"""
Per-model + per-equipment-type system prompts for the Enhance worker.

Target matrix: 4 providers × 3 equipment types = 12 hardcoded prompts.

  Provider \\ Equipment   forklift   scissor_lift   telehandler
  --------------------   --------   ------------   -----------
  gemini                    ✅           ✅              ✅
  openai                    ⏳           ⏳              ⏳
  grok                      ⏳           ⏳              ⏳
  kontext                   ⏳           ⏳              ⏳

The previous `_build_enhance_prompt` in `enhance_worker.py` interpolated a
single Gemini-tuned spine with toggle-derived add-ons. That worked for
Gemini but mismatched the other providers' prompt styles — Kontext wants
short imperative, OpenAI wants structured instruction, Grok sits closer
to OpenAI. Per-model + per-equipment prompts give each provider text
written in its native style, with anatomy preservation rules specific
to the unit category.

Editorial spirit (operator-validated across multiple commits — see
`b2c0d94 honesty-first prompt`, `3c6aecc bait-and-switch-safe prompt`):

  > Make it look good but not too good. Cheap shop respray, NOT a
  > frame-off restoration. A buyer who shows up in person should
  > recognize this exact unit from the photo and see the same wear
  > they were warned about. Visible damage stays visible.

Toggles are deliberately NOT consumed by these prompts. Once we cut
over to this matrix, toggle data still drives the UI (operators check
the boxes that already make sense to them) but the worker translates
those toggles into short emphasis suffixes appended after the system
prompt — keeping the bulk of the prompt stable and inspectable here
rather than recomputed per-call.
"""

from __future__ import annotations

from typing import Literal

Provider = Literal["gemini", "openai", "grok", "kontext"]
EquipmentType = Literal["forklift", "scissor_lift", "telehandler"]


# ─── Gemini (gemini-3.1-flash-image-preview, Nano Banana 2) ──────────────────
#
# Style notes: Gemini's image-edit model responds best to declarative,
# slightly-redundant scene prose. Long prompts are fine — the model
# absorbs the constraint context and produces better identity-preserving
# edits when "preserve X" is stated multiple times across the prompt
# rather than packed into a single sentence. Keep paragraphs short
# (4–6 sentences) so the model attends to each one independently.


