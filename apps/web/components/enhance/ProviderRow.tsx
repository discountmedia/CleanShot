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
  GENERIC_AUTHORS,
  PROMPT_AUTHOR_LABELS,
  TAILORED_AUTHORS_BY_GENERATOR,
  type EnhanceProvider,
  type PromptChoice,
} from "../../lib/types-enhance";
import { ENHANCE_PROVIDER_DURATION_S } from "../../lib/pricing";

interface ProviderRowProps {
  selected: Set<EnhanceProvider>;
  onToggle: (provider: EnhanceProvider) => void;
  /**
   * Bulk toggle for the whole provider row. When invoked, the caller is
   * expected to flip between "all providers" and "single default
   * provider" (it can never reduce to zero — same invariant as the
   * per-tile toggle). Optional so existing callers that haven't wired
   * it yet keep compiling.
   */
  onSelectAll?: () => void;
  /**
   * Per-card master-prompt selection. Maps each provider to its chosen
   * "Prompt:" dropdown value. Optional so callers that don't use the
   * prompt-tuning feature keep compiling (the dropdown just won't render).
   */
  promptChoices?: Record<EnhanceProvider, PromptChoice>;
  onPromptChoiceChange?: (provider: EnhanceProvider, choice: PromptChoice) => void;
  /**
   * "Set all" bulk helper — applies one choice to every selected provider.
   * Only exposes Auto + the generic-by-author options (valid for any model).
   */
  onBulkPromptChoice?: (choice: PromptChoice) => void;
}

// Build the grouped option list for one generator's "Prompt:" dropdown.
// Auto first, then "Tailored for <X>" (its own authored variants), then the
// four universal generics. Shape mirrors master_prompts.py.
function promptOptionsFor(provider: EnhanceProvider) {
  const tailored = TAILORED_AUTHORS_BY_GENERATOR[provider] ?? [];
  return { tailored };
}

export function ProviderRow({
  selected,
  onToggle,
  onSelectAll,
  promptChoices,
  onPromptChoiceChange,
  onBulkPromptChoice,
}: ProviderRowProps) {
  const allOn = selected.size === ENHANCE_PROVIDERS.length;
  const showPrompts = !!promptChoices && !!onPromptChoiceChange;
  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-950/60 overflow-hidden">
      <header className="flex items-center justify-between px-5 py-4 bg-zinc-900/30 border-b border-zinc-900 gap-3 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-base font-bold uppercase tracking-[0.14em] text-zinc-100">
            AI Providers
          </span>
          <span className="text-sm uppercase tracking-[0.14em] font-bold text-zinc-300">
            multi-select
          </span>
        </div>
        <div className="flex items-center gap-4 flex-wrap">
          {onSelectAll && (
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={allOn}
                onChange={onSelectAll}
                aria-label={allOn ? "Deselect all providers" : "Select all providers"}
                className="w-4 h-4 accent-emerald-500 cursor-pointer"
              />
              <span className="text-sm uppercase tracking-[0.14em] font-bold text-zinc-200">
                Select all
              </span>
            </label>
          )}
          {showPrompts && onBulkPromptChoice && (
            <label className="flex items-center gap-2 select-none">
              <span className="text-sm uppercase tracking-[0.14em] font-bold text-zinc-300">
                Set all prompts
              </span>
              <select
                aria-label="Set the prompt for every selected provider"
                defaultValue=""
                onChange={(e) => {
                  const v = e.target.value;
                  if (v) onBulkPromptChoice(v as PromptChoice);
                  e.target.value = ""; // reset so re-picking same value re-fires
                }}
                className="bg-zinc-900 border border-zinc-700 rounded-md px-2 py-1 text-sm text-zinc-100 focus:outline-none focus:ring-2 focus:ring-sky-500"
              >
                <option value="" disabled>
                  Apply to selected…
                </option>
                <option value="auto">Auto (built-in)</option>
                {GENERIC_AUTHORS.map((a) => (
                  <option key={a} value={`generic:${a}`}>
                    Generic · by {PROMPT_AUTHOR_LABELS[a]}
                  </option>
                ))}
              </select>
            </label>
          )}
          <span className="text-sm uppercase tracking-[0.14em] font-bold text-zinc-200 tabular-nums">
            {selected.size} selected
          </span>
        </div>
      </header>

      <div className="px-5 py-4">
        {/* Cost/latency caption — picking more providers fans the
            same source out to more vendor calls in parallel, so the
            batch finishes only when the slowest one completes and
            the per-source spend scales linearly with the count.
            Small yellow print, italic so it reads as a hint. */}
        <p className="text-sm italic text-yellow-300/80 mb-3 leading-relaxed">
          Heads up — the more providers you tick, the longer each batch takes.
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
          {ENHANCE_PROVIDERS.map((p) => {
            const isOn = selected.has(p);
            const meta = ENHANCE_PROVIDER_META[p];
            const { tailored } = promptOptionsFor(p);
            const choice = promptChoices?.[p] ?? "auto";
            return (
              <div
                key={p}
                className={`flex flex-col gap-1.5 px-3 py-3 rounded-md border transition-colors ${
                  isOn
                    ? ENHANCE_PROVIDER_CHIP_ON[p]
                    : "bg-zinc-900 border-zinc-800 hover:border-zinc-700"
                }`}
              >
                {/* Toggle region — own button so the dropdown below isn't
                    nested in a button (invalid HTML) and its clicks don't
                    flip selection. */}
                <button
                  type="button"
                  onClick={() => onToggle(p)}
                  aria-pressed={isOn}
                  className="flex flex-col gap-1.5 text-left"
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

                {/* Per-card "Prompt:" dropdown — the single source of truth
                    for which authored prompt drives THIS generator. Grouped:
                    Auto, then this model's tailored-by-author variants, then
                    the four universal generics. "Prompt by" wording so it's
                    never confused with "generate with". */}
                {showPrompts && (
                  <label className="flex items-center gap-2 mt-1 pt-2 border-t border-white/10">
                    <span className="text-[11px] uppercase tracking-[0.16em] font-bold text-zinc-300 shrink-0">
                      Prompt
                    </span>
                    <select
                      aria-label={`Prompt for ${ENHANCE_PROVIDER_LABELS[p]}`}
                      value={choice}
                      onChange={(e) =>
                        onPromptChoiceChange?.(p, e.target.value as PromptChoice)
                      }
                      className="flex-1 min-w-0 bg-zinc-900 border border-zinc-700 rounded px-2 py-1 text-xs text-zinc-100 focus:outline-none focus:ring-2 focus:ring-sky-500"
                    >
                      <option value="auto">Auto (built-in)</option>
                      {tailored.length > 0 && (
                        <optgroup label={`Tailored for ${ENHANCE_PROVIDER_LABELS[p]}`}>
                          {tailored.map((a) => (
                            <option key={`t-${a}`} value={`tailored:${a}`}>
                              {ENHANCE_PROVIDER_LABELS[p]} · by {PROMPT_AUTHOR_LABELS[a]}
                            </option>
                          ))}
                        </optgroup>
                      )}
                      <optgroup label="Generic (one-size-fits-all)">
                        {GENERIC_AUTHORS.map((a) => (
                          <option key={`g-${a}`} value={`generic:${a}`}>
                            Generic · by {PROMPT_AUTHOR_LABELS[a]}
                          </option>
                        ))}
                      </optgroup>
                    </select>
                  </label>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </section>
  );
}
