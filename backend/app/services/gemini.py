"""
Gemini Service — wraps google-genai 1.70.0 for image generation.

Three changes from the v2.1 scaffold:
  1. SDK retry config replaces tenacity (one retry layer, not two)
  2. Correct response_modalities (Modality enum, not all-caps string)
  3. No max_output_tokens cap — image responses need ~1290 output tokens

v2.3 additions:
  - Modular prompt construction: brand rules can be toggled per-request
  - Discount Forklift house style: red forks with yellow tips, shiny tires,
    rust removal, realism guardrail to avoid over-restoration
  - Per-photo extra_instructions for edge cases

v2.4.1 additions:
  - Gemini 3 cutover: Enhance defaults to gemini-3-pro-image-preview
  - On NotFound / PermissionDenied (preview model decommissioned, project not
    allowlisted), automatically falls back to gemini-2.5-flash-image
  - enhance_image() now returns (bytes, model_label) so the worker can
    record model_used on the job hash for UI display

Auth: Application Default Credentials. On Cloud Run this is the attached SA.
Locally, run `gcloud auth application-default login` once and mount the creds
into the docker-compose container.
"""

import structlog
from typing import Optional, List, Tuple

from google import genai
from google.genai import types as genai_types

from app.config import settings


logger = structlog.get_logger()


# Module-level singleton client. The constructor is expensive (~150ms);
# don't recreate per-request or per-job.
_client: Optional[genai.Client] = None


def get_client() -> genai.Client:
    """Lazy-init module-level Gemini client."""
    global _client
    if _client is None:
        _client = genai.Client(
            vertexai=settings.use_vertex_ai,
            project=settings.gcp_project_id,
            location=settings.gcp_location,
            http_options=genai_types.HttpOptions(
                api_version="v1",
                # SDK-level retry: 5 attempts, exponential, jittered
                retry_options=genai_types.HttpRetryOptions(
                    attempts=5,
                    exp_base=2.0,
                    jitter=0.5,
                ),
            ),
        )
        logger.info(
            "Gemini client initialized",
            project=settings.gcp_project_id,
            location=settings.gcp_location,
            enhance_model=settings.gemini_enhance_model,
            enhance_fallback_model=settings.gemini_enhance_fallback_model,
            scan_model=settings.gemini_scan_model,
        )
    return _client


# -----------------------------------------------------------------------------
# Prompt construction (modular — brand rules are toggleable per-request)
# -----------------------------------------------------------------------------

# Always-on rules. These keep the AI from generating a fake-looking forklift
# or fundamentally changing the unit. Not exposed to end-users.

REALISM_GUARDRAIL = (
    "Realism guardrail: the forklift must still look like a realistic used unit "
    "the customer will receive. Do NOT make it appear factory-new unless the source "
    "photo already shows a near-new unit. Some honest patina and age is acceptable "
    "and preferred over a fake-looking pristine result."
)

PRESERVATION_RULES = (
    "Preserve the exact forklift model, attachments, decals, and overall proportions. "
    "Match the original perspective and lighting. Keep the background unchanged."
)


# Toggleable Discount Forklift brand rules. Default on, end-user can disable
# any individual rule per-photo if Gemini repeatedly produces bad output.

FORK_PAINT_RULE = (
    "Forks must be painted red with yellow tips. If the forks are unpainted, rusted, "
    "scratched, or a different color, repaint them red with bright yellow tips. "
    "The paint should look freshly applied but not unrealistically perfect."
)

TIRE_SHINE_RULE = (
    "Tires should look freshly cleaned with a slight wet/shiny sheen, as if recently "
    "tire-dressed. IMPORTANT EXCEPTION: if the tires are cushion-style (solid rubber, "
    "no tread pattern) or marked non-marking (typically white or grey), keep them matte. "
    "Do NOT add shine to cushion or non-marking tires."
)

RUST_REMOVAL_RULE = (
    "Clean up rust, corrosion, scratches, chipped paint, and minor dents on body panels. "
    "Do not over-restore — the realism guardrail above takes priority over this rule."
)


# Intensity dial. Controls how aggressively the model cleans up wear in general.

