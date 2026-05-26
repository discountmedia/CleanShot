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
    <div className="min-h-screen bg-black text-white">
      <header className="border-b border-zinc-800 bg-zinc-950">
        <div className="max-w-screen-md mx-auto px-6 py-5 flex items-center justify-between">
          <h1 className="text-2xl font-bold tracking-tight text-white">My Profile</h1>
          <div className="flex items-center gap-4 text-base text-zinc-200">
            <span className="font-mono">{userEmail}</span>
            <Link href="/" className="text-blue-300 hover:text-white font-bold">
              ← Back to workspace
            </Link>
          </div>
        </div>
      </header>

      <main className="max-w-screen-md mx-auto px-6 py-6 space-y-6">
        {loadErr && (
          <p className="text-base text-red-300 bg-red-950/40 border border-red-800 rounded-lg px-4 py-3">
            Could not load profile: {loadErr}
          </p>
        )}

        {/* ── Identity + avatar ── */}
        <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 overflow-hidden">
          <header className="px-5 py-4 bg-zinc-900/50 border-b border-zinc-800 flex items-center justify-between">
            <span className="text-base font-bold uppercase tracking-[0.14em] text-zinc-100">Identity</span>
            {avatarMsg && (
              <span className="text-sm uppercase tracking-[0.16em] font-bold text-zinc-200">
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
                className="w-24 h-24 rounded-full object-cover border border-zinc-700"
              />
            ) : (
              <div className="w-24 h-24 rounded-full bg-zinc-800 border border-zinc-700 flex items-center justify-center text-2xl font-bold text-zinc-200">
                {userEmail.slice(0, 2).toUpperCase()}
              </div>
            )}
            <div className="flex-1">
              <p className="text-lg font-bold text-white">{profile?.fullName || userEmail}</p>
              <p className="text-sm text-zinc-300 font-mono mt-0.5">{userEmail}</p>
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
                  ? "border-zinc-800 text-zinc-600 cursor-not-allowed"
                  : "border-zinc-600 text-zinc-100 hover:border-zinc-400 hover:text-white"
              }`}>
                {avatarUploading ? "Uploading…" : "Change avatar"}
              </span>
            </label>
          </div>
        </section>

        {/* ── Editable profile form ── */}
        <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 overflow-hidden">
          <header className="px-5 py-4 bg-zinc-900/50 border-b border-zinc-800 flex items-center justify-between">
            <span className="text-base font-bold uppercase tracking-[0.14em] text-zinc-100">Details</span>
            {saveMsg && (
              <span className="text-sm uppercase tracking-[0.16em] font-bold text-green-300">
                {saveMsg}
              </span>
            )}
          </header>

          {/* Tip: why these fields matter. */}
          <div className="px-5 pt-4">
            <div className="rounded-lg border border-yellow-700/60 bg-yellow-950/30 px-4 py-3">
              <p className="text-sm font-bold uppercase tracking-[0.14em] text-yellow-200 mb-1">
                Why fill these out
              </p>
              <p className="text-base text-yellow-100 leading-relaxed">
                Your <strong>name</strong>, <strong>phone</strong>, and <strong>location</strong> appear next
                to every project you create — admins and teammates use these to know who shot which set of
                photos, who to call about a listing, and which yard the unit lives in. Inaccurate fields slow
                everyone down. Take 20 seconds to fill them in correctly.
              </p>
            </div>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-5">
            <label className="flex flex-col gap-1.5">
              <span className="text-sm uppercase tracking-[0.16em] text-zinc-100 font-bold">Full name</span>
              <input
                type="text"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="e.g. Stephen Cunningham"
                className="bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2.5 text-base text-white placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent transition"
              />
            </label>
            <label className="flex flex-col gap-1.5">
              <span className="text-sm uppercase tracking-[0.16em] text-zinc-100 font-bold">Work phone</span>
              <input
                type="text"
                value={workPhone}
                onChange={(e) => setWorkPhone(e.target.value)}
                placeholder="(555) 555-5555"
                className="bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2.5 text-base text-white placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent transition"
              />
            </label>
            <label className="flex flex-col gap-1.5 md:col-span-2">
              <span className="text-sm uppercase tracking-[0.16em] text-zinc-100 font-bold">Location</span>
              <input
                type="text"
                value={location}
                onChange={(e) => setLocation(e.target.value)}
                placeholder="City, State (e.g. Dallas, TX)"
                className="bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2.5 text-base text-white placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent transition"
              />
            </label>
          </div>
          <div className="px-5 pb-5">
            <button
              onClick={handleSave}
              disabled={saving}
              className={`px-6 py-2.5 rounded-lg text-base font-bold transition-colors ${
                saving
                  ? "bg-zinc-800 text-zinc-500 cursor-not-allowed"
                  : "bg-blue-600 hover:bg-blue-500 text-white"
              }`}
            >
              {saving ? "Saving…" : "Save changes"}
            </button>
          </div>
        </section>

        {/* ── Usage stats (personal) ── */}
        <PersonalUsageCard />

        {/* ── History link ── */}
        <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 px-5 py-5 flex items-center justify-between gap-4">
          <div>
            <p className="text-lg font-bold text-white">Project history</p>
            <p className="text-base text-zinc-200 mt-1">
              View every image set you&apos;ve approved + saved over the last 60 days.
            </p>
          </div>
          <Link
            href="/"
            className="text-sm uppercase tracking-[0.16em] font-bold text-blue-300 hover:text-white transition-colors whitespace-nowrap"
          >
            Open History tab →
          </Link>
        </section>

        {/* ── Support / feature ticket ── */}
        <SupportTicketForm />

        <footer className="text-center">
          <p className="text-[10px] text-zinc-950 select-none">
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
    <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 overflow-hidden">
      <header className="px-5 py-4 bg-zinc-900/50 border-b border-zinc-800">
        <span className="text-base font-bold uppercase tracking-[0.14em] text-zinc-100">
          My usage (last 30 days)
        </span>
      </header>
      {err ? (
        <p className="px-5 py-6 text-base text-zinc-200">
          Usage stats are admin-only right now. Ask your admin for a personal-usage feed.
        </p>
      ) : !data ? (
        <p className="px-5 py-6 text-base text-zinc-200">Loading…</p>
      ) : data.byUser.length === 0 ? (
        <p className="px-5 py-6 text-base text-zinc-200">No tracked events yet — run an enhance to populate this.</p>
      ) : (
        <table className="w-full text-base">
          <thead className="bg-zinc-900/60 text-xs uppercase tracking-[0.16em] text-zinc-200">
            <tr>
              <th className="px-4 py-3 text-left font-bold">Provider / model</th>
              <th className="px-4 py-3 text-right font-bold">Calls</th>
              <th className="px-4 py-3 text-right font-bold">Cost $</th>
            </tr>
          </thead>
          <tbody>
            {data.byProviderModel.map((r, i) => (
              <tr key={i} className="border-t border-zinc-800">
                <td className="px-4 py-2 font-mono text-zinc-100">{r.provider} · {r.model}</td>
                <td className="px-4 py-2 text-right tabular-nums text-zinc-100">{r.callCount}</td>
                <td className="px-4 py-2 text-right tabular-nums text-zinc-200">{r.totalCostUsd.toFixed(4)}</td>
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
    <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 overflow-hidden">
      <header className="px-5 py-4 bg-zinc-900/50 border-b border-zinc-800 flex items-center justify-between">
        <span className="text-base font-bold uppercase tracking-[0.14em] text-zinc-100">
          Contact the admin
        </span>
        {msg && (
          <span className="text-sm uppercase tracking-[0.16em] font-bold text-green-300">
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
              className="accent-red-500 w-4 h-4"
            />
            <span className="text-zinc-100 font-medium">Support / bug</span>
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input
              type="radio"
              name="ticket-type"
              checked={type === "feature"}
              onChange={() => setType("feature")}
              className="accent-red-500 w-4 h-4"
            />
            <span className="text-zinc-100 font-medium">Feature request</span>
          </label>
        </div>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm uppercase tracking-[0.16em] text-zinc-100 font-bold">Subject</span>
          <input
            type="text"
            value={subject}
            onChange={(e) => setSubject(e.target.value)}
            required
            maxLength={200}
            className="bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2.5 text-base text-white placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent transition"
          />
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-sm uppercase tracking-[0.16em] text-zinc-100 font-bold">Details</span>
          <textarea
            value={body}
            onChange={(e) => setBody(e.target.value)}
            required
            rows={5}
            maxLength={4000}
            className="bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2.5 text-base text-white placeholder-zinc-400 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent transition resize-y"
          />
        </label>
        <button
          type="submit"
          disabled={sending || !subject.trim() || !body.trim()}
          className={`px-6 py-2.5 rounded-lg text-base font-bold transition-colors ${
            sending || !subject.trim() || !body.trim()
              ? "bg-zinc-800 text-zinc-500 cursor-not-allowed"
              : "bg-red-600 hover:bg-red-500 text-white"
          }`}
        >
          {sending ? "Sending…" : "Send to admin"}
        </button>
      </form>
    </section>
  );
}
