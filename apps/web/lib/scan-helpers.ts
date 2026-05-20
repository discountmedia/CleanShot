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
  forklift:     "forklift",
  scissor_lift: "scissor lift",
  telehandler:  "telehandler",
};

const EQUIPMENT_ANATOMY: Record<EquipmentType, string> = {
  forklift:
    "Same mast configuration, fork count, fork length, overhead guard shape, counterweight shape, and tire type.",
  scissor_lift:
    "Same platform size and handrail pattern, scissor mechanism extension, base / chassis dimensions, drive wheels, and control box position.",
  telehandler:
    "Same boom length and section count, attachment (forks / bucket / lifting jib), outrigger configuration, cab shape, and wheel / tire type.",
};

function buildMaster(equipmentType: EquipmentType): string {
  const eq = EQUIPMENT_DISPLAY[equipmentType];
  return [
    `You are editing a photograph of a USED ${eq}. The goal is to improve presentation — clean look, sharper decals, dressed tires — WITHOUT misrepresenting condition. The output should look like a well-cared-for used unit a buyer would be happy to see in a listing, NOT a brand-new unit straight from the factory.`,
    "",
    "HONESTY CONSTRAINT (critical, legal): visible defects that affect buyer evaluation MUST remain visible. Dents and panel damage stay. Deep scratches stay. Broken or missing parts stay. Significant rust and rust-through stay. Large faded or worn-through paint sections stay. Cracked, deeply-worn, or gouged tires stay. Treat the output like an honest detail-pass on the same used unit — wash, wax, and tidy — NOT a full body restoration. If unsure whether a defect is cosmetic or material, LEAVE IT.",
  ].join("\n");
}

function buildStandardTreatment(
  includeRentalScrub: boolean,
): string {
  const bullets: string[] = [];

  bullets.push(
    "SURFACE CLEAN-UP. Remove dust, dirt, grime, mud splatter, road spray, and surface staining from body panels. Lift cosmetic dullness so the existing paint reads sharper and more saturated. You may tidy up very small scuffs and hairline scratches to read as well-maintained. DO NOT repaint over deep scratches, dents, panel damage, large worn-through patches, faded sections that show actual wear pattern, or anything that materially changes the unit's apparent condition. Keep the same colours and the same panel-to-colour mapping — only the surface dirtiness changes, not the condition.",
  );

  bullets.push(
    "DECAL RESTORATION. Restore every OEM decal, brand logo, capacity sticker, model badge, and safety label to crisp, fully legible condition. Keep their original text, layout, and position. Do not invent new decals, add manufacturer logos that were not present, or change any model / capacity numbering.",
  );

  if (includeRentalScrub) {
    //const makeClean = (make ?? "").trim();
    //const oemRestoration = makeClean
    //  ? ` Where the removed rental branding covered a substantial body panel area that an OEM-shipped ${makeClean} unit would normally carry brand identification on (typical positions: side cab panels, rear counterweight / chassis, mast cross-member or boom side), restore an OEM-style "${makeClean}" brand wordmark or logo in the manufacturer's typical decal style and placement for that make. Do NOT invent capacity numbers, model numbers, serial numbers, or specifications that aren't already visible elsewhere in the source — only the ${makeClean} brand identification.`
    //  : "";

    bullets.push(
      "RENTAL-FLEET BRANDING. Remove decals, stickers, vinyl wraps, painted lettering, and asset-tag numbers that advertise third-party rental fleets. Examples include (non-exhaustive): Sunbelt Rentals, United Rentals, Herc Rentals, Sunstate Equipment, Ahern Rentals, EquipmentShare, The Home Depot Tool Rental, BlueLine Rental, NES Rentals, and any similar fleet-branding wraps or stickers (large fleet ID numbers, '1-800' style asset tags, rental-company logos in non-OEM colours). Where a rental decal is removed, leave the underlying panel surface matching the surrounding panel — do not leave a ghost outline."
      //+ oemRestoration
      + " PRESERVE all OEM manufacturer decals (Toyota, Hyster, Yale, Crown, Komatsu, Mitsubishi, Caterpillar, Skyjack, Genie, JLG, Bobcat, etc.), capacity plates, VIN / serial numbers, model badges, and safety stickers — only third-party rental-fleet branding is removed.",
    );
  }

  bullets.push(
    "SURFACE DIRT + LIGHT OXIDATION. Light surface dust, very superficial oxidation, and dirt staining that read as 'unwashed' may be cleaned. Significant rust, pitting, advanced corrosion, and any rust-through MUST remain visible — these are condition signals buyers rely on, and removing them turns the listing photo into a misleading sale claim.",
  );

  bullets.push(
    "TIRE / WHEEL REFRESH. Wipe surface dust and grime off tires and wheels so the existing rubber reads cleaner. Keep the SAME tires — same type, tread pattern, sidewall, wear profile. Significant tread wear, cuts, gouges, aging cracks, and chunks MUST stay visible. Do not make worn tires look new.",
  );

  bullets.push(
    "LIGHTING / EXPOSURE. Lift the deepest shadows just enough to reveal detail, recover any blown highlights, and neutralize obvious colour casts. Keep the scene's original light direction and ambient mood — do NOT replace it with studio lighting.",
  );

  return [
    "STANDARD TREATMENT — apply each of the following to every request, bounded by the HONESTY CONSTRAINT above:",
    "",
    ...bullets.map((b) => `• ${b}`),
  ].join("\n");
}

