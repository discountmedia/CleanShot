// apps/web/app/api/admin/known-models/route.ts
// BFF Route Handler — GET every known Make + Model entry, hidden ones
// included, for the admin cleanup tab. Gated by isAdmin(session.email), the
// same gate as the rest of /api/admin; FastAPI trusts the BFF for it.

import { type NextRequest, NextResponse } from "next/server";
import { headers as nextHeaders } from "next/headers";

import { getSessionAdmin } from "@/lib/auth";
import { forwardError, getFastApiEnv } from "@/lib/bff";

export const maxDuration = 15;
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const { admin } = await getSessionAdmin(await nextHeaders());
  if (!admin) return NextResponse.json({ detail: "Admin access required" }, { status: 403 });

  const env = getFastApiEnv();
  if (env instanceof NextResponse) return env;

  const res = await fetch(`${env.base}/api/v1/admin/known-models`, {
    headers: { "X-Api-Key": env.key },
    signal: request.signal,
    cache: "no-store",
  });
  if (!res.ok) return forwardError(res);
  return NextResponse.json(await res.json());
}
