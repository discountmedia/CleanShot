// apps/web/app/api/sessions/route.ts
// BFF Route Handler — POST /api/sessions
// Creates a new workspace session by proxying to FastAPI's POST /api/v1/sessions.
// FASTAPI_INTERNAL_KEY is server-only and never reaches the browser.

import { type NextRequest, NextResponse } from "next/server";

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

  const res = await fetch(`${base}/api/v1/sessions`, {
    method: "POST",
    headers: {
      "X-Api-Key":   key,
      "Content-Type": "application/json",
    },
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
