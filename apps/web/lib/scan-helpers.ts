// apps/web/lib/scan-helpers.ts
// Pure helpers shared by the Scan-tab components. Kept side-effect-free so
// the redesigned `ScanCard`, `UnifiedAnomalies`, `RegenPanel`, and the
// command bar can all reach for the same consensus + dedup logic without
// import cycles.
//
// Important: the existing data shape uses ProviderScanResult[] (an array,
// not a per-provider record). These helpers accept the array directly so
// we don't have to remodel the polling/result-fetch pipeline.

import type {
  AnomalyItem,
  EquipmentType,
  ProviderScanResult,
  ScanProvider,
} from "./types";

// ─── Expected per-provider scan duration (seconds) ───────────────────────────
//
// Used by ScanProgressStrip to drive the elapsed-vs-expected progress bar
// per provider while a scan is in flight. Values are honest medians from
// the production worker; raise them if p95 wall-time grows.

export const EXPECTED_SCAN_DURATIONS_S: Record<ScanProvider, number> = {
  gemini:    18,
  openai:    30,
  anthropic: 25,
};

// ─── Consensus ───────────────────────────────────────────────────────────────

/**
 * Per-provider identity colours for scan progress bars and verdict rows.
 *
 * DELIBERATE PALETTE EXCEPTION — do not "fix" these into tokens.
 *
 * The house palette is three accents (lime = good, purple = action/attention,
 * red = destructive only) and it cannot encode provider identity: a previous
 * restyle collapsed all three scan bars onto `bg-panel-hi` while running and
 * `bg-accent` when done, so the strip carried NO per-provider colour at all
 * and you could not tell which vendor was still working. The operator asked
 * for these back as saturated, distinct hues (2026-08-21).
 *
 * These are literal hexes for the same reason the Tweak button's `#0A84FF` is
 * — the palette has no slot for them, and routing them through `@theme` would
 * imply they carry house semantics. They do not. They mean "Gemini",
 * "OpenAI", "Anthropic" and nothing else.
 *
 * Two of the three are blue-dominant, which the palette notes otherwise
 * restrict. That is accepted here: these are identity colours, not UI state.
 *
 * Measured contrast (all pass AA as text, so they are safe on labels too):
 *   #4A9EFF  bg 5.64  panel 5.07  well 6.32
 *   #22D3EE  bg 8.59  panel 7.73  well 9.63
 *   #FF8A3D  bg 6.62  panel 5.96  well 7.42
 *
 * If a component library default would flatten these to a single neutral,
 * override it — an inline `style` beats a utility class, which is exactly why
 * these are consumed as style values rather than Tailwind classes.
 */
export const SCAN_PROVIDER_COLOR: Record<ScanProvider, string> = {
  gemini:    "#4A9EFF",  // blue
  openai:    "#22D3EE",  // cyan
  anthropic: "#FF8A3D",  // orange
};

export interface ConsensusSummary {
  verdict:       "pass" | "fail" | "mixed";
  /** 0–1 average across whichever providers have returned a verdict. */
  avgConfidence: number;
  /** How many providers said pass. */
  passes:        number;
  /** How many providers returned a verdict total. */
  total:         number;
}

/**
 * Compute a single consensus summary across however many providers have
 * landed results so far. Returns null when none have — callers should
 * fall back to the "scanning" treatment in that case.
 */
export function computeConsensus(
  providerResults: ProviderScanResult[],
): ConsensusSummary | null {
  if (providerResults.length === 0) return null;
  const passes = providerResults.filter((r) => r.verdict === "pass").length;
  const avgConf =
    providerResults.reduce((acc, r) => acc + r.confidence, 0) / providerResults.length;
  const verdict: ConsensusSummary["verdict"] =
    passes === providerResults.length ? "pass"
    : passes === 0                    ? "fail"
    :                                   "mixed";
  return {
    verdict,
    avgConfidence: avgConf,
    passes,
    total: providerResults.length,
  };
}

// ─── Unified anomaly dedup ───────────────────────────────────────────────────

