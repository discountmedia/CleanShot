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
| **2. AI pipelines** (Enhance, multi-model Scan with consensus) | ✅ Complete & in production |
| **3. UX + auth** (Resize, Save/Approve flow, Microsoft SSO, profile, admin, support) | ✅ Complete — SSO is live |
| **4. Rollout & operations** (analytics, rate limiters, scan resilience, Erase tool, Kontext, Ideogram, Reve, Modify tab) | 🟡 Ongoing |

**Tab order:** `Enhance → Scan → Modify → Resize → Your Photo Library`. The display label "Your Photo Library" is the History tab — internal identifiers (TabId `"history"`, `HistoryList.tsx`, `/api/history`, etc.) stay as-is; only user-facing strings were renamed (commits `9ed4649` + `ce735a5`, 2026-05-26).

---

## Image-gen providers — what's wired and which model

The Enhance tab exposes a **6-checkbox** model selector. Provider literal: `"gemini" | "openai" | "grok" | "kontext" | "ideogram" | "reve"`. All routing happens in `_run_enhance` in [enhance_worker.py](apps/api/src/cleanshot_api/workers/enhance_worker.py). Defaults to `gemini`.

| Provider | Model ID | SDK / endpoint | Key |
|---|---|---|---|
| `gemini` | `gemini-3.1-flash-image-preview` | `google-genai` via **AI Studio** backend (`api_key=`, not `vertexai=True`). Preview models live on AI Studio first. | `cleanshot-gemini-key` |
| `openai` | `gpt-5` + `image_generation` tool | `openai.AsyncOpenAI` `client.responses.create(..., tools=[{"type":"image_generation"}], tool_choice={"type":"image_generation"})`. gpt-5 reads the input image + prompt then dispatches the image_generation tool, which internally invokes a gpt-image-* model. The forced tool_choice ensures gpt-5 always generates (without it, gpt-5 can decide the prompt is conversational and reply with text). | `cleanshot-openai-key` |
| `grok` | `grok-imagine-image-quality` at `https://api.x.ai/v1/images/edits` | OpenAI-compatible image-edit API, Bearer auth, prompt max 4000 chars | `cleanshot-xai-key` |
| `kontext` | `flux-1-kontext/max/edit` at `https://model-api.runcomfy.net/v1/models/blackforestlabs/flux-1-kontext/max/edit` | **RunComfy async proxy**. POST returns `request_id`; poll `/v1/requests/{id}/status` until `"completed"`; GET `/v1/requests/{id}/result` for the rendered image URL. Body field is `image_url` (singular string — NOT `images` array; that's Seedream's shape). RunComfy fetches the image via HTTPS so we mint a short-lived signed GCS GET URL via `services.gcs.mint_read_url` and pass that. | `cleanshot-runcomfy-key` |
| `ideogram` | `ideogram-3.0` at `https://api.ideogram.ai/v1/edit` | **Sync** multipart endpoint. POST returns JSON with `data[0].url` already populated; GET that URL (no auth header) for the bytes. Reuses the per-variant `_tweak_with_ideogram` helper — primary-enhance path just passes the full enhance prompt instead of a short tweak instruction. Surfaces twice in the UI: as the cyan provider card on Enhance (full generation) AND as the cyan ✎ + rose 🖌 per-variant tools (targeted edit + mask inpaint). Wired 2026-05-26 (`ad7b202`). | `cleanshot-ideogram-key` |
| `reve` | `reve-edit-fast-latest` at `https://api.reve.com/v1/image/edit` | **Sync** JSON endpoint. Bearer auth. Body: `edit_instruction` (string, **2560-char cap**), `reference_image` (base64), `version` (`latest-fast` pinned). Response: `{ image: <base64 PNG>, credits_used, credits_remaining, content_violation }`. The model's note "this instruction will be automatically enhanced by the model" means truncation is forgiving — we slice to 2560 chars and accept any meaning lost in the tail. Pin to `latest-fast` (not `latest`) for RPM headroom; full-quality reliably trips Reve's undocumented per-minute cap. Operator preferred Reve over Recraft on quality after a same-day re-evaluation (2026-05-26). | `cleanshot-reve-key` |

