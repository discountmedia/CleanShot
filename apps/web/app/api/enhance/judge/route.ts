// apps/web/app/api/enhance/judge/route.ts
// BFF Route Handler — POST /api/enhance/judge
// Proxies to FastAPI's POST /api/v1/enhance/judge. Auto-pick "best of N":
// given the completed enhance variants for one source image, FastAPI runs a
// single Claude vision call that ranks them and names a winner. SYNCHRONOUS —
// unlike the enqueue endpoints this returns the ranking inline (no job_id), so
// we give it extra duration headroom for the vision round-trip.
//
// camel→snake on the way in, snake→camel on the way out.

import { type NextRequest, NextResponse } from "next/server";

import { forwardError, getFastApiEnv, jsonHeaders } from "@/lib/bff";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

interface ClientRequest {
  sessionId: string;
  originalAssetId?: string;
  candidates: Array<{ provider: string; assetId: string }>;
  equipmentType?: string;
  make?: string;
}

interface FastApiRanking {
  provider: string;
  asset_id: string;
  verdict: "pass" | "fail";
  score: number;
  reason: string;
}

interface FastApiResponse {
  winner_provider: string;
  winner_asset_id: string;
  all_pass: boolean;
  any_pass: boolean;
  rankings: FastApiRanking[];
}

export async function POST(request: NextRequest) {
  const env = getFastApiEnv();
  if (env instanceof NextResponse) return env;

  const body = (await request.json()) as ClientRequest;

  const res = await fetch(`${env.base}/api/v1/enhance/judge`, {
    method: "POST",
    headers: jsonHeaders(env.key),
    body: JSON.stringify({
      session_id: body.sessionId,
      ...(body.originalAssetId ? { original_asset_id: body.originalAssetId } : {}),
      candidates: body.candidates.map((c) => ({
        provider: c.provider,
        asset_id: c.assetId,
      })),
      ...(body.equipmentType ? { equipment_type: body.equipmentType } : {}),
      ...(body.make?.trim() ? { make: body.make } : {}),
    }),
    signal: request.signal,
    cache: "no-store",
  });

  if (!res.ok) return forwardError(res);

  const data = (await res.json()) as FastApiResponse;
  return NextResponse.json({
    winnerProvider: data.winner_provider,
    winnerAssetId: data.winner_asset_id,
    allPass: data.all_pass,
    anyPass: data.any_pass,
    rankings: data.rankings.map((r) => ({
      provider: r.provider,
      assetId: r.asset_id,
      verdict: r.verdict,
      score: r.score,
      reason: r.reason,
    })),
  });
}
