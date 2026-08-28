"""
Operator-authored master enhance prompts — the prompt-tuning library.

This is the LIVE source for the Enhance tab's per-model "Prompt:" dropdown.
(The older `prompts.py` in this package is unused scaffolding; do not confuse
the two — this module is what `_run_enhance` consults.)

The operator hand-authored a library of master respray prompts, each written by
a different LLM (Claude, Gemini, OpenAI, Grok), in three flavours:

  • GENERIC — one-size-fits-all, used for any generator. 4 prompts (one per
    author).
  • TAILORED — bespoke wording for the three edit-style generators that need it
    (Kontext, Ideogram, Reve), one per author = 12 prompts.
  • NAMESAKE — a tailored prompt for each generator that shares a name with an
    author (Gemini→Gemini, OpenAI→OpenAI, Grok→Grok) = 3 prompts. There is no
    Claude→Claude because Claude is not an image generator.

Total = 19 prompts.

The Enhance tab exposes these via a per-card prompt-choice key:
  • "auto"            → None here → caller uses the procedural builder
  • "generic:<author>" → GENERIC_PROMPTS[author]
  • "tailored:<author>" → TAILORED_PROMPTS[(generator, author)]

When a master prompt is chosen, it REPLACES the procedural "spine" only — the
worker still appends the toggle add-ons (paint-forks, rental-scrub, showroom
floor, …) and the hard GUARDRAILS block on top (see `spine_override` in
enhance_worker.py). So toggle checkboxes keep working on every prompt choice.

Placeholders: every prompt is stored with `{equipment_type}` (filled from the
equipment radio's display name, e.g. "forklift" / "scissor lift") and, where the
author wrote an anatomy note, `{anatomy}` (filled from EQUIPMENT_ANATOMY). The
operator's source prompts used a few placeholder spellings + some hardcoded
"forklift"; those are normalized here so the equipment radio drives all 7
equipment types.

DRIFT-WARNING: the per-generator author list (TAILORED_AUTHORS) is mirrored on
the frontend as TAILORED_AUTHORS_BY_GENERATOR in apps/web/lib/types.ts to build
the dropdown option lists. Keep them in sync.
"""

from __future__ import annotations

from typing import Literal

Author = Literal["claude", "gemini", "openai", "grok"]
Generator = Literal["gemini", "openai", "grok", "ideogram"]


# ════════════════════════════════════════════════════════════════════════════
# GENERIC — one-size-fits-all (used for any generator in "generic:<author>")
# ════════════════════════════════════════════════════════════════════════════

GROK_GENERIC = """\
A photorealistic image of a heavily used {equipment_type} that has just received a quick, inexpensive shop-grade respray.

This is a real commercial shop repaint — fast, cheap, and done to make the unit look listing-ready. It is explicitly NOT a professional restoration and NOT a factory-fresh finish. The goal is "cheap but clean."

WHAT THE NEW PAINT COVERS:
- All surface paint chips, scuffs, scratches, and faded areas
- Light surface rust and oxidation
- Dirt, grime, dust, and surface stains (cleaned before painting)
- Dull, weathered original paint — now restored to saturated versions of the colors it already is

WHAT THE NEW PAINT DOES NOT COVER (these must remain clearly visible):
- Dents, panel deformations, and bent hardware
- Deep gouges that go into the metal
- Missing parts, broken or cracked components
- Severe rust-through holes and large rust pitting craters
- Mismatched or replaced aftermarket panels (keep them visually distinct)

PAINT JOB QUALITY:
Apply a realistic shop spray gun respray in the exact colors the unit already wears. Even coverage on most surfaces with slight orange-peel texture visible on close inspection, minor overspray in tight corners, and subtle edge buildup. It should look like a competent but budget-conscious shop job, not premium bodywork.

Preserve and mask off all OEM make, model, capacity, and safety decals in their exact original positions with realistic existing wear.

TIRES:
Keep the exact same tires from the source image. Maintain all tread wear, cuts, gouges, and aging cracks on the tread surface. However, generously apply glossy tire shine ONLY to the sidewalls, making them deep black, wet-look, and highly reflective. Tread must remain dry, dusty, and matte.

SCENE & COMPOSITION:
Maintain the exact same camera angle, perspective, framing, lighting direction, and background environment as the source image. Do not change, crop, rotate, or replace the background under any circumstances.

STRICT GUARDRAILS:
- Do not add any new accessories, lights, beacons, mirrors, antennas, or attachments
- Do not introduce any new damage, dents, or wear not present in the source
- Do not make the {equipment_type} look brand new or factory fresh
- Do not leave it completely unchanged (the respray must be clearly visible)
- Preserve all original equipment-specific details, proportions, and panel layouts

The ideal result is a clearly used {equipment_type} that has obviously received a fresh but inexpensive shop respray — improved appearance while still looking like a working, previously abused machine with glossy tire sidewalls.\
"""

