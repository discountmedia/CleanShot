// apps/web/components/scan/ScanCommandBar.tsx
// Sticky bottom action strip — mirrors the Enhance tab's CommandBar.
// Shows verdict tallies, approved/rejected counts, and one primary CTA:
// "Approve N → Export" — approves every undecided card regardless of
// consensus verdict or confidence and queues them into the Save & Export
// section at the bottom of the tab.
//
// Operator's escape hatches: per-card Reject (✕) keeps a card out of
// the bulk action; per-card Approve forwards just that one.

interface ScanCommandBarProps {
  passCount:     number;
  mixedCount:    number;
  failCount:     number;
  scanningCount: number;
  approvedCount: number;
  rejectedCount: number;

  /** Number of cards that would be approved by the bulk CTAs right now. */
  eligibleCount: number;

  /** Bulk-approve handler. Approves every eligible card and queues them for export. */
  onApproveBulk: () => void;
  /**
   * Bulk-approve → Modify handler. Approves every eligible card AND flips
   * to the Modify tab so the operator can darkroom-tweak before final
   * export. Same eligible set as onApproveBulk — only the destination
   * tab differs.
   */
  onApproveBulkModify?: () => void;
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
  onApproveBulkModify,
}: ScanCommandBarProps) {
  const canSend = eligibleCount > 0;

  return (
    <section className="sticky bottom-0 -mx-6 px-6 py-3 bg-header-bg/95 backdrop-blur border-t border-line">
      <div className="max-w-screen-2xl mx-auto flex items-center gap-4 flex-wrap">
        <div className="flex items-center gap-4 text-xs flex-wrap">
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-accent" />
            <span className="text-ink-soft tabular-nums">{passCount} pass</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-accent" />
            <span className="text-ink-soft tabular-nums">{mixedCount} mixed</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-danger" />
            <span className="text-ink-soft tabular-nums">{failCount} fail</span>
          </span>
          {scanningCount > 0 && (
            <span className="flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full bg-panel-hi" />
              <span className="text-ink-soft tabular-nums">{scanningCount} scanning</span>
            </span>
          )}
          <span className="text-muted">·</span>
          <span className="text-ink-faint tabular-nums">
            {approvedCount} approved · {rejectedCount} rejected
          </span>
        </div>

        <div className="ml-auto flex items-center gap-3 flex-wrap">
          {/* Approve → Modify = BLUE secondary path (approve, but route
              through the Modify darkroom first). Approve → Resize below
              is the GREEN primary proceed. Both follow the app-wide
              button colour system. */}
          {onApproveBulkModify && (
            <button
              type="button"
              onClick={onApproveBulkModify}
              disabled={!canSend}
              title="Approve all eligible cards and send them to the Modify tab for darkroom adjustments before Resize"
              className={`text-xs uppercase tracking-[0.18em] font-semibold px-4 py-2 rounded border-2 transition-colors ${
                canSend
                  ? "border-line bg-panel hover:bg-panel-hi text-ink"
                  : "border-line bg-well text-muted cursor-not-allowed"
              }`}
            >
              Approve {eligibleCount} → Modify
            </button>
          )}

          <button
            type="button"
            onClick={onApproveBulk}
            disabled={!canSend}
            className={`text-xs uppercase tracking-[0.18em] font-semibold px-4 py-2 rounded border-2 transition-colors ${
              canSend
                ? "border-cta bg-cta hover:bg-cta-dark text-white"
                : "border-line bg-well text-muted cursor-not-allowed"
            }`}
          >
            Approve {eligibleCount} → Export
          </button>
        </div>
      </div>
    </section>
  );
}
