// apps/web/components/enhance/ForkFramingControls.tsx
//
// Per-image "what's actually in frame" controls for the forks.
//
// The problem these solve: conditional rules inside the prompt weren't
// holding. On camera angles where the upright fork section is out of frame,
// the prompt still asked for it, so the model painted part of the overhead
// guard or carriage into a shank. Where the tips are cropped out, the prompt
// still asked for yellow tips, so the model SHORTENED the forks to drag tips
// into view and have something to paint.
//
// So these controls REMOVE the offending prompt fragment rather than adding
// another instruction on top of it. Emphatic "do not draw X" phrasing is known
// to backfire on Gemini in this codebase (the reverted Phase A guardrail
// experiment) — the reliable fix is to stop asking.
//
// Per image, not per batch: whether the tips got cropped is a property of one
// camera angle. Each queued image already carries its own task payload, so
// this costs no extra plumbing.

import type { ForkVisibility } from "../../lib/recommended-prompt";

interface ForkFramingControlsProps {
  value: ForkVisibility;
  onChange: (next: ForkVisibility) => void;
  /**
   * True when the operator's prompt is no longer the recommended text. Their
   * words are the spine in that case, so there is no fragment of ours to
   * remove and the backend appends an explicit instruction instead. Surfaced
   * here because a control that silently changes what it does is worse than
   * one that says so.
   */
  promptIsCustom: boolean;
  /** Compact variant for the pre-enhance upload grid's small tiles. */
  compact?: boolean;
}

export function ForkFramingControls({
  value,
  onChange,
  promptIsCustom,
  compact = false,
}: ForkFramingControlsProps) {
  const rows: Array<{
    key: keyof ForkVisibility;
    label: string;
    hint: string;
  }> = [
    {
      key: "verticalVisible",
      label: "Vertical fork section not visible",
      hint: "Drops the instruction to paint the fork's upright shank, so the model can't invent one out of the carriage or overhead guard.",
    },
    {
      key: "tipsVisible",
      label: "Fork tips not visible",
      hint: "Swaps the yellow-tip instruction for red-only, so the model doesn't shorten the forks to bring tips into view.",
    },
  ];

  return (
    <div className={compact ? "space-y-1" : "space-y-2"}>
      {!compact && (
        <p className="text-sm uppercase tracking-[0.12em] font-bold text-ink-soft">
          Fork framing
        </p>
      )}
      {rows.map((row) => {
        // The control reads as the PROBLEM ("not visible"), while the stored
        // value is the positive ("visible"). Inverted here so the checkbox
        // label matches how the operator thinks about the photo.
        const checked = !value[row.key];
        return (
          <label
            key={row.key}
            className={`flex items-start gap-2 cursor-pointer select-none ${
              compact ? "" : "rounded-lg border border-line bg-panel px-3 py-2"
            }`}
            title={row.hint}
          >
            <input
              type="checkbox"
              checked={checked}
              onChange={(e) =>
                onChange({ ...value, [row.key]: !e.target.checked })
              }
              className={`accent-accent shrink-0 ${compact ? "mt-0.5 w-3.5 h-3.5" : "mt-0.5 w-4 h-4"}`}
            />
            <span className="min-w-0">
              <span
                className={`block font-semibold text-ink leading-snug ${
                  compact ? "text-[11px]" : "text-base"
                }`}
              >
                {row.label}
              </span>
              {!compact && (
                <span className="block text-sm text-ink-soft mt-0.5 leading-relaxed">
                  {row.hint}
                </span>
              )}
            </span>
          </label>
        );
      })}

      {/* Custom-prompt degradation, stated rather than silent. */}
      {!compact && promptIsCustom && (value.verticalVisible === false || value.tipsVisible === false) && (
        <p className="text-sm text-attn leading-relaxed">
          You&apos;ve edited the prompt, so there&apos;s no recommended wording left to
          remove. These will be added to your prompt as explicit instructions
          instead, which is less reliable than leaving the instruction out.
        </p>
      )}
    </div>
  );
}