OPENAI_GENERIC = """\
Create a photorealistic image of a used {equipment_type} that has received a quick, inexpensive shop-grade respray. The goal is "cheap but clean" — the unit must look listing-ready, not restored or factory-fresh.

WHAT THE PAINT COVERS:
- Surface chips, scuffs, scratches, and faded paint
- Light surface rust and oxidation
- Dirt, grime, dust, and superficial stains (pre-cleaned)
- Faded original colors restored to saturated factory hues

WHAT MUST REMAIN VISIBLE:
- Dents, panel deformations, and bent hardware
- Deep gouges through metal
- Missing parts, broken or cracked components
- Severe rust-through or large pitting
- Replaced or mismatched panels

PAINT CHARACTER:
- Apply a realistic shop spray gun respray in original panel colors
- Slight orange-peel texture, minor overspray in tight corners
- Maintain exact OEM decal placement and realistic wear

TIRES:
- Preserve all tread wear, cuts, gouges, and cracks
- Apply glossy tire shine only to sidewalls (tread stays matte/dry)
- Non-marking tires remain light gray; no black or gloss

SCENE & COMPOSITION:
- Preserve camera angle, perspective, lighting, and background
- Do NOT crop, rotate, or isolate the equipment
- Do not introduce new accessories, damage, or hardware

RESULT:
- Clearly used but freshly resprayed
- Tires treated appropriately
- Only pre-existing structural damage and deep rust remain\
"""

GEMINI_GENERIC = """\
System Role & Objective:
You are an expert commercial photo retoucher specializing in industrial heavy equipment. Perform a photorealistic image-to-image style transfer on the provided source image of a used {equipment_type}. The goal is to apply a "cheap-but-clean" shop-grade spray paint job for a retail listing. This is a quick cosmetic refresh, absolutely not a factory restoration.

Color & Paint Application (The Cosmetic Refresh):

Transform all faded, dull painted surfaces into highly saturated, freshly sprayed versions of the colors they already are.

Cover all superficial wear: completely mask surface scratches, light oxidation, paint chips, and general scuffs with the fresh paint layer.

Render the paint texture as a budget shop job: it should have a slight, realistic orange-peel texture upon close inspection, with minor overspray in tight corners and crevices.

The overall aesthetic must remain high-resolution, sharp, and brilliantly lit, typical of a modern 4K commercial equipment listing.

Structural Preservation (The Hard Reality):

Do not "heal" the metal. Visually preserve and maintain all physical deformations exactly as they appear in the source image.

Keep all deep gouges that penetrate the metal, bent hardware, crushed panels, and cracked components clearly visible, simply painting over the deformed shapes.

Retain all severe rust-through holes and large, eaten-away rust craters.

Keep any mismatched, aftermarket, or clearly replaced body panels distinct and visible.

Ensure all OEM decals (Make, Model, Capacity) are masked off, preserving their exact original placement, precise spelling, and existing wear.

Mechanical & Scene Accuracy:

Strictly maintain the original mechanical anatomy. {anatomy}

Preserve the exact mast, carriage, and fork structures without adding unrequested beacons, lamps, or attachments.

Keep the identical camera angle, framing, perspective, and background environment. The background must remain 100% untouched and integrated.

Tire Treatment:

Maintain the exact physical condition of the tires, keeping every slice, chunk, gouge, and age crack on the tread surface.

For standard black tires: The treads must look dry, dusty, and matte. Contrast this by rendering the sidewalls with a thick, glossy, wet-look tire shine that reflects the surrounding light.

For non-marking tires: Render them as a matte, light primer gray with zero glossy tire shine applied.\
"""

