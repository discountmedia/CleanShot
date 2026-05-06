"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { Job } from "@/lib/types";
import { ModelBadge } from "./ModelBadge";
import { getAssetPreviewUrl } from "@/lib/api";

type Props = {
  job: Job;
};

/**
 * Renders the final Enhance output.
 *
 * Pulls the result asset_id from the gs:// path in job.result_uri, then
 * fetches a 15-min signed GET URL via /api/v1/assets/{id}/preview-url for
 * display. The result asset is a derivative — backend creates an asset
 * record per successful job so the same preview-url endpoint serves both
 * originals and outputs.
 */
export function EnhanceResult({ job }: Props) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const resultAssetId = parseAssetIdFromGcs(job.result_uri);

  useEffect(() => {
    if (!resultAssetId) return;
    let cancelled = false;
    void (async () => {
      try {
        const { preview_url } = await getAssetPreviewUrl(resultAssetId);
        if (!cancelled) setPreviewUrl(preview_url);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "preview_failed");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [resultAssetId]);

  if (job.status === "failed") {
    return (
      <div className="rounded border border-status-fail/40 bg-df-red-tint px-4 py-3 text-xs uppercase tracking-label text-status-fail">
        Enhance failed: {job.error ?? "unknown error"}
      </div>
    );
  }
  if (job.status !== "succeeded") return null;

  return (
    <section className="space-y-4 rounded border border-line bg-surface-card p-5">
      <header className="flex items-center justify-between border-b border-line-subtle pb-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-label-loose text-ink-muted">
          Result
        </h2>
        <ModelBadge model={job.model_used} />
      </header>

      {error && (
        <div className="rounded border border-status-fail/40 bg-df-red-tint px-3 py-2 text-xs uppercase tracking-label text-status-fail">
          {error}
        </div>
      )}

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
            Loading preview…
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
            href={`/scan?asset=${encodeURIComponent(resultAssetId)}`}
            className="rounded border border-line bg-surface-raised px-4 py-2 text-[11px] font-semibold uppercase tracking-label-loose text-ink hover:border-line-bright"
          >
            Scan This Image
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

function parseAssetIdFromGcs(uri: string | undefined): string | null {
  if (!uri) return null;
  // gs://bucket/asset_id.ext  →  asset_id
  const m = uri.match(/^gs:\/\/[^/]+\/([^./]+)/);
  return m?.[1] ?? null;
}
