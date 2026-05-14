// proxy.ts — Next.js 16 (renamed from middleware.ts)
// v3.5: AUTH_ENABLED gate + Better Auth session check
// v3.4: CSP nonce per-request (XSS mitigation — GHSA-ffhc-5mcf-pf4q)
//
// SECURITY NOTE: proxy.ts is a UX redirect layer only.
// The real authz boundary is isAuthorized() inside every Route Handler.
// Never rely on this file as the sole security gate.

import { NextRequest, NextResponse } from 'next/server'

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  // --- AUTH GATE (v3.5) ---
  // AUTH_ENABLED=false during development and testing (default)
  // AUTH_ENABLED=true only in Vercel Production after testing complete
  if (process.env.AUTH_ENABLED === 'true') {
    const isPublic =
      pathname.startsWith('/login') ||
      pathname.startsWith('/unauthorized') ||
      pathname.startsWith('/api/auth') ||
      pathname.startsWith('/_next')

    if (!isPublic) {
      // Dynamic import avoids loading better-auth when AUTH_ENABLED=false
      const { auth } = await import('@/lib/auth/auth')
      const session = await auth.api.getSession({ headers: request.headers })

      if (!session) {
        const loginUrl = new URL('/login', request.url)
        loginUrl.searchParams.set('callbackUrl', pathname)
        return NextResponse.redirect(loginUrl)
      }
    }
  }

  // --- CSP NONCE (v3.4 — unchanged) ---
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64')
  const response = NextResponse.next({
    request: { headers: new Headers({ 'x-nonce': nonce }) },
  })

  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: https://storage.googleapis.com`,
    `connect-src 'self'`,
    `frame-ancestors 'none'`,
  ].join('; ')

  response.headers.set('Content-Security-Policy', csp)
  response.headers.set('x-nonce', nonce)
  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
