// apps/web/app/api/sessions/[id]/route.ts
// BFF Route Handler — GET /api/sessions/[id]
// Proxies to FastAPI's GET /api/v1/sessions/{session_id}. Forwards the
// session-state payload as-is. The nested structure is large and shapes are
// already typed in lib/types.ts via snake_case-aware consumers — leaving
// the payload untouched keeps this handler trivial. If a consumer wants
// camelCase, it can transform at the call site.

import { type NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";

import { getFastApiEnv } from "@/lib/bff";
import { getSessionEmail } from "@/lib/auth";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, ctx: RouteContext) {
  const env = getFastApiEnv();
  if (env instanceof NextResponse) return env;

  const { id } = await ctx.params;

  // Identity for the session-ownership check on the FastAPI side. Enforcement
  // lives in the handler, not here — this API takes a shared X-Api-Key and is
  // callable directly, so the BFF is a convenience layer and cannot be the
  // security boundary. Without this header a session that HAS an owner reads
  // as not-found, so forgetting it locks out the only legitimate caller.
  let userEmail: string | null;
  if (process.env.AUTH_ENABLED === "true") {
    userEmail = await getSessionEmail(await headers());
  } else {
    userEmail = "dev@local";
  }

  const fwd: Record<string, string> = { "X-Api-Key": env.key };
  if (userEmail) fwd["X-User-Email"] = userEmail;

  const res = await fetch(`${env.base}/api/v1/sessions/${id}`, {
    headers: fwd,
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
