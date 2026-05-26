"use client";
// apps/web/components/modify/ModifyPanel.tsx
//
// Modify tab — optional darkroom + standalone tool between Scan and Resize.
//
// Three modes (tab strip at top):
//   1. ADJUSTMENTS — Brightness / Contrast / Saturation sliders.
//   2. CROP        — Aspect-ratio picker + zoom slider (centred crop).
//   3. STRAIGHTEN  — Rotation slider (-15°..+15°); wedges auto-cropped.
//
// All three settings combine on Apply — operator can dial in any subset.
// Backend pyvips renders each queued asset at full resolution and
// returns new asset rows; Workspace state swaps the queued assets
// in-place so Resize picks up the modified versions automatically.
//
// Standalone mode: operator can drop raw photos directly on this tab,
// bypassing Enhance / Scan entirely. Uploaded files combine with the
// curated resizeAssets pool into `allAssets`. Apply renders them all
// together and the result flows into resizeAssets for the Resize tab
// to pick up.
//
// Phase 1 is BATCH ONLY — same adjustments / crop / rotation apply to
// every queued image. Per-image variation is Phase 2.

import { useCallback, useMemo, useRef, useState } from "react";
import { v4 as uuidv4 } from "uuid";

import {
  applyModifyBatch,
  getSignedUploadUrl,
  uploadToGcs,
  type ModifyAdjustments,
} from "../../lib/api";
import { convertToJpeg } from "../../lib/compress";
import { TipBanner } from "../workspace/TipBanner";

interface PipelineAsset {
  assetId:      string;
  filename:     string;
  thumbnailUrl: string;
  outputUrl?:   string;
  provider?:    string;
}

interface StandaloneUpload {
  id:         string;
  filename:   string;
  previewUrl: string;
  size:       number;
  status:     "uploading" | "done" | "error";
  progress:   number;
  assetId?:   string;
  error?:     string;
}

type ModifyMode = "adjust" | "crop" | "straighten";
type EditScope  = "batch" | "per-image";

/** Neutral adjustments — used as the default for any asset the operator hasn't tweaked. */
const NEUTRAL_ADJ: ModifyAdjustments = {
  brightness:  1.0,
  contrast:    1.0,
  saturation:  1.0,
  rotationDeg: 0.0,
  cropAspect:  "free",
  cropZoom:    1.0,
};

/** True iff `a` and NEUTRAL_ADJ are equivalent (no-op). */
function isNeutralAdj(a: ModifyAdjustments): boolean {
  return (
    a.brightness  === 1.0 &&
    a.contrast    === 1.0 &&
    a.saturation  === 1.0 &&
    a.rotationDeg === 0.0 &&
    a.cropAspect  === "free" &&
    a.cropZoom    === 1.0
  );
}

/** Aspect-ratio choices for the Crop mode. "free" = no crop (keep source aspect). */
type CropAspect = "free" | "1:1" | "4:3" | "7:5" | "16:9";

const ASPECT_RATIOS: Record<Exclude<CropAspect, "free">, [number, number]> = {
  "1:1":  [1, 1],
  "4:3":  [4, 3],
  "7:5":  [7, 5],
  "16:9": [16, 9],
};

const MAX_UPLOADS = 20;

export interface ModifyPanelProps {
  sessionId: string;
  resizeAssets: PipelineAsset[];
  onModifyApplied: (next: PipelineAsset[]) => void;
  /** Wipe the cross-tab pipeline state (Workspace's resizeAssets). */
  onClearPipeline?: () => void;
  /** Jump straight to the Resize tab without applying any adjustments. */
  onSkipToResize?: () => void;
}

// Slider → factor math. Same math both client (CSS preview) and server
// (pyvips render) so the operator's preview is faithful.
function sliderToBC(v: number): number   { return 1.0 + v / 200; } // 0.5..1.5
function sliderToSat(v: number): number  { return 1.0 + v / 100; } // 0.0..2.0

