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
    EraseTaskPayload,
    JobStatusEnum,
    OperationEnum,
    ScanTaskPayload,
    TweakTaskPayload,
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
# OpenAI image-edit now goes through gpt-5 + the image_generation
# tool (Responses API), rather than calling client.images.edit on
# gpt-image-2 directly. gpt-5 reads the input image + prompt, then
# orchestrates the image_generation tool which calls an underlying
# image model (currently gpt-image-1 family per OpenAI's docs). The
# tradeoff vs the previous direct gpt-image-2 path:
#   + One unified provider key path (Responses API everywhere)
#   + gpt-5's reasoning can refine ambiguous prompts before generation
#   - Extra LLM round-trip vs direct images.edit
#   - Cost = gpt-5 input/output tokens + underlying image-gen call
# We force tool_choice so gpt-5 always invokes the tool (no chance of
# it deciding the prompt is conversational and just replying in text).
ENHANCE_MODEL_OPENAI = "gpt-5"
# BFL erase endpoint. Flux is no longer a generation provider on the
# Enhance tab — it's reserved for mask-based object removal via
# /v1/flux-tools/erase-v1 (operator paints a mask in the browser over
# something on a completed variant they want gone; the backend submits
# both image + mask to BFL and writes the cleaned result as a new
# asset). Same async-polling pattern as the prior flux-2-max generator
# (POST returns { id, polling_url }; poll until "Ready"; GET
# result.sample for bytes). Auth is via the same x-key header / same
# BFL_API_KEY secret we already mount.
FLUX_ERASE_URL = "https://api.bfl.ai/v1/flux-tools/erase-v1"
# Polling cadence: ramp from 0.5s up to 2.0s instead of a flat 1.5s.
# Median FLUX 2 MAX finish is 15-25s — the prior flat 1.5s spent ~10
# poll-intervals at the start of every job rounding up to the next 1.5s
# tick, wasting 1-4s per call. Front-loading the polls with sub-second
# checks catches the rare 8-12s finishers immediately; the long tail
# settles at 2s so we don't hammer BFL on slow jobs.
# After the explicit ramp we hold at 2.0s for the remainder; the total
# budget (max attempts × 2.0s ceiling) is sized for ~90s same as before.
FLUX_POLL_INTERVALS_S: tuple[float, ...] = (
    0.5, 0.5, 0.75, 1.0, 1.25, 1.5, 1.5, 1.75,
)
FLUX_POLL_STEADY_INTERVAL_S = 2.0
FLUX_POLL_MAX_ATTEMPTS = 50        # ~90s total budget; FLUX 2 MAX typically finishes in 10-30s

# BFL Flux Kontext Max image-edit via the RunComfy proxy. RunComfy
# is async — submit returns a request_id; we poll
# /v1/requests/{request_id}/status until "completed", then GET
# /v1/requests/{request_id}/result for the rendered image URL. Like
# Seedream, Kontext consumes its input image as a publicly fetchable
# HTTPS URL rather than a base64 blob, so we mint a short-lived
# signed GCS GET URL with services.gcs.mint_read_url and pass that
# through. Auth is Bearer token on the same Authorization header for
# every endpoint in the flow.
#
# Why Kontext specifically: BFL positions it as purpose-built for
# identity-preserving edits — "change anything except the subject."
# That matches CleanShot's brief better than general-purpose
# image-edit models, which sometimes hallucinate model badges or
# alter the unit's silhouette under heavy paint refresh prompts.
KONTEXT_SUBMIT_URL = "https://model-api.runcomfy.net/v1/models/blackforestlabs/flux-1-kontext/max/edit"
KONTEXT_STATUS_URL = "https://model-api.runcomfy.net/v1/requests/{request_id}/status"
KONTEXT_RESULT_URL = "https://model-api.runcomfy.net/v1/requests/{request_id}/result"
ENHANCE_MODEL_KONTEXT = "flux-1-kontext-max-edit"
# Reasonable per-call prompt ceiling. Kontext's docs don't publish a
# hard cap but most BFL models tolerate up to ~4k chars; staying
# inside that bound matches what we send to the other providers.
KONTEXT_PROMPT_MAX_CHARS = 3800
# Match Flux's poll cadence — Kontext typical finish is 15–40s with
# the same ~90-second tail budget.
KONTEXT_POLL_INTERVALS_S: tuple[float, ...] = (
    0.75, 0.75, 1.0, 1.25, 1.5, 1.5, 1.75, 2.0,
)
KONTEXT_POLL_STEADY_INTERVAL_S = 2.0
KONTEXT_POLL_MAX_ATTEMPTS = 50

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


# Display name + per-type anatomy guardrail for the equipment-aware prompt.
# Keep these short — they slot into a sentence inside GUARDRAILS so the
# operator's model gets a clear "preserve these specific parts" list per
# unit category.
EQUIPMENT_DISPLAY: dict[str, str] = {
    "forklift":     "forklift",
    "scissor_lift": "scissor lift",
    "telehandler":  "telehandler",
}

EQUIPMENT_ANATOMY: dict[str, str] = {
    "forklift": (
        "Same mast configuration, fork count, fork length, overhead guard "
        "shape, counterweight shape, and tire type."
    ),
    "scissor_lift": (
        "Same platform size and handrail pattern, scissor mechanism "
        "extension, base / chassis dimensions, drive wheels, and control "
        "box position."
    ),
    "telehandler": (
        "Same boom length and section count, attachment (forks / bucket / "
        "lifting jib), outrigger configuration, cab shape, and wheel / "
        "tire type."
    ),
}

# Body-parts list that gets substituted into "the entire body of the
# {eq}, including the {EQUIPMENT_BODY_PARTS}, has received a fresh coat".
# Keeps the refined prompt readable for non-forklift types.
EQUIPMENT_BODY_PARTS: dict[str, str] = {
    "forklift":     "chassis, mast, and carriage",
    "scissor_lift": "chassis, scissor arms, and platform railing",
    "telehandler":  "chassis, boom, and cab",
}


