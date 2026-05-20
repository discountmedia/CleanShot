// apps/web/app/api/export/pro/preview/route.ts
// BFF Route Handler — POST /api/export/pro/preview
//
// Proxies to FastAPI's POST /api/v1/export/pro/preview. The FastAPI
// endpoint streams NDJSON progress events:
//   {"event":"started",  "total": N}
//   {"event":"progress", "current": K, "total": N, "filename": "..."}
//   {"event":"result",   "items": [...], "zip_url": "...", ...}
//   {"event":"error",    "message": "..."}
//
// We pass the stream through verbatim — the browser-side helper
// (lib/api.exportProPreviewStream) reads the NDJSON line-by-line and
// translates snake_case → camelCase for each event.
//
// FastAPI 403s this route until the session's project has been saved.
//
// maxDuration is bumped to 300 (Pro tier max). A 50-image batch with
// captioning + resize can take 90-180s; the prior 60s ceiling was the
// FUNCTION_INVOCATION_TIMEOUT the operator saw.

import { type NextRequest, NextResponse } from "next/server";

import { forwardError, getFastApiEnv, jsonHeaders } from "@/lib/bff";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

interface ClientRequest {
  sessionId: string;
  assetIds: string[];
}

export async function POST(request: NextRequest) {
  const env = getFastApiEnv();
  if (env instanceof NextResponse) return env;

  const body = (await request.json()) as ClientRequest;

  const res = await fetch(`${env.base}/api/v1/export/pro/preview`, {
    method: "POST",
    headers: jsonHeaders(env.key),
    body: JSON.stringify({
      session_id: body.sessionId,
      asset_ids:  body.assetIds,
    }),
    signal: request.signal,
    cache: "no-store",
  });

  if (!res.ok) return forwardError(res);

  // Pass the NDJSON stream straight through. x-accel-buffering=no tells
  // Vercel's edge not to buffer the body, so chunks reach the browser
  // as soon as FastAPI yields them.
  return new NextResponse(res.body, {
    status: res.status,
    headers: {
      "content-type":      "application/x-ndjson",
      "cache-control":     "no-cache",
      "x-accel-buffering": "no",
    },
  });
}
