"use client";
// apps/web/components/export/ExportControls.tsx
//
// Save Project + Export controls — extracted from the old Resize tab so the
// same Save / PRO-export / collage / branded-collage flow can be embedded at
// the bottom of BOTH the Enhance and Scan tabs (the standalone Resize tab was
// removed). Operates on a caller-supplied `assets` list (Enhance feeds it the
// picked winners; Scan feeds it the approved cards) and keeps a local,
// drag-reorderable copy of that list so branded-collage hero ordering still
// works without round-tripping through Workspace state.
//
// Flow (unchanged from the old Resize tab):
//   1. Confirm the project fields (pre-filled from Workspace meta + login email).
//   2. Click "Save Project" → POST /api/projects/save (also approves the set to
//      Your Photo Library). Backend flips projects.saved_at, unblocking exports.
//   3. Pick an export preset (PRO / collage / branded collage) and download.
//
// Deliberately omits the standalone uploader + Clear-all that the Resize tab
// had — the host tab (Enhance / Scan) already owns image intake and clearing.

import { useEffect, useMemo, useState } from "react";
import {
  approveSet,
  createBrandedCollage,
  exportCollageAsBlob,
  exportProPreviewStream,
  getSignedUploadUrl,
  saveProject,
  uploadToGcs,
  type ExportProPreviewItem,
} from "../../lib/api";
import { formatBytes } from "../../lib/compress";
import {
  EQUIPMENT_GROUPS,
  EQUIPMENT_TYPE_LABELS,
  type EquipmentType,
  type ForkliftMeta,
} from "../../lib/types";

// Watermark string burnt into the bottom-right corner of every exported JPEG
// when the operator ticks "Add AI disclaimer". Backend pyvips uses the same
// string; keep in sync if you change one (hard-won lesson #20).
export const AI_DISCLAIMER_WATERMARK =
  "AI-enhanced image — depicts the unit as it will be delivered";

export interface ExportAsset {
  assetId:      string;
  filename:     string;
  thumbnailUrl: string;
  provider?:    string;
}