CLAUDE_GENERIC = """\
Edit the source image of a used {equipment_type}. Make ONE change only: apply a quick, cheap-but-clean shop-grade respray that makes the unit listing-ready. This is a budget cosmetic refresh for a sales listing — NOT a restoration and NOT a factory-fresh rebuild. Keep the same machine, the same scene, and the same wear; only the paint and the tire sidewalls change.

REPAINT — the fresh coat covers these:
- Repaint every painted body panel in the EXACT color it already is. Keep the existing panel-to-color mapping. Do not recolor, unify, or swap any colors.
- The fresh paint hides surface chips, scuffs, scratches, faded/dull patches, light surface rust and oxidation, plus dirt, grime, and stains (cleaned before painting). Faded paint returns to a saturated version of its own shade.
- It must read as a real shop spray-gun job, not premium bodywork: even coverage with faint orange-peel texture up close and minor overspray in tight corners.

KEEP CLEARLY VISIBLE UNDER THE NEW PAINT — do NOT repair these:
- Dents, bent hardware, and panel deformation — paint over the deformed shape, do not straighten it.
- Deep gouges through the metal, cracked or broken components, missing parts.
- Severe rust-through holes and large rust pitting craters.
- Replaced, mismatched, or aftermarket panels — leave them distinct, do not blend them in.

DECALS: Keep all OEM make / model / capacity / safety decals in their exact original position and spelling, with their existing wear.

TIRES: Keep the same tires and all tread wear, cuts, gouges, and age cracks; the tread stays dry, dusty, and matte. Apply heavy glossy wet-look tire shine to the SIDEWALLS ONLY. Exception: light-gray non-marking tires stay matte gray with no gloss and are never painted black.

PRESERVE EXACTLY (must not change): camera angle, perspective, framing, lighting direction, background and environment, and the unit's mechanical layout — {anatomy}. Do not crop, rotate, level, zoom, re-pose, or place the unit on a white / studio / gradient backdrop. Add nothing that is not already present (no lamps, beacons, mirrors, antennas, or attachments). Introduce no new damage.

TARGET RESULT: an obviously used, previously hard-worked {equipment_type} that has clearly just been freshly resprayed in a cheap-but-clean shop job, with glossy sidewalls — improved but honest, with only structural damage and severe rust still showing.\
"""


# ════════════════════════════════════════════════════════════════════════════
# TAILORED — Ideogram
# ════════════════════════════════════════════════════════════════════════════

IDEOGRAM_GROK = """\
Photorealistic depiction of a heavily used {equipment_type} that has just received a quick, inexpensive shop-grade respray. This is a real commercial shop repaint — fast, cheap, and done to make the unit listing-ready. Cheap but clean appearance. Not a full restoration, not factory fresh.

The fresh paint covers all surface chips, scuffs, scratches, faded areas, light surface rust, dirt, grime, and dull weathered paint, restoring it to saturated versions of the colors it already is.

The fresh paint does NOT cover or hide: dents, panel deformations, bent hardware, deep metal gouges, missing or broken parts, cracked components, severe rust-through holes, large rust pitting, or mismatched aftermarket panels — these must remain clearly visible and unchanged.

Paint application: realistic shop spray gun respray using the exact colors the unit already wears on all body panels. Even coverage with slight orange-peel texture, minor overspray in tight corners. Competent but budget-level finish.

All OEM make, model, capacity, and safety decals are masked off and preserved exactly as in the source, with realistic wear.

TIRES: Keep the exact same tires as the source image. Preserve all tread wear, cuts, gouges, and aging cracks. Tread must stay dry, dusty, and matte.
- Standard black tires: apply glossy tire shine only to the sidewalls (deep black, wet-look, highly reflective).
- Non-marking tires (light gray): paint them light primer gray. Do NOT paint them black and do NOT add glossy shine.

Maintain the exact same camera angle, perspective, framing, lighting, and unchanged background environment from the source image. No cropping, rotating, or background replacement.

Strict rules: Do not add any new lights, beacons, mirrors, antennas, or attachments. Do not introduce new damage or wear. Do not make it look brand new. Do not leave it unchanged — the fresh respray must be clearly visible while still showing real-world use.

Result: A clearly used {equipment_type} with an obvious fresh but cheap shop respray and correctly treated tires.\
"""

