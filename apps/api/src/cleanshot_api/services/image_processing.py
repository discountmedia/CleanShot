"""
Server-side image processing with pyvips (libvips 8.18+).

Used by the export endpoints only. All generative AI work happens in workers.

Rules per Phase 2 v2.5:
  PRO export:    largest 7:5 crop the source supports, JPEG Q92, no size target
                 (PRO resizes + compresses downstream — see export_pro)
                 Cap at 10 compression iterations. On failure, return closest
                 size with X-Warning: target-size-unachievable header.
  Custom export: min 100px, min 50kb, crop-not-letterbox enforced absolutely.
  All formats:   JPEG, PNG, WebP, BMP, SVG output supported.

libvips must be installed in the OS layer:
    apt-get install libvips-dev libvips42 librsvg2-common fontconfig
"""

from __future__ import annotations

import io
import tempfile
from pathlib import Path

import pyvips


class ExportResult:
    def __init__(self, data: bytes, content_type: str, size_warning: bool = False):
        self.data = data
        self.content_type = content_type
        self.size_warning = size_warning


# Watermark text burnt into the bottom-right of every exported JPEG when
# the operator ticks "Add AI disclaimer" in the Resize tab. Mirrors the
# AI_DISCLAIMER_WATERMARK constant in the web app — keep in sync.
#
# The leading "*Disclaimer:" label is rendered in green; the remainder in
# white. The split point is the literal label below — the renderer colours
# everything up to and including it green and the rest white.
AI_DISCLAIMER_LABEL = "*Disclaimer:"
AI_DISCLAIMER_WATERMARK = (
    "*Disclaimer:  AI enhanced images - used for representational purposes"
)

# Green applied to the "*Disclaimer:" label (Tailwind green-500).
_DISCLAIMER_LABEL_COLOR = "#22c55e"


# Watermark sizing. Proportional so legibility holds at any export resolution;
# see the docstring in _apply_disclaimer_watermark for why it stopped being a
# fixed point size.
_DISCLAIMER_PT_RATIO = 0.027
_DISCLAIMER_MIN_PT = 15


def _apply_disclaimer_watermark(img: "pyvips.Image") -> "pyvips.Image":
    """
    Burn AI_DISCLAIMER_WATERMARK into the bottom-right corner of `img`.

    Renders a tiny string with a green "*Disclaimer:" label and a white
    body, plus a one-pixel dark shadow offset for legibility on both light
    and dark backgrounds. The output bytes carry the watermark permanently
    — the customer-facing listing photo cannot have it stripped.

    Font size SCALES WITH IMAGE WIDTH rather than being fixed. It used to be a
    flat 15pt, tuned when every export was exactly 1024px wide. Now that PRO
    export emits the source's full resolution, a fixed size shrinks in relative
    terms as the image grows -- the bigger the export, the less legible the
    disclaimer. The owner's complaint was specifically that it is hard to read
    on mobile, where a listing photo is displayed a few hundred pixels wide.
    So: proportional size, heavier weight, and a stronger shadow.
    """
    # Pango markup so the label and body can carry different colours in a
    # single text render. Roboto matches the web-app preview font; falls
    # back to Liberation via fontconfig if Roboto isn't installed.
    label = AI_DISCLAIMER_LABEL
    body = AI_DISCLAIMER_WATERMARK[len(label):]
    markup = (
        f'<span foreground="{_DISCLAIMER_LABEL_COLOR}">{label}</span>'
        f'<span foreground="#ffffff">{body}</span>'
    )
    # ~2.7% of image width, so the disclaimer occupies the same fraction of the
    # frame at any export size and survives being scaled down for a mobile
    # listing. Floor of 15 keeps it at least as large as the old fixed size, so
    # this can only ever increase legibility, never reduce it.
    font_pt = max(_DISCLAIMER_MIN_PT, round(img.width * _DISCLAIMER_PT_RATIO))

    # rgba=True renders the coloured text directly (4-band sRGB + alpha).
    # Black (not Bold) for the extra stroke weight the owner asked for -- Roboto
    # ships a 900 weight, and Pango picks it up by name. Falls back through
    # fontconfig if Roboto Black is absent, which is why the Dockerfile installs
    # fonts-roboto (lesson #20).
    text_img = pyvips.Image.text(
        markup,
        font=f"Roboto Black {font_pt}",
        dpi=72,
        rgba=True,
    )

    # Margin scales too, so the text doesn't crowd the corner on a large export.
    margin = max(12, round(img.width * 0.012))
    x = img.width  - text_img.width  - margin
    y = img.height - text_img.height - margin
    # Bail if the export is too small to host the watermark at all
    # (e.g. a custom-export <100×100 thumbnail). The caller is expected
    # to only enable this for PRO exports which are always ≥1024px on
    # the long edge, but a defensive check keeps pyvips from crashing.
    if x < 0 or y < 0:
        return img

    # Alpha band carries the text coverage; RGB bands carry the colours.
    coverage = text_img.extract_band(3)
    rgb = text_img.extract_band(0, n=3)

    # Shadow: black RGBA following the text shape, dimmed to ~72% alpha.
    # `.copy(interpretation="srgb")` is REQUIRED — bandjoin produces a
    # 4-band image that pyvips otherwise tags as "multiband", which
    # libvips composite() refuses to align with the canvas's srgb
    # (errors: "vips_colourspace: no known route from 'multiband' to
    # 'srgb'"). Forcing the interpretation tells libvips to treat the
    # 4 bands as srgb+alpha.
    # Shadow alpha raised 0.72 -> 0.85: at the larger font the text sits over
    # more varied background, and the heavier drop makes it readable against a
    # bright sky or a white wall.
    shadow = coverage.new_from_image([0, 0, 0]).bandjoin(
        (coverage * 0.85).cast("uchar"),
    ).copy(interpretation="srgb")
    # Foreground: the coloured text at ~98% alpha — nearly opaque so the
    # disclaimer reads clearly while still being a burned-in watermark.
    fg = rgb.bandjoin(
        (coverage * 0.98).cast("uchar"),
    ).copy(interpretation="srgb")

    img = img.composite(shadow, "over", x=x + 1, y=y + 1)
    img = img.composite(fg,     "over", x=x,     y=y)
    return img