LEVEL_INSTRUCTIONS = {
    "light": (
        "Light cleanup pass: remove surface dust, dirt, and minor scuffs. "
        "Leave honest wear visible — the unit should still look used."
    ),
    "moderate": (
        "Moderate restoration: clean, repaint where needed, and polish to a "
        "presentable dealer-lot condition. The unit should look well-maintained "
        "but clearly used."
    ),
    "heavy": (
        "Heavy restoration: bring the unit close to showroom condition while "
        "respecting the realism guardrail. Remove most visible wear, but the "
        "result should still look like a real used forklift, not factory-new."
    ),
}


def build_prompt(
    enhancement_level: str = "moderate",
    apply_fork_paint: bool = True,
    apply_tire_shine: bool = True,
    apply_rust_removal: bool = True,
    extra_instructions: Optional[str] = None,
) -> str:
    """Assemble a Gemini prompt from level + brand toggles + per-photo extras."""
    parts = [
        "You are restoring a forklift photograph for a dealership listing.",
        LEVEL_INSTRUCTIONS.get(enhancement_level, LEVEL_INSTRUCTIONS["moderate"]),
    ]

    # Toggleable brand styling rules
    rules = []
    if apply_fork_paint:
        rules.append(FORK_PAINT_RULE)
    if apply_tire_shine:
        rules.append(TIRE_SHINE_RULE)
    if apply_rust_removal:
        rules.append(RUST_REMOVAL_RULE)

    if rules:
        parts.append(
            "Brand styling rules:\n" + "\n".join(f"- {r}" for r in rules)
        )

    # Always-on rules (cannot be disabled by end-users)
    parts.append(REALISM_GUARDRAIL)
    parts.append(PRESERVATION_RULES)

    # Optional per-photo additions
    if extra_instructions:
        parts.append(
            "Additional instructions for this specific photo:\n"
            + extra_instructions.strip()
        )

    return "\n\n".join(parts)


# -----------------------------------------------------------------------------
# Public API
# -----------------------------------------------------------------------------

# Heuristic: the SDK doesn't expose a clean "model unavailable" exception class
# distinct from transient errors, so we match on the error text. These are the
# substrings that indicate the model itself is the problem (vs network/quota).
# Transient errors are already handled by SDK retry; if we see them here it's
# a real failure and we shouldn't silently downgrade to the fallback model.
_FALLBACK_TRIGGERS = (
    "not found",
    "404",
    "permission",
    "permission_denied",
    "permissiondenied",
    "403",
    "not allowed",
    "is not available",
    "does not exist",
    "is not supported",
)


def _model_label(model_id: str) -> str:
    """Compact label for the job-result UI: 'pro' | 'flash-2.5' | <model_id>."""
    if "pro-image" in model_id:
        return "pro"
    if "flash-image" in model_id:
        return "flash-2.5"
    # Future-proofing: if the model name changes, just return it as-is so the
    # frontend at least shows something accurate.
    return model_id


