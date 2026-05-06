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
 * (15-min TTL, content-disposition=attachment). We use it directly as the
 * <img src> and as the download <a href> — no preview-url roundtrip needed.
 *
 * "Scan Result" handoff (after Phase 2 v2.4.3):
 *   The worker now registers each derivative as a first-class asset and
 *   returns its asset_id on the job hash as `result_asset_id`. We just
 *   navigate to /scan with that id and the auto-submit flag — the Scan
 *   page picks both up on mount and kicks off the job. No re-upload, no
 *   client-side byte shuffling.
 *
 *   If `result_asset_id` is absent (running against a pre-2.4.3 backend),
 *   the button is hidden — the rest of the result UI works fine. This
 *   means the frontend can deploy ahead of the backend without breaking.
 *
 * Permalink: /jobs/[id] re-polls the backend, so an expired download_url
 * can be refreshed by navigating there.
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
  const resultAssetId = job.result_asset_id ?? null;

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
        {resultAssetId && (
          <Link
            href={`/scan?asset=${encodeURIComponent(resultAssetId)}&auto=1`}
            className="rounded border border-line bg-surface-raised px-4 py-2 text-[11px] font-semibold uppercase tracking-label-loose text-ink hover:border-df-red hover:text-df-red"
          >
            Scan Result
          </Link>
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
