# CleanShot

AI-powered forklift image processing platform. Upload raw forklift photos, enhance them with Gemini, scan for quality issues across three AI providers, resize to marketplace specs, and export — all in a single workflow.

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
- [Image History & 30-Day Storage](#image-history--30-day-storage)
- [Adding Authorized Users](#adding-authorized-users)
- [Troubleshooting](#troubleshooting)

---

## What It Does

CleanShot takes raw forklift photos and runs them through a four-step pipeline:

1. **Enhance** — Gemini Pro Image removes rust, restores decals, improves lighting, paints forks, and replaces backgrounds based on user-selected toggles.
2. **Scan** — Up to three AI providers (Gemini Flash, GPT-5.4, Claude Sonnet) each give a pass/fail verdict with confidence scores and an anomaly list. Failed images can be regenerated in-place without starting over.
3. **Resize** — Auto-crops to 1024×731 (7:5), zoom-to-fill, JPEG compressed to ≤99 KB. Ready for auction platforms and dealer inventory systems.
4. **Export** — Individual downloads, ZIP batch, or PRO preset exports. Approved sets are saved to each user's GCS library for 30 days.

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
│   ├── terraform/                    # GCP resources
│   └── gcs-lifecycle-approved.json   # 30-day lifecycle rule for approved/ prefix
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

| Operation | Model | Provider | Notes |
|---|---|---|---|
| Enhance | `gemini-3-pro-image-preview` | Vertex AI (ADC) | No API key — IAM auth |
| Enhance fallback | `gemini-2.5-flash-image` | Vertex AI | Activated if primary fails |
| Scan — primary | `gemini-3.1-flash-image-preview` | Vertex AI (ADC) | Always active |
| Scan — optional | `gpt-5.4` | OpenAI | Enable: `SCAN_PROVIDER_OPENAI=true` |
| Scan — optional | `claude-sonnet-4-6` | Anthropic | Enable: `SCAN_PROVIDER_ANTHROPIC=true` |
| Scan — hard cases | `claude-opus-4-7` | Anthropic | Auto-routed when confidence < 0.6 |
| Cleanup / Regen | `gemini-3-pro-image-preview` | Vertex AI (ADC) | Same model as enhance |

**Critical API format differences** (do not mix up — each provider requires a different image input format):

- **Gemini:** Pass the GCS URI directly via `file_data.file_uri` — no base64 transfer needed
- **OpenAI:** Data URL **with** `data:image/jpeg;base64,` prefix — uses Responses API (`client.responses.parse`)
- **Anthropic:** Raw base64 **without** any prefix — uses GA structured output via `output_config`

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
| `OPENAI_API_KEY` | When scan enabled | Only needed if `SCAN_PROVIDER_OPENAI=true` |
| `ANTHROPIC_API_KEY` | When scan enabled | Only needed if `SCAN_PROVIDER_ANTHROPIC=true` |
| `SCAN_PROVIDER_OPENAI` | No | `"true"` to activate GPT-5.4 scan |
| `SCAN_PROVIDER_ANTHROPIC` | No | `"true"` to activate Claude scan |
| `GCP_PROJECT` | No | Defaults to `cleanshot-493512` |
| `ENVIRONMENT` | No | `"local"` runs auto-migrations on startup |

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

**Auth + approval schema** (`apps/api/src/cleanshot_api/db/migrate_auth.py`):

- `authorization` — domain/email allowlist for runtime additions
- `approval_sets` — one row per "Approve All" click, with 30-day expiry
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

# Apply lifecycle rules:
#   - approved/ prefix: delete after 30 days
#   - tmp/ prefix: delete after 1 day
gcloud storage buckets update gs://cleanshot-derivatives-493512 \
  --lifecycle-file=infra/gcs-lifecycle-approved.json
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

1. Drop up to 22 images into the upload zone (drag-and-drop or file picker)
2. Files over 4.5 MB are automatically compressed client-side before upload (Vercel limit)
3. Optionally fill in forklift metadata: Make, Model, Year, Tire Type, Capacity, Fuel Type — helps Gemini cross-reference the captioned library
4. Toggle the enhancements you want:
   - **New Paint Job** — uniform factory colour restoration
   - **Remove Rust** — clean corrosion from all surfaces
   - **Restore Decals** — rebuild faded OEM labels and logos
   - **Remove People** — erase bystanders from the scene
   - **Paint Forks Red w/ Yellow Tips** — OSHA safety colour convention
   - **Shine Tires** — clean, black, conditioned appearance
   - **Improve Lighting** — exposure, shadows, white point
5. Click **Enhance** — images upload directly to GCS, enhance jobs are enqueued, per-image status rows appear

### Scan tab

1. Images arrive automatically after enhancement completes
2. Each image shows results from up to three AI providers with verdict chips, confidence bars, and anomaly lists
3. Failed images show a **Regenerate** button with an auto-generated prompt built from the detected anomalies — edit the prompt or use it as-is
4. Click **Approve All** when satisfied — all images are saved to your GCS library and moved to the Resize tab

### Resize tab

1. Images are automatically cropped to 1024×731 (7:5 aspect ratio)
2. Zoom-to-fill — no letterboxing, forklift centred and maximised in frame
3. Each image compressed to ≤99 KB JPEG
4. Download individually or as a ZIP

---

## Image History & 30-Day Storage

Every time a user clicks **Approve All**, the approved images are copied to:

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
INSERT INTO authorization (type, value, note)
VALUES ('domain', 'newclient.com', 'Added 2026-05-14 by admin');

-- Add a specific personal email (e.g. freelancer with @gmail.com)
INSERT INTO authorization (type, value, note)
VALUES ('email', 'photographer@gmail.com', 'Freelance contractor');

-- Remove access
DELETE FROM authorization WHERE value = 'expartner.com';

-- View current allowlist
SELECT type, value, note, created_at FROM authorization ORDER BY created_at DESC;
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

At Tier 1 IPM, Cloud Tasks dispatches one enhance job every 10 seconds. A batch of 22 images takes approximately 3–4 minutes to fully dispatch. The QueueStatusBar shows estimated time remaining. If a job is stuck for more than 10 minutes, check Cloud Run logs for `gemini-3-pro-image-preview` quota errors (429s). The Dynamic Shared Quota on this model is subject to global congestion.

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

## Cost Reference (Tier 1 — 100 users, 50 images/month each)

| Line Item | Monthly |
|---|---|
| Gemini Pro Image (5,000 enhance ops) | ~$670 |
| Gemini Flash Image (5,000 scans) | ~$335 |
| OpenAI gpt-5.4 (5,000 scans, if enabled) | ~$60 |
| Anthropic claude-sonnet-4-6 (5,000 scans, if enabled) | ~$75 |
| Cloud Run API (warm, request billing) | ~$13 |
| Cloud Run Worker Pool | ~$20 |
| Memorystore Valkey 1 GiB | ~$36 |
| Cloud SQL Postgres 17 | ~$25 |
| GCS storage + egress | ~$15 |
| Vercel Pro | ~$40 |
| **Total (Gemini scan only)** | **~$1,154/month** |
| **Total (all 3 scan providers)** | **~$1,289/month** |

The single biggest lever is Gemini Pro Image IPM quota. Upgrade from Tier 1 to Tier 2 (~$250 cumulative GCP spend) to raise throughput from 10 IPM to 20 IPM, halving batch wait times.

---

## License

Proprietary — Discount Media. All rights reserved.
