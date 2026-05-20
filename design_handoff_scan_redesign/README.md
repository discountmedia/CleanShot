# Handoff: Scan tab redesign (5 integrated UX improvements)

## Overview

Five coordinated UX improvements to CleanShot's **Scan** tab, designed to ship together as one PR. They reduce the visual surface area of the consensus review, replace indeterminate progress with real timers, and surface the regenerate prompt as the primary affordance for failed scans.

The five changes:

1. **Consensus-first card layout (highest impact)** — One card per scanned image, with a big `PASS / FAIL / MIXED` pill at the top showing averaged confidence and `N/3` provider agreement. Replaces the current "3 separate provider result cards per image" pattern. Per-provider verdicts collapse behind a "Per-provider verdicts" disclosure.

2. **Deduplicated unified anomaly list** — Anomalies from all 3 providers are grouped by `(type, location-prefix)`. Each entry shows a tick-bar of how many providers flagged it (1/3, 2/3, 3/3) — operators see signal strength at a glance instead of reading the same "rust on overhead guard" three times.

3. **Real per-provider scan progress** — While `state === "scanning"`, replace the indeterminate `@keyframes scanbar` sweep with a per-provider strip showing `{elapsed}s / ~{expected}s` and a percent bar (capped at 95% until completion, snaps to 100% on the actual `complete` event). Uses the same pattern `JobStatusRow` already uses for Enhance.

4. **Inline regenerate panel** — Clicking `↻ Regenerate` expands an inline panel *under the card* with the auto-built prompt (from `buildRegenPrompt`) pre-filled in an editable textarea, a provider picker, and an `↻ Regenerate now` CTA. No modal, no separate route.

5. **Bulk approve at confidence threshold** — Sticky command bar at the bottom of the tab with a confidence slider (default 80%) and a single `Approve N → Resize` CTA that picks up every passing image at or above the threshold.

Plus three smaller patterns ship together:

- **Filter chips** at the top (`All / Pass / Mixed / Fail / Scanning`) with live counts.
- **Sticky command bar** showing pass/mixed/fail/scanning tallies plus the threshold + bulk approve CTA.
- **Approved / rejected cards stay in place** with a washed-out treatment instead of disappearing — the operator can still see what they decided without scrolling history.

---

## About the Design Files

The files in this bundle are **design references created in HTML/React** — high-fidelity prototypes showing intended look and behavior, not production code to copy directly. The task is to **recreate these designs in CleanShot's existing Next.js 16 / React 19 / Tailwind v4 codebase**, reusing established patterns from `apps/web/components/`.

Specifically, do **not**:
- Lift the prototype's mock `INITIAL_SCANS` data — connect to the real `useJobPoller` + `/api/scan/results/[id]` flow already wired in `ScanPanel.tsx`.
- Replace `apps/web/lib/api.ts` calls (`enqueueScanBatch`, `enqueueRegen`, etc.) — those stay.
- Use the prototype's gradient placeholder images — wire to real `outputUrl` values from existing pipeline state.

Do:
- Match the Tailwind class vocabulary exactly — `bg-zinc-950/60`, `border-zinc-800`, `rounded-xl`, `tracking-[0.18em]`, `text-[10px] uppercase font-semibold`, etc.
- Preserve every existing prop + handler on `ScanPanel` — the redesign is an internal restructure. `onSendToResize`, `onClearPipeline`, etc. all stay.
- Reuse `buildRegenPrompt` from `scan/ScanPanel.tsx` for the inline regen panel — it already does the dedup + GUARDRAILS injection correctly.
- Keep the existing `useJobPoller` + scan-result fetch pattern (`/api/scan/results/[jobId]`).

---

## Fidelity

**High-fidelity.** Pixel-perfect mockup using the exact same Tailwind classes the live app uses. Colours, type, spacing, radii, motion durations, and icon style are production-ready as-shown. The only placeholder is the forklift photo — use real signed-URL thumbnails from the existing scan asset.

---

## Files in this bundle

| File | Purpose |
|---|---|
| `mockup/scan-redesign.html` | Static HTML entry — open in a browser to see the prototype |
| `mockup/scan-redesign.jsx` | React prototype source — read this for component breakdown, state shape, and helper functions (`computeConsensus`, `unifyAnomalies`, `buildRegenPrompt`) |
| `mockup/enhance-redesign.html` + `.jsx` | The previous Enhance redesign — shipped or shipping; the Scan redesign assumes the same header + Workspace lifted `autoAdvance` state |
| `assets/discount-forklift-logo.png` | Header logo |
| `colors_and_type.css` | Canonical design tokens — already used by the codebase as Tailwind classes |

