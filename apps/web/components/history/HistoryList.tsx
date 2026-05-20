"use client";
// apps/web/components/history/HistoryList.tsx
// Renders the user's last 60 days of approval sets.
// Each ApprovalSet has a date, make/model label, image thumbnails, and download.
//
// Filter bar across the top supports free-text search (matches make, model,
// directory name, filenames) and a date range. Make + model dropdowns are
// populated from the actual loaded data. All filtering happens client-side
// — /api/history returns up to 200 sets, easy to filter in-browser.

import { useEffect, useMemo, useState } from "react";

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
  dirName:      string;   // YYYY-MM-DD_{make}_{model}_{session-short}
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

function daysUntilExpiry(expiresAt: string): number {
  const ms = new Date(expiresAt).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (1000 * 60 * 60 * 24)));
}

/** Date in YYYY-MM-DD form for native date inputs. */
function isoDateOnly(iso: string): string {
  return new Date(iso).toISOString().slice(0, 10);
}

// ─── Filter bar ───────────────────────────────────────────────────────────────

interface Filters {
  query: string;        // free-text — matches make, model, dirName, filenames
  startDate: string;    // YYYY-MM-DD or ""
  endDate:   string;    // YYYY-MM-DD or ""
  make:      string;    // "" = all
  model:     string;    // "" = all
}

const EMPTY_FILTERS: Filters = {
  query: "",
  startDate: "",
  endDate: "",
  make: "",
  model: "",
};

