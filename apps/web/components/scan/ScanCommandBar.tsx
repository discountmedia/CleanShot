// apps/web/components/scan/ScanCommandBar.tsx
// Sticky bottom action strip — mirrors the Enhance tab's CommandBar.
// Shows verdict tallies, approved/rejected counts, a min-confidence
// threshold slider, and one primary CTA: "Approve N → Resize".
//
// Eligibility is intentionally narrow: only clean PASS consensus at or
// above the threshold gets bulk-approved. Mixed and fail verdicts are
// excluded regardless of slider — bulk should never approve against AI
// dissent.

interface ScanCommandBarProps {
  passCount:     number;
  mixedCount:    number;
  failCount:     number;
  scanningCount: number;
  approvedCount: number;
  rejectedCount: number;

  /** Number of cards that would be approved by the bulk CTA right now. */
  eligibleCount: number;

  /** 0–1, defaults to 0.80 on first mount; lives in ScanPanel state. */
  threshold:     number;
  onThreshold:   (next: number) => void;

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
  threshold,
  onThreshold,
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
          <label className="flex items-center gap-2">
            <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-zinc-500">
              Min confidence
            </span>
            <input
              type="range"
              min={50}
              max={100}
              step={5}
              value={Math.round(threshold * 100)}
              onChange={(e) => onThreshold(Number(e.target.value) / 100)}
              className="w-24 accent-red-500"
              aria-label="Minimum confidence threshold for bulk approve"
            />
            <span className="text-xs font-mono tabular-nums text-zinc-300 w-9 text-right">
              {Math.round(threshold * 100)}%
            </span>
          </label>

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
