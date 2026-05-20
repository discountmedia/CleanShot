// apps/web/app/admin/page.tsx
// Admin dashboard root.
//
// Gating happens here (Server Component) — non-admins get a 404-like
// redirect to the operator workspace. ADMIN_EMAILS env var is the
// allowlist; bypass mode (AUTH_ENABLED=false) treats dev@local as
// admin so local development still works.

import { redirect } from "next/navigation";
import { headers } from "next/headers";

import { getSessionAdmin } from "@/lib/auth";
import { AdminDashboard } from "@/components/admin/AdminDashboard";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const { email, admin } = await getSessionAdmin(await headers());

  if (process.env.AUTH_ENABLED === "true" && !email) {
    redirect("/login?callbackUrl=%2Fadmin");
  }
  if (!admin) {
    // Don't leak existence of /admin to non-admins — redirect to the
    // workspace as if the URL didn't exist. They'll see the operator
    // app like normal.
    redirect("/");
  }

  return <AdminDashboard userEmail={email ?? "dev@local"} />;
}