export function ModifyPanel({
  sessionId,
  resizeAssets,
  onModifyApplied,
  onClearPipeline,
  onSkipToResize,
}: ModifyPanelProps) {
  // ── Mode tab state ────────────────────────────────────────────────────
  const [mode, setMode] = useState<ModifyMode>("adjust");

  // ── Edit scope (batch vs per-image) ──────────────────────────────────
  // Batch: one set of adjustments applies to every queued asset. This
  //   is the simple/default mode — preserves Phase 1 behaviour.
  // Per-image: each queued asset keeps its own adjustments in a Map.
  //   Operator clicks a thumb to select; sliders write to that thumb's
  //   entry. Selected thumb is highlighted; the global "batch" sliders
  //   become the FALLBACK for any asset the operator hasn't touched.
  const [editScope, setEditScope] = useState<EditScope>("batch");
  const [batchAdj,  setBatchAdj]  = useState<ModifyAdjustments>(NEUTRAL_ADJ);
  const [perImageAdj, setPerImageAdj] = useState<Map<string, ModifyAdjustments>>(new Map());
  const [selectedAssetId, setSelectedAssetId] = useState<string | null>(null);

  // ── Submission lifecycle ──────────────────────────────────────────────
  const [isApplying, setIsApplying] = useState(false);
  const [error,      setError]      = useState<string | null>(null);
  // Count of images modified in the most recent successful Apply. Drives
  // the green "→ Continue to Resize" success card that appears next to
  // the Apply button after a run. `null` = no recent success (banner
  // hidden). Cleared when the operator clicks Dismiss; preserved when
  // they keep adjusting sliders so a fresh Apply can replace it.
  const [appliedCount, setAppliedCount] = useState<number | null>(null);

  // ── Standalone uploads ───────────────────────────────────────────────
  const [uploads, setUploads] = useState<StandaloneUpload[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const patchUpload = useCallback(
    (id: string, patch: Partial<StandaloneUpload>) => {
      setUploads((prev) => prev.map((u) => (u.id === id ? { ...u, ...patch } : u)));
    },
    [],
  );

  const runUpload = useCallback(
    async (id: string, file: File) => {
      const targetFilename = file.name.replace(/\.[^./\\]+$/, "") + ".jpg";
      let jpegFile: File;
      try {
        jpegFile = await convertToJpeg(file, targetFilename);
        patchUpload(id, { filename: jpegFile.name, size: jpegFile.size });
      } catch (err) {
        patchUpload(id, {
          status: "error",
          error:  err instanceof Error ? err.message : "JPEG conversion failed",
        });
        return;
      }
      let signed: Awaited<ReturnType<typeof getSignedUploadUrl>>;
      try {
        signed = await getSignedUploadUrl({
          sessionId,
          filename:    jpegFile.name,
          contentType: "image/jpeg",
        });
      } catch (err) {
        patchUpload(id, {
          status: "error",
          error:  err instanceof Error ? `Upload URL: ${err.message}` : "Upload URL failed",
        });
        return;
      }
      try {
        await uploadToGcs(signed.uploadUrl, jpegFile, (pct) =>
          patchUpload(id, { progress: pct }),
        );
        patchUpload(id, { status: "done", progress: 100, assetId: signed.assetId });
      } catch (err) {
        patchUpload(id, {
          status: "error",
          error:  err instanceof Error ? `GCS PUT: ${err.message}` : "GCS PUT failed",
        });
      }
    },
    [sessionId, patchUpload],
  );

  const addFiles = useCallback(
    (incoming: FileList | File[]) => {
      const list = Array.from(incoming).filter((f) => f.type.startsWith("image/"));
      if (list.length === 0) return;
      const allowed  = Math.max(0, MAX_UPLOADS - uploads.length);
      const accepted = list.slice(0, allowed);
      const next: StandaloneUpload[] = accepted.map((file) => ({
        id:         uuidv4(),
        filename:   file.name,
        previewUrl: URL.createObjectURL(file),
        size:       file.size,
        status:     "uploading",
        progress:   0,
      }));
      setUploads((prev) => [...prev, ...next]);
      next.forEach((u, i) => { void runUpload(u.id, accepted[i]); });
    },
    [uploads.length, runUpload],
  );

  const handleFileInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      if (e.target.files) addFiles(e.target.files);
      e.target.value = "";
    },
    [addFiles],
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setIsDragging(false);
      if (e.dataTransfer.files) addFiles(e.dataTransfer.files);
    },
    [addFiles],
  );

  const removeUpload = useCallback((id: string) => {
    setUploads((prev) => {
      const target = prev.find((u) => u.id === id);
      if (target) URL.revokeObjectURL(target.previewUrl);
      return prev.filter((u) => u.id !== id);
    });
  }, []);

  // ── Derived values ────────────────────────────────────────────────────
  const standaloneAssets: PipelineAsset[] = uploads
    .filter((u) => u.status === "done" && u.assetId)
    .map((u) => ({
      assetId:      u.assetId as string,
      filename:     u.filename,
      thumbnailUrl: u.previewUrl,
      provider:     undefined,
    }));
  const allAssets = [...resizeAssets, ...standaloneAssets];
  const anyUploadInFlight = uploads.some((u) => u.status === "uploading");

  // The adjustments the operator is currently EDITING — in batch
  // mode this is the global batchAdj; in per-image mode it's the
  // selected thumb's per-image entry (falling back to batchAdj if
  // the operator hasn't touched it yet, so picking up a new
  // image and tweaking inherits the batch baseline).
  const currentAdj: ModifyAdjustments = (() => {
    if (editScope === "batch") return batchAdj;
    if (!selectedAssetId)     return batchAdj;
    return perImageAdj.get(selectedAssetId) ?? batchAdj;
  })();

  // Write back to the right slot based on scope.
  const setCurrentAdj = useCallback(
    (next: ModifyAdjustments) => {
      if (editScope === "batch") {
        setBatchAdj(next);
      } else if (selectedAssetId) {
        setPerImageAdj((prev) => {
          const m = new Map(prev);
          m.set(selectedAssetId, next);
          return m;
        });
      }
    },
    [editScope, selectedAssetId],
  );

  // Per-asset effective adjustments — used for each thumb's CSS
  // preview. In batch mode every thumb sees the same batchAdj.
  // In per-image mode each thumb sees its own perImageAdj entry
  // (or batchAdj as fallback). This is what the operator's actual
  // Apply call will render.
  const effectiveAdjFor = useCallback(
    (assetId: string): ModifyAdjustments => {
      if (editScope === "batch") return batchAdj;
      return perImageAdj.get(assetId) ?? batchAdj;
    },
    [editScope, batchAdj, perImageAdj],
  );

  // Slider display values derive from currentAdj.
  const brightnessSlider = Math.round((currentAdj.brightness - 1.0) * 200);
  const contrastSlider   = Math.round((currentAdj.contrast   - 1.0) * 200);
  const saturationSlider = Math.round((currentAdj.saturation - 1.0) * 100);
  const cropZoomSlider   = Math.round(currentAdj.cropZoom * 100);
  const rotationSliderTenths = Math.round(currentAdj.rotationDeg * 10);

  // Field setters that update the slot driven by scope.
  const setBrightness = (v: number) => setCurrentAdj({ ...currentAdj, brightness: sliderToBC(v) });
  const setContrast   = (v: number) => setCurrentAdj({ ...currentAdj, contrast:   sliderToBC(v) });
  const setSaturation = (v: number) => setCurrentAdj({ ...currentAdj, saturation: sliderToSat(v) });
  const setRotation   = (tenths: number) => setCurrentAdj({ ...currentAdj, rotationDeg: tenths / 10 });
  const setCropAspect = (a: CropAspect) => setCurrentAdj({ ...currentAdj, cropAspect: a });
  const setCropZoom   = (pct: number)  => setCurrentAdj({ ...currentAdj, cropZoom: pct / 100 });

  // Neutrality flags for the controls + the Apply button gate.
  const isAdjustNeutral     = brightnessSlider === 0 && contrastSlider === 0 && saturationSlider === 0;
  const isCropNeutral       = currentAdj.cropAspect === "free" && currentAdj.cropZoom === 1.0;
  const isStraightenNeutral = rotationSliderTenths === 0;
  // "All neutral" considers the FULL set of pending adjustments
  // across batch + per-image. Apply is disabled only if neither the
  // batch defaults nor any per-image override would change anything.
  const anyPerImageNonNeutral = useMemo(
    () => Array.from(perImageAdj.values()).some((a) => !isNeutralAdj(a)),
    [perImageAdj],
  );
  const isAllNeutral = isNeutralAdj(batchAdj) && !anyPerImageNonNeutral;

  // Helpers — slider display values for a SPECIFIC assetId (used for
  // the per-thumb CSS filter / transform).
  const cssFilterFor = (assetId: string): string => {
    const a = effectiveAdjFor(assetId);
    return (
      `brightness(${a.brightness.toFixed(3)}) ` +
      `contrast(${a.contrast.toFixed(3)}) ` +
      `saturate(${a.saturation.toFixed(3)})`
    );
  };
  const cssRotateFor = (assetId: string): string => {
    const deg = effectiveAdjFor(assetId).rotationDeg;
    return deg === 0 ? "none" : `rotate(${deg.toFixed(1)}deg)`;
  };

  // ── Handlers ──────────────────────────────────────────────────────────
  const handleResetAll = () => {
    setBatchAdj(NEUTRAL_ADJ);
    setPerImageAdj(new Map());
    setError(null);
  };

  // Big red "Clear All" — wipes EVERY piece of Modify-tab state:
  //   - Standalone uploads (with URL.revokeObjectURL on each preview)
  //   - All adjustment state (batch + per-image)
  //   - Selection + error
  //   - Cross-tab pipeline via onClearPipeline (resizeAssets goes empty
  //     so Scan/Resize/Modify all see a clean slate)
  // Sliders go back to neutral, scope flips back to Batch.
  const handleClearEverything = () => {
    setUploads((prev) => {
      prev.forEach((u) => URL.revokeObjectURL(u.previewUrl));
      return [];
    });
    setBatchAdj(NEUTRAL_ADJ);
    setPerImageAdj(new Map());
    setSelectedAssetId(null);
    setEditScope("batch");
    setError(null);
    onClearPipeline?.();
  };

  // Reset only the currently-selected per-image override (in per-image
  // mode) — useful for "undo my tweak to this image" without nuking
  // the whole batch.
  const handleResetCurrent = () => {
    if (editScope === "batch") {
      setBatchAdj(NEUTRAL_ADJ);
    } else if (selectedAssetId) {
      setPerImageAdj((prev) => {
        const m = new Map(prev);
        m.delete(selectedAssetId);
        return m;
      });
    }
  };

  // Copy the currently-selected image's adjustments to every other
  // image in per-image mode. Handy for "I tuned this one perfectly,
  // now apply the same settings to the rest."
  const handleCopyCurrentToAll = () => {
    if (editScope !== "per-image" || !selectedAssetId) return;
    const source = perImageAdj.get(selectedAssetId) ?? batchAdj;
    if (isNeutralAdj(source)) return;
    setPerImageAdj(() => {
      const m = new Map<string, ModifyAdjustments>();
      for (const a of allAssets) m.set(a.assetId, source);
      return m;
    });
  };

  const handleApply = async () => {
    if (allAssets.length === 0 || isApplying || anyUploadInFlight) return;
    setError(null);
    setIsApplying(true);
    try {
      // In per-image mode, serialise the Map → Record for the API.
      // In batch mode, perAsset stays empty and the default
      // `adjustments` applies to every asset_id.
      const perAssetRecord: Record<string, ModifyAdjustments> = {};
      if (editScope === "per-image") {
        for (const [k, v] of perImageAdj.entries()) {
          if (!isNeutralAdj(v)) perAssetRecord[k] = v;
        }
      }
      const { items } = await applyModifyBatch({
        sessionId,
        assetIds:    allAssets.map((a) => a.assetId),
        adjustments: batchAdj,
        perAsset:    perAssetRecord,
      });
      const next: PipelineAsset[] = items.map((it, i) => {
        const original = allAssets[i];
        return {
          assetId:      it.assetId,
          filename:     original?.filename ?? it.filename,
          thumbnailUrl: it.url,
          outputUrl:    it.url,
          provider:     original?.provider,
        };
      });
      onModifyApplied(next);
      // Clear standalone uploads + revoke object URLs.
      setUploads((prev) => {
        prev.forEach((u) => URL.revokeObjectURL(u.previewUrl));
        return [];
      });
      handleResetAll();
      setSelectedAssetId(null);
      // Show the green "→ Continue to Resize" success card. handleResetAll
      // doesn't clear this; only an explicit Dismiss or a subsequent
      // successful Apply replaces the count.
      setAppliedCount(next.length);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Modify failed");
    } finally {
      setIsApplying(false);
    }
  };

  // Helper — compute the dashed-overlay CSS percentages for a given
  // asset's adjustments. Used by each thumb so per-image mode shows
  // each thumb's own crop bounds.
  function cropOverlayFor(adj: ModifyAdjustments): React.CSSProperties | null {
    if (adj.cropAspect === "free" && adj.cropZoom === 1.0) return null;
    if (adj.cropAspect === "free") {
      const inset = (1 - adj.cropZoom) * 50;
      return { top: `${inset}%`, left: `${inset}%`, right: `${inset}%`, bottom: `${inset}%` };
    }
    const [aw, ah] = ASPECT_RATIOS[adj.cropAspect];
    const containerAR = 4 / 3;
    const targetAR    = aw / ah;
    let widthPct: number;
    let heightPct: number;
    if (targetAR >= containerAR) {
      widthPct  = 100;
      heightPct = (containerAR / targetAR) * 100;
    } else {
      heightPct = 100;
      widthPct  = (targetAR / containerAR) * 100;
    }
    widthPct  *= adj.cropZoom;
    heightPct *= adj.cropZoom;
    const horizontalInset = (100 - widthPct)  / 2;
    const verticalInset   = (100 - heightPct) / 2;
    return {
      top:    `${verticalInset}%`,
      left:   `${horizontalInset}%`,
      right:  `${horizontalInset}%`,
      bottom: `${verticalInset}%`,
    };
  }

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className="space-y-4">
      <header className="space-y-1">
        <h1 className="text-3xl font-extrabold text-white tracking-tight">
          Modify
        </h1>
        <p className="text-base text-zinc-300">
          Optional darkroom + standalone tool — adjust, crop, or straighten
          before the final Resize step.
        </p>
      </header>

      {/* ── Optional / Skip / Clear callout ─────────────────────────────
          Loud and at the top so the operator immediately sees they don't
          HAVE to use this tab. Skip jumps straight to Resize; Clear All
          wipes every piece of Modify-tab state (local + cross-tab). */}
      <section className="rounded-xl border-2 border-yellow-600 bg-yellow-950/30 px-5 py-4 flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-3 min-w-0 flex-1">
          <span className="text-2xl shrink-0" aria-hidden="true">⏭️</span>
          <div className="min-w-0">
            <p className="text-base font-bold uppercase tracking-[0.14em] text-yellow-100">
              Modify is optional — feel free to skip
            </p>
            <p className="text-sm text-yellow-50 mt-1 leading-relaxed">
              If your photos already look good after Scan (or you uploaded
              straight to Resize), you can go straight to the Resize tab.
              This tab is here for when you want to tweak brightness,
              contrast, crop, or straightening before exporting.
            </p>
          </div>
        </div>
        <div className="flex gap-2 shrink-0 flex-wrap">
          {onSkipToResize && (
            <button
              type="button"
              onClick={onSkipToResize}
              className="text-base font-bold uppercase tracking-[0.12em] px-5 py-3 rounded-lg border-2 border-blue-500 bg-blue-600 hover:bg-blue-500 text-white transition-colors shadow-lg shadow-blue-900/40"
            >
              Skip to Resize →
            </button>
          )}
          <button
            type="button"
            onClick={handleClearEverything}
            className="text-base font-bold uppercase tracking-[0.12em] px-5 py-3 rounded-lg border-2 border-red-500 bg-red-600 hover:bg-red-500 text-white transition-colors shadow-lg shadow-red-900/40"
          >
            Clear All
          </button>
        </div>
      </section>

      <TipBanner
        title="How Modify works"
        steps={[
          <>This tab is optional. If your photos already look good after Scan, skip it and go straight to Resize.</>,
          <>You can also <span className="font-semibold text-yellow-300">drop raw photos directly</span> below to use Modify as a standalone tool — no need to run Enhance / Scan first.</>,
          <>Switch between Adjustments / Crop / Straighten tabs. Settings from all three combine on Apply.</>,
          <>The preview thumbnails update live as you drag. Click <span className="font-semibold text-white">Apply</span> to commit; full-resolution render runs server-side.</>,
        ]}
      >
        <p>
          Lighting bad? Photo crooked? Wrong aspect ratio? Fix it here in one
          pass. The modified versions replace what&apos;s queued for Resize.
        </p>
      </TipBanner>

      {/* ── Standalone upload drop zone ──────────────────────────────── */}
      <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 overflow-hidden">
        <header className="flex items-center justify-between px-5 py-4 bg-zinc-900/40 border-b border-zinc-900 gap-3">
          <div className="flex flex-col gap-1 min-w-0">
            <span className="text-base font-bold uppercase tracking-[0.14em] text-zinc-100">
              Upload images directly
            </span>
            <span className="text-sm text-zinc-300 leading-relaxed">
              Use Modify as a standalone tool — drop raw photos here, adjust,
              click Apply, then continue to Resize for export.
            </span>
          </div>
          <span className="text-sm uppercase tracking-[0.16em] font-mono text-zinc-300 tabular-nums shrink-0">
            {uploads.length} / {MAX_UPLOADS}
          </span>
        </header>
        <div
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
          role="button"
          tabIndex={0}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              fileInputRef.current?.click();
            }
          }}
          className={`m-4 p-6 rounded-lg border-2 border-dashed cursor-pointer transition-colors text-center
            ${isDragging
              ? "border-blue-500 bg-blue-950/30"
              : uploads.length >= MAX_UPLOADS
                ? "border-zinc-800 bg-zinc-900/40 cursor-not-allowed opacity-60"
                : "border-zinc-700 bg-zinc-900/40 hover:border-zinc-500"}`}
          aria-disabled={uploads.length >= MAX_UPLOADS}
        >
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            multiple
            onChange={handleFileInputChange}
            className="sr-only"
            disabled={uploads.length >= MAX_UPLOADS}
          />
          <p className="text-lg text-zinc-100 font-semibold">
            {uploads.length >= MAX_UPLOADS
              ? `Maximum ${MAX_UPLOADS} uploads reached`
              : isDragging
                ? "Drop to upload"
                : "Click or drop image files here"}
          </p>
          <p className="text-sm text-zinc-300 mt-1">
            JPEG, PNG, WebP · auto-converted to JPEG before upload
          </p>
        </div>
        {uploads.length > 0 && (
          <div className="grid grid-cols-2 sm:grid-cols-4 md:grid-cols-5 gap-2 p-4 pt-0">
            {uploads.map((u) => (
              <div
                key={u.id}
                className={`relative rounded-lg overflow-hidden border bg-zinc-900 ${
                  u.status === "error" ? "border-red-700" : "border-zinc-800"
                }`}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img src={u.previewUrl} alt={u.filename} className="w-full aspect-square object-cover" />
                {u.status !== "done" && (
                  <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center p-2 gap-1">
                    {u.status === "uploading" && (
                      <>
                        <div className="w-full bg-zinc-700 rounded-full h-1.5">
                          <div
                            className="bg-blue-500 h-1.5 rounded-full transition-all"
                            style={{ width: `${u.progress}%` }}
                          />
                        </div>
                        <span className="text-[10px] text-blue-300">{u.progress}%</span>
                      </>
                    )}
                    {u.status === "error" && (
                      <span className="text-[10px] text-red-400 text-center">{u.error ?? "Upload failed"}</span>
                    )}
                  </div>
                )}
                {u.status === "done" && (
                  <div className="absolute top-1 right-1 bg-green-500 rounded-full p-0.5" aria-label="Uploaded">
                    <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  </div>
                )}
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); removeUpload(u.id); }}
                  className="absolute -top-1 -right-1 bg-red-600 hover:bg-red-500 rounded-full p-0.5 opacity-0 hover:opacity-100 group-hover:opacity-100 transition-opacity"
                  aria-label={`Remove ${u.filename}`}
                >
                  <svg className="w-3 h-3 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={3}>
                    <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      {/* Empty state when nothing queued + no uploads */}
      {allAssets.length === 0 && (
        <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-950/30 px-6 py-12 text-center">
          <p className="text-base text-zinc-300 font-semibold">
            Nothing queued for modify yet.
          </p>
          <p className="text-sm text-zinc-400 mt-2">
            Drop photos above to use Modify standalone, OR send approved photos
            from the Scan tab to operate on enhanced output.
          </p>
        </div>
      )}

      {/* Preview grid + control panel — only when we have assets */}
      {allAssets.length > 0 && (
        <>
          {/* Edit scope toggle — batch vs per-image */}
          <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 px-5 py-4 flex items-center justify-between gap-4 flex-wrap">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="text-sm uppercase tracking-[0.14em] font-bold text-zinc-100">Edit scope</span>
              <div className="inline-flex rounded-md border border-zinc-700 overflow-hidden">
                <button
                  type="button"
                  onClick={() => { setEditScope("batch"); setSelectedAssetId(null); }}
                  aria-pressed={editScope === "batch"}
                  className={`text-sm font-bold uppercase tracking-[0.14em] px-4 py-2 transition-colors ${
                    editScope === "batch" ? "bg-emerald-600 text-white" : "bg-zinc-900 text-zinc-200 hover:text-white"
                  }`}
                >
                  Batch (all images)
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setEditScope("per-image");
                    if (!selectedAssetId && allAssets[0]) setSelectedAssetId(allAssets[0].assetId);
                  }}
                  aria-pressed={editScope === "per-image"}
                  className={`text-sm font-bold uppercase tracking-[0.14em] px-4 py-2 border-l border-zinc-700 transition-colors ${
                    editScope === "per-image" ? "bg-emerald-600 text-white" : "bg-zinc-900 text-zinc-200 hover:text-white"
                  }`}
                >
                  Per-image
                </button>
              </div>
            </div>
            <p className="text-sm text-zinc-300 max-w-xl">
              {editScope === "batch"
                ? "One set of adjustments applies to every queued image. Switch to Per-image to tune photos individually."
                : "Click a thumbnail below to select it, then adjust. Each image keeps its own settings; untouched images use the batch defaults."}
            </p>
          </section>

          <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 overflow-hidden">
            <header className="flex items-center justify-between px-5 py-4 bg-zinc-900/40 border-b border-zinc-900">
              <span className="text-base font-bold uppercase tracking-[0.14em] text-zinc-100">
                Live preview · {allAssets.length} image{allAssets.length !== 1 ? "s" : ""}
              </span>
              <span className="text-sm text-zinc-400 italic">
                {isAllNeutral
                  ? "All controls neutral — no changes applied"
                  : editScope === "per-image"
                    ? "Click any thumbnail to select + tune"
                    : "Adjust below to preview"}
              </span>
            </header>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 p-5">
              {allAssets.map((a) => {
                const adj = effectiveAdjFor(a.assetId);
                const overlay = cropOverlayFor(adj);
                const isSelected = editScope === "per-image" && selectedAssetId === a.assetId;
                const hasOverride = perImageAdj.has(a.assetId) && !isNeutralAdj(perImageAdj.get(a.assetId)!);
                const clickable = editScope === "per-image";
                return (
                  <figure
                    key={a.assetId}
                    onClick={clickable ? () => setSelectedAssetId(a.assetId) : undefined}
                    className={`relative aspect-4/3 rounded-lg overflow-hidden border bg-black transition-all ${
                      isSelected
                        ? "border-emerald-400 ring-2 ring-emerald-400/40"
                        : clickable
                          ? "border-zinc-700 hover:border-zinc-400 cursor-pointer"
                          : "border-zinc-800"
                    }`}
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={a.thumbnailUrl}
                      alt={a.filename}
                      className="absolute inset-0 w-full h-full object-contain transition-[filter,transform] duration-100"
                      style={{
                        filter:    cssFilterFor(a.assetId),
                        transform: cssRotateFor(a.assetId),
                      }}
                    />
                    {overlay && (
                      <div
                        className="absolute border-2 border-dashed border-yellow-400 pointer-events-none"
                        style={overlay}
                      />
                    )}
                    {hasOverride && (
                      <span className="absolute top-2 right-2 text-[10px] uppercase tracking-[0.12em] font-bold text-emerald-100 bg-emerald-900/80 border border-emerald-500 px-1.5 py-0.5 rounded pointer-events-none">
                        Tuned
                      </span>
                    )}
                    {isSelected && (
                      <span className="absolute top-2 left-2 text-[10px] uppercase tracking-[0.12em] font-bold text-white bg-emerald-600 px-1.5 py-0.5 rounded pointer-events-none">
                        Editing
                      </span>
                    )}
                    <div className="absolute inset-x-0 bottom-0 px-3 py-1.5 bg-linear-to-t from-black/85 to-transparent">
                      <span className="text-xs font-mono text-zinc-200 truncate block" title={a.filename}>
                        {a.filename}
                      </span>
                    </div>
                  </figure>
                );
              })}
            </div>
          </section>

          <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 overflow-hidden">
            {/* Mode tab strip */}
            <div className="flex items-center justify-between px-5 pt-4 gap-3 border-b border-zinc-900">
              <div className="flex gap-2">
                <ModeButton active={mode === "adjust"}     onClick={() => setMode("adjust")}>     Adjustments </ModeButton>
                <ModeButton active={mode === "crop"}       onClick={() => setMode("crop")}>       Crop        </ModeButton>
                <ModeButton active={mode === "straighten"} onClick={() => setMode("straighten")}> Straighten  </ModeButton>
              </div>
              <button
                type="button"
                onClick={handleResetAll}
                disabled={isAllNeutral || isApplying}
                className="text-sm uppercase tracking-[0.14em] font-bold text-zinc-200 hover:text-white border border-zinc-700 hover:border-zinc-400 rounded px-3 py-1.5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors mb-3"
              >
                Reset all
              </button>
            </div>

            <div className="p-5 space-y-5">
              {/* Per-image scope banner — shows which image the controls are editing. */}
              {editScope === "per-image" && (
                <div className="rounded-md border border-emerald-700/60 bg-emerald-950/30 px-4 py-3 flex items-center justify-between gap-3 flex-wrap">
                  <div className="min-w-0">
                    <p className="text-sm font-bold uppercase tracking-[0.14em] text-emerald-200">
                      Editing
                    </p>
                    <p className="text-base text-emerald-50 font-mono truncate" title={selectedAssetId ? allAssets.find((a) => a.assetId === selectedAssetId)?.filename : undefined}>
                      {selectedAssetId
                        ? (allAssets.find((a) => a.assetId === selectedAssetId)?.filename ?? "—")
                        : "Click a thumbnail above to start editing"}
                    </p>
                  </div>
                  {selectedAssetId && (
                    <div className="flex gap-2 flex-wrap">
                      <button
                        type="button"
                        onClick={handleCopyCurrentToAll}
                        disabled={isApplying || isNeutralAdj(currentAdj)}
                        className="text-sm uppercase tracking-[0.14em] font-bold text-emerald-200 hover:text-white border border-emerald-700 hover:border-emerald-400 rounded px-3 py-1.5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      >
                        Copy to all
                      </button>
                      <button
                        type="button"
                        onClick={handleResetCurrent}
                        disabled={isApplying || isNeutralAdj(currentAdj)}
                        className="text-sm uppercase tracking-[0.14em] font-bold text-zinc-200 hover:text-white border border-zinc-700 hover:border-zinc-400 rounded px-3 py-1.5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      >
                        Reset this image
                      </button>
                    </div>
                  )}
                </div>
              )}

              {mode === "adjust" && (
                <>
                  <SliderRow label="Brightness" value={brightnessSlider} onChange={setBrightness} factor={currentAdj.brightness} accent="amber"   disabled={isApplying} />
                  <SliderRow label="Contrast"   value={contrastSlider}   onChange={setContrast}   factor={currentAdj.contrast}   accent="sky"     disabled={isApplying} />
                  <SliderRow label="Saturation" value={saturationSlider} onChange={setSaturation} factor={currentAdj.saturation} accent="emerald" disabled={isApplying} />
                </>
              )}

              {mode === "crop" && (
                <>
                  <div className="flex flex-col gap-2">
                    <span className="text-sm uppercase tracking-[0.16em] font-bold text-zinc-100">Aspect ratio</span>
                    <div className="flex flex-wrap gap-2">
                      {(["free", "1:1", "4:3", "7:5", "16:9"] as const).map((opt) => {
                        const selected = currentAdj.cropAspect === opt;
                        return (
                          <button
                            key={opt}
                            type="button"
                            onClick={() => setCropAspect(opt)}
                            disabled={isApplying}
                            className={`text-base font-bold uppercase tracking-[0.14em] px-4 py-2 rounded-md border-2 transition-colors ${
                              selected
                                ? "border-yellow-400 bg-yellow-950/40 text-yellow-100"
                                : "border-zinc-700 bg-zinc-900 text-zinc-200 hover:border-zinc-500"
                            } disabled:opacity-40 disabled:cursor-not-allowed`}
                          >
                            {opt === "free" ? "Free" : opt}
                          </button>
                        );
                      })}
                    </div>
                    <p className="text-sm text-zinc-400 leading-relaxed">
                      <span className="text-zinc-300 font-semibold">7:5</span> matches the PRO export target.{" "}
                      <span className="text-zinc-300 font-semibold">Free</span> keeps the source aspect (zoom only crops symmetrically).
                    </p>
                  </div>

                  <label className="flex flex-col gap-2">
                    <div className="flex items-baseline justify-between">
                      <span className="text-sm uppercase tracking-[0.16em] font-bold text-zinc-100">Zoom</span>
                      <span className="text-sm font-mono tabular-nums text-zinc-300">
                        {cropZoomSlider}% <span className="text-zinc-500">· keep {cropZoomSlider}% of frame</span>
                      </span>
                    </div>
                    <input
                      type="range"
                      min={50}
                      max={100}
                      step={1}
                      value={cropZoomSlider}
                      disabled={isApplying}
                      onChange={(e) => setCropZoom(Number(e.target.value))}
                      className="w-full accent-yellow-400 disabled:opacity-40"
                    />
                    <p className="text-sm text-zinc-400">100% = no crop. Lower values crop in from the centre.</p>
                  </label>
                </>
              )}

              {mode === "straighten" && (
                <label className="flex flex-col gap-2">
                  <div className="flex items-baseline justify-between">
                    <span className="text-sm uppercase tracking-[0.16em] font-bold text-zinc-100">Rotation</span>
                    <span className="text-sm font-mono tabular-nums text-zinc-300">
                      {currentAdj.rotationDeg > 0 ? `+${currentAdj.rotationDeg.toFixed(1)}` : currentAdj.rotationDeg.toFixed(1)}°
                    </span>
                  </div>
                  <input
                    type="range"
                    min={-150}
                    max={150}
                    step={1}
                    value={rotationSliderTenths}
                    disabled={isApplying}
                    onChange={(e) => setRotation(Number(e.target.value))}
                    className="w-full accent-rose-400 disabled:opacity-40"
                  />
                  <p className="text-sm text-zinc-400 leading-relaxed">
                    Rotates the whole scene to level the horizon. On Apply, the rotation
                    wedges are cropped out automatically so the output stays rectangular.
                    Range: −15.0° to +15.0°.
                  </p>
                </label>
              )}

              {error && (
                <p className="text-base text-red-300 bg-red-950/40 border border-red-800 rounded-lg px-4 py-3">
                  {error}
                </p>
              )}

              {appliedCount !== null && (
                <div className="bg-emerald-950/50 border-2 border-emerald-600 rounded-xl px-5 py-4 flex items-center gap-4">
                  <div className="flex-1">
                    <p className="text-base font-bold text-emerald-100">
                      ✓ {appliedCount} image{appliedCount !== 1 ? "s" : ""} modified successfully
                    </p>
                    <p className="text-sm text-emerald-300 mt-0.5">
                      Ready for Resize, or keep adjusting and Apply again to replace.
                    </p>
                  </div>
                  {onSkipToResize && (
                    <button
                      type="button"
                      onClick={() => {
                        setAppliedCount(null);
                        onSkipToResize();
                      }}
                      className="px-5 py-2.5 rounded-lg font-bold text-sm uppercase tracking-[0.12em] bg-emerald-500 hover:bg-emerald-400 text-emerald-950 shadow-lg shadow-emerald-900/40 transition-colors whitespace-nowrap"
                    >
                      Continue to Resize →
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => setAppliedCount(null)}
                    aria-label="Dismiss"
                    className="text-emerald-400 hover:text-emerald-200 text-xl leading-none px-1"
                  >
                    ×
                  </button>
                </div>
              )}

              <button
                type="button"
                onClick={handleApply}
                disabled={isAllNeutral || isApplying || allAssets.length === 0 || anyUploadInFlight}
                className={`w-full py-3 px-6 rounded-xl font-bold text-base uppercase tracking-[0.12em] transition-all ${
                  !isAllNeutral && !isApplying && allAssets.length > 0 && !anyUploadInFlight
                    ? "bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-900/40"
                    : "bg-zinc-800 text-zinc-500 cursor-not-allowed"
                }`}
              >
                {isApplying
                  ? `Applying to ${allAssets.length} image${allAssets.length !== 1 ? "s" : ""}…`
                  : anyUploadInFlight
                    ? "Waiting for uploads to finish…"
                    : isAllNeutral
                      ? "Adjust a control to enable Apply"
                      : `Apply to ${allAssets.length} image${allAssets.length !== 1 ? "s" : ""}`}
              </button>
            </div>
          </section>
        </>
      )}
    </div>
  );
}

