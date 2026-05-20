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
from cleanshot_api.services.pricing import estimate_cost_usd
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

# Reve endpoint — synchronous JSON request, returns base64-encoded PNG +
# credit accounting in the same response. Auth via Bearer token in
# Authorization header. We pin to `latest-fast` (resolves to
# reve-edit-fast@20251030) instead of `latest` for RPM headroom; the
# full-quality model trips Reve's undocumented per-minute cap on small
# bursts. Pin to a dated slug like "reve-edit-fast@20251030" if you
# need frozen behaviour across versions.
REVE_GENERATE_URL = "https://api.reve.com/v1/image/edit"
ENHANCE_MODEL_REVE = "reve-edit-fast-latest"
# Reve's edit_instruction field caps at 2560 chars — our stock prompt
# can exceed that with all toggles on, so we truncate. The Reve docs
# explicitly say "this instruction will be automatically enhanced by
# the model", so a clean truncation at a sentence boundary loses less
# than it would on the more literal providers.
REVE_PROMPT_MAX_CHARS = 2560

# Grok / xAI image editing — synchronous JSON request to /v1/images/edits.
# Auth via Bearer header. Source image is sent as a base64 data URI
# inside the `image` object (NOT the OpenAI-compatible multipart/edit
# shape — the xAI docs explicitly call out that openai-sdk's
# client.images.edit() doesn't work because xAI's endpoint requires
# application/json). Response is OpenAI-style: { data: [{ url }] } or
# { data: [{ b64_json }] } depending on response_format.
GROK_GENERATE_URL = "https://api.x.ai/v1/images/edits"
ENHANCE_MODEL_GROK = "grok-imagine-image-quality"
GROK_PROMPT_MAX_CHARS = 4000


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


# Cap long-edge of the input image before sending to any vendor. Final
# export is 1024×731, so anything bigger upstream is just paying tax on
# upload bandwidth + vendor inference time for detail that gets thrown
# away. 1024 matches export resolution exactly.
INPUT_MAX_LONG_EDGE_PX = 1024


async def _load_image_bytes(gcs_uri: str) -> tuple[bytes, str]:
    """Download bytes from GCS and downsize to INPUT_MAX_LONG_EDGE_PX.
    Returns (bytes, detected_content_type).

    Sync SDK runs in a worker thread. pyvips handles the resize + re-encode
    (already a dep — used by services/image_processing.py for export
    pipeline). PNG inputs stay PNG (lossless); everything else round-trips
    through JPEG Q=92 since vendors mostly want photographic bytes.

    Skipping the resize when max(w, h) <= 1024 avoids upscaling tiny inputs
    and avoids the re-encode tax when there's no work to do.

    Duplicated from scan_worker.py for now — TODO: move to services/gcs.py
    (TODO is now 3-callers-old, cleanup_worker imports this directly).
    """
    from google.cloud import storage as gcs
    import pyvips

    settings = get_settings()
    without_scheme = gcs_uri[len("gs://"):]
    bucket_name, _, object_name = without_scheme.partition("/")

    def _download_and_downsize() -> tuple[bytes, str]:
        client = gcs.Client(project=settings.gcp_project)
        blob = client.bucket(bucket_name).blob(object_name)
        data = blob.download_as_bytes()

        # Magic-byte sniff for content type (before any re-encode).
        if data[:8] == b"\x89PNG\r\n\x1a\n":
            ct = "image/png"
        elif data[:4] == b"RIFF":
            ct = "image/webp"
        else:
            ct = "image/jpeg"

        img = pyvips.Image.new_from_buffer(data, "")
        long_edge = max(img.width, img.height)
        if long_edge <= INPUT_MAX_LONG_EDGE_PX:
            # Already small enough — no resize, no re-encode tax.
            return data, ct

        scale = INPUT_MAX_LONG_EDGE_PX / long_edge
        img = img.resize(scale)

        if ct == "image/png":
            out = bytes(img.write_to_buffer(".png"))
            return out, "image/png"
        # JPEG / WebP / anything else → JPEG Q=92 (small, fast, vendor-friendly).
        out = bytes(img.write_to_buffer(".jpg", Q=92))
        return out, "image/jpeg"

    return await asyncio.to_thread(_download_and_downsize)


