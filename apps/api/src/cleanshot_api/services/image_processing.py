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


def export_pro(input_bytes: bytes) -> ExportResult:
    """
    PRO preset: 1024×731 (7:5), zoom-to-fill, JPEG ≤100 kb.
    Crop-not-letterbox: always fills the frame.
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


def export_collage(input_bytes: bytes) -> ExportResult:
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
    """
    img = pyvips.Image.new_from_buffer(input_bytes, "")

    long_edge = max(img.width, img.height)
    if long_edge > 1024:
        scale = 1024 / long_edge
        img = img.resize(scale, kernel="lanczos3")
    # else: input is already at-or-below target, no upscale — keep as-is.

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
