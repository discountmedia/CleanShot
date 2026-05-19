"""
Enhance worker — Cloud Tasks HTTP Target handler.

Pattern (Phase 2 v2.5):
  1. HTTP 200 returned immediately (quick-acknowledge) to prevent Cloud Tasks
     from retrying a live task.
  2. asyncio.create_task() fires the Gemini call in the background.
  3. Semaphore(2) per instance limits concurrent Gemini Pro Image calls.
     Global cap is enforced by Cloud Tasks max_concurrent_dispatches=10.
  4. On completion: write output asset to GCS, update job row, auto-enqueue scan.

Model: gemini-2.5-flash-image (generation/cleanup)
"""

from __future__ import annotations

import asyncio
import logging
import mimetypes
import uuid

from fastapi import BackgroundTasks, Request
from google.genai import types

from cleanshot_api.core.config import get_settings
from cleanshot_api.db import queries
from cleanshot_api.models.schemas import (
    EnhanceTaskPayload,
    EnhanceToggles,
    JobStatusEnum,
    OperationEnum,
    ScanTaskPayload,
)
from cleanshot_api.services.tasks import enqueue_scan

logger = logging.getLogger(__name__)

ENHANCE_MODEL = "gemini-2.5-flash-image"
REGEN_PROMPT_KEY = "__regen_prompt_override__"  # sentinel — not a real toggle


def _build_enhance_prompt(toggles: EnhanceToggles) -> str:
    """
    Build a Gemini image-edit instruction from the 7 active toggles.

    Structure:
      1. MASTER GOAL — tells the model what kind of output we want overall.
         Without this, individual toggles read as descriptive sentences and
         Gemini does almost nothing.
      2. INVARIANTS — what must NOT change. Listed up front so the model
         treats them as hard constraints, not afterthoughts.
      3. CONDITIONAL MODIFIERS — each toggle is phrased as "ONLY if X is
         present, do Y; otherwise preserve as-is." Critical fix: the prior
         unconditional "Remove all visible rust" framing caused Gemini to
         add rust to clean machines because "rust" was the topic.
    """
    modifiers: list[str] = []

    if toggles.new_paint_job:
        modifiers.append(
            "Apply a fresh, even coat of the forklift's existing factory "
            "paint colour over the body panels. The finish should look "
            "smooth and freshly applied — no chips, scratches, oxidation, "
            "scuffs, or dirt. Do not change the colour itself."
        )
    if toggles.remove_rust:
        modifiers.append(
            "If — and only if — rust, corrosion, oxidation, or surface "
            "pitting is visible anywhere on the machine, replace those "
            "areas with clean painted metal in the surrounding OEM colour. "
            "Do not add, suggest, or imply any rust or wear that was not "
            "in the source image. If the machine is already clean, leave "
            "its surface exactly as-is."
        )
    if toggles.restore_decals:
        modifiers.append(
            "If OEM decals, brand logos, capacity stickers, or safety "
            "labels are faded, peeling, scratched, or partially missing, "
            "restore them to crisp, fully legible condition while keeping "
            "their original text, layout, and position. Do not invent new "
            "decals, add manufacturer logos that were not present, or "
            "change any model/capacity numbering."
        )
    if toggles.remove_people:
        modifiers.append(
            "Remove every person, operator, bystander, and hand from the "
            "frame. Fill the vacated space with whatever is plausibly "
            "behind them — warehouse floor, parking lot pavement, "
            "showroom flooring — matching the surrounding environment."
        )
    if toggles.paint_forks_red_yellow_tips:
        modifiers.append(
            "Repaint the two forks themselves: solid safety red along the "
            "shank, with bright safety yellow on the last ~6 inches of "
            "the tip. Standard OSHA fork-safety convention. Do not change "
            "fork length, profile, or mounting."
        )
    if toggles.shine_tires:
        modifiers.append(
            "Render the tires clean, deep black, and freshly conditioned, "
            "as if just dressed. Remove visible dust, mud, salt residue, "
            "and grey UV fading. Do not change tire type (cushion / "
            "pneumatic / solid), tread pattern, or sidewall markings."
        )
    if toggles.improve_lighting:
        modifiers.append(
            "Balance the exposure: lift deep shadows, recover any blown "
            "highlights, neutralize colour casts (yellow warehouse lights, "
            "blue overcast, etc.), and present the machine as if "
            "photographed under clean, soft, professional studio lighting."
        )

    # Fallback when no toggles are on — should never happen given the
    # frontend's "at least one toggle" gate, but keep a sensible default.
    if not modifiers:
        modifiers.append(
            "Improve overall image quality: balanced exposure, accurate "
            "colour, and increased clarity. Do not alter the machine itself."
        )

    master = (
        "Re-render this image as a professional dealership-listing "
        "photograph of the SAME forklift. The output must be visibly "
        "improved for use in an online inventory listing, while remaining "
        "an honest representation of the actual machine in the source image."
    )

    invariants = (
        "HARD CONSTRAINTS — these MUST hold in the output:\n"
        "• Same make, model, year, and trim level as the source.\n"
        "• Same mast configuration, fork count, fork length, and tire type.\n"
        "• Same camera angle, framing, and proportions (do not zoom, "
        "rotate, or re-pose the machine).\n"
        "• All OEM decals, capacity plates, VIN/serial numbers, and "
        "model/data tags remain present, legible, and unchanged. Do not "
        "alter, regenerate, or hallucinate any text, digits, or logos on "
        "the machine.\n"
        "• Do not introduce damage, rust, dents, scratches, or wear that "
        "was not in the source image."
    )

    modifier_block = "\n".join(f"• {m}" for m in modifiers)

    return (
        f"{master}\n\n"
        f"{invariants}\n\n"
        f"APPLY THE FOLLOWING — each item is conditional and only takes "
        f"effect where the described condition is present in the source:\n"
        f"{modifier_block}"
    )


