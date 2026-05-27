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

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
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
