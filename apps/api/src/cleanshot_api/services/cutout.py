"""
Background removal (matting) — turns a finished enhance output into a
transparent-background PNG for the new-equipment site.

WHY THIS IS A MATTING PASS AND NOT A PROMPT
-------------------------------------------
The obvious-looking implementation is to ask the image model for "a seamless
white backdrop" or "transparent background". That is a GENERATION: the model
re-draws the machine, which re-opens identity drift (the whole reason
identity-preserving editing exists in this stack), and it has to decide where
the machine ends. A forklift is the worst case for that — mast lattice, fork
gaps, overhead-guard openings — and this repo's durable findings already record
that Gemini handles exactly that kind of fine structure inconsistently, with no
background texture left to hide a mistake in.

So this runs AFTER enhancement, over the finished pixels, and only computes an
alpha channel. The RGB is untouched: whatever the operator approved is still
exactly what ships, just with the backdrop knocked out.

WHY A VENDOR NOW, AFTER IN-CONTAINER WON LAST TIME (changed 2026-08-28)
-----------------------------------------------------------------------
Until today this ran `rembg` + `onnxruntime` with `isnet-general-use` baked into
the image. That was chosen on 2026-08-26 over remove.bg / Bria / Photoroom
knowing a vendor gives better edges, because the vendor cost a new secret, a new
rate limiter, per-image spend on a bulk workflow, and one more thing that can
429 mid-batch. Operator reversed that call in favour of fal.ai's BiRefNet v2.

Two things make the reversal cheaper than it looks:

  • `isnet-general-use` computes its mask at 1024x1024 internally and upscales.
    So the OLD engine was putting a 1024-derived alpha onto a 2800x2000 image.
    BiRefNet at `2048x2048` is strictly better mask precision than what it
    replaces, not merely different.
  • Dropping rembg + onnxruntime + the baked 170MB model removes most of the
    container's cold-start weight.

WHY WE ASK FOR THE MASK AND COMPOSITE LOCALLY
----------------------------------------------
fal can return a finished cutout. We do not use it. Taking the vendor's
composite would mean accepting their re-encode and whatever `refine_foreground`
does to edge pixels, applied to output the operator already approved — which
throws away the "RGB is never regenerated" property that is the entire reason
this is a matting pass and not a prompt. So we request the mask, scale it onto
our own bytes, and composite here. `operating_resolution` then only ever affects
mask precision, never our pixels.

A CUTOUT FAILURE MUST NOT DEGRADE TO AN OPAQUE IMAGE
-----------------------------------------------------
The toggle exists because the destination site needs transparency; an opaque
file is a wrong answer wearing a success badge, so the job fails instead. That
now includes vendor failures — 401, 429, timeout. Do not add an
except-and-return-original path here.
"""

from __future__ import annotations

import array
import logging
import os

import pyvips

from cleanshot_api.services import fal

logger = logging.getLogger(__name__)

# fal model id. Env-overridable so swapping BiRefNet variants is a redeploy,
# not a code change — the same reason CUTOUT_MODEL was an env var before.
CUTOUT_MODEL = os.environ.get("CUTOUT_MODEL", "fal-ai/birefnet/v2")

# BiRefNet weights. "General Use (Heavy)" is the accuracy end of the range;
# "General Use (Light)" is the model default and is faster. Machinery
# silhouettes with lattice and fork gaps are the case heavy is for.
CUTOUT_FAL_MODEL = os.environ.get("CUTOUT_FAL_MODEL", "General Use (Heavy)")

# The resolution BiRefNet computes the mask at. Enum — fal accepts exactly
# "1024x1024", "2048x2048", "2304x2304". NOT a limit on what we may send: it is
# the model's internal working resolution, which is why the pipeline's own
# 2800x2000 standard does not have to change to accommodate it.
CUTOUT_OPERATING_RESOLUTION = os.environ.get(
    "CUTOUT_OPERATING_RESOLUTION", "2048x2048"
)

# Long edge we upload at. Sending more pixels than the model will operate on
# buys a bigger request and a bigger bill for an identical mask, so this tracks
# the operating resolution. Mirrors OPENAI_MAX_LONG_EDGE_PX in enhance_worker:
# a PER-VENDOR TRANSPORT cap, never an output size. The stored asset stays
# 2800x2000 no matter what this is.
CUTOUT_MAX_UPLOAD_LONG_EDGE_PX = int(
    os.environ.get("CUTOUT_MAX_UPLOAD_LONG_EDGE_PX", "2048")
)

