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
import type { InlineScanState } from "../../lib/inline-scan";
import {
  SCAN_PROVIDER_COLOR,
  computeConsensus,
  unifyAnomalies,
} from "../../lib/scan-helpers";
import { ScanProgressStrip } from "../scan/ScanProgressStrip";
import { ForkFramingControls } from "./ForkFramingControls";
import type { ForkVisibility } from "../../lib/recommended-prompt";
import { UnifiedAnomalies } from "../scan/UnifiedAnomalies";

/**
 * Per-variant contrast / saturation. Deliberately NOT the full darkroom —
 * the bulk Modify panel that carried brightness / crop / straighten was
 * removed from the Enhance tab (2026-08-21) in favour of these two controls
 * living on the image they affect.
 *
 * Values are the same multiplicative factors the backend pyvips helper takes
 * (1.0 = neutral), so the CSS-filter preview below is faithful to the bytes
 * the Apply produces.
 */
export interface VariantAdjustment {
  contrast:   number;
  saturation: number;
}

export const NEUTRAL_ADJUSTMENT: VariantAdjustment = {
  contrast:   1.0,
  saturation: 1.0,
};

export function isNeutralAdjustment(a: VariantAdjustment): boolean {
  return a.contrast === 1.0 && a.saturation === 1.0;
}

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
  /**
   * Inline scan state per variant, keyed by provider. Read from the scan the
   * BACKEND already enqueues for every enhance output — see lib/inline-scan.ts.
   * A provider missing from this record simply has no scan to show yet.
   */
  scans: Partial<Record<EnhanceProvider, InlineScanState>>;
  /**
   * Per-image fork framing. Surfaced here as well as on the pre-enhance grid
   * because this is where the failure is actually visible — the operator sees
   * the invented shank or the shortened forks in the output, ticks the box,
   * and hits Retry on that one variant.
   */
  forkVisibility: ForkVisibility;
  onForkVisibilityChange: (next: ForkVisibility) => void;
  /** Operator has rewritten the prompt — drives the degradation note. */
  promptIsCustom: boolean;
  /** False for scissor lifts, which have a platform and no forks. */
  showForkControls: boolean;
  /** Uncommitted contrast / saturation per variant. Missing = neutral. */
  adjustments: Partial<Record<EnhanceProvider, VariantAdjustment>>;
  /** Providers whose adjustment Apply is currently in flight. */
  adjusting: Partial<Record<EnhanceProvider, boolean>>;

  onChoose: (provider: EnhanceProvider | null) => void;
  onToggleHold: () => void;
  onRetry: (provider: EnhanceProvider) => void;
  /** Slider moved — preview only, nothing committed yet. */
  onAdjustChange: (provider: EnhanceProvider, adj: VariantAdjustment) => void;
  /** Commit this variant's adjustment: renders new bytes and replaces the
   *  variant in place, so the export picks it up with no extra step. */
  onAdjustApply: (provider: EnhanceProvider) => void;
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
  scans,
  forkVisibility,
  onForkVisibilityChange,
  promptIsCustom,
  showForkControls,
  adjustments,
  adjusting,
  onChoose,
  onToggleHold,
  onRetry,
  onAdjustChange,
  onAdjustApply,
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

  const filename = file.uploadedFilename ?? file.filename;

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
                <span className="text-attn ml-1">· {failedCount} failed</span>
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
                  : "text-attn bg-panel border-attn"
              }`}
            >
              ★ Best of {judgeResult.rankings.length}
              {winnerRank ? ` · ${winnerRank.score}` : ""}
              {!judgeResult.anyPass ? " · review" : ""}
            </span>
          )}
          {showPickPrompt && (
            <span className="text-xs uppercase tracking-[0.16em] font-bold text-attn bg-panel border border-attn px-2.5 py-1 rounded">
              pick a winner
            </span>
          )}

          <button
            type="button"
            onClick={onToggleHold}
            title={
              held
                ? "Held — excluded from the bulk Send to Scan"
                : "Hold this image (leave it out of the export)"
            }
            aria-pressed={held}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded border-2 text-sm font-bold uppercase tracking-[0.14em] transition-colors ${
              held
                ? "border-attn bg-panel text-attn hover:bg-panel-hi"
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

          {/* Fork framing for THIS photo. Sits under the source image because
              that is what the operator is looking at to decide. Changing it
              affects the next Retry / Re-enhance of this image only. */}
          {showForkControls && (
            <div className="w-full max-w-3xl mx-auto">
              <ForkFramingControls
                value={forkVisibility}
                onChange={onForkVisibilityChange}
                promptIsCustom={promptIsCustom}
              />
            </div>
          )}
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
                  scan={scans[p]}
                  adjustment={adjustments[p] ?? NEUTRAL_ADJUSTMENT}
                  adjusting={adjusting[p] ?? false}
                  onAdjustChange={(adj) => onAdjustChange(p, adj)}
                  onAdjustApply={() => onAdjustApply(p)}
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
            <div className="mt-1 flex flex-col gap-2 rounded border border-attn bg-panel px-4 py-3">
              {failedVariants.map(({ provider, variant }) => (
                <div
                  key={provider}
                  className="flex items-center justify-between gap-3"
                >
                  <div className="text-sm text-attn min-w-0">
                    <span className="font-bold uppercase tracking-[0.14em] text-attn">
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
                    className="shrink-0 text-sm uppercase tracking-[0.14em] font-bold text-attn hover:text-ink bg-panel hover:bg-cta-dark border-2 border-attn hover:border-attn px-3 py-1.5 rounded transition-colors"
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
  /** This variant's inline scan, if the backend's auto-scan has produced one. */
  scan: InlineScanState | undefined;
  /** Uncommitted contrast / saturation for this variant. */
  adjustment: VariantAdjustment;
  /** True while this variant's Apply is in flight. */
  adjusting: boolean;
  onAdjustChange: (adj: VariantAdjustment) => void;
  onAdjustApply: () => void;
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
  scan, adjustment, adjusting,
  onAdjustChange, onAdjustApply,
  onChoose, onRegen, onTweak,
}: VariantThumbProps) {
  // onErase / onIdeogramEdit / onIdeogramInpaint are still ACCEPTED (the parent
  // forwards them and EnhancePanel still owns the dialogs) but are not
  // rendered: the operator asked for a pared-back action set on the variant
  // thumb. Left on the interface as dead-but-harmless plumbing, the same
  // pattern this repo uses for dormant providers -- restoring a tool is
  // re-adding its button, not re-wiring a backend.
  //
  // onRegen came off the thumb in that same pass and is BACK as of 2026-08-21
  // (operator: "the button that is supposed to be present on each image for
  // retry is not visible"). Re-rolling one variant otherwise meant unchecking
  // its provider and re-running the whole batch.
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
            ? "border-attn ring-2 ring-attn/40"
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
            /* Live preview of the pending adjustment. The CSS filter uses the
               same factors the backend pyvips helper takes, so what the
               operator sees here is what Apply bakes in. */
            style={
              isNeutralAdjustment(adjustment)
                ? undefined
                : {
                    filter:
                      `contrast(${adjustment.contrast.toFixed(3)}) ` +
                      `saturate(${adjustment.saturation.toFixed(3)})`,
                  }
            }
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

        {/* Per-variant Retry — restored 2026-08-21 by operator request (see
            the note at the top of this component). Re-enqueues the same
            provider through the same handler the failed-variant strip uses,
            with the CURRENT prompt and toggle state; EnhancePanel evicts the
            old jobId so this thumb falls back to its spinner and the new
            result replaces it in place. stopPropagation so the click doesn't
            also fire the outer "pick winner" select. Styled to match the
            Tweak pill it sits beside. */}
        {isComplete && (
          <div className="group/regen absolute top-2 left-2 z-10">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onRegen();
              }}
              title="Retry — regenerate this image with the current prompt and toggles"
              aria-label={`Retry the ${ENHANCE_PROVIDER_LABELS[provider]} variant`}
              className="inline-flex items-center gap-1.5 h-9 pl-2.5 pr-3 rounded-full bg-cta hover:bg-cta-dark text-white border-2 border-cta hover:border-cta-dark transition-colors shadow-lg"
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
              <span className="text-sm font-bold leading-none">Retry</span>
            </button>
            <span className="pointer-events-none absolute left-0 top-full mt-2 whitespace-nowrap bg-header-bg/95 border border-line rounded-md px-3 py-1.5 text-sm font-bold text-ink-soft shadow-2xl opacity-0 group-hover/regen:opacity-100 transition-opacity duration-150 z-20">
              Regenerate this image — same prompt, same toggles
            </span>
          </div>
        )}

        {/* Per-variant tweak — opens the Gemini text-edit dialog. */}
        {isComplete && (
          <div className="group/tweak absolute top-2 left-28 z-10">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onTweak();
              }}
              title="Tweak with text — small targeted edits (Gemini)"
              aria-label="Open Gemini tweak tool for this variant"
              /* Bright blue with the name spelled out. Deliberately a literal
                 hex rather than a palette token: every house colour is either
                 lime, a purple, a neutral, or red, and the operator asked for
                 this one to read as bright blue and be unmissable. */
              className="inline-flex items-center gap-1.5 h-9 pl-2.5 pr-3 rounded-full bg-[#0A84FF] hover:bg-[#3D9BFF] text-white border-2 border-[#0A84FF] hover:border-[#3D9BFF] transition-colors shadow-lg"
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
              <span className="text-sm font-bold leading-none">Tweak</span>
            </button>
            <span className="pointer-events-none absolute left-0 top-full mt-2 whitespace-nowrap bg-header-bg/95 border border-line rounded-md px-3 py-1.5 text-sm font-bold text-ink-soft shadow-2xl opacity-0 group-hover/tweak:opacity-100 transition-opacity duration-150 z-20">
              Tweak with text — Gemini (&ldquo;remove the propane tank&rdquo;)
            </span>
          </div>
        )}

        {/* Per-variant Ideogram edit — sibling to Tweak (Gemini), routed
            through Ideogram /v1/edit. Cyan accent to read as a sibling
            of the blue Gemini Tweak. */}

        {/* Per-variant erase — opens the BFL flux-tools/erase-v1 mask dialog. */}

        {/* Per-variant Ideogram inpaint — sibling to Flux Erase, routed
            through Ideogram /v1/ideogram-v3/inpaint. Rose accent so it
            visually pairs with the purple Flux eraser. */}

        {/* A second provider pass is in flight (currently: OpenAI handed back a
            portrait image and is being re-run). Without this the thumb just
            sits on its spinner for twice as long and looks hung. */}
        {isProcessing && (variant?.job?.retryCount ?? 0) > 0 && (
          <div className="absolute top-2 right-2 z-10 inline-flex items-center gap-1.5 rounded-full bg-[#0A84FF] px-2.5 py-1 shadow-lg">
            <svg className="w-3 h-3 animate-spin text-white" viewBox="0 0 24 24" fill="none">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
            </svg>
            <span className="text-[11px] font-bold text-white leading-none">Retrying</span>
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
              className="w-6 h-6 text-attn"
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
            <span className="text-[10px] uppercase tracking-[0.16em] text-attn">
              Failed
            </span>
          </div>
        )}

        {chosen && (
          <div className="absolute inset-x-0 bottom-0 bg-cta px-2 py-1 flex items-center justify-center gap-1">
            <span className="text-[9px] uppercase tracking-[0.18em] font-bold text-ink">
              Winner
            </span>
          </div>
        )}
      </div>

      <div
        className={`px-2 py-1.5 flex items-center justify-between border-t ${
          chosen ? "border-attn bg-panel" : "border-line bg-well"
        }`}
      >
        <span
          className={`text-[10px] font-bold uppercase tracking-[0.16em] ${
            chosen ? "text-attn" : "text-ink-soft"
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

      {/* Inline scan verdict — sits with the image it judged instead of on a
          separate tab. Rendered only for completed variants; a variant with no
          scan row yet shows nothing rather than a misleading "waiting". */}
      {isComplete && scan && <VariantScanStrip scan={scan} nowMs={nowMs} />}

      {/* Per-image adjustments. Replaces the bulk darkroom that used to sit at
          the bottom of the page and applied one setting to every winner. */}
      {isComplete && (
        <VariantAdjustments
          adjustment={adjustment}
          adjusting={adjusting}
          onChange={onAdjustChange}
          onApply={onAdjustApply}
        />
      )}
    </div>
  );
}