# True 7:5. 2800x2000 is exactly 1.4.
_PRO_ASPECT = 7 / 5

# THE standard size for an enhanced image, applied ONCE at the end of
# enhancement (2026-08-21). Everything downstream — per-image adjustments,
# the disclaimer composite, export, the copies written to the user's project —
# operates on an image that is already exactly this size and never resamples
# it again.
#
# Sizing used to live in export_pro, which meant the stored enhanced asset was
# whatever the vendor happened to return (~1024 from Gemini, 1536x1024 from
# OpenAI) and only became 7:5 on the way out. Moving it upstream makes the
# stored asset the finished article and makes export a pure passthrough, so
# there is exactly one place that can produce a dimension.
ENHANCED_WIDTH  = 2800
ENHANCED_HEIGHT = 2000

# Fixed high quality, no size target. PRO does its own resizing and compression
# now, so shrinking to fit a byte budget here would just throw away detail that
# PRO is about to resample anyway. 92 is visually lossless for listing photos at
# a sane file size.
_PRO_JPEG_QUALITY = 92


def _cover_crop(img: "pyvips.Image", width: int, height: int) -> "pyvips.Image":
    """
    Scale to COVER the target box, then crop the overflow. Never pads, never
    letterboxes, never stretches — a non-uniform scale would distort the
    machine and make the listing photo inaccurate, which is the whole reason
    this is crop-to-fill.

    The crop is CENTRED. `smartcrop(interesting="attention")` was the previous
    behaviour in export_custom and follows the salient region instead, which is
    arguably kinder on an extreme aspect ratio — but centre is deterministic
    and predictable, which is what an operator judging "what did the crop take?"
    needs. Swap the final call to smartcrop to change that.

    Extracted from export_custom rather than written a second time; both call
    sites share it so the two can't drift.
    """
    scale = max(width / img.width, height / img.height)
    img = img.resize(scale, kernel="lanczos3")

    # Guard the rounding: resize can land a pixel short of the target on one
    # axis, and crop rejects a box larger than its input.
    left = max(0, (img.width  - width)  // 2)
    top  = max(0, (img.height - height) // 2)
    w = min(width,  img.width  - left)
    h = min(height, img.height - top)
    return img.crop(left, top, w, h)


def upscale_to_standard(input_bytes: bytes) -> bytes:
    """
    Bring an enhanced image to exactly ENHANCED_WIDTH x ENHANCED_HEIGHT.

    Called ONCE, at the end of enhancement, before the bytes are written to
    GCS — so the stored asset is already the final size and every downstream
    stage (adjustments, disclaimer, export) works on it directly.

    Idempotent: an image already at the standard size is returned untouched
    rather than re-encoded, so a re-run or a second pass costs nothing and
    cannot accumulate JPEG generations.

    Emits PNG to stay lossless through the adjustment/erase/tweak stages that
    may follow; the single lossy encode happens at export.
    """
    img = pyvips.Image.new_from_buffer(input_bytes, "")
    if img.width == ENHANCED_WIDTH and img.height == ENHANCED_HEIGHT:
        return input_bytes
    img = _cover_crop(img, ENHANCED_WIDTH, ENHANCED_HEIGHT)
    return img.write_to_buffer(".png")


def export_pro(input_bytes: bytes, *, ai_disclaimer: bool = True) -> ExportResult:
    """
    PRO preset: encode the enhanced image as-is, at ENHANCED_WIDTH x
    ENHANCED_HEIGHT, JPEG at fixed high quality.

    THIS FUNCTION NO LONGER RESIZES OR CROPS (2026-08-21). Sizing moved
    upstream: enhancement standardises every output to 2800x2000 via
    upscale_to_standard() before it is stored, so by the time bytes reach here
    they are already exactly the export size. Resampling again would only cost
    detail and risk a second, slightly-different rounding.

    Every export path goes through this function or serves the stored asset
    directly, so no path can emit another dimension.

    A defensive cover-crop remains for the one case that can still arrive
    off-size: an asset created before this change. It is a migration guard, not
    the sizing policy.

    When `ai_disclaimer=True`, the AI_DISCLAIMER_WATERMARK is burned into the
    bottom-right corner BEFORE encoding, so it lands in the final JPEG bytes.

    This was briefly unconditional (2026-08-21) and is back to a flag pending a
    final decision on how the watermark gets applied. The default is True, so a
    caller that says nothing still gets the disclaimer — the UI checkbox is
    likewise on by default and the operator opts OUT. Reverting to unconditional
    is deleting the parameter and the `if` below.

    This remains the single place the watermark is applied and the single place
    export bytes are produced, so nothing downstream re-applies it.

    TRANSPARENT CUTOUTS EXIT AS PNG, NOT JPEG (2026-08-26). When the stored
    asset carries an alpha channel — the transparent-background toggle ran a
    matting pass over it — this emits PNG and SKIPS the disclaimer watermark.
    Both parts are forced:

      • JPEG has no alpha channel at all. Encoding a cutout as JPEG does not
        "lose transparency", it composites onto black, which is the single most
        visible possible failure on a product cutout.
      • The watermark is skipped because a cutout is destined for a product-page
        composite where a burnt-in corner caption lands on top of the site's own
        layout. Decided with the toggle; the `ai_disclaimer` argument is still
        honoured for every opaque export.

    The branch is driven by the IMAGE, not by a flag threaded down from the
    request. A flag can disagree with the bytes; `hasalpha()` cannot, and it
    means there is exactly one export button rather than a preset the operator
    has to remember to pick.
    """
    img = pyvips.Image.new_from_buffer(input_bytes, "")

    # Migration guard only. Anything produced by enhancement since 2026-08-21
    # is already exactly the standard size and falls straight through.
    if img.width != ENHANCED_WIDTH or img.height != ENHANCED_HEIGHT:
        img = _cover_crop(img, ENHANCED_WIDTH, ENHANCED_HEIGHT)

    if img.hasalpha():
        # Lossless, alpha preserved, no watermark. compression=6 is libvips'
        # default balance; a cutout is a hand-off asset, not a page weight
        # decision, and the site will re-encode it anyway.
        data = img.write_to_buffer(".png", compression=6)
        return ExportResult(
            data=data, content_type="image/png", size_warning=False
        )

    # Optional disclaimer watermark — composited onto the FINAL-SIZE image so
    # it lands at a fixed pixel offset from the corner, and before the encode
    # so it is part of the bytes rather than an overlay.
    if ai_disclaimer:
        img = _apply_disclaimer_watermark(img)

    # Step 4: single encode. No quality-iteration loop, so `size_warning` can no
    # longer be raised here — there is no size target left to miss.
    data = img.write_to_buffer(
        ".jpg", Q=_PRO_JPEG_QUALITY, optimize_coding=True
    )

    return ExportResult(data=data, content_type="image/jpeg", size_warning=False)


# ─── Modify (darkroom) adjustments ────────────────────────────────────────────
#
# Brightness / Contrast / Saturation applied via pyvips. Used by the Modify
# tab's batch endpoint — operator drags sliders, clicks Apply, every queued
# asset gets run through this helper and re-uploaded as a new asset.
#
# Slider math (matches the CSS-filter preview the frontend renders so the
# operator's live preview is faithful to the final bytes):
#   brightness: 0.5..1.5  (1.0 = no change; multiplicative on pixel values)
#   contrast:   0.5..1.5  (1.0 = no change; scales around midpoint 127.5)
#   saturation: 0.0..2.0  (1.0 = no change; scales LCH chroma band)
#
# Output is PNG (matches every other in-pipeline asset write — final JPEG
# encoding happens later in the Resize/PRO export step).


# Aspect-ratio map for the Modify-tab crop mode. Keys match the
# frontend's CropAspect literal. "free" is handled separately (no
# aspect lock — only the zoom factor applies).
_MODIFY_CROP_ASPECTS: dict[str, tuple[int, int]] = {
    "1:1":  (1, 1),
    "4:3":  (4, 3),
    "7:5":  (7, 5),
    "16:9": (16, 9),
}


def _inscribed_rect_after_rotation(
    width: int,
    height: int,
    angle_deg: float,
) -> tuple[int, int]:
    """
    Largest axis-aligned rectangle (matching the input aspect ratio)
    that fits inside `width x height` after rotation by `angle_deg`.
    Used to crop the triangular wedges introduced by the rotate step
    in apply_adjustments.

    Implements the closed-form formula for the maximum inscribed
    rectangle from a rotated bounding box. See e.g.
    https://stackoverflow.com/a/16778797 — handles both the wide and
    narrow source cases.
    """
    import math
    if angle_deg == 0.0:
        return (width, height)
    angle = math.radians(abs(angle_deg)) % math.pi
    if angle > math.pi / 2:
        angle = math.pi - angle
    # Limit guard: above 45° the formulas flip — we cap upstream at
    # ±15° so this is just defensive.
    if angle >= math.pi / 2:
        return (width, height)
    if width <= 0 or height <= 0:
        return (width, height)
    side_long  = max(width, height)
    side_short = min(width, height)
    sin_a = math.sin(angle)
    cos_a = math.cos(angle)
    if side_short <= 2 * sin_a * cos_a * side_long or abs(sin_a - cos_a) < 1e-10:
        # Half-by-half region case.
        x = 0.5 * side_short
        if width >= height:
            new_w = int(x / sin_a)
            new_h = int(x / cos_a)
        else:
            new_w = int(x / cos_a)
            new_h = int(x / sin_a)
    else:
        cos_2a = cos_a * cos_a - sin_a * sin_a
        new_long  = (side_long  * cos_a - side_short * sin_a) / cos_2a
        new_short = (side_short * cos_a - side_long  * sin_a) / cos_2a
        if width >= height:
            new_w, new_h = int(new_long),  int(new_short)
        else:
            new_w, new_h = int(new_short), int(new_long)
    return (max(1, new_w), max(1, new_h))


def apply_adjustments(
    input_bytes:  bytes,
    *,
    brightness:   float = 1.0,
    contrast:     float = 1.0,
    saturation:   float = 1.0,
    rotation_deg: float = 0.0,
    crop_aspect:  str   = "free",
    crop_zoom:    float = 1.0,
) -> bytes:
    """
    Run the operator's Modify-tab adjustments through pyvips and
    return the modified bytes as a PNG.

    Pipeline order:
      1. Rotate (if rotation_deg != 0): rotate the full source then
         centre-crop to the largest inscribed rectangle so the wedges
         introduced by rotation are gone.
      2. Crop (if crop_aspect != "free" OR crop_zoom < 1.0): smart-
         crop to the target aspect at the requested zoom level.
      3. Brightness + contrast (combined linear op).
      4. Saturation (LCH chroma scaling).

    ALPHA IS PRESERVED (2026-08-26). It used to be dropped outright, which
    meant a contrast tweak on a transparent cutout silently handed back an
    opaque image. The handling is split deliberately:

      • Through the GEOMETRY steps (rotate, crop) alpha stays ATTACHED, so it
        is transformed by the identical operation and still lines up with the
        colour bands afterwards. Detaching first and re-attaching later would
        misregister the mask the moment a rotation or crop was involved.
      • For the COLOUR steps it is detached, because `linear()` would scale
        transparency along with brightness and `colourspace("lch")` is not
        defined on an alpha band at all. It is re-joined immediately after.
    """
    img = pyvips.Image.new_from_buffer(input_bytes, "")
    # >4 bands (CMYK+alpha, or a stray extra channel) is not something this
    # pipeline produces; clamp to RGB(A) so the band arithmetic below holds.
    if img.bands > 4:
        img = img.extract_band(0, n=4 if img.hasalpha() else 3)
    img = img.copy(interpretation="srgb")

    # ── Step 1: rotation + auto-wedge-crop ────────────────────────────
    if rotation_deg != 0.0:
        pre_w, pre_h = img.width, img.height
        # pyvips rotate() expands the bounding box and fills the
        # corners with black by default. We rotate then centre-crop
        # to the maximum inscribed rectangle so the wedges disappear.
        # Wedge fill: transparent when the image carries alpha (the crop below
        # removes the wedges anyway, but a black fill would bleed at the seam
        # on a cutout), black otherwise, as before.
        img = img.rotate(
            rotation_deg,
            background=[0, 0, 0, 0] if img.hasalpha() else [0, 0, 0],
        )
        inner_w, inner_h = _inscribed_rect_after_rotation(pre_w, pre_h, rotation_deg)
        # Clamp inner dims to the rotated image's actual dims (rotation
        # can grow the bounding box, but the inscribed rect is always
        # inside the ORIGINAL source's pixel content).
        inner_w = min(inner_w, img.width)
        inner_h = min(inner_h, img.height)
        x_off = max(0, (img.width  - inner_w) // 2)
        y_off = max(0, (img.height - inner_h) // 2)
        img = img.crop(x_off, y_off, inner_w, inner_h)

    # ── Step 2: crop (aspect + zoom) ──────────────────────────────────
    if crop_aspect != "free" or crop_zoom < 1.0:
        if crop_aspect == "free":
            # No aspect lock — keep source aspect, just zoom-in.
            target_w = int(img.width  * crop_zoom)
            target_h = int(img.height * crop_zoom)
        else:
            aw, ah = _MODIFY_CROP_ASPECTS[crop_aspect]
            # Largest aspect-aw:ah rect that fits in the current image.
            if img.width / aw < img.height / ah:
                cell_w = img.width
                cell_h = int(img.width * ah / aw)
            else:
                cell_h = img.height
                cell_w = int(img.height * aw / ah)
            target_w = int(cell_w * crop_zoom)
            target_h = int(cell_h * crop_zoom)
        target_w = max(1, target_w)
        target_h = max(1, target_h)
        if target_w < img.width or target_h < img.height:
            img = img.smartcrop(target_w, target_h, interesting="attention")

    # ── Alpha detach — geometry is done, colour work starts ──────────
    # From here the maths is colour-only, so transparency comes off and goes
    # back on at the end. It has already been through the same rotate/crop as
    # the colour bands, so it is still registered to them.
    alpha = None
    if img.hasalpha():
        alpha = img.extract_band(img.bands - 1)
        img = img.extract_band(0, n=img.bands - 1)

    # ── Step 3: brightness + contrast (combined linear op) ───────────
    if brightness != 1.0 or contrast != 1.0:
        scale  = contrast * brightness
        offset = (1.0 - contrast) * 127.5
        img = img.linear(scale, offset).cast("uchar")

    # ── Step 4: saturation (LCH chroma scaling) ──────────────────────
    if saturation != 1.0:
        lch = img.colourspace("lch")
        l_band = lch.extract_band(0)
        c_band = lch.extract_band(1) * saturation
        h_band = lch.extract_band(2)
        lch = l_band.bandjoin([c_band, h_band]).copy(interpretation="lch")
        img = lch.colourspace("srgb").cast("uchar")

    # ── Alpha re-attach ─────────────────────────────────────────────
    if alpha is not None:
        img = img.bandjoin(alpha.cast("uchar"))

    return img.write_to_buffer(".png")


def export_custom(
    input_bytes: bytes,
    *,
    width: int,
    height: int,
    quality: int,
    fmt: str,
) -> ExportResult:
    """
    Custom export: crop-not-letterbox enforced. Min 100px both axes.
    fmt: 'jpeg' | 'png' | 'webp' | 'bmp'
    """
    assert width >= 100 and height >= 100, "Dimensions must be ≥100px"
    assert 50 <= quality <= 100, "Quality must be 50–100"

    img = pyvips.Image.new_from_buffer(input_bytes, "")

    # Crop-not-letterbox, via the shared helper this logic was extracted into
    # so export_custom and the enhancement standard can't drift apart.
    img = _cover_crop(img, width, height)

    fmt_map = {
        "jpeg": (".jpg", {"Q": quality, "optimize_coding": True}),
        "png": (".png", {"compression": max(0, 9 - quality // 10)}),
        "webp": (".webp", {"Q": quality}),
        "bmp": (".bmp", {}),
    }
    suffix, opts = fmt_map.get(fmt, fmt_map["jpeg"])
    content_types = {
        "jpeg": "image/jpeg",
        "png": "image/png",
        "webp": "image/webp",
        "bmp": "image/bmp",
    }

    data = img.write_to_buffer(suffix, **opts)
    return ExportResult(data=data, content_type=content_types.get(fmt, "image/jpeg"))
