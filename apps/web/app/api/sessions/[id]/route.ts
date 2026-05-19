// apps/web/app/api/sessions/[id]/route.ts
// BFF Route Handler — GET /api/sessions/[id]
// Proxies to FastAPI's GET /api/v1/sessions/{session_id}. Forwards the
// session-state payload as-is. The nested structure is large and shapes are
// already typed in lib/types.ts via snake_case-aware consumers — leaving
// the payload untouched keeps this handler trivial. If a consumer wants
// camelCase, it can transform at the call site.

import { type NextRequest, NextResponse } from "next/server";

import { forwardError, getFastApiEnv } from "@/lib/bff";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, ctx: RouteContext) {
  const env = getFastApiEnv();
  if (env instanceof NextResponse) return env;

  const { id } = await ctx.params;

  const res = await fetch(`${env.base}/api/v1/sessions/${id}`, {
    headers: { "X-Api-Key": env.key },
    signal: request.signal,
    cache: "no-store",
  });

  if (!res.ok) return forwardError(res);

  return NextResponse.json(await res.json());
}
