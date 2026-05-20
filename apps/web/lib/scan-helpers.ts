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

// ─── Regen prompt (moved verbatim from ScanPanel.tsx) ────────────────────────
//
// The regen path sends a verbatim `custom_prompt` that bypasses the
// worker's wrapper, so the prompt assembled here must carry the FULL
// enhance treatment instructions on its own. The text below is a
// near-verbatim port of `_build_enhance_prompt` in
// apps/api/src/cleanshot_api/workers/enhance_worker.py
// (master + standard_treatment + guardrails). The only regen-specific
// addition is an "ISSUES TO ADDRESS" block.
//
// If you change one side, change the other — drift here means regen
// quality silently diverges from enhance quality.

const ENHANCE_MASTER = (
  "You are editing a photograph of a USED forklift. The goal is a "
  + "thorough makeover of the SAME machine in the SAME place: clean "
  + "paint, sharp decals, dressed tires — like the unit just rolled "
  + "out of a professional detail bay. The output MUST be visibly "
  + "improved versus the input. A reasonable viewer should be able "
  + "to see at a glance that the machine has been cleaned up. "
  + "\"Used lift with a really good makeover\" — not brand-new from "
  + "factory, not a stock photo, not a studio composite."
);

const ENHANCE_STANDARD_TREATMENT = [
  "STANDARD TREATMENT — apply ALL of the following to every request. These are the changes the output MUST reflect:",
  "",
  "• PAINT REFRESH. Repaint every visibly-worn body panel so the machine looks like it just came out of a professional detail bay. Concretely:",
  "    – Where any panel is currently yellowed, cream-coloured, or dingy white, render it as clean, bright, even white.",
  "    – Where any panel is currently dull, faded, dirty, or chalky red, render it as clean, saturated, evenly painted red.",
  "    – Anywhere you see chips, scratches, scuffs, scrapes, paint loss, oxidation, stains, or dirt streaks, replace those areas with a smooth uniform coat of paint matching the surrounding panel's colour.",
  "  The cab roof, overhead guard, mast, main body, step panels, and counterweight should all visibly look freshly painted in the output. Keep the same colours and the same panel-to-colour mapping — only the surface condition changes.",
  "",
  "• DECAL RESTORATION. Restore every OEM decal, brand logo, capacity sticker, model badge, and safety label to crisp, fully legible condition. Keep their original text, layout, and position. Do not invent new decals, add manufacturer logos that were not present, or change any model / capacity numbering.",
  "",
  "• RUST + CORROSION. Where rust, corrosion, oxidation, or surface pitting is visible, replace those areas with clean painted metal in the surrounding OEM colour. Do NOT add or imply rust or wear that was not in the source.",
  "",
  "• TIRE REFRESH. Clean and refresh the EXISTING tires — darker rubber, no dust or grime, freshly dressed appearance. Keep the same tires (same type, tread, sidewall, wear profile); do NOT swap them for new tires.",
  "",
  "• LIGHTING / EXPOSURE. Lift the deepest shadows just enough to reveal detail, recover any blown highlights, and neutralize obvious colour casts. Keep the scene's original light direction and ambient mood — do NOT replace it with studio lighting.",
].join("\n");

const ENHANCE_GUARDRAILS = [
  "GUARDRAILS — while applying everything above, the following must stay identical to the source. These are limits on HOW you change the image, not reasons to skip the standard treatment:",
  "• Background, floor, walls, surroundings — keep the exact same location. Never isolate the forklift on a white / studio / gradient backdrop. Never blur or replace the scene.",
  "• Lighting direction, ambient colour, and shadow placement. Refresh exposure, but keep the same lighting character.",
  "• Camera angle, framing, distance, proportions. No zoom, crop, rotate, horizon-leveling, or re-posing.",
  "• Make, model, year, trim level. Same mast configuration, fork count, fork length, overhead guard shape, counterweight shape, and tire type.",
  "• Do NOT add lamps, beacons, mirrors, antennas, attachments, or any bolt-on hardware that is not already in the source.",
  "• Every OEM decal, capacity plate, VIN / serial number, and data tag remains present, legible, and unchanged. Do not invent or alter any text, digits, or logos on the machine.",
  "• Do not introduce damage, rust, dents, or wear that was not in the source image.",
].join("\n");

/**
 * Compose the full regen prompt from a unified anomaly list. Accepts the
 * deduped list directly so the caller doesn't have to recompute it; the
 * provider-result form is supported via `buildRegenPromptFromResults`
 * below for callers that already have the array.
 */
export function buildRegenPrompt(unified: UnifiedAnomalyEntry[]): string {
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

  const sections = [ENHANCE_MASTER, ENHANCE_STANDARD_TREATMENT];
  if (issuesBlock) sections.push(issuesBlock);
  sections.push(ENHANCE_GUARDRAILS);
  return sections.join("\n\n");
}

/** Convenience wrapper for callers that have the raw provider-result array. */
export function buildRegenPromptFromResults(results: ProviderScanResult[]): string {
  return buildRegenPrompt(unifyAnomalies(results));
}
