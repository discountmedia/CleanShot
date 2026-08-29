"""
Auto-crop — locate the machine with Florence-2 and build a consistent 7:5 frame.

PORTED FROM df-auto-edit, NOT REINVENTED. That app (c:\\dev\\df-auto-edit) is a
standalone auto-crop tool for this same inventory, and its constants were
measured against Stephen's own photos rather than chosen. The maths below is a
faithful port of its `lib/crop.ts` and `lib/detect/fal.ts`. If you find yourself
"improving" a number here, go and read `lib/config.ts` there first — several of
these look arbitrary and are not.

WHAT TRANSFERS AND WHAT DOES NOT
--------------------------------
Both apps target the SAME output: 2800x2000, 7:5. So the framing constants
(fill, vertical bias, aspect) describe the same house style and port cleanly.

What does NOT automatically transfer is anything measured against df-auto-edit's
INPUT, because it detects on raw shoot photos and this detects on an enhanced
render. Its `detailCoverage` close-up test is the obvious example, and it is
deliberately not ported — nothing here needs it.

WHERE THIS RUNS, AND THE COST OF THAT CHOICE
--------------------------------------------
It runs on the ENHANCED output, after the vendor and before
`upscale_to_standard`. That keeps it entirely out of the vendor dispatch path,
which is worth a lot, but it has a real price: cropping in and then scaling up
to 2800x2000 is an UPSCALE, and the enhance path only just stopped upscaling
(GEMINI_IMAGE_SIZE). A crop to 60% of the frame turns a x1.16 scale into
roughly x1.9.

The alternative — crop the SOURCE and let the vendor generate the tight framing
natively — avoids that entirely and is the better answer if this proves
worthwhile. It was not done first because it means touching the vendor input
path, the stored original, and the differential scan's before/after pair. The
`sizing:` log line reports the resulting scale on every image, so the cost of
this choice is measured rather than argued about. Watch it.
"""

from __future__ import annotations

import logging
import math
import os
from dataclasses import dataclass

import pyvips

from cleanshot_api.services import fal

logger = logging.getLogger(__name__)

# fal slug for Florence-2 open-vocabulary detection. Two traps recorded by
# df-auto-edit that cost real time: there is NO `fal-ai/grounding-dino` (that
# slug 404s), and the prompt field is `text_input`, NOT `text_prompt`.
AUTOCROP_MODEL = os.environ.get(
    "AUTOCROP_MODEL", "fal-ai/florence-2-large/open-vocabulary-detection"
)

# ONE WORD, DELIBERATELY, AGAINST EVERY INSTINCT. Measured over 121 real photos
# of this inventory: "forklift" alone located the machine in 100% of them —
# scissor lifts, telehandlers and boom lifts included — because the grounding is
# semantic rather than a class lookup. Expanding it to eight machine types made
# Florence-2 LOSE a forklift it had previously found at 75% coverage.
#
# ⚠️ DO NOT substitute the request's `equipment_type` here. It is the obvious
# idea and the measurement says it is wrong: broader is not safer with this
# model. Re-run df-auto-edit's scripts/prompt-trial.mjs before changing it.
AUTOCROP_PROMPT = os.environ.get("AUTOCROP_PROMPT", "forklift")

# Long edge sent to the detector. A bounding box does not need full resolution,
# and the boxes come back in the pixel space of what was SENT, so they are
# scaled back afterwards. Keeping this small matters: the data URI is base64 and
# lands in memory on a container that has already been OOM-killed once today.
AUTOCROP_DETECT_LONG_EDGE_PX = int(
    os.environ.get("AUTOCROP_DETECT_LONG_EDGE_PX", "1024")
)

# 7:5 — the same standard the rest of the pipeline enforces.
AUTOCROP_ASPECT = 7.0 / 5.0

