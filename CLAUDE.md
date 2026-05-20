# CleanShot — Project Briefing for Claude

Internal B2B tool that takes used-forklift photos and produces clean, listing-ready images via an AI pipeline. Not a customer-facing product. No external sharing, no per-seat billing — the company pays AI vendor costs and the only "users" are employees.

---

## Architecture at a glance

- **`apps/web`** — Next.js app on **Vercel**. UI for upload, enhance, scan, resize. Uses Better Auth (for the upcoming Microsoft SSO). All FastAPI calls go through Next.js Route Handlers in `apps/web/app/api/*` (BFF pattern — browser never talks to FastAPI directly).
- **`apps/api`** — Python/FastAPI service on **Cloud Run** (`cleanshot-api`, us-central1, project `cleanshot-493512`). Single container handles HTTP + Cloud Tasks worker callbacks under `/worker/*`.
- **`apps/worker-image`**, **`apps/worker-video`** — empty scaffolding; the real workers live inside `apps/api/src/cleanshot_api/workers/` and run inside the API container via Cloud Tasks HTTP targets.

### Data stores
- **Postgres 17** on Cloud SQL — `cleanshot-database-url:latest` secret; asyncpg pool.
- **Valkey 9** on Memorystore — `valkey://10.122.45.83:6379` (in-VPC).
- **GCS buckets** — `cleanshot-originals-prod` (uploads), `cleanshot-derivatives-prod` (enhanced/cleanup outputs).
- **Cloud Tasks** — `cleanshot-image-gen` (enhance + cleanup) and `cleanshot-image-scan` (scan). Both authenticate to the worker via OIDC; service account `forklift-api@cleanshot-493512.iam.gserviceaccount.com`.

### Deploy pipelines
- **API** → `.github/workflows/deploy-api.yml`, triggered on push to `apps/api/**`. Builds Docker, pushes to Artifact Registry, `gcloud run deploy` with the canonical `--set-secrets` and `--set-env-vars` list. **Important:** that workflow's env-var list is authoritative — every deploy replays it, so any `gcloud run services update --update-env-vars` you do by hand outside the workflow gets wiped on next push.
- **Web** → `.github/workflows/deploy-web.yml`, triggered on push to `apps/web/**` or `packages/types/**`. Uses `amondnet/vercel-action@v25`.

---

## Phase progress

| Phase | Status |
|---|---|
| **1. Foundation** (infra, DB, GCS, Cloud Tasks, secrets) | ✅ Complete |
| **2. AI pipelines** (Enhance via Gemini, multi-model Scan with consensus) | ✅ Complete & tested end-to-end |
| **3. UX + auth** (Resize wiring done, SSO pending, "Save project" UX pending) | 🟡 In progress |
| **4. Rollout & operations** (internal publish, monitoring, team onboarding) | ⏳ Future |

---

## Active work-in-progress (uncommitted local changes)

**Dual-client Gemini migration** — switching the enhance/cleanup pipeline from Vertex AI to AI Studio because preview image-gen models (`gemini-3.1-flash-image-preview`, `gemini-3.1-pro`, etc.) live on AI Studio first and may never reach Vertex's Publisher Models catalog. Scan stays on Vertex (proven path).

5 files modified, not yet committed:
- `apps/api/src/cleanshot_api/core/config.py` — adds `gemini_api_key: str = Field("", alias="GEMINI_API_KEY")`
- `apps/api/src/cleanshot_api/main.py` — lifespan now initializes a second `app.state.genai_aistudio` client when `GEMINI_API_KEY` is set; existing Vertex client stays as `app.state.genai` for scan.
- `apps/api/src/cleanshot_api/workers/enhance_worker.py` — `_enhance_with_gemini` switched from `Part.from_uri(gcs_uri)` to `Part.from_bytes(image_bytes)` because AI Studio can't read GCS URIs; `_run_enhance` now pulls `genai_aistudio` client and errors loudly if it's not initialized.
- `apps/api/src/cleanshot_api/workers/cleanup_worker.py` — same swap; also imports `_load_image_bytes` from `enhance_worker` (TODO: extract to `services.gcs.download_image` once a fourth caller needs it).
- `.github/workflows/deploy-api.yml` — adds `GEMINI_API_KEY=cleanshot-gemini-key:latest` to `--set-secrets`.

