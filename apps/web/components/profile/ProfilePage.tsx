"use client";
// apps/web/components/profile/ProfilePage.tsx
//
// Single client component for the entire /profile route. Sections (top
// to bottom):
//   • Header bar with link back to workspace
//   • Avatar + identity card (avatar upload via client-side resize +
//     two-step BFF flow: mint signed URL → PUT bytes → commit gs:// URI)
//   • Editable profile form (full_name / work_phone / location)
//   • Personal usage stats (filter of the existing /api/admin/usage
//     aggregations — falls back to a 'no data yet' state for users
//     with no events)
//   • Link to History tab
//   • Support / feature-request form
//
// Identity comes from the server (userEmail prop). Everything else
// flows through the BFF.

import Link from "next/link";
import { useEffect, useState } from "react";

interface ProfileResponse {
  userEmail: string;
  fullName:  string | null;
  workPhone: string | null;
  location:  string | null;
  avatarUri: string | null;
  avatarUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

interface AvatarMintResponse {
  uploadUrl: string;
  gcsUri:    string;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function resizeToSquare(file: File, edge: number): Promise<Blob> {
  // Read into ImageBitmap so we get fast off-thread decode. Center-crop
  // to a square, draw into an `edge × edge` canvas, export as JPEG.
  const bitmap = await createImageBitmap(file);
  const cropSize = Math.min(bitmap.width, bitmap.height);
  const sx = Math.floor((bitmap.width  - cropSize) / 2);
  const sy = Math.floor((bitmap.height - cropSize) / 2);

  const canvas = document.createElement("canvas");
  canvas.width  = edge;
  canvas.height = edge;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Canvas 2D context unavailable");
  ctx.drawImage(bitmap, sx, sy, cropSize, cropSize, 0, 0, edge, edge);
  bitmap.close();

  return await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("canvas.toBlob returned null"))), "image/jpeg", 0.92),
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

