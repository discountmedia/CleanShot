// apps/web/app/api/admin/support/route.ts
// Admin view of all support tickets. isAdmin-gated.

import { type NextRequest, NextResponse } from "next/server";
import { headers as nextHeaders } from "next/headers";

import { forwardError, getFastApiEnv, jsonHeaders } from "@/lib/bff";
import { getSessionAdmin } from "@/lib/auth";

export const maxDuration = 15;
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const { admin } = await getSessionAdmin(await nextHeaders());
  if (!admin) {
    return NextResponse.json({ detail: "Admin access required" }, { status: 403 });
  }

  const env = getFastApiEnv();
  if (env instanceof NextResponse) return env;

  const qs = request.nextUrl.searchParams.toString();
  const url = `${env.base}/api/v1/admin/support${qs ? `?${qs}` : ""}`;

  const res = await fetch(url, {
    headers: { ...jsonHeaders(env.key) },
    signal: request.signal,
    cache: "no-store",
  });
  if (!res.ok) return forwardError(res);
  return NextResponse.json(await res.json());
}
