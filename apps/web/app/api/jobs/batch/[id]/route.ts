// apps/web/app/api/jobs/batch/[id]/route.ts
// BFF Route Handler — GET /api/jobs/batch/[id]
// Proxies to FastAPI's GET /api/v1/jobs/batch/{batch_id}. Translates the
// snake_case status payload + nested JobRecord list into camelCase.

import { type NextRequest, NextResponse } from "next/server";

import { forwardError, getFastApiEnv, snakeJobToCamel } from "@/lib/bff";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface FastApiBatchStatus {
  batch_id: string;
  total: number;
  status_counts: Record<string, number>;
  complete: boolean;
  jobs: Record<string, unknown>[];
}

export async function GET(request: NextRequest, ctx: RouteContext) {
  const env = getFastApiEnv();
  if (env instanceof NextResponse) return env;

  const { id } = await ctx.params;

  const res = await fetch(`${env.base}/api/v1/jobs/batch/${id}`, {
    headers: { "X-Api-Key": env.key },
    signal: request.signal,
    cache: "no-store",
  });

  if (!res.ok) return forwardError(res);

  const data = (await res.json()) as FastApiBatchStatus;
  return NextResponse.json({
    batchId:      data.batch_id,
    total:        data.total,
    statusCounts: data.status_counts,
    complete:     data.complete,
    jobs:         data.jobs.map(snakeJobToCamel),
  });
}
