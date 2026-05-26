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
AI_DISCLAIMER_WATERMARK = (
    "AI-enhanced image — depicts the unit as it will be delivered"
)


def _apply_disclaimer_watermark(img: "pyvips.Image") -> "pyvips.Image":
    """
    Burn AI_DISCLAIMER_WATERMARK into the bottom-right corner of `img`.

    Renders a tiny semi-transparent white string with a one-pixel dark
    shadow offset for legibility on both light and dark backgrounds. The
    output bytes carry the watermark permanently — the customer-facing
    listing photo cannot have it stripped.

    Sized for 1024-px-wide exports; on smaller images the relative
    proportion shifts but the watermark stays legible.
    """
    # Single-band alpha mask: U8 with values 0..255 where text was drawn.
    mask = pyvips.Image.text(
        AI_DISCLAIMER_WATERMARK,
        font="sans bold 11",
        dpi=72,
    )

    margin = 12
    x = img.width  - mask.width  - margin
    y = img.height - mask.height - margin
    # Bail if the export is too small to host the watermark at all
    # (e.g. a custom-export <100×100 thumbnail). The caller is expected
    # to only enable this for PRO/Collage which are always ≥1024px on
    # the long edge, but a defensive check keeps pyvips from crashing.
    if x < 0 or y < 0:
        return img

    # Shadow: black RGBA with the same text mask, dimmed to ~55% alpha.
    # `.copy(interpretation="srgb")` is REQUIRED — bandjoin produces a
    # 4-band image that pyvips otherwise tags as "multiband", which
    # libvips composite() refuses to align with the canvas's srgb
    # (errors: "vips_colourspace: no known route from 'multiband' to
    # 'srgb'"). Forcing the interpretation tells libvips to treat the
    # 4 bands as srgb+alpha.
    shadow = mask.new_from_image([0, 0, 0]).bandjoin(
        (mask * 0.55).cast("uchar"),
    ).copy(interpretation="srgb")
    # Foreground: white RGBA, dimmed to ~70% alpha so the disclaimer is
    # readable but unmistakably a watermark, not a primary element.
    fg = mask.new_from_image([255, 255, 255]).bandjoin(
        (mask * 0.70).cast("uchar"),
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


def export_collage(input_bytes: bytes, *, ai_disclaimer: bool = False) -> ExportResult:
    """
    COLLAGE preset: 1024px LONG EDGE (fit, NOT crop), JPEG ≤99 kb.

    Unlike PRO (1024×731 7:5 zoom-to-fill), collage images preserve the
    source aspect ratio entirely — the operator has already composed the
    layout, we just downsize so it fits the marketing target. Output is
    whatever (≤1024 × ≤1024) preserves the original shape.

    Quality iteration mirrors export_pro: start at Q=85, drop by 8 each
    miss, stop at Q<20 with size_warning=True. Same ≤100 kb-class
    behaviour, just one kilobyte tighter at 99 kb so collages reliably
    fit under listing-site upload caps that quote "100 kb max".

    When `ai_disclaimer=True`, burns the AI_DISCLAIMER_WATERMARK string
    into the bottom-right corner before the quality loop.
    """
    img = pyvips.Image.new_from_buffer(input_bytes, "")

    long_edge = max(img.width, img.height)
    if long_edge > 1024:
        scale = 1024 / long_edge
        img = img.resize(scale, kernel="lanczos3")
    # else: input is already at-or-below target, no upscale — keep as-is.

    if ai_disclaimer:
        img = _apply_disclaimer_watermark(img)

    quality = 85
    max_size = 99 * 1024  # 99 kb (cushion below the 100 kb listing cap)
    data = b""
    size_warning = False

    for _attempt in range(10):
        data = img.write_to_buffer(".jpg", Q=quality, optimize_coding=True)
        if len(data) <= max_size:
            break
        quality -= 8
        if quality < 20:
            size_warning = True
            break

    return ExportResult(data=data, content_type="image/jpeg", size_warning=size_warning)


# ─── Branded collage composer ─────────────────────────────────────────────────
#
# Discount Forklift's marketing-layout collage: one large hero on the left
# + four supporting thumbnails stacked on the right. Final canvas is
# 1024×540 (long edge = 1024) and the JPEG quality loop targets ≤99 kb.
#
# Layout, edge-to-edge (no gaps):
#
#   ┌─────────────────────────────────────┬───────────────────────┐
#   │                                     │   thumb 1 (304×135)   │
#   │                                     ├───────────────────────┤
#   │       hero (720×540)                │   thumb 2 (304×135)   │
#   │                                     ├───────────────────────┤
#   │                                     │   thumb 3 (304×135)   │
#   │                                     ├───────────────────────┤
#   │                                     │   thumb 4 (304×135)   │
#   └─────────────────────────────────────┴───────────────────────┘
#                                                       1024 × 540
#
# Dimension rationale: matches the company's existing marketing-layout
# collage (reference: blue Genie GS-1930 example). Hero is 4:3 (720×540)
# so the studio banner across the top of the source frames cleanly
# without being side-cropped. Thumbs are 304×135 (≈2.25:1) — narrower
# than the prior 384×145, again so the banner makes it into each thumb
# instead of getting cropped off.
#
# Each cell is cover-cropped (zoom-to-fill) so the cell is fully filled
# with no letterboxing. smartcrop with `attention` interest picks the
# most visually-important region — same heuristic as export_pro.

_COLLAGE_CANVAS_W = 1024
_COLLAGE_CANVAS_H = 540
_COLLAGE_HERO_W   = 720
_COLLAGE_HERO_H   = 540
_COLLAGE_THUMB_W  = 304  # 1024 - 720
_COLLAGE_THUMB_H  = 135  # 540 / 4 (canvas height 540 = 4×135)


def _cover_crop(input_bytes: bytes, target_w: int, target_h: int) -> "pyvips.Image":
    """
    Decode `input_bytes`, scale to cover the target box in both dims,
    then smart-crop to the exact target size. Used as the per-cell
    resize for the branded collage HERO cell.
    """
    img = pyvips.Image.new_from_buffer(input_bytes, "")
    scale = max(target_w / img.width, target_h / img.height)
    img = img.resize(scale, kernel="lanczos3")
    img = img.smartcrop(target_w, target_h, interesting="attention")
    # Strip alpha if present so the JPEG encoder doesn't choke on RGBA.
    if img.bands == 4:
        img = img.extract_band(0, n=3)
    return img.copy(interpretation="srgb")


def _letterbox_to_aspect(
    input_bytes: bytes,
    cell_w: int,
    cell_h: int,
    aspect_w: int,
    aspect_h: int,
) -> "pyvips.Image":
    """
    Decode `input_bytes`, fit it (longest-edge, no crop) inside the
    largest `aspect_w:aspect_h` box that still fits inside `cell_w x
    cell_h`, then embed that into a black `cell_w x cell_h` canvas,
    centered. Used as the per-cell resize for the branded collage
    THUMB cells — operator wants each thumb to show the source at the
    7:5 listing aspect with black bars filling any leftover space in
    the cell, not a smart-cropped fill.
    """
    img = pyvips.Image.new_from_buffer(input_bytes, "")
    if img.bands == 4:
        img = img.extract_band(0, n=3)
    img = img.copy(interpretation="srgb")

    # Largest aspect_w:aspect_h box that fits inside (cell_w, cell_h).
    box_w_from_h = int(cell_h * aspect_w / aspect_h)
    box_h_from_w = int(cell_w * aspect_h / aspect_w)
    if box_w_from_h <= cell_w:
        inner_w, inner_h = box_w_from_h, cell_h
    else:
        inner_w, inner_h = cell_w, box_h_from_w

    # Fit the source inside that inner box (no crop — letterbox the
    # source's own aspect into the 7:5 frame as needed, so the operator
    # sees the full source).
    scale = min(inner_w / img.width, inner_h / img.height)
    img = img.resize(scale, kernel="lanczos3")

    # Build a black cell-sized canvas and insert the fit image,
    # centered. `gravity` would be neater but isn't on this libvips
    # build everywhere we run; manual insert keeps it portable.
    canvas = pyvips.Image.black(cell_w, cell_h, bands=3).copy(interpretation="srgb")
    x_off = (cell_w - img.width) // 2
    y_off = (cell_h - img.height) // 2
    canvas = canvas.insert(img, x_off, y_off)
    return canvas


def compose_branded_collage(
    *,
    hero_bytes:    bytes,
    thumb_bytes:   list[bytes],
    ai_disclaimer: bool = False,
) -> ExportResult:
    """
    Compose the 1-hero + 4-thumb marketing collage. `thumb_bytes` MUST
    have exactly 4 entries; the schema caller enforces this. Output is a
    single JPEG, 1024×580, iteratively re-encoded until ≤99 kb (same
    quality loop as export_collage).

    When `ai_disclaimer=True`, burns the AI_DISCLAIMER_WATERMARK string
    into the bottom-right corner after composition.
    """
    if len(thumb_bytes) != 4:
        raise ValueError(
            f"compose_branded_collage expects 4 thumbnails, got {len(thumb_bytes)}",
        )

    # Start from a black canvas of the final dimensions — pyvips
    # `black()` makes a 1-band image; embed into 3 RGB bands so the
    # subsequent composite-from-RGB works without band-count surprises.
    canvas = pyvips.Image.black(_COLLAGE_CANVAS_W, _COLLAGE_CANVAS_H, bands=3).copy(
        interpretation="srgb",
    )

    # Hero on the left — cover-crop (zoom-to-fill, no letterboxing).
    hero = _cover_crop(hero_bytes, _COLLAGE_HERO_W, _COLLAGE_HERO_H)
    canvas = canvas.insert(hero, 0, 0)

    # Thumbnail strip on the right — top to bottom. Per operator
    # request: each thumb shows the source at the 7:5 listing aspect
    # (the same aspect as the PRO export) with black bars filling
    # whatever's left of the 304x135 cell. Pillarbox / letterbox
    # rather than cover-crop so the operator sees the FULL source
    # framed for listing, not a cropped slice.
    for i, raw in enumerate(thumb_bytes):
        thumb = _letterbox_to_aspect(
            raw,
            cell_w=_COLLAGE_THUMB_W,
            cell_h=_COLLAGE_THUMB_H,
            aspect_w=7,
            aspect_h=5,
        )
        canvas = canvas.insert(thumb, _COLLAGE_HERO_W, i * _COLLAGE_THUMB_H)

    if ai_disclaimer:
        canvas = _apply_disclaimer_watermark(canvas)

    # JPEG quality iteration loop — mirror export_collage's 99 kb target.
    quality = 85
    max_size = 99 * 1024
    data = b""
    size_warning = False
    for _attempt in range(10):
        data = canvas.write_to_buffer(".jpg", Q=quality, optimize_coding=True)
        if len(data) <= max_size:
            break
        quality -= 8
        if quality < 20:
            size_warning = True
            break

    return ExportResult(data=data, content_type="image/jpeg", size_warning=size_warning)


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
