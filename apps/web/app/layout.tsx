// Root layout — fonts, global styles
// TODO: add Inter font via next/font/google
import '@/styles/globals.css'
import type { Metadata } from 'next'
import { Analytics } from '@vercel/analytics/next'

export const metadata: Metadata = {
  title: 'CleanShot',
  description: 'AI-powered forklift image processing',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        {children}
        <Analytics />
      </body>
    </html>
  )
}
