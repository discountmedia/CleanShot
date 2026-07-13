#!/usr/bin/env python3
"""
Candidate enhance-prompt BUILDER v2 — equipment-type-enriched + defect-locked.

Driven by the eval findings + operator calibration:
  • The fails cluster by EQUIPMENT TYPE — Gemini botches warehouse-electric gear
    (reach trucks, order pickers, walkies, pallet jacks) whose anatomy is rare in
    training data, rendering them as generic sit-down forklifts.
  • The operator's exact reject list: cab recoloured, mast recoloured, wheels ADDED,
    components DESATURATED, unit RESHAPED.

So each prompt now leads with a prominent per-type "THIS MACHINE" block (operator-
confirmed) telling the model what the machine IS, its defining parts, and what NOT
to turn it into — then hard-locks the specific defects.

Default: light same-colour body respray (operator decision). Toggle fragments +
scan whitelist as before. Tested via the enhance API's custom_prompt (no deploy);
port the winner into enhance_worker._build_enhance_prompt.
"""

from __future__ import annotations

EQUIP_DISPLAY = {
    "forklift": "sit-down counterbalance forklift", "rough_terrain": "rough-terrain forklift",
    "scissor_lift": "scissor lift", "telehandler": "telehandler",
    "reach_truck": "stand-up reach truck", "turret_truck": "turret truck (VNA)",
    "articulated_forklift": "articulated narrow-aisle forklift",
    "order_picker": "order picker", "pallet_jack": "pallet jack",
    "walkie_stacker": "walkie (walk-behind) stacker",
}

# Prominent per-type "THIS MACHINE" blocks — operator-confirmed. Each says what the
# machine IS, its defining parts to preserve, and what NOT to turn it into (the actual
# failure mode for the warehouse-electric types).
EQUIP_ANATOMY = {
    "forklift": (
        "A sit-down counterbalance forklift: a seated operator cab under an overhead "
        "guard, a vertical mast at the front carrying two forks on a carriage, and a "
        "heavy rear counterweight, on front drive wheels plus smaller rear steer "
        "wheels. Preserve the mast stage count, fork length, overhead guard, "
        "counterweight, and wheel layout."
    ),
    "rough_terrain": (
        "A rough-terrain forklift: like a counterbalance forklift but on LARGE knobby "
        "pneumatic outdoor tires with a heavier frame and higher ground clearance. "
        "Preserve the big pneumatic tires (never shrink them to small cushion tires), "
        "the mast, forks, overhead guard, and counterweight."
    ),
    "scissor_lift": (
        "A scissor lift: an elevating work platform with guardrails raised by a folding "
        "X-pattern SCISSOR mechanism over a compact wheeled base. It has NO mast, NO "
        "forks, NO counterweight. Preserve the platform + railings, the scissor arms, "
        "and the base; never add forks or a mast."
    ),
    "telehandler": (
        "A telehandler: a single long TELESCOPIC BOOM (not a vertical mast) extending "
        "up and forward, with forks or an attachment at the boom tip, a side-mounted "
        "cab, large outdoor tires, and sometimes outriggers. Preserve the boom (length "
        "+ sections), the side cab, and the tire type; never replace the boom with a "
        "vertical mast."
    ),
    "reach_truck": (
        "A stand-up electric warehouse reach truck — NOT a sit-down counterbalance "
        "forklift. It has two forward OUTRIGGER LEGS with load wheels at their tips, a "
        "tall multi-stage mast, a pantograph or moving-mast REACH mechanism that "
        "extends the forks forward, and a STAND-UP operator compartment (no seat) at "
        "the rear with a battery. Preserve the outrigger legs + load wheels, the reach "
        "mechanism, the stand-up compartment, the tall narrow proportions, and the "
        "exact wheel count. NEVER add a seat, add a counterweight, add extra wheels, or "
        "render it as a sit-down forklift."
    ),
    "order_picker": (
        "An order picker: the operator rides UP on a platform that ELEVATES with the "
        "forks (operator-up), inside a compartment with railings/gates. It has a tall "
        "mast, a narrow chassis, load wheels, and forks or a load platform at the base. "
        "Preserve the elevating operator platform + railings, the tall mast, and the "
        "narrow proportions. NEVER drop the elevated platform, add a seat/counterweight/"
        "extra wheels, or render it as a ground-level sit-down forklift."
    ),
    "walkie_stacker": (
        "A walk-behind (walkie) stacker: NO riding cab — a walking operator steers via "
        "a long TILLER / steering arm with a control head. It has a compact upright "
        "body, a mast with forks, a single drive wheel, and load wheels/outriggers at "
        "the fork base. Preserve the tiller arm + control head, the mast, and the "
        "compact walk-behind body. NEVER add a seat, cab, or overhead guard, add extra "
        "wheels, or turn it into a ride-on forklift."
    ),
    "pallet_jack": (
        "A pallet jack / pallet truck: a low-profile unit with two long forks AT FLOOR "
        "LEVEL, a TILLER steering handle, small steer wheel(s) at the handle end and "
        "load rollers under the fork tips; often electric with a small battery/motor "
        "housing. Preserve the low flat forks, the tiller handle, and the low profile. "
        "NEVER add a mast, cab, or overhead guard, add extra wheels, or raise it into a "
        "stacker/forklift."
    ),
    "turret_truck": (
        "A turret truck (very-narrow-aisle / swing-reach): a very TALL multi-stage "
        "mast, a fork carriage that ROTATES 90 degrees and traverses to pick sideways "
        "without the truck turning, a man-up or man-down cab, aisle guide rollers, and "
        "a narrow chassis. Preserve the tall mast, the rotating turret fork head, the "
        "cab/platform, and the narrow proportions. NEVER render it as a standard "
        "counterbalance forklift or add a counterweight."
    ),
    "articulated_forklift": (
        "An articulated narrow-aisle forklift (Bendi / Flexi / Aisle-Master style): it "
        "looks like a counterbalance forklift but the FRONT mast/carriage section "
        "ARTICULATES (pivots) to the side to turn in narrow aisles. Preserve the "
        "articulation joint, the mast, forks, counterweight, and compact chassis. NEVER "
        "straighten out the articulation or add extra wheels."
    ),
}


