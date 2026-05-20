// apps/web/proxy.ts
// Next.js 16 proxy (was middleware.ts in Next.js ≤15).
// Named export must be `proxy` — default export also works but named is explicit.
//
// Auth flow:
//   AUTH_ENABLED=true   → check Better Auth session cookie
//                         no session → redirect /login
//                         session present → allow through
//                         (domain/email gate happens at signIn callback, not here)
//   anything else       → pass all requests through (default, dev/test mode)
//
// Auth is OFF unless explicitly turned ON. Inverted from a prior default
// because an unset (or wrong-environment-scoped) Vercel env var would
// otherwise gate the whole site behind a half-configured OAuth flow.
//
// We intentionally keep the proxy LEAN — just cookie presence check.
// Full session validation (DB lookup) happens in Server Components and Route Handlers.
// Reason: proxy runs at the edge before Node.js runtime is available.

import { type NextRequest, NextResponse } from "next/server";
import { getSessionCookie } from "better-auth/cookies";

// Routes that are always public (never redirected)
const PUBLIC_PATHS = [
  "/login",
  "/unauthorized",
  "/api/auth",        // Better Auth callback routes
  "/_vercel",         // Vercel Web Analytics beacon endpoint (/_vercel/insights/*)
];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Bypass unless auth is explicitly enabled.
  if (process.env.AUTH_ENABLED !== "true") {
    return NextResponse.next();
  }

  // Always allow public paths
  if (PUBLIC_PATHS.some((p) => pathname.startsWith(p))) {
    return NextResponse.next();
  }

  // Allow static assets
  if (
    pathname.startsWith("/_next") ||
    pathname.startsWith("/favicon") ||
    pathname.match(/\.(ico|png|jpg|jpeg|gif|svg|webp|avif|css|js|woff2?)$/)
  ) {
    return NextResponse.next();
  }

  // Check for Better Auth session cookie (edge-safe — no DB call)
  const sessionCookie = getSessionCookie(request);
  if (!sessionCookie) {
    const loginUrl = new URL("/login", request.url);
    loginUrl.searchParams.set("callbackUrl", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return NextResponse.next();
}

export const config = {
  // Match all routes except Next.js internals
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico).*)",
  ],
};
