// apps/web/components/enhance/CommandBar.tsx
// Sticky bottom action strip — Phase 3 redesign.
//
// Replaces the old "bulk select bar + dual send buttons" footer with a
// single source of truth: counts of ready / working / undecided / held
// images on the left, and one primary CTA on the right (Send N to Scan).
//
// EnhancePanel owns the source-of-truth state; CommandBar just renders.

interface CommandBarProps {
  /** Count of source images with a chosen winner, not held, fully done, not yet sent. */
  readyCount: number;
  /** Count of source images with at least one provider still queued / processing. */
  workingCount: number;
  /** Count of source images that are fully done but have no winner picked yet (and aren't held). */
  undecidedCount: number;
  /** Count of source images the operator explicitly Hold'd. */
  heldCount: number;

  /**
   * Primary CTA — fires onSendAll when the operator wants to forward the
   * `readyCount` set to Scan in one go. Disabled when nothing's ready.
   */
  onSendAll: () => void;
  /**
   * Secondary CTA — fires onSkipScan to bypass Scan and route the same
   * `readyCount` set straight to the Resize tab. Rendered inline with
   * the primary button at matching size. Optional so older callers stay
   * happy.
   */
  onSkipScan?: () => void;
}

export function CommandBar({
  readyCount,
  workingCount,
  undecidedCount,
  heldCount,
  onSendAll,
  onSkipScan,
}: CommandBarProps) {
  const canSend = readyCount > 0;

  // Both CTAs share the same base sizing so they read as a pair —
  // matching height, matching uppercase weight, matching padding.
  const ctaBase =
    "text-sm uppercase tracking-[0.16em] font-bold px-5 py-2.5 rounded border-2 transition-colors whitespace-nowrap";

  return (
    <section className="sticky bottom-0 mt-2 -mx-6 px-6 py-3 bg-black/95 backdrop-blur border-t border-zinc-900">
      <div className="max-w-screen-2xl mx-auto flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-4 text-sm">
          <span className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-green-500" />
            <span className="text-zinc-100 tabular-nums font-bold">{readyCount} ready</span>
          </span>
          <span className="flex items-center gap-2">
            <span className="w-2.5 h-2.5 rounded-full bg-blue-500" />
            <span className="text-zinc-100 tabular-nums font-bold">{workingCount} working</span>
          </span>
          {undecidedCount > 0 && (
            <span className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-red-500" />
              <span className="text-red-300 tabular-nums font-bold">
                {undecidedCount} need a pick
              </span>
            </span>
          )}
          {heldCount > 0 && (
            <span className="flex items-center gap-2">
              <span className="w-2.5 h-2.5 rounded-full bg-amber-500" />
              <span className="text-amber-200 tabular-nums font-bold">{heldCount} held</span>
            </span>
          )}
        </div>

        <div className="ml-auto flex items-center gap-3">
          {/* Skip Scan → Resize = BLUE (skip next step) per the app-wide
              button colour system. */}
          {onSkipScan && (
            <button
              type="button"
              onClick={onSkipScan}
              disabled={!canSend}
              title="Skip the Scan step and send picked winners straight to the Resize tab"
              className={`${ctaBase} ${
                canSend
                  ? "border-blue-500 bg-blue-600 hover:bg-blue-500 text-white"
                  : "border-zinc-800 bg-zinc-950 text-zinc-700 cursor-not-allowed"
              }`}
            >
              Skip Scan → Send {readyCount} to Resize
            </button>
          )}
          {/* Send to Scan = GREEN (proceed to next step). */}
          <button
            type="button"
            onClick={onSendAll}
            disabled={!canSend}
            className={`${ctaBase} ${
              canSend
                ? "border-green-500 bg-green-600 hover:bg-green-500 text-white"
                : "border-zinc-800 bg-zinc-950 text-zinc-700 cursor-not-allowed"
            }`}
          >
            Send {readyCount} to Scan →
          </button>
        </div>
      </div>
    </section>
  );
}
