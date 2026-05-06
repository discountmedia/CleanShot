import type { Metadata } from "next";
import Link from "next/link";
import { JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Providers } from "./providers";
import { TabNav } from "@/components/TabNav";

/**
 * Single typeface for the entire app — matches the existing Discount Forklift
 * internal tooling. Loaded via next/font/google for self-hosting + perf.
 */
const jetbrains = JetBrains_Mono({
  subsets: ["latin"],
  display: "swap",
  weight: ["400", "500", "600", "700"],
  variable: "--font-jetbrains",
});

export const metadata: Metadata = {
  title: "CleanShot — Discount Forklift",
  description: "Forklift photo enhancement, scan, and resize",
};

/**
 * Root layout — Server Component.
 *
 * Header pattern (mirrors Daily Activity / Inventory Dashboard):
 *   1. Top bar — DF logo + " CLEANSHOT " uppercase mono label
 *   2. Thin red horizontal divider
 *   3. Tab bar — ENHANCE / SCAN / RESIZE with red active state
 *   4. Page content
 *   5. Faint footer with build identifier
 */
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={jetbrains.variable}>
      <body>
        <Providers>
          <div className="flex min-h-screen flex-col bg-surface-base">
            {/* Top bar */}
            <div className="bg-surface-base">
              <div className="mx-auto flex max-w-7xl items-center justify-between gap-6 px-6 pt-5 pb-3">
                <div className="flex items-center gap-4">
                  <Link
                    href="/"
                    aria-label="Discount Forklift — Home"
                    className="block shrink-0"
                  >
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src="/df-logo.png"
                      alt="Discount Forklift"
                      className="h-8 w-auto"
                    />
                  </Link>
                  <div className="hidden items-center gap-3 sm:flex">
                    <span className="text-sm font-semibold uppercase tracking-label text-ink">
                      CleanShot
                    </span>
                    <span className="text-xs uppercase tracking-label text-ink-faint">
                      — forklift photo pipeline
                    </span>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <span className="hidden items-center gap-2 rounded border border-line bg-surface-card px-3 py-1.5 text-xs uppercase tracking-label text-ink-muted sm:inline-flex">
                    <span className="h-1.5 w-1.5 rounded-full bg-status-pass" aria-hidden />
                    {formatToday()}
                  </span>
                </div>
              </div>

              {/* Brand red divider */}
              <div className="h-px w-full bg-df-red/80" />
            </div>

            {/* Tab bar — sits below the divider on its own row */}
            <div className="border-b border-line-subtle bg-surface-base">
              <div className="mx-auto flex max-w-7xl items-center px-6">
                <TabNav />
              </div>
            </div>

            {/* Page content */}
            <main className="mx-auto w-full max-w-7xl flex-1 px-6 py-8">
              {children}
            </main>

            <footer className="border-t border-line-subtle bg-surface-base">
              <div className="mx-auto max-w-7xl px-6 py-3 text-[10px] uppercase tracking-label text-ink-faint">
                CleanShot · Phase 3 build · App Router
              </div>
            </footer>
          </div>
        </Providers>
      </body>
    </html>
  );
}

/**
 * Formats today's date as "MAY 06 · 2026" to match the date pill in the
 * dashboard screenshots. Server-rendered so it's stable per request.
 */
function formatToday(): string {
  const d = new Date();
  const month = d.toLocaleString("en-US", { month: "short" }).toUpperCase();
  const day = String(d.getDate()).padStart(2, "0");
  return `${month} ${day} · ${d.getFullYear()}`;
}
