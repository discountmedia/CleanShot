// apps/web/app/api/auth/[...all]/route.ts
// Better Auth v1.6.11 catch-all Route Handler.
// Handles: /api/auth/sign-in/microsoft, /api/auth/callback/microsoft,
//          /api/auth/get-session, /api/auth/sign-out, etc.

import { getAuth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";

// Defer handler creation so module load doesn't require DATABASE_URL
// (Next.js build collects page data without env vars set).
let cached: ReturnType<typeof toNextJsHandler> | null = null;
const handlers = () => (cached ??= toNextJsHandler(getAuth().handler));

export async function GET(req: Request)  { return handlers().GET(req); }
export async function POST(req: Request) { return handlers().POST(req); }
