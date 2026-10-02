"use client";
// apps/web/components/ui/SelectField.tsx
//
// One dropdown look for every fixed-choice field (tire, fuel, year, equipment
// type), so the Enhance details card and the export form can't drift apart.
//
// A native <select>, deliberately: it is keyboard- and screen-reader-correct
// for free and opens the platform's own picker on a tablet. The styling is
// ours (field surface, chevron, focus ring); the list itself is the browser's.
// `color-scheme: dark` is what makes that list open dark -- the app sets no
// color-scheme anywhere, so without it Windows draws a white list.
//
// ⚠️ A STORED VALUE THAT IS NOT AN OPTION IS NEVER CLEARED. Values typed before
// these fields were dropdowns, or carried in by an import, may say something
// the list does not ("Non-marking"). `canonical` maps the ones that plainly
// mean an option; anything left over is shown as its own entry, marked, so the
// operator sees it and decides. Silently blanking it would lose real data.

import type { FieldOption } from "../../lib/equipment-fields";

export interface OptionGroup {
  label: string;
  options: readonly FieldOption[];
}

interface SelectFieldProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  /** Flat options, or groups rendered as <optgroup>. */
  options: readonly FieldOption[] | readonly OptionGroup[];
  /** Label for the empty choice. Omit to offer no empty choice. */
  emptyLabel?: string;
  /** Maps a stored value to the option it means; null when it means none. */
  canonical?: (raw: string) => string | null;
  /** Suffix for a stored value that matches no option. */
  unlistedNote?: string;
  /** Tailwind focus ring class, so each form keeps its own accent. */
  ringClass?: string;
  disabled?: boolean;
  "aria-describedby"?: string;
}

const isGrouped = (o: SelectFieldProps["options"]): o is readonly OptionGroup[] =>
  o.length > 0 && "options" in o[0];

export function SelectField({
  id, value, onChange, options, emptyLabel, canonical,
  unlistedNote = "not in the list", ringClass = "focus:ring-attn", disabled,
  "aria-describedby": describedBy,
}: SelectFieldProps) {
  const flat = isGrouped(options) ? options.flatMap((g) => g.options) : options;
  /* "unknown" is what the export save writes for a blank field, so it means
     empty here too, never an unlisted value. */
  const trimmed = (value ?? "").trim();
  const raw = trimmed.toLowerCase() === "unknown" ? "" : trimmed;
  const listed = (v: string) => flat.some((o) => o.value === v);
  const shown = raw === "" ? "" : listed(raw) ? raw : (canonical?.(raw) ?? raw);
  const unlisted = shown !== "" && !listed(shown);

  const optionClass = "bg-panel text-ink";

  return (
    <div className="relative">
      <select
        id={id}
        value={shown}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled}
        aria-describedby={describedBy}
        className={`w-full appearance-none [color-scheme:dark] bg-panel border border-line rounded-lg pl-3 pr-10 py-2.5 text-base ${shown === "" ? "text-muted" : "text-ink"} cursor-pointer hover:border-ink-faint focus:outline-none focus:ring-2 ${ringClass} focus:border-transparent transition disabled:opacity-50 disabled:cursor-not-allowed`}
      >
        {emptyLabel !== undefined && (
          <option value="" className={optionClass}>{emptyLabel}</option>
        )}
        {unlisted && (
          <option value={shown} className={optionClass}>{`${shown} (${unlistedNote})`}</option>
        )}
        {isGrouped(options)
          ? options.map((g) => (
              <optgroup key={g.label} label={g.label} className={optionClass}>
                {g.options.map((o) => (
                  <option key={o.value} value={o.value} className={optionClass}>{o.label}</option>
                ))}
              </optgroup>
            ))
          : options.map((o) => (
              <option key={o.value} value={o.value} className={optionClass}>{o.label}</option>
            ))}
      </select>
      <svg
        className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-soft"
        fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true"
      >
        <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
      </svg>
    </div>
  );
}
