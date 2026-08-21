"use client";
// apps/web/components/export/ExportControls.tsx
//
// Export controls — extracted from the old Resize tab so the same export flow
// can be embedded at the bottom of BOTH the Enhance and Scan tabs (the
// standalone Resize tab was removed). Operates on a caller-supplied `assets`
// list (Enhance feeds it the picked winners; Scan feeds it the approved cards)
// and keeps a local, drag-reorderable copy of that list so the operator can set
// export order without round-tripping through Workspace state.
//
// Flow (2026-08-21 — EXPORT IS THE ONLY SAVE ACTION):
//   1. Confirm the project fields (pre-filled from Workspace meta + login email).
//   2. Click "7x5 EXPORT". That one click saves the project (FastAPI still
//      gates export on projects.saved_at, so this has to happen first) and then
//      runs the export, which writes the finished files straight into the
//      user's Photo Library.
//
// The old "Save Project" button is gone, and so is the separate approveSet
// call it made: that call copied the PRE-export bytes into the library, which
// is exactly the duplicate this design removes. What the library holds now is
// the final exported file — cropped, upscaled, and watermarked if the
// disclaimer checkbox was on — and the pre-enhance originals, one copy each.
//
// Deliberately omits the standalone uploader + Clear-all that the Resize tab
// had — the host tab (Enhance / Scan) already owns image intake and clearing.

import { useState, useEffect, useMemo } from "react";
import {
  exportProPreviewStream,
  saveProject,
  type ExportProPreviewItem,
} from "../../lib/api";
import { formatBytes } from "../../lib/compress";
import { type ForkliftMeta } from "../../lib/types";

// Watermark string burnt into the bottom-right corner of every exported JPEG
// when the disclaimer checkbox is on. Briefly unconditional (2026-08-21), now
// back to a checkbox pending a final decision on how the watermark gets
// applied — the difference from the original is that it defaults ON, so the
// operator opts OUT rather than in. Backend pyvips uses the same string; keep
// in sync if you change one (hard-won lesson #20). The leading "*Disclaimer:"
// label is rendered green; the rest white.
export const AI_DISCLAIMER_LABEL = "*Disclaimer:";
export const AI_DISCLAIMER_WATERMARK =
  "*Disclaimer:  AI enhanced images - used for representational purposes";

export interface ExportAsset {
  assetId:      string;
  filename:     string;
  thumbnailUrl: string;
  provider?:    string;
  /** Asset id of the pre-enhance original, saved alongside the export. */
  originalAssetId?: string;
}

export interface ExportControlsProps {
  sessionId: string;
  /**
   * Curated assets to save + export. Order matters — it drives the export
   * filename numbering. The host tab passes its current set (Enhance: picked
   * winners; Scan: approved cards); ExportControls keeps a local reorderable
   * copy so the operator can drag to set the order before exporting.
   */
  assets: ExportAsset[];
  /** Shared forklift metadata from Workspace — pre-fills the project form. */
  meta: Partial<ForkliftMeta>;
  /** Signed-in user's email — pre-fills the Username field. */
  userEmail: string;
}

interface ProjectForm {
  make:      string;
  year:      string;
  model:     string;
  tireType:  string;
  capacity:  string;
  fuelType:  string;
  username:  string;
}

const EMPTY_FORM: ProjectForm = {
  make: "", year: "", model: "", tireType: "", capacity: "", fuelType: "", username: "",
};

function validateForm(form: ProjectForm): { valid: boolean; yearNum: number | null } {
  // Only make + model gate the Save action.
  //
  // Year is OPTIONAL and has NO DEFAULT. It used to be required, and a blank
  // field was silently filled with `new Date().getFullYear()` — so a unit whose
  // year nobody knew got confidently labelled with the current year, and that
  // wrong number was baked into every export filename. A guess that looks like
  // data is worse than a blank. Blank now stays blank all the way to the DB
  // column, and the filename simply omits the year.
  //
  // An out-of-range or non-numeric entry also yields null rather than blocking
  // Save — the field is a strong recommendation, not a gate.
  const yearRaw = form.year.trim();
  let yearNum: number | null = null;
  if (yearRaw.length > 0) {
    const parsed = Number.parseInt(yearRaw, 10);
    if (Number.isInteger(parsed) && parsed >= 1900 && parsed <= 2100) {
      yearNum = parsed;
    }
  }
  const valid = form.make.trim().length > 0 && form.model.trim().length > 0;
  return { valid, yearNum };
}

