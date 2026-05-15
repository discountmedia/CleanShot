// apps/web/app/api/enhance/regen/route.ts
// BFF Route Handler — POST /api/enhance/regen
// Proxies a single-image regen request to FastAPI.
// Called from ScanPanel when user clicks "Regenerate Image".
// FASTAPI_INTERNAL_KEY is injected server-side — never reaches the browser.

import { type NextRequest, NextResponse } from "next/server";

export const maxDuration = 15;           // Enqueue only — returns job_id immediately
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = await request.json();

  const res = await fetch(
    `${process.env.FASTAPI_INTERNAL_URL}/api/v1/enhance/regen`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": process.env.FASTAPI_INTERNAL_KEY!,
      },
      body: JSON.stringify(body),
      signal: request.signal,   // propagate AbortSignal — prevents zombie Cloud Run connections
      cache: "no-store",
    }
  );

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    return NextResponse.json(
      { error: "upstream failed", detail: text, status: res.status },
      { status: res.status }
    );
  }

  return NextResponse.json(await res.json());
}
