// apps/web/lib/auth.ts
// Better Auth v1.6.11 server configuration.
// Microsoft OAuth (Azure Entra ID) — any Microsoft account can attempt sign-in,
// but checkAuthorization() gates on domain/email allowlist before session is set.
//
// AUTH_ENABLED env var:
//   "false"  → bypass all auth (dev / testing mode, app works as today)
//   "true"   → full Microsoft OAuth + authorization gate
//
// Allowlist resolution order:
//   1. ALLOWED_DOMAINS env var  (comma-separated, e.g. "acme.com,partner.org")
//   2. ALLOWED_EMAILS env var   (comma-separated individual addresses)
//   3. Postgres `authorizations` table (runtime additions without redeploy)

import { betterAuth } from "better-auth";
import { Pool } from "pg";

if (!process.env.DATABASE_URL) {
  throw new Error("DATABASE_URL is required for Better Auth");
}

// Use a raw pg Pool — Better Auth autodetects it as a pg adapter.
// We reuse the same DATABASE_URL as the FastAPI backend for the user/session tables.
const pgPool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 3, // small pool — auth calls are infrequent
});

export const auth = betterAuth({
  database: pgPool,

  session: {
    expiresIn: 60 * 60 * 24 * 7,          // 7 days
    updateAge: 60 * 60 * 24,               // refresh cookie if >1 day old
    cookieCache: {
      enabled: true,
      maxAge: 60 * 5,                      // 5-minute client-side cache
    },
  },

  socialProviders: {
    microsoft: {
      clientId:     process.env.MICROSOFT_CLIENT_ID!,
      clientSecret: process.env.MICROSOFT_CLIENT_SECRET!,
      // "common" tenant = any Microsoft account (personal + org).
      // Set MICROSOFT_TENANT_ID to a specific tenant GUID to restrict.
      tenantId: process.env.MICROSOFT_TENANT_ID ?? "common",
    },
  },

  // Authorization gate: runs before the user row is created on first sign-in.
  // Throwing aborts the OAuth flow; the client surfaces this as an error and
  // can redirect to /unauthorized via the signIn callbackURL.
  // Note: existing users are NOT re-checked on subsequent sign-ins — to revoke
  // access, delete the user's row from the `user` table.
  databaseHooks: {
    user: {
      create: {
        before: async (user) => {
          if (process.env.AUTH_ENABLED === "false") return { data: user };
          const email = (user.email ?? "").toLowerCase();
          if (!(await checkAuthorization(email))) {
            throw new Error("Email not authorized to access CleanShot");
          }
          return { data: user };
        },
      },
    },
  },
});

// ─── Authorization check ──────────────────────────────────────────────────────

/**
 * Returns true if the email is authorized to use CleanShot.
 * Checks env-var allowlists first (fast, no DB), then Postgres table.
 */
export async function checkAuthorization(email: string): Promise<boolean> {
  const lower = email.toLowerCase();

  // 1. Env-var domain allowlist
  const allowedDomains = (process.env.ALLOWED_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);

  const domain = lower.split("@")[1] ?? "";
  if (allowedDomains.includes(domain)) return true;

  // 2. Env-var individual email allowlist
  const allowedEmails = (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);

  if (allowedEmails.includes(lower)) return true;

  // 3. Postgres authorization table (runtime additions)
  try {
    const client = await pgPool.connect();
    try {
      const { rows } = await client.query<{ value: string }>(
        `SELECT value FROM authorizations
         WHERE (type = 'domain' AND $1 LIKE '%@' || value)
            OR (type = 'email'  AND value = $1)
         LIMIT 1`,
        [lower]
      );
      if (rows.length > 0) return true;
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("[checkAuthorization] DB error:", err);
    // Fail closed — DB error means unauthorized
  }

  return false;
}

// ─── Session helper (server-side) ────────────────────────────────────────────

/** Get the current session from request headers. Returns null if not authed. */
export async function getSession(headers: Headers) {
  return auth.api.getSession({ headers });
}

/** Get just the email from the current session, or null. */
export async function getSessionEmail(headers: Headers): Promise<string | null> {
  const session = await getSession(headers);
  return session?.user?.email?.toLowerCase() ?? null;
}
