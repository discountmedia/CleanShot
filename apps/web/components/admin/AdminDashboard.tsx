"use client";
// apps/web/components/admin/AdminDashboard.tsx
// Three-tab admin view: Users · Projects · Usage.
//
// Each tab lazily fetches from /api/admin/* on first activation so
// dashboard load doesn't wait on three round-trips before paint.
// Data is fetched once and cached per-tab in component state — the
// admin can click Refresh to pull fresh data.

import Link from "next/link";
import { Fragment, useEffect, useMemo, useState } from "react";

import { KpiCard } from "../workspace/KpiCard";

type TabId = "users" | "projects" | "usage" | "support" | "models";

interface SupportTicket {
  id:         string;
  userEmail:  string;
  type:       "support" | "feature";
  subject:    string;
  body:       string;
  status:     "open" | "in_progress" | "closed";
  adminNotes: string | null;
  createdAt:  string;
  updatedAt:  string;
}

interface AdminKpis {
  enhancedToday:     number;
  scannedToday:      number;
  pendingReview:     number;
  storageGcsObjects: number;
}

// ─── KPI row ──────────────────────────────────────────────────────────────────

function KpiRow() {
  const [data, setData] = useState<AdminKpis | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/kpis", { cache: "no-store" })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((j: AdminKpis) => setData(j))
      .catch((e: Error) => setError(e.message));
  }, []);

  const loaded = data !== null;

  return (
    <section aria-label="Admin KPIs">
      {error && (
        <p className="mb-2 text-xs text-attn">Couldn&apos;t load KPIs: {error}</p>
      )}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard
          label="Enhanced today"
          value={data?.enhancedToday ?? 0}
          color="good"
          placeholder={!loaded}
          secondary="images processed"
        />
        <KpiCard
          label="Scanned today"
          value={data?.scannedToday ?? 0}
          color="neutral"
          placeholder={!loaded}
          secondary="AI verdicts"
        />
        <KpiCard
          label="Pending review"
          value={data?.pendingReview ?? 0}
          color={data && data.pendingReview > 0 ? "attention" : "neutral"}
          placeholder={!loaded}
          secondary="scan fails (last 7d)"
        />
        <KpiCard
          label="GCS objects"
          value={data?.storageGcsObjects ?? 0}
          color="neutral"
          placeholder={!loaded}
          secondary="assets stored"
        />
      </div>
    </section>
  );
}

interface AdminUser {
  userEmail:         string;
  sessionCount:      number;
  savedProjectCount: number;
  approvalSetCount:  number;
  firstSeenAt:       string | null;
  lastSeenAt:        string | null;
}

interface AdminProject {
  id:         string;
  sessionId:  string;
  userEmail:  string;
  title:      string;
  make:       string;
  year:       number;
  model:      string;
  tireType:   string;
  capacity:   string;
  fuelType:   string;
  username:   string;
  photoType:  string;
  assetCount: number;
  savedAt:    string | null;
  createdAt:  string;
}

interface UsageByProviderModel {
  provider:     string;
  model:        string;
  operation:    string;
  status:       string;
  callCount:    number;
  avgLatencyMs: number | null;
  maxLatencyMs: number | null;
  totalCostUsd: number;
}

interface UsageByUser {
  userEmail:    string;
  callCount:    number;
  totalCostUsd: number;
}

interface UsageDaily {
  day:          string;
  callCount:    number;
  successCount: number;
  failedCount:  number;
}

interface UsageSummary {
  windowDays:      number;
  byProviderModel: UsageByProviderModel[];
  byUser:          UsageByUser[];
  daily:           UsageDaily[];
}

function isoDateShort(iso: string | null): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString([], {
      year: "numeric", month: "short", day: "numeric",
      hour: "2-digit", minute: "2-digit",
    });
  } catch {
    return iso;
  }
}

// ─── Users tab ────────────────────────────────────────────────────────────────