def _ident(make, model, year):
    bits = [b.strip() for b in (year, make, model) if b and b.strip()]
    return " ".join(bits) if bits else "used forklift"


def build_candidate(toggles, equipment_display="forklift", equipment_anatomy="",
                    make=None, model=None, year=None, include_this_machine=True):
    t = lambda k: bool(toggles.get(k))  # noqa: E731
    ident = _ident(make, model, year)
    paint_forks = t("paintForksRedYellowTips") and equipment_display != "scissor lift"
    S = []

    # Layer 1 — CORE
    S.append(
        f"Photorealistic professional used-equipment listing photo of a {ident} "
        f"({equipment_display}), produced by cleaning up and cosmetically refreshing "
        f"the SUPPLIED photo. This is a quick, honest shop-grade refresh — NOT a "
        f"restoration, NOT a rebuild, NOT a newer model. Present the REAL machine "
        f"attractively; never turn it into a different or newer machine."
    )

    # Layer 1.5 — THIS MACHINE (prominent per-type anatomy — the isolated variable)
    if include_this_machine and equipment_anatomy:
        S.append(f"THIS MACHINE — {equipment_anatomy}")

    # Layer 2 — DEFECT LOCKS (the operator's exact reject list, loud, first)
    S.append(
        "HARD RULES — these override everything and match how this listing is judged:\n"
        "1. REAL COLOURS: keep every component its ACTUAL colour from the photo. Do NOT "
        "swap the cab, mast, body, frame, or any panel to a DIFFERENT colour. (A "
        "cleaner/brighter version of the SAME colour is fine; the load-backrest and "
        "fork-carriage staying black is fine.)\n"
        "2. NO DESATURATION: do not wash out, grey, or fade any component — colours stay "
        "as saturated as the original or slightly more.\n"
        "3. ADD NOTHING: do not add wheels, axles, guards, lights, mirrors, hoses, "
        "attachments, stickers, or any part not clearly in the photo; remove no real part.\n"
        "4. NO RESHAPING: keep the machine's exact silhouette, structure, and "
        "proportions per THIS MACHINE above — do not redraw it into a different shape or "
        "a generic forklift.\n"
        "5. TEXT: keep model-number, capacity, and data-plate text as-is; never invent, "
        "complete, or scramble it (a wrong character or two on a tiny marking is fine).\n"
        "6. NO NEW DAMAGE: add no dents, rust, cracks, scratches, or debris."
    )

    # REFRESH (always — same-colour body respray)
    S.append(
        "REFRESH: give the body a clean, even, lightly-resprayed look in its OWN "
        "existing colour — cover grime, minor scuffs, and dullness so it reads well "
        "cared-for. Keep it a realistic USED unit (not showroom-new); leave real "
        "structural wear (dents, deep gouges, rust-through) visible."
    )

    # Layer 3 — ACTION FRAGMENTS (per active toggle)
    frags = []
    if t("newPaintJob"):
        frags.append("PAINT EMPHASIS: cover surface chips/scuffs/fade more thoroughly, still strictly the SAME real colour (rule 1).")
    if paint_forks:
        frags.append("FORKS: paint ONLY the two fork tines Discount Forklift red with safety-yellow tips (red on shank + ~80% of blade, yellow on the outer ~15-20 cm). Fork shape/length/count unchanged; carriage/mast unpainted; load-backrest cage stays BLACK.")
    if t("removeRust"):
        frags.append("RUST: clean off surface rust and light oxidation; keep deep rust-through holes visible.")
    if t("shineTires"):
        frags.append("TIRES: gloss the tire SIDEWALLS only (deep black, wet look); tread stays dry and matte; same tires + tread wear.")
    if t("restoreDecals"):
        frags.append("DECALS: make existing decals sharp and legible WITHOUT changing their text/numbers (rule 5).")
    if t("improveLighting"):
        frags.append("LIGHTING: balance exposure and even out lighting; keep the same scene.")
    if t("removePeople"):
        frags.append("PEOPLE: remove any person/operator/hand; fill with the plausible background behind them.")
    if t("removeBackgroundSignage"):
        frags.append("BACKGROUND SIGNAGE: remove wall/scene signs, posters, banners, and printed text in the environment; keep all text ON the machine (rule 5).")
    if t("showroomFloor"):
        frags.append("FLOOR: if a studio/showroom shot, replace the floor with a flawless uniform mid-gray (~#808080) polished studio floor; keep the unit's contact shadow. No-op on real yard/warehouse floors.")
    if t("removeRentalBranding"):
        frags.append("RENTAL BRANDING: remove third-party rental-fleet decals/wraps/asset-tags (Sunbelt, United Rentals, Herc, etc.); leave the panel matching its surroundings, no ghost outline, no invented logos; PRESERVE OEM decals/plates (rule 5).")
    if t("threeWheel") and equipment_display == "sit-down counterbalance forklift":
        frags.append("THREE-WHEEL: single rear wheel — preserve it; do not add or split into a second rear wheel.")
    if frags:
        S.append("REQUESTED EDITS:\n" + "\n".join(f"- {f}" for f in frags))

    # Layer 4 — SCENE
    S.append(
        "SCENE: keep the exact camera angle, perspective, and framing. Keep the "
        "background (lightly tidied) unless an edit above changes it. No zoom, crop, "
        "rotate, horizon-leveling, or re-posing."
    )
    return "\n\n".join(S)