# Fraction of the crop's binding axis the machine should occupy. THE single
# number that makes a set match. 0.88 came from a visual sweep over 314 real
# photos and REPLACED an earlier 0.78 that was correctly measured from an
# unrepresentative sample (9 close-crops drawn from a pool that was 61/70
# aspect-trims, so it skewed loose and produced visibly loose output).
#
# The counter-intuitive part, worth keeping: raising fill REDUCES clamping.
# cropW = subject / fill, so a bigger fill asks for a SMALLER crop, which is
# likelier to fit. Measured over 48 photos: 0.72 clamped 36/48, 0.88 clamps far
# less. A tighter house style is cheaper, not more expensive.
AUTOCROP_FILL = float(os.environ.get("AUTOCROP_FILL", "0.88"))

# 0 = dead centre; positive pushes the machine UP, leaving more ground than sky.
# Forklifts read better that way.
AUTOCROP_VERTICAL_BIAS = float(os.environ.get("AUTOCROP_VERTICAL_BIAS", "0.04"))

# A detection whose own area is at least this fraction inside the winner is a
# FRAGMENT of the same machine (forks, mast, counterweight) and gets absorbed.
AUTOCROP_MERGE_CONTAINMENT = 0.5

# A separate box at least this fraction of the winner's area is a second
# machine, not a fragment. Only logged here — this app has no review queue.
AUTOCROP_SECOND_MACHINE_RATIO = 0.55


@dataclass(frozen=True)
class Box:
    x: float
    y: float
    w: float
    h: float

    @property
    def area(self) -> float:
        return max(0.0, self.w) * max(0.0, self.h)

    @property
    def cx(self) -> float:
        return self.x + self.w / 2

    @property
    def cy(self) -> float:
        return self.y + self.h / 2


class AutoCropUnavailableError(RuntimeError):
    """
    Detection could not produce a usable subject box.

    Its own type so the caller can decide. Unlike a cutout failure, this is NOT
    worth failing the job over: an uncropped 2800x2000 image is a correct,
    shippable listing photo that merely is not reframed. The caller degrades.
    """


def _intersection_area(a: Box, b: Box) -> float:
    x = max(0.0, min(a.x + a.w, b.x + b.w) - max(a.x, b.x))
    y = max(0.0, min(a.y + a.h, b.y + b.h) - max(a.y, b.y))
    return x * y


def _union(a: Box, b: Box) -> Box:
    x = min(a.x, b.x)
    y = min(a.y, b.y)
    return Box(x, y, max(a.x + a.w, b.x + b.w) - x, max(a.y + a.h, b.y + b.h) - y)


def _parse_boxes(raw: dict, sent_w: int, sent_h: int) -> list[Box]:
    """
    Read Florence-2's detections.

    THE BOXES ARE xywh IN PIXELS of the image that was sent — not xyxy, and not
    normalised. The response also carries a differently-sized annotated preview
    image; ignore it, it does not describe these coordinates.

    Florence-2 returns NO confidence scores, so every detection effectively
    arrives at score 1. df-auto-edit's rank formula has a 0.5*score term that is
    therefore constant on this provider; size and centrality carry the decision.
    """
    results = raw.get("results") or raw.get("detections") or {}
    if isinstance(results, dict):
        candidates = results.get("bboxes") or results.get("boxes") or []
    else:
        candidates = results

    boxes: list[Box] = []
    for item in candidates:
        if isinstance(item, dict):
            if {"x", "y", "w", "h"} <= item.keys():
                box = Box(
                    float(item["x"]), float(item["y"]),
                    float(item["w"]), float(item["h"]),
                )
            elif {"x1", "y1", "x2", "y2"} <= item.keys():
                box = Box(
                    float(item["x1"]), float(item["y1"]),
                    float(item["x2"]) - float(item["x1"]),
                    float(item["y2"]) - float(item["y1"]),
                )
            else:
                continue
        elif isinstance(item, (list, tuple)) and len(item) == 4:
            # Bare [x1, y1, x2, y2] — Florence's raw task output shape.
            box = Box(
                float(item[0]), float(item[1]),
                float(item[2]) - float(item[0]),
                float(item[3]) - float(item[1]),
            )
        else:
            continue

        # A box outside the sent frame means the coordinate convention is not
        # what we think. Dropping it silently would hand the cropper a garbage
        # subject, so it is worth the log line.
        if box.area <= 0 or box.x < -1 or box.y < -1:
            continue
        if box.x + box.w > sent_w + 1 or box.y + box.h > sent_h + 1:
            logger.warning(
                "autocrop: detection %s lies outside the %dx%d frame sent — "
                "check the box format before trusting this crop",
                box, sent_w, sent_h,
            )
            continue
        boxes.append(box)
    return boxes


