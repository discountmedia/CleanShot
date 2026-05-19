// apps/web/app/api/enhance/route.ts
// BFF Route Handler — POST /api/enhance
// Proxies to FastAPI's POST /api/v1/enhance. Translates camel→snake on the
// way in. Drops `forkliftMeta` — the FastAPI EnhanceRequest schema doesn't
// accept it; metadata goes through /api/projects/save when the user is
// ready to commit it (export endpoints require it).

import { type NextRequest, NextResponse } from "next/server";

import { forwardError, getFastApiEnv, jsonHeaders } from "@/lib/bff";

export const maxDuration = 15;
export const dynamic = "force-dynamic";

interface ClientRequest {
  sessionId: string;
  assetId: string;
  toggles: Record<string, boolean>;
  forkliftMeta?: Record<string, string>;  // intentionally dropped before forward
  provider?: "gemini" | "openai";
  customPrompt?: string;                  // when set, FastAPI bypasses toggles
  idempotencyKey: string;
}

interface FastApiResponse {
  job_id: string;
}

export async function POST(request: NextRequest) {
  const env = getFastApiEnv();
  if (env instanceof NextResponse) return env;

  const body = (await request.json()) as ClientRequest;

  const res = await fetch(`${env.base}/api/v1/enhance`, {
    method: "POST",
    headers: jsonHeaders(env.key),
    body: JSON.stringify({
      session_id:      body.sessionId,
      asset_id:        body.assetId,
      toggles:         body.toggles,            // already camelCase; Pydantic aliases handle it
      provider:        body.provider ?? "gemini",
      // Only forward custom_prompt when non-empty; omitting lets FastAPI
      // use its `None` default and the worker falls through to toggles.
      ...(body.customPrompt?.trim() ? { custom_prompt: body.customPrompt } : {}),
      idempotency_key: body.idempotencyKey,
    }),
    signal: request.signal,
    cache: "no-store",
  });

  if (!res.ok) return forwardError(res);

  const data = (await res.json()) as FastApiResponse;
  return NextResponse.json({ jobId: data.job_id }, { status: 202 });
}
