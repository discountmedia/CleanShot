// apps/web/app/api/enhance/route.ts
// BFF Route Handler — POST /api/enhance
// Proxies to FastAPI's POST /api/v1/enhance. Translates camel→snake on the
// way in. `forkliftMeta` is project-side state and is committed later
// through /api/projects/save (export endpoints require it); we accept it
// here for caller convenience but only forward the bits the worker
// actually uses (provider, toggles, equipmentType, customPrompt).
//
// Operator-driven multi-provider selection — the EnhancePanel ProviderRow
// fans out one POST per selected provider per source image; we forward
// whichever provider the client sent (defaulting to gemini if a hand-
// crafted request omits it). Per-user model locking (USER_RESTRICTIONS) is
// gone — anyone signed in can pick any subset of providers.

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
  provider?: "gemini" | "openai" | "grok" | "kontext" | "ideogram" | "reve";
  /**
   * Drives the per-type anatomy block in _build_enhance_prompt. Optional
   * — backend defaults to "forklift" when omitted.
   */
  equipmentType?: "forklift" | "rough_terrain" | "scissor_lift" | "telehandler" | "reach_truck" | "order_picker" | "pallet_jack" | "walkie_stacker";
  customPrompt?: string;                  // when set, FastAPI bypasses toggles
  /**
   * Per-card master-prompt selection from the Enhance tab's "Prompt:" dropdown.
   * One opaque key: "auto" | "generic:<author>" | "tailored:<author>". When
   * "auto" or omitted, FastAPI falls through to its procedural builder (today's
   * behavior). Resolved server-side in workers/master_prompts.py.
   */
  promptChoice?: string;
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
      // Only forward prompt_choice when it's an actual master-prompt
      // selection; "auto"/empty stays off the wire so FastAPI keeps its
      // procedural default.
      ...(body.promptChoice && body.promptChoice !== "auto"
        ? { prompt_choice: body.promptChoice }
        : {}),
      idempotency_key: body.idempotencyKey,
    }),
    signal: request.signal,
    cache: "no-store",
  });

  if (!res.ok) return forwardError(res);

  const data = (await res.json()) as FastApiResponse;
  return NextResponse.json({ jobId: data.job_id }, { status: 202 });
}
