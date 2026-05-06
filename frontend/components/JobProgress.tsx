"use client";

import type { Job } from "@/lib/types";
import { cx } from "@/lib/utils";

type Props = {
  job: Job | null;
  error: string | null;
  isPolling: boolean;
};

export function JobProgress({ job, error, isPolling }: Props) {
  if (error) {
    return (
      <div className="rounded border border-status-fail/40 bg-df-red-tint px-3 py-2 text-xs uppercase tracking-label text-status-fail">
        Job polling failed: {error}
      </div>
    );
  }
  if (!job && !isPolling) return null;

  const status   = job?.status   ?? "queued";
  const progress = job?.progress ?? 0;
  const message  = job?.message  ?? "Waiting for worker…";

  return (
    <div className="space-y-2 rounded border border-line bg-surface-card p-4">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-label text-ink-muted">
          {statusLabel(status)}
        </span>
        <span className="text-sm font-bold text-ink">{progress}%</span>
      </div>
      <div className="h-1 w-full overflow-hidden rounded-full bg-line">
        <div
          className={cx(
            "h-full transition-all",
            status === "failed" ? "bg-status-fail" : "bg-df-red",
          )}
          style={{ width: `${progress}%` }}
        />
      </div>
      <p className="text-xs text-ink-muted">{message}</p>
    </div>
  );
}

function statusLabel(status: Job["status"]): string {
  switch (status) {
    case "queued":    return "Queued";
    case "running":   return "Running";
    case "succeeded": return "Done";
    case "failed":    return "Failed";
  }
}
