"use client";
// apps/web/components/history/HistoryList.tsx
// Renders ALL of the user's approval sets (stored indefinitely as of
// 2026-05-26 — operator decided photo library is infinite). Each
// ApprovalSet has a date, make/model label, image thumbnails, and
// download.
//
// Filter bar across the top supports free-text search (matches make, model,
// directory name, filenames) and a date range. Make + model dropdowns are
// populated from the actual loaded data. All filtering happens client-side
// — /api/history returns up to 200 sets, easy to filter in-browser.
//
// expiresAt: nullable on the wire — null means "stored indefinitely"
// (new default). Legacy rows from when the GCS lifecycle rule deleted
// approved/ objects after 60 days may still carry an ISO timestamp; we
// render a countdown badge for those until they age out and the
// backend stops returning them.

import { useEffect, useMemo, useState } from "react";

import { TipBanner } from "../workspace/TipBanner";

interface ApprovalSetAsset {
  assetId:      string;
  filename:     string;
  thumbnailUrl: string;   // signed GCS GET URL
  gcsPath:      string;   // approved/{email}/{dir}/{filename}
}

interface ApprovalSet {
  id:           string;
  createdAt:    string;          // ISO 8601
  expiresAt:    string | null;   // null = stored indefinitely; ISO string = legacy 60-day row
  dirName:      string;          // YYYY-MM-DD_{make}_{model}_{session-short}
  make:         string;
  model:        string;
  imageCount:   number;
  assets:       ApprovalSetAsset[];
  zipSignedUrl?: string;         // pre-signed ZIP download URL (if available)
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
    <section className="rounded-xl border border-line bg-well/60 overflow-hidden">
      <header className="flex items-start justify-between gap-4 px-5 py-4 bg-panel/50 border-b border-line flex-wrap">
        <div className="flex flex-col gap-1 min-w-0">
          <span className="text-base font-semibold uppercase tracking-[0.14em] text-ink">
            Filter
          </span>
          <span className="text-sm text-ink-soft leading-relaxed">
            Use the search box to find a specific lift by Make, Model,
            filename, or folder name. Date filters narrow the list to
            sets approved in a window. Use the Make / Model dropdowns
            to pin one unit type at a time.
          </span>
        </div>
        <div className="flex items-center gap-4 shrink-0">
          <span className="text-sm uppercase tracking-[0.16em] text-ink-soft tabular-nums font-semibold">
            {filteredCount} / {totalSets} set{totalSets !== 1 ? "s" : ""}
          </span>
          {isFiltered && (
            <button
              onClick={() => onChange(EMPTY_FILTERS)}
              className="text-sm uppercase tracking-[0.18em] font-semibold text-attn hover:text-attn transition-colors"
            >
              Clear filters
            </button>
          )}
        </div>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 p-5">
        {/* Free-text search */}
        <label className="flex flex-col gap-1.5 md:col-span-2">
          <span className="text-xs uppercase tracking-[0.18em] text-ink-soft font-semibold">
            Search
          </span>
          <input
            type="text"
            value={filters.query}
            onChange={(e) => onChange({ ...filters, query: e.target.value })}
            placeholder="Make, model, filename, or folder…"
            className="bg-panel border border-line rounded-md px-3 py-2.5 text-base text-ink placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-attn focus:border-transparent transition"
          />
        </label>

        {/* Date range */}
        <label className="flex flex-col gap-1.5">
          <span className="text-xs uppercase tracking-[0.18em] text-ink-soft font-semibold">
            From date
          </span>
          <input
            type="date"
            value={filters.startDate}
            onChange={(e) => onChange({ ...filters, startDate: e.target.value })}
            className="bg-panel border border-line rounded-md px-3 py-2.5 text-base text-ink focus:outline-none focus:ring-2 focus:ring-attn focus:border-transparent transition"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs uppercase tracking-[0.18em] text-ink-soft font-semibold">
            To date
          </span>
          <input
            type="date"
            value={filters.endDate}
            onChange={(e) => onChange({ ...filters, endDate: e.target.value })}
            className="bg-panel border border-line rounded-md px-3 py-2.5 text-base text-ink focus:outline-none focus:ring-2 focus:ring-attn focus:border-transparent transition"
          />
        </label>

