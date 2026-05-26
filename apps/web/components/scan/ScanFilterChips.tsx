// apps/web/components/scan/ScanFilterChips.tsx
// Filter row above the scan card list. Lets the operator narrow the list
// to a specific verdict. Counts reflect the WHOLE batch (not the
// currently-filtered slice), so the chip tallies stay honest.

export type ScanFilter = "all" | "pass" | "mixed" | "fail" | "scanning";

interface ScanFilterChipsProps {
  counts: Record<ScanFilter, number>;
  active: ScanFilter;
  onChange: (filter: ScanFilter) => void;
}

interface ChipDef {
  id:     ScanFilter;
  label:  string;
  /** Active-state classes. Undefined for the "All" chip which uses the brand red. */
  color?: string;
}

const CHIPS: readonly ChipDef[] = [
  { id: "all",      label: "All" },
  { id: "pass",     label: "Pass",     color: "text-green-300 border-green-600 bg-green-950/40" },
  { id: "mixed",    label: "Mixed",    color: "text-yellow-300 border-yellow-600 bg-yellow-950/40" },
  { id: "fail",     label: "Fail",     color: "text-red-300 border-red-600 bg-red-950/40" },
  { id: "scanning", label: "Scanning", color: "text-blue-300 border-blue-600 bg-blue-950/40" },
] as const;

export function ScanFilterChips({ counts, active, onChange }: ScanFilterChipsProps) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {CHIPS.map((c) => {
        const isActive = active === c.id;
        const n = counts[c.id] ?? 0;
        const disabled = n === 0 && c.id !== "all";
        const inactiveClass = c.color
          ? "text-zinc-300 border-zinc-700 bg-transparent hover:border-zinc-500 hover:text-zinc-100"
          : "text-zinc-100 border-zinc-600 bg-zinc-900 hover:border-zinc-400";
        const activeClass = c.color ?? "border-red-500 bg-red-950/40 text-red-200";
        return (
          <button
            key={c.id}
            type="button"
            onClick={() => onChange(c.id)}
            disabled={disabled}
            aria-pressed={isActive}
            className={`flex items-center gap-2 px-4 py-2 rounded-md border-2 text-sm font-bold uppercase tracking-[0.14em] transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${
              isActive ? activeClass : inactiveClass
            }`}
          >
            <span>{c.label}</span>
            <span className="tabular-nums opacity-90">{n}</span>
          </button>
        );
      })}
    </div>
  );
}
