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
  { id: "pass",     label: "Pass",     color: "text-green-400 border-green-800 bg-green-950/30" },
  { id: "mixed",    label: "Mixed",    color: "text-yellow-400 border-yellow-800 bg-yellow-950/30" },
  { id: "fail",     label: "Fail",     color: "text-red-400 border-red-800 bg-red-950/30" },
  { id: "scanning", label: "Scanning", color: "text-blue-400 border-blue-800 bg-blue-950/30" },
] as const;

export function ScanFilterChips({ counts, active, onChange }: ScanFilterChipsProps) {
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {CHIPS.map((c) => {
        const isActive = active === c.id;
        const n = counts[c.id] ?? 0;
        const disabled = n === 0 && c.id !== "all";
        const inactiveClass = c.color
          ? "text-zinc-500 border-zinc-800 bg-transparent hover:border-zinc-700"
          : "text-zinc-300 border-zinc-700 bg-zinc-900 hover:border-zinc-600";
        const activeClass = c.color ?? "border-red-500 bg-red-950/40 text-red-300";
        return (
          <button
            key={c.id}
            type="button"
            onClick={() => onChange(c.id)}
            disabled={disabled}
            aria-pressed={isActive}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-md border text-[11px] font-semibold uppercase tracking-[0.16em] transition-colors disabled:opacity-30 disabled:cursor-not-allowed ${
              isActive ? activeClass : inactiveClass
            }`}
          >
            <span>{c.label}</span>
            <span className="tabular-nums opacity-70">{n}</span>
          </button>
        );
      })}
    </div>
  );
}