# Photoroom request shaping, for the A/B engine (services/photoroom.py).
# `channels=alpha` should return a bare mask rather than a finished cutout —
# but `_mask_band` copes with either, so this is a preference, not a
# requirement. `size=full` keeps the mask at the resolution we uploaded;
# `preview` is smaller and may bill differently on the free tier, which is
# worth checking on the dashboard before spending the ten credits.
CUTOUT_PHOTOROOM_CHANNELS = os.environ.get("CUTOUT_PHOTOROOM_CHANNELS", "alpha")
CUTOUT_PHOTOROOM_SIZE = os.environ.get("CUTOUT_PHOTOROOM_SIZE", "full")

# Below this, an already-small upload is sent as-is rather than re-encoded.
# Re-encoding a small JPEG would cost a generation of quality for nothing.
CUTOUT_UPLOAD_REENCODE_MIN_BYTES = int(
    os.environ.get("CUTOUT_UPLOAD_REENCODE_MIN_BYTES", "1500000")
)

# Keep only the principal subject in the mask. BiRefNet "General Use" is a
# SALIENT OBJECT detector, not a subject segmenter: on a real showroom photo it
# returned the forklift AND a potted plant AND a wall banner, each with its own
# alpha. This drops every mask island that is not the machine. Off switch is an
# env var because it is a behaviour change on a live pass, not because it is
# expected to be wrong.
CUTOUT_ISOLATE_SUBJECT = os.environ.get("CUTOUT_ISOLATE_SUBJECT", "1") != "0"

# Islands are grouped through gaps this wide (px, at MASK resolution) before
# they are counted. A machine is one object but its mask is not reliably one
# island — a fork tip or a mirror can be split off by a hairline of background.
# Bridging first means such a part is grouped WITH the machine instead of being
# deleted as a distractor. It only affects grouping: the alpha that ships is
# always the untouched original inside whatever is kept.
CUTOUT_BRIDGE_PX = int(os.environ.get("CUTOUT_BRIDGE_PX", "6"))

# An island this big relative to the largest one is kept too, on the assumption
# that it is a real detached part rather than scenery. Set from measurement, not
# taste: on the 2026-08-29 sample the plant was ~9% of the machine's masked area
# and the "Discount Forklift" wall banner was ~36%, so anything under ~0.4 keeps
# the banner. 0.5 drops both while still keeping a mask that has genuinely split
# a machine into two large pieces — the failure that actually ruins an asset.
# Distractors bigger than half the machine are not reachable from here; those
# need removeBackgroundSignage at enhance time, before the pixels ever reach the
# mask.
CUTOUT_KEEP_AREA_RATIO = float(os.environ.get("CUTOUT_KEEP_AREA_RATIO", "0.5"))

# Safety valve for masks where "one dominant subject plus scenery" is simply
# false — nothing dominates, so picking a winner is guesswork. Tripping it keeps
# the ORIGINAL mask and logs loudly: a retained plant is a complaint, an
# amputated machine on a product page is not recoverable from.
#
# The line is drawn at "the subject must be the MAJORITY of what was masked".
# That is the honest test of the premise, and it is deliberately not tighter:
# a first pass used 0.35 and it fired on the very image this was written for
# (banner 14k px + plant 9k px against a 39k px machine = 37.2% dropped),
# abandoning the fix on the one case that needed it. Anything under 0.5 is
# tuned to a guess about how much scenery a photo contains; 0.5 is tuned to
# whether we can still identify the subject at all. Note the ratio rule above
# is what actually protects a split machine — no island within half the size of
# the largest is ever dropped, whatever this is set to.
CUTOUT_MAX_DROP_FRACTION = float(os.environ.get("CUTOUT_MAX_DROP_FRACTION", "0.5"))


class CutoutUnavailableError(RuntimeError):
    """
    Raised when the matting engine cannot produce a usable alpha channel.

    Deliberately its own type: the caller treats "the cutout engine is broken"
    differently from "this image failed". Neither may silently ship an opaque
    image to a site that requires transparency.
    """


def has_alpha(image_bytes: bytes) -> bool:
    """
    True when these bytes already carry a transparency channel.

    Used by the per-variant erase/tweak paths to answer "was this variant a
    cutout?" without threading a flag through four schemas. A vendor edit
    returns opaque pixels, so without this check a tweak on a cutout would
    silently hand back a black background — worse than refusing.
    """
    try:
        return bool(pyvips.Image.new_from_buffer(image_bytes, "").hasalpha())
    except Exception:
        # An unreadable buffer is not this function's problem to report; the
        # caller is about to fail on it far more informatively.
        return False


