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

-- projects  (8 required fields enforced at API layer AND here via NOT NULL)
CREATE TABLE IF NOT EXISTS projects (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    session_id  UUID NOT NULL REFERENCES sessions(id),
    title       TEXT NOT NULL,
    make        TEXT NOT NULL,
    year        INT  NOT NULL,
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
"""


async def run_migrations(pool: asyncpg.Pool) -> None:
    async with pool.acquire() as conn:
        await conn.execute(DDL)
