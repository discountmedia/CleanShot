// Root layout — fonts, global styles
import '@/styles/globals.css'
import type { Metadata } from 'next'
import { Archivo, Archivo_Black, IBM_Plex_Mono } from 'next/font/google'
import { Analytics } from '@vercel/analytics/next'
import { SpeedInsights } from '@vercel/speed-insights/next'

// House typefaces. Archivo Black = display (h1, section headings), Archivo =
// body, IBM Plex Mono = labels + metadata (filenames, sizes, ids, timings).
// Each exposes a CSS var that styles/globals.css reads in its @theme block,
// so the token layer stays the single source of truth for typography too.
const archivo = Archivo({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-archivo-src',
})

const archivoBlack = Archivo_Black({
  subsets: ['latin'],
  weight: '400',        // Archivo Black ships a single weight
  display: 'swap',
  variable: '--font-archivo-black-src',
})

const plexMono = IBM_Plex_Mono({
  subsets: ['latin'],
  weight: ['400', '600'],
  display: 'swap',
  variable: '--font-plex-mono-src',
})

export const metadata: Metadata = {
  // The logo carries "Discount Forklift", so the in-page <h1> is just the app
  // name — the full product name lives here in the document title instead.
  title: 'CleanShot — Discount Forklift',
  description: 'AI-powered forklift image processing',
  // Point both the modern <link rel="icon"> and the shortcut/Apple
  // touch slots at the new splash icon so the browser tab + bookmarks
  // pick it up. /favicon.ico is also overwritten with the same bytes
  // for any client that hits the legacy /favicon.ico path directly.
  icons: {
    icon: [
      { url: '/splash-ico.ico', sizes: 'any' },
    ],
    shortcut: '/splash-ico.ico',
    apple: '/splash-ico.ico',
  },
}

// Hints in <head> below — both target LCP by starting work earlier:
//   • preload  → the logo is rendered by the Header on every page; fetch
//                the bytes in parallel with the JS bundle download instead
//                of waiting for the <img> to mount.
//   • preconnect → every authenticated page-load hits /api/profile (via
//                  UserMenu) and /api/session (via Better Auth), which
//                  proxy through to the Cloud Run API at the URL below.
//                  Pre-establishing the TLS handshake cuts ~80-200ms off
//                  the first BFF call. crossOrigin attr is required for
//                  the preconnect to actually save the TLS round-trip.
const CLOUD_RUN_API_URL = "https://cleanshot-api-387208973244.us-central1.run.app";

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html
      lang="en"
      className={`${archivo.variable} ${archivoBlack.variable} ${plexMono.variable}`}
    >
      <head>
        <link rel="preload" as="image" href="/discount-forklift-logo.png" />
        <link rel="preconnect" href={CLOUD_RUN_API_URL} crossOrigin="anonymous" />
      </head>
      <body>
        {children}
        {/* Vercel Web Analytics — page-view + custom-event tracking.
            Auto-disabled in non-production / non-Vercel environments
            so local dev / preview don't pollute the prod dataset. */}
        <Analytics />
        {/* Vercel Speed Insights — Core Web Vitals (LCP, INP, CLS, FCP,
            TTFB) reported per route. Same auto-disable behaviour outside
            Vercel production as Analytics, so local dev doesn't ship
            beacons. Dashboard: Vercel project → Speed Insights tab. */}
        <SpeedInsights />
      </body>
    </html>
  )
}
