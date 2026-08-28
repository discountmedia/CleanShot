// apps/web/app/api/enhance/erase/route.ts
// BFF Route Handler — POST /api/enhance/erase
// Forwards mask-based erase requests to FastAPI's /api/v1/enhance/erase.
// The mask is a base64 PNG produced by the client-side canvas; we
// translate camelCase → snake_case at this boundary like other BFF
// routes do, and return { jobId } so the frontend can poll just like
// it does for enhance jobs.

import { type NextRequest, NextResponse } from "next/server";

import { forwardError, getFastApiEnv, jsonHeaders } from "@/lib/bff";

// Erase payload includes a base64 PNG mask + base64 source asset
// reference; keep the route handler timeout generous since the call to
// FastAPI only enqueues (returns 202 immediately).
export const maxDuration = 15;
export const dynamic = "force-dynamic";

interface ClientRequest {
  sessionId: string;
  assetId: string;
  maskPngBase64: string;
  instruction?: string;
  /** "flux" (default) or "ideogram". */
  tool?: "ideogram";
  idempotencyKey: string;
}

interface FastApiResponse {
  job_id: string;
}

export async function POST(request: NextRequest) {
  const env = getFastApiEnv();
  if (env instanceof NextResponse) return env;

  const body = (await request.json()) as ClientRequest;

  const res = await fetch(`${env.base}/api/v1/enhance/erase`, {
    method: "POST",
    headers: jsonHeaders(env.key),
    body: JSON.stringify({
      session_id:       body.sessionId,
      asset_id:         body.assetId,
      mask_png_base64:  body.maskPngBase64,
      ...(body.instruction?.trim() ? { instruction: body.instruction } : {}),
      // Default must track EraseTaskPayload.tool, which is Literal["ideogram"]
      // as of 2026-08-27. Defaulting to "flux" here 422s the worker.
      tool:             body.tool ?? "ideogram",
      idempotency_key:  body.idempotencyKey,
    }),
    signal: request.signal,
    cache: "no-store",
  });

  if (!res.ok) return forwardError(res);

  const data = (await res.json()) as FastApiResponse;
  return NextResponse.json({ jobId: data.job_id }, { status: 202 });
}
