# CleanShot — Project Briefing for Claude

Internal B2B tool that takes used-forklift photos and produces clean, listing-ready images via an AI pipeline. Not customer-facing. No external sharing, no per-seat billing — the company pays AI vendor costs and the only "users" are employees authenticated via Microsoft SSO.

---

## Architecture at a glance

- **`apps/web`** — Next.js app on **Vercel**. UI, Microsoft SSO (Better Auth), admin dashboard, support tickets, profile page. All FastAPI calls go through Next.js Route Handlers in `apps/web/app/api/*` (BFF pattern — browser never talks to FastAPI directly).
- **`apps/api`** — Python/FastAPI on **Cloud Run** (`cleanshot-api`, us-central1, project `cleanshot-493512`). Single container handles HTTP + Cloud Tasks worker callbacks under `/worker/*`.
- **`apps/worker-image` / `apps/worker-video`** — empty scaffolding; real workers live inside `apps/api/src/cleanshot_api/workers/`.

### Data stores
- **Postgres 17** on Cloud SQL — `cleanshot-database-url:latest`; asyncpg pool.
- **Valkey 9** on Memorystore — `valkey://10.122.45.83:6379` (in-VPC).
- **GCS buckets** — `cleanshot-originals-prod` (uploads), `cleanshot-derivatives-prod` (enhance + cleanup outputs, plus `approved/{email}/{dir}/` curated sets).
- **Cloud Tasks** — `cleanshot-image-gen` (enhance + cleanup) + `cleanshot-image-scan` (scan). OIDC-authed via SA `forklift-api@cleanshot-493512.iam.gserviceaccount.com`.

### Deploy pipelines
- **API** → `.github/workflows/deploy-api.yml` on push to `apps/api/**`. Builds Docker, pushes to Artifact Registry, `gcloud run deploy` with the canonical `--set-secrets` + `--set-env-vars` list. **The workflow's env-var list is authoritative** — every deploy replays it, so manual `gcloud run services update --update-env-vars` outside the workflow gets wiped on next push.
- **Web** → `.github/workflows/deploy-web.yml` on push to `apps/web/**` or `packages/types/**`. Uses `amondnet/vercel-action@v25`.

### Routers (FastAPI)
`admin`, `approvals`, `export`, `jobs`, `operations`, `profiles`, `projects`, `scan_results`, `sessions`, `support`, `upload`, `worker`

### Services (FastAPI)
`gcs`, `image_processing`, `pricing`, `rate_limit`, `tasks`

---

## Phase progress

| Phase | Status |
|---|---|
| **1. Foundation** (infra, DB, GCS, Cloud Tasks, secrets) | ✅ Complete |
| **2. AI pipelines** (Enhance via 5 providers, multi-model Scan with consensus) | ✅ Complete & in production |
| **3. UX + auth** (Resize, Save/Approve flow, Microsoft SSO, profile, admin, support) | ✅ Complete — SSO is live |
| **4. Rollout & operations** (internal publish, monitoring, team onboarding) | 🟡 In flight (analytics + rate limiters shipped; full ops still pending) |

---

## Image-gen providers — what's wired and which model

The Enhance tab exposes a 5-checkbox model selector. Provider literal: `"gemini" | "openai" | "flux" | "reve" | "grok"`. All routing happens in `_run_enhance` in [apps/api/src/cleanshot_api/workers/enhance_worker.py](apps/api/src/cleanshot_api/workers/enhance_worker.py). Defaults to `gemini`.

