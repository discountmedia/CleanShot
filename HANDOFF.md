# Session handoff — updated 2026-05-28

Resume notes for picking CleanShot back up. CLAUDE.md is the authoritative project briefing; this file is the "what's pending right now" snapshot.

---

## Repo state

- **Branch:** `main`. Almost everything is pushed; the latest doc commit (`7537db0`, CLAUDE.md) may be unpushed — `git push origin main` to be safe.
- Auto-mode classifier blocks the assistant from pushing; you run `git push origin main` yourself.

---

## Pending OPERATOR steps (not code — dashboards / gcloud / env)

### 1. Per-user access control — flip the switch when ready
Phase 1 shipped (model lock + Enhance-only + toggles-off + custom-prompt-only for brian/asia/aj/stephen, enforced server-side in `/api/enhance`). **It's inert until you set `AUTH_ENABLED=true` in Vercel** (Production env). That also locks the WHOLE app behind Microsoft SSO for everyone + activates the email allowlist — confirm the allowlist is complete first, ideally test on Preview env before Production. Restrictions live in `apps/web/lib/access-control.ts` (add a user = one entry + redeploy).

### 2. GCS CORS — confirm it applied
Fixed the "GCS PUT network error" on uploads from `discountforklift.ai`. You ran the `/tmp/gcs-cors.json` heredoc apply — confirm both buckets show `Completed 1` (not 0) and the origin list includes `discountforklift.ai`:
```bash
gcloud storage buckets describe gs://cleanshot-originals-prod \
  --format="default(cors_config)" --project=cleanshot-493512
```
Canonical policy is version-controlled at `infra/gcs-cors.json`.

### 3. Reve API key — verify it's the real key
`cleanshot-reve-key` should hold a valid Reve token (~30-80 bytes). Rotate with the `read -s` + `printf "%s"` pattern (hard-won lesson #21) if Reve enhance 401s.

### Already DONE (no action): Cloud Tasks dispatch rate 0.1→1.5, GCS lifecycle clear (infinite library), Vercel deploy pipeline fix, Deployment Protection disabled.

---

## Pending CODE work

### Phase 2 — admin audit logging (the only open piece of the access-control feature)
Spec'd, not built. Plan:
1. `enhance_audit_log` table in `apps/api/.../db/migrate_auth.py` — `id, timestamp, user_email, model_used, prompt_text, result_text`.
2. Thread `user_email` through `/api/enhance` BFF (already resolves it) → FastAPI `/api/v1/enhance` → `EnhanceTaskPayload` → `_run_enhance`, which writes the row on completion (`result_text` = output asset id + signed URL + status) for users whose config has `tracking: true`.
3. Admin API `GET /api/admin/audit?user=` (FastAPI) + BFF proxy `/api/admin/audit`.
4. "Audit" tab in `apps/web/components/admin/AdminDashboard.tsx`, filterable by user.

**Open decision:** full worker-side logging (captures the result) vs cheaper BFF-only enqueue logging (user+model+prompt+timestamp, no result). Worker path is the spec-complete one but threads email through the whole enqueue→worker chain.

---

## Adding a new domain — 4-place checklist (hard-won lesson #26)
When onboarding another domain (like discountforklift.ai), update ALL of:
1. **Vercel** project → add domain + DNS.
2. **`apps/web/lib/auth.ts`** `trustedOrigins` — add apex + www (else Better Auth 403s sign-in).
3. **Entra** app registration → add `https://<domain>/api/auth/callback/microsoft` (else AADSTS50011).
4. **`infra/gcs-cors.json`** — add origin + re-apply to BOTH buckets (`cleanshot-originals-prod`, `cleanshot-derivatives-prod`) via `gcloud storage buckets update gs://<bucket> --cors-file=infra/gcs-cors.json --project=cleanshot-493512`.

---

## Gotchas (full list in CLAUDE.md hard-won lessons)
- **Deps:** `cd apps/web && pnpm add <dep>` — NEVER npm, NEVER from repo root (lesson #25 — it poisoned the lockfile root importer and broke every web deploy with `ERR_PNPM_OUTDATED_LOCKFILE`).
- **New UI:** conform to `STYLE_GUIDE.md` (button colours green/blue/red, no full-width, sky-400 links, yellow-300 hints, collapsible tooltips via `useVisitCount`).
- **Local Node mismatch warning** (`wanted 22.x, current v24.x`) is just pnpm being noisy — CI runs Node 22, harmless locally.