// ─── Inline scan strip ────────────────────────────────────────

function VariantScanStrip({
  scan,
  nowMs,
}: {
  scan: InlineScanState;
  nowMs: number;
}) {
  const consensus = useMemo(
    () => computeConsensus(scan.providerResults),
    [scan.providerResults],
  );
  const unified = useMemo(
    () => unifyAnomalies(scan.providerResults),
    [scan.providerResults],
  );

  // A failed scan JOB is this variant's problem alone — the other variants in
  // the batch each carry their own job and their own strip.
  if (scan.status === "failed") {
    return (
      <div className="px-2 py-1.5 border-t border-line bg-well">
        <p className="text-sm uppercase tracking-[0.14em] font-bold text-attn">
          Scan failed
        </p>
        {scan.error && (
          <p className="text-[10px] text-ink-soft mt-0.5 leading-snug">{scan.error}</p>
        )}
      </div>
    );
  }

  if (scan.status === "waiting" && scan.providerResults.length === 0) {
    // Same coloured per-provider bars the Scan tab renders, not a generic
    // spinner — the operator can see which vendor is still out from here.
    return (
      <div className="px-2 py-2 border-t border-line bg-well">
        <ScanProgressStrip
          startedMs={scan.startedMs}
          nowMs={nowMs}
          allComplete={false}
        />
      </div>
    );
  }

  if (!consensus) return null;

  const tone =
    consensus.verdict === "pass"
      ? "text-accent"
      : consensus.verdict === "fail"
        ? "text-attn"
        : "text-ink";

  return (
    <details className="border-t border-line bg-well">
      <summary className="px-2 py-1.5 flex items-center justify-between gap-2 cursor-pointer list-none">
        {/* Stepped up the type scale (was text-[10px] / text-[9px]) so the
            verdict is readable from the grid without zooming. Colour, weight
            and the pass/fail tone are unchanged. */}
        <span className={`text-sm uppercase tracking-[0.14em] font-bold ${tone}`}>
          Scan: {consensus.verdict}
          {scan.status === "waiting" && " (partial)"}
        </span>
        <span className="text-xs font-mono text-muted tabular-nums">
          {consensus.passes}/{consensus.total} · {Math.round(consensus.avgConfidence * 100)}%
        </span>
      </summary>
      <div className="px-2 pb-2 space-y-2">
        {/* Per-provider verdicts, each in its own identity colour so the row
            ties back to the bar that was running a moment ago. */}
        <ul className="flex flex-wrap gap-1.5" aria-label="Per-provider verdicts">
          {scan.providerResults.map((r) => (
            <li
              key={r.provider}
              className="text-xs font-bold uppercase tracking-[0.12em] px-2 py-0.5 rounded border bg-panel"
              style={{ color: SCAN_PROVIDER_COLOR[r.provider], borderColor: SCAN_PROVIDER_COLOR[r.provider] }}
            >
              {r.provider} {r.verdict}
            </li>
          ))}
        </ul>
        <UnifiedAnomalies unified={unified} totalProviders={consensus.total} />
      </div>
    </details>
  );
}

