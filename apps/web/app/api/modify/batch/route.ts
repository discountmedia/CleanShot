// apps/web/app/api/modify/batch/route.ts
// BFF Route Handler — POST /api/modify/batch
//
// Forwards to FastAPI's POST /api/v1/modify/batch. Modify tab sends a
// batch of asset_ids + one set of brightness/contrast/saturation
// adjustments; backend pyvips renders each, uploads the result, and
// returns new asset rows with signed preview URLs.

import { type NextRequest, NextResponse } from "next/server";

import { forwardError, getFastApiEnv, jsonHeaders } from "@/lib/bff";

export const maxDuration = 60;
export const dynamic = "force-dynamic";

interface ClientAdjustments {
  brightness:  number;
  contrast:    number;
  saturation:  number;
  rotationDeg: number;
  cropAspect:  "free" | "1:1" | "4:3" | "7:5" | "16:9";
  cropZoom:    number;
}

interface ClientRequest {
  sessionId:   string;
  assetIds:    string[];
  adjustments: ClientAdjustments;
}

interface FastApiItem {
  asset_id: string;
  filename: string;
  url:      string;
  width:    number;
  height:   number;
}

interface FastApiResponse {
  items: FastApiItem[];
}

export async function POST(request: NextRequest) {
  const env = getFastApiEnv();
  if (env instanceof NextResponse) return env;

  const body = (await request.json()) as ClientRequest;

  const res = await fetch(`${env.base}/api/v1/modify/batch`, {
    method: "POST",
    headers: jsonHeaders(env.key),
    body: JSON.stringify({
      session_id:  body.sessionId,
      asset_ids:   body.assetIds,
      adjustments: {
        brightness:   body.adjustments.brightness,
        contrast:     body.adjustments.contrast,
        saturation:   body.adjustments.saturation,
        rotation_deg: body.adjustments.rotationDeg,
        crop_aspect:  body.adjustments.cropAspect,
        crop_zoom:    body.adjustments.cropZoom,
      },
    }),
    signal: request.signal,
    cache: "no-store",
  });

  if (!res.ok) return forwardError(res);

  const data = (await res.json()) as FastApiResponse;
  return NextResponse.json({
    items: data.items.map((it) => ({
      assetId:  it.asset_id,
      filename: it.filename,
      url:      it.url,
      width:    it.width,
      height:   it.height,
    })),
  });
}