---

## Files to modify in the CleanShot codebase

| Path | Change |
|---|---|
| `apps/web/components/scan/ScanPanel.tsx` | **Major refactor.** Replace the 3-providers-per-image card with the new `ScanCard`. See specs below. Keep all existing data flow: `useJobPoller`, scan-result fetch, `enqueueRegen`, `onSendToResize`. |
| `apps/web/components/scan/ScanCard.tsx` | **New file.** The core change — one card per image, consensus-first. |
| `apps/web/components/scan/UnifiedAnomalies.tsx` | **New file.** Deduped anomaly list with `N/3 flagged` signal bars. |
| `apps/web/components/scan/ScanProgressStrip.tsx` | **New file.** Per-provider progress while scanning. |
| `apps/web/components/scan/RegenPanel.tsx` | **New file.** Inline expandable regenerate panel with editable prompt + provider picker. |
| `apps/web/components/scan/ConsensusPill.tsx` | **New file.** PASS / FAIL / MIXED pill with confidence + N/M tally. |
| `apps/web/components/scan/ScanFilterChips.tsx` | **New file.** Filter row above the scan card list. |
| `apps/web/components/scan/ScanCommandBar.tsx` | **New file.** Sticky bottom action strip with threshold slider + bulk approve. |
| `apps/web/lib/scan-helpers.ts` | **New file.** Move `computeConsensus`, `unifyAnomalies` helpers here from `ScanPanel.tsx`. `buildRegenPrompt` already exists in `ScanPanel.tsx` — move it here too for shared use. |
| `apps/web/components/workspace/Workspace.tsx` | **Already touched in Enhance PR** — pass `autoAdvance` down to `ScanPanel` too (the Scan tab uses it to decide whether passes auto-flow to Resize). |

---

## Component spec: `ScanCard`

The most important new component. One card per scanned image.

### Props

```ts
interface ScanCardProps {
  /** The scanned image — from the existing ImageScanState shape in lib/types.ts. */
  scan: {
    id: string;                        // assetId
    filename: string;
    thumbnailUrl: string;              // signed GCS GET URL
    state: "queued" | "scanning" | "complete" | "failed";
    /** Per-provider scan results. Populated by /api/scan/results/[jobId]. */
    providers: Partial<Record<ScanProvider, ProviderScanResult>>;
    /** Per-provider in-flight progress — populated by useJobPoller. */
    progress?: Partial<Record<ScanProvider, { status: "queued" | "scanning" | "complete"; elapsed: number; pct: number }>>;
  };

  /** True if operator has already approved this card (forwarded to Resize). */
  approved: boolean;
  /** True if operator has rejected — card stays visible but washed out. */
  rejected: boolean;

  /** Per-card UI state — owned by ScanPanel so only one regen panel + details open at a time. */
  regenOpen: boolean;
  detailsOpen: boolean;
  onToggleRegen: () => void;
  onToggleDetails: () => void;

  onApprove: () => void;
  onReject: () => void;
  /** Calls enqueueRegen with the prompt+provider from the inline panel. */
  onApplyRegen: (payload: { prompt: string; provider: EnhanceProvider }) => void;
}
```

### Layout

```
┌─ FILENAME.jpg ───────────── ✓ PASS · 3/3 pass · 91% ── [↻ Regen] [Approve →] [✕] ┐
├──────────────────────────────────────────────────────────────────────────────────┤
│                                                                                  │
│ ┌──────┐  ANOMALIES — unified across providers              2 issues             │
│ │      │  ┌────────────────────────────────────────────────────────────┐         │
│ │ THUMB│  │ HIGH · rust · overhead guard            3/3  ━━━           │         │
│ │      │  │ heavy corrosion on overhead protective structure           │         │
│ └──────┘  └────────────────────────────────────────────────────────────┘         │
│           ┌────────────────────────────────────────────────────────────┐         │
│           │ MEDIUM · paint scuff · left fork tip    2/3  ━━            │         │
│           │ minor surface abrasion, cosmetic only                      │         │
│           └────────────────────────────────────────────────────────────┘         │
│                                                                                  │
│           ▸ Per-provider verdicts                                                │
└──────────────────────────────────────────────────────────────────────────────────┘
```

When `state === "scanning"`, the body swaps the anomaly list for a `ScanProgressStrip`. When `regenOpen === true`, an `RegenPanel` slides in below the body (still inside the card).

