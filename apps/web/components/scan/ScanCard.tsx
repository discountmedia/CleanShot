// apps/web/components/scan/ScanCard.tsx
// One card per scanned image — Phase 3 redesign.
//
// Layout: filename + consensus pill + action buttons on the header row;
// thumbnail (left) + unified anomalies / progress strip (right) in the
// body. Per-provider raw verdicts hide behind a "Per-provider verdicts"
// disclosure. The inline RegenPanel slides in below the body when the
// operator clicks ↻ Regenerate.

import { useMemo } from "react";

import {
  SCAN_PROVIDER_COLOR,
  computeConsensus,
  unifyAnomalies,
  type ConsensusSummary,
  type UnifiedAnomalyEntry,
} from "../../lib/scan-helpers";
import type {
  EquipmentType,
  ImageScanState,
  ProviderScanResult,
  ScanProvider,
} from "../../lib/types";
import type { EnhanceProvider } from "../../lib/types-enhance";

import { ConsensusPill } from "./ConsensusPill";
import { UnifiedAnomalies } from "./UnifiedAnomalies";
import { ScanProgressStrip } from "./ScanProgressStrip";
import { RegenPanel } from "./RegenPanel";

// Same fan-out the backend uses (gemini + openai + anthropic), kept here
// for the Per-provider verdicts disclosure render order.
const SCAN_PROVIDERS_ORDER: readonly ScanProvider[] = [
  "gemini",
  "openai",
  "anthropic",
] as const;

const SCAN_PROVIDER_LABELS: Record<ScanProvider, string> = {
  gemini:    "Gemini",
  openai:    "OpenAI",
  anthropic: "Anthropic",
};

export interface ScanCardProps {
  scan: ImageScanState;
  /** True once the operator has approved (forwarded to Resize). */
  approved: boolean;
  /** True once the operator has rejected — card stays visible but dimmed. */
  rejected: boolean;
  /** True iff this card's inline RegenPanel is open. */
  regenOpen:   boolean;
  /** True iff this card's Per-provider verdicts disclosure is expanded. */
  detailsOpen: boolean;

  /**
   * Ms timestamp from the underlying scan job's createdAt. Drives the
   * ScanProgressStrip's elapsed counter while the scan is in flight.
   * Null when the parent hasn't recorded a start time yet.
   */
  scanStartedMs: number | null;
  /** Monotonic-ish ms tick (ScanPanel runs a 1s interval while scanning). */
  nowMs: number;
  /** Equipment category — forwarded to RegenPanel so the seeded prompt
   *  uses the same per-type guardrails Enhance applied originally. */
  equipmentType: EquipmentType;

  onToggleRegen:   () => void;
  onToggleDetails: () => void;
  onApprove:       () => void;
  onReject:        () => void;
  onApplyRegen:    (payload: { prompt: string; provider: EnhanceProvider }) => void;
}