IDEOGRAM_OPENAI = """\
Photorealistic used {equipment_type} after a quick, inexpensive shop respray. Not factory-fresh, not restored, cheap-but-clean.

Paint covers: surface scratches, scuffs, light rust, dirt, faded paint.
Paint does NOT cover: dents, deep gouges, missing or broken parts, severe rust, mismatched panels.

Decals: OEM make, model, and capacity preserved in exact positions with realistic wear.

Tires: keep original tread wear and cracks; sidewalls glossy (wet-look), tread matte/dry. Non-marking tires stay light gray.

Scene: maintain original camera angle, perspective, lighting, and background. Do NOT crop, rotate, or isolate. No new accessories or added damage.

Result: clearly used, visibly resprayed, only pre-existing structural imperfections remain, tires correctly treated.\
"""

IDEOGRAM_GEMINI = """\
Prompt Style:
A sharp, 4K high-resolution photorealistic commercial product listing photograph.

Core Subject & Paint State:
An authentic, heavily used {equipment_type} that has just received a quick, inexpensive commercial shop-grade spray paint respray. The paint is highly saturated, in the {equipment_type}'s precise colors the unit already wears. The overall appearance is "cheap but clean," looking listing-ready. The new paint covers all superficial scratches, scuffs, paint chips, and general surface oxidation. Upon close inspection, the paint surface exhibits a realistic, subtle orange-peel texture and minor, accidental overspray mist in tight crevices and corners.

Preserved Use & Damage Details (Crucial):
The fresh paint layer visibly covers and follows the exact contours of pre-existing, non-restored physical damage. The painted metal panels clearly display all severe visual imperfections exactly as they are in the source image, including: specific dents, panel deformations, bent metal hardware, cracked components, and deep gouges that bite through the metal. Large, eaten-away rust-through holes and deep rust pitting craters remain physically distinct and visible, simply covered by the new paint layer.

Typography & Decals:
All original OEM decals, logos, model numbers, and capacity charts are perfectly preserved in their exact original spots, demonstrating clean, readable lettering. These decals are masked off, showing only realistic fading and edge wear, contrasting with the fresh paint around them.

Tires & Background:
The original tires are retained, showcasing the full extent of existing cuts, tread chunks missing, and rubber age-cracking on the tread surface.

For Black Tires: The treads are dry, dusty matte brown. The sidewalls are treated with a heavy application of ultra-glossy, wet-look tire shine, appearing deep black and highly reflective.

For Non-Marking Tires: The tires are rendered entirely in matte, light primer gray with zero glossy elements.
The background environment remains identical and completely untouched from the source image.

Lighting:
Modern, sharp, brilliant commercial studio lighting that highlights both the fresh glossy shine and the texture of the preserved structural damage.\
"""

IDEOGRAM_CLAUDE = """\
Photorealistic product-listing photo of a used {equipment_type} that has just received a cheap-but-clean shop-grade respray. Each painted body panel wears a fresh coat in its own existing color, keeping the same panel-to-color layout, colors saturated and revived. It is a budget spray-gun job: even coverage with a faint orange-peel texture up close and slight overspray in tight corners. The fresh paint has hidden the old surface chips, scuffs, scratches, faded patches, light surface rust, dirt, and grime.

Beneath the paint, real wear still shows through: dents and bent hardware painted over but still deformed, deep gouges through the metal, cracked or missing parts, severe rust-through holes, and large rust pitting craters. Mismatched aftermarket or replaced panels stay visibly distinct. All OEM make, model, and capacity decals stay crisp in their exact original positions with light existing wear. {anatomy}

The tires are the original tires, tread dry, dusty, and matte with all its cuts, gouges, and age cracks intact, while the sidewalls carry a heavy glossy wet-look tire shine, deep black and reflective. (Light-gray non-marking tires stay matte gray.)

Same camera angle, perspective, framing, lighting, background, and mechanical layout as the original machine. An honestly used, hard-worked unit, freshly and cheaply resprayed for sale with glossy sidewalls, clearly improved yet clearly still used.\
"""


# ════════════════════════════════════════════════════════════════════════════
# NAMESAKE — generator authored by its own namesake LLM
# ════════════════════════════════════════════════════════════════════════════

