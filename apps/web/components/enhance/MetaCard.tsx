// apps/web/components/enhance/MetaCard.tsx
// Equipment metadata input.
//
// Header sets context for the operator: WHY these fields matter and what
// they drive downstream. Make is required; Model / Year / Tire Type /
// Capacity / Fuel Type live in the always-expanded "+ More details"
// disclosure. The meta object is owned by Workspace and also pre-fills
// the Resize tab's Save Project form.

import {
  EQUIPMENT_TYPES,
  EQUIPMENT_TYPE_LABELS,
  type EquipmentType,
  type ForkliftMeta,
} from "../../lib/types";

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
  hint: string;
}> = [
  { key: "model",    label: "Model",     placeholder: "e.g. 8FGU25",    hint: "Model number from the data plate." },
  { key: "year",     label: "Year",      placeholder: "e.g. 2019",      hint: "Model year. Helps buyers shortlist." },
  { key: "tireType", label: "Tire Type", placeholder: "e.g. Pneumatic", hint: "Pneumatic, cushion, or solid." },
  { key: "capacity", label: "Capacity",  placeholder: "e.g. 5000 lbs",  hint: "Rated load capacity in lbs." },
  { key: "fuelType", label: "Fuel Type", placeholder: "e.g. LPG",       hint: "LPG, diesel, electric, gasoline." },
];