export function ScanCard({
  scan,
  approved,
  rejected,
  regenOpen,
  detailsOpen,
  scanStartedMs,
  nowMs,
  equipmentType,
  onToggleRegen,
  onToggleDetails,
  onApprove,
  onReject,
  onApplyRegen,
}: ScanCardProps) {
  // The scan is "scanning" iff no provider results have landed yet AND it
  // hasn't outright failed. The existing pipeline writes all 3 provider
  // results together when the job completes, so this collapses to "has
  // results vs doesn't" — matches how the prior ImageScanCard rendered.
  const isScanning = scan.providerResults.length === 0;

  const consensus: ConsensusSummary | null = useMemo(
    () => (isScanning ? null : computeConsensus(scan.providerResults)),
    [scan.providerResults, isScanning],
  );
  const unified: UnifiedAnomalyEntry[] = useMemo(
    () => unifyAnomalies(scan.providerResults),
    [scan.providerResults],
  );

  // Approved/rejected get a subtle wash — operators can still scroll past
  // and see what they decided without those cards disappearing from the list.
  const cardOuter = approved
    ? "border-accent/60 bg-panel opacity-75"
    : rejected
      ? "border-line bg-well/40 opacity-50"
      : "border-line bg-well/60";

  const canShowActions = !isScanning && !approved && !rejected;
  const showRegen =
    canShowActions
    && consensus !== null
    && (consensus.verdict === "fail" || consensus.verdict === "mixed");
  const showApprove =
    canShowActions
    && consensus !== null
    && consensus.verdict !== "fail";

  const totalProviders = consensus?.total ?? SCAN_PROVIDERS_ORDER.length;

  return (
    <article
      className={`rounded-xl border overflow-hidden transition-colors ${cardOuter}`}
      aria-label={`Scan result for ${scan.filename}`}
    >
      {/* Header — filename, consensus pill, actions */}
      <header className="flex items-center justify-between gap-4 px-5 py-3 border-b border-line flex-wrap">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <span
            className="font-mono text-sm text-ink truncate"
            title={scan.filename}
          >
            {scan.filename}
          </span>
        </div>

        <div className="flex items-center gap-3 shrink-0 flex-wrap">
          {isScanning ? (
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md border border-line bg-panel text-ink-soft">
              <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
              </svg>
              <span className="text-[11px] font-bold uppercase tracking-[0.18em]">
                Scanning
              </span>
            </div>
          ) : (
            <ConsensusPill consensus={consensus} />
          )}

          {canShowActions && (
            <div className="flex items-center gap-2 flex-wrap">
              {showRegen && (
                <button
                  type="button"
                  onClick={onToggleRegen}
                  aria-pressed={regenOpen}
                  className={`text-xs uppercase tracking-[0.18em] font-semibold transition-colors px-3 py-2 rounded border ${
                    regenOpen
                      ? "text-attn bg-cta border-attn"
                      : "text-attn hover:text-ink bg-panel hover:bg-cta-dark border-attn hover:border-attn"
                  }`}
                >
                  ↻ Regenerate
                </button>
              )}
              {showApprove && (
                <button
                  type="button"
                  onClick={onApprove}
                  className="text-xs uppercase tracking-[0.18em] font-semibold text-white bg-cta hover:bg-cta-dark border border-attn px-3 py-2 rounded transition-colors"
                >
                  Approve →
                </button>
              )}
              <button
                type="button"
                onClick={onReject}
                title="Reject — don't ship this image"
                aria-label="Reject"
                className="text-xs uppercase tracking-[0.18em] font-semibold text-ink-faint hover:text-ink-soft border border-line hover:border-line px-3 py-2 rounded transition-colors"
              >
                ✕
              </button>
            </div>
          )}

          {approved && (
            <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-accent px-3 py-2">
              ✓ Approved → Resize
            </span>
          )}
          {rejected && (
            <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-ink-faint px-3 py-2">
              ✕ Rejected
            </span>
          )}
        </div>
      </header>

      {/* Body — large preview (left) + anomalies/progress (right) */}
      {/* Preview bumped from a 160px-square cover-cropped thumb to a
          ~3x-larger 4:3 landscape frame using object-contain — the
          operator needs to actually SEE the enhanced image to spot
          issues during the scan review, not a postage-stamp slice.
          The minmax() keeps it reasonable on narrower viewports. */}
      <div className="p-5">
        <div className="grid grid-cols-1 md:grid-cols-[minmax(320px,440px)_1fr] gap-5 items-start">
          <figure className="relative aspect-4/3 rounded-lg overflow-hidden border border-line bg-well">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={scan.thumbnailUrl}
              alt={`${scan.filename} (enhanced)`}
              className="absolute inset-0 w-full h-full object-contain"
            />
            {!isScanning && consensus?.verdict === "pass" && (
              <div className="absolute top-2 right-2 w-6 h-6 rounded-full bg-accent flex items-center justify-center">
                <svg className="w-4 h-4 text-header-bg" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
            )}
            {!isScanning && consensus?.verdict === "fail" && (
              <div className="absolute top-2 right-2 w-6 h-6 rounded-full bg-cta flex items-center justify-center text-white text-base font-bold">
                ✗
              </div>
            )}
            <div className="absolute inset-x-0 bottom-0 px-2 py-1 bg-linear-to-t from-black/80 to-transparent">
              <span className="text-[9px] font-mono text-ink-soft">enhanced</span>
            </div>
          </figure>

          <div className="space-y-4 min-w-0">
            {isScanning ? (
              <ScanProgressStrip
                startedMs={scanStartedMs}
                nowMs={nowMs}
                allComplete={false}
              />
            ) : (
              <>
                <div className="space-y-2">
                  <div className="flex items-center justify-between">
                    <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-ink-faint">
                      Anomalies — unified across providers
                    </span>
                    {unified.length > 0 && (
                      <span className="text-[10px] text-muted tabular-nums">
                        {unified.length} issue{unified.length !== 1 ? "s" : ""}
                      </span>
                    )}
                  </div>
                  <UnifiedAnomalies
                    unified={unified}
                    totalProviders={totalProviders}
                  />
                </div>

                <ProviderDetail
                  providerResults={scan.providerResults}
                  expanded={detailsOpen}
                  onToggle={onToggleDetails}
                />
              </>
            )}
          </div>
        </div>

        {regenOpen && !isScanning && (
          <div className="mt-4">
            <RegenPanel
              unified={unified}
              equipmentType={equipmentType}
              onApply={onApplyRegen}
              onCancel={onToggleRegen}
            />
          </div>
        )}
      </div>
    </article>
  );
}

