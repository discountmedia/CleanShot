// apps/web/app/api/sessions/route.ts
// BFF Route Handler — POST /api/sessions
// Creates a new workspace session by proxying to FastAPI's POST /api/v1/sessions.
// FASTAPI_INTERNAL_KEY is server-only and never reaches the browser.

import { type NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { getSessionEmail } from "@/lib/auth";

export const maxDuration = 15;
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const base = process.env.FASTAPI_INTERNAL_URL;
  const key  = process.env.FASTAPI_INTERNAL_KEY;
  if (!base || !key) {
    return NextResponse.json(
      { detail: "FASTAPI_INTERNAL_URL / FASTAPI_INTERNAL_KEY env vars are not set" },
      { status: 500 }
    );
  }

  // Resolve the signed-in user's email so the new session row gets
  // tagged with who created it. Powers per-user attribution on the
  // admin dashboard (projects + usage_events join through sessions).
  // Bypass mode falls back to dev@local.
  let userEmail: string | null;
  if (process.env.AUTH_ENABLED === "true") {
    userEmail = await getSessionEmail(await headers());
  } else {
    userEmail = "dev@local";
  }

  const fwd: Record<string, string> = {
    "X-Api-Key":   key,
    "Content-Type": "application/json",
  };
  if (userEmail) fwd["X-User-Email"] = userEmail;

  const res = await fetch(`${base}/api/v1/sessions`, {
    method: "POST",
    headers: fwd,
    body: "{}",
    signal: request.signal,
    cache: "no-store",
  });

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    return NextResponse.json({ detail: text }, { status: res.status });
  }

  // FastAPI returns { session_id: "..." }. The frontend expects { sessionId: "..." }.
  const data = await res.json() as { session_id: string };
  return NextResponse.json({ sessionId: data.session_id }, { status: 201 });
}
