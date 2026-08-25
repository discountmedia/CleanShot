// apps/web/app/api/prompts/[id]/vote/route.ts
// BFF Route Handler — POST (upvote) / DELETE (withdraw) one vote on a shared
// template.
//
// The vote belongs to the signed-in user, resolved here and forwarded as
// X-User-Email; the client never says whose vote it is, so it can't vote on
// anyone's behalf. One vote per user is enforced by a composite primary key in
// Postgres, not by a check in any layer of this stack — two tabs clicking at
// once still produce one vote.
//
// Both verbs return the authoritative {voteCount, voted} so the UI can settle
// on the server's number instead of trusting its own optimistic increment.

import { type NextRequest, NextResponse } from "next/server";

import { authedHeaders, forwardError, getFastApiEnv, resolveUserEmail } from "@/lib/bff";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface FastApiVote {
  vote_count: number;
  voted:      boolean;
}

async function forward(
  request: NextRequest,
  ctx: RouteContext,
  method: "POST" | "DELETE",
) {
  const email = await resolveUserEmail();
  if (!email) return NextResponse.json({ detail: "Unauthorized" }, { status: 401 });

  const env = getFastApiEnv();
  if (env instanceof NextResponse) return env;

  const { id } = await ctx.params;
  const res = await fetch(`${env.base}/api/v1/prompts/${id}/vote`, {
    method,
    headers: await authedHeaders(env.key),
    signal: request.signal,
    cache: "no-store",
  });
  if (!res.ok) return forwardError(res);
  const data = (await res.json()) as FastApiVote;
  return NextResponse.json({ voteCount: data.vote_count, voted: data.voted });
}

export async function POST(request: NextRequest, ctx: RouteContext) {
  return forward(request, ctx, "POST");
}

export async function DELETE(request: NextRequest, ctx: RouteContext) {
  return forward(request, ctx, "DELETE");
}
