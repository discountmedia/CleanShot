// apps/web/app/api/admin/known-models/[id]/route.ts
// BFF Route Handler — PATCH one known Make + Model entry: rename it, or hide
// or show it. Admin-only. There is no DELETE: the inventory seed runs on every
// API start and would bring a deleted inventory row back, so hiding is the
// removal. A rename that would duplicate another entry comes back as 409.

import { type NextRequest, NextResponse } from "next/server";
import { headers as nextHeaders } from "next/headers";

import { getSessionAdmin } from "@/lib/auth";
import { forwardError, getFastApiEnv, jsonHeaders } from "@/lib/bff";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

interface ClientPatch {
  make?: string;
  model?: string;
  hidden?: boolean;
}

export async function PATCH(request: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { admin } = await getSessionAdmin(await nextHeaders());
  if (!admin) return NextResponse.json({ detail: "Admin access required" }, { status: 403 });

  const env = getFastApiEnv();
  if (env instanceof NextResponse) return env;

  const { id } = await ctx.params;
  const body = (await request.json()) as ClientPatch;
  // Only the three fields this route is for, and only when they are the
  // right type, so a malformed client cannot pass anything else through.
  const out: ClientPatch = {};
  if (typeof body.make === "string") out.make = body.make;
  if (typeof body.model === "string") out.model = body.model;
  if (typeof body.hidden === "boolean") out.hidden = body.hidden;

  const res = await fetch(`${env.base}/api/v1/admin/known-models/${encodeURIComponent(id)}`, {
    method: "PATCH",
    headers: jsonHeaders(env.key),
    body: JSON.stringify(out),
    signal: request.signal,
    cache: "no-store",
  });
  if (!res.ok) return forwardError(res);
  return NextResponse.json(await res.json());
}
