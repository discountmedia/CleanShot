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
import type { JudgeResult } from "../../lib/api";
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
  /** True once this source has been forwarded to Scan. Hides the card from the active set. */
  sent: boolean;
  /** Monotonic-ish ms tick used for the per-variant progress estimate. */
  nowMs: number;
  /** Auto-pick "best of N" ranking for this source, once the judge has run.
   *  Null when there was nothing to judge (single provider) or it hasn't run. */
  judgeResult: JudgeResult | null;
  /** True while the judge call for this source is in flight. */
  judging: boolean;

  onChoose: (provider: EnhanceProvider | null) => void;
  onToggleHold: () => void;
  onRetry: (provider: EnhanceProvider) => void;
  /** Opens the per-variant Flux erase dialog. */
  onErase: (provider: EnhanceProvider) => void;
  /** Opens the per-variant Gemini tweak dialog. */
  onTweak: (provider: EnhanceProvider) => void;
  /** Opens the per-variant Ideogram text-edit dialog (sibling to Tweak). */
  onIdeogramEdit: (provider: EnhanceProvider) => void;
  /** Opens the per-variant Ideogram inpaint dialog (sibling to Erase). */
  onIdeogramInpaint: (provider: EnhanceProvider) => void;
}

export function SourceCompareCard({
  file,
  variants,
  chosen,
  held,
  sent,
  nowMs,
  judgeResult,
  judging,
  onChoose,
  onToggleHold,
  onRetry,
  onErase,
  onTweak,
  onIdeogramEdit,
  onIdeogramInpaint,
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

  const showWorking = !allDone && totalCount > 0;
  // Suppress the "pick a winner" nudge while the auto-judge is deciding — it
  // will set the winner itself in a moment. If the judge errors (judgeResult
  // stays null, chosen stays null), the nudge reappears as the manual fallback.
  const showPickPrompt = allDone && chosen === null && !held && !judging;

  // Auto-pick badge: show when the judge has run AND the current winner pick
  // is still the one it chose (an operator override clears the badge, since
  // the pick is no longer the judge's). winnerRank carries the score + reason.
  const winnerRank =
    judgeResult?.rankings.find((r) => r.provider === judgeResult.winnerProvider) ?? null;
  const showJudgeBadge =
    judgeResult !== null && chosen !== null && chosen === judgeResult.winnerProvider;

  const filename = file.uploadedFilename ?? file.file.name;

  return (
    <article className="rounded-xl border border-line bg-well/60 overflow-hidden">
      {/* Header */}
      <header className="flex items-center justify-between px-5 py-4 border-b border-line gap-3">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <span
            className="font-mono text-base font-bold text-ink truncate"
            title={filename}
          >
            {filename}
          </span>
          {totalCount > 0 && (
            <span className="text-sm uppercase tracking-[0.14em] font-bold text-ink tabular-nums whitespace-nowrap">
              {completedCount}/{totalCount} complete
              {failedCount > 0 && (
                <span className="text-danger-ink ml-1">· {failedCount} failed</span>
              )}
            </span>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {sent && (
            <span className="text-xs uppercase tracking-[0.16em] font-bold text-ink bg-panel border border-line px-2.5 py-1 rounded">
              ✓ Sent
            </span>
          )}
          {showWorking && (
            <span className="text-xs uppercase tracking-[0.16em] font-bold text-ink-soft bg-panel border border-line px-2.5 py-1 rounded">
              working
            </span>
          )}
          {judging && (
            <span className="flex items-center gap-1.5 text-xs uppercase tracking-[0.16em] font-bold text-accent bg-panel-hi/40 border border-line px-2.5 py-1 rounded">
              <svg className="animate-spin w-3 h-3" viewBox="0 0 24 24" fill="none">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
              </svg>
              judging
            </span>
          )}
          {showJudgeBadge && (
            <span
              title={
                winnerRank
                  ? `Auto-picked best of ${judgeResult.rankings.length}` +
                    ` — ${ENHANCE_PROVIDER_LABELS[judgeResult.winnerProvider as EnhanceProvider] ?? judgeResult.winnerProvider}` +
                    ` (${winnerRank.score}/100${winnerRank.verdict === "fail" ? ", would not list" : ""}).` +
                    (winnerRank.reason ? ` ${winnerRank.reason}` : "") +
                    " — click any variant to override."
                  : undefined
              }
              className={`flex items-center gap-1 text-xs uppercase tracking-[0.16em] font-bold px-2.5 py-1 rounded border ${
                judgeResult.anyPass
                  ? "text-accent bg-panel border-accent"
                  : "text-danger-ink bg-panel border-danger-ink"
              }`}
            >
              ★ Best of {judgeResult.rankings.length}
              {winnerRank ? ` · ${winnerRank.score}` : ""}
              {!judgeResult.anyPass ? " · review" : ""}
            </span>
          )}
          {showPickPrompt && (
            <span className="text-xs uppercase tracking-[0.16em] font-bold text-danger-ink bg-panel border border-danger-ink px-2.5 py-1 rounded">
              pick a winner
            </span>
          )}

          <button
            type="button"
            onClick={onToggleHold}
            title={
              held
                ? "Held — excluded from the bulk Send to Scan"
                : "Hold this image (exclude it from the bulk Send to Scan)"
            }
            aria-pressed={held}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded border-2 text-sm font-bold uppercase tracking-[0.14em] transition-colors ${
              held
                ? "border-danger-ink bg-panel text-danger-ink hover:bg-panel-hi"
                : "border-line bg-transparent text-ink hover:border-ink-faint hover:text-ink"
            }`}
          >
            <svg
              className="w-4 h-4"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2.5}
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
          <span className="text-base uppercase tracking-[0.14em] text-ink font-bold">
            Original — source photo
          </span>
          {/* Original capped narrower than the variant column so each
              variant in the 2-col grid below comes out ≥85% of the
              original's display width. Math: card body ~1448px →
              variants ~718px each → original max-w-3xl (768px) keeps
              the variant/original ratio at ~93%. */}
          <div className="relative w-full max-w-3xl mx-auto aspect-4/3 rounded-lg overflow-hidden border border-line bg-well">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={file.previewUrl}
              alt={`${filename} (original)`}
              className="w-full h-full object-contain"
            />
            <div className="absolute inset-x-0 bottom-0 px-3 py-1.5 bg-linear-to-t from-black/80 to-transparent">
              <span className="text-sm font-mono font-bold text-ink">source</span>
            </div>
          </div>
        </figure>

        {/* Variants — 5-column landscape row */}
        <div className="flex flex-col gap-2">
          <div className="flex items-center justify-between">
            <span className="text-base uppercase tracking-[0.14em] text-ink font-bold">
              Enhanced — click a variant to pick the winner
            </span>
            {chosen && (
              <button
                type="button"
                onClick={() => onChoose(null)}
                className="text-sm uppercase tracking-[0.14em] font-bold text-ink hover:text-ink border border-line hover:border-ink-faint rounded px-3 py-1.5"
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
                  onIdeogramEdit={() => onIdeogramEdit(p)}
                  onIdeogramInpaint={() => onIdeogramInpaint(p)}
                />
              );
            })}
          </div>

          {/* Failed-variant inline retry strip. Lists every failed variant
              so the operator can address them in one place rather than
              hunting for the red thumb. */}
          {failedVariants.length > 0 && (
            <div className="mt-1 flex flex-col gap-2 rounded border border-danger-ink bg-panel px-4 py-3">
              {failedVariants.map(({ provider, variant }) => (
                <div
                  key={provider}
                  className="flex items-center justify-between gap-3"
                >
                  <div className="text-sm text-danger-ink min-w-0">
                    <span className="font-bold uppercase tracking-[0.14em] text-danger-ink">
                      {ENHANCE_PROVIDER_LABELS[provider]} failed
                    </span>
                    {variant.error && (
                      <span className="text-ink-soft ml-2 font-mono truncate inline-block max-w-[40ch] align-bottom">
                        {variant.error}
                      </span>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => onRetry(provider)}
                    className="shrink-0 text-sm uppercase tracking-[0.14em] font-bold text-danger-ink hover:text-ink bg-panel hover:bg-danger-dark border-2 border-danger-ink hover:border-danger-ink px-3 py-1.5 rounded transition-colors"
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
        <p className="text-base text-ink italic leading-relaxed text-center max-w-3xl mx-auto px-4">
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
  /** Ideogram sibling of onTweak — same dialog, Ideogram /v1/edit backend. */
  onIdeogramEdit: () => void;
  /** Ideogram sibling of onErase — same dialog, Ideogram inpaint backend. */
  onIdeogramInpaint: () => void;
}

function VariantThumb({
  provider, variant, chosen, nowMs,
  onChoose, onRegen, onErase, onTweak, onIdeogramEdit, onIdeogramInpaint,
}: VariantThumbProps) {
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
            ? "border-danger-ink ring-2 ring-danger-ink/40"
            : "border-line hover:border-line"
        }
        ${isComplete ? "cursor-pointer" : "cursor-default"}`}
    >
      <div className="relative aspect-4/3 bg-panel">
        {isComplete && variant?.outputUrl && (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={variant.outputUrl}
            alt={`${ENHANCE_PROVIDER_LABELS[provider]} variant`}
            className="absolute inset-0 w-full h-full object-contain"
          />
        )}

        {isComplete && (
          <div className="absolute top-1.5 right-1.5 w-5 h-5 rounded-full bg-accent flex items-center justify-center">
            <svg
              className="w-3 h-3 text-header-bg"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={3}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          </div>
        )}

        {/* Per-variant regen — visible on completed thumbs. Re-enqueues
            the same provider via the same retry handler the failed-strip
            uses; the thumb resets to a spinner via EnhancePanel's
            eviction of the old jobId. stopPropagation so the click
            doesn't also trigger the outer "pick winner" select.

            The three quick-action icons (regen / tweak / erase) cluster in
            the top-left in a clear "↻ ✎ ⌫" order. Each one wraps a `group`
            so a styled hover-tooltip can fade in below the button. */}
        {isComplete && (
          <div className="group/regen absolute top-2 left-2 z-10">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRegen();
              }}
              title={`Regenerate this variant with ${ENHANCE_PROVIDER_LABELS[provider]}`}
              aria-label={`Regenerate ${ENHANCE_PROVIDER_LABELS[provider]} variant`}
              className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-header-bg/80 hover:bg-danger-dark text-danger-ink hover:text-ink border-2 border-danger-ink hover:border-danger-ink transition-colors shadow-lg"
            >
              <svg
                className="w-5 h-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"
                />
              </svg>
            </button>
            <span className="pointer-events-none absolute left-0 top-full mt-2 whitespace-nowrap bg-header-bg/95 border border-danger-ink rounded-md px-3 py-1.5 text-sm font-bold text-danger-ink shadow-2xl opacity-0 group-hover/regen:opacity-100 transition-opacity duration-150 z-20">
              Regenerate — run {ENHANCE_PROVIDER_LABELS[provider]} again
            </span>
          </div>
        )}

        {/* Per-variant tweak — opens the Gemini text-edit dialog. */}
        {isComplete && (
          <div className="group/tweak absolute top-2 left-13 z-10">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onTweak();
              }}
              title="Tweak with text — small targeted edits (Gemini)"
              aria-label="Open Gemini tweak tool for this variant"
              className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-header-bg/80 hover:bg-panel-hi text-ink-soft hover:text-ink border-2 border-line hover:border-line transition-colors shadow-lg"
            >
              {/* Pencil / magic-wand icon */}
              <svg
                className="w-5 h-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.536L16.732 3.732z"
                />
              </svg>
            </button>
            <span className="pointer-events-none absolute left-0 top-full mt-2 whitespace-nowrap bg-header-bg/95 border border-line rounded-md px-3 py-1.5 text-sm font-bold text-ink-soft shadow-2xl opacity-0 group-hover/tweak:opacity-100 transition-opacity duration-150 z-20">
              Tweak with text — Gemini (&ldquo;remove the propane tank&rdquo;)
            </span>
          </div>
        )}

        {/* Per-variant Ideogram edit — sibling to Tweak (Gemini), routed
            through Ideogram /v1/edit. Cyan accent to read as a sibling
            of the blue Gemini Tweak. */}
        {isComplete && (
          <div className="group/ideogram-edit absolute top-2 left-24 z-10">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onIdeogramEdit();
              }}
              title="Edit with text — Ideogram (typography-strong, best for decals)"
              aria-label="Open Ideogram edit tool for this variant"
              className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-header-bg/80 hover:bg-panel-hi text-grey hover:text-ink border-2 border-line hover:border-line transition-colors shadow-lg"
            >
              {/* Type / typography icon — distinguishes Ideogram (text-strong) from Gemini's general pencil */}
              <svg
                className="w-5 h-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M4 6h16M9 6v14M15 6v14"
                />
              </svg>
            </button>
            <span className="pointer-events-none absolute left-0 top-full mt-2 whitespace-nowrap bg-header-bg/95 border border-line rounded-md px-3 py-1.5 text-sm font-bold text-grey shadow-2xl opacity-0 group-hover/ideogram-edit:opacity-100 transition-opacity duration-150 z-20">
              Edit with text — Ideogram (best for decals + signage)
            </span>
          </div>
        )}

        {/* Per-variant erase — opens the BFL flux-tools/erase-v1 mask dialog. */}
        {isComplete && (
          <div className="group/erase absolute top-2 left-35 z-10">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onErase();
              }}
              title="Erase with brush — paint over the area to remove it (Flux)"
              aria-label="Open erase tool for this variant"
              className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-header-bg/80 hover:bg-panel-hi text-grey hover:text-ink border-2 border-line hover:border-line transition-colors shadow-lg"
            >
              {/* Eraser icon */}
              <svg
                className="w-5 h-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M16.862 4.487l3.65 3.65a2 2 0 010 2.828L9.172 22.305H5.025a1 1 0 01-1-1V17.16a2 2 0 01.586-1.414L16.034 4.487a2 2 0 012.828 0z"
                />
                <path strokeLinecap="round" strokeLinejoin="round" d="M13 7l4 4" />
              </svg>
            </button>
            <span className="pointer-events-none absolute left-0 top-full mt-2 whitespace-nowrap bg-header-bg/95 border border-line rounded-md px-3 py-1.5 text-sm font-bold text-grey shadow-2xl opacity-0 group-hover/erase:opacity-100 transition-opacity duration-150 z-20">
              Erase with brush — Flux (paint over what to remove)
            </span>
          </div>
        )}

        {/* Per-variant Ideogram inpaint — sibling to Flux Erase, routed
            through Ideogram /v1/ideogram-v3/inpaint. Rose accent so it
            visually pairs with the purple Flux eraser. */}
        {isComplete && (
          <div className="group/ideogram-inpaint absolute top-2 left-46 z-10">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onIdeogramInpaint();
              }}
              title="Inpaint with brush — Ideogram (typography-strong, best for decals)"
              aria-label="Open Ideogram inpaint tool for this variant"
              className="inline-flex items-center justify-center w-9 h-9 rounded-full bg-header-bg/80 hover:bg-panel-hi text-grey hover:text-ink border-2 border-line hover:border-line transition-colors shadow-lg"
            >
              {/* Brush/paint icon — distinguishes Ideogram inpaint from Flux eraser */}
              <svg
                className="w-5 h-5"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9.53 16.122a3 3 0 00-5.78 1.128 2.25 2.25 0 01-2.4 2.245 4.5 4.5 0 008.4-2.245c0-.399-.078-.78-.22-1.128zm0 0a15.998 15.998 0 003.388-1.62m-5.043-.025a15.994 15.994 0 011.622-3.395m3.42 3.42a15.995 15.995 0 004.764-4.648l3.876-5.814a1.151 1.151 0 00-1.597-1.597L14.146 6.32a15.996 15.996 0 00-4.649 4.763m3.42 3.42a6.776 6.776 0 00-3.42-3.42"
                />
              </svg>
            </button>
            <span className="pointer-events-none absolute left-0 top-full mt-2 whitespace-nowrap bg-header-bg/95 border border-line rounded-md px-3 py-1.5 text-sm font-bold text-grey shadow-2xl opacity-0 group-hover/ideogram-inpaint:opacity-100 transition-opacity duration-150 z-20">
              Inpaint with brush — Ideogram (best for decals + signage)
            </span>
          </div>
        )}

        {isProcessing && (
          <div className="absolute inset-0 bg-header-bg/70 flex flex-col items-center justify-center gap-2">
            <svg className="animate-spin w-5 h-5 text-ink-soft" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
            </svg>
            <span className="font-mono text-[10px] text-ink-soft tabular-nums">
              {estimatedPct}%
            </span>
          </div>
        )}

        {isIdle && (
          <div className="absolute inset-0 bg-header-bg/70 flex items-center justify-center">
            <span className="text-[10px] uppercase tracking-[0.18em] text-muted">
              not run
            </span>
          </div>
        )}

        {isFailed && (
          <div className="absolute inset-0 bg-header-bg/80 flex flex-col items-center justify-center gap-1.5 px-2">
            <svg
              className="w-6 h-6 text-danger-ink"
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
            <span className="text-[10px] uppercase tracking-[0.16em] text-danger-ink">
              Failed
            </span>
          </div>
        )}

        {chosen && (
          <div className="absolute inset-x-0 bottom-0 bg-danger px-2 py-1 flex items-center justify-center gap-1">
            <span className="text-[9px] uppercase tracking-[0.18em] font-bold text-ink">
              Winner
            </span>
          </div>
        )}
      </div>

      <div
        className={`px-2 py-1.5 flex items-center justify-between border-t ${
          chosen ? "border-danger-ink bg-panel" : "border-line bg-well"
        }`}
      >
        <span
          className={`text-[10px] font-bold uppercase tracking-[0.16em] ${
            chosen ? "text-danger-ink" : "text-ink-soft"
          }`}
        >
          {ENHANCE_PROVIDER_LABELS[provider]}
        </span>
        <span className="text-[9px] font-mono text-muted tabular-nums">
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
