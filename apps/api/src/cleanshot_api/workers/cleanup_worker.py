"""
Cleanup worker — uses scan anomaly context to generate a targeted cleanup prompt.

Model: gemini-2.5-flash-image (matches the enhance worker's default).
The anomaly_context list (from scan_results) is formatted into the prompt so
Gemini addresses specific issues rather than making general improvements.
"""

from __future__ import annotations

import asyncio
import logging
import mimetypes
import time
import uuid
from typing import Any

from fastapi import BackgroundTasks, Request
from google.genai import types

from cleanshot_api.core.config import get_settings
from cleanshot_api.db import queries
from cleanshot_api.models.schemas import (
    CleanupTaskPayload,
    JobStatusEnum,
    OperationEnum,
)
# Shared helper — third worker needing this download utility (scan, enhance,
# now cleanup). TODO: extract to cleanshot_api.services.gcs.download_image
# once we're ready for the 3-file refactor.
from cleanshot_api.workers.enhance_worker import _load_image_bytes

logger = logging.getLogger(__name__)

CLEANUP_MODEL = "gemini-3.1-flash-image-preview"


def _build_cleanup_prompt(anomaly_context: list[dict[str, Any]] | None) -> str:
    base = (
        "You are performing targeted cleanup and restoration on a forklift image "
        "for commercial resale photography. "
    )

    if anomaly_context:
        items = "\n".join(
            f"  - [{a.get('severity','?').upper()}] {a.get('type','anomaly')} "
            f"at {a.get('location','unknown')}: {a.get('description','')}"
            for a in anomaly_context
        )
        task = (
            f"Address the following detected anomalies:\n{items}\n\n"
            "For each issue: clean, repair, or restore the affected area to "
            "professional showroom condition."
        )
    else:
        task = (
            "Perform general cleanup: remove rust, dirt, scratches, and blemishes. "
            "Restore paint and surfaces to clean, professional condition."
        )

    safety = (
        "\n\nCRITICAL: Preserve ALL of the following exactly:\n"
        "- OEM brand decals and logos\n"
        "- Data plates and capacity tags\n"
        "- VIN and serial numbers\n"
        "- Fork tine geometry and mast structure\n"
        "- Machine proportions and perspective\n"
        "Do not alter, generate, or hallucinate any text or numbers."
    )

    return base + task + safety


async def _run_cleanup(
    request: Request,
    payload: CleanupTaskPayload,
) -> None:
    pool = request.app.state.pool
    # Cleanup uses the AI Studio Gemini client (same reason as enhance:
    # preview image-gen models live on AI Studio first, may never reach
    # Vertex's Publisher catalog).
    genai_client = request.app.state.genai_aistudio
    if not genai_client:
        async with pool.acquire() as conn:
            await queries.update_job_status(
                conn,
                payload.job_id,
                JobStatusEnum.failed,
                error=(
                    "Cleanup requires the AI Studio Gemini client but "
                    "GEMINI_API_KEY is not set."
                ),
            )
        return
    semaphore: asyncio.Semaphore = request.app.state.gemini_semaphore
    settings = get_settings()

    async with pool.acquire() as conn:
        await queries.update_job_status(conn, payload.job_id, JobStatusEnum.processing)

    try:
        async with semaphore:
            prompt = _build_cleanup_prompt(payload.anomaly_context)

            # AI Studio doesn't accept GCS URIs — download bytes and inline
            # via Part.from_bytes. Derive mime from the URI filename.
            mime_type = mimetypes.guess_type(payload.input_gcs_uri)[0] or "image/jpeg"
            image_bytes, _ct = await _load_image_bytes(payload.input_gcs_uri)
            file_part = types.Part.from_bytes(data=image_bytes, mime_type=mime_type)
            text_part = types.Part.from_text(text=prompt)

            response = await genai_client.aio.models.generate_content(
                model=CLEANUP_MODEL,
                contents=[
                    types.Content(role="user", parts=[file_part, text_part])
                ],
                config=types.GenerateContentConfig(
                    response_modalities=["IMAGE", "TEXT"],
                    # Gemini 3.x thinking control — see enhance_worker
                    # for rationale. Dropped from "High" to "Medium"
                    # alongside the 1024px input downsize; smaller
                    # inputs + targeted anomaly prompts don't need the
                    # full reasoning budget. Bump back to "High" if you
                    # see cleanup outputs missing flagged issues.
                    thinking_config=types.ThinkingConfig(thinking_level="Medium"),
                ),
            )

        # google-genai already decodes the protobuf bytes field, so `data` is
        # raw image bytes — do NOT b64-decode again (would silently drop
        # non-base64 chars and produce garbage).
        output_bytes: bytes | None = None
        for part in response.candidates[0].content.parts:
            if part.inline_data and part.inline_data.data:
                output_bytes = part.inline_data.data
                break

        if not output_bytes:
            raise ValueError("Gemini returned no image part in cleanup response")

        # Write to GCS derivatives — run sync client in thread to avoid blocking event loop
        from google.cloud import storage as gcs

        object_name = f"session/{payload.session_id}/cleanup/{payload.job_id}.png"

        def _upload() -> None:
            client = gcs.Client(project=settings.gcp_project)
            bucket = client.bucket(settings.gcs_bucket_derivatives)
            blob = bucket.blob(object_name)
            blob.upload_from_string(output_bytes, content_type="image/png")

        await asyncio.to_thread(_upload)
        output_gcs_uri = f"gs://{settings.gcs_bucket_derivatives}/{object_name}"

        import hashlib
        content_hash = hashlib.sha256(output_bytes).hexdigest()

        async with pool.acquire() as conn:
            output_asset = await queries.create_asset(
                conn,
                session_id=payload.session_id,
                operation=OperationEnum.cleanup,
                gcs_uri=output_gcs_uri,
                content_hash=content_hash,
            )
            await queries.update_job_status(
                conn,
                payload.job_id,
                JobStatusEnum.complete,
                output_asset_id=output_asset.id,
            )

        logger.info("Cleanup complete for job %s", payload.job_id)

    except Exception as exc:
        logger.exception("Cleanup worker failed for job %s", payload.job_id)
        async with pool.acquire() as conn:
            await queries.update_job_status(
                conn,
                payload.job_id,
                JobStatusEnum.failed,
                error=str(exc)[:500],
            )


async def handle_cleanup_task(
    payload: CleanupTaskPayload,
    background_tasks: BackgroundTasks,
    request: Request,
) -> dict:
    """Quick-acknowledge then fire cleanup in background."""
    background_tasks.add_task(_run_cleanup, request, payload)
    return {"status": "acknowledged"}