export interface ExportControlsProps {
  sessionId: string;
  /**
   * Curated assets to save + export. Order matters — index 0 becomes the hero
   * in branded collages. The host tab passes its current set (Enhance: picked
   * winners; Scan: approved cards); ExportControls keeps a local reorderable
   * copy so the operator can drag to set the hero/order before exporting.
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
  // Only make + model gate the Save action. Year is parsed if provided
  // (1900-2100) and defaults to the current year when blank. The rest are
  // nice-to-have free text (placeholder-substituted server-side).
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
      <span className="text-sm uppercase tracking-[0.16em] text-zinc-100 font-bold">
        {label}
      </span>
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        disabled={disabled}
        className="bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2.5 text-base text-white placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-brand-500 focus:border-transparent transition disabled:opacity-50"
      />
      {hint && <span className="text-base text-yellow-300 font-semibold leading-relaxed">{hint}</span>}
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
  const [isSaving,           setIsSaving]           = useState(false);
  const [isSaved,            setIsSaved]            = useState(false);
  const [isExporting,        setIsExporting]        = useState(false);
  const [isExportingCollage, setIsExportingCollage] = useState(false);
  const [isCreatingCollage,  setIsCreatingCollage]  = useState(false);
  const [collageEquipmentType, setCollageEquipmentType] =
    useState<EquipmentType | null>(meta.equipmentType ?? null);
  const [error,              setError]              = useState<string | null>(null);
  const [addAiDisclaimer,    setAddAiDisclaimer]    = useState(false);

  // ── Branded-collage result state ──
  const [collageBlob,        setCollageBlob]        = useState<Blob | null>(null);
  const [collagePreviewUrl,  setCollagePreviewUrl]  = useState<string | null>(null);
  const [collageFilename,    setCollageFilename]    = useState<string | null>(null);
  const [collageSizeBytes,   setCollageSizeBytes]   = useState<number>(0);
  const [collageSizeWarning, setCollageSizeWarning] = useState<boolean>(false);
  const [collageSavingToHistory, setCollageSavingToHistory] = useState(false);
  const [collageSavedToHistory,  setCollageSavedToHistory]  = useState(false);

  // ── PRO export preview state ──
  const [previewItems, setPreviewItems] = useState<ExportProPreviewItem[]>([]);
  const [zipUrl,       setZipUrl]       = useState<string | null>(null);
  const [zipSizeBytes, setZipSizeBytes] = useState<number>(0);
  const [anyWarning,   setAnyWarning]   = useState<boolean>(false);
  const [progressTotal,    setProgressTotal]    = useState<number>(0);
  const [progressCurrent,  setProgressCurrent]  = useState<number>(0);
  const [progressFilename, setProgressFilename] = useState<string>("");

  const { valid: formValid, yearNum } = validateForm(form);
  const hasAssets = orderedAssets.length > 0;
  const canSave   = formValid && !isSaving;
  const canExport        = isSaved && hasAssets && !isExporting && !isExportingCollage;
  const canExportCollage = isSaved && hasAssets && !isExporting && !isExportingCollage;

  const updateField = <K extends keyof ProjectForm>(key: K, value: ProjectForm[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  };

  // ─── Save ───────────────────────────────────────────────────────────────────

  const handleSave = async () => {
    if (!formValid || yearNum === null) return;
    setError(null);
    setIsSaving(true);
    try {
      const derivedTitle =
        [form.make, form.model, form.year].map((s) => s.trim()).filter(Boolean).join(" ")
        || "Untitled";
      const tireTypeOut = form.tireType.trim() || "unknown";
      const capacityOut = form.capacity.trim() || "unknown";
      const fuelTypeOut = form.fuelType.trim() || "unknown";
      const usernameOut = form.username.trim() || (userEmail && userEmail !== "dev@local" ? userEmail : "unknown");

      // 1. Commit project metadata (unlocks exports server-side).
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

      // 2. Commit the curated set to History (Save is the single trigger
      // for both — no separate Approve action). Skips if nothing queued.
      if (orderedAssets.length > 0) {
        await approveSet({
          sessionId,
          assetIds: orderedAssets.map((a) => a.assetId),
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

  // ─── PRO export ───────────────────────────────────────────────────────────

  const handleExport = async () => {
    if (!hasAssets) return;
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
      await exportProPreviewStream(
        {
          sessionId,
          assetIds:  orderedAssets.map((a) => a.assetId),
          providers: orderedAssets.map((a) => a.provider ?? null),
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

  // ─── Collage export (1024 long edge, no crop) ───────────────────────────────

  const handleExportCollage = async () => {
    if (!hasAssets) return;
    setError(null);
    setIsExportingCollage(true);
    try {
      const { blob, filename, warning } = await exportCollageAsBlob({
        sessionId,
        assetIds:  orderedAssets.map((a) => a.assetId),
        providers: orderedAssets.map((a) => a.provider ?? null),
        aiDisclaimer: addAiDisclaimer,
      });
      if (warning) setAnyWarning(true);
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(objectUrl);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Collage export failed");
    } finally {
      setIsExportingCollage(false);
    }
  };

  // ─── Branded collage ──────────────────────────────────────────────────────

  const handleCreateBrandedCollage = async () => {
    if (!collageEquipmentType || orderedAssets.length < 5 || !isSaved) return;
    setError(null);
    setIsCreatingCollage(true);
    if (collagePreviewUrl) URL.revokeObjectURL(collagePreviewUrl);
    setCollageBlob(null);
    setCollagePreviewUrl(null);
    setCollageFilename(null);
    setCollageSizeBytes(0);
    setCollageSizeWarning(false);
    setCollageSavedToHistory(false);
    try {
      const { blob, filename, warning } = await createBrandedCollage({
        sessionId,
        equipmentType: collageEquipmentType,
        assetIds:      orderedAssets.slice(0, 5).map((a) => a.assetId),
        aiDisclaimer:  addAiDisclaimer,
      });
      setCollageBlob(blob);
      setCollagePreviewUrl(URL.createObjectURL(blob));
      setCollageFilename(filename);
      setCollageSizeBytes(blob.size);
      setCollageSizeWarning(Boolean(warning));
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? `Collage creation failed: ${err.message}`
          : "Collage creation failed",
      );
    } finally {
      setIsCreatingCollage(false);
    }
  };

  const handleDownloadCollage = () => {
    if (!collageBlob || !collageFilename) return;
    const objectUrl = URL.createObjectURL(collageBlob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = collageFilename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(objectUrl);
  };

  const handleSaveCollageToHistory = async () => {
    if (!collageBlob || !collageFilename || collageSavingToHistory) return;
    setError(null);
    setCollageSavingToHistory(true);
    try {
      const blobAsFile = new File([collageBlob], collageFilename, { type: "image/jpeg" });
      const signed = await getSignedUploadUrl({
        sessionId,
        filename:    collageFilename,
        contentType: "image/jpeg",
      });
      await uploadToGcs(signed.uploadUrl, blobAsFile);
      await approveSet({
        sessionId,
        assetIds: [signed.assetId],
        projectMeta: {
          make:  form.make.trim()  || "unknown",
          model: form.model.trim() || "unknown",
          year:  form.year.trim(),
        },
      });
      setCollageSavedToHistory(true);
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? `Save to Your Photo Library failed: ${err.message}`
          : "Save to Your Photo Library failed",
      );
    } finally {
      setCollageSavingToHistory(false);
    }
  };

  const handleDiscardCollagePreview = () => {
    if (collagePreviewUrl) URL.revokeObjectURL(collagePreviewUrl);
    setCollageBlob(null);
    setCollagePreviewUrl(null);
    setCollageFilename(null);
    setCollageSizeBytes(0);
    setCollageSizeWarning(false);
    setCollageSavedToHistory(false);
  };

  // Revoke the collage blob URL on unmount so it doesn't leak.
  useEffect(() => {
    return () => {
      if (collagePreviewUrl) URL.revokeObjectURL(collagePreviewUrl);
    };
  }, [collagePreviewUrl]);

  // ─── Render ─────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-6">
      {/* ── Spec card ── */}
      <div className="bg-black border border-zinc-700 rounded-xl p-5 space-y-5">
        <div className="space-y-2.5">
          <h3 className="text-lg font-semibold text-acid">PRO CONSTRAINTS EXPORT</h3>
          <ul className="text-base text-zinc-100 space-y-1.5 leading-relaxed" role="list">
            <li>• <strong className="font-semibold text-yellow-300">1024 × 731 px</strong> — 7:5 aspect ratio</li>
            <li>• <strong className="font-semibold text-yellow-300">Zoom-to-fill</strong> — smart-crop to subject, no letterboxing</li>
            <li>• <strong className="font-semibold text-yellow-300">≤ 99 KB JPEG</strong> — quality iterated until target</li>
          </ul>
        </div>
        <div className="space-y-2.5 pt-4 border-t border-zinc-800">
          <h3 className="text-lg font-semibold text-acid">COLLAGE EXPORT</h3>
          <ul className="text-base text-zinc-100 space-y-1.5 leading-relaxed" role="list">
            <li>• <strong className="font-semibold text-yellow-300">1024 px long edge</strong> — original aspect ratio preserved</li>
            <li>• <strong className="font-semibold text-yellow-300">No crop</strong> — fits to long edge; output is whatever the input&apos;s shape calls for</li>
            <li>• <strong className="font-semibold text-yellow-300">≤ 99 KB JPEG</strong> — same quality-iteration loop as PRO</li>
          </ul>
        </div>
      </div>

      {/* ── Export set (reorderable) ── */}
      {orderedAssets.length > 0 && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 overflow-hidden">
          <header className="flex items-start justify-between gap-4 px-5 py-4 bg-zinc-900/50 border-b border-zinc-800">
            <div className="flex flex-col gap-1">
              <span className="text-base font-semibold uppercase tracking-[0.14em] text-zinc-100">
                Queued for export
              </span>
              <span className="text-sm text-zinc-300 leading-relaxed">
                These images will be included in the next export.{" "}
                <span className="font-semibold text-yellow-300">Drag any tile to reorder</span> — image #1 becomes the hero in branded collages.
              </span>
            </div>
            <span className="text-sm uppercase tracking-[0.18em] font-mono text-zinc-300 tabular-nums shrink-0">
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
                  className={`relative rounded-lg overflow-hidden border-2 bg-zinc-900 cursor-move transition-colors ${
                    isOver
                      ? "border-brand-500"
                      : isDragging
                        ? "border-zinc-600 opacity-50"
                        : "border-zinc-800"
                  }`}
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={a.thumbnailUrl}
                    alt={a.filename}
                    draggable={false}
                    className="w-full aspect-square object-cover pointer-events-none"
                  />
                  <span className="absolute top-1 left-1 text-[11px] uppercase tracking-[0.12em] font-bold px-1.5 py-0.5 rounded bg-black/80 border border-zinc-700 text-yellow-300 tabular-nums">
                    {idx + 1}
                  </span>
                  {a.provider && (
                    <span className="absolute top-1 right-1 text-[9px] uppercase tracking-[0.12em] font-bold px-1.5 py-0.5 rounded bg-black/70 text-zinc-200">
                      {a.provider}
                    </span>
                  )}
                  <div className="absolute bottom-0 inset-x-0 bg-linear-to-t from-black/80 to-transparent px-2 py-1">
                    <p className="text-[10px] text-zinc-200 truncate" title={a.filename}>
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
      <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 overflow-hidden">
        <header className="flex items-start justify-between gap-4 px-5 py-4 bg-zinc-900/50 border-b border-zinc-800">
          <div className="flex flex-col gap-1">
            <span className="text-base font-semibold uppercase tracking-[0.14em] text-zinc-100">
              Project details
            </span>
            <span className="text-sm text-zinc-300 leading-relaxed">
              Clicking <span className="font-semibold text-white">Save Project</span> does two things:
              it locks in this metadata so the export buttons will work, AND
              it copies the queued images into Your Photo Library so you can
              re-download them later. Only{" "}
              <span className="font-semibold text-yellow-300">Make</span> and{" "}
              <span className="font-semibold text-yellow-300">Model</span> are
              required — the rest pre-fill from the Enhance tab.
            </span>
          </div>
          {isSaved && (
            <span className="text-sm uppercase tracking-[0.18em] font-semibold text-green-400 shrink-0">
              ✓ Saved
            </span>
          )}
        </header>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 p-5">
          <TextField label="Make *" value={form.make} onChange={(v) => updateField("make", v)}
            placeholder="Toyota" hint="OEM brand — Toyota, Hyster, Yale, Crown, etc." />
          <TextField label="Model *" value={form.model} onChange={(v) => updateField("model", v)}
            placeholder="8FGU25" hint="Model number from the data plate." />
          <TextField label="Year" value={form.year}
            onChange={(v) => updateField("year", v.replace(/[^0-9]/g, "").slice(0, 4))}
            placeholder="defaults to current year" hint="Model year (1900–2100). Leave blank for current year." />
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
        <p className="text-sm text-red-400 bg-red-950/40 border border-red-800 rounded-lg px-4 py-3" role="alert">
          {error}
        </p>
      )}
      {anyWarning && (
        <p className="text-sm text-amber-300 bg-amber-950/40 border border-amber-800 rounded-lg px-4 py-3" role="status">
          Some images could not be compressed under 99 KB at acceptable quality — those tiles are flagged below. Inspect them before downloading; the ZIP still contains the lowest-quality version the encoder could produce.
        </p>
      )}

      {/* ── Save action ── */}
      <button
        onClick={handleSave}
        disabled={!canSave}
        className={`
          inline-flex py-3 px-6 rounded-lg font-semibold text-sm uppercase tracking-[0.12em] border-2 transition-all
          ${canSave
            ? isSaved
              ? "border-green-700 bg-green-700 hover:bg-green-600 text-white"
              : "border-green-500 bg-green-600 hover:bg-green-500 text-white"
            : "border-zinc-800 bg-zinc-800 text-zinc-500 cursor-not-allowed"}
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

      {/* ── AI-disclaimer toggle ── */}
      <label
        className={`flex items-start gap-3 rounded-xl border-2 px-4 py-3 cursor-pointer transition-colors select-none ${
          addAiDisclaimer
            ? "border-yellow-500 bg-yellow-950/30 hover:bg-yellow-900/30"
            : "border-zinc-700 bg-zinc-950/40 hover:border-zinc-500"
        }`}
      >
        <input
          type="checkbox"
          checked={addAiDisclaimer}
          onChange={(e) => setAddAiDisclaimer(e.target.checked)}
          className="mt-1 w-5 h-5 accent-yellow-500 shrink-0"
        />
        <div className="min-w-0">
          <p className="text-base font-bold text-zinc-100 leading-snug">
            Add AI disclaimer watermark
          </p>
          <p className="text-sm text-zinc-300 mt-1 leading-relaxed">
            Burns a tiny, semi-transparent line of text into the bottom-right
            corner of every exported JPEG:
          </p>
          <p className="text-sm text-yellow-300 italic font-mono mt-1.5 leading-snug">
            &ldquo;{AI_DISCLAIMER_WATERMARK}&rdquo;
          </p>
          <p className="text-sm text-zinc-300 mt-1.5 leading-relaxed">
            Use this when the photo is going to a customer-facing listing —
            it&apos;s your honest disclosure that the image was cleaned up by AI.
          </p>
        </div>
      </label>

      {/* ── PRO export button ── */}
      <button
        onClick={handleExport}
        disabled={!canExport}
        className={`
          inline-flex py-3 px-6 rounded-lg font-semibold text-sm uppercase tracking-[0.12em] border-2 transition-all
          ${canExport
            ? "border-green-500 bg-green-600 hover:bg-green-500 text-white"
            : "border-zinc-800 bg-zinc-800 text-zinc-500 cursor-not-allowed"}
        `}
      >
        {isExporting
          ? "Resizing & generating previews…"
          : !isSaved
            ? "Save project first"
            : !hasAssets
              ? "No assets queued"
              : previewItems.length > 0
                ? `Re-resize ${orderedAssets.length} image${orderedAssets.length !== 1 ? "s" : ""} (PRO)`
                : `PRO export — 1024×731 (${orderedAssets.length})`}
      </button>

      {/* ── Create branded collage ── */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-900 p-4 space-y-3">
        <div className="space-y-1">
          <h3 className="text-base font-bold text-acid uppercase tracking-[0.12em]">
            Create branded collage
          </h3>
          <p className="text-sm text-zinc-300 leading-relaxed">
            Composes your first 5 queued images into the marketing-layout
            collage — one hero shot on the left, four thumbnails stacked on
            the right. 1024 px long edge, ≤99 KB JPEG.
          </p>
        </div>

        <div className="space-y-2">
          <span className="text-sm uppercase tracking-[0.16em] font-bold text-zinc-100">
            What kind of equipment is this?
          </span>
          <div className="flex flex-wrap items-stretch gap-x-6 gap-y-2">
            {EQUIPMENT_GROUPS.map((group) => (
              <div
                key={group.label ?? group.members.join("-")}
                className="flex flex-wrap gap-2"
                role="group"
                aria-label={group.label}
              >
                {group.members.map((id) => {
                  const selected = collageEquipmentType === id;
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => setCollageEquipmentType(id)}
                      aria-pressed={selected}
                      className={`flex items-center gap-2.5 px-3 py-2.5 rounded-lg border-2 text-left transition-colors ${
                        selected
                          ? "bg-blue-950 border-blue-500 text-white"
                          : "bg-zinc-900 border-zinc-700 text-zinc-300 hover:border-zinc-500"
                      }`}
                    >
                      <span className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 ${selected ? "border-blue-400" : "border-zinc-600"}`}>
                        {selected && <span className="w-2 h-2 rounded-full bg-blue-400" />}
                      </span>
                      <span className="text-sm uppercase tracking-[0.12em] font-bold">
                        {EQUIPMENT_TYPE_LABELS[id]}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        <button
          onClick={handleCreateBrandedCollage}
          disabled={
            !collageEquipmentType ||
            orderedAssets.length < 5 ||
            !isSaved ||
            isCreatingCollage ||
            isExporting ||
            isExportingCollage
          }
          className={`
            inline-flex py-3 px-6 rounded-lg font-bold text-base uppercase tracking-[0.12em] border-2 transition-all
            ${collageEquipmentType && orderedAssets.length >= 5 && isSaved && !isCreatingCollage && !isExporting && !isExportingCollage
              ? "border-green-500 bg-green-600 hover:bg-green-500 text-white"
              : "border-zinc-800 bg-zinc-800 text-zinc-500 cursor-not-allowed"}
          `}
        >
          {isCreatingCollage
            ? "Composing collage…"
            : !isSaved
              ? "Save project first"
              : !collageEquipmentType
                ? "Pick equipment type to continue"
                : orderedAssets.length < 5
                  ? `Need 5 images (have ${orderedAssets.length})`
                  : collagePreviewUrl
                    ? "Re-compose collage"
                    : "Create image collage"}
        </button>
      </section>

      {/* ── Branded-collage preview + actions ── */}
      {collagePreviewUrl && collageBlob && collageFilename && (
        <section className="rounded-xl border-2 border-emerald-600 bg-emerald-950/30 p-5 space-y-4">
          <div className="flex items-baseline justify-between gap-3 flex-wrap">
            <h3 className="text-lg font-bold text-emerald-100 uppercase tracking-[0.12em]">
              Collage preview
            </h3>
            <span className="text-sm font-mono text-emerald-200 tabular-nums">
              {(collageSizeBytes / 1024).toFixed(1)} KB · {collageFilename}
            </span>
          </div>

          {collageSizeWarning && (
            <p className="text-sm text-amber-300 bg-amber-950/40 border border-amber-800 rounded-lg px-3 py-2">
              ⚠ The encoder couldn&apos;t hit ≤99 KB at acceptable quality.
              This file is the closest it could get — inspect it before publishing.
            </p>
          )}

          <div className="rounded-lg overflow-hidden border border-emerald-800 bg-black">
            {/* eslint-disable-next-line @next/next/no-img-element -- blob URL, no Next/Image needed */}
            <img src={collagePreviewUrl} alt="Composed marketing collage preview" className="block w-full h-auto" />
          </div>

          <div className="flex flex-wrap gap-3">
            <button
              onClick={handleDownloadCollage}
              className="inline-flex py-3 px-5 rounded-lg font-bold text-base text-white border-2 border-blue-500 bg-blue-600 hover:bg-blue-500 transition-colors"
            >
              ⬇ Download collage
            </button>
            <button
              onClick={handleSaveCollageToHistory}
              disabled={collageSavingToHistory || collageSavedToHistory}
              className={`inline-flex py-3 px-5 rounded-lg font-bold text-base border-2 transition-colors ${
                collageSavedToHistory
                  ? "border-green-700 bg-green-700 text-white cursor-default"
                  : collageSavingToHistory
                    ? "border-zinc-800 bg-zinc-800 text-zinc-500 cursor-not-allowed"
                    : "border-green-500 bg-green-600 hover:bg-green-500 text-white"
              }`}
            >
              {collageSavedToHistory
                ? "✓ Saved to Your Photo Library"
                : collageSavingToHistory
                  ? "Saving to Your Photo Library…"
                  : "💾 Save to Your Photo Library"}
            </button>
          </div>

          <button
            onClick={handleDiscardCollagePreview}
            className="text-sm font-bold uppercase tracking-[0.14em] text-zinc-300 hover:text-white transition-colors border border-zinc-700 hover:border-zinc-400 rounded px-3 py-1.5"
          >
            Discard preview
          </button>
        </section>
      )}

      {/* ── Collage export (1024 long edge, no crop, ≤99 KB) ── */}
      <button
        onClick={handleExportCollage}
        disabled={!canExportCollage}
        className={`
          inline-flex py-3 px-6 rounded-lg font-semibold text-sm uppercase tracking-[0.12em] border-2 transition-all
          ${canExportCollage
            ? "border-green-500 bg-green-600 hover:bg-green-500 text-white"
            : "border-zinc-800 bg-zinc-800 text-zinc-500 cursor-not-allowed"}
        `}
        title="Collage preset: 1024px long edge, no crop, ≤99 KB JPEG. Use for pre-composed multi-image listing collages."
      >
        {isExportingCollage
          ? "Resizing collage(s)…"
          : !isSaved
            ? "Save project first"
            : !hasAssets
              ? "No assets queued"
              : `Collage export — 1024 long edge (${orderedAssets.length})`}
      </button>

      {/* ── Streaming progress ── */}
      {isExporting && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 px-4 py-3 space-y-2" aria-live="polite">
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

      {/* ── PRO preview grid ── */}
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
                className="bg-blue-600 hover:bg-blue-500 text-white text-sm font-semibold px-4 py-2 rounded-lg transition-colors inline-flex items-center gap-2"
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
                  <div className="relative bg-black mx-auto" style={{ aspectRatio: "1024 / 731", width: "100%" }}>
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
