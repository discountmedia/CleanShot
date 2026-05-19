// apps/web/app/page.tsx
// Root route — renders the CleanShot workspace.
//
// Auth resolution:
//   AUTH_ENABLED=false  → render workspace with a "dev@local" identity (bypass)
//   AUTH_ENABLED=true   → require a Better Auth session, otherwise → /login
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
  const bypassed = process.env.AUTH_ENABLED === "false";

  let userEmail = "dev@local";
  if (!bypassed) {
    const email = await getSessionEmail(await headers());
    if (!email) redirect("/login");
    userEmail = email;
  }

  return <Workspace userEmail={userEmail} bypassed={bypassed} />;
}
