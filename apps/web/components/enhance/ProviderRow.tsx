// apps/web/components/enhance/ProviderRow.tsx
// Provider multi-select row — Phase 3 redesign.
//
// Compact chip-style buttons replace the verbose 5-card stack the previous
// Enhance layout used. Multi-select with a "must keep at least one"
// invariant (enforced by the caller — this component just calls
// `onToggle`; refusing to drop the last provider is EnhancePanel's job,
// matching the prior behaviour).

import {
  ENHANCE_PROVIDERS,
  ENHANCE_PROVIDER_LABELS,
  ENHANCE_PROVIDER_CHIP_ON,
  type EnhanceProvider,
} from "../../lib/types-enhance";
import { ENHANCE_PROVIDER_DURATION_S } from "../../lib/pricing";

interface ProviderRowProps {
  selected: Set<EnhanceProvider>;
  onToggle: (provider: EnhanceProvider) => void;
}

export function ProviderRow({ selected, onToggle }: ProviderRowProps) {
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 overflow-hidden">
      <header className="flex items-center justify-between px-5 py-3 bg-zinc-900/30 border-b border-zinc-900">
        <div className="flex items-center gap-3">
          <span className="text-xs font-semibold uppercase tracking-[0.18em] text-zinc-300">
            AI Providers
          </span>
          <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-600">
            multi-select
          </span>
        </div>
        <span className="text-[10px] uppercase tracking-[0.18em] text-zinc-500">
          {selected.size} selected
        </span>
      </header>

      <div className="px-5 py-4">
        <div className="flex flex-wrap gap-2">
          {ENHANCE_PROVIDERS.map((p) => {
            const isOn = selected.has(p);
            return (
              <button
                key={p}
                type="button"
                onClick={() => onToggle(p)}
                aria-pressed={isOn}
                className={`flex items-center gap-2 px-3 py-2 rounded-md border transition-colors ${
                  isOn
                    ? ENHANCE_PROVIDER_CHIP_ON[p]
                    : "bg-zinc-900 border-zinc-800 text-zinc-500 hover:border-zinc-700"
                }`}
              >
                <span
                  className={`w-3.5 h-3.5 rounded border flex items-center justify-center ${
                    isOn ? "bg-current border-current" : "border-zinc-700"
                  }`}
                >
                  {isOn && (
                    <svg
                      className="w-2.5 h-2.5 text-black"
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={4}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                    </svg>
                  )}
                </span>
                <span className="text-xs font-semibold uppercase tracking-[0.16em]">
                  {ENHANCE_PROVIDER_LABELS[p]}
                </span>
                <span className="text-[10px] opacity-60 font-mono">
                  ~{ENHANCE_PROVIDER_DURATION_S[p]}s
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
