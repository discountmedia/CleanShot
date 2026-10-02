"use client";
// apps/web/components/ui/CheckField.tsx
//
// One optional yes/no field (Dual Drive, Cab), shared by the Enhance details
// card and the export form so the two look and behave the same.
//
// A real <input type="checkbox"> inside its label, so the whole tile is the
// click target and keyboard / screen-reader behaviour is the browser's. The
// tile follows STYLE_GUIDE's selected pattern: raised surface + lime border
// when ticked, plain panel when not.

interface CheckFieldProps {
  id: string;
  label: string;
  hint?: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}

export function CheckField({ id, label, hint, checked, onChange }: CheckFieldProps) {
  return (
    <label
      htmlFor={id}
      className={`flex items-start gap-3 rounded-lg border-2 px-4 py-3 cursor-pointer select-none transition-colors ${
        checked
          ? "border-accent bg-panel-hi"
          : "border-line bg-panel hover:border-ink-faint"
      }`}
    >
      <input
        id={id}
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-0.5 w-5 h-5 accent-accent shrink-0 cursor-pointer"
      />
      <span className="min-w-0">
        <span className="block text-sm uppercase tracking-[0.16em] font-bold text-ink">
          {label}
        </span>
        {hint && (
          <span className="block text-base text-accent font-semibold leading-relaxed mt-1">
            {hint}
          </span>
        )}
      </span>
    </label>
  );
}
