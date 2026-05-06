"use client";

import { useState } from "react";
import { useStore } from "@/lib/store";
import { useJobPolling } from "@/lib/usePolling";
import { UploadZone } from "@/components/UploadZone";
import { JobProgress } from "@/components/JobProgress";
import { enqueueResize } from "@/lib/api";
import type { ResizeFormat, ResizePreset } from "@/lib/types";
import { cx } from "@/lib/utils";

const PRESETS: { value: ResizePreset; label: string; hint: string }[] = [
  { value: "marketplace_1024", label: "Marketplace 1024", hint: "Square · 1024×1024" },
  { value: "marketplace_1200", label: "Marketplace 1200", hint: "Square · 1200×1200" },
  { value: "hero_1920_1080",   label: "Hero 1920×1080",   hint: "16:9 · dealer site" },
  { value: "square_1080",      label: "Social 1080",      hint: "Square · 1080×1080" },
];

export default function ResizePage() {
  const session_id = useStore((s) => s.session_id);
  const activeId   = useStore((s) => s.active.resize);
  const jobId      = useStore((s) => s.jobs.resize);
  const setJob     = useStore((s) => s.setJob);

  const polling = useJobPolling(jobId);
  const [preset, setPreset]         = useState<ResizePreset>("marketplace_1024");
  const [format, setFormat]         = useState<ResizeFormat>("webp");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError]           = useState<string | null>(null);

  async function onSubmit() {
    if (!session_id || !activeId) return;
    setSubmitting(true);
    setError(null);
    try {
      const { job_id } = await enqueueResize({
        session_id,
        asset_id: activeId,
        preset,
        format,
      });
      setJob("resize", job_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "resize_failed");
    } finally {
      setSubmitting(false);
    }
  }

  const ready = !!session_id && !!activeId && !submitting;

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="space-y-6">
        <h1 className="text-[11px] font-semibold uppercase tracking-label-loose text-ink-muted">
          Resize
        </h1>
        <UploadZone tab="resize" />

        <section className="space-y-5 rounded border border-line bg-surface-card p-5">
          <h2 className="border-b border-line-subtle pb-3 text-[11px] font-semibold uppercase tracking-label-loose text-ink-muted">
            Preset
          </h2>

          <div className="grid grid-cols-2 gap-2">
            {PRESETS.map((p) => (
              <button
                key={p.value}
                type="button"
                onClick={() => setPreset(p.value)}
                className={cx(
                  "rounded border px-3 py-2 text-left transition-colors",
                  preset === p.value
                    ? "border-df-red bg-df-red-tint"
                    : "border-line bg-surface-raised hover:border-line-bright",
                )}
              >
                <div className={cx(
                  "text-xs font-semibold uppercase tracking-label",
                  preset === p.value ? "text-df-red" : "text-ink",
                )}>
                  {p.label}
                </div>
                <div className="mt-0.5 text-[10px] uppercase tracking-label text-ink-dim">
                  {p.hint}
                </div>
              </button>
            ))}
          </div>

          <div>
            <div className="text-[11px] font-semibold uppercase tracking-label text-ink-muted">
              Format
            </div>
            <div className="mt-2 inline-flex rounded border border-line bg-surface-raised p-0.5">
              {(["webp", "jpeg", "avif"] as const).map((f) => (
                <button
                  key={f}
                  type="button"
                  onClick={() => setFormat(f)}
                  className={cx(
                    "rounded px-4 py-1 text-xs font-semibold uppercase tracking-label transition-colors",
                    format === f
                      ? "bg-df-red text-white"
                      : "text-ink-muted hover:text-ink",
                  )}
                >
                  {f}
                </button>
              ))}
            </div>
          </div>

          {error && (
            <div className="rounded border border-status-fail/40 bg-df-red-tint px-3 py-2 text-xs uppercase tracking-label text-status-fail">
              {error}
            </div>
          )}

          <div className="flex justify-end pt-2">
            <button
              type="button"
              disabled={!ready}
              onClick={onSubmit}
              className={cx(
                "rounded px-5 py-2.5 text-xs font-semibold uppercase tracking-label-loose transition-colors",
                ready
                  ? "bg-df-red text-white hover:bg-df-red-700"
                  : "cursor-not-allowed bg-surface-hover text-ink-faint",
              )}
            >
              {submitting ? "Submitting…" : "Resize"}
            </button>
          </div>
        </section>
      </div>

      <div className="space-y-4">
        <h2 className="text-[11px] font-semibold uppercase tracking-label-loose text-ink-muted">
          Result
        </h2>
        {!jobId && (
          <div className="rounded border border-dashed border-line-subtle bg-surface-card px-6 py-10 text-center">
            <p className="text-[11px] uppercase tracking-label text-ink-dim">
              Submit to see resized output
            </p>
          </div>
        )}
        <JobProgress
          job={polling.job}
          error={polling.error}
          isPolling={polling.isPolling}
        />
        {polling.job?.status === "done" && polling.job.download_url && (
          <div className="space-y-3 rounded border border-line bg-surface-card p-4">
            <p className="text-[11px] uppercase tracking-label text-ink-muted">
              Done — preview:
            </p>
            <div className="overflow-hidden rounded border border-line-subtle bg-surface-raised">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={polling.job.download_url}
                alt="Resized output"
                className="h-auto w-full"
              />
            </div>
            <a
              href={polling.job.download_url}
              download
              className="inline-block rounded bg-df-red px-4 py-2 text-[11px] font-semibold uppercase tracking-label-loose text-white hover:bg-df-red-700"
            >
              Download
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
