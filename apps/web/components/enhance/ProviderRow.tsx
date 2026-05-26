// apps/web/components/enhance/ProviderRow.tsx
// Provider multi-select row — Phase 3 redesign.
//
// Grid of provider tiles. Each tile keeps the chip-style selection visual
// (checkbox + saturated tint when on) but also surfaces the speed label
// and one-line "what this is" description that lived in the prior
// verbose card stack — operators kept that context useful and asked for
// it back after the v1 redesign hid it.
//
// Multi-select with a "must keep at least one" invariant (enforced by
// the caller; this component just calls `onToggle`).

import {
  ENHANCE_PROVIDERS,
  ENHANCE_PROVIDER_LABELS,
  ENHANCE_PROVIDER_CHIP_ON,
  ENHANCE_PROVIDER_META,
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
      <header className="flex items-center justify-between px-5 py-4 bg-zinc-900/30 border-b border-zinc-900">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-base font-bold uppercase tracking-[0.14em] text-zinc-100">
            AI Providers
          </span>
          <span className="text-sm uppercase tracking-[0.14em] font-bold text-zinc-300">
            multi-select
          </span>
        </div>
        <span className="text-sm uppercase tracking-[0.14em] font-bold text-zinc-200 tabular-nums">
          {selected.size} selected
        </span>
      </header>

      <div className="px-5 py-4">
        {/* Cost/latency caption — picking more providers fans the
            same source out to more vendor calls in parallel, so the
            batch finishes only when the slowest one completes and
            the per-source spend scales linearly with the count.
            Small yellow print, italic so it reads as a hint. */}
        <p className="text-xs italic text-yellow-300/80 mb-3 leading-relaxed">
          Heads up — the more providers you tick, the longer each batch takes (it has to wait for the slowest one to finish) and the more it costs (each provider charges per image). Each additional provider adds a small amount to the per-source spend.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {ENHANCE_PROVIDERS.map((p) => {
            const isOn = selected.has(p);
            const meta = ENHANCE_PROVIDER_META[p];
            return (
              <button
                key={p}
                type="button"
                onClick={() => onToggle(p)}
                aria-pressed={isOn}
                className={`flex flex-col gap-1.5 px-3 py-3 rounded-md border text-left transition-colors ${
                  isOn
                    ? ENHANCE_PROVIDER_CHIP_ON[p]
                    : "bg-zinc-900 border-zinc-800 hover:border-zinc-700"
                }`}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                      isOn ? "bg-current border-current" : "border-zinc-600"
                    }`}
                  >
                    {isOn && (
                      <svg
                        className="w-3 h-3 text-black"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                        strokeWidth={4}
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                      </svg>
                    )}
                  </span>
                  {/* Provider name — per-provider colour so each model
                      is visually distinct from the others at a glance. */}
                  <span className={`text-base font-semibold uppercase tracking-[0.16em] ${meta.titleClass}`}>
                    {ENHANCE_PROVIDER_LABELS[p]}
                  </span>
                  <span
                    className={`text-[11px] uppercase tracking-[0.18em] font-bold border rounded px-1.5 py-0.5 ${meta.speedClass}`}
                  >
                    {meta.speedLabel}
                  </span>
                  <span className="text-xs font-mono ml-auto text-yellow-300">
                    ~{ENHANCE_PROVIDER_DURATION_S[p]}s
                  </span>
                </div>
                <p className="text-sm leading-snug text-yellow-300">
                  {meta.description}
                </p>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}