def _build_enhance_prompt(
    toggles: EnhanceToggles,
    equipment_type: str = "forklift",
) -> str:
    """
    Build the enhance prompt.

    SPINE — refined operator-authored single-paragraph scene description
    (image-gen models respond better to declarative scene prose than to
    multi-section instructional text). The paragraph covers paint pass,
    masked OEM decals, fork colour, tire-shine on sidewalls only, and
    the legal/honesty bookend that prevents the unit from looking
    deceptively brand-new.

    Toggle-driven add-ons (remove people, background signage, rental
    scrub, plus light emphasis nudges) get appended AFTER the spine.
    Hard guardrails (scene anatomy preservation) sit at the very end.

    DRIFT-WARNING:
      The Scan-tab "Regenerate" auto-prompt is built client-side in
      apps/web/lib/scan-helpers.ts. Keep it in sync.
    """
    eq_display = EQUIPMENT_DISPLAY.get(equipment_type, "forklift")
    eq_anatomy = EQUIPMENT_ANATOMY.get(
        equipment_type, EQUIPMENT_ANATOMY["forklift"]
    )
    eq_parts = EQUIPMENT_BODY_PARTS.get(
        equipment_type, EQUIPMENT_BODY_PARTS["forklift"]
    )

    paint_forks_on = (
        toggles.paint_forks_red_yellow_tips
        and equipment_type in ("forklift", "telehandler")
    )

    # ── Spine — balanced cheap-respray framing ───────────────────────────
    # Earlier honesty-first prompt overshot — model left scuffs, gashes,
    # and dull tires intact even with the paint/rust toggles on, because
    # "MANDATORY IMPERFECTIONS — Worn-through paint patches stay visible"
    # told the model to preserve cosmetic wear that a cheap respray
    # would actually cover. Split into two explicit lists ("covers" vs
    # "does NOT cover") so the model knows surface scuffs/chips/light
    # rust are fair game, and only structural defects stay. Dual failure
    # criteria at the end: too-new AND unchanged both fail.
    sections: list[str] = []

    sections.append(
        f"A photorealistic depiction of a USED {eq_display} that has just "
        f"received a CHEAP shop-grade spray paint job. This is a real "
        f"shop respray — quick, inexpensive, and effective at making a "
        f"used unit listing-ready. It is NOT a restoration and NOT a "
        f"factory finish, but the fresh paint clearly improves the unit's "
        f"appearance."
    )

    sections.append(
        "WHAT THE FRESH PAINT COVERS (these are gone in the output):\n"
        "• Surface paint chips, scuffs, scratches, and faded patches — "
        "covered by the new paint.\n"
        "• Light surface rust and oxidation — covered.\n"
        "• Dirt, grime, dust, and surface staining — cleaned off before "
        "the paint pass.\n"
        "• Dull, worn-out colour — restored to the saturated original "
        "factory colour."
    )

    sections.append(
        "WHAT THE FRESH PAINT DOES NOT COVER (these stay clearly "
        "visible in the output):\n"
        "• Dents, panel deformation, and bent hardware.\n"
        "• Deep gouges THROUGH the metal (not surface scratches — actual "
        "metal damage).\n"
        "• Missing parts, broken hardware, cracked components.\n"
        "• Severe rust-through holes and large rust pitting craters that "
        "have eaten into the panel.\n"
        "• Replaced / mismatched panels, aftermarket non-OEM parts — "
        "leave them as-is, do not unify them."
    )

    sections.append(
        f"PAINT JOB CHARACTER: a quick coat from a shop spray gun in the "
        f"precise original factory colour scheme. It looks CHEAP-but-"
        f"CLEAN — even coverage in most places, slight orange-peel "
        f"texture on close inspection, maybe minor overspray edges in "
        f"tight corners. Apply this respray to the {eq_parts}. Match the "
        f"original panel-to-colour mapping exactly; do not change which "
        f"panel is which colour."
    )

    sections.append(
        "OEM make, model, and capacity decals are masked off and "
        "preserved in their EXACT original placement and spelling, "
        "showing only realistic wear."
    )

    if paint_forks_on:
        sections.append(
            "LIFTING FORKS — paint ONLY the two horizontal fork tines "
            "themselves (the L-shaped blades that go into pallets) with "
            "Discount Forklift signature red and safety yellow tips. The "
            "red covers the heel of each fork (the vertical shank) and "
            "roughly the first 80% of the horizontal blade; the "
            "outermost ~15-20 cm (~6-8 inches) of the tip is safety "
            "YELLOW. Do NOT paint the surrounding carriage, mast, mast "
            "rails, side shifters, attachment brackets, or any hardware "
            "around the forks — ONLY the two fork tines themselves. The "
            "LOAD BACK REST (LBR), the vertical cage / grid frame at the "
            "back of the fork carriage, remains BLACK; OSHA convention "
            "reserves black for the LBR so the high-vis forks read "
            "clearly against it."
        )

    sections.append(
        "TIRES: keep the SAME tires — do not replace them, and existing "
        "tread wear, cuts, gouges, and aging cracks on the tread itself "
        "stay visible. But the SIDEWALLS have been treated with a "
        "generous coat of glossy tire shine — the sidewalls read as "
        "wet-look, deep black, noticeably glossy and contrasted against "
        "the dry, dusty, untreated tread. Apply tire shine ONLY to the "
        "sidewall, never the tread."
    )

    sections.append(
        f"SCENE: maintain the identical camera angle, perspective, and "
        f"background environment from the source image. The background "
        f"setting remains entirely unchanged."
    )

    sections.append(
        f"DUAL FAILURE CRITERIA:\n"
        f"• If the final image looks brand-new, factory-fresh, restored, "
        f"or like the unit was never used, you have failed (too "
        f"perfect).\n"
        f"• If the final image looks unchanged from the source — same "
        f"scuffs, same chips, same dull paint, same dusty tires — you "
        f"have ALSO failed (no respray applied).\n"
        f"The right answer is: clearly a used {eq_display}, clearly "
        f"freshly resprayed in a cheap-but-clean shop paint job, with "
        f"glossy tire-shined sidewalls; only structural damage and "
        f"severe rust-through still visible."
    )

    # ── Toggle-driven additions ────────────────────────────────────────
    extras: list[str] = []

    if toggles.new_paint_job:
        extras.append(
            "EXTRA EMPHASIS — paint coverage. This image's surface paint "
            "is particularly rough. Lean hard on the cheap respray — "
            "ALL surface scuffs, chips, scratches, and faded patches "
            "should be CLEARLY covered by the new factory-colour paint. "
            "Only structural damage (dents, deep gouges through metal, "
            "broken parts) stays visible."
        )
    if toggles.remove_rust:
        extras.append(
            "EXTRA EMPHASIS — rust. This image has visible rust. Cover "
            "ALL surface rust and light oxidation under the fresh paint. "
            "Only deep rust-through holes and large pitting craters that "
            "have eaten into the panel stay visible."
        )
    if toggles.shine_tires:
        extras.append(
            "EXTRA EMPHASIS — tire shine. The sidewalls should read as "
            "wet-look, glossy black, with strong contrast against the "
            "dry untreated tread. Push the gloss harder than the default."
        )
    if toggles.restore_decals:
        extras.append(
            "EXTRA EMPHASIS — decals. Pay extra attention to decal "
            "restoration; every label should read perfectly crisp in the "
            "output."
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
            f"  CRITICAL EXCEPTION — do NOT touch any signage on the "
            f"{eq_display} ITSELF. OEM decals, brand name on the mast / "
            f"boom / chassis, capacity plates, VIN / serial numbers, "
            f"model badges, safety stickers, and data tags all stay."
        )
    if toggles.remove_rental_branding:
        extras.append(
            "ADDITIONAL ACTION — RENTAL-FLEET BRANDING. Remove decals, "
            "stickers, vinyl wraps, painted lettering, and asset-tag "
            "numbers that advertise third-party rental fleets. Examples "
            "include (non-exhaustive): Sunbelt Rentals, United Rentals, "
            "Herc Rentals, Sunstate Equipment, Ahern Rentals, "
            "EquipmentShare, The Home Depot Tool Rental, BlueLine Rental, "
            "NES Rentals, and any similar fleet-branding wraps or stickers "
            "(large fleet ID numbers, '1-800' style asset tags, rental-"
            "company logos in non-OEM colours). Where a rental decal is "
            "removed, leave the underlying panel surface matching the "
            "surrounding panel — do not leave a ghost outline, and do NOT "
            "invent or paste any replacement brand decals, logos, or "
            "wordmarks (no guessing OEM identity). PRESERVE all OEM "
            "manufacturer decals already present (Toyota, Hyster, Yale, "
            "Crown, Komatsu, Mitsubishi, Caterpillar, Skyjack, Genie, "
            "JLG, Bobcat, etc.), capacity plates, VIN / serial numbers, "
            "model badges, and safety stickers — only third-party rental-"
            "fleet branding is removed."
        )

    if extras:
        sections.append(
            "ADDITIONAL EMPHASIS — apply ON TOP of the spine above:\n\n"
            + "\n\n".join(f"• {e}" for e in extras)
        )

    # ── Hard guardrails (scene + anatomy preservation) ─────────────────
    sections.append(
        f"GUARDRAILS — hard constraints:\n"
        f"• Make, model, year, trim level. {eq_anatomy}\n"
        f"• Do NOT add lamps, beacons, mirrors, antennas, attachments, or "
        f"any bolt-on hardware that is not already in the source.\n"
        f"• Do not introduce damage, dents, broken parts, or wear that "
        f"was not in the source image.\n"
        f"• Never isolate the {eq_display} on a white / studio / gradient "
        f"backdrop. No zoom, crop, rotate, horizon-leveling, or re-posing."
    )

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
            # gemini-3.1-flash-image-preview only accepts "High" — both
            # "Medium" and "Low" return 400 INVALID_ARGUMENT. So this
            # isn't really a perf knob on the current model. Reassess
            # when image-gen models with a real thinking-level spectrum
            # ship to AI Studio.
            thinking_config=types.ThinkingConfig(thinking_level="High"),
        ),
    )

    # google-genai already decodes the protobuf bytes field, so `data` is raw
    # image bytes — do NOT b64-decode again (silently drops non-base64 chars).
    for part in response.candidates[0].content.parts:
        if part.inline_data and part.inline_data.data:
            return part.inline_data.data

    # No image came back. Build an actionable error from whatever
    # diagnostic context Gemini DID return — there are several distinct
    # reasons this can happen and they need different operator responses:
    #   • prompt_feedback.block_reason set → prompt-level safety block
    #   • candidate.finish_reason == SAFETY → output-level safety block
    #   • candidate.finish_reason == MAX_TOKENS → output budget exhausted
    #     before the image was generated (rare on Flash Image but possible)
    #   • text-only response → Gemini interpreted the prompt as conversational
    raise ValueError(_describe_gemini_no_image(response, "enhance"))


