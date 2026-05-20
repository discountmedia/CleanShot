// apps/web/lib/types-enhance.ts
// Shared types for the Enhance tab. Pulled out of EnhancePanel.tsx so the
// new compare-card components (SourceCompareCard, ProviderRow, etc.) can
// share the Provider literal without circular-importing the panel.

/**
 * AI provider used for image enhancement. Pinned to the backend
 * `EnhanceTaskPayload.provider` literal in
 * apps/api/src/cleanshot_api/models/schemas.py.
 */
export type EnhanceProvider = "gemini" | "openai" | "flux" | "reve" | "grok";

export const ENHANCE_PROVIDERS: readonly EnhanceProvider[] = [
  "gemini",
  "openai",
  "grok",
  "flux",
  "reve",
] as const;

export const ENHANCE_PROVIDER_LABELS: Record<EnhanceProvider, string> = {
  gemini: "Gemini",
  openai: "OpenAI",
  flux:   "Flux",
  reve:   "Reve",
  grok:   "Grok",
};

/**
 * Per-provider chip classes when SELECTED (i.e. checkbox / variant footer
 * highlighted). Matches the saturated `bg-*-950/40 text-*-300 border-*-800`
 * vocabulary the rest of the app uses.
 */
export const ENHANCE_PROVIDER_CHIP_ON: Record<EnhanceProvider, string> = {
  gemini: "bg-blue-950/40 text-blue-300 border-blue-800",
  openai: "bg-green-950/40 text-green-300 border-green-800",
  flux:   "bg-purple-950/40 text-purple-300 border-purple-800",
  reve:   "bg-fuchsia-950/40 text-fuchsia-300 border-fuchsia-800",
  grok:   "bg-orange-950/40 text-orange-300 border-orange-800",
};
