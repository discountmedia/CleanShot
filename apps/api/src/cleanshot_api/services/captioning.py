"""
Image-to-filename captioning — used by /api/v1/export/pro/preview to
auto-name each resized JPEG with a short SEO-friendly slug instead of
the asset-id default.

We deliberately route this through the Vertex client (app.state.genai
with gemini-2.5-flash) rather than the AI Studio image-preview model:
  • Vertex's catalog includes 2.5-flash as a stable GA vision model.
  • Captioning is short prompts, no image generation — no need for the
    preview models that motivated the dual-client split.
  • Vertex Gemini accepts gs:// URIs via Part.from_uri, but we already
    have the bytes in hand from the resize pipeline so we inline them.

Typical wall-clock cost: ~1-2s per image on warm instances.

The CAPTION_PROMPT is tuned for used-forklift listing photos. If you
add a new vertical (e.g. construction equipment), parameterise the
prompt rather than overloading this one.
"""

from __future__ import annotations

import logging
import re
from typing import Any

from google.genai import types

logger = logging.getLogger(__name__)

CAPTION_MODEL = "gemini-2.5-flash"

CAPTION_PROMPT = (
    "Generate a short SEO-friendly filename slug for this used-forklift photo. "
    "Use 3-6 lowercase English words separated by hyphens. Describe the most "
    "distinctive visual features: brand (if visible on decals), colour, setting "
    "(warehouse / outdoor-yard / auction-lot / showroom), fork attachments, "
    "tire type if obvious. Include any make / model designation visible on the "
    "unit (for example '8fgu25', 'h50ft', 'gc25k') as one of the words. Do NOT "
    "include a file extension, the literal word 'forklift', special characters, "
    "or numbers from VIN / serial plates. Return ONLY the slug — no quotes, no "
    "trailing punctuation, no commentary.\n\n"
    "Example outputs:\n"
    "  yellow-toyota-8fgu25-warehouse-cushion\n"
    "  red-hyster-h50ft-outdoor-pneumatic\n"
    "  blue-clark-gc25k-auction-lot"
)


def sanitize_filename_slug(text: str, *, max_length: int = 60) -> str:
    """
    Convert AI output (or any string) into a filesystem-safe slug.

    Rules:
      • Lowercase.
      • Drop everything except ASCII alphanumerics, whitespace, and hyphens.
      • Collapse any run of whitespace / underscores / hyphens to one hyphen.
      • Trim leading + trailing hyphens.
      • Cap length, then re-trim trailing hyphens introduced by the cap.
      • Empty result → 'forklift' fallback so we never emit a bare '.jpg'.
    """
    text = (text or "").strip().lower()
    # Drop bracketed/quoted noise the model sometimes wraps the slug in.
    text = re.sub(r"[^\w\s-]", "", text)
    text = re.sub(r"[\s_-]+", "-", text)
    text = text.strip("-")
    if len(text) > max_length:
        text = text[:max_length].rstrip("-")
    return text or "forklift"


def make_filename_unique(base: str, used: set[str]) -> str:
    """
    If `base` is already in `used`, append -2, -3, … until unique.
    Mutates `used` by adding the chosen name. Caller passes the same
    set across an iteration so dupes within a single batch get
    distinguished without losing meaning.
    """
    if base not in used:
        used.add(base)
        return base
    i = 2
    while f"{base}-{i}" in used:
        i += 1
    chosen = f"{base}-{i}"
    used.add(chosen)
    return chosen


async def caption_image_for_filename(
    image_bytes: bytes,
    *,
    genai_client: Any,
    mime_type: str = "image/jpeg",
) -> str:
    """
    Ask Gemini Vision to produce a short filename slug describing the
    image. Returns the SANITISED slug (always safe to use as a filename
    component). Caller is responsible for uniquification.

    Returns empty string on any failure so callers can fall back to the
    asset-id naming. We intentionally don't raise — captioning is a
    nice-to-have and shouldn't fail the export.
    """
    try:
        file_part = types.Part.from_bytes(data=image_bytes, mime_type=mime_type)
        text_part = types.Part.from_text(text=CAPTION_PROMPT)
        response = await genai_client.aio.models.generate_content(
            model=CAPTION_MODEL,
            contents=[types.Content(role="user", parts=[file_part, text_part])],
        )
        raw = (response.text or "").strip()
        slug = sanitize_filename_slug(raw)
        # If the model returned something genuinely garbage (e.g. just
        # 'forklift'), sanitize_filename_slug's fallback will give us
        # 'forklift'. Treat that as "no useful caption" so caller falls
        # back to the asset-id naming.
        return "" if slug == "forklift" else slug
    except Exception:
        logger.exception("caption_image_for_filename failed; falling back to default name")
        return ""
