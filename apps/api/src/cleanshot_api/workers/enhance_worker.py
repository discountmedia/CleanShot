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
import base64
import logging
import mimetypes
import uuid
from typing import Any

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

ENHANCE_MODEL_GEMINI = "gemini-2.5-flash-image"
ENHANCE_MODEL_OPENAI = "gpt-image-1"


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
            "PAINT REFRESH — REQUIRED VISIBLE CHANGE. Repaint every visibly-"
            "worn body panel so the machine looks like it just came out of "
            "a professional detail bay. Concretely:\n"
            "  – Where any panel is currently yellowed, cream-coloured, or "
            "dingy white, render it as clean, bright, even white.\n"
            "  – Where any panel is currently dull, faded, dirty, or chalky "
            "red, render it as clean, saturated, evenly painted red.\n"
            "  – Anywhere you see chips, scratches, scuffs, scrapes, paint "
            "loss, oxidation, stains, or dirt streaks, replace those areas "
            "with a smooth uniform coat of paint matching the surrounding "
            "panel's colour.\n"
            "The cab roof, overhead guard, mast, main body, step panels, "
            "and counterweight should all visibly look freshly painted in "
            "the output. Keep the same colours and the same panel-to-colour "
            "mapping — only the surface condition changes. The user MUST "
            "be able to see, at a glance, that the paint is fresher than "
            "the source."
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
            "Repaint the two forks with the standard OSHA two-tone safety "
            "scheme: the MAIN BODY of each fork — the heel, the vertical "
            "shank, and roughly the first 80% of the horizontal blade — "
            "must be solid bright safety RED. Only the final tip — the "
            "outermost ~15-20 cm (~6-8 inches) of the blade — should be "
            "solid bright safety YELLOW. The result must clearly read as "
            "a RED fork with a small YELLOW tip cap. Do NOT paint the "
            "entire fork yellow. Do NOT paint the entire fork red. Do "
            "not change fork length, profile, mounting, or position."
        )
    if toggles.shine_tires:
        modifiers.append(
            "Clean and refresh the EXISTING tires only. Remove dust, mud, "
            "salt residue, and grey UV fading from the original tires so "
            "the rubber looks darker and freshly dressed. Keep the same "
            "tires — do NOT replace them with new tires. Identical tire "
            "type (cushion / pneumatic / solid), identical tread pattern, "
            "identical wear profile, identical sidewall markings."
        )
    if toggles.improve_lighting:
        modifiers.append(
            "Improve the exposure of the existing photograph while keeping "
            "the original location and lighting character intact. Lift the "
            "deepest shadows just enough to reveal detail, recover any blown "
            "highlights, and neutralize obvious colour casts. Do NOT replace "
            "the lighting with studio lighting. Do NOT change the light "
            "direction or the location's ambient mood — the machine should "
            "still clearly read as photographed in the same place."
        )

    # Fallback when no toggles are on — should never happen given the
    # frontend's "at least one toggle" gate, but keep a sensible default.
    if not modifiers:
        modifiers.append(
            "Improve overall image quality: balanced exposure, accurate "
            "colour, and increased clarity. Do not alter the machine itself."
        )

    master = (
        "You are editing a photograph of a USED forklift. The goal is a "
        "thorough makeover of the SAME machine in the SAME place: clean "
        "paint, sharp decals, dressed tires — like the unit just rolled "
        "out of a professional detail bay. The output MUST be visibly "
        "improved versus the input. A reasonable viewer should be able "
        "to see at a glance that the machine has been cleaned up. "
        "\"Used lift with a really good makeover\" — not brand-new from "
        "factory, not a stock photo, not a studio composite."
    )

    modifier_block = "\n\n".join(f"• {m}" for m in modifiers)

    actions_lead = (
        "ACTIONS — apply each of the following wherever its described "
        "condition is present in the source. These are the changes the "
        "output must reflect:"
    )

    guardrails = (
        "GUARDRAILS — while applying the actions above, the following must "
        "stay identical to the source. These are limits on HOW you change "
        "the image, not reasons to skip the changes:\n"
        "• Background, floor, walls, surroundings — keep the exact same "
        "location. Never isolate the forklift on a white / studio / "
        "gradient backdrop. Never blur or replace the scene.\n"
        "• Lighting direction, ambient colour, and shadow placement. Do "
        "not swap warehouse / yard lighting for studio lighting.\n"
        "• Camera angle, framing, distance, proportions. No zoom, crop, "
        "rotate, horizon-leveling, or re-posing.\n"
        "• Make, model, year, trim level. Same mast configuration, fork "
        "count, fork length, overhead guard shape, counterweight shape, "
        "and tire type.\n"
        "• Tires themselves — same tread pattern, sidewall, wear profile. "
        "Refresh appearance only; do not swap for new tires.\n"
        "• Do NOT add lamps, beacons, mirrors, antennas, attachments, or "
        "any bolt-on hardware that is not already in the source.\n"
        "• Every OEM decal, capacity plate, VIN / serial number, and "
        "data tag remains present, legible, and unchanged. Do not invent "
        "or alter any text, digits, or logos on the machine.\n"
        "• Do not introduce damage, rust, dents, or wear that was not in "
        "the source image."
    )

    return (
        f"{master}\n\n"
        f"{actions_lead}\n\n"
        f"{modifier_block}\n\n"
        f"{guardrails}"
    )


