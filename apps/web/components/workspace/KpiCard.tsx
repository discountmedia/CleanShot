// apps/web/components/workspace/KpiCard.tsx
// One stat tile — small uppercase label, huge colored number, optional secondary label.
// Mirrors the metric-card pattern from the company's inventory/ledger dashboards.

export type KpiColor =
  | "white"
  | "red"
  | "green"
  | "yellow"
  | "orange"
  | "blue"
  | "purple"
  | "muted";

const VALUE_COLORS: Record<KpiColor, string> = {
  white:  "text-white",
  red:    "text-red-500",
  green:  "text-green-400",
  yellow: "text-yellow-400",
  orange: "text-orange-400",
  blue:   "text-sky-400",
  purple: "text-violet-400",
  muted:  "text-zinc-600",
};

interface KpiCardProps {
  label: string;
  value: string | number;
  /** Small secondary label below the value (e.g., "8 ACCTS  latest ending") */
  secondary?: React.ReactNode;
  /** Color of the big number */
  color?: KpiColor;
  /** Optional href if the card should be clickable */
  href?: string;
  /** Pass true when the data is a placeholder, not real — shows a subtle "—" hint */
  placeholder?: boolean;
}

export function KpiCard({
  label,
  value,
  secondary,
  color = "white",
  href,
  placeholder = false,
}: KpiCardProps) {
  const Tag = href ? "a" : "div";
  const tagProps = href ? { href } : {};

  return (
    <Tag
      {...tagProps}
      className={`
        group relative block rounded-xl border border-zinc-800 bg-zinc-950/60
        px-5 py-4 transition-colors
        ${href ? "hover:border-zinc-700" : ""}
      `}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="text-[10px] font-semibold uppercase tracking-[0.16em] text-zinc-500">
          {label}
        </span>
        {href && (
          <span className="text-zinc-600 group-hover:text-zinc-400 transition-colors" aria-hidden="true">
            →
          </span>
        )}
      </div>

      <div className={`mt-2 text-4xl font-bold tracking-tight tabular-nums ${VALUE_COLORS[placeholder ? "muted" : color]}`}>
        {placeholder ? "—" : value}
      </div>

      {secondary && (
        <div className="mt-1 text-xs text-zinc-500">
          {secondary}
        </div>
      )}
    </Tag>
  );
}
