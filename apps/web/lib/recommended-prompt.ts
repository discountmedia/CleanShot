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
//
// ─── Why this is a fragment list and not one string (2026-08-21) ───────────
//
// The prompt is assembled from NAMED FRAGMENTS so a control can remove one
// cleanly. The driving case is forks: on some camera angles the upright
// section of the fork isn't in frame, and on others the tips are cropped out.
// The old single-string prompt told the model to render both regardless, so
// it invented them — painting part of the overhead guard into a vertical
// shank, or shortening the forks to drag the tips into view so it had
// something yellow to paint.
//
// Removing a fragment is a list filter, never string surgery on assembled
// prose: searching for a sentence in text the operator may have reworded is
// unreliable, and deleting a clause mid-paragraph leaves dangling references
// ("keep those black") pointing at something no longer mentioned. Each
// fragment is a self-contained sentence, so dropping any one leaves the rest
// grammatical and non-contradictory.

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

/**
 * Which parts of the fork are actually visible in THIS source photo.
 *
 * Both default to true, i.e. "the fork is fully in frame", which is the
 * common case and reproduces the prompt exactly as it read before these
 * controls existed.
 */
export interface ForkVisibility {
  /** False when the upright/shank portion of the fork is out of frame. */
  verticalVisible: boolean;
  /** False when the fork tips are cropped out of frame. */
  tipsVisible: boolean;
}

export const DEFAULT_FORK_VISIBILITY: ForkVisibility = {
  verticalVisible: true,
  tipsVisible:     true,
};

export function isDefaultForkVisibility(f: ForkVisibility): boolean {
  return f.verticalVisible && f.tipsVisible;
}

/** A named, self-contained piece of the prompt. */
export interface PromptFragment {
  id:   string;
  text: string;
}

/**
 * The fork instruction, as fragments.
 *
 * `fork.tips` and `fork.noTips` are mutually exclusive: when tips are cropped
 * out we do not simply DELETE the yellow-tip clause, we SUBSTITUTE one that
 * says what to do instead. A bare removal would leave "paint the fork blades
 * red" with no statement about the tips at all, and the model fills silence
 * with its training prior — which is yellow tips.
 */
function forkFragments(
  equipment: EquipmentType,
  fork: ForkVisibility,
): PromptFragment[] {
  // Scissor lifts have a platform, not forks — swap the whole fork group for a
  // platform line so the starter never tells the model to paint forks that
  // don't exist (mirrors the backend paint_forks_on gate that skips scissor
  // lifts). Fork visibility is meaningless here.
  if (equipment === "scissor_lift") {
    return [{
      id:   "platform",
      text: "Keep the platform, guard rails, and scissor stack exactly as they are.",
    }];
  }

  const out: PromptFragment[] = [];

  if (fork.tipsVisible) {
    out.push({
      id:   "fork.tips",
      text: "Paint the fork blades Discount Forklift red with safety-yellow tips.",
    });
  } else {
    // Substitution, not removal. Also states the negative explicitly, because
    // the reported failure is the model shortening the forks to bring tips
    // into frame so it has something to paint yellow.
    out.push({
      id:   "fork.noTips",
      text:
        "Paint the fork blades Discount Forklift red with NO separate tip " +
        "treatment — the fork tips are cropped out of frame in this photo, so " +
        "paint no yellow anywhere and do NOT shorten, resize, or reposition " +
        "the forks to bring their tips into view.",
    });
  }

  if (!fork.verticalVisible) {
    // Only ever added, never removed: when the vertical section IS visible the
    // base instruction already covers it and saying so would be noise.
    out.push({
      id:   "fork.noVertical",
      text:
        "The upright vertical section of the fork is not visible in this " +
        "photo. Do not render, paint, or invent one, and do not treat any " +
        "part of the carriage, mast, or overhead guard as if it were the " +
        "vertical fork shank.",
    });
  }

  out.push({
    id:   "fork.backrest",
    text: "Keep the load backrest black.",
  });

  return out;
}

/**
 * The recommended prompt as an ordered fragment list. `buildRecommendedPrompt`
 * joins these; exported separately so a caller can inspect or diff the pieces.
 */
export function recommendedPromptFragments(
  equipment: EquipmentType = "forklift",
  meta?: { make?: string; model?: string; year?: string },
  fork: ForkVisibility = DEFAULT_FORK_VISIBILITY,
): PromptFragment[] {
  const noun = EQUIPMENT_NOUN[equipment] ?? "forklift";
  const idBits = [meta?.year, meta?.make, meta?.model]
    .map((s) => s?.trim())
    .filter(Boolean)
    .join(" ");

  const fragments: PromptFragment[] = [];

  if (idBits) {
    fragments.push({ id: "identity", text: `This is a ${idBits}.` });
  }

  fragments.push({
    id: "respray",
    text:
      // "in its ORIGINAL factory color" was changed to "in the same color"
      // 2026-08-21 (operator: it trips Gemini up in most cases). The likely
      // reason is that "original factory color" asks the model to reason about
      // what the factory colour WAS, which invites it to correct a faded or
      // repainted unit toward a remembered brand colour. "The same color" is a
      // comparison against the pixels in front of it, which is what we want.
      `Give this used ${noun} a clean, listing-ready look with an inexpensive ` +
      "shop-quality respray in the same color — do not change the color.",
  });

  fragments.push({
    id: "preserve",
    text:
      "Keep it looking like the real, used machine: same shape and " +
      "proportions, same parts, and every make / model / capacity decal intact.",
  });

  fragments.push(...forkFragments(equipment, fork));

  fragments.push({
    id: "finish",
    text:
      "Add glossy shine to the tire sidewalls, improve the lighting, and tidy " +
      "up the background without changing the location or camera angle.",
  });

  fragments.push({
    id: "honesty",
    text:
      "Cover surface scuffs, chips, and light rust with the fresh paint, but " +
      "leave real structural damage (dents, deep gouges, missing parts) " +
      "visible — don't make it look brand-new, and don't add anything that " +
      "isn't already on the unit.",
  });

  return fragments;
}

export function buildRecommendedPrompt(
  equipment: EquipmentType = "forklift",
  meta?: { make?: string; model?: string; year?: string },
  fork: ForkVisibility = DEFAULT_FORK_VISIBILITY,
): string {
  return recommendedPromptFragments(equipment, meta, fork)
    .map((f) => f.text)
    .join(" ");
}

/**
 * Is `prompt` still the recommended text for these inputs, ignoring
 * whitespace?
 *
 * This is what decides whether the fork controls can REMOVE a fragment or
 * only append an instruction. If the operator has reworded the prompt, the
 * fragments no longer describe their text and rebuilding it would silently
 * throw their edits away — so we leave their words alone and the backend
 * appends an explicit instruction instead. The UI says which is happening;
 * see the note beside the controls in EnhancePanel.
 */
export function matchesRecommendedPrompt(
  prompt: string,
  equipment: EquipmentType,
  meta?: { make?: string; model?: string; year?: string },
): boolean {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim();
  const target = norm(prompt);
  if (!target) return false;
  // Any fork-visibility combination counts as "still recommended" — the
  // operator may have already toggled one, and that must not demote their
  // prompt to custom.
  const combos: ForkVisibility[] = [
    { verticalVisible: true,  tipsVisible: true  },
    { verticalVisible: true,  tipsVisible: false },
    { verticalVisible: false, tipsVisible: true  },
    { verticalVisible: false, tipsVisible: false },
  ];
  return combos.some(
    (f) => norm(buildRecommendedPrompt(equipment, meta, f)) === target,
  );
}
