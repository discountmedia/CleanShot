"use client";
// apps/web/components/enhance/MetaCard.tsx
// Equipment metadata input.
//
// Header sets context for the operator: WHY these fields matter and what
// they drive downstream. Make is required; Model / Year / Tire Type /
// Capacity / Fuel Type live in the always-expanded "+ More details"
// disclosure. The meta object is owned by Workspace and also pre-fills
// the Resize tab's Save Project form.

import { useState } from "react";

import {
  EQUIPMENT_GROUPS,
  EQUIPMENT_TYPE_LABELS,
  type EquipmentType,
  type ForkliftMeta,
} from "../../lib/types";

interface MetaCardProps {
  meta: Partial<ForkliftMeta>;
  onChange: (meta: Partial<ForkliftMeta>) => void;
  expanded: boolean;
  onExpand: (v: boolean) => void;
  /**
   * When the operator is access-restricted, hide the Make field + the
   * "+ More details" metadata fields. The equipment-type selector
   * stays (it still drives anatomy guardrails). null = unrestricted.
   */
  restriction?: { customPromptOnly: boolean } | null;
}

const EXTRA_FIELDS: Array<{
  key: keyof ForkliftMeta;
  label: string;
  placeholder: string;
  hint: string;
}> = [
  { key: "model",    label: "Model",     placeholder: "e.g. 8FGU25",    hint: "Model number from the data plate." },
  { key: "year",     label: "Year",      placeholder: "e.g. 2019",      hint: "Model year. Helps buyers shortlist." },
  { key: "tireType", label: "Tire Type", placeholder: "e.g. Pneumatic", hint: "Pneumatic, cushion, or solid." },
  { key: "capacity", label: "Capacity",  placeholder: "e.g. 5000 lbs",  hint: "Rated load capacity in lbs." },
  { key: "fuelType", label: "Fuel Type", placeholder: "e.g. LPG",       hint: "LPG, diesel, electric, gasoline." },
];

