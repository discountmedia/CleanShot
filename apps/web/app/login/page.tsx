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
    <div className="min-h-screen bg-black flex items-center justify-center p-4">
      {/* Subtle red glow behind the logo to match the red-accent
          treatment the rest of the app uses (Header border, admin
          badge, send-to-resize button). */}
      <div className="w-full max-w-sm space-y-8 relative">
        {/* Logo / wordmark */}
        <div className="text-center space-y-3">
          {/* eslint-disable-next-line @next/next/no-img-element -- plain <img>; logo is a circular PNG with transparency, next/image optimization isn't worth the config */}
          <img
            src="/cleanshot-logo.png"
            alt="CleanShot"
            className="inline-block w-24 h-24 rounded-full mb-2 shadow-lg shadow-red-900/40"
          />
          <h1 className="text-2xl font-bold text-white tracking-[0.18em] uppercase">
            CleanShot
          </h1>
          <p className="text-sm text-zinc-500">AI-powered forklift image processing</p>
        </div>

        {/* Sign-in card — black with a red top accent matching the
            site Header's red-600 underline. */}
        <div className="bg-zinc-950 border border-zinc-800 rounded-2xl overflow-hidden">
          <div className="h-1 bg-red-600" aria-hidden="true" />
          <div className="p-6 space-y-4">
            <p className="text-sm text-zinc-400 text-center">
              Sign in with your Microsoft account to continue.
              Only authorized accounts can access CleanShot.
            </p>
            <LoginButton callbackUrl={callbackUrl} />
          </div>
        </div>

        <p className="text-center text-xs text-zinc-700">
          Access restricted to authorized users only.
          Contact your administrator to request access.
        </p>

        {/* Attribution footer (same as workspace + admin) */}
        <p className="text-[10px] text-zinc-800 text-center select-none">
          Developed by Stephen Cunningham © AI App Integrations LLC 2026
        </p>
      </div>
    </div>
  );
}
