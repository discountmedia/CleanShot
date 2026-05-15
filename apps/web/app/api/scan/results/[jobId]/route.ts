// apps/web/app/api/scan/results/[jobId]/route.ts
// BFF Route Handler — GET /api/scan/results/:jobId
// Returns per-provider scan results + consensus for a completed scan job.
// Next.js 16: params is a Promise — always await.

import { type NextRequest, NextResponse } from "next/server";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ jobId: string }> }
) {
  const { jobId } = await params;   // REQUIRED: Next.js 16 async params

  const res = await fetch(
    `${process.env.FASTAPI_INTERNAL_URL}/api/v1/scan/results/${jobId}`,
    {
      headers: { "X-Api-Key": process.env.FASTAPI_INTERNAL_KEY! },
      signal: request.signal,
      cache: "no-store",
    }
  );

  if (!res.ok) {
    return NextResponse.json(
      { error: "upstream failed", status: res.status },
      { status: res.status }
    );
  }

  return NextResponse.json(await res.json());
}