export interface UnifiedAnomalyEntry {
  type:        string;
  /** First location seen across providers (varies in phrasing but normalised below). */
  location:    string;
  severity:    AnomalyItem["severity"];
  /** Description text from the first provider that flagged the entry. */
  description: string;
  /** Set of providers that flagged a matching anomaly. */
  flaggedBy:   Set<ScanProvider>;
}

/**
 * Group anomalies from all providers by `(type, location-prefix)` so the
 * operator sees one row per distinct issue with a "flagged by N/3" signal
 * instead of three near-identical entries.
 *
 * HEURISTIC NOTE: `location.split(" ")[0]` collapses
 *   "right side" + "right side panel" + "right" → all match on "right"
 *   "overhead guard" + "overhead" → both match on "overhead"
 * It may over-collapse on tokens like "left"/"right" — e.g. "left fork"
 * and "left mast" both normalise to "left". If operators report bad
 * matches, swap in a longer prefix (`.slice(0, 2).join(" ")`) or a
 * scene-part normalisation table. Land the heuristic first; treat the
 * table as a follow-up.
 */
/**
 * Backend severity normalisation. The JSON schema documents
 * `low | medium | high` but models occasionally emit uppercase, "med",
 * "minor", etc. Anything we don't recognise defaults to "low" rather
 * than blowing up downstream lookups.
 */
function normalizeSeverity(raw: unknown): AnomalyItem["severity"] {
  if (typeof raw !== "string") return "low";
  const lower = raw.toLowerCase();
  if (lower === "high" || lower === "medium" || lower === "low") return lower;
  // Common drift cases worth pinning by hand.
  if (lower === "med") return "medium";
  if (lower === "critical" || lower === "severe") return "high";
  return "low";
}

export function unifyAnomalies(
  providerResults: ProviderScanResult[],
): UnifiedAnomalyEntry[] {
  const map = new Map<string, UnifiedAnomalyEntry>();
  const sevOrder: Record<AnomalyItem["severity"], number> = {
    low:    0,
    medium: 1,
    high:   2,
  };

  for (const result of providerResults) {
    for (const a of result.anomalies) {
      const type = (a.type ?? "").toString();
      const location = (a.location ?? "").toString();
      const description = (a.description ?? "").toString();
      const severity = normalizeSeverity(a.severity);

      const locPrefix = location.split(" ")[0]?.toLowerCase() ?? "";
      const key = `${type.toLowerCase()}::${locPrefix}`;
      const existing = map.get(key);
      if (!existing) {
        map.set(key, {
          type,
          location,
          severity,
          description,
          flaggedBy: new Set<ScanProvider>([result.provider]),
        });
        continue;
      }
      existing.flaggedBy.add(result.provider);
      if (sevOrder[severity] > sevOrder[existing.severity]) {
        existing.severity = severity;
      }
    }
  }

  return Array.from(map.values()).sort(
    (a, b) => sevOrder[b.severity] - sevOrder[a.severity],
  );
}

// ─── Regen prompt — mirror of the backend's _build_enhance_prompt ────────────
//
// The regen path sends a verbatim `custom_prompt` that bypasses the
// worker's wrapper, so the prompt assembled here must carry the FULL
// enhance treatment instructions on its own. The text below is a
// near-verbatim port of `_build_enhance_prompt` in
// apps/api/src/cleanshot_api/workers/enhance_worker.py — master +
// standard_treatment + guardrails, with an "ISSUES TO ADDRESS" block
// in place of the toggle-driven extras the enhance flow uses.
//
// DRIFT-WARNING: if you change either side, mirror the change here too.
// In particular: the HONESTY CONSTRAINT (preserve visible defects) and
// the RENTAL-FLEET BRANDING block must stay in lock-step.

