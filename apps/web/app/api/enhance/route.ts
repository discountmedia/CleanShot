// apps/web/app/api/enhance/route.ts
// BFF Route Handler — POST /api/enhance
// Proxies to FastAPI's POST /api/v1/enhance. Translates camel→snake on the
// way in. `forkliftMeta` is project-side state and is committed later
// through /api/projects/save (export endpoints require it); we accept it
// here for caller convenience but only forward the bits the worker
// actually uses (provider, toggles, equipmentType, customPrompt).

import { type NextRequest, NextResponse } from "next/server";

import { forwardError, getFastApiEnv, jsonHeaders } from "@/lib/bff";

export const maxDuration = 15;
export const dynamic = "force-dynamic";

interface ClientRequest {
  sessionId: string;
  assetId: string;
  toggles: Record<string, boolean>;
  /** Accepted for caller convenience; we don't forward it. Project meta
   *  lands via /api/projects/save instead. */
  forkliftMeta?: Record<string, string>;
  provider?: "gemini" | "openai" | "grok" | "kontext";
  /**
   * Drives the per-type anatomy block in _build_enhance_prompt. Optional
   * — backend defaults to "forklift" when omitted.
   */
  equipmentType?: "forklift" | "scissor_lift" | "telehandler";
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
      ...(body.equipmentType ? { equipment_type: body.equipmentType } : {}),
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
