"""
Auth + approval schema migration.
Run after migrate.py (core schema).
Adds:
  authorization       — domain/email allowlist (runtime additions)
  approval_sets       — one row per "Approve All" click, keyed by user_email
  approval_set_assets — junction: which assets are in each approval set

Better Auth tables (user, session, account, verification) are created by
Better Auth's own migration tool (`pnpm dlx @better-auth/cli migrate`).
We only manage CleanShot-specific tables here.
"""

from __future__ import annotations

import asyncpg

DDL = """
-- ─── Authorization allowlist ─────────────────────────────────────────────────
-- type: 'domain'  value: 'acme.com'
-- type: 'email'   value: 'alice@partner.org'
CREATE TABLE IF NOT EXISTS authorizations (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    type        TEXT NOT NULL CHECK (type IN ('domain', 'email')),
    value       TEXT NOT NULL,
    note        TEXT,                       -- optional human note (who added, why)
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (type, value)
);
CREATE INDEX IF NOT EXISTS idx_authorization_value ON authorizations(value);

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
    async with pool.acquire() as conn:
        await conn.execute(DDL)
