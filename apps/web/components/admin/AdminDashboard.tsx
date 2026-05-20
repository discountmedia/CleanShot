"use client";
// apps/web/components/admin/AdminDashboard.tsx
// Three-tab admin view: Users · Projects · Usage.
//
// Each tab lazily fetches from /api/admin/* on first activation so
// dashboard load doesn't wait on three round-trips before paint.
// Data is fetched once and cached per-tab in component state — the
// admin can click Refresh to pull fresh data.

import { useEffect, useMemo, useState } from "react";

import { KpiCard } from "../workspace/KpiCard";

type TabId = "users" | "projects" | "usage";

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
        <p className="mb-2 text-xs text-red-400">Couldn&apos;t load KPIs: {error}</p>
      )}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <KpiCard
          label="Enhanced today"
          value={data?.enhancedToday ?? 0}
          color="green"
          placeholder={!loaded}
          secondary="images processed"
        />
        <KpiCard
          label="Scanned today"
          value={data?.scannedToday ?? 0}
          color="blue"
          placeholder={!loaded}
          secondary="AI verdicts"
        />
        <KpiCard
          label="Pending review"
          value={data?.pendingReview ?? 0}
          color={data && data.pendingReview > 0 ? "yellow" : "white"}
          placeholder={!loaded}
          secondary="scan fails (last 7d)"
        />
        <KpiCard
          label="GCS objects"
          value={data?.storageGcsObjects ?? 0}
          color="white"
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

  if (loading) return <p className="text-sm text-zinc-500">Loading users…</p>;
  if (error)   return <p className="text-sm text-red-400">{error}</p>;
  if (!data || data.length === 0) {
    return <p className="text-sm text-zinc-500">No users yet.</p>;
  }

  return (
    <div className="overflow-x-auto rounded-xl border border-zinc-800">
      <table className="w-full text-sm">
        <thead className="bg-zinc-900/60 text-[10px] uppercase tracking-[0.18em] text-zinc-400">
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
            <tr key={u.userEmail} className="border-t border-zinc-800 hover:bg-zinc-900/40">
              <td className="px-3 py-2 font-mono text-zinc-200">{u.userEmail}</td>
              <td className="px-3 py-2 text-right tabular-nums text-zinc-400">{u.sessionCount}</td>
              <td className="px-3 py-2 text-right tabular-nums text-zinc-400">{u.savedProjectCount}</td>
              <td className="px-3 py-2 text-right tabular-nums text-zinc-400">{u.approvalSetCount}</td>
              <td className="px-3 py-2 text-zinc-500">{isoDateShort(u.firstSeenAt)}</td>
              <td className="px-3 py-2 text-zinc-500">{isoDateShort(u.lastSeenAt)}</td>
              <td className="px-3 py-2 text-right">
                <button
                  onClick={() => onSelectUser(u.userEmail)}
                  className="text-[11px] text-blue-400 hover:text-blue-300 font-semibold"
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

  useEffect(() => {
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
        <div className="flex items-center justify-between rounded-lg border border-blue-900 bg-blue-950/30 px-3 py-2 text-xs">
          <span className="text-blue-200">
            Filtering to <code className="font-mono text-blue-100">{filterEmail}</code>
          </span>
          <button
            onClick={onClearFilter}
            className="text-blue-400 hover:text-blue-200 font-semibold uppercase tracking-[0.18em]"
          >
            Clear
          </button>
        </div>
      )}

      {loading ? (
        <p className="text-sm text-zinc-500">Loading projects…</p>
      ) : error ? (
        <p className="text-sm text-red-400">{error}</p>
      ) : !data || data.length === 0 ? (
        <p className="text-sm text-zinc-500">No saved projects yet.</p>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900/60 text-[10px] uppercase tracking-[0.18em] text-zinc-400">
              <tr>
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
              {data.map((p) => (
                <tr key={p.id} className="border-t border-zinc-800 hover:bg-zinc-900/40">
                  <td className="px-3 py-2 text-zinc-500">{isoDateShort(p.savedAt)}</td>
                  <td className="px-3 py-2 font-mono text-zinc-200">{p.userEmail}</td>
                  <td className="px-3 py-2 text-zinc-200">{p.title}</td>
                  <td className="px-3 py-2 text-zinc-300">{p.make}</td>
                  <td className="px-3 py-2 text-zinc-300">{p.model}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-400">{p.year}</td>
                  <td className="px-3 py-2 text-zinc-400">{p.capacity}</td>
                  <td className="px-3 py-2 text-zinc-400">{p.tireType}</td>
                  <td className="px-3 py-2 text-zinc-400">{p.fuelType}</td>
                  <td className="px-3 py-2 text-right tabular-nums text-zinc-400">{p.assetCount}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ─── Usage tab ────────────────────────────────────────────────────────────────

function UsageTab() {
  const [data,    setData]    = useState<UsageSummary | null>(null);
  const [error,   setError]   = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [days,    setDays]    = useState(30);

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
        <label className="flex items-center gap-2 text-xs text-zinc-400">
          Window:
          <select
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
            className="bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs text-white"
          >
            {[7, 30, 90, 180, 365].map((d) => (
              <option key={d} value={d}>last {d} days</option>
            ))}
          </select>
        </label>
        {data && (
          <span className="text-xs font-mono text-zinc-500">
            {totalCalls.toLocaleString()} calls · ${totalCost.toFixed(2)} estimated
          </span>
        )}
      </header>

      {loading ? (
        <p className="text-sm text-zinc-500">Loading usage…</p>
      ) : error ? (
        <p className="text-sm text-red-400">{error}</p>
      ) : !data ? null : (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 overflow-hidden">
            <h3 className="px-4 py-2 border-b border-zinc-800 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-300">
              By provider / model
            </h3>
            {data.byProviderModel.length === 0 ? (
              <p className="px-4 py-6 text-xs text-zinc-500">No events in this window.</p>
            ) : (
              <table className="w-full text-xs">
                <thead className="bg-zinc-900/40 text-[10px] uppercase tracking-[0.18em] text-zinc-500">
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
                    <tr key={i} className="border-t border-zinc-800">
                      <td className="px-3 py-1.5 font-mono text-zinc-300">{r.provider} · {r.model}</td>
                      <td className="px-3 py-1.5 text-zinc-400">{r.operation}</td>
                      <td className={`px-3 py-1.5 font-semibold ${r.status === "failed" ? "text-red-400" : "text-green-400"}`}>{r.status}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-zinc-300">{r.callCount}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">{r.avgLatencyMs ?? "—"}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">{r.totalCostUsd.toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 overflow-hidden">
            <h3 className="px-4 py-2 border-b border-zinc-800 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-300">
              By user
            </h3>
            {data.byUser.length === 0 ? (
              <p className="px-4 py-6 text-xs text-zinc-500">No events in this window.</p>
            ) : (
              <table className="w-full text-xs">
                <thead className="bg-zinc-900/40 text-[10px] uppercase tracking-[0.18em] text-zinc-500">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold">User</th>
                    <th className="px-3 py-2 text-right font-semibold">Calls</th>
                    <th className="px-3 py-2 text-right font-semibold">Cost $</th>
                  </tr>
                </thead>
                <tbody>
                  {data.byUser.map((r) => (
                    <tr key={r.userEmail} className="border-t border-zinc-800">
                      <td className="px-3 py-1.5 font-mono text-zinc-300">{r.userEmail}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-zinc-300">{r.callCount}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-zinc-400">{r.totalCostUsd.toFixed(4)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>

          <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 overflow-hidden lg:col-span-2">
            <h3 className="px-4 py-2 border-b border-zinc-800 text-xs font-semibold uppercase tracking-[0.18em] text-zinc-300">
              Daily volume
            </h3>
            {data.daily.length === 0 ? (
              <p className="px-4 py-6 text-xs text-zinc-500">No events in this window.</p>
            ) : (
              <table className="w-full text-xs">
                <thead className="bg-zinc-900/40 text-[10px] uppercase tracking-[0.18em] text-zinc-500">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold">Day</th>
                    <th className="px-3 py-2 text-right font-semibold">Total</th>
                    <th className="px-3 py-2 text-right font-semibold">Success</th>
                    <th className="px-3 py-2 text-right font-semibold">Failed</th>
                  </tr>
                </thead>
                <tbody>
                  {data.daily.map((r) => (
                    <tr key={r.day} className="border-t border-zinc-800">
                      <td className="px-3 py-1.5 font-mono text-zinc-300">{r.day}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-zinc-300">{r.callCount}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-green-400">{r.successCount}</td>
                      <td className="px-3 py-1.5 text-right tabular-nums text-red-400">{r.failedCount}</td>
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

// ─── Main dashboard ───────────────────────────────────────────────────────────

export function AdminDashboard({ userEmail }: { userEmail: string }) {
  const [tab, setTab] = useState<TabId>("users");
  // Cross-tab filter — clicking "View projects" on a Users row sends
  // the operator to the Projects tab pre-filtered to that email.
  const [projectFilterEmail, setProjectFilterEmail] = useState<string | null>(null);

  const tabs: { id: TabId; label: string }[] = [
    { id: "users",    label: "Users"    },
    { id: "projects", label: "Projects" },
    { id: "usage",    label: "Usage"    },
  ];

  return (
    <div className="min-h-screen bg-black text-white">
      <header className="border-b border-zinc-800 bg-zinc-950">
        <div className="max-w-screen-2xl mx-auto px-6 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <h1 className="text-base font-bold tracking-tight">CleanShot Admin</h1>
            <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-red-400 bg-red-950/40 border border-red-900 rounded px-2 py-0.5">
              ADMIN
            </span>
          </div>
          <div className="flex items-center gap-4 text-xs text-zinc-500">
            <span className="font-mono">{userEmail}</span>
            <a href="/" className="text-blue-400 hover:text-blue-300 font-semibold">
              ← Back to workspace
            </a>
          </div>
        </div>
        <nav className="max-w-screen-2xl mx-auto px-6 flex gap-1">
          {tabs.map((t) => {
            const active = t.id === tab;
            return (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`px-4 py-2 text-xs font-semibold uppercase tracking-[0.18em] border-b-2 transition-colors ${
                  active
                    ? "border-red-500 text-white"
                    : "border-transparent text-zinc-500 hover:text-zinc-300"
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
      </main>

      <footer className="px-6 py-6 text-center">
        <p className="text-[10px] text-zinc-800 select-none">
          Developed by Stephen Cunningham © AI App Integrations LLC 2026
        </p>
      </footer>
    </div>
  );
}