def _describe_gemini_no_image(response: Any, operation: str) -> str:
    """
    Build a useful error string when a Gemini Flash Image call returns
    a non-image response. Pulled out so _enhance_with_gemini AND
    _tweak_with_gemini share the same diagnostic plumbing.
    """
    bits: list[str] = [f"Gemini returned no image part in {operation} response"]

    # Prompt-level block: Gemini refused the request before generating.
    prompt_fb = getattr(response, "prompt_feedback", None)
    block_reason = getattr(prompt_fb, "block_reason", None) if prompt_fb else None
    if block_reason:
        bits.append(f"prompt_feedback.block_reason={block_reason}")

    # Candidate-level: what happened during/after generation.
    candidates = getattr(response, "candidates", None) or []
    if candidates:
        c = candidates[0]
        finish = getattr(c, "finish_reason", None)
        if finish:
            bits.append(f"finish_reason={finish}")

        safety = getattr(c, "safety_ratings", None) or []
        blocked = [
            f"{getattr(s, 'category', '?')}={getattr(s, 'probability', '?')}"
            for s in safety
            if getattr(s, "blocked", False)
        ]
        if blocked:
            bits.append("safety_blocked=[" + ", ".join(blocked) + "]")

        # Surface any TEXT the model emitted in lieu of an image — often
        # the most useful clue. Capped so we don't dump pages into
        # usage_events.error_message (column is varchar(500)).
        content = getattr(c, "content", None)
        parts = getattr(content, "parts", None) or [] if content else []
        text_chunks = [
            getattr(p, "text", "") for p in parts if getattr(p, "text", None)
        ]
        if text_chunks:
            joined = " ".join(t.strip() for t in text_chunks if t).strip()
            if joined:
                preview = joined[:160] + ("…" if len(joined) > 160 else "")
                bits.append(f"text_response={preview!r}")
    else:
        bits.append("no_candidates_returned")

    return " | ".join(bits)


