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
                className={`flex flex-col gap-1.5 px-3 py-2.5 rounded-md border text-left transition-colors ${
                  isOn
                    ? ENHANCE_PROVIDER_CHIP_ON[p]
                    : "bg-zinc-900 border-zinc-800 text-zinc-500 hover:border-zinc-700"
                }`}
              >
                <div className="flex items-center gap-2 flex-wrap">
                  <span
                    className={`w-3.5 h-3.5 rounded border flex items-center justify-center shrink-0 ${
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
                  <span
                    className={`text-[9px] uppercase tracking-[0.18em] font-bold border rounded px-1.5 py-0.5 ${meta.speedClass}`}
                  >
                    {meta.speedLabel}
                  </span>
                  {meta.isNew && (
                    <span className="text-[9px] uppercase tracking-[0.18em] font-bold text-sky-100 bg-sky-600 border border-sky-500 rounded px-1.5 py-0.5">
                      New
                    </span>
                  )}
                  <span className="text-[10px] opacity-60 font-mono ml-auto">
                    ~{ENHANCE_PROVIDER_DURATION_S[p]}s
                  </span>
                </div>
                <p
                  className={`text-[11px] leading-snug ${
                    isOn ? "opacity-80" : "text-zinc-500"
                  }`}
                >
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
