"use client";
// apps/web/components/resize/ResizePanel.tsx
//
// Resize tab — Phase 3
//
// Flow:
//   1. Operator fills the 9 project fields (or accepts defaults from prior
//      tabs once that state is lifted to Workspace — currently not lifted,
//      so this tab collects them fresh).
//   2. Click "Save Project"      → POST /api/projects/save
//      Backend flips projects.saved_at, unblocking the export endpoints.
//   3. Click "Export PRO (ZIP)"  → POST /api/export/pro
//      Backend returns a binary ZIP (or single JPEG if only one asset).
//      The browser is then handed the blob via an <a download> click.
//
// PRO spec (server-enforced via pyvips, see services/image_processing.py):
//   • 1024×731 px, 7:5 aspect ratio
//   • Zoom-to-fill (crop, never letterbox)
//   • JPEG, iteratively re-encoded until ≤100 KB (or X-Warning header set)
//
// Custom + Fullsize + streaming-ZIP endpoints exist on the backend too but
// are intentionally not surfaced here yet — PRO is the only preset the
// operator needs day-to-day. Add an "Advanced" disclosure later if usage
// data shows they're wanted.

import { useState } from "react";
import {
  exportProAsBlob,
  saveProject,
  triggerBrowserDownload,
} from "../../lib/api";
import type { ResizeResult } from "../../lib/types";

export interface ResizePanelProps {
  sessionId: string;
  /** Curated list of assets the user "Send to Resize"'d from the Scan tab. */
  enhancedAssets: Array<{ assetId: string; filename: string; thumbnailUrl: string }>;
  /**
   * Kept for prop compatibility with Workspace. The current PRO flow returns a
   * single ZIP blob and does not produce per-asset ResizeResult rows, so this
   * isn't rendered. Wire it up when a future preview-grid UX needs per-image
   * signed URLs.
   */
  resizeResults: ResizeResult[];
  /** Kept for prop compatibility with Workspace; not currently invoked. */
  onResizeComplete: (results: ResizeResult[]) => void;
}

type PhotoType = "auction" | "studio";

interface ProjectForm {
  title:     string;
  make:      string;
  year:      string;        // input value; parsed to int before send
  model:     string;
  tireType:  string;
  capacity:  string;
  fuelType:  string;
  username:  string;
  photoType: PhotoType;
}

