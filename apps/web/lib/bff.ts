// apps/web/lib/bff.ts
// Shared helpers for BFF Route Handlers.
// Keeps the FASTAPI_INTERNAL_* env reads and X-Api-Key wiring in one place so
// each route file stays as a thin proxy.

import { NextResponse } from "next/server";

interface FastApiEnv {
  base: string;
  key:  string;
}

/** Pulls FASTAPI_INTERNAL_URL / KEY or returns a 500 NextResponse if missing. */
export function getFastApiEnv(): FastApiEnv | NextResponse {
  const base = process.env.FASTAPI_INTERNAL_URL;
  const key  = process.env.FASTAPI_INTERNAL_KEY;
  if (!base || !key) {
    return NextResponse.json(
      { detail: "FASTAPI_INTERNAL_URL / FASTAPI_INTERNAL_KEY env vars are not set" },
      { status: 500 }
    );
  }
  return { base, key };
}

/** Build a standard {X-Api-Key, Content-Type: json} header set. */
export function jsonHeaders(key: string): HeadersInit {
  return { "X-Api-Key": key, "Content-Type": "application/json" };
}

/** Forward a non-OK FastAPI response as a NextResponse with the same status. */
export async function forwardError(res: Response): Promise<NextResponse> {
  const text = await res.text().catch(() => res.statusText);
  return NextResponse.json({ detail: text }, { status: res.status });
}

/**
 * Convert a snake_case JobRecord from FastAPI into the camelCase shape the
 * frontend expects (lib/types.ts JobRecord). Pulled out so /api/jobs/[id]
 * and /api/jobs/batch/[id] stay consistent.
 */
export function snakeJobToCamel(j: Record<string, unknown>): Record<string, unknown> {
  return {
    id:              j.id,
    sessionId:       j.session_id,
    operation:       j.operation,
    status:          j.status,
    inputAssetId:    j.input_asset_id,
    outputAssetId:   j.output_asset_id,
    error:           j.error,
    createdAt:       j.created_at,
    updatedAt:       j.updated_at,
  };
}