GROK_TO_GROK = """\
Edit this image of a heavily used {equipment_type} to show it after receiving a quick, inexpensive shop-grade respray.

This is a realistic commercial shop repaint — fast, cheap, and done to make the unit listing-ready. Aim for a "cheap but clean" look. It is NOT a full restoration and NOT factory fresh.

WHAT THE NEW PAINT COVERS:
- All surface chips, scuffs, scratches, and faded areas
- Light surface rust and oxidation
- Dirt, grime, dust, and surface stains
- Dull, weathered paint — restore to saturated versions of the colors it already is

WHAT THE NEW PAINT MUST NOT COVER (keep these clearly visible):
- Dents, panel deformations, and bent hardware
- Deep gouges into the metal
- Missing parts, broken or cracked components
- Severe rust-through holes and large rust pitting
- Mismatched or aftermarket panels (keep them visually distinct)

PAINT APPLICATION:
Apply a realistic shop spray gun respray in the exact colors the unit already wears. Use even coverage with slight orange-peel texture on close inspection, minor overspray in tight corners, and subtle edge buildup. It should look like competent budget-level body shop work.

Mask off and preserve all OEM make, model, capacity, and safety decals in their exact original positions with realistic wear.

TIRES:
Keep the exact same tires from the source image, including all tread wear, cuts, gouges, and aging cracks. Tread must remain dry, dusty, and matte.
- Standard black tires: Apply generous glossy tire shine ONLY to the sidewalls (deep black, wet-look, highly reflective).
- Non-marking tires (light gray): Paint them light primer gray. Do NOT paint them black and do NOT add glossy shine.

SCENE & COMPOSITION:
Keep the exact same camera angle, perspective, framing, lighting, and background as the source image. Do not crop, rotate, change, or replace the background.

STRICT RULES:
- Do not add any new lights, beacons, mirrors, antennas, attachments, or hardware
- Do not introduce any new damage or wear
- Do not make the {equipment_type} look brand new
- Do not leave the {equipment_type} unchanged — the fresh respray must be clearly visible

Final result: A clearly used {equipment_type} with an obvious fresh but cheap shop respray and correctly treated tires, while preserving all original wear and damage.\
"""

OPENAI_TO_OPENAI = """\
Photorealistic image of a used {equipment_type} after a quick, inexpensive shop-grade respray. The goal is "cheap but clean" — listing-ready, not restored or factory-fresh.

Paint covers:
- Surface chips, scuffs, scratches, faded paint
- Light surface rust and oxidation
- Dirt, grime, dust, superficial stains (pre-cleaned)
- Faded original colors restored to saturated factory hues

Must remain visible:
- Dents, panel deformations, bent hardware
- Deep gouges through metal
- Missing, broken, or cracked components
- Severe rust-through or large pitting
- Replaced or mismatched panels

Paint character:
- Realistic shop spray gun application in original panel colors
- Slight orange-peel texture
- Minor overspray in tight corners
- Preserve OEM decals exactly with realistic wear

Tires:
- Keep original tread wear, cuts, gouges, cracks
- Apply glossy tire shine only to sidewalls; tread remains matte/dry
- Non-marking tires stay light gray; no black or gloss

Scene & composition:
- Preserve original camera angle, perspective, lighting, and background
- Do NOT crop, rotate, isolate, or add accessories or new damage

Result:
- Clearly used but freshly resprayed
- Tires treated correctly
- Only pre-existing structural damage and rust remain\
"""

GEMINI_TO_GEMINI = """\
[SYSTEM ROLE & OBJECTIVE]
Execute a high-fidelity, photorealistic image-to-image style transfer on the provided source image of a used {equipment_type}. Your primary objective is to render a "cheap-but-clean" shop-grade respray that meets modern Discount Forklift retail listing standards. This is a fast cosmetic refresh—do not generate a factory restoration. Output must be a brilliant 4K commercial-grade image with a clean, industrial aesthetic.

[COLOR & PAINT APPLICATION]

Saturate all dull and faded painted surfaces to match the colors they already are.

Completely mask superficial wear (surface scratches, light oxidation, paint chips) under the new paint layer.

Generate a budget shop job texture: include a slight, realistic orange-peel effect upon close inspection, and minor overspray in tight crevices.

[STRUCTURAL PRESERVATION]

Maintain all physical damage and deformations exactly as they appear. Do not "heal" or smooth the metal.

Deep gouges, bent hardware, crushed panels, and cracked components must remain distinctly visible beneath the new paint layer.

Retain all severe rust-through holes and large rust pitting craters.

Mask off all OEM decals (Make, Model, Capacity). Preserve their exact original spelling, placement, and pre-existing wear.

[MECHANICAL & SCENE ACCURACY]

Strictly lock the original mechanical anatomy. {anatomy}

Preserve the exact mast specifications (including Full Free Lift mechanisms), carriage, and forks without adding unrequested beacons, lamps, or attachments.

Lock the identical camera angle, framing, perspective, and background environment. The background must remain 100% untouched.

[TIRE TREATMENT]

Lock the exact physical condition of the tires, preserving every slice, chunk, gouge, and age crack on the tread surface.

Standard black tires: Render dry, dusty, matte treads. Apply a thick, glossy, wet-look tire shine strictly to the sidewalls for high contrast.

Non-marking tires: Render as a flat, matte, light primer gray with absolutely zero glossy tire shine.\
"""


