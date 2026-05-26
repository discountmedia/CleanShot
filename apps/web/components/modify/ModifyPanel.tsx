"use client";
// apps/web/components/modify/ModifyPanel.tsx
//
// Modify tab — optional "darkroom" pass between Scan and Resize.
// Operator drags Brightness / Contrast / Saturation sliders, sees a
// live CSS-filter preview on every queued image, and clicks Apply to
// commit. Backend pyvips renders each asset at full resolution and
// returns new asset rows; Workspace state swaps the queued assets
// in-place so Resize picks up the modified versions automatically.
//
// Phase 1 is BATCH ONLY — same adjustments apply to every queued
// image. Per-image variation is a follow-up.

import { useMemo, useState } from "react";

import { applyModifyBatch, type ModifyAdjustments } from "../../lib/api";
import { TipBanner } from "../workspace/TipBanner";

interface PipelineAsset {
  assetId:      string;
  filename:     string;
  thumbnailUrl: string;
  outputUrl?:   string;
  provider?:    string;
}

export interface ModifyPanelProps {
  sessionId: string;
  /** Assets currently queued for Resize. Modify reads + replaces this list. */
  resizeAssets: PipelineAsset[];
  /** Called after Apply succeeds with the new asset list. Workspace swaps state. */
  onModifyApplied: (next: PipelineAsset[]) => void;
}

// Slider mapping — frontend uses integer -100..+100 sliders. Factors
// shipped to the backend / used in CSS filters:
//   brightness/contrast: 0.5..1.5  (neutral = 1.0 at slider 0)
//   saturation:          0.0..2.0  (neutral = 1.0 at slider 0)
// Same math both sides keeps the live CSS preview faithful to the
// final pyvips render.
function sliderToBC(v: number): number {
  return 1.0 + v / 200; // -100 → 0.5, 0 → 1.0, +100 → 1.5
}
function sliderToSat(v: number): number {
  return 1.0 + v / 100; // -100 → 0.0, 0 → 1.0, +100 → 2.0
}

