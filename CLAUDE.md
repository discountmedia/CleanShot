# CleanShot — Project Briefing for Claude

Internal B2B tool that takes used-forklift photos and produces clean, listing-ready images via an AI pipeline. Not customer-facing. No external sharing, no per-seat billing — the company pays AI vendor costs and the only "users" are employees authenticated via Microsoft SSO.

---

## Architecture at a glance

- **`apps/web`** — Next.js app on **Vercel**. UI, Microsoft SSO (Better Auth), admin dashboard, support tickets, profile page. All FastAPI calls go through Next.js Route Handlers in `apps/web/app/api/*` (BFF pattern — browser never talks to FastAPI directly).
- **`apps/api`** — Python/FastAPI on **Cloud Run** (`cleanshot-api`, us-central1, project `cleanshot-493512`). Single container handles HTTP + Cloud Tasks worker callbacks under `/worker/*`.
- **`apps/worker-image` / `apps/worker-video`** — empty scaffolding; real workers live inside `apps/api/src/cleanshot_api/workers/`.

### Data stores
- **Postgres 17** on Cloud SQL — `cleanshot-database-url:latest`; asyncpg pool. Schema is applied by the idempotent `CREATE TABLE IF NOT EXISTS` blocks in `db/migrate.py` + `db/migrate_auth.py`, which run on startup — **adding a table means editing those files, and the deploy applies it.** Adding a value to an existing Postgres ENUM still needs an explicit `ALTER TYPE` (lesson #12).
- **Valkey 9** on Memorystore — `valkey://10.122.45.83:6379` (in-VPC).
- **GCS buckets** — `cleanshot-originals-prod` (uploads), `cleanshot-derivatives-prod` (enhance + cleanup outputs, plus `approved/{email}/{dir}/` curated sets).
- **Cloud Tasks** — `cleanshot-image-gen` (enhance + cleanup) + `cleanshot-image-scan` (scan). OIDC-authed via SA `forklift-api@cleanshot-493512.iam.gserviceaccount.com`.

### Deploy pipelines
- **API** → `.github/workflows/deploy-api.yml` on push to `apps/api/**`. Builds Docker, pushes to Artifact Registry, `gcloud run deploy` with the canonical `--set-secrets` + `--set-env-vars` list. **The workflow's env-var list is authoritative** — every deploy replays it, so manual `gcloud run services update --update-env-vars` outside the workflow gets wiped on next push.
- **Web** → `.github/workflows/deploy-web.yml` on push to `apps/web/**` or `packages/types/**`. Uses `amondnet/vercel-action@v25`.

### Routers (FastAPI)
`admin`, `approvals`, `export`, `jobs`, `modify`, `operations`, `profiles`, `projects`, `saved_prompts`, `scan_results`, `sessions`, `support`, `upload`, `worker`

### Services (FastAPI)
`gcs`, `image_processing`, `pricing`, `rate_limit`, `tasks`

---

## Phase progress

| Phase | Status |
|---|---|
| **1. Foundation** (infra, DB, GCS, Cloud Tasks, secrets) | ✅ Complete |
| **2. AI pipelines** (Enhance, multi-model Scan with consensus) | ✅ Complete & in production |
| **3. UX + auth** (export flow, Microsoft SSO, profile, admin, support) | ✅ Complete — SSO is live |
| **4. Rollout & operations** (analytics, rate limiters, scan resilience, per-variant tools, saved prompts) | 🟡 Ongoing |

**Tab order (current):** `Enhance → Scan → Your Photo Library`. There are no Modify or Resize tabs. "Your Photo Library" is the History tab — internal identifiers (TabId `"history"`, `HistoryList.tsx`, `/api/history`) stay as-is.

**The Enhance tab is now the whole workflow.** Prompt → generate → inline scan → per-image retry/adjust → export. Nothing navigates between tabs during normal work: Scan is a standalone side tool, and export is the save. If you are about to add a "send to X tab" affordance, that is a reversal of a deliberate decision — check first.

---

## Enhance tab — current shape

**Prompt-first.** The operator's typed prompt is REQUIRED and is the spine; `_build_enhance_prompt` appends toggle add-ons and the hard guardrails on top of it (`spine_override`). The old one-size built-in prompt survives only as a dormant fallback. Two prompt paths, and confusing them causes real bugs:

- **Enhance-tab prompt = SPINE** — the builder augments it.
- **Scan-regen prompt = VERBATIM** — `buildRegenPrompt` already composes a complete prompt including its own guardrails, so `prompt_is_complete=True` keeps it off the builder. Without that flag the reroute double-appends guardrails and attaches a forklift-default guardrail to non-forklift regens.

**Saved prompts.** Operators save the current prompt to their profile under a title and re-insert it in one click (`SavedPromptsBar.tsx`, `routers/saved_prompts.py`, `saved_prompts` table). Titles are unique per user via a `UNIQUE INDEX ON (user_email, lower(title))` — the DB is the authority, not a pre-check, so two tabs racing on one title can't both win. A collision returns **409**, which the UI turns into an overwrite-or-rename question; never resolve it silently. Inserted text is a copy; editing it never writes back.

**Four visible toggles.** `VISIBLE_TOGGLES` in `apps/web/lib/types.ts` is the single list controlling which toggles render: rental-fleet branding removal, floor cleanup (`showroomFloor`), remove people, shine tires. **The others are hidden, not deleted** — their state, handlers, labels and backend prompt-injection all still work, and a hidden toggle sits at its `DEFAULT_TOGGLES` value (all `false`). Restoring one is adding a key to that array. Do not "clean up" the unused ones.

**Inline scan.** Every enhance output is scanned automatically — `_run_enhance` has always enqueued a differential scan job per completed variant. The Enhance tab READS those results (`lib/inline-scan.ts` folds the session payload's `jobs` + `scan_results` into per-asset state) and renders them beside each variant. **Do not enqueue scans from the browser** — it doubles the AI spend on every batch for results the backend already produces.

**Per-image, not per-batch.** Retry, contrast/saturation, and fork conditionals are all per source image. `EnhanceTaskPayload` was already per-job, so per-image features need a new field, not new plumbing. Retry re-runs one (file, provider) pair with the CURRENT prompt and toggles and swaps it in place.

**Re-enhance has no dirty-input guard.** An identical batch can be re-run at will — generation is non-deterministic and a second roll is often the point.

**Best-of-N auto-pick.** A multi-provider (≥2) batch is auto-judged by a single Claude vision call and the winner auto-selected. Model pinned to `claude-sonnet-4-6` — **do not swap it; that invalidates the ~70% operator-agreement calibration.** Candidates are labelled neutrally ("CANDIDATE 1/2/3") so brand can't bias the pick. There is a `judgeEpochRef` + `judgeStartedRef` guard because a re-enhance during an in-flight judge could otherwise write the OLD batch's winner onto a reused file id and silently drop an image from export.

### Fork conditionals (experimental, OFF by default)

Conditional fork rules inside the prompt don't hold when the fork isn't fully in frame: with the upright section out of shot the model paints the carriage or overhead guard into a shank; with the tips cropped it SHORTENS the forks to bring tips into view so it has something to paint yellow.

The fix is **fragment removal, not counter-instruction** — emphatic "do not draw X" backfires on Gemini (see the reverted Phase A experiment below). Both the frontend starter (`lib/recommended-prompt.ts`) and the backend fork block (`_build_fork_fragments`) are ordered lists of whole, self-contained sentences, so any subset still reads as coherent prose. The yellow-tip clause is **substituted**, not merely deleted — silence lets the model fall back on its yellow-tip prior.

- **Master switch is off by default, session-only, never persisted, never enabled as a side effect of anything else.** `forkVisFor()` in `EnhancePanel` is the ONE gate every read goes through; with the feature off it returns fully-visible regardless of stored per-file state, and `promptForFile` returns the operator's text verbatim with no rebuild. That is what makes "turn it off" a true restore with no residual effect.
- **Custom prompts degrade visibly.** If the operator reworded the prompt there is no fragment of ours to remove, so the backend appends an explicit FORK FRAMING note instead and the UI says so. `fork_framing_in_prompt` stops both paths firing and saying it twice.
- Automatic detection would need no rework here (the flags are per-image booleans resolved at enqueue), but note the ordering problem: the scan runs AFTER enhance, so auto-detection needs a pre-pass on the SOURCE photo.

### Durable findings — do not relearn

- **Prompt wording is NOT the lever for hard equipment types.** Gemini handles big/common machines fine (telehandler, articulated, counterbalance) but botches **warehouse-electric gear** (reach trucks, order pickers, walkie stackers, pallet jacks) — recolours cab/mast, adds wheels, desaturates, reshapes — inconsistently run-to-run **regardless of prompt**. Measured via eval harness + operator grading: full rewrite = wash; per-type "THIS MACHINE" block = mixed/negative. It is a model capability/variance limit. Do not re-run prompt A/Bs on these types.
- **Tried and REVERTED — don't redo blindly:** the Phase A enhance-prompt change (make/model/year identity anchor + "PRESERVE EXACT DIMENSIONS" guardrail) shipped as `48c653f` and was reverted in `1585f46` after it regressed output. Emphatic "don't change X" guardrails backfire on Gemini — the "don't think of an elephant" effect.
- **Operator's holistic pass/fail bar** (a part-diff count does NOT predict it): FAIL for cab/mast/body recoloured to a DIFFERENT hue, desaturation, added wheels/parts, reshaping, an obviously-AI look, or a legible model-# significantly wrong. PASS/tolerate: same-colour body respray, red forks + yellow tips, BLACK backrest/carriage, cleaned background/floor, better lighting, subtle geometry, 1-2 char model-# drift.
- **Paint is STANDING policy in the differential scan prompt**, not a per-batch whitelist entry — same-colour respray, red/orange forks + yellow tips, black backrest/carriage/load guard, repainted wheels/counterweight are always expected. This is what stopped the scan false-positiving on the exact edits the operator asked for. Geometry flags were removed from the differential vocabulary entirely ("no one understands what that means" — it was the label on most false positives); gross deformity still lands as `size_changed`/`part_added`/`part_removed`.
- **The differential scan CAN and MUST report body colour changes.** It briefly
  could not: the rubric said "A repaint is NEVER a defect. Do not report any
  anomaly for paint" while defect #5 pointed back at that same rule, and the
  `AnomalyItem.type` field description — which constrains structured output —
  listed `wrong_colour` as valid and forbade "paint/colour changes" in the same
  sentence. A full grey-to-orange body repaint scanned clean. The paint
  allowance is now scoped to the SAME COLOUR FAMILY, and two cases are explicit
  defects: a large body panel changing colour family, and non-marking (white /
  cream / light grey) tyres turned black. **Non-marking tyres are a real priced
  spec** — turning them black misrepresents the machine as surely as a body
  recolour, and `shine_tires` is on by default, so this is not a hypothetical.
  Nothing in the intended-edits whitelist, including the operator's verbatim
  prompt, can authorise either case.
- **`computeConsensus` returns `"mixed"` if any ONE of three providers fails**, so a single over-eager vote still costs a clean pass badge. Changing it is a verdict-semantics decision, not a bug fix.

---

## Image sizing — one standard, one place

**Enhanced images are exactly 2800x2000 (true 7:5).** `upscale_to_standard()` in
[image_processing.py](apps/api/src/cleanshot_api/services/image_processing.py) is
called ONCE, at the end of enhancement, before the bytes are written to GCS. The
stored asset is therefore already the finished size, and every later stage —
per-image adjustments, the disclaimer composite, export, the copies written to
the user's project — operates on it directly and never resamples.

- **`export_pro` no longer resizes or crops.** It composites the disclaimer and
  encodes. Sizing used to live there, which meant the stored enhanced asset was
  whatever the vendor returned (~1024 Gemini, 1536x1024 OpenAI) and only became
  7:5 on the way out. If you find yourself adding a resize to an export path,
  that is the bug this change fixed.
- **The erase and tweak workers standardise too.** They REPLACE the stored
  variant, so without it one tweak drops the image back to vendor resolution.
  Any future tool that rewrites a variant must call `upscale_to_standard`.
- **`_cover_crop()` is the only crop-to-fill implementation.** Scale to cover,
  then crop the overflow, centred. Never pads, never letterboxes, never
  stretches — a non-uniform scale distorts the machine and makes the listing
  photo inaccurate. `export_custom` was refactored onto it so the two can't
  drift. Note it uses a plain centre crop; `smartcrop(interesting="attention")`
  was the old behaviour and follows the salient region instead.

**Input resolution is NOT capped.** Both caps are gone: `MAX_LONG_EDGE` in
`lib/compress.ts` and the downsize inside `enhance_worker._load_image_bytes`
(`INPUT_MAX_LONG_EDGE_PX` survives as an unapplied constant so the old behaviour
is one line away). Sources reach the model at native resolution, which is what
makes the 2800x2000 standard meaningful rather than an upscale of a 1024px
frame. Watch for the thing that originally justified the cap: OpenAI
`/v1/responses` timeouts on large uploads.

- **Byte compression stays on the client, and the reason in the old comment was
  wrong.** Uploads go straight to GCS via a signed PUT, so Vercel's 4.5 MB
  serverless body limit never applied to image bytes. The quality loop is now
  best-effort and no longer throws when it can't hit the target.
- **The scan path has its OWN cap (`SCAN_MAX_LONG_EDGE_PX = 2576`) and that is
  deliberate, not an oversight.** The binding constraint is Anthropic's
  SERVER-SIDE VISION DOWNSCALE, not bytes: `claude-sonnet-4-6` is standard tier
  and gets downscaled to a 1568px long edge; `claude-opus-4-7` (the hard-scan
  route) is high-resolution tier at 2576px / 4784 visual tokens. 2576 serves the
  hard path at full fidelity and wastes nothing on the standard path — anything
  larger is bytes and latency for pixels the model never sees. Byte limits are
  not close: 10 MB per image base64 on the direct Claude API (**the 5 MB figure
  is Bedrock/Vertex and does not apply to us**), 32 MB per request; OpenAI is
  looser still at 512 MB. Gemini is unaffected — it reads the GCS URI. Do not
  "unify" this with the enhance path: resolution there is output quality, here
  it is only enough pixels to see a repaint. Numbers verified against vendor
  docs 2026-08-21; re-check if the scan models change tier.

---

## Image-gen providers — what's wired and which model

The Enhance tab picker is now **2 live providers** (`gemini | openai`) — narrowed to 3 on 2026-06-05, then **Grok made dormant 2026-07-21** (see Latest session). The `EnhanceRequest`/`EnhanceTaskPayload` provider Literals still allow `gemini|openai|grok` (grok kept as dormant code). `grok | kontext | ideogram | reve` all remain as dead-but-harmless worker code, unreachable from the picker. All routing happens in `_run_enhance` in [enhance_worker.py](apps/api/src/cleanshot_api/workers/enhance_worker.py). Defaults to `gemini`. The table below documents all six worker helpers; only `gemini` + `openai` are live.

| Provider | Model ID | SDK / endpoint | Key |
|---|---|---|---|
| `gemini` | `gemini-3.1-flash-image-preview` | `google-genai` via **AI Studio** backend (`api_key=`, not `vertexai=True`). Preview models live on AI Studio first. | `cleanshot-gemini-key` |
| `openai` | `gpt-5` + `image_generation` tool | `openai.AsyncOpenAI` `client.responses.create(..., tools=[{"type":"image_generation"}], tool_choice={"type":"image_generation"})`. gpt-5 reads the input image + prompt then dispatches the image_generation tool, which internally invokes a gpt-image-* model. The forced tool_choice ensures gpt-5 always generates (without it, gpt-5 can decide the prompt is conversational and reply with text). | `cleanshot-openai-key` |
| `grok` | `grok-imagine-image-quality` at `https://api.x.ai/v1/images/edits` | OpenAI-compatible image-edit API, Bearer auth, prompt max 4000 chars | `cleanshot-xai-key` |
| `kontext` | `flux-1-kontext/max/edit` at `https://model-api.runcomfy.net/v1/models/blackforestlabs/flux-1-kontext/max/edit` | **RunComfy async proxy**. POST returns `request_id`; poll `/v1/requests/{id}/status` until `"completed"`; GET `/v1/requests/{id}/result` for the rendered image URL. Body field is `image_url` (singular string — NOT `images` array; that's Seedream's shape). RunComfy fetches the image via HTTPS so we mint a short-lived signed GCS GET URL via `services.gcs.mint_read_url` and pass that. | `cleanshot-runcomfy-key` |
| `ideogram` | `ideogram-3.0` at `https://api.ideogram.ai/v1/edit` | **Sync** multipart endpoint. POST returns JSON with `data[0].url` already populated; GET that URL (no auth header) for the bytes. Reuses the per-variant `_tweak_with_ideogram` helper — primary-enhance path just passes the full enhance prompt instead of a short tweak instruction. Surfaces twice in the UI: as the cyan provider card on Enhance (full generation) AND as the cyan ✎ + rose 🖌 per-variant tools (targeted edit + mask inpaint). Wired 2026-05-26 (`ad7b202`). | `cleanshot-ideogram-key` |
| `reve` | `reve-edit-fast-latest` at `https://api.reve.com/v1/image/edit` | **Sync** JSON endpoint. Bearer auth. Body: `edit_instruction` (string, **2560-char cap**), `reference_image` (base64), `version` (`latest-fast` pinned). Response: `{ image: <base64 PNG>, credits_used, credits_remaining, content_violation }`. The model's note "this instruction will be automatically enhanced by the model" means truncation is forgiving — we slice to 2560 chars and accept any meaning lost in the tail. Pin to `latest-fast` (not `latest`) for RPM headroom; full-quality reliably trips Reve's undocumented per-minute cap. Operator preferred Reve over Recraft on quality after a same-day re-evaluation (2026-05-26). | `cleanshot-reve-key` |

**Removed / repositioned providers (don't reintroduce as primary generators without reading why):**

- `grok` — made **DORMANT 2026-07-21** (`fb4e24a`; operator cut it from the mix). Removed from `ENHANCE_PROVIDERS` (the picker roster in `lib/types-enhance.ts`) so it can't be selected / defaulted-to / fanned-out-to — but kept in the `EnhanceProvider` union + every Record + the backend `gemini|openai|grok` Literal + `_enhance_with_grok`. Re-enable = uncomment the one array entry. `cleanshot-xai-key` left in place.
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

**Scan prompt philosophy (2026-06-25).** The prompt is a **CYA gate against serious, obvious AI generation failures only** — NOT a photo critic and NOT a perfectionist. `SCAN_SYSTEM_PROMPT_BASE` instructs all three providers to **default to `pass`** and `fail` only for gross/unmistakable defects (duplicated/missing/melted major parts, obvious gibberish text, wildly wrong colour, hallucinated fused objects, mangled people). It **explicitly must NOT flag** minor warped geometry, slightly-soft/partially-legible text, subtle colour shifts, or **any** photography quality (lighting/angle/composition/exposure/focus/framing/background) — and must never give advice or tips. `AnomalyItem.severity` is `medium`/`high` only (no `low`/nitpicks). This was a direct response to over-eager warped-geometry + garbled-text false positives on production-fine images. If retuning, edit `SCAN_SYSTEM_PROMPT_BASE` in scan_worker.py and the `ScanResult`/`AnomalyItem` Field descriptions in schemas.py (the schema descriptions ship to the providers too).

**Equipment context threading (2026-06-25).** `ScanBatchRequest` + `ScanTaskPayload` carry optional `equipment_type` + `make`. `_build_scan_prompt(equipment_type, make)` appends a "KNOWN EQUIPMENT CONTEXT" block so the inspector judges anatomy against the right machine (e.g. a scissor lift has no forks) — cutting false "missing/warped part" flags. The Scan tab now renders the same `MetaCard` as Enhance (shared workspace `meta` state via `onMetaChange`), so standalone scans get equipment context too. The three `_scan_*` helpers take a `system_prompt` arg; the module-level `SCAN_SYSTEM_PROMPT` alias is kept for back-compat.

**Differential (before/after) scan (2026-07-13, `3a90e77`).** When the scan is handed the ORIGINAL pre-enhance photo alongside the enhanced output, `_run_scan` branches into DIFFERENTIAL mode: each provider gets BOTH images (Gemini part-order, OpenAI dual `input_image`, Anthropic labeled image blocks) with a "what changed?" prompt (`SCAN_DIFFERENTIAL_PROMPT_BASE` + `_build_differential_prompt`). It flags UNINTENDED machine changes (`dimension_changed`, `part_added`/`part_removed`, `geometry_altered`, `text_changed`, `colour_changed`, `damage_added`) while an `intended_edits` whitelist (derived from the enhance toggles) marks deliberate edits (repaint, de-brand, remove-people) as expected. `ScanTaskPayload` carries `original_asset_id` / `original_gcs_uri` / `intended_edits`; `ScanBatchRequest` carries `original_asset_ids` (map) + `intended_edits` (schemas.py). The post-enhance auto-scan threads the original + toggle-derived intended edits (`_describe_intended_edits` in enhance_worker.py); the manual `/scan/batch` resolves an `original_asset_ids` map; standalone uploads (no original) fall back to the isolated CYA scan. Consensus / `gather` / fail-stub logic reused unchanged. **Known issue (parked):** the live differential scan OVER-FIRES vs the operator's actual bar — it flags intended fork/backrest repaint, 1-2 char model-# drift, and subtle geometry the operator doesn't care about. A prod recalibration (whitelist repaint/backrest, model-# only on *significant* change, drop subtle geometry) is the parked clean win. Also note: the differential anomaly COUNT does NOT predict the operator's holistic pass/fail — see Latest session.

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

## Per-image adjustments (the darkroom, what's left of it)

There is no Modify tab and no bulk adjustment panel. Each generated variant carries its own compact **contrast + saturation** controls; Apply renders that one image and swaps it into `completed`, which is what `pickedWinners` and therefore `ExportControls` read — so an applied adjustment persists through export with no extra plumbing.

- **The backend is unchanged and still shared.** `POST /api/v1/modify/batch` ([routers/modify.py](apps/api/src/cleanshot_api/routers/modify.py)) + `apply_adjustments()` in [image_processing.py](apps/api/src/cleanshot_api/services/image_processing.py). The per-image path calls it with a single asset id. `ModifyAdjustments` still carries `brightness`, `rotation_deg`, `crop_aspect`, `crop_zoom`; the per-image UI sends neutral values for those (`1.0` / `0` / `"free"` / `1.0`, all no-ops).
- **Slider math (`sliderToBC`, `sliderToSat`) is duplicated as comments in `apply_adjustments`** so the CSS-filter preview matches the pyvips render to the third decimal. Don't drift these.
- **`OperationEnum.modify`** needed `ALTER TYPE operation_enum ADD VALUE` in [migrate.py](apps/api/src/cleanshot_api/db/migrate.py) — see hard-won lesson #12.
- **Brightness, crop, and straighten are no longer reachable from the UI.** `ModifyPanel.tsx` is orphaned but retained (same dormant-code convention as the retired providers); the backend for all three still works. Restoring one is UI work, not backend work.

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

## CleanShot as an ingest target (media-auditor → df-auto-edit → here)

As of 13 Aug 2026 two sibling apps are being wired to send work in:
**media-auditor** (audits published listing photos, owns a separate Neon DB) and
**df-auto-edit** (crops them). An auditor selects flagged units, they get cropped,
and the crops arrive here for a paint pass.

**Nothing new is needed on this side.** The handoff uses the API-key surface that
already exists, and callers were pointed at it precisely so no new ingest endpoint
gets invented:

```text
POST /api/v1/upload/signed-url   -> signed GCS PUT   (X-Api-Key, require_api_key)
PUT  <signed url>                -> df-auto-edit sends the bytes directly
POST /api/v1/enhance             -> 202 + job id      (X-Api-Key)
GET  /api/v1/assets/{asset_id}/url -> signed GET      (X-Api-Key)
```

Things to know if this starts showing traffic:

- **Auth is `X-Api-Key` via `core/security.py`**, which already supports rotation
  (`api_key` + `api_key_prev`, constant-time compare). An HMAC scheme and Entra
  client-credentials were both considered for the cross-app call and rejected as
  duplicate machinery — these routes check a key, not a token.
- **`require_api_key` is a shared-secret gate with no notion of *which* caller
  it is.** If per-app attribution or revocation matters, that is a real gap —
  today a leaked key is a leaked key for every caller.
- **Batch sizes are capped on the auditor's side at 25 units (~250 images)**
  specifically because `openai_image_rate_limiter` is 5 events/60s and the
  limiters are **process-local** with `min-instances=1`. A larger batch is mostly
  queue. If external batches become routine, the Valkey-backed limiter noted in
  the Rate limiting section stops being optional.
- **Dispatch on the auditor's side is OFF by default** (`PAINT_DISPATCH_ENABLED`
  unset) because paint is real vendor spend. Do not assume traffic has started
  just because the queue exists.
- **Bytes arrive by pre-signed PUT, not a shared bucket.** This app is on GCS,
  df-auto-edit is on Vercel Blob, and there is no store both can reach — so
  `mint_read_url` / signed PUT is the integration surface, permanently.

---

## Approvals + Export flow

- **Export IS the save.** There is no Save Project button; clicking `7x5 EXPORT` saves the project and then exports, in that order. **`_require_saved_project` still 403s every export endpoint until `projects.saved_at` is set**, which is why the save has to run first and why Make + Model still gate the export button. The project metadata FORM is still there — only the button is gone.
- **The stored copy is the exported file.** `/export/pro/preview` writes the finished JPEG straight into `approved/{email}/{dir}/` and registers an `assets` row (`operation=export`) plus the approval-set rows. It no longer writes a working copy under `session/.../pro/` and copies it across afterwards — that produced two copies of every image, one clean and one exported. **One copy, one location.**
- **Originals go with it.** `original_asset_ids` on `ExportProRequest` carries the pre-enhance asset ids; they're server-side copied into the same directory as `original_*`, de-duplicated (several exported variants can share one source).
- **Only selected images are persisted.** Unselected variants never reach the export call.
- **Re-export is idempotent per (session, gcs_dir)** — it reuses the existing approval set and rebuilds its membership rather than stacking a duplicate entry in the Photo Library.
- **The frontend no longer calls `approveSet` on the export path.** That call copied the PRE-export bytes and is exactly the duplicate the above removes. `POST /api/approvals` still exists and is unchanged for other callers.
- **Export endpoints** (all in `routers/export.py`, FastAPI side fully built):
  - `/api/v1/export/fullsize` — signed GET URL for the full-size PNG (1-hour expiry).
  - `/api/v1/export/pro` — 1024×731 crop, JPEG ≤100 KB iterated quality. Single JPEG or ZIP for batches. Sets `X-Warning: target-size-unachievable` when the size target can't be met.
  - `/api/v1/export/pro/preview` — per-image signed URLs + size metadata (complements the binary download). **This is the path the UI actually uses** (`exportProPreviewStream`). Filenames are meta-derived: per-image `_build_pro_filename` (`Toyota_8FGU25_2019_01[_Provider].jpg`) and the ZIP `_build_zip_filename` (`Toyota_8FGU25_2019.zip`). Both the ZIP and per-image download links force their name via `mint_read_url(..., download_filename=...)` which sets `response-content-disposition` on the signed URL — required because the HTML `download` attribute is ignored for cross-origin (`storage.googleapis.com`) hrefs. Stream now also emits `zip_filename`. The legacy non-streaming `/api/v1/export/pro` endpoint still uses generic `{asset_id}_pro.jpg` / `cleanshot_pro_export.zip` names (not UI-wired).
  - `/api/v1/export/custom` — arbitrary dimensions, JPEG/PNG/WebP/BMP.
  - `/api/v1/export/zip` — streaming ZIP for batch downloads.
- **AI-disclaimer watermark — CURRENTLY AN OPTIONAL CHECKBOX, defaulting ON.** It was briefly made unconditional (2026-08-21) and then reverted **pending a final decision on how the watermark gets applied**, so expect this to move again. The flag (`ai_disclaimer: bool`) is back on `ExportProRequest`, but note it now defaults **`True`** on the wire and in `export_pro()`, unlike the original which defaulted `False` — a caller that omits it gets the disclaimer rather than silently dropping it. There is no tooltip claiming all exports are watermarked; that was removed with the revert. When `True`, pyvips burns the string `"*Disclaimer:  AI enhanced images - used for representational purposes"` into the bottom-right corner of every output JPEG. Rendered via Pango markup (`text(..., rgba=True)`) so the `*Disclaimer:` label is **green** (`#22c55e`) and the body white, with a black shadow at ~65% alpha + foreground at ~92% alpha for legibility on both light and dark backgrounds, **Roboto Bold 11 pt** (needs `fonts-roboto` in the Dockerfile — without it Pango silently falls back to Liberation), 12 px margin. Constant lives in two places that must stay in sync: `AI_DISCLAIMER_WATERMARK` (+ `AI_DISCLAIMER_LABEL` for the green-split point) in `apps/web/components/export/ExportControls.tsx` (UI preview) and `apps/api/src/cleanshot_api/services/image_processing.py` (pyvips render). Helper: `_apply_disclaimer_watermark()`.
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

**`STYLE_GUIDE.md` (repo root) is the canonical UI reference.** Rewritten for the **Discount Forklift house palette**. Conform to it for any new UI; extend it in-PR rather than inventing one-offs. Key rules baked in across the app:

- **`apps/web/styles/globals.css` is the SINGLE source of truth for colour.** 17 semantic tokens in Tailwind v4 `@theme` (`bg-panel`, `text-ink`, `border-line`, …). Never a raw hex, never a Tailwind palette family — the offending families are **deleted** (`--color-zinc-*: initial`, etc.), so `bg-zinc-900` generates no CSS and a stray legacy class is visibly unstyled instead of silently reintroducing a blue-grey.
- **Three hard constraints:** every grey is a true neutral (`r == g == b`) · no amber/orange/mustard anywhere · the only blue-dominant colours allowed are the **three** house purples `#914EA6` / `#743E85` / `#B786C6` (every hue-285° colour is blue-dominant, so a purple attention colour necessarily widened this from two to three).
- **Accents and meanings:** lime `#95EA00` = brand + "good" (complete/active/progress) · purple `#914EA6` (`cta`) = action/primary buttons · purple `#B786C6` (`attn`) = **attention + error** (text/borders/rules/status dots) · red = **destructive controls ONLY**, currently just the two ✕ remove buttons and Clear All. **Red is not a general accent** — it used to be the brand accent, so Approve/Download ZIP/Retry/Regenerate/Send-to-admin were all red despite being ordinary actions; those are purple now.
- **Button colour system (strict):** primary/proceed/approve = **purple** `border-cta bg-cta hover:bg-cta-dark text-white` · secondary/skip/utility = **neutral ghost** `bg-panel hover:bg-panel-hi` · destructive (only if it really destroys) = `bg-danger hover:bg-danger-dark text-white`. No full-width buttons (`inline-flex`, never `w-full`). Flat — no shadows.
- **Text-on-fill (easiest thing to get wrong):** text on filled lime/grey MUST be `text-header-bg` `#131313` (white is ~1.5:1) · white is correct on filled purple/red · attention *text* is `attn` `#B786C6` (5.35:1 page / 4.81:1 card), **never** a CTA purple as text (`#914EA6` = 2.84:1, `#743E85` = 2.05:1 — fill-only).
- **Elevation is three-level and intentional:** header/footer plates are DARKER than the page (`#131313` on `#242424`) while cards are LIGHTER (`#2C2C2C`). Don't "fix" it into a conventional ramp.
- **Selected/active state, one pattern everywhere:** raised surface + lime border (`bg-panel-hi border-accent`).
- **Links/CTAs:** bold **lime** (global base-layer rule in `globals.css`). Not purple (buttons only); the old `sky-400` and `#CE6FEC` are both blue-dominant and banned.
- **Fonts:** `font-display` Archivo Black (h1 + uppercase section headings) · Archivo body · IBM Plex Mono labels/metadata, via `next/font/google` in `app/layout.tsx`. **Never combine `font-display` with `font-bold`** — Archivo Black is single-weight and the browser fakes a smeared bold.
- **Auto-advance is GONE** — removed entirely, and so is Send-to-Scan. The per-card "Hold" on Enhance now means "exclude from export and from the per-image batch operations".
- **Tooltip accordions:** `TipBanner` is collapsible by default, driven by `apps/web/lib/useVisitCount.ts` — expanded visits 1-4, collapsed visit 5+ (localStorage `cleanshot_visit_count`). One callout per tab; `tone="info"` is neutral + lime icon, `tone="warn"` is purple (`attn`). The Enhance equipment-details callout is the exception: always defaults expanded.
- **Equipment selectors** render as toggle-cards (raised + lime border selected / dark + radio-dot unselected), grouped warehouse-forks vs aerial via `EQUIPMENT_GROUPS` in `lib/types.ts`.
- **Scrollbar gutter:** `html { scrollbar-gutter: stable }` reserves the gutter so cards don't jump when the scrollbar appears.
- **Enhance provider selection carries no identity hue** — a three-accent palette can't encode six model colours. Selection is structural (raised surface + lime border); the speed pill (lime "Fast" / purple "Slow") carries differentiation.
- **SCAN provider colours are a documented EXCEPTION.** `SCAN_PROVIDER_COLOR` in `lib/scan-helpers.ts` gives Gemini `#4A9EFF`, OpenAI `#22D3EE`, Anthropic `#FF8A3D`. Literal hexes, not `@theme` tokens, and applied as inline `style` so no restyle or library default can flatten them — a previous pass collapsed all three progress bars onto one neutral grey and the strip stopped telling you which vendor was still running. Two of the three are blue-dominant, which the constraint above otherwise restricts; accepted, because these are identity colours, not UI state. All three pass AA as text on bg/panel/well (lowest 5.07:1), so they're safe on labels and chips too. The bar keeps its hue when complete — done-ness is width + a separate lime ✓, not a hue swap. Same precedent as the Tweak button's literal `#0A84FF`.

**Vercel Flags SDK + PostHog** — `apps/web/flags.ts`. `identify()` resolves the operator from the Better Auth session (`getSessionEmail(await headers())`) so PostHog targets flags per-user by email. Example flag `myFlag`/`my-flag` is a template — rename to the real PostHog flag key. Adapter env vars come from `vercel env pull` (.env.local, gitignored); must also exist in Vercel Production.

**Per-user access control** — `apps/web/lib/access-control.ts`. `USER_RESTRICTIONS` config (keyed by lowercased SSO email) locks specific users to one model + Enhance-tab-only + toggles-off + custom-prompt-only + tracking. Currently: brian→grok, asia→gemini, aj→openai, stephen→kontext. **Inert until `AUTH_ENABLED=true`** (the workspace runs as `dev@local` otherwise, which isn't in the table). Enforcement is two-layer: UI gating in Workspace/EnhancePanel/MetaCard (cosmetic) + **authoritative server-side model-lock in the `/api/enhance` BFF route** (forces the locked model + strips toggles regardless of what the client sends). **Phase 2 — admin audit logging (prompt/result/model/email per restricted user, viewable + filterable in the admin panel) — is NOT built yet.** Plan in HANDOFF.md.

---

## Open work items (prioritised)

1. **Per-user access control — Phase 2 (admin audit logging).** Phase 1 (config + UI gating + server-side model lock) shipped 2026-05-28. Phase 2 NOT built: (a) `enhance_audit_log` table in `migrate_auth.py` (`id, timestamp, user_email, model_used, prompt_text, result_text`); (b) thread `user_email` through `/api/enhance` BFF → FastAPI `/api/v1/enhance` → `EnhanceTaskPayload` → `_run_enhance`, which writes the row on completion (result_text = output asset id + signed URL + status) for `tracking` users; (c) admin API `GET /api/admin/audit?user=` + BFF proxy; (d) "Audit" tab in `AdminDashboard.tsx`, filterable by user. Decision still open: full worker-side logging (captures result) vs cheaper BFF-only enqueue logging (no result). See HANDOFF.md.
2. **Per-model enhance prompts.** ⚠️ **2026-07-13 UPDATE:** investigated with the eval harness — prompt wording is NOT a reliable lever for the hard warehouse-electric types (Gemini model limit; see "Durable findings" above). Per-model *phrasing* may still help cross-model consistency on the easy types, but it's deprioritized behind the parked bets (best-of-N / model-routing / scan recalibration). Original note kept below. Single biggest quality lever left. Current `_build_enhance_prompt` is ~200 lines of declarative scene prose tuned for Gemini Nano Banana edit semantics, and it ships verbatim to every provider. Kontext especially is mismatched — BFL positions it for short imperative prompts (1–3 sentences) to preserve subject identity; long prose dilutes that. Reve has a 2560-char `edit_instruction` cap and explicitly auto-enhances the instruction internally, so it benefits from terse imperative prose too. Discussed plan: add `_build_kontext_prompt` first (Phase A, smallest win), then `_build_reve_prompt`, then `_build_openai_prompt` + eval harness (Phase B). Grok can share OpenAI's style.
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
13. **Judge spend is not logged to `usage_events`.** Needs `OperationEnum.judge` + an `ALTER TYPE` (lesson #12). There is also no rate limiter on the judge's Anthropic calls — it shares scan's `claude-sonnet-4-6` tier.
14. **Fork conditionals are experimental and off by default.** Whether they help is unmeasured. If they prove out, the next step is automatic detection via a pre-pass on the source photo (see the Enhance tab section for why the existing scan can't do it).
15. **The disclaimer watermark's final form is undecided.** It is an optional checkbox defaulting ON, pending a decision on how the watermark gets applied. Expect it to move.
16. **Two orphaned components retained deliberately:** `components/modify/ModifyPanel.tsx` and `components/enhance/CommandBar.tsx`. Neither is rendered; both are kept as dormant code rather than deleted.

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
