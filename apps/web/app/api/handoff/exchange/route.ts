// apps/web/app/api/handoff/exchange/route.ts
// BFF Route Handler — POST /api/handoff/exchange
// Proxies to FastAPI's POST /api/v1/ingest/handoff/exchange.
//
// Exchanges the short-TTL single-use token minted by media-auditor's
// /api/v1/ingest/handoff for the CleanShot session ingest already created.
// Server-to-server auth is the existing X-Api-Key; it never reaches the browser.
//
// ─── Re-presenting a consumed token is NOT an error ──────────────────────────
// When the SAME authenticated user presents an already-spent token, the
// upstream returns the session it already created. Reject only on expiry or
// user mismatch. If that reads as laxness and you are about to tighten it:
// reload and back-navigation are normal user behaviour, and React StrictMode
// double-invokes the exchange effect in development, so the second attempt
// always presents a spent token. Tightening this breaks `next dev` and the
// browser's back button, not an attack.
//
// ─── Why this route does NOT use lib/bff.ts's forwardError ───────────────────
// `forwardError` returns FastAPI's raw response body to the browser as
// { detail }. There is no custom RequestValidationError handler in the FastAPI
// app, so a Pydantic 422 carries an `input` field echoing the offending value
// for each error `loc`. If the token were ever a constrained field, a malformed
// token would be echoed straight back through that path. The FastAPI side keeps
// the token as an unconstrained `str` and validates in the handler body for
// exactly that reason — and this route adds the second layer: every non-OK
// response collapses to a FIXED string, and every OK response is rebuilt from a
// three-field whitelist so nothing the upstream adds later can ride along.
//
// The token is never logged here, in any form.

import { type NextRequest, NextResponse } from "next/server";
import { headers } from "next/headers";
import { getSessionEmail } from "@/lib/auth";

export const maxDuration = 15;
export const dynamic = "force-dynamic";

interface ClientRequest {
  token: string;
}

interface FastApiResponse {
  session_id: string;
  handoff_id: string;
  expected_count: number;
}

/** Fixed rejection copy. Deliberately says nothing about which check failed. */
const REJECTED = "Import link is no longer valid.";
const UNAVAILABLE = "Could not reach the import service.";

export async function POST(request: NextRequest) {
  const base = process.env.FASTAPI_INTERNAL_URL;
  const key = process.env.FASTAPI_INTERNAL_KEY;
  if (!base || !key) {
    return NextResponse.json(
      { detail: "FASTAPI_INTERNAL_URL / FASTAPI_INTERNAL_KEY env vars are not set" },
      { status: 500 },
    );
  }

  // Identity the token gets bound against. FastAPI rejects the exchange when
  // this does not match the user who requested the handoff. Bypass mode falls
  // back to dev@local, matching /api/sessions.
  let userEmail: string | null;
  if (process.env.AUTH_ENABLED === "true") {
    userEmail = await getSessionEmail(await headers());
  } else {
    userEmail = "dev@local";
  }

  let body: ClientRequest;
  try {
    body = (await request.json()) as ClientRequest;
  } catch {
    return NextResponse.json({ detail: REJECTED }, { status: 400 });
  }
  if (typeof body?.token !== "string" || !body.token.trim()) {
    return NextResponse.json({ detail: REJECTED }, { status: 400 });
  }

  const fwd: Record<string, string> = {
    "X-Api-Key": key,
    "Content-Type": "application/json",
  };
  if (userEmail) fwd["X-User-Email"] = userEmail;

  let res: Response;
  try {
    res = await fetch(`${base}/api/v1/ingest/handoff/exchange`, {
      method: "POST",
      headers: fwd,
      // Token travels in the BODY. Never the path — a 404 on a path-carried
      // token would put it in the upstream's access log.
      body: JSON.stringify({ token: body.token }),
      signal: request.signal,
      cache: "no-store",
    });
  } catch {
    // Network-level failure reaching FastAPI. Client treats 5xx as
    // "unavailable" and degrades to a normal session.
    return NextResponse.json({ detail: UNAVAILABLE }, { status: 502 });
  }

  if (!res.ok) {
    // NO body pass-through. Preserve only the status class so the client can
    // tell "rejected" (4xx: expired / user mismatch) from "unavailable"
    // (5xx: could not get an answer). Which check failed is recorded
    // server-side against handoff_id, not surfaced here.
    const status = res.status >= 500 ? 502 : 403;
    return NextResponse.json(
      { detail: status >= 500 ? UNAVAILABLE : REJECTED },
      { status },
    );
  }

  const data = (await res.json()) as FastApiResponse;

  // Explicit whitelist, camelCased. The token is NOT among these fields and
  // must never be added — the success response must not echo it back.
  return NextResponse.json(
    {
      sessionId: data.session_id,
      handoffId: data.handoff_id,
      expectedCount: data.expected_count,
    },
    { status: 200 },
  );
}