const EMPTY_FORM: ProjectForm = {
  title:     "",
  make:      "",
  year:      "",
  model:     "",
  tireType:  "",
  capacity:  "",
  fuelType:  "",
  username:  "",
  photoType: "auction",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function validateForm(form: ProjectForm): { valid: boolean; yearNum: number | null } {
  const yearNum = Number.parseInt(form.year, 10);
  const yearOk  = Number.isInteger(yearNum) && yearNum >= 1900 && yearNum <= 2100;
  const allTextFieldsOk = (
    form.title.trim().length    > 0 &&
    form.make.trim().length     > 0 &&
    form.model.trim().length    > 0 &&
    form.tireType.trim().length > 0 &&
    form.capacity.trim().length > 0 &&
    form.fuelType.trim().length > 0 &&
    form.username.trim().length > 0
  );
  return {
    valid:   allTextFieldsOk && yearOk,
    yearNum: yearOk ? yearNum : null,
  };
}

// ─── Form field components ────────────────────────────────────────────────────

function TextField({
  label, value, onChange, placeholder, disabled,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold">
        {label}
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent transition disabled:opacity-50"
      />
    </label>
  );
}

function SelectField<T extends string>({
  label, value, options, onChange, disabled,
}: {
  label: string;
  value: T;
  options: readonly { value: T; label: string }[];
  onChange: (v: T) => void;
  disabled?: boolean;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 font-semibold">
        {label}
      </span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        disabled={disabled}
        className="bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-sm text-white focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent transition disabled:opacity-50"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </label>
  );
}

// ─── Main panel ───────────────────────────────────────────────────────────────

export function ResizePanel({
  sessionId,
  enhancedAssets,
}: ResizePanelProps) {
  const [form, setForm] = useState<ProjectForm>(EMPTY_FORM);

  // Status flags. `isSaved` flips true after a successful Save — Export is
  // gated on it. Editing the form after a successful Save does NOT unset
  // isSaved (the backend project row is still saved); we re-enable Save so
  // the user can push the updated metadata in (it's an UPSERT server-side).
  const [isSaving,    setIsSaving]    = useState(false);
  const [isSaved,     setIsSaved]     = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [error,       setError]       = useState<string | null>(null);
  const [warning,     setWarning]     = useState<string | null>(null);
  const [lastDownloadedAt, setLastDownloadedAt] = useState<Date | null>(null);

  const { valid: formValid, yearNum } = validateForm(form);
  const hasAssets = enhancedAssets.length > 0;
  const canSave   = formValid && !isSaving;
  const canExport = isSaved && hasAssets && !isExporting;

  const updateField = <K extends keyof ProjectForm>(key: K, value: ProjectForm[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  // ─── Save ───────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    if (!formValid || yearNum === null) return;
    setError(null);
    setIsSaving(true);
    try {
      await saveProject({
        sessionId,
        title:     form.title.trim(),
        make:      form.make.trim(),
        year:      yearNum,
        model:     form.model.trim(),
        tireType:  form.tireType.trim(),
        capacity:  form.capacity.trim(),
        fuelType:  form.fuelType.trim(),
        username:  form.username.trim(),
        photoType: form.photoType,
      });
      setIsSaved(true);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setIsSaving(false);
    }
  };

  // ─── Export ─────────────────────────────────────────────────────────────────

  const handleExport = async () => {
    if (!hasAssets) return;
    setError(null);
    setWarning(null);
    setIsExporting(true);
    try {
      const { blob, filename, warning: w } = await exportProAsBlob({
        sessionId,
        assetIds: enhancedAssets.map((a) => a.assetId),
      });
      triggerBrowserDownload(blob, filename);
      setLastDownloadedAt(new Date());
      if (w) setWarning(w);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setIsExporting(false);
    }
  };

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">

      {/* ── Spec card ── */}
      <div className="bg-zinc-900 border border-zinc-800 rounded-xl p-4 space-y-2">
        <h3 className="text-sm font-semibold text-zinc-200">PRO Export Spec</h3>
        <ul className="text-xs text-zinc-400 space-y-1" role="list">
          <li>• <strong className="text-zinc-300">1024 × 731 px</strong> — 7:5 aspect ratio</li>
          <li>• <strong className="text-zinc-300">Zoom-to-fill</strong> — smart-crop to subject, no letterboxing</li>
          <li>• <strong className="text-zinc-300">≤ 99 KB JPEG</strong> — quality iterated until target</li>
          <li>• Batch returns as a single ZIP; single asset returns as JPEG</li>
        </ul>
      </div>

      {/* ── Asset count ── */}
      <div className="rounded-xl border border-zinc-800 bg-zinc-950/60 px-4 py-3 flex items-center justify-between">
        <span className="text-xs uppercase tracking-[0.18em] text-zinc-500 font-semibold">
          Assets queued
        </span>
        <span className={`text-sm font-mono tabular-nums ${hasAssets ? "text-zinc-200" : "text-zinc-500"}`}>
          {enhancedAssets.length}
        </span>
      </div>

      {/* ── Project form ── */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 overflow-hidden">
        <header className="flex items-center justify-between px-4 py-3 bg-zinc-900/50 border-b border-zinc-800">
          <span className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-300">
            Project Details
          </span>
          {isSaved && (
            <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-green-400">
              Saved ✓
            </span>
          )}
        </header>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 p-4">
          <TextField
            label="Title"
            value={form.title}
            onChange={(v) => updateField("title", v)}
            placeholder="e.g. Toyota 8FGU25 2019 — Lot 042"
          />
          <TextField
            label="Username"
            value={form.username}
            onChange={(v) => updateField("username", v)}
            placeholder="Your name or initials"
          />
          <TextField
            label="Make"
            value={form.make}
            onChange={(v) => updateField("make", v)}
            placeholder="Toyota"
          />
          <TextField
            label="Model"
            value={form.model}
            onChange={(v) => updateField("model", v)}
            placeholder="8FGU25"
          />
          <TextField
            label="Year"
            value={form.year}
            onChange={(v) => updateField("year", v.replace(/[^0-9]/g, "").slice(0, 4))}
            placeholder="2019"
          />
          <TextField
            label="Capacity"
            value={form.capacity}
            onChange={(v) => updateField("capacity", v)}
            placeholder="5000 lbs"
          />
          <TextField
            label="Tire type"
            value={form.tireType}
            onChange={(v) => updateField("tireType", v)}
            placeholder="Pneumatic / Cushion / Non-marking"
          />
          <TextField
            label="Fuel type"
            value={form.fuelType}
            onChange={(v) => updateField("fuelType", v)}
            placeholder="LP / Diesel / Electric"
          />
          <SelectField<PhotoType>
            label="Photo type"
            value={form.photoType}
            options={[
              { value: "auction", label: "Auction" },
              { value: "studio",  label: "Studio"  },
            ]}
            onChange={(v) => updateField("photoType", v)}
          />
        </div>
      </section>

      {/* ── Error / warning banners ── */}
      {error && (
        <p
          className="text-sm text-red-400 bg-red-950/40 border border-red-800 rounded-lg px-4 py-3"
          role="alert"
        >
          {error}
        </p>
      )}
      {warning && (
        <p
          className="text-sm text-amber-300 bg-amber-950/40 border border-amber-800 rounded-lg px-4 py-3"
          role="status"
        >
          Some images could not be compressed under 99 KB — they were exported at the lowest JPEG quality the encoder allows. Inspect the ZIP and re-shoot any that look unacceptable.
        </p>
      )}

      {/* ── Save + Export actions ── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <button
          onClick={handleSave}
          disabled={!canSave}
          className={`
            py-3 px-6 rounded-xl font-semibold text-sm transition-all
            ${canSave
              ? isSaved
                ? "bg-green-700 hover:bg-green-600 text-white"
                : "bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-900/40"
              : "bg-zinc-800 text-zinc-500 cursor-not-allowed"}
          `}
        >
          {isSaving
            ? "Saving project…"
            : isSaved
              ? "Re-save Project"
              : !formValid
                ? "Fill all fields to save"
                : "Save Project"}
        </button>

        <button
          onClick={handleExport}
          disabled={!canExport}
          className={`
            py-3 px-6 rounded-xl font-semibold text-sm transition-all
            ${canExport
              ? "bg-blue-600 hover:bg-blue-500 text-white shadow-lg shadow-blue-900/40"
              : "bg-zinc-800 text-zinc-500 cursor-not-allowed"}
          `}
        >
          {isExporting
            ? "Building PRO export…"
            : !isSaved
              ? "Save project first"
              : !hasAssets
                ? "No assets queued"
                : `Export PRO (${enhancedAssets.length} image${enhancedAssets.length !== 1 ? "s" : ""})`}
        </button>
      </div>

      {lastDownloadedAt && (
        <p className="text-[11px] text-zinc-500 text-center">
          Last download triggered at{" "}
          {lastDownloadedAt.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
        </p>
      )}
    </div>
  );
}