export function MetaCard({ meta, onChange, expanded, onExpand, restriction = null }: MetaCardProps) {
  const update = <K extends keyof ForkliftMeta>(key: K, value: ForkliftMeta[K]) =>
    onChange({ ...meta, [key]: value });

  // Restricted (custom-prompt-only) users don't see the Make field or
  // the extra metadata — their prompt is verbatim, so make/model/etc.
  // wouldn't feed the build anyway.
  const hideMeta = restriction?.customPromptOnly ?? false;

  // Equipment-details accuracy callout is a collapsible accordion. Unlike
  // the visit-count-driven TipBanners, this one ALWAYS defaults expanded
  // (per operator request) — the accuracy warning is important enough to
  // show every load. Operator can still collapse it manually.
  const [detailsOpen, setDetailsOpen] = useState(true);

  const makeValue = (meta.make ?? "");
  const makeValid = makeValue.trim().length > 0;
  const equipmentType: EquipmentType = meta.equipmentType ?? "forklift";

  return (
    <section className="rounded-xl border border-line bg-well/60 overflow-hidden">
      {/* Explanatory header — sets context for what these fields do. */}
      <header className="px-5 py-4 border-b border-line bg-panel/30">
        <div className="flex items-start gap-3">
          <svg
            className="w-6 h-6 mt-0.5 text-ink-soft shrink-0"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div className="space-y-3 min-w-0 flex-1">
            {/* Collapsible accordion — always defaults open. */}
            <button
              type="button"
              onClick={() => setDetailsOpen((v) => !v)}
              aria-expanded={detailsOpen}
              className="w-full flex items-center justify-between gap-3 text-left"
            >
              <h3 className="font-display text-lg text-ink uppercase tracking-[0.12em]">
                Equipment details — accuracy matters
              </h3>
              <span className={`shrink-0 transition-transform ${detailsOpen ? "rotate-180" : ""}`}>
                <svg className="w-4 h-4 text-ink-soft" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                </svg>
              </span>
            </button>

            {/* Headline rule — bright red callout so nobody misses it. */}
            {detailsOpen && (
            <div className="rounded-lg border-2 border-danger-ink bg-panel px-4 py-3">
              <p className="text-base text-danger-ink leading-relaxed font-bold">
                Fill in as many of these fields as you can — but ONLY with
                information you actually know is correct.
              </p>
              <p className="text-base text-ink leading-relaxed mt-2">
                <strong className="text-ink">If you know it, enter it.</strong>{" "}
                Wrong info is worse than no info — the AI will use whatever you
                type to decide brand colours, decals, and anatomy. A typo in
                &ldquo;Make&rdquo; can mean a Toyota photo gets painted in Hyster
                yellow.
              </p>
              <p className="text-base text-ink leading-relaxed mt-2">
                <strong className="text-ink">If you don&apos;t know, leave it blank.</strong>{" "}
                That&apos;s fine — Make is the only required field. Don&apos;t
                guess.
              </p>
            </div>
            )}

          </div>
        </div>
      </header>

      <div className="px-5 py-4 space-y-5">
        {/* Equipment type — single-select toggle-cards laid out on a
            fixed-column grid so the chips line up in clean, equal-width
            columns (content-width flex-wrap read ragged). Driven from
            EQUIPMENT_GROUPS: each cluster (warehouse forks / aerial) gets
            its own labelled sub-grid sharing the same column template, so
            columns stay aligned across groups. Selected card pops with a
            blue gradient + ring + shadow; unselected cards lift on hover. */}
        <div className="flex flex-col gap-2">
          <span className="text-sm uppercase tracking-[0.16em] font-bold text-ink">
            Equipment
          </span>
          <div className="space-y-3">
            {EQUIPMENT_GROUPS.map((group) => (
              <div
                key={group.label ?? group.members.join("-")}
                role="group"
                aria-label={group.label}
              >
                {group.label && (
                  <span className="block text-[11px] uppercase tracking-[0.2em] font-semibold text-ink-faint mb-1.5">
                    {group.label}
                  </span>
                )}
                <div className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-4 gap-2">
                  {group.members.map((t) => {
                    const selected = t === equipmentType;
                    return (
                      <button
                        key={t}
                        type="button"
                        onClick={() => update("equipmentType", t)}
                        aria-pressed={selected}
                        /* Selected state is the spec's raised-surface pattern:
                           panel-hi + a lime border/dot. Lime carries "active"
                           here; the old blue gradient + blue ring is gone with
                           the rest of the blue. */
                        className={`group flex items-center gap-2.5 w-full px-3.5 py-3 rounded-lg border-2 text-left transition-all duration-150 ${
                          selected
                            ? "bg-panel-hi border-accent text-ink"
                            : "bg-panel border-line text-ink-soft hover:border-ink-faint hover:bg-panel-hi/80 hover:text-ink"
                        }`}
                      >
                        <span className={`w-4 h-4 rounded-full border-2 flex items-center justify-center shrink-0 transition-colors ${selected ? "border-accent" : "border-line group-hover:border-ink-faint"}`}>
                          {selected && <span className="w-2 h-2 rounded-full bg-accent" />}
                        </span>
                        <span className="text-sm uppercase tracking-[0.08em] font-bold leading-tight">
                          {EQUIPMENT_TYPE_LABELS[t]}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </div>

        {!hideMeta && (
        <div className="flex items-end gap-4 flex-wrap">
          <div className="flex-1 min-w-50">
            <label
              htmlFor="meta-make"
              className="flex items-center gap-1 text-sm uppercase tracking-[0.16em] font-bold text-ink mb-1.5"
            >
              Make <span className="text-danger-ink" aria-label="required">*</span>
            </label>
            <input
              id="meta-make"
              type="text"
              value={makeValue}
              onChange={(e) => update("make", e.target.value)}
              placeholder="e.g. Toyota"
              aria-required
              aria-invalid={!makeValid || undefined}
              className={`w-full bg-panel border rounded-md px-3 py-2.5 text-base text-ink placeholder:text-ink-soft focus:outline-none focus:ring-2 focus:border-transparent transition ${
                makeValid
                  ? "border-line focus:ring-danger-ink"
                  : "border-danger-ink focus:ring-danger-ink"
              }`}
            />
          </div>

          <button
            type="button"
            onClick={() => onExpand(!expanded)}
            aria-expanded={expanded}
            className="text-xs uppercase tracking-[0.16em] font-semibold text-ink hover:text-ink transition-colors px-3 py-2.5 border border-line hover:border-ink-faint rounded mb-px"
          >
            {expanded ? "− Hide details" : "+ More details"}
          </button>

          <span
            className={`text-sm ml-auto mb-2 ${makeValid ? "text-accent" : "text-danger-ink"}`}
          >
            {makeValid ? "✓ Ready to enhance" : "Enter the Make to continue"}
          </span>
        </div>
        )}
      </div>

      {!hideMeta && expanded && (
        <div className="border-t border-line px-5 py-5 grid grid-cols-2 md:grid-cols-5 gap-4">
          {EXTRA_FIELDS.map(({ key, label, placeholder, hint }) => (
            <label key={key} className="flex flex-col gap-1.5">
              <span className="text-sm uppercase tracking-[0.16em] font-bold text-ink">
                {label}
              </span>
              <input
                type="text"
                value={meta[key] ?? ""}
                onChange={(e) => update(key, e.target.value)}
                placeholder={placeholder}
                className="bg-panel border border-line rounded-md px-3 py-2.5 text-base text-ink placeholder:text-ink-soft focus:outline-none focus:ring-2 focus:ring-danger-ink focus:border-transparent transition"
              />
              <span className="text-base text-accent font-semibold leading-relaxed">
                {hint}
              </span>
            </label>
          ))}
          <p className="col-span-full text-base text-ink leading-relaxed">
            These same values pre-fill the Resize tab&apos;s{" "}
            <span className="font-mono text-accent font-bold">Save Project</span> form
            when you&apos;re ready to export — no need to re-type them there.
          </p>
        </div>
      )}
    </section>
  );
}
