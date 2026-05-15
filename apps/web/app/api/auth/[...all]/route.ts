// apps/web/app/api/auth/[...all]/route.ts
// Better Auth v1.6.11 catch-all Route Handler.
// Handles: /api/auth/sign-in/microsoft, /api/auth/callback/microsoft,
//          /api/auth/get-session, /api/auth/sign-out, etc.

import { auth } from "@/lib/auth";
import { toNextJsHandler } from "better-auth/next-js";

export const { GET, POST } = toNextJsHandler(auth.handler);
