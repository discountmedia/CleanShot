// apps/web/lib/types-enhance.ts
// Shared types for the Enhance tab. Pulled out of EnhancePanel.tsx so the
// new compare-card components (SourceCompareCard, ProviderRow, etc.) can
// share the Provider literal without circular-importing the panel.

/**
 * AI provider used for image enhancement. Pinned to the backend
 * `EnhanceTaskPayload.provider` literal in
 * apps/api/src/cleanshot_api/models/schemas.py.
 */
/**
 * Image-edit GENERATION provider for the primary Enhance picker.
 * Narrowed to Gemini / OpenAI / Grok 2026-06-05 — Kontext (BFL Flux
 * Kontext Max via RunComfy), Ideogram (3.0 /v1/edit), and Reve
 * (latest-fast /v1/image/edit) were removed from the user-facing
 * picker. Grok was then made DORMANT 2026-07-21 (operator cut it from
 * the mix), so the LIVE picker is now Gemini / OpenAI only — grok stays
 * in this union + all Records + the backend _enhance_with_grok helper as
 * dead-but-harmless code (removed only from ENHANCE_PROVIDERS below).
 * Note: Ideogram is still wired internally for the per-variant
 * Tweak ("T cyan Edit") + Inpaint ("🖌 rose") tools — those tools have
 * their own `tool` Literal separate from this primary-provider union.
 * ⚠️ UPDATED 2026-08-27 — the dead-but-harmless code is no longer all
 * there. `_enhance_with_kontext`, `_enhance_with_reve` and
 * `_erase_with_flux` were DELETED from enhance_worker.py, and the erase
 * tool now routes to Ideogram inpaint instead of BFL. Restoring Kontext or
 * Reve is a git revert of that commit, not a one-line change. What DOES
 * still stand as dead-but-harmless: `grok` in this union, in every Record
 * below, and as `_enhance_with_grok` in the worker; and Ideogram, which is
 * live for the Tweak and Inpaint tools.
 */
export type EnhanceProvider = "gemini" | "openai" | "grok";

export const ENHANCE_PROVIDERS: readonly EnhanceProvider[] = [
  "gemini",
  "openai",
  // "grok" — DORMANT AGAIN as of 2026-08-28. Live for one day; the
  // operator tried it against the Gemini reference and stopped rather
  // than keep tuning: output bled the fork red onto the mast, overhead
  // guard and body, and re-posed the camera angle. Two fixes shipped that
  // day (removing an invented 4000-char prompt cap, then giving Grok its
  // own terse edit-model builder) and the second was never evaluated.
  //
  // Dormancy is an omission from THIS ARRAY ONLY. Still in place and
  // still correct: the EnhanceProvider union, every Record below,
  // XAI_API_KEY (confirmed valid), the rate limiter, the PER_IMAGE_USD
  // row, _enhance_with_grok, and _build_grok_prompt. Re-enabling is
  // re-adding "grok" to this array — and if you do, START from the
  // terse builder, not from the Gemini prose. Deleting that builder is
  // how this went wrong: its Kontext ancestor was removed on 2026-08-27
  // and Grok was switched on hours later with nothing but Gemini's
  // declarative prompt, which this repo had already measured as the
  // "whole machine turns red" failure mode for edit models.
] as const;

export const ENHANCE_PROVIDER_LABELS: Record<EnhanceProvider, string> = {
  gemini:   "Gemini",
  openai:   "OpenAI",
  grok:     "Grok",
};

// ─── Master-prompt selection (the per-card "Prompt:" dropdown) ───────────────
//
// The operator hand-authored a library of master enhance prompts, each written
// by a different LLM. Each generator card carries one "Prompt:" dropdown whose
// value is an opaque key sent verbatim to the BFF as `promptChoice`:
//
//   • "auto"             → backend procedural builder (default; no regression)
//   • "generic:<author>" → one-size-fits-all master prompt by that author
//   • "tailored:<author>" → model-specific master prompt by that author
//
// Resolution + the prompt text itself live server-side in
// apps/api/.../workers/master_prompts.py. This file only needs the option
// vocabulary so the dropdowns can be built. KEEP IN SYNC with that module's
// GENERIC_PROMPTS keys + TAILORED_AUTHORS.