### Tailwind class manifest

**Outer card (default / approved / rejected):**
```
rounded-xl border overflow-hidden transition-colors

// Default
border-zinc-800 bg-zinc-950/60

// Approved (washed green)
border-green-800/60 bg-green-950/10 opacity-75

// Rejected (dimmed)
border-zinc-800 bg-zinc-950/40 opacity-50
```

**Header row:**
```
flex items-center justify-between gap-4 px-5 py-3 border-b border-zinc-900 flex-wrap
```

**Filename:** `font-mono text-sm text-zinc-200 truncate`

**Body grid:** `p-5` containing `grid grid-cols-[160px_1fr] gap-5 items-start`

**Thumbnail:** `relative aspect-square rounded-lg overflow-hidden border border-zinc-800` with the image as a `<img>` or background. The pass/fail badge sits at `top-2 right-2`.

**Pass badge on thumb:** `w-6 h-6 rounded-full bg-green-500 flex items-center justify-center` + checkmark svg
**Fail badge on thumb:** `w-6 h-6 rounded-full bg-red-500 flex items-center justify-center text-white text-base font-bold` containing `✗`

**Action buttons (right side of header):**
- Approve: `text-xs uppercase tracking-[0.18em] font-semibold text-white bg-red-600 hover:bg-red-500 border border-red-500 px-3 py-2 rounded`
- Regenerate (idle): `text-amber-300 hover:text-white bg-amber-950/40 hover:bg-amber-700 border border-amber-800 hover:border-amber-600`
- Regenerate (panel open): `text-amber-200 bg-amber-800 border-amber-500`
- Reject (✕): `text-zinc-500 hover:text-zinc-300 border border-zinc-800 hover:border-zinc-600 px-3 py-2 rounded`

---

## Component spec: `ConsensusPill`

A single inline-flex element shown to the right of the filename, summarising the consensus.

### Props

```ts
interface ConsensusPillProps {
  consensus: {
    verdict: "pass" | "fail" | "mixed";
    avgConfidence: number;  // 0–1
    passes: number;         // how many providers passed
    total: number;          // how many providers returned a verdict
  } | null;
}
```

### Layout

```
┌──────────────────────────────┐
│ ✓  PASS                      │
│    3/3 pass · 91% avg conf   │
└──────────────────────────────┘
```

### Colour mapping

| Verdict | Icon | Classes |
|---|---|---|
| pass  | ✓ | `text-green-400 bg-green-950/60 border-green-800` |
| fail  | ✗ | `text-red-400 bg-red-950/60 border-red-800` |
| mixed | ◐ | `text-yellow-400 bg-yellow-950/60 border-yellow-800` |

### Outer wrapper

```
inline-flex items-center gap-2 px-3 py-1.5 rounded-md border
```

Icon is `text-base font-bold`. Label + sub-label use `flex flex-col items-start leading-tight` with the label at `text-[11px] font-bold uppercase tracking-[0.18em]` and the sub-label at `text-[10px] opacity-75 tabular-nums`.

---

## Component spec: `UnifiedAnomalies`

Receives the deduplicated anomaly list and renders one row per entry with a tick-bar.

### Props

```ts
interface UnifiedAnomaliesProps {
  unified: Array<{
    type: string;
    location: string;
    severity: "low" | "medium" | "high";
    description: string;
    flaggedBy: Set<ScanProvider>;
  }>;
  totalProviders: number;  // usually 3
}
```

### Empty state

```
┌────────────────────────────────────────────────────────────────────┐
│ No anomalies detected — all providers agree the image is clean.    │
└────────────────────────────────────────────────────────────────────┘
```

Classes: `rounded-md border border-zinc-800 bg-zinc-900/30 px-3 py-2.5 text-xs text-zinc-500 italic`

### Anomaly entry

```
┌────────────────────────────────────────────────────────────────────┐
│ ● HIGH · rust — overhead guard                          3/3 ━━━    │
│   heavy corrosion on overhead protective structure                 │
└────────────────────────────────────────────────────────────────────┘
```

**Severity colour map:**

| Severity | Dot | Text | BG/border |
|---|---|---|---|
| high   | `bg-red-500`    | `text-red-400`    | `bg-red-950/20 border-red-900` |
| medium | `bg-yellow-500` | `text-yellow-400` | `bg-yellow-950/20 border-yellow-900` |
| low    | `bg-zinc-500`   | `text-zinc-400`   | `bg-zinc-900/40 border-zinc-800` |

**Entry layout:**

