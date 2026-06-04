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
 * Image-edit GENERATION provider. Flux 2 Max deliberately not in this
 * list — it's reserved for mask-based erase on completed variants
 * (see lib/api.ts enqueueErase) rather than full-image generation.
 * The Kontext slot is BFL's identity-preserving flux-1-kontext/max
 * via the RunComfy proxy — same vendor as the erase tool but
 * different model family. Ideogram joined as a 5th option for its
 * typography strength on OEM decals + model numbers; same underlying
 * /v1/edit endpoint as the per-variant Ideogram Edit tool. Reve is
 * the 6th option — synchronous /v1/image/edit; auto-enhances the
 * instruction internally for a distinct creative voice.
 */
export type EnhanceProvider = "gemini" | "openai" | "grok" | "kontext" | "ideogram" | "reve";

export const ENHANCE_PROVIDERS: readonly EnhanceProvider[] = [
  "gemini",
  "openai",
  "grok",
  "kontext",
  "ideogram",
  "reve",
] as const;

export const ENHANCE_PROVIDER_LABELS: Record<EnhanceProvider, string> = {
  gemini:   "Gemini",
  openai:   "OpenAI",
  grok:     "Grok",
  kontext:  "Kontext",
  ideogram: "Ideogram",
  reve:     "Reve",
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

// Authors offered under "Tailored for <generator>" per card. Edit-style models
// have all four; the namesake generators (gemini/openai/grok) carry only their
// own author. Mirrors TAILORED_AUTHORS in master_prompts.py.
export const TAILORED_AUTHORS_BY_GENERATOR: Record<EnhanceProvider, PromptAuthor[]> = {
  kontext:  ["claude", "gemini", "openai", "grok"],
  ideogram: ["claude", "gemini", "openai", "grok"],
  reve:     ["claude", "gemini", "openai", "grok"],
  gemini:   ["gemini"],
  openai:   ["openai"],
  grok:     ["grok"],
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
 * Per-provider chip classes when SELECTED (i.e. checkbox / variant footer
 * highlighted). Matches the saturated `bg-*-950/40 text-*-300 border-*-800`
 * vocabulary the rest of the app uses.
 */
export const ENHANCE_PROVIDER_CHIP_ON: Record<EnhanceProvider, string> = {
  gemini:   "bg-blue-950/40 text-blue-300 border-blue-800",
  openai:   "bg-green-950/40 text-green-300 border-green-800",
  grok:     "bg-orange-950/40 text-orange-300 border-orange-800",
  kontext:  "bg-purple-950/40 text-purple-300 border-purple-800",
  ideogram: "bg-cyan-950/40 text-cyan-300 border-cyan-800",
  reve:     "bg-fuchsia-950/40 text-fuchsia-300 border-fuchsia-800",
};

/**
 * Per-provider descriptive metadata — speed pill copy + classes + the
 * one-line "what this is" description that used to live in the verbose
 * checkbox card stack. Restored to the redesigned ProviderRow so the
 * operator still sees latency expectations and routing details.
 */
export interface EnhanceProviderMeta {
  speedLabel:   "Fast" | "Fastest" | "Moderate" | "Slow";
  /** Tailwind classes for the speed pill. Tone tracks the label (emerald for fast, amber moderate, red slow). */
  speedClass:   string;
  /** One-sentence "what this is" line shown under the provider name. */
  description:  string;
  /** Per-provider title colour class — keeps each model visually distinct
   *  on the provider chip card (the operator explicitly asked for this). */
  titleClass:   string;
}

export const ENHANCE_PROVIDER_META: Record<EnhanceProvider, EnhanceProviderMeta> = {
  gemini: {
    speedLabel:  "Fast",
    speedClass:  "text-emerald-300 bg-emerald-950/60 border-emerald-800",
    description: "Fastest and cheapest. Routes through gemini-3.1-flash-image-preview.",
    titleClass:  "text-sky-300",
  },
  openai: {
    speedLabel:  "Slow",
    speedClass:  "text-red-300 bg-red-950/60 border-red-800",
    description: "Slower but can be more literal. gpt-5 reasons + dispatches the image_generation tool.",
    titleClass:  "text-emerald-300",
  },
  grok: {
    speedLabel:  "Fast",
    speedClass:  "text-emerald-300 bg-emerald-950/60 border-emerald-800",
    description: "xAI Grok image-edit — broad style transfer + photorealistic touch-ups via grok-imagine-image-quality.",
    titleClass:  "text-orange-300",
  },
  kontext: {
    speedLabel:  "Moderate",
    speedClass:  "text-amber-300 bg-amber-950/60 border-amber-800",
    description: "BFL Flux Kontext Max (via RunComfy) — purpose-built for identity-preserving edits. Strong on subject continuity.",
    titleClass:  "text-fuchsia-300",
  },
  ideogram: {
    speedLabel:  "Fastest",
    speedClass:  "text-emerald-200 bg-emerald-900/70 border-emerald-600",
    description: "Ideogram 3.0 /v1/edit — typography-strong, best when the unit has visible OEM decals, model numbers, or signage to preserve.",
    titleClass:  "text-cyan-300",
  },
  reve: {
    speedLabel:  "Fast",
    speedClass:  "text-emerald-200 bg-emerald-900/70 border-emerald-600",
    description: "Reve image-edit (latest-fast) — synchronous /v1/image/edit; auto-enhances the instruction internally for a distinct creative voice.",
    titleClass:  "text-fuchsia-300",
  },
};