def _select_subject(boxes: list[Box], w: int, h: int) -> Box | None:
    """
    Pick the one machine the photo is about, then absorb its fragments.

    "Biggest box wins" is not good enough: dealer-lot photos routinely have a
    second machine parked behind the subject, and a distant one can out-score
    the subject on centrality alone. Rank on size and centrality, then merge in
    part-detections that sit INSIDE the winner (forks, boom, counterweight)
    while leaving genuinely separate machines out of the frame.
    """
    usable = [b for b in boxes if b.area > 0]
    if not usable:
        return None

    max_area = max(b.area for b in usable)
    img_cx, img_cy = w / 2, h / 2
    max_dist = math.hypot(img_cx, img_cy) or 1.0

    def rank(b: Box) -> float:
        centrality = 1 - math.hypot(b.cx - img_cx, b.cy - img_cy) / max_dist
        # 0.5 * score omitted: Florence-2 returns no scores, so it is a constant
        # and would only obscure what is actually deciding this.
        return 0.35 * (b.area / max_area) + 0.15 * centrality

    ordered = sorted(usable, key=rank, reverse=True)
    primary = ordered[0]
    subject = primary

    for other in ordered[1:]:
        if other.area <= 0:
            continue
        if _intersection_area(other, primary) / other.area >= AUTOCROP_MERGE_CONTAINMENT:
            subject = _union(subject, other)

    others = [
        b for b in ordered[1:]
        if b.area > 0
        and _intersection_area(b, subject) / b.area < AUTOCROP_MERGE_CONTAINMENT
        and b.area >= primary.area * AUTOCROP_SECOND_MACHINE_RATIO
    ]
    if others:
        logger.info(
            "autocrop: %d other machine(s) of comparable size in frame; framing "
            "the primary only", len(others),
        )
    return subject


def compute_crop(subject: Box | None, w: int, h: int) -> tuple[Box, bool]:
    """
    Build the 7:5 crop around `subject`. Returns (crop, subject_cut).

    VERTICAL BOUNDS ARE INVIOLABLE, HORIZONTAL ONES ARE SPENDABLE — the load-
    bearing rule, ported verbatim in spirit. Every forklift has forks, and a
    viewer fills in a clipped fork tip without noticing. A cut-off mast top or
    missing wheels reads as a damaged or floating machine, which cannot ship. So
    when the subject does not fit, the loss comes off the left or right edge.
    """
    max_w = min(float(w), h * AUTOCROP_ASPECT)
    max_h = max_w / AUTOCROP_ASPECT
    centred = Box((w - max_w) / 2, (h - max_h) / 2, max_w, max_h)

    if subject is None or subject.w <= 0 or subject.h <= 0:
        return centred, False

    # Smallest 7:5 crop that still contains the subject's full height.
    min_width_for_full_height = subject.h * AUTOCROP_ASPECT
    if min_width_for_full_height > max_w + 1e-6:
        # No valid 7:5 window holds this subject's height. Rather than clip the
        # mast or the wheels, hand back the centred crop and say so.
        return centred, True

    crop_w = max(subject.w / AUTOCROP_FILL, (subject.h / AUTOCROP_FILL) * AUTOCROP_ASPECT)
    crop_w = min(crop_w, max_w)
    crop_w = max(crop_w, min_width_for_full_height)
    crop_h = crop_w / AUTOCROP_ASPECT

    # Vertical placement is CONSTRAINED before it is preferred: the window must
    # contain the subject top-to-bottom, and the house bias only chooses a
    # position within whatever range that leaves. On a tight photo the range
    # collapses and containment wins, so the bias can never push the mast out.
    y_lowest = max(0.0, subject.y + subject.h - crop_h)
    y_highest = min(h - crop_h, subject.y)
    preferred_y = subject.cy - crop_h / 2 + AUTOCROP_VERTICAL_BIAS * crop_h
    if y_highest >= y_lowest:
        y = min(max(preferred_y, y_lowest), y_highest)
    else:
        y = min(max(preferred_y, 0.0), h - crop_h)

    x = min(max(subject.cx - crop_w / 2, 0.0), w - crop_w)

    crop = _snap_to_aspect(Box(x, y, crop_w, crop_h), w, h)
    cut = (
        subject.x < crop.x - 0.5
        or subject.y < crop.y - 0.5
        or subject.x + subject.w > crop.x + crop.w + 0.5
        or subject.y + subject.h > crop.y + crop.h + 0.5
    )
    return crop, cut