function UsersTab({ onSelectUser }: { onSelectUser: (email: string) => void }) {
  const [data,    setData]    = useState<AdminUser[] | null>(null);
  const [error,   setError]   = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/admin/users", { cache: "no-store" })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((j: { users: AdminUser[] }) => setData(j.users))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <p className="text-sm text-ink-faint">Loading users…</p>;
  if (error)   return <p className="text-sm text-attn">{error}</p>;
  if (!data || data.length === 0) {
    return <p className="text-sm text-ink-faint">No users yet.</p>;
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-line">
      <table className="w-full text-sm">
        <thead className="bg-panel/60 text-xs uppercase tracking-[0.16em] text-ink">
          <tr>
            <th className="px-3 py-2 text-left font-semibold">User</th>
            <th className="px-3 py-2 text-right font-semibold">Sessions</th>
            <th className="px-3 py-2 text-right font-semibold">Projects</th>
            <th className="px-3 py-2 text-right font-semibold">Approval sets</th>
            <th className="px-3 py-2 text-left font-semibold">First seen</th>
            <th className="px-3 py-2 text-left font-semibold">Last seen</th>
            <th className="px-3 py-2"></th>
          </tr>
        </thead>
        <tbody>
          {data.map((u) => (
            <tr key={u.userEmail} className="border-t border-line hover:bg-panel/40">
              <td className="px-3 py-2 font-mono text-ink">{u.userEmail}</td>
              <td className="px-3 py-2 text-right tabular-nums text-ink-soft">{u.sessionCount}</td>
              <td className="px-3 py-2 text-right tabular-nums text-ink-soft">{u.savedProjectCount}</td>
              <td className="px-3 py-2 text-right tabular-nums text-ink-soft">{u.approvalSetCount}</td>
              <td className="px-3 py-2 text-ink-faint">{isoDateShort(u.firstSeenAt)}</td>
              <td className="px-3 py-2 text-ink-faint">{isoDateShort(u.lastSeenAt)}</td>
              <td className="px-3 py-2 text-right">
                <button
                  onClick={() => onSelectUser(u.userEmail)}
                  className="text-[11px] text-ink-soft hover:text-ink-soft font-semibold"
                >
                  View projects →
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── Projects tab ─────────────────────────────────────────────────────────────

interface ProjectSetAsset {
  assetId:      string;
  filename:     string;
  thumbnailUrl: string;
  gcsPath:      string;
}

interface ProjectSet {
  id:         string;
  userEmail:  string;
  createdAt:  string;
  expiresAt:  string | null;
  dirName:    string;
  make:       string | null;
  model:      string | null;
  imageCount: number;
  assets:     ProjectSetAsset[];
}

interface ProjectSetsResponse {
  project: {
    id:        string;
    userEmail: string;
    title:     string;
    make:      string;
    model:     string;
    year:      number;
  };
  sets:      ProjectSet[];
  totalSets: number;
}

function ProjectsTab({
  filterEmail,
  onClearFilter,
}: {
  filterEmail: string | null;
  onClearFilter: () => void;
}) {
  const [data,    setData]    = useState<AdminProject[] | null>(null);
  const [error,   setError]   = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  /** Project id currently expanded for image-set drill-down. */
  const [expandedId, setExpandedId] = useState<string | null>(null);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data-fetch pattern: reset loading/error then fetch and write back. Refactor to SWR/React Query later if this grows.
    setLoading(true);
    setError(null);
    const qs = filterEmail ? `?user_email=${encodeURIComponent(filterEmail)}` : "";
    fetch(`/api/admin/projects${qs}`, { cache: "no-store" })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((j: { projects: AdminProject[] }) => setData(j.projects))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [filterEmail]);

  return (
    <div className="space-y-3">
      {filterEmail && (
        <div className="flex items-center justify-between rounded-lg border border-line bg-panel px-3 py-2 text-xs">
          <span className="text-ink-soft">
            Filtering to <code className="font-mono text-ink-soft">{filterEmail}</code>
          </span>
          <button
            onClick={onClearFilter}
            className="text-ink-soft hover:text-ink-soft font-semibold uppercase tracking-[0.18em]"
          >
            Clear
          </button>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-ink-faint">Loading projects…</p>
      ) : error ? (
        <p className="text-sm text-attn">{error}</p>
      ) : !data || data.length === 0 ? (
        <p className="text-sm text-ink-faint">No saved projects yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-line">
          <table className="w-full text-sm">
            <thead className="bg-panel/60 text-xs uppercase tracking-[0.16em] text-ink">
              <tr>
                <th className="px-3 py-2 text-left font-semibold w-6" />
                <th className="px-3 py-2 text-left font-semibold">Saved</th>
                <th className="px-3 py-2 text-left font-semibold">User</th>
                <th className="px-3 py-2 text-left font-semibold">Title</th>
                <th className="px-3 py-2 text-left font-semibold">Make</th>
                <th className="px-3 py-2 text-left font-semibold">Model</th>
                <th className="px-3 py-2 text-right font-semibold">Year</th>
                <th className="px-3 py-2 text-left font-semibold">Capacity</th>
                <th className="px-3 py-2 text-left font-semibold">Tire</th>
                <th className="px-3 py-2 text-left font-semibold">Fuel</th>
                <th className="px-3 py-2 text-right font-semibold">Assets</th>
              </tr>
            </thead>
            <tbody>
              {data.map((p) => {
                const expanded = expandedId === p.id;
                return (
                  <Fragment key={p.id}>
                    <tr
                      className={`border-t border-line cursor-pointer transition-colors ${expanded ? "bg-panel" : "hover:bg-panel/40"}`}
                      onClick={() => setExpandedId(expanded ? null : p.id)}
                      title={expanded ? "Hide image sets" : "View image sets"}
                    >
                      <td className="px-3 py-2 text-ink-faint">
                        <svg
                          className={`w-3 h-3 transition-transform ${expanded ? "rotate-90" : ""}`}
                          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}
                        >
                          <path strokeLinecap="round" strokeLinejoin="round" d="M9 5l7 7-7 7" />
                        </svg>
                      </td>
                      <td className="px-3 py-2 text-ink-faint">{isoDateShort(p.savedAt)}</td>
                      <td className="px-3 py-2 font-mono text-ink">{p.userEmail}</td>
                      <td className="px-3 py-2 text-ink">{p.title}</td>
                      <td className="px-3 py-2 text-ink-soft">{p.make}</td>
                      <td className="px-3 py-2 text-ink-soft">{p.model}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-ink-soft">{p.year}</td>
                      <td className="px-3 py-2 text-ink-soft">{p.capacity}</td>
                      <td className="px-3 py-2 text-ink-soft">{p.tireType}</td>
                      <td className="px-3 py-2 text-ink-soft">{p.fuelType}</td>
                      <td className="px-3 py-2 text-right tabular-nums text-ink-soft">{p.assetCount}</td>
                    </tr>
                    {expanded && (
                      <tr className="border-t border-line bg-well/40">
                        <td colSpan={11} className="px-4 py-4">
                          <ProjectSetsPanel projectId={p.id} />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/**
 * Loads + renders all approval sets (with thumbnails) for a project.
 * Mounted lazily — only when the operator clicks a project row to expand.
 * Each mount fetches once; closing + reopening re-fetches (signed URLs
 * have a 1-hour expiry, so a stale cached result would 403 on click-out).
 */
function ProjectSetsPanel({ projectId }: { projectId: string }) {
  const [data,    setData]    = useState<ProjectSetsResponse | null>(null);
  const [error,   setError]   = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- data-fetch pattern: lazy load on expand; same shape as the parent's projects fetch.
    setLoading(true);
    setError(null);
    fetch(`/api/admin/projects/${projectId}/sets`, { cache: "no-store" })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((j: ProjectSetsResponse) => setData(j))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [projectId]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-xs text-ink-faint">
        <svg className="animate-spin w-3.5 h-3.5" viewBox="0 0 24 24" fill="none">
          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8z" />
        </svg>
        Loading image sets…
      </div>
    );
  }

  if (error) {
    return <p className="text-xs text-attn">{error}</p>;
  }

  if (!data || data.sets.length === 0) {
    return (
      <p className="text-xs text-ink-faint italic">
        No image sets have been approved for this project yet.
      </p>
    );
  }

  return (
    <div className="space-y-4">
      {data.sets.map((s) => (
        <section
          key={s.id}
          className="rounded-lg border border-line bg-well/40 overflow-hidden"
        >
          <header className="flex items-center justify-between gap-3 px-3 py-2 bg-panel/40 border-b border-line flex-wrap">
            <div className="flex items-center gap-3 min-w-0 flex-wrap">
              <span className="font-mono text-xs text-ink truncate">
                {s.dirName}
              </span>
              <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-ink-faint tabular-nums">
                {s.imageCount} image{s.imageCount !== 1 ? "s" : ""}
              </span>
            </div>
            <span className="text-[10px] text-muted tabular-nums">
              approved {isoDateShort(s.createdAt)}
              {s.expiresAt && (
                <> · expires {isoDateShort(s.expiresAt)}</>
              )}
            </span>
          </header>

          {s.assets.length === 0 ? (
            <p className="px-3 py-3 text-xs text-ink-faint italic">
              No assets recorded on this set.
            </p>
          ) : (
            <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-6 lg:grid-cols-8 gap-2 p-3">
              {s.assets.map((a) => (
                <a
                  key={a.assetId}
                  href={a.thumbnailUrl || "#"}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="relative aspect-square rounded overflow-hidden border border-line hover:border-line transition-colors bg-panel block"
                  title={a.filename}
                >
                  {a.thumbnailUrl ? (
                    /* eslint-disable-next-line @next/next/no-img-element -- inline thumbnail of an approval-set asset; we have a signed GCS URL and don't need next/image transformations */
                    <img
                      src={a.thumbnailUrl}
                      alt={a.filename}
                      className="w-full h-full object-cover"
                      loading="lazy"
                    />
                  ) : (
                    <div className="w-full h-full flex items-center justify-center text-[10px] text-muted">
                      no preview
                    </div>
                  )}
                  <div className="absolute inset-x-0 bottom-0 bg-linear-to-t from-black/80 to-transparent px-1.5 py-1">
                    <p className="text-[9px] font-mono text-ink truncate">
                      {a.filename}
                    </p>
                  </div>
                </a>
              ))}
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

// ─── Usage tab ────────────────────────────────────────────────────────────────

function UsageTab() {
  const [data,    setData]    = useState<UsageSummary | null>(null);
  const [error,   setError]   = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [days,    setDays]    = useState(30);

  // eslint-disable-next-line react-hooks/set-state-in-effect -- data-fetch pattern: reset loading/error then fetch and write back.
  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/admin/usage?days=${days}`, { cache: "no-store" })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((j: UsageSummary) => setData(j))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [days]);

  const totalCalls   = useMemo(
    () => data?.byProviderModel.reduce((s, r) => s + r.callCount, 0) ?? 0,
    [data],
  );
  const totalCost    = useMemo(
    () => data?.byProviderModel.reduce((s, r) => s + r.totalCostUsd, 0) ?? 0,
    [data],
  );

  return (
    <div className="space-y-4">
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <label className="flex items-center gap-2 text-xs text-ink-soft">
          Window:
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="bg-panel border border-line rounded px-2 py-1 text-xs text-ink"
          >
            {[7, 30, 90, 180, 365].map((d) => (
              <option key={d} value={d}>last {d} days</option>
            ))}
          </select>
        </label>
        {data && (
          <span className="text-xs font-mono text-ink-faint">
            {totalCalls.toLocaleString()} calls · ${totalCost.toFixed(2)} estimated
          </span>
        )}
      </header>

      {loading ? (
        <p className="text-sm text-ink-faint">Loading usage…</p>
      ) : error ? (
        <p className="text-sm text-attn">{error}</p>
      ) : !data ? null : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <section className="rounded-xl border border-line bg-well/60 overflow-hidden">
            <h3 className="font-display px-5 py-3 border-b border-line text-base uppercase tracking-[0.14em] text-ink">
              By provider / model
            </h3>
            {data.byProviderModel.length === 0 ? (
              <p className="px-4 py-6 text-xs text-ink-faint">No events in this window.</p>
            ) : (
              <table className="w-full text-xs">
                <thead className="bg-panel/40 text-xs uppercase tracking-[0.16em] text-ink-soft">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold">Provider · Model</th>
                    <th className="px-3 py-2 text-left font-semibold">Op</th>
                    <th className="px-3 py-2 text-left font-semibold">Status</th>
                    <th className="px-3 py-2 text-right font-semibold">Calls</th>
                    <th className="px-3 py-2 text-right font-semibold">Avg ms</th>
                    <th className="px-3 py-2 text-right font-semibold">Cost $</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byProviderModel.map((r, i) => (
                    <tr key={i} className="border-t border-line">
                      <td className="px-3 py-1.5 font-mono text-ink-soft">{r.provider} · {r.model}</td>
                      <td className="px-3 py-1.5 text-ink-soft">{r.operation}</td>
                      <td className={`px-3 py-1.5 font-semibold ${r.status === "failed" ? "text-attn" : "text-accent"}`}>{r.status}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-ink-soft">{r.callCount}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-ink-soft">{r.avgLatencyMs ?? "—"}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-ink-soft">{r.totalCostUsd.toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="rounded-xl border border-line bg-well/60 overflow-hidden">
            <h3 className="font-display px-5 py-3 border-b border-line text-base uppercase tracking-[0.14em] text-ink">
              By user
            </h3>
            {data.byUser.length === 0 ? (
              <p className="px-4 py-6 text-xs text-ink-faint">No events in this window.</p>
            ) : (
              <table className="w-full text-xs">
                <thead className="bg-panel/40 text-xs uppercase tracking-[0.16em] text-ink-soft">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold">User</th>
                    <th className="px-3 py-2 text-right font-semibold">Calls</th>
                    <th className="px-3 py-2 text-right font-semibold">Cost $</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byUser.map((r) => (
                    <tr key={r.userEmail} className="border-t border-line">
                      <td className="px-3 py-1.5 font-mono text-ink-soft">{r.userEmail}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-ink-soft">{r.callCount}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-ink-soft">{r.totalCostUsd.toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="rounded-xl border border-line bg-well/60 overflow-hidden lg:col-span-2">
            <h3 className="font-display px-5 py-3 border-b border-line text-base uppercase tracking-[0.14em] text-ink">
              Daily volume
            </h3>
            {data.daily.length === 0 ? (
              <p className="px-4 py-6 text-xs text-ink-faint">No events in this window.</p>
            ) : (
              <table className="w-full text-xs">
                <thead className="bg-panel/40 text-xs uppercase tracking-[0.16em] text-ink-soft">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold">Day</th>
                    <th className="px-3 py-2 text-right font-semibold">Total</th>
                    <th className="px-3 py-2 text-right font-semibold">Success</th>
                    <th className="px-3 py-2 text-right font-semibold">Failed</th>
                  </tr>
                </thead>
                <tbody>
                  {data.daily.map((r) => (
                    <tr key={r.day} className="border-t border-line">
                      <td className="px-3 py-1.5 font-mono text-ink-soft">{r.day}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-ink-soft">{r.callCount}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-accent">{r.successCount}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-attn">{r.failedCount}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

// ─── Support tab ──────────────────────────────────────────────────────────────

function SupportTab() {
  const [tickets, setTickets] = useState<SupportTicket[] | null>(null);
  const [error,   setError]   = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filter,  setFilter]  = useState<"all" | "open" | "in_progress" | "closed">("all");
  const [savingId, setSavingId] = useState<string | null>(null);

  const refresh = () => {
    setLoading(true);
    setError(null);
    const qs = filter === "all" ? "" : `?status=${filter}`;
    fetch(`/api/admin/support${qs}`, { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: { tickets: SupportTicket[] }) => setTickets(j.tickets))
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  };

  // eslint-disable-next-line react-hooks/set-state-in-effect -- refresh() is the data-fetch pattern (reset loading/error then fetch); passing it directly to useEffect is intentional.
  useEffect(refresh, [filter]);

  const updateTicket = async (id: string, patch: { status?: SupportTicket["status"]; adminNotes?: string }) => {
    setSavingId(id);
    try {
      const res = await fetch(`/api/admin/support/${id}`, {
        method:  "PATCH",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify(patch),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      // Optimistic-ish: replace in place from the server response.
      const updated = (await res.json()) as {
        id: string; user_email: string; type: "support" | "feature";
        subject: string; body: string; status: SupportTicket["status"];
        admin_notes: string | null; created_at: string; updated_at: string;
      };
      setTickets((prev) =>
        prev
          ? prev.map((t) => (t.id === id ? {
              id:         updated.id,
              userEmail:  updated.user_email,
              type:       updated.type,
              subject:    updated.subject,
              body:       updated.body,
              status:     updated.status,
              adminNotes: updated.admin_notes,
              createdAt:  updated.created_at,
              updatedAt:  updated.updated_at,
            } : t))
          : prev,
      );
    } catch {
      // Re-fetch on failure so the UI doesn't show stale state.
      refresh();
    } finally {
      setSavingId(null);
    }
  };

  return (
    <div className="space-y-3">
      <header className="flex items-center justify-between gap-3 flex-wrap">
        <label className="flex items-center gap-2 text-base text-ink font-medium">
          Status:
          <select
            value={filter}
            onChange={(e) => setFilter(e.target.value as typeof filter)}
            className="bg-panel border border-line rounded px-3 py-1.5 text-base text-ink"
          >
            <option value="all">All</option>
            <option value="open">Open</option>
            <option value="in_progress">In progress</option>
            <option value="closed">Closed</option>
          </select>
        </label>
        <button
          onClick={refresh}
          className="text-sm uppercase tracking-[0.16em] font-bold text-ink hover:text-ink border border-line hover:border-ink-faint px-3 py-1.5 rounded transition-colors"
        >
          Refresh
        </button>
      </header>

      {loading ? (
        <p className="text-base text-ink">Loading tickets…</p>
      ) : error ? (
        <p className="text-base text-attn">{error}</p>
      ) : !tickets || tickets.length === 0 ? (
        <p className="text-base text-ink">No tickets in this view.</p>
      ) : (
        <div className="space-y-3">
          {tickets.map((t) => (
            <article
              key={t.id}
              className="rounded-xl border border-line bg-well/60 overflow-hidden"
            >
              <header className="flex items-center justify-between gap-3 px-5 py-4 border-b border-line">
                <div className="flex items-center gap-2 min-w-0">
                  <span className={`text-xs uppercase tracking-[0.16em] font-bold px-2.5 py-1 rounded border ${
                    t.type === "feature"
                      ? "text-grey bg-panel-hi/60 border-line"
                      : "text-attn bg-panel border-attn"
                  }`}>
                    {t.type === "feature" ? "Feature" : "Support"}
                  </span>
                  <p className="text-lg font-bold text-ink truncate" title={t.subject}>
                    {t.subject}
                  </p>
                </div>
                <span className="text-sm text-ink font-mono shrink-0">
                  {new Date(t.createdAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}
                </span>
              </header>
              <div className="px-5 py-4 space-y-2">
                <p className="text-sm text-ink-soft font-mono">{t.userEmail}</p>
                <p className="text-base text-ink whitespace-pre-wrap leading-relaxed">{t.body}</p>
                {t.adminNotes && (
                  <p className="text-sm text-ink border-l-2 border-line pl-3 mt-2 whitespace-pre-wrap">
                    <span className="font-bold text-ink">Admin notes:</span> {t.adminNotes}
                  </p>
                )}
              </div>
              <footer className="flex items-center justify-between gap-3 px-5 py-3 bg-panel/40 border-t border-line">
                <label className="flex items-center gap-2 text-base text-ink font-medium">
                  Status:
                  <select
                    value={t.status}
                    onChange={(e) => updateTicket(t.id, { status: e.target.value as SupportTicket["status"] })}
                    disabled={savingId === t.id}
                    className="bg-panel border border-line rounded px-3 py-1.5 text-base text-ink disabled:opacity-50"
                  >
                    <option value="open">Open</option>
                    <option value="in_progress">In progress</option>
                    <option value="closed">Closed</option>
                  </select>
                </label>
                <button
                  onClick={() => {
                    const note = window.prompt("Admin notes (visible only to admins):", t.adminNotes ?? "");
                    if (note !== null) updateTicket(t.id, { adminNotes: note });
                  }}
                  disabled={savingId === t.id}
                  className="text-sm uppercase tracking-[0.16em] font-bold text-ink-soft hover:text-ink transition-colors disabled:opacity-50"
                >
                  {t.adminNotes ? "Edit notes" : "Add notes"}
                </button>
              </footer>
            </article>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main dashboard ───────────────────────────────────────────────────────────

// ─── Makes & Models (the Make / Model dropdown list) ─────────────────────────
// Seeded from the inventory CSV; operators add to it through "Other" on every
// export. This is where a typo ("Toyta") gets fixed or hidden. There is no
// delete on purpose: the inventory seed runs on every API start and would put
// a deleted inventory row straight back, so Hide is the removal.

interface KnownModelRow {
  id:        string;
  make:      string;
  model:     string;
  source:    "inventory" | "operator";
  hidden:    boolean;
  createdBy: string | null;
  createdAt: string | null;
}

function KnownModelsTab() {
  const [rows,       setRows]       = useState<KnownModelRow[] | null>(null);
  const [error,      setError]      = useState<string | null>(null);
  const [query,      setQuery]      = useState("");
  const [showHidden, setShowHidden] = useState(false);
  const [editing,    setEditing]    = useState<string | null>(null);
  const [draft,      setDraft]      = useState<{ make: string; model: string }>({ make: "", model: "" });
  const [rowError,   setRowError]   = useState<{ id: string; message: string } | null>(null);
  const [busy,       setBusy]       = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/known-models", { cache: "no-store" })
      .then((r) => r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`)))
      .then((j: { models: KnownModelRow[] }) => setRows(j.models))
      .catch((e: Error) => setError(e.message));
  }, []);

  const save = async (id: string, patch: Partial<Pick<KnownModelRow, "make" | "model" | "hidden">>) => {
    setBusy(id);
    setRowError(null);
    try {
      const r = await fetch(`/api/admin/known-models/${encodeURIComponent(id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (!r.ok) {
        // FastAPI's message ("Toyota 8FGU25 is already in the list.") arrives
        // wrapped as {detail: "<json text>"} by the BFF's forwardError.
        const raw = (await r.json().catch(() => ({ detail: `HTTP ${r.status}` }))) as { detail?: unknown };
        let message = String(raw.detail ?? `HTTP ${r.status}`);
        try { message = String((JSON.parse(message) as { detail?: unknown }).detail ?? message); } catch { /* plain text */ }
        setRowError({ id, message });
        return;
      }
      const updated = (await r.json()) as KnownModelRow;
      setRows((prev) => prev?.map((x) => (x.id === id ? { ...x, ...updated } : x)) ?? prev);
      setEditing(null);
    } finally {
      setBusy(null);
    }
  };

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    return (rows ?? []).filter((r) =>
      (showHidden || !r.hidden) &&
      (!q || `${r.make} ${r.model} ${r.createdBy ?? ""}`.toLowerCase().includes(q)));
  }, [rows, query, showHidden]);

  if (error) return <p className="text-sm text-attn">{error}</p>;
  if (!rows) return <p className="text-sm text-ink-faint">Loading makes and models…</p>;

  const hiddenCount = rows.filter((r) => r.hidden).length;
  const field = "bg-panel border border-line rounded-lg px-2.5 py-1.5 text-sm text-ink focus:outline-none focus:ring-2 focus:ring-attn focus:border-transparent w-full";
  const ghost = "px-3 py-1.5 rounded-lg border border-line bg-panel hover:bg-panel-hi text-ink font-semibold disabled:opacity-50";

  return (
    <section className="space-y-4">
      <div className="flex flex-wrap items-end gap-4">
        <label className="flex flex-col gap-1.5 min-w-64 flex-1 max-w-md">
          <span className="text-sm uppercase tracking-[0.16em] font-bold text-ink">Search</span>
          <input id="known-models-search" type="search" value={query} onChange={(e) => setQuery(e.target.value)}
            placeholder="Make, model, or who added it" className={field} />
        </label>
        <label className="flex items-center gap-2 text-sm text-ink-soft cursor-pointer select-none pb-2">
          <input id="known-models-show-hidden" type="checkbox" checked={showHidden}
            onChange={(e) => setShowHidden(e.target.checked)} className="w-4 h-4 accent-accent" />
          Show hidden ({hiddenCount})
        </label>
        <p className="text-sm text-ink-soft pb-2 ml-auto">
          {rows.length - hiddenCount} in the dropdowns. Hide removes an entry for everyone.
        </p>
      </div>

      <div className="overflow-x-auto rounded-xl border border-line">
        <table className="w-full text-sm">
          <thead className="bg-panel/60 text-xs uppercase tracking-[0.16em] text-ink">
            <tr>
              <th className="px-3 py-2 text-left font-semibold">Make</th>
              <th className="px-3 py-2 text-left font-semibold">Model</th>
              <th className="px-3 py-2 text-left font-semibold">From</th>
              <th className="px-3 py-2 text-left font-semibold">Added</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {shown.map((r) => {
              const isEditing = editing === r.id;
              return (
                <Fragment key={r.id}>
                  <tr className={`border-t border-line ${r.hidden ? "opacity-60" : "hover:bg-panel/40"}`}>
                    <td className="px-3 py-2 text-ink">
                      {isEditing
                        ? <input aria-label="Make" className={field} value={draft.make}
                            onChange={(e) => setDraft((d) => ({ ...d, make: e.target.value }))} />
                        : r.make}
                    </td>
                    <td className="px-3 py-2 text-ink">
                      {isEditing
                        ? <input aria-label="Model" className={field} value={draft.model}
                            onChange={(e) => setDraft((d) => ({ ...d, model: e.target.value }))} />
                        : r.model}
                    </td>
                    <td className="px-3 py-2 text-ink-soft">
                      {r.source === "inventory" ? "Inventory list" : "Typed by an operator"}
                      {r.hidden && <span className="ml-2 text-attn font-semibold">Hidden</span>}
                    </td>
                    <td className="px-3 py-2 text-ink-soft">
                      {r.createdBy ?? "—"} · {isoDateShort(r.createdAt)}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      <div className="inline-flex gap-2">
                        {isEditing ? (
                          <>
                            <button type="button" disabled={busy === r.id}
                              onClick={() => save(r.id, { make: draft.make, model: draft.model })}
                              className="px-3 py-1.5 rounded-lg border-2 border-cta bg-cta hover:bg-cta-dark text-white font-semibold disabled:opacity-50">
                              Save
                            </button>
                            <button type="button" className={ghost}
                              onClick={() => { setEditing(null); setRowError(null); }}>
                              Cancel
                            </button>
                          </>
                        ) : (
                          <>
                            <button type="button" className={ghost}
                              onClick={() => { setEditing(r.id); setDraft({ make: r.make, model: r.model }); setRowError(null); }}>
                              Fix spelling
                            </button>
                            <button type="button" className={ghost} disabled={busy === r.id}
                              onClick={() => save(r.id, { hidden: !r.hidden })}>
                              {r.hidden ? "Show" : "Hide"}
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  </tr>
                  {rowError?.id === r.id && (
                    <tr className="border-t border-line">
                      <td colSpan={5} className="px-3 py-2 text-attn">{rowError.message}</td>
                    </tr>
                  )}
                </Fragment>
              );
            })}
            {shown.length === 0 && (
              <tr><td colSpan={5} className="px-3 py-4 text-ink-faint">Nothing matches.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}

export function AdminDashboard({ userEmail }: { userEmail: string }) {
  const [tab, setTab] = useState<TabId>("users");
  // Cross-tab filter — clicking "View projects" on a Users row sends
  // the operator to the Projects tab pre-filtered to that email.
  const [projectFilterEmail, setProjectFilterEmail] = useState<string | null>(null);

  const tabs: { id: TabId; label: string }[] = [
    { id: "users",    label: "Users"    },
    { id: "projects", label: "Projects" },
    { id: "usage",    label: "Usage"    },
    { id: "support",  label: "Support"  },
    { id: "models",   label: "Makes & Models" },
  ];

  return (
    <div className="min-h-screen bg-bg text-ink">
      <header className="border-b border-line bg-well">
        <div className="max-w-screen-2xl mx-auto px-6 py-5 flex items-center justify-between gap-4 flex-wrap">
          <div className="flex items-center gap-4">
            <h1 className="text-2xl font-bold tracking-tight text-ink">CleanShot Admin</h1>
            <span className="text-sm uppercase tracking-[0.16em] font-bold text-attn bg-panel border border-attn rounded px-2.5 py-1">
              ADMIN
            </span>
          </div>
          <div className="flex items-center gap-5 text-base">
            <span className="font-mono text-ink">{userEmail}</span>
            <Link href="/" className="text-ink-soft hover:text-ink font-semibold">
              ← Back to workspace
            </Link>
          </div>
        </div>
        <nav className="max-w-screen-2xl mx-auto px-6 flex gap-2">
          {tabs.map((t) => {
            const active = t.id === tab;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`px-5 py-3 text-base font-bold uppercase tracking-[0.14em] border-b-2 transition-colors ${
                  active
                    ? "border-attn text-ink"
                    : "border-transparent text-ink-soft hover:text-ink"
                }`}
              >
                {t.label}
              </button>
            );
          })}
        </nav>
      </header>

      <main className="max-w-screen-2xl mx-auto px-6 py-6 space-y-6">
        <KpiRow />

        {tab === "users" && (
          <UsersTab
            onSelectUser={(email) => {
              setProjectFilterEmail(email);
              setTab("projects");
            }}
          />
        )}
        {tab === "projects" && (
          <ProjectsTab
            filterEmail={projectFilterEmail}
            onClearFilter={() => setProjectFilterEmail(null)}
          />
        )}
        {tab === "usage" && <UsageTab />}
        {tab === "support" && <SupportTab />}
        {tab === "models" && <KnownModelsTab />}
      </main>

      <footer className="px-6 py-6 text-center">
        <p className="text-[10px] text-header-bg select-none">
          Developed by Stephen Cunningham © AI App Integrations LLC 2026
        </p>
      </footer>
    </div>
  );
}