def _downscale_for_upload(image_bytes: bytes) -> tuple[bytes, str]:
    """
    Shrink a copy to the upload cap. Never touches the caller's bytes.
    Returns (bytes, mime_type).

    JPEG, NOT PNG — and this is a memory fix, not a bandwidth nicety. A
    lossless 2048px PNG of a photo measured **5.1 MB** in production, and
    `fal.data_uri` then base64-encodes it into a ~6.8 MB string, with httpx
    holding another copy of the JSON body. That is ~12 MB of transient
    allocation per concurrent job before any pixel work, and Cloud Tasks can
    put ten of those on one instance.

    Lossless buys nothing here. We ask fal for a MASK and throw its RGB away,
    so the encode is a TRANSPORT format for a segmentation model, not output.
    The finished cutout's pixels are the caller's untouched originals either
    way — this cannot degrade what ships, only what the model looks at while
    deciding where the edges are, and Q92 at 2048px is far above what changes
    that decision.

    Alpha keeps PNG. JPEG has no alpha channel, and libvips would composite it
    onto BLACK rather than dropping it — handing the matting model a black
    background to find edges against. Only the re-matte paths (tweak/erase on
    an existing cutout) can arrive with alpha, and they are rare enough that
    the bigger payload does not matter.
    """
    img = pyvips.Image.new_from_buffer(image_bytes, "")
    long_edge = max(img.width, img.height)

    if long_edge > CUTOUT_MAX_UPLOAD_LONG_EDGE_PX:
        img = img.resize(
            CUTOUT_MAX_UPLOAD_LONG_EDGE_PX / long_edge, kernel="lanczos3"
        )
    elif not img.hasalpha():
        # Already small enough, but still worth re-encoding if the source is a
        # big PNG — the point is the payload, not the pixel count.
        if len(image_bytes) <= CUTOUT_UPLOAD_REENCODE_MIN_BYTES:
            return image_bytes, _sniff_mime(image_bytes)

    if img.hasalpha():
        return img.write_to_buffer(".png"), "image/png"
    return img.write_to_buffer(".jpg", Q=92, strip=True), "image/jpeg"


def _sniff_mime(data: bytes) -> str:
    """Magic-byte mime sniff, so an untouched buffer is labelled correctly."""
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return "image/png"
    if data[:4] == b"RIFF":
        return "image/webp"
    return "image/jpeg"


def _isolate_principal_subject(mask: "pyvips.Image") -> "pyvips.Image":
    """
    Zero every mask island that is not the machine. Returns a single-band mask.

    WHY THIS IS NEEDED AT ALL. BiRefNet returns everything SALIENT, not "the
    subject". The first production cutout came back with the forklift matted
    correctly — lattice, fork gaps and overhead-guard openings all clean — and a
    potted plant and a wall banner matted just as correctly beside it. Raising
    CUTOUT_FAL_MODEL or CUTOUT_OPERATING_RESOLUTION does not help: those buy edge
    PRECISION, and precision was never what failed. This is a selection problem
    and it is solved in the mask, for free, with no vendor involved — which also
    means it keeps working if the matting vendor is swapped.

    THE ALPHA IS NEVER REDRAWN. Grouping happens on a bridged binary copy; the
    value that ships is the ORIGINAL soft mask wherever a kept island covers it.
    So anti-aliased edges survive exactly as the vendor computed them, and the
    only possible effect of this function is turning some pixels transparent.

    NEVER RAISES — and that is load-bearing, not defensive habit. The first
    version had no failure path, so a bug in here failed the whole enhance job
    and the operator got FAILED cards instead of a cutout with a plant in it.
    Read the no-degradation rule in this module's header carefully: it forbids
    shipping an OPAQUE image, because the destination site needs transparency.
    Falling back to the un-isolated mask still ships transparency, so it is a
    correct answer with a cosmetic flaw — categorically different from an
    opaque file, and never worth an outage.
    """
    if not CUTOUT_ISOLATE_SUBJECT:
        return mask
    try:
        return _isolate_islands(mask)
    except Exception:
        logger.exception(
            "cutout: isolate failed — shipping the UN-ISOLATED mask. The cutout "
            "is still transparent and correct; it may just carry a distractor."
        )
        return mask