export type PromptAuthor = "claude" | "gemini" | "openai" | "grok";

export type PromptChoice =
  | "auto"
  | `generic:${PromptAuthor}`
  | `tailored:${PromptAuthor}`;

export const PROMPT_AUTHOR_LABELS: Record<PromptAuthor, string> = {
  claude: "Claude",
  gemini: "Gemini",
  openai: "OpenAI",
  grok:   "Grok",
};

// Authors offered under "Tailored for <generator>" per card. With the
// Kontext/Ideogram/Reve edit-style models removed from the picker (see
// EnhanceProvider above), only the three namesake generators remain —
// each offers only its own author. Master prompts for the removed
// generators still live in master_prompts.py as dead-but-harmless code
// in case the operator wants any of them back.
export const TAILORED_AUTHORS_BY_GENERATOR: Record<EnhanceProvider, PromptAuthor[]> = {
  gemini: ["gemini"],
  openai: ["openai"],
  grok:   ["grok"],
};

// The four generic (one-size-fits-all) authors — offered on every card, and the
// only options the "Set all" bulk helper exposes (since generic + auto are valid
// for every generator).
export const GENERIC_AUTHORS: readonly PromptAuthor[] = [
  "claude",
  "gemini",
  "openai",
  "grok",
] as const;

/**
 * Chip classes when SELECTED. The house palette has three accents (lime =
 * good/active, purple = action + attention, red = destructive only), so it
 * cannot encode six per-provider identity hues — the old blue/green/orange/
 * purple/cyan/fuchsia set is gone. Selection is now shown structurally, the
 * same way the equipment cards and toggles show it: RAISED SURFACE + LIME
 * BORDER. Per-model differentiation is carried by the provider name and the
 * speed pill (lime "Fast" vs purple "Slow") instead of by hue.
 *
 * All providers share one ON style deliberately — a previous per-provider
 * sweep left gemini's ON state byte-identical to its OFF state, so selecting
 * it produced no visible change at all.
 */
const CHIP_ON_SELECTED = "bg-panel-hi text-ink border-accent";

export const ENHANCE_PROVIDER_CHIP_ON: Record<EnhanceProvider, string> = {
  gemini: CHIP_ON_SELECTED,
  openai: CHIP_ON_SELECTED,
  grok:   CHIP_ON_SELECTED,
};

/**
 * Per-provider descriptive metadata — speed pill copy + classes + the
 * one-line "what this is" description that used to live in the verbose
 * checkbox card stack. Restored to the redesigned ProviderRow so the
 * operator still sees latency expectations and routing details.
 */
export interface EnhanceProviderMeta {
  speedLabel:   "Fast" | "Fastest" | "Moderate" | "Slow";
  /** Tailwind classes for the speed pill. Tone tracks the label: lime for
   *  fast ("good"), purple `attn` for slow (the palette's attention colour —
   *  there is no amber middle tone, so "Moderate" also reads neutral). */
  speedClass:   string;
  /** One-sentence "what this is" line shown under the provider name. */
  description:  string;
  /** Provider title colour. Now uniform: the three-accent palette can't
   *  carry six identity hues, so the name text itself is the identity. */
  titleClass:   string;
}

export const ENHANCE_PROVIDER_META: Record<EnhanceProvider, EnhanceProviderMeta> = {
  gemini: {
    speedLabel:  "Fast",
    speedClass:  "text-accent bg-panel border-accent",
    description: "Fastest and cheapest. Routes through gemini-3.1-flash-image-preview.",
    titleClass:  "text-ink",
  },
  openai: {
    speedLabel:  "Slow",
    speedClass:  "text-attn bg-panel border-attn",
    description: "Slower but can be more literal. gpt-5 reasons + dispatches the image_generation tool.",
    titleClass:  "text-ink",
  },
  grok: {
    speedLabel:  "Fast",
    speedClass:  "text-accent bg-panel border-accent",
    description: "xAI Grok image-edit — broad style transfer + photorealistic touch-ups via grok-imagine-image-quality.",
    titleClass:  "text-ink",
  },
};