# Wraps the operator's free-text instruction with a scope guard so the
# tweak applies ONE targeted change rather than re-rendering the whole
# unit (Gemini's natural tendency when given any image-edit prompt).
# Kept short on purpose — long preambles dilute the operator's actual
# intent. The phrase "Do NOT re-paint or re-render the entire vehicle"
# is load-bearing; without it, "remove the propane tank" can trigger a
# full re-enhance.
TWEAK_PREAMBLE = (
    "You are making a targeted edit to a photo of a used industrial lift "
    "truck for a B2B equipment listing. Apply ONLY the change described "
    "below. Preserve everything else exactly as in the input: the unit's "
    "identity (make, model, decals, badges, mast/boom/platform anatomy), "
    "all other paint and surface condition, the background, the lighting, "
    "and any defects or wear that were NOT explicitly named in the change. "
    "Do NOT re-paint or re-render the entire vehicle. Do NOT touch anything "
    "outside the specific change requested.\n\n"
    "Change to apply: "
)


async def _tweak_with_gemini(
    genai_client: Any,
    gcs_uri: str,
    instruction: str,
) -> bytes:
    """
    Targeted text-guided edit via Gemini Flash Image. Operator-supplied
    instruction is wrapped with a short scope guard (TWEAK_PREAMBLE) so
    the model applies one change rather than re-enhancing the unit.

    Same SDK path as _enhance_with_gemini — AI Studio backend,
    Part.from_bytes after a GCS download (AI Studio rejects gs:// URIs),
    response_modalities=["IMAGE", "TEXT"], thinking_level="High" (only
    value gemini-3.1-flash-image-preview accepts).
    """
    mime_type = mimetypes.guess_type(gcs_uri)[0] or "image/jpeg"
    image_bytes, _ct = await _load_image_bytes(gcs_uri)
    file_part = types.Part.from_bytes(data=image_bytes, mime_type=mime_type)
    text_part = types.Part.from_text(text=TWEAK_PREAMBLE + instruction.strip())

    response = await genai_client.aio.models.generate_content(
        model=ENHANCE_MODEL_GEMINI,
        contents=[types.Content(role="user", parts=[file_part, text_part])],
        config=types.GenerateContentConfig(
            response_modalities=["IMAGE", "TEXT"],
            thinking_config=types.ThinkingConfig(thinking_level="High"),
        ),
    )

    for part in response.candidates[0].content.parts:
        if part.inline_data and part.inline_data.data:
            return part.inline_data.data
    raise ValueError(_describe_gemini_no_image(response, "tweak"))


async def _enhance_with_openai(
    openai_client: Any,
    gcs_uri: str,
    prompt: str,
) -> bytes:
    """
    Call OpenAI gpt-5 via the Responses API with the image_generation
    tool forced. gpt-5 reads the input image + our enhance prompt,
    then dispatches the image_generation tool to produce the edited
    output. The tool internally invokes a gpt-image-* model and
    returns the result inline as base64 in an image_generation_call
    output item.

    tool_choice is forced to ensure gpt-5 always invokes the tool —
    without it, gpt-5 may sometimes decide the prompt is conversational
    and just reply with text, returning no image.

    OpenAI requires the image bytes in the request (no GCS URI ingress),
    so we download via _load_image_bytes first and inline as a data URL.
    """
    image_bytes, ct = await _load_image_bytes(gcs_uri)
    image_b64 = base64.b64encode(image_bytes).decode()

    response = await openai_client.responses.create(
        model=ENHANCE_MODEL_OPENAI,
        input=[
            {
                "role": "user",
                "content": [
                    {"type": "input_text", "text": prompt},
                    {
                        "type": "input_image",
                        "image_url": f"data:{ct};base64,{image_b64}",
                    },
                ],
            }
        ],
        tools=[{"type": "image_generation"}],
        tool_choice={"type": "image_generation"},
    )

    # Responses API returns a list of output items. We want the one
    # produced by the image_generation tool — it carries the rendered
    # PNG as a base64 string on `.result`.
    for item in response.output:
        if getattr(item, "type", None) == "image_generation_call":
            b64 = getattr(item, "result", None)
            if not b64:
                raise ValueError(
                    "OpenAI image_generation_call returned no result bytes"
                )
            return base64.b64decode(b64)

    raise ValueError(
        "OpenAI gpt-5 response had no image_generation_call output item — "
        "gpt-5 may have refused or the tool failed to invoke. "
        f"Output types: {[getattr(o, 'type', '?') for o in response.output]}"
    )


# Ideogram model IDs / endpoints — versioned constants so we can swap
# without grep-hunting through the worker. Sync API; no polling.
IDEOGRAM_EDIT_URL    = "https://api.ideogram.ai/v1/edit"
IDEOGRAM_INPAINT_URL = "https://api.ideogram.ai/v1/ideogram-v3/inpaint"
IDEOGRAM_MODEL_LABEL = "ideogram-3.0"  # for usage_event.model column