export function ProfilePage({ userEmail }: { userEmail: string }) {
  const [profile, setProfile] = useState<ProfileResponse | null>(null);
  const [loadErr, setLoadErr] = useState<string | null>(null);

  // Editable form state — initialised from the loaded profile.
  const [fullName,  setFullName]  = useState("");
  const [workPhone, setWorkPhone] = useState("");
  const [location,  setLocation]  = useState("");
  const [saving,    setSaving]    = useState(false);
  const [saveMsg,   setSaveMsg]   = useState<string | null>(null);

  // Avatar upload state.
  const [avatarUploading, setAvatarUploading] = useState(false);
  const [avatarMsg,       setAvatarMsg]       = useState<string | null>(null);

  // Load profile on mount.
  useEffect(() => {
    fetch("/api/profile", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((p: ProfileResponse) => {
        setProfile(p);
        setFullName(p.fullName  ?? "");
        setWorkPhone(p.workPhone ?? "");
        setLocation(p.location  ?? "");
      })
      .catch((e: Error) => setLoadErr(e.message));
  }, []);

  const handleSave = async () => {
    setSaving(true);
    setSaveMsg(null);
    try {
      const res = await fetch("/api/profile", {
        method:  "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fullName, workPhone, location }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const p = (await res.json()) as ProfileResponse;
      setProfile(p);
      setSaveMsg("Saved");
      setTimeout(() => setSaveMsg(null), 2500);
    } catch (err: unknown) {
      setSaveMsg(err instanceof Error ? `Save failed: ${err.message}` : "Save failed");
    } finally {
      setSaving(false);
    }
  };

  const handleAvatarChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ""; // allow re-selecting the same file later
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      setAvatarMsg("Please pick an image file");
      return;
    }

    setAvatarUploading(true);
    setAvatarMsg(null);
    try {
      // 1. Resize client-side to 256×256 square JPEG.
      const blob = await resizeToSquare(file, 256);

      // 2. Mint signed PUT URL.
      const mintRes = await fetch("/api/profile/avatar", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contentType: "image/jpeg" }),
      });
      if (!mintRes.ok) throw new Error(`Mint URL failed: HTTP ${mintRes.status}`);
      const { uploadUrl, gcsUri } = (await mintRes.json()) as AvatarMintResponse;

      // 3. PUT the bytes to GCS directly.
      const putRes = await fetch(uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "image/jpeg" },
        body: blob,
      });
      if (!putRes.ok) throw new Error(`GCS PUT failed: HTTP ${putRes.status}`);

      // 4. Commit the URI on the profile row.
      const commitRes = await fetch("/api/profile/avatar/commit", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ gcsUri }),
      });
      if (!commitRes.ok) throw new Error(`Commit failed: HTTP ${commitRes.status}`);
      const updated = (await commitRes.json()) as ProfileResponse;
      setProfile(updated);
      setAvatarMsg("Avatar updated");
      setTimeout(() => setAvatarMsg(null), 2500);
    } catch (err: unknown) {
      setAvatarMsg(err instanceof Error ? err.message : "Avatar upload failed");
    } finally {
      setAvatarUploading(false);
    }
  };

  return (
    <div className="min-h-screen bg-bg text-ink">
      <header className="border-b border-line bg-well">
        <div className="max-w-screen-md mx-auto px-6 py-5 flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight text-ink">My Profile</h1>
          <div className="flex items-center gap-4 text-base text-ink">
            <span className="font-mono">{userEmail}</span>
            <Link href="/" className="text-ink-soft hover:text-ink font-bold">
              ← Back to workspace
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-screen-md mx-auto px-6 py-6 space-y-6">
        {loadErr && (
          <p className="text-base text-danger-ink bg-panel border border-danger-ink rounded-lg px-4 py-3">
            Could not load profile: {loadErr}
          </p>
        )}

        {/* ── Identity + avatar ── */}
        <section className="rounded-xl border border-line bg-well/60 overflow-hidden">
          <header className="px-5 py-4 bg-panel/50 border-b border-line flex items-center justify-between">
            <span className="text-base font-bold uppercase tracking-[0.14em] text-ink">Identity</span>
            {avatarMsg && (
              <span className="text-sm uppercase tracking-[0.16em] font-bold text-ink">
                {avatarMsg}
              </span>
            )}
          </header>
          <div className="p-5 flex items-center gap-5">
            {profile?.avatarUrl ? (
              /* eslint-disable-next-line @next/next/no-img-element -- small avatar */
              <img
                src={profile.avatarUrl}
                alt=""
                className="w-24 h-24 rounded-full object-cover border border-line"
              />
            ) : (
              <div className="w-24 h-24 rounded-full bg-panel-hi border border-line flex items-center justify-center text-2xl font-bold text-ink">
                {userEmail.slice(0, 2).toUpperCase()}
              </div>
            )}
            <div className="flex-1">
              <p className="text-lg font-bold text-ink">{profile?.fullName || userEmail}</p>
              <p className="text-sm text-ink-soft font-mono mt-0.5">{userEmail}</p>
            </div>
            <label className="cursor-pointer">
              <input
                type="file"
                accept="image/*"
                onChange={handleAvatarChange}
                disabled={avatarUploading}
                className="hidden"
              />
              <span className={`inline-block text-sm uppercase tracking-[0.16em] font-bold px-4 py-2.5 rounded border transition-colors ${
                avatarUploading
                  ? "border-line text-muted cursor-not-allowed"
                  : "border-line text-ink hover:border-ink-faint hover:text-ink"
              }`}>
                {avatarUploading ? "Uploading…" : "Change avatar"}
              </span>
            </label>
          </div>
        </section>

        {/* ── Editable profile form ── */}
        <section className="rounded-xl border border-line bg-well/60 overflow-hidden">
          <header className="px-5 py-4 bg-panel/50 border-b border-line flex items-center justify-between">
            <span className="text-base font-bold uppercase tracking-[0.14em] text-ink">Details</span>
            {saveMsg && (
              <span className="text-sm uppercase tracking-[0.16em] font-bold text-accent">
                {saveMsg}
              </span>
            )}
          </header>

          {/* Tip: why these fields matter. */}
          <div className="px-5 pt-4">
            <div className="rounded-lg border border-accent bg-panel px-4 py-3">
              <p className="text-sm font-bold uppercase tracking-[0.14em] text-accent mb-1">
                Why fill these out
              </p>
              <p className="text-base text-accent leading-relaxed">
                Your <strong>name</strong>, <strong>phone</strong>, and <strong>location</strong> appear next
                to every project you create — admins and teammates use these to know who shot which set of
                photos, who to call about a listing, and which yard the unit lives in. Inaccurate fields slow
                everyone down. Take 20 seconds to fill them in correctly.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-5">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm uppercase tracking-[0.16em] text-ink font-bold">Full name</span>
              <input
                type="text"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="e.g. Stephen Cunningham"
                className="bg-panel border border-line rounded-md px-3 py-2.5 text-base text-ink placeholder-ink-faint focus:outline-none focus:ring-2 focus:ring-danger-ink focus:border-transparent transition"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm uppercase tracking-[0.16em] text-ink font-bold">Work phone</span>
              <input
                type="text"
                value={workPhone}
                onChange={(e) => setWorkPhone(e.target.value)}
                placeholder="(555) 555-5555"
                className="bg-panel border border-line rounded-md px-3 py-2.5 text-base text-ink placeholder-ink-faint focus:outline-none focus:ring-2 focus:ring-danger-ink focus:border-transparent transition"
              />
            </label>
            <label className="flex flex-col gap-1.5 md:col-span-2">
              <span className="text-sm uppercase tracking-[0.16em] text-ink font-bold">Location</span>
              <input
                type="text"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="City, State (e.g. Dallas, TX)"
                className="bg-panel border border-line rounded-md px-3 py-2.5 text-base text-ink placeholder-ink-faint focus:outline-none focus:ring-2 focus:ring-danger-ink focus:border-transparent transition"
              />
            </label>
          </div>
          <div className="px-5 pb-5">
            <button
              onClick={handleSave}
              disabled={saving}
              className={`px-6 py-2.5 rounded-lg text-base font-bold transition-colors ${
                saving
                  ? "bg-panel-hi text-ink-faint cursor-not-allowed"
                  : "bg-panel hover:bg-panel-hi text-ink"
              }`}
            >
              {saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        </section>

        {/* ── Usage stats (personal) ── */}
        <PersonalUsageCard />

        {/* ── Your Photo Library link ── */}
        <section className="rounded-xl border border-line bg-well/60 px-5 py-5 flex items-center justify-between gap-4">
          <div>
            <p className="text-lg font-bold text-ink">Your Photo Library</p>
            <p className="text-base text-ink mt-1">
              View every image set you&apos;ve approved + saved over the last 60 days.
            </p>
          </div>
          <Link
            href="/"
            className="text-sm uppercase tracking-[0.16em] font-bold text-ink-soft hover:text-ink transition-colors whitespace-nowrap"
          >
            Open Your Photo Library →
          </Link>
        </section>

        {/* ── Support / feature ticket ── */}
        <SupportTicketForm />

        <footer className="text-center">
          <p className="text-[10px] text-header-bg select-none">
            Developed by Stephen Cunningham © AI App Integrations LLC 2026
          </p>
        </footer>
      </main>
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

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

interface UsageSummary {
  windowDays:      number;
  byProviderModel: UsageByProviderModel[];
  byUser:          UsageByUser[];
}

function PersonalUsageCard() {
  // We reuse /api/admin/usage for the data — but that endpoint is
  // admin-gated. For now we just attempt it; if forbidden we render
  // a friendly placeholder. Future improvement: a dedicated
  // /api/profile/usage endpoint that returns the caller's own rollup.
  const [data, setData] = useState<UsageSummary | null>(null);
  const [err, setErr]   = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/admin/usage?days=30", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((j: UsageSummary) => setData(j))
      .catch((e: Error) => setErr(e.message));
  }, []);

  return (
    <section className="rounded-xl border border-line bg-well/60 overflow-hidden">
      <header className="px-5 py-4 bg-panel/50 border-b border-line">
        <span className="text-base font-bold uppercase tracking-[0.14em] text-ink">
          My usage (last 30 days)
        </span>
      </header>
      {err ? (
        <p className="px-5 py-6 text-base text-ink">
          Usage stats are admin-only right now. Ask your admin for a personal-usage feed.
        </p>
      ) : !data ? (
        <p className="px-5 py-6 text-base text-ink">Loading…</p>
      ) : data.byUser.length === 0 ? (
        <p className="px-5 py-6 text-base text-ink">No tracked events yet — run an enhance to populate this.</p>
      ) : (
        <table className="w-full text-base">
          <thead className="bg-panel/60 text-xs uppercase tracking-[0.16em] text-ink">
            <tr>
              <th className="px-4 py-3 text-left font-bold">Provider / model</th>
              <th className="px-4 py-3 text-right font-bold">Calls</th>
              <th className="px-4 py-3 text-right font-bold">Cost $</th>
            </tr>
          </thead>
          <tbody>
            {data.byProviderModel.map((r, i) => (
              <tr key={i} className="border-t border-line">
                <td className="px-4 py-2 font-mono text-ink">{r.provider} · {r.model}</td>
                <td className="px-4 py-2 text-right tabular-nums text-ink">{r.callCount}</td>
                <td className="px-4 py-2 text-right tabular-nums text-ink">{r.totalCostUsd.toFixed(4)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function SupportTicketForm() {
  const [type,    setType]    = useState<"support" | "feature">("support");
  const [subject, setSubject] = useState("");
  const [body,    setBody]    = useState("");
  const [sending, setSending] = useState(false);
  const [msg,     setMsg]     = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSending(true);
    setMsg(null);
    try {
      const res = await fetch("/api/support", {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type, subject, body }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setSubject("");
      setBody("");
      setMsg(`${type === "feature" ? "Feature request" : "Support ticket"} sent to the admin`);
      setTimeout(() => setMsg(null), 4000);
    } catch (err: unknown) {
      setMsg(err instanceof Error ? `Failed: ${err.message}` : "Failed");
    } finally {
      setSending(false);
    }
  };

  return (
    <section className="rounded-xl border border-line bg-well/60 overflow-hidden">
      <header className="px-5 py-4 bg-panel/50 border-b border-line flex items-center justify-between">
        <span className="text-base font-bold uppercase tracking-[0.14em] text-ink">
          Contact the admin
        </span>
        {msg && (
          <span className="text-sm uppercase tracking-[0.16em] font-bold text-accent">
            {msg}
          </span>
        )}
      </header>
      <form onSubmit={handleSubmit} className="p-5 space-y-4">
        <div className="flex items-center gap-6 text-base">
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="ticket-type"
              checked={type === "support"}
              onChange={() => setType("support")}
              className="accent-accent w-4 h-4"
            />
            <span className="text-ink font-medium">Support / bug</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="ticket-type"
              checked={type === "feature"}
              onChange={() => setType("feature")}
              className="accent-accent w-4 h-4"
            />
            <span className="text-ink font-medium">Feature request</span>
          </label>
        </div>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm uppercase tracking-[0.16em] text-ink font-bold">Subject</span>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            required
            maxLength={200}
            className="bg-panel border border-line rounded-md px-3 py-2.5 text-base text-ink placeholder-ink-faint focus:outline-none focus:ring-2 focus:ring-danger-ink focus:border-transparent transition"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm uppercase tracking-[0.16em] text-ink font-bold">Details</span>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            required
            rows={5}
            maxLength={4000}
            className="bg-panel border border-line rounded-md px-3 py-2.5 text-base text-ink placeholder-ink-faint focus:outline-none focus:ring-2 focus:ring-danger-ink focus:border-transparent transition resize-y"
          />
        </label>
        <button
          type="submit"
          disabled={sending || !subject.trim() || !body.trim()}
          className={`px-6 py-2.5 rounded-lg text-base font-bold transition-colors ${
            sending || !subject.trim() || !body.trim()
              ? "bg-panel-hi text-ink-faint cursor-not-allowed"
              : "bg-danger hover:bg-danger-dark text-white"
          }`}
        >
          {sending ? "Sending…" : "Send to admin"}
        </button>
      </form>
    </section>
  );
}
