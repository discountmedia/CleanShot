# CleanShot

AI-powered forklift image processing platform. Upload raw forklift photos, enhance them with a prompt you write, see an automatic quality scan beside each result, adjust and retry per image, then export to marketplace specs — all on one tab.

> **Current-state note (updated 2026-08-21).** Some of the body below still describes older behaviour. The corrections that matter:
> - **Enhance providers: 3 live** — Gemini, OpenAI (gpt-5 + image tool) and **Grok, restored 2026-08-27** after being dormant since 2026-07-21. Grok is in the picker but **not ticked by default**. **BFL/Flux, Kontext and Reve were DELETED on 2026-08-27**, not parked — restoring one is a `git revert`, not a Literal edit. Ideogram is not a generator but is live for the per-variant Tweak and Inpaint tools. Any "4 providers" / "6 providers" text below is stale.
> - **Enhance is prompt-first:** the operator writes their own prompt (required), with an equipment-aware "Insert recommended prompt" starter and a **shared template library** the whole team contributes to and picks from. Toggles *augment* that prompt; they no longer build it.
> - **Only four toggles are visible** — rental-fleet branding removal, floor cleanup, remove people, shine tires. The rest are hidden, not deleted (`VISIBLE_TOGGLES` in `apps/web/lib/types.ts`).
> - **Scan is inline on Enhance.** Every generated image is scanned automatically and the verdict renders beside that image. Nothing navigates to the Scan tab.
> - **Tabs: `Enhance → Scan → Your Photo Library`.** Scan is now a **standalone** tool with its own uploader. There is no Resize or Modify tab, and no bulk adjustment panel.
> - **Export is the only save action.** It writes the finished files and their pre-enhance originals into the user's Photo Library. The Save Project button is gone.
> - **Enhanced images are standardised at 2800x2000 (7:5)** at the end of enhancement. Export writes that file out unchanged.
> - **Upload resolution is no longer capped.** File size is still compressed; the pixels are not downscaled.
> - **Photo-library storage is indefinite**, not 30 or 60 days (GCS lifecycle rule removed 2026-05-26).
> - Live bucket names are `cleanshot-originals-prod` / `cleanshot-derivatives-prod` (the `-493512` names below are illustrative).
>
> **`CLAUDE.md` is the canonical, continuously-updated project briefing — trust it over this README where they disagree.**

---

## Table of Contents

