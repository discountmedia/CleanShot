// apps/web/app/api/profile/avatar/commit/route.ts
// POST { gcsUri } — link the freshly-uploaded avatar to the
// signed-in user's profile row. Returns the updated profile.

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

export async function POST(request: NextRequest) {
  const email = await resolveEmail();
  if (!email) return NextResponse.json({ detail: "Unauthorized" }, { status: 401 });

  const env = getFastApiEnv();
  if (env instanceof NextResponse) return env;

  const body = (await request.json()) as { gcsUri?: string };
  if (!body.gcsUri) {
    return NextResponse.json({ detail: "gcsUri required" }, { status: 400 });
  }

  const res = await fetch(`${env.base}/api/v1/profile/avatar/commit`, {
    method: "POST",
    headers: { ...jsonHeaders(env.key), "X-User-Email": email },
    body: JSON.stringify({ gcs_uri: body.gcsUri }),
    signal: request.signal,
    cache: "no-store",
  });
  if (!res.ok) return forwardError(res);

  const p = (await res.json()) as FastApiProfile;
  return NextResponse.json({
    userEmail: p.user_email,
    fullName:  p.full_name,
    workPhone: p.work_phone,
    location:  p.location,
    avatarUri: p.avatar_uri,
    avatarUrl: p.avatar_url,
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  });
}