def _snap_to_aspect(b: Box, w: int, h: int) -> Box:
    """
    Snap to integer pixels holding the aspect as closely as integers allow.

    Flooring width and height independently lets the ratio drift, which would
    mean a slightly different stretch on every photo once it is resized to the
    fixed output size — precisely the inconsistency this exists to remove. So
    pick an integer width, derive the height, and walk down if it overflows.
    """
    cw = max(1, min(int(b.w), w))
    ch = max(1, round(cw / AUTOCROP_ASPECT))
    while ch > h and cw > 1:
        cw -= 1
        ch = max(1, round(cw / AUTOCROP_ASPECT))
    ch = min(ch, h)
    return Box(
        float(min(max(round(b.x), 0), w - cw)),
        float(min(max(round(b.y), 0), h - ch)),
        float(cw),
        float(ch),
    )


async def auto_crop(image_bytes: bytes) -> bytes:
    """
    Reframe an enhanced image to the house 7:5 composition. Returns PNG bytes.

    Raises AutoCropUnavailableError when no usable subject is found; the caller
    should ship the image uncropped rather than fail the job.
    """
    img = pyvips.Image.new_from_buffer(image_bytes, "")

    long_edge = max(img.width, img.height)
    scale = min(1.0, AUTOCROP_DETECT_LONG_EDGE_PX / long_edge)
    detect_img = img.resize(scale, kernel="lanczos3") if scale < 1.0 else img
    if detect_img.hasalpha():
        # A cutout would otherwise be flattened onto black by the JPEG encode,
        # which is a strange thing to ask a detector to find a machine in.
        detect_img = detect_img.flatten(background=[255, 255, 255])
    detect_bytes = detect_img.write_to_buffer(".jpg", Q=90, strip=True)

    try:
        raw = await fal.run(
            AUTOCROP_MODEL,
            {
                # `text_input`, NOT `text_prompt`. Wrong field name is a 422.
                "image_url": fal.data_uri(detect_bytes, "image/jpeg"),
                "text_input": AUTOCROP_PROMPT,
            },
        )
    except fal.FalError as exc:
        raise AutoCropUnavailableError(f"detection failed: {exc}") from exc

    boxes = _parse_boxes(raw, detect_img.width, detect_img.height)
    subject = _select_subject(boxes, detect_img.width, detect_img.height)
    if subject is None:
        raise AutoCropUnavailableError(
            f"no machine found for prompt {AUTOCROP_PROMPT!r} "
            f"(detector returned {len(boxes)} usable box(es))"
        )

    # Scale the box out of detector-resolution coordinates and back into the
    # full-size image. Skipping this is the classic way to crop the wrong region.
    sx = img.width / detect_img.width
    sy = img.height / detect_img.height
    subject = Box(subject.x * sx, subject.y * sy, subject.w * sx, subject.h * sy)

    crop, cut = compute_crop(subject, img.width, img.height)
    logger.info(
        "autocrop: %dx%d -> crop %dx%d at (%d,%d), subject %dx%d, fill %.2f%s",
        img.width, img.height, int(crop.w), int(crop.h), int(crop.x), int(crop.y),
        int(subject.w), int(subject.h),
        max(subject.w / crop.w, subject.h / crop.h) if crop.w and crop.h else 0.0,
        " [SUBJECT CLIPPED]" if cut else "",
    )

    out = img.crop(int(crop.x), int(crop.y), int(crop.w), int(crop.h))
    return out.write_to_buffer(".png")
