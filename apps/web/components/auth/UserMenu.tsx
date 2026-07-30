"use client";
// apps/web/components/auth/UserMenu.tsx
// Shows authenticated user's email and a sign-out button.
// Renders nothing when AUTH_ENABLED=false (no session exists).

import Link from "next/link";
import { useEffect, useState } from "react";
import { useSession, signOut } from "@/lib/auth-client";

// Per-user avatar fallback when the profile row doesn't have a custom
// uploaded image yet. Email keys are lowercased to match how Better
// Auth normalises the session. profile.avatarUrl from /api/profile
// takes precedence — this map is just the "before the operator uploads
// their own" default for a known account.
const USER_AVATARS: Record<string, string> = {
  "stephen@discountforklift.us": "/sukuna-avatar.png",
};

export function UserMenu() {
  const { data: session, isPending } = useSession();
  const [signingOut, setSigningOut] = useState(false);
  const [menuOpen,   setMenuOpen]   = useState(false);
  const [profileAvatarUrl, setProfileAvatarUrl] = useState<string | null>(null);

  // Lazy-load the user's profile so we can show their uploaded avatar.
  // /api/profile lazy-creates the row on first read, so this is safe
  // to call as a side effect every mount.
  useEffect(() => {
    if (!session?.user) return;
    let cancelled = false;
    fetch("/api/profile", { cache: "no-store" })
      .then((r) => (r.ok ? r.json() : null))
      .then((p: { avatarUrl?: string | null } | null) => {
        if (!cancelled) setProfileAvatarUrl(p?.avatarUrl ?? null);
      })
      .catch(() => { /* keep silent — fall back to map / initials */ });
    return () => { cancelled = true; };
  }, [session?.user?.email]);

  // While useSession is resolving (initial mount + cookie -> session
  // hydration round-trip), render a skeleton matching the resolved
  // UserMenu's footprint. Without this we'd return null → the header
  // shifts horizontally when UserMenu pops in a few hundred ms later,
  // which was the dominant remaining CLS contributor after the
  // avatar-dims fix in 00cf91e. (Real Experience Score fix layer 2.)
  if (isPending) {
    return (
      <div
        className="flex items-center gap-3 px-4 py-2 rounded-lg bg-panel border-2 border-line"
        aria-hidden="true"
      >
        <span className="w-9 h-9 rounded-full bg-panel-hi" />
        <span className="hidden sm:block w-32 h-4 rounded bg-panel-hi" />
      </div>
    );
  }

  if (!session?.user) return null;

  const email    = session.user.email ?? "";
  const initials = email.split("@")[0].slice(0, 2).toUpperCase();
  // Precedence: uploaded avatar (DB) → hardcoded fallback → initials.
  const avatarUrl = profileAvatarUrl ?? USER_AVATARS[email.toLowerCase()];

  const handleSignOut = async () => {
    setSigningOut(true);
    await signOut({ fetchOptions: { onSuccess: () => { window.location.href = "/login"; } } });
  };

  return (
    <div className="relative">
      <button
        onClick={() => setMenuOpen((v) => !v)}
        className="flex items-center gap-3 px-4 py-2 rounded-lg bg-panel border-2 border-line hover:border-ink-faint transition-colors"
        aria-expanded={menuOpen}
        aria-label="User menu"
      >
        {avatarUrl ? (
          /* eslint-disable-next-line @next/next/no-img-element -- small avatar, next/image overhead isn't worth it */
          <img
            src={avatarUrl}
            alt=""
            width={36}
            height={36}
            className="w-9 h-9 rounded-full object-cover bg-panel-hi"
          />
        ) : (
          /* Initials fallback shares the avatar's exact 36×36 footprint
             so swapping in the real <img> after the /api/profile fetch
             resolves doesn't shift the header layout. Without explicit
             width/height on the <img>, the browser couldn't reserve
             space before the image bytes arrived → CLS spike each
             page-load. (Real Experience Score fix 2026-05-27.) */
          <span className="w-9 h-9 rounded-full bg-panel-hi flex items-center justify-center text-sm font-bold text-ink">
            {initials}
          </span>
        )}
        <span className="text-base text-ink font-bold max-w-45 truncate hidden sm:block">{email}</span>
        <svg className={`w-4 h-4 text-ink-soft transition-transform ${menuOpen ? "rotate-180" : ""}`}
          fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {menuOpen && (
        <>
          {/* Backdrop */}
          <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} aria-hidden="true" />

          {/* Dropdown */}
          <div className="absolute right-0 mt-2 w-56 bg-panel border border-line rounded-xl shadow-xl z-20 overflow-hidden">
            <div className="px-4 py-3 border-b border-line">
              <p className="text-xs text-ink-faint">Signed in as</p>
              <p className="text-sm text-ink font-medium truncate mt-0.5">{email}</p>
            </div>
            <Link
              href="/profile"
              onClick={() => setMenuOpen(false)}
              className="w-full flex items-center gap-2 px-4 py-3 text-sm text-ink hover:bg-panel-hi border-b border-line transition-colors"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                  d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
              </svg>
              My profile
            </Link>
            <button
              onClick={handleSignOut}
              disabled={signingOut}
              className="w-full flex items-center gap-2 px-4 py-3 text-sm text-danger-ink hover:bg-panel-hi transition-colors"
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