const EQUIPMENT_DISPLAY: Record<EquipmentType, string> = {
  forklift:       "forklift",
  rough_terrain:  "rough-terrain forklift",
  scissor_lift:   "scissor lift",
  telehandler:    "telehandler",
  reach_truck:    "reach truck",
  turret_truck:   "turret truck (VNA / swing-reach)",
  articulated_forklift: "articulated narrow-aisle forklift (Bendi / Flexi / Aisle-Master style)",
  order_picker:   "order picker",
  pallet_jack:    "pallet jack",
  walkie_stacker: "walkie stacker",
};

const EQUIPMENT_ANATOMY: Record<EquipmentType, string> = {
  forklift:
    "Same mast configuration, fork count, fork length, overhead guard shape, counterweight shape, and tire type.",
  rough_terrain:
    "Same mast configuration, fork count, fork length, overhead guard shape, counterweight shape, and the LARGE PNEUMATIC outdoor tires with their existing tread pattern — rough-terrain units run on knobby pneumatic tires (NOT solid cushion tires). Preserve the heavier-duty outdoor frame.",
  scissor_lift:
    "Same platform size and handrail pattern, scissor mechanism extension, base / chassis dimensions, drive wheels, and control box position.",
  telehandler:
    "Same boom length and section count, attachment (forks / bucket / lifting jib), outrigger configuration, cab shape, and wheel / tire type.",
  reach_truck:
    "Same mast height and section count, fork count and length, reach mechanism geometry (pantograph or moving-mast), operator cab / stand-up compartment shape, drive wheels, and load wheels.",
  turret_truck:
    "Same tall multi-stage mast and section count, the rotating / traversing turret fork head (swing-reach carriage), fork count and length, operator cab or platform shape (man-up cab that rises, or man-down), overhead guard, narrow chassis width, drive wheel, load wheels, and any aisle guide rollers. This is a very-narrow-aisle (VNA) truck — do NOT redraw it as a standard counterbalance forklift.",
  articulated_forklift:
    "Same articulating front end — the mast/carriage assembly pivots to the side for narrow-aisle turning (Bendi / Flexi / Aisle-Master style). Preserve that articulation joint, the mast configuration and section count, fork count and length, overhead guard shape, counterweight shape, compact chassis, and tire type. It resembles a counterbalance forklift but the front section bends — keep it.",
  order_picker:
    "Same platform size and railing pattern, mast height and section count, integrated forks or load support, base chassis dimensions, drive wheels, and operator control layout.",
  pallet_jack:
    "Same fork length and spread, tiller handle shape and length, front (steer) wheels, load wheels, and battery box position if electric.",
  walkie_stacker:
    "Same mast configuration, fork count and length, tiller handle position and shape, drive wheel, load wheels, and operator control layout.",
};

// Body-parts list substituted into "the entire body of the {eq},
// including the {EQUIPMENT_BODY_PARTS}, has received a fresh coat".
const EQUIPMENT_BODY_PARTS: Record<EquipmentType, string> = {
  forklift:       "chassis, mast, and carriage",
  rough_terrain:  "chassis, mast, carriage, and counterweight",
  scissor_lift:   "chassis, scissor arms, and platform railing",
  telehandler:    "chassis, boom, and cab",
  reach_truck:    "chassis, mast, reach mechanism, and cab",
  turret_truck:   "chassis, mast, and turret fork head",
  articulated_forklift: "chassis, articulating mast, and carriage",
  order_picker:   "chassis, mast, platform, and forks",
  pallet_jack:    "forks, tiller, and wheel housing",
  walkie_stacker: "chassis, mast, forks, and tiller",
};

/** Honesty-first multi-section spine. The earlier single-paragraph
 *  version with "completely covering all previous paint chips and rust"
 *  made the model render near-factory-new lifts. This version leads
 *  with mandatory-imperfections + "cheap shop respray" framing and
 *  ends with explicit FAILURE CRITERIA so "looks too new" reads as a
 *  hard fail. Mirrors apps/api/.../workers/enhance_worker.py exactly. */
