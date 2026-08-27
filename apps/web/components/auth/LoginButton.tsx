"use client";
// apps/web/components/auth/LoginButton.tsx
// Microsoft sign-in button — uses Better Auth client.

import { useState } from "react";
import { signIn } from "@/lib/auth-client";

export function LoginButton({ callbackUrl }: { callbackUrl?: string }) {
  const [loading, setLoading] = useState(false);
  const [error, setError]     = useState<string | null>(null);

  const handleSignIn = async () => {
    setLoading(true);
    setError(null);
    try {
      await signIn.social({
        provider: "microsoft",
        callbackURL: callbackUrl ?? "/",
        // Failed auth (e.g. unauthorized email) lands on /unauthorized
        // with the reason in ?error= rather than a broken redirect.
        errorCallbackURL: "/unauthorized",
      });
    } catch {
      setError("Sign-in failed. Please try again.");
      setLoading(false);
    }
  };

  return (
    <div className="space-y-3">
      <button
        onClick={handleSignIn}
        disabled={loading}
        className={`
          w-full flex items-center justify-center gap-3 py-3 px-4 rounded-xl
          font-medium text-sm transition-all border
          ${loading
            ? "bg-panel-hi border-line text-muted cursor-not-allowed"
            : "bg-white border-white text-header-bg hover:bg-white/90 shadow-lg"}
        `}
        aria-busy={loading}
      >
        {/* Microsoft logo */}
        <svg width="20" height="20" viewBox="0 0 21 21" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
          <rect x="1"  y="1"  width="9" height="9" fill="#F25022"/>
          <rect x="11" y="1"  width="9" height="9" fill="#7FBA00"/>
          <rect x="1"  y="11" width="9" height="9" fill="#00A4EF"/>
          <rect x="11" y="11" width="9" height="9" fill="#FFB900"/>
        </svg>
        {loading ? "Signing in…" : "Sign in with Microsoft"}
      </button>

      {error && (
        <p className="text-xs text-attn text-center" role="alert">{error}</p>
      )}
    </div>
  );
}