- Outer: `rounded-md border px-3 py-2` + severity bg/border
- Inner flex: `flex items-start gap-2.5`
- Dot: `mt-1.5 w-1.5 h-1.5 rounded-full shrink-0` + severity dot colour
- Type+location header: `text-[10px] font-bold uppercase tracking-[0.18em]` for severity, `text-xs text-zinc-200 font-medium capitalize` for type, `text-xs text-zinc-500` for location
- Description: `text-xs text-zinc-400 mt-0.5 leading-snug`
- Right-side tick bar: `shrink-0 flex flex-col items-end gap-0.5`
  - Count text: `text-[9px] uppercase tracking-[0.16em] text-zinc-600 tabular-nums` showing `{flagged}/{total}`
  - Ticks: `flex gap-0.5` with N ticks colored at severity dot colour and (total−N) ticks at `bg-zinc-800`. Each tick: `w-3 h-1 rounded-full`.

---

## Component spec: `ScanProgressStrip` (change #3)

Replaces the indeterminate `@keyframes scanbar` per-provider bars during in-flight scans.

### Props

```ts
interface ScanProgressStripProps {
  providers: Partial<Record<ScanProvider, {
    status: "queued" | "scanning" | "complete";
    elapsed: number;   // seconds since the scan job for this provider started
    pct: number;       // 0–100, capped at 95 until status==="complete"
  }>>;
}
```

### Expected durations (extend the existing `EXPECTED_SCAN_PROVIDERS` constant)

```ts
const EXPECTED_SCAN_DURATIONS_S: Record<ScanProvider, number> = {
  gemini:    18,
  openai:    30,
  anthropic: 25,
};
```

### Per-provider row

```
GEMINI    ████████████░░░░░░░░  18s / ~18s   100%
OPENAI    █████████████░░░░░░░  22s / ~30s    73%
ANTHROPIC █████████████░░░░░░░  18s / ~25s    72%
```

Each row:
- Outer: `flex items-center gap-3`
- Label: `text-[11px] font-bold uppercase tracking-[0.16em] w-20` + per-provider text colour (`text-blue-300` for gemini, `text-green-300` for openai, `text-orange-300` for anthropic)
- Bar: `flex-1 h-1.5 bg-zinc-900 rounded-full overflow-hidden` with inner `h-full transition-all duration-500 ease-out bg-blue-500` (or `bg-green-500` once complete)
- Timer: `text-[10px] font-mono text-zinc-500 tabular-nums w-24 text-right` showing `{elapsed}s / ~{expected}s` (zero-padded elapsed seconds)
- Percent: `text-[10px] font-mono tabular-nums w-10 text-right text-blue-400` (or `text-green-400` once complete)

### Percent computation (same pattern as `JobStatusRow`)

```ts
const expectedSeconds = EXPECTED_SCAN_DURATIONS_S[provider];
const estimatedPct = status === "complete"
  ? 100
  : Math.min(95, Math.round((elapsedSeconds / expectedSeconds) * 100));
```

Tick the timer with a `setInterval(() => setNowMs(Date.now()), 1000)` while at least one provider is still scanning. Stop the interval when all three are complete.

---

## Component spec: `RegenPanel` (change #4)

Inline panel that expands under a ScanCard's body when the operator clicks `↻ Regenerate` on a card with `verdict === "fail" || verdict === "mixed"`.

### Props

```ts
interface RegenPanelProps {
  /** Pre-computed by ScanCard via unifyAnomalies(scan.providers). */
  unified: UnifiedAnomalyEntry[];
  /** All enhance providers — operator picks one for the regen run. */
  providersList: EnhanceProvider[];
  defaultProvider: EnhanceProvider;
  onApply: (payload: { prompt: string; provider: EnhanceProvider }) => void;
  onCancel: () => void;
}
```

### Layout

```
┌─ ↻ Regenerate    Auto-built prompt from anomalies — edit before applying        Cancel ┐
├──────────────────────────────────────────────────────────────────────────────────────┤
│ ┌──────────────────────────────────────────────────────────────────────────────────┐ │
│ │ You are editing a photograph of a USED forklift to address SPECIFIC issues       │ │
│ │ detected by AI scan. Fix the listed issues while leaving the rest of the image  │ │
│ │ exactly as-is — same machine, same place, same lighting.                         │ │
│ │                                                                                  │ │
│ │ ISSUES TO ADDRESS:                                                               │ │
│ │ • Fix [HIGH] rust at overhead guard: heavy corrosion on protective structure    │ │
│ │ • Fix [HIGH] missing decals at side: no OEM brand decals visible                │ │
│ │ ...                                                                              │ │
│ └──────────────────────────────────────────────────────────────────────────────────┘ │
│                                                                                       │
│ PROVIDER  [Gemini ▾]  · re-runs Enhance with this prompt        [↻ Regenerate now]   │
└──────────────────────────────────────────────────────────────────────────────────────┘
```