| Provider | Model ID | SDK / endpoint | Key |
|---|---|---|---|
| `gemini` | `gemini-3.1-flash-image-preview` | `google-genai` via **AI Studio** backend (`api_key=`, not `vertexai=True`). Preview models live on AI Studio first. | `cleanshot-gemini-key` |
| `openai` | `gpt-image-2-2026-04-21` | `openai.AsyncOpenAI` `client.images.edit` | `cleanshot-openai-key` |
| `flux` | `flux-2-max` at `https://api.bfl.ai/v1/flux-2-max` | Raw `httpx` POST + polling loop (1.5s × 60 attempts, ~90s ceiling). Body field is `input_image` (base64); `flux-2-pro` used `image_prompt` — don't confuse. | `cleanshot-bfl-key` |
| `reve` | `reve-edit-fast-latest` at `https://api.reve.com/v1/image/edit` | Raw `httpx`, Bearer auth, prompt max 2560 chars | `cleanshot-reve-key` |
| `grok` | `grok-imagine-image-quality` at `https://api.x.ai/v1/images/edits` | OpenAI-compatible image-edit API, Bearer auth, prompt max 4000 chars | `cleanshot-xai-key` |

**Cleanup worker** (anomaly-guided regen from Scan tab) uses the same Gemini AI Studio client as enhance.

**Vertex AI Gemini client is still wired** in `main.py` as `app.state.genai` for the scan path (`gemini-2.5-flash` text/JSON vision is published in Vertex and Part.from_uri works there). Don't mix the two — `app.state.genai_aistudio` is enhance/cleanup, `app.state.genai` is scan.

### Scan (image-in → structured JSON out)
Multi-vendor consensus, all in [scan_worker.py](apps/api/src/cleanshot_api/workers/scan_worker.py):
- **Gemini (Vertex)** — `gemini-2.5-flash`. Vision model with `response_mime_type="application/json"` + `response_schema=ScanResult`.
- **OpenAI** — `gpt-5.4` via `client.responses.parse(..., text_format=ScanResult)`. SDK handles the strict-mode schema conversion internally. Don't hand-roll `text={"format": ...}` — Pydantic's default `.model_json_schema()` omits `additionalProperties: false` and OpenAI 400s.
- **Anthropic** — `claude-sonnet-4-6` (std) / `claude-opus-4-7` (hard). **Tool-forced JSON pattern**: `tools=[{name, input_schema}]` + `tool_choice={"type":"tool", "name":...}`, with prompt in top-level `system=`. `output_config={"format": ...}` is NOT a valid Messages API param — it 400s. Result lives in the tool_use block's `.input` dict.

Provider feature flags (Cloud Run env, baked into deploy-api.yml):
- `SCAN_PROVIDER_OPENAI=true`
- `SCAN_PROVIDER_ANTHROPIC=true`

---

## Rate limiting

`apps/api/src/cleanshot_api/services/rate_limit.py` exports `AsyncRateLimiter` (sliding window, process-local). Limiters live on `app.state` in [main.py](apps/api/src/cleanshot_api/main.py):

| Limiter | Window | Reason |
|---|---|---|
| `openai_image_rate_limiter` | 5 events / 60s | Tier-1 `gpt-image-2` caps `/v1/images/edits` at 5/min/org |
| `reve_image_rate_limiter` | 3 events / 30s | Empirical — Reve 429s on bursts despite no published cap |

**Important:** limiters are process-local. If `max-instances > 1` and you run heavy OpenAI/Reve batches across multiple Cloud Run pods, they won't coordinate. Known-good fix when that bites is a Valkey-backed limiter.

Also note: the OpenAI client is `max_retries=8, timeout=300.0` because the rate-limiter alone wasn't enough — multi-image batches were timing out on `quality="high"` full-res edits before the planned input-resize-to-2048 shipped.

---

## Auth, profile, admin, support (Phase 3 shipped)

- **Better Auth + Microsoft SSO** wired and live. Setup playbook in [ENTRA_SETUP.md](ENTRA_SETUP.md).
- **`/profile`** page (`apps/web/app/profile/page.tsx` + `components/profile/ProfilePage.tsx`) — user settings + avatar override.
- **Per-user avatar override** — `cdea7ab` maps specific emails to specific avatar assets (e.g. `stephen@discountforklift.us` → `sukuna-avatar.png` in `public/`).
- **Admin Dashboard** (`apps/web/components/admin/AdminDashboard.tsx`) — Support, Users, Usage tabs.
- **Support tickets** — `/api/support` (user create) + `/api/admin/support` + `/api/admin/support/[id]` (admin manage). Backend at `routers/support.py`.
- **Profile API** — `/api/profile`, `/api/profile/avatar`, `/api/profile/avatar/commit`. Backend at `routers/profiles.py`.
- **Admin APIs** — `/api/admin/users`, `/api/admin/usage`. Backend at `routers/admin.py`.

