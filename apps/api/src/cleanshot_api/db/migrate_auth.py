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
-- expires_at: 60 days after created_at — enforced by GCS lifecycle + this column.
CREATE TABLE IF NOT EXISTS approval_sets (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_email  TEXT NOT NULL,
    session_id  UUID REFERENCES sessions(id),
    project_id  UUID REFERENCES projects(id),
    gcs_dir     TEXT NOT NULL,              -- approved/{email}/{YYYY-MM-DD}_{make}_{model}_{session-short}
    make        TEXT NOT NULL DEFAULT '',
    model       TEXT NOT NULL DEFAULT '',
    image_count INT  NOT NULL DEFAULT 0,
    expires_at  TIMESTAMPTZ NOT NULL DEFAULT (now() + INTERVAL '60 days'),
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
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
