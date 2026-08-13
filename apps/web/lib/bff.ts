// apps/web/lib/bff.ts
// Shared helpers for BFF Route Handlers.
// Keeps the FASTAPI_INTERNAL_* env reads and X-Api-Key wiring in one place so
// each route file stays as a thin proxy.

import { NextResponse } from "next/server";
import { headers } from "next/headers";

import { getSessionEmail } from "./auth";

interface FastApiEnv {
  base: string;
  key:  string;
}

/**
 * Resolve the signed-in tenant user for the X-User-Email header.
 *
 * FastAPI's `require_authenticated_user` gates the session / job / asset /
 * scan-result reads on this header being present. It is an AUTHENTICATION
 * check, not ownership — editors share a queue, so the value is never compared
 * against a row. Forwarding it is therefore idempotent and cannot break a
 * shared-queue workflow; omitting it 404s the read.
 *
 * Mirrors the bypass semantics of app/page.tsx and /api/sessions: with
 * AUTH_ENABLED off the workspace runs as `dev@local`, which counts as
 * authenticated.
 */
export async function resolveUserEmail(): Promise<string | null> {
  if (process.env.AUTH_ENABLED === "true") {
    return getSessionEmail(await headers());
  }
  return "dev@local";
}

/**
 * {X-Api-Key} plus the identity header when we have one. For GET proxies that
 * don't send a JSON body — use `jsonHeaders` + a manual merge for POSTs.
 */
export async function authedHeaders(key: string): Promise<Record<string, string>> {
  const out: Record<string, string> = { "X-Api-Key": key };
  const email = await resolveUserEmail();
  if (email) out["X-User-Email"] = email;
  return out;
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
    retryCount:      j.retry_count,
    error:           j.error,
    createdAt:       j.created_at,
    updatedAt:       j.updated_at,
  };
}