### Tailwind

**Outer:** `rounded-lg border border-amber-900 bg-amber-950/15 overflow-hidden`

**Header:** `flex items-center justify-between px-4 py-2 border-b border-amber-900/50 bg-amber-950/30`

**Title:** `text-[10px] uppercase tracking-[0.18em] font-bold text-amber-300` containing `↻ Regenerate`
**Subtitle:** `text-[10px] text-zinc-500 italic` — "Auto-built prompt from anomalies — edit before applying if needed"

**Body:** `p-4 space-y-3`

**Textarea:** `w-full bg-zinc-950 border border-zinc-800 rounded-md px-3 py-2 text-[12px] font-mono text-zinc-200 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent resize-y leading-relaxed`
- Use `rows={Math.min(12, prompt.split("\n").length + 1)}` for sensible default height.

**Provider select:** `bg-zinc-900 border border-zinc-700 rounded-md px-2.5 py-1.5 text-xs text-white focus:outline-none focus:ring-2 focus:ring-amber-500`

**Apply button:** `text-xs uppercase tracking-[0.18em] font-semibold text-white bg-amber-600 hover:bg-amber-500 border border-amber-500 px-4 py-2 rounded transition-colors`

### Initial prompt

Call the existing `buildRegenPrompt(scanResults)` from `ScanPanel.tsx`. Already does dedup + GUARDRAILS — do **not** rewrite it. Move it into `lib/scan-helpers.ts` for shared use.

### Apply handler

```ts
onApply({ prompt, provider }) → enqueueRegen({
  sessionId,
  assetId: scan.id,
  customPrompt: prompt,
  provider,
  idempotencyKey: `regen-${scan.id}-${Date.now()}`,
});
```

The existing `enqueueRegen` in `lib/api.ts` already supports `customPrompt` + `provider`.

---

## Component spec: `ScanFilterChips`

Top-of-tab filter row.

### Props

```ts
interface ScanFilterChipsProps {
  counts: { all: number; pass: number; mixed: number; fail: number; scanning: number };
  active: "all" | "pass" | "mixed" | "fail" | "scanning";
  onChange: (filter: "all" | "pass" | "mixed" | "fail" | "scanning") => void;
}
```

### Chip styling

- Outer: `flex items-center gap-2 flex-wrap`
- Each chip: `flex items-center gap-2 px-3 py-1.5 rounded-md border text-[11px] font-semibold uppercase tracking-[0.16em] transition-colors disabled:opacity-30 disabled:cursor-not-allowed`
- "All" chip (no verdict colour) — active: `border-red-500 bg-red-950/40 text-red-300` · inactive: `text-zinc-300 border-zinc-700 bg-zinc-900 hover:border-zinc-600`
- Verdict chips (Pass / Mixed / Fail / Scanning) — active: own colour (`text-green-400 border-green-800 bg-green-950/30` etc.) · inactive: `text-zinc-500 border-zinc-800 bg-transparent hover:border-zinc-700`
- Count: `tabular-nums opacity-70`
- Chips with count 0 should be `disabled` (except "All").

---

## Component spec: `ScanCommandBar` (change #5)

Sticky bar at the bottom of the Scan tab. Mirrors the `CommandBar` shipped in the Enhance redesign.

### Props

```ts
interface ScanCommandBarProps {
  scans: ImageScanState[];
  approved: Set<string>;
  rejected: Set<string>;
  threshold: number;  // 0–1, default 0.80
  onThreshold: (n: number) => void;
  onApproveBulk: (ids: string[]) => void;
  autoAdvance: boolean;
}
```

