// apps/web/lib/pricing.ts
// Per-provider duration constants used by the Enhance tab's variant
// progress bars and the provider chip's "~Ns" hint. Calibrated on the
// current pipeline; raise these if real p95 grows.
//
// Cost constants intentionally not exposed here — the redesign drops the
// dollar-amount preview in favor of letting Cloud billing be the source
// of truth for spend.

import type { EnhanceProvider } from "./types-enhance";

/**
 * Wall-clock seconds the operator should expect, per provider. Drives the
 * "~Ns" tag on each provider chip and the elapsed-vs-expected progress
 * estimate on the variant thumbnails.
 */
export const ENHANCE_PROVIDER_DURATION_S: Record<EnhanceProvider, number> = {
  gemini:   20,
  openai:   75,
  grok:     30,
  kontext:  40,
  ideogram: 25,
  reve:     20,
};
