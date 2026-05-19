"""
Enhance worker — Cloud Tasks HTTP Target handler.

Pattern (Phase 2 v2.5):
  1. HTTP 200 returned immediately (quick-acknowledge) to prevent Cloud Tasks
     from retrying a live task.
  2. asyncio.create_task() fires the Gemini call in the background.
  3. Semaphore(2) per instance limits concurrent Gemini Pro Image calls.
     Global cap is enforced by Cloud Tasks max_concurrent_dispatches=10.
  4. On completion: write output asset to GCS, update job row, auto-enqueue scan.

Models: gemini-2.5-flash-image (default) | gpt-image-2-2026-04-21 (OpenAI opt-in) | flux-2-max (BFL opt-in)
"""

from __future__ import annotations

import asyncio
import base64
import logging
import mimetypes
import uuid
from typing import Any

import httpx
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

# Model IDs are pinned here. Update via this single source of truth.
#
# IMPORTANT — do NOT use Google's `-latest` aliases here. Vertex AI's
# Publisher Models catalog does not resolve them for image-gen variants
# (only the AI Studio backend does), so requests get a 404 NOT_FOUND
# "Publisher Model ... was not found or your project does not have
# access to it". This has bitten us three times in this codebase
# (gemini-3-pro-image-preview, gemini-3-flash-image, gemini-flash-latest
# all 404'd the same way). Always pin to an explicit dated/numbered
# image model that's published in us-central1 for this project.
ENHANCE_MODEL_GEMINI = "gemini-3.1-flash-image-preview"
# gpt-image-2 dated snapshot (2026-04-21 release). Switch back to a
# moving alias like "gpt-image-2-latest" if/when one exists and you
# prefer auto-tracked updates.
ENHANCE_MODEL_OPENAI = "gpt-image-2-2026-04-21"
# BFL endpoint URL — flux-2-max is their flagship image editor with
# product/identity consistency (preserves the input subject while
# changing context, surface treatment, lighting, etc.). The earlier
# flux-2-pro endpoint was generation-flavored and tended to fabricate
# a new subject rather than edit the source.
#
# Async pattern: POST returns { id, polling_url }; we poll polling_url
# until status="Ready", then GET result.sample to fetch the bytes.
#
# Request body field for the source image is `input_image` (base64
# string, no data: prefix). The flux-2-pro endpoint used `image_prompt`
# for the same field — the rename was a breaking change between the
# two endpoints.
FLUX_GENERATE_URL = "https://api.bfl.ai/v1/flux-2-max"
FLUX_POLL_INTERVAL_S = 1.5         # seconds between poll requests
FLUX_POLL_MAX_ATTEMPTS = 60        # ~90s total budget; FLUX 2 MAX typically finishes in 10-30s


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
    if toggles.remove_background_signage:
        extras.append(
            "ADDITIONAL ACTION — clean up background signage. Remove from "
            "the surrounding environment: exit signs, fire-exit signs, "
            "company logos, posters, notice boards, wall-mounted notices, "
            "branded banners, store branding, racking labels, and any "
            "other printed text or signage on the walls, doors, ceilings, "
            "or floor of the scene. Replace each removed sign with a "
            "plausible continuation of the wall / door / surface behind "
            "it (same colour, same material, same lighting).\n"
            "  CRITICAL EXCEPTION — do NOT touch any signage that lives "
            "ON THE FORKLIFT ITSELF. The OEM decals, brand name on the "
            "mast (e.g., 'NISSAN', 'TOYOTA', 'HYSTER'), capacity plates, "
            "VIN / serial numbers, model badges, safety stickers, and "
            "data tags must all remain present, legible, and unchanged. "
            "Only environmental / background signage is removed."
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
    Call OpenAI gpt-image-2's image-edit endpoint. Slower + costlier than
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


async def _enhance_with_flux(gcs_uri: str, prompt: str) -> bytes:
    """
    Call Black Forest Labs FLUX 2 PRO via the async-polling pattern.

      1. POST FLUX_GENERATE_URL with prompt + base64 image_prompt →
         { id, polling_url }
      2. GET polling_url every FLUX_POLL_INTERVAL_S seconds (auth via
         x-key) until status == "Ready" (or terminal error).
      3. GET result.sample (a presigned URL, no auth) → JPEG bytes.

    The polling_url returned by the submit already encodes BFL's region;
    use it verbatim rather than reconstructing.

    BFL terminal statuses to surface as job failures:
      "Error" | "Content Moderated" | "Request Moderated" | "Task not found"

    Typical latency: 10-30s. Budget ceiling is
    FLUX_POLL_INTERVAL_S × FLUX_POLL_MAX_ATTEMPTS (~90s today).
    """
    settings = get_settings()
    if not settings.bfl_api_key:
        raise RuntimeError(
            "Flux provider requested but BFL_API_KEY is not set. "
            "Mount cleanshot-bfl-key:latest via Cloud Run --set-secrets "
            "and re-deploy."
        )

    image_bytes, _ct = await _load_image_bytes(gcs_uri)
    image_b64 = base64.b64encode(image_bytes).decode()

    auth_headers = {"x-key": settings.bfl_api_key}

    async with httpx.AsyncClient(timeout=30.0) as client:
        # ── 1. Submit ─────────────────────────────────────────────────
        submit = await client.post(
            FLUX_GENERATE_URL,
            headers={**auth_headers, "Content-Type": "application/json"},
            json={"prompt": prompt, "input_image": image_b64},
        )
        if submit.status_code >= 400:
            raise ValueError(
                f"BFL submit failed ({submit.status_code}): {submit.text[:300]}"
            )
        submit_data = submit.json()
        polling_url = submit_data.get("polling_url")
        if not polling_url:
            raise ValueError(f"BFL submit returned no polling_url: {submit_data}")

        # ── 2. Poll ──────────────────────────────────────────────────
        for _attempt in range(FLUX_POLL_MAX_ATTEMPTS):
            await asyncio.sleep(FLUX_POLL_INTERVAL_S)
            poll = await client.get(polling_url, headers=auth_headers)
            if poll.status_code >= 400:
                raise ValueError(
                    f"BFL poll failed ({poll.status_code}): {poll.text[:300]}"
                )
            poll_data = poll.json()
            status = poll_data.get("status")

            if status == "Ready":
                result = poll_data.get("result") or {}
                sample_url = result.get("sample")
                if not sample_url:
                    raise ValueError(
                        f"BFL Ready without result.sample URL: {poll_data}"
                    )
                # ── 3. Fetch rendered image (signed URL, no auth) ───
                image_resp = await client.get(sample_url)
                image_resp.raise_for_status()
                return image_resp.content

            if status in (
                "Error",
                "Content Moderated",
                "Request Moderated",
                "Task not found",
            ):
                detail = poll_data.get("result") or poll_data.get("error") or "no detail"
                raise ValueError(f"BFL returned terminal status '{status}': {detail}")
            # Otherwise still "Pending" / transient — keep polling.

        raise TimeoutError(
            f"BFL FLUX 2 PRO did not finish within "
            f"{FLUX_POLL_INTERVAL_S * FLUX_POLL_MAX_ATTEMPTS:.0f}s "
            f"({FLUX_POLL_MAX_ATTEMPTS} polls)"
        )


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
        # per-instance semaphore (Vertex AI quota is the binding cap). OpenAI
        # and Flux have their own vendor-side rate limits and don't share
        # ours.
        if payload.provider == "openai":
            if not openai_client:
                raise RuntimeError(
                    "OpenAI provider requested but client is not initialized. "
                    "Set OPENAI_API_KEY and ensure the lifespan picked it up."
                )
            output_bytes = await _enhance_with_openai(
                openai_client, payload.input_gcs_uri, prompt
            )
        elif payload.provider == "flux":
            output_bytes = await _enhance_with_flux(
                payload.input_gcs_uri, prompt
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
