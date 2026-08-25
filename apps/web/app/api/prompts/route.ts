// apps/web/app/api/prompts/route.ts
// BFF Route Handler — GET (list) / POST (save) the SHARED prompt templates.
//
// Shared since 2026-08-25: the list is the same for every signed-in user, so
// GET no longer scopes by identity. A session is still required — the library
// is company-wide, not public. The one per-viewer field is `votedByMe`, which
// FastAPI resolves from the forwarded email.
//
// GET also carries each template's vote and use counts, because the client
// sorts on them (recent / top rated / most used) and a sort needs the whole
// set in hand. Switching sort is therefore instant, not a round-trip.
//
// Identity is resolved from the Better Auth session HERE and forwarded as
// X-User-Email, exactly as /api/profile does. It decides authorship on create
// and `votedByMe` on read; the client never names whose templates it wants.
//
// The admin allowlist lives in lib/auth.ts and nowhere else; it is forwarded
// as X-User-Is-Admin on the delete path (see [id]/route.ts) and reported here
// as `canDelete`. FastAPI trusts that header because the BFF is its only
// caller in production, the same arrangement /api/admin/* uses.

import { type NextRequest, NextResponse } from "next/server";

import { isAdmin } from "@/lib/auth";
import { authedHeaders, forwardError, getFastApiEnv, resolveUserEmail } from "@/lib/bff";

export const maxDuration = 10;
export const dynamic = "force-dynamic";

interface FastApiPrompt {
  id:           string;
  user_email:   string;
  title:        string;
  body:         string;
  author_name:  string | null;
  vote_count:   number;
  voted:        boolean;
  use_count:    number;
  created_at:   string;
  updated_at:   string;
}

/**
 * Shape one template for the client, resolving the two things only this layer
 * knows: who is looking (`canDelete`) and what to call the author.
 *
 * The byline falls back through full_name → email local-part → the raw email,
 * so it is never blank. A user who has never opened their profile page has no
 * user_profiles row at all, which is the common case for a new hire.
 *
 * `canDelete` is admin-ness, not ownership. Deleting removes a template for
 * everybody, so it is curation of a shared library rather than tidying your
 * own drawer — the author of a well-used template is the last person who
 * should be able to pull it unilaterally.
 */
function toCamel(p: FastApiPrompt, viewer: string, admin: boolean) {
  const local = p.user_email.split("@")[0];
  return {
    id:          p.id,
    title:       p.title,
    body:        p.body,
    authorEmail: p.user_email,
    authorName:  p.author_name?.trim() || local || p.user_email,
    authorIsMe:  p.user_email.toLowerCase() === viewer.toLowerCase(),
    canDelete:   admin,
    voteCount:   p.vote_count ?? 0,
    votedByMe:   p.voted ?? false,
    useCount:    p.use_count ?? 0,
    createdAt:   p.created_at,
    updatedAt:   p.updated_at,
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
  const admin = isAdmin(email);
  return NextResponse.json(data.map((p) => toCamel(p, email, admin)));
}

interface ClientCreate {
  title: string;
  body:  string;
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
    body: JSON.stringify({ title: body.title, body: body.body }),
    signal: request.signal,
    cache: "no-store",
  });
  // A 409 here is the title-collision answer, and the client branches on that
  // status — so it has to survive as a 409 rather than becoming a generic
  // error. Titles are permanent and there is no overwrite, so the only
  // resolution is a different title; the detail string names who holds the
  // one that's taken, which is why forwardError preserving the body matters
  // as much as the status.
  if (!res.ok) return forwardError(res);
  const data = (await res.json()) as FastApiPrompt;
  return NextResponse.json(toCamel(data, email, isAdmin(email)));
}