export function ModifyPanel({
  sessionId,
  resizeAssets,
  onModifyApplied,
}: ModifyPanelProps) {
  const [brightnessSlider, setBrightnessSlider] = useState(0);
  const [contrastSlider,   setContrastSlider]   = useState(0);
  const [saturationSlider, setSaturationSlider] = useState(0);

  const [isApplying, setIsApplying] = useState(false);
  const [error,      setError]      = useState<string | null>(null);

  const brightnessFactor = sliderToBC(brightnessSlider);
  const contrastFactor   = sliderToBC(contrastSlider);
  const saturationFactor = sliderToSat(saturationSlider);

  const isNeutral =
    brightnessSlider === 0 &&
    contrastSlider === 0 &&
    saturationSlider === 0;

  const cssFilter = useMemo(
    () =>
      `brightness(${brightnessFactor.toFixed(3)}) ` +
      `contrast(${contrastFactor.toFixed(3)}) ` +
      `saturate(${saturationFactor.toFixed(3)})`,
    [brightnessFactor, contrastFactor, saturationFactor],
  );

  const handleReset = () => {
    setBrightnessSlider(0);
    setContrastSlider(0);
    setSaturationSlider(0);
    setError(null);
  };

  const handleApply = async () => {
    if (resizeAssets.length === 0 || isApplying) return;
    setError(null);
    setIsApplying(true);
    try {
      const adjustments: ModifyAdjustments = {
        brightness: brightnessFactor,
        contrast:   contrastFactor,
        saturation: saturationFactor,
      };
      const { items } = await applyModifyBatch({
        sessionId,
        assetIds: resizeAssets.map((a) => a.assetId),
        adjustments,
      });
      // Stitch new asset_ids back onto the existing pipeline metadata
      // (filename + provider) so downstream Resize keeps the
      // provider-suffixed filenames + per-source identity intact.
      const next: PipelineAsset[] = items.map((it, i) => {
        const original = resizeAssets[i];
        return {
          assetId:      it.assetId,
          filename:     original?.filename ?? it.filename,
          thumbnailUrl: it.url,
          outputUrl:    it.url,
          provider:     original?.provider,
        };
      });
      onModifyApplied(next);
      // Sliders snap back to neutral so the operator's next Apply on
      // the just-modified set isn't double-applied.
      handleReset();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Modify failed");
    } finally {
      setIsApplying(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* Page heading */}
      <header className="space-y-1">
        <h1 className="text-3xl font-extrabold text-white tracking-tight">
          Modify
        </h1>
        <p className="text-base text-zinc-300">
          Optional darkroom pass — adjust brightness, contrast, and saturation
          before the final Resize step.
        </p>
      </header>

      <TipBanner
        title="How Modify works"
        steps={[
          <>This tab is optional. If your photos already look good after Scan, skip it and go straight to Resize.</>,
          <>The sliders apply the same adjustment to <span className="font-semibold text-yellow-300">every</span> queued image at once. Phase 1 is batch-only.</>,
          <>The preview thumbnails update live as you drag. Click <span className="font-semibold text-white">Apply</span> when it looks right.</>,
          <>Apply re-renders each image at full resolution on the server and replaces what&apos;s queued for Resize.</>,
        ]}
      >
        <p>
          Lighting was bad on the lot? Photos look flat? Bump brightness
          and contrast a touch. Colors looking dull on a grey-sky day? Add
          a little saturation. Don&apos;t overdo it — listings should still
          look honest.
        </p>
      </TipBanner>

      {/* Empty state */}
      {resizeAssets.length === 0 && (
        <div className="rounded-xl border border-dashed border-zinc-800 bg-zinc-950/30 px-6 py-12 text-center">
          <p className="text-base text-zinc-300 font-semibold">
            Nothing queued for modify yet.
          </p>
          <p className="text-sm text-zinc-400 mt-2">
            Send approved photos from the Scan tab — they&apos;ll show up here
            ready to adjust.
          </p>
        </div>
      )}

      {/* Preview grid */}
      {resizeAssets.length > 0 && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 overflow-hidden">
          <header className="flex items-center justify-between px-5 py-4 bg-zinc-900/40 border-b border-zinc-900">
            <span className="text-base font-bold uppercase tracking-[0.14em] text-zinc-100">
              Live preview · {resizeAssets.length} image{resizeAssets.length !== 1 ? "s" : ""}
            </span>
            <span className="text-sm text-zinc-400 italic">
              {isNeutral ? "Sliders neutral — no changes applied" : "Drag the sliders below to preview"}
            </span>
          </header>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 p-5">
            {resizeAssets.map((a) => (
              <figure
                key={a.assetId}
                className="relative aspect-4/3 rounded-lg overflow-hidden border border-zinc-800 bg-black"
              >
                {/* eslint-disable-next-line @next/next/no-img-element -- signed GCS URL, no Next/Image needed */}
                <img
                  src={a.thumbnailUrl}
                  alt={a.filename}
                  className="absolute inset-0 w-full h-full object-contain transition-[filter] duration-100"
                  style={{ filter: cssFilter }}
                />
                <div className="absolute inset-x-0 bottom-0 px-3 py-1.5 bg-linear-to-t from-black/85 to-transparent">
                  <span className="text-xs font-mono text-zinc-200 truncate block" title={a.filename}>
                    {a.filename}
                  </span>
                </div>
              </figure>
            ))}
          </div>
        </section>
      )}

      {/* Sliders */}
      {resizeAssets.length > 0 && (
        <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 p-5 space-y-5">
          <header className="flex items-center justify-between">
            <span className="text-base font-bold uppercase tracking-[0.14em] text-zinc-100">
              Adjustments
            </span>
            <button
              type="button"
              onClick={handleReset}
              disabled={isNeutral || isApplying}
              className="text-sm uppercase tracking-[0.14em] font-bold text-zinc-200 hover:text-white border border-zinc-700 hover:border-zinc-400 rounded px-3 py-1.5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              Reset sliders
            </button>
          </header>

          <SliderRow
            label="Brightness"
            value={brightnessSlider}
            onChange={setBrightnessSlider}
            factor={brightnessFactor}
            accent="amber"
            disabled={isApplying}
          />
          <SliderRow
            label="Contrast"
            value={contrastSlider}
            onChange={setContrastSlider}
            factor={contrastFactor}
            accent="sky"
            disabled={isApplying}
          />
          <SliderRow
            label="Saturation"
            value={saturationSlider}
            onChange={setSaturationSlider}
            factor={saturationFactor}
            accent="emerald"
            disabled={isApplying}
          />

          {error && (
            <p className="text-base text-red-300 bg-red-950/40 border border-red-800 rounded-lg px-4 py-3">
              {error}
            </p>
          )}

          <button
            type="button"
            onClick={handleApply}
            disabled={isNeutral || isApplying || resizeAssets.length === 0}
            className={`w-full py-3 px-6 rounded-xl font-bold text-base uppercase tracking-[0.12em] transition-all ${
              !isNeutral && !isApplying && resizeAssets.length > 0
                ? "bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-900/40"
                : "bg-zinc-800 text-zinc-500 cursor-not-allowed"
            }`}
          >
            {isApplying
              ? `Applying to ${resizeAssets.length} image${resizeAssets.length !== 1 ? "s" : ""}…`
              : isNeutral
                ? "Drag a slider to enable Apply"
                : `Apply adjustments to ${resizeAssets.length} image${resizeAssets.length !== 1 ? "s" : ""}`}
          </button>
        </section>
      )}
    </div>
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
        <span className="text-sm uppercase tracking-[0.16em] font-bold text-zinc-100">
          {label}
        </span>
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
