// apps/web/app/api/enhance/route.ts
// BFF Route Handler — POST /api/enhance
// Proxies to FastAPI's POST /api/v1/enhance. Translates camel→snake on the
// way in. Most of `forkliftMeta` is project-side state and is committed
// later through /api/projects/save (export endpoints require it). We do
// pull `forkliftMeta.make` out and forward it as the top-level `make`
// field on EnhanceRequest — the worker's RENTAL-FLEET BRANDING block
// uses it to know which OEM brand decals to restore where rental wraps
// were stripped.

import { type NextRequest, NextResponse } from "next/server";

import { forwardError, getFastApiEnv, jsonHeaders } from "@/lib/bff";

export const maxDuration = 15;
export const dynamic = "force-dynamic";

interface ClientRequest {
  sessionId: string;
  assetId: string;
  toggles: Record<string, boolean>;
  // We forward `.make` as the top-level `make` field; the rest of
  // forkliftMeta is project-side state and lands via /api/projects/save.
 // forkliftMeta?: Record<string, string>;
  provider?: "gemini" | "openai" | "flux" | "reve" | "grok";
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
      // Forward the OEM make so the worker's RENTAL-FLEET BRANDING block
      // can restore Toyota / Hyster / etc. decals where rental wraps had
      // been stripped. Pulled from the operator's meta form.
     // ...(body.forkliftMeta?.make?.trim() ? { make: body.forkliftMeta.make.trim() } : {}),
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
