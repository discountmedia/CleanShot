"""
Gemini Service — wraps google-genai 1.70.0 for image generation.

Three changes from the v2.1 scaffold:
  1. SDK retry config replaces tenacity (one retry layer, not two)
  2. Correct response_modalities (Modality enum, not all-caps string)
  3. No max_output_tokens cap — image responses need ~1290 output tokens

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
                    multiplier=2.0,
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
# Prompts (kept in code, version-controlled, easy to tune)
# -----------------------------------------------------------------------------

ENHANCE_PROMPTS = {
    "light": (
        "Enhance this forklift to look clean and well-maintained. "
        "Remove surface dust, dirt, and minor scuffs. "
        "The forklift should appear professionally cleaned. "
        "Preserve the exact color, decals, and proportions. "
        "Match perspective and lighting of the original. "
        "Do not change the forklift model or attachments. "
        "Keep the background and lighting unchanged."
    ),
    "moderate": (
        "Restore this forklift to good working condition appearance. "
        "Remove rust, dirt, scratches, and minor dents. "
        "The paint should look fresh but not necessarily new. "
        "Clean all surfaces and components. "
        "Preserve the exact color, decals, and proportions. "
        "Match perspective and lighting of the original. "
        "Do not change the forklift model or attachments. "
        "Keep the background and lighting unchanged."
    ),
    "heavy": (
        "Restore this forklift to like-new condition. "
        "The paint is fresh, all surfaces are pristine, "
        "no rust, corrosion, dirt, scratches, chipped paint, or wear. "
        "All components should appear new and properly maintained. "
        "Preserve the exact color, decals, and proportions. "
        "Match perspective and lighting of the original. "
        "Do not change the forklift model or attachments. "
        "Keep the background and lighting unchanged."
    ),
}


# -----------------------------------------------------------------------------
# Public API
# -----------------------------------------------------------------------------

async def enhance_image(
    image_gcs_uri: str,
    mime_type: str,
    enhancement_level: str = "moderate",
    reference_uris: Optional[List[str]] = None,
) -> bytes:
    """
    Run Gemini 2.5 Flash Image enhance on a forklift image.

    Args:
        image_gcs_uri: gs://bucket/path of the source image
        mime_type: e.g. "image/jpeg"
        enhancement_level: "light" | "moderate" | "heavy"
        reference_uris: optional list of reference image GCS URIs (max 2 used)

    Returns:
        Raw bytes of the generated image (caller decides where to write).

    Raises:
        ValueError if Gemini returns no image (e.g. content filter, prompt issue).
    """
    client = get_client()
    prompt = ENHANCE_PROMPTS.get(enhancement_level, ENHANCE_PROMPTS["moderate"])

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
