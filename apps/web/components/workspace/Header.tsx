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
}

export function Header({ subtitle, bypassed = false }: HeaderProps) {
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
