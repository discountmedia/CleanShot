// apps/web/app/api/known-models/route.ts
// BFF Route Handler — GET the known Make + Model list behind the Make and
// Model dropdowns. Company-wide, so any signed-in user; never public.
//
// Seeded from the inventory CSV and the forklift catalog, and grown by
// operators through "Other": a new pair is recorded by FastAPI when a project
// is saved, not by this route.
// Hidden entries are left out here. Renaming and hiding are admin-only, under
// /api/admin/known-models.

import { type NextRequest, NextResponse } from "next/server";

import { authedHeaders, forwardError, getFastApiEnv, resolveUserEmail } from "@/lib/bff";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const email = await resolveUserEmail();
  if (!email) return NextResponse.json({ detail: "Unauthorized" }, { status: 401 });

  const env = getFastApiEnv();
  if (env instanceof NextResponse) return env;

  const res = await fetch(`${env.base}/api/v1/known-models`, {
    headers: await authedHeaders(env.key),
    signal: request.signal,
    cache: "no-store",
  });
  if (!res.ok) return forwardError(res);
  return NextResponse.json(await res.json());
}