**Removed / repositioned providers (don't reintroduce as primary generators without reading why):**

- `recraft` — wired end-to-end on 2026-05-26 (commits `b03032a` through `b21e9eb`), then **gutted same day** after the operator preferred Reve's output on quality. The known footguns are captured in hard-won lesson #21 (secret-value contamination) and the per-model-prompts work item (the 1000-byte prompt cap meant Gemini-tuned prose got hard-truncated, which is most of what made the output ugly). If reintroducing: restore via the cherry-picks of `b03032a`/`9fd8df1`/`b39da9b`/`d903430`/`fe826e8`/`b98f1f1`, AND write `_build_recraft_prompt` before judging quality. `cleanshot-recraft-key` secret left in place pending operator decision on full delete.
- `seedream` — operator tested 2026-05-26 and rejected on quality grounds. Not wired.
- `flux` (as generator) — repositioned as the **Erase tool only**, not a generation provider. See "Per-variant edit tools" below.
- `runway gen-4` — evaluated 2026-05-26, declined. Redundant with Kontext for identity preservation, 2-3× the cost, slower API.

**Cleanup worker** (anomaly-guided regen from Scan tab) uses the same Gemini AI Studio client as enhance.

**Vertex AI Gemini client is still wired** in `main.py` as `app.state.genai` for the scan path (`gemini-2.5-flash` text/JSON vision is published in Vertex and Part.from_uri works there). Don't mix the two — `app.state.genai_aistudio` is enhance/cleanup, `app.state.genai` is scan.

### Scan (image-in → structured JSON out)

Multi-vendor consensus, all in [scan_worker.py](apps/api/src/cleanshot_api/workers/scan_worker.py):

- **Gemini (Vertex)** — `gemini-2.5-flash`. Vision model with `response_mime_type="application/json"` + `response_schema=ScanResult`.
- **OpenAI** — `gpt-5.4` via `client.responses.parse(..., text_format=ScanResult)`. SDK handles the strict-mode schema conversion internally. Don't hand-roll `text={"format": ...}` — Pydantic's default `.model_json_schema()` omits `additionalProperties: false` and OpenAI 400s.
- **Anthropic** — `claude-sonnet-4-6` (std) / `claude-opus-4-7` (hard). **Tool-forced JSON pattern**: `tools=[{name, input_schema}]` + `tool_choice={"type":"tool", "name":...}`, with prompt in top-level `system=`. `output_config={"format": ...}` is NOT a valid Messages API param — it 400s. Result lives in the tool_use block's `.input` dict.

**Per-provider isolation** (commit `0747d14`, 2026-05-20). Fan-out uses `asyncio.gather(return_exceptions=True)` with each provider wrapped in its own try/except — **never `asyncio.TaskGroup`** for this kind of work, because TaskGroup cancels every sibling on the first exception. The original TaskGroup version meant a single OpenAI 429 cascaded into "Gemini: fail/0%/0ms, OpenAI + Anthropic stuck pending" because the in-flight Gemini and Anthropic scans were cancelled mid-call. With the gather pattern, partial results are persisted, fail-stubs are written for the providers that errored (so the UI shows "OpenAI — failed: <reason>" instead of "pending" forever), and consensus is computed over whatever subset did respond. The job only goes to `failed` status when EVERY provider errors.

Provider feature flags (Cloud Run env, baked into deploy-api.yml):

- `SCAN_PROVIDER_OPENAI=true`
- `SCAN_PROVIDER_ANTHROPIC=true`

---

## Rate limiting

`apps/api/src/cleanshot_api/services/rate_limit.py` exports `AsyncRateLimiter` (sliding window, process-local). Limiters live on `app.state` in [main.py](apps/api/src/cleanshot_api/main.py):

| Limiter | Window | Reason |
|---|---|---|
| `openai_image_rate_limiter` | 5 events / 60s | Original Tier-1 `/v1/images/edits` ceiling. Stays in place even though enhance is now `gpt-5 + image_generation tool` on `/v1/responses` — the internal tool call still hits the image endpoint. |
| `grok_image_rate_limiter` | 3 events / 30s | Defensive default — xAI doesn't publish a per-minute cap for `/v1/images/edits`. Retune once we have real burst data. |

**Important:** limiters are process-local. If `max-instances > 1` and you run heavy batches across multiple Cloud Run pods, they won't coordinate. Known-good fix when that bites is a Valkey-backed limiter. Kontext (via RunComfy) has **no limiter** — RunComfy hasn't published a cap; add one if 429s start showing up.

Also note: the OpenAI client is `max_retries=8, timeout=300.0` because the SDK's backoff alone wasn't enough on the prior direct `gpt-image-2` quality="high" path. The new `gpt-5 + image_generation tool` path is taking real quota pressure now that BOTH enhance AND scan-side `gpt-5.4` share the same `/v1/responses` rate budget — that's how we got the "Gemini: fail/0%/0ms" scan cascade (see scan section above). Watch for 429s in production; either tier-bump the OpenAI org or add a scan-side limiter if it persists.

---

## Per-variant edit tools (Tweak + Erase, dual backends each)

Five small icons on every completed enhance variant (top-left, left to right): **↻ Regenerate** (amber) · **✎ Tweak with Gemini** (blue) · **T Edit with Ideogram** (cyan) · **⌫ Erase with Flux** (purple) · **🖌 Inpaint with Ideogram** (rose). Tweak + Edit are text-only; Erase + Inpaint are mask-based. Each pair shares a dialog component; a `tool` prop drives copy + vendor routing.

### Tools matrix

| Icon | Tool name | Input | Vendor / endpoint | Best for |
|---|---|---|---|---|
| ✎ blue | Tweak | text instruction | Gemini Flash Image (AI Studio) — `_tweak_with_gemini` | Additive changes, conversational edits, fast |
| T cyan | Ideogram Edit | text instruction | Ideogram 3.0 — `POST /v1/edit` (sync multipart) — `_tweak_with_ideogram` | Decal/typography repair, model-number restoration |
| ⌫ purple | Erase | binary mask | BFL `flux-tools/erase-v1` (async poll) — `_erase_with_flux` | Identity-preserving object removal |
| 🖌 rose | Ideogram Inpaint | binary mask | Ideogram 3.0 — `POST /v1/ideogram-v3/inpaint` (sync) — `_inpaint_with_ideogram` | Mask-based edits in/near OEM text or signage |

### Backend

- **Endpoints:** `POST /api/v1/enhance/erase` and `POST /api/v1/enhance/tweak` in [operations.py](apps/api/src/cleanshot_api/routers/operations.py). Each request carries a `tool` Literal — `"flux" | "ideogram"` for erase, `"gemini" | "ideogram"` for tweak — defaulted to the original backend so old callers don't break.
- **Schemas:** `EraseRequest`, `TweakRequest`, `EraseTaskPayload`, `TweakTaskPayload` in [schemas.py](apps/api/src/cleanshot_api/models/schemas.py) — all carry the `tool` field through.
- **Worker dispatch:** `_run_erase` / `_run_tweak` in [enhance_worker.py](apps/api/src/cleanshot_api/workers/enhance_worker.py) branch on `payload.tool` and call the matching helper. Both tools reuse the `cleanshot-image-gen` Cloud Tasks queue.
- **Usage events:** rows tagged with the actual provider (`flux` / `gemini` / `ideogram`) and matching model label (`flux-erase-v1` / `gemini-3.1-flash-image-preview` / `ideogram-3.0`) so the admin dashboard attributes spend correctly per backend.

### Ideogram specifics (sync API, no polling)

- Sync HTTP: POST multipart → JSON response with `data[0].url` → GET that URL → image bytes. The result URL is a short-lived presigned CDN URL (no auth on the GET).
- Mask convention is **inverted** vs Flux: Ideogram reads BLACK as "edit here." The worker pyvips-`invert()`s the mask server-side so EraseDialog can keep producing the WHITE-equals-erase mask for either backend without branching on tool in the frontend.
- Ideogram inpaint **requires** a prompt (unlike Flux erase where it's optional). When the operator leaves the fill hint blank, the worker falls back to `"fill with plausible background"`.
- Secret: `cleanshot-ideogram-key` → `IDEOGRAM_API_KEY` env var (baked into deploy-api.yml's `--set-secrets`).

### Frontend dialogs

- [EraseDialog.tsx](apps/web/components/enhance/EraseDialog.tsx) accepts `tool="flux" | "ideogram"` — drives title, subtitle, action label, progress label. Same canvas/mask export code path either way. Idempotency key includes the tool name so back-to-back Flux + Ideogram submits on the same variant don't dedupe to one job.
- [TweakDialog.tsx](apps/web/components/enhance/TweakDialog.tsx) accepts `tool="gemini" | "ideogram"` — same dual-target pattern.
- EnhancePanel keeps **four separate dialog target states** (`eraseTarget`, `tweakTarget`, `ideogramEditTarget`, `ideogramInpaintTarget`) so opening the Ideogram editor doesn't tear down a half-typed Gemini instruction.

### Hard-won bits

- **EXIF normalization** is critical for mask-based vendors. iPhone JPEGs carry EXIF Orientation; browsers respect it (so `naturalWidth/Height` reflect post-rotation dims) but BFL/Ideogram read raw JPEG bytes pre-rotation. Fix lives in `_normalise()` inside both `_erase_with_flux` and `_inpaint_with_ideogram`: pyvips `autorot()` → write PNG → resize mask nearest-neighbour to match if dims still diverge.
- **Result handling:** on Accept, EnhancePanel patches the variant **in-place** — `completed[jobId].outputAssetId/outputUrl` updates to the new asset, original `jobId` stays put so winner-picks + sent-to-Scan flags + the poller all stay coherent. Same patch-in-place semantics across all four tools.
- **Don't reach for `asyncio.TaskGroup`** anywhere in this stack — the scan worker already learned that lesson (see scan section).

---

## Modify tab — darkroom + standalone tool

Optional tab between Scan and Resize. Deterministic (non-AI) pixel-level operations via pyvips. Operator can EITHER use it as a darkroom pass on whatever's queued for Resize OR upload raw photos directly to use it as a standalone tool — both modes converge into the same `allAssets` pool inside the panel.

**Three modes** in the controls card (tab strip at the top):

| Mode | Controls | Live preview |
|---|---|---|
| Adjustments | Brightness / Contrast / Saturation sliders (−100..+100) | CSS `filter` |
| Crop        | Aspect picker (Free / 1:1 / 4:3 / 7:5 / 16:9) + Zoom slider (50..100%) | Yellow dashed overlay over the keep-region |
| Straighten  | Rotation slider (−15.0° to +15.0°, 0.1° step) | CSS `transform: rotate()` |

All three modes **combine** on Apply — operator can dial in any subset. Backend runs them in this order so the math composes cleanly: `rotate → wedge-crop → smart-crop (aspect) → brightness/contrast → saturation`.

**Backend pipeline:**

- **Endpoint:** `POST /api/v1/modify/batch` ([routers/modify.py](apps/api/src/cleanshot_api/routers/modify.py)). Parallel GCS fetch + thread-dispatched pyvips work + new asset rows tagged `operation=modify`.
- **Schema:** `ModifyBatchRequest` wraps `ModifyAdjustments` (`brightness`, `contrast`, `saturation`, `rotation_deg`, `crop_aspect` Literal, `crop_zoom`) in [schemas.py](apps/api/src/cleanshot_api/models/schemas.py).
- **Service:** `apply_adjustments()` in [image_processing.py](apps/api/src/cleanshot_api/services/image_processing.py). Combined brightness+contrast in one `linear()` op; LCH colourspace round-trip for saturation; rotation via `pyvips.Image.rotate(angle, background=[0,0,0])` followed by centre-crop to the maximum inscribed rectangle (closed-form formula in `_inscribed_rect_after_rotation()`); smart-crop for aspect mode.
- **DB:** `OperationEnum.modify` value + `ALTER TYPE operation_enum ADD VALUE IF NOT EXISTS 'modify'` in [migrate.py](apps/api/src/cleanshot_api/db/migrate.py) — per hard-won lesson #12 (Pydantic StrEnum additions don't migrate the Postgres type automatically).

**Frontend:**

- [ModifyPanel.tsx](apps/web/components/modify/ModifyPanel.tsx) — combined darkroom + standalone uploader.
- Slider math (`sliderToBC`, `sliderToSat`) is duplicated as comments in `apply_adjustments` so the CSS-filter preview matches the pyvips render to the third decimal place. Don't drift these.
- Crop overlay is a dashed yellow rectangle positioned in % units relative to the preview thumb's `aspect-4/3` figure. The math (`cropOverlay` useMemo) handles both "free" mode (symmetric zoom inset) and aspect-locked mode (smaller axis-locked rectangle).
- Apply replaces `resizeAssets` wholesale via Workspace's `handleModifyApplied` callback (same length + order; modified PNGs land in `derivatives/session/{id}/modify/*.png`).
- Standalone-upload pattern mirrors ResizePanel — `StandaloneUpload` state, `runUpload` pipeline (convertToJpeg → getSignedUploadUrl → uploadToGcs), uploaded files merge into `allAssets`.

**Phase 2 still pending:**

- Per-image variation (each queued asset gets its own slider state) — currently Phase 1 is batch-only (same adjustments to every queued image).
- Drag-handle freeform crop (the current aspect+zoom UI is centre-only).
- Pre-applied client-side preview of the crop+rotate combination (currently the overlay shows the keep-region but doesn't show the rotated-then-cropped result inline).

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
- **AI-disclaimer watermark.** Optional opt-in flag (`ai_disclaimer: bool`) on `ExportProRequest`. When `True`, pyvips burns the string `"*Disclaimer:  AI enhanced images - used for representational purposes"` into the bottom-right corner of every output JPEG. Rendered via Pango markup (`text(..., rgba=True)`) so the `*Disclaimer:` label is **green** (`#22c55e`) and the body white, with a black shadow at ~65% alpha + foreground at ~92% alpha for legibility on both light and dark backgrounds, **Roboto Bold 11 pt** (needs `fonts-roboto` in the Dockerfile — without it Pango silently falls back to Liberation), 12 px margin. Constant lives in two places that must stay in sync: `AI_DISCLAIMER_WATERMARK` (+ `AI_DISCLAIMER_LABEL` for the green-split point) in `apps/web/components/export/ExportControls.tsx` (UI preview) and `apps/api/src/cleanshot_api/services/image_processing.py` (pyvips render). Helper: `_apply_disclaimer_watermark()`.
- **Collage export removed (2026-06-18).** Both the plain `/export/collage` preset and the 5-image `/export/branded-collage` marketing composer were deleted — endpoints, BFF proxies, `ExportCollageRequest`/`ExportBrandedCollageRequest` schemas, `export_collage`/`compose_branded_collage` (+ `_cover_crop`/`_fit_with_letterbox`) helpers, and the entire collage UI in `ExportControls.tsx`. Lesson #19 and the shipped-archive collage bullets below are kept only as historical record. Don't reintroduce without a fresh reason.
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

11. **`asyncio.TaskGroup` cancels every sibling on first exception.** Wrong primitive for any multi-vendor fan-out where you want partial results to survive one provider's failure. Use `asyncio.gather(return_exceptions=True)` with each task body in its own try/except. The scan worker was originally written with TaskGroup; a single OpenAI 429 cascaded into "Gemini fail/0%/0ms, others stuck pending" for hours before we figured it out.

12. **Postgres enum updates require explicit `ALTER TYPE ... ADD VALUE IF NOT EXISTS`.** Adding a new value to a Pydantic `StrEnum` does NOT migrate the corresponding Postgres enum type. Bare `INSERT` with the new value 500s with `InvalidTextRepresentationError`. The DDL is single-statement on PG12+ and lives next to the matching `CREATE TYPE` block in `migrate.py`.

13. **EXIF orientation mismatches** between browser-reported `naturalWidth/Height` (which respect EXIF) and raw JPEG dimensions (which BFL / most non-browser image libs see un-rotated) cause "image and mask must have the same dimensions" failures. Fix: pyvips `autorot()` + re-encode to PNG before sending to any vendor that doesn't auto-orient.

14. **RunComfy API uses an async submit/poll/result pattern**. Submit → `{ request_id }`, poll `/v1/requests/{id}/status` until `"completed"`, then GET `/v1/requests/{id}/result` for the rendered URL (which you then fetch with a separate plain HTTP GET — no auth on the signed result URL). Submit field for image input is `image_url` (singular HTTPS string), NOT `images` (which is Seedream's shape). Provider prefix is collapsed: `blackforestlabs`, not `black-forest-labs`.

15. **OpenAI `gpt-5 + image_generation` tool path eats `/v1/responses` quota.** Both enhance (gpt-5 with image_generation tool forced via `tool_choice`) and scan (gpt-5.4 text/vision via `responses.parse`) share the same endpoint quota. Heavy enhance batches will throttle scan calls into 429s. Mitigations: tier-bump the OpenAI org, or add a scan-side rate limiter on `/v1/responses`.

16. **Ideogram inverts the mask convention vs Flux/BFL.** Our EraseDialog exports a PNG where **WHITE = erase**, BLACK = preserve (matches Flux). Ideogram's `/v1/ideogram-v3/inpaint` reads the opposite: **BLACK = edit**, WHITE = preserve. The worker pyvips-`invert()`s the mask server-side inside `_inpaint_with_ideogram` so the frontend dialog can stay vendor-agnostic. Don't push the inversion into the dialog — it would force per-tool branching in the canvas-export path and the operator-supplied stroke list has the WHITE-erase convention baked in everywhere.

17. **Ideogram inpaint requires a prompt; Flux erase doesn't.** When the operator leaves the fill hint blank, `_inpaint_with_ideogram` falls back to the string `"fill with plausible background"`. Don't pass an empty string — Ideogram 422s with a confusing schema-validation error.

18. **Ideogram is sync, not async-poll like Flux/Kontext.** POST returns the JSON response with `data[0].url` already populated; GET that URL (no auth header) for the bytes. The URL is short-lived presigned CDN — fetch immediately, don't try to round-trip it through a job queue.

19. **Branded collage proportions must match the company's existing template.** Constants in `image_processing.py`: canvas 1024×540, hero 720×540 (4:3), thumbs 304×135 (4 stacked, ~2.25:1 each). Prior 640×580 hero + 384×145 thumbs side-cropped the studio banner out of both the hero AND the thumbs — confirmed against the blue Genie GS-1930 reference 2026-05-26. If you change these constants, eyeball-check against the reference before pushing.

20. **AI-disclaimer watermark string lives in two files that must stay in sync.** `AI_DISCLAIMER_WATERMARK` (+ `AI_DISCLAIMER_LABEL`) in `apps/web/components/export/ExportControls.tsx` (UI preview next to the checkbox) and `apps/api/src/cleanshot_api/services/image_processing.py` (pyvips render). Frontend value is what the operator sees; backend value is what gets burnt into the JPEG. Diverging values mean the preview lies — change both or change neither. The text is now two-colour (green `*Disclaimer:` label + white body via Pango markup) and renders in Roboto — the green split-point is `AI_DISCLAIMER_LABEL`, and Roboto requires `fonts-roboto` in `apps/api/Dockerfile`.

21. **Secret-Manager values get contaminated with the gcloud command text itself when rotated wrong** — this bit `cleanshot-recraft-key` twice on 2026-05-26 (first stored value: `lication-policy=automati` from a `--lifecycle-policy=automatic` flag fragment; second stored value: `gcloud secrets create cleanshot-recraft-key --` literally). Both produced unhelpful Recraft errors — the first failed `^Bearer [^\s]+$` with a "Authorization header format must be Bearer {token}" 400, the second mashed together after `.strip()` looked like a token to Recraft's parser and got a 401 "request unauthorized." The symptom changes depending on what's in the value, which makes diagnosis confusing. **Always rotate secrets with this exact pattern** (keeps the key off the terminal and avoids `echo`'s trailing newline):

    ```bash
    read -s -p "Secret value: " K && echo
    printf "%s" "$K" | gcloud secrets versions add <SECRET_NAME> --data-file=- --project=cleanshot-493512
    unset K
    history -d $((HISTCMD-1))
    ```

    Then `gcloud run services update cleanshot-api --region=us-central1 --update-secrets="ENV_VAR=<SECRET_NAME>:latest"` to roll the revision (or push an empty commit to trigger the workflow — but never `--set-secrets` outside the workflow, that wipes the others). Verify with `gcloud secrets versions access latest --secret=<SECRET_NAME> | wc -c` — expect 30–100 bytes for typical API keys; >150 or printable command text means redo. The diagnostic fingerprint in `_enhance_with_recraft` (`key_fp=len=N prefix='abcd' suffix='wxyz' raw_len=M`) is the pattern to copy when wiring future providers — it surfaces secret-value bugs from Cloud Run logs without leaking the value.

22. **Don't trust third-party Vercel wrapper actions on GitHub Actions** — `amondnet/vercel-action@v25` worked fine for months then started failing with `Error! Your Vercel CLI version is outdated. This endpoint requires version 47.2.2 or later.` The wrapper pinned `vercel@25.1.0` internally (~22 majors behind), and Vercel's API moved on. Run the CLI directly instead — same workflow secrets, no wrapper, no version pin to rot. Pattern that's known-working in `.github/workflows/deploy-web.yml`:

    ```yaml
    - name: Deploy to Vercel
      env:
        VERCEL_ORG_ID:     ${{ secrets.VERCEL_ORG_ID }}
        VERCEL_PROJECT_ID: ${{ secrets.VERCEL_PROJECT_ID }}
      run: |
        npm install --global vercel@latest
        vercel pull   --yes --environment=production --token=${{ secrets.VERCEL_TOKEN }}
        vercel build  --prod --token=${{ secrets.VERCEL_TOKEN }}
        vercel deploy --prebuilt --prod --token=${{ secrets.VERCEL_TOKEN }}
    ```

    Same idea applies to any third-party deploy wrapper — when it breaks, drop the wrapper before debugging it.

23. **In `deploy-web.yml`, do NOT add `working-directory: apps/web` to the Vercel CLI step.** The Vercel project itself has Root Directory = `apps/web` configured in its dashboard settings, and the CLI applies that ON TOP of the current working directory. With both set, the CLI tries to find `apps/web/apps/web/package.json` and ENOENTs. Same path-doubling we hit when running `vercel link` from inside `apps/web` locally (fix there was moving `.vercel/` up to repo root). The repo root + project Root Directory setting is the correct combination; redundant `working-directory:` only breaks things.

24. **Vercel Deployment Protection (SSO / Password) silently breaks production aliases even after CI reports success.** Symptom: the alias (`clean-shot-web.vercel.app`) returns `404` with `X-Vercel-Error: DEPLOYMENT_NOT_FOUND`, while the immutable URL (`clean-shot-*-discountforkliftmedia-*.vercel.app`) returns `401` with a `_vercel_sso_nonce` cookie set. CI logs show `▲ Aliased https://clean-shot-web.vercel.app` so it looks like deploys are landing — but unauth'd traffic hits a wall at the edge. For internal tools that already gate their own auth (CleanShot uses Better Auth + Microsoft SSO INSIDE the app), Vercel-side Deployment Protection is redundant double-locking. Toggle off at: Vercel project → Settings → Deployment Protection → Production Deployments → Disabled. Preview Deployments can stay protected if you don't want unreleased work link-shareable. Took ~30 minutes of "why is the deploy green but the site 404ing" before it clicked.

25. **NEVER run `npm install` in this repo — it's a pnpm workspace. And never run any install from the repo ROOT; always `cd apps/web` first.** Running `npm install <dep>` at the repo root during the Flags SDK setup added the deps to the ROOT `package.json` + touched the tracked npm `package-lock.json`, and when `pnpm-lock.yaml` was later regenerated the deps baked into the lockfile's ROOT importer. Result: committed root `package.json` had no deps block but the lockfile's root importer listed them → every web deploy died at `pnpm install --frozen-lockfile` with `ERR_PNPM_OUTDATED_LOCKFILE … specifiers in the lockfile don't match … 2 dependencies were removed`. Fix was reverting the root cruft + `pnpm install` to regen the lockfile cleanly. **Always `cd apps/web && pnpm add <dep>`.** Verify before committing: `pnpm install --frozen-lockfile` must pass locally, and the diff should only touch `apps/web/package.json` + `pnpm-lock.yaml` (never root `package.json` / `package-lock.json`).

26. **Adding a new domain requires updates in FOUR places, not just Vercel.** When `discountforklift.ai` was added, uploads broke with "GCS PUT network error" (xhr.onerror = CORS preflight block, NOT a real network fault — an HTTP 4xx would fire `onload` with a status instead). The browser PUTs directly to `storage.googleapis.com`, so the bucket CORS must allow the new origin. **Full domain-onboarding checklist:** (1) Vercel project → add the domain + DNS; (2) `apps/web/lib/auth.ts` `trustedOrigins` array — add apex + www or Better Auth 403s the sign-in POST; (3) Entra app registration → add `https://<domain>/api/auth/callback/microsoft` redirect URI or SSO dies with AADSTS50011; (4) `infra/gcs-cors.json` — add the origin + re-apply to BOTH browser-PUT buckets (`cleanshot-originals-prod` for uploads, `cleanshot-derivatives-prod` for approved/exported assets) via `gcloud storage buckets update gs://<bucket> --cors-file=infra/gcs-cors.json --project=cleanshot-493512`. The CORS file is the version-controlled source of truth but the gcloud apply is a manual operator step.

---

## Conventions

- **Direct-to-main pushes** are the norm — no PR review process. The Claude Code auto-mode classifier sometimes blocks pushes; when it does, ask the user to run `git push origin main` themselves.
- **Commit messages**: body explains *why*, not just *what*. Trailer: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- **After API pushes**, arm a Cloud Run revision watcher (Bash `run_in_background`) for a single completion notification when 100% traffic flips to the new revision. Pattern uses `until ... done` over `gcloud run services describe` with the current baseline.
- **Web-only pushes** trigger Vercel; don't arm the Cloud Run watcher for those.
- **Dependencies**: `cd apps/web && pnpm add <dep>` — never npm, never from repo root (hard-won lesson #25).

---

## Frontend UI system, Flags & access control

**`STYLE_GUIDE.md` (repo root) is the canonical UI reference.** Established in the 2026-05-27 consistency overhaul. Conform to it for any new UI; extend it in-PR rather than inventing one-offs. Key rules baked in across the app:

- **Button colour system (strict):** 🟢 green = approve/proceed/commit · 🔵 blue = skip/utility · 🔴 red = cancel/clear/start-over. No full-width buttons (`inline-flex`, never `w-full`).
- **Links/CTAs:** bold `sky-400` (global base-layer rule in `globals.css`).
- **One yellow:** `yellow-300` for field hints (matches provider-card text).
- **Auto-advance is GONE** — removed entirely. The per-card "Hold" on Enhance now just means "exclude from the bulk Send to Scan".
- **Tooltip accordions:** `TipBanner` is collapsible by default, driven by `apps/web/lib/useVisitCount.ts` — expanded visits 1-4, collapsed visit 5+ (localStorage `cleanshot_visit_count`). One blue tooltip per tab. The Enhance equipment-details red callout is the exception: always defaults expanded.
- **Equipment selectors** render as toggle-cards (blue selected / dark + radio-dot unselected), grouped warehouse-forks vs aerial via `EQUIPMENT_GROUPS` in `lib/types.ts`.
- **Scrollbar gutter:** `html { scrollbar-gutter: stable }` reserves the gutter so cards don't jump when the scrollbar appears.

**Vercel Flags SDK + PostHog** — `apps/web/flags.ts`. `identify()` resolves the operator from the Better Auth session (`getSessionEmail(await headers())`) so PostHog targets flags per-user by email. Example flag `myFlag`/`my-flag` is a template — rename to the real PostHog flag key. Adapter env vars come from `vercel env pull` (.env.local, gitignored); must also exist in Vercel Production.

**Per-user access control** — `apps/web/lib/access-control.ts`. `USER_RESTRICTIONS` config (keyed by lowercased SSO email) locks specific users to one model + Enhance-tab-only + toggles-off + custom-prompt-only + tracking. Currently: brian→grok, asia→gemini, aj→openai, stephen→kontext. **Inert until `AUTH_ENABLED=true`** (the workspace runs as `dev@local` otherwise, which isn't in the table). Enforcement is two-layer: UI gating in Workspace/EnhancePanel/MetaCard (cosmetic) + **authoritative server-side model-lock in the `/api/enhance` BFF route** (forces the locked model + strips toggles regardless of what the client sends). **Phase 2 — admin audit logging (prompt/result/model/email per restricted user, viewable + filterable in the admin panel) — is NOT built yet.** Plan in HANDOFF.md.

---

## Open work items (prioritised)

1. **Per-user access control — Phase 2 (admin audit logging).** Phase 1 (config + UI gating + server-side model lock) shipped 2026-05-28. Phase 2 NOT built: (a) `enhance_audit_log` table in `migrate_auth.py` (`id, timestamp, user_email, model_used, prompt_text, result_text`); (b) thread `user_email` through `/api/enhance` BFF → FastAPI `/api/v1/enhance` → `EnhanceTaskPayload` → `_run_enhance`, which writes the row on completion (result_text = output asset id + signed URL + status) for `tracking` users; (c) admin API `GET /api/admin/audit?user=` + BFF proxy; (d) "Audit" tab in `AdminDashboard.tsx`, filterable by user. Decision still open: full worker-side logging (captures result) vs cheaper BFF-only enqueue logging (no result). See HANDOFF.md.
2. **Per-model enhance prompts.** Single biggest quality lever left. Current `_build_enhance_prompt` is ~200 lines of declarative scene prose tuned for Gemini Nano Banana edit semantics, and it ships verbatim to every provider. Kontext especially is mismatched — BFL positions it for short imperative prompts (1–3 sentences) to preserve subject identity; long prose dilutes that. Reve has a 2560-char `edit_instruction` cap and explicitly auto-enhances the instruction internally, so it benefits from terse imperative prose too. Discussed plan: add `_build_kontext_prompt` first (Phase A, smallest win), then `_build_reve_prompt`, then `_build_openai_prompt` + eval harness (Phase B). Grok can share OpenAI's style.
3. **OpenAI `/v1/responses` rate pressure.** Enhance (gpt-5 + image_generation tool) and scan (gpt-5.4) both pull from the same endpoint quota. Already caused scan cascade failures once. Pick one: tier-bump the OpenAI org, OR add a scan-side `AsyncRateLimiter` on `/v1/responses`.
4. ~~**Raise Cloud Tasks `max_dispatches_per_second`** from `0.1` to `1.5` for `cleanshot-image-gen`.~~ **DONE 2026-05-27** — operator ran the gcloud command. Was the single biggest perceived-speed win: 10-image × 6-provider batch dispatch dropped from ~600s to ~40s. Per-provider rate limiters (`5/60s` OpenAI, `3/30s` Reve/Grok) are now the binding ceiling, as planned.
5. **~~Drop Gemini `thinking_level: High` → `Medium`~~ — DEAD LEVER.** `gemini-3.1-flash-image-preview` ONLY accepts `"High"`; both `"Medium"` and `"Low"` return `400 INVALID_ARGUMENT`. Code comment at `_enhance_with_gemini` says as much. Re-evaluate when an image-gen model with a real thinking-level spectrum ships to AI Studio. Until then, do not waste cycles on this knob.
6. **Input image downsize before vendor call** — upload pipeline already caps long edge at 1024 px (`compress.ts` on the web side), but the worker doesn't re-verify. Consider a server-side guard for 2048 max in `_load_image_bytes` to defend against any backend regen path that bypasses the upload cap.
7. **Valkey-backed rate limiters** if `max-instances > 1` and OpenAI batches grow. **Note 2026-05-26:** `min-instances` was bumped from 2 → 5 this session (warmer pool, less cold-start tax). The process-local limiter scope is now even more pronounced — "5 per 60s OpenAI" is effectively "25 per 60s across 5 instances" under burst load. Either accept the looser real ceiling, or move to a Valkey-backed limiter. Don't tighten the local limiters to "compensate" — that wastes capacity on cold instances.
8. **Extract `_load_image_bytes`** to `services/gcs.download_image` — currently 4-way triplicated across scan / enhance / cleanup / erase / inpaint-ideogram / tweak-ideogram workers (TODO marker in code).
9. **Ideogram rate limiter.** No limiter currently in place. Ideogram doesn't publish a per-minute cap; add a defensive `AsyncRateLimiter` if 429s start showing up in production logs.
10. **Provider-output cache** keyed on `(image_sha256, prompt, provider)` backed by Valkey. Re-runs with the same toggles/source/provider return instantly. Big win on the "operator iterates on toggles, hits Re-enhance" loop. Whole-batch hit rate is realistically 30-60% based on observed re-run patterns.
11. **OpenAI as opt-in, not default-on.** `gpt-5 + image_generation` is the slowest provider (~75s vs ~20s Gemini) AND it shares `/v1/responses` quota with scan (see item #3). The "Select all providers" checkbox we shipped in `f004606` makes the cost visible, but consider also un-checking OpenAI on initial mount if the operator hasn't manually selected it. Default-on for a 75s provider penalises every batch.
12. **Considered + declined (do not re-litigate without new evidence):**
    - **Runway Gen-4** — evaluated 2026-05-26, declined. Redundant with Kontext for identity preservation, 2-3× the per-image cost, slower API. Note in CLAUDE.md to prevent re-evaluation.
13. **Recently shipped, archived from this list:**
    - **Per-user access control Phase 1 (2026-05-28).** `lib/access-control.ts` config + UI gating (Workspace tabs, EnhancePanel locked-model/no-toggles/custom-prompt-only, MetaCard metadata hidden) + authoritative server-side model lock in the `/api/enhance` BFF route. Inert until `AUTH_ENABLED=true`. Phase 2 (admin audit logging) is open work item #1.
    - **UI consistency overhaul + `STYLE_GUIDE.md` (2026-05-27/28).** 9-section pass: removed auto-advance entirely, global bold sky-400 links, green/blue/red button system, no full-width buttons, collapsible tooltip accordions (`useVisitCount`, expanded visits 1-4 / collapsed 5+), standardized drag-drop zones, equipment toggle-cards, Modify bottom button row (gold tooltip removed), compacted Resize export cards (black bg + thin border, "PRO CONSTRAINTS EXPORT" / "COLLAGE EXPORT", yellow bullets), Scan pre-scan image previews, Enhance equipment-details accordion, `scrollbar-gutter: stable` (no card-jump). `STYLE_GUIDE.md` at repo root is the canonical reference.
    - **Vercel Flags SDK + PostHog (2026-05-28, commit `e103f2b`).** `apps/web/flags.ts` with session-based `identify()`. Template flag `my-flag` — rename to real PostHog key when gating a feature.
    - **Better Auth `trustedOrigins` for discountforklift.ai (2026-05-28).** Added apex + www + Vercel + localhost so the 2nd domain's sign-in POSTs aren't CSRF-rejected. SSO re-enable (`AUTH_ENABLED=true`) + per-domain Entra redirect URIs are operator steps.
    - **GCS CORS policy `infra/gcs-cors.json` (2026-05-28).** Fixed "GCS PUT network error" uploads from the new domain — bucket CORS now allows discountforklift.ai. Operator applied to both browser-PUT buckets. See lesson #26.
    - **frozen-lockfile CI fix (2026-05-28, commit `fe9b3fc`).** Root `npm install` had polluted the pnpm lockfile's root importer with flags deps. See lesson #25.
    - **Cloud Tasks dispatch-rate bump 0.1 → 1.5 /s (2026-05-27).** Operator ran `gcloud tasks queues update cleanshot-image-gen --max-dispatches-per-second=1.5 --max-concurrent-dispatches=20 ...`. Single biggest perceived-speed win in the whole session — a 10-image × 6-provider batch (60 jobs) now dispatches in ~40s instead of ~600s. Per-provider rate limiters are now the binding ceiling, not the queue. No code change.
    - **Per-provider speed tuning (2026-05-27, commit `8cf10c4`).** OpenAI `reasoning_effort: low` cuts ~25-40s off each gpt-5 call (75s → ~45s); Ideogram `rendering_speed: TURBO` (25s → ~15s); Kontext poll cadence tightened (front-load 0.5-1.0s intervals + steady 1.0s, max attempts 90) to catch completion ~1-2s sooner. Gemini `thinking_level="High"` confirmed as the only accepted value — not a knob.
    - **7-equipment expansion (2026-05-27, commits `16d47d9` + `7e3ee21` + `59b5520`).** Added Reach Truck, Order Picker, Pallet Jack, Walkie Stacker as enhance equipment types alongside Forklift, Telehandler, Scissor Lift. Backend `EQUIPMENT_DISPLAY` / `EQUIPMENT_ANATOMY` / `EQUIPMENT_BODY_PARTS` dicts extended with per-type anatomy prose. `paint_forks_on` rule relaxed from `equipment_type in ("forklift", "telehandler")` to `equipment_type != "scissor_lift"` since the 4 new types all carry visible forks. Frontend `EQUIPMENT_GROUPS` introduced (warehouse forks vs aerial) — chip strip now renders as two visually distinct segmented controls instead of one continuous row, wired across MetaCard + ResizePanel.
    - **Vercel Speed Insights wired + Real Experience Score fix pass (2026-05-27, commits `feb4fdf` → `00cf91e` → `9e7bf70` → `a9298b6`).** `<SpeedInsights />` added to root layout. Initial RES was 74 / "Needs Improvement" with CLS=0.29 (poor) and LCP=3.49s (yellow). Fixes shipped: explicit `width`/`height` on UserMenu avatar (36×36) + Header logo (230×64, intrinsic 1438×400) + thumbnail images; dynamic-import of Scan/Modify/Resize/History panels (Enhance stays static as the default tab) + `visitedTabs: Set<TabId>` gate so panel chunks only download on first activation but stay mounted afterwards (state preserved); TipBanner step list deferred one paint after mount; `<link rel="preload" as="image">` for logo + `<link rel="preconnect" crossOrigin="anonymous">` for Cloud Run API; UserMenu skeleton placeholder while `useSession.isPending`; tab-hover/focus prefetch of dynamic-imported chunks via `TAB_PREFETCH` map in Workspace + `onPrefetch` prop on TabBar.
    - **Deploy-web CI pipeline rewrite (2026-05-27, commits `b75bdf4` + `cc4370e`).** Dropped `amondnet/vercel-action@v25` (rotted — pinned `vercel@25.1.0`, rejected by current Vercel API with "version 47.2.2 or later required"). Now installs `vercel@latest` per-run and invokes the three-command CI pattern (`vercel pull` → `vercel build` → `vercel deploy --prebuilt`). Also dropped redundant `working-directory: apps/web` that was path-doubling with the project's Root Directory setting. Captured the why in hard-won lessons #22 + #23.
    - **Vercel Deployment Protection disabled on Production (2026-05-27, operator-side toggle).** Was silently blocking the production alias even though CI reported deploys + alias step as successful — symptoms: `clean-shot-web.vercel.app` 404'd with `DEPLOYMENT_NOT_FOUND`, immutable deployment URL 401'd with `_vercel_sso_nonce`. Internal tool already has its own auth gate (Better Auth + Microsoft SSO), so Vercel-side protection was double-locking. Captured as lesson #24.
    - **`engines.node` pinned 22.x + Speed Insights install (2026-05-27, commits `b578742` + `feb4fdf`).** Vercel was warning that `">=22.11.0"` would silently jump majors when Node 24 lands as a supported runtime. Pinned to `22.x` (still picks up patches + minors). `@vercel/speed-insights@2.0.0` added as a dep alongside the existing `@vercel/analytics`.
    - **Cloud Run `min-instances` 2 → 5 (2026-05-26).** Warmer pool kills cold-start tax on burst dispatch. Mild monthly cost bump (~3 extra always-on CPU at idle); the latency win on the first 1-2 requests of a new batch is worth it. Pair with the Cloud Tasks dispatch-rate bump (now done — first bullet above) to fully unlock burst throughput.
    - **Infinite photo library storage (this session).** GCS lifecycle rule deleted; `approval_sets.expires_at` made nullable; UI badge hides when NULL. Photo library now keeps approved sets forever. Operator ran `gcloud storage buckets update gs://cleanshot-derivatives-prod --clear-lifecycle` after the code change shipped. See commit `32df157`.
    - **Enhance UX defaults overhaul (this session).** Toggles default OFF on landing (previously baked in `newPaintJob` / `paintForksRedYellowTips` / `removeRentalBranding` — silently repeating across batches). "Select all" checkbox added to the AI providers row header — toggles between "all 6 providers" and "just Gemini," never to zero. See commit `f004606`.
    - **Modify → Resize CTA (this session).** Green success card with "Continue to Resize →" button appears under Apply after a successful modify run. Existing `onModifyApplied → setResizeAssets` path already pushed the modified images into Workspace state, so the button just flips the active tab. See commit `d06424a`.
    - **Recraft → Reve swap (this session).** Wired Recraft V3 end-to-end on 2026-05-26 (`b03032a` + five fix commits), then gutted same day after operator preferred Reve's output on quality. Reve restored as 6th primary generator with the previous `_enhance_with_reve` implementation (sync /v1/image/edit, base64 JSON, 2560-char prompt cap, `latest-fast` pinned for RPM headroom). Recraft secret left in Secret Manager pending operator decision on full delete.
    - Ideogram as 5th primary enhance generator + per-variant Edit/Inpaint tools (`1babd98`, `7d9ef6b`, `d0e93b1`, `ad7b202`). Initially declined as a primary generator on 2026-05-26 (creative-drift concern); reversed same day after operator request — wired end-to-end to the existing `_tweak_with_ideogram` helper. The two per-variant tools (cyan ✎ Edit + rose 🖌 Inpaint) ship alongside it for targeted decal/text repair on completed variants.
    - Showroom Floor toggle on Enhance advanced toggles (this commit). New `showroomFloor` field in `EnhanceToggles`; backend prompt block under `_build_enhance_prompt` adds a SHOWROOM / STUDIO FLOOR action when set. Off by default — applying it to non-studio photos would over-clean a real ground surface.
    - Branded collage composer (`/api/v1/export/branded-collage` + Create Image Collage UI + preview-with-save-to-history) (`0a0b48a`, `68cc6b0`).
    - Branded collage layout proportions matched to company's blue reference (`cc531e8`).
    - AI-disclaimer watermark with operator opt-in checkbox (`8de9203`).
    - Auto-advance toggle disabled during beta (greyed-out in Header; `onClick` no-op; one-line restore when it graduates).
    - Phase 3 toggles auto-reset + re-enhance with new toggles (`4291f17`), per-provider scan isolation (`0747d14`), Erase tool + canvas UI (`acd33ec`, `5f9bffa`, `370d542`), Kontext via RunComfy as 4th generator (`008cd51`, `85f16cc`), OpenAI gpt-5 + image_generation tool migration (`fe02b3c`), Reve removed (`a0cedac`).

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
- Secrets in use: `cleanshot-database-url`, `cleanshot-api-key(+prev)`, `cleanshot-openai-key`, `cleanshot-anthropic-key`, `cleanshot-bfl-key` (erase-only — Flux is no longer a primary generator), `cleanshot-gemini-key`, `cleanshot-xai-key`, `cleanshot-runcomfy-key`, `cleanshot-ideogram-key` (5th primary generator + per-variant edit/inpaint tools), `cleanshot-reve-key` (6th primary generator — reinstated 2026-05-26), `cleanshot-tasks-oidc-sa`, `cleanshot-worker-url`
- Deprecated (safe to delete from Secret Manager): `cleanshot-recraft-key` (Recraft removed 2026-05-26)
