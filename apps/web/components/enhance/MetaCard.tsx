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

import { InfoTip } from "../ui/InfoTip";
import { SelectField } from "../ui/SelectField";

import {
  canonicalFuel,
  canonicalTire,
  canonicalYear,
  FUEL_OPTIONS,
  TIRE_OPTIONS,
  yearOptions,
  type FieldOption,
} from "../../lib/equipment-fields";
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

/* Year, Tire Type and Fuel Type are dropdowns (2026-10-02); Model and
   Capacity stay free text because their values are open-ended. The choices
   live in lib/equipment-fields.ts so the export form offers the same ones. */
type ExtraField = {
  key: "model" | "year" | "tireType" | "capacity" | "fuelType" | "color";
  label: string;
  hint: string;
} & (
  | { kind: "text"; placeholder: string }
  | { kind: "select"; options: readonly FieldOption[]; emptyLabel: string;
      canonical: (raw: string) => string | null }
);

const EXTRA_FIELDS: ExtraField[] = [
  { key: "model",    label: "Model",     kind: "text", placeholder: "e.g. 8FGU25",
    hint: "Model number from the data plate." },
  { key: "year",     label: "Year",      kind: "select", options: yearOptions(), emptyLabel: "Unknown",
    canonical: (v) => canonicalYear(v), hint: "Model year. Leave it on Unknown if you're not sure." },
  { key: "tireType", label: "Tire Type", kind: "select", options: TIRE_OPTIONS, emptyLabel: "Not set",
    canonical: canonicalTire, hint: "Pneumatic (outdoor) or cushion (indoor)." },
  { key: "capacity", label: "Capacity",  kind: "text", placeholder: "e.g. 5000 lbs",
    hint: "Rated load capacity in lbs." },
  { key: "fuelType", label: "Fuel Type", kind: "select", options: FUEL_OPTIONS, emptyLabel: "Not set",
    canonical: canonicalFuel, hint: "The letter in brackets goes in the export file name." },
  /* Typed, not a dropdown: paint names are open-ended (Luminous Yellow, RAL
     1016). Optional; it ends the export name when given. */
  { key: "color",    label: "Color",     kind: "text", placeholder: "e.g. Luminous Yellow",
    hint: "Optional. Goes at the end of the export file name." },
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
            <div className="rounded-lg border-2 border-attn bg-panel px-4 py-3">
              <p className="text-base text-attn leading-relaxed font-bold">
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
        {/* Equipment type — a grouped dropdown (2026-10-02, operator request;
            it was a grid of ten radio cards). Same EQUIPMENT_GROUPS, now as
            <optgroup>s, so the Forklifts / Aerial split survives. The (i) tip
            says what the choice actually changes, because "equipment type"
            reads as a label and is not one: it rewrites the anatomy rule in
            the safety block, the recommended prompt, and which fork controls
            exist. Every claim in the tip is checked against
            enhance_worker.EQUIPMENT_ANATOMY, lib/recommended-prompt.ts and
            EnhancePanel's showForkControls gate -- keep them in step. */}
        <div className="flex flex-col gap-1.5 max-w-md">
          <div className="flex items-center gap-2">
            <label
              htmlFor="meta-equipment-type"
              className="text-sm uppercase tracking-[0.16em] font-bold text-ink"
            >
              Equipment type
            </label>
            <InfoTip label="What the equipment type changes" title="What the equipment type changes">
              <span className="block">
                It tells the AI what kind of machine is in the photo, so the
                rules sent with every image protect the right parts: a
                forklift&apos;s mast, forks, overhead guard and counterweight;
                a scissor lift&apos;s platform, guard rails and scissor stack;
                a telehandler&apos;s boom, attachment and outriggers.
              </span>
              <span className="block">
                The recommended prompt is written for the type you pick.
              </span>
              <span className="block">
                Scissor Lift has a platform instead of forks, so fork options
                don&apos;t apply to it.
              </span>
              <span className="block text-ink">
                Pick the closest match before you press Enhance.
              </span>
            </InfoTip>
          </div>
          <SelectField
            id="meta-equipment-type"
            value={equipmentType}
            onChange={(v) => update("equipmentType", v as EquipmentType)}
            options={EQUIPMENT_GROUPS.map((g) => ({
              label: g.label ?? "Other",
              options: g.members.map((t) => ({ value: t, label: EQUIPMENT_TYPE_LABELS[t] })),
            }))}
          />
        </div>

        {!hideMeta && (
        <div className="flex items-end gap-4 flex-wrap">
          <div className="flex-1 min-w-50">
            <label
              htmlFor="meta-make"
              className="flex items-center gap-1 text-sm uppercase tracking-[0.16em] font-bold text-ink mb-1.5"
            >
              Make <span className="text-attn" aria-label="required">*</span>
            </label>
            <input
              id="meta-make"
              type="text"
              value={makeValue}
              onChange={(e) => update("make", e.target.value)}
              placeholder="e.g. Toyota"
              aria-required
              aria-invalid={!makeValid || undefined}
              className={`w-full bg-panel border rounded-md px-3 py-2.5 text-base text-ink placeholder:text-muted focus:outline-none focus:ring-2 focus:border-transparent transition ${
                makeValid
                  ? "border-line focus:ring-attn"
                  : "border-attn focus:ring-attn"
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
            className={`text-sm ml-auto mb-2 ${makeValid ? "text-accent" : "text-attn"}`}
          >
            {makeValid ? "✓ Ready to enhance" : "Enter the Make to continue"}
          </span>
        </div>
        )}
      </div>

      {!hideMeta && expanded && (
        <div className="border-t border-line px-5 py-5 grid grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-4">
          {EXTRA_FIELDS.map((f) => (
            <div key={f.key} className="flex flex-col gap-1.5">
              <label
                htmlFor={`meta-${f.key}`}
                className="text-sm uppercase tracking-[0.16em] font-bold text-ink"
              >
                {f.label}
              </label>
              {f.kind === "select" ? (
                <SelectField
                  id={`meta-${f.key}`}
                  value={meta[f.key] ?? ""}
                  onChange={(v) => update(f.key, v)}
                  options={f.options}
                  emptyLabel={f.emptyLabel}
                  canonical={f.canonical}
                />
              ) : (
                <input
                  id={`meta-${f.key}`}
                  type="text"
                  value={meta[f.key] ?? ""}
                  onChange={(e) => update(f.key, e.target.value)}
                  placeholder={f.placeholder}
                  className="bg-panel border border-line rounded-lg px-3 py-2.5 text-base text-ink placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-attn focus:border-transparent transition"
                />
              )}
              <span className="text-base text-accent font-semibold leading-relaxed">
                {f.hint}
              </span>
            </div>
          ))}
          {/* Was "pre-fill the Resize tab's Save Project form" -- that tab and
              that button are both gone; the export form is on this page. */}
          <p className="col-span-full text-base text-ink leading-relaxed">
            These same values fill in the export details at the bottom of the
            page, so there&apos;s no need to type them twice.
          </p>
        </div>
      )}
    </section>
  );
}
