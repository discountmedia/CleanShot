// apps/web/app/api/admin/support/[id]/route.ts
// PATCH a single ticket — status / admin_notes. isAdmin-gated.

import { type NextRequest, NextResponse } from "next/server";
import { headers as nextHeaders } from "next/headers";

import { forwardError, getFastApiEnv, jsonHeaders } from "@/lib/bff";
import { getSessionAdmin } from "@/lib/auth";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

interface ClientPatch {
  status?:     "open" | "in_progress" | "closed";
  adminNotes?: string | null;
}

export async function PATCH(
  request: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const { admin } = await getSessionAdmin(await nextHeaders());
  if (!admin) {
    return NextResponse.json({ detail: "Admin access required" }, { status: 403 });
  }

  const env = getFastApiEnv();
  if (env instanceof NextResponse) return env;

  const { id } = await ctx.params;
  const body = (await request.json()) as ClientPatch;

  const res = await fetch(`${env.base}/api/v1/admin/support/${id}`, {
    method: "PATCH",
    headers: jsonHeaders(env.key),
    body: JSON.stringify({
      status:      body.status,
      admin_notes: body.adminNotes,
    }),
    signal: request.signal,
    cache: "no-store",
  });
  if (!res.ok) return forwardError(res);
  return NextResponse.json(await res.json());
}
