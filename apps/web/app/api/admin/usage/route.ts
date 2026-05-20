// apps/web/app/api/admin/usage/route.ts
// BFF Route Handler — GET /api/admin/usage?days=30
// Gated by isAdmin(session.email).

import { type NextRequest, NextResponse } from "next/server";
import { headers as nextHeaders } from "next/headers";

import { getSessionAdmin } from "@/lib/auth";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const { admin } = await getSessionAdmin(await nextHeaders());
  if (!admin) {
    return NextResponse.json({ detail: "Admin access required" }, { status: 403 });
  }

  const base = process.env.FASTAPI_INTERNAL_URL;
  const key  = process.env.FASTAPI_INTERNAL_KEY;
  if (!base || !key) {
    return NextResponse.json(
      { detail: "FASTAPI_INTERNAL_URL / FASTAPI_INTERNAL_KEY not set" },
      { status: 500 },
    );
  }

  const qs = request.nextUrl.searchParams.toString();
  const url = `${base}/api/v1/admin/usage${qs ? `?${qs}` : ""}`;

  const res = await fetch(url, {
    headers: { "X-Api-Key": key },
    signal: request.signal,
    cache: "no-store",
  });
  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    return NextResponse.json({ detail: text }, { status: res.status });
  }
  return NextResponse.json(await res.json());
}
