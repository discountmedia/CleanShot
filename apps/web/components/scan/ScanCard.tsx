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
  computeConsensus,
  unifyAnomalies,
  type ConsensusSummary,
  type UnifiedAnomalyEntry,
} from "../../lib/scan-helpers";
import type {
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

const SCAN_PROVIDER_TEXT: Record<ScanProvider, string> = {
  gemini:    "text-blue-300",
  openai:    "text-green-300",
  anthropic: "text-orange-300",
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
    ? "border-green-800/60 bg-green-950/10 opacity-75"
    : rejected
      ? "border-zinc-800 bg-zinc-950/40 opacity-50"
      : "border-zinc-800 bg-zinc-950/60";

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
      <header className="flex items-center justify-between gap-4 px-5 py-3 border-b border-zinc-900 flex-wrap">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <span
            className="font-mono text-sm text-zinc-200 truncate"
            title={scan.filename}
          >
            {scan.filename}
          </span>
        </div>

        <div className="flex items-center gap-3 shrink-0 flex-wrap">
          {isScanning ? (
            <div className="inline-flex items-center gap-2 px-3 py-1.5 rounded-md border border-blue-800 bg-blue-950/60 text-blue-300">
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
                      ? "text-amber-200 bg-amber-800 border-amber-500"
                      : "text-amber-300 hover:text-white bg-amber-950/40 hover:bg-amber-700 border-amber-800 hover:border-amber-600"
                  }`}
                >
                  ↻ Regenerate
                </button>
              )}
              {showApprove && (
                <button
                  type="button"
                  onClick={onApprove}
                  className="text-xs uppercase tracking-[0.18em] font-semibold text-white bg-red-600 hover:bg-red-500 border border-red-500 px-3 py-2 rounded transition-colors"
                >
                  Approve →
                </button>
              )}
              <button
                type="button"
                onClick={onReject}
                title="Reject — don't ship this image"
                aria-label="Reject"
                className="text-xs uppercase tracking-[0.18em] font-semibold text-zinc-500 hover:text-zinc-300 border border-zinc-800 hover:border-zinc-600 px-3 py-2 rounded transition-colors"
              >
                ✕
              </button>
            </div>
          )}

          {approved && (
            <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-green-400 px-3 py-2">
              ✓ Approved → Resize
            </span>
          )}
          {rejected && (
            <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-zinc-500 px-3 py-2">
              ✕ Rejected
            </span>
          )}
        </div>
      </header>

      {/* Body — thumb (left) + anomalies/progress (right) */}
      <div className="p-5">
        <div className="grid grid-cols-[160px_1fr] gap-5 items-start">
          <figure className="relative aspect-square rounded-lg overflow-hidden border border-zinc-800 bg-black">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={scan.thumbnailUrl}
              alt={`${scan.filename} (enhanced)`}
              className="absolute inset-0 w-full h-full object-cover"
            />
            {!isScanning && consensus?.verdict === "pass" && (
              <div className="absolute top-2 right-2 w-6 h-6 rounded-full bg-green-500 flex items-center justify-center">
                <svg className="w-4 h-4 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                </svg>
              </div>
            )}
            {!isScanning && consensus?.verdict === "fail" && (
              <div className="absolute top-2 right-2 w-6 h-6 rounded-full bg-red-500 flex items-center justify-center text-white text-base font-bold">
                ✗
              </div>
            )}
            <div className="absolute inset-x-0 bottom-0 px-2 py-1 bg-linear-to-t from-black/80 to-transparent">
              <span className="text-[9px] font-mono text-zinc-300">enhanced</span>
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
                    <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-zinc-500">
                      Anomalies — unified across providers
                    </span>
                    {unified.length > 0 && (
                      <span className="text-[10px] text-zinc-600 tabular-nums">
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
        className="flex items-center gap-1.5 text-[10px] uppercase tracking-[0.18em] text-zinc-500 hover:text-zinc-300 transition-colors"
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
                  className="rounded-md border border-zinc-800 bg-zinc-900/30 px-2.5 py-1.5 text-[11px] text-zinc-600"
                >
                  {SCAN_PROVIDER_LABELS[p]} — pending
                </div>
              );
            }
            const pct = Math.round(r.confidence * 100);
            const isPass = r.verdict === "pass";
            const barColor =
              pct >= 80 ? "bg-green-500"
              : pct >= 50 ? "bg-yellow-500"
              : "bg-red-500";
            return (
              <div
                key={p}
                className={`rounded-md border px-2.5 py-2 ${
                  isPass ? "border-green-900 bg-green-950/15" : "border-red-900 bg-red-950/15"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className={`text-[10px] font-bold uppercase tracking-[0.16em] ${SCAN_PROVIDER_TEXT[p]}`}>
                    {SCAN_PROVIDER_LABELS[p]}
                  </span>
                  <span className={`text-[10px] font-semibold ${isPass ? "text-green-400" : "text-red-400"}`}>
                    {isPass ? "✓ pass" : "✗ fail"}
                  </span>
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <div className="flex-1 h-1 bg-zinc-800 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full ${barColor}`}
                      style={{ width: `${pct}%` }}
                    />
                  </div>
                  <span className="text-[10px] font-mono text-zinc-400 tabular-nums w-8 text-right">
                    {pct}%
                  </span>
                </div>
                <div className="mt-1 flex items-center justify-between text-[9px] text-zinc-600">
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
