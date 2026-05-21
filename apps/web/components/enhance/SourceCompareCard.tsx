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
  /** Opens the per-variant Flux erase dialog. */
  onErase: (provider: EnhanceProvider) => void;
  /** Opens the per-variant Gemini tweak dialog. */
  onTweak: (provider: EnhanceProvider) => void;
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
  onErase,
  onTweak,
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

      {/* Body — big landscape original on top, 5-col landscape variants
          below. Stacks vertically so the operator can see anomalies on
          the source at a useful size, then scan across the variants to
          pick a winner. */}
      <div className="p-5 space-y-5">
        {/* Original — large landscape. Capped at a sensible max-width so
            the card doesn't dominate ultra-wide screens; centered when
            narrower than the cap. */}
        <figure className="flex flex-col gap-2">
          <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold">
            Original — source photo
          </span>
          {/* Original capped narrower than the variant column so each
              variant in the 2-col grid below comes out ≥85% of the
              original's display width. Math: card body ~1448px →
              variants ~718px each → original max-w-3xl (768px) keeps
              the variant/original ratio at ~93%. */}
          <div className="relative w-full max-w-3xl mx-auto aspect-4/3 rounded-lg overflow-hidden border border-zinc-800 bg-black">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={file.previewUrl}
              alt={`${filename} (original)`}
              className="w-full h-full object-contain"
            />
            <div className="absolute inset-x-0 bottom-0 px-2 py-1 bg-linear-to-t from-black/80 to-transparent">
              <span className="text-[9px] font-mono text-zinc-300">source</span>
            </div>
          </div>
        </figure>

        {/* Variants — 5-column landscape row */}
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

          {/* Variants in a minimum 2-column grid at every breakpoint so
              the operator always sees side-by-side comparison (no
              single-column collapse on mobile). Each variant keeps its
              full landscape aspect; wraps to N/2 rows. Providers not
              enqueued for this file (operator unchecked them in
              ProviderRow before hitting Enhance) are filtered out
              entirely — no "not run" placeholder. */}
          <div className="grid grid-cols-2 gap-3">
            {ENHANCE_PROVIDERS.filter((p) => variants[p] !== undefined).map((p) => {
              const variant = variants[p];
              return (
                <VariantThumb
                  key={p}
                  provider={p}
                  variant={variant}
                  chosen={chosen === p}
                  nowMs={nowMs}
                  onChoose={() => onChoose(p)}
                  onRegen={() => onRetry(p)}
                  onErase={() => onErase(p)}
                  onTweak={() => onTweak(p)}
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

        {/* AI disclaimer — small, low-contrast italic footer. Reminds
            the operator (and anyone shoulder-surfing) that the enhanced
            images are AI-generated representations, not raw photos. The
            backend prompt's HONESTY CONSTRAINT keeps the output close
            to the source, but the disclaimer is the belt to its braces. */}
        <p className="text-[10px] text-zinc-600 italic leading-snug text-center max-w-3xl mx-auto">
          AI-enhanced for clarity — visible defects, dents, and significant
          wear are preserved. Listings should disclose that images may have
          been altered to better represent the unit&apos;s actual appearance.
        </p>
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
  /**
   * Re-runs enhance on this (file, provider) pair. EnhancePanel maps it
   * to `retryProvider`, which is the same handler that powers the
   * failed-variant retry strip — same idempotency-key bump, same eviction
   * of the prior completed/jobStateMap entry. Surfaced here as a small
   * ↻ button on completed thumbs so the operator can regenerate a single
   * variant without unchecking its provider in the ProviderRow.
   */
  onRegen: () => void;
  /**
   * Opens the per-variant Flux erase dialog. EnhancePanel keeps a
   * single dialog instance and uses (fileId, provider) to look up the
   * source asset + URL. Only meaningful when the variant is complete.
   */
  onErase: () => void;
  /**
   * Opens the per-variant Gemini tweak dialog. Same single-instance
   * pattern as Erase, just routes to the text-only TweakDialog
   * instead of the mask-drawing EraseDialog.
   */
  onTweak: () => void;
}

function VariantThumb({ provider, variant, chosen, nowMs, onChoose, onRegen, onErase, onTweak }: VariantThumbProps) {
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

  // The thumb's outer element is a div with role="button" rather than a
  // native <button> so we can safely nest a separate regen <button>
  // inside it without producing invalid HTML (button-in-button).
  const handleSelect = isComplete ? onChoose : undefined;

  return (
    <div
      role="button"
      tabIndex={isComplete ? 0 : -1}
      onClick={handleSelect}
      onKeyDown={(e) => {
        if (!isComplete) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onChoose();
        }
      }}
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
      <div className="relative aspect-4/3 bg-zinc-900">
        {isComplete && variant?.outputUrl && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={variant.outputUrl}
            alt={`${ENHANCE_PROVIDER_LABELS[provider]} variant`}
            className="absolute inset-0 w-full h-full object-contain"
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

        {/* Per-variant tweak — opens the Gemini text-edit dialog.
            Sits between the regen and erase buttons so the operator
            sees the quick-action cluster in a clear "↻ ✎ ⌫" order:
            regen → tweak (text) → erase (mask). */}
        {isComplete && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onTweak();
            }}
            title="Tweak a detail with text (Gemini)"
            aria-label="Open tweak tool for this variant"
            className="absolute top-1.5 left-9 inline-flex items-center justify-center w-6 h-6 rounded-full bg-black/70 hover:bg-blue-700 text-blue-300 hover:text-white border border-blue-800 hover:border-blue-500 transition-colors"
          >
            {/* Pencil / magic-wand icon */}
            <svg
              className="w-3.5 h-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.536L16.732 3.732z"
              />
            </svg>
          </button>
        )}

        {/* Per-variant erase — opens the BFL flux-tools/erase-v1 mask
            dialog. Sits alongside the regen and tweak buttons so the
            operator's quick actions cluster in one corner. */}
        {isComplete && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onErase();
            }}
            title="Erase a detail (Flux mask)"
            aria-label="Open erase tool for this variant"
            className="absolute top-1.5 left-17 inline-flex items-center justify-center w-6 h-6 rounded-full bg-black/70 hover:bg-purple-700 text-purple-300 hover:text-white border border-purple-800 hover:border-purple-500 transition-colors"
          >
            {/* Eraser icon */}
            <svg
              className="w-3.5 h-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M16.862 4.487l3.65 3.65a2 2 0 010 2.828L9.172 22.305H5.025a1 1 0 01-1-1V17.16a2 2 0 01.586-1.414L16.034 4.487a2 2 0 012.828 0z"
              />
              <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l4 4" />
            </svg>
          </button>
        )}

        {/* Per-variant regen — visible on completed thumbs. Re-enqueues
            the same provider via the same retry handler the failed-strip
            uses; the thumb resets to a spinner via EnhancePanel's
            eviction of the old jobId. stopPropagation so the click
            doesn't also trigger the outer "pick winner" select. */}
        {isComplete && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onRegen();
            }}
            title={`Regenerate with ${ENHANCE_PROVIDER_LABELS[provider]}`}
            aria-label={`Regenerate ${ENHANCE_PROVIDER_LABELS[provider]} variant`}
            className="absolute top-1.5 left-1.5 inline-flex items-center justify-center w-6 h-6 rounded-full bg-black/70 hover:bg-amber-700 text-amber-300 hover:text-white border border-amber-800 hover:border-amber-500 transition-colors"
          >
            <svg
              className="w-3.5 h-3.5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
              />
            </svg>
          </button>
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
    </div>
  );
}
