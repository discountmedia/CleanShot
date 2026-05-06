"use client";

import Link from "next/link";
import type { Job } from "@/lib/types";
import { ModelBadge } from "./ModelBadge";

type Props = {
  job: Job;
};

/**
 * Renders the final Enhance output.
 *
 * Backend's job hash carries `download_url` as a pre-signed HTTPS GET URL
 * (15-min TTL, content-disposition=attachment baked in for the download
 * button). We use it directly as the <img src> and as the download <a href>.
 *
 * If the URL expires while the user is still on the page (sat idle 15+ min),
 * the cached image stays visible but the download button will fail. The
 * escape hatch is the Permalink — navigating to /jobs/[id] re-polls the
 * backend and gets a fresh download_url.
 *
 * Note: there's no "Scan this image" button here. The backend's enhance
 * derivative is a file in the bucket, NOT a registered asset (no separate
 * asset_id is minted). To scan the result, the user would re-upload it on
 * the Scan tab. Add a "scan derivative" feature when the backend registers
 * derivative assets with their own asset_id.
 */
export function EnhanceResult({ job }: Props) {
  if (job.status === "failed") {
    return (
      <div className="rounded border border-status-fail/40 bg-df-red-tint px-4 py-3 text-xs uppercase tracking-label text-status-fail">
        Enhance failed: {job.error ?? "unknown error"}
      </div>
    );
  }
  if (job.status !== "done") return null;

  const previewUrl = job.download_url ?? null;

  return (
    <section className="space-y-4 rounded border border-line bg-surface-card p-5">
      <header className="flex items-center justify-between border-b border-line-subtle pb-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-label-loose text-ink-muted">
          Result
        </h2>
        <ModelBadge model={job.model_used} />
      </header>

      <div className="relative aspect-square w-full overflow-hidden rounded border border-line-subtle bg-surface-raised">
        {previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={previewUrl}
            alt="Enhanced forklift"
            className="h-full w-full object-contain"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-[11px] uppercase tracking-label text-ink-dim">
            No preview URL on this job
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {previewUrl && (
          <a
            href={previewUrl}
            download
            className="rounded bg-df-red px-4 py-2 text-[11px] font-semibold uppercase tracking-label-loose text-white hover:bg-df-red-700"
          >
            Download
          </a>
        )}
        <Link
          href={`/jobs/${job.job_id}`}
          className="ml-auto text-[11px] uppercase tracking-label text-ink-muted hover:text-ink"
        >
          Permalink ↗
        </Link>
      </div>
    </section>
  );
}
