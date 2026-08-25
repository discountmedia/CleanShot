// apps/web/app/api/prompts/[id]/route.ts
// BFF Route Handler — DELETE one shared template. Admin only.
//
// There is no PATCH here, and that is deliberate: template titles and bodies
// are immutable once saved. Votes and use counts are ratings of a specific
// text, so editing the row under them would leave the reputation attached to
// something nobody endorsed. Customising is load → edit → save under a new
// title. See routers/saved_prompts.py for the long version.
//
// FastAPI enforces the admin rule itself and 403s a non-admin; this layer only
// supplies the fact it alone holds — whether the caller is on the ADMIN_EMAILS
// allowlist (X-User-Is-Admin, from lib/auth.ts), the same trust model
// /api/admin/* uses.

import { type NextRequest, NextResponse } from "next/server";

import { isAdmin } from "@/lib/auth";
import { authedHeaders, forwardError, getFastApiEnv, resolveUserEmail } from "@/lib/bff";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export async function DELETE(request: NextRequest, ctx: RouteContext) {
  const email = await resolveUserEmail();
  if (!email) return NextResponse.json({ detail: "Unauthorized" }, { status: 401 });

  const env = getFastApiEnv();
  if (env instanceof NextResponse) return env;

  const { id } = await ctx.params;
  const res = await fetch(`${env.base}/api/v1/prompts/${id}`, {
    method: "DELETE",
    headers: {
      ...(await authedHeaders(env.key)),
      "X-User-Is-Admin": String(isAdmin(email)),
    },
    signal: request.signal,
    cache: "no-store",
  });
  if (!res.ok) return forwardError(res);
  // FastAPI answers 204; there is no body to forward.
  return new NextResponse(null, { status: 204 });
}
