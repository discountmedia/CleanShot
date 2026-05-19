// apps/web/app/api/projects/save/route.ts
// BFF Route Handler — POST /api/projects/save
// Proxies to FastAPI's POST /api/v1/projects/save. Translates camel→snake
// on the way in. The save call upserts the project row and sets
// projects.saved_at, which is the gate that the export endpoints
// (export_pro, export_custom, export_fullsize, export_zip) check before
// they'll serve any asset.

import { type NextRequest, NextResponse } from "next/server";

import { forwardError, getFastApiEnv, jsonHeaders } from "@/lib/bff";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

interface ClientRequest {
  sessionId: string;
  title: string;
  make: string;
  year: number;
  model: string;
  tireType: string;
  capacity: string;
  fuelType: string;
  username: string;
  photoType: "auction" | "studio";
}

interface FastApiResponse {
  project_id: string;
}

export async function POST(request: NextRequest) {
  const env = getFastApiEnv();
  if (env instanceof NextResponse) return env;

  const body = (await request.json()) as ClientRequest;

  const res = await fetch(`${env.base}/api/v1/projects/save`, {
    method: "POST",
    headers: jsonHeaders(env.key),
    body: JSON.stringify({
      session_id: body.sessionId,
      title:      body.title,
      make:       body.make,
      year:       body.year,
      model:      body.model,
      tire_type:  body.tireType,
      capacity:   body.capacity,
      fuel_type:  body.fuelType,
      username:   body.username,
      photo_type: body.photoType,
    }),
    signal: request.signal,
    cache: "no-store",
  });

  if (!res.ok) return forwardError(res);

  const data = (await res.json()) as FastApiResponse;
  return NextResponse.json({ projectId: data.project_id });
}
