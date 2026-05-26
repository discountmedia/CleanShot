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
  - `/api/v1/export/collage` — 1024 px long-edge fit (no crop), ≤99 KB JPEG. Single asset or streamed ZIP for batches. Used when the operator already pre-composed a multi-image layout upstream.
  - `/api/v1/export/branded-collage` — composes a 1024×540 marketing-layout collage from EXACTLY 5 source assets (index 0 = hero, 1–4 = thumb strip). Dimensions: hero 720×540 (4:3), thumbs 304×135 each (4 stacked edge-to-edge). Match the company's existing blue-reference template. Filename suffixed by equipment type (`cleanshot_forklift_collage.jpg`, etc.).
  - `/api/v1/export/custom` — arbitrary dimensions, JPEG/PNG/WebP/BMP.
  - `/api/v1/export/zip` — streaming ZIP for batch downloads.
- **AI-disclaimer watermark.** Optional opt-in flag (`ai_disclaimer: bool`) on `ExportProRequest`, `ExportCollageRequest`, and `ExportBrandedCollageRequest`. When `True`, pyvips burns the string `"AI-enhanced image — depicts the unit as it will be delivered"` into the bottom-right corner of every output JPEG (black shadow at ~55% alpha + white foreground at ~70% alpha for legibility on both light and dark backgrounds, 11 pt sans-bold, 12 px margin). Constant lives in two places that must stay in sync: `AI_DISCLAIMER_WATERMARK` in `apps/web/components/resize/ResizePanel.tsx` (UI preview) and `apps/api/src/cleanshot_api/services/image_processing.py` (pyvips render). Helper: `_apply_disclaimer_watermark()`.
- **Branded-collage preview + Save-to-History.** Frontend doesn't auto-download anymore — the composed JPEG lands in an emerald-bordered preview card directly below the Create button with inline image, file-size readout, and two action buttons: ⬇ Download (browser download from the blob), 💾 Save to History (uploads the blob to GCS via signed PUT + folds the resulting asset into the approval set). Blob URLs revoked on unmount + when a new collage replaces the current preview.
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

20. **AI-disclaimer watermark string lives in two files that must stay in sync.** `AI_DISCLAIMER_WATERMARK` in `apps/web/components/resize/ResizePanel.tsx` (UI preview next to the checkbox) and `apps/api/src/cleanshot_api/services/image_processing.py` (pyvips render). Frontend value is what the operator sees; backend value is what gets burnt into the JPEG. Diverging values mean the preview lies — change both or change neither.

21. **Secret-Manager values get contaminated with the gcloud command text itself when rotated wrong** — this bit `cleanshot-recraft-key` twice on 2026-05-26 (first stored value: `lication-policy=automati` from a `--lifecycle-policy=automatic` flag fragment; second stored value: `gcloud secrets create cleanshot-recraft-key --` literally). Both produced unhelpful Recraft errors — the first failed `^Bearer [^\s]+$` with a "Authorization header format must be Bearer {token}" 400, the second mashed together after `.strip()` looked like a token to Recraft's parser and got a 401 "request unauthorized." The symptom changes depending on what's in the value, which makes diagnosis confusing. **Always rotate secrets with this exact pattern** (keeps the key off the terminal and avoids `echo`'s trailing newline):

    ```bash
    read -s -p "Secret value: " K && echo
    printf "%s" "$K" | gcloud secrets versions add <SECRET_NAME> --data-file=- --project=cleanshot-493512
    unset K
    history -d $((HISTCMD-1))
    ```

    Then `gcloud run services update cleanshot-api --region=us-central1 --update-secrets="ENV_VAR=<SECRET_NAME>:latest"` to roll the revision (or push an empty commit to trigger the workflow — but never `--set-secrets` outside the workflow, that wipes the others). Verify with `gcloud secrets versions access latest --secret=<SECRET_NAME> | wc -c` — expect 30–100 bytes for typical API keys; >150 or printable command text means redo. The diagnostic fingerprint in `_enhance_with_recraft` (`key_fp=len=N prefix='abcd' suffix='wxyz' raw_len=M`) is the pattern to copy when wiring future providers — it surfaces secret-value bugs from Cloud Run logs without leaking the value.

---

## Conventions

- **Direct-to-main pushes** are the norm — no PR review process. The Claude Code auto-mode classifier sometimes blocks pushes; when it does, ask the user to run `git push origin main` themselves.
- **Commit messages**: body explains *why*, not just *what*. Trailer: `Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>`.
- **After API pushes**, arm a Cloud Run revision watcher (Bash `run_in_background`) for a single completion notification when 100% traffic flips to the new revision. Pattern uses `until ... done` over `gcloud run services describe` with the current baseline.
- **Web-only pushes** trigger Vercel; don't arm the Cloud Run watcher for those.

---

## Open work items (prioritised)

1. **Per-model enhance prompts.** Single biggest quality lever left. Current `_build_enhance_prompt` is ~200 lines of declarative scene prose tuned for Gemini Nano Banana edit semantics, and it ships verbatim to every provider. Kontext especially is mismatched — BFL positions it for short imperative prompts (1–3 sentences) to preserve subject identity; long prose dilutes that. Reve has a 2560-char `edit_instruction` cap and explicitly auto-enhances the instruction internally, so it benefits from terse imperative prose too. Discussed plan: add `_build_kontext_prompt` first (Phase A, smallest win), then `_build_reve_prompt`, then `_build_openai_prompt` + eval harness (Phase B). Grok can share OpenAI's style.
2. **OpenAI `/v1/responses` rate pressure.** Enhance (gpt-5 + image_generation tool) and scan (gpt-5.4) both pull from the same endpoint quota. Already caused scan cascade failures once. Pick one: tier-bump the OpenAI org, OR add a scan-side `AsyncRateLimiter` on `/v1/responses`.
3. **Raise Cloud Tasks `max_dispatches_per_second`** from `0.1` to `1.0–2.0` for `cleanshot-image-gen`. Real win for batch dispatch latency.
4. **Drop Gemini `thinking_level: High` → `Medium`** for enhance/cleanup. Saves measurable reasoning time with marginal quality cost on image edits.
5. **Input image downsize before vendor call** — upload pipeline already caps long edge at 1024 px (`compress.ts` on the web side), but the worker doesn't re-verify. Consider a server-side guard for 2048 max in `_load_image_bytes` to defend against any backend regen path that bypasses the upload cap.
6. **Valkey-backed rate limiters** if `max-instances > 1` and OpenAI batches grow.
7. **Extract `_load_image_bytes`** to `services/gcs.download_image` — currently 4-way triplicated across scan / enhance / cleanup / erase / inpaint-ideogram / tweak-ideogram workers (TODO marker in code).
8. **Ideogram rate limiter.** No limiter currently in place. Ideogram doesn't publish a per-minute cap; add a defensive `AsyncRateLimiter` if 429s start showing up in production logs.
9. **Considered + declined (do not re-litigate without new evidence):**
   - **Runway Gen-4** — evaluated 2026-05-26, declined. Redundant with Kontext for identity preservation, 2-3× the per-image cost, slower API. Note in CLAUDE.md to prevent re-evaluation.
10. **Recently shipped, archived from this list:**
    - **Recraft → Reve swap (this commit).** Wired Recraft V3 end-to-end on 2026-05-26 (`b03032a` + five fix commits), then gutted same day after operator preferred Reve's output on quality. Reve restored as 6th primary generator with the previous `_enhance_with_reve` implementation (sync /v1/image/edit, base64 JSON, 2560-char prompt cap, `latest-fast` pinned for RPM headroom). Recraft secret left in Secret Manager pending operator decision on full delete.
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
