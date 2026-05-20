// apps/web/components/scan/ConsensusPill.tsx
// PASS / FAIL / MIXED consensus summary pill. Renders inline-flex with a
// large unicode glyph + two-line label (verdict + sub-line of `N/M pass ·
// XX% avg conf`). Designed to sit at the right of a ScanCard's header.

import type { ConsensusSummary } from "../../lib/scan-helpers";

interface ConsensusPillProps {
  consensus: ConsensusSummary | null;
}

const VERDICT_CONFIG: Record<
  ConsensusSummary["verdict"],
  { label: string; icon: string; colorClass: string }
> = {
  pass:  { label: "PASS",  icon: "✓", colorClass: "text-green-400 bg-green-950/60 border-green-800" },
  fail:  { label: "FAIL",  icon: "✗", colorClass: "text-red-400 bg-red-950/60 border-red-800" },
  mixed: { label: "MIXED", icon: "◐", colorClass: "text-yellow-400 bg-yellow-950/60 border-yellow-800" },
};

export function ConsensusPill({ consensus }: ConsensusPillProps) {
  if (!consensus) return null;
  const { verdict, avgConfidence, passes, total } = consensus;
  const pct = Math.round(avgConfidence * 100);
  const cfg = VERDICT_CONFIG[verdict];

  return (
    <div
      className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-md border ${cfg.colorClass}`}
      aria-label={`Consensus ${cfg.label}: ${passes} of ${total} providers passed, ${pct}% average confidence`}
    >
      <span className="text-base font-bold">{cfg.icon}</span>
      <div className="flex flex-col items-start leading-tight">
        <span className="text-[11px] font-bold uppercase tracking-[0.18em]">
          {cfg.label}
        </span>
        <span className="text-[10px] opacity-75 tabular-nums">
          {passes}/{total} pass · {pct}% avg conf
        </span>
      </div>
    </div>
  );
}
