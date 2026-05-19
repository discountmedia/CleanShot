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
    <div className="min-h-screen bg-zinc-950 flex items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-8">
        {/* Logo / wordmark */}
        <div className="text-center space-y-2">
          <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-blue-600 mb-4">
            <svg className="w-8 h-8 text-white" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.07 4h3.86a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5}
                d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
            </svg>
          </div>
          <h1 className="text-2xl font-bold text-white">CleanShot</h1>
          <p className="text-sm text-zinc-400">AI-powered forklift image processing</p>
        </div>

        {/* Sign-in card */}
        <div className="bg-zinc-900 border border-zinc-800 rounded-2xl p-6 space-y-4">
          <p className="text-sm text-zinc-400 text-center">
            Sign in with your Microsoft account to continue.
            Only authorized accounts can access CleanShot.
          </p>
          <LoginButton callbackUrl={callbackUrl} />
        </div>

        <p className="text-center text-xs text-zinc-700">
          Access restricted to authorized users only.
          Contact your administrator to request access.
        </p>
      </div>
    </div>
  );
}
