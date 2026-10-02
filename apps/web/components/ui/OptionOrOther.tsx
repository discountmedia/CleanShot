"use client";
// apps/web/components/ui/OptionOrOther.tsx
//
// A dropdown of known names with "Other" at the top (Stephen, 2 Oct 2026).
// Choosing Other opens a text box for a name the list does not have yet; the
// name joins everyone's list when the project is saved.
//
// Other mode is DERIVED as well as chosen. A value that is not in the list (a
// new make typed earlier, or one carried in before the list had loaded) shows
// in the text box rather than vanishing; once the list arrives and the value
// is in it, the dropdown shows it selected instead.

import { useState } from "react";

import { isListed, nameKey } from "../../lib/known-models";

const OTHER = "__other__";

interface OptionOrOtherProps {
  id: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly string[];
  /** The empty choice, e.g. "Choose a make". */
  emptyLabel: string;
  /** Accessible name of the Other text box, e.g. "New make". The choice
      itself is labelled "Other…": anything longer was cut off in the narrow
      Model column of the Enhance card. */
  newLabel: string;
  /** Placeholder for the Other text box. */
  placeholder: string;
  ringClass?: string;
  invalid?: boolean;
  required?: boolean;
}

export function OptionOrOther({
  id, value, onChange, options, emptyLabel, newLabel, placeholder,
  ringClass = "focus:ring-attn", invalid = false, required = false,
}: OptionOrOtherProps) {
  const [choseOther, setChoseOther] = useState(false);
  const typed = (value ?? "").trim() !== "";
  const listed = isListed(options, value);
  const otherMode = choseOther || (typed && !listed);
  const selected = otherMode ? OTHER : listed ? options.find((o) => nameKey(o) === nameKey(value)) ?? "" : "";

  const border = invalid ? "border-attn" : "border-line";
  const optionClass = "bg-panel text-ink";

  return (
    <div className="flex flex-col gap-2">
      <div className="relative">
        <select
          id={id}
          value={selected}
          aria-required={required || undefined}
          aria-invalid={invalid || undefined}
          onChange={(e) => {
            const v = e.target.value;
            if (v === OTHER) { setChoseOther(true); onChange(listed ? "" : value); return; }
            setChoseOther(false);
            onChange(v);
          }}
          className={`w-full appearance-none [color-scheme:dark] bg-panel border ${border} rounded-lg pl-3 pr-10 py-2.5 text-base ${selected === "" ? "text-muted" : "text-ink"} cursor-pointer hover:border-ink-faint focus:outline-none focus:ring-2 ${ringClass} focus:border-transparent transition`}
        >
          <option value="" className={optionClass}>{emptyLabel}</option>
          <option value={OTHER} className={optionClass}>Other…</option>
          {options.map((o) => (
            <option key={nameKey(o)} value={o} className={optionClass}>{o}</option>
          ))}
        </select>
        <svg
          className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 w-4 h-4 text-ink-soft"
          fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5} aria-hidden="true"
        >
          <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
        </svg>
      </div>
      {otherMode && (
        <input
          id={`${id}-other`}
          type="text"
          value={value}
          autoFocus={choseOther}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          aria-label={newLabel}
          aria-invalid={invalid || undefined}
          className={`w-full bg-panel border ${border} rounded-lg px-3 py-2.5 text-base text-ink placeholder:text-muted focus:outline-none focus:ring-2 ${ringClass} focus:border-transparent transition`}
        />
      )}
    </div>
  );
}
