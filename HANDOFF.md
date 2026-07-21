# Session handoff — updated 2026-07-21

Resume notes for picking CleanShot back up in a new chat. **`CLAUDE.md` is the authoritative, continuously-updated project briefing** — read it first (esp. the "Latest session (2026-07-21)" block). This file is the "where we are right now / what's pending" snapshot.

---

## Repo state

- **Branch:** `main`. Everything through `cf3ff1c` is pushed.
- **Direct-to-main is the norm** (no PR review). If the auto-mode classifier blocks a push, run `git push origin main` yourself.
- **Live API revision** after the last deploy in this session: `cleanshot-api-00149-gqm` → the regen fix (`cf3ff1c`) was deploying at handoff time; confirm the newer revision is serving before smoke-testing (`gcloud run services describe cleanshot-api --region=us-central1 --format="value(status.latestReadyRevisionName)"`).
- **Untracked:** `AGENTS.md` (a Codex-facing briefing) is present but not committed — see note under "Docs" below.

---

## What shipped this session (2026-07-21) — all on the Enhance tab

| # | Change | Commits |
|---|--------|---------|
| 1 | **Best-of-N auto-pick** — a Claude judge ranks the multi-provider variants for each image and auto-selects the winner (operator sees one vetted image, not N). Sync `POST /api/v1/enhance/judge`. | `9d268ab` + fixes `98c6027` |
| 2 | **Grok made dormant** — dropped from the picker (`ENHANCE_PROVIDERS`), kept as dead code. Live picker is now **Gemini + OpenAI only**. | `fb4e24a` |
| 3 | **Prompt-first Enhance** — the operator's prompt is now required + primary; "Insert recommended prompt" gives an equipment-aware editable starter; toggles now AUGMENT the prompt (spine_override) instead of overriding it. | `e7afc09` |
| 3b | **Regen fix** — the prompt-first reroute double-appended guardrails to the Scan-tab Regenerate path; fixed with a `prompt_is_complete` verbatim flag. | `cf3ff1c` |

Both #1 and #3 got a post-ship adversarial review (multi-agent workflow); the HIGH from #1 (re-enhance-during-judge race) and the mediums from #3 (regen double-guardrail) were fixed. **Both reviews are complete — no open review findings.**

---

## The one thing still owed: a real end-to-end smoke test

Everything above is verified by `tsc` / py-parse / lint / live-route probes + adversarial review, but **nobody has put a real photo through the pipeline in prod yet.** When you're back, run a **3-provider… wait, 2-provider (Gemini + OpenAI) batch** in the UI (or `~/enhance-smoke.sh`) and confirm:

