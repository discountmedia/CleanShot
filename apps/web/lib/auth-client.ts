"use client";
// apps/web/lib/auth-client.ts
// Better Auth v1.6.11 client instance.
// Import this in Client Components — never import lib/auth.ts on the client.

import { createAuthClient } from "better-auth/react";

export const authClient = createAuthClient({
  baseURL: typeof window !== "undefined" ? window.location.origin : "",
});

export const { signIn, signOut, useSession } = authClient;
