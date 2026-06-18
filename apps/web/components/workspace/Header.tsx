// apps/web/components/workspace/Header.tsx
// Top header — Discount Forklift logo + CleanShot title + utility actions.
// Mirrors the header pattern from the company's other internal apps.

import Link from "next/link";

import { UserMenu } from "@/components/auth/UserMenu";

interface HeaderProps {
  /** Optional subtitle shown after the title (e.g., active batch filename) */
  subtitle?: string;
  /** When auth is bypassed (AUTH_ENABLED=false), show a dev-mode tag in place of UserMenu */
  bypassed?: boolean;
  /** When true, render the Admin link next to the user menu. Decided server-side. */
  isAdmin?: boolean;
}

export function Header({
  subtitle,
  bypassed = false,
  isAdmin = false,
}: HeaderProps) {
  return (
    <header className="bg-black border-b-2 border-brand-500">
      {/* BETA banner — sits above the logo row so it's the first thing
          the operator sees on page load. Links to the user profile page
          where they can file a support ticket. Amber striped to read as
          informational/warning without competing with the brand-red
          underline below the main header strip. Enlarged 2026-05-27 per
          operator request so the testing notice is unmissable. */}
      <div className="bg-amber-950/40 border-b border-amber-900">
        <div className="px-6 py-3.5 flex items-center justify-center gap-3 text-center flex-wrap">
          <span className="text-sm uppercase tracking-[0.18em] font-bold text-amber-300 bg-amber-900/60 border border-amber-700 rounded px-3 py-1 shrink-0">
            Beta V.1
          </span>
          <p className="text-base sm:text-lg font-semibold uppercase tracking-[0.12em] text-amber-100 leading-snug">
            Site is currently in testing — bugs will be present.{" "}
            <Link
              href="/profile"
              className="font-bold text-brand-400 underline hover:text-brand-300 transition-colors"
            >
              Send a support ticket through the user profile page
            </Link>{" "}
            to report bugs or request features.
          </p>
        </div>
      </div>

      <div className="flex items-center px-6 py-3 gap-5">
        {/* Logo block */}
        <Link href="/" className="shrink-0" aria-label="CleanShot home">
          {/* eslint-disable-next-line @next/next/no-img-element -- intentional plain <img>; logo is small + transparent PNG so next/image optimization isn't worth the config */}
          <img
            src="/discount-forklift-logo.png"
            alt="Discount Forklift"
            /* Intrinsic 1438×400 → 64px tall → 230px wide. Explicit
               dims let the browser reserve space before the PNG bytes
               arrive, eliminating the load-time layout shift that was
               showing up as the dominant CLS contributor on /
               (Real Experience Score fix 2026-05-27). */
            width={230}
            height={64}
            className="h-16 w-auto block"
          />
        </Link>

        {/* Title + filename. "CleanShot" enlarged 2026-05-27 so it reads
            as a co-equal brand mark next to the Discount Forklift logo
            instead of fine print. */}
        <div className="flex items-baseline gap-3 min-w-0">
          <h1 className="text-3xl font-extrabold tracking-[0.14em] text-acid uppercase">
            CleanShot
          </h1>
          {subtitle && (
            <span className="text-sm text-zinc-500 truncate font-mono">
              — {subtitle}
            </span>
          )}
        </div>

        {/* Utility actions */}
        <div className="ml-auto flex items-center gap-3">
          {isAdmin && (
            <Link
              href="/admin"
              className="text-sm uppercase tracking-[0.16em] font-bold text-brand-300 hover:text-white border-2 border-brand-700 hover:border-brand-500 bg-brand-900/40 hover:bg-brand-700/40 px-4 py-2 rounded transition-colors"
              aria-label="Open admin dashboard"
            >
              Admin
            </Link>
          )}
          {bypassed ? (
            <span className="text-sm uppercase tracking-[0.16em] font-bold text-amber-300 border-2 border-amber-700 px-4 py-2 rounded">
              Dev bypass
            </span>
          ) : (
            <UserMenu />
          )}
        </div>
      </div>
    </header>
  );
}