Vercel env vars needed for auth (set via the Vercel dashboard, not in any workflow): `MICROSOFT_CLIENT_ID`, `MICROSOFT_TENANT_ID`, `MICROSOFT_CLIENT_SECRET` (Sensitive), `BETTER_AUTH_SECRET` (Sensitive), `BETTER_AUTH_URL`, `DATABASE_URL` (must be in Prod + Preview + Dev).

---

## Approvals + Export flow

- **Save Project** (`POST /api/projects/save`) — required precondition for any export. Upserts the project row and flips `projects.saved_at`. FastAPI 403s every export endpoint until this is set.
- **Approve set** (`POST /api/approvals`, [api.ts:169](apps/web/lib/api.ts#L169)) — copies each asset to `gs://cleanshot-derivatives-prod/approved/{email}/{dir}/` keyed by the signed-in user's email (from Better Auth session). Creates an `approval_set` row visible in the History tab.
- **Single-click Save+Approve** — the Resize flow calls both immediately after the user clicks the action button. No separate "Approve All" button anymore (`ApproveAllButton.tsx` was deleted).
- **Export endpoints** (all in `routers/export.py`, FastAPI side fully built):
  - `/api/v1/export/fullsize` — signed GET URL for the full-size PNG (1-hour expiry).
  - `/api/v1/export/pro` — 1024×731 crop, JPEG ≤100 KB iterated quality. Single JPEG or ZIP for batches. Sets `X-Warning: target-size-unachievable` when the size target can't be met.
  - `/api/v1/export/pro/preview` — per-image signed URLs + size metadata (complements the binary download).
  - `/api/v1/export/custom` — arbitrary dimensions, JPEG/PNG/WebP/BMP.
  - `/api/v1/export/zip` — streaming ZIP for batch downloads.
- All BFF proxies in `apps/web/app/api/export/*` are wired (no more 501 stubs).

---

## Smoke test pattern

`~/enhance-smoke.sh` on Cloud Shell runs the full pipeline: session → signed upload URL → PUT to GCS → enqueue enhance → poll job → scrape scan job ID from logs → poll scan → fetch `/api/v1/scan/results/{id}` and pretty-print per-provider verdicts + consensus.

Run with `VERBOSE=1` to see polling timestamps, GCS output file size (sanity check: real PNG should be >100 KB — if you see ~269 bytes, the double-b64-decode bug has resurfaced), and scan-job lookup progress.

---

## Hard-won lessons (don't relearn these)

1. **Cloud Run env vars set by `gcloud run services update --update-env-vars` are reset on the next workflow deploy.** Bake permanent changes into deploy-api.yml.

2. **Vertex AI does NOT honor Google's `-latest` aliases for image-gen models** and is missing several Gemini 3.x image-gen IDs entirely. AI Studio has them. Hence the dual Gemini client in `main.py` — Vertex for scan, AI Studio for enhance/cleanup.

3. **`google-genai`'s `Part.inline_data.data` is already raw bytes — never `base64.b64decode` it.** Doing so silently drops non-base64 bytes and produces a ~269-byte garbage file even though job status flips to "complete."

4. **AI Studio can't read GCS URIs.** Use `Part.from_bytes(image_bytes, mime_type=...)` after a `_load_image_bytes` download. Vertex's `Part.from_uri(file_uri="gs://...")` only works on the Vertex backend.

5. **OpenAI strict-mode JSON schema** requires `additionalProperties: false` on every object + every field in `required`. Pydantic's default `model_json_schema()` emits neither. Use the SDK helper `responses.parse(..., text_format=YourPydanticClass)`.

6. **Anthropic Messages API has no `output_config` parameter.** For structured output use the tool-call pattern + `tool_choice={"type":"tool", "name":...}`; result lands in `content[0].input` as a dict.

7. **BFL endpoint matters.** `flux-2-pro` is generation-flavored (fabricates new subjects). `flux-2-max` is identity-consistent editing (preserves subject). Field name is also different: `image_prompt` (pro) vs `input_image` (max).

8. **Don't run the smoke test mid-deploy.** Cloud Run can serve a draining old revision for ~10s after a new one becomes Ready. Wait for 100% traffic on the new revision.

9. **React Compiler's purity rule fires on component-scoped functions.** `Date.now()` inside a callback defined at component scope is flagged. Fix is a `useRef`-based monotonic counter. ESLint config honors `^_` prefix for intentionally-unused vars.

10. **Don't paste secrets in chat.** Use `read -s` + `history -d` to rotate without leaking the value to the conversation transcript or bash history.

---

## Conventions

- **Direct-to-main pushes** are the norm — no PR review process. The Claude Code auto-mode classifier sometimes blocks pushes; when it does, ask the user to run `git push origin main` themselves.
- **Commit messages**: body explains *why*, not just *what*. Trailer: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- **After API pushes**, arm a Cloud Run revision watcher (Bash `run_in_background`) for a single completion notification when 100% traffic flips to the new revision. Pattern uses `until ... done` over `gcloud run services describe` with the current baseline.
- **Web-only pushes** trigger Vercel; don't arm the Cloud Run watcher for those.

---

## Open work items (prioritised)

1. **Input image downsize before vendor call** — cap long edge at ~2048 px in `_load_image_bytes` (or right before base64 in each provider call). Biggest single perf win (30-50% faster + ~4× smaller payload). Main.py comments call this out as "Phase 3 input-resize-to-2048."
2. **Drop Gemini `thinking_level: High` → `Medium`** for enhance/cleanup. Saves significant reasoning time with marginal quality cost on image edits.
3. **Raise Cloud Tasks `max_dispatches_per_second`** from `0.1` to `1.0-2.0` for the `cleanshot-image-gen` queue. Big win for batch dispatch latency.
4. **Per-model enhance prompts.** Current `_build_enhance_prompt` is Gemini-tuned ~200 lines. Flux 2 MAX wants 1-3 imperative sentences; OpenAI somewhere between. Per-provider builders would lift non-Gemini quality.
5. **Valkey-backed rate limiters** if `max-instances > 1` and OpenAI/Reve batches grow.
6. **Extract `_load_image_bytes`** to `services/gcs.download_image` — currently triplicated across scan/enhance/cleanup workers (TODO marker in code).

---

## User preferences / collaboration style

- **Move fast.** The user iterates rapidly across machines and prefers tight responses (manager-readable, not blog-post). Bullet points and tables welcome.
- **Ask only on real forks in the road** (architectural choices, security tradeoffs, model migrations). Line-level decisions: make the reasonable call.
- **Cite file paths with `file_path:line_number` markdown links** so they're clickable in the IDE.
- **Never paste secret values back into chat.** Use `read -s` + `history -d` cleanup pattern when rotating.
- **Read the docs the user pastes carefully** — they often answer the question themselves but not in the obvious place (e.g. AI Studio vs Vertex backend was hiding in plain sight when the user shared the JS snippet).

---

## Quick reference

- GCP project: `cleanshot-493512`
- Region: `us-central1`
- API URL: `https://cleanshot-api-387208973244.us-central1.run.app`
- Web URL: `https://cleanshot.vercel.app` (+ `https://cleanshot.discountmedia.com` once DNS lands)
- API service account: `forklift-api@cleanshot-493512.iam.gserviceaccount.com`
- Secrets in use: `cleanshot-database-url`, `cleanshot-api-key(+prev)`, `cleanshot-openai-key`, `cleanshot-anthropic-key`, `cleanshot-bfl-key`, `cleanshot-gemini-key`, `cleanshot-reve-key`, `cleanshot-xai-key`, `cleanshot-tasks-oidc-sa`, `cleanshot-worker-url`
