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
 * Image-edit GENERATION provider. Flux deliberately not in this list
 * any more — it's reserved for mask-based erase on completed variants
 * (see lib/api.ts enqueueErase) rather than full-image generation.
 */
export type EnhanceProvider = "gemini" | "openai" | "grok" | "seedream";

export const ENHANCE_PROVIDERS: readonly EnhanceProvider[] = [
  "gemini",
  "openai",
  "grok",
  "seedream",
] as const;

export const ENHANCE_PROVIDER_LABELS: Record<EnhanceProvider, string> = {
  gemini:   "Gemini",
  openai:   "OpenAI",
  grok:     "Grok",
  seedream: "Seedream",
};

/**
 * Per-provider chip classes when SELECTED (i.e. checkbox / variant footer
 * highlighted). Matches the saturated `bg-*-950/40 text-*-300 border-*-800`
 * vocabulary the rest of the app uses.
 */
export const ENHANCE_PROVIDER_CHIP_ON: Record<EnhanceProvider, string> = {
  gemini:   "bg-blue-950/40 text-blue-300 border-blue-800",
  openai:   "bg-green-950/40 text-green-300 border-green-800",
  grok:     "bg-orange-950/40 text-orange-300 border-orange-800",
  seedream: "bg-pink-950/40 text-pink-300 border-pink-800",
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
  /** True if the provider got a "New" tag in the prior verbose layout. */
  isNew:        boolean;
}

export const ENHANCE_PROVIDER_META: Record<EnhanceProvider, EnhanceProviderMeta> = {
  gemini: {
    speedLabel:  "Fast",
    speedClass:  "text-emerald-300 bg-emerald-950/60 border-emerald-800",
    description: "Fastest and cheapest. Routes through gemini-3.1-flash-image-preview.",
    isNew:       false,
  },
  openai: {
    speedLabel:  "Slow",
    speedClass:  "text-red-300 bg-red-950/60 border-red-800",
    description: "Slower but can be more literal. gpt-5 reasons + dispatches the image_generation tool.",
    isNew:       false,
  },
  grok: {
    speedLabel:  "Fastest",
    speedClass:  "text-emerald-200 bg-emerald-900/70 border-emerald-600",
    description: "xAI Grok image-edit — broad style transfer + photorealistic touch-ups via grok-imagine-image-quality.",
    isNew:       true,
  },
  seedream: {
    speedLabel:  "Moderate",
    speedClass:  "text-amber-300 bg-amber-950/60 border-amber-800",
    description: "Bytedance Seedream 4.5 (via RunComfy) — async polling, strong on photorealistic detail preservation.",
    isNew:       true,
  },
};