**Before committing this, the user must run:**

```bash
gcloud secrets create cleanshot-gemini-key --replication-policy=automatic \
  --project=cleanshot-493512

read -s -p "Paste AI Studio API key: " KEY && echo
printf '%s' "$KEY" | gcloud secrets versions add cleanshot-gemini-key \
  --data-file=- --project=cleanshot-493512
unset KEY && history -d $(history 1)

gcloud secrets add-iam-policy-binding cleanshot-gemini-key \
  --member="serviceAccount:forklift-api@cleanshot-493512.iam.gserviceaccount.com" \
  --role="roles/secretmanager.secretAccessor" \
  --project=cleanshot-493512
```

If the user comes back saying "I created the secret, commit + push" — push the 5-file commit and arm the watcher for a new Cloud Run revision.

---

## Models — what works, what doesn't

### Enhance / Cleanup (image-in → image-out)
| Provider | Model ID | Status |
|---|---|---|
| Gemini (Vertex) | `gemini-2.5-flash-image` | ✅ Proven — produced 1.4-1.6 MB real PNGs this session |
| Gemini (Vertex) | `gemini-3.1-flash-image-preview` | ❌ 404 NOT_FOUND from Vertex catalog |
| Gemini (Vertex) | `gemini-3-flash-image` | ❌ 404 |
| Gemini (Vertex) | `gemini-3-pro-image-preview` | ❌ 404 |
| Gemini (Vertex) | `gemini-flash-latest` | ❌ 404 (Vertex doesn't honor `-latest` aliases for image-gen) |
| Gemini (AI Studio) | `gemini-3.1-flash-image-preview` | ⏳ Pending — the dual-client migration above unlocks this |
| OpenAI | `gpt-image-2-2026-04-21` | ✅ Works via `client.images.edit` |
| BFL | `flux-2-max` at `https://api.bfl.ai/v1/flux-2-max` | ✅ Works, identity-preserving (vs `flux-2-pro` which fabricated wrong subjects) |

### Scan (image-in → structured JSON out)
| Provider | Model ID | Notes |
|---|---|---|
| Gemini (Vertex) | `gemini-2.5-flash` | Vision model; supports `response_mime_type="application/json"` + `response_schema=ScanResult` |
| OpenAI | `gpt-5.4` | Use `client.responses.parse(..., text_format=ScanResult)` — the SDK handles strict-mode schema conversion. Hand-rolling `text={"format": {...}}` with `ScanResult.model_json_schema()` 400s because Pydantic doesn't emit `additionalProperties: false` |
| Anthropic | `claude-sonnet-4-6` / `claude-opus-4-7` (hard cases) | Use tool-forced JSON pattern: `tools=[{name, input_schema}]` + `tool_choice={"type":"tool","name":...}`. `output_config` is NOT a valid Messages API parameter — it 400s |

### Provider feature flags (Cloud Run env vars)
- `SCAN_PROVIDER_OPENAI=true` — enable OpenAI scan branch
- `SCAN_PROVIDER_ANTHROPIC=true` — enable Anthropic scan branch
- Both are baked into the deploy workflow so they survive future deploys.

---

## Hard-won lessons (don't relearn these)

1. **Cloud Run env vars set by `gcloud run services update --update-env-vars` are reset on the next workflow deploy.** The workflow's `--set-env-vars` list is authoritative. Bake permanent changes into the workflow file, not the live service.

2. **Vertex AI does NOT honor Google's `-latest` aliases for image-generation models.** Confirmed three times this session. Always pin to an explicit dated/numbered ID published in the project's Vertex Publisher Models catalog for `us-central1`.

3. **`google-genai`'s `Part.inline_data.data` is already raw bytes — never `base64.b64decode` it.** Doing so silently drops non-base64 bytes and produces a ~269-byte garbage file. Earlier in this codebase that bug made every "successful" enhance output a corrupt 269-byte PNG even though job status was "complete."

4. **AI Studio and Vertex AI have different model catalogs and incompatible auth.** AI Studio uses static `x-goog-api-key`; Vertex uses IAM/ADC. AI Studio can't read GCS URIs (`Part.from_uri` fails) — must inline base64 via `Part.from_bytes`. Vertex can. The dual-client setup in main.py exists precisely to bridge this.

5. **OpenAI strict-mode JSON schema requires `additionalProperties: false` on every object + every field in `required`.** Pydantic's default `model_json_schema()` emits neither. Use the SDK helper `responses.parse(..., text_format=YourPydanticClass)` and it handles the strict-mode schema transformation internally.

6. **Anthropic Messages API has no `output_config` parameter.** Hand-rolled JSON-mode 400s. For structured output use the tool-call pattern (`tools=[{name, input_schema}]` + `tool_choice={"type":"tool", "name":...}`); the result lands in `content[0].input` as a dict.

7. **BFL has multiple endpoints with different semantics.** `flux-2-pro` is generation-flavored (fabricates new subjects from the prompt, treats image_prompt as loose visual conditioning). `flux-2-max` is identity-consistent editing (preserves subject, modifies surface treatment). The two also differ in field name: `image_prompt` (pro) vs `input_image` (max).

8. **Don't run the smoke test mid-deploy.** Cloud Run can serve a draining old revision for ~10 seconds after a new one becomes Ready. We've eaten one false-positive 422 to this race. Wait for the watcher to confirm 100% traffic on the new revision.

9. **Vercel default build can fail on lint.** React Compiler's purity rule treats component-scoped functions as render code, so `Date.now()` inside a callback defined at component scope is flagged. Fix is a `useRef`-based monotonic counter, not the function. The eslint config has been updated to honor `^_` prefix for intentionally-unused vars.

---

## Smoke test pattern

`enhance-smoke.sh` (lives at the user's `~/enhance-smoke.sh` on Cloud Shell) runs the full pipeline:

1. POST `/api/v1/sessions` → session_id
2. POST `/api/v1/upload/signed-url` → signed PUT URL + asset_id
3. PUT image bytes to GCS
4. POST `/api/v1/enhance` with toggles → job_id
5. Poll `/api/v1/jobs/{id}` every 5s until `status == complete`
6. Scrape Cloud Logging for the auto-enqueued scan job_id
7. Poll the scan job until `complete`
8. Fetch `/api/v1/scan/results/{scan_id}` and pretty-print per-provider verdicts + consensus

Run with `VERBOSE=1 ./enhance-smoke.sh` to see polling timestamps, GCS output file sizes (sanity check: real PNG should be >100KB), and the scan-job lookup progress.

**Sanity-check the enhance output size in logs.** A real PNG is hundreds of KB to a few MB. If you see ~269 bytes, the double-b64-decode bug has resurfaced.

---

## Conventions

- **Direct-to-main pushes** are normal for this repo — there's no PR review process and the user pushes straight to main. The Claude Code auto-mode classifier sometimes blocks pushes; when that happens I tell the user to run `git push origin main` themselves.
- **Commit messages** include the body explaining *why* (not just *what*), then `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>` as the trailer.
- **After pushing API changes**, arm a Cloud Run revision watcher (Bash with `run_in_background`) so we get a single notification when the new revision is serving 100% traffic. Pattern:

```bash
CURRENT=$(gcloud run services describe cleanshot-api --region=us-central1 \
  --project=cleanshot-493512 --format="value(status.latestReadyRevisionName)")
until out=$(gcloud run services describe ... 2>/dev/null); \
  ready=$(echo "$out" | awk '{print $1}'); \
  created=$(echo "$out" | awk '{print $2}'); \
  serving=$(echo "$out" | awk '{print $3}'); \
  pct=$(echo "$out" | awk '{print $4}'); \
  [ "$ready" = "$created" ] && [ "$serving" = "$created" ] && \
  [ "$pct" = "100" ] && [ "$ready" != "$CURRENT" ]; \
  do sleep 15; done; echo "DEPLOY READY: $ready (serving $pct%)"
```

- **Web-only changes** trigger Vercel, not Cloud Run. Don't arm the Cloud Run watcher for those.

---

## Open work items (Phase 3 next-up)

1. **"Save project" UX** — `/api/projects/save` BFF and `/api/export/pro` BFF are now wired to FastAPI, but the FastAPI export endpoints 403 unless `projects.saved_at` is set. The frontend needs a save-project button or auto-save on entering the Resize tab. ENTRA_SETUP.md exists with the full Microsoft Entra registration walkthrough — that's the next bigger ticket.

2. **Microsoft SSO** — Better Auth + Microsoft provider. Vercel env vars needed: `MICROSOFT_CLIENT_ID`, `MICROSOFT_TENANT_ID`, `MICROSOFT_CLIENT_SECRET` (Sensitive), `BETTER_AUTH_SECRET` (Sensitive), `BETTER_AUTH_URL`. Plus `DATABASE_URL` needs to be in Vercel **Production** and **Preview** environments (currently only **Development**) or Better Auth will crash at runtime.

3. **Per-model enhance prompts.** Current `_build_enhance_prompt` is ~200 lines tuned for Gemini's edit semantics. Flux 2 MAX prefers 1-3 short imperative sentences. OpenAI is somewhere in between. A `_build_flux_prompt` and `_build_openai_prompt` would noticeably lift quality on those providers.

4. **Input image resize before sending to Flux.** Today we base64-encode the full upload, which can be 3-4 MP from smartphones. Capping the long edge at 2048 before encoding would cut Flux generation time 30-50% and shrink the request payload an order of magnitude.

---

## User preferences / collaboration style

- **Move fast, don't pause for confirmation** on routine work. The user explicitly requested autonomous mode early in our session ("you can now continue with the user's answers in mind"). When you'd normally ask, make the reasonable call and continue — the user will redirect if needed.
- **Flag genuine forks in the road** (architectural choices, security tradeoffs, model migrations) with `AskUserQuestion` before committing significant work. Don't ask about line-level decisions.
- **Tight responses.** Manager-readable, not blog-post. Bullet points and tables welcome. Avoid restating what just happened — say what changed and what's next.
- **Cite file paths with `file_path:line_number` markdown links** so they're clickable in the IDE.
- **Never paste secret values back into chat.** The user has leaked one BFL key this way and a future leak is a real cost. Use `read -s` pattern + `history -d` cleanup.
- **The user trusts the agent's judgment** on most things but pushes back hard when they have evidence we should reconsider (e.g. "use this model" with docs attached). Read the docs they paste carefully — they often answer the question themselves but not in the obvious place.

---

## Quick reference

- GCP project: `cleanshot-493512`
- Region: `us-central1`
- API URL: `https://cleanshot-api-387208973244.us-central1.run.app`
- Web URL: `https://cleanshot.vercel.app` (and `https://cleanshot.discountmedia.com` once DNS lands)
- API service account: `forklift-api@cleanshot-493512.iam.gserviceaccount.com`
- Cloud Tasks SA (OIDC token issuer): mounted via `cleanshot-tasks-oidc-sa:latest`
- BFL secret: `cleanshot-bfl-key` (rotated once this session)
- Gemini AI Studio secret: `cleanshot-gemini-key` (pending creation as of last session)
