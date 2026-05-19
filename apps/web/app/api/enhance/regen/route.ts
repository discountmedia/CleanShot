// apps/web/app/api/enhance/regen/route.ts
// BFF Route Handler — POST /api/enhance/regen
// Proxies a single-image regen request to FastAPI.
// Called from ScanPanel when the user clicks "Regenerate Image".
//
// FastAPI's RegenRequest is snake_case with no Pydantic aliases on the
// schema — the same translation pattern as /api/enhance.
//
//   client  -> BFF:    sessionId,  assetId,  regenPrompt,  idempotencyKey
//   BFF     -> FastAPI: session_id, asset_id, regen_prompt, idempotency_key
//   response: { job_id }  ->  { jobId }

import { type NextRequest, NextResponse } from "next/server";

import { forwardError, getFastApiEnv, jsonHeaders } from "@/lib/bff";

export const maxDuration = 15;
export const dynamic = "force-dynamic";

interface ClientRequest {
  sessionId: string;
  assetId: string;
  regenPrompt: string;
  idempotencyKey: string;
}

interface FastApiResponse {
  job_id: string;
}

export async function POST(request: NextRequest) {
  const env = getFastApiEnv();
  if (env instanceof NextResponse) return env;

  const body = (await request.json()) as ClientRequest;

  const res = await fetch(`${env.base}/api/v1/enhance/regen`, {
    method: "POST",
    headers: jsonHeaders(env.key),
    body: JSON.stringify({
      session_id:      body.sessionId,
      asset_id:        body.assetId,
      regen_prompt:    body.regenPrompt,
      idempotency_key: body.idempotencyKey,
    }),
    signal: request.signal,
    cache: "no-store",
  });

  if (!res.ok) return forwardError(res);

  const data = (await res.json()) as FastApiResponse;
  return NextResponse.json({ jobId: data.job_id }, { status: 202 });
}
