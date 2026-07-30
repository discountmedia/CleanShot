// apps/web/components/scan/ScanProgressStrip.tsx
// Per-provider progress while a scan is in flight. Replaces the
// indeterminate `@keyframes scanbar` sweep with elapsed-vs-expected bars
// (Gemini ~18s, OpenAI ~30s, Anthropic ~25s).
//
// Important honesty note: the backend currently runs a single job per
// image that fans out to all 3 providers internally and only writes
// results when the entire job completes. There's no per-provider
// milestone in the wire format. So this strip drives all three bars
// from one elapsed timestamp + per-provider expected duration — each
// row shows its own honest pct (Gemini hits 95% earlier than OpenAI
// because Gemini's expected is shorter), and all three snap to 100%
// simultaneously when the job completes.

import { EXPECTED_SCAN_DURATIONS_S } from "../../lib/scan-helpers";
import type { ScanProvider } from "../../lib/types";

interface ScanProgressStripProps {
  /**
   * Ms the scan job started (job.createdAt parsed to a timestamp). The
   * parent ticks `nowMs` once a second; together they produce the
   * elapsed value used by every provider row.
   */
  startedMs:    number | null;
  nowMs:        number;
  /** True once the scan job has flipped to status=complete. */
  allComplete:  boolean;
  /** Providers we expect a verdict from. Defaults to all three. */
  providers?:   readonly ScanProvider[];
}

const SCAN_PROVIDER_LABELS: Record<ScanProvider, string> = {
  gemini:    "Gemini",
  openai:    "OpenAI",
  anthropic: "Anthropic",
};

const SCAN_PROVIDER_TEXT: Record<ScanProvider, string> = {
  gemini:    "text-ink-soft",
  openai:    "text-accent",
  anthropic: "text-grey",
};

const DEFAULT_PROVIDERS: readonly ScanProvider[] = [
  "gemini",
  "openai",
  "anthropic",
] as const;

export function ScanProgressStrip({
  startedMs,
  nowMs,
  allComplete,
  providers = DEFAULT_PROVIDERS,
}: ScanProgressStripProps) {
  const elapsedSeconds = startedMs
    ? Math.max(0, Math.floor((nowMs - startedMs) / 1000))
    : 0;

  return (
    <div className="space-y-2">
      <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-ink-faint">
        Running 3-provider consensus scan
      </span>
      {providers.map((p) => {
        const expected = EXPECTED_SCAN_DURATIONS_S[p];
        const done = allComplete;
        const pct = done
          ? 100
          : Math.min(95, Math.max(5, Math.round((elapsedSeconds / expected) * 100)));
        return (
          <div key={p} className="flex items-center gap-3">
            <span
              className={`text-[11px] font-bold uppercase tracking-[0.16em] w-20 ${SCAN_PROVIDER_TEXT[p]}`}
            >
              {SCAN_PROVIDER_LABELS[p]}
            </span>
            <div
              className="flex-1 h-1.5 bg-panel rounded-full overflow-hidden"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={pct}
              aria-label={`${SCAN_PROVIDER_LABELS[p]} scan progress`}
            >
              <div
                className={`h-full transition-all duration-500 ease-out ${
                  done ? "bg-accent" : "bg-panel-hi"
                }`}
                style={{ width: `${pct}%` }}
              />
            </div>
            <span className="text-[10px] font-mono text-ink-faint tabular-nums w-24 text-right">
              {String(Math.min(elapsedSeconds, 99)).padStart(2, "0")}s / ~{expected}s
            </span>
            <span
              className={`text-[10px] font-mono tabular-nums w-10 text-right ${
                done ? "text-accent" : "text-ink-soft"
              }`}
            >
              {pct}%
            </span>
          </div>
        );
      })}
    </div>
  );
}
