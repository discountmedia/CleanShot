// apps/web/app/api/sessions/[id]/route.ts
// BFF Route Handler — GET /api/sessions/[id]
// Proxies to FastAPI's GET /api/v1/sessions/{session_id}. Forwards the
// session-state payload as-is. The nested structure is large and shapes are
// already typed in lib/types.ts via snake_case-aware consumers — leaving
// the payload untouched keeps this handler trivial. If a consumer wants
// camelCase, it can transform at the call site.

import { type NextRequest, NextResponse } from "next/server";

import { authedHeaders, getFastApiEnv } from "@/lib/bff";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, ctx: RouteContext) {
  const env = getFastApiEnv();
  if (env instanceof NextResponse) return env;

  const { id } = await ctx.params;

  // Identity for FastAPI's require_authenticated_user. Enforcement lives in the
  // handler, not here — this API takes a shared X-Api-Key and is callable
  // directly, so the BFF is a convenience layer and cannot be the security
  // boundary. Without this header the read 404s, so forgetting it locks out the
  // only legitimate caller.
  const res = await fetch(`${env.base}/api/v1/sessions/${id}`, {
    headers: await authedHeaders(env.key),
    signal: request.signal,
    cache: "no-store",
  });

  if (!res.ok) {
    // No body pass-through (so no `forwardError` here). Upstream already sends
    // a fixed string, and collapsing to a constant keeps it that way if that
    // ever changes — the 404 must not become a place where request content is
    // reflected back. Status is preserved so the client can classify.
    return NextResponse.json({ detail: "Session not available." }, { status: res.status });
  }

  return NextResponse.json(await res.json());
}
