// apps/web/app/api/assets/[id]/url/route.ts
// BFF Route Handler — GET /api/assets/[id]/url
// Mints a fresh signed GET URL for an asset (used by thumbnails / preview).
// Proxies to FastAPI's GET /api/v1/assets/{asset_id}/url.

import { type NextRequest, NextResponse } from "next/server";

import { forwardError, getFastApiEnv } from "@/lib/bff";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface FastApiResponse {
  url: string;
  expires_at: string;
}

export async function GET(request: NextRequest, ctx: RouteContext) {
  const env = getFastApiEnv();
  if (env instanceof NextResponse) return env;

  const { id } = await ctx.params;

  const res = await fetch(`${env.base}/api/v1/assets/${id}/url`, {
    headers: { "X-Api-Key": env.key },
    signal: request.signal,
    cache: "no-store",
  });

  if (!res.ok) return forwardError(res);

  const data = (await res.json()) as FastApiResponse;
  return NextResponse.json({
    url:       data.url,
    expiresAt: data.expires_at,
  });
}