async def _tweak_with_ideogram(gcs_uri: str, instruction: str) -> bytes:
    """
    Targeted text-guided edit via Ideogram /v1/edit. Sister to
    _tweak_with_gemini — same input contract (image URI + text
    instruction → edited image bytes) but routed through Ideogram for
    its typography strength (OEM decals, model numbers, signage, data
    plates — the regions Gemini most often mangles).

    Sync API: POST multipart → JSON response with a direct image URL,
    GET the URL → image bytes. No polling.
    """
    settings = get_settings()
    if not settings.ideogram_api_key:
        raise RuntimeError(
            "Ideogram tweak requested but IDEOGRAM_API_KEY is not set. "
            "Mount cleanshot-ideogram-key:latest via Cloud Run "
            "--set-secrets and re-deploy."
        )

    image_bytes, ct = await _load_image_bytes(gcs_uri)
    # Ideogram accepts JPEG/PNG/WebP up to 10 MB; our enhance outputs
    # are PNG and well under the cap, so pass-through is safe.
    filename = "input.png" if "png" in ct else "input.jpg"

    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            IDEOGRAM_EDIT_URL,
            headers={"Api-Key": settings.ideogram_api_key},
            data={"prompt": instruction.strip()},
            files={"images": (filename, image_bytes, ct)},
        )
        if resp.status_code >= 400:
            raise ValueError(
                f"Ideogram edit failed ({resp.status_code}): {resp.text[:300]}"
            )
        data = resp.json()
        items = data.get("data") or []
        if not items:
            raise ValueError(f"Ideogram edit returned empty data: {data}")
        item = items[0]
        if not item.get("is_image_safe", True):
            raise ValueError(
                f"Ideogram refused the edit on safety grounds: {item}"
            )
        url = item.get("url")
        if not url:
            raise ValueError(f"Ideogram edit item missing url: {item}")

        # Result URL is a presigned CDN URL — no auth header on the GET.
        # The docs warn the link is short-lived so fetch immediately.
        fetched = await client.get(url)
        if fetched.status_code >= 400:
            raise ValueError(
                f"Ideogram result GET failed ({fetched.status_code}): "
                f"{fetched.text[:200]}"
            )
        return fetched.content


async def _inpaint_with_ideogram(
    gcs_uri: str,
    mask_png_base64: str,
    instruction: str | None,
) -> bytes:
    """
    Mask-based inpaint via Ideogram /v1/ideogram-v3/inpaint. Sister to
    _erase_with_flux — same client-supplied WHITE=erase mask convention,
    but Ideogram's API uses the inverted convention (BLACK = region to
    edit). We invert the mask server-side so the EraseDialog can stay
    vendor-agnostic.

    Ideogram inpaint requires a prompt (unlike Flux erase where it's
    optional). When the operator leaves the fill hint blank we fall
    back to a neutral "fill with plausible background" instruction —
    same effective behaviour as Flux's default.
    """
    settings = get_settings()
    if not settings.ideogram_api_key:
        raise RuntimeError(
            "Ideogram inpaint requested but IDEOGRAM_API_KEY is not set. "
            "Mount cleanshot-ideogram-key:latest via Cloud Run "
            "--set-secrets and re-deploy."
        )

    image_bytes, _ct = await _load_image_bytes(gcs_uri)

    # Same EXIF/dim normalisation as _erase_with_flux — and then invert
    # the mask so WHITE=erase (our convention) becomes BLACK=edit
    # (Ideogram's convention).
    def _normalise() -> tuple[bytes, bytes]:
        import pyvips
        src = pyvips.Image.new_from_buffer(image_bytes, "")
        src = src.autorot()
        src_w, src_h = src.width, src.height
        src_png = src.write_to_buffer(".png")

        mask_raw = base64.b64decode(mask_png_base64)
        mask = pyvips.Image.new_from_buffer(mask_raw, "")
        if mask.width != src_w or mask.height != src_h:
            mask = mask.resize(
                src_w / mask.width,
                vscale=src_h / mask.height,
                kernel="nearest",
            )
        # Invert: pyvips `invert()` flips each pixel value (255-x for
        # U8), turning WHITE strokes into BLACK regions that Ideogram
        # reads as "edit here".
        mask = mask.invert()
        mask_png = mask.write_to_buffer(".png")
        return src_png, mask_png

    src_png, mask_png = await asyncio.to_thread(_normalise)

    prompt = (instruction or "").strip() or "fill with plausible background"

    async with httpx.AsyncClient(timeout=120.0) as client:
        resp = await client.post(
            IDEOGRAM_INPAINT_URL,
            headers={"Api-Key": settings.ideogram_api_key},
            data={
                "prompt": prompt,
                "rendering_speed": "DEFAULT",
                "style_type": "REALISTIC",
            },
            files={
                "image": ("image.png", src_png,  "image/png"),
                "mask":  ("mask.png",  mask_png, "image/png"),
            },
        )
        if resp.status_code >= 400:
            raise ValueError(
                f"Ideogram inpaint failed ({resp.status_code}): "
                f"{resp.text[:300]}"
            )
        data = resp.json()
        items = data.get("data") or []
        if not items:
            raise ValueError(f"Ideogram inpaint returned empty data: {data}")
        item = items[0]
        if not item.get("is_image_safe", True):
            raise ValueError(
                f"Ideogram refused the inpaint on safety grounds: {item}"
            )
        url = item.get("url")
        if not url:
            raise ValueError(f"Ideogram inpaint item missing url: {item}")

        fetched = await client.get(url)
        if fetched.status_code >= 400:
            raise ValueError(
                f"Ideogram inpaint result GET failed ({fetched.status_code}): "
                f"{fetched.text[:200]}"
            )
        return fetched.content


