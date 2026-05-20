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

// Lazy init: env vars aren't available at build-time during Next.js page-data
// collection. Anything that touches DATABASE_URL must run on first request,
// not at module load.

let _pool: Pool | null = null;
function getPool(): Pool {
  if (_pool) return _pool;
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required for Better Auth");
  }
  _pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    max: 3, // small pool — auth calls are infrequent
    // Cloud SQL Postgres presents a Google-issued server certificate
    // that isn't in Node's default CA bundle, so `sslmode=require` in
    // the URL alone produces UNABLE_TO_VERIFY_LEAF_SIGNATURE. Setting
    // rejectUnauthorized=false keeps the connection TLS-encrypted but
    // skips chain verification — mimics what libpq does by default for
    // `sslmode=require`. Stricter alternative: download the Cloud SQL
    // server CA and pass it as `ssl.ca`.
    ssl: { rejectUnauthorized: false },
  });
  return _pool;
}

// Factory + lazy cache. Inferring AuthInstance from createAuth gives us the
// specific instance type (not the generic Auth<BetterAuthOptions>), which is
// what callers actually need for type-safe access to .handler, .api, etc.
const createAuth = () =>
  betterAuth({
    database: getPool(),

    // Prefix all Better Auth tables with `ba_` to (a) avoid `user` being a
    // Postgres reserved word that needs quoting in every query and (b) make
    // it obvious in psql which tables belong to the auth layer vs. CleanShot.
    // The schema is materialized by apps/api/.../db/migrate_auth.py on startup.
    user:         { modelName: "ba_user" },
    account:      { modelName: "ba_account" },
    verification: { modelName: "ba_verification" },

    session: {
      modelName: "ba_session",
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
            console.log("[auth.hook] user.create.before — raw user object:", JSON.stringify(user));
            console.log("[auth.hook] user.create.before — normalized email:", email);
            if (!(await checkAuthorization(email))) {
              console.log("[auth.hook] REJECTING — email not authorized:", email);
              throw new Error("Email not authorized to access CleanShot");
            }
            console.log("[auth.hook] ACCEPTING — email authorized:", email);
            return { data: user };
          },
        },
      },
    },
  });

type AuthInstance = ReturnType<typeof createAuth>;
let _auth: AuthInstance | null = null;
export function getAuth(): AuthInstance {
  if (!_auth) _auth = createAuth();
  return _auth;
}

// ─── Authorization check ──────────────────────────────────────────────────────

/**
 * Returns true if the email is authorized to use CleanShot.
 * Checks env-var allowlists first (fast, no DB), then Postgres table.
 */
export async function checkAuthorization(email: string): Promise<boolean> {
  const lower = email.toLowerCase();
  console.log("[checkAuth] start — email:", lower);

  // 1. Env-var domain allowlist
  const allowedDomains = (process.env.ALLOWED_DOMAINS ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);

  const domain = lower.split("@")[1] ?? "";
  console.log("[checkAuth] domain:", domain, "allowed domains:", allowedDomains);
  if (allowedDomains.includes(domain)) {
    console.log("[checkAuth] PASS via ALLOWED_DOMAINS");
    return true;
  }

  // 2. Env-var individual email allowlist
  const allowedEmails = (process.env.ALLOWED_EMAILS ?? "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  console.log("[checkAuth] allowed emails:", allowedEmails);

  if (allowedEmails.includes(lower)) {
    console.log("[checkAuth] PASS via ALLOWED_EMAILS");
    return true;
  }

  // 3. Postgres authorization table (runtime additions)
  try {
    const client = await getPool().connect();
    try {
      const { rows } = await client.query<{ value: string }>(
        `SELECT value FROM authorizations
         WHERE (type = 'domain' AND $1 LIKE '%@' || value)
            OR (type = 'email'  AND value = $1)
         LIMIT 1`,
        [lower]
      );
      console.log("[checkAuth] DB query rows:", rows.length);
      if (rows.length > 0) {
        console.log("[checkAuth] PASS via DB row:", rows[0]?.value);
        return true;
      }
    } finally {
      client.release();
    }
  } catch (err) {
    console.error("[checkAuth] DB error:", err);
    // Fail closed — DB error means unauthorized
  }

  console.log("[checkAuth] FAIL — no allowlist source matched");
  return false;
}

// ─── Session helpers (server-side) ───────────────────────────────────────────

/** Get the current session from request headers. Returns null if not authed. */
export async function getSession(headers: Headers) {
  return getAuth().api.getSession({ headers });
}

/** Get just the email from the current session, or null. */
export async function getSessionEmail(headers: Headers): Promise<string | null> {
  const session = await getSession(headers);
  return session?.user?.email?.toLowerCase() ?? null;
}