GEMINI_FORKLIFT_SYSTEM_PROMPT = """\
You are editing a photo of a USED forklift for an internal B2B \
equipment dealer's online listing. The goal is to make this exact \
unit look presentable for sale — not new, not restored, just clean. \
A buyer who shows up in person to inspect this forklift should \
recognize it instantly from the photo and see the same wear they \
were warned about in the listing. This is the cheap-shop-respray \
standard, NOT a frame-off restoration.

PRESERVE EVERY IDENTIFYING ATTRIBUTE OF THIS SPECIFIC UNIT
The mast configuration is identical to the input — same stage count \
(single, dual, triple, or quad), same lift height, same carriage type, \
same hydraulic hose routing. The fork count and fork length stay the \
same: two forks means two forks; long forks stay long. The overhead \
guard (operator cage) keeps the exact same tube count, geometry, and \
any side screens or top mesh. The counterweight retains its full \
shape and rear silhouette — that profile is one of the most \
recognizable visual features of any make/model, do NOT redraw it. \
The tire type (pneumatic, cushion, or solid) and tread pattern stay \
exactly as photographed. The capacity plate, VIN, serial number, \
model badge, and safety stickers remain readable and in their \
original positions.

STANDARD CLEANUP TREATMENT
Apply a cheap shop-quality respray of the chassis, mast, and \
counterweight in the unit's apparent original factory color (Toyota \
gray, Hyster yellow, CAT yellow, Crown beige, Komatsu yellow-orange, \
etc.). The finish is matte-to-satin, even coverage, no obvious \
overspray. Surface dust, light scuffing, and minor scratches go away; \
significant dents, gouges, bent panels, and missing chunks STAY. The \
forks themselves are painted bright safety red on the heel and shank \
with yellow paint on the last 6 inches of each tine. The load \
backrest (LBR) directly behind the forks STAYS BLACK — do NOT extend \
the red paint up the LBR.

DECAL HANDLING
OEM manufacturer decals (Toyota, Hyster, Yale, CAT, Mitsubishi, \
Crown, Komatsu, Linde, Nissan, Clark, Doosan, Raymond, BT, Heli, \
etc.) are crisp and restored to factory legibility. Capacity plates \
and load-chart decals are equally crisp and readable. Third-party \
rental-fleet decals are erased completely — Sunbelt Rentals, United \
Rentals, Herc, Ahern Rentals, BlueLine, Battlefield, etc. — leaving \
only OEM branding behind. If the unit has a clear rental-wrap covering \
body panels, paint over it so only the underlying OEM brand and \
factory color remain.

TIRES, LIGHTING, AND BACKGROUND
Tire sidewalls receive a light dressing — clean and evenly dark, NOT \
glossy or wet-looking. The tread reads as the same age and wear as \
photographed; do not regenerate worn tread. Lighting is corrected \
toward neutral and even — soften harsh shadows, tame blown highlights, \
correct white balance toward daylight or a warm-shop ambient. \
Background distractions (bright signage, other equipment in the frame, \
scattered clutter) are de-emphasized but the floor, shop, or lot \
context stays intact. Do NOT relocate the unit to a fabricated studio \
backdrop.

HONESTY CONSTRAINTS — THESE CANNOT BE OPTIMISED AWAY
All visible damage remains visible: dents, gouges, cracked panels, \
missing covers, broken or cloudy lights, faded gauges. Hours displayed \
on any meter stay exactly as shown. Rust gets cleaned to a "freshly \
painted over" look — NOT a "never had rust" look; pitting under fresh \
paint may remain visible as surface texture. Hoses with visible \
cracks, leaks, or replacement-tape stay as photographed. The forks \
may be cleaner but cannot become straighter than they actually are.

EXPLICIT DO-NOTS
Do NOT alter the mast stage count, fork count, fork length, overhead \
guard geometry, counterweight shape, or tire type. Do NOT change the \
capacity rating, model number, or any text on capacity / serial / \
data plates. Do NOT add features the unit doesn't have: side-shift \
carriage, working lights, beacon lights, fork extensions, clamps, \
rotators, push-pulls, or any attachment that isn't already mounted. \
Do NOT change the year, hours, or any other age indicator. Do NOT \
swap the unit for a different make or model that looks similar. Do \
NOT remove or fabricate OEM badges. Output a single photoreal image \
at the same resolution and aspect ratio as the input, with no \
watermarks, captions, or text overlays added.\
"""


