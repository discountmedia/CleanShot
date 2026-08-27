import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // React Compiler: stable in Next.js 16 — auto-memoizes components
  reactCompiler: true,

  // Images: allow GCS bucket domain for signed URLs
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'storage.googleapis.com',
        pathname: '/cleanshot-training-df-2026/**',
      },
    ],
  },

  // Security headers on all routes
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options',  value: 'nosniff' },
          { key: 'Referrer-Policy',          value: 'strict-origin-when-cross-origin' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
          },
        ],
      },

      // Clickjacking protection, split so the GUIDES tab can frame its own
      // pages. `DENY` refuses framing even from the same origin, which is why
      // the in-app guide iframes rendered blank.
      //
      // Everything except /guides keeps DENY.
      {
        source: '/((?!guides/).*)',
        headers: [
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },

      // /guides is static operator documentation with no forms, no session
      // reads and no state — the only thing framing it can achieve is the
      // GUIDES tab. SAMEORIGIN for old browsers, frame-ancestors for current
      // ones; the two MUST agree or the page is blocked.
      {
        source: '/guides/:path*',
        headers: [
          { key: 'X-Frame-Options',         value: 'SAMEORIGIN' },
          { key: 'Content-Security-Policy', value: "frame-ancestors 'self'" },
        ],
      },
    ]
  },
}

export default nextConfig
