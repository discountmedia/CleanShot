"use client";

import { useStore } from "@/lib/store";
import { useJobPolling } from "@/lib/usePolling";
import { UploadZone } from "@/components/UploadZone";
import { EnhanceForm } from "@/components/EnhanceForm";
import { JobProgress } from "@/components/JobProgress";
import { EnhanceResult } from "@/components/EnhanceResult";

export default function EnhancePage() {
  const jobId = useStore((s) => s.jobs.enhance);
  const polling = useJobPolling(jobId);
  const job = polling.job;

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="space-y-6">
        <h1 className="text-[11px] font-semibold uppercase tracking-label-loose text-ink-muted">
          Enhance
        </h1>
        <UploadZone tab="enhance" />
        <EnhanceForm />
      </div>

      <div className="space-y-4">
        <h2 className="text-[11px] font-semibold uppercase tracking-label-loose text-ink-muted">
          Result
        </h2>
        {!jobId && (
          <div className="rounded border border-dashed border-line-subtle bg-surface-card px-6 py-10 text-center">
            <p className="text-[11px] uppercase tracking-label text-ink-dim">
              Upload a photo and submit to see results
            </p>
          </div>
        )}

        <JobProgress
          job={polling.job}
          error={polling.error}
          isPolling={polling.isPolling}
        />

        {job && job.status === "succeeded" && job.operation === "enhance" && (
          <EnhanceResult job={job} />
        )}
      </div>
    </div>
  );
}
