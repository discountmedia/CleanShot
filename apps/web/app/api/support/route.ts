// apps/web/app/api/support/route.ts
// POST a new support ticket / feature request. Identity is taken from
// the Better Auth session here so the user can't spoof who submitted.

import { type NextRequest, NextResponse } from "next/server";
import { headers as nextHeaders } from "next/headers";

import { forwardError, getFastApiEnv, jsonHeaders } from "@/lib/bff";
import { getSessionEmail } from "@/lib/auth";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

interface ClientTicket {
  type:    "support" | "feature";
  subject: string;
  body:    string;
}

export async function POST(request: NextRequest) {
  let userEmail: string | null;
  if (process.env.AUTH_ENABLED === "true") {
    userEmail = await getSessionEmail(await nextHeaders());
  } else {
    userEmail = "dev@local";
  }
  if (!userEmail) {
    return NextResponse.json({ detail: "Unauthorized" }, { status: 401 });
  }

  const env = getFastApiEnv();
  if (env instanceof NextResponse) return env;

  const body = (await request.json()) as ClientTicket;
  const res = await fetch(`${env.base}/api/v1/support`, {
    method: "POST",
    headers: { ...jsonHeaders(env.key), "X-User-Email": userEmail },
    body: JSON.stringify({
      type:    body.type,
      subject: body.subject,
      body:    body.body,
    }),
    signal: request.signal,
    cache: "no-store",
  });
  if (!res.ok) return forwardError(res);

  return NextResponse.json(await res.json(), { status: 201 });
}
