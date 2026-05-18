"use client";
// apps/web/components/history/HistoryList.tsx
// Renders the user's last 60 days of approval sets.
// Each ApprovalSet has a date, make/model label, image thumbnails, and download.

import { useEffect, useState } from "react";

interface ApprovalSetAsset {
  assetId:      string;
  filename:     string;
  thumbnailUrl: string;   // signed GCS GET URL
  gcsPath:      string;   // approved/{email}/{dir}/{filename}
}

interface ApprovalSet {
  id:           string;
  createdAt:    string;   // ISO 8601
  expiresAt:    string;   // ISO 8601 — 60 days after createdAt
  dirName:      string;   // YYYY-MM-DD_{make}_{model}
  make:         string;
  model:        string;
  imageCount:   number;
  assets:       ApprovalSetAsset[];
  zipSignedUrl?: string;  // pre-signed ZIP download URL (if available)
}

interface HistoryResponse {
  sets: ApprovalSet[];
  totalSets: number;
}

function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    year: "numeric", month: "short", day: "numeric",
  });
}

function daysUntilExpiry(expiresAt: string): number {
  const ms = new Date(expiresAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
}

function ApprovalSetCard({ set }: { set: ApprovalSet }) {
  const [expanded, setExpanded] = useState(false);
  const daysLeft = daysUntilExpiry(set.expiresAt);
  const expired  = daysLeft === 0;

  return (
    <article
      className={`rounded-xl border overflow-hidden transition-colors ${
        expired ? "border-zinc-800 opacity-60" : "border-zinc-700 bg-zinc-900"
      }`}
    >
      {/* Header row */}
      <div className="flex items-center justify-between px-4 py-3 gap-3">
        <div className="flex items-center gap-3 min-w-0">
          {/* Date badge */}
          <div className="shrink-0 text-center bg-zinc-800 rounded-lg px-3 py-1.5">
            <p className="text-[11px] text-zinc-500 uppercase tracking-wide">
              {new Date(set.createdAt).toLocaleDateString("en-US", { month: "short" })}
            </p>
            <p className="text-lg font-bold text-white leading-none">
              {new Date(set.createdAt).getDate()}
            </p>
          </div>

          {/* Info */}
          <div className="min-w-0">
            <p className="font-medium text-white truncate">
              {set.make} {set.model}
            </p>
            <p className="text-xs text-zinc-500 mt-0.5">
              {set.imageCount} image{set.imageCount !== 1 ? "s" : ""}
              {" · "}
              <code className="font-mono text-[10px] text-zinc-600">{set.dirName}</code>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Expiry */}
          <span className={`text-xs px-2 py-1 rounded-full border ${
            expired
              ? "text-red-400 border-red-800 bg-red-950/40"
              : daysLeft <= 5
                ? "text-yellow-400 border-yellow-800 bg-yellow-950/40"
                : "text-zinc-500 border-zinc-700 bg-zinc-900"
          }`}>
            {expired ? "Expired" : `${daysLeft}d left`}
          </span>

          {/* ZIP download */}
          {set.zipSignedUrl && !expired && (
            <a
              href={set.zipSignedUrl}
              download
              className="text-xs text-blue-400 hover:text-blue-300 transition-colors px-3 py-1.5 rounded-lg border border-blue-800 bg-blue-950/40"
              aria-label={`Download ZIP for ${set.dirName}`}
            >
              ZIP
            </a>
          )}

          {/* Expand toggle */}
          <button
            onClick={() => setExpanded((v) => !v)}
            className="p-1.5 rounded-lg hover:bg-zinc-800 transition-colors"
            aria-expanded={expanded}
            aria-label={expanded ? "Collapse images" : "Expand images"}
          >
            <svg
              className={`w-4 h-4 text-zinc-500 transition-transform ${expanded ? "rotate-180" : ""}`}
              fill="none" viewBox="0 0 24 24" stroke="currentColor"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>
        </div>
      </div>

      {/* Thumbnail strip (collapsed: 6 previews) */}
      {!expanded && set.assets.length > 0 && (
        <div className="px-4 pb-3 flex gap-1.5 overflow-x-auto">
          {set.assets.slice(0, 8).map((a) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={a.assetId}
              src={a.thumbnailUrl}
              alt={a.filename}
              className="w-12 h-12 rounded-lg object-cover shrink-0 border border-zinc-800"
            />
          ))}
          {set.assets.length > 8 && (
            <div className="w-12 h-12 rounded-lg border border-zinc-700 bg-zinc-800 flex items-center justify-center text-xs text-zinc-500 shrink-0">
              +{set.assets.length - 8}
            </div>
          )}
        </div>
      )}

      {/* Expanded grid */}
      {expanded && (
        <div className="px-4 pb-4 border-t border-zinc-800 pt-3">
          <div className="grid grid-cols-4 sm:grid-cols-6 md:grid-cols-8 gap-2">
            {set.assets.map((a) => (
              <div key={a.assetId} className="group relative">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={a.thumbnailUrl}
                  alt={a.filename}
                  className="w-full aspect-square object-cover rounded-lg border border-zinc-800"
                />
                {!expired && (
                  <a
                    href={a.thumbnailUrl}
                    download={a.filename}
                    className="absolute inset-0 bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity rounded-lg flex items-center justify-center"
                    aria-label={`Download ${a.filename}`}
                  >
                    <svg className="w-5 h-5 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                        d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-4l-4 4m0 0l-4-4m4 4V4" />
                    </svg>
                  </a>
                )}
              </div>
            ))}
          </div>
          <p className="mt-3 text-[11px] text-zinc-600 font-mono">
            gs://…/approved/{"{email}"}/{set.dirName}/
          </p>
        </div>
      )}
    </article>
  );
}

export function HistoryList({ userEmail }: { userEmail: string }) {
  const [data, setData]       = useState<HistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/history", { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<HistoryResponse>;
      })
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load history"))
      .finally(() => setLoading(false));
  }, []);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16 gap-3 text-zinc-500">
        <svg className="animate-spin w-5 h-5" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"/>
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z"/>
        </svg>
        Loading history…
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-center py-12 text-red-400 text-sm" role="alert">
        {error}
      </div>
    );
  }

  if (!data || data.sets.length === 0) {
    return (
      <div className="text-center py-16 space-y-2">
        <p className="text-zinc-500">No approved image sets in the last 60 days.</p>
        <p className="text-xs text-zinc-700">
          Approve images in the Scan tab to save them to your library.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-xs text-zinc-600">
        {data.totalSets} set{data.totalSets !== 1 ? "s" : ""} · Images stored 60 days from approval
      </p>
      {data.sets.map((s) => (
        <ApprovalSetCard key={s.id} set={s} />
      ))}
    </div>
  );
}