export function MetaCard({ meta, onChange, expanded, onExpand }: MetaCardProps) {
  const update = <K extends keyof ForkliftMeta>(key: K, value: ForkliftMeta[K]) =>
    onChange({ ...meta, [key]: value });

  const makeValue = (meta.make ?? "");
  const makeValid = makeValue.trim().length > 0;
  const equipmentType: EquipmentType = meta.equipmentType ?? "forklift";

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 overflow-hidden">
      {/* Explanatory header — sets context for what these fields do. */}
      <header className="px-5 py-4 border-b border-zinc-900 bg-zinc-900/30">
        <div className="flex items-start gap-3">
          <svg
            className="w-6 h-6 mt-0.5 text-blue-300 shrink-0"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
            aria-hidden="true"
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          <div className="space-y-3 min-w-0">
            <h3 className="text-lg font-bold text-white uppercase tracking-[0.12em]">
              Equipment details — accuracy matters
            </h3>

            {/* Headline rule — bright red callout so nobody misses it. */}
            <div className="rounded-lg border-2 border-red-600 bg-red-950/40 px-4 py-3">
              <p className="text-base text-red-100 leading-relaxed font-bold">
                Fill in as many of these fields as you can — but ONLY with
                information you actually know is correct.
              </p>
              <p className="text-base text-red-50 leading-relaxed mt-2">
                <strong className="text-white">If you know it, enter it.</strong>{" "}
                Wrong info is worse than no info — the AI will use whatever you
                type to decide brand colours, decals, and anatomy. A typo in
                &ldquo;Make&rdquo; can mean a Toyota photo gets painted in Hyster
                yellow.
              </p>
              <p className="text-base text-red-50 leading-relaxed mt-2">
                <strong className="text-white">If you don&apos;t know, leave it blank.</strong>{" "}
                That&apos;s fine — Make is the only required field. Don&apos;t
                guess.
              </p>
            </div>

            <p className="text-base text-zinc-200 leading-relaxed">
              When you do fill these in correctly, here&apos;s what they drive:
            </p>
            <ul className="space-y-2 text-base text-zinc-100 leading-relaxed list-disc pl-5">
              <li>
                <span className="text-white font-bold">Filenames.</span>{" "}
                Each uploaded photo is renamed to{" "}
                <span className="font-mono text-yellow-300 font-bold">
                  Make_Model_Year_NN.jpg
                </span>{" "}
                so downstream tools can sort them.
              </li>
              <li>
                <span className="text-white font-bold">Prompt tuning.</span>{" "}
                The AI models use the equipment type and make to apply the
                right brand colour, anatomy preservation, and OEM-decal
                rules to each photo.
              </li>
              <li>
                <span className="text-white font-bold">Resize Save Project.</span>{" "}
                The same values pre-fill the Resize tab&apos;s Save Project
                form — no double entry, no typos between tabs.
              </li>
            </ul>
          </div>
        </div>
      </header>

      <div className="px-5 py-4 flex items-end gap-4 flex-wrap">
        {/* Equipment type — sits before Make so the operator sees they
            can swap categories. Compact chip row to match the Enhance
            tab's ProviderRow vocabulary. */}
        <div className="flex flex-col gap-1.5">
          <span className="text-sm uppercase tracking-[0.16em] font-bold text-zinc-100">
            Equipment
          </span>
          <div className="inline-flex rounded-md border border-zinc-700 overflow-hidden">
            {EQUIPMENT_TYPES.map((t, i) => {
              const selected = t === equipmentType;
              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => update("equipmentType", t)}
                  aria-pressed={selected}
                  className={`text-sm uppercase tracking-[0.14em] font-semibold px-4 py-2.5 transition-colors ${
                    selected
                      ? "bg-red-950/40 text-red-300"
                      : "bg-zinc-900 text-zinc-300 hover:text-white"
                  } ${i > 0 ? "border-l border-zinc-700" : ""}`}
                >
                  {EQUIPMENT_TYPE_LABELS[t]}
                </button>
              );
            })}
          </div>
        </div>

        <div className="flex-1 min-w-50">
          <label
            htmlFor="meta-make"
            className="flex items-center gap-1 text-sm uppercase tracking-[0.16em] font-bold text-zinc-100 mb-1.5"
          >
            Make <span className="text-red-400" aria-label="required">*</span>
          </label>
          <input
            id="meta-make"
            type="text"
            value={makeValue}
            onChange={(e) => update("make", e.target.value)}
            placeholder="e.g. Toyota"
            aria-required
            aria-invalid={!makeValid || undefined}
            className={`w-full bg-zinc-900 border rounded-md px-3 py-2.5 text-base text-white placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:border-transparent transition ${
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
          className="text-xs uppercase tracking-[0.16em] font-semibold text-zinc-200 hover:text-white transition-colors px-3 py-2.5 border border-zinc-700 hover:border-zinc-500 rounded mb-px"
        >
          {expanded ? "− Hide details" : "+ More details"}
        </button>

        <span
          className={`text-sm ml-auto mb-2 ${makeValid ? "text-green-400" : "text-amber-300"}`}
        >
          {makeValid ? "✓ Ready to enhance" : "Enter the Make to continue"}
        </span>
      </div>

      {expanded && (
        <div className="border-t border-zinc-900 px-5 py-5 grid grid-cols-2 md:grid-cols-5 gap-4">
          {EXTRA_FIELDS.map(({ key, label, placeholder, hint }) => (
            <label key={key} className="flex flex-col gap-1.5">
              <span className="text-sm uppercase tracking-[0.16em] font-bold text-zinc-100">
                {label}
              </span>
              <input
                type="text"
                value={meta[key] ?? ""}
                onChange={(e) => update(key, e.target.value)}
                placeholder={placeholder}
                className="bg-zinc-900 border border-zinc-700 rounded-md px-3 py-2.5 text-base text-white placeholder:text-zinc-400 focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-transparent transition"
              />
              <span className="text-base text-yellow-200 font-semibold leading-relaxed">
                {hint}
              </span>
            </label>
          ))}
          <p className="col-span-full text-base text-zinc-100 leading-relaxed">
            These same values pre-fill the Resize tab&apos;s{" "}
            <span className="font-mono text-yellow-300 font-bold">Save Project</span> form
            when you&apos;re ready to export — no need to re-type them there.
          </p>
        </div>
      )}
    </section>
  );
}
