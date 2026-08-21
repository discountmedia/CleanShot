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
    /* Header is the DARKER plate (#131313) sitting on the #242424 page —
       three-level elevation, where cards go lighter (#2C2C2C) and the
       plates top and bottom go near-black. Not a mistake; it is the look.
       The divider is a neutral line: purple is reserved for primary
       buttons, and a red rule here would read as an error state. */
    <header className="bg-header-bg border-b border-line">
      {/* BETA banner — sits above the logo row so it's the first thing the
          operator sees on page load. Links to the user profile page where
          they can file a support ticket. Now PURPLE rather than amber or
          red: the palette has no amber, and red is reserved for genuinely
          destructive controls, so purple carries attention.
          Uses `attn` (light purple #B786C6) for text/border over a neutral
          panel — the CTA purples are fill-only and fail AA as text. */}
      <div className="bg-panel border-b border-attn">
        <div className="px-6 py-3.5 flex items-center justify-center gap-3 text-center flex-wrap">
          <span className="text-sm uppercase tracking-[0.18em] font-bold text-attn border border-attn rounded px-3 py-1 shrink-0">
            Beta V.2
          </span>
          <p className="text-base sm:text-lg font-semibold uppercase tracking-[0.12em] text-attn leading-snug">
            Site is currently in testing — bugs will be present.{" "}
            <Link
              href="/profile"
              className="font-bold text-accent underline hover:text-accent transition-colors"
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
            /* Intrinsic 1438×400 (3.6:1) → 48px tall → 173px wide, inside
               the house 44-52px header band. The wordmark is red with a
               black outline and white keyline, so it reads correctly
               straight on #131313 and needs no plate behind it.

               Explicit dims let the browser reserve space before the PNG
               bytes arrive, eliminating the load-time layout shift that
               was the dominant CLS contributor on / (Real Experience
               Score fix 2026-05-27). */
            width={173}
            height={48}
            className="h-12 w-auto block"
          />
        </Link>

        {/* Title block. The logo already says "Discount Forklift", so the
            <h1> is just the app name and there is deliberately NO
            "DISCOUNT FORKLIFT" text eyebrow above it — the full product
            name lives in the document <title> instead. One subheading
            line states what the app does. */}
        <div className="min-w-0">
          <div className="flex items-baseline gap-3 min-w-0">
            <h1 className="font-display text-3xl tracking-[0.14em] text-accent uppercase">
              CleanShot
            </h1>
            {subtitle && (
              <span className="text-sm text-ink-faint truncate font-mono">
                — {subtitle}
              </span>
            )}
          </div>
          <p className="text-sm text-ink-soft leading-snug mt-0.5">
            Turns used-equipment photos into clean, listing-ready images.
          </p>
        </div>

        {/* Utility actions */}
        <div className="ml-auto flex items-center gap-3">
          {isAdmin && (
            <Link
              href="/admin"
              className="text-sm uppercase tracking-[0.16em] font-bold text-accent hover:text-ink border-2 border-cta-dark hover:border-cta bg-panel hover:bg-cta-dark px-4 py-2 rounded transition-colors"
              aria-label="Open admin dashboard"
            >
              Admin
            </Link>
          )}
          {bypassed ? (
            <span className="text-sm uppercase tracking-[0.16em] font-bold text-attn border-2 border-attn px-4 py-2 rounded">
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