1. **Prompt-first:** Enhance is disabled until you type/insert a prompt; "Insert recommended prompt" fills an equipment-appropriate starter; a toggle appends (doesn't replace).
2. **Best-of-N:** after both variants land, a "judging…" spinner → green **★ Best of 2** badge on the winner; it flows to Export.
3. **The race fix:** hit **Re-enhance mid-judge** — the new batch judges cleanly, no stale badge, image never dropped from Export.
4. **Regen fix:** on the Scan tab, Regenerate a **scissor lift** (or any non-forklift) — output shouldn't grow hallucinated forks/mast (that was the double-guardrail bug).

Hard-refresh first (Vercel) so you're on the latest web build.

---

## Pending CODE work (parked, prioritised)

1. **Best-of-N follow-ups** (deferred at ship): (a) log the judge's Claude spend to `usage_events` — needs an `OperationEnum.judge` value + `ALTER TYPE ... ADD VALUE` (hard-won lesson #12) + threading it through `judge_variants`; (b) add an `AsyncRateLimiter` on the judge's Anthropic calls (shares scan's `claude-sonnet-4-6` tier — add if 429s appear on big batches).
2. **Prompt-first Phase 2 — iterative refinement.** "Write a 2nd/3rd prompt to change the image more, rather than starting over." The per-variant **Tweak** tool (✎ Gemini) already does text-guided refinement on a completed variant — surface/rename it as the iterative path rather than building new.
3. **Scan differential recalibration** (parked from 2026-07-13). The live differential scan over-fires vs the operator's actual bar — flags intended repaint/backrest, 1-2 char model-# drift, subtle geometry. Tighten `_build_differential_prompt` + the intended-edits whitelist. Clean deployable win. (Note: best-of-N's judge is a *separate* Claude call from the scan; this item is still open.)
4. **Model-routing / best-of-N for hard equipment types.** Prompt wording is a DEAD lever for warehouse-electric gear (reach/order-picker/walkie/pallet) — Gemini drifts regardless (see memory `enhance-warehouse-electric-model-limit`). The real levers are best-of-N (now shipped — extend it) or routing those types to a different model. With Grok gone, the fan-out is Gemini vs OpenAI.
5. **Per-user access control — Phase 2 (admin audit logging).** Still unbuilt. `enhance_audit_log` table + thread `user_email` through `/api/enhance` → `_run_enhance` (writes row on completion for `tracking` users) + admin `GET /api/admin/audit` + an "Audit" tab. NOTE: `access-control.ts` is currently **defanged** (`USER_RESTRICTIONS = {}`, `getRestriction()` returns null) — the old brian/asia/aj/stephen locks are gone. Rebuild `USER_RESTRICTIONS` if per-user gating is wanted again.

---

## Pending OPERATOR steps (dashboards / gcloud / env — not code)

- **`AUTH_ENABLED=true`** in Vercel (Production) when ready — locks the whole app behind Microsoft SSO + activates the email allowlist. Confirm the allowlist first; test on Preview. (Still inert; workspace runs as `dev@local`.)
- **CLAUDE.md quick-reference secrets list** still names `cleanshot-xai-key` (Grok) as in-use — it's now dormant but the secret stays in place (one-line re-enable). `cleanshot-recraft-key` is still safe to delete.
- Domain onboarding is a **4-place checklist** (hard-won lesson #26): Vercel + `lib/auth.ts` trustedOrigins + Entra redirect URI + `infra/gcs-cors.json` (re-apply to BOTH buckets).

---

## Docs

- **CLAUDE.md** — updated this session (new 2026-07-21 block, provider picker → 2 live, Grok dormant, prompt-first + regen fix). Authoritative.
- **README.md** — top "current-state note" refreshed; the body below it is still stale by design (it defers to CLAUDE.md).
- **AGENTS.md** — was a stale ~2026-05-28 fork of CLAUDE.md (6 providers, old tab order, "Codex" branding). Reworked into a thin pointer to CLAUDE.md to kill the dual-maintenance drift. **Left untracked** (as found — `git add AGENTS.md` if you want it in the repo).
- **STYLE_GUIDE.md / ENTRA_SETUP.md / .instructions.md** — unaffected by this session (evergreen).

---

## Gotchas / conventions (full list in CLAUDE.md)

- **Deps:** `cd apps/web && pnpm add <dep>` — NEVER npm, NEVER from repo root (lesson #25).
- **After API pushes**, arm a Cloud Run revision watcher for a one-shot "deploy done" ping; web-only pushes (Vercel) don't need it.
- **New UI:** conform to `STYLE_GUIDE.md` (green/blue/red buttons, no full-width, bold sky-400 links, yellow-300 hints).
- **`gcloud` is off the session PATH** — call by full path (`C:\Program Files (x86)\Google\Cloud SDK\google-cloud-sdk\bin\gcloud.cmd`), and from Bash it needs PowerShell's `&` call operator, not `cmd /c` (the spaced path mangles). See memory `gcloud-local-access`.
- **Pre-existing lint debt** in `EnhancePanel.tsx` (one `enhanceJobsRef` "refs during render" error from commit `93c8dfe`) — not the deploy gate; `tsc` is. Don't chase it.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`.
