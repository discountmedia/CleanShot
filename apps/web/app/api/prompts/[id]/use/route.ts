// apps/web/app/api/prompts/[id]/use/route.ts
// BFF Route Handler — POST: count one use of a shared template.
//
// Fired when a template is loaded into the prompt box, to drive the "most
// used" sort. It is a popularity counter, not an audit trail: no row is
// written saying who used what, and the backend deliberately doesn't bump
// updated_at, so using a template never reorders the recency list. Per-user
// attribution, if it is ever wanted, belongs in usage_events.
//
// A session is still required — an unauthenticated caller shouldn't be able to
// inflate the counter — but the identity isn't forwarded beyond the standard
// header, because nothing downstream stores it.

import { type NextRequest, NextResponse } from "next/server";

import { authedHeaders, forwardError, getFastApiEnv, resolveUserEmail } from "@/lib/bff";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function POST(request: NextRequest, ctx: RouteContext) {
  const email = await resolveUserEmail();
  if (!email) return NextResponse.json({ detail: "Unauthorized" }, { status: 401 });

  const env = getFastApiEnv();
  if (env instanceof NextResponse) return env;

  const { id } = await ctx.params;
  const res = await fetch(`${env.base}/api/v1/prompts/${id}/use`, {
    method: "POST",
    headers: await authedHeaders(env.key),
    signal: request.signal,
    cache: "no-store",
  });
  if (!res.ok) return forwardError(res);
  const data = (await res.json()) as { use_count: number };
  return NextResponse.json({ useCount: data.use_count });
}
