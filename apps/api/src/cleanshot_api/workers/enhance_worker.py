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
    Build a Gemini instruction prompt from the 7 active toggles.
    Field names match the camelCase aliases from the frontend exactly.
    Gemini has no negative_prompt — exclusions are written as positive descriptions.
    """
    parts: list[str] = []

    if toggles.new_paint_job:
        parts.append(
            "Repaint the forklift body in its original factory colour. "
            "The finish should appear clean, uniform, and professionally applied. "
            "Preserve all OEM decals, data plates, and capacity tags exactly."
        )
    if toggles.remove_rust:
        parts.append(
            "Remove all visible rust, corrosion, and oxidation from every surface. "
            "Restore affected areas to clean painted metal in the machine's original colour."
        )
    if toggles.restore_decals:
        parts.append(
            "Restore any faded, peeling, or missing OEM decals, brand logos, "
            "and capacity/safety labels to their original crisp, legible appearance."
        )
    if toggles.remove_people:
        parts.append(
            "Remove all people, bystanders, and human figures from the image. "
            "Fill vacated areas naturally with the surrounding background."
        )
    if toggles.paint_forks_red_yellow_tips:
        parts.append(
            "Paint the forklift forks red with yellow safety tips, "
            "following standard OSHA forklift safety colour conventions."
        )
    if toggles.shine_tires:
        parts.append(
            "Make all tires appear clean, jet-black, and recently conditioned. "
            "Remove dirt, dust, and fading. Tires should look showroom-ready."
        )
    if toggles.improve_lighting:
        parts.append(
            "Apply balanced exposure correction: reduce harsh shadows, "
            "eliminate blown highlights, correct white balance, and boost "
            "overall clarity so the machine appears professionally lit."
        )

    if not parts:
        parts.append("Make minor improvements to lighting and overall image clarity.")

    # Safety clause — always appended regardless of toggles
    parts.append(
        "CRITICAL: Preserve the forklift's exact colour, all OEM decals, "
        "data plates, VIN numbers, capacity tags, and proportions exactly. "
        "Do not alter, generate, or hallucinate any text or numbers on the machine."
    )

    return "\n".join(f"- {p}" for p in parts)


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
