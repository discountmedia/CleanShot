// apps/web/app/api/_debug/auth-flag/route.ts
//
// TEMPORARY debug endpoint — confirms what the live Vercel runtime sees
// for AUTH_ENABLED. Returns no secrets. Delete this file after the
// SSO rollout is confirmed working.
//
// Usage:
//   curl https://cleanshot.vercel.app/api/_debug/auth-flag
//   → { value: "true", strict_equality_with_true: true, length: 4 }
//
// If `value` is null → env var isn't set on the active environment.
// If `value` is something other than the literal string "true" → that's
//   why the gate is bypassed (proxy.ts + page.tsx do `=== "true"`).

import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

export async function GET() {
  const raw = process.env.AUTH_ENABLED;
  const allowedDomains = process.env.ALLOWED_DOMAINS ?? null;
  const allowedEmails  = process.env.ALLOWED_EMAILS  ?? null;
  return NextResponse.json({
    auth_enabled: {
      value:                     raw ?? null,
      strict_equality_with_true: raw === "true",
      length:                    raw?.length ?? 0,
      char_codes:                raw ? Array.from(raw).map((c) => c.charCodeAt(0)) : null,
    },
    allowed_domains: {
      raw:        allowedDomains,
      parsed:     allowedDomains
        ? allowedDomains.split(",").map((d) => d.trim().toLowerCase()).filter(Boolean)
        : [],
      length:     allowedDomains?.length ?? 0,
      char_codes: allowedDomains ? Array.from(allowedDomains).map((c) => c.charCodeAt(0)) : null,
    },
    allowed_emails: {
      raw:    allowedEmails,
      parsed: allowedEmails
        ? allowedEmails.split(",").map((e) => e.trim().toLowerCase()).filter(Boolean)
        : [],
    },
    better_auth_url:  process.env.BETTER_AUTH_URL ?? null,
    node_env:         process.env.NODE_ENV ?? null,
    vercel_env:       process.env.VERCEL_ENV ?? null,
  });
}
