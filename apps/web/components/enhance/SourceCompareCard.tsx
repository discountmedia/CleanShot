// apps/web/components/enhance/SourceCompareCard.tsx
// One card per uploaded source image. Original on the left, a horizontal
// strip of 5 provider variants on the right. The operator clicks a variant
// to pick the "winner" — the only one that gets forwarded to Scan.
//
// Replaces the previous "N rows × M providers" layout. State is fully
// derived from EnhancePanel — this component does not poll directly.
// EnhancePanel maintains a single jobStateMap and forwards each variant's
// current JobRecord + outputUrl as part of `variants`.

import { useMemo } from "react";

import {
  ENHANCE_PROVIDERS,
  ENHANCE_PROVIDER_LABELS,
  type EnhanceProvider,
} from "../../lib/types-enhance";
import { ENHANCE_PROVIDER_DURATION_S } from "../../lib/pricing";
import type { JobRecord, UploadFile } from "../../lib/types";

/** One provider's slice of state for a single source image. */
export interface SourceVariant {
  jobId: string;
  /** Latest poll record. Undefined while we're still enqueuing. */
  job?: JobRecord;
  /** Signed GET URL — populated once the job completes successfully. */
  outputUrl?: string;
  /** Failure message — populated when status === "failed". */
  error?: string;
}

interface SourceCompareCardProps {
  file: UploadFile;
  variants: Partial<Record<EnhanceProvider, SourceVariant>>;
  chosen: EnhanceProvider | null;
  held: boolean;
  /** Workspace-scoped auto-advance state. Drives the "→ sending to Scan" pill. */
  autoAdvance: boolean;
  /** True once this source has been forwarded to Scan. Hides the card from the active set. */
  sent: boolean;
  /** Monotonic-ish ms tick used for the per-variant progress estimate. */
  nowMs: number;

  onChoose: (provider: EnhanceProvider | null) => void;
  onToggleHold: () => void;
  onRetry: (provider: EnhanceProvider) => void;
}

