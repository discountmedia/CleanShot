"use client";
// apps/web/components/auth/UserMenu.tsx
// Shows authenticated user's email and a sign-out button.
// Renders nothing when AUTH_ENABLED=false (no session exists).

import { useState } from "react";
import { useSession, signOut } from "@/lib/auth-client";

export function UserMenu() {
  const { data: session } = useSession();
  const [signingOut, setSigningOut]   = useState(false);
  const [menuOpen, setMenuOpen]       = useState(false);

  if (!session?.user) return null;

  const email   = session.user.email ?? "";
  const initials = email.split("@")[0].slice(0, 2).toUpperCase();

  const handleSignOut = async () => {
    setSigningOut(true);
    await signOut({ fetchOptions: { onSuccess: () => { window.location.href = "/login"; } } });
  };

  return (
    <div className="relative">
      <button
        onClick={() => setMenuOpen((v) => !v)}
        className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-zinc-900 border border-zinc-800 hover:border-zinc-600 transition-colors"
        aria-expanded={menuOpen}
        aria-label="User menu"
      >
        <span className="w-6 h-6 rounded-full bg-blue-600 flex items-center justify-center text-[10px] font-bold text-white">
          {initials}
        </span>
        <span className="text-xs text-zinc-300 max-w-[140px] truncate hidden sm:block">{email}</span>
        <svg className={`w-3 h-3 text-zinc-500 transition-transform ${menuOpen ? "rotate-180" : ""}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {menuOpen && (
        <>
          {/* Backdrop */}
          <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} aria-hidden="true" />

          {/* Dropdown */}
          <div className="absolute right-0 mt-2 w-56 bg-zinc-900 border border-zinc-700 rounded-xl shadow-xl z-20 overflow-hidden">
            <div className="px-4 py-3 border-b border-zinc-800">
              <p className="text-xs text-zinc-500">Signed in as</p>
              <p className="text-sm text-white font-medium truncate mt-0.5">{email}</p>
            </div>
            <button
              onClick={handleSignOut}
              disabled={signingOut}
              className="w-full flex items-center gap-2 px-4 py-3 text-sm text-red-400 hover:bg-zinc-800 transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M17 16l4-4m0 0l-4-4m4 4H7m6 4v1a3 3 0 01-3 3H6a3 3 0 01-3-3V7a3 3 0 013-3h4a3 3 0 013 3v1" />
              </svg>
              {signingOut ? "Signing out…" : "Sign out"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
