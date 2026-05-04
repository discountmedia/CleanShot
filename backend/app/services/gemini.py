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

v2.5 hardening (after rear-→-front fabrication failure mode in production):
  - PRESERVATION RULES moved to TOP of prompt (LLMs weight early instructions
    more heavily; brand rules previously dominated)
  - Anti-fabrication clause added explicitly: do not invent missing parts
  - Every brand rule gated with "if visible in the source photo" — a rear-view
    photo with no forks no longer triggers fork-paint hallucination
  - Explicit perspective-lock: forbids rotation, mirror, angle change
  - Temperature dropped from 0.3 to 0.1 for stricter source adherence

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

# v2.5: Preservation comes FIRST. LLMs weight early instructions more heavily,
# and the previous prompt order (brand rules first, preservation last) caused
# the fork-paint rule to override perspective preservation, producing
# rear-view-→-front-view fabrications.

PRESERVATION_RULES = (
    "PRIMARY DIRECTIVE — Preserve the source photograph exactly:\n"
    "- Do NOT change the viewing angle, perspective, or orientation. "
    "If the source shows the REAR of the forklift, the output must show the rear. "
    "If the source shows a SIDE, the output must show that same side. "
    "Do not rotate, flip, mirror, or reconstruct the unit from a different angle.\n"
    "- Do NOT add, remove, or replace parts that are not visible in the source. "
    "If the source has no forks visible, do not draw forks. "
    "If the source has no operator cage visible, do not draw one. "
    "Restore only what is already in the photo.\n"
    "- Preserve the exact forklift model, attachments, decals, manufacturer "
    "branding, and proportions. Do not substitute the unit for a different model.\n"
    "- Keep the background, lighting direction, and shadows consistent with the "
    "source photo."
)

REALISM_GUARDRAIL = (
    "Realism guardrail: the forklift must still look like a realistic used unit "
    "the customer will receive. Do NOT make it appear factory-new unless the "
    "source photo already shows a near-new unit. Some honest patina and age is "
    "acceptable and preferred over a fake-looking pristine result."
)


# Toggleable Discount Forklift brand rules.
# v2.5: Every rule is gated with "if visible in the source." This is the
# critical change that prevents the fork-paint rule from forcing a perspective
# flip when no forks are visible in the source.

FORK_PAINT_RULE = (
    "If — and only if — the lifting forks are clearly visible in the source "
    "photo, paint them red with bright yellow tips. The paint should look "
    "freshly applied but not unrealistically perfect. "
    "If the forks are not visible (e.g., the photo shows the rear or a side "
    "view that does not show the forks), do NOT add or fabricate them — "
    "leave the photo as-is."
)

TIRE_SHINE_RULE = (
    "If tires are clearly visible in the source photo, give them a slight "
    "wet/shiny sheen as if recently tire-dressed. "
    "EXCEPTION: if the visible tires are cushion-style (solid rubber, no tread "
    "pattern) or marked non-marking (typically white or grey), keep them matte. "
    "Do NOT add shine to cushion or non-marking tires. "
    "If no tires are visible in the source photo, do not modify or add any."
)

RUST_REMOVAL_RULE = (
    "Clean up rust, corrosion, scratches, chipped paint, and minor dents that "
    "are visible on body panels in the source photo. "
    "Do not over-restore — the realism guardrail above takes priority. "
    "Do not invent surfaces or panels that are not visible in the source."
)


# Intensity dial. Controls how aggressively the model cleans up wear in general.

LEVEL_INSTRUCTIONS = {
    "light": (
        "Light cleanup pass: remove surface dust, dirt, and minor scuffs that "
        "are visible in the source. Leave honest wear visible — the unit "
        "should still look used."
    ),
    "moderate": (
        "Moderate restoration: clean, repaint where needed (only on visible "
        "surfaces), and polish to a presentable dealer-lot condition. The unit "
        "should look well-maintained but clearly used."
    ),
    "heavy": (
        "Heavy restoration: bring the unit close to showroom condition while "
        "respecting the realism guardrail and preservation directive above. "
        "Remove most visible wear, but the result must still look like a "
        "real used forklift photographed from the same angle, not a "
        "factory-new replacement."
    ),
}


def build_prompt(
    enhancement_level: str = "moderate",
    apply_fork_paint: bool = True,
    apply_tire_shine: bool = True,
    apply_rust_removal: bool = True,
    extra_instructions: Optional[str] = None,
) -> str:
    """
    Assemble a Gemini prompt from level + brand toggles + per-photo extras.

    v2.5 ordering:
      1. Role + preservation directive (highest weight)
      2. Realism guardrail
      3. Intensity level
      4. Toggleable brand styling rules (each gated 'if visible')
      5. Optional per-photo extras
    """
    parts = [
        "You are restoring a forklift photograph for a dealership listing. "
        "The goal is to make the EXISTING photo look more presentable, "
        "NOT to generate an idealized replacement image.",
        PRESERVATION_RULES,
        REALISM_GUARDRAIL,
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
            "Brand styling rules — each applies only if the relevant feature is "
            "actually visible in the source photo:\n"
            + "\n".join(f"- {r}" for r in rules)
        )

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
            # v2.5: Dropped from 0.3 → 0.1. Stricter adherence to the
            # preservation directive; less creative drift.
            temperature=0.1,
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