        {/* Make + model dropdowns */}
        <label className="flex flex-col gap-1.5">
          <span className="text-xs uppercase tracking-[0.18em] text-ink-soft font-semibold">
            Make
          </span>
          <select
            value={filters.make}
            onChange={(e) => onChange({ ...filters, make: e.target.value })}
            className="bg-panel border border-line rounded-md px-3 py-2.5 text-base text-ink focus:outline-none focus:ring-2 focus:ring-attn focus:border-transparent transition"
          >
            <option value="">All makes</option>
            {availableMakes.map((m) => (
              <option key={m} value={m}>{m}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs uppercase tracking-[0.18em] text-ink-soft font-semibold">
            Model
          </span>
          <select
            value={filters.model}
            onChange={(e) => onChange({ ...filters, model: e.target.value })}
            className="bg-panel border border-line rounded-md px-3 py-2.5 text-base text-ink focus:outline-none focus:ring-2 focus:ring-attn focus:border-transparent transition"
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
  // null expiresAt = stored indefinitely (new default). Only legacy
  // rows have a real timestamp; compute countdown + expired for those.
  const daysLeft = set.expiresAt ? daysUntilExpiry(set.expiresAt) : null;
  const expired  = daysLeft === 0;

  return (
    <article
      className={`rounded-xl border overflow-hidden transition-colors ${
        expired ? "border-line opacity-60 bg-well/60" : "border-line bg-well/60"
      }`}
    >
      {/* Header row */}
      <div className="flex items-center justify-between px-4 py-3 gap-3">
        <div className="flex items-center gap-3 min-w-0">
          {/* Date badge */}
          <div className="shrink-0 text-center bg-panel border border-line rounded-lg px-3 py-1.5">
            <p className="text-[10px] text-ink-faint uppercase tracking-[0.18em]">
              {new Date(set.createdAt).toLocaleDateString("en-US", { month: "short" })}
            </p>
            <p className="text-lg font-bold text-ink leading-none tabular-nums">
              {new Date(set.createdAt).getDate()}
            </p>
          </div>

          {/* Info */}
          <div className="min-w-0">
            <p className="font-medium text-ink truncate">
              {set.make} {set.model}
            </p>
            <p className="text-xs text-ink-faint mt-0.5">
              {set.imageCount} image{set.imageCount !== 1 ? "s" : ""}
              {" · "}
              <code className="font-mono text-[10px] text-muted">{set.dirName}</code>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {/* Expiry badge — only rendered for legacy rows (expiresAt set).
              New "stored indefinitely" rows (expiresAt === null) get no
              badge at all; the absence is the indication. */}
          {daysLeft !== null && (
            <span className={`text-[10px] uppercase tracking-[0.18em] font-semibold px-2 py-1 rounded border ${
              expired
                ? "text-attn border-attn bg-panel"
                : daysLeft <= 5
                  ? "text-attn border-attn bg-panel"
                  : "text-ink-faint border-line bg-panel"
            }`}>
              {expired ? "Expired" : `${daysLeft}d left`}
            </span>
          )}

          {/* ZIP download */}
          {set.zipSignedUrl && !expired && (
            <a
              href={set.zipSignedUrl}
              download
              className="text-[10px] uppercase tracking-[0.18em] font-semibold text-white bg-cta hover:bg-cta-dark border border-attn transition-colors px-3 py-1.5 rounded"
              aria-label={`Download ZIP for ${set.dirName}`}
            >
              Download ZIP
            </a>
          )}

          {/* Expand toggle */}
          <button
            onClick={() => setExpanded((v) => !v)}
            className="p-1.5 rounded hover:bg-panel-hi transition-colors"
            aria-expanded={expanded}
            aria-label={expanded ? "Collapse images" : "Expand images"}
          >
            <svg
              className={`w-4 h-4 text-ink-faint transition-transform ${expanded ? "rotate-180" : ""}`}
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
              className="w-14 h-14 rounded object-cover shrink-0 border border-line"
            />
          ))}
          {set.assets.length > 8 && (
            <div className="w-14 h-14 rounded border border-line bg-panel flex items-center justify-center text-xs text-ink-faint shrink-0">
              +{set.assets.length - 8}
            </div>
          )}
        </div>
      )}

      {/* Expanded grid */}
      {expanded && (
        <div className="px-4 pb-4 border-t border-line pt-3">
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
                  className="w-full aspect-square object-contain bg-well rounded-lg border border-line group-hover:border-line transition-colors"
                />
                <span className="absolute bottom-1 left-1 right-1 text-[9px] font-mono text-ink-soft bg-header-bg/70 px-1 py-0.5 rounded truncate">
                  {a.filename}
                </span>
              </a>
            ))}
          </div>
          <p className="mt-3 text-[10px] text-muted font-mono">
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
  // eslint-disable-next-line react-hooks/set-state-in-effect -- data-fetch pattern: reset loading/error then fetch and write back.
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
      <div className="flex items-center justify-center py-16 gap-3 text-ink-faint">
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
      <div className="text-center py-12 text-attn text-sm" role="alert">
        {error}
      </div>
    );
  }

  if (!data || data.sets.length === 0) {
    return (
      <div className="space-y-4">
        <TipBanner title="Your Photo Library — what this does">
          <p>
            Every time you approve a set of photos on the Resize tab,
            they get copied here and kept indefinitely. You can come back
            any time, re-download any approved set, search by Make /
            Model / filename, or filter by approval date.
          </p>
        </TipBanner>
        <div className="text-center py-16 space-y-3">
          <p className="text-base text-ink font-semibold">
            No approved image sets yet.
          </p>
          <p className="text-sm text-ink-soft">
            Approve a set on the Resize tab to save it here.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* ── Page heading ── */}
      <header className="space-y-1">
        <h1 className="text-3xl font-extrabold text-ink tracking-tight">
          Your Photo Library
        </h1>
        <p className="text-base text-ink-soft">
          Every approved set you&apos;ve shipped — kept indefinitely.
        </p>
      </header>

      {/* ── Plain-language explanation of what this tab is for ── */}
      <TipBanner
        title="Your Photo Library — what this does"
        steps={[
          <>Every approved set from the Resize tab lands here automatically.</>,
          <>Sets are kept <span className="font-semibold text-accent">indefinitely</span> — no auto-deletion. Old sets stay until you manually clean them up.</>,
          <>Use the filter bar below to search by Make / Model / filename / folder, or narrow by approval date.</>,
          <>Click any thumbnail to open the full-size signed URL in a new tab.</>,
        ]}
      >
        <p>
          Your library of approved image sets. Every photo you&apos;ve
          ever signed off on lives here so you can pull it back any
          time a listing site asks for it again.
        </p>
      </TipBanner>

      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-sm uppercase tracking-[0.16em] text-ink-soft font-semibold">
          <span className="text-accent">{data.totalSets}</span>{" "}
          set{data.totalSets !== 1 ? "s" : ""}
          <span className="text-ink-faint"> · </span>
          Stored indefinitely
          <span className="text-ink-faint"> · </span>
          <span className="text-ink font-mono">{userEmail}</span>
        </p>
        <button
          onClick={() => setRefreshTick((t) => t + 1)}
          disabled={loading}
          className="text-sm uppercase tracking-[0.16em] font-semibold text-ink hover:text-ink border border-line hover:border-ink-faint px-3 py-2 rounded transition-colors disabled:opacity-50"
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
        <div className="text-center py-12 rounded-xl border border-line bg-well/60">
          <p className="text-ink-faint text-sm">No approval sets match the current filters.</p>
          <button
            onClick={() => setFilters(EMPTY_FILTERS)}
            className="mt-3 text-[10px] uppercase tracking-[0.18em] font-semibold text-attn hover:text-attn transition-colors"
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
