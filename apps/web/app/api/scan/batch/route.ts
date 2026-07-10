// apps/web/app/api/scan/batch/route.ts
// BFF Route Handler — POST /api/scan/batch
// Proxies to FastAPI's POST /api/v1/scan/batch.

import { type NextRequest, NextResponse } from "next/server";

import { forwardError, getFastApiEnv, jsonHeaders } from "@/lib/bff";

export const maxDuration = 15;
export const dynamic = "force-dynamic";

interface ClientRequest {
  sessionId: string;
  assetIds: string[];
  idempotencyKey: string;
  equipmentType?: string;
  make?: string;
  originalAssetIds?: Record<string, string>;
  intendedEdits?: string[];
}

interface FastApiResponse {
  batch_id: string;
  job_ids: string[];
}

export async function POST(request: NextRequest) {
  const env = getFastApiEnv();
  if (env instanceof NextResponse) return env;

  const body = (await request.json()) as ClientRequest;

  const res = await fetch(`${env.base}/api/v1/scan/batch`, {
    method: "POST",
    headers: jsonHeaders(env.key),
    body: JSON.stringify({
      session_id:         body.sessionId,
      asset_ids:          body.assetIds,
      idempotency_key:    body.idempotencyKey,
      equipment_type:     body.equipmentType ?? null,
      make:               body.make ?? null,
      original_asset_ids: body.originalAssetIds ?? null,
      intended_edits:     body.intendedEdits ?? null,
    }),
    signal: request.signal,
    cache: "no-store",
  });

  if (!res.ok) return forwardError(res);

  const data = (await res.json()) as FastApiResponse;
  return NextResponse.json({
    batchId: data.batch_id,
    jobIds:  data.job_ids,
  }, { status: 202 });
}
