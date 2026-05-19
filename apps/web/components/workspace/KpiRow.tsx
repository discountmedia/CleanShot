// apps/web/components/workspace/KpiRow.tsx
// Default operator-console KPI row for CleanShot's workspace home.
// Real values will come from /api/stats once that endpoint exists; for now the
// numbers are placeholders (rendered as "—") so the layout reads correctly
// without lying about data.

import { KpiCard } from "./KpiCard";

interface KpiRowProps {
  /** When real stats are wired in, pass them here. Missing fields render as "—". */
  stats?: Partial<{
    enhancedToday: number;
    scannedToday: number;
    pendingReview: number;
    storageUsedBytes: number;
    storageLimitBytes: number;
  }>;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)}GB`;
}

export function KpiRow({ stats = {} }: KpiRowProps) {
  const hasStorage = stats.storageUsedBytes !== undefined && stats.storageLimitBytes !== undefined;

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
      <KpiCard
        label="Enhanced today"
        value={stats.enhancedToday ?? 0}
        color="green"
        placeholder={stats.enhancedToday === undefined}
        secondary="images processed"
      />
      <KpiCard
        label="Scanned today"
        value={stats.scannedToday ?? 0}
        color="blue"
        placeholder={stats.scannedToday === undefined}
        secondary="AI verdicts"
      />
      <KpiCard
        label="Pending review"
        value={stats.pendingReview ?? 0}
        color={stats.pendingReview && stats.pendingReview > 0 ? "yellow" : "white"}
        placeholder={stats.pendingReview === undefined}
        secondary="needs human"
      />
      <KpiCard
        label="Storage used"
        value={
          hasStorage
            ? `${formatBytes(stats.storageUsedBytes!)} / ${formatBytes(stats.storageLimitBytes!)}`
            : "—"
        }
        color="white"
        placeholder={!hasStorage}
        secondary="GCS derivatives"
      />
    </div>
  );
}
