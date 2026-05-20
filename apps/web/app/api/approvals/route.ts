// apps/web/app/api/approvals/route.ts
// BFF Route Handler — POST /api/approvals
//
// Reads the authenticated user's email from the Better Auth session,
// injects it into the FastAPI request, and proxies to the backend.
// The session email becomes the GCS directory owner and Postgres FK.
//
// AUTH_ENABLED=false → email defaults to "dev@local" for testing.

import { type NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { getSessionEmail } from "@/lib/auth";

export const maxDuration = 30;
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  // Resolve authenticated email
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

  const body = (await request.json()) as {
    sessionId: string;
    assetIds: string[];
    projectMeta?: { make?: string; model?: string; year?: string };
  };

  // FastAPI's approval schema is snake_case. Translate at the BFF
  // boundary — same pattern as /api/sessions and /api/projects/save.
  // userEmail is injected here (not trusted from the client body).
  const res = await fetch(
    `${process.env.FASTAPI_INTERNAL_URL}/api/v1/approvals`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key":    process.env.FASTAPI_INTERNAL_KEY!,
        "X-User-Email": userEmail,   // Backend cross-checks this against user_email in body
      },
      body: JSON.stringify({
        session_id:   body.sessionId,
        asset_ids:    body.assetIds,
        user_email:   userEmail,
        project_meta: body.projectMeta,
      }),
      signal: request.signal,
      cache: "no-store",
    }
  );

  if (!res.ok) {
    const text = await res.text().catch(() => res.statusText);
    return NextResponse.json(
      { detail: text, status: res.status },
      { status: res.status }
    );
  }

  return NextResponse.json(await res.json());
}
