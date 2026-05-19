// apps/web/app/page.tsx
// Root route — renders the CleanShot workspace.
//
// Auth resolution:
//   AUTH_ENABLED=true   → require a Better Auth session, otherwise → /login
//   anything else       → render workspace with a "dev@local" identity (bypass)
//
// Auth is OFF unless explicitly enabled. Must match the proxy.ts semantics so
// proxy and page agree on whether to gate.
//
// The workspace shell + panel state live in <Workspace />, which is a Client
// Component. This file is intentionally a thin Server Component wrapper so the
// session lookup happens server-side.

import { redirect } from "next/navigation";
import { headers } from "next/headers";

import { Workspace } from "@/components/workspace/Workspace";
import { getSessionEmail } from "@/lib/auth";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const authEnabled = process.env.AUTH_ENABLED === "true";

  let userEmail = "dev@local";
  if (authEnabled) {
    const email = await getSessionEmail(await headers());
    if (!email) redirect("/login");
    userEmail = email;
  }

  return <Workspace userEmail={userEmail} bypassed={!authEnabled} />;
}
