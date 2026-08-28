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


def _downscale_for_upload(image_bytes: bytes) -> bytes:
    """Shrink a copy to the upload cap. Never touches the caller's bytes."""
    img = pyvips.Image.new_from_buffer(image_bytes, "")
    long_edge = max(img.width, img.height)
    if long_edge <= CUTOUT_MAX_UPLOAD_LONG_EDGE_PX:
        return image_bytes
    scale = CUTOUT_MAX_UPLOAD_LONG_EDGE_PX / long_edge
    return img.resize(scale, kernel="lanczos3").write_to_buffer(".png")


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

    mask = pyvips.Image.new_from_buffer(mask_bytes, "")
    if mask.hasalpha():
        mask = mask.flatten(background=[0, 0, 0])
    if mask.bands > 1:
        mask = mask[0]

    if mask.width != img.width or mask.height != img.height:
        mask = mask.resize(
            img.width / mask.width,
            vscale=img.height / mask.height,
            kernel="linear",
        )

    out = img.bandjoin(mask.cast("uchar"))
    out = out.copy(interpretation="srgb")
    return out.write_to_buffer(".png")


async def remove_background(image_bytes: bytes) -> bytes:
    """
    Knock the backdrop out of a finished enhance output. Returns PNG bytes with
    a real alpha channel, at the SAME dimensions as the input — the caller has
    already standardised to 2800x2000 and this must not change that.

    Raises CutoutUnavailableError if a usable alpha cannot be produced.
    Callers must NOT swallow that into "ship it opaque".
    """
    src = pyvips.Image.new_from_buffer(image_bytes, "")
    upload = _downscale_for_upload(image_bytes)

    payload = {
        "image_url": fal.data_uri(upload, "image/png"),
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
        "cutout: fal %s (%s @ %s), source %dx%d, upload %d bytes",
        CUTOUT_MODEL,
        CUTOUT_FAL_MODEL,
        CUTOUT_OPERATING_RESOLUTION,
        src.width,
        src.height,
        len(upload),
    )

    try:
        result = await fal.run(CUTOUT_MODEL, payload)
    except fal.FalError as exc:
        raise CutoutUnavailableError(f"matting failed: {exc}") from exc

    # mask_image FIRST: it is unambiguously the mask. `image` is only the mask
    # if fal honoured mask_only; if it did not, `image` is a cutout whose red
    # channel would silently become our alpha.
    ref = result.get("mask_image") or result.get("image")
    if ref is None:
        raise CutoutUnavailableError(
            f"matting returned no image field; keys were {sorted(result)}"
        )

    try:
        mask_bytes = await fal.fetch_output(ref)
    except fal.FalError as exc:
        raise CutoutUnavailableError(f"matting mask fetch failed: {exc}") from exc

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
