// apps/web/app/api/enhance/tweak/route.ts
// BFF Route Handler — POST /api/enhance/tweak
// Forwards text-guided variant tweak requests to FastAPI's
// /api/v1/enhance/tweak. Same camelCase → snake_case translation as
// the other enhance routes, returns { jobId } so the frontend can
// poll using the existing useJobPoller hook.

import { type NextRequest, NextResponse } from "next/server";

import { forwardError, getFastApiEnv, jsonHeaders } from "@/lib/bff";

export const maxDuration = 15;
export const dynamic = "force-dynamic";

interface ClientRequest {
  sessionId: string;
  assetId: string;
  instruction: string;
  /** "gemini" (default) or "ideogram". */
  tool?: "gemini" | "ideogram";
  idempotencyKey: string;
}

interface FastApiResponse {
  job_id: string;
}

export async function POST(request: NextRequest) {
  const env = getFastApiEnv();
  if (env instanceof NextResponse) return env;

  const body = (await request.json()) as ClientRequest;

  const res = await fetch(`${env.base}/api/v1/enhance/tweak`, {
    method: "POST",
    headers: jsonHeaders(env.key),
    body: JSON.stringify({
      session_id:      body.sessionId,
      asset_id:        body.assetId,
      instruction:     body.instruction,
      tool:            body.tool ?? "gemini",
      idempotency_key: body.idempotencyKey,
    }),
    signal: request.signal,
    cache: "no-store",
  });

  if (!res.ok) return forwardError(res);

  const data = (await res.json()) as FastApiResponse;
  return NextResponse.json({ jobId: data.job_id }, { status: 202 });
}
