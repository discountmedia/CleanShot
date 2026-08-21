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
// FastAPI 403s this route until the session's project has been saved — the
// caller (ExportControls) saves the project as the first step of the same
// click, so the operator never sees a separate Save action.
//
// maxDuration is bumped to 300 (Pro tier max). A 50-image batch with
// captioning + resize can take 90-180s; the prior 60s ceiling was the
// FUNCTION_INVOCATION_TIMEOUT the operator saw.

import { type NextRequest, NextResponse } from "next/server";

import { authedHeaders, forwardError, getFastApiEnv } from "@/lib/bff";

export const maxDuration = 300;
export const dynamic = "force-dynamic";

interface ClientRequest {
  sessionId: string;
  assetIds: string[];
  /** Optional parallel list — entry [i] is the AI provider for assetIds[i]. */
  providers?: (string | null)[];
  /** Pre-enhance originals to save alongside the exported files. */
  originalAssetIds?: string[];
  /** Burn the AI-disclaimer watermark into the bottom-right of every JPEG. */
  aiDisclaimer?: boolean;
}

export async function POST(request: NextRequest) {
  const env = getFastApiEnv();
  if (env instanceof NextResponse) return env;

  const body = (await request.json()) as ClientRequest;

  const res = await fetch(`${env.base}/api/v1/export/pro/preview`, {
    method: "POST",
    // X-User-Email is now load-bearing, not just an auth probe: the export
    // files its output under this identity in the Photo Library. Same header
    // the approvals route uses — no new identity mechanism.
    headers: {
      ...(await authedHeaders(env.key)),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      session_id:         body.sessionId,
      asset_ids:          body.assetIds,
      providers:          body.providers,
      original_asset_ids: body.originalAssetIds ?? [],
      // `?? true` matches the checkbox default. An omitted flag must not mean
      // "no watermark" — the operator opts out explicitly or not at all.
      ai_disclaimer:      body.aiDisclaimer ?? true,
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
