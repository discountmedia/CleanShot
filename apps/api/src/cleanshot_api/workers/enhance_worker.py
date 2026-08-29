"""
Enhance worker — Cloud Tasks HTTP Target handler.

Pattern (Phase 2 v2.5):
  1. HTTP 200 returned immediately (quick-acknowledge) to prevent Cloud Tasks
     from retrying a live task.
  2. asyncio.create_task() fires the Gemini call in the background.
  3. Semaphore(8) per instance limits concurrent Gemini Pro Image calls
     (see main.py — this docstring said 2 long after it became 8).
     Global cap is enforced by Cloud Tasks max_concurrent_dispatches=10.
  4. On completion: write output asset to GCS, update job row, auto-enqueue scan.

Models: gemini-3.1-flash-image-preview (default) | gpt-5 (OpenAI) | grok-imagine-image-quality (xAI)
"""

from __future__ import annotations

import asyncio
import base64
import logging
import mimetypes
import os
import uuid
from typing import Any

import httpx
from fastapi import BackgroundTasks, Request
from google.genai import types

from cleanshot_api.core.config import get_settings
from cleanshot_api.db import queries
from cleanshot_api.services.image_processing import (
    apply_adjustments,
    downsize_for_vendor,
    upscale_to_standard,
)
from cleanshot_api.services.cutout import has_alpha, remove_background
from cleanshot_api.services.pricing import estimate_cost_usd
from cleanshot_api.models.schemas import (
    EnhanceTaskPayload,
    EnhanceToggles,
    EraseTaskPayload,
    ForkVisibility,
    JobStatusEnum,
    OperationEnum,
    ScanTaskPayload,
    TweakTaskPayload,
)
from cleanshot_api.services.tasks import enqueue_scan
from cleanshot_api.workers.master_prompts import (
    render_master_prompt,
    resolve_master_prompt,
)

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

# Native output resolution asked of Gemini. MEASURED 2026-08-29 on
# gemini-3.1-flash-image-preview, same input photo, same prompt:
#
#   (unset)  1209x864   1.04 MP  -> upscale_to_standard must cover-scale x2.32
#   "2K"     2418x1728  4.18 MP  -> x1.16
#   "4K"     4836x3456  16.7 MP  -> x0.58 (a downsample)
#
# Nothing set this before, so every stored asset was a ~2.3x lanczos UPSCALE of
# a 1 MP generation. Against a busy background that is invisible; against a
# transparent cutout it is not, which is how the operator found it.
#
# 2K and not 4K, for a measured reason rather than taste: the API container is
# **1 GiB with Semaphore(8)**. A 4836x3456 image decodes to ~50 MB of raw pixels
# for the resize, so eight concurrent jobs is 400 MB+ of pixel data alone and a
# Cloud Run OOM kills every in-flight job, not just the greedy one. 2K decodes
# to ~12.5 MB, so eight is ~100 MB. **Raise the memory limit BEFORE setting this
# to 4K.** At x1.16 the remaining upscale is nearly nothing anyway; 4K buys
# supersampling, not a fix.
#
# ⚠️ PER_IMAGE_USD carries a flat $0.039 for this model. Google prices image
# output by tokens, which scale with resolution, so that row is probably now
# low. Re-check it against a real bill rather than trusting it.
GEMINI_IMAGE_SIZE = os.environ.get("GEMINI_IMAGE_SIZE", "2K").strip()
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


# Grok / xAI image editing — synchronous JSON request to /v1/images/edits.
# Auth via Bearer header. Source image is sent as a base64 data URI
# inside the `image` object (NOT the OpenAI-compatible multipart/edit
# shape — the xAI docs explicitly call out that openai-sdk's
# client.images.edit() doesn't work because xAI's endpoint requires
# application/json). Response is OpenAI-style: { data: [{ url }] } or
# { data: [{ b64_json }] } depending on response_format.
GROK_GENERATE_URL = "https://api.x.ai/v1/images/edits"
ENHANCE_MODEL_GROK = "grok-imagine-image-quality"
#
# There is NO prompt length cap here, deliberately. A
# GROK_PROMPT_MAX_CHARS = 4000 slice lived here until 2026-08-28. xAI
# publishes no character limit and the number had no citation anywhere in
# the repo -- it was invented. What it actually did was silently discard
# the TAIL of every prompt, and because _build_enhance_prompt appends
# GUARDRAILS last, the tail is exactly the hard constraints: OEM decal
# preservation, no added lamps/beacons/attachments, no invented damage,
# and 'No zoom, crop, rotate, horizon-leveling, or re-posing'.
#
# Measured before removing it: the standard toggle set (painted forks +
# rental-branding removal) assembles to 4,586 characters, so Grok had
# never once received the anti-re-posing clause. Operator-reported symptom
# was 'results look good but it changes the angle of the lift' -- the
# creative half of the prompt survived at the front, the geometry half was
# cut off the back. Adding sterner anti-drift wording would have made it
# WORSE, because that wording lands in the discarded region too.
#
# If a genuine upstream limit ever appears, let it surface as a 4xx from
# api.x.ai, which the caller raises and logs. A visible error beats silent
# geometry corruption.

# Ideogram model label for usage_events.model when Ideogram is picked as a
# PRIMARY enhance provider (the 5th card on the Enhance tab). Same /v1/edit
# endpoint as the per-variant Ideogram Edit tool — see _tweak_with_ideogram
# for the lower-level call helper. The primary-enhance path reuses
# _tweak_with_ideogram and just passes the full enhance prompt instead of
# a short tweak instruction. Distinct constant from IDEOGRAM_MODEL_LABEL
# (which is used for the per-variant tweak/inpaint tools) so future model
# bumps can move independently per surface if needed.
ENHANCE_MODEL_IDEOGRAM = "ideogram-3.0"


# Display name + per-type anatomy guardrail for the equipment-aware prompt.
# Keep these short — they slot into a sentence inside GUARDRAILS so the
# operator's model gets a clear "preserve these specific parts" list per
# unit category.
EQUIPMENT_DISPLAY: dict[str, str] = {
    "forklift":       "forklift",
    "rough_terrain":  "rough-terrain forklift",
    "scissor_lift":   "scissor lift",
    "telehandler":    "telehandler",
    "reach_truck":    "reach truck",
    "turret_truck":   "turret truck (VNA / swing-reach)",
    "articulated_forklift": "articulated narrow-aisle forklift (Bendi / Flexi / Aisle-Master style)",
    "order_picker":   "order picker",
    "pallet_jack":    "pallet jack",
    "walkie_stacker": "walkie stacker",
}