async def _erase_with_flux(
    gcs_uri: str,
    mask_png_base64: str,
    instruction: str | None,
) -> bytes:
    """
    Call BFL's flux-tools/erase-v1 endpoint to remove the masked region
    from the source image. Mask is a base64-encoded PNG drawn client-side
    where white pixels mark areas to erase and black pixels mark areas
    to preserve.

    Same async-polling pattern as the (now-removed) flux-2-max generator:
      1. POST FLUX_ERASE_URL with { image, mask, prompt? } → { id, polling_url }
      2. GET polling_url every FLUX_POLL_INTERVALS_S until Ready / terminal
      3. GET result.sample (a presigned URL, no auth) → image bytes
    """
    settings = get_settings()
    if not settings.bfl_api_key:
        raise RuntimeError(
            "Flux erase requested but BFL_API_KEY is not set. "
            "Mount cleanshot-bfl-key:latest via Cloud Run --set-secrets "
            "and re-deploy."
        )

    image_bytes, _ct = await _load_image_bytes(gcs_uri)

    # Normalise the source image AND the mask to identical dimensions in
    # a single pass. We can't trust:
    #   (a) the source JPEG (iPhone EXIF orientation rotates the browser
    #       display but BFL reads raw JPEG without applying EXIF), OR
    #   (b) the mask matching the source (the operator drew at the
    #       browser's reported naturalWidth × naturalHeight which can
    #       diverge from the source's true pixel dims for the same EXIF
    #       reason — or if Seedream / other providers returned slightly
    #       different resolution than what landed in GCS after the
    #       browser scaled it).
    # Fix: re-encode the source to PNG with EXIF baked in, then
    # explicitly resize the mask to the source's post-autorot dims so
    # the two are *guaranteed* to match before we send to BFL.
    def _normalise() -> tuple[bytes, bytes, int, int, int, int]:
        import pyvips
        src = pyvips.Image.new_from_buffer(image_bytes, "")
        src = src.autorot()
        src_w, src_h = src.width, src.height
        src_png = src.write_to_buffer(".png")

        mask_raw = base64.b64decode(mask_png_base64)
        mask = pyvips.Image.new_from_buffer(mask_raw, "")
        mask_w, mask_h = mask.width, mask.height
        if mask_w != src_w or mask_h != src_h:
            # Pixel-resample the mask so its dimensions match the source.
            # Operator's stroke regions map to roughly the same area;
            # binary mask is still binary after nearest-neighbour resize.
            hscale = src_w / mask_w
            vscale = src_h / mask_h
            mask = mask.resize(hscale, vscale=vscale, kernel="nearest")
        mask_png = mask.write_to_buffer(".png")
        return src_png, mask_png, src_w, src_h, mask_w, mask_h

    src_png, mask_png, src_w, src_h, mask_w_in, mask_h_in = await asyncio.to_thread(_normalise)
    logger.info(
        "BFL erase: source %dx%d, incoming mask %dx%d (resized to match if needed)",
        src_w, src_h, mask_w_in, mask_h_in,
    )

    image_b64 = base64.b64encode(src_png).decode()
    mask_b64  = base64.b64encode(mask_png).decode()

    auth_headers = {"x-key": settings.bfl_api_key}
    body: dict[str, Any] = {
        "image": image_b64,
        "mask":  mask_b64,
    }
    # BFL accepts an optional prompt to guide what should fill the
    # erased region. Empty/None means "infer plausible background."
    if instruction and instruction.strip():
        body["prompt"] = instruction.strip()

    async with httpx.AsyncClient(timeout=30.0) as client:
        submit = await client.post(
            FLUX_ERASE_URL,
            headers={**auth_headers, "Content-Type": "application/json"},
            json=body,
        )
        if submit.status_code >= 400:
            raise ValueError(
                f"BFL erase submit failed ({submit.status_code}): "
                f"{submit.text[:300]}"
            )
        submit_data = submit.json()
        polling_url = submit_data.get("polling_url")
        if not polling_url:
            raise ValueError(
                f"BFL erase submit returned no polling_url: {submit_data}"
            )

        for attempt in range(FLUX_POLL_MAX_ATTEMPTS):
            interval = (
                FLUX_POLL_INTERVALS_S[attempt]
                if attempt < len(FLUX_POLL_INTERVALS_S)
                else FLUX_POLL_STEADY_INTERVAL_S
            )
            await asyncio.sleep(interval)
            poll = await client.get(polling_url, headers=auth_headers)
            if poll.status_code >= 400:
                raise ValueError(
                    f"BFL erase poll failed ({poll.status_code}): "
                    f"{poll.text[:300]}"
                )
            poll_data = poll.json()
            status = poll_data.get("status")

            if status == "Ready":
                result = poll_data.get("result") or {}
                sample_url = result.get("sample")
                if not sample_url:
                    raise ValueError(
                        f"BFL erase Ready without result.sample URL: {poll_data}"
                    )
                image_resp = await client.get(sample_url)
                image_resp.raise_for_status()
                return image_resp.content

            if status in (
                "Error",
                "Content Moderated",
                "Request Moderated",
                "Task not found",
            ):
                detail = (
                    poll_data.get("result")
                    or poll_data.get("error")
                    or "no detail"
                )
                raise ValueError(
                    f"BFL erase returned terminal status '{status}': {detail}"
                )

        budget_s = (
            sum(FLUX_POLL_INTERVALS_S)
            + max(0, FLUX_POLL_MAX_ATTEMPTS - len(FLUX_POLL_INTERVALS_S))
              * FLUX_POLL_STEADY_INTERVAL_S
        )
        raise TimeoutError(
            f"BFL erase did not finish within {budget_s:.0f}s "
            f"({FLUX_POLL_MAX_ATTEMPTS} polls)"
        )


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