function buildSpine(
  equipmentType: EquipmentType,
  paintForksOn:  boolean,
): string {
  const eq    = EQUIPMENT_DISPLAY[equipmentType];
  const parts = EQUIPMENT_BODY_PARTS[equipmentType];

  // All equipment types except scissor lift have visible forks. Mirrors
  // the backend `paint_forks_on` rule in enhance_worker.py — keep these
  // two conditions in lock-step (the comment block at the top of this
  // file calls out the drift hazard).
  const paintForksApplies =
    paintForksOn && equipmentType !== "scissor_lift";

  const sections: string[] = [];

  sections.push(
    `A photorealistic depiction of a USED ${eq} that has just received a CHEAP shop-grade spray paint job. This is a real shop respray — quick, inexpensive, and effective at making a used unit listing-ready. It is NOT a restoration and NOT a factory finish, but the fresh paint clearly improves the unit's appearance.`,
  );

  sections.push(
    "WHAT THE FRESH PAINT COVERS (these are gone in the output):\n• Surface paint chips, scuffs, scratches, and faded patches — covered by the new paint.\n• Light surface rust and oxidation — covered.\n• Dirt, grime, dust, and surface staining — cleaned off before the paint pass.\n• Dull, worn-out colour — restored to the saturated original factory colour.",
  );

  sections.push(
    "WHAT THE FRESH PAINT DOES NOT COVER (these stay clearly visible in the output):\n• Dents, panel deformation, and bent hardware.\n• Deep gouges THROUGH the metal (not surface scratches — actual metal damage).\n• Missing parts, broken hardware, cracked components.\n• Severe rust-through holes and large rust pitting craters that have eaten into the panel.\n• Replaced / mismatched panels, aftermarket non-OEM parts — leave them as-is, do not unify them.",
  );

  sections.push(
    `PAINT JOB CHARACTER: a quick coat from a shop spray gun in the precise original factory colour scheme. It looks CHEAP-but-CLEAN — even coverage in most places, slight orange-peel texture on close inspection, maybe minor overspray edges in tight corners. Apply this respray to the ${parts}. Match the original panel-to-colour mapping exactly; do not change which panel is which colour.`,
  );

  sections.push(
    "OEM make, model, and capacity decals are masked off and preserved in their EXACT original placement and spelling, showing only realistic wear.",
  );

  if (paintForksApplies) {
    sections.push(
      "LIFTING FORKS — paint ONLY the two horizontal fork tines themselves (the L-shaped blades that go into pallets) with Discount Forklift signature red and safety yellow tips. The red covers the heel of each fork (the vertical shank) and roughly the first 80% of the horizontal blade; the outermost ~15-20 cm (~6-8 inches) of the tip is safety YELLOW. Do NOT paint the surrounding carriage, mast, mast rails, side shifters, attachment brackets, or any hardware around the forks — ONLY the two fork tines themselves. The LOAD BACK REST (LBR), the vertical cage / grid frame at the back of the fork carriage, remains BLACK; OSHA convention reserves black for the LBR so the high-vis forks read clearly against it.",
    );
  }

  sections.push(
    "TIRES: keep the SAME tires — do not replace them, and existing tread wear, cuts, gouges, and aging cracks on the tread itself stay visible. But the SIDEWALLS have been treated with a generous coat of glossy tire shine — the sidewalls read as wet-look, deep black, noticeably glossy and contrasted against the dry, dusty, untreated tread. Apply tire shine ONLY to the sidewall, never the tread.",
  );

  sections.push(
    "SCENE: maintain the identical camera angle, perspective, and background environment from the source image. The background setting remains entirely unchanged.",
  );

  sections.push(
    `DUAL FAILURE CRITERIA:\n• If the final image looks brand-new, factory-fresh, restored, or like the unit was never used, you have failed (too perfect).\n• If the final image looks unchanged from the source — same scuffs, same chips, same dull paint, same dusty tires — you have ALSO failed (no respray applied).\nThe right answer is: clearly a used ${eq}, clearly freshly resprayed in a cheap-but-clean shop paint job, with glossy tire-shined sidewalls; only structural damage and severe rust-through still visible.`,
  );

  return sections.join("\n\n");
}

