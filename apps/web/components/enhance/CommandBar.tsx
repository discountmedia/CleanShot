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

  autoAdvance: boolean;
  /**
   * Primary CTA — fires onSendAll when the operator wants to forward the
   * `readyCount` set in one go. Disabled when nothing's ready.
   */
  onSendAll: () => void;
}

export function CommandBar({
  readyCount,
  workingCount,
  undecidedCount,
  heldCount,
  autoAdvance,
  onSendAll,
}: CommandBarProps) {
  const canSend = readyCount > 0;

  return (
    <section className="sticky bottom-0 mt-2 -mx-6 px-6 py-3 bg-black/95 backdrop-blur border-t border-zinc-900">
      <div className="max-w-screen-2xl mx-auto flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-4 text-xs">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-green-500" />
            <span className="text-zinc-400 tabular-nums">{readyCount} ready</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-blue-500" />
            <span className="text-zinc-400 tabular-nums">{workingCount} working</span>
          </span>
          {undecidedCount > 0 && (
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-red-500" />
              <span className="text-red-400 tabular-nums">
                {undecidedCount} need a pick
              </span>
            </span>
          )}
          {heldCount > 0 && (
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-amber-500" />
              <span className="text-amber-300 tabular-nums">{heldCount} held</span>
            </span>
          )}
        </div>

        <div className="ml-auto flex items-center gap-3">
          {autoAdvance && (
            <span className="text-[11px] text-zinc-500 italic">
              Auto-advance is on — picks send to Scan as they&apos;re made
            </span>
          )}
          <button
            type="button"
            onClick={onSendAll}
            disabled={!canSend}
            className={`text-xs uppercase tracking-[0.18em] font-semibold px-4 py-2 rounded border transition-colors ${
              canSend
                ? "border-red-500 bg-red-600 hover:bg-red-500 text-white"
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
