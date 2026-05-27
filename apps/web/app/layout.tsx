// Root layout — fonts, global styles
// TODO: add Inter font via next/font/google
import '@/styles/globals.css'
import type { Metadata } from 'next'
import { Analytics } from '@vercel/analytics/next'
import { SpeedInsights } from '@vercel/speed-insights/next'

export const metadata: Metadata = {
  title: 'CleanShot',
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
    <html lang="en">
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