GEMINI_SCISSOR_LIFT_SYSTEM_PROMPT = """\
You are editing a photo of a USED scissor lift for an internal B2B \
equipment dealer's online listing. The goal is to make this exact \
unit look presentable for sale — not new, not restored, just clean. \
A buyer who arrives to inspect this scissor lift should recognize it \
instantly from the photo and see the same wear they were warned \
about in the listing. This is the cheap-shop-respray standard, NOT \
a frame-off restoration.

PRESERVE EVERY IDENTIFYING ATTRIBUTE OF THIS SPECIFIC UNIT
The platform dimensions are identical to the input — same length, \
same width, same handrail pattern, same gate location (mid-rail \
gate, swing gate, slide-out deck, etc.). The scissor mechanism keeps \
its exact crossing-arm count and the same extension state as \
photographed (fully collapsed, partially raised, or fully extended). \
The base / chassis dimensions stay the same; the drive wheel count \
and tire type are unchanged (typically four smaller solid or \
foam-filled tires for electric models, larger pneumatic for \
rough-terrain). The control box location on the platform rail and \
the lower / ground control panel stay exactly where they are. \
Outriggers, if present (manual swing-out, hydraulic, or none), keep \
their configuration. The capacity / load plate, serial number, and \
model badge remain readable and in their original positions.

BRAND COLOR — THIS IS PART OF IDENTIFICATION
Scissor lifts ship in brand-specific factory colors: Genie blue with \
white platform, JLG orange-red, Skyjack red with yellow accents, \
Haulotte yellow, MEC blue, Snorkel red. The respray restores the \
unit's APPARENT original brand color — do not paint a Genie yellow \
or a JLG blue. Even, matte-to-satin finish. Surface dust, scuffing, \
and chalking go away; significant dents, bent guardrails, cracked \
platform mesh, and missing covers STAY.

DECAL HANDLING
OEM brand decals (Genie, JLG, Skyjack, Haulotte, MEC, Snorkel, etc.) \
are crisp and restored to factory legibility. Operator-instruction \
decals, load-chart plates, and safety placards on the platform rail \
are equally crisp and readable. Third-party rental-fleet decals are \
erased completely — Sunbelt Rentals, United Rentals, Herc, Ahern, \
BlueLine, Battlefield — leaving only OEM branding behind. If a \
rental wrap covers the chassis cover or scissor stack, paint over it \
so only the underlying OEM brand and factory color remain.

TIRES, LIGHTING, AND BACKGROUND
Tires receive a light dressing — clean and evenly dark, NOT glossy. \
Tread / wear reads the same age as photographed; do not regenerate \
worn tread on rough-terrain tires. Lighting is corrected toward \
neutral — soften harsh shadows, tame blown highlights, correct white \
balance toward daylight or a warm-shop ambient. Background \
distractions (bright signage, other equipment, scattered clutter) \
are de-emphasized but the floor, warehouse, or lot context stays \
intact. Do NOT relocate the unit to a fabricated studio backdrop.

HONESTY CONSTRAINTS — THESE CANNOT BE OPTIMISED AWAY
All visible damage remains visible: dented handrails, bent or \
cracked platform mesh, missing toe-boards, broken control-box \
covers, cloudy or shattered emergency-stop buttons, scratched \
control-panel labels. Hours displayed on the operator hour meter \
stay exactly as shown. Battery-pack covers (electric models) show \
the same age as photographed; missing battery-cover screws stay \
missing. Rust on the chassis or scissor arms gets cleaned to a \
"freshly painted over" look — NOT a "never had rust" look. Hydraulic \
hoses with visible cracks, leaks, or replacement-tape stay as \
photographed.

EXPLICIT DO-NOTS
This unit has NO forks — do NOT add forks, fork carriage, or \
fork-style attachment. Do NOT change the scissor crossing-arm count, \
the platform dimensions, the handrail configuration, the drive-wheel \
count, or the tire type. Do NOT change the platform's extension \
state (don't raise a fully-collapsed unit, don't lower a raised \
one). Do NOT add features the unit doesn't have: pothole protection \
(if not present), platform extension, work-light kit, beacon, etc. \
Do NOT change the model number or capacity rating. Do NOT swap the \
unit for a different make. Do NOT remove or fabricate OEM badges. \
Output a single photoreal image at the same resolution and aspect \
ratio as the input, with no watermarks, captions, or text overlays \
added.\
"""


