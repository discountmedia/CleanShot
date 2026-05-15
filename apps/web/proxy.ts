// apps/web/proxy.ts
// Next.js 16 proxy (was middleware.ts in Next.js ≤15).
// Named export must be `proxy` — default export also works but named is explicit.
//
// Auth flow:
//   AUTH_ENABLED=false  → pass all requests through (dev/test mode)
//   AUTH_ENABLED=true   → check Better Auth session cookie
//                         no session → redirect /login
//                         session present → allow through
//                         (domain/email gate happens at signIn callback, not here)
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
];

export function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // AUTH_ENABLED=false → bypass entirely (testing mode)
  if (process.env.AUTH_ENABLED === "false") {
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
    pathname.match(/\.(ico|png|jpg|jpeg|svg|css|js|woff2?)$/)
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
