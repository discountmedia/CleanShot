// apps/web/app/profile/page.tsx
// Per-user profile page.
//
// Server-side: resolve the signed-in user's email, redirect unauthed
// visitors to /login (or treat bypass mode as dev@local). Client
// component handles the actual UI + data fetching against the BFF
// /api/profile, /api/profile/avatar, /api/support endpoints.

import { redirect } from "next/navigation";
import { headers } from "next/headers";

import { getSessionEmail } from "@/lib/auth";
import { ProfilePage } from "@/components/profile/ProfilePage";

export const dynamic = "force-dynamic";

export default async function Profile() {
  const authEnabled = process.env.AUTH_ENABLED === "true";

  let userEmail = "dev@local";
  if (authEnabled) {
    const email = await getSessionEmail(await headers());
    if (!email) redirect("/login?callbackUrl=%2Fprofile");
    userEmail = email;
  }

  return <ProfilePage userEmail={userEmail} />;
}
