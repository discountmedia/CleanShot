// apps/web/app/api/profile/avatar/route.ts
//
// Two-step avatar upload BFF:
//   POST /api/profile/avatar         { contentType } → { uploadUrl, gcsUri }
//   POST /api/profile/avatar/commit  { gcsUri }      → { ...profile }
//
// The browser PUTs the resized avatar bytes directly to GCS using the
// signed URL between the two requests. Identity is resolved here from
// the Better Auth session and forwarded to FastAPI as X-User-Email.

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

interface MintRequest {
  contentType?: string;
}

export async function POST(request: NextRequest) {
  const email = await resolveEmail();
  if (!email) return NextResponse.json({ detail: "Unauthorized" }, { status: 401 });

  const env = getFastApiEnv();
  if (env instanceof NextResponse) return env;

  const body = (await request.json().catch(() => ({}))) as MintRequest;
  const contentType = body.contentType ?? "image/jpeg";

  const res = await fetch(`${env.base}/api/v1/profile/avatar`, {
    method: "POST",
    headers: {
      ...jsonHeaders(env.key),
      "X-User-Email":         email,
      "X-Avatar-Content-Type": contentType,
    },
    signal: request.signal,
    cache: "no-store",
  });
  if (!res.ok) return forwardError(res);

  const data = (await res.json()) as { upload_url: string; gcs_uri: string };
  return NextResponse.json({ uploadUrl: data.upload_url, gcsUri: data.gcs_uri });
}
