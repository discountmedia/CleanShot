# CleanShot — Agent Briefing

> **This file is intentionally thin.** It used to be a full second copy of the
> project briefing (a fork for Codex), which drifted badly out of sync with the
> live app. To avoid dual-maintenance drift, the canonical briefing now lives in
> **one place**.

## Read this first

**[`CLAUDE.md`](CLAUDE.md) is the single, authoritative, continuously-updated
project briefing.** Whatever agent you are (Claude, Codex, Cursor, …), read
`CLAUDE.md` — it covers architecture, the AI providers, the Enhance/Scan
pipelines, deploy workflows, hard-won lessons, conventions, and a dated
"Latest session" log.

For "what's pending right now / where we left off," read **[`HANDOFF.md`](HANDOFF.md)**.

## One-paragraph orientation

Internal B2B tool: takes used-forklift photos and produces clean, listing-ready
images. `apps/web` = Next.js on Vercel (UI + BFF route handlers; the browser
never calls FastAPI directly). `apps/api` = Python/FastAPI on Cloud Run (HTTP +
Cloud Tasks workers). Postgres 17 + Valkey + GCS. The Enhance tab is
**prompt-first** (operator writes the prompt; toggles augment it) and fans out to
**Gemini + OpenAI**, then a Claude judge auto-picks the best variant. See
`CLAUDE.md` for everything else.

## Conventions that bind every agent here

- **Direct-to-main pushes** are the norm; commit bodies explain *why*. Trailer:
  `Co-Authored-By: <model> <noreply@anthropic.com>`.
- **Dependencies:** `cd apps/web && pnpm add <dep>` — never npm, never from repo
  root (hard-won lesson #25 in `CLAUDE.md`).
- **New UI** conforms to [`STYLE_GUIDE.md`](STYLE_GUIDE.md).
- **Never hardcode secrets;** least-privilege IAM; see `CLAUDE.md` lesson #21 for
  the safe secret-rotation pattern.
- Full engineering role/style guidance for this repo lives in
  [`.instructions.md`](.instructions.md).
