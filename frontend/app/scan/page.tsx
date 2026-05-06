"use client";

import { useEffect, useState } from "react";
import { useStore } from "@/lib/store";
import { useJobPolling } from "@/lib/usePolling";
import { UploadZone } from "@/components/UploadZone";
import { JobProgress } from "@/components/JobProgress";
import { enqueueScan } from "@/lib/api";
import type { ScanResult, ScanCheckKey } from "@/lib/types";
import { cx } from "@/lib/utils";

/**
 * Scan tab.
 *
 * Result UI mirrors the existing Discount Forklift "AI scan" pattern:
 *   - Verdict pill at top (PASS green / NEEDS REVIEW amber / FAIL red)
 *   - Banner above the per-provider grid when agreement != "full"
 *   - Three side-by-side panels (Gemini / GPT-4o / Claude) showing each
 *     provider's verdict, confidence, and reasoning paragraph
 *   - Artifact checklist grid (12 checks) showing the merged worst-status
 *     value across providers, with the dissent note inline when present
 *   - Numbered flagged-issues list at bottom
 *
 * The 3-provider design comes from Phase 2 v2.4 § 2 + v2.4.1 § 2 (Gemini lane
 * upgraded to gemini-3-flash-preview).
 */
export default function ScanPage() {
  const session_id = useStore((s) => s.session_id);
  const activeId   = useStore((s) => s.active.scan);
  const jobId      = useStore((s) => s.jobs.scan);
  const setJob     = useStore((s) => s.setJob);

  const polling = useJobPolling(jobId);
  const job = polling.job;
  const result = job?.scan_result;

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Deep link from Enhance result: /scan?asset=...
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const asset = params.get("asset");
    if (asset) {
      useStore.getState().setActive("scan", asset);
      window.history.replaceState(null, "", "/scan");
    }
  }, []);

  async function onSubmit() {
    if (!session_id || !activeId) return;
    setSubmitting(true);
    setError(null);
    try {
      const { job_id } = await enqueueScan({ session_id, asset_id: activeId });
      setJob("scan", job_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "scan_failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="space-y-6">
        <div>
          <h1 className="text-[11px] font-semibold uppercase tracking-label-loose text-ink-muted">
            Scan
          </h1>
          <p className="mt-1 text-[11px] uppercase tracking-label text-ink-dim">
            Triple-provider artifact detection · image not modified
          </p>
        </div>

        <UploadZone tab="scan" />

        {error && (
          <div className="rounded border border-status-fail/40 bg-df-red-tint px-3 py-2 text-xs uppercase tracking-label text-status-fail">
            {error}
          </div>
        )}

        <button
          type="button"
          disabled={!session_id || !activeId || submitting}
          onClick={onSubmit}
          className={cx(
            "w-full rounded px-5 py-2.5 text-xs font-semibold uppercase tracking-label-loose transition-colors",
            session_id && activeId && !submitting
              ? "bg-df-red text-white hover:bg-df-red-700"
              : "cursor-not-allowed bg-surface-hover text-ink-faint",
          )}
        >
          {submitting ? "Submitting…" : "Scan Image"}
        </button>
      </div>

      <div className="space-y-4">
        <h2 className="text-[11px] font-semibold uppercase tracking-label-loose text-ink-muted">
          Verdict
        </h2>
        {!jobId && (
          <div className="rounded border border-dashed border-line-subtle bg-surface-card px-6 py-10 text-center">
            <p className="text-[11px] uppercase tracking-label text-ink-dim">
              Upload a photo and submit to see verdict
            </p>
          </div>
        )}
        <JobProgress job={polling.job} error={polling.error} isPolling={polling.isPolling} />
        {result && <ScanResultPanel result={result} />}
      </div>
    </div>
  );
}

// ---------- result rendering ----------

function ScanResultPanel({ result }: { result: ScanResult }) {
  const showDisagreementBanner = result.agreement !== "full";

  return (
    <section className="space-y-5 rounded border border-line bg-surface-card p-5">
      <header className="flex flex-wrap items-center gap-3 border-b border-line-subtle pb-4">
        <VerdictPill verdict={result.verdict} />
        <AgreementBadge agreement={result.agreement} />
        <span className="ml-auto text-xs text-ink-muted">
          Confidence{" "}
          <span className={cx("font-bold", confidenceColor(result.confidence))}>
            {result.confidence}%
          </span>
        </span>
      </header>

      {showDisagreementBanner && (
        <div className="flex items-center gap-2 rounded border border-status-warn/40 bg-status-warn/10 px-3 py-2">
          <DisagreementIcon />
          <span className="text-[11px] font-semibold uppercase tracking-label text-status-warn">
            AIs disagree — review carefully
          </span>
        </div>
      )}

      <p className="text-sm text-ink">{result.summary}</p>

      {result.warnings && result.warnings.length > 0 && (
        <div className="rounded border border-status-warn/30 bg-status-warn/5 px-3 py-2 text-[11px] uppercase tracking-label text-status-warn">
          {result.warnings.join(" · ")}
        </div>
      )}

      {result.individual && <ProviderGrid individual={result.individual} />}

      <div>
        <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-label-loose text-ink-muted">
          Artifact Checklist
        </h3>
        <CheckGrid checks={result.checks} />
      </div>

      {result.issues.length > 0 && (
        <div>
          <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-label-loose text-status-fail">
            Flagged Issues
          </h3>
          <ol className="space-y-1.5 text-sm text-ink">
            {result.issues.map((iss, i) => (
              <li key={i} className="flex gap-3">
                <span className="font-bold text-status-fail">{i + 1}</span>
                <span>{iss}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
    </section>
  );
}

function VerdictPill({ verdict }: { verdict: ScanResult["verdict"] }) {
  const config = {
    PASS:   { label: "Pass",         cls: "border-status-pass/40 bg-status-pass/10 text-status-pass" },
    REVIEW: { label: "Needs Review", cls: "border-status-warn/40 bg-status-warn/10 text-status-warn" },
    FAIL:   { label: "Fail",         cls: "border-status-fail/40 bg-status-fail/10 text-status-fail" },
  }[verdict];
  return (
    <span className={cx(
      "inline-flex items-center rounded border px-2.5 py-0.5 text-[10px] font-bold uppercase tracking-label-loose",
      config.cls,
    )}>
      {config.label}
    </span>
  );
}

function AgreementBadge({ agreement }: { agreement: ScanResult["agreement"] }) {
  const label = agreement === "full"
    ? "All Agree"
    : agreement === "majority"
      ? "2 of 3"
      : "Split";
  return (
    <span className="rounded border border-line bg-surface-raised px-2 py-0.5 text-[10px] uppercase tracking-label text-ink-muted">
      {label}
    </span>
  );
}

function confidenceColor(c: number): string {
  if (c >= 80) return "text-status-pass";
  if (c >= 60) return "text-status-warn";
  return "text-status-fail";
}

function DisagreementIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="h-4 w-4 shrink-0 text-status-warn"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      aria-hidden
    >
      <circle cx="8" cy="8" r="6.5" />
      <path d="M8 4.5v4M8 11.25v.25" strokeLinecap="round" />
    </svg>
  );
}

// ---------- per-provider grid ----------

const PROVIDER_LABELS: Record<string, { name: string; dot: string }> = {
  gemini:    { name: "Gemini",    dot: "bg-status-info" },
  openai:    { name: "GPT-4o",    dot: "bg-status-pass" },
  anthropic: { name: "Claude",    dot: "bg-status-deposit" },
};

type ProviderResult = {
  verdict?: ScanResult["verdict"];
  confidence?: number;
  summary?: string;
};

function ProviderGrid({
  individual,
}: {
  individual: NonNullable<ScanResult["individual"]>;
}) {
  const entries = Object.entries(individual).filter(([, v]) => v != null) as [
    string,
    ProviderResult,
  ][];
  if (entries.length === 0) return null;

  return (
    <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {entries.map(([key, value]) => {
        const meta = PROVIDER_LABELS[key] ?? { name: key, dot: "bg-ink-muted" };
        const v = value as ProviderResult;
        return (
          <div
            key={key}
            className="space-y-2 rounded border border-line-subtle bg-surface-raised p-3"
          >
            <div className="flex items-center gap-2">
              <span className={cx("h-1.5 w-1.5 rounded-full", meta.dot)} aria-hidden />
              <span className="text-[10px] font-semibold uppercase tracking-label text-ink-muted">
                {meta.name}
              </span>
            </div>
            {v.verdict && (
              <div className={cx(
                "text-lg font-bold",
                v.verdict === "PASS" ? "text-status-pass" :
                v.verdict === "FAIL" ? "text-status-fail" :
                "text-status-warn",
              )}>
                {v.verdict === "REVIEW" ? "Review" :
                  v.verdict.charAt(0) + v.verdict.slice(1).toLowerCase()}
              </div>
            )}
            {typeof v.confidence === "number" && (
              <div className="text-[10px] uppercase tracking-label text-ink-dim">
                {v.confidence}% confidence
              </div>
            )}
            {v.summary && (
              <p className="text-xs leading-relaxed text-ink-muted">{v.summary}</p>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ---------- check grid ----------

const CHECK_LABELS: Record<ScanCheckKey, string> = {
  limb_count:           "Limb Count",
  finger_detail:        "Finger Detail",
  face_anatomy:         "Face Anatomy",
  forklift_forks:       "Forks",
  forklift_mast:        "Mast",
  operator_seat:        "Operator Seat",
  wheel_count:          "Wheels",
  duplicate_objects:    "Duplicate Objects",
  text_legibility:      "Text Legibility",
  lighting_shadows:     "Lighting + Shadows",
  background_coherence: "Background",
  proportions:          "Proportions",
};

function CheckGrid({ checks }: { checks: ScanResult["checks"] }) {
  const keys = Object.keys(CHECK_LABELS) as ScanCheckKey[];
  return (
    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
      {keys.map((k) => {
        const c = checks[k];
        return (
          <div
            key={k}
            className="flex items-start gap-2.5 rounded border border-line-subtle bg-surface-raised px-3 py-2"
          >
            <StatusDot status={c?.status ?? "skip"} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center justify-between">
                <span className="text-xs font-semibold uppercase tracking-label text-ink">
                  {CHECK_LABELS[k]}
                </span>
                <span className={cx(
                  "text-[10px] font-bold uppercase tracking-label",
                  statusColor(c?.status ?? "skip"),
                )}>
                  {(c?.status ?? "skip").toUpperCase()}
                </span>
              </div>
              {c?.note && (
                <div className="mt-0.5 text-[11px] text-ink-muted line-clamp-2">
                  {c.note}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function StatusDot({
  status,
}: {
  status: NonNullable<ScanResult["checks"][ScanCheckKey]>["status"];
}) {
  return (
    <span
      className={cx(
        "mt-1 h-2 w-2 shrink-0 rounded-full",
        status === "ok"   && "bg-status-pass",
        status === "warn" && "bg-status-warn",
        status === "bad"  && "bg-status-fail",
        status === "skip" && "bg-ink-faint",
      )}
      aria-label={status}
    />
  );
}

function statusColor(status: NonNullable<ScanResult["checks"][ScanCheckKey]>["status"]): string {
  switch (status) {
    case "ok":   return "text-status-pass";
    case "warn": return "text-status-warn";
    case "bad":  return "text-status-fail";
    case "skip": return "text-ink-faint";
  }
}