def build_intended_edits(toggles, equipment_display="forklift"):
    t = lambda k: bool(toggles.get(k))  # noqa: E731
    edits = [
        "The body may be lightly resprayed in its OWN colour — a same-colour freshen is "
        "EXPECTED. Only flag colour if a component is swapped to a DIFFERENT hue.",
        "The photo/background may be cleaned up and lighting improved; a dirty floor "
        "becoming clean is EXPECTED.",
    ]
    if t("paintForksRedYellowTips") and equipment_display != "scissor lift":
        edits.append("Forks may be repainted red with yellow tips (fork shape/length/count must match); load-backrest may be black.")
    if t("removeRust"):
        edits.append("Surface rust may be cleaned off.")
    if t("shineTires"):
        edits.append("Tire sidewalls may be glossed.")
    if t("removeRentalBranding"):
        edits.append("Rental-fleet branding may be removed.")
    if t("removeBackgroundSignage"):
        edits.append("Background signage may be removed.")
    if t("showroomFloor"):
        edits.append("Floor may be replaced with uniform studio gray.")
    return edits


if __name__ == "__main__":
    import sys
    et = sys.argv[1] if len(sys.argv) > 1 else "reach_truck"
    toggles = {"paintForksRedYellowTips": True, "removeRentalBranding": True, "improveLighting": True}
    print(build_candidate(toggles, EQUIP_DISPLAY.get(et, "forklift"), EQUIP_ANATOMY.get(et, ""),
                          make="Raymond", model="R45T", year="2015"))