export function SourceCompareCard({
  file,
  variants,
  chosen,
  held,
  autoAdvance,
  sent,
  nowMs,
  onChoose,
  onToggleHold,
  onRetry,
}: SourceCompareCardProps) {
  // Stable-ordered list of providers that have a variant for this source.
  // Order follows ENHANCE_PROVIDERS so re-renders don't shuffle.
  const variantList = useMemo(
    () =>
      ENHANCE_PROVIDERS.filter((p) => variants[p] !== undefined).map((p) => ({
        provider: p,
        variant:  variants[p]!,
      })),
    [variants],
  );

  const totalCount = variantList.length;
  const completedCount = variantList.filter(
    (v) => v.variant.job?.status === "complete",
  ).length;
  const failedCount = variantList.filter(
    (v) => v.variant.job?.status === "failed" || v.variant.job?.status === "cancelled",
  ).length;
  const allDone = totalCount > 0 && completedCount + failedCount === totalCount;

  const failedVariants = variantList.filter(
    (v) => v.variant.job?.status === "failed" || v.variant.job?.status === "cancelled",
  );

  const willAutoSend = autoAdvance && !held && chosen !== null && allDone && !sent;
  const showWorking = !allDone && totalCount > 0;
  const showPickPrompt = allDone && chosen === null && !held;

  const filename = file.uploadedFilename ?? file.file.name;

  return (
    <article className="rounded-xl border border-zinc-800 bg-zinc-950/60 overflow-hidden">
      {/* Header */}
      <header className="flex items-center justify-between px-5 py-3 border-b border-zinc-900 gap-3">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <span
            className="font-mono text-sm text-zinc-200 truncate"
            title={filename}
          >
            {filename}
          </span>
          {totalCount > 0 && (
            <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-zinc-500 tabular-nums whitespace-nowrap">
              {completedCount}/{totalCount} complete
              {failedCount > 0 && (
                <span className="text-red-400 ml-1">· {failedCount} failed</span>
              )}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {sent && (
            <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-zinc-500 bg-zinc-900 border border-zinc-800 px-2 py-1 rounded">
              ✓ Sent
            </span>
          )}
          {willAutoSend && (
            <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-green-400 bg-green-950/40 border border-green-800 px-2 py-1 rounded">
              → sending to Scan
            </span>
          )}
          {showWorking && (
            <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-blue-400 bg-blue-950/40 border border-blue-800 px-2 py-1 rounded">
              working
            </span>
          )}
          {showPickPrompt && (
            <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-red-400 bg-red-950/40 border border-red-800 px-2 py-1 rounded">
              pick a winner
            </span>
          )}

          <button
            type="button"
            onClick={onToggleHold}
            title={
              held
                ? "Holding — won't auto-advance"
                : "Hold this image (don't auto-send to Scan)"
            }
            aria-pressed={held}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded border text-[10px] font-semibold uppercase tracking-[0.18em] transition-colors ${
              held
                ? "border-amber-700 bg-amber-950/40 text-amber-300 hover:bg-amber-900/40"
                : "border-zinc-800 bg-transparent text-zinc-500 hover:border-zinc-600 hover:text-zinc-300"
            }`}
          >
            <svg
              className="w-3 h-3"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              {held ? (
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z"
                />
              ) : (
                <path strokeLinecap="round" strokeLinejoin="round" d="M10 9v6m4-6v6" />
              )}
            </svg>
            {held ? "Held" : "Hold"}
          </button>
        </div>
      </header>

      {/* Body — original + variants */}
      <div className="p-5">
        <div className="grid grid-cols-[140px_auto_1fr] gap-4 items-start">
          {/* Original thumbnail (uses the local object URL the file picker
              produced — no GCS fetch needed for the source side). */}
          <figure className="flex flex-col gap-2">
            <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold">
              Original
            </span>
            <div className="relative aspect-square rounded-lg overflow-hidden border border-zinc-800 bg-black">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={file.previewUrl}
                alt={`${filename} (original)`}
                className="w-full h-full object-cover"
              />
              <div className="absolute inset-x-0 bottom-0 px-2 py-1 bg-linear-to-t from-black/80 to-transparent">
                <span className="text-[9px] font-mono text-zinc-300">source</span>
              </div>
            </div>
          </figure>

          {/* Arrow */}
          <div className="self-center text-2xl text-zinc-700 pt-6" aria-hidden="true">
            →
          </div>

          {/* Variants */}
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between">
              <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold">
                Enhanced — click a variant to pick the winner
              </span>
              {chosen && (
                <button
                  type="button"
                  onClick={() => onChoose(null)}
                  className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 hover:text-zinc-300"
                >
                  Clear pick
                </button>
              )}
            </div>

            {/* 5-column grid so every variant has a fixed slot whether or
                not it's been enqueued yet. Providers not enqueued for this
                file (e.g. the operator unchecked them mid-batch) render as
                a disabled placeholder so the layout stays stable. */}
            <div className="grid grid-cols-5 gap-2">
              {ENHANCE_PROVIDERS.map((p) => {
                const variant = variants[p];
                return (
                  <VariantThumb
                    key={p}
                    provider={p}
                    variant={variant}
                    chosen={chosen === p}
                    nowMs={nowMs}
                    onChoose={() => onChoose(p)}
                  />
                );
              })}
            </div>

            {/* Failed-variant inline retry strip. Lists every failed variant
                so the operator can address them in one place rather than
                hunting for the red thumb. */}
            {failedVariants.length > 0 && (
              <div className="mt-1 flex flex-col gap-1.5 rounded border border-red-900 bg-red-950/20 px-3 py-2">
                {failedVariants.map(({ provider, variant }) => (
                  <div
                    key={provider}
                    className="flex items-center justify-between gap-3"
                  >
                    <div className="text-[11px] text-red-300 min-w-0">
                      <span className="font-semibold uppercase tracking-[0.16em] text-red-400">
                        {ENHANCE_PROVIDER_LABELS[provider]} failed
                      </span>
                      {variant.error && (
                        <span className="text-zinc-500 ml-2 font-mono truncate inline-block max-w-[40ch] align-bottom">
                          {variant.error}
                        </span>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => onRetry(provider)}
                      className="shrink-0 text-[10px] uppercase tracking-[0.18em] font-semibold text-amber-300 hover:text-white bg-amber-950/40 hover:bg-amber-700 border border-amber-800 hover:border-amber-600 px-2.5 py-1 rounded transition-colors"
                    >
                      ↻ Retry {ENHANCE_PROVIDER_LABELS[provider]}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </article>
  );
}

// ─── Variant thumbnail ─────────────────────────────────────────────────────

interface VariantThumbProps {
  provider: EnhanceProvider;
  variant: SourceVariant | undefined;
  chosen: boolean;
  nowMs: number;
  onChoose: () => void;
}

function VariantThumb({ provider, variant, chosen, nowMs, onChoose }: VariantThumbProps) {
  const status = variant?.job?.status ?? (variant ? "queued" : "idle");
  const isComplete = status === "complete";
  const isProcessing = status === "queued" || status === "processing";
  const isFailed = status === "failed" || status === "cancelled";
  const isIdle = !variant;

  // Time-based progress estimate. Snapshots createdAt; ticks via nowMs
  // (driven by EnhancePanel's 1s interval). Falls back to 5% so the bar
  // isn't a blank line while the job is still queued and we don't yet
  // know its createdAt.
  const expectedSeconds = ENHANCE_PROVIDER_DURATION_S[provider] ?? 30;
  const startedMs = variant?.job?.createdAt
    ? new Date(variant.job.createdAt).getTime()
    : nowMs;
  const elapsedSeconds = Math.max(0, Math.floor((nowMs - startedMs) / 1000));
  const estimatedPct = isComplete
    ? 100
    : isProcessing
      ? Math.max(5, Math.min(95, Math.round((elapsedSeconds / expectedSeconds) * 100)))
      : 0;

  return (
    <button
      type="button"
      onClick={isComplete ? onChoose : undefined}
      disabled={!isComplete}
      aria-pressed={chosen || undefined}
      aria-disabled={!isComplete || undefined}
      className={`group relative flex flex-col items-stretch text-left rounded-lg overflow-hidden border transition-all
        ${
          chosen
            ? "border-red-500 ring-2 ring-red-600/40"
            : "border-zinc-800 hover:border-zinc-600"
        }
        ${isComplete ? "cursor-pointer" : "cursor-default"}`}
    >
      <div className="relative aspect-square bg-zinc-900">
        {isComplete && variant?.outputUrl && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={variant.outputUrl}
            alt={`${ENHANCE_PROVIDER_LABELS[provider]} variant`}
            className="absolute inset-0 w-full h-full object-cover"
          />
        )}

        {isComplete && (
          <div className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-green-500 flex items-center justify-center">
            <svg
              className="w-3 h-3 text-white"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={3}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
        )}

        {isProcessing && (
          <div className="absolute inset-0 bg-black/70 flex flex-col items-center justify-center gap-2">
            <svg className="animate-spin w-5 h-5 text-blue-400" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
            </svg>
            <span className="font-mono text-[10px] text-blue-300 tabular-nums">
              {estimatedPct}%
            </span>
          </div>
        )}

        {isIdle && (
          <div className="absolute inset-0 bg-black/70 flex items-center justify-center">
            <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-600">
              not run
            </span>
          </div>
        )}

        {isFailed && (
          <div className="absolute inset-0 bg-black/80 flex flex-col items-center justify-center gap-1.5 px-2">
            <svg
              className="w-6 h-6 text-red-400"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={1.5}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z"
              />
            </svg>
            <span className="text-[10px] uppercase tracking-[0.16em] text-red-400">
              Failed
            </span>
          </div>
        )}

        {chosen && (
          <div className="absolute inset-x-0 bottom-0 bg-red-600 px-2 py-1 flex items-center justify-center gap-1">
            <span className="text-[9px] uppercase tracking-[0.18em] font-bold text-white">
              Winner
            </span>
          </div>
        )}
      </div>

      <div
        className={`px-2 py-1.5 flex items-center justify-between border-t ${
          chosen ? "border-red-700 bg-red-950/30" : "border-zinc-800 bg-zinc-950"
        }`}
      >
        <span
          className={`text-[10px] font-bold uppercase tracking-[0.16em] ${
            chosen ? "text-red-300" : "text-zinc-300"
          }`}
        >
          {ENHANCE_PROVIDER_LABELS[provider]}
        </span>
        <span className="text-[9px] font-mono text-zinc-600 tabular-nums">
          {isComplete
            ? `${elapsedSeconds}s`
            : isProcessing
              ? "…"
              : "—"}
        </span>
      </div>
    </button>
  );
}
