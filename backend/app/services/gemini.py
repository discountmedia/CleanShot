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

Auth: Application Default Credentials. On Cloud Run this is the attached SA.
Locally, run `gcloud auth application-default login` once and mount the creds
into the docker-compose container.
"""

import structlog
from typing import Optional, List

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
            model=settings.gemini_model,
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

async def enhance_image(
    image_gcs_uri: str,
    mime_type: str,
    enhancement_level: str = "moderate",
    reference_uris: Optional[List[str]] = None,
    apply_fork_paint: bool = True,
    apply_tire_shine: bool = True,
    apply_rust_removal: bool = True,
    extra_instructions: Optional[str] = None,
) -> bytes:
    """
    Run Gemini 2.5 Flash Image enhance on a forklift image.

    Args:
        image_gcs_uri: gs://bucket/path of the source image
        mime_type: e.g. "image/jpeg"
        enhancement_level: "light" | "moderate" | "heavy"
        reference_uris: optional list of reference image GCS URIs (max 2 used)
        apply_fork_paint: include the red-forks-with-yellow-tips brand rule
        apply_tire_shine: include the wet-look-tire brand rule (auto-skips
            cushion/non-marking tires regardless)
        apply_rust_removal: include the rust/scratch cleanup rule
        extra_instructions: optional per-photo prompt addition (max 1000 chars,
            length-validated upstream in the API layer)

    Returns:
        Raw bytes of the generated image (caller decides where to write).

    Raises:
        ValueError if Gemini returns no image (e.g. content filter, prompt issue).
    """
    client = get_client()
    prompt = build_prompt(
        enhancement_level=enhancement_level,
        apply_fork_paint=apply_fork_paint,
        apply_tire_shine=apply_tire_shine,
        apply_rust_removal=apply_rust_removal,
        extra_instructions=extra_instructions,
    )

    # Build the contents list using the typed SDK helpers (cleaner than dicts).
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
        model=settings.gemini_model,
        level=enhancement_level,
        image_uri=image_gcs_uri,
        reference_count=len(reference_uris) if reference_uris else 0,
        fork_paint=apply_fork_paint,
        tire_shine=apply_tire_shine,
        rust_removal=apply_rust_removal,
        has_extras=bool(extra_instructions),
    )

    response = await client.aio.models.generate_content(
        model=settings.gemini_model,
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
            f"Gemini returned no image. finish_reasons={finish_reasons}"
        )

    logger.info("Gemini returned image", bytes=len(image_bytes))
    return image_bytes


# -----------------------------------------------------------------------------
# Internals
# -----------------------------------------------------------------------------

def _extract_first_image(response) -> Optional[bytes]:
    """
    Pull raw image bytes out of a generate_content response.

    Response shape (Gemini 2.5 Flash Image):
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
