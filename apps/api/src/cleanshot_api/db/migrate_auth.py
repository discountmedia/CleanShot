"""
Auth + approval schema migration.
Runs on API startup (after migrate.py — core schema).

Tables managed here:
  ba_user, ba_session, ba_account, ba_verification
      Better Auth v1.6.x schema. Field shapes mirror what better-auth/core
      expects in @better-auth/core/dist/db/get-tables.mjs. Pinned: 1.6.11.
      Table names are configured in apps/web/lib/auth.ts (modelName: "ba_*").
      On upgrade of better-auth, regenerate this DDL.

  authorizations
      Domain/email allowlist queried in apps/web/lib/auth.ts:checkAuthorization().

  approval_sets, approval_set_assets
      One row per "Approve All" click, plus the per-asset junction.

Idempotent: every statement uses IF NOT EXISTS / ON CONFLICT DO NOTHING.
Wrapped in a pg_advisory_xact_lock so concurrent cold-start replicas serialize
their CREATE TABLE calls.

Additive only — never ALTER or DROP here. If a schema change is destructive,
do it manually via a one-off psql session, not by editing this file.
"""

from __future__ import annotations

import asyncpg

# Arbitrary stable lock key for the migrations transaction. Any int works as
# long as it's stable across replicas.
_MIGRATION_LOCK_KEY = 8473829