async def _enhance_with_kontext(gcs_uri: str, prompt: str) -> bytes:
    """
    Call BFL Flux Kontext Max via the RunComfy async proxy.

      1. mint_read_url(gcs_uri) → short-lived signed GCS GET URL
      2. POST KONTEXT_SUBMIT_URL with { prompt, images: [signed_url] }
         → { request_id }
      3. GET KONTEXT_STATUS_URL.format(request_id=...) every
         KONTEXT_POLL_INTERVALS_S until status == "completed"
         (also handles "cancelled" / "failed" / "in_queue" /
         "in_progress").
      4. GET KONTEXT_RESULT_URL.format(request_id=...) → result.image
         (single URL) or result.images[0] (array).
      5. Fetch that URL for the rendered bytes.
    """
    settings = get_settings()
    if not settings.runcomfy_api_key:
        raise RuntimeError(
            "Kontext provider requested but RUNCOMFY_API_KEY is not set. "
            "Mount cleanshot-runcomfy-key:latest via Cloud Run --set-secrets "
            "and re-deploy."
        )

    # Mint a signed GCS GET URL so RunComfy's servers can fetch the
    # source image. mint_read_url is sync (runs in a thread to keep
    # the event loop free; the call is fast in practice).
    from cleanshot_api.services.gcs import mint_read_url
    signed_get_url, _expires = await asyncio.to_thread(mint_read_url, gcs_uri)

    auth_headers = {
        "Authorization": f"Bearer {settings.runcomfy_api_key}",
        "Content-Type":  "application/json",
    }
    body = {
        "prompt":    prompt[:KONTEXT_PROMPT_MAX_CHARS],
        "image_url": signed_get_url,
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        # ── 1. Submit ──────────────────────────────────────────────
        submit = await client.post(KONTEXT_SUBMIT_URL, headers=auth_headers, json=body)
        if submit.status_code >= 400:
            raise ValueError(
                f"RunComfy/Kontext submit failed ({submit.status_code}): "
                f"{submit.text[:300]}"
            )
        submit_data = submit.json()
        request_id = submit_data.get("request_id") or submit_data.get("id")
        if not request_id:
            raise ValueError(
                f"RunComfy/Kontext submit returned no request_id: {submit_data}"
            )

        # ── 2. Poll ────────────────────────────────────────────────
        status_url = KONTEXT_STATUS_URL.format(request_id=request_id)
        terminal_status = None
        for attempt in range(KONTEXT_POLL_MAX_ATTEMPTS):
            interval = (
                KONTEXT_POLL_INTERVALS_S[attempt]
                if attempt < len(KONTEXT_POLL_INTERVALS_S)
                else KONTEXT_POLL_STEADY_INTERVAL_S
            )
            await asyncio.sleep(interval)
            poll = await client.get(
                status_url,
                headers={"Authorization": auth_headers["Authorization"]},
            )
            if poll.status_code >= 400:
                raise ValueError(
                    f"RunComfy/Kontext poll failed ({poll.status_code}): "
                    f"{poll.text[:300]}"
                )
            poll_data = poll.json()
            status_val = (poll_data.get("status") or "").lower()

            if status_val == "completed":
                terminal_status = "completed"
                break
            if status_val in ("cancelled", "failed", "error"):
                detail = poll_data.get("error") or poll_data.get("message") or "no detail"
                raise ValueError(
                    f"RunComfy/Kontext terminal status '{status_val}': {detail}"
                )
            # Otherwise still "in_queue" / "in_progress" — keep polling.

        if terminal_status != "completed":
            budget_s = (
                sum(KONTEXT_POLL_INTERVALS_S)
                + max(0, KONTEXT_POLL_MAX_ATTEMPTS - len(KONTEXT_POLL_INTERVALS_S))
                  * KONTEXT_POLL_STEADY_INTERVAL_S
            )
            raise TimeoutError(
                f"RunComfy/Kontext did not complete within {budget_s:.0f}s "
                f"({KONTEXT_POLL_MAX_ATTEMPTS} polls)"
            )

        # ── 3. Fetch result ───────────────────────────────────────
        result_url = KONTEXT_RESULT_URL.format(request_id=request_id)
        result_resp = await client.get(
            result_url,
            headers={"Authorization": auth_headers["Authorization"]},
        )
        if result_resp.status_code >= 400:
            raise ValueError(
                f"RunComfy/Kontext result fetch failed "
                f"({result_resp.status_code}): {result_resp.text[:300]}"
            )
        result_data = result_resp.json() or {}
        # RunComfy nests the actual output under `output` per their schema.
        output = result_data.get("output") or result_data
        image_url = output.get("image")
        if not image_url:
            images_arr = output.get("images") or []
            image_url = images_arr[0] if images_arr else None
        if not image_url:
            raise ValueError(
                f"RunComfy/Kontext result missing image/images URL: {result_data}"
            )

        # ── 4. Download the rendered image ────────────────────────
        async with httpx.AsyncClient(timeout=60.0) as fetcher:
            img_resp = await fetcher.get(image_url)
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
            prompt = _build_enhance_prompt(
                payload.toggles,
                equipment_type=payload.equipment_type,
            )

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
        elif payload.provider == "grok":
            provider_model = ENHANCE_MODEL_GROK
            # xAI doesn't publish a per-minute cap for /v1/images/edits.
            # Defensive throttle of 3 per 30s in main.py — retune once
            # we observe actual burst behaviour.
            await request.app.state.grok_image_rate_limiter.acquire()
            output_bytes = await _enhance_with_grok(
                payload.input_gcs_uri, prompt
            )
        elif payload.provider == "kontext":
            provider_model = ENHANCE_MODEL_KONTEXT
            # No published RunComfy per-minute cap — start without a
            # limiter and add one if we observe 429s in production.
            output_bytes = await _enhance_with_kontext(
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


# ─── Erase pipeline (BFL flux-tools/erase-v1) ────────────────────────────────


async def _run_erase(
    request: Request,
    payload: EraseTaskPayload,
) -> None:
    """Background coroutine for mask-based BFL erase jobs."""
    pool = request.app.state.pool

    async with pool.acquire() as conn:
        user_email = await queries.get_session_user_email(conn, payload.session_id)
        await queries.update_job_status(conn, payload.job_id, JobStatusEnum.processing)

    import time as _time
    call_started_at = _time.monotonic()
    if payload.tool == "ideogram":
        provider_label = "ideogram"
        provider_model = IDEOGRAM_MODEL_LABEL
    else:
        provider_label = "flux"
        provider_model = "flux-erase-v1"

    try:
        if payload.tool == "ideogram":
            output_bytes = await _inpaint_with_ideogram(
                payload.input_gcs_uri,
                payload.mask_png_base64,
                payload.instruction,
            )
        else:
            output_bytes = await _erase_with_flux(
                payload.input_gcs_uri,
                payload.mask_png_base64,
                payload.instruction,
            )
        if not output_bytes:
            raise ValueError(f"{provider_label} erase returned no image bytes")

        try:
            async with pool.acquire() as conn:
                await queries.insert_usage_event(
                    conn,
                    user_email=user_email,
                    session_id=payload.session_id,
                    job_id=payload.job_id,
                    provider=provider_label,
                    model=provider_model,
                    operation="erase",
                    status="success",
                    latency_ms=int((_time.monotonic() - call_started_at) * 1000),
                    cost_estimate_usd=estimate_cost_usd(provider_model),
                )
        except Exception:
            logger.exception("usage_event insert failed (erase success path)")

        output_gcs_uri = await _write_to_gcs(
            output_bytes,
            session_id=payload.session_id,
            job_id=payload.job_id,
            operation="erase",
            content_type="image/png",
        )

        async with pool.acquire() as conn:
            output_asset = await queries.create_asset(
                conn,
                session_id=payload.session_id,
                operation=OperationEnum.erase,
                gcs_uri=output_gcs_uri,
                content_hash=_sha256_hex(output_bytes),
            )
            await queries.update_job_status(
                conn,
                payload.job_id,
                JobStatusEnum.complete,
                output_asset_id=output_asset.id,
            )

        logger.info("Erase complete for job %s", payload.job_id)

    except Exception as exc:
        logger.exception("Erase worker failed for job %s", payload.job_id)
        async with pool.acquire() as conn:
            await queries.update_job_status(
                conn,
                payload.job_id,
                JobStatusEnum.failed,
                error=str(exc)[:500],
            )
            try:
                await queries.insert_usage_event(
                    conn,
                    user_email=user_email,
                    session_id=payload.session_id,
                    job_id=payload.job_id,
                    provider=provider_label,
                    model=provider_model,
                    operation="erase",
                    status="failed",
                    latency_ms=int((_time.monotonic() - call_started_at) * 1000),
                    cost_estimate_usd=estimate_cost_usd(provider_model),
                    error_message=str(exc)[:500],
                )
            except Exception:
                logger.exception("usage_event insert failed (erase failure path)")


async def handle_erase_task(
    payload: EraseTaskPayload,
    background_tasks: BackgroundTasks,
    request: Request,
) -> dict:
    """
    FastAPI route handler for POST /worker/erase. Quick-acknowledge
    pattern: returns HTTP 200 immediately, BFL polling happens in the
    background. Same shape as handle_enhance_task.
    """
    background_tasks.add_task(_run_erase, request, payload)
    return {"status": "acknowledged"}


# ─── Tweak pipeline (Gemini Flash Image text-guided targeted edits) ──────────


async def _run_tweak(
    request: Request,
    payload: TweakTaskPayload,
) -> None:
    """Background coroutine for Gemini text-guided variant refinement."""
    pool = request.app.state.pool
    genai_aistudio_client = request.app.state.genai_aistudio
    gemini_semaphore: asyncio.Semaphore = request.app.state.gemini_semaphore

    async with pool.acquire() as conn:
        user_email = await queries.get_session_user_email(conn, payload.session_id)
        await queries.update_job_status(conn, payload.job_id, JobStatusEnum.processing)

    import time as _time
    call_started_at = _time.monotonic()
    if payload.tool == "ideogram":
        provider_label = "ideogram"
        provider_model = IDEOGRAM_MODEL_LABEL
    else:
        provider_label = "gemini"
        provider_model = ENHANCE_MODEL_GEMINI  # same model id as primary enhance

    try:
        if payload.tool == "ideogram":
            # Ideogram has no shared concurrency budget with our other
            # Gemini-quota work, so it skips the gemini_semaphore.
            output_bytes = await _tweak_with_ideogram(
                payload.input_gcs_uri,
                payload.instruction,
            )
        else:
            if not genai_aistudio_client:
                raise RuntimeError(
                    "Tweak requested but the Gemini AI Studio client is not "
                    "initialized. Mount cleanshot-gemini-key:latest as "
                    "GEMINI_API_KEY via Cloud Run --set-secrets."
                )
            # Use the same Gemini concurrency semaphore as primary enhance.
            # Tweaks share the AI Studio quota with enhance/cleanup, so we
            # don't want a burst of tweaks to starve in-flight enhance jobs.
            async with gemini_semaphore:
                output_bytes = await _tweak_with_gemini(
                    genai_aistudio_client,
                    payload.input_gcs_uri,
                    payload.instruction,
                )
        if not output_bytes:
            raise ValueError(f"{provider_label} tweak returned no image bytes")

        try:
            async with pool.acquire() as conn:
                await queries.insert_usage_event(
                    conn,
                    user_email=user_email,
                    session_id=payload.session_id,
                    job_id=payload.job_id,
                    provider=provider_label,
                    model=provider_model,
                    operation="tweak",
                    status="success",
                    latency_ms=int((_time.monotonic() - call_started_at) * 1000),
                    cost_estimate_usd=estimate_cost_usd(provider_model),
                )
        except Exception:
            logger.exception("usage_event insert failed (tweak success path)")

        output_gcs_uri = await _write_to_gcs(
            output_bytes,
            session_id=payload.session_id,
            job_id=payload.job_id,
            operation="tweak",
            content_type="image/png",
        )

        async with pool.acquire() as conn:
            output_asset = await queries.create_asset(
                conn,
                session_id=payload.session_id,
                operation=OperationEnum.tweak,
                gcs_uri=output_gcs_uri,
                content_hash=_sha256_hex(output_bytes),
            )
            await queries.update_job_status(
                conn,
                payload.job_id,
                JobStatusEnum.complete,
                output_asset_id=output_asset.id,
            )

        logger.info("Tweak complete for job %s", payload.job_id)

    except Exception as exc:
        logger.exception("Tweak worker failed for job %s", payload.job_id)
        async with pool.acquire() as conn:
            await queries.update_job_status(
                conn,
                payload.job_id,
                JobStatusEnum.failed,
                error=str(exc)[:500],
            )
            try:
                await queries.insert_usage_event(
                    conn,
                    user_email=user_email,
                    session_id=payload.session_id,
                    job_id=payload.job_id,
                    provider=provider_label,
                    model=provider_model,
                    operation="tweak",
                    status="failed",
                    latency_ms=int((_time.monotonic() - call_started_at) * 1000),
                    cost_estimate_usd=estimate_cost_usd(provider_model),
                    error_message=str(exc)[:500],
                )
            except Exception:
                logger.exception("usage_event insert failed (tweak failure path)")


async def handle_tweak_task(
    payload: TweakTaskPayload,
    background_tasks: BackgroundTasks,
    request: Request,
) -> dict:
    """
    FastAPI route handler for POST /worker/tweak. Quick-acknowledge
    pattern: returns HTTP 200 immediately, Gemini call happens in the
    background. Same shape as handle_erase_task.
    """
    background_tasks.add_task(_run_tweak, request, payload)
    return {"status": "acknowledged"}
