/**
 * Self-hosted fonts via next/font/google.
 *
 * Two faces:
 *   - Anton (display): heavy condensed sans for giant numerics. Closest free
 *     analog of Druk Wide. If you license Druk later, swap this import for a
 *     localFont() call against /public/fonts/druk-*.woff2.
 *   - JetBrains Mono: UI labels, body, code. Tracked uppercase via Tailwind
 *     utility tracking-track / tracking-wide.
 *
 * next/font self-hosts these at build time so there's no FOIT/FOUT and no
 * layout shift on first paint.
 */
import { Anton, JetBrains_Mono } from "next/font/google";

export const fontDisplay = Anton({
  subsets: ["latin"],
  weight: "400",
  variable: "--font-display",
  display: "swap",
});

export const fontMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-mono",
  display: "swap",
});
