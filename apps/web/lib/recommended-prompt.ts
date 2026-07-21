// apps/web/lib/recommended-prompt.ts
// Equipment-aware starting prompt for the Enhance tab's prompt-first flow.
//
// Enhance went prompt-first on 2026-07-21: the operator's own words drive the
// result. Most users aren't used to writing image prompts, so "Insert
// recommended prompt" drops this readable baseline into the box — a STARTING
// POINT they then edit in their own style, not a locked preset.
//
// This is intentionally concise + human-editable (a few sentences), NOT the
// full ~200-line procedural prose in enhance_worker._build_enhance_prompt.
// That prose is machine-tuned and not something a person can meaningfully
// edit. The backend still appends the always-on safety guardrails (preserve
// make / model / decals / proportions) and any ON toggle add-ons on top of
// whatever ends up in the box, so this starter can stay light.

import type { EquipmentType } from "./types";

const EQUIPMENT_NOUN: Record<EquipmentType, string> = {
  forklift:             "forklift",
  rough_terrain:        "rough-terrain forklift",
  scissor_lift:         "scissor lift",
  telehandler:          "telehandler",
  reach_truck:          "reach truck",
  turret_truck:         "turret (very-narrow-aisle) truck",
  articulated_forklift: "articulated forklift",
  order_picker:         "order picker",
  pallet_jack:          "pallet jack",
  walkie_stacker:       "walkie stacker",
};

// Scissor lifts have a platform, not forks — swap the fork line for a platform
// line so the starter never tells the model to paint forks that don't exist
// (mirrors the backend paint_forks_on gate that skips scissor lifts).
function liftingLine(equipment: EquipmentType): string {
  if (equipment === "scissor_lift") {
    return "Keep the platform, guard rails, and scissor stack exactly as they are.";
  }
  return (
    "Paint the fork blades Discount Forklift red with safety-yellow tips, and " +
    "keep the load backrest black."
  );
}

export function buildRecommendedPrompt(
  equipment: EquipmentType = "forklift",
  meta?: { make?: string; model?: string; year?: string },
): string {
  const noun = EQUIPMENT_NOUN[equipment] ?? "forklift";
  const idBits = [meta?.year, meta?.make, meta?.model]
    .map((s) => s?.trim())
    .filter(Boolean)
    .join(" ");
  const idLine = idBits ? `This is a ${idBits}. ` : "";
  return (
    `${idLine}Give this used ${noun} a clean, listing-ready look with an ` +
    "inexpensive shop-quality respray in its ORIGINAL factory color — do not " +
    "change the color. Keep it looking like the real, used machine: same shape " +
    "and proportions, same parts, and every make / model / capacity decal " +
    `intact. ${liftingLine(equipment)} Add glossy shine to the tire sidewalls, ` +
    "improve the lighting, and tidy up the background without changing the " +
    "location or camera angle. Cover surface scuffs, chips, and light rust with " +
    "the fresh paint, but leave real structural damage (dents, deep gouges, " +
    "missing parts) visible — don't make it look brand-new, and don't add " +
    "anything that isn't already on the unit."
  );
}