function TextField({
  label, value, onChange, placeholder, disabled, hint,
}: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  disabled?: boolean;
  hint?: string;
}) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm uppercase tracking-[0.16em] text-ink font-bold">
        {label}
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="bg-panel border border-line rounded-md px-3 py-2.5 text-base text-ink placeholder:text-ink-soft focus:outline-none focus:ring-2 focus:ring-cta focus:border-transparent transition disabled:opacity-50"
      />
      {hint && <span className="text-base text-accent font-semibold leading-relaxed">{hint}</span>}
    </label>
  );
}

export function ExportControls({ sessionId, assets, meta, userEmail }: ExportControlsProps) {
  // ── Local reorderable copy of the incoming asset set ──
  // Stored as an order of assetIds so reorders survive prop refreshes and new
  // assets append at the end. Reconciled whenever the incoming set changes.
  const [order, setOrder] = useState<string[]>(() => assets.map((a) => a.assetId));
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional reconcile of upstream prop into local order; functional setState bails when unchanged so there's no loop.
    setOrder((prev) => {
      const incoming = assets.map((a) => a.assetId);
      const incomingSet = new Set(incoming);
      const kept = prev.filter((id) => incomingSet.has(id));
      const keptSet = new Set(kept);
      const appended = incoming.filter((id) => !keptSet.has(id));
      const next = [...kept, ...appended];
      if (next.length === prev.length && next.every((id, i) => id === prev[i])) return prev;
      return next;
    });
  }, [assets]);

  const byId = useMemo(() => new Map(assets.map((a) => [a.assetId, a])), [assets]);
  const orderedAssets = useMemo(
    () => order.map((id) => byId.get(id)).filter((a): a is ExportAsset => a !== undefined),
    [order, byId],
  );

  // ── Drag-to-reorder state ──
  const [dragIndex,     setDragIndex]     = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  // ── Project form ──
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

  // Keep the form synced with upstream meta without clobbering local edits.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional sync from upstream prop to local form; functional setForm preserves prior input.
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

  // ── Status flags ──
  const [isExporting, setIsExporting] = useState(false);
  const [error,       setError]       = useState<string | null>(null);
  // Defaults ON — the disclaimer is the expected case and turning it off is
  // the deliberate act.
  const [addAiDisclaimer, setAddAiDisclaimer] = useState(true);

  // ── PRO export preview state ──
  const [previewItems, setPreviewItems] = useState<ExportProPreviewItem[]>([]);
  const [zipUrl,       setZipUrl]       = useState<string | null>(null);
  const [zipFilename,  setZipFilename]  = useState<string>("cleanshot_pro_export.zip");
  const [zipSizeBytes, setZipSizeBytes] = useState<number>(0);
  const [anyWarning,   setAnyWarning]   = useState<boolean>(false);
  const [progressTotal,    setProgressTotal]    = useState<number>(0);
  const [progressCurrent,  setProgressCurrent]  = useState<number>(0);
  const [progressFilename, setProgressFilename] = useState<string>("");

  const { valid: formValid, yearNum } = validateForm(form);
  const hasAssets = orderedAssets.length > 0;
  // Make + Model still gate export, because the save that export performs
  // needs them — they are what the export filenames and the library folder
  // are built from.
  const canExport = formValid && hasAssets && !isExporting;

  const updateField = <K extends keyof ProjectForm>(key: K, value: ProjectForm[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  // ─── Save (no longer a button — the first half of Export) ────────────────

  /**
   * Commit the project metadata. FastAPI's export endpoints 403 until
   * `projects.saved_at` is set, so this has to run before the export call.
   *
   * It no longer calls `approveSet`. That call used to copy the pre-export
   * bytes into the Photo Library; the export itself now writes the finished
   * files there, so keeping it would store each image twice — once clean,
   * once exported.
   */
  const saveProjectMetadata = async () => {
    const derivedTitle =
      [form.make, form.model, form.year].map((str) => str.trim()).filter(Boolean).join(" ")
      || "Untitled";
    const usernameOut =
      form.username.trim() || (userEmail && userEmail !== "dev@local" ? userEmail : "unknown");

    // yearNum === null is a VALID save (unknown year).
    await saveProject({
      sessionId,
      title:     derivedTitle,
      make:      form.make.trim(),
      year:      yearNum,
      model:     form.model.trim(),
      tireType:  form.tireType.trim() || "unknown",
      capacity:  form.capacity.trim() || "unknown",
      fuelType:  form.fuelType.trim() || "unknown",
      username:  usernameOut,
      photoType: "auction",
    });
  };

  // ─── PRO export ───────────────────────────────────────────────────────────

  const handleExport = async () => {
    if (!hasAssets || !formValid) return;
    setError(null);
    setIsExporting(true);
    setPreviewItems([]);
    setZipUrl(null);
    setZipSizeBytes(0);
    setAnyWarning(false);
    setProgressTotal(0);
    setProgressCurrent(0);
    setProgressFilename("");
    try {
      // Save first — export is gated on it server-side, and this is the click
      // that replaces the removed Save Project button.
      await saveProjectMetadata();

      await exportProPreviewStream(
        {
          sessionId,
          assetIds:  orderedAssets.map((a) => a.assetId),
          providers: orderedAssets.map((a) => a.provider ?? null),
          originalAssetIds: orderedAssets
            .map((a) => a.originalAssetId)
            .filter((id): id is string => typeof id === "string" && id.length > 0),
          aiDisclaimer: addAiDisclaimer,
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
            setZipFilename(resp.zipFilename);
            setZipSizeBytes(resp.zipSizeBytes);
            setAnyWarning(resp.anySizeWarning);
          },
        },
      );
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
      <div className="bg-well border border-line rounded-xl p-5 space-y-5">
        <div className="space-y-2.5">
          <h3 className="text-lg font-semibold text-accent">PRO CONSTRAINTS EXPORT</h3>
          <ul className="text-base text-ink space-y-1.5 leading-relaxed" role="list">
            <li>• <strong className="font-semibold text-accent">1024 × 731 px</strong> — 7:5 aspect ratio</li>
            <li>• <strong className="font-semibold text-accent">Zoom-to-fill</strong> — smart-crop to subject, no letterboxing</li>
            <li>• <strong className="font-semibold text-accent">≤ 99 KB JPEG</strong> — quality iterated until target</li>
          </ul>
        </div>
      </div>

      {/* ── Export set (reorderable) ── */}
      {orderedAssets.length > 0 && (
        <section className="rounded-xl border border-line bg-well/60 overflow-hidden">
          <header className="flex items-start justify-between gap-4 px-5 py-4 bg-panel/50 border-b border-line">
            <div className="flex flex-col gap-1">
              <span className="text-base font-semibold uppercase tracking-[0.14em] text-ink">
                Queued for export
              </span>
              <span className="text-sm text-ink-soft leading-relaxed">
                These images will be included in the next export.{" "}
                <span className="font-semibold text-accent">Drag any tile to reorder</span> — the order drives the export filename numbering.
              </span>
            </div>
            <span className="text-sm uppercase tracking-[0.18em] font-mono text-ink-soft tabular-nums shrink-0">
              {orderedAssets.length}
            </span>
          </header>
          <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-5 gap-2 p-4">
            {orderedAssets.map((a, idx) => {
              const isDragging = dragIndex === idx;
              const isOver     = dragOverIndex === idx && dragIndex !== idx;
              return (
                <div
                  key={a.assetId}
                  draggable
                  onDragStart={(e) => {
                    setDragIndex(idx);
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", String(idx));
                  }}
                  onDragOver={(e) => {
                    if (dragIndex === null) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = "move";
                    if (dragIndex !== idx) setDragOverIndex(idx);
                  }}
                  onDragLeave={() => {
                    if (dragOverIndex === idx) setDragOverIndex(null);
                  }}
                  onDragEnd={() => {
                    setDragIndex(null);
                    setDragOverIndex(null);
                  }}
                  onDrop={(e) => {
                    if (dragIndex === null) return;
                    e.preventDefault();
                    const from = dragIndex;
                    setDragOverIndex(null);
                    setDragIndex(null);
                    if (from === idx) return;
                    setOrder((prev) => {
                      const next = [...prev];
                      const [moved] = next.splice(from, 1);
                      next.splice(idx, 0, moved);
                      return next;
                    });
                  }}
                  className={`relative rounded-lg overflow-hidden border-2 bg-panel cursor-move transition-colors ${
                    isOver
                      ? "border-cta"
                      : isDragging
                        ? "border-line opacity-50"
                        : "border-line"
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={a.thumbnailUrl}
                    alt={a.filename}
                    draggable={false}
                    className="w-full aspect-square object-cover pointer-events-none"
                  />
                  <span className="absolute top-1 left-1 text-[11px] uppercase tracking-[0.12em] font-bold px-1.5 py-0.5 rounded bg-header-bg/80 border border-line text-accent tabular-nums">
                    {idx + 1}
                  </span>
                  {a.provider && (
                    <span className="absolute top-1 right-1 text-[9px] uppercase tracking-[0.12em] font-bold px-1.5 py-0.5 rounded bg-header-bg/70 text-ink">
                      {a.provider}
                    </span>
                  )}
                  <div className="absolute bottom-0 inset-x-0 bg-linear-to-t from-black/80 to-transparent px-2 py-1">
                    <p className="text-[10px] text-ink truncate" title={a.filename}>
                      {a.filename}
                    </p>
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      )}

      {/* ── Project form ── */}
      <section className="rounded-xl border border-line bg-well/60 overflow-hidden">
        <header className="flex items-start justify-between gap-4 px-5 py-4 bg-panel/50 border-b border-line">
          <div className="flex flex-col gap-1">
            <span className="text-base font-semibold uppercase tracking-[0.14em] text-ink">
              Project details
            </span>
            <span className="text-sm text-ink-soft leading-relaxed">
              Exporting saves this project for you — there is no separate save
              step. The exported images and their original photos go into Your
              Photo Library under your account, and this metadata is what names
              them. Only{" "}
              <span className="font-semibold text-accent">Make</span> and{" "}
              <span className="font-semibold text-accent">Model</span> are
              required — the rest pre-fill from the Enhance tab.
            </span>
          </div>
        </header>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-5">
          <TextField label="Make *" value={form.make} onChange={(v) => updateField("make", v)}
            placeholder="Toyota" hint="OEM brand — Toyota, Hyster, Yale, Crown, etc." />
          <TextField label="Model *" value={form.model} onChange={(v) => updateField("model", v)}
            placeholder="8FGU25" hint="Model number from the data plate." />
          <TextField label="Year" value={form.year}
            onChange={(v) => updateField("year", v.replace(/[^0-9]/g, "").slice(0, 4))}
            placeholder="strongly recommended"
            hint="Model year (1900–2100). Strongly recommended — it goes in the export filename. Left blank it stays blank; nothing is guessed." />
          <TextField label="Username" value={form.username} onChange={(v) => updateField("username", v)}
            placeholder="defaults to your login email" hint="Who's saving this — defaults to your account email." />
          <TextField label="Capacity" value={form.capacity} onChange={(v) => updateField("capacity", v)}
            placeholder="5000 lbs" hint="Rated load capacity from the data plate." />
          <TextField label="Tire type" value={form.tireType} onChange={(v) => updateField("tireType", v)}
            placeholder="Pneumatic / Cushion / Non-marking" hint="Pneumatic (outdoor), cushion (indoor), or non-marking." />
          <TextField label="Fuel type" value={form.fuelType} onChange={(v) => updateField("fuelType", v)}
            placeholder="LP / Diesel / Electric" hint="LP, diesel, electric, gasoline, dual-fuel." />
        </div>
      </section>

      {/* ── Error / warning banners ── */}
      {error && (
        <p className="text-sm text-attn bg-panel border border-attn rounded-lg px-4 py-3" role="alert">
          {error}
        </p>
      )}
      {anyWarning && (
        <p className="text-sm text-attn bg-panel border border-attn rounded-lg px-4 py-3" role="status">
          Some images could not be compressed under 99 KB at acceptable quality — those tiles are flagged below. Inspect them before downloading; the ZIP still contains the lowest-quality version the encoder could produce.
        </p>
      )}

      {/* ── AI-disclaimer toggle ── */}
      <label
        className={`flex items-start gap-3 rounded-xl border-2 px-4 py-3 cursor-pointer transition-colors select-none ${
          addAiDisclaimer
            ? "border-accent bg-panel hover:bg-accent/30"
            : "border-line bg-well/40 hover:border-ink-faint"
        }`}
      >
        <input
          type="checkbox"
          checked={addAiDisclaimer}
          onChange={(e) => setAddAiDisclaimer(e.target.checked)}
          className="mt-1 w-5 h-5 accent-accent shrink-0"
        />
        <div className="min-w-0">
          <p className="text-base font-bold text-ink leading-snug">
            Add AI disclaimer watermark
          </p>
          <p className="text-sm text-ink-soft mt-1 leading-relaxed">
            Burns a tiny, semi-transparent line of text into the bottom-right
            corner of every exported JPEG:
          </p>
          <p
            className="text-sm mt-1.5 leading-snug"
            style={{ fontFamily: "Roboto, sans-serif" }}
          >
            &ldquo;
            <span className="font-bold text-accent">{AI_DISCLAIMER_LABEL}</span>
            <span className="font-bold text-ink">
              {AI_DISCLAIMER_WATERMARK.slice(AI_DISCLAIMER_LABEL.length)}
            </span>
            &rdquo;
          </p>
          <p className="text-sm text-ink-soft mt-1.5 leading-relaxed">
            Use this when the photo is going to a customer-facing listing —
            it&apos;s your honest disclosure that the image was cleaned up by AI.
          </p>
        </div>
      </label>

      {/* ── Export button ── */}
      <div className="space-y-2">
        <button
          onClick={handleExport}
          disabled={!canExport}
          title="Exported images are upscaled for quality — you MUST run the image optimizer in PRO after uploading them."
          className={`
            inline-flex py-3 px-6 rounded-lg font-semibold text-sm uppercase tracking-[0.12em] border-2 transition-all
            ${canExport
              ? "border-cta bg-cta hover:bg-cta-dark text-white"
              : "border-line bg-panel-hi text-ink-faint cursor-not-allowed"}
          `}
        >
          {isExporting
            ? "Saving & exporting…"
            : !hasAssets
              ? "No assets queued"
              : !formValid
                ? "Enter Make and Model to export"
                : "7x5 EXPORT"}
        </button>

        {/* Tips sit beside the button rather than in the title attribute alone
            — a hover-only warning about a mandatory follow-up step is a
            warning most operators never see. */}
        <p className="text-sm text-attn font-semibold leading-relaxed max-w-prose">
          Exported images have been <span className="font-bold">upscaled for quality</span>, so you
          MUST run the image optimizer in PRO after uploading them.
        </p>
        <p className="text-sm text-ink-soft leading-relaxed max-w-prose">
          Exported images are saved to Your Photo Library along with their
          original photos.
        </p>
      </div>

      {/* ── Streaming progress ── */}
      {isExporting && (
        <section className="rounded-xl border border-line bg-well/60 px-4 py-3 space-y-2" aria-live="polite">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold uppercase tracking-[0.18em] text-ink-soft">
              {progressTotal === 0
                ? "Downloading…"
                : progressCurrent >= progressTotal && progressTotal > 0
                  ? "Bundling ZIP…"
                  : `Resizing ${progressCurrent} of ${progressTotal}`}
            </span>
            <span className="font-mono tabular-nums text-ink-faint">
              {progressTotal > 0
                ? `${Math.round((progressCurrent / progressTotal) * 100)}%`
                : "…"}
            </span>
          </div>
          <div
            className="h-2 w-full bg-panel rounded-full overflow-hidden"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={progressTotal || 100}
            aria-valuenow={progressCurrent}
          >
            <div
              className="h-full bg-panel-hi transition-all duration-300 ease-out"
              style={{
                width: progressTotal === 0
                  ? "5%"
                  : `${Math.round((progressCurrent / progressTotal) * 100)}%`,
              }}
            />
          </div>
          {progressFilename && (
            <p className="text-[11px] font-mono text-muted truncate" title={progressFilename}>
              {progressFilename}
            </p>
          )}
        </section>
      )}

      {/* ── PRO preview grid ── */}
      {previewItems.length > 0 && (
        <section className="space-y-3">
          {/* Download ZIP moved to the LEFT of this row and the heading to the
              right — a straight swap of the two children, so `justify-between`
              still fills the row and nothing is left with a hole in it. On a
              narrow screen `flex-wrap` stacks them, ZIP first, which is the
              order that matters. Colour and styling are unchanged. */}
          <header className="flex flex-wrap items-center justify-between gap-3">
            {zipUrl && (
              <a
                href={zipUrl}
                download={zipFilename}
                /* Was bg-panel on a dark card, i.e. dark-on-dark and
                   effectively invisible. Lime fill with near-black text is the
                   brightest thing the palette has, and text-header-bg is
                   mandatory on a lime fill (white is ~1.5:1). */
                className="bg-accent hover:bg-accent/85 text-header-bg text-base font-bold px-5 py-2.5 rounded-lg transition-colors inline-flex items-center gap-2 shadow-lg"
              >
                Download ZIP
                <span className="text-[10px] font-mono opacity-80">{formatBytes(zipSizeBytes)}</span>
              </a>
            )}
            {/* `ml-auto` pins the heading right even before the ZIP link
                exists (it only renders once the export returns), so the header
                doesn't jump sideways when the download appears. */}
            <div className="ml-auto text-right">
              <h3 className="text-sm font-semibold text-ink">
                Resized previews ({previewItems.length})
              </h3>
              <p className="text-[11px] text-ink-faint mt-0.5">
                Every tile renders at its exact pixel dimensions — if a tile&apos;s aspect doesn&apos;t match the 7:5 frame, the export is wrong.
              </p>
            </div>
          </header>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {previewItems.map((item) => {
              // Ratio test, not fixed dimensions. PRO export emits the
              // source's full resolution now, so hardcoding 1024x731 flagged
              // every correct export as wrong. 1.38-1.42 is the band the crop
              // audit accepts as 7:5.
              const ratio = item.height > 0 ? item.width / item.height : 0;
              const aspectOk = ratio >= 1.38 && ratio <= 1.42;
              const dimensionsLabel = `${item.width}×${item.height}`;
              return (
                <figure
                  key={item.assetId}
                  className="rounded-xl border border-line bg-well overflow-hidden"
                >
                  <div className="relative bg-well mx-auto" style={{ aspectRatio: "1024 / 731", width: "100%" }}>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={item.url}
                      alt={`Resized: ${item.filename}`}
                      className="absolute inset-0 w-full h-full"
                      style={{ objectFit: "fill" }}
                    />
                    <div className="absolute bottom-2 left-2 flex items-center gap-1">
                      <span
                        className={`text-[10px] font-mono px-2 py-0.5 rounded ${
                          aspectOk
                            ? "bg-header-bg/70 text-accent"
                            : "bg-panel text-attn border border-attn"
                        }`}
                        title={aspectOk ? "Dimensions match spec" : "Wrong dimensions — letterboxing or wrong aspect"}
                      >
                        {dimensionsLabel}
                      </span>
                      <span
                        className={`text-[10px] font-mono px-2 py-0.5 rounded ${
                          item.sizeWarning
                            ? "bg-panel text-attn border border-attn"
                            : "bg-header-bg/70 text-ink-soft"
                        }`}
                        title={item.sizeWarning ? "Couldn't compress under 99 KB" : ""}
                      >
                        {formatBytes(item.sizeBytes)}
                      </span>
                    </div>
                  </div>
                  <figcaption className="flex items-center justify-between px-3 py-2 border-t border-line">
                    <span className="text-xs text-ink-soft truncate" title={item.filename}>
                      {item.filename}
                    </span>
                    <a
                      href={item.url}
                      download={item.filename}
                      className="text-xs text-ink-soft hover:text-ink-soft transition-colors font-medium shrink-0"
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