def _isolate_islands(mask: "pyvips.Image") -> "pyvips.Image":
    """
    Body of _isolate_principal_subject. MAY RAISE; the caller degrades to the
    original mask, which is why nothing in here carries its own error handling.
    """
    total = mask.avg() / 255.0 * mask.width * mask.height
    if total <= 0:
        # An empty mask is a matting failure, not something to isolate. Leave it
        # for the caller's has_alpha/coverage checks to report properly.
        return mask

    binary = (mask > 127).ifthenelse(255, 0)

    # Bridge hairline gaps so one machine reads as one island. A blur-then-
    # threshold is a cheap dilation and precise enough for grouping — morph()
    # with a real structuring element costs far more for no better an answer.
    bridged = binary
    if CUTOUT_BRIDGE_PX > 0:
        bridged = (binary.gaussblur(CUTOUT_BRIDGE_PX) > 8).ifthenelse(255, 0)

    # labelregions numbers regions of EQUAL value, so background regions get
    # labels too. Shifting foreground labels up by one and forcing background to
    # zero means the histogram below is indexed by foreground island directly.
    labels = bridged.labelregions()
    n_labels = int(labels.max())
    if n_labels < 1 or n_labels > 60000:
        # One island (nothing to drop) or pathological fragmentation, where the
        # premise does not hold and the histogram would be meaningless anyway.
        logger.info("cutout: isolate skipped, %d label(s)", n_labels + 1)
        return mask

    marked = (bridged > 127).ifthenelse(labels + 1, 0).cast("ushort")

    # ONE memory read, not one getpoint per island. The first cut of this called
    # `hist(i, 0)` in a comprehension and took production down with "unable to
    # call getpoint" — pyvips reports the whole lazy pipeline's failure at the
    # point it is finally forced, which was the first getpoint, so the message
    # named the wrong operation. Local tests never had more than five islands; a
    # real 2048px mask has hundreds of speck islands, which is the difference.
    # Reading the buffer whole makes the bin count EXPLICIT and checkable
    # instead of assumed, and removes a loop that would have been tens of
    # thousands of libvips calls even when it worked.
    hist = marked.hist_find().cast("uint")
    counts = array.array("I")
    if counts.itemsize != 4:  # pragma: no cover - not a platform we ship on
        logger.warning("cutout: isolate skipped, unexpected uint size")
        return mask
    counts.frombytes(hist.write_to_memory())

    # CLAMP to the histogram, do not assume it spans the label range. MEASURED:
    # vips hist_find sizes a ushort histogram to (max value + 1), NOT to a fixed
    # 65536 — a ushort image whose max is 300 gives 301 bins. labelregions
    # numbers background regions too, so when the HIGHEST-numbered region is a
    # background one, `marked` never reaches n_labels + 1 and the histogram is
    # short. That is the production crash: with two islands the last region
    # happened to be foreground and the range fit; with 312 speck islands it did
    # not, and reading one past the end took every cutout job down.
    #
    # Clamping is correct rather than merely safe: a label missing from the
    # histogram cannot appear in `marked`, so its area is genuinely zero.
    limit = min(len(counts), n_labels + 2)

    # Index 0 is every background pixel lumped together — never a candidate.
    areas = {i: counts[i] for i in range(1, limit) if counts[i] > 0}
    if len(areas) <= 1:
        return mask

    largest = max(areas.values())
    keep = {
        label
        for label, area in areas.items()
        if area >= largest * CUTOUT_KEEP_AREA_RATIO
    }
    dropped = {label: area for label, area in areas.items() if label not in keep}
    if not dropped:
        return mask

    # OR the kept labels together. There are only ever a handful, so equality
    # tests beat building a 65536-entry maplut.
    keep_mask = None
    for label in keep:
        hit = marked == label
        keep_mask = hit if keep_mask is None else (keep_mask | hit)

    isolated = keep_mask.ifthenelse(mask, 0)

    kept_total = isolated.avg() / 255.0 * mask.width * mask.height
    drop_fraction = 1.0 - (kept_total / total)
    if drop_fraction > CUTOUT_MAX_DROP_FRACTION:
        logger.warning(
            "cutout: isolate would drop %.1f%% of the mask (>%.0f%% limit) across "
            "%d island(s) — keeping the original mask. This image is not "
            "'one subject plus scenery'; check it by hand.",
            drop_fraction * 100,
            CUTOUT_MAX_DROP_FRACTION * 100,
            len(dropped),
        )
        return mask

    logger.info(
        "cutout: isolate kept %d/%d island(s), dropped %.2f%% of masked area "
        "(dropped island px: %s)",
        len(keep),
        len(areas),
        drop_fraction * 100,
        sorted(dropped.values(), reverse=True)[:8],
    )
    return isolated


