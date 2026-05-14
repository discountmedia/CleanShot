# CleanShot

AI-powered forklift image processing platform.

## Stack

- **Frontend**: Next.js 16 / React 19 / Tailwind v4 — Vercel Pro
- **Backend**: FastAPI / Python 3.12 — Cloud Run
- **Workers**: Arq — Cloud Run Worker Pools
- **Database**: Postgres 17 — Cloud SQL
- **Cache**: Valkey 9.0 — Memorystore
- **Storage**: GCS (two buckets)
- **AI**: Gemini 3 Pro Image / GPT-5.4 / Claude Sonnet 4.6

## Prerequisites

- Node.js >= 24
- pnpm 11.0.8 (`corepack enable && corepack prepare pnpm@11.0.8 --activate`)
- Python 3.12
- Docker Desktop

## Setup

```bash
cp .env.local.example .env.local
# Fill in .env.local values

pnpm install
pnpm dev:web
```

## Project structure

```
apps/
  api/            FastAPI backend (Cloud Run Service)
  worker-image/   Image processing worker (Cloud Run Worker Pool)
  worker-video/   Video worker — Phase 4.5 (Cloud Run Worker Pool)
  web/            Next.js 16 frontend (Vercel)
packages/
  types/          Shared TypeScript types
infra/
  terraform/      GCP infrastructure as code
migrations/       Postgres migration SQL files
.github/
  workflows/      CI/CD — GitHub Actions + WIF
```

## Playbooks

- Phase 1 — Dataset pipeline (complete)
- Phase 2 — Backend architecture
- Phase 3 — Frontend architecture
- Phase 4 — Production deployment