DDL = """
-- ─── Better Auth: ba_user ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ba_user (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    email           TEXT NOT NULL UNIQUE,
    "emailVerified" BOOLEAN NOT NULL DEFAULT false,
    image           TEXT,
    "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── Better Auth: ba_session ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ba_session (
    id              TEXT PRIMARY KEY,
    "userId"        TEXT NOT NULL REFERENCES ba_user(id) ON DELETE CASCADE,
    "expiresAt"     TIMESTAMPTZ NOT NULL,
    token           TEXT NOT NULL UNIQUE,
    "ipAddress"     TEXT,
    "userAgent"     TEXT,
    "createdAt"     TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updatedAt"     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ba_session_user_id ON ba_session("userId");

-- ─── Better Auth: ba_account ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ba_account (
    id                       TEXT PRIMARY KEY,
    "userId"                 TEXT NOT NULL REFERENCES ba_user(id) ON DELETE CASCADE,
    "accountId"              TEXT NOT NULL,
    "providerId"             TEXT NOT NULL,
    "accessToken"            TEXT,
    "refreshToken"           TEXT,
    "idToken"                TEXT,
    "accessTokenExpiresAt"   TIMESTAMPTZ,
    "refreshTokenExpiresAt"  TIMESTAMPTZ,
    scope                    TEXT,
    password                 TEXT,
    "createdAt"              TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updatedAt"              TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ba_account_user_id ON ba_account("userId");

-- ─── Better Auth: ba_verification ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS ba_verification (
    id          TEXT PRIMARY KEY,
    identifier  TEXT NOT NULL,
    value       TEXT NOT NULL,
    "expiresAt" TIMESTAMPTZ NOT NULL,
    "createdAt" TIMESTAMPTZ NOT NULL DEFAULT now(),
    "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ba_verification_identifier ON ba_verification(identifier);

-- ─── Authorization allowlist ─────────────────────────────────────────────────
-- type: 'domain'  value: 'acme.com'
-- type: 'email'   value: 'alice@partner.org'
--
-- The CREATE TABLE here only fires for fresh installs. In prod the table was
-- created by an older revision of migrate_auth.py that lacked the `created_by`
-- and `expires_at` columns. The ALTER TABLE ... ADD COLUMN IF NOT EXISTS lines
-- below bring an old-schema table forward without touching a fresh one.
-- Note: the lowercase CHECK constraint only applies to fresh installs. Existing
-- old-schema tables won't have it — auth.ts always lowercases values before
-- INSERT and lookup, so app-level invariant holds either way.
CREATE TABLE IF NOT EXISTS authorizations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type        TEXT NOT NULL CHECK (type IN ('domain', 'email')),
    value       TEXT NOT NULL CHECK (value = lower(value)),
    note        TEXT,
    created_by  TEXT NOT NULL DEFAULT 'system',
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    expires_at  TIMESTAMPTZ,
    UNIQUE (type, value)
);
ALTER TABLE authorizations
    ADD COLUMN IF NOT EXISTS created_by TEXT NOT NULL DEFAULT 'system';
ALTER TABLE authorizations
    ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_authorizations_domain
    ON authorizations(value) WHERE type = 'domain';
CREATE INDEX IF NOT EXISTS idx_authorizations_email
    ON authorizations(value) WHERE type = 'email';
CREATE INDEX IF NOT EXISTS idx_authorizations_expires
    ON authorizations(expires_at) WHERE expires_at IS NOT NULL;

-- Seed: domain allowlist for the discountforklift family.
-- ON CONFLICT DO NOTHING is what makes this idempotent across replicas.
INSERT INTO authorizations (type, value, note, created_by) VALUES
    ('domain', 'discountforklift.us',         'initial seed', 'migrate_auth'),
    ('domain', 'discountforkliftphoenix.com', 'initial seed', 'migrate_auth'),
    ('domain', 'discountforkliftvegas.com',   'initial seed', 'migrate_auth'),
    ('domain', 'discountforkliftdfw.com',     'initial seed', 'migrate_auth')
ON CONFLICT (type, value) DO NOTHING;

-- ─── Approval sets ────────────────────────────────────────────────────────────
-- One row per "Approve All" click.
-- user_email: authenticated Microsoft email (from Better Auth session).
-- gcs_dir:    the GCS directory path for this set (human-readable).
-- expires_at: NULL = stored indefinitely (current default — operator decided
--             "photo library is infinite" 2026-05-26). Legacy rows from when
--             the GCS lifecycle rule deleted approved/ objects after 60 days
--             may still have non-NULL values; the SELECT filter in
--             approvals.py treats those as the original "expires when this
--             timestamp passes" semantics so old expired rows naturally drop
--             out of the History view without a backfill.
CREATE TABLE IF NOT EXISTS approval_sets (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_email  TEXT NOT NULL,
    session_id  UUID REFERENCES sessions(id),
    project_id  UUID REFERENCES projects(id),
    gcs_dir     TEXT NOT NULL,              -- approved/{email}/{YYYY-MM-DD}_{make}_{model}_{session-short}
    make        TEXT NOT NULL DEFAULT '',
    model       TEXT NOT NULL DEFAULT '',
    image_count INT  NOT NULL DEFAULT 0,
    expires_at  TIMESTAMPTZ,                -- nullable; NULL = no expiry
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Migration for existing deployments where expires_at was originally
-- defined as NOT NULL DEFAULT (now() + INTERVAL '60 days'). Both ALTERs
-- are idempotent; running them on a fresh schema (the CREATE TABLE
-- above already has expires_at nullable with no default) is a no-op.
ALTER TABLE approval_sets
    ALTER COLUMN expires_at DROP NOT NULL;
ALTER TABLE approval_sets
    ALTER COLUMN expires_at DROP DEFAULT;
CREATE INDEX IF NOT EXISTS idx_approval_sets_user_email ON approval_sets(user_email);
CREATE INDEX IF NOT EXISTS idx_approval_sets_expires_at ON approval_sets(expires_at);

-- ─── Approval set assets ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS approval_set_assets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    approval_set_id UUID NOT NULL REFERENCES approval_sets(id) ON DELETE CASCADE,
    asset_id        UUID NOT NULL REFERENCES assets(id),
    gcs_path        TEXT NOT NULL,          -- full gs:// URI in approved bucket
    filename        TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_approval_set_assets_set_id
    ON approval_set_assets(approval_set_id);
"""


async def run_auth_migrations(pool: asyncpg.Pool) -> None:
    """Apply auth + approval schema. Idempotent. Serialized across replicas."""
    async with pool.acquire() as conn:
        async with conn.transaction():
            # Held until the end of this transaction. Two replicas calling
            # this simultaneously serialize on the lock — CREATE TABLE
            # IF NOT EXISTS is otherwise mostly safe, but ON CONFLICT
            # seeding can race during concurrent inserts, and INDEX
            # creation has been historically racy too.
            await conn.execute(
                "SELECT pg_advisory_xact_lock($1)",
                _MIGRATION_LOCK_KEY,
            )
            await conn.execute(DDL)
