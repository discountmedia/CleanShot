// apps/web/app/api/handoff/[id]/route.ts
// BFF Route Handler — GET /api/handoff/[id]
// Proxies to FastAPI's GET /api/v1/ingest/handoff/{handoff_id} and camelCases
// the payload, matching how /api/jobs/batch/[id] treats its envelope.
//
// This is the only way an operator watches their import land, so it is
// deliberately free of any cache dependency upstream — see the endpoint's
// docstring. Errors collapse to a fixed string (no forwardError) so a 404 can
// never reflect request content.

import { type NextRequest, NextResponse } from "next/server";

import { authedHeaders, getFastApiEnv } from "@/lib/bff";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface FastApiItem {
  item_id: string;
  filename: string;
  status: "pending" | "landed" | "failed";
  asset_id: string | null;
  error: string | null;
}

interface FastApiStatus {
  handoff_id: string;
  session_id: string;
  total: number;
  status_counts: Record<string, number>;
  complete: boolean;
  items: FastApiItem[];
}

export async function GET(request: NextRequest, ctx: RouteContext) {
  const env = getFastApiEnv();
  if (env instanceof NextResponse) return env;

  const { id } = await ctx.params;

  const res = await fetch(`${env.base}/api/v1/ingest/handoff/${id}`, {
    headers: await authedHeaders(env.key),
    signal: request.signal,
    cache: "no-store",
  });

  if (!res.ok) {
    return NextResponse.json(
      { detail: "Import status unavailable." },
      { status: res.status },
    );
  }

  const data = (await res.json()) as FastApiStatus;
  return NextResponse.json({
    handoffId: data.handoff_id,
    sessionId: data.session_id,
    total: data.total,
    statusCounts: data.status_counts,
    complete: data.complete,
    items: data.items.map((it) => ({
      itemId: it.item_id,
      filename: it.filename,
      status: it.status,
      assetId: it.asset_id,
      error: it.error,
    })),
  });
}
