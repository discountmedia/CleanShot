// apps/web/app/api/prompts/route.ts
// BFF Route Handler — GET (list) / POST (save) the signed-in user's saved
// enhance prompts.
//
// Identity is resolved from the Better Auth session HERE and forwarded as
// X-User-Email, exactly as /api/profile does. The client never names whose
// prompts it wants, so it cannot ask for someone else's.

import { type NextRequest, NextResponse } from "next/server";

import { authedHeaders, forwardError, getFastApiEnv, resolveUserEmail } from "@/lib/bff";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

interface FastApiPrompt {
  id:         string;
  user_email: string;
  title:      string;
  body:       string;
  created_at: string;
  updated_at: string;
}

function toCamel(p: FastApiPrompt) {
  return {
    id:        p.id,
    title:     p.title,
    body:      p.body,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

export async function GET(request: NextRequest) {
  const email = await resolveUserEmail();
  if (!email) return NextResponse.json({ detail: "Unauthorized" }, { status: 401 });

  const env = getFastApiEnv();
  if (env instanceof NextResponse) return env;

  const res = await fetch(`${env.base}/api/v1/prompts`, {
    headers: await authedHeaders(env.key),
    signal: request.signal,
    cache: "no-store",
  });
  if (!res.ok) return forwardError(res);
  const data = (await res.json()) as FastApiPrompt[];
  return NextResponse.json(data.map(toCamel));
}

interface ClientCreate {
  title:      string;
  body:       string;
  /** Set only after the user answered the title-collision prompt with Overwrite. */
  overwrite?: boolean;
}

export async function POST(request: NextRequest) {
  const email = await resolveUserEmail();
  if (!email) return NextResponse.json({ detail: "Unauthorized" }, { status: 401 });

  const env = getFastApiEnv();
  if (env instanceof NextResponse) return env;

  const body = (await request.json()) as ClientCreate;
  const res = await fetch(`${env.base}/api/v1/prompts`, {
    method: "POST",
    headers: {
      ...(await authedHeaders(env.key)),
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      title:     body.title,
      body:      body.body,
      overwrite: body.overwrite ?? false,
    }),
    signal: request.signal,
    cache: "no-store",
  });
  // A 409 here is the title-collision answer, and the client branches on that
  // status — so it has to survive as a 409 rather than becoming a generic error.
  if (!res.ok) return forwardError(res);
  const data = (await res.json()) as FastApiPrompt;
  return NextResponse.json(toCamel(data));
}
