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
    Build a Gemini image-edit instruction.

    Hardcoded standard treatment + optional toggle-driven emphasis.

    Structure (applied to every Enhance request regardless of toggle state):
      1. MASTER GOAL — used-lift makeover, same machine in same place,
         output MUST be visibly improved.
      2. STANDARD TREATMENT — paint refresh, decal restoration, rust
         removal, tire refresh, lighting correction. ALWAYS in the prompt.
         These were previously gated behind individual toggles, but
         Gemini's conservative bias meant toggling them on barely
         produced change. Making them unconditional + present-tense
         significantly raises compliance.
      3. ADDITIONAL EMPHASIS — driven by toggles. The five "core"
         toggles emphasize the matching base item; remove_people and
         paint_forks_red_yellow_tips add genuinely new actions.
      4. GUARDRAILS — same scene, same hardware, readable decals.
    """
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

    standard_treatment = (
        "STANDARD TREATMENT — apply ALL of the following to every request. "
        "These are the changes the output MUST reflect:\n\n"

        "• PAINT REFRESH. Repaint every visibly-worn body panel so the "
        "machine looks like it just came out of a professional detail bay. "
        "Concretely:\n"
        "    – Where any panel is currently yellowed, cream-coloured, or "
        "dingy white, render it as clean, bright, even white.\n"
        "    – Where any panel is currently dull, faded, dirty, or chalky "
        "red, render it as clean, saturated, evenly painted red.\n"
        "    – Anywhere you see chips, scratches, scuffs, scrapes, paint "
        "loss, oxidation, stains, or dirt streaks, replace those areas "
        "with a smooth uniform coat of paint matching the surrounding "
        "panel's colour.\n"
        "  The cab roof, overhead guard, mast, main body, step panels, "
        "and counterweight should all visibly look freshly painted in the "
        "output. Keep the same colours and the same panel-to-colour "
        "mapping — only the surface condition changes.\n\n"

        "• DECAL RESTORATION. Restore every OEM decal, brand logo, "
        "capacity sticker, model badge, and safety label to crisp, fully "
        "legible condition. Keep their original text, layout, and "
        "position. Do not invent new decals, add manufacturer logos that "
        "were not present, or change any model / capacity numbering.\n\n"

        "• RUST + CORROSION. Where rust, corrosion, oxidation, or surface "
        "pitting is visible, replace those areas with clean painted metal "
        "in the surrounding OEM colour. Do NOT add or imply rust or wear "
        "that was not in the source.\n\n"

        "• TIRE REFRESH. Clean and refresh the EXISTING tires — darker "
        "rubber, no dust or grime, freshly dressed appearance. Keep the "
        "same tires (same type, tread, sidewall, wear profile); do NOT "
        "swap them for new tires.\n\n"

        "• LIGHTING / EXPOSURE. Lift the deepest shadows just enough to "
        "reveal detail, recover any blown highlights, and neutralize "
        "obvious colour casts. Keep the scene's original light direction "
        "and ambient mood — do NOT replace it with studio lighting."
    )

    # Toggle-driven additions. The 5 "core" toggles emphasize a base item;
    # remove_people and paint_forks_red_yellow_tips add genuinely new
    # actions the standard treatment doesn't cover.
    extras: list[str] = []

    if toggles.new_paint_job:
        extras.append(
            "EXTRA EMPHASIS — paint refresh. This image has been flagged "
            "as needing particularly fresh paint; be especially aggressive "
            "on the paint step above."
        )
    if toggles.remove_rust:
        extras.append(
            "EXTRA EMPHASIS — rust removal. This image has been flagged "
            "as needing particularly thorough rust / corrosion cleanup."
        )
    if toggles.restore_decals:
        extras.append(
            "EXTRA EMPHASIS — decals. Pay extra attention to decal "
            "restoration on this image; every label should read perfectly "
            "crisp in the output."
        )
    if toggles.shine_tires:
        extras.append(
            "EXTRA EMPHASIS — tires. Pay extra attention to the tire "
            "refresh; the rubber should read as freshly conditioned."
        )
    if toggles.improve_lighting:
        extras.append(
            "EXTRA EMPHASIS — lighting / exposure. Balance the histogram "
            "more aggressively on this image while keeping the scene's "
            "location intact."
        )
    if toggles.remove_people:
        extras.append(
            "ADDITIONAL ACTION — remove every person, operator, bystander, "
            "and hand from the frame. Fill the vacated space with whatever "
            "is plausibly behind them (warehouse floor, parking lot "
            "pavement, showroom flooring), matching the surrounding "
            "environment."
        )
    if toggles.paint_forks_red_yellow_tips:
        extras.append(
            "ADDITIONAL ACTION — repaint the forks with the standard OSHA "
            "two-tone safety scheme. The MAIN BODY of each fork (the heel, "
            "the vertical shank, and roughly the first 80% of the "
            "horizontal blade) must be solid bright safety RED. Only the "
            "final tip — the outermost ~15-20 cm (~6-8 inches) of the "
            "blade — should be solid bright safety YELLOW. The result must "
            "clearly read as a RED fork with a small YELLOW tip cap. Do "
            "NOT paint the entire fork yellow or the entire fork red. Do "
            "not change fork length, profile, mounting, or position."
        )

    extras_block = (
        "ADDITIONAL EMPHASIS — apply ON TOP of the standard treatment:\n\n"
        + "\n\n".join(f"• {e}" for e in extras)
        if extras
        else ""
    )

    guardrails = (
        "GUARDRAILS — while applying everything above, the following must "
        "stay identical to the source. These are limits on HOW you change "
        "the image, not reasons to skip the standard treatment:\n"
        "• Background, floor, walls, surroundings — keep the exact same "
        "location. Never isolate the forklift on a white / studio / "
        "gradient backdrop. Never blur or replace the scene.\n"
        "• Lighting direction, ambient colour, and shadow placement. "
        "Refresh exposure, but keep the same lighting character.\n"
        "• Camera angle, framing, distance, proportions. No zoom, crop, "
        "rotate, horizon-leveling, or re-posing.\n"
        "• Make, model, year, trim level. Same mast configuration, fork "
        "count, fork length, overhead guard shape, counterweight shape, "
        "and tire type.\n"
        "• Do NOT add lamps, beacons, mirrors, antennas, attachments, or "
        "any bolt-on hardware that is not already in the source.\n"
        "• Every OEM decal, capacity plate, VIN / serial number, and "
        "data tag remains present, legible, and unchanged. Do not invent "
        "or alter any text, digits, or logos on the machine.\n"
        "• Do not introduce damage, rust, dents, or wear that was not in "
        "the source image."
    )

    sections = [master, standard_treatment]
    if extras_block:
        sections.append(extras_block)
    sections.append(guardrails)
    return "\n\n".join(sections)


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