async def _run_enhance(
    request: Request,
    payload: EnhanceTaskPayload,
) -> None:
    """Background coroutine — runs after HTTP 200 has been returned."""
    pool = request.app.state.pool
    genai_client = request.app.state.genai
    semaphore: asyncio.Semaphore = request.app.state.gemini_semaphore

    async with pool.acquire() as conn:
        await queries.update_job_status(conn, payload.job_id, JobStatusEnum.processing)

    try:
        async with semaphore:  # max 2 concurrent Gemini calls per instance
            # Regen from Scan tab: use the auto-generated anomaly prompt verbatim.
            # Toggle-derived prompt is used for normal Enhance flow.
            if payload.regen_prompt_override:
                prompt = payload.regen_prompt_override
            else:
                prompt = _build_enhance_prompt(payload.toggles)

            # Gemini file_data requires mime_type. Derive from filename in URI;
            # fall back to JPEG (matches SignedUploadUrlRequest default).
            mime_type = mimetypes.guess_type(payload.input_gcs_uri)[0] or "image/jpeg"
            file_part = types.Part.from_uri(
                file_uri=payload.input_gcs_uri,
                mime_type=mime_type,
            )
            text_part = types.Part.from_text(text=prompt)

            response = await genai_client.aio.models.generate_content(
                model=ENHANCE_MODEL,
                contents=[
                    types.Content(role="user", parts=[file_part, text_part])
                ],
                config=types.GenerateContentConfig(
                    response_modalities=["IMAGE", "TEXT"],
                ),
            )

        # Extract image bytes from response. google-genai already decodes the
        # protobuf bytes field, so `data` is raw image bytes — do NOT b64-decode
        # again (that silently drops non-base64 chars and produces garbage).
        output_bytes: bytes | None = None
        for part in response.candidates[0].content.parts:
            if part.inline_data and part.inline_data.data:
                output_bytes = part.inline_data.data
                break

        if not output_bytes:
            raise ValueError("Gemini returned no image part in enhance response")

        # Write output to GCS derivatives bucket
        output_gcs_uri = await _write_to_gcs(
            output_bytes,
            session_id=payload.session_id,
            job_id=payload.job_id,
            operation="enhance",
            content_type="image/png",
        )

        async with pool.acquire() as conn:
            output_asset = await queries.create_asset(
                conn,
                session_id=payload.session_id,
                operation=OperationEnum.enhance,
                gcs_uri=output_gcs_uri,
                content_hash=_sha256_hex(output_bytes),
            )
            await queries.update_job_status(
                conn,
                payload.job_id,
                JobStatusEnum.complete,
                output_asset_id=output_asset.id,
            )

        # Auto-enqueue scan job per spec
        scan_payload = ScanTaskPayload(
            job_id=uuid.uuid4(),
            session_id=payload.session_id,
            input_asset_id=output_asset.id,
            input_gcs_uri=output_gcs_uri,
        )
        async with pool.acquire() as conn:
            scan_job = await queries.create_job(
                conn,
                session_id=payload.session_id,
                operation=OperationEnum.scan,
                input_asset_id=output_asset.id,
                idempotency_key=f"auto-scan-{output_asset.id}",
            )
        scan_payload.job_id = scan_job.id
        tasks_name = enqueue_scan(scan_payload)
        async with pool.acquire() as conn:
            await queries.set_job_tasks_name(conn, scan_job.id, tasks_name)

        logger.info("Enhance complete for job %s; scan enqueued as %s", payload.job_id, scan_job.id)

    except Exception as exc:
        logger.exception("Enhance worker failed for job %s", payload.job_id)
        async with pool.acquire() as conn:
            await queries.update_job_status(
                conn,
                payload.job_id,
                JobStatusEnum.failed,
                error=str(exc)[:500],
            )


async def _write_to_gcs(
    data: bytes,
    *,
    session_id: uuid.UUID,
    job_id: uuid.UUID,
    operation: str,
    content_type: str,
) -> str:
    """Write bytes to the derivatives GCS bucket. Returns gs:// URI.
    Runs the sync GCS upload in a thread to avoid blocking the event loop.
    """
    from google.cloud import storage as gcs

    settings = get_settings()
    object_name = f"session/{session_id}/{operation}/{job_id}.png"

    def _upload() -> None:
        client = gcs.Client(project=settings.gcp_project)
        bucket = client.bucket(settings.gcs_bucket_derivatives)
        blob = bucket.blob(object_name)
        blob.upload_from_string(data, content_type=content_type)

    await asyncio.to_thread(_upload)
    return f"gs://{settings.gcs_bucket_derivatives}/{object_name}"


def _sha256_hex(data: bytes) -> str:
    import hashlib
    return hashlib.sha256(data).hexdigest()


async def handle_enhance_task(
    payload: EnhanceTaskPayload,
    background_tasks: BackgroundTasks,
    request: Request,
) -> dict:
    """
    FastAPI route handler for POST /worker/enhance.

    Returns HTTP 200 IMMEDIATELY (quick-acknowledge) then fires the
    Gemini work in the background. Cloud Tasks sees 200 → marks task done.
    If the background work fails, the job row is updated to status=failed.
    The frontend polls /jobs/{id} and shows the error state.
    """
    background_tasks.add_task(_run_enhance, request, payload)
    return {"status": "acknowledged"}
