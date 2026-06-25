"""
Server-side image processing with pyvips (libvips 8.18+).

Used by the export endpoints only. All generative AI work happens in workers.

Rules per Phase 2 v2.5:
  PRO export:    1024px longest edge, 7×5 (1024×731) crop, JPEG ≤100 kb
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


def _apply_disclaimer_watermark(img: "pyvips.Image") -> "pyvips.Image":
    """
    Burn AI_DISCLAIMER_WATERMARK into the bottom-right corner of `img`.

    Renders a tiny string with a green "*Disclaimer:" label and a white
    body, plus a one-pixel dark shadow offset for legibility on both light
    and dark backgrounds. The output bytes carry the watermark permanently
    — the customer-facing listing photo cannot have it stripped.

    Sized for 1024-px-wide exports; on smaller images the relative
    proportion shifts but the watermark stays legible.
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
    # rgba=True renders the coloured text directly (4-band sRGB + alpha).
    text_img = pyvips.Image.text(
        markup,
        font="Roboto Bold 11",
        dpi=72,
        rgba=True,
    )

    margin = 12
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

    # Shadow: black RGBA following the text shape, dimmed to ~65% alpha.
    # `.copy(interpretation="srgb")` is REQUIRED — bandjoin produces a
    # 4-band image that pyvips otherwise tags as "multiband", which
    # libvips composite() refuses to align with the canvas's srgb
    # (errors: "vips_colourspace: no known route from 'multiband' to
    # 'srgb'"). Forcing the interpretation tells libvips to treat the
    # 4 bands as srgb+alpha.
    shadow = coverage.new_from_image([0, 0, 0]).bandjoin(
        (coverage * 0.65).cast("uchar"),
    ).copy(interpretation="srgb")
    # Foreground: the coloured text at ~92% alpha — less transparent than
    # before so the disclaimer reads clearly while still being a watermark.
    fg = rgb.bandjoin(
        (coverage * 0.92).cast("uchar"),
    ).copy(interpretation="srgb")

    img = img.composite(shadow, "over", x=x + 1, y=y + 1)
    img = img.composite(fg,     "over", x=x,     y=y)
    return img


def export_pro(input_bytes: bytes, *, ai_disclaimer: bool = False) -> ExportResult:
    """
    PRO preset: 1024×731 (7:5), zoom-to-fill, JPEG ≤100 kb.
    Crop-not-letterbox: always fills the frame.

    When `ai_disclaimer=True`, burns the AI_DISCLAIMER_WATERMARK string
    into the bottom-right corner BEFORE the quality-iteration loop so
    the watermark is encoded into the final JPEG bytes.
    """
    img = pyvips.Image.new_from_buffer(input_bytes, "")

    target_w, target_h = 1024, 731

    # Step 1: Cover-fit scale — pick the LARGER of the two ratios so the
    # image is guaranteed to cover the target box in both dimensions.
    # Previous version used `1024 / max(w, h)` (longest-edge fit), which
    # for inputs already close to 7:5 produced a result smaller than
    # 1024×731 on one axis. smartcrop then returned the full (sub-target)
    # image and the final JPEG had the wrong aspect ratio — looked like
    # letterboxing on listing platforms. Cover-fit matches what
    # export_custom does and guarantees both target dimensions are
    # achievable before cropping.
    scale = max(target_w / img.width, target_h / img.height)
    img = img.resize(scale, kernel="lanczos3")

    # Step 2: Smart crop to 1024×731 (7:5 ratio)
    img = img.smartcrop(target_w, target_h, interesting="attention")

    # Step 2b: Optional disclaimer watermark — applied AFTER the crop so
    # it lands at a fixed pixel offset from the final corner regardless
    # of the source aspect ratio.
    if ai_disclaimer:
        img = _apply_disclaimer_watermark(img)

    # Step 3: JPEG compression loop targeting ≤100 kb
    quality = 85
    max_size = 100 * 1024  # 100 kb
    data = b""
    size_warning = False

    for attempt in range(10):
        data = img.write_to_buffer(".jpg", Q=quality, optimize_coding=True)
        if len(data) <= max_size:
            break
        quality -= 8
        if quality < 20:
            size_warning = True
            break

    return ExportResult(data=data, content_type="image/jpeg", size_warning=size_warning)


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

    Bands are forced to 3 (drop alpha) up front so the LCH conversion
    + final encode stay consistent with the rest of the pipeline.
    """
    img = pyvips.Image.new_from_buffer(input_bytes, "")
    if img.bands == 4:
        img = img.extract_band(0, n=3)
    img = img.copy(interpretation="srgb")

    # ── Step 1: rotation + auto-wedge-crop ────────────────────────────
    if rotation_deg != 0.0:
        pre_w, pre_h = img.width, img.height
        # pyvips rotate() expands the bounding box and fills the
        # corners with black by default. We rotate then centre-crop
        # to the maximum inscribed rectangle so the wedges disappear.
        img = img.rotate(rotation_deg, background=[0, 0, 0])
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

    # Scale to cover target (never letterbox)
    scale = max(width / img.width, height / img.height)
    img = img.resize(scale, kernel="lanczos3")

    # Crop-not-letterbox: centre crop to exact target
    img = img.smartcrop(width, height, interesting="attention")

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