async def _enhance_with_gemini(
    genai_client: Any,
    gcs_uri: str,
    prompt: str,
) -> bytes:
    """
    Call Gemini image-edit via the AI Studio backend. Returns raw PNG bytes.

    The genai_client here must be the AI Studio variant
    (genai.Client(api_key=...)). AI Studio does NOT accept GCS URIs as
    image input — Part.from_uri(file_uri="gs://...") would 400 — so we
    download the bytes from GCS first and inline them via Part.from_bytes.

    Scan stays on the Vertex client (app.state.genai) where Part.from_uri
    still works; only the enhance/cleanup flow uses AI Studio.
    """
    mime_type = mimetypes.guess_type(gcs_uri)[0] or "image/jpeg"
    image_bytes, _ct = await _load_image_bytes(gcs_uri)
    file_part = types.Part.from_bytes(data=image_bytes, mime_type=mime_type)
    text_part = types.Part.from_text(text=prompt)

    response = await genai_client.aio.models.generate_content(
        model=ENHANCE_MODEL_GEMINI,
        contents=[types.Content(role="user", parts=[file_part, text_part])],
        config=types.GenerateContentConfig(
            response_modalities=["IMAGE", "TEXT"],
            # Gemini 3.x thinking control. "High" gives the model the
            # most reasoning budget — useful for image edits where the
            # standard treatment + emphasis stack is long and the model
            # benefits from planning the edit before generating. Capital
            # "High" matches the official Python SDK enum exactly.
            thinking_config=types.ThinkingConfig(thinking_level="Medium"),
        ),
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


async def _enhance_with_reve(gcs_uri: str, prompt: str) -> bytes:
    """
    Call Reve's /v1/image/edit endpoint synchronously and return raw PNG
    bytes.

    Request shape (per https://docs.reve.com):
      Authorization: Bearer <REVE_API_KEY>
      Accept: application/json
      body: {
        edit_instruction: <prompt — capped to REVE_PROMPT_MAX_CHARS>,
        reference_image:  <base64 source bytes>,
        version:          "latest-fast",
      }

    Reve exposes its speed/quality knob via the `version` string itself,
    not a separate `mode` field (a `mode` parameter 400s with
    "One or more of your parameters is not recognized."). Valid versions
    are `latest`, `latest-fast`, `reve-edit@20250915`, and
    `reve-edit-fast@20251030`. We pin to `latest-fast` because the
    full-quality model reliably trips Reve's undocumented per-minute
    cap (~7 successful edits then a wall of 429s even with our
    3-per-30s limiter in front). The fast variant is materially cheaper
    in credits + has noticeably more RPM headroom.

    Response shape (when accept=json):
      {
        image:              <base64 PNG>,
        version:            "reve-edit@...",
        content_violation:  bool,
        request_id:         "rsid-...",
        credits_used:       int,
        credits_remaining:  int,
      }

    Aspect ratio is intentionally NOT sent — Reve defaults to the
    reference image's aspect, which is what we want (we already cap
    uploads at 1024 long-edge in compress.ts).
    """
    settings = get_settings()
    if not settings.reve_api_key:
        raise RuntimeError(
            "Reve provider requested but REVE_API_KEY is not set. "
            "Mount cleanshot-reve-key:latest via Cloud Run --set-secrets "
            "and re-deploy."
        )

    image_bytes, _ct = await _load_image_bytes(gcs_uri)
    image_b64 = base64.b64encode(image_bytes).decode()

    body = {
        "edit_instruction": prompt[:REVE_PROMPT_MAX_CHARS],
        "reference_image":  image_b64,
        "version":          "latest-fast",
    }
    headers = {
        "Authorization": f"Bearer {settings.reve_api_key}",
        "Accept":        "application/json",
        "Content-Type":  "application/json",
    }

    # Reve is synchronous — a single POST returns the rendered image.
    # Timeout matches the OpenAI client (300s); Reve typically returns
    # in 10-30s but we'd rather wait than fail.
    async with httpx.AsyncClient(timeout=300.0) as client:
        resp = await client.post(REVE_GENERATE_URL, headers=headers, json=body)

    if resp.status_code >= 400:
        # Surface the structured error fields if present.
        try:
            err = resp.json()
            detail = err.get("message") or err.get("error_code") or resp.text[:300]
        except Exception:
            detail = resp.text[:300]
        raise ValueError(f"Reve edit failed ({resp.status_code}): {detail}")

    data = resp.json()
    if data.get("content_violation"):
        raise ValueError(
            "Reve flagged the response as a content-policy violation; no image returned."
        )
    image_b64_out = data.get("image")
    if not image_b64_out:
        raise ValueError(f"Reve returned no image bytes: {data}")

    # Reve returns a base64-encoded PNG payload — decode once to raw bytes.
    return base64.b64decode(image_b64_out)


async def _enhance_with_grok(gcs_uri: str, prompt: str) -> bytes:
    """
    Call xAI Grok's /v1/images/edits endpoint and return raw PNG bytes.

    Request shape (per https://docs.x.ai/.../images/editing):
      Authorization: Bearer <XAI_API_KEY>
      Content-Type: application/json
      body: {
        model:  "grok-imagine-image-quality",
        prompt: <prompt, capped to GROK_PROMPT_MAX_CHARS>,
        image: {
          url:  "data:<mime>;base64,<...>",
          type: "image_url",
        },
      }

    Response is OpenAI-compatible: data[0].url is a temporary signed
    URL we fetch once to get the rendered bytes. (xAI also supports
    response_format=b64_json on the generation endpoint; this code
    handles either shape defensively in case the edits endpoint
    follows suit.)
    """
    settings = get_settings()
    if not settings.xai_api_key:
        raise RuntimeError(
            "Grok provider requested but XAI_API_KEY is not set. "
            "Mount cleanshot-xai-key:latest via Cloud Run --set-secrets "
            "and re-deploy."
        )

    image_bytes, ct = await _load_image_bytes(gcs_uri)
    image_b64 = base64.b64encode(image_bytes).decode()

    headers = {
        "Authorization": f"Bearer {settings.xai_api_key}",
        "Content-Type":  "application/json",
    }
    body = {
        "model":  ENHANCE_MODEL_GROK,
        "prompt": prompt[:GROK_PROMPT_MAX_CHARS],
        "image": {
            "url":  f"data:{ct};base64,{image_b64}",
            "type": "image_url",
        },
    }

    async with httpx.AsyncClient(timeout=300.0) as client:
        resp = await client.post(GROK_GENERATE_URL, headers=headers, json=body)

    if resp.status_code >= 400:
        try:
            err = resp.json()
            detail = err.get("error", {}).get("message") or err.get("detail") or resp.text[:300]
        except Exception:
            detail = resp.text[:300]
        raise ValueError(f"Grok edit failed ({resp.status_code}): {detail}")

    data = resp.json()
    items = data.get("data") or []
    if not items:
        raise ValueError(f"Grok returned no image data: {data}")

    item = items[0]
    # Prefer inline base64 if present; otherwise fetch the temporary URL.
    b64 = item.get("b64_json")
    if b64:
        return base64.b64decode(b64)
    image_url = item.get("url")
    if not image_url:
        raise ValueError(f"Grok response missing both url and b64_json: {data}")

    async with httpx.AsyncClient(timeout=60.0) as client:
        img_resp = await client.get(image_url)
    img_resp.raise_for_status()
    return img_resp.content


async def _run_enhance(
    request: Request,
    payload: EnhanceTaskPayload,
) -> None:
    """Background coroutine — runs after HTTP 200 has been returned."""
    pool = request.app.state.pool
    # Enhance uses the AI Studio Gemini client (preview image-gen models);
    # scan still uses the Vertex client on app.state.genai.
    genai_aistudio_client = request.app.state.genai_aistudio
    openai_client = request.app.state.openai
    gemini_semaphore: asyncio.Semaphore = request.app.state.gemini_semaphore

    # Look up the session owner so usage_events get attributed per user.
    async with pool.acquire() as conn:
        user_email = await queries.get_session_user_email(conn, payload.session_id)
        await queries.update_job_status(conn, payload.job_id, JobStatusEnum.processing)

    # Track per-call latency so we can write it into usage_events.
    import time as _time
    call_started_at = _time.monotonic()
    provider_model = None
    provider_name = payload.provider or "gemini"

    try:
        # Custom prompt overrides — either from the Scan tab's "Regenerate"
        # auto-prompt or the Enhance tab's "Custom prompt (advanced)" textarea.
        # When set, the model receives this text verbatim and toggles are
        # ignored. Otherwise the toggle-derived prompt is used.
        if payload.custom_prompt:
            prompt = payload.custom_prompt
        else:
            prompt = _build_enhance_prompt(payload.toggles)

        # Dispatch to the requested provider. The Gemini semaphore is
        # still useful for cost control on the AI Studio key (the key has
        # a per-minute rate limit we don't want to blow through), but
        # the binding cap is AI Studio's quota, not Vertex's. OpenAI and
        # Flux have their own vendor-side rate limits and don't share
        # ours.
        if payload.provider == "openai":
            if not openai_client:
                raise RuntimeError(
                    "OpenAI provider requested but client is not initialized. "
                    "Set OPENAI_API_KEY and ensure the lifespan picked it up."
                )
            provider_model = ENHANCE_MODEL_OPENAI
            # Pace OpenAI requests against the org's per-minute cap
            # (Tier-1 gpt-image-2 = 5 input-images/min). The limiter
            # blocks here until a slot opens, so 10-image batches queue
            # instead of failing with 429.
            await request.app.state.openai_image_rate_limiter.acquire()
            output_bytes = await _enhance_with_openai(
                openai_client, payload.input_gcs_uri, prompt
            )
        elif payload.provider == "flux":
            provider_model = "flux-2-max"
            output_bytes = await _enhance_with_flux(
                payload.input_gcs_uri, prompt
            )
        elif payload.provider == "reve":
            provider_model = ENHANCE_MODEL_REVE
            # Reve's docs claim no per-minute cap but the API returns
            # 429 RPM on bursts. Same sliding-window throttle as the
            # OpenAI path (5 per 60s) — retune in main.py once we
            # have data on Reve's actual ceiling.
            await request.app.state.reve_image_rate_limiter.acquire()
            output_bytes = await _enhance_with_reve(
                payload.input_gcs_uri, prompt
            )
        elif payload.provider == "grok":
            provider_model = ENHANCE_MODEL_GROK
            # xAI doesn't publish a per-minute cap for /v1/images/edits.
            # Mirroring the Reve treatment (3 per 30s) until we observe
            # actual behaviour and can retune in main.py.
            await request.app.state.grok_image_rate_limiter.acquire()
            output_bytes = await _enhance_with_grok(
                payload.input_gcs_uri, prompt
            )
        else:  # "gemini" or default
            if not genai_aistudio_client:
                raise RuntimeError(
                    "Gemini provider requested but the AI Studio client is "
                    "not initialized. Mount cleanshot-gemini-key:latest as "
                    "GEMINI_API_KEY via Cloud Run --set-secrets."
                )
            provider_model = ENHANCE_MODEL_GEMINI
            async with gemini_semaphore:
                output_bytes = await _enhance_with_gemini(
                    genai_aistudio_client, payload.input_gcs_uri, prompt
                )

        if not output_bytes:
            raise ValueError(
                f"{payload.provider} returned no image bytes in enhance response"
            )

        # Log a successful usage event before continuing into the GCS
        # write — captures the pure AI-call latency. Wrapped in try so a
        # logging failure can't tank an otherwise-successful enhance.
        try:
            async with pool.acquire() as conn:
                await queries.insert_usage_event(
                    conn,
                    user_email=user_email,
                    session_id=payload.session_id,
                    job_id=payload.job_id,
                    provider=provider_name,
                    model=provider_model or "unknown",
                    operation="enhance",
                    status="success",
                    latency_ms=int((_time.monotonic() - call_started_at) * 1000),
                    # All three enhance providers (Gemini image, OpenAI
                    # gpt-image-2, Flux 2 max) bill per image, not per
                    # token. estimate_cost_usd does the lookup; returns
                    # None for unknown models so we'd record NULL.
                    cost_estimate_usd=estimate_cost_usd(provider_model or ""),
                )
        except Exception:
            logger.exception("usage_event insert failed (enhance success path)")

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
            # Log the failed usage event too — admin dashboard tallies
            # both success/failed counts per provider so we can see
            # reliability per model. Same defensive try/except so a
            # secondary failure doesn't escalate.
            try:
                # Failed calls still cost real money on some providers
                # (OpenAI charges for image-edit attempts that error
                # mid-stream, BFL bills on submission). Record the same
                # estimated cost on failure so the admin's running
                # spend total stays accurate.
                await queries.insert_usage_event(
                    conn,
                    user_email=user_email,
                    session_id=payload.session_id,
                    job_id=payload.job_id,
                    provider=provider_name,
                    model=provider_model or "unknown",
                    operation="enhance",
                    status="failed",
                    latency_ms=int((_time.monotonic() - call_started_at) * 1000),
                    cost_estimate_usd=estimate_cost_usd(provider_model or ""),
                    error_message=str(exc)[:500],
                )
            except Exception:
                logger.exception("usage_event insert failed (enhance failure path)")


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
