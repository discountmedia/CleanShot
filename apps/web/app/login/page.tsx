// apps/web/app/login/page.tsx
// Login page — Microsoft SSO only.
// Shows the "Sign in with Microsoft" button.
// AUTH_ENABLED=false → auto-redirects to app (bypass mode).

import { redirect } from "next/navigation";
import { headers } from "next/headers";
import { getSession } from "@/lib/auth";
import { LoginButton } from "@/components/auth/LoginButton";

interface Props {
  searchParams: Promise<{ callbackUrl?: string }>;
}

export default async function LoginPage({ searchParams }: Props) {
  const { callbackUrl } = await searchParams;

  // Auth off (default) → skip the login page entirely
  if (process.env.AUTH_ENABLED !== "true") {
    redirect(callbackUrl ?? "/");
  }

  // Already logged in → go to app
  const session = await getSession(await headers());
  if (session) {
    redirect(callbackUrl ?? "/");
  }

  return (
    <div className="min-h-screen bg-bg flex items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-8 relative">
        {/* Wordmark — centred at the house auth-screen size (~250px wide).
            The PNG is red with a black outline and a white keyline, so it
            reads correctly on the dark page with no plate behind it. It
            already carries "Discount Forklift", so the <h1> below is just
            the app name with no text eyebrow. */}
        <div className="text-center space-y-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- plain <img>; wide transparent PNG, next/image optimization isn't worth the config */}
          <img
            src="/discount-forklift-logo.png"
            alt="Discount Forklift"
            /* Intrinsic 1438×400 (3.6:1) → 250px wide → 70px tall. */
            width={250}
            height={70}
            className="inline-block h-auto mb-2"
          />
          <h1 className="font-display text-2xl text-accent tracking-[0.18em] uppercase">
            CleanShot
          </h1>
          <p className="text-sm text-ink-soft">
            Turns used-equipment photos into clean, listing-ready images.
          </p>
        </div>

        {/* Sign-in card. The top keyline is brand lime, not red — red in
            this palette means attention/error, and an error-coloured bar
            across the sign-in card reads as a failure state. */}
        <div className="bg-well border border-line rounded-2xl overflow-hidden">
          <div className="h-1 bg-accent" aria-hidden="true" />
          <div className="p-6 space-y-4">
            <p className="text-sm text-ink-soft text-center">
              Sign in with your Microsoft account to continue.
              Only authorized accounts can access CleanShot.
            </p>
            <LoginButton callbackUrl={callbackUrl} />
          </div>
        </div>

        <p className="text-center text-xs text-muted">
          Access restricted to authorized users only.
          Contact your administrator to request access.
        </p>

        {/* Attribution footer (same as workspace + admin) */}
        <p className="text-[10px] text-ink-faint text-center select-none">
          Developed by Stephen Cunningham © AI App Integrations LLC 2026
        </p>
      </div>
    </div>
  );
}
