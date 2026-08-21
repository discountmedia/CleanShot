// apps/web/app/api/prompts/[id]/route.ts
// BFF Route Handler — PATCH (rename) / DELETE one saved prompt.
//
// The id travels in the path but ownership is NOT decided here: FastAPI scopes
// every statement by the forwarded X-User-Email, so a guessed id belonging to
// another user matches nothing and comes back 404.

import { type NextRequest, NextResponse } from "next/server";

import { authedHeaders, forwardError, getFastApiEnv, resolveUserEmail } from "@/lib/bff";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface FastApiPrompt {
  id:         string;
  user_email: string;
  title:      string;
  body:       string;
  created_at: string;
  updated_at: string;
}

export async function PATCH(request: NextRequest, ctx: RouteContext) {
  const email = await resolveUserEmail();
  if (!email) return NextResponse.json({ detail: "Unauthorized" }, { status: 401 });

  const env = getFastApiEnv();
  if (env instanceof NextResponse) return env;

  const { id } = await ctx.params;
  const body = (await request.json()) as { title: string };

  const res = await fetch(`${env.base}/api/v1/prompts/${id}`, {
    method: "PATCH",
    headers: {
      ...(await authedHeaders(env.key)),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ title: body.title }),
    signal: request.signal,
    cache: "no-store",
  });
  if (!res.ok) return forwardError(res);
  const data = (await res.json()) as FastApiPrompt;
  return NextResponse.json({
    id:        data.id,
    title:     data.title,
    body:      data.body,
    createdAt: data.created_at,
    updatedAt: data.updated_at,
  });
}

export async function DELETE(request: NextRequest, ctx: RouteContext) {
  const email = await resolveUserEmail();
  if (!email) return NextResponse.json({ detail: "Unauthorized" }, { status: 401 });

  const env = getFastApiEnv();
  if (env instanceof NextResponse) return env;

  const { id } = await ctx.params;
  const res = await fetch(`${env.base}/api/v1/prompts/${id}`, {
    method: "DELETE",
    headers: await authedHeaders(env.key),
    signal: request.signal,
    cache: "no-store",
  });
  if (!res.ok) return forwardError(res);
  // FastAPI answers 204; there is no body to forward.
  return new NextResponse(null, { status: 204 });
}
