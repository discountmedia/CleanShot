"""
Schema migration runner.

Applies the Postgres 17 schema from Phase 2 v2.5.
Idempotent — safe to run on every startup in local/dev.
Production should use a proper migration tool (Alembic) once schema stabilises.
"""

from __future__ import annotations

import asyncpg

DDL = """
-- Enable pgcrypto for gen_random_uuid() if not already enabled
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- Enum types (idempotent via DO block)
DO $$ BEGIN
    CREATE TYPE operation_enum AS ENUM
        ('upload', 'enhance', 'scan', 'cleanup', 'export');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Idempotent additions to operation_enum after the type was first created.
-- ADD VALUE IF NOT EXISTS is a single-statement op (no DO block needed) and
-- safe on PG12+. Add new operation kinds here rather than re-creating
-- the enum, which would require dropping every column that references it.
ALTER TYPE operation_enum ADD VALUE IF NOT EXISTS 'erase';
ALTER TYPE operation_enum ADD VALUE IF NOT EXISTS 'tweak';
ALTER TYPE operation_enum ADD VALUE IF NOT EXISTS 'modify';

DO $$ BEGIN
    CREATE TYPE job_status_enum AS ENUM
        ('queued', 'processing', 'complete', 'failed', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE verdict_enum AS ENUM ('pass', 'fail');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE consensus_verdict_enum AS ENUM ('pass', 'fail', 'split');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE photo_type_enum AS ENUM ('auction', 'studio');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- sessions
CREATE TABLE IF NOT EXISTS sessions (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Idempotent post-create patches: add `user_email` so we can attribute
-- sessions (and downstream projects / jobs / usage events) back to a
-- signed-in user. NULL for pre-SSO rows.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS user_email TEXT;
CREATE INDEX IF NOT EXISTS idx_sessions_user_email ON sessions(user_email);

-- projects  (required fields enforced at API layer AND here via NOT NULL --
-- EXCEPT `year`, see the ALTER below)
CREATE TABLE IF NOT EXISTS projects (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id  UUID NOT NULL REFERENCES sessions(id),
    title       TEXT NOT NULL,
    make        TEXT NOT NULL,
    year        INT,          -- nullable since 2026-08-13; see the ALTER below
    model       TEXT NOT NULL,
    tire_type   TEXT NOT NULL,
    capacity    TEXT NOT NULL,
    fuel_type   TEXT NOT NULL,
    username    TEXT NOT NULL,
    photo_type  photo_type_enum NOT NULL,
    saved_at    TIMESTAMPTZ,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (session_id, title)
);
-- Idempotent post-create patch: `year` was NOT NULL, and because the web form
-- silently substituted the current year for a blank field, a unit with an
-- unknown year got confidently stamped with the wrong one -- and that number
-- went into the export filenames. An unknown year is now recorded as unknown.
-- DROP NOT NULL is idempotent, so this is safe on every startup.
ALTER TABLE projects ALTER COLUMN year DROP NOT NULL;

-- assets
CREATE TABLE IF NOT EXISTS assets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    project_id      UUID REFERENCES projects(id),
    session_id      UUID NOT NULL REFERENCES sessions(id),
    operation       operation_enum NOT NULL,
    gcs_uri         TEXT NOT NULL,
    content_hash    TEXT NOT NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_assets_session  ON assets(session_id);
CREATE INDEX IF NOT EXISTS idx_assets_project  ON assets(project_id);
CREATE INDEX IF NOT EXISTS idx_assets_op       ON assets(operation);
-- Idempotent post-create patch: provenance for assets copied in by the
-- media-auditor handoff. Holds the source unit's stock number.
--
-- Why it lives on the asset and not on the handoff record: the handoff record
-- is TTL'd and assets are not, so a join through it dies while the asset
-- outlives it. One nullable column means an asset can still be traced back to
-- a unit next month, with no migration risk to the normal upload path (which
-- simply leaves it NULL).
--
-- NOTE: hard-won lesson #12 does NOT apply here — that lesson is about
-- Postgres ENUM types needing ALTER TYPE ... ADD VALUE. This is plain
-- nullable text.
ALTER TABLE assets ADD COLUMN IF NOT EXISTS source_ref TEXT;

-- jobs
CREATE TABLE IF NOT EXISTS jobs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id          UUID NOT NULL REFERENCES sessions(id),
    operation           operation_enum NOT NULL,
    status              job_status_enum NOT NULL DEFAULT 'queued',
    input_asset_id      UUID NOT NULL REFERENCES assets(id),
    output_asset_id     UUID REFERENCES assets(id),
    cloud_tasks_name    TEXT,
    idempotency_key     TEXT NOT NULL UNIQUE,
    error               TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_jobs_session ON jobs(session_id);
CREATE INDEX IF NOT EXISTS idx_jobs_status  ON jobs(status);
-- Idempotent post-create patch: how many times this job's provider call was
-- re-run for a correctable defect (currently: OpenAI returning a portrait
-- image). Drives the "Retrying" badge on the variant thumb so a second pass
-- looks intentional rather than stuck. Plain int, no enum -- lesson #12 N/A.
ALTER TABLE jobs ADD COLUMN IF NOT EXISTS retry_count INT NOT NULL DEFAULT 0;

-- scan_results
CREATE TABLE IF NOT EXISTS scan_results (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id      UUID NOT NULL REFERENCES jobs(id),
    asset_id    UUID NOT NULL REFERENCES assets(id),
    provider    TEXT NOT NULL,          -- 'gemini' | 'openai' | 'anthropic'
    verdict     verdict_enum NOT NULL,
    confidence  FLOAT NOT NULL,
    anomalies   JSONB NOT NULL DEFAULT '[]',
    summary     TEXT NOT NULL,
    latency_ms  INT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_scan_results_asset_provider
    ON scan_results(asset_id, provider);

-- usage_events: one row per AI provider call (enhance / scan / cleanup
-- / export). Powers the /admin usage tab and per-user cost attribution.
-- user_email is denormalised here so the admin queries don't need to
-- join through sessions on every read. Both fields nullable to keep
-- workers tolerant of missing context.
CREATE TABLE IF NOT EXISTS usage_events (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_email          TEXT,
    session_id          UUID REFERENCES sessions(id),
    job_id              UUID REFERENCES jobs(id),
    provider            TEXT NOT NULL,
    model               TEXT NOT NULL,
    operation           operation_enum NOT NULL,
    status              TEXT NOT NULL,             -- 'success' | 'failed'
    latency_ms          INT,
    input_tokens        INT,
    output_tokens       INT,
    cost_estimate_usd   NUMERIC(10, 6),
    error_message       TEXT,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_usage_events_user_created
    ON usage_events(user_email, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_events_provider_model_created
    ON usage_events(provider, model, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_usage_events_created
    ON usage_events(created_at DESC);

-- user_profiles: per-user editable details + a single signed-in user's
-- avatar override. Keyed by lowercased email (matches how the BFF
-- forwards X-User-Email + how Better Auth normalises session email).
-- Created lazily on first GET /api/profile so the row appears as soon
-- as the user visits their profile page.
CREATE TABLE IF NOT EXISTS user_profiles (
    user_email      TEXT PRIMARY KEY,
    full_name       TEXT,
    work_phone      TEXT,
    location        TEXT,
    avatar_uri      TEXT,                          -- gs:// path; signed GET URL minted on read
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- saved_prompts: named, reusable enhance prompts belonging to one user.
-- Enhance went prompt-first in July 2026, so operators write their own
-- prompts; the good ones were being retyped from scratch every session.
--
-- Keyed on lowercased email, same as user_profiles and for the same reason
-- (that is the form the BFF forwards in X-User-Email). No FK to
-- user_profiles: a user can save a prompt before ever visiting their
-- profile page, and that row is created lazily.
--
-- The unique index is on lower(title), not title, so "Yard Units" and
-- "yard units" collide. Titles are user-facing labels chosen for a
-- dropdown — two entries differing only in case read as duplicates to the
-- person picking one. Making it a DB constraint rather than a pre-check
-- also closes the two-tabs race that a SELECT-then-INSERT would leave open.
CREATE TABLE IF NOT EXISTS saved_prompts (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_email  TEXT NOT NULL,
    title       TEXT NOT NULL,
    body        TEXT NOT NULL,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_prompts_user_title
    ON saved_prompts(user_email, lower(title));
-- Listing order for the dropdown: most recently touched first.
CREATE INDEX IF NOT EXISTS idx_saved_prompts_user
    ON saved_prompts(user_email, updated_at DESC);

-- support_tickets: feature requests + bug reports submitted from
-- /profile. Surfaced in /admin's Support tab so the owner sees them
-- without leaving the tool.
DO $$ BEGIN
    CREATE TYPE support_ticket_type_enum AS ENUM ('support', 'feature');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
    CREATE TYPE support_ticket_status_enum AS ENUM ('open', 'in_progress', 'closed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS support_tickets (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_email      TEXT NOT NULL,
    type            support_ticket_type_enum NOT NULL,
    subject         TEXT NOT NULL,
    body            TEXT NOT NULL,
    status          support_ticket_status_enum NOT NULL DEFAULT 'open',
    admin_notes     TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_support_tickets_user_email
    ON support_tickets(user_email);
CREATE INDEX IF NOT EXISTS idx_support_tickets_status_created
    ON support_tickets(status, created_at DESC);

-- consensus_results (multi-model)
CREATE TABLE IF NOT EXISTS consensus_results (
    id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_id                      UUID NOT NULL REFERENCES jobs(id),
    asset_id                    UUID NOT NULL REFERENCES assets(id),
    verdict                     consensus_verdict_enum NOT NULL,
    confidence                  FLOAT NOT NULL,
    provider_count              INT NOT NULL,
    pass_count                  INT NOT NULL,
    fail_count                  INT NOT NULL,
    unanimous                   BOOL NOT NULL,
    divergent_providers         JSONB NOT NULL DEFAULT '[]',
    merged_anomalies            JSONB NOT NULL DEFAULT '[]',
    high_confidence_anomalies   JSONB NOT NULL DEFAULT '[]',
    created_at                  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ─── media-auditor → CleanShot photo import ─────────────────────────────────
--
-- One handoff row per "send this unit's photos to CleanShot" click, and one
-- item row per photo in it.
--
-- Deliberately DURABLE rather than Valkey-backed. The polling endpoint is the
-- only way an operator sees their import land, so it must not depend on a cache
-- being up — /jobs/batch hard-503s without Valkey and that is not an acceptable
-- shape here. Postgres is the single source of truth; there is no dual-write to
-- keep consistent.
--
-- `status` is plain TEXT, not a Postgres enum, so adding a state later is a code
-- change rather than an ALTER TYPE dance (hard-won lesson #12).
CREATE TABLE IF NOT EXISTS ingest_handoffs (
    id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id          UUID NOT NULL REFERENCES sessions(id),
    -- Who clicked. The exchange refuses a token presented by anyone else.
    user_email          TEXT NOT NULL,
    -- Caller's stable id for this batch. Half of the dedupe key.
    source_batch_id     TEXT NOT NULL,
    -- Source unit's stock number; copied onto each asset's source_ref.
    stock_number        TEXT,
    -- SHA-256 of the exchange token, never the token itself: a DB dump must not
    -- yield a usable credential.
    token_hash          TEXT NOT NULL,
    token_expires_at    TIMESTAMPTZ NOT NULL,
    -- Set on first successful exchange. NOT a lock: the same user re-presenting
    -- a consumed token gets the same session back, because reload and
    -- back-navigation are normal behaviour.
    consumed_at         TIMESTAMPTZ,
    expected_count      INT NOT NULL,
    created_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_ingest_handoffs_token
    ON ingest_handoffs(token_hash);
CREATE INDEX IF NOT EXISTS idx_ingest_handoffs_session
    ON ingest_handoffs(session_id);

CREATE TABLE IF NOT EXISTS ingest_items (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    handoff_id      UUID NOT NULL REFERENCES ingest_handoffs(id),
    session_id      UUID NOT NULL REFERENCES sessions(id),
    source_batch_id TEXT NOT NULL,
    source_url      TEXT NOT NULL,
    filename        TEXT NOT NULL,
    -- 'pending' | 'landed' | 'failed'. Every item reaches one of the terminal
    -- two, so the UI never holds a permanent skeleton.
    status          TEXT NOT NULL DEFAULT 'pending',
    error           TEXT,
    asset_id        UUID REFERENCES assets(id),
    content_hash    TEXT,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ingest_items_handoff ON ingest_items(handoff_id);
-- Dedupe on (source_batch_id, checksum): re-sending a batch, or a Cloud Tasks
-- retry after a partial success, reuses the landed asset instead of copying the
-- bytes again. Partial index because content_hash is only known post-fetch.
CREATE UNIQUE INDEX IF NOT EXISTS idx_ingest_items_dedupe
    ON ingest_items(source_batch_id, content_hash)
    WHERE content_hash IS NOT NULL;

-- Lets a reloaded page discover whether its session has an import worth polling
-- without the handoff id being in the URL. Additive, same shape as the
-- user_email patch above.
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS handoff_id UUID;
"""


async def run_migrations(pool: asyncpg.Pool) -> None:
    async with pool.acquire() as conn:
        await conn.execute(DDL)
