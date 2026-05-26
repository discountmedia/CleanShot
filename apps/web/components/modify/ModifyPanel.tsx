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
}

// Slider → factor math. Same math both client (CSS preview) and server
// (pyvips render) so the operator's preview is faithful.
function sliderToBC(v: number): number   { return 1.0 + v / 200; } // 0.5..1.5
function sliderToSat(v: number): number  { return 1.0 + v / 100; } // 0.0..2.0

export function ModifyPanel({
  sessionId,
  resizeAssets,
  onModifyApplied,
}: ModifyPanelProps) {
  // ── Mode tab state ────────────────────────────────────────────────────
  const [mode, setMode] = useState<ModifyMode>("adjust");

  // ── Adjustments ───────────────────────────────────────────────────────
  const [brightnessSlider, setBrightnessSlider] = useState(0);
  const [contrastSlider,   setContrastSlider]   = useState(0);
  const [saturationSlider, setSaturationSlider] = useState(0);

  // ── Crop ──────────────────────────────────────────────────────────────
  const [cropAspect, setCropAspect] = useState<CropAspect>("free");
  // Zoom slider 50..100 = 0.5..1.0 crop_zoom (1.0 = full source area).
  const [cropZoomSlider, setCropZoomSlider] = useState(100);

  // ── Straighten ────────────────────────────────────────────────────────
  // Rotation slider -150..+150 maps to -15.0°..+15.0° (step = 0.1°).
  const [rotationSliderTenths, setRotationSliderTenths] = useState(0);

  // ── Submission lifecycle ──────────────────────────────────────────────
  const [isApplying, setIsApplying] = useState(false);
  const [error,      setError]      = useState<string | null>(null);

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

  const brightnessFactor = sliderToBC(brightnessSlider);
  const contrastFactor   = sliderToBC(contrastSlider);
  const saturationFactor = sliderToSat(saturationSlider);
  const cropZoomFactor   = cropZoomSlider / 100;
  const rotationDeg      = rotationSliderTenths / 10;

  const isAdjustNeutral   = brightnessSlider === 0 && contrastSlider === 0 && saturationSlider === 0;
  const isCropNeutral     = cropAspect === "free" && cropZoomFactor === 1;
  const isStraightenNeutral = rotationSliderTenths === 0;
  const isAllNeutral = isAdjustNeutral && isCropNeutral && isStraightenNeutral;

  // ── CSS preview transforms ────────────────────────────────────────────
  const cssFilter = useMemo(
    () =>
      `brightness(${brightnessFactor.toFixed(3)}) ` +
      `contrast(${contrastFactor.toFixed(3)}) ` +
      `saturate(${saturationFactor.toFixed(3)})`,
    [brightnessFactor, contrastFactor, saturationFactor],
  );
  const cssRotate = useMemo(
    () => (rotationDeg === 0 ? "none" : `rotate(${rotationDeg.toFixed(1)}deg)`),
    [rotationDeg],
  );

  // ── Handlers ──────────────────────────────────────────────────────────
  const handleResetAll = () => {
    setBrightnessSlider(0);
    setContrastSlider(0);
    setSaturationSlider(0);
    setCropAspect("free");
    setCropZoomSlider(100);
    setRotationSliderTenths(0);
    setError(null);
  };

  const handleApply = async () => {
    if (allAssets.length === 0 || isApplying || anyUploadInFlight) return;
    setError(null);
    setIsApplying(true);
    try {
      const adjustments: ModifyAdjustments = {
        brightness:   brightnessFactor,
        contrast:     contrastFactor,
        saturation:   saturationFactor,
        rotationDeg:  rotationDeg,
        cropAspect:   cropAspect,
        cropZoom:     cropZoomFactor,
      };
      const { items } = await applyModifyBatch({
        sessionId,
        assetIds: allAssets.map((a) => a.assetId),
        adjustments,
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
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Modify failed");
    } finally {
      setIsApplying(false);
    }
  };

  // Helper for the dashed-overlay rect's CSS — given the source's
  // visible aspect (which the operator sees in the preview thumbnail)
  // compute the largest aspect-locked rect that fits, scaled by zoom.
  // Returns CSS percentages so it works regardless of actual pixel
  // dims (the preview thumb is responsive).
  const cropOverlay = useMemo(() => {
    if (cropAspect === "free") {
      // Whole image at zoom factor.
      const inset = (1 - cropZoomFactor) * 50; // percent on each side
      return {
        top:    `${inset}%`,
        left:   `${inset}%`,
        right:  `${inset}%`,
        bottom: `${inset}%`,
      };
    }
    const [aw, ah] = ASPECT_RATIOS[cropAspect];
    // Without knowing the thumb's true aspect we assume the displayed
    // image fills a 4:3 figure (the preview cell aspect-4/3). The
    // overlay is computed relative to that container.
    const containerAR = 4 / 3;
    const targetAR    = aw / ah;
    let widthPct: number;
    let heightPct: number;
    if (targetAR >= containerAR) {
      // Target is wider — width-limited at the container.
      widthPct  = 100;
      heightPct = (containerAR / targetAR) * 100;
    } else {
      // Target is narrower — height-limited.
      heightPct = 100;
      widthPct  = (targetAR / containerAR) * 100;
    }
    widthPct  *= cropZoomFactor;
    heightPct *= cropZoomFactor;
    const horizontalInset = (100 - widthPct)  / 2;
    const verticalInset   = (100 - heightPct) / 2;
    return {
      top:    `${verticalInset}%`,
      left:   `${horizontalInset}%`,
      right:  `${horizontalInset}%`,
      bottom: `${verticalInset}%`,
    };
  }, [cropAspect, cropZoomFactor]);

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
          <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 overflow-hidden">
            <header className="flex items-center justify-between px-5 py-4 bg-zinc-900/40 border-b border-zinc-900">
              <span className="text-base font-bold uppercase tracking-[0.14em] text-zinc-100">
                Live preview · {allAssets.length} image{allAssets.length !== 1 ? "s" : ""}
              </span>
              <span className="text-sm text-zinc-400 italic">
                {isAllNeutral ? "All controls neutral — no changes applied" : "Adjust below to preview"}
              </span>
            </header>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 p-5">
              {allAssets.map((a) => (
                <figure
                  key={a.assetId}
                  className="relative aspect-4/3 rounded-lg overflow-hidden border border-zinc-800 bg-black"
                >
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img
                    src={a.thumbnailUrl}
                    alt={a.filename}
                    className="absolute inset-0 w-full h-full object-contain transition-[filter,transform] duration-100"
                    style={{ filter: cssFilter, transform: cssRotate }}
                  />
                  {/* Crop overlay — dashed rect indicates the area kept on Apply */}
                  {!isCropNeutral && (
                    <div
                      className="absolute border-2 border-dashed border-yellow-400 pointer-events-none"
                      style={cropOverlay}
                    />
                  )}
                  <div className="absolute inset-x-0 bottom-0 px-3 py-1.5 bg-linear-to-t from-black/85 to-transparent">
                    <span className="text-xs font-mono text-zinc-200 truncate block" title={a.filename}>
                      {a.filename}
                    </span>
                  </div>
                </figure>
              ))}
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
              {mode === "adjust" && (
                <>
                  <SliderRow label="Brightness" value={brightnessSlider} onChange={setBrightnessSlider} factor={brightnessFactor} accent="amber"   disabled={isApplying} />
                  <SliderRow label="Contrast"   value={contrastSlider}   onChange={setContrastSlider}   factor={contrastFactor}   accent="sky"     disabled={isApplying} />
                  <SliderRow label="Saturation" value={saturationSlider} onChange={setSaturationSlider} factor={saturationFactor} accent="emerald" disabled={isApplying} />
                </>
              )}

              {mode === "crop" && (
                <>
                  <div className="flex flex-col gap-2">
                    <span className="text-sm uppercase tracking-[0.16em] font-bold text-zinc-100">Aspect ratio</span>
                    <div className="flex flex-wrap gap-2">
                      {(["free", "1:1", "4:3", "7:5", "16:9"] as const).map((opt) => {
                        const selected = cropAspect === opt;
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
                        {cropZoomSlider}% <span className="text-zinc-500">· keep {Math.round(cropZoomFactor * 100)}% of frame</span>
                      </span>
                    </div>
                    <input
                      type="range"
                      min={50}
                      max={100}
                      step={1}
                      value={cropZoomSlider}
                      disabled={isApplying}
                      onChange={(e) => setCropZoomSlider(Number(e.target.value))}
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
                      {rotationDeg > 0 ? `+${rotationDeg.toFixed(1)}` : rotationDeg.toFixed(1)}°
                    </span>
                  </div>
                  <input
                    type="range"
                    min={-150}
                    max={150}
                    step={1}
                    value={rotationSliderTenths}
                    disabled={isApplying}
                    onChange={(e) => setRotationSliderTenths(Number(e.target.value))}
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
