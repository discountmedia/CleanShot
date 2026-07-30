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
  high:   { dot: "bg-cta",    text: "text-attn",    bg: "bg-panel border-attn" },
  medium: { dot: "bg-accent", text: "text-accent", bg: "bg-panel border-accent" },
  low:    { dot: "bg-grey",   text: "text-ink-soft",   bg: "bg-panel/40 border-line" },
};

export function UnifiedAnomalies({ unified, totalProviders }: UnifiedAnomaliesProps) {
  if (unified.length === 0) {
    return (
      <div className="rounded-md border border-line bg-panel/30 px-3 py-2.5 text-xs text-ink-faint italic">
        No anomalies detected — all providers agree the image is clean.
      </div>
    );
  }

  return (
    <ul className="space-y-1.5" aria-label="Detected anomalies">
      {unified.map((a, i) => {
        // Defensive: backend can occasionally emit severity in unexpected
        // casing or value (the JSON schema documents low/medium/high but
        // models drift). Fall back to the low style rather than crash.
        const sev = SEV_STYLE[a.severity] ?? SEV_STYLE.low;
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
                  <span className="text-xs text-ink font-medium capitalize">
                    {a.type}
                  </span>
                  <span className="text-xs text-ink-faint">— {a.location}</span>
                </div>
                <p className="text-xs text-ink-soft mt-0.5 leading-snug">
                  {a.description}
                </p>
              </div>

              {/* N/{total} signal bar — N ticks colored at severity, rest grey. */}
              <div className="shrink-0 flex flex-col items-end gap-0.5">
                <span className="text-[9px] uppercase tracking-[0.16em] text-muted tabular-nums">
                  {flaggedCount}/{totalProviders}
                </span>
                <div className="flex gap-0.5">
                  {Array.from({ length: totalProviders }).map((_, idx) => (
                    <span
                      key={idx}
                      className={`w-3 h-1 rounded-full ${idx < flaggedCount ? sev.dot : "bg-panel-hi"}`}
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
