// apps/web/lib/access-control.ts
// Per-user access restrictions for the Enhance tab, keyed by the
// authenticated Microsoft SSO email. Single source of truth — imported
// by both the client (UI gating) and the server (BFF enforcement +
// audit logging), so the UI and the real gate can never drift.
//
// Restrictions are ONLY active when AUTH_ENABLED=true. With auth off,
// the workspace runs as "dev@local", which isn't in the table below, so
// getRestriction() returns null and nothing is restricted.
//
// To add a restricted user: add one entry here + redeploy. (Config-file
// driven by design — no admin-panel toggle this round.)

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

// Emails are lowercased keys — getRestriction lowercases its input to
// match (Better Auth normalises session emails to lowercase too).
export const USER_RESTRICTIONS: Record<string, UserRestriction> = {
  "brian@discountforklift.us": {
    model: "grok",
    enhanceOnly: true,
    disableToggles: true,
    customPromptOnly: true,
    tracking: true,
  },
  "asia@discountforklift.us": {
    model: "gemini",
    enhanceOnly: true,
    disableToggles: true,
    customPromptOnly: true,
    tracking: true,
  },
  "aj@discountforklift.us": {
    model: "openai",
    enhanceOnly: true,
    disableToggles: true,
    customPromptOnly: true,
    tracking: true,
  },
  "stephen@discountforklift.us": {
    model: "kontext",
    enhanceOnly: true,
    disableToggles: true,
    customPromptOnly: true,
    tracking: true,
  },
};

/**
 * Returns the restriction for an email, or null if the user is
 * unrestricted (not in the table) or no email is present. Lowercases
 * the input so casing in the session / config never causes a miss.
 */
export function getRestriction(email: string | null | undefined): UserRestriction | null {
  if (!email) return null;
  return USER_RESTRICTIONS[email.toLowerCase()] ?? null;
}
