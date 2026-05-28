// apps/web/flags.ts
// Vercel Flags SDK + PostHog adapter — server-side feature-flag
// evaluation.
//
// identify() resolves the current operator from the Better Auth session
// (the same getSessionEmail(await headers()) pattern the server pages
// use) so PostHog can target flags per-user by email. Falls back to
// "anonymous" pre-login or if the lookup fails (e.g. no DB at build
// time). Wrapped in dedupe() so the session is resolved at most once
// per request even when several flags evaluate.

import { postHogAdapter } from "@flags-sdk/posthog";
import { flag, dedupe } from "flags/next";
import type { Identify } from "flags";
import { headers } from "next/headers";

import { getSessionEmail } from "@/lib/auth";

export const identify = dedupe(async () => {
  try {
    const email = await getSessionEmail(await headers());
    if (email) return { distinctId: email };
  } catch {
    // Session lookup unavailable (build-time static eval, DB down, etc.)
    // — fall through to the anonymous distinctId.
  }
  return { distinctId: "anonymous" };
}) satisfies Identify<{ distinctId: string }>;

// Example flag. Rename `myFlag` + the `key` to match the flag you
// create in PostHog (Vercel dashboard → Open in PostHog → Feature
// Flags). The `key` string MUST exactly match the PostHog flag key, or
// it resolves to the flag's default/off.
export const myFlag = flag({
  key: "my-flag",
  adapter: postHogAdapter.isFeatureEnabled(),
  identify,
});
