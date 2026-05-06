"use client";

import { useState } from "react";
import { useStore } from "@/lib/store";
import { enqueueEnhance } from "@/lib/api";
import type {
  EnhanceBrandToggles,
  EnhanceIntensity,
  EnhanceResolution,
} from "@/lib/types";
import { cx } from "@/lib/utils";

const INTENSITIES: { value: EnhanceIntensity; label: string; hint: string }[] = [
  { value: "light",    label: "Light",    hint: "Surface dust + dirt only" },
  { value: "moderate", label: "Moderate", hint: "Dealer-lot condition (default)" },
  { value: "heavy",    label: "Heavy",    hint: "Showroom — keeps realism" },
];

const DEFAULT_BRAND: EnhanceBrandToggles = {
  apply_fork_paint:   true,
  apply_tire_shine:   true,
  apply_rust_removal: true,
};

export function EnhanceForm() {
  const session_id = useStore((s) => s.session_id);
  const activeId   = useStore((s) => s.active.enhance);
  const setJob     = useStore((s) => s.setJob);

  const [intensity,   setIntensity]   = useState<EnhanceIntensity>("moderate");
  const [brand,       setBrand]       = useState<EnhanceBrandToggles>(DEFAULT_BRAND);
  const [resolution,  setResolution]  = useState<EnhanceResolution>("1K");
  const [extra,       setExtra]       = useState("");
  const [submitting,  setSubmitting]  = useState(false);
  const [error,       setError]       = useState<string | null>(null);

  const ready = !!session_id && !!activeId && !submitting;

  async function onSubmit() {
    if (!session_id || !activeId) return;
    setSubmitting(true);
    setError(null);
    try {
      const { job_id } = await enqueueEnhance({
        session_id,
        asset_id: activeId,
        intensity,
        brand,
        resolution,
        extra_instructions: extra.trim() || undefined,
      });
      setJob("enhance", job_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "enhance_failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <section className="space-y-6 rounded border border-line bg-surface-card p-5">
      <header className="flex items-center justify-between border-b border-line-subtle pb-3">
        <h2 className="text-[11px] font-semibold uppercase tracking-label-loose text-ink-muted">
          Enhance Settings
        </h2>
        <button
          type="button"
          className="text-[11px] uppercase tracking-label text-ink-dim hover:text-ink"
          onClick={() => {
            setIntensity("moderate");
            setBrand(DEFAULT_BRAND);
            setResolution("1K");
            setExtra("");
          }}
        >
          Reset
        </button>
      </header>

      {/* Intensity */}
      <fieldset>
        <legend className="text-[11px] font-semibold uppercase tracking-label text-ink-muted">
          Intensity
        </legend>
        <div className="mt-2 grid grid-cols-3 gap-2">
          {INTENSITIES.map((opt) => (
            <button
              key={opt.value}
              type="button"
              onClick={() => setIntensity(opt.value)}
              className={cx(
                "rounded border px-3 py-2 text-left transition-colors",
                intensity === opt.value
                  ? "border-df-red bg-df-red-tint"
                  : "border-line bg-surface-raised hover:border-line-bright",
              )}
            >
              <div className={cx(
                "text-xs font-semibold uppercase tracking-label",
                intensity === opt.value ? "text-df-red" : "text-ink",
              )}>
                {opt.label}
              </div>
              <div className="mt-0.5 text-[10px] uppercase tracking-label text-ink-dim">
                {opt.hint}
              </div>
            </button>
          ))}
        </div>
      </fieldset>

      {/* Brand toggles */}
      <fieldset>
        <legend className="text-[11px] font-semibold uppercase tracking-label text-ink-muted">
          Brand Rules
        </legend>
        <p className="mt-1 text-[10px] uppercase tracking-label text-ink-dim">
          Discount Forklift house style — disable per photo if output looks off
        </p>
        <div className="mt-2 space-y-2">
          <ToggleRow
            label="Red forks · yellow tips"
            value={brand.apply_fork_paint}
            onChange={(v) => setBrand({ ...brand, apply_fork_paint: v })}
          />
          <ToggleRow
            label="Shiny tires (skipped on cushion)"
            value={brand.apply_tire_shine}
            onChange={(v) => setBrand({ ...brand, apply_tire_shine: v })}
          />
          <ToggleRow
            label="Rust + corrosion removal"
            value={brand.apply_rust_removal}
            onChange={(v) => setBrand({ ...brand, apply_rust_removal: v })}
          />
        </div>
      </fieldset>

      {/* Resolution */}
      <fieldset>
        <legend className="text-[11px] font-semibold uppercase tracking-label text-ink-muted">
          Resolution
        </legend>
        <p className="mt-1 text-[10px] uppercase tracking-label text-ink-dim">
          1K marketplace default · 2K hero shots
        </p>
        <div className="mt-2 inline-flex rounded border border-line bg-surface-raised p-0.5">
          {(["1K", "2K"] as const).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setResolution(r)}
              className={cx(
                "rounded px-4 py-1 text-xs font-semibold uppercase tracking-label transition-colors",
                resolution === r
                  ? "bg-df-red text-white"
                  : "text-ink-muted hover:text-ink",
              )}
            >
              {r}
            </button>
          ))}
        </div>
      </fieldset>

      {/* Extra instructions */}
      <fieldset>
        <label
          htmlFor="extra-instructions"
          className="text-[11px] font-semibold uppercase tracking-label text-ink-muted"
        >
          Extra Instructions
          <span className="ml-2 font-normal normal-case tracking-normal text-ink-dim">
            (optional)
          </span>
        </label>
        <textarea
          id="extra-instructions"
          rows={3}
          value={extra}
          onChange={(e) => setExtra(e.target.value)}
          placeholder="emphasize the data plate, keep the warehouse background dim…"
          className="mt-2 block w-full resize-y rounded border border-line bg-surface-raised px-3 py-2 text-sm text-ink placeholder:text-ink-faint focus:border-df-red focus:outline-none"
        />
      </fieldset>

      {error && (
        <div className="rounded border border-status-fail/40 bg-df-red-tint px-3 py-2 text-xs uppercase tracking-label text-status-fail">
          {error}
        </div>
      )}

      <div className="flex items-center justify-end pt-2">
        <button
          type="button"
          disabled={!ready}
          onClick={onSubmit}
          className={cx(
            "rounded px-5 py-2.5 text-xs font-semibold uppercase tracking-label-loose transition-colors",
            ready
              ? "bg-df-red text-white hover:bg-df-red-700"
              : "cursor-not-allowed bg-surface-hover text-ink-faint",
          )}
        >
          {submitting ? "Submitting…" : "Enhance Photo"}
        </button>
      </div>
    </section>
  );
}

function ToggleRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-center justify-between rounded border border-line-subtle bg-surface-raised px-3 py-2.5 hover:border-line">
      <span className="text-xs uppercase tracking-label text-ink">{label}</span>
      <span className="relative inline-flex h-5 w-9 shrink-0 items-center">
        <input
          type="checkbox"
          checked={value}
          onChange={(e) => onChange(e.target.checked)}
          className="peer sr-only"
        />
        <span className="absolute inset-0 rounded-full bg-line transition-colors peer-checked:bg-df-red" />
        <span className="absolute left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform peer-checked:translate-x-4" />
      </span>
    </label>
  );
}
