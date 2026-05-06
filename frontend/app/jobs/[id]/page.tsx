"use client";

import Link from "next/link";
import { use } from "react";
import { useJobPolling } from "@/lib/usePolling";
import { JobProgress } from "@/components/JobProgress";
import { EnhanceResult } from "@/components/EnhanceResult";

export default function JobPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = use(params);
  const polling = useJobPolling(id);
  const job = polling.job;

  return (
    <div className="mx-auto max-w-2xl space-y-5">
      <Link
        href="/"
        className="inline-block text-[11px] uppercase tracking-label text-ink-muted hover:text-ink"
      >
        ← Back to Enhance
      </Link>

      <header className="space-y-2 border-b border-line-subtle pb-4">
        <h1 className="text-sm font-semibold uppercase tracking-label-loose text-ink">
          Job {id.slice(0, 8)}…
        </h1>
        {job && (
          <p className="text-[11px] uppercase tracking-label text-ink-dim">
            Operation: <span className="text-ink">{job.operation}</span>
            <span className="mx-2 text-ink-faint">·</span>
            Created: <span className="text-ink">{new Date(job.created_at).toLocaleString()}</span>
          </p>
        )}
      </header>

      <JobProgress
        job={polling.job}
        error={polling.error}
        isPolling={polling.isPolling}
      />

      {job?.status === "succeeded" && job.operation === "enhance" && (
        <EnhanceResult job={job} />
      )}

      {job?.status === "succeeded" && job.operation === "scan" && (
        <div className="rounded border border-line bg-surface-card p-4">
          <p className="text-sm text-ink">
            Scan result available — open the Scan tab to see the full panel.
          </p>
          <Link
            href="/scan"
            className="mt-3 inline-block text-[11px] font-semibold uppercase tracking-label-loose text-df-red hover:text-df-red-700"
          >
            Go to Scan →
          </Link>
        </div>
      )}

      {job?.status === "succeeded" && job.operation === "resize" && (
        <div className="rounded border border-line bg-surface-card p-4">
          <p className="text-[11px] uppercase tracking-label text-ink-muted">
            Resize complete · result URI:
          </p>
          <code className="mt-2 block break-all rounded border border-line-subtle bg-surface-raised px-2 py-1 text-[11px] text-ink">
            {job.result_uri}
          </code>
        </div>
      )}
    </div>
  );
}
