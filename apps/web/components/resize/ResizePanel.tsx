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

import { useEffect, useState } from "react";
import {
  approveSet,
  exportProPreviewStream,
  saveProject,
  type ExportProPreviewItem,
} from "../../lib/api";
import type { ForkliftMeta, ResizeResult } from "../../lib/types";

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
  /**
   * Shared forklift metadata from Workspace state. The Resize tab's Save
   * Project form pre-fills from this — the operator already typed
   * make / model / year on the Enhance tab, so re-entry would be busywork.
   * Read-only here (the form has its own local edit state for any
   * field the operator wants to tweak before saving).
   */
  meta: Partial<ForkliftMeta>;
  /**
   * Signed-in user's email. Used to pre-fill the Username field so the
   * operator doesn't re-type it every project.
   */
  userEmail: string;
}

interface ProjectForm {
  make:      string;
  year:      string;        // input value; parsed to int before send
  model:     string;
  tireType:  string;
  capacity:  string;
  fuelType:  string;
  username:  string;
}

const EMPTY_FORM: ProjectForm = {
  make:      "",
  year:      "",
  model:     "",
  tireType:  "",
  capacity:  "",
  fuelType:  "",
  username:  "",
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function validateForm(form: ProjectForm): { valid: boolean; yearNum: number | null } {
  // Per-product call: only `make` and `model` are gating fields for the
  // Save Project action. Year is parsed if provided (validated 1900-2100)
  // and falls back to the current year when blank. Capacity / tireType /
  // fuelType / username are nice-to-have free text — empty values get
  // replaced with "unknown" / the operator's email before send so the
  // backend's NOT-NULL columns are still satisfied.
  const yearRaw = form.year.trim();
  let yearNum: number | null = null;
  if (yearRaw.length === 0) {
    yearNum = new Date().getFullYear();
  } else {
    const parsed = Number.parseInt(yearRaw, 10);
    if (Number.isInteger(parsed) && parsed >= 1900 && parsed <= 2100) {
      yearNum = parsed;
    }
  }
  const valid = form.make.trim().length > 0 && form.model.trim().length > 0 && yearNum !== null;
  return { valid, yearNum };
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

// ─── Main panel ───────────────────────────────────────────────────────────────

export function ResizePanel({
  sessionId,
  enhancedAssets,
  meta,
  userEmail,
}: ResizePanelProps) {
  // Initialise the form from the values the operator already entered on
  // the Enhance tab + their signed-in email. Once the form mounts the
  // local state takes over — edits stay local until Save Project. If
  // the operator returns to Enhance and changes meta, the next mount of
  // this panel (or the effect below) reflects the new values.
  const [form, setForm] = useState<ProjectForm>(() => ({
    ...EMPTY_FORM,
    make:     meta.make     ?? "",
    model:    meta.model    ?? "",
    year:     meta.year     ?? "",
    tireType: meta.tireType ?? "",
    capacity: meta.capacity ?? "",
    fuelType: meta.fuelType ?? "",
    username: userEmail && userEmail !== "dev@local" ? userEmail : "",
  }));

  // Keep the form in sync when Workspace's meta changes (e.g. the
  // operator edits the Enhance form while the Resize panel is mounted
  // but hidden). Only fills in fields the operator hasn't already
  // touched locally — once they've typed something we don't clobber it.
  useEffect(() => {
    setForm((prev) => ({
      ...prev,
      make:     prev.make     || (meta.make     ?? ""),
      model:    prev.model    || (meta.model    ?? ""),
      year:     prev.year     || (meta.year     ?? ""),
      tireType: prev.tireType || (meta.tireType ?? ""),
      capacity: prev.capacity || (meta.capacity ?? ""),
      fuelType: prev.fuelType || (meta.fuelType ?? ""),
      username: prev.username || (userEmail && userEmail !== "dev@local" ? userEmail : ""),
    }));
  }, [meta, userEmail]);

  // Status flags. `isSaved` flips true after a successful Save — Export is
  // gated on it. Editing the form after a successful Save does NOT unset
  // isSaved (the backend project row is still saved); we re-enable Save so
  // the user can push the updated metadata in (it's an UPSERT server-side).
  const [isSaving,    setIsSaving]    = useState(false);
  const [isSaved,     setIsSaved]     = useState(false);
  const [isExporting, setIsExporting] = useState(false);
  const [error,       setError]       = useState<string | null>(null);

  // Preview state: populated by the /api/export/pro/preview response.
  // When non-null the grid renders, the operator visually verifies the
  // 7:5 zoom-to-fill output, then clicks "Download ZIP" (a direct GCS
  // hyperlink — no second backend roundtrip).
  const [previewItems, setPreviewItems] = useState<ExportProPreviewItem[]>([]);
  const [zipUrl,       setZipUrl]       = useState<string | null>(null);
  const [zipSizeBytes, setZipSizeBytes] = useState<number>(0);
  const [anyWarning,   setAnyWarning]   = useState<boolean>(false);

  // Streaming progress state — populated by exportProPreviewStream's
  // callbacks. While `progressTotal > 0` and the result hasn't arrived
  // yet, the UI renders a determinate progress bar instead of just a
  // spinner.
  const [progressTotal,    setProgressTotal]    = useState<number>(0);
  const [progressCurrent,  setProgressCurrent]  = useState<number>(0);
  const [progressFilename, setProgressFilename] = useState<string>("");

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
      // Auto-derive title from make/model/year — the backend's
      // SaveProjectRequest still requires a title (min_length=1), but the
      // operator already enters those values so re-typing a third name
      // would be busywork. photoType isn't surfaced in the UI either;
      // defaults to "auction" since that's the dominant use case.
      const derivedTitle =
        [form.make, form.model, form.year].map((s) => s.trim()).filter(Boolean).join(" ")
        || "Untitled";

      // Only make + model are gating fields on the form. Everything else
      // is nice-to-have, but the FastAPI schema still requires min_length=1
      // on each column. Substitute sensible placeholders when the
      // operator left them blank rather than blocking the save.
      const tireTypeOut = form.tireType.trim() || "unknown";
      const capacityOut = form.capacity.trim() || "unknown";
      const fuelTypeOut = form.fuelType.trim() || "unknown";
      const usernameOut = form.username.trim() || (userEmail && userEmail !== "dev@local" ? userEmail : "unknown");

      // 1. Commit the project metadata (unlocks the export endpoints
      // server-side by setting projects.saved_at).
      await saveProject({
        sessionId,
        title:     derivedTitle,
        make:      form.make.trim(),
        year:      yearNum,
        model:     form.model.trim(),
        tireType:  tireTypeOut,
        capacity:  capacityOut,
        fuelType:  fuelTypeOut,
        username:  usernameOut,
        photoType: "auction",
      });

      // 2. Commit the curated image set to History. Save Project is the
      // single trigger that does both — there is no separate "Approve
      // All" action. Skips silently if no assets are queued; the user
      // can still save the project metadata without an image set yet.
      if (enhancedAssets.length > 0) {
        await approveSet({
          sessionId,
          assetIds: enhancedAssets.map((a) => a.assetId),
          projectMeta: {
            make:  form.make.trim()  || "unknown",
            model: form.model.trim() || "unknown",
            year:  form.year.trim(),
          },
        });
      }

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
    setIsExporting(true);
    // Wipe stale preview + progress so the loading state is unambiguous.
    setPreviewItems([]);
    setZipUrl(null);
    setZipSizeBytes(0);
    setAnyWarning(false);
    setProgressTotal(0);
    setProgressCurrent(0);
    setProgressFilename("");
    try {
      await exportProPreviewStream(
        {
          sessionId,
          assetIds: enhancedAssets.map((a) => a.assetId),
        },
        {
          onStarted: (total) => {
            setProgressTotal(total);
            setProgressCurrent(0);
          },
          onProgress: (p) => {
            setProgressCurrent(p.current);
            setProgressFilename(p.filename);
          },
          onResult: (resp) => {
            setPreviewItems(resp.items);
            setZipUrl(resp.zipUrl);
            setZipSizeBytes(resp.zipSizeBytes);
            setAnyWarning(resp.anySizeWarning);
          },
        },
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setIsExporting(false);
      // Leave the progress numbers in place after success so the bar
      // doesn't snap back to 0 between the last progress event and the
      // grid render. They get reset on the next click.
    }
  };

  // Format bytes as KB or MB for the status badges.
  const formatBytes = (b: number): string => {
    if (b < 1024) return `${b} B`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} KB`;
    return `${(b / (1024 * 1024)).toFixed(2)} MB`;
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
          <div className="flex flex-col gap-0.5">
            <span className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-300">
              Project Details
            </span>
            <span className="text-[10px] text-zinc-500">
              Save Project commits this metadata AND adds the queued image set to your History tab. Only <span className="text-zinc-300">Make</span> and <span className="text-zinc-300">Model</span> are required.
            </span>
          </div>
          {isSaved && (
            <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-green-400">
              Saved ✓
            </span>
          )}
        </header>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 p-4">
          <TextField
            label="Make *"
            value={form.make}
            onChange={(v) => updateField("make", v)}
            placeholder="Toyota"
          />
          <TextField
            label="Model *"
            value={form.model}
            onChange={(v) => updateField("model", v)}
            placeholder="8FGU25"
          />
          <TextField
            label="Year"
            value={form.year}
            onChange={(v) => updateField("year", v.replace(/[^0-9]/g, "").slice(0, 4))}
            placeholder="defaults to current year"
          />
          <TextField
            label="Username"
            value={form.username}
            onChange={(v) => updateField("username", v)}
            placeholder="defaults to your login email"
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
      {anyWarning && (
        <p
          className="text-sm text-amber-300 bg-amber-950/40 border border-amber-800 rounded-lg px-4 py-3"
          role="status"
        >
          Some images could not be compressed under 99 KB at acceptable quality — those tiles are flagged below. Inspect them before downloading; the ZIP still contains the lowest-quality version the encoder could produce.
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
            ? "Resizing & generating previews…"
            : !isSaved
              ? "Save project first"
              : !hasAssets
                ? "No assets queued"
                : previewItems.length > 0
                  ? `Re-resize ${enhancedAssets.length} image${enhancedAssets.length !== 1 ? "s" : ""}`
                  : `Resize & preview (${enhancedAssets.length} image${enhancedAssets.length !== 1 ? "s" : ""})`}
        </button>
      </div>

      {/* ── Streaming progress ── */}
      {isExporting && (
        <section
          className="rounded-xl border border-zinc-800 bg-zinc-950/60 px-4 py-3 space-y-2"
          aria-live="polite"
        >
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold uppercase tracking-[0.18em] text-zinc-300">
              {progressTotal === 0
                ? "Downloading…"
                : progressCurrent >= progressTotal && progressTotal > 0
                  ? "Bundling ZIP…"
                  : `Resizing ${progressCurrent} of ${progressTotal}`}
            </span>
            <span className="font-mono tabular-nums text-zinc-500">
              {progressTotal > 0
                ? `${Math.round((progressCurrent / progressTotal) * 100)}%`
                : "…"}
            </span>
          </div>

          {/* Progress bar */}
          <div
            className="h-2 w-full bg-zinc-900 rounded-full overflow-hidden"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={progressTotal || 100}
            aria-valuenow={progressCurrent}
          >
            <div
              className="h-full bg-blue-500 transition-all duration-300 ease-out"
              style={{
                // Before `started` event lands, show a 5% sliver so the
                // bar isn't completely empty during the captioning phase.
                width: progressTotal === 0
                  ? "5%"
                  : `${Math.round((progressCurrent / progressTotal) * 100)}%`,
              }}
            />
          </div>

          {progressFilename && (
            <p className="text-[11px] font-mono text-zinc-600 truncate" title={progressFilename}>
              {progressFilename}
            </p>
          )}
        </section>
      )}

      {/* ── Preview grid ── */}
      {previewItems.length > 0 && (
        <section className="space-y-3">
          <header className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h3 className="text-sm font-semibold text-zinc-200">
                Resized previews ({previewItems.length})
              </h3>
              <p className="text-[11px] text-zinc-500 mt-0.5">
                Every tile renders at its exact pixel dimensions — if a tile&apos;s aspect doesn&apos;t match the 7:5 frame, the export is wrong.
              </p>
            </div>
            {zipUrl && (
              <a
                href={zipUrl}
                download="cleanshot_pro_export.zip"
                className="bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold px-4 py-2 rounded-lg shadow-lg shadow-blue-900/40 transition-colors inline-flex items-center gap-2"
              >
                Download ZIP
                <span className="text-[10px] font-mono opacity-80">{formatBytes(zipSizeBytes)}</span>
              </a>
            )}
          </header>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {previewItems.map((item) => {
              const aspectOk = item.width === 1024 && item.height === 731;
              const dimensionsLabel = `${item.width}×${item.height}`;
              return (
                <figure
                  key={item.assetId}
                  className="rounded-xl border border-zinc-800 bg-zinc-950 overflow-hidden"
                >
                  {/*
                    No object-fit on the img — we want to render at its
                    intrinsic size so the operator can spot any wrong
                    aspect ratio coming from the backend. The wrapping div
                    has a 7:5 reference frame (with a thin border) so the
                    eye has a comparator: if the image overflows or
                    underfills the frame, the export is broken.
                  */}
                  <div
                    className="relative bg-black mx-auto"
                    style={{ aspectRatio: "1024 / 731", width: "100%" }}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={item.url}
                      alt={`Resized: ${item.filename}`}
                      className="absolute inset-0 w-full h-full"
                      style={{ objectFit: "fill" }}
                    />
                    {/* Bottom-left: dimensions + size badge */}
                    <div className="absolute bottom-2 left-2 flex items-center gap-1">
                      <span
                        className={`text-[10px] font-mono px-2 py-0.5 rounded ${
                          aspectOk
                            ? "bg-black/70 text-green-400"
                            : "bg-red-950/90 text-red-300 border border-red-700"
                        }`}
                        title={aspectOk ? "Dimensions match spec" : "Wrong dimensions — letterboxing or wrong aspect"}
                      >
                        {dimensionsLabel}
                      </span>
                      <span
                        className={`text-[10px] font-mono px-2 py-0.5 rounded ${
                          item.sizeWarning
                            ? "bg-amber-950/90 text-amber-300 border border-amber-700"
                            : "bg-black/70 text-zinc-300"
                        }`}
                        title={item.sizeWarning ? "Couldn't compress under 99 KB" : ""}
                      >
                        {formatBytes(item.sizeBytes)}
                      </span>
                    </div>
                  </div>
                  <figcaption className="flex items-center justify-between px-3 py-2 border-t border-zinc-800">
                    <span className="text-xs text-zinc-400 truncate" title={item.filename}>
                      {item.filename}
                    </span>
                    <a
                      href={item.url}
                      download={item.filename}
                      className="text-xs text-blue-400 hover:text-blue-300 transition-colors font-medium shrink-0"
                    >
                      Download
                    </a>
                  </figcaption>
                </figure>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}
