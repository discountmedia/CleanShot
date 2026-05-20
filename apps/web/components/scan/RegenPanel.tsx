// apps/web/components/scan/RegenPanel.tsx
// Inline expandable regenerate panel — sits under a ScanCard's body when
// the operator clicks ↻ Regenerate. Pre-fills the editable prompt from
// `buildRegenPrompt(unified)` (full enhance system prompt + anomaly
// list). The provider picker matches the Enhance tab's chip vocabulary.

import { useMemo, useState } from "react";

import {
  buildRegenPrompt,
  type UnifiedAnomalyEntry,
} from "../../lib/scan-helpers";
import type { EquipmentType } from "../../lib/types";
import {
  ENHANCE_PROVIDERS,
  ENHANCE_PROVIDER_LABELS,
  type EnhanceProvider,
} from "../../lib/types-enhance";

interface RegenPanelProps {
  /** Deduped anomaly list — used to seed the prompt textarea. */
  unified: UnifiedAnomalyEntry[];
  /** Default provider for the regen run (defaults to "gemini"). */
  defaultProvider?: EnhanceProvider;
  /**
   * Equipment category — feeds the seeded prompt's per-type anatomy
   * block so the regen target uses the same guardrails Enhance did.
   * Defaults to "forklift" when omitted.
   */
  equipmentType?: EquipmentType;
  /**
   * OEM make — feeds the RENTAL-FLEET BRANDING block's OEM-decal
   * restoration sentence. Null/missing => no OEM restoration on regen.
   */
  make?: string | null;
  onApply:  (payload: { prompt: string; provider: EnhanceProvider }) => void;
  onCancel: () => void;
}

export function RegenPanel({
  unified,
  defaultProvider = "gemini",
  equipmentType = "forklift",
  make = null,
  onApply,
  onCancel,
}: RegenPanelProps) {
  const initialPrompt = useMemo(
    () => buildRegenPrompt(unified, { equipmentType, make }),
    [unified, equipmentType, make],
  );
  const [prompt, setPrompt] = useState(initialPrompt);
  const [provider, setProvider] = useState<EnhanceProvider>(defaultProvider);

  // Sensible default height: enough to show the first ~12 lines without
  // forcing the operator to scroll for short prompts. Resize handle stays
  // available for long edits.
  const rows = Math.min(12, prompt.split("\n").length + 1);

  return (
    <section className="rounded-lg border border-amber-900 bg-amber-950/15 overflow-hidden">
      <header className="flex items-center justify-between px-4 py-2 border-b border-amber-900/50 bg-amber-950/30">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] uppercase tracking-[0.18em] font-bold text-amber-300">
            ↻ Regenerate
          </span>
          <span className="text-[10px] text-zinc-500 italic">
            Auto-built prompt from anomalies — edit before applying if needed
          </span>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="text-[10px] uppercase tracking-[0.18em] text-zinc-500 hover:text-zinc-300 transition-colors"
        >
          Cancel
        </button>
      </header>

      <div className="p-4 space-y-3">
        <textarea
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={rows}
          spellCheck={false}
          aria-label="Regeneration prompt"
          className="w-full bg-zinc-950 border border-zinc-800 rounded-md px-3 py-2 text-[12px] font-mono text-zinc-200 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent resize-y leading-relaxed"
        />

        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-zinc-500">
              Provider
            </span>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value as EnhanceProvider)}
              aria-label="Regeneration provider"
              className="bg-zinc-900 border border-zinc-700 rounded-md px-2.5 py-1.5 text-xs text-white focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent"
            >
              {ENHANCE_PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {ENHANCE_PROVIDER_LABELS[p]}
                </option>
              ))}
            </select>
            <span className="text-[10px] text-zinc-600 italic">
              · re-runs Enhance with this prompt
            </span>
          </div>

          <button
            type="button"
            onClick={() => onApply({ prompt, provider })}
            className="text-xs uppercase tracking-[0.18em] font-semibold text-white bg-amber-600 hover:bg-amber-500 border border-amber-500 px-4 py-2 rounded transition-colors"
          >
            ↻ Regenerate now
          </button>
        </div>
      </div>
    </section>
  );
}