- [What It Does](#what-it-does)
- [Architecture Overview](#architecture-overview)
- [Repository Layout](#repository-layout)
- [Tech Stack](#tech-stack)
- [AI Models](#ai-models)
- [Prerequisites](#prerequisites)
- [Local Development](#local-development)
- [Environment Variables](#environment-variables)
- [Auth Setup (Microsoft SSO)](#auth-setup-microsoft-sso)
- [Database Setup](#database-setup)
- [GCS Bucket Setup](#gcs-bucket-setup)
- [Cloud Tasks Setup](#cloud-tasks-setup)
- [Deploying to Production](#deploying-to-production)
- [The Workflow](#the-workflow)
- [Image History & Storage](#image-history--storage)
- [Adding Authorized Users](#adding-authorized-users)
- [Troubleshooting](#troubleshooting)

---

## What It Does

The whole job happens on the **Enhance** tab:

1. **Write a prompt.** The operator's own words drive the result. "Insert recommended prompt" drops an equipment-aware starter to edit, and any prompt can be **saved to your profile under a title** and re-inserted later in one click. Four toggles (rental-branding removal, floor cleanup, remove people, shine tires) append emphasis on top.
2. **Generate.** Pick Gemini, OpenAI, or both; each runs as an independent variant per source image. A multi-provider batch is auto-judged by a Claude vision call and the winner pre-selected — manual override is one click.
3. **Read the scan inline.** Every generated image is scanned automatically against its original, and the verdict plus anomaly list renders on that image's card. Results arrive per image; one slow or failed scan never blocks the others.
4. **Fix per image.** Each result carries its own **Retry** (re-roll that one variant with the current prompt) and its own **contrast / saturation** adjustment, applied to that image only and persisted through export.
5. **Export.** `7x5 EXPORT` writes the finished 2800x2000 files — plus the pre-enhance originals — straight into your Photo Library. That is the save; there is no separate Save Project step. Only selected images are persisted.

Two side tools:

- **Scan tab** — the same three-provider consensus scan (Gemini Flash, GPT-5.4, Claude Sonnet/Opus) as a **standalone** tool with its own uploader, for images that didn't come from Enhance. Note that a standalone upload has no "before" to compare against, so it gets the isolated scan rather than the differential one.
- **Per-variant Tweak** — a text-instruction edit (Gemini) on any completed variant. A mask-drawing canvas also exists, now backed by Ideogram v3 inpaint (the BFL erase tool was removed 2026-08-27), but note that **no mask button currently renders** on the variant thumb — only Regenerate and Tweak do.

---

## Architecture Overview

```
Browser
  │
  ├── Next.js 16 (Vercel Pro)
  │     ├── proxy.ts         ← Auth gate (Better Auth + Microsoft SSO)
  │     ├── App Router        ← Enhance / Scan / Resize / Export / History tabs
  │     └── Route Handlers    ← BFF layer — never exposes FastAPI key to browser
  │
  └── FastAPI (Cloud Run Service)
        ├── /api/v1/*         ← REST API (sessions, jobs, assets, approvals, history)
        ├── /worker/*         ← Cloud Tasks HTTP targets (enhance, scan, cleanup)
        └── Lifespan          ← Gemini (Vertex AI ADC), OpenAI, Anthropic, Valkey, asyncpg

Cloud Infrastructure (GCP — cleanshot-493512, us-central1)
  ├── Cloud Run Service       ← FastAPI (min-instances=1, concurrency=80)
  ├── Cloud Run Worker Pools  ← Image worker, Video worker (Phase 4.5)
  ├── Cloud Tasks             ← cleanshot-image-gen (0.1 dps), cleanshot-image-scan (0.5 dps)
  ├── Cloud SQL Postgres 17   ← sessions, jobs, assets, scan_results, approvals, auth
  ├── Memorystore Valkey 9.0  ← job poll cache (3s TTL), batch tracking
  └── GCS (2 buckets)
        ├── cleanshot-originals-493512    ← uploads, versioned, indefinite retention
        └── cleanshot-derivatives-493512  ← enhanced/scanned/approved, lifecycle rules
              └── approved/{email}/{YYYY-MM-DD}_{make}_{model}/   ← 30-day lifecycle
```

**Key design decisions:**

- The browser never touches FastAPI directly. All calls go through Next.js Route Handlers (BFF layer), which inject `FASTAPI_INTERNAL_KEY` server-side.
- The API pod never receives image bytes. Browsers upload directly to GCS via V4 signed PUT URLs. Workers read from GCS URIs.
- AI work is fully async. API endpoints enqueue Cloud Tasks and return a job ID immediately. Frontend polls at adaptive intervals (3s/10s/15s).
- Three-layer IPM throttle: Cloud Tasks dispatch rate + Cloud Run max-instances + asyncio.Semaphore(2) per instance.

---

## Repository Layout

```
cleanshot/
├── apps/
│   ├── api/                          # FastAPI backend (Cloud Run Service)
│   │   ├── src/cleanshot_api/
│   │   │   ├── core/                 # Config, security, Cloud Tasks auth
│   │   │   ├── db/                   # asyncpg pool, migrations, queries
│   │   │   ├── models/               # Pydantic v2 schemas
│   │   │   ├── routers/              # sessions, jobs, operations, upload,
│   │   │   │                         #   projects, export, approvals, scan_results
│   │   │   ├── services/             # GCS signed URLs, Cloud Tasks enqueue, pyvips
│   │   │   └── workers/              # enhance, scan (multi-model), cleanup
│   │   ├── Dockerfile
│   │   ├── pyproject.toml
│   │   └── docker-compose.dev.yml    # Postgres 17 + Valkey 9 for local dev
│   │
│   └── web/                          # Next.js 16 frontend (Vercel)
│       ├── app/
│       │   ├── api/                  # Route Handlers (BFF layer)
│       │   │   ├── auth/[...all]/    # Better Auth catch-all
│       │   │   ├── approvals/        # POST — save approved set to GCS
│       │   │   ├── history/          # GET  — 30-day approval history
│       │   │   ├── enhance/          # POST — enqueue enhance job
│       │   │   ├── enhance/regen/    # POST — single-image regen from Scan tab
│       │   │   ├── scan/batch/       # POST — enqueue scan batch
│       │   │   ├── scan/results/     # GET  — per-provider scan results
│       │   │   ├── jobs/[id]/        # GET  — poll job status
│       │   │   ├── sessions/[id]/    # GET  — full session state
│       │   │   ├── upload/signed-url/# POST — mint GCS signed PUT URL
│       │   │   ├── assets/[id]/url/  # GET  — mint GCS signed GET URL
│       │   │   └── export/           # fullsize, pro, custom, zip
│       │   ├── login/                # Microsoft SSO page
│       │   ├── unauthorized/         # Domain/email gate failure page
│       │   ├── history/              # 30-day image history
│       │   └── session/[sessionId]/  # Main workspace
│       ├── components/
│       │   ├── auth/                 # LoginButton, UserMenu
│       │   ├── enhance/              # EnhancePanel, toggles, thumbnails
│       │   ├── scan/                 # ScanPanel, ApproveAllButton, per-provider cards
│       │   ├── resize/               # ResizePanel
│       │   └── history/              # HistoryList, ApprovalSetCard
│       ├── lib/
│       │   ├── auth.ts               # Better Auth server config
│       │   ├── auth-client.ts        # Better Auth client instance
│       │   ├── api.ts                # Typed BFF fetch wrappers
│       │   ├── compress.ts           # Client-side compression (>4.5 MB)
│       │   ├── polling.ts            # useJobPoller adaptive hook
│       │   └── types.ts              # Shared TypeScript types
│       ├── proxy.ts                  # Next.js 16 auth gate (was middleware.ts)
│       └── package.json
│
├── packages/
│   └── types/                        # Shared TS interfaces (OpenAPI-generated)
│
├── infra/
│   └── terraform/                    # GCP resources
│
├── .github/workflows/
│   ├── deploy-api.yml                # WIF → Docker build → Cloud Run deploy
│   ├── deploy-worker-image.yml
│   └── ci.yml
│
├── ENTRA_SETUP.md                    # Step-by-step Microsoft App Registration
├── pnpm-workspace.yaml
└── README.md
```

---

## Tech Stack

| Layer | Technology | Version |
|---|---|---|
| Frontend framework | Next.js | 16.2.6 |
| UI runtime | React | 19.2.6 |
| Styling | Tailwind CSS | 4.3.0 |
| Language (frontend) | TypeScript | 6.0.3 |
| Auth | Better Auth | 1.6.11 |
| Identity provider | Microsoft OAuth (Entra ID) | — |
| Frontend hosting | Vercel Pro | — |
| Backend framework | FastAPI | 0.136.1 |
| Backend language | Python | 3.12 |
| Backend hosting | Cloud Run (gen2) | — |
| Database | Cloud SQL Postgres 17 | — |
| Cache | Memorystore Valkey 9.0 | — |
| Job queue | Cloud Tasks HTTP Target | — |
| Image storage | Google Cloud Storage | — |
| Image processing | pyvips / libvips | ≥8.18 |
| Package manager | pnpm | 9.x |
| Node.js | LTS | 22.11.0 |
| CI/CD auth | Workload Identity Federation | — |

---

## AI Models

The Enhance tab offers **4 generation providers** (operator picks any subset per image) plus a **per-variant Erase tool** (mask-drawing canvas for surgical object removal). Scan uses up to 3 vision models with consensus voting.

| Operation | Model | Provider / Endpoint | Notes |
|---|---|---|---|
| Enhance | `gemini-3.1-flash-image-preview` | Google AI Studio (`x-goog-api-key`) | Preview models live on AI Studio, not Vertex |
| Enhance | `gpt-5` + `image_generation` tool | OpenAI Responses API | gpt-5 reads input + dispatches the image tool (forced via `tool_choice`) |
| Enhance | `grok-imagine-image-quality` | xAI `/v1/images/edits` | OpenAI-compatible image-edit API |
| Erase / Inpaint tool | `ideogram-3.0` | Ideogram `/v1/ideogram-v3/inpaint` (sync) | Mask-based object removal. Mask is inverted server-side: the client sends WHITE=erase, Ideogram wants BLACK=edit |
| Cleanup / Regen | `gemini-3.1-flash-image-preview` | Google AI Studio | Same model as enhance |
| Scan — primary | `gemini-2.5-flash` | Vertex AI (ADC) | Always active |
| Scan — optional | `gpt-5.4` | OpenAI Responses API | Enable: `SCAN_PROVIDER_OPENAI=true` |
| Scan — optional | `claude-opus-5` | Anthropic Messages API | Enable: `SCAN_PROVIDER_ANTHROPIC=true` |
| Scan — hard cases | `claude-opus-5` | Anthropic | Same model since 2026-08-27; the std/hard split is a no-op at the model level |
| Variant judge | `claude-opus-5` | Anthropic | Auto-pick "best of N". **Uncalibrated** — the ~70% agreement figure was measured on the old model |
| Prompt optimizer | `claude-opus-5` | Anthropic | Condenses a long enhance prompt; gated by the same `SCAN_PROVIDER_ANTHROPIC` flag |

**Why two Gemini clients?** Scan uses the Vertex backend (`app.state.genai` — IAM auth, can read GCS URIs directly). Enhance + Cleanup use the AI Studio backend (`app.state.genai_aistudio` — static API key, image input must be inlined via `Part.from_bytes`). Preview image-gen models like `gemini-3.1-flash-image-preview` ship to AI Studio first; the dual-client setup is the workaround.

**Critical API format differences** (do not mix up — each provider requires a different image input format):

- **Gemini (Vertex, scan):** `Part.from_uri("gs://...")` directly — no base64 transfer.
- **Gemini (AI Studio, enhance):** `Part.from_bytes(image_bytes, mime_type=...)` after a GCS download — Studio backend can't read GCS URIs.
- **OpenAI (enhance):** `responses.create` with `tools=[{"type":"image_generation"}]` + `tool_choice={"type":"image_generation"}`. Result PNG is base64 on the `image_generation_call` output item.
- **OpenAI (scan):** `responses.parse(..., text_format=ScanResult)` — let the SDK do the strict-mode JSON schema conversion (Pydantic's `model_json_schema()` is missing `additionalProperties: false` and gets rejected).
- **Anthropic (scan):** Raw base64 **without** any prefix, structured output via the tool-call pattern (`tools=[{name, input_schema}]` + `tool_choice={"type":"tool", "name":...}`). No `output_config` parameter — it 400s.
- **Ideogram (Inpaint tool):** multipart POST, sync, returns `data[0].url` (fetch it without an auth header). A prompt is **mandatory** — Ideogram 422s without one, so a blank fill-hint falls back to "fill with plausible background". Mask must match source dimensions exactly: the backend runs the source through `pyvips.autorot()` then resizes the mask with **nearest-neighbour** — a mask is drawn against the *displayed* image, so an EXIF rotation would otherwise land the edit in the wrong place, and any smoothing kernel would produce grey pixels in what must stay a binary mask.

---

## Prerequisites

- Node.js 22.11.0+ and pnpm 9.x
- Python 3.12+
- Docker (for local backend)
- GCP project with billing enabled (`cleanshot-493512`)
- `gcloud` CLI authenticated
- A Microsoft account (for SSO setup — see [Auth Setup](#auth-setup-microsoft-sso))

---

## Local Development

### 1. Clone and install

```bash
git clone https://github.com/discountmedia/CleanShot
cd CleanShot
pnpm install
```

### 2. Start local services (Postgres 17 + Valkey 9)

```bash
cd apps/api
docker compose -f docker-compose.dev.yml up -d
```

### 3. Configure environment

```bash
# Frontend
cp apps/web/.env.example apps/web/.env.local

# Backend
cp apps/api/.env.example apps/api/.env
```

Edit both files. Minimum required for local dev:

```bash
# apps/api/.env
DATABASE_URL=postgresql://cleanshot:password@localhost:5432/cleanshot
GCS_BUCKET_ORIGINALS=cleanshot-originals-493512
GCS_BUCKET_DERIVATIVES=cleanshot-derivatives-493512
TASKS_OIDC_SA=cleanshot-tasks@cleanshot-493512.iam.gserviceaccount.com
WORKER_URL=http://localhost:8080
API_KEY=local-dev-key
ENVIRONMENT=local

# apps/web/.env.local
FASTAPI_INTERNAL_URL=http://localhost:8080
FASTAPI_INTERNAL_KEY=local-dev-key
AUTH_ENABLED=false   # Bypasses all auth — app works without Microsoft credentials
```

### 4. Start the backend

```bash
cd apps/api
pip install uv
uv pip install --system .
uvicorn cleanshot_api.main:app --reload --port 8080
```

Schema migrations run automatically on first startup when `ENVIRONMENT=local`.

### 5. Start the frontend

```bash
cd apps/web
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000).

With `AUTH_ENABLED=false`, you land directly in the workspace — no login required.

---

## Environment Variables

### Frontend (`apps/web` / Vercel)

| Variable | Required | Description |
|---|---|---|
| `FASTAPI_INTERNAL_URL` | Yes | Cloud Run service URL |
| `FASTAPI_INTERNAL_KEY` | Yes | Internal API key (server-only — never in browser) |
| `AUTH_ENABLED` | Yes | `"false"` = bypass auth; `"true"` = Microsoft SSO enforced |
| `BETTER_AUTH_SECRET` | When auth enabled | Generate: `openssl rand -hex 32` |
| `MICROSOFT_CLIENT_ID` | When auth enabled | From Entra App Registration |
| `MICROSOFT_CLIENT_SECRET` | When auth enabled | From Entra App Registration |
| `MICROSOFT_TENANT_ID` | When auth enabled | `"common"` for any MS account |
| `ALLOWED_DOMAINS` | When auth enabled | Comma-separated domains, e.g. `acme.com,partner.org` |
| `ALLOWED_EMAILS` | When auth enabled | Comma-separated individual emails |
| `DATABASE_URL` | Yes | Postgres 17 connection string |

**Setting `ALLOWED_DOMAINS` and `ALLOWED_EMAILS` in Vercel:**

Go to your Vercel project → Settings → Environment Variables. Add them as plain text — no quotes needed. Set per-environment values if your staging and production allowlists differ.

```
ALLOWED_DOMAINS    acme.com,partner.org
ALLOWED_EMAILS     contractor@outlook.com,freelancer@gmail.com
```

Changes take effect on the next deployment. For immediate effect without a deploy, use the Postgres `authorization` table (see [Adding Authorized Users](#adding-authorized-users)).

### Backend (`apps/api` / Cloud Run `--set-secrets`)

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | Cloud SQL Postgres 17 connection string |
| `GCS_BUCKET_ORIGINALS` | Yes | GCS bucket for uploaded originals |
| `GCS_BUCKET_DERIVATIVES` | Yes | GCS bucket for processed images + approved sets |
| `VALKEY_URL` | Yes | Memorystore Valkey private IP URL |
| `TASKS_OIDC_SA` | Yes | Service account email for Cloud Tasks OIDC |
| `WORKER_URL` | Yes | Cloud Run service URL (used as OIDC audience) |
| `API_KEY` | Yes | Internal key checked by `X-Api-Key` header |
| `API_KEY_PREV` | No | Previous key — kept during rotation window |
| `OPENAI_API_KEY` | Yes | Powers both enhance (gpt-5 + image_generation tool) AND scan (gpt-5.4). Both share the same `/v1/responses` quota — bump tier if you see 429s. |
| `ANTHROPIC_API_KEY` | When scan enabled | Only needed if `SCAN_PROVIDER_ANTHROPIC=true` |
| `GEMINI_API_KEY` | Yes | Google AI Studio key for enhance/cleanup (`gemini-3.1-flash-image-preview`). Scan uses Vertex IAM (no key) on a separate client. |
| `XAI_API_KEY` | Yes | xAI Grok image-edit (`grok-imagine-image-quality`). Live again as of 2026-08-27. |
| `IDEOGRAM_API_KEY` | Yes | Ideogram 3.0 — per-variant Tweak (`/v1/edit`) and the mask-based Inpaint tool (`/v1/ideogram-v3/inpaint`). The only mask-based backend left. |
| `SCAN_PROVIDER_OPENAI` | No | `"true"` to activate GPT-5.4 scan |
| `SCAN_PROVIDER_ANTHROPIC` | No | `"true"` to activate Claude scan |
| `GCP_PROJECT` | No | Defaults to `cleanshot-493512` |
| `ENVIRONMENT` | No | `"local"` runs auto-migrations on startup |

**Removed 2026-08-27:** `BFL_API_KEY`, `REVE_API_KEY` and `RUNCOMFY_API_KEY` are no longer mounted, and `KONTEXT_SEED` is gone. `cleanshot-bfl-key`, `cleanshot-reve-key` and `cleanshot-runcomfy-key` are deletable from Secret Manager once that deploy lands.

> An earlier note here claimed Reve was retired on 2026-05-20. That was **false** — Reve was reinstated on 2026-05-26 and was still mounted and still read by `config.py` right up until 2026-08-27. Don't trust a removal note without checking `deploy-api.yml` itself.

---

## Auth Setup (Microsoft SSO)

See `ENTRA_SETUP.md` for the complete step-by-step guide. The short version:

1. Register an app in [entra.microsoft.com](https://entra.microsoft.com) → Identity → Applications → App registrations
2. Set redirect URI: `https://your-domain.com/api/auth/callback/microsoft`
3. Copy Client ID, Client Secret, Tenant ID into Vercel env vars
4. Set `AUTH_ENABLED=true` in Vercel
5. Set `ALLOWED_DOMAINS` to your company domain(s)

**Auth flow:**

```
User visits CleanShot
    │
    ├── AUTH_ENABLED=false → app loads directly (dev/testing mode)
    │
    └── AUTH_ENABLED=true
          │
          ├── Has session cookie? → yes → App loads
          │
          └── no → /login
                     │
                     └── "Sign in with Microsoft" → Microsoft OAuth
                                                       │
                                                  checkAuthorization(email)
                                                  1. ALLOWED_DOMAINS env var
                                                  2. ALLOWED_EMAILS env var
                                                  3. Postgres authorization table
                                                       │
                                              pass → session cookie set → App loads
                                              fail → /unauthorized
```

---

## Database Setup

CleanShot uses Cloud SQL Postgres 17. The schema is split into two migrations:

**Core schema** (`apps/api/src/cleanshot_api/db/migrate.py`) — runs automatically when `ENVIRONMENT=local`:

- `sessions`, `projects`, `assets`, `jobs`, `scan_results`, `consensus_results`
- `user_profiles` — per-user editable details + avatar
- `saved_prompts` — **shared** reusable enhance prompts, visible to every signed-in user. `user_email` is the CREATOR, not an access scope. Unique on `lower(title)` alone — titles are one company-wide namespace and a duplicate is refused by the database rather than by a pre-check. Title and body are **immutable after insert**; `use_count` is the only column that changes
- `saved_prompt_votes` — one upvote per user per template, `PRIMARY KEY (prompt_id, user_email)`. The composite key is what enforces one-vote-per-user; deleting a template cascades its votes away

Prompt bodies are capped at 32,000 characters. The cap exists only because `GET /prompts` returns every template's full body — the client sorts and inserts locally — so the list payload scales with library size. It is not a model or database limit; `custom_prompt` on the enhance path has no cap at all.

**Auth + approval schema** (`apps/api/src/cleanshot_api/db/migrate_auth.py`):

- `authorization` — domain/email allowlist for runtime additions
- `approval_sets` — one row per exported set. `expires_at` is nullable and NULL means stored indefinitely; only legacy rows carry an expiry
- `approval_set_assets` — images in each approval set

**Better Auth tables** — run once via CLI:

```bash
cd apps/web
pnpm dlx @better-auth/cli migrate
```

This creates `user`, `session`, `account`, `verification` tables.

**Production migration order:**

```bash
# 1. Apply core schema
psql $DATABASE_URL -c "\i apps/api/src/cleanshot_api/db/migrate.py"
# (or trigger via API startup with ENVIRONMENT=local on first boot)

# 2. Apply auth/approval schema
psql $DATABASE_URL < apps/api/src/cleanshot_api/db/migrate_auth.sql

# 3. Apply Better Auth schema
cd apps/web && pnpm dlx @better-auth/cli migrate

# 4. Enable pgcrypto (if not already enabled)
psql $DATABASE_URL -c "CREATE EXTENSION IF NOT EXISTS pgcrypto;"
```

> **Vercel note:** You do not need to enable any Postgres extension in Vercel. Vercel holds the `DATABASE_URL` connection string as an environment variable pointing at your GCP Cloud SQL instance. All schema setup happens on the Cloud SQL side.

---

## GCS Bucket Setup

Two buckets in `us-central1`:

```bash
# Originals — versioned, indefinite retention
gcloud storage buckets create gs://cleanshot-originals-493512 \
  --location=us-central1 \
  --uniform-bucket-level-access

gcloud storage buckets update gs://cleanshot-originals-493512 \
  --versioning

# Derivatives — unversioned, lifecycle rules
gcloud storage buckets create gs://cleanshot-derivatives-493512 \
  --location=us-central1 \
  --uniform-bucket-level-access

# Disable soft-delete on derivatives (it's ON by default — silent billing risk)
gcloud storage buckets update gs://cleanshot-derivatives-493512 \
  --no-soft-delete

# No GCS lifecycle rules — photo library is stored indefinitely
# (operator decision 2026-05-26). If an old lifecycle rule was
# previously applied, clear it:
gcloud storage buckets update gs://cleanshot-derivatives-493512 \
  --clear-lifecycle
```

---

## Cloud Tasks Setup

```bash
# Image generation / enhance / cleanup queue
gcloud tasks queues create cleanshot-image-gen \
  --location=us-central1 \
  --max-dispatches-per-second=0.1 \
  --max-concurrent-dispatches=10 \
  --max-attempts=3 \
  --min-backoff=10s \
  --max-backoff=300s

# Scan queue (faster dispatch — scan is cheaper per call)
gcloud tasks queues create cleanshot-image-scan \
  --location=us-central1 \
  --max-dispatches-per-second=0.5 \
  --max-concurrent-dispatches=5 \
  --max-attempts=3 \
  --min-backoff=10s \
  --max-backoff=300s
```

---

## Deploying to Production

Deployment is fully automated via GitHub Actions with Workload Identity Federation — no JSON service account keys exist anywhere.

**First-time setup:**

1. Configure WIF pool and provider (see `infra/terraform/`)
2. Set `GCP_PROJECT_NUMBER` in GitHub repository secrets
3. Push to `main` — GitHub Actions handles the rest

**Deploy triggers:**

- `apps/api/**` changed → `deploy-api.yml` → builds Docker image, pushes to Artifact Registry, deploys to Cloud Run
- `apps/web/**` changed → Vercel native GitHub integration deploys automatically

**Rollback:**

```bash
# Backend — Cloud Run revision traffic
gcloud run services update-traffic cleanshot-api \
  --to-revisions=PREVIOUS_REVISION=100 \
  --region=us-central1

# Frontend — Vercel dashboard → Deployments → Promote previous deployment
```

---

## The Workflow

### Enhance tab

1. Drop images into the upload zone (drag-and-drop or file picker). Files over 4.5 MB are auto-compressed client-side (Vercel limit). Uploads cap at 1024 px long edge.
2. Pick the equipment type (10 types, from forklift to turret truck) and fill in Make + optional metadata (Model, Year, Tire Type, Capacity, Fuel Type). Make is required; the rest pre-fills the export form.
3. **Write the prompt** — required. The starter asks for a respray **in the same colour the unit already wears**, never an "original factory colour" (that phrasing makes the model correct a faded or repainted unit toward a remembered brand colour). Use **Insert recommended prompt** for an equipment-aware starter, or pick a **shared template** from the picker — the team's library, sortable by Newest, Top rated, or Most used, each entry showing who wrote it and when. `SAVE PROMPT TO SHARED TEMPLATES` publishes the current text under a title you choose, visible to everyone immediately.
   - **Titles are global and permanent.** A collision means the title is taken for good; there is no rename and no overwrite, because a template's upvotes and use count are ratings of a *specific* text. To customise one: load it, edit the box, save under a new title. The original is untouched.
   - **Loading a template gives you a copy** — editing the prompt box never writes back to the shared row.
   - **▲ upvote** what works: one vote per person, reversible. *Top rated* counts endorsements; *Most used* counts loads. They are different signals.
   - **Only an admin can delete** a template, since deleting removes it for everybody.
> **Writing prompts:** see [PROMPT-HYSTER.md](PROMPT-HYSTER.md) for a worked, CleanShot-tuned example and — more importantly — the three rules governing how a typed prompt and the toggles combine. They are not intuitive: a custom prompt *skips* the built-in prompt blocks while toggle fragments still append **after** it and therefore outrank it. (The old 1,500-character scanner cap is gone as of 2026-08-27 — the whole prompt is passed now, so length is a quality question, not a coverage one — and decal preservation became a guardrail on the same date.) [TEMPLATES-HOWTO.md](TEMPLATES-HOWTO.md) covers the shared template library.

4. Optionally set the five visible toggles. They *append emphasis* to your prompt; they don't replace it — with one exception:
   - **Remove Background Entirely** is not a prompt at all. It runs a matting pass over the finished image and cuts the unit out with a real alpha channel, for the new-equipment site that shows units on no backdrop. Those images **export as transparent PNG with no disclaimer watermark**, since they go into a product-page composite. It overrides Perfect Showroom Floor.
5. **Pick one or more providers** (Gemini, OpenAI). Each runs as an independent variant per source image.
6. Click **Enhance**. Images upload to GCS, jobs enqueue per provider, and one `SourceCompareCard` renders per source image with its variants side by side. Re-running an unchanged batch is allowed — generation is non-deterministic and a second roll is often the point.
7. **Each completed variant carries its own controls**: **Retry** (re-roll this one image with the current prompt and toggles, replacing it in place), **Tweak** (text-instruction edit via Gemini), and a compact **contrast / saturation** section whose Apply re-renders that image and carries through to export.
8. **The scan appears inline** under each variant as it lands — a consensus verdict with the per-provider breakdown and anomaly list. Nothing navigates away.
9. **Export.** Fill Make + Model, then `7x5 EXPORT`.

### Fork conditionals (experimental, off by default)

Conditional fork instructions inside the prompt don't hold when the fork isn't fully in frame: with the upright section out of shot the model paints part of the carriage or overhead guard into a shank, and with the tips cropped it shortens the forks to bring tips into view so it has something to paint yellow.

The **Fork conditionals** switch sits directly above the Enhance button and is **off by default**, session-only, and never enabled as a side effect of anything else. Turning it on reveals two per-image controls — *vertical fork section not visible* and *fork tips not visible*. These **remove** the offending prompt fragment (and, for tips, substitute a red-only instruction) rather than piling on more instructions, because emphatic "do not draw X" phrasing backfires on Gemini.

Turning the switch off restores the previous prompt exactly, with no residual effect, and takes effect on the next run — images already generated are untouched. If you've rewritten the prompt yourself there's no fragment of ours left to remove, so the constraint is appended as an explicit instruction instead and the UI says so.

### Erase tool (per-variant)

Opens a full-screen mask-drawing modal. Paint over the area to remove with the brush (adjustable size), type a hint for what should fill the cleaned area, and submit. Routes through Ideogram v3 inpaint. On accept, the cleaned image replaces the variant in-place.

> Two caveats. Ideogram **requires** a prompt, so leaving the hint blank sends "fill with plausible background" rather than nothing. And as of 2026-08-27 **no button on the variant thumb opens this dialog** — the component and its whole backend are wired, but `VariantThumb` renders only Regenerate and Tweak. Restoring it is re-adding one button, not re-wiring a backend.

### Scan tab (standalone)

Decoupled from the Enhance pipeline. Nothing on Enhance sends images here.

1. Upload images with the tab's own uploader.
2. Each image shows results from up to three AI providers with verdict chips, per-provider progress bars in that provider's own colour, and anomaly lists. Per-provider failures are isolated and surfaced as "provider — failed" instead of hanging on "pending".
3. Failed images show a **Regenerate** button with an auto-generated prompt built from the detected anomalies — edit it or use it as-is, and pick which provider runs the regen.

Because a standalone upload has no pre-enhance original to compare against, it gets the **isolated** scan. The **differential** (before/after) scan still runs — inline on the Enhance tab, where the original is known.

### Export

1. **2800x2000, exactly.** Every enhanced image is brought to that size once, at the end of enhancement; export writes it out without resizing, resampling, or re-cropping. Single image, batch, and ZIP all produce the same dimensions, and the copies saved to your project are those same files.
2. **Crop to fill, never pad or stretch.** A source that isn't 7:5 is scaled to cover 2800x2000 and the overflow is cropped from the centre. Stretching would distort the machine and make the photo inaccurate, so it never happens; a portrait source loses roughly 30% of its height.
3. Exported images are **upscaled**, so they must go through the image optimizer in PRO after upload — the button says so.
4. An optional **AI disclaimer watermark** checkbox, **on by default**. This was briefly mandatory and is back to a checkbox pending a final decision on how the watermark gets applied; the rendering code is unchanged either way.
5. Clicking export saves the project, writes the finished files and their originals to your Photo Library, and gives you per-image downloads plus a ZIP.

---

## Image History & Storage

Exporting is what writes to the library. The stored copy **is the exported file** — cropped, upscaled, and watermarked if the disclaimer box was ticked — alongside the pre-enhance originals, one copy of each, in one place. Unselected variants are never persisted. Re-exporting the same session updates that set rather than stacking a duplicate.

Files land under:

```
gs://cleanshot-derivatives-493512/approved/{email}/{YYYY-MM-DD}_{make}_{model}/{filename}
```

Examples:
```
approved/john_acme_com/2026-05-14_toyota_8fgu25/forklift_01.jpg
approved/john_acme_com/2026-05-14_toyota_8fgu25/forklift_02.jpg
approved/sarah_partner_org/2026-05-15_hyster_h50ft/unit_front.jpg
```

Images are stored for **30 days** then deleted automatically via a GCS lifecycle rule. The `/history` page shows all sets from the last 30 days with thumbnails, download links, and days-remaining indicators (yellow warning at ≤5 days).

Each user only sees their own history — the backend filters by authenticated email.

---

## Adding Authorized Users

Three ways to add users, in order of speed:

**1. Vercel env vars (requires redeploy — ~2 minutes)**

Update `ALLOWED_DOMAINS` or `ALLOWED_EMAILS` in Vercel project settings and trigger a redeploy.

**2. Postgres `authorization` table (instant — no redeploy)**

```sql
-- Add a whole domain
INSERT INTO authorizations (type, value, note)
VALUES ('domain', 'newclient.com', 'Added 2026-05-14 by admin');

-- Add a specific personal email (e.g. freelancer with @gmail.com)
INSERT INTO authorizations (type, value, note)
VALUES ('email', 'photographer@gmail.com', 'Freelance contractor');

-- Remove access
DELETE FROM authorizations WHERE value = 'expartner.com';

-- View current allowlist
SELECT type, value, note, created_at FROM authorizations ORDER BY created_at DESC;
```

**3. Rotate out a user**

Revoking a domain/email takes effect on the next sign-in attempt. Existing sessions remain valid until they expire (7 days). To force immediate logout, delete the user's row from the Better Auth `session` table.

---

## Troubleshooting

**App redirects to /login even with AUTH_ENABLED=false**

Check that `AUTH_ENABLED` is set to the string `"false"`, not a boolean. Environment variables are always strings. Verify in Vercel dashboard → Settings → Environment Variables.

**"Compression failed" on upload**

The browser needs a `<canvas>` element to compress images. This fails in some headless environments. In normal browsers it should never occur — if it does, reduce the source image before uploading.

**Enhance job stuck at "queued" for more than 2 minutes**

Cloud Tasks dispatches enhance jobs at the rate configured on the `cleanshot-image-gen` queue's `max-dispatches-per-second` setting. A batch of 10 images at 0.1 dps takes ~100s to fully dispatch; at 1.0 dps it's ~10s. Check the current queue rate with `gcloud tasks queues describe cleanshot-image-gen --location=us-central1` and raise it with `gcloud tasks queues update ... --max-dispatches-per-second=N` if batches feel slow. The QueueStatusBar shows estimated time remaining. If a job is stuck for more than 10 minutes, check Cloud Run logs for quota errors (429s) from the active image-gen provider.

**Scan shows no results after job completes**

The scan results endpoint (`GET /api/scan/results/:jobId`) is called after the poll returns `status=complete`. If it returns empty, check that `scan_results` rows were written — the scan worker may have failed after the quick-acknowledge HTTP 200. Check Cloud Run worker logs for the specific job ID.

**Microsoft sign-in succeeds but lands on /unauthorized**

Your email or domain is not in the allowlist. Add it via the Postgres `authorization` table (instant) or update `ALLOWED_DOMAINS`/`ALLOWED_EMAILS` in Vercel env vars (requires redeploy). See [Adding Authorized Users](#adding-authorized-users).

**GCS signed URLs return 403**

The Cloud Run service account (`forklift-api@cleanshot-493512.iam.gserviceaccount.com`) needs `roles/iam.serviceAccountTokenCreator` on itself to sign URLs. Grant it:

```bash
gcloud iam service-accounts add-iam-policy-binding \
  forklift-api@cleanshot-493512.iam.gserviceaccount.com \
  --member="serviceAccount:forklift-api@cleanshot-493512.iam.gserviceaccount.com" \
  --role="roles/iam.serviceAccountTokenCreator"
```

**pyvips ImportError in Cloud Run**

`libvips` must be installed as a system library in the Docker image. The Dockerfile installs `libvips42 libvips-dev librsvg2-common fontconfig`. Do not use Alpine base images — fontconfig and librsvg have known issues on Alpine that cause SVG rasterization failures.

---

## Cost Reference (5–10 internal users)

CleanShot is sized for a small in-house team — Discount Forklift's listing operators, not a public SaaS. The three scenarios below assume roughly 5 forklifts per user per workday with 4–6 photos per unit, which is the actual cadence Discount Forklift's listing flow produces.

**Per-call rates that drive `usage_events.cost_estimate_usd`** (placeholders in [services/pricing.py](apps/api/src/cleanshot_api/services/pricing.py); refine from real invoices):

| Model | Type | Rate |
|---|---|---|
| `gemini-3.1-flash-image-preview` (enhance, default) | per image | $0.039 |
| `gpt-5` + image_generation tool (enhance) | per image | $0.080 |
| `grok-imagine-image-quality` (enhance) | per image | $0.070 |
| `gemini-2.5-flash` (scan, primary) | per token | $0.075 in / $0.30 out per M |
| `gpt-5.4` (scan, optional) | per token | $5.00 in / $15.00 out per M |
| `claude-opus-5` (scan, judge, prompt optimizer) | per token | $5.00 in / $25.00 out per M |

**Fixed monthly infrastructure floor** (incurred regardless of usage — this is the bigger lever at small user counts):

| Line item | Monthly |
|---|---|
| Cloud Run API + Worker (min-instances=2) | ~$33 |
| Memorystore Valkey 1 GiB | ~$36 |
| Cloud SQL Postgres 17 (db-f1-micro) | ~$25 |
| GCS storage + egress (modest volume) | ~$15 |
| Vercel Pro | ~$40 |
| **Infra floor** | **~$150** |

### Scenario A — Light usage (5 users, ~500 images/month)

5 users × ~5 forklifts/workday × 5 photos × ~20 workdays = ~2,500 source images/month, of which ~500 actually run through the enhance pipeline (most photos don't need touch-up; the rest are pass-through to Resize).

| Line item | Monthly |
|---|---|
| Enhance (~1.5 providers picked per image avg, ~$0.06/img blended) | ~$30 |
| Scan (3 providers, ~$0.03/img blended) | ~$15 |
| Erase tool (~15% of enhanced images) | ~$3 |
| **AI subtotal** | **~$48** |
| Infra floor (from above) | $150 |
| **Total** | **~$198/month** (~$40/user) |

### Scenario B — Moderate usage (8 users, ~2,000 images/month)

8 users at the same per-user pace, all generators slightly more utilised (operators picking 2 providers per image on average for comparison).

| Line item | Monthly |
|---|---|
| Enhance (~2 providers per image, ~$0.06/img blended) | ~$120 |
| Scan (3 providers) | ~$60 |
| Erase tool (~15% of enhanced images) | ~$12 |
| **AI subtotal** | **~$192** |
| Infra floor | $150 |
| **Total** | **~$342/month** (~$43/user) |

### Scenario C — High usage (10 users, ~3,600 images/month)

Full team running heavy comparison batches — typically 2–3 providers selected per image, with hero shots running all 4.

| Line item | Monthly |
|---|---|
| Enhance (~2.5 providers per image avg) | ~$270 |
| Scan (3 providers) | ~$108 |
| Erase tool (~20% of enhanced images) | ~$29 |
| **AI subtotal** | **~$407** |
| Infra floor | $150 |
| **Total** | **~$557/month** (~$56/user) |

### Notes for the bill payer

- **Infra dominates at the low end.** At 5 users, the fixed ~$150/month infra floor is 3× the AI spend. If you ever want to drop the bill significantly at light usage, the lever is infra (downsize Cloud SQL, drop Memorystore Valkey and use in-memory caching, etc.) — not AI throttling.
- **Per-provider selection is the AI lever.** Selecting all 4 generators per image roughly **quadruples** the enhance cost vs picking 1. Default operator behaviour should be 1–2 providers for routine work, all 4 only for hero shots that justify the $0.27/image splurge.
- **Scan cost is dominated by the optional OpenAI + Anthropic providers.** If `SCAN_PROVIDER_OPENAI=false` and `SCAN_PROVIDER_ANTHROPIC=false`, scan drops to Gemini-only at roughly $0.001/image — and the totals above shrink by ~$15 / ~$60 / ~$108 across the three scenarios.
- **Real invoices will diverge from these placeholders.** The per-image rates are educated estimates pending the first 30 days of production data; revisit `services/pricing.py` and this section once Cloud Billing exports are accurate enough to back out the true per-call cost.

---

## License

Proprietary — AI App Integrations LLC - designed for Discount Forklift. All rights reserved.
