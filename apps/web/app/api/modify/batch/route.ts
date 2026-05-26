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
  /** Optional per-image overrides. Keys are asset IDs from assetIds. */
  perAsset?:   Record<string, ClientAdjustments>;
}

function toSnake(a: ClientAdjustments) {
  return {
    brightness:   a.brightness,
    contrast:     a.contrast,
    saturation:   a.saturation,
    rotation_deg: a.rotationDeg,
    crop_aspect:  a.cropAspect,
    crop_zoom:    a.cropZoom,
  };
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
      adjustments: toSnake(body.adjustments),
      per_asset:   body.perAsset
        ? Object.fromEntries(
            Object.entries(body.perAsset).map(([k, v]) => [k, toSnake(v)]),
          )
        : {},
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