function buildGuardrails(equipmentType: EquipmentType): string {
  const eq = EQUIPMENT_DISPLAY[equipmentType];
  const anatomy = EQUIPMENT_ANATOMY[equipmentType];
  return [
    "GUARDRAILS — while applying everything above, the following must stay identical to the source. These are limits on HOW you change the image, not reasons to skip the standard treatment:",
    `• Background, floor, walls, surroundings — keep the exact same location. Never isolate the ${eq} on a white / studio / gradient backdrop. Never blur or replace the scene.`,
    "• Lighting direction, ambient colour, and shadow placement. Refresh exposure, but keep the same lighting character.",
    "• Camera angle, framing, distance, proportions. No zoom, crop, rotate, horizon-leveling, or re-posing.",
    `• Make, model, year, trim level. ${anatomy}`,
    "• Do NOT add lamps, beacons, mirrors, antennas, attachments, or any bolt-on hardware that is not already in the source.",
    "• Every OEM decal, capacity plate, VIN / serial number, and data tag remains present, legible, and unchanged. Do not invent or alter any text, digits, or logos on the machine. (Third-party rental-fleet branding is the one exception — see STANDARD TREATMENT.)",
    "• Do not introduce damage, rust, dents, or wear that was not in the source image.",
    "• HONESTY CONSTRAINT (restated): preserve visible damage, deep wear, dents, panel damage, broken parts, significant rust, and heavy paint failure. The output must not misrepresent the unit's actual condition. This is a detail-pass, not a restoration.",
  ].join("\n");
}

export interface BuildRegenPromptOptions {
  /** Defaults to "forklift" so existing callers keep working. */
  equipmentType?:        EquipmentType;
  /** Defaults to true (most batches want it). */
  removeRentalBranding?: boolean;
  /**
   * OEM make (e.g. "Toyota", "Hyster"). When set, the RENTAL-FLEET
   * BRANDING block instructs the model to restore OEM-style brand
   * decals where rental wraps were stripped. Empty/missing => rental
   * branding is just cleaned off without OEM restoration.
   */
  //make?:                 string | null;
}

/**
 * Compose the full regen prompt from a unified anomaly list. Equipment
 * type and rental-scrub branching come through as options; both default
 * to the production-default behaviour (forklift, rental scrub on).
 */
export function buildRegenPrompt(
  unified:  UnifiedAnomalyEntry[],
  options:  BuildRegenPromptOptions = {},
): string {
  const equipmentType        = options.equipmentType        ?? "forklift";
  const removeRentalBranding = options.removeRentalBranding ?? true;
  //const make                 = options.make                 ?? null;

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
      "ISSUES TO ADDRESS — apply ON TOP of the standard treatment. Each item below was flagged by an AI scan of this same image:",
      "",
      ...lines,
    ].join("\n");
  }

  const sections: string[] = [
    buildMaster(equipmentType),
    buildStandardTreatment(removeRentalBranding),
  ];
  if (issuesBlock) sections.push(issuesBlock);
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
