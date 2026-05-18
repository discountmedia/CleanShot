// apps/web/app/api/history/route.ts
// BFF Route Handler — GET /api/history
// Returns the authenticated user's approval sets from the last 60 days.

import { type NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { getSessionEmail } from "@/lib/auth";

export const maxDuration = 15;
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  let userEmail: string;

  if (process.env.AUTH_ENABLED === "false") {
    userEmail = "dev@local";
  } else {
    const email = await getSessionEmail(await headers());
    if (!email) {
      return NextResponse.json({ detail: "Unauthorized" }, { status: 401 });
    }
    userEmail = email;
  }

  const res = await fetch(
    `${process.env.FASTAPI_INTERNAL_URL}/api/v1/history?user_email=${encodeURIComponent(userEmail)}`,
    {
      headers: {
        "X-Api-Key":    process.env.FASTAPI_INTERNAL_KEY!,
        "X-User-Email": userEmail,
      },
      signal: request.signal,
      cache: "no-store",
    }
  );

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    return NextResponse.json({ detail: text }, { status: res.status });
  }

  return NextResponse.json(await res.json());
}
