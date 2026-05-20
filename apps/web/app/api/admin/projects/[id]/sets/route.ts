// apps/web/app/api/admin/projects/[id]/sets/route.ts
// BFF Route Handler — GET /api/admin/projects/[id]/sets
// Returns the approval sets + assets tied to this project's session.
// Admin-gated; the FastAPI route bypasses the email-match check that
// the user-facing /api/v1/history enforces.

import { type NextRequest, NextResponse } from "next/server";
import { headers as nextHeaders } from "next/headers";

import { getSessionAdmin } from "@/lib/auth";

export const maxDuration = 15;
export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
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

  const { id } = await ctx.params;
  // Reject anything that isn't a UUID-shape string before passing to FastAPI.
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ detail: "Invalid project id" }, { status: 400 });
  }

  const url = `${base}/api/v1/admin/projects/${encodeURIComponent(id)}/sets`;

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