### Layout

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ● 4 pass  ● 2 mixed  ● 1 fail  ● 1 scanning   ·   2 approved · 0 rejected   │
│                                                                              │
│                MIN CONFIDENCE [────●──] 80%        [Approve 4 → Resize]     │
└──────────────────────────────────────────────────────────────────────────────┘
```

### Classes

**Outer:** `sticky bottom-0 -mx-6 px-6 py-3 bg-black/95 backdrop-blur border-t border-zinc-900`
**Inner:** `max-w-screen-2xl mx-auto flex items-center gap-4 flex-wrap`

**Status dots:** `w-2 h-2 rounded-full bg-{green|yellow|red|blue}-500` with adjacent text `text-zinc-400 tabular-nums`

**Threshold slider:** `<input type="range" min={50} max={100} step={5}>` with `className="w-24 accent-red-500"` (no other styling — native control with `accent-color` is sufficient).
**Threshold value:** `text-xs font-mono tabular-nums text-zinc-300 w-9 text-right`

**Auto-advance hint** (when on): `text-[11px] text-zinc-500 italic` — "Auto-advance is on — passes auto-send to Resize"

**Bulk approve CTA** (enabled): `text-xs uppercase tracking-[0.18em] font-semibold px-4 py-2 rounded border border-red-500 bg-red-600 hover:bg-red-500 text-white`
**Bulk approve CTA** (disabled): `border-zinc-800 bg-zinc-950 text-zinc-700 cursor-not-allowed`

### Eligibility computation

```ts
const eligible = scans.filter((s) => {
  if (approved.has(s.id) || rejected.has(s.id) || s.state !== "complete") return false;
  const c = computeConsensus(s.providers);
  return c && c.verdict === "pass" && c.avgConfidence >= threshold;
});
```

Bulk approve only catches **clean passes** at or above the threshold. Mixed and fail verdicts are excluded from bulk approve regardless of threshold — they require an explicit per-card decision. This is intentional: bulk should never approve against AI dissent.

---

## Helper: `computeConsensus`

Move into `apps/web/lib/scan-helpers.ts`.

```ts
export function computeConsensus(
  providers: Partial<Record<ScanProvider, ProviderScanResult>>
): { verdict: "pass" | "fail" | "mixed"; avgConfidence: number; passes: number; total: number } | null {
  const results = Object.values(providers).filter((p): p is ProviderScanResult => p?.verdict != null);
  if (results.length === 0) return null;
  const passes = results.filter((r) => r.verdict === "pass").length;
  const avgConf = results.reduce((a, r) => a + r.confidence, 0) / results.length;
  const verdict =
    passes === results.length ? "pass" :
    passes === 0              ? "fail" :
                                "mixed";
  return { verdict, avgConfidence: avgConf, passes, total: results.length };
}
```

---

## Helper: `unifyAnomalies`

Move into `apps/web/lib/scan-helpers.ts`.

```ts
export interface UnifiedAnomalyEntry {
  type: string;
  location: string;
  severity: "low" | "medium" | "high";
  description: string;
  flaggedBy: Set<ScanProvider>;
}

