// apps/web/app/api/export/pro/route.ts
// BFF Route Handler — POST /api/export/pro
// Proxies to FastAPI's POST /api/v1/export/pro. Streams the binary
// response back (single JPEG for one asset, ZIP for many) without
// buffering, and forwards the headers the client cares about:
//   • Content-Type        (image/jpeg or application/zip)
//   • Content-Disposition (attachment; filename="…")
//   • X-Warning           (set by FastAPI when the ≤100 KB target was
//                         unachievable after 10 quality iterations)
//
// FastAPI 403s this route until the session's project has been saved
// (POST /api/v1/projects/save flips projects.saved_at). That 403 is
// forwarded verbatim by forwardError so the UI can surface it.

import { type NextRequest, NextResponse } from "next/server";

import { forwardError, getFastApiEnv, jsonHeaders } from "@/lib/bff";

export const maxDuration = 20;
export const dynamic = "force-dynamic";

interface ClientRequest {
  sessionId: string;
  assetIds: string[];
}

export async function POST(request: NextRequest) {
  const env = getFastApiEnv();
  if (env instanceof NextResponse) return env;

  const body = (await request.json()) as ClientRequest;

  const res = await fetch(`${env.base}/api/v1/export/pro`, {
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

  // Pass binary body + selected headers through to the browser. Reading
  // res.body (a ReadableStream) instead of res.arrayBuffer() lets the
  // ZIP/JPEG stream out without buffering the whole payload in the
  // Vercel function's memory.
  const headers = new Headers();
  for (const name of ["content-type", "content-disposition", "x-warning"]) {
    const v = res.headers.get(name);
    if (v) headers.set(name, v);
  }

  return new NextResponse(res.body, { status: res.status, headers });
}
