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
  /**
   * Workspace-scoped auto-advance toggle. When ON, picked winners on the
   * Enhance tab flow into Scan automatically; when OFF (default), the
   * operator confirms each hand-off via the CommandBar's primary CTA.
   */
  autoAdvance?: boolean;
  onAutoAdvance?: (v: boolean) => void;
}

export function Header({
  subtitle,
  bypassed = false,
  isAdmin = false,
  autoAdvance,
  onAutoAdvance,
}: HeaderProps) {
  const showAutoAdvance = typeof autoAdvance === "boolean" && typeof onAutoAdvance === "function";
  return (
    <header className="bg-black border-b-2 border-red-600">
      {/* BETA banner — sits above the logo row so it's the first thing
          the operator sees on page load. Links to the user profile page
          where they can file a support ticket. Amber striped to read as
          informational/warning without competing with the brand-red
          underline below the main header strip. */}
      <div className="bg-amber-950/40 border-b border-amber-900">
        <div className="px-6 py-2 flex items-center justify-center gap-3 text-center flex-wrap">
          <span className="text-[10px] uppercase tracking-[0.18em] font-bold text-amber-300 bg-amber-900/60 border border-amber-700 rounded px-2 py-0.5 shrink-0">
            Beta V.1
          </span>
          <p className="text-xs sm:text-sm font-semibold uppercase tracking-[0.12em] text-amber-100 leading-snug">
            Site is currently in testing — bugs will be present.{" "}
            <Link
              href="/profile"
              className="underline decoration-amber-500 hover:text-white hover:decoration-amber-300 transition-colors"
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
            className="h-16 w-auto block"
          />
        </Link>

        {/* Title + filename */}
        <div className="flex items-baseline gap-3 min-w-0">
          <h1 className="text-sm font-bold tracking-[0.18em] text-white uppercase">
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
          {/* Auto-advance toggle — disabled during beta testing.
              Visually present so operators know the feature exists, but
              the click is no-op and the tooltip explains why. Once
              auto-advance graduates from beta, drop the `disabled` prop
              + the "Not available during beta testing" copy + restore
              the onClick to onAutoAdvance!(!autoAdvance). */}
          {showAutoAdvance && (
            <button
              type="button"
              disabled
              aria-pressed={false}
              aria-disabled="true"
              title="Auto-advance — not available during beta testing"
              className="group flex items-center gap-3 px-4 py-2 rounded-md border-2 border-zinc-800 bg-zinc-950/60 cursor-not-allowed opacity-50"
            >
              <span className="text-sm uppercase tracking-[0.16em] font-bold text-zinc-500">
                Auto-advance
              </span>
              <span className="relative w-9 h-5 rounded-full bg-zinc-700">
                <span className="absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-zinc-400" />
              </span>
              <span className="text-xs uppercase tracking-[0.14em] font-extrabold text-amber-400 ml-1">
                Beta
              </span>
            </button>
          )}
          {isAdmin && (
            <Link
              href="/admin"
              className="text-sm uppercase tracking-[0.16em] font-bold text-red-300 hover:text-white border-2 border-red-700 hover:border-red-500 bg-red-950/40 hover:bg-red-900/50 px-4 py-2 rounded transition-colors"
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
