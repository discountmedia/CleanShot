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
  onApply:  (payload: { prompt: string; provider: EnhanceProvider }) => void;
  onCancel: () => void;
}

export function RegenPanel({
  unified,
  defaultProvider = "gemini",
  equipmentType = "forklift",
  onApply,
  onCancel,
}: RegenPanelProps) {
  const initialPrompt = useMemo(
    () => buildRegenPrompt(unified, { equipmentType }),
    [unified, equipmentType],
  );
  const [prompt, setPrompt] = useState(initialPrompt);
  const [provider, setProvider] = useState<EnhanceProvider>(defaultProvider);

  // Sensible default height: enough to show the first ~12 lines without
  // forcing the operator to scroll for short prompts. Resize handle stays
  // available for long edits.
  const rows = Math.min(12, prompt.split("\n").length + 1);

  return (
    <section className="rounded-lg border border-danger-ink bg-panel overflow-hidden">
      <header className="flex items-center justify-between px-4 py-2 border-b border-danger-ink bg-panel">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[10px] uppercase tracking-[0.18em] font-bold text-danger-ink">
            ↻ Regenerate
          </span>
          <span className="text-[10px] text-ink-faint italic">
            Auto-built prompt from anomalies — edit before applying if needed
          </span>
        </div>
        <button
          type="button"
          onClick={onCancel}
          className="text-[10px] uppercase tracking-[0.18em] text-ink-faint hover:text-ink-soft transition-colors"
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
          className="w-full bg-well border border-line rounded-md px-3 py-2 text-[12px] font-mono text-ink focus:outline-none focus:ring-2 focus:ring-danger-ink focus:border-transparent resize-y leading-relaxed"
        />

        <div className="flex items-center justify-between gap-3 flex-wrap">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-ink-faint">
              Provider
            </span>
            <select
              value={provider}
              onChange={(e) => setProvider(e.target.value as EnhanceProvider)}
              aria-label="Regeneration provider"
              className="bg-panel border border-line rounded-md px-2.5 py-1.5 text-xs text-ink focus:outline-none focus:ring-2 focus:ring-danger-ink focus:border-transparent"
            >
              {ENHANCE_PROVIDERS.map((p) => (
                <option key={p} value={p}>
                  {ENHANCE_PROVIDER_LABELS[p]}
                </option>
              ))}
            </select>
            <span className="text-[10px] text-muted italic">
              · re-runs Enhance with this prompt
            </span>
          </div>

          <button
            type="button"
            onClick={() => onApply({ prompt, provider })}
            className="text-xs uppercase tracking-[0.18em] font-semibold text-ink bg-danger hover:bg-danger-dark border border-danger-ink px-4 py-2 rounded transition-colors"
          >
            ↻ Regenerate now
          </button>
        </div>
      </div>
    </section>
  );
}
