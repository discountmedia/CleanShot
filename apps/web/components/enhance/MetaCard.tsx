// apps/web/components/enhance/MetaCard.tsx
// Forklift metadata input — Phase 3 redesign.
//
// Only `Make` is shown up front (required, drives filename + Resize Save
// Project form). Model / Year / Tire Type / Capacity / Fuel Type live
// behind a "+ More details" disclosure. Same `meta` shape as before,
// owned by `Workspace` (lifted source of truth that also pre-fills the
// Resize tab's Save Project form).

import type { ForkliftMeta } from "../../lib/types";

interface MetaCardProps {
  meta: Partial<ForkliftMeta>;
  onChange: (meta: Partial<ForkliftMeta>) => void;
  expanded: boolean;
  onExpand: (v: boolean) => void;
}

const EXTRA_FIELDS: Array<{
  key: keyof ForkliftMeta;
  label: string;
  placeholder: string;
}> = [
  { key: "model",    label: "Model",     placeholder: "e.g. 8FGU25" },
  { key: "year",     label: "Year",      placeholder: "e.g. 2019" },
  { key: "tireType", label: "Tire Type", placeholder: "e.g. Pneumatic" },
  { key: "capacity", label: "Capacity",  placeholder: "e.g. 5000 lbs" },
  { key: "fuelType", label: "Fuel Type", placeholder: "e.g. LPG" },
];

export function MetaCard({ meta, onChange, expanded, onExpand }: MetaCardProps) {
  const update = <K extends keyof ForkliftMeta>(key: K, value: ForkliftMeta[K]) =>
    onChange({ ...meta, [key]: value });

  const makeValue = (meta.make ?? "");
  const makeValid = makeValue.trim().length > 0;

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 overflow-hidden">
      <div className="px-5 py-4 flex items-end gap-4 flex-wrap">
        <div className="flex-1 min-w-[200px]">
          <label
            htmlFor="meta-make"
            className="flex items-center gap-1 text-[10px] uppercase tracking-[0.18em] font-semibold text-zinc-500 mb-1.5"
          >
            Make <span className="text-red-500" aria-label="required">*</span>
          </label>
          <input
            id="meta-make"
            type="text"
            value={makeValue}
            onChange={(e) => update("make", e.target.value)}
            placeholder="e.g. Toyota"
            aria-required
            aria-invalid={!makeValid || undefined}
            className={`w-full bg-zinc-900 border rounded-md px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:ring-2 focus:border-transparent transition ${
              makeValid
                ? "border-zinc-700 focus:ring-red-500"
                : "border-red-900 focus:ring-red-500"
            }`}
          />
        </div>

        <button
          type="button"
          onClick={() => onExpand(!expanded)}
          aria-expanded={expanded}
          className="text-[10px] uppercase tracking-[0.18em] font-semibold text-zinc-400 hover:text-white transition-colors px-3 py-2 border border-zinc-800 hover:border-zinc-600 rounded mb-[1px]"
        >
          {expanded ? "− Hide details" : "+ More details"}
        </button>

        <span className="text-xs text-zinc-500 ml-auto mb-2">
          {makeValid ? "✓ ready to enhance" : "Enter the forklift Make to continue"}
        </span>
      </div>

      {expanded && (
        <div className="border-t border-zinc-900 px-5 py-4 grid grid-cols-2 md:grid-cols-5 gap-3">
          {EXTRA_FIELDS.map(({ key, label, placeholder }) => (
            <label key={key} className="flex flex-col gap-1.5">
              <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-zinc-500">
                {label}
              </span>
              <input
                type="text"
                value={meta[key] ?? ""}
                onChange={(e) => update(key, e.target.value)}
                placeholder={placeholder}
                className="bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2 text-sm text-white placeholder-zinc-600 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent transition"
              />
            </label>
          ))}
          <p className="col-span-full text-[11px] text-zinc-600 leading-snug">
            These also feed the Resize tab&apos;s{" "}
            <span className="font-mono">Save Project</span> form — no need to re-enter.
          </p>
        </div>
      )}
    </section>
  );
}
