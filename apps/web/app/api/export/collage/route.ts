// apps/web/app/api/export/collage/route.ts
// BFF Route Handler — POST /api/export/collage
// Proxies to FastAPI's POST /api/v1/export/collage. Streams the binary
// response back (single JPEG for one asset, ZIP for many) without
// buffering, and forwards the headers the client cares about:
//   • Content-Type        (image/jpeg or application/zip)
//   • Content-Disposition (attachment; filename="…")
//   • X-Warning           (set by FastAPI when the ≤99 KB target was
//                         unachievable after 10 quality iterations)
//
// Mirrors /api/export/pro/route.ts exactly except for the upstream
// path. Same save-project precondition applies — FastAPI 403s until
// projects.saved_at is set on the session.

import { type NextRequest, NextResponse } from "next/server";

import { forwardError, getFastApiEnv, jsonHeaders } from "@/lib/bff";

export const maxDuration = 20;
export const dynamic = "force-dynamic";

interface ClientRequest {
  sessionId: string;
  assetIds: string[];
  providers?: (string | null)[];
  /** Burn the AI-disclaimer watermark into the bottom-right of every JPEG. */
  aiDisclaimer?: boolean;
}

export async function POST(request: NextRequest) {
  const env = getFastApiEnv();
  if (env instanceof NextResponse) return env;

  const body = (await request.json()) as ClientRequest;

  const res = await fetch(`${env.base}/api/v1/export/collage`, {
    method: "POST",
    headers: jsonHeaders(env.key),
    body: JSON.stringify({
      session_id:    body.sessionId,
      asset_ids:     body.assetIds,
      ai_disclaimer: body.aiDisclaimer ?? false,
      ...(body.providers ? { providers: body.providers } : {}),
    }),
    signal: request.signal,
    cache: "no-store",
  });

  if (!res.ok) return forwardError(res);

  // Stream the binary body + selected headers through to the browser.
  const headers = new Headers();
  for (const name of ["content-type", "content-disposition", "x-warning"]) {
    const v = res.headers.get(name);
    if (v) headers.set(name, v);
  }

  return new NextResponse(res.body, { status: res.status, headers });
}
