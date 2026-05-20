// apps/web/app/api/profile/route.ts
// BFF Route Handler — GET / PUT the signed-in user's profile.
// User identity (X-User-Email) is read from the Better Auth session here
// and forwarded to FastAPI — clients can't spoof which profile they edit.

import { type NextRequest, NextResponse } from "next/server";
import { headers as nextHeaders } from "next/headers";

import { forwardError, getFastApiEnv, jsonHeaders } from "@/lib/bff";
import { getSessionEmail } from "@/lib/auth";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

async function resolveEmail(): Promise<string | null> {
  if (process.env.AUTH_ENABLED === "true") {
    return await getSessionEmail(await nextHeaders());
  }
  return "dev@local";
}

interface FastApiProfile {
  user_email: string;
  full_name:  string | null;
  work_phone: string | null;
  location:   string | null;
  avatar_uri: string | null;
  avatar_url: string | null;
  created_at: string;
  updated_at: string;
}

function toCamel(p: FastApiProfile) {
  return {
    userEmail:  p.user_email,
    fullName:   p.full_name,
    workPhone:  p.work_phone,
    location:   p.location,
    avatarUri:  p.avatar_uri,
    avatarUrl:  p.avatar_url,
    createdAt:  p.created_at,
    updatedAt:  p.updated_at,
  };
}

export async function GET(request: NextRequest) {
  const email = await resolveEmail();
  if (!email) return NextResponse.json({ detail: "Unauthorized" }, { status: 401 });

  const env = getFastApiEnv();
  if (env instanceof NextResponse) return env;

  const res = await fetch(`${env.base}/api/v1/profile`, {
    headers: { ...jsonHeaders(env.key), "X-User-Email": email },
    signal: request.signal,
    cache: "no-store",
  });
  if (!res.ok) return forwardError(res);
  const data = (await res.json()) as FastApiProfile;
  return NextResponse.json(toCamel(data));
}

interface ClientUpdate {
  fullName?:  string | null;
  workPhone?: string | null;
  location?:  string | null;
}

export async function PUT(request: NextRequest) {
  const email = await resolveEmail();
  if (!email) return NextResponse.json({ detail: "Unauthorized" }, { status: 401 });

  const env = getFastApiEnv();
  if (env instanceof NextResponse) return env;

  const body = (await request.json()) as ClientUpdate;
  const res = await fetch(`${env.base}/api/v1/profile`, {
    method:  "PUT",
    headers: { ...jsonHeaders(env.key), "X-User-Email": email },
    body: JSON.stringify({
      full_name:  body.fullName  ?? null,
      work_phone: body.workPhone ?? null,
      location:   body.location  ?? null,
    }),
    signal: request.signal,
    cache: "no-store",
  });
  if (!res.ok) return forwardError(res);
  const data = (await res.json()) as FastApiProfile;
  return NextResponse.json(toCamel(data));
}