def _mask_band(img: "pyvips.Image") -> "pyvips.Image":
    """
    Pull a single-band alpha mask out of whatever a matting vendor returned.

    TWO SHAPES ARRIVE and they need opposite handling, which is why this is a
    function rather than two lines at the call site:

      • A BARE MASK — greyscale, no meaningful alpha. The mask is the pixels,
        so take band 0.
      • A FINISHED CUTOUT — RGBA, where the mask is the ALPHA CHANNEL and the
        RGB is the vendor's own composite (which we discard; see the module
        header). Taking band 0 here would use the RED CHANNEL as transparency,
        so a black tyre would come out 92% see-through. This is the exact
        nonsense the fal reader's `mask_image`-first rule guards against, and
        Photoroom can return either shape depending on whether it honours
        `channels=alpha`.

    Distinguished by whether the alpha actually varies. A greyscale mask saved
    with a fully-opaque alpha channel is still a bare mask, and using that
    all-255 alpha would produce no cutout at all — the failure would be a
    completely opaque image, the one outcome this module exists to prevent.
    """
    if img.hasalpha():
        alpha = img[img.bands - 1]
        if alpha.min() < 255:
            return alpha
    return img[0] if img.bands > 1 else img


def _composite_alpha(image_bytes: bytes, mask_bytes: bytes) -> bytes:
    """
    Attach `mask_bytes` to `image_bytes` as an alpha channel, at the image's
    own dimensions. Returns PNG bytes.

    The mask arrives at whatever size fal produced it; it is scaled to the
    image here. `kernel="linear"` on purpose — lanczos overshoots, and on an
    alpha channel overshoot is a halo of >255 clipped to opaque along every
    edge, which reads as a bright fringe against the destination site's
    background. Softness costs less than ringing here.
    """
    img = pyvips.Image.new_from_buffer(image_bytes, "")
    if img.hasalpha():
        # Defensive: re-matting an existing cutout should replace the alpha,
        # not stack a second one (bandjoin would make a 5-band image).
        img = img.flatten(background=[255, 255, 255])

    mask = _mask_band(pyvips.Image.new_from_buffer(mask_bytes, ""))

    # Isolate BEFORE the resize: islands are cleanest at the mask's native
    # resolution, and it is cheaper on fewer pixels.
    mask = _isolate_principal_subject(mask)

    if mask.width != img.width or mask.height != img.height:
        mask = mask.resize(
            img.width / mask.width,
            vscale=img.height / mask.height,
            kernel="linear",
        )

    out = img.bandjoin(mask.cast("uchar"))
    out = out.copy(interpretation="srgb")
    return out.write_to_buffer(".png")


async def _fetch_mask_photoroom(upload: bytes, upload_mime: str) -> bytes:
    """
    Photoroom's mask for one image. A/B alternative to fal — see photoroom.py.

    ⚠️ SPENDS ONE OF TEN FREE CREDITS PER CALL. There is no metering on this
    side; the count lives in Photoroom's dashboard.
    """
    from cleanshot_api.services import photoroom

    logger.info(
        "cutout: photoroom segment, upload %d bytes (%s)", len(upload), upload_mime
    )
    try:
        return await photoroom.segment(
            upload,
            upload_mime,
            channels=CUTOUT_PHOTOROOM_CHANNELS,
            output_size=CUTOUT_PHOTOROOM_SIZE,
        )
    except photoroom.PhotoroomError as exc:
        raise CutoutUnavailableError(f"matting failed (photoroom): {exc}") from exc


