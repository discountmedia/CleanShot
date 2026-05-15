// apps/web/app/history/page.tsx
// User's 30-day image enhancement history — Server Component shell.
// Lists all approval sets created by the authenticated user in the last 30 days.
// Each set shows: date, make/model, image count, thumbnails, download link.

import Link from "next/link";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { getSessionEmail } from "@/lib/auth";
import { HistoryList } from "@/components/history/HistoryList";

export const dynamic = "force-dynamic";

export default async function HistoryPage() {
  // AUTH_ENABLED=false → use dev email
  let userEmail: string;

  if (process.env.AUTH_ENABLED === "false") {
    userEmail = "dev@local";
  } else {
    const email = await getSessionEmail(await headers());
    if (!email) redirect("/login");
    userEmail = email;
  }

  return (
    <div className="min-h-screen bg-zinc-950 text-white">
      <div className="max-w-5xl mx-auto px-4 py-8 space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-xl font-bold text-white">My Enhancement History</h1>
            <p className="text-sm text-zinc-500 mt-1">
              Last 30 days · {userEmail}
            </p>
          </div>
          <Link
            href="/"
            className="text-sm text-blue-400 hover:text-blue-300 transition-colors"
          >
            ← Back to workspace
          </Link>
        </div>

        <HistoryList userEmail={userEmail} />
      </div>
    </div>
  );
}