function FilterBar({
  filters,
  onChange,
  availableMakes,
  availableModels,
  totalSets,
  filteredCount,
}: {
  filters: Filters;
  onChange: (next: Filters) => void;
  availableMakes: string[];
  availableModels: string[];
  totalSets: number;
  filteredCount: number;
}) {
  const isFiltered = JSON.stringify(filters) !== JSON.stringify(EMPTY_FILTERS);

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 overflow-hidden">
      <header className="flex items-center justify-between px-4 py-3 bg-zinc-900/50 border-b border-zinc-800">
        <span className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-300">
          Filter
        </span>
        <div className="flex items-center gap-3">
          <span className="text-[10px] uppercase tracking-[0.16em] text-zinc-500 tabular-nums">
            {filteredCount} / {totalSets} set{totalSets !== 1 ? "s" : ""}
          </span>
          {isFiltered && (
            <button
              onClick={() => onChange(EMPTY_FILTERS)}
              className="text-[10px] uppercase tracking-[0.18em] font-semibold text-red-400 hover:text-red-300 transition-colors"
            >
              Clear filters
            </button>
          )}
        </div>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3 p-4">
        {/* Free-text search */}
        <label className="flex flex-col gap-1 md:col-span-2">
          <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold">
            Search
          </span>
          <input
            type="text"
            value={filters.query}
            onChange={(e) => onChange({ ...filters, query: e.target.value })}
            placeholder="Make, model, filename, or folder…"
            className="bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent transition"
          />
        </label>

        {/* Date range */}
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold">
            From date
          </span>
          <input
            type="date"
            value={filters.startDate}
            onChange={(e) => onChange({ ...filters, startDate: e.target.value })}
            className="bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent transition"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold">
            To date
          </span>
          <input
            type="date"
            value={filters.endDate}
            onChange={(e) => onChange({ ...filters, endDate: e.target.value })}
            className="bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent transition"
          />
        </label>

        {/* Make + model dropdowns */}
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold">
            Make
          </span>
          <select
            value={filters.make}
            onChange={(e) => onChange({ ...filters, make: e.target.value })}
            className="bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent transition"
          >
            <option value="">All makes</option>
            {availableMakes.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold">
            Model
          </span>
          <select
            value={filters.model}
            onChange={(e) => onChange({ ...filters, model: e.target.value })}
            className="bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent transition"
          >
            <option value="">All models</option>
            {availableModels.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </label>
      </div>
    </section>
  );
}

// ─── Approval-set card ───────────────────────────────────────────────────────

function ApprovalSetCard({ set }: { set: ApprovalSet }) {
  const [expanded, setExpanded] = useState(false);
  const daysLeft = daysUntilExpiry(set.expiresAt);
  const expired  = daysLeft === 0;

  return (
    <article
      className={`rounded-xl border overflow-hidden transition-colors ${
        expired ? "border-zinc-800 opacity-60 bg-zinc-950/60" : "border-zinc-800 bg-zinc-950/60"
      }`}
    >
      {/* Header row */}
      <div className="flex items-center justify-between px-4 py-3 gap-3">
        <div className="flex items-center gap-3 min-w-0">
          {/* Date badge */}
          <div className="shrink-0 text-center bg-zinc-900 border border-zinc-800 rounded-lg px-3 py-1.5">
            <p className="text-[10px] text-zinc-500 uppercase tracking-[0.18em]">
              {new Date(set.createdAt).toLocaleDateString("en-US", { month: "short" })}
            </p>
            <p className="text-lg font-bold text-white leading-none tabular-nums">
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
          <span className={`text-[10px] uppercase tracking-[0.18em] font-semibold px-2 py-1 rounded border ${
            expired
              ? "text-red-400 border-red-900 bg-red-950/40"
              : daysLeft <= 5
                ? "text-amber-400 border-amber-900 bg-amber-950/40"
                : "text-zinc-500 border-zinc-800 bg-zinc-900"
          }`}>
            {expired ? "Expired" : `${daysLeft}d left`}
          </span>

          {/* ZIP download */}
          {set.zipSignedUrl && !expired && (
            <a
              href={set.zipSignedUrl}
              download
              className="text-[10px] uppercase tracking-[0.18em] font-semibold text-white bg-red-600 hover:bg-red-500 border border-red-500 transition-colors px-3 py-1.5 rounded"
              aria-label={`Download ZIP for ${set.dirName}`}
            >
              Download ZIP
            </a>
          )}

          {/* Expand toggle */}
          <button
            onClick={() => setExpanded((v) => !v)}
            className="p-1.5 rounded hover:bg-zinc-800 transition-colors"
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

      {/* Thumbnail strip (collapsed: 8 previews) */}
      {!expanded && set.assets.length > 0 && (
        <div className="px-4 pb-3 flex gap-1.5 overflow-x-auto">
          {set.assets.slice(0, 8).map((a) => (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              key={a.assetId}
              src={a.thumbnailUrl}
              alt={a.filename}
              className="w-14 h-14 rounded object-cover shrink-0 border border-zinc-800"
            />
          ))}
          {set.assets.length > 8 && (
            <div className="w-14 h-14 rounded border border-zinc-800 bg-zinc-900 flex items-center justify-center text-xs text-zinc-500 shrink-0">
              +{set.assets.length - 8}
            </div>
          )}
        </div>
      )}

      {/* Expanded grid */}
      {expanded && (
        <div className="px-4 pb-4 border-t border-zinc-900 pt-3">
          <div className="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-7 gap-2">
            {set.assets.map((a) => (
              <a
                key={a.assetId}
                href={a.thumbnailUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="group relative block"
                aria-label={`Open ${a.filename} full size`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={a.thumbnailUrl}
                  alt={a.filename}
                  className="w-full aspect-square object-contain bg-black rounded-lg border border-zinc-800 group-hover:border-zinc-600 transition-colors"
                />
                <span className="absolute bottom-1 left-1 right-1 text-[9px] font-mono text-zinc-300 bg-black/70 px-1 py-0.5 rounded truncate">
                  {a.filename}
                </span>
              </a>
            ))}
          </div>
          <p className="mt-3 text-[10px] text-zinc-700 font-mono">
            gs://…/approved/{"{email}"}/{set.dirName}/
          </p>
        </div>
      )}
    </article>
  );
}

// ─── Main list ───────────────────────────────────────────────────────────────

export function HistoryList({
  userEmail,
  active = true,
}: {
  userEmail: string;
  /**
   * True when the History tab is the active workspace tab. Refetches
   * whenever this flips false → true so new approvals from the Resize
   * tab show up without a full page reload. Defaults to true so this
   * component still works when mounted standalone (e.g. /history page).
   */
  active?: boolean;
}) {
  const [data, setData]       = useState<HistoryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError]     = useState<string | null>(null);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [refreshTick, setRefreshTick] = useState(0);

  // Refetch on mount, whenever the tab becomes active, and whenever the
  // Refresh button is clicked. Workspace keeps all four panels mounted
  // simultaneously (visibility-only toggle), so without this the
  // history list would forever show whatever it loaded on first paint.
  useEffect(() => {
    if (!active) return;
    setLoading(true);
    setError(null);
    fetch("/api/history", { cache: "no-store" })
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json() as Promise<HistoryResponse>;
      })
      .then(setData)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Failed to load history"))
      .finally(() => setLoading(false));
  }, [active, refreshTick]);

  // Distinct make / model dropdown options, sorted alphabetically.
  const availableMakes = useMemo(() => {
    if (!data) return [];
    return Array.from(new Set(data.sets.map((s) => s.make).filter(Boolean))).sort();
  }, [data]);

  const availableModels = useMemo(() => {
    if (!data) return [];
    const filtered = filters.make
      ? data.sets.filter((s) => s.make === filters.make)
      : data.sets;
    return Array.from(new Set(filtered.map((s) => s.model).filter(Boolean))).sort();
  }, [data, filters.make]);

  // Apply filters.
  const filteredSets = useMemo(() => {
    if (!data) return [];
    const q = filters.query.trim().toLowerCase();
    return data.sets.filter((s) => {
      // Date range
      if (filters.startDate && isoDateOnly(s.createdAt) < filters.startDate) return false;
      if (filters.endDate   && isoDateOnly(s.createdAt) > filters.endDate)   return false;
      // Make / model exact match
      if (filters.make  && s.make  !== filters.make)  return false;
      if (filters.model && s.model !== filters.model) return false;
      // Free-text query — match against make, model, dirName, or any filename
      if (q) {
        const hay = [
          s.make.toLowerCase(),
          s.model.toLowerCase(),
          s.dirName.toLowerCase(),
          ...s.assets.map((a) => a.filename.toLowerCase()),
        ].join(" ");
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [data, filters]);

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
      <div className="flex items-center justify-between gap-3">
        <p className="text-[10px] uppercase tracking-[0.18em] text-zinc-600">
          {data.totalSets} set{data.totalSets !== 1 ? "s" : ""} · Images stored 60 days from approval · {userEmail}
        </p>
        <button
          onClick={() => setRefreshTick((t) => t + 1)}
          disabled={loading}
          className="text-[10px] uppercase tracking-[0.18em] font-semibold text-zinc-400 hover:text-white border border-zinc-700 hover:border-zinc-500 px-2 py-1 rounded transition-colors disabled:opacity-50"
          aria-label="Reload history"
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      <FilterBar
        filters={filters}
        onChange={setFilters}
        availableMakes={availableMakes}
        availableModels={availableModels}
        totalSets={data.totalSets}
        filteredCount={filteredSets.length}
      />

      {filteredSets.length === 0 ? (
        <div className="text-center py-12 rounded-xl border border-zinc-800 bg-zinc-950/60">
          <p className="text-zinc-500 text-sm">No approval sets match the current filters.</p>
          <button
            onClick={() => setFilters(EMPTY_FILTERS)}
            className="mt-3 text-[10px] uppercase tracking-[0.18em] font-semibold text-red-400 hover:text-red-300 transition-colors"
          >
            Clear filters
          </button>
        </div>
      ) : (
        <div className="space-y-3">
          {filteredSets.map((s) => (
            <ApprovalSetCard key={s.id} set={s} />
          ))}
        </div>
      )}
    </div>
  );
}
