-- Migration 001: authorizations table
-- Phase 3 — Microsoft Entra ID SSO authorization gate.
-- Schema matches the query in apps/web/lib/auth.ts:checkAuthorization().
-- Does NOT modify any existing Phase 2 tables.

CREATE TABLE IF NOT EXISTS authorizations (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  type        text        NOT NULL CHECK (type IN ('domain', 'email')),
  value       text        NOT NULL CHECK (value = lower(value)),
  note        text,
  created_by  text        NOT NULL DEFAULT 'system',
  created_at  timestamptz NOT NULL DEFAULT NOW(),
  expires_at  timestamptz,  -- NULL = permanent; set for temp third-party access
  UNIQUE (type, value)
);

-- Fast lookups for the OR'd query in checkAuthorization():
--   WHERE (type='domain' AND $1 LIKE '%@' || value) OR (type='email' AND value=$1)
-- Two separate indexes outperform a composite for an OR query.
CREATE INDEX IF NOT EXISTS idx_authorizations_domain
  ON authorizations (value) WHERE type = 'domain';

CREATE INDEX IF NOT EXISTS idx_authorizations_email
  ON authorizations (value) WHERE type = 'email';

CREATE INDEX IF NOT EXISTS idx_authorizations_expires
  ON authorizations (expires_at) WHERE expires_at IS NOT NULL;

-- Better Auth tables (user, session, account, verification) are created
-- separately via: pnpm dlx @better-auth/cli migrate (run from apps/web).
