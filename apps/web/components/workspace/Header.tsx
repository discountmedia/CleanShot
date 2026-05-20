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
      <div className="flex items-center px-6 py-3 gap-5">
        {/* Logo block */}
        <Link href="/" className="shrink-0" aria-label="CleanShot home">
          {/* eslint-disable-next-line @next/next/no-img-element -- intentional plain <img>; logo is small + transparent PNG so next/image optimization isn't worth the config */}
          <img
            src="/discount-forklift-logo.png"
            alt="Discount Forklift"
            className="h-9 w-auto block"
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
          {/* Auto-advance toggle — sits before the user chip so it's the
              first thing the operator sees in the right cluster. Off by
              default; flipping it on auto-flows picked Enhance winners
              into the Scan tab without an explicit Send click. */}
          {showAutoAdvance && (
            <button
              type="button"
              onClick={() => onAutoAdvance!(!autoAdvance)}
              aria-pressed={autoAdvance}
              title={autoAdvance
                ? "Picked winners auto-flow to Scan and approved scans auto-flow to Resize"
                : "Click to let picked winners auto-flow into Scan as you make them"}
              className={`group flex items-center gap-2.5 px-3 py-1.5 rounded-md border transition-colors ${
                autoAdvance
                  ? "border-red-900 bg-red-950/30 hover:border-red-700"
                  : "border-zinc-800 bg-zinc-950 hover:border-zinc-700"
              }`}
            >
              <span className="text-[10px] uppercase tracking-[0.18em] font-semibold text-zinc-400 group-hover:text-zinc-200">
                Auto-advance
              </span>
              <span className={`relative w-7 h-4 rounded-full transition-colors ${autoAdvance ? "bg-red-600" : "bg-zinc-700"}`}>
                <span className={`absolute top-0.5 left-0.5 w-3 h-3 rounded-full bg-white transition-transform ${autoAdvance ? "translate-x-3" : ""}`} />
              </span>
            </button>
          )}
          {isAdmin && (
            <Link
              href="/admin"
              className="text-[10px] uppercase tracking-[0.18em] font-semibold text-red-400 hover:text-red-300 border border-red-900 hover:border-red-700 bg-red-950/30 px-2 py-1 rounded transition-colors"
              aria-label="Open admin dashboard"
            >
              Admin
            </Link>
          )}
          {bypassed ? (
            <span className="text-[10px] uppercase tracking-[0.18em] text-amber-500 border border-amber-700 px-2 py-1 rounded">
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