async def enhance_image(
    image_gcs_uri: str,
    mime_type: str,
    enhancement_level: str = "moderate",
    reference_uris: Optional[List[str]] = None,
    apply_fork_paint: bool = True,
    apply_tire_shine: bool = True,
    apply_rust_removal: bool = True,
    extra_instructions: Optional[str] = None,
) -> Tuple[bytes, str]:
    """
    Run Gemini enhance on a forklift image.

    v2.4.1: tries settings.gemini_enhance_model (Pro Image) first; on
    NotFound / PermissionDenied (typically preview-model decommissioning or
    project not allowlisted), falls back to settings.gemini_enhance_fallback_model.

    Args:
        image_gcs_uri: gs://bucket/path of the source image
        mime_type: e.g. "image/jpeg"
        enhancement_level: "light" | "moderate" | "heavy"
        reference_uris: optional list of reference image GCS URIs (max 2 used)
        apply_fork_paint: include the red-forks-with-yellow-tips brand rule
        apply_tire_shine: include the wet-look-tire brand rule
        apply_rust_removal: include the rust/scratch cleanup rule
        extra_instructions: optional per-photo prompt addition

    Returns:
        (image_bytes, model_label) — model_label is "pro" or "flash-2.5".
        The worker writes model_label onto the job hash so the result UI can
        show which model produced the output.

    Raises:
        ValueError if both primary and fallback models fail to return an image.
    """
    prompt = build_prompt(
        enhancement_level=enhancement_level,
        apply_fork_paint=apply_fork_paint,
        apply_tire_shine=apply_tire_shine,
        apply_rust_removal=apply_rust_removal,
        extra_instructions=extra_instructions,
    )

    primary = settings.gemini_enhance_model
    fallback = settings.gemini_enhance_fallback_model

    try:
        image_bytes = await _generate_with_model(
            model=primary,
            image_gcs_uri=image_gcs_uri,
            mime_type=mime_type,
            prompt=prompt,
            reference_uris=reference_uris,
            level=enhancement_level,
            apply_fork_paint=apply_fork_paint,
            apply_tire_shine=apply_tire_shine,
            apply_rust_removal=apply_rust_removal,
            has_extras=bool(extra_instructions),
        )
        return image_bytes, _model_label(primary)
    except Exception as exc:
        msg = str(exc).lower()
        is_unavailable = any(s in msg for s in _FALLBACK_TRIGGERS)
        if not is_unavailable or primary == fallback:
            # Either it's a transient/real error (re-raise so the worker fails
            # loudly), or the fallback IS the primary (no point retrying).
            raise

        logger.warning(
            "Primary enhance model unavailable; falling back",
            primary=primary,
            fallback=fallback,
            error=str(exc),
        )
        image_bytes = await _generate_with_model(
            model=fallback,
            image_gcs_uri=image_gcs_uri,
            mime_type=mime_type,
            prompt=prompt,
            reference_uris=reference_uris,
            level=enhancement_level,
            apply_fork_paint=apply_fork_paint,
            apply_tire_shine=apply_tire_shine,
            apply_rust_removal=apply_rust_removal,
            has_extras=bool(extra_instructions),
        )
        return image_bytes, _model_label(fallback)


async def _generate_with_model(
    *,
    model: str,
    image_gcs_uri: str,
    mime_type: str,
    prompt: str,
    reference_uris: Optional[List[str]],
    level: str,
    apply_fork_paint: bool,
    apply_tire_shine: bool,
    apply_rust_removal: bool,
    has_extras: bool,
) -> bytes:
    """The actual generate_content call. Extracted so the fallback path can reuse it."""
    client = get_client()

    parts: list = [
        genai_types.Part.from_uri(file_uri=image_gcs_uri, mime_type=mime_type),
    ]
    if reference_uris:
        for ref_uri in reference_uris[:2]:  # cap at 2 references for cost
            parts.append(
                genai_types.Part.from_uri(file_uri=ref_uri, mime_type=mime_type)
            )
    parts.append(genai_types.Part.from_text(text=prompt))

    logger.info(
        "Calling Gemini",
        model=model,
        level=level,
        image_uri=image_gcs_uri,
        reference_count=len(reference_uris) if reference_uris else 0,
        fork_paint=apply_fork_paint,
        tire_shine=apply_tire_shine,
        rust_removal=apply_rust_removal,
        has_extras=has_extras,
    )

    response = await client.aio.models.generate_content(
        model=model,
        contents=parts,
        config=genai_types.GenerateContentConfig(
            # Image-only response; no text. Use the Modality enum, not strings.
            response_modalities=[genai_types.Modality.IMAGE],
            temperature=0.3,  # lower = more deterministic, less drift
        ),
    )

    image_bytes = _extract_first_image(response)
    if image_bytes is None:
        # Surface useful error info to the worker for logging
        finish_reasons = []
        if response.candidates:
            finish_reasons = [
                str(c.finish_reason) for c in response.candidates if c.finish_reason
            ]
        raise ValueError(
            f"Gemini ({model}) returned no image. finish_reasons={finish_reasons}"
        )

    logger.info("Gemini returned image", model=model, bytes=len(image_bytes))
    return image_bytes


# -----------------------------------------------------------------------------
# Internals
# -----------------------------------------------------------------------------

def _extract_first_image(response) -> Optional[bytes]:
    """
    Pull raw image bytes out of a generate_content response.

    Response shape (Gemini 2.5 Flash Image / Gemini 3 Pro Image):
      response.candidates[0].content.parts[*].inline_data.data    # bytes
    """
    if not response.candidates:
        return None
    for candidate in response.candidates:
        if not candidate.content or not candidate.content.parts:
            continue
        for part in candidate.content.parts:
            inline = getattr(part, "inline_data", None)
            if inline and getattr(inline, "data", None):
                return inline.data
    return None