// ─── Per-provider verdicts disclosure ───────────────────────────────────────

interface ProviderDetailProps {
  providerResults: ProviderScanResult[];
  expanded:        boolean;
  onToggle:        () => void;
}

function ProviderDetail({ providerResults, expanded, onToggle }: ProviderDetailProps) {
  const byProvider = new Map<ScanProvider, ProviderScanResult>();
  for (const r of providerResults) byProvider.set(r.provider, r);

  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={expanded}
        className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-ink-faint hover:text-ink-soft transition-colors"
      >
        <svg
          className={`w-3 h-3 transition-transform ${expanded ? "rotate-90" : ""}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
        </svg>
        Per-provider verdicts
      </button>

      {expanded && (
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {SCAN_PROVIDERS_ORDER.map((p) => {
            const r = byProvider.get(p);
            if (!r) {
              return (
                <div
                  key={p}
                  className="rounded-md border border-line bg-panel/30 px-2.5 py-1.5 text-[11px] text-muted"
                >
                  {SCAN_PROVIDER_LABELS[p]} — pending
                </div>
              );
            }
            const pct = Math.round(r.confidence * 100);
            const isPass = r.verdict === "pass";
            const barColor =
              pct >= 80 ? "bg-accent"
              : pct >= 50 ? "bg-accent"
              : "bg-cta";
            return (
              <div
                key={p}
                className={`rounded-md border px-2.5 py-2 ${
                  isPass ? "border-accent bg-panel" : "border-attn bg-panel"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  {/* Same identity colour the progress bar used, so the
                      per-provider verdict rows stay tied to the vendor that
                      produced them. */}
                  {/* Stepped up one notch with the rest of the scan verdict
                      text. Colour, weight and the pass/fail glyphs unchanged. */}
                  <span
                    className="text-xs font-bold uppercase tracking-[0.16em]"
                    style={{ color: SCAN_PROVIDER_COLOR[p] }}
                  >
                    {SCAN_PROVIDER_LABELS[p]}
                  </span>
                  <span className={`text-xs font-semibold ${isPass ? "text-accent" : "text-attn"}`}>
                    {isPass ? "✓ pass" : "✗ fail"}
                  </span>
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <div className="flex-1 h-1 bg-panel-hi rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full ${barColor}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="text-[10px] font-mono text-ink-soft tabular-nums w-8 text-right">
                    {pct}%
                  </span>
                </div>
                <div className="mt-1 flex items-center justify-between text-[9px] text-muted">
                  <span>{r.anomalies?.length ?? 0} flagged</span>
                  <span className="font-mono tabular-nums">{r.latencyMs}ms</span>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
