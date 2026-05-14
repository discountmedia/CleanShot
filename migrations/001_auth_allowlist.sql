-- Migration 001: auth_allowlist table
-- Phase 3 v3.5 — Microsoft Entra ID SSO authorization
-- Does NOT modify any existing Phase 2 tables

CREATE TABLE IF NOT EXISTS auth_allowlist (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text        UNIQUE NOT NULL,
  label       text,                         -- e.g. "Bob Smith - ABC Auctions"
  created_by  text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT NOW(),
  expires_at  timestamptz               -- NULL = permanent; set for temp third-party access
);

CREATE INDEX IF NOT EXISTS idx_auth_allowlist_email
  ON auth_allowlist (email);

CREATE INDEX IF NOT EXISTS idx_auth_allowlist_expires
  ON auth_allowlist (expires_at)
  WHERE expires_at IS NOT NULL;

-- Better Auth tables are created automatically via: npx better-auth migrate
-- Tables created: ba_user, ba_session, ba_account, ba_verification
