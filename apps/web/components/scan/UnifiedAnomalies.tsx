// apps/web/components/scan/UnifiedAnomalies.tsx
// Deduplicated anomaly list with an N/{total} signal bar per entry.
// Operator sees one row per distinct issue instead of three near-identical
// rows ("rust on overhead guard" × Gemini × OpenAI × Anthropic).

import type { UnifiedAnomalyEntry } from "../../lib/scan-helpers";
import type { AnomalyItem } from "../../lib/types";

interface UnifiedAnomaliesProps {
  unified: UnifiedAnomalyEntry[];
  /** How many providers participated in this scan (usually 3). */
  totalProviders: number;
}

const SEV_STYLE: Record<
  AnomalyItem["severity"],
  { dot: string; text: string; bg: string }
> = {
  high:   { dot: "bg-red-500",    text: "text-red-400",    bg: "bg-red-950/20 border-red-900" },
  medium: { dot: "bg-yellow-500", text: "text-yellow-400", bg: "bg-yellow-950/20 border-yellow-900" },
  low:    { dot: "bg-zinc-500",   text: "text-zinc-400",   bg: "bg-zinc-900/40 border-zinc-800" },
};

export function UnifiedAnomalies({ unified, totalProviders }: UnifiedAnomaliesProps) {
  if (unified.length === 0) {
    return (
      <div className="rounded-md border border-zinc-800 bg-zinc-900/30 px-3 py-2.5 text-xs text-zinc-500 italic">
        No anomalies detected — all providers agree the image is clean.
      </div>
    );
  }

  return (
    <ul className="space-y-1.5" aria-label="Detected anomalies">
      {unified.map((a, i) => {
        const sev = SEV_STYLE[a.severity];
        const flaggedCount = a.flaggedBy.size;
        return (
          <li key={`${a.type}::${a.location}::${i}`} className={`rounded-md border px-3 py-2 ${sev.bg}`}>
            <div className="flex items-start gap-2.5">
              <span className={`mt-1.5 w-1.5 h-1.5 rounded-full shrink-0 ${sev.dot}`} />
              <div className="flex-1 min-w-0">
                <div className="flex items-baseline gap-2 flex-wrap">
                  <span className={`text-[10px] font-bold uppercase tracking-[0.18em] ${sev.text}`}>
                    {a.severity}
                  </span>
                  <span className="text-xs text-zinc-200 font-medium capitalize">
                    {a.type}
                  </span>
                  <span className="text-xs text-zinc-500">— {a.location}</span>
                </div>
                <p className="text-xs text-zinc-400 mt-0.5 leading-snug">
                  {a.description}
                </p>
              </div>

              {/* N/{total} signal bar — N ticks colored at severity, rest grey. */}
              <div className="shrink-0 flex flex-col items-end gap-0.5">
                <span className="text-[9px] uppercase tracking-[0.16em] text-zinc-600 tabular-nums">
                  {flaggedCount}/{totalProviders}
                </span>
                <div className="flex gap-0.5">
                  {Array.from({ length: totalProviders }).map((_, idx) => (
                    <span
                      key={idx}
                      className={`w-3 h-1 rounded-full ${idx < flaggedCount ? sev.dot : "bg-zinc-800"}`}
                    />
                  ))}
                </div>
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