// ─── Per-image adjustments ──────────────────────────────────

/**
 * Slider integers map to the same factor ranges the darkroom used, so the
 * backend maths is unchanged: contrast -100..+100 → 0.5..1.5, saturation
 * -100..+100 → 0.0..2.0.
 */
const toContrast   = (v: number) => 1.0 + v / 200;
const toSaturation = (v: number) => 1.0 + v / 100;
const fromContrast   = (f: number) => Math.round((f - 1.0) * 200);
const fromSaturation = (f: number) => Math.round((f - 1.0) * 100);

function VariantAdjustments({
  adjustment,
  adjusting,
  onChange,
  onApply,
}: {
  adjustment: VariantAdjustment;
  adjusting: boolean;
  onChange: (adj: VariantAdjustment) => void;
  onApply: () => void;
}) {
  const neutral = isNeutralAdjustment(adjustment);
  return (
    <div
      className="px-2 py-2 border-t border-line bg-well space-y-1.5"
      /* The thumb's outer element is a role="button" that picks the winner on
         click — without this, dragging a slider would also change the pick. */
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <AdjustSlider
        label="Contrast"
        value={fromContrast(adjustment.contrast)}
        disabled={adjusting}
        onChange={(v) => onChange({ ...adjustment, contrast: toContrast(v) })}
      />
      <AdjustSlider
        label="Saturation"
        value={fromSaturation(adjustment.saturation)}
        disabled={adjusting}
        onChange={(v) => onChange({ ...adjustment, saturation: toSaturation(v) })}
      />
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={onApply}
          disabled={neutral || adjusting}
          className={`text-[10px] uppercase tracking-[0.14em] font-bold px-2.5 py-1 rounded border-2 transition-colors ${
            neutral || adjusting
              ? "border-line bg-panel text-muted cursor-not-allowed"
              : "border-cta bg-cta hover:bg-cta-dark text-white"
          }`}
        >
          {adjusting ? "Applying…" : "Apply"}
        </button>
        {!neutral && !adjusting && (
          <button
            type="button"
            onClick={() => onChange(NEUTRAL_ADJUSTMENT)}
            className="text-[10px] uppercase tracking-[0.14em] font-bold text-ink-soft hover:text-ink"
          >
            Reset
          </button>
        )}
      </div>
    </div>
  );
}

function AdjustSlider({
  label, value, disabled, onChange,
}: {
  label: string;
  value: number;
  disabled: boolean;
  onChange: (v: number) => void;
}) {
  return (
    <label className="flex items-center gap-2">
      <span className="text-[10px] uppercase tracking-[0.12em] font-bold text-ink-soft w-16 shrink-0">
        {label}
      </span>
      <input
        type="range"
        min={-100}
        max={100}
        step={1}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className="flex-1 accent-accent disabled:opacity-50"
      />
      <span className="text-[9px] font-mono text-muted tabular-nums w-8 text-right shrink-0">
        {value > 0 ? `+${value}` : value}
      </span>
    </label>
  );
}