EQUIPMENT_ANATOMY: dict[str, str] = {
    "forklift": (
        "Same mast configuration, fork count, fork length, overhead guard "
        "shape, counterweight shape, and tire type."
    ),
    "rough_terrain": (
        "Same mast configuration, fork count, fork length, overhead guard "
        "shape, counterweight shape, and the LARGE PNEUMATIC outdoor tires "
        "with their existing tread pattern — rough-terrain units run on "
        "knobby pneumatic tires (NOT the small solid cushion tires of a "
        "warehouse forklift). Preserve the heavier-duty outdoor frame."
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
    "reach_truck": (
        "Same mast height and section count, fork count and length, reach "
        "mechanism geometry (pantograph or moving-mast), operator cab / "
        "stand-up compartment shape, drive wheels, and load wheels."
    ),
    "turret_truck": (
        "Same tall multi-stage mast and section count, the rotating / "
        "traversing turret fork head (swing-reach carriage), fork count and "
        "length, operator cab or platform shape (man-up cab that rises, or "
        "man-down), overhead guard, narrow chassis width, drive wheel, load "
        "wheels, and any aisle guide rollers. This is a very-narrow-aisle "
        "(VNA) truck — do NOT redraw it as a standard counterbalance forklift."
    ),
    "articulated_forklift": (
        "Same articulating front end — the mast/carriage assembly pivots to "
        "the side for narrow-aisle turning (Bendi / Flexi / Aisle-Master "
        "style). Preserve that articulation joint, the mast configuration and "
        "section count, fork count and length, overhead guard shape, "
        "counterweight shape, compact chassis, and tire type. It resembles a "
        "counterbalance forklift but the front section bends — keep it."
    ),
    "order_picker": (
        "Same platform size and railing pattern, mast height and section "
        "count, integrated forks or load support, base chassis dimensions, "
        "drive wheels, and operator control layout."
    ),
    "pallet_jack": (
        "Same fork length and spread, tiller handle shape and length, "
        "front (steer) wheels, load wheels, and battery box position if "
        "electric."
    ),
    "walkie_stacker": (
        "Same mast configuration, fork count and length, tiller handle "
        "position and shape, drive wheel, load wheels, and operator "
        "control layout."
    ),
}

# Body-parts list that gets substituted into "the entire body of the
# {eq}, including the {EQUIPMENT_BODY_PARTS}, has received a fresh coat".
# Keeps the refined prompt readable for non-forklift types.
EQUIPMENT_BODY_PARTS: dict[str, str] = {
    "forklift":       "chassis, mast, and carriage",
    "rough_terrain":  "chassis, mast, carriage, and counterweight",
    "scissor_lift":   "chassis, scissor arms, and platform railing",
    "telehandler":    "chassis, boom, and cab",
    "reach_truck":    "chassis, mast, reach mechanism, and cab",
    "turret_truck":   "chassis, mast, and turret fork head",
    "articulated_forklift": "chassis, articulating mast, and carriage",
    "order_picker":   "chassis, mast, platform, and forks",
    "pallet_jack":    "forks, tiller, and wheel housing",
    "walkie_stacker": "chassis, mast, forks, and tiller",
}


def _build_fork_fragments(fork: ForkVisibility) -> list[str]:
    """
    The LIFTING FORKS instruction, as named fragments.

    This used to be one paragraph. Two clauses inside it were driving reported
    failures whenever the source photo didn't show the whole fork:

      • "The red covers the heel of each fork (the vertical shank)" — on angles
        where the upright section is out of frame, the model painted part of
        the overhead guard or carriage to manufacture one to cover.
      • "the outermost ~15-20 cm of the tip is safety YELLOW" — when the tips
        are cropped out, the model SHORTENED the forks to drag tips into view
        so it had something to paint yellow.

    So the fix is removal, not more instruction. Each fragment below is a whole
    sentence, which is what makes dropping one safe: no fragment refers to
    another ("those", "the above"), so any subset still reads as coherent,
    non-contradictory prose.

    Ordering is fixed and independent of which fragments survive.
    """
    fragments: list[str] = []

    # Always present: what to paint, and what NOT to paint around it.
    fragments.append(
        "LIFTING FORKS — paint ONLY the two horizontal fork tines "
        "themselves (the L-shaped blades that go into pallets) with "
        "Discount Forklift signature red."
    )

    if fork.vertical_visible:
        fragments.append(
            "The red covers the heel of each fork (the vertical shank) and "
            "roughly the first 80% of the horizontal blade."
        )
    else:
        # Not a bare deletion — the model is told the section is absent, so it
        # has no gap to fill in from its training prior.
        fragments.append(
            "The upright vertical section (shank / heel) of the fork is NOT "
            "visible in this photo. Paint only the horizontal blade that is "
            "actually in frame. Do not render or invent a vertical fork "
            "section, and do not treat any part of the carriage, mast, mast "
            "rails, or overhead guard as if it were one."
        )

    if fork.tips_visible:
        fragments.append(
            "The outermost ~15-20 cm (~6-8 inches) of the tip is safety YELLOW."
        )
    else:
        # SUBSTITUTION. Deleting the tip clause outright leaves the tips
        # unmentioned, and the model's prior for a red Discount Forklift fork
        # is yellow tips — so silence reproduces the bug.
        fragments.append(
            "The fork tips are CROPPED OUT of frame in this photo. Paint the "
            "visible blade red end to end with NO yellow anywhere, and do NOT "
            "shorten, resize, or reposition the forks to bring their tips "
            "into view."
        )

    fragments.append(
        "Do NOT paint the surrounding carriage, mast, mast rails, side "
        "shifters, attachment brackets, or any hardware around the forks — "
        "ONLY the two fork tines themselves. The LOAD BACK REST (LBR), the "
        "vertical cage / grid frame at the back of the fork carriage, remains "
        "BLACK; OSHA convention reserves black for the LBR so the high-vis "
        "forks read clearly against it."
    )

    return fragments


def _build_fork_visibility_note(fork: ForkVisibility) -> str | None:
    """
    The append-mode counterpart for a CUSTOM operator prompt.

    When the operator has written their own prompt there is no fragment of
    ours to remove — their words are the spine. Doing nothing would be a
    silent failure: they ticked a control and it had no effect. So the
    constraint is stated explicitly instead, and the UI tells them that is
    what will happen (see the note beside the controls in EnhancePanel).

    Returns None when both parts are visible, so the common case adds nothing.
    """
    lines: list[str] = []
    if not fork.vertical_visible:
        lines.append(
            "• The upright vertical section (shank / heel) of the fork is NOT "
            "visible in this photo. Do not render, paint, or invent one, and "
            "do not treat any part of the carriage, mast, or overhead guard "
            "as if it were the vertical fork shank."
        )
    if not fork.tips_visible:
        lines.append(
            "• The fork tips are CROPPED OUT of frame in this photo. Paint no "
            "yellow tips anywhere, and do NOT shorten, resize, or reposition "
            "the forks to bring their tips into view."
        )
    if not lines:
        return None
    return "FORK FRAMING — what is actually in frame:\n" + "\n".join(lines)


def _build_enhance_prompt(
    toggles: EnhanceToggles,
    equipment_type: str = "forklift",
    spine_override: str | None = None,
    fork_visibility: ForkVisibility | None = None,
    framing_already_in_prompt: bool = False,
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

    `spine_override` — when set (a fully-rendered master prompt from
    workers/master_prompts.py, placeholders already filled), it REPLACES
    the built-in spine prose. The paint-forks block, the toggle add-ons,
    and the final GUARDRAILS section are still appended on top, so toggle
    checkboxes keep working regardless of prompt choice. When None, the
    function behaves exactly as before (zero regression on the legacy /
    "auto" path).

    `fork_visibility` — which parts of the fork are in frame for THIS photo.
    Defaults to fully-visible, which reproduces the previous prompt exactly.
    On the built-in path it REMOVES the offending fork fragments; on the
    custom-prompt path there is nothing of ours to remove, so an explicit
    FORK FRAMING note is appended instead (see _build_fork_visibility_note).

    DRIFT-WARNING:
      The Scan-tab "Regenerate" auto-prompt is built client-side in
      apps/web/lib/scan-helpers.ts. Keep it in sync.
    """
    fork = fork_visibility or ForkVisibility()
    eq_display = EQUIPMENT_DISPLAY.get(equipment_type, "forklift")
    eq_anatomy = EQUIPMENT_ANATOMY.get(
        equipment_type, EQUIPMENT_ANATOMY["forklift"]
    )
    eq_parts = EQUIPMENT_BODY_PARTS.get(
        equipment_type, EQUIPMENT_BODY_PARTS["forklift"]
    )

    # All equipment types except scissor lift carry visible forks
    # (forklift / telehandler / reach truck / order picker / pallet
    # jack / walkie stacker). Scissor lifts have a platform instead, so
    # the "paint forks red w/ yellow tips" toggle is silently ignored
    # for them.
    paint_forks_on = (
        toggles.paint_forks_red_yellow_tips
        and equipment_type != "scissor_lift"
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

    if spine_override is not None:
        # Master-prompt path: the operator-selected prompt (already rendered
        # with equipment placeholders filled) is the entire spine. Toggle
        # add-ons + GUARDRAILS still append below.
        sections.append(spine_override)
    else:
        # ── Built-in spine (the "auto" / legacy path) ────────────────────
        # Operator-supplied respray spine. The {eq_display} / {eq_parts}
        # interpolation keeps non-forklift equipment reading correctly.
        sections.append(
            f"A photorealistic image of a heavily used {eq_display} that has "
            f"just received a quick, inexpensive shop-grade respray."
        )

        sections.append(
            f"This is a real commercial shop repaint — fast, cheap, and done to "
            f"make the unit look listing-ready. It is explicitly NOT a "
            f"professional restoration and NOT a factory-fresh finish. The goal "
            f"is \"cheap but clean.\""
        )

        sections.append(
            "WHAT THE NEW PAINT COVERS:\n"
            "- All surface paint chips, scuffs, scratches, and faded areas\n"
            "- Light surface rust and oxidation\n"
            "- Dirt, grime, dust, and surface stains (cleaned before painting)\n"
            "- Dull, weathered original paint — now restored to a saturated "
            "version of the colour it already is"
        )

        sections.append(
            "WHAT THE NEW PAINT DOES NOT COVER (these must remain clearly "
            "visible):\n"
            "- Dents, panel deformations, and bent hardware\n"
            "- Deep gouges that go into the metal\n"
            "- Missing parts, broken or cracked components\n"
            "- Severe rust-through holes and large rust pitting craters\n"
            "- Mismatched or replaced aftermarket panels (keep them visually "
            "distinct)"
        )

        sections.append(
            f"PAINT JOB QUALITY:\n"
            f"Apply a realistic shop spray gun respray in the exact original "
            f"factory color scheme. Even coverage on most surfaces with slight "
            f"orange-peel texture visible on close inspection, minor overspray "
            f"in tight corners, and subtle edge buildup. It should look like a "
            f"competent but budget-conscious shop job, not premium bodywork. "
            f"Apply this respray to the {eq_parts}."
        )

    if paint_forks_on:
        sections.append(" ".join(_build_fork_fragments(fork)))

    # Custom-prompt path: the operator's words are the spine, so there is no
    # fragment of ours to drop. State the framing constraint outright rather
    # than letting the control do nothing.
    #
    # Skipped when the caller already composed the framing into the prompt
    # itself (`fork_framing_in_prompt`) — the Enhance tab rebuilds the
    # recommended prompt from fragments per image, which is a real removal, and
    # appending our note on top would restate it a second time.
    if (
        spine_override is not None
        and equipment_type != "scissor_lift"
        and not framing_already_in_prompt
    ):
        fork_note = _build_fork_visibility_note(fork)
        if fork_note is not None:
            sections.append(fork_note)

    if spine_override is None:
        # Tires / scene / closing line are part of the built-in spine — a
        # master prompt carries its own equivalents, so skip these when one
        # is in use.
        sections.append(
            "TIRES:\n"
            "Keep the exact same tires from the source image. Maintain all "
            "tread wear, cuts, gouges, and aging cracks on the tread surface. "
            "However, generously apply glossy tire shine ONLY to the sidewalls, "
            "making them deep black, wet-look, and highly reflective. Tread "
            "must remain dry, dusty, and matte."
        )

        sections.append(
            "SCENE & COMPOSITION:\n"
            "Maintain the exact same camera angle, perspective, framing, "
            "lighting direction, and background environment as the source "
            "image. Do not change, crop, rotate, or replace the background "
            "under any circumstances."
        )

        sections.append(
            f"The ideal result is a clearly used {eq_display} that has obviously "
            f"received a fresh but inexpensive shop respray — improved "
            f"appearance while still looking like a working, previously abused "
            f"machine with glossy tire sidewalls."
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
    # Forced ON under a cutout (2026-08-29). Printed signage is the one
    # distractor the matting pass cannot fix downstream: a wall banner can be a
    # third of the machine's masked area, so the mask-island filter in
    # services/cutout.py keeps it rather than risk deleting a split machine. The
    # only reliable place to remove it is here, before the pixels reach the mask.
    # Physical objects (plants, cones, pallets) go the other way — the island
    # filter deletes those for free, with no regeneration.
    if toggles.remove_background_signage or toggles.transparent_background:
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
    if toggles.showroom_floor and not toggles.transparent_background:
        # Skipped under a cutout: the floor is about to be matted away, so
        # replacing it first is wasted instruction — and a glossy grey sweep
        # gives the matting model a lower-contrast edge to find under the
        # tyres than the real ground did.
        extras.append(
            "ADDITIONAL ACTION — SHOWROOM / STUDIO FLOOR. The source "
            "photo was shot inside a studio or showroom. REPLACE the "
            "floor entirely with a perfect, flawless, MIDDLE-GRAY "
            "(neutral 50% gray, approximately #808080) seamless "
            "studio floor with a glossy / polished concrete finish. "
            "The new floor must read as: perfectly clean, evenly "
            "lit, subtly reflective (a soft polished sheen suggesting "
            "a buffed surface — NOT mirror-bright, NOT a wet look), "
            "absolutely no tape marks, no scuff streaks, no "
            "footprints, no tire tracks, no dust, no debris, no "
            "drop-cloth wrinkles, no gaffer-tape edges, no visible "
            "seam between the floor and the backdrop wall, and no "
            "visible texture variation across the surface. The grey "
            "is the same value everywhere — uniform, calibrated, "
            "showroom-grade. Preserve the unit's own contact shadow "
            "exactly as cast on the original floor — do not soften, "
            "lift, or remove the shadow; it grounds the unit in the "
            "new floor. If the photo is NOT a studio shot (outdoor "
            "yard, warehouse with a busy floor pattern, parking lot, "
            "gravel), this action is a no-op; leave the ground as-is."
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
    # Identity-preservation guardrail for 3-wheel forklifts. Gated to
    # equipment_type=="forklift" in lock-step with the EnhancePanel
    # filter — rough-terrain / telehandler / scissor / pallet / etc.
    # are never 3-wheel layouts, so the toggle silently no-ops there
    # even if a hand-crafted request sends it on.
    if toggles.three_wheel and equipment_type == "forklift":
        extras.append(
            "THREE-WHEEL FORKLIFT — this unit is a 3-WHEEL design with a "
            "SINGLE rear wheel (a pivot / steer wheel under the centre of "
            "the counterweight), NOT two rear wheels. Preserve the single-"
            "rear-wheel layout exactly: do not add a second rear wheel, "
            "do not split the single wheel into a dual set, do not change "
            "the wheel position or size."
        )

    if extras:
        sections.append(
            "ADDITIONAL EMPHASIS — apply ON TOP of the spine above:\n\n"
            + "\n\n".join(f"• {e}" for e in extras)
        )

    # ── Hard guardrails (scene + anatomy preservation) ─────────────────
    #
    # `eq_anatomy` asks for "same fork count, fork length". That is exactly the
    # clause the model is fighting when the tips are out of frame: it cannot
    # both preserve fork length and show tips it can't see, and it resolves the
    # conflict by shortening the forks. Restate the length rule so the
    # out-of-frame case is unambiguous rather than contradictory.
    if not fork.tips_visible and equipment_type != "scissor_lift":
        eq_anatomy = (
            f"{eq_anatomy} The forks run out of frame in this photo — keep "
            f"them running out of frame at their existing length and angle; "
            f"do not foreshorten them to fit the tips into the image."
        )

    sections.append(
        f"GUARDRAILS — hard constraints:\n"
        f"• Make, model, year, trim level. {eq_anatomy}\n"
        f"• Every OEM make, model, capacity and safety decal stays "
        f"exactly as it is: same position, same size, same existing wear, "
        f"still legible. Mask them off during the respray rather than "
        f"painting over them or redrawing the text.\n"
        f"• Do NOT add lamps, beacons, mirrors, antennas, attachments, or "
        f"any bolt-on hardware that is not already in the source.\n"
        f"• Do not introduce damage, dents, broken parts, or wear that "
        f"was not in the source image.\n"
        f"• Never isolate the {eq_display} on a white / studio / gradient "
        f"backdrop. No zoom, crop, rotate, horizon-leveling, or re-posing."
    )

    return "\n\n".join(sections)


def _build_grok_prompt(
    toggles: EnhanceToggles,
    equipment_type: str = "forklift",
    spine_override: str | None = None,
    fork_visibility: ForkVisibility | None = None,
) -> str:
    """Build a Grok-specific enhance prompt. Terse, imperative, "change X, keep Y".

    WHY GROK DOES NOT USE _build_enhance_prompt
    -------------------------------------------
    Grok (`/v1/images/edits`) is an identity-preserving EDIT model, the same
    class as Flux Kontext. This repo already learned — and wrote down — that
    such models "degrade badly on the long, multi-section declarative prose
    that _build_enhance_prompt feeds Gemini", and named the result **the
    "whole machine turns red" failure mode**. That text lived in
    `_build_kontext_prompt`, which was deleted along with Kontext on
    2026-08-27. Grok was then routed through the Gemini builder and reproduced
    the failure exactly: operator-reported output on 2026-08-28 had the mast,
    overhead guard and body bled red from the fork instruction, and the camera
    angle re-posed from side-profile to three-quarter.

    Removing the invented 4000-char cap earlier the same day did NOT fix it,
    and plausibly made it worse: it delivered MORE of the wrong-shaped prompt.
    The cap removal was still correct on its own terms — it was silently
    discarding the GUARDRAILS block — but shape, not length, is the problem.

    This is a faithful adaptation of the deleted Kontext builder, whose shape
    was tuned against this model class. Two things in it are load-bearing and
    should not be "tidied":

      • The fork clause ends with "Leave the carriage, mast, and the black
        load-back-rest cage unpainted." That sentence is the anti-bleed
        instruction. Gemini's fragment builder has no equivalent because
        Gemini does not need one. Grok does.
      • The pure-emphasis toggles (new_paint_job / remove_rust / shine_tires /
        restore_decals) get NO clause of their own. The base already covers
        paint, rust, tire-shine and decals, and restating them dilutes the
        edit. Only ACTION toggles append.

    UNVERIFIED. This restores a shape measured against Kontext, not Grok. It
    needs a side-by-side against the Gemini reference render before it is
    trusted on a batch — see the enhance-prompt rules in CLAUDE.md.

    DRIFT-WARNING: shares treatment intent with _build_enhance_prompt (Gemini)
    and the Scan-tab regen prompt in apps/web/lib/scan-helpers.ts — when the
    treatment changes, update all three.
    """
    eq_display = EQUIPMENT_DISPLAY.get(equipment_type, "forklift")
    fork = fork_visibility or ForkVisibility()
    paint_forks_on = (
        toggles.paint_forks_red_yellow_tips
        and equipment_type != "scissor_lift"
    )

    lines: list[str]
    if spine_override is not None:
        # Operator prompt (or a master prompt) is the whole base; the action
        # clauses below still append on top, same contract as the Gemini path.
        lines = [spine_override]
    else:
        lines = [
            f"Photorealistic image of a heavily used {eq_display} after a "
            f"quick, inexpensive shop-grade respray. This is a cheap-but-clean "
            f"commercial repaint to make it listing-ready. Not a restoration, "
            f"not factory fresh.",
            "WHAT THE PAINT COVERS:\n"
            "- Surface chips, scuffs, scratches, faded paint\n"
            "- Light surface rust and oxidation\n"
            "- Dirt, grime, and stains\n"
            "- Dull colors restored to a saturated version of the colour they "
            "already are",
            "WHAT THE PAINT DOES NOT COVER (must remain visible):\n"
            "- Dents, panel deformations, bent hardware\n"
            "- Deep metal gouges\n"
            "- Missing/broken parts, cracked components\n"
            "- Severe rust-through holes and large pitting\n"
            "- Mismatched aftermarket panels (keep them distinct)",
            "PAINT STYLE: Realistic shop spray gun application in the SAME "
            "colours the unit already wears. Even coverage with slight "
            "orange-peel texture, minor overspray in corners. Looks competent "
            "but budget-level.",
            "Preserve all OEM decals in exact original positions with realistic "
            "wear.",
            "TIRES: Keep identical tires. Preserve all tread wear, cuts, and "
            "cracks. Apply glossy tire shine ONLY to sidewalls (deep black, "
            "wet-look, reflective). Tread stays dry, dusty, and matte.",
            "SCENE: Exact same camera angle, perspective, framing, lighting, "
            "and background as the source image. Do not change, crop, rotate, "
            "re-pose, or replace anything.",
            "STRICT RULES:\n"
            "- Do not add lights, beacons, mirrors, antennas, or new "
            "attachments\n"
            "- Do not add new damage or wear\n"
            "- Do not make it look brand new\n"
            "- Do not leave it unchanged — clear fresh respray must be obvious\n"
            "- Preserve all original proportions, panels, and mechanical "
            "details",
            f"Result: Clearly used {eq_display} with fresh but cheap shop paint "
            f"job and glossy sidewalls, while keeping all real-world wear and "
            f"damage.",
        ]

    if paint_forks_on:
        # The trailing "leave ... unpainted" sentence is the anti-bleed clause.
        # fork_visibility is honoured the same way the Gemini fragments do it:
        # a section that is out of frame is DESCRIBED as absent rather than
        # silently dropped, so the model has no gap to fill from its prior.
        if fork.tips_visible and fork.vertical_visible:
            fork_line = (
                "Paint only the two fork blades Discount Forklift red with "
                "safety-yellow tips — red on the shank and roughly the first "
                "80% of each blade, yellow on the outer ~15 cm tip."
            )
        elif fork.tips_visible:
            fork_line = (
                "Paint only the two fork blades Discount Forklift red with "
                "safety-yellow tips. The upright shank is out of frame in this "
                "photo — paint only the horizontal blade that is visible."
            )
        elif fork.vertical_visible:
            fork_line = (
                "Paint only the two fork blades Discount Forklift red, red on "
                "the shank and along the whole visible blade. The fork tips run "
                "out of frame — keep them running out of frame at their "
                "existing length; do not shorten the forks and do not add "
                "yellow tips."
            )
        else:
            fork_line = (
                "Paint only the two fork blades Discount Forklift red along the "
                "whole visible length. The tips run out of frame — keep them "
                "out of frame at their existing length; do not shorten the "
                "forks and do not add yellow tips."
            )
        lines.append(
            fork_line
            + " Leave the carriage, mast, overhead guard, counterweight, body "
            "panels, and the black load-back-rest cage completely unpainted — "
            "the red goes on the fork blades and nowhere else."
        )

    if toggles.remove_people:
        lines.append(
            "Remove every person, operator, and hand from the frame, "
            "filling the vacated space with the background behind them."
        )
    # Forced ON under a cutout — same reasoning as the Gemini builder above.
    if toggles.remove_background_signage or toggles.transparent_background:
        lines.append(
            "Remove background signs, posters, logos, and wall text "
            "(replace each with the plain surface behind it), but keep all "
            f"signage on the {eq_display} itself."
        )
    if toggles.remove_rental_branding:
        lines.append(
            "Remove third-party rental-fleet decals, wraps, and asset-tag "
            "numbers (Sunbelt, United Rentals, Herc, etc.), matching the "
            "panel underneath with no ghost outline. Keep all OEM "
            "manufacturer decals and do not invent any replacement logos."
        )
    if toggles.showroom_floor and not toggles.transparent_background:
        # Skipped under a cutout for the same reason as the Gemini builder:
        # the floor is about to be matted away, and a glossy grey sweep gives
        # the matting model a lower-contrast edge under the tyres.
        lines.append(
            "If the shot is in a studio or showroom, replace the floor with "
            "a clean uniform mid-gray (#808080) lightly-polished seamless "
            "studio floor, keeping the unit's own contact shadow; if it is "
            "an outdoor yard, warehouse, or lot, leave the ground as-is."
        )
    if toggles.improve_lighting:
        lines.append(
            "Balance the exposure and lighting while keeping the scene and "
            "location intact."
        )
    if toggles.three_wheel and equipment_type == "forklift":
        lines.append(
            "This is a 3-WHEEL forklift — keep the SINGLE rear pivot/steer "
            "wheel under the counterweight. Do not add a second rear wheel."
        )

    return "\n".join(lines)


# Cap long-edge of the input image before sending to any vendor. Final
# export is 1024×731, so anything bigger upstream is just paying tax on
# INPUT RESOLUTION IS NO LONGER CAPPED (2026-08-21).
#
# This used to downscale every source to 1024px on the long edge before the
# vendor call. With enhanced output standardised at 2800x2000, that meant the
# model was handed a 1024px source and its result was upscaled ~2.7x on the way
# out — correctly sized, but soft, because the detail was discarded upstream.
# Full-resolution sources give the model something real to work with.
#
# The constant is kept at its old value but is NO LONGER APPLIED, so the
# previous behaviour is one line away if vendor latency or per-image byte
# limits turn out to bite. Watch for: OpenAI /v1/responses timeouts on large
# uploads (the original reason for the cap), and provider request-size limits.
INPUT_MAX_LONG_EDGE_PX = 1024

# Per-provider cap for the OpenAI path ONLY (see downsize_for_vendor).
# 2048 is the resize target main.py already anticipates: "once Phase 3
# input-resize-to-2048 ships, this can come back down" - written next to
# the 300s client timeout that full-resolution uploads forced.
OPENAI_MAX_LONG_EDGE_PX = 2048


async def _load_image_bytes(gcs_uri: str) -> tuple[bytes, str]:
    """Download bytes from GCS at NATIVE RESOLUTION.
    Returns (bytes, detected_content_type).

    The downsize to INPUT_MAX_LONG_EDGE_PX was removed 2026-08-21 — see the
    note on that constant. The source now reaches the model at whatever
    resolution it was uploaded at, so the standardisation to 2800x2000 after
    enhancement has real detail to work from instead of enlarging a 1024px
    frame.

    Sync SDK runs in a worker thread.

    Duplicated from scan_worker.py for now — TODO: move to services/gcs.py
    (TODO is now 3-callers-old, cleanup_worker imports this directly).
    """
    from google.cloud import storage as gcs

    settings = get_settings()
    without_scheme = gcs_uri[len("gs://"):]
    bucket_name, _, object_name = without_scheme.partition("/")

    def _download_and_downsize() -> tuple[bytes, str]:
        client = gcs.Client(project=settings.gcp_project)
        blob = client.bucket(bucket_name).blob(object_name)
        data = blob.download_as_bytes()

        # Magic-byte sniff for content type. No re-encode: the bytes go to the
        # vendor exactly as uploaded.
        if data[:8] == b"\x89PNG\r\n\x1a\n":
            ct = "image/png"
        elif data[:4] == b"RIFF":
            ct = "image/webp"
        else:
            ct = "image/jpeg"
        return data, ct

    return await asyncio.to_thread(_download_and_downsize)


# ── Auto-pick "best of N" judge ──────────────────────────────────────────────
#
# One Claude vision call ranks the enhance variants for a single source image
# against the operator's calibrated listing-readiness rubric and names a winner.
#
# The rubric is ported VERBATIM from scripts/holistic_judge.py, which measured
# ~70% agreement with the operator's hand labels. Two hard rules:
#   • Do NOT retune this rubric here without re-running that calibration harness
#     — the agreement number stops meaning anything otherwise.
#   • The harness measured `claude-sonnet-4-6`. JUDGE_MODEL was moved to
#     `claude-opus-5` on 2026-08-27 at the operator's request (standardising
#     every Claude call in the app on one model). THE ~70% FIGURE ABOVE NO
#     LONGER DESCRIBES WHAT SHIPS. It is the agreement of the old model on the
#     old rubric. Re-run scripts/holistic_judge.py against opus-5 to get a real
#     number; until then, treat auto-pick as uncalibrated rather than as a
#     measured 70%. Opus 5 is a stronger model, so it is more likely to have
#     improved than regressed — but "likely" is not a measurement.
#
# Candidates are labeled NEUTRALLY ("CANDIDATE 1/2/3") — the provider name is
# never shown to the model so brand priors can't bias the pick. The caller maps
# the winning candidate number back to its provider by index.
JUDGE_MODEL = "claude-opus-5"

JUDGE_RUBRIC = """You are the final quality-control reviewer for a USED-forklift dealer's
online listing photos. You are shown the ORIGINAL real photo of a machine, then
one or more AI-ENHANCED CANDIDATE versions of the SAME machine, each intended to
go on the sales listing. Score every candidate and pick the single best one.

The enhancer is ONLY allowed to: lightly respray the BODY in its OWN existing colour,
paint the FORKS red with yellow tips, keep the load-backrest black, clean/soften the
background and floor, and improve lighting. Nothing else about the machine may change.

A candidate FAILS if it shows ANY of these vs the ORIGINAL — these are the exact
defects the dealer rejects:
- COMPONENT RECOLOURED to a CLEARLY DIFFERENT HUE: a part changed to a different colour
  family than the original — especially the CAB / operator compartment, the MAST, the
  body, or a panel (e.g. yellow→red, grey→blue, orange→charcoal). This is a real defect.
  NOT a defect: a cleaner/brighter version of the SAME colour, or darkening a frame /
  fork-carriage / load-backrest / overhead-guard toward BLACK (that black treatment is
  intended). Only flag a genuine hue SWAP, not darkening or same-colour freshening.
- DESATURATED / WASHED-OUT: components look greyed, faded, or less saturated than the
  original.
- WHEELS OR PARTS ADDED/REMOVED: a wheel, axle, or part appears that was not in the
  original (or a real part is gone), changing the machine's configuration.
- RESHAPED: the machine's overall shape, structure, or silhouette has been redrawn so it
  no longer matches the real unit's proportions (a "completely different look").
- OBVIOUSLY AI-GENERATED: melted, warped, plasticky, smeared, or nonsensical structure.
- MODEL TEXT WRONG: a legible model-number or capacity plate is SIGNIFICANTLY wrong (a
  1-2 character difference on a small marking is fine).

A candidate PASSES only if NONE of the above apply — it still looks like the same real
unit, changed only in the allowed ways. Tolerate: same-colour body respray, red/yellow
forks, black load-backrest, cleaned background/floor, better lighting, subtle harmless
differences, tiny text differences, and filling in parts that were merely hard to see.

Scoring: give each candidate a listing-readiness score from 0-100. A passing candidate
scores 60-100 (higher = cleaner, more believable, better lighting/background). A failing
candidate scores 0-59 (lower = more/worse defects). Rank all candidates and name the ONE
you would list. If several pass, pick the most believable and best-presented. If NONE
pass, still name the least-bad candidate as the winner.

If no original photo is provided, judge each candidate on listing-readiness alone:
believable real machine, clean presentation, no obvious AI artefacts."""


def _as_int(value: Any, default: int = 0) -> int:
    """Coerce a model-supplied value to int, falling back on anything unparseable.

    Anthropic does NOT validate tool_use input against the declared schema
    (unlike OpenAI strict mode — hard-won lesson #6), so a model that emits
    score:null or "N/A" for a candidate it declines to grade would crash a bare
    int(). This keeps one malformed field from 500-ing the whole judge (which
    silently disables auto-pick for that image)."""
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


async def judge_variants(
    anthropic_client: Any,
    candidates: list[tuple[str, uuid.UUID, str]],
    original_gcs_uri: str | None,
    equipment_type: str | None = None,
    make: str | None = None,
) -> dict[str, Any]:
    """Rank N enhance variants of one source image; return the winner + per-candidate
    scores. `candidates` is [(provider, asset_id, gcs_uri), ...] in caller order.

    Returns a dict matching EnhanceJudgeResponse's fields (winner_provider,
    winner_asset_id, all_pass, any_pass, rankings). Mirrors the scan worker's
    tool-forced-JSON Anthropic pattern (hard-won lesson #6 — no output_config).
    """
    # Download all images concurrently (original first if present).
    load_targets: list[str] = ([original_gcs_uri] if original_gcs_uri else []) + [
        uri for _p, _a, uri in candidates
    ]
    loaded = await asyncio.gather(*(_load_image_bytes(u) for u in load_targets))

    content: list[dict[str, Any]] = []
    idx = 0
    if original_gcs_uri:
        obytes, oct = loaded[0]
        content.append({"type": "text", "text": "ORIGINAL — the real photo of the machine:"})
        content.append(
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": oct,
                    "data": base64.b64encode(obytes).decode(),
                },
            }
        )
        idx = 1

    for i, (_provider, _asset_id, _uri) in enumerate(candidates, start=1):
        cbytes, cct = loaded[idx]
        idx += 1
        content.append({"type": "text", "text": f"CANDIDATE {i} — an AI-enhanced version:"})
        content.append(
            {
                "type": "image",
                "source": {
                    "type": "base64",
                    "media_type": cct,
                    "data": base64.b64encode(cbytes).decode(),
                },
            }
        )

    n = len(candidates)
    content.append(
        {
            "type": "text",
            "text": (
                f"Score all {n} candidate(s) and report the ranking. "
                "Return the assessment via the report_ranking tool only."
            ),
        }
    )

    # Equipment context (mirrors the scan tab's KNOWN EQUIPMENT CONTEXT block)
    # so the judge weighs anatomy against the right machine.
    system_prompt = JUDGE_RUBRIC
    if equipment_type or make:
        ctx = "\n\nKNOWN EQUIPMENT CONTEXT — the machine is a "
        ctx += " ".join(x for x in [make, (equipment_type or "").replace("_", " ")] if x).strip()
        ctx += ". Judge its anatomy against this type."
        system_prompt += ctx

    tool_schema = {
        "type": "object",
        "properties": {
            "rankings": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "candidate": {
                            "type": "integer",
                            "description": f"Candidate number, 1-{n}.",
                        },
                        "verdict": {"type": "string", "enum": ["pass", "fail"]},
                        "score": {
                            "type": "integer",
                            "description": "Listing-readiness 0-100 (pass=60-100, fail=0-59).",
                        },
                        "reason": {"type": "string"},
                    },
                    "required": ["candidate", "verdict", "score", "reason"],
                },
            },
            "winner": {
                "type": "integer",
                "description": f"Candidate number (1-{n}) you would list.",
            },
        },
        "required": ["rankings", "winner"],
    }

    response = await anthropic_client.messages.create(
        model=JUDGE_MODEL,
        max_tokens=1024,
        system=system_prompt,
        tools=[
            {
                "name": "report_ranking",
                "description": "Submit the ranked listing-readiness assessment.",
                "input_schema": tool_schema,
            }
        ],
        tool_choice={"type": "tool", "name": "report_ranking"},
        messages=[{"role": "user", "content": content}],
    )
    tool_block = next(b for b in response.content if b.type == "tool_use")
    result = tool_block.input  # dict

    # Map candidate numbers (1-based) back to providers/assets. Defensive
    # against an out-of-range or missing winner from the model.
    by_num: dict[int, dict[str, Any]] = {}
    rankings_out: list[dict[str, Any]] = []
    for r in result.get("rankings", []):
        # _as_int guards against non-integer model output (Anthropic doesn't
        # enforce tool-input types — lesson #6). The `num in by_num` guard drops
        # duplicate candidate numbers so rankings_out stays one-per-candidate;
        # without it a repeated candidate inflates the "Best of N" count shown to
        # the operator and skews all_pass/any_pass over a duplicated verdict set.
        num = _as_int(r.get("candidate"), 0)
        if not (1 <= num <= n) or num in by_num:
            continue
        provider, asset_id, _uri = candidates[num - 1]
        verdict = "pass" if r.get("verdict") == "pass" else "fail"
        score = max(0, min(100, _as_int(r.get("score"), 0)))
        entry = {
            "provider": provider,
            "asset_id": asset_id,
            "verdict": verdict,
            "score": score,
            "reason": str(r.get("reason", ""))[:400],
        }
        by_num[num] = entry
        rankings_out.append(entry)

    # Winner: trust the model's pick if valid, else fall back to the highest
    # score we parsed, else the first candidate.
    winner_num = _as_int(result.get("winner"), 0)
    if winner_num in by_num:
        winner = by_num[winner_num]
    elif rankings_out:
        winner = max(rankings_out, key=lambda e: e["score"])
    else:
        provider, asset_id, _uri = candidates[0]
        winner = {"provider": provider, "asset_id": asset_id, "verdict": "fail", "score": 0, "reason": ""}

    verdicts = [e["verdict"] for e in rankings_out] or ["fail"]
    return {
        "winner_provider": winner["provider"],
        "winner_asset_id": winner["asset_id"],
        "all_pass": all(v == "pass" for v in verdicts),
        "any_pass": any(v == "pass" for v in verdicts),
        "rankings": rankings_out,
    }


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

    response = await _gemini_generate_image(genai_client, [file_part, text_part])

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


async def _gemini_generate_image(genai_client: Any, parts: list[Any]) -> Any:
    """
    One Gemini image call, at GEMINI_IMAGE_SIZE, shared by enhance and tweak.

    Shared because the two were byte-identical calls and the tweak path also
    runs upscale_to_standard afterwards — so leaving it at the model default
    would have made tweaking a variant quietly re-blur it back to a 1 MP
    upscale, undoing the enhance's sharpness for anyone who used the button.

    FALLS BACK rather than failing. If the model rejects `image_config` — a
    preview model can drop a field between revisions — this retries once at the
    default resolution and logs a warning. Soft output is a complaint; every
    enhance job failing is an outage, and this repo produced exactly that once
    today by shipping a path with no degradation.
    """

    def _config(image_size: str) -> types.GenerateContentConfig:
        config = types.GenerateContentConfig(
            response_modalities=["IMAGE", "TEXT"],
            # Gemini 3.x thinking control. "High" gives the model the most
            # reasoning budget — useful for image edits where the standard
            # treatment + emphasis stack is long and the model benefits from
            # planning the edit before generating. Capital "High" matches the
            # official Python SDK enum exactly. gemini-3.1-flash-image-preview
            # only accepts "High" — both "Medium" and "Low" return 400
            # INVALID_ARGUMENT, so this is not really a perf knob on the current
            # model. Reassess when an image-gen model with a real thinking-level
            # spectrum ships to AI Studio.
            thinking_config=types.ThinkingConfig(thinking_level="High"),
        )
        if image_size:
            config.image_config = types.ImageConfig(image_size=image_size)
        return config

    contents = [types.Content(role="user", parts=parts)]
    try:
        return await genai_client.aio.models.generate_content(
            model=ENHANCE_MODEL_GEMINI,
            contents=contents,
            config=_config(GEMINI_IMAGE_SIZE),
        )
    except Exception as exc:
        if not GEMINI_IMAGE_SIZE:
            raise
        logger.warning(
            "gemini: image_size=%r rejected (%s) — retrying at the model "
            "default. Output will be ~1MP and upscaled ~2.3x to the 2800x2000 "
            "standard, so expect soft results until GEMINI_IMAGE_SIZE is fixed.",
            GEMINI_IMAGE_SIZE,
            exc,
        )
        return await genai_client.aio.models.generate_content(
            model=ENHANCE_MODEL_GEMINI, contents=contents, config=_config("")
        )


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

    response = await _gemini_generate_image(genai_client, [file_part, text_part])

    for part in response.candidates[0].content.parts:
        if part.inline_data and part.inline_data.data:
            return part.inline_data.data
    raise ValueError(_describe_gemini_no_image(response, "tweak"))


# Deterministic colour correction applied to Gemini output only.
#
# These are pyvips MULTIPLIER FACTORS, not Modify-tab slider units. That
# distinction is the whole bug this replaced: apply_adjustments() takes factors
# where 1.0 is neutral (the web app maps its -100..+100 sliders to factors
# client-side, so the backend only ever sees factors). Passing slider units
# meant brightness=0, and since the brightness/contrast step computes
# `scale = contrast * brightness`, the scale went to zero with a -892 offset --
# every Gemini output clamped to pure black.
#
# Equivalent slider positions, via the mapping documented on ModifyAdjustments:
#   saturation 1.12 == +12 slider  (-100..+100 -> 0.0..2.0)
#   contrast   1.04 == +8  slider  (-100..+100 -> 0.5..1.5)
#
# THESE VALUES ARE A STARTING POINT, NOT MEASURED. Chosen small so a wrong
# guess reads as flat rather than garish. Grade a batch side by side against
# OpenAI before nudging them.
GEMINI_SATURATION_FACTOR = 1.12
GEMINI_CONTRAST_FACTOR = 1.04

_LANDSCAPE_DIRECTIVE = (
    "\n\nORIENTATION (non-negotiable): the output image MUST be LANDSCAPE, "
    "wider than it is tall, at approximately a 7:5 width-to-height ratio. "
    "Do not return a portrait or square image. Do not add sky above or ground "
    "below to reach a taller frame. Keep the machine fully in frame across its "
    "full width."
)


def _is_portrait(image_bytes: bytes) -> bool:
    """
    True when the image is taller than it is wide.

    Deliberately a plain orientation test, not an aspect-band test: the export
    path already crops to exactly 7:5, so a slightly-off landscape frame is
    fine and does not justify a second paid model call. Only a portrait frame
    actually loses the ends of the machine.

    Unreadable bytes return False -- a decode problem is not an orientation
    problem, and the caller's normal error path should surface it.
    """
    # pyvips is imported lazily throughout this module rather than at module
    # scope; kept consistent here.
    import pyvips

    try:
        probe = pyvips.Image.new_from_buffer(image_bytes, "")
        return probe.height > probe.width
    except Exception:
        return False


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

    The source is capped at OPENAI_MAX_LONG_EDGE_PX before the base64.
    Unlike Gemini, which takes the GCS bytes at native resolution, this
    path pays for resolution twice - once uploading a multi-megabyte data
    URL, once in the model's own processing - and that is the documented
    cause of /v1/responses timeouts on this endpoint. Gemini is untouched.
    """
    image_bytes, ct = await _load_image_bytes(gcs_uri)
    image_bytes, ct = await asyncio.to_thread(
        downsize_for_vendor, image_bytes, OPENAI_MAX_LONG_EDGE_PX
    )
    image_b64 = base64.b64encode(image_bytes).decode()

    response = await openai_client.responses.create(
        model=ENHANCE_MODEL_OPENAI,
        # reasoning_effort="low" — image edits don't need deep planning;
        # the prompt itself carries the spec. medium (default) burns
        # ~25-40s of reasoning tokens on each call before the
        # image_generation tool ever dispatches. Dropping to "low"
        # keeps the tool-choice gate intact (gpt-5 still calls the
        # tool because tool_choice is forced) while reclaiming that
        # latency. Revisit if image quality regresses.
        reasoning={"effort": "low"},
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
        # size is the ONLY reliable lever for orientation here. Prompt wording
        # alone does not hold -- gpt-5 was handing back portrait crops of
        # landscape equipment, which then had to be centre-cropped to 7:5 on
        # export and lost the machine's ends. 1536x1024 is the tool's landscape
        # option and is 1.5:1, the closest available to our 1.4:1 house ratio,
        # so the export crop trims a little width rather than inventing height.
        tools=[{"type": "image_generation", "size": "1536x1024"}],
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
            # rendering_speed=TURBO — Ideogram exposes a three-tier
            # speed/quality knob (TURBO / DEFAULT / QUALITY). DEFAULT
            # is the implicit fallback; TURBO trades a small amount of
            # render fidelity for ~10s of wall-clock. The Ideogram
            # surface here (per-variant tweak + primary-enhance path
            # via the same helper) is text-led — operator typing a
            # short instruction — so the speed/quality trade lands on
            # the right side. Bump to "DEFAULT" if a particular
            # tweak ever needs more care; the param is per-call.
            data={
                "prompt":          instruction.strip(),
                "rendering_speed": "TURBO",
            },
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
    Mask-based inpaint via Ideogram /v1/ideogram-v3/inpaint, and the only
    mask-based vendor left after the BFL removal.

    MASK CONVENTION. The client (EraseDialog) always sends WHITE=erase,
    BLACK=preserve. Ideogram's API uses the INVERTED convention
    (BLACK = the region to edit), so we invert server-side and the dialog
    stays vendor-agnostic. Do not "simplify" by changing what the client
    draws — the inversion belongs here, at the vendor boundary.

    A PROMPT IS MANDATORY. Ideogram 422s without one, so the blank-hint
    fallback to "fill with plausible background" below is load-bearing
    error avoidance, not a nicety. Do not remove it.
    """
    settings = get_settings()
    if not settings.ideogram_api_key:
        raise RuntimeError(
            "Ideogram inpaint requested but IDEOGRAM_API_KEY is not set. "
            "Mount cleanshot-ideogram-key:latest via Cloud Run "
            "--set-secrets and re-deploy."
        )

    image_bytes, _ct = await _load_image_bytes(gcs_uri)

    # EXIF/dim normalisation, then mask inversion.
    #
    # autorot() first: a mask is drawn against the DISPLAYED image, so if
    # the source carries an EXIF rotation the raw pixels and the mask
    # disagree and the erase lands in the wrong place. The mask is then
    # resized with NEAREST-NEIGHBOUR specifically — any smoothing kernel
    # produces grey edge pixels, and a binary mask must stay binary.
    # (This rationale used to live in _erase_with_flux, now deleted.)
    #
    # Finally invert: WHITE=erase (our convention) becomes BLACK=edit
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


async def _enhance_with_grok(gcs_uri: str, prompt: str) -> bytes:
    """
    Call xAI Grok's /v1/images/edits endpoint and return raw PNG bytes.

    Request shape (per https://docs.x.ai/.../images/editing):
      Authorization: Bearer <XAI_API_KEY>
      Content-Type: application/json
      body: {
        model:  "grok-imagine-image-quality",
        prompt: <the full assembled prompt, uncapped>,
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
    # Logged rather than capped: if xAI ever does start rejecting long
    # prompts we want the length in the same log line as the 4xx.
    logger.info("grok: sending prompt of %d chars", len(prompt))

    body = {
        "model":  ENHANCE_MODEL_GROK,
        "prompt": prompt,
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
    # Set inside the try once the master prompt is resolved; pre-init here so
    # the except handler's usage-event insert can reference it even if an
    # exception fires before resolution.
    prompt_choice_suffix = ""

    try:
        # Custom prompt overrides — either from the Scan tab's "Regenerate"
        # auto-prompt or the Enhance tab's "Custom prompt (advanced)" textarea.
        # When set, the model receives this text verbatim and toggles are
        # ignored. Otherwise the toggle-derived prompt is used.
        #
        # Master-prompt selection (Enhance tab "Prompt:" dropdown): when
        # payload.prompt_choice resolves to an operator-authored prompt, that
        # prompt (placeholders filled) becomes the SPINE — the procedural
        # builders still append the paint-forks block, toggle add-ons, and
        # GUARDRAILS on top. "auto"/None → spine_override is None → builders
        # behave exactly as the legacy path.
        spine_override = resolve_master_prompt(
            payload.prompt_choice, payload.provider
        )
        if spine_override is not None:
            spine_override = render_master_prompt(
                spine_override,
                EQUIPMENT_DISPLAY.get(payload.equipment_type, "forklift"),
                EQUIPMENT_ANATOMY.get(
                    payload.equipment_type, EQUIPMENT_ANATOMY["forklift"]
                ),
            )

        # Prompt routing (2026-07-21 prompt-first redesign):
        #   • Scan-tab "Regenerate" sends a COMPLETE, self-contained prompt
        #     (buildRegenPrompt already composed the spine + issues + an
        #     equipment-correct GUARDRAILS block). prompt_is_complete=True →
        #     send it VERBATIM, exactly as before this reroute. Routing it
        #     through the builder would DOUBLE-append guardrails and attach a
        #     forklift-default guardrail to non-forklift regens.
        #   • Enhance-tab: the operator's prompt is the PRIMARY input and
        #     becomes the SPINE — the paint-forks block + toggle add-ons + hard
        #     guardrails append on top via the builder, so toggles AUGMENT the
        #     prompt instead of overriding it. Falls back to the master-prompt
        #     spine_override (dormant) or the procedural built-in when no prompt
        #     is supplied (a dormant safety net — the Enhance UI now requires one).
        if payload.custom_prompt and payload.prompt_is_complete:
            prompt = payload.custom_prompt
        else:
            effective_spine = payload.custom_prompt or spine_override
            if payload.provider == "grok":
                # Grok is an identity-preserving EDIT model and degrades on
                # the declarative multi-section prose below — see
                # _build_grok_prompt for the measured history.
                prompt = _build_grok_prompt(
                    payload.toggles,
                    equipment_type=payload.equipment_type,
                    spine_override=effective_spine,
                    fork_visibility=payload.fork_visibility,
                )
            else:
                prompt = _build_enhance_prompt(
                    payload.toggles,
                    equipment_type=payload.equipment_type,
                    spine_override=effective_spine,
                    fork_visibility=payload.fork_visibility,
                    framing_already_in_prompt=payload.fork_framing_in_prompt,
                )

        # Attribution suffix for the usage-event `model` label — lets the
        # admin dashboard tell prompt-tuning variants apart (e.g.
        # "gemini-3.1-flash-image-preview [generic:claude]"). Only added
        # when a master prompt was actually resolved (not auto/custom).
        prompt_choice_suffix = (
            f" [{payload.prompt_choice}]"
            if spine_override is not None and payload.prompt_choice
            else ""
        )

        # Dispatch to the requested provider. The Gemini semaphore is
        # still useful for cost control on the AI Studio key (the key has
        # a per-minute rate limit we don't want to blow through), but
        # the binding cap is AI Studio's quota, not Vertex's. OpenAI and
        # Grok have their own vendor-side rate limits and don't share
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
            # OpenAI still occasionally returns a PORTRAIT image even with the
            # landscape `size` set. Every downstream consumer assumes 7:5
            # landscape, and a portrait output survives export only by being
            # centre-cropped -- which cuts the forks off one end and the
            # counterweight off the other. So verify and re-run ONCE.
            #
            # Bounded to a single extra attempt on purpose: each one is a paid
            # gpt-5 call, and if the model is going to comply it complies on the
            # retry. A second portrait is passed through and dealt with at
            # export rather than billed again.
            if _is_portrait(output_bytes):
                logger.warning(
                    "job %s: OpenAI returned portrait output, re-running once",
                    payload.job_id,
                )
                async with pool.acquire() as conn:
                    await queries.bump_job_retry_count(conn, payload.job_id)
                await request.app.state.openai_image_rate_limiter.acquire()
                output_bytes = await _enhance_with_openai(
                    openai_client,
                    payload.input_gcs_uri,
                    prompt + _LANDSCAPE_DIRECTIVE,
                )
                if _is_portrait(output_bytes):
                    logger.warning(
                        "job %s: OpenAI returned portrait twice; passing through",
                        payload.job_id,
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
        elif payload.provider == "ideogram":
            provider_model = ENHANCE_MODEL_IDEOGRAM
            # Ideogram /v1/edit is sync (no async poll). Same helper as
            # the per-variant Edit tool — full enhance prompt slots into
            # the same `instruction` field. No published per-minute cap;
            # add a limiter if we observe 429s.
            output_bytes = await _tweak_with_ideogram(
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
            # Gemini comes back noticeably flatter than OpenAI on the same
            # source -- desaturated and low-contrast, which reads as "washed
            # out" sitting next to the OpenAI variant in the picker. Corrected
            # deterministically here rather than by asking the model to be more
            # saturated: prompt wording is not a reliable lever on this model
            # (see the warehouse-electric finding in CLAUDE.md), and a pyvips
            # pass costs nothing per image where another generation costs money.
            #
            # Values, and the reason they are FACTORS rather than slider units,
            # are documented on GEMINI_SATURATION_FACTOR above. Do not pass
            # slider units here -- brightness=0 zeroes the linear scale and
            # every output comes back pure black.
            if output_bytes:
                output_bytes = await asyncio.to_thread(
                    apply_adjustments,
                    output_bytes,
                    brightness=1.0,
                    contrast=GEMINI_CONTRAST_FACTOR,
                    saturation=GEMINI_SATURATION_FACTOR,
                    rotation_deg=0.0,
                    crop_aspect="free",
                    crop_zoom=1.0,
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
                    model=(provider_model or "unknown") + prompt_choice_suffix,
                    operation="enhance",
                    status="success",
                    latency_ms=int((_time.monotonic() - call_started_at) * 1000),
                    # All three enhance providers (Gemini image, OpenAI
                    # gpt-5, Grok) bill per image, not per
                    # token. estimate_cost_usd does the lookup; returns
                    # None for unknown models so we'd record NULL.
                    cost_estimate_usd=estimate_cost_usd(provider_model or ""),
                )
        except Exception:
            logger.exception("usage_event insert failed (enhance success path)")

        # Standardise to 2800x2000 — ONCE, here, before the bytes are stored.
        # Everything downstream (per-image adjustments, the disclaimer
        # composite, export, the copies written to the user's project) then
        # operates on an image that is already the final size and never
        # resamples it again.
        output_bytes = await asyncio.to_thread(upscale_to_standard, output_bytes)

        # TOTAL BACKGROUND REMOVAL. Runs AFTER standardisation and after the
        # vendor is finished, over the approved pixels — it only computes an
        # alpha channel and never redraws the machine. Order matters: matting
        # before the resize would mean resampling a hard alpha edge, which
        # fringes it.
        #
        # A failure here is NOT downgraded to "ship it opaque". The toggle
        # exists because the destination site needs transparency, so an opaque
        # file is a wrong answer wearing a success badge — better to fail the
        # job and let the operator see it.
        if payload.toggles.transparent_background:
            # Engine is per-batch so the operator can A/B the two matting
            # vendors on identical pixels. Everything downstream of the mask is
            # the same either way, which is what keeps the comparison honest.
            output_bytes = await remove_background(
                output_bytes,
                engine=("photoroom" if payload.toggles.cutout_photoroom else "fal"),
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

        # Auto-enqueue scan job per spec. We hand the scan worker BOTH the
        # enhanced output (to inspect) AND the original source photo
        # (payload.input_asset_id/input_gcs_uri) so it runs in DIFFERENTIAL
        # mode — comparing before/after to catch silent structural drift
        # (e.g. shrunk forks) and added damage that an isolated scan misses.
        # intended_edits (derived from the toggles the operator actually
        # asked for) whitelists deliberate changes so they aren't flagged.
        scan_payload = ScanTaskPayload(
            job_id=uuid.uuid4(),
            session_id=payload.session_id,
            input_asset_id=output_asset.id,
            input_gcs_uri=output_gcs_uri,
            original_asset_id=payload.input_asset_id,
            original_gcs_uri=payload.input_gcs_uri,
            equipment_type=payload.equipment_type,
            intended_edits=_describe_intended_edits(
                payload.toggles, payload.equipment_type, payload.custom_prompt
            ),
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
                # mid-stream). Record the same
                # estimated cost on failure so the admin's running
                # spend total stays accurate.
                await queries.insert_usage_event(
                    conn,
                    user_email=user_email,
                    session_id=payload.session_id,
                    job_id=payload.job_id,
                    provider=provider_name,
                    model=(provider_model or "unknown") + prompt_choice_suffix,
                    operation="enhance",
                    status="failed",
                    latency_ms=int((_time.monotonic() - call_started_at) * 1000),
                    cost_estimate_usd=estimate_cost_usd(provider_model or ""),
                    error_message=str(exc)[:500],
                )
            except Exception:
                logger.exception("usage_event insert failed (enhance failure path)")


def _describe_intended_edits(
    toggles: "EnhanceToggles",
    equipment_type: str,
    custom_prompt: str | None,
) -> list[str] | None:
    """
    Translate the enhance toggles into a human-readable whitelist for the
    differential scanner, so deliberate edits (repaint, de-brand, remove
    people) are treated as EXPECTED rather than flagged as unintended
    changes. Note we deliberately reinforce that a fork REPAINT must not
    change the fork's shape or length — that exact silent-drift case is the
    reason this whole differential pass exists. Returns None when nothing
    non-cosmetic was requested (the prompt then uses its default whitelist).

    The whitelist was CAPPED at 1500 characters between 2026-08-21 and
    2026-08-27, which silently stopped whitelisting anything an operator wrote
    past that point — their own requested edits came back reported as faults.
    The cap is gone; the full instruction is passed through. What actually
    protects against the failure below is the explicit two-case carve-out at
    the end of this function, not the length limit.

    The original 2026-08-21 note, kept because the failure it describes is the
    one to watch for if the carve-outs are ever weakened: the whitelist
    previously ended with
    "everything that instruction asks for ... do not flag it", which — combined
    with a blanket "a repaint is never a defect" in the scan rubric — meant a
    grey battery compartment coming back bright orange, and white non-marking
    tyres coming back black, both scanned clean. A requested repaint cannot
    authorise changing what colour the machine IS, so the two colour cases the
    rubric calls defects are carved out of every line below that could be read
    as permitting them.
    """
    edits: list[str] = []
    if toggles.new_paint_job:
        edits.append(
            "The machine may have a fresh coat of paint — a cleaner, glossier "
            "finish in the SAME colour it already was is expected; do not flag "
            "it. A body panel that came back a DIFFERENT colour is still a "
            "defect."
        )
    if toggles.paint_forks_red_yellow_tips and equipment_type != "scissor_lift":
        edits.append(
            "The forks may be repainted red with yellow tips. The COLOUR "
            "change is expected, but the forks' shape, length, and count "
            "must still match the original."
        )
    if toggles.remove_rust:
        edits.append("Surface rust may be cleaned off; rust simply being gone is expected.")
    if toggles.restore_decals:
        edits.append(
            "Faded decals/labels may be restored to be legible; still flag "
            "model or capacity NUMBERS that changed to different values."
        )
    if toggles.remove_people:
        edits.append("People may have been removed from the scene.")
    # Mirrors the forced-ON in the prompt builders: if the cutout made us ask
    # for signage removal, the scan has to be told it was intended, or the
    # whitelist and the prompt disagree.
    if toggles.remove_background_signage or toggles.transparent_background:
        edits.append("Background signage may have been removed.")
    if toggles.shine_tires:
        edits.append(
            "Tyre sidewalls may be glossed and darkened. This applies to tyres "
            "that were ALREADY dark. If the original tyres are white, cream, or "
            "light grey they are NON-MARKING tyres — a real spec — and turning "
            "them black is still a defect, not this edit."
        )
    if toggles.improve_lighting:
        edits.append("Lighting and exposure may be improved.")
    if toggles.remove_rental_branding:
        edits.append("Rental-fleet branding/stickers may have been removed.")
    if toggles.showroom_floor:
        edits.append("The floor may be cleaned to a uniform studio finish.")
    if toggles.transparent_background:
        # Without this the differential scan compares a photo in a yard against
        # a floating cut-out machine and reports the largest change it has ever
        # seen. Stated in the strongest terms available because it is the one
        # intended edit that alters literally every background pixel.
        edits.append(
            "THE ENTIRE BACKGROUND WAS DELIBERATELY REMOVED. This image is a "
            "cut-out on a transparent background, requested by the operator for "
            "a product page. The floor, walls, sky, other vehicles, and every "
            "other background element are GONE ON PURPOSE — that is not a "
            "defect and must not be reported as one, in any form (not as a "
            "removed part, not as a colour change, not as altered geometry). "
            "Judge ONLY the machine itself: its parts, text, proportions and "
            "colour. The machine's pixels were not regenerated for this step, "
            "so anything wrong with the machine was already wrong before the "
            "background was removed."
        )
    if custom_prompt and custom_prompt.strip():
        # Enhance went PROMPT-FIRST (2026-07-21): the operator types their
        # intent ("repaint it, forks red with yellow tips") instead of using
        # the toggles, so the toggle-derived lines above are often EMPTY and
        # this is the only real record of what was requested. The old vague
        # "operator supplied a custom instruction" line never named the actual
        # edits, so the differential scanner flagged requested repaints as
        # unintended colour changes. Pass the instruction through verbatim.
        edits.append(
            "The operator's own enhancement instruction for this image was: "
            f'"{custom_prompt.strip()}". '
            "Everything that instruction "
            "asks for was deliberately requested — treat it as EXPECTED and "
            "do not flag it. TWO EXCEPTIONS that this instruction cannot "
            "authorise no matter how it is worded: a body panel coming back in "
            "a DIFFERENT colour family than the original, and non-marking "
            "(white / cream / light grey) tyres turned black. Those stay "
            "defects — asking for a repaint is never asking to change what "
            "colour the machine is."
        )
    return edits or None


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

    Runs the enhance INLINE and returns 200 only once it is finished.

    This was a quick-acknowledge until 2026-08-27: add_task() + an
    immediate 200, with the vendor call, the 2800x2000 upscale and the
    matting pass all running in a FastAPI BackgroundTask AFTER the
    response was sent. On Cloud Run that is the THROTTLED window - the
    service deploys without --no-cpu-throttling, so CPU is allocated only
    during request processing and every CPU-bound step ran at a fraction
    of a core. Two Gemini images with the cutout toggle on took over five
    minutes. Inline, the same work holds a real vCPU, and it is billed
    only while it actually runs rather than 24/7.

    Retry semantics are UNCHANGED. _run_enhance catches every exception,
    marks the job row failed and returns normally, so Cloud Tasks still
    sees a 200 and still does not retry a job that failed on its own.

    The one NEW failure mode is a job outliving Cloud Run's 900s request
    timeout: the instance kills it mid-flight, Cloud Tasks sees a 5xx and
    retries (max_attempts=3), which bills the vendor call again. Typical
    jobs are 20-75s. The OpenAI path was the only one running near that
    ceiling, which is why its input is now downsized and its retry count
    cut - do not raise either back without re-checking this.

    `background_tasks` stays in the signature because the router passes it
    and the sibling handlers still use it.
    """
    await _run_enhance(request, payload)
    return {"status": "completed"}


# ─── Erase pipeline (Ideogram v3 inpaint) ───────────────────────────────────


async def _input_was_cutout(gcs_uri: str) -> bool:
    """
    Was the variant being edited a transparent-background cutout?

    Answered from the stored pixels, not from a request flag: the per-variant
    edit tools replace an asset in place, and a flag on the request could
    disagree with what is actually in the bucket. Costs one GCS read of an
    image the vendor helpers are about to download anyway, which is noise next
    to a 20-75s vendor call.

    A read failure returns False rather than raising. Getting this wrong in the
    False direction means one edit comes back opaque and the operator re-runs
    it; raising here would fail an edit that would otherwise have succeeded.
    """
    try:
        image_bytes, _ct = await _load_image_bytes(gcs_uri)
    except Exception:
        logger.warning("cutout: could not read %s to check for alpha", gcs_uri)
        return False
    return has_alpha(image_bytes)


async def _run_erase(
    request: Request,
    payload: EraseTaskPayload,
) -> None:
    """Background coroutine for mask-based Ideogram inpaint jobs."""
    pool = request.app.state.pool

    async with pool.acquire() as conn:
        user_email = await queries.get_session_user_email(conn, payload.session_id)
        await queries.update_job_status(conn, payload.job_id, JobStatusEnum.processing)

    import time as _time
    call_started_at = _time.monotonic()
    provider_label = "ideogram"
    provider_model = IDEOGRAM_MODEL_LABEL

    try:
        output_bytes = await _inpaint_with_ideogram(
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

        # Same standard as enhance. This path REPLACES the stored variant, so
        # without it one erase would drop the image back to vendor resolution
        # and break the "no code path produces another dimension" guarantee.
        output_bytes = await asyncio.to_thread(upscale_to_standard, output_bytes)

        # A cutout that gets erased must come back a cutout. The vendor was
        # handed an RGBA PNG and returns opaque pixels, so without re-matting
        # the operator would get a BLACK background — the most visible possible
        # failure on a product cutout. Detected from the input rather than
        # threaded through the request schema, because a flag on EraseRequest
        # could disagree with the actual stored asset; the pixels cannot.
        if await _input_was_cutout(payload.input_gcs_uri):
            # DEFAULT ENGINE ON PURPOSE, not an oversight. The erase/tweak
            # payloads do not carry the enhance toggles, so this path cannot
            # know which vendor produced the original cutout. Pinning it to the
            # default keeps a re-matte consistent and predictable; threading
            # the toggle through two more schemas to make an A/B marginally
            # purer is not worth it. Worth knowing while comparing: tweaking a
            # Photoroom cutout re-mattes it with fal.
            output_bytes = await remove_background(output_bytes, engine="fal")

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
    pattern: returns HTTP 200 immediately, the vendor call happens in a
    background task. NOTE: unlike the old BFL path this is not a poll —
    Ideogram inpaint is synchronous, so "background" here means only the
    Cloud Tasks hop. Unlike handle_enhance_task, which now runs inline.
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

        # Same standard as enhance — see the note on the erase path.
        output_bytes = await asyncio.to_thread(upscale_to_standard, output_bytes)

        # Re-matte if the variant being tweaked was a cutout — same reason as
        # the erase path: otherwise the vendor's opaque result reads as a black
        # background.
        if await _input_was_cutout(payload.input_gcs_uri):
            # DEFAULT ENGINE ON PURPOSE, not an oversight. The erase/tweak
            # payloads do not carry the enhance toggles, so this path cannot
            # know which vendor produced the original cutout. Pinning it to the
            # default keeps a re-matte consistent and predictable; threading
            # the toggle through two more schemas to make an A/B marginally
            # purer is not worth it. Worth knowing while comparing: tweaking a
            # Photoroom cutout re-mattes it with fal.
            output_bytes = await remove_background(output_bytes, engine="fal")

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
