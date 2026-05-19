// apps/web/app/api/jobs/[id]/route.ts
// BFF Route Handler — GET /api/jobs/[id]
// Proxies to FastAPI's GET /api/v1/jobs/{job_id}. Translates the snake_case
// JobRecord into the camelCase shape lib/types.ts expects.

import { type NextRequest, NextResponse } from "next/server";

import { forwardError, getFastApiEnv, snakeJobToCamel } from "@/lib/bff";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function GET(request: NextRequest, ctx: RouteContext) {
  const env = getFastApiEnv();
  if (env instanceof NextResponse) return env;

  const { id } = await ctx.params;

  const res = await fetch(`${env.base}/api/v1/jobs/${id}`, {
    headers: { "X-Api-Key": env.key },
    signal: request.signal,
    cache: "no-store",
  });

  if (!res.ok) return forwardError(res);

  const job = await res.json() as Record<string, unknown>;
  return NextResponse.json(snakeJobToCamel(job));
}