async def _load_image_bytes(gcs_uri: str) -> tuple[bytes, str]:
    """Download bytes from GCS in a worker thread (sync SDK).
    Returns (bytes, detected_content_type).

    Duplicated from scan_worker.py for now — TODO: move to services/gcs.py
    once a third worker needs it.
    """
    from google.cloud import storage as gcs

    settings = get_settings()
    without_scheme = gcs_uri[len("gs://"):]
    bucket_name, _, object_name = without_scheme.partition("/")

    def _download() -> bytes:
        client = gcs.Client(project=settings.gcp_project)
        blob = client.bucket(bucket_name).blob(object_name)
        return blob.download_as_bytes()

    data = await asyncio.to_thread(_download)

    ct = "image/jpeg"
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        ct = "image/png"
    elif data[:4] == b"RIFF":
        ct = "image/webp"
    return data, ct


async def _enhance_with_gemini(
    genai_client: Any,
    gcs_uri: str,
    prompt: str,
) -> bytes:
    """Call Gemini 2.5 Flash Image. Returns raw PNG bytes."""
    mime_type = mimetypes.guess_type(gcs_uri)[0] or "image/jpeg"
    file_part = types.Part.from_uri(file_uri=gcs_uri, mime_type=mime_type)
    text_part = types.Part.from_text(text=prompt)

    response = await genai_client.aio.models.generate_content(
        model=ENHANCE_MODEL_GEMINI,
        contents=[types.Content(role="user", parts=[file_part, text_part])],
        config=types.GenerateContentConfig(response_modalities=["IMAGE", "TEXT"]),
    )

    # google-genai already decodes the protobuf bytes field, so `data` is raw
    # image bytes — do NOT b64-decode again (silently drops non-base64 chars).
    for part in response.candidates[0].content.parts:
        if part.inline_data and part.inline_data.data:
            return part.inline_data.data
    raise ValueError("Gemini returned no image part in enhance response")


async def _enhance_with_openai(
    openai_client: Any,
    gcs_uri: str,
    prompt: str,
) -> bytes:
    """
    Call OpenAI gpt-image-1's image-edit endpoint. Slower + costlier than
    Gemini (~$0.04–0.19 per image, ~8–15s typical) but sometimes recovers
    images that Gemini refuses or under-edits.

    OpenAI requires the image bytes in the request (no GCS URI ingress),
    so we download via _load_image_bytes first.
    """
    image_bytes, ct = await _load_image_bytes(gcs_uri)

    response = await openai_client.images.edit(
        model=ENHANCE_MODEL_OPENAI,
        # tuple form: (filename, content, content_type) for httpx multipart
        image=("input.jpg", image_bytes, ct),
        prompt=prompt,
        n=1,
        size="auto",
        quality="high",
    )

    if not response.data:
        raise ValueError("OpenAI returned no data in enhance response")
    b64 = response.data[0].b64_json
    if not b64:
        raise ValueError("OpenAI returned no b64_json image in enhance response")
    return base64.b64decode(b64)


async def _run_enhance(
    request: Request,
    payload: EnhanceTaskPayload,
) -> None:
    """Background coroutine — runs after HTTP 200 has been returned."""
    pool = request.app.state.pool
    genai_client = request.app.state.genai
    openai_client = request.app.state.openai
    gemini_semaphore: asyncio.Semaphore = request.app.state.gemini_semaphore

    async with pool.acquire() as conn:
        await queries.update_job_status(conn, payload.job_id, JobStatusEnum.processing)

    try:
        # Custom prompt overrides — either from the Scan tab's "Regenerate"
        # auto-prompt or the Enhance tab's "Custom prompt (advanced)" textarea.
        # When set, the model receives this text verbatim and toggles are
        # ignored. Otherwise the toggle-derived prompt is used.
        if payload.custom_prompt:
            prompt = payload.custom_prompt
        else:
            prompt = _build_enhance_prompt(payload.toggles)

        # Dispatch to the requested provider. Gemini calls go through the
        # per-instance semaphore (max 2 concurrent); OpenAI has its own
        # rate limits and doesn't share the cap.
        if payload.provider == "openai":
            if not openai_client:
                raise RuntimeError(
                    "OpenAI provider requested but client is not initialized. "
                    "Set OPENAI_API_KEY and ensure the lifespan picked it up."
                )
            output_bytes = await _enhance_with_openai(
                openai_client, payload.input_gcs_uri, prompt
            )
        else:  # "gemini" or default
            async with gemini_semaphore:
                output_bytes = await _enhance_with_gemini(
                    genai_client, payload.input_gcs_uri, prompt
                )

        if not output_bytes:
            raise ValueError(
                f"{payload.provider} returned no image bytes in enhance response"
            )

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