# ════════════════════════════════════════════════════════════════════════════
# Registries + resolver
# ════════════════════════════════════════════════════════════════════════════

GENERIC_PROMPTS: dict[str, str] = {
    "claude": CLAUDE_GENERIC,
    "gemini": GEMINI_GENERIC,
    "openai": OPENAI_GENERIC,
    "grok": GROK_GENERIC,
}

# Sparse: exactly the 4 edit-tailored cells (Ideogram, the only surviving
# edit-style generator) + the 3 namesake cells authored.
TAILORED_PROMPTS: dict[tuple[str, str], str] = {
    ("ideogram", "claude"): IDEOGRAM_CLAUDE,
    ("ideogram", "gemini"): IDEOGRAM_GEMINI,
    ("ideogram", "openai"): IDEOGRAM_OPENAI,
    ("ideogram", "grok"): IDEOGRAM_GROK,
    # Namesakes — the generator authored by its own namesake LLM.
    ("gemini", "gemini"): GEMINI_TO_GEMINI,
    ("openai", "openai"): OPENAI_TO_OPENAI,
    ("grok", "grok"): GROK_TO_GROK,
}

# Which authors are offered under "Tailored for <generator>" in the UI. Mirrored
# on the frontend as TAILORED_AUTHORS_BY_GENERATOR in
# apps/web/lib/types-enhance.ts (NOT types.ts — that pointer was always wrong).
TAILORED_AUTHORS: dict[str, list[str]] = {
    "ideogram": ["claude", "gemini", "openai", "grok"],
    "gemini": ["gemini"],
    "openai": ["openai"],
    "grok": ["grok"],
}


def resolve_master_prompt(choice_key: str | None, generator: str) -> str | None:
    """
    Resolve a per-card prompt-choice key to a raw (un-rendered) master prompt.

    choice_key forms:
      • None / "auto"        → return None  (caller uses the procedural builder)
      • "generic:<author>"   → GENERIC_PROMPTS[author]
      • "tailored:<author>"  → TAILORED_PROMPTS[(generator, author)]

    Any unknown key, missing author, or missing (generator, author) cell returns
    None so the caller falls back to the procedural builder rather than erroring.
    The returned string still contains {equipment_type} / {anatomy} placeholders;
    call render_master_prompt() to fill them.
    """
    if not choice_key or choice_key == "auto":
        return None

    kind, _, author = choice_key.partition(":")
    if not author:
        return None

    if kind == "generic":
        return GENERIC_PROMPTS.get(author)
    if kind == "tailored":
        return TAILORED_PROMPTS.get((generator, author))
    return None


def render_master_prompt(
    template: str,
    equipment_display: str,
    equipment_anatomy: str,
) -> str:
    """
    Fill the {equipment_type} / {anatomy} placeholders in a master prompt.

    `equipment_display` is the human-readable equipment name (e.g. "forklift",
    "scissor lift") — pass EQUIPMENT_DISPLAY[equipment_type]. `equipment_anatomy`
    is the per-type anatomy-preservation sentence — pass
    EQUIPMENT_ANATOMY[equipment_type]. Both dicts already live in
    enhance_worker.py; the worker passes the looked-up values in so this module
    has no dependency back on the worker.

    Tolerant of the two placeholder spellings the operator's source prompts used
    ("{equipment_type}" and "{equipment type}").
    """
    return (
        template.replace("{equipment_type}", equipment_display)
        .replace("{equipment type}", equipment_display)
        .replace("{anatomy}", equipment_anatomy)
    )