function buildRentalScrubBlock(): string {
  return (
    "ADDITIONAL ACTION — RENTAL-FLEET BRANDING. Remove decals, stickers, vinyl wraps, painted lettering, and asset-tag numbers that advertise third-party rental fleets. Examples include (non-exhaustive): Sunbelt Rentals, United Rentals, Herc Rentals, Sunstate Equipment, Ahern Rentals, EquipmentShare, The Home Depot Tool Rental, BlueLine Rental, NES Rentals, and any similar fleet-branding wraps or stickers (large fleet ID numbers, '1-800' style asset tags, rental-company logos in non-OEM colours). Where a rental decal is removed, leave the underlying panel surface matching the surrounding panel — do not leave a ghost outline, and do NOT invent or paste any replacement brand decals, logos, or wordmarks (no guessing OEM identity). PRESERVE all OEM manufacturer decals already present (Toyota, Hyster, Yale, Crown, Komatsu, Mitsubishi, Caterpillar, Skyjack, Genie, JLG, Bobcat, etc.), capacity plates, VIN / serial numbers, model badges, and safety stickers — only third-party rental-fleet branding is removed."
  );
}

function buildGuardrails(equipmentType: EquipmentType): string {
  const eq = EQUIPMENT_DISPLAY[equipmentType];
  const anatomy = EQUIPMENT_ANATOMY[equipmentType];
  return [
    "GUARDRAILS — hard constraints:",
    `• Make, model, year, trim level. ${anatomy}`,
    "• Do NOT add lamps, beacons, mirrors, antennas, attachments, or any bolt-on hardware that is not already in the source.",
    "• Do not introduce damage, dents, broken parts, or wear that was not in the source image.",
    `• Never isolate the ${eq} on a white / studio / gradient backdrop. No zoom, crop, rotate, horizon-leveling, or re-posing.`,
  ].join("\n");
}

export interface BuildRegenPromptOptions {
  /** Defaults to "forklift" so existing callers keep working. */
  equipmentType?:        EquipmentType;
  /** Defaults to true (most batches want it). */
  removeRentalBranding?: boolean;
  /** Defaults to true — paint-forks is the Discount Forklift standard
   *  treatment. Caller can pass false to skip the forks sentence. */
  paintForksRedYellowTips?: boolean;
}

/**
 * Compose the full regen prompt from a unified anomaly list. The spine
 * is the refined operator-authored scene description; toggle-driven
 * additions and the anomaly issues list get appended after.
 */
export function buildRegenPrompt(
  unified:  UnifiedAnomalyEntry[],
  options:  BuildRegenPromptOptions = {},
): string {
  const equipmentType           = options.equipmentType           ?? "forklift";
  const removeRentalBranding    = options.removeRentalBranding    ?? true;
  const paintForksRedYellowTips = options.paintForksRedYellowTips ?? true;

  let issuesBlock = "";
  if (unified.length > 0) {
    const severityOrder: Record<AnomalyItem["severity"], number> = {
      high:   0,
      medium: 1,
      low:    2,
    };
    const lines = [...unified]
      .sort((a, b) => severityOrder[a.severity] - severityOrder[b.severity])
      .map(
        (a) =>
          `• Fix [${a.severity.toUpperCase()}] ${a.type} at ${a.location}: ${a.description}`,
      );
    issuesBlock = [
      "ISSUES TO ADDRESS — apply ON TOP of the spine above. Each item below was flagged by an AI scan of this same image:",
      "",
      ...lines,
    ].join("\n");
  }

  const sections: string[] = [
    buildSpine(equipmentType, paintForksRedYellowTips),
  ];
  if (removeRentalBranding) sections.push(buildRentalScrubBlock());
  if (issuesBlock)          sections.push(issuesBlock);
  sections.push(buildGuardrails(equipmentType));
  return sections.join("\n\n");
}

/** Convenience wrapper for callers that have the raw provider-result array. */
export function buildRegenPromptFromResults(
  results: ProviderScanResult[],
  options: BuildRegenPromptOptions = {},
): string {
  return buildRegenPrompt(unifyAnomalies(results), options);
}
