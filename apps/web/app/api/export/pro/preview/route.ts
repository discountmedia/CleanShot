// apps/web/app/api/export/pro/preview/route.ts
// BFF Route Handler — POST /api/export/pro/preview
// Proxies to FastAPI's POST /api/v1/export/pro/preview. Returns JSON
// (per-image signed URLs + a ZIP signed URL) rather than binary, so the
// ResizePanel can render every resized image inline before the operator
// commits to the ZIP download.
//
// FastAPI 403s this route until the session's project has been saved.

import { type NextRequest, NextResponse } from "next/server";

import { forwardError, getFastApiEnv, jsonHeaders } from "@/lib/bff";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

interface ClientRequest {
  sessionId: string;
  assetIds: string[];
}

interface FastApiItem {
  asset_id:     string;
  filename:     string;
  url:          string;
  width:        number;
  height:       number;
  size_bytes:   number;
  size_warning: boolean;
}

interface FastApiResponse {
  items:            FastApiItem[];
  zip_url:          string;
  zip_size_bytes:   number;
  any_size_warning: boolean;
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

  const data = (await res.json()) as FastApiResponse;

  // Translate snake_case → camelCase for the client.
  return NextResponse.json({
    items: data.items.map((it) => ({
      assetId:     it.asset_id,
      filename:    it.filename,
      url:         it.url,
      width:       it.width,
      height:      it.height,
      sizeBytes:   it.size_bytes,
      sizeWarning: it.size_warning,
    })),
    zipUrl:         data.zip_url,
    zipSizeBytes:   data.zip_size_bytes,
    anySizeWarning: data.any_size_warning,
  });
}
