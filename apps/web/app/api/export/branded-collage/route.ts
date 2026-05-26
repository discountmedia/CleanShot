// apps/web/app/api/export/branded-collage/route.ts
// BFF Route Handler — POST /api/export/branded-collage
// Proxies to FastAPI's POST /api/v1/export/branded-collage. Returns the
// composed JPEG as a binary stream with Content-Disposition for direct
// browser download.

import { type NextRequest, NextResponse } from "next/server";

import { forwardError, getFastApiEnv, jsonHeaders } from "@/lib/bff";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

interface ClientRequest {
  sessionId: string;
  equipmentType: "forklift" | "scissor_lift" | "telehandler";
  assetIds: string[];
  aiDisclaimer?: boolean;
}

export async function POST(request: NextRequest) {
  const env = getFastApiEnv();
  if (env instanceof NextResponse) return env;

  const body = (await request.json()) as ClientRequest;

  const res = await fetch(`${env.base}/api/v1/export/branded-collage`, {
    method: "POST",
    headers: jsonHeaders(env.key),
    body: JSON.stringify({
      session_id:     body.sessionId,
      equipment_type: body.equipmentType,
      asset_ids:      body.assetIds,
      ai_disclaimer:  body.aiDisclaimer ?? false,
    }),
    signal: request.signal,
    cache: "no-store",
  });

  if (!res.ok) return forwardError(res);

  const headers = new Headers();
  for (const name of ["content-type", "content-disposition", "x-warning"]) {
    const v = res.headers.get(name);
    if (v) headers.set(name, v);
  }

  return new NextResponse(res.body, { status: res.status, headers });
}
