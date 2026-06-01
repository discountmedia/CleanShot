// apps/web/lib/access-control.ts
// Per-user access restrictions — DEFANGED 2026-06-01.
//
// CleanShot scrapped per-model selection in favor of a single
// one-size-fits-all model (Gemini). With no per-user model locks left,
// USER_RESTRICTIONS is now empty and getRestriction() always returns
// null. The interface + function are preserved so existing callers
// (Workspace / EnhancePanel / MetaCard / /api/enhance) keep compiling
// without churn — they all already handle the null case as the
// unrestricted path. Re-introduce entries here if a future per-user
// gate is needed.

import type { EnhanceProvider } from "./types-enhance";

export interface UserRestriction {
  /** The single AI model this user is locked to. Every other model is hidden. */
  model: EnhanceProvider;
  /** Restrict the UI to the Enhance tab only — all other tabs hidden. */
  enhanceOnly: boolean;
  /** Feature toggles disabled + non-interactive. */
  disableToggles: boolean;
  /** Custom prompt is the only active input, auto-expanded on load. */
  customPromptOnly: boolean;
  /** Every prompt + result for this user is written to the admin audit log. */
  tracking: boolean;
}

export const USER_RESTRICTIONS: Record<string, UserRestriction> = {};

export function getRestriction(_email: string | null | undefined): UserRestriction | null {
  return null;
}
