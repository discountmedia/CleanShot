// apps/web/components/scan/ScanCommandBar.tsx
// Sticky bottom action strip — mirrors the Enhance tab's CommandBar.
// Shows verdict tallies, approved/rejected counts, and one primary CTA:
// "Approve N → Resize" — approves every undecided card regardless of
// consensus verdict or confidence.
//
// Operator's escape hatches: per-card Reject (✕) keeps a card out of
// the bulk action; per-card Approve forwards just that one. Auto-advance
// (when on) still uses the pass-only safety filter so silent background
// approval never auto-ships a fail.

interface ScanCommandBarProps {
  passCount:     number;
  mixedCount:    number;
  failCount:     number;
  scanningCount: number;
  approvedCount: number;
  rejectedCount: number;

  /** Number of cards that would be approved by the bulk CTA right now. */
  eligibleCount: number;

  /** Bulk-approve handler. Receives no args — eligibleCount is the count we'd ship. */
  onApproveBulk: () => void;

  autoAdvance:   boolean;
}

export function ScanCommandBar({
  passCount,
  mixedCount,
  failCount,
  scanningCount,
  approvedCount,
  rejectedCount,
  eligibleCount,
  onApproveBulk,
  autoAdvance,
}: ScanCommandBarProps) {
  const canSend = eligibleCount > 0;

  return (
    <section className="sticky bottom-0 -mx-6 px-6 py-3 bg-black/95 backdrop-blur border-t border-zinc-900">
      <div className="max-w-screen-2xl mx-auto flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-4 text-xs flex-wrap">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-green-500" />
            <span className="text-zinc-400 tabular-nums">{passCount} pass</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-yellow-500" />
            <span className="text-zinc-400 tabular-nums">{mixedCount} mixed</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-red-500" />
            <span className="text-zinc-400 tabular-nums">{failCount} fail</span>
          </span>
          {scanningCount > 0 && (
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-blue-500" />
              <span className="text-blue-300 tabular-nums">{scanningCount} scanning</span>
            </span>
          )}
          <span className="text-zinc-700">·</span>
          <span className="text-zinc-500 tabular-nums">
            {approvedCount} approved · {rejectedCount} rejected
          </span>
        </div>

        <div className="ml-auto flex items-center gap-3 flex-wrap">
          {autoAdvance && (
            <span className="text-[11px] text-zinc-500 italic">
              Auto-advance is on — passes auto-send to Resize
            </span>
          )}

          <button
            type="button"
            onClick={onApproveBulk}
            disabled={!canSend}
            className={`text-xs uppercase tracking-[0.18em] font-semibold px-4 py-2 rounded border transition-colors ${
              canSend
                ? "border-red-500 bg-red-600 hover:bg-red-500 text-white"
                : "border-zinc-800 bg-zinc-950 text-zinc-700 cursor-not-allowed"
            }`}
          >
            Approve {eligibleCount} → Resize
          </button>
        </div>
      </div>
    </section>
  );
}
