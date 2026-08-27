// apps/web/app/api/prompts/optimize/route.ts
// BFF Route Handler — POST /api/prompts/optimize
// Proxies to FastAPI's POST /api/v1/prompts/optimize. Condenses a long enhance
// prompt down toward the differential scanner's intended-edit window, and
// returns an account of what was cut and what was protected.
//
// SYNCHRONOUS, like /api/enhance/judge: nothing is written, so there is no job
// to poll and the result comes back inline. Unlike the judge this is a text
// call over a body that can reach 32k characters, so it gets more headroom —
// see maxDuration below.
//
// Static segment, so it wins over the sibling /api/prompts/[id] dynamic route.
// (That one only exports DELETE anyway.)
//
// camel→snake on the way in, snake→camel on the way out.

import { type NextRequest, NextResponse } from "next/server";

import { forwardError, getFastApiEnv, jsonHeaders } from "@/lib/bff";

// 120s, well above the judge's 30. A pages-long prompt is a large input and
// the model is reasoning over a protected list before it rewrites anything;
// the FastAPI side bounds its own call at 100s so a slow optimize surfaces as
// a clean error from the API rather than the edge function being killed.
//
// NOTE: vercel.json carries a catch-all `app/api/**/*.ts: { maxDuration: 10 }`.
// This route is listed explicitly there so it is not capped at 10s if the
// route-segment export loses to the config file.
export const maxDuration = 120;
export const dynamic = "force-dynamic";

interface ClientRequest {
  body: string;
  equipmentType?: string;
}

interface FastApiChange {
  text: string;
  reason: string;
}

interface FastApiResponse {
  optimized_prompt: string;
  original_chars: number;
  optimized_chars: number;
  target_chars: number;
  removed: FastApiChange[];
  kept: FastApiChange[];
  warnings: string[];
}

export async function POST(request: NextRequest) {
  const env = getFastApiEnv();
  if (env instanceof NextResponse) return env;

  const body = (await request.json()) as ClientRequest;

  const res = await fetch(`${env.base}/api/v1/prompts/optimize`, {
    method: "POST",
    headers: jsonHeaders(env.key),
    body: JSON.stringify({
      body: body.body,
      ...(body.equipmentType ? { equipment_type: body.equipmentType } : {}),
    }),
    signal: request.signal,
    cache: "no-store",
  });

  if (!res.ok) return forwardError(res);

  const data = (await res.json()) as FastApiResponse;
  return NextResponse.json({
    optimizedPrompt: data.optimized_prompt,
    originalChars:   data.original_chars,
    optimizedChars:  data.optimized_chars,
    targetChars:     data.target_chars,
    removed:         data.removed ?? [],
    kept:            data.kept ?? [],
    warnings:        data.warnings ?? [],
  });
}