async def _fetch_mask_fal(
    upload: bytes, upload_mime: str, src: "pyvips.Image"
) -> bytes:
    """fal BiRefNet's mask for one image. The default engine."""
    payload = {
        "image_url": fal.data_uri(upload, upload_mime),
        "model": CUTOUT_FAL_MODEL,
        "operating_resolution": CUTOUT_OPERATING_RESOLUTION,
        "output_format": "png",
        # We composite ourselves, so the refined foreground would be discarded
        # anyway — and turning it off keeps fal from touching pixel values.
        "refine_foreground": False,
        # Ask for the mask two ways on purpose. fal documents both flags but
        # not their precedence, and guessing wrong here is quiet: if
        # mask_only were ignored, `image` would be the finished CUTOUT, and
        # using its red channel as an alpha would produce nonsense rather
        # than an error. Requesting output_mask too means a dedicated
        # `mask_image` field comes back, which the reader below prefers.
        "output_mask": True,
        "mask_only": True,
    }

    logger.info(
        "cutout: fal %s (%s @ %s), source %dx%d, upload %d bytes (%s)",
        CUTOUT_MODEL,
        CUTOUT_FAL_MODEL,
        CUTOUT_OPERATING_RESOLUTION,
        src.width,
        src.height,
        len(upload),
        upload_mime,
    )

    try:
        result = await fal.run(CUTOUT_MODEL, payload)
    except fal.FalError as exc:
        raise CutoutUnavailableError(f"matting failed (fal): {exc}") from exc

    # mask_image FIRST: it is unambiguously the mask. `image` is only the mask
    # if fal honoured mask_only; if it did not, `image` is a cutout whose red
    # channel would silently become our alpha.
    ref = result.get("mask_image") or result.get("image")
    if ref is None:
        raise CutoutUnavailableError(
            f"matting returned no image field; keys were {sorted(result)}"
        )

    try:
        return await fal.fetch_output(ref)
    except fal.FalError as exc:
        raise CutoutUnavailableError(f"matting mask fetch failed: {exc}") from exc


async def remove_background(image_bytes: bytes, *, engine: str = "fal") -> bytes:
    """
    Knock the backdrop out of a finished enhance output. Returns PNG bytes with
    a real alpha channel, at the SAME dimensions as the input — the caller has
    already standardised to 2800x2000 and this must not change that.

    `engine` picks the matting vendor ("fal" | "photoroom"). Everything after
    the mask arrives is IDENTICAL for both: the same island filter, the same
    local composite onto untouched RGB, the same contract checks. That is what
    makes the A/B honest — the only variable is the mask.

    Raises CutoutUnavailableError if a usable alpha cannot be produced.
    Callers must NOT swallow that into "ship it opaque".
    """
    src = pyvips.Image.new_from_buffer(image_bytes, "")
    upload, upload_mime = _downscale_for_upload(image_bytes)

    if engine == "photoroom":
        mask_bytes = await _fetch_mask_photoroom(upload, upload_mime)
    elif engine == "fal":
        mask_bytes = await _fetch_mask_fal(upload, upload_mime, src)
    else:
        # Not a silent fallback to fal: an unknown engine means a toggle and
        # this dispatch disagree, and quietly matting with the wrong vendor
        # would corrupt an A/B result rather than fail it.
        raise CutoutUnavailableError(f"unknown matting engine {engine!r}")

    try:
        out = _composite_alpha(image_bytes, mask_bytes)
    except Exception as exc:
        raise CutoutUnavailableError(f"matting composite failed: {exc}") from exc

    # Verify the contract rather than trusting it. A model or API change that
    # started returning RGB would otherwise produce a silently opaque "cutout"
    # that only surfaces as a complaint from the website.
    if not has_alpha(out):
        raise CutoutUnavailableError(
            "matting produced an image with no alpha channel; refusing to pass "
            "it off as a cutout"
        )

    result_img = pyvips.Image.new_from_buffer(out, "")
    if (result_img.width, result_img.height) != (src.width, src.height):
        raise CutoutUnavailableError(
            f"matting changed dimensions {src.width}x{src.height} -> "
            f"{result_img.width}x{result_img.height}; the sizing standard says "
            "nothing after enhancement may resample"
        )
    return out


def flatten_onto_white(image_bytes: bytes) -> bytes:
    """
    Composite a transparent image onto opaque white, for the paths that
    genuinely cannot carry alpha.

    Not used by the export route — that emits PNG and keeps the transparency —
    but kept here because it is the one correct way to do this and it is easy
    to get wrong: pyvips `flatten` needs an explicit background, and letting it
    default gives BLACK, which on a product cutout is the single most visible
    possible failure.
    """
    img = pyvips.Image.new_from_buffer(image_bytes, "")
    if not img.hasalpha():
        return image_bytes
    return img.flatten(background=[255, 255, 255]).write_to_buffer(".png")