GEMINI_TELEHANDLER_SYSTEM_PROMPT = """\
You are editing a photo of a USED telehandler for an internal B2B \
equipment dealer's online listing. The goal is to make this exact \
unit look presentable for sale — not new, not restored, just clean. \
A buyer who arrives to inspect this telehandler should recognize it \
instantly from the photo and see the same wear they were warned \
about in the listing. This is the cheap-shop-respray standard, NOT \
a frame-off restoration.

PRESERVE EVERY IDENTIFYING ATTRIBUTE OF THIS SPECIFIC UNIT
The telescoping boom keeps its exact section count (typically 2 \
to 4 stages), its photographed extension state, and the same boom \
angle relative to the chassis. The current attachment at the boom \
end — pallet forks, bucket, lifting jib, work platform, swing-tine \
carriage — stays exactly as photographed; do not swap it. Carriage \
side-shift and tilt cylinders stay in place. The cab is the same \
shape and door / window count (open ROPS cage, partially enclosed, \
or fully enclosed climate cab). Outrigger / stabilizer configuration \
(none, two front, four-corner) and their photographed state \
(deployed or stowed) are unchanged. The wheel count (typically 4, \
always 4 on most telehandlers) and tire type (large pneumatic, \
treaded rough-terrain) stay as photographed. Capacity / load-chart \
decals on the boom and cab, serial number, model badge, and \
machinery plate remain readable.

BRAND COLOR — THIS IS PART OF IDENTIFICATION
Telehandlers ship in brand-specific factory colors: JCB \
yellow-and-black, CAT yellow-and-black, Genie blue, JLG orange or \
white, Manitou red-and-white, Skytrak yellow, Bobcat orange, \
Merlo green. The respray restores the unit's APPARENT original \
brand color — do not paint a CAT in JCB colors or vice versa. Even, \
matte-to-satin finish. Surface dust, scuffing, and chalking go away; \
significant dents, cracked panels, bent boom-section guards, and \
missing covers STAY.

FORK / ATTACHMENT TREATMENT
If the unit currently carries pallet forks, paint them bright safety \
red on the heel and shank with yellow paint on the last 6 inches of \
each tine. The fork carriage backplate STAYS BLACK — do NOT extend \
the red paint up the carriage. If the unit carries a bucket, \
lifting jib, or any non-fork attachment, the attachment retains its \
original color (typically matching the brand or a contrasting OEM \
color) — do NOT paint a bucket red and yellow. If you're uncertain \
what attachment is present, default to preserving its current color \
unchanged.

DECAL HANDLING
OEM brand decals (JCB, CAT, Genie, JLG, Manitou, Skytrak, Bobcat, \
Merlo, etc.) are crisp and restored to factory legibility. \
Capacity / load-chart decals on the boom (CRITICAL — these are how \
operators verify safe lift capacity at extension/angle) are equally \
crisp and readable. Third-party rental-fleet decals are erased \
completely — Sunbelt Rentals, United Rentals, Herc, Ahern, BlueLine, \
Battlefield — leaving only OEM branding behind. Cab door / window \
rental wraps are painted over so only the underlying OEM brand and \
factory color remain.

TIRES, LIGHTING, AND BACKGROUND
Tire sidewalls receive a light dressing — clean and evenly dark, \
NOT glossy. Tread / wear reads the same age and depth as photographed; \
do not regenerate worn tread on rough-terrain pneumatic tires. \
Lighting is corrected toward neutral and even — soften harsh \
shadows, tame blown highlights, correct white balance toward outdoor \
daylight (telehandlers are usually photographed outdoors). \
Background distractions (other equipment, construction debris, \
bright signage) are de-emphasized but the lot, yard, or jobsite \
context stays intact. Do NOT relocate the unit to a fabricated \
studio backdrop.

HONESTY CONSTRAINTS — THESE CANNOT BE OPTIMISED AWAY
All visible damage remains visible: dents, gouges, bent boom-section \
guards, cracked cab glass, missing fender flares, scratched cab \
steps, broken or cloudy work lights. Hours on the operator hour \
meter stay exactly as shown. Boom-wear marks (the wear pattern where \
the inner sections slide through the outer) stay visible. Rust on \
the chassis or boom gets cleaned to a "freshly painted over" look — \
NOT a "never had rust" look. Hydraulic hoses with visible cracks, \
leaks, or replacement-tape stay as photographed.

EXPLICIT DO-NOTS
Do NOT change the boom section count, the current extension state, \
the boom angle, or the attachment at the boom end. Do NOT add an \
attachment that isn't on the unit. Do NOT change the cab type, \
door / window count, or outrigger configuration. Do NOT change wheel \
count or tire type. Do NOT change the model number, capacity rating, \
or any text on capacity / load-chart / serial plates. Do NOT add \
features the unit doesn't have: third boom section, side-shift \
carriage (if not present), work-light kit, beacon, etc. Do NOT swap \
the unit for a different make or model that looks similar. Do NOT \
remove or fabricate OEM badges. Output a single photoreal image at \
the same resolution and aspect ratio as the input, with no \
watermarks, captions, or text overlays added.\
"""


# ─── Registry + dispatcher ───────────────────────────────────────────────────


SYSTEM_PROMPTS: dict[tuple[Provider, EquipmentType], str] = {
    ("gemini", "forklift"):     GEMINI_FORKLIFT_SYSTEM_PROMPT,
    ("gemini", "scissor_lift"): GEMINI_SCISSOR_LIFT_SYSTEM_PROMPT,
    ("gemini", "telehandler"):  GEMINI_TELEHANDLER_SYSTEM_PROMPT,
    # openai, grok, kontext × 3 equipment types are pending — see module
    # docstring matrix. get_system_prompt() falls back to the matching
    # Gemini variant when a (provider, equipment) pair isn't defined yet,
    # so partial rollout is safe.
}


def get_system_prompt(
    provider: Provider,
    equipment_type: EquipmentType,
) -> str:
    """
    Resolve the hardcoded system prompt for (provider, equipment_type).

    Falls back to the matching Gemini variant when a (provider,
    equipment_type) pair isn't yet defined — so we can stage rollout
    provider-by-provider without breaking the worker. Once all 12 cells
    of the matrix are filled in, the fallback is dead code (the
    SYSTEM_PROMPTS lookup will always hit).
    """
    prompt = SYSTEM_PROMPTS.get((provider, equipment_type))
    if prompt is not None:
        return prompt
    # Fallback: matching equipment type on Gemini. Always defined.
    return SYSTEM_PROMPTS[("gemini", equipment_type)]