export function unifyAnomalies(
  providers: Partial<Record<ScanProvider, ProviderScanResult>>
): UnifiedAnomalyEntry[] {
  const map = new Map<string, UnifiedAnomalyEntry>();
  for (const [pid, p] of Object.entries(providers)) {
    if (!p?.anomalies) continue;
    for (const a of p.anomalies) {
      // Normalise location to its first word so "right side", "right side panel",
      // and "right" collapse into one entry.
      const norm = `${a.type.toLowerCase()}::${a.location.split(" ")[0].toLowerCase()}`;
      if (!map.has(norm)) {
        map.set(norm, {
          type: a.type, location: a.location, severity: a.severity,
          description: a.description, flaggedBy: new Set(),
        });
      }
      map.get(norm)!.flaggedBy.add(pid as ScanProvider);
      // Upgrade severity if any provider flagged worse.
      const order = { low: 0, medium: 1, high: 2 };
      if (order[a.severity] > order[map.get(norm)!.severity]) {
        map.get(norm)!.severity = a.severity;
      }
    }
  }
  const sevOrder = { high: 0, medium: 1, low: 2 };
  return Array.from(map.values()).sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]);
}
```

### Dedup-strategy caveat

The `location.split(" ")[0]` normalisation is a heuristic. It collapses:
- "right side" + "right side panel" + "right" → all match on `right`
- "overhead guard" + "overhead" → both match on `overhead`

It may over-collapse on locations like "left" / "right" (e.g. "left fork" and "left mast" both normalise to "left"). If operators report false consolidation, switch to a longer prefix (`split(" ").slice(0, 2).join(" ")`) or to a normalisation table. Don't ship the heuristic without flagging this in the PR description.

---

## Interactions & Behavior

| Interaction | Behavior |
|---|---|
| Operator opens Scan tab | All scanned images render as cards in arrival order. Filter chips default to `All`. Threshold slider defaults to 80%. |
| Scan job is still in flight for an image | Card shows the blue `SCANNING` pill in the header, body shows `ScanProgressStrip` with per-provider timers. Provider rows turn green as they complete individually. |
| All 3 providers complete | Card transitions to the result state. Consensus pill replaces the scanning pill. Anomaly list renders. |
| Click `Approve →` | Card immediately flips to washed-green state ("✓ Approved → Resize"). `onSendToResize([scan])` is called via the existing pipeline. |
| Click `↻ Regenerate` | Inline `RegenPanel` slides in below the body of that card (only one open at a time globally — clicking another card's button closes the first). |
| Edit the prompt textarea | State is local to the panel until apply. Cancel discards changes. |
| Click `↻ Regenerate now` | Calls `enqueueRegen(...)` with the edited prompt + selected provider. Panel collapses. (Once the regen job completes, the operator can re-send to Scan via the Enhance tab's new compare flow.) |
| Click `✕` (reject) | Card flips to dimmed state. Stays visible in the list — not deleted. |
| Drag the threshold slider | `Approve N → Resize` count updates in real time. Only `pass` verdicts at or above the threshold are eligible. |
| Click `Approve 4 → Resize` | `onSendToResize(eligible)` is called. The 4 cards flip to washed-green simultaneously. |
| Toggle Auto-advance ON | A `useEffect` watches for any newly-completed scan with `verdict === "pass" && avgConfidence >= threshold` and auto-approves it. Mixed and fail verdicts stay for review even with auto-advance on. |
| Click a Per-provider verdicts disclosure | Provider detail grid expands inside the card body. Only one card's detail open at a time (single state in ScanPanel). |
| Click a Filter chip | Card list filters. The command bar still shows totals across all (not filtered) for honest tallies. |

---

## State Management

All new state lives in `ScanPanel.tsx`. **No new global stores. No backend changes.**

```ts
const [filter, setFilter] = useState<"all" | "pass" | "mixed" | "fail" | "scanning">("all");
const [threshold, setThreshold] = useState(0.80);                 // 0–1
const [approved, setApproved] = useState<Set<string>>(new Set()); // scan.id (assetId)
const [rejected, setRejected] = useState<Set<string>>(new Set());
const [regenOpenId, setRegenOpenId] = useState<string | null>(null);    // assetId or null
const [detailsOpenId, setDetailsOpenId] = useState<string | null>(null);
```

The existing state stays:
- `imageScans` (or whatever the ImageScanState map is called) — keeps poll results.
- Existing job poller hooks — feeds the per-provider progress object.
- `enqueueRegen` call path — unchanged.

State **removed** from `ScanPanel`:
- The per-image `expandedAnomalies` state (the old "show anomaly detail" toggle) — replaced by unified always-visible list.
- The per-row regen prompt local state on each provider card — replaced by single `RegenPanel` state owned by ScanPanel.

---

## Auto-advance — exact behavior

Defaults `OFF`. State lives in `Workspace` and is passed down — already wired in the Enhance redesign PR.

**When ON:**
- A `useEffect` watches for newly-`complete` scans with `verdict === "pass"` and `avgConfidence >= threshold`. Auto-calls `onSendToResize([scan])` and marks the card approved.
- Mixed and fail verdicts never auto-advance, regardless of threshold. They require operator decision.
- The command bar shows the italic hint: "Auto-advance is on — passes auto-send to Resize".

**When OFF (default):**
- Nothing happens automatically. Operator clicks per-card Approve or uses the bulk command bar.

---

## Design Tokens

All values pulled from the live app — no new tokens.

**Colors (Tailwind classes):**
- Surfaces: `bg-zinc-950/60`, `bg-zinc-900/30`, `bg-zinc-950/40`, `bg-black/95`
- Borders: `border-zinc-900`, `border-zinc-800`, `border-zinc-700`
- Brand red: `bg-red-600`, `bg-red-500`, `border-red-500`, `text-red-300`, `text-red-400`, `bg-red-950/40`, `bg-red-950/60`
- Verdict colours: green (pass), yellow (mixed), red (fail), blue (scanning) — all using `-400 text`, `-950/60 bg`, `-800 border` for the consensus pill; `-500 dot` + `-950/20 bg` + `-900 border` for anomaly entries
- Per-provider colours (already in code): `text-blue-300` for gemini, `text-green-300` for openai, `text-orange-300` for anthropic
- Regen / amber: `bg-amber-950/15`, `border-amber-900`, `text-amber-300`, `bg-amber-600`, `bg-amber-500`

**Typography:**
- Family: Inter (sans), JetBrains Mono (mono) — already loaded.
- Sizes used: `text-[9px]`, `text-[10px]`, `text-[11px]`, `text-xs`, `text-sm`, `text-base`.
- All status pills and labels: `font-semibold uppercase tracking-[0.18em]` (default) or `tracking-[0.16em]` (slightly larger like the tab labels).
- Filenames and timers: `font-mono`.

**Spacing:**
- Card outer padding: `px-5 py-3` (header) + `p-5` (body).
- Card body grid gap: `gap-5`.
- Thumb size: `160px × 160px` (fixed) with `aspect-square`.
- Anomaly list inter-item: `space-y-1.5`.
- Provider detail grid: `grid grid-cols-3 gap-2`.

**Border radius:**
- `rounded` (4px) — tiny pills, status chips, anomaly entries
- `rounded-md` (6px) — buttons, inputs, consensus pill
- `rounded-lg` (8px) — thumbnails, regen panel
- `rounded-xl` (12px) — main scan card (the dominant pattern)

**Motion:**
- `transition-colors` on every interactive element.
- `transition-transform` on the per-provider disclosure caret (rotates 90° when expanded).
- `transition-all duration-500 ease-out` on the per-provider progress bar fills.
- `animate-spin` on the SCANNING pill icon.
- No celebratory animations on approve/reject — just the colour/opacity transition.

---

## Assets

- `discount-forklift-logo.png` — already in `apps/web/public/`. No change.
- No new images, no new icons. All icons are inline `<svg>` with `stroke="currentColor"` (matches existing pattern in `ScanPanel.tsx`).
- The `✓ / ✗ / ◐` glyphs in the consensus pill are Unicode characters, not SVG — matches the existing CleanShot Unicode-icon idiom (see `→`, `↻` already in use).

---

## What NOT to ship in this PR

- **Per-provider expand on mixed verdicts** — the unified anomaly list is enough. If operators want raw provider text, the existing `Per-provider verdicts` disclosure surfaces it.
- **Animated transitions between filter chips** — filter is instant; no fade.
- **Persistent threshold across sessions** — slider resets to 80% on page reload. Operator preference; revisit if usage data shows they re-set it every time.
- **Reject reasoning capture** — `✕` is a single click with no comment field. Defer to a follow-up if a reason becomes useful for analytics.

---

## QA scenarios

| Scenario | Expected |
|---|---|
| Send 5 images to Scan, threshold at 80% | Cards appear as the scan jobs complete. While scanning, body shows ScanProgressStrip with real timers. |
| All 5 pass with ≥80% confidence | `Approve 5 → Resize` lights up red in the command bar. One click sends all 5 to Resize, all 5 cards flip to washed-green. |
| Drag threshold to 95% | Eligible count drops to whichever images pass at ≥95% avg conf. Button label updates live. |
| One image returns mixed verdict | Yellow MIXED pill, both Approve and Regen buttons shown. Not included in bulk approve regardless of threshold. |
| Click Regen on a fail card | Inline RegenPanel expands with the auto-built prompt visible. Operator can edit, pick a provider, click Regenerate now. |
| Open Regen on card A, then click Regen on card B | Card A's panel collapses, card B's opens (single-state regenOpenId). |
| Toggle Auto-advance ON when 3 passes are already complete | All 3 auto-approve immediately and flip green. Future passes auto-approve as they complete. |
| Reject a card | Card dims to 50% opacity, stays in the list, doesn't show in the bulk-approve tally. |
| Open the Per-provider verdicts disclosure | 3-column grid of provider verdict + confidence + anomaly count + elapsed shows. |
| Click a Filter chip with 0 count | Chip is disabled, nothing happens. |

---

## Open questions for the developer

- **`location` normalisation in `unifyAnomalies`** — the `split(" ")[0]` heuristic may over-collapse. Worth shipping a small lookup table of "scene part" canonical names (`overhead`, `mast`, `forks`, `tires`, `counterweight`, `side panel`, etc.) if operators report bad matches. Land the heuristic first; treat the lookup as a follow-up.
- **Auto-advance threshold default** — the prototype uses 80% as both the default threshold AND the eligibility floor. If you want them to be separate (e.g. "always require 90% for auto-advance regardless of slider"), wire that as a second constant. v1: keep them coupled.
- **Reject persistence** — currently rejects are in-tab state only. If the operator switches tabs and comes back, rejects are gone. Acceptable for v1 but consider lifting `rejected` to Workspace if you want it to persist across tab switches.
