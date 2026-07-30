// apps/web/components/workspace/KpiCard.tsx
// One stat tile — small uppercase label, huge colored number, optional secondary label.
// Mirrors the metric-card pattern from the company's inventory/ledger dashboards.

// Named by ROLE, not by hue. The old union ("green" | "yellow" | "blue" | …)
// became a second colour vocabulary once the house palette landed — "blue"
// mapped to lime, which is a lie the next reader would have to decode.
export type KpiColor =
  | "neutral"   // plain count, no judgement
  | "good"      // lime — throughput, healthy, done
  | "attention" // red — needs a human; this palette has no amber
  | "muted";    // inactive / archived

const VALUE_COLORS: Record<KpiColor, string> = {
  neutral:   "text-ink",
  good:      "text-accent",
  attention: "text-attn",
  muted:     "text-muted",
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
  color = "neutral",
  href,
  placeholder = false,
}: KpiCardProps) {
  const Tag = href ? "a" : "div";
  const tagProps = href ? { href } : {};

  return (
    <Tag
      {...tagProps}
      className={`
        group relative block rounded-xl border border-line bg-well/60
        px-5 py-4 transition-colors
        ${href ? "hover:border-line" : ""}
      `}
    >
      <div className="flex items-start justify-between gap-3">
        <span className="text-sm font-semibold uppercase tracking-[0.14em] text-ink">
          {label}
        </span>
        {href && (
          <span className="text-ink-soft group-hover:text-ink transition-colors" aria-hidden="true">
            →
          </span>
        )}
      </div>

      <div className={`mt-2 text-5xl font-bold tracking-tight tabular-nums ${VALUE_COLORS[placeholder ? "muted" : color]}`}>
        {placeholder ? "—" : value}
      </div>

      {secondary && (
        <div className="mt-2 text-sm text-ink-soft">
          {secondary}
        </div>
      )}
    </Tag>
  );
}