// ─── Mode tab button ──────────────────────────────────────────────────────────

function ModeButton({
  active, onClick, children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`px-4 py-2 text-sm uppercase tracking-[0.14em] font-bold rounded-t-md transition-colors ${
        active
          ? "bg-zinc-900 text-white border-b-2 border-emerald-500"
          : "bg-transparent text-zinc-400 hover:text-zinc-200 border-b-2 border-transparent"
      }`}
    >
      {children}
    </button>
  );
}

// ─── Slider row ───────────────────────────────────────────────────────────────

interface SliderRowProps {
  label: string;
  value: number;
  onChange: (next: number) => void;
  factor: number;
  accent: "amber" | "sky" | "emerald";
  disabled?: boolean;
}

function SliderRow({ label, value, onChange, factor, accent, disabled }: SliderRowProps) {
  const accentClass =
    accent === "amber"   ? "accent-amber-500" :
    accent === "sky"     ? "accent-sky-500"   :
    /* emerald */          "accent-emerald-500";
  return (
    <label className="flex flex-col gap-2">
      <div className="flex items-baseline justify-between">
        <span className="text-sm uppercase tracking-[0.16em] font-bold text-zinc-100">{label}</span>
        <span className="text-sm font-mono tabular-nums text-zinc-300">
          {value > 0 ? `+${value}` : value}{" "}
          <span className="text-zinc-500">· ×{factor.toFixed(2)}</span>
        </span>
      </div>
      <input
        type="range"
        min={-100}
        max={100}
        step={1}
        value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        className={`w-full ${accentClass} disabled:opacity-40`}
      />
    </label>
  );
}
