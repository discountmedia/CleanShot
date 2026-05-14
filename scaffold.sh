#!/usr/bin/env bash
# =============================================================================
# CleanShot — Monorepo Scaffold Script
# Phase 4 Playbook v4.2 — Step 1: Repository Layout
#
# Run this from the repo root:
#   cd /path/to/CleanShot
#   chmod +x scaffold.sh
#   bash scaffold.sh
#
# What it creates:
#   - pnpm workspace config
#   - Root package.json (Node 24, pnpm 11)
#   - .nvmrc (Node 24.12.0)
#   - .gitignore (comprehensive)
#   - apps/api/          FastAPI backend stub
#   - apps/worker-image/ Image worker stub
#   - apps/worker-video/ Video worker stub
#   - apps/web/          Next.js 16 frontend scaffold
#   - packages/types/    Shared TypeScript types
#   - infra/terraform/   Terraform stub
#   - .github/workflows/ CI/CD workflow stubs
#   - vercel.json
#   - .env.local.example
# =============================================================================

set -euo pipefail

GREEN='\033[0;32m'; CYAN='\033[0;36m'; BOLD='\033[1m'; RESET='\033[0m'
ok()     { echo -e "  ${GREEN}✔${RESET}  $*"; }
header() { echo -e "\n${BOLD}${CYAN}━━━  $*  ━━━${RESET}"; }
mkd()    { mkdir -p "$1" && ok "mkdir $1"; }

# Guard — must be run from the repo root
if [[ ! -d ".git" ]]; then
  echo "ERROR: Run this script from the CleanShot repo root (where .git lives)"
  exit 1
fi

echo ""
echo -e "${BOLD}CleanShot — Monorepo Scaffold${RESET}"
echo -e "Phase 4 Playbook v4.2 — Step 1"
echo ""

# =============================================================================
# DIRECTORY STRUCTURE
# =============================================================================
header "Creating directory structure"

mkd "apps/api/app/api"
mkd "apps/api/app/services"
mkd "apps/api/app/workers"
mkd "apps/api/app/models"
mkd "apps/worker-image/app"
mkd "apps/worker-video/app"
mkd "apps/web/app/session/[sessionId]"
mkd "apps/web/app/api/sessions/[id]"
mkd "apps/web/app/api/enhance"
mkd "apps/web/app/api/scan/batch"
mkd "apps/web/app/api/cleanup/batch"
mkd "apps/web/app/api/jobs/[id]"
mkd "apps/web/app/api/jobs/batch/[id]"
mkd "apps/web/app/api/projects/save"
mkd "apps/web/app/api/export/fullsize"
mkd "apps/web/app/api/export/pro"
mkd "apps/web/app/api/export/custom"
mkd "apps/web/app/api/export/zip"
mkd "apps/web/app/api/upload/signed-url"
mkd "apps/web/app/api/assets/[id]/url"
mkd "apps/web/app/api/auth/session"
mkd "apps/web/app/api/auth/[...all]"
mkd "apps/web/app/login"
mkd "apps/web/app/unauthorized"
mkd "apps/web/components/workspace"
mkd "apps/web/components/enhance"
mkd "apps/web/components/scan"
mkd "apps/web/components/cleanup"
mkd "apps/web/components/export"
mkd "apps/web/components/queue"
mkd "apps/web/components/shared"
mkd "apps/web/components/auth"
mkd "apps/web/lib/auth"
mkd "apps/web/styles"
mkd "apps/web/public"
mkd "packages/types/src"
mkd "infra/terraform"
mkd "migrations"
mkd ".github/workflows"

# =============================================================================
# ROOT CONFIG FILES
# =============================================================================
header "Root config files"

# .nvmrc — Node 24 (Active LTS, ahead of playbook's 22 — safe to use)
cat > .nvmrc << 'EOF'
24.12.0
EOF
ok ".nvmrc"

# pnpm-workspace.yaml
cat > pnpm-workspace.yaml << 'EOF'
packages:
  - 'apps/*'
  - 'packages/*'
EOF
ok "pnpm-workspace.yaml"

# Root package.json
cat > package.json << 'EOF'
{
  "name": "cleanshot",
  "private": true,
  "version": "0.1.0",
  "description": "CleanShot — AI-powered forklift image processing platform",
  "engines": {
    "node": ">=24.0.0",
    "pnpm": ">=11.0.0"
  },
  "packageManager": "pnpm@11.0.8",
  "scripts": {
    "dev:web": "pnpm --filter web dev",
    "build:web": "pnpm --filter web build",
    "typecheck": "pnpm --filter web exec tsc --noEmit",
    "test": "pnpm --filter web test --run",
    "lint": "pnpm --filter web lint",
    "audit": "pnpm audit --audit-level=high"
  }
}
EOF
ok "package.json"

# .gitignore
cat > .gitignore << 'EOF'
# Dependencies
node_modules/
.pnp
.pnp.js

# Build outputs
.next/
out/
dist/
build/
*.egg-info/
__pycache__/
*.pyc
*.pyo
.pytest_cache/
.mypy_cache/
.ruff_cache/

# Environment files — NEVER commit these
.env
.env.local
.env.*.local
.env.production

# pnpm
.pnpm-store/

# Vercel
.vercel

# TypeScript
*.tsbuildinfo
next-env.d.ts

# Testing
coverage/
.playwright/
playwright-report/
test-results/

# Python virtual environments
.venv/
venv/
env/

# Terraform
infra/terraform/.terraform/
infra/terraform/*.tfstate
infra/terraform/*.tfstate.backup
infra/terraform/.terraform.lock.hcl
infra/terraform/terraform.tfvars

# OS
.DS_Store
Thumbs.db

# Logs
*.log
npm-debug.log*
pnpm-debug.log*

# Editor
.vscode/settings.json
.idea/
*.swp
*.swo
EOF
ok ".gitignore"

# vercel.json
cat > vercel.json << 'EOF'
{
  "$schema": "https://openapi.vercel.sh/vercel.json",
  "buildCommand": "pnpm --filter web build",
  "installCommand": "pnpm install --frozen-lockfile",
  "outputDirectory": "apps/web/.next",
  "framework": "nextjs",
  "functions": {
    "apps/web/app/api/export/zip/route.ts":       { "maxDuration": 60  },
    "apps/web/app/api/export/**/*.ts":             { "maxDuration": 20  },
    "apps/web/app/api/sessions/**/*.ts":           { "maxDuration": 15  },
    "apps/web/app/api/enhance/route.ts":           { "maxDuration": 15  },
    "apps/web/app/api/scan/**/*.ts":               { "maxDuration": 15  },
    "apps/web/app/api/cleanup/**/*.ts":            { "maxDuration": 15  },
    "apps/web/app/api/**/*.ts":                    { "maxDuration": 10  }
  }
}
EOF
ok "vercel.json"

# .env.local.example
cat > .env.local.example << 'EOF'
# ============================================================
# CleanShot — Local Development Environment Variables
# Copy this file to .env.local and fill in values
# .env.local is gitignored — NEVER commit real secrets
# ============================================================

# --- Backend (server-only — never NEXT_PUBLIC_) ---
FASTAPI_INTERNAL_URL=http://localhost:8000
FASTAPI_INTERNAL_KEY=dev-api-key-change-in-production

# --- Auth (server-only) ---
AUTH_ENABLED=false
MICROSOFT_CLIENT_ID=
MICROSOFT_CLIENT_SECRET=
BETTER_AUTH_SECRET=
ALLOWED_DOMAINS=yourdomain.com

# --- Database ---
DATABASE_URL=postgresql://postgres:password@localhost:5432/cleanshot

# --- Frontend ---
NEXT_PUBLIC_APP_ENV=development
NEXT_TELEMETRY_DISABLED=1
EOF
ok ".env.local.example"

# README
cat > README.md << 'EOF'
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
EOF
ok "README.md"

# =============================================================================
# APPS/WEB — Next.js 16 frontend
# =============================================================================
header "apps/web — Next.js 16"

cat > apps/web/package.json << 'EOF'
{
  "name": "web",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev":   "next dev",
    "build": "next build",
    "start": "next start",
    "lint":  "next lint",
    "test":  "vitest",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "next":      "16.2.6",
    "react":     "19.2.5",
    "react-dom": "19.2.5",
    "better-auth": "1.x"
  },
  "devDependencies": {
    "@tailwindcss/postcss":   "4.1.x",
    "tailwindcss":            "4.1.x",
    "typescript":             "5.9.x",
    "@types/node":            "24.x",
    "@types/react":           "19.x",
    "@types/react-dom":       "19.x",
    "vitest":                 "4.1.x",
    "@testing-library/react": "16.x",
    "@playwright/test":       "1.59.x"
  }
}
EOF
ok "apps/web/package.json"

cat > apps/web/tsconfig.json << 'EOF'
{
  "compilerOptions": {
    "lib":              ["dom", "dom.iterable", "esnext"],
    "allowJs":          false,
    "skipLibCheck":     true,
    "strict":           true,
    "noEmit":           true,
    "esModuleInterop":  true,
    "module":           "node22",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules":  true,
    "jsx":              "preserve",
    "incremental":      true,
    "plugins":          [{ "name": "next" }],
    "paths": {
      "@/*":                ["./src/*"],
      "@cleanshot/types":   ["../../packages/types/src"]
    }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
EOF
ok "apps/web/tsconfig.json"

cat > apps/web/next.config.ts << 'EOF'
import type { NextConfig } from 'next'

const nextConfig: NextConfig = {
  // React Compiler: stable in Next.js 16 — auto-memoizes components
  reactCompiler: true,

  // Images: allow GCS bucket domain for signed URLs
  images: {
    remotePatterns: [
      {
        protocol: 'https',
        hostname: 'storage.googleapis.com',
        pathname: '/cleanshot-training-df-2026/**',
      },
    ],
  },

  // Security headers on all routes
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          { key: 'X-Content-Type-Options',  value: 'nosniff' },
          { key: 'X-Frame-Options',          value: 'DENY' },
          { key: 'Referrer-Policy',          value: 'strict-origin-when-cross-origin' },
          {
            key: 'Strict-Transport-Security',
            value: 'max-age=63072000; includeSubDomains; preload',
          },
          {
            key: 'Permissions-Policy',
            value: 'camera=(), microphone=(), geolocation=(), interest-cohort=()',
          },
        ],
      },
    ]
  },
}

export default nextConfig
EOF
ok "apps/web/next.config.ts"

cat > apps/web/postcss.config.mjs << 'EOF'
// Tailwind v4: @tailwindcss/postcss replaces old 'tailwindcss' plugin
export default {
  plugins: { '@tailwindcss/postcss': {} },
}
EOF
ok "apps/web/postcss.config.mjs"

cat > apps/web/styles/globals.css << 'EOF'
/* Tailwind v4: single @import replaces @tailwind base/components/utilities */
@import "tailwindcss";

/* All design tokens — no tailwind.config.js in v4 */
@theme {
  --color-brand-900:   #1A2F5E;
  --color-brand-700:   #1F4E9B;
  --color-brand-500:   #2E75B6;
  --color-brand-100:   #EBF3FB;

  --color-success-900: #1E4620;
  --color-success-100: #D6EFD8;

  --color-warn-900:    #7F4F00;
  --color-warn-100:    #FFF3CD;

  --color-error-900:   #6B1A1A;
  --color-error-100:   #FDECEA;

  --color-surface:     #F8FAFC;
  --color-border:      #E2E8F0;

  --font-sans:   'Inter', system-ui, sans-serif;
  --font-mono:   'JetBrains Mono', monospace;

  --radius-card: 0.75rem;
  --radius-pill: 9999px;
}

@utility focus-ring {
  outline: 2px solid var(--color-brand-500);
  outline-offset: 2px;
}
EOF
ok "apps/web/styles/globals.css"

# proxy.ts — Next.js 16 (renamed from middleware.ts per v3.5 playbook)
cat > apps/web/proxy.ts << 'EOF'
// proxy.ts — Next.js 16 (renamed from middleware.ts)
// v3.5: AUTH_ENABLED gate + Better Auth session check
// v3.4: CSP nonce per-request (XSS mitigation — GHSA-ffhc-5mcf-pf4q)
//
// SECURITY NOTE: proxy.ts is a UX redirect layer only.
// The real authz boundary is isAuthorized() inside every Route Handler.
// Never rely on this file as the sole security gate.

import { NextRequest, NextResponse } from 'next/server'

export async function proxy(request: NextRequest) {
  const { pathname } = request.nextUrl

  // --- AUTH GATE (v3.5) ---
  // AUTH_ENABLED=false during development and testing (default)
  // AUTH_ENABLED=true only in Vercel Production after testing complete
  if (process.env.AUTH_ENABLED === 'true') {
    const isPublic =
      pathname.startsWith('/login') ||
      pathname.startsWith('/unauthorized') ||
      pathname.startsWith('/api/auth') ||
      pathname.startsWith('/_next')

    if (!isPublic) {
      // Dynamic import avoids loading better-auth when AUTH_ENABLED=false
      const { auth } = await import('@/lib/auth/auth')
      const session = await auth.api.getSession({ headers: request.headers })

      if (!session) {
        const loginUrl = new URL('/login', request.url)
        loginUrl.searchParams.set('callbackUrl', pathname)
        return NextResponse.redirect(loginUrl)
      }
    }
  }

  // --- CSP NONCE (v3.4 — unchanged) ---
  const nonce = Buffer.from(crypto.randomUUID()).toString('base64')
  const response = NextResponse.next({
    request: { headers: new Headers({ 'x-nonce': nonce }) },
  })

  const csp = [
    `default-src 'self'`,
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'`,
    `style-src 'self' 'unsafe-inline'`,
    `img-src 'self' data: https://storage.googleapis.com`,
    `connect-src 'self'`,
    `frame-ancestors 'none'`,
  ].join('; ')

  response.headers.set('Content-Security-Policy', csp)
  response.headers.set('x-nonce', nonce)
  return response
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
EOF
ok "apps/web/proxy.ts"

# Stub app files
cat > apps/web/app/layout.tsx << 'EOF'
// Root layout — fonts, global styles
// TODO: add Inter font via next/font/google
import '@/styles/globals.css'
import type { Metadata } from 'next'

export const metadata: Metadata = {
  title: 'CleanShot',
  description: 'AI-powered forklift image processing',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
EOF
ok "apps/web/app/layout.tsx"

cat > apps/web/app/page.tsx << 'EOF'
// Root page — redirects to session workspace
// Session creation handled by /api/auth/session route handler
import { redirect } from 'next/navigation'

export default function HomePage() {
  // TODO: create session via BFF, redirect to /session/[sessionId]
  redirect('/login')
}
EOF
ok "apps/web/app/page.tsx"

cat > apps/web/app/login/page.tsx << 'EOF'
// Login page — Microsoft SSO via Better Auth
// Only shown when AUTH_ENABLED=true
// TODO: implement SignInButton component and Better Auth session check
export default function LoginPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-950">
      <div className="flex flex-col items-center gap-6 rounded-2xl border border-white/10 bg-white/5 p-10">
        <h1 className="text-xl font-semibold text-white">CleanShot</h1>
        <p className="text-sm text-neutral-400">
          Sign in with your Microsoft account to continue
        </p>
        {/* TODO: <SignInButton callbackUrl="/" /> */}
        <p className="text-xs text-neutral-600">Auth not yet configured</p>
      </div>
    </main>
  )
}
EOF
ok "apps/web/app/login/page.tsx"

cat > apps/web/app/unauthorized/page.tsx << 'EOF'
// Shown when user passes Microsoft SSO but fails the allowlist check
export default function UnauthorizedPage() {
  return (
    <main className="flex min-h-screen items-center justify-center bg-neutral-950">
      <div className="flex flex-col items-center gap-4 rounded-2xl border border-white/10 bg-white/5 p-10">
        <h1 className="text-xl font-semibold text-white">Access Denied</h1>
        <p className="text-sm text-neutral-400 text-center max-w-xs">
          Your account is not authorised to use CleanShot.
          Contact your administrator to request access.
        </p>
      </div>
    </main>
  )
}
EOF
ok "apps/web/app/unauthorized/page.tsx"

# Route handler stubs — all protected routes get the auth guard pattern
for ROUTE in \
  "app/api/sessions/[id]/route.ts" \
  "app/api/enhance/route.ts" \
  "app/api/scan/batch/route.ts" \
  "app/api/cleanup/batch/route.ts" \
  "app/api/jobs/[id]/route.ts" \
  "app/api/jobs/batch/[id]/route.ts" \
  "app/api/projects/save/route.ts" \
  "app/api/export/fullsize/route.ts" \
  "app/api/export/pro/route.ts" \
  "app/api/export/custom/route.ts" \
  "app/api/export/zip/route.ts" \
  "app/api/upload/signed-url/route.ts" \
  "app/api/assets/[id]/url/route.ts" \
  "app/api/auth/session/route.ts"
do
  ROUTE_NAME=$(basename "$(dirname "$ROUTE")")
  cat > "apps/web/$ROUTE" << STUB
// Route Handler stub — $ROUTE_NAME
// TODO: implement per Phase 3 Playbook v3.5
import { NextRequest, NextResponse } from 'next/server'
export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  return NextResponse.json({ error: 'not implemented' }, { status: 501 })
}

export async function POST(request: NextRequest) {
  return NextResponse.json({ error: 'not implemented' }, { status: 501 })
}
STUB
  ok "apps/web/$ROUTE"
done

# Better Auth catch-all handler
cat > apps/web/app/api/auth/\[...all\]/route.ts << 'EOF'
// Better Auth catch-all handler
// Handles: /api/auth/sign-in/microsoft, /api/auth/callback/microsoft, /api/auth/sign-out
// TODO: wire up once better-auth is configured in lib/auth/auth.ts
// import { auth } from '@/lib/auth/auth'
// import { toNextJsHandler } from 'better-auth/next-js'
// export const { GET, POST } = toNextJsHandler(auth)

import { NextResponse } from 'next/server'
export async function GET() {
  return NextResponse.json({ error: 'auth not yet configured' }, { status: 501 })
}
export async function POST() {
  return NextResponse.json({ error: 'auth not yet configured' }, { status: 501 })
}
EOF
ok "apps/web/app/api/auth/[...all]/route.ts"

# lib/auth stubs
cat > apps/web/lib/auth/auth.ts << 'EOF'
// Better Auth configuration
// Requires: MICROSOFT_CLIENT_ID, MICROSOFT_CLIENT_SECRET, BETTER_AUTH_SECRET, DATABASE_URL
// TODO: implement per Phase 3 Playbook v3.5 Section 21.5
// import { betterAuth } from 'better-auth'
// import { nextCookies } from 'better-auth/next-js'
// import { pg } from 'better-auth/adapters/pg'
// ...
export const auth = null // placeholder — replace with real config
EOF
ok "apps/web/lib/auth/auth.ts"

cat > apps/web/lib/auth/isAuthorized.ts << 'EOF'
// Two-step allowlist authorization
// Step 1: domain check via ALLOWED_DOMAINS env var (zero DB cost)
// Step 2: individual email check via auth_allowlist Postgres table
// TODO: implement per Phase 3 Playbook v3.5 Section 21.3
export async function isAuthorized(_email: string): Promise<boolean> {
  // Placeholder — always returns true until implemented
  return true
}
EOF
ok "apps/web/lib/auth/isAuthorized.ts"

# =============================================================================
# APPS/API — FastAPI backend
# =============================================================================
header "apps/api — FastAPI"

cat > apps/api/pyproject.toml << 'EOF'
[project]
name = "cleanshot-api"
version = "0.1.0"
description = "CleanShot FastAPI backend"
requires-python = ">=3.12"

dependencies = [
  "fastapi==0.136.1",
  "pydantic>=2.9",
  "uvicorn[standard]>=0.34",
  "google-genai[aiohttp]==1.75.0",
  "google-cloud-tasks>=2.16",
  "google-cloud-storage>=2.18",
  "google-auth>=2.38",
  "openai>=1.68",
  "anthropic>=0.51",
  "pyvips>=2.2",
  "asyncpg>=0.30",
  "python-jose[cryptography]>=3.3",
]

[tool.ruff]
target-version = "py312"
line-length = 100

[tool.ruff.lint]
select = ["E", "F", "I", "UP"]
EOF
ok "apps/api/pyproject.toml"

cat > apps/api/Dockerfile << 'EOF'
# CleanShot API — Cloud Run Service
# Base: python:3.12-slim (Debian) — NOT Alpine (fontconfig/librsvg issues)
FROM python:3.12-slim AS base

# System deps: libvips for pyvips, fonts for SVG rendering
RUN apt-get update && apt-get install -y --no-install-recommends \
    libvips-dev \
    libvips42 \
    librsvg2-common \
    fontconfig \
    fonts-liberation \
    libcairo2 \
    libwebp-dev \
    curl \
  && rm -rf /var/lib/apt/lists/*

# Install uv for fast Python package management
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.cargo/bin:$PATH"

WORKDIR /app

# Install Python dependencies
COPY pyproject.toml .
RUN uv pip install --system -e .

# Copy application code
COPY app/ ./app/

# Non-root user for security
RUN useradd --no-create-home --shell /bin/false appuser
USER appuser

# Cloud Run: single uvicorn process — never gunicorn on Cloud Run
# --workers 1 is intentional — Cloud Run handles scaling via instances
CMD ["uvicorn", "app.main:app", \
     "--host", "0.0.0.0", \
     "--port", "8080", \
     "--workers", "1", \
     "--loop", "uvloop", \
     "--http", "httptools"]
EOF
ok "apps/api/Dockerfile"

cat > apps/api/app/__init__.py << 'EOF'
EOF

cat > apps/api/app/main.py << 'EOF'
# CleanShot FastAPI — main application entry point
# TODO: implement per Phase 2 Playbook v2.5
from fastapi import FastAPI

app = FastAPI(
    title="CleanShot API",
    version="0.1.0",
    docs_url=None,   # Disable in production
    redoc_url=None,
)

@app.get("/health")
async def health() -> dict:
    return {"status": "ok", "version": "0.1.0"}
EOF
ok "apps/api/app/main.py"

# API module stubs
for MODULE in sessions jobs enhance scan cleanup export assets; do
  printf '# %s — TODO: implement per Phase 2 Playbook v2.5\n' "${MODULE}" \
    > "apps/api/app/api/${MODULE}.py"
  ok "apps/api/app/api/${MODULE}.py"
done

touch apps/api/app/api/__init__.py
touch apps/api/app/services/__init__.py
touch apps/api/app/workers/__init__.py
touch apps/api/app/models/__init__.py

# =============================================================================
# APPS/WORKER-IMAGE — Arq image worker
# =============================================================================
header "apps/worker-image — Arq image worker"

cat > apps/worker-image/pyproject.toml << 'EOF'
[project]
name = "cleanshot-worker-image"
version = "0.1.0"
description = "CleanShot image processing worker (Arq + Cloud Run Worker Pool)"
requires-python = ">=3.12"

dependencies = [
  "arq>=0.26",
  "google-genai[aiohttp]==1.75.0",
  "google-cloud-storage>=2.18",
  "google-auth>=2.38",
  "pyvips>=2.2",
  "asyncpg>=0.30",
]
EOF
ok "apps/worker-image/pyproject.toml"

cat > apps/worker-image/Dockerfile << 'EOF'
# CleanShot Image Worker — Cloud Run Worker Pool
# Same base as API — requires libvips for image processing
FROM python:3.12-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends \
    libvips-dev \
    libvips42 \
    librsvg2-common \
    fontconfig \
    fonts-liberation \
    libcairo2 \
    libwebp-dev \
    curl \
  && rm -rf /var/lib/apt/lists/*

RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.cargo/bin:$PATH"

WORKDIR /app
COPY pyproject.toml .
RUN uv pip install --system -e .
COPY app/ ./app/

RUN useradd --no-create-home --shell /bin/false appuser
USER appuser

# Worker Pool: no HTTP listener — pulls from Arq/Redis queue
CMD ["python", "-m", "app.worker"]
EOF
ok "apps/worker-image/Dockerfile"

cat > apps/worker-image/app/__init__.py << 'EOF'
EOF

cat > apps/worker-image/app/worker.py << 'EOF'
# CleanShot Image Worker — Arq worker entry point
# TODO: implement per Phase 2 Playbook v2.5
# max_jobs=8 (I/O bound — Gemini wait time)
# job_timeout=480s (8 minutes max per image)
import asyncio

async def process_image(ctx: dict, job_id: str) -> dict:
    """Main image processing job — enhance, scan, cleanup."""
    raise NotImplementedError("TODO: implement per Phase 2 v2.5")

class WorkerSettings:
    functions = [process_image]
    max_jobs = 8
    job_timeout = 480

if __name__ == "__main__":
    from arq import run_worker
    run_worker(WorkerSettings)
EOF
ok "apps/worker-image/app/worker.py"

# =============================================================================
# APPS/WORKER-VIDEO — Arq video worker (Phase 4.5 stub)
# =============================================================================
header "apps/worker-video — Video worker (Phase 4.5 stub)"

cat > apps/worker-video/pyproject.toml << 'EOF'
[project]
name = "cleanshot-worker-video"
version = "0.1.0"
description = "CleanShot video worker — Veo 3.1 (Phase 4.5)"
requires-python = ">=3.12"

dependencies = [
  "arq>=0.26",
  "google-genai[aiohttp]==1.75.0",
  "google-cloud-storage>=2.18",
  "google-auth>=2.38",
  "asyncpg>=0.30",
]
EOF
ok "apps/worker-video/pyproject.toml"

cat > apps/worker-video/Dockerfile << 'EOF'
# CleanShot Video Worker — Cloud Run Worker Pool (Phase 4.5)
# Lightweight — no pyvips needed, just Veo API polling
FROM python:3.12-slim AS base

RUN apt-get update && apt-get install -y --no-install-recommends curl \
  && rm -rf /var/lib/apt/lists/*

RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.cargo/bin:$PATH"

WORKDIR /app
COPY pyproject.toml .
RUN uv pip install --system -e .
COPY app/ ./app/

RUN useradd --no-create-home --shell /bin/false appuser
USER appuser

CMD ["python", "-m", "app.worker"]
EOF
ok "apps/worker-video/Dockerfile"

mkdir -p apps/worker-video/app
cat > apps/worker-video/app/__init__.py << 'EOF'
EOF

cat > apps/worker-video/app/worker.py << 'EOF'
# CleanShot Video Worker — Phase 4.5 stub
# Veo 3.1 video generation — not implemented until Phase 4.5
# max_jobs=20 (mostly asyncio.sleep polling Veo)
# job_timeout=1500s (25 minutes — covers worst-case Veo rendering)
# max_tries=2 — Veo retries cost real money, never burn 5 attempts

class WorkerSettings:
    functions = []
    max_jobs = 20
    job_timeout = 1500
EOF
ok "apps/worker-video/app/worker.py"

# =============================================================================
# PACKAGES/TYPES — Shared TypeScript types
# =============================================================================
header "packages/types — Shared TypeScript types"

cat > packages/types/package.json << 'EOF'
{
  "name": "@cleanshot/types",
  "version": "0.1.0",
  "private": true,
  "main": "./src/index.ts",
  "types": "./src/index.ts"
}
EOF
ok "packages/types/package.json"

cat > packages/types/src/index.ts << 'EOF'
// Shared TypeScript types — CleanShot
// These are consumed by apps/web via @cleanshot/types path alias

export type JobStatus = 'queued' | 'processing' | 'complete' | 'failed'

export interface JobRecord {
  id: string
  session_id: string
  status: JobStatus
  created_at: string
  updated_at: string
  result_url?: string
  error?: string
}

export interface SessionState {
  session_id: string
  created_at: string
  jobs: JobRecord[]
  project?: ProjectRecord
}

export interface ProjectRecord {
  id: string
  session_id: string
  name: string
  saved_at: string
}

export interface EnhanceRequest {
  session_id: string
  asset_id: string
  toggles: EnhanceToggles
}

export interface EnhanceToggles {
  paint_upgrade: boolean
  rust_removal: boolean
  decal_restoration: boolean
  remove_people: boolean
  hide_third_party_branding: boolean
  paint_forks_red_yellow: boolean
  shiny_wet_tires: boolean
  clean_grey_floor: boolean
  studio_background: boolean
  general_improvements: boolean
}

export interface ScanResult {
  asset_id: string
  verdict: 'pass' | 'warn' | 'fail'
  confidence: number
  anomalies: string[]
}

export interface QueueStatus {
  depth: number
  position: number
  eta_seconds: number
}
EOF
ok "packages/types/src/index.ts"

# =============================================================================
# MIGRATIONS
# =============================================================================
header "Database migrations"

cat > migrations/001_auth_allowlist.sql << 'EOF'
-- Migration 001: auth_allowlist table
-- Phase 3 v3.5 — Microsoft Entra ID SSO authorization
-- Does NOT modify any existing Phase 2 tables

CREATE TABLE IF NOT EXISTS auth_allowlist (
  id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text        UNIQUE NOT NULL,
  label       text,                         -- e.g. "Bob Smith - ABC Auctions"
  created_by  text        NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT NOW(),
  expires_at  timestamptz               -- NULL = permanent; set for temp third-party access
);

CREATE INDEX IF NOT EXISTS idx_auth_allowlist_email
  ON auth_allowlist (email);

CREATE INDEX IF NOT EXISTS idx_auth_allowlist_expires
  ON auth_allowlist (expires_at)
  WHERE expires_at IS NOT NULL;

-- Better Auth tables are created automatically via: npx better-auth migrate
-- Tables created: ba_user, ba_session, ba_account, ba_verification
EOF
ok "migrations/001_auth_allowlist.sql"

# =============================================================================
# INFRA/TERRAFORM — stub
# =============================================================================
header "infra/terraform — stubs"

cat > infra/terraform/main.tf << 'EOF'
# CleanShot — Terraform Infrastructure
# GCP Project: cleanshot-493512
# Region: us-central1
# TODO: implement per Phase 4 Playbook v4.2

terraform {
  required_version = ">= 1.7"
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
  }
  # TODO: configure remote backend (GCS bucket for state)
  # backend "gcs" {
  #   bucket = "cleanshot-terraform-state"
  #   prefix = "terraform/state"
  # }
}

provider "google" {
  project = var.project_id
  region  = var.region
}
EOF
ok "infra/terraform/main.tf"

cat > infra/terraform/variables.tf << 'EOF'
variable "project_id" {
  description = "GCP project ID"
  type        = string
  default     = "cleanshot-493512"
}

variable "region" {
  description = "GCP region"
  type        = string
  default     = "us-central1"
}

variable "github_org" {
  description = "GitHub organisation or username"
  type        = string
  default     = "discountmedia"
}

variable "github_repo" {
  description = "GitHub repository name"
  type        = string
  default     = "CleanShot"
}
EOF
ok "infra/terraform/variables.tf"

# =============================================================================
# GITHUB ACTIONS WORKFLOWS
# =============================================================================
header ".github/workflows"

# WIF provider resource (from our setup earlier)
WIF_PROVIDER="projects/387208973244/locations/global/workloadIdentityPools/github-pool/providers/github-provider"

# CI workflow — runs on every push/PR
cat > .github/workflows/ci.yml << EOF
name: CI

on:
  push:
    branches: [main]
  pull_request:
    branches: [main]

jobs:
  typecheck-and-test:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version-file: '.nvmrc'

      - run: corepack enable
      - run: corepack prepare pnpm@11.0.8 --activate

      - run: pnpm install --frozen-lockfile

      - name: Security audit
        run: pnpm audit --audit-level=high

      - name: Type check
        run: pnpm typecheck

      - name: Unit tests
        run: pnpm test
EOF
ok ".github/workflows/ci.yml"

# Deploy API workflow
cat > .github/workflows/deploy-api.yml << EOF
name: Deploy API

on:
  push:
    branches: [main]
    paths:
      - 'apps/api/**'
      - 'packages/**'
      - '.github/workflows/deploy-api.yml'

permissions:
  id-token: write
  contents: read

env:
  PROJECT_ID: cleanshot-493512
  REGION: us-central1
  REGISTRY: us-central1-docker.pkg.dev
  IMAGE: us-central1-docker.pkg.dev/cleanshot-493512/cleanshot/api

jobs:
  deploy:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4

      - name: Authenticate to GCP via WIF
        uses: google-github-actions/auth@v3
        with:
          workload_identity_provider: '${WIF_PROVIDER}'

      - uses: google-github-actions/setup-gcloud@v2

      - name: Configure Docker for Artifact Registry
        run: gcloud auth configure-docker \$REGISTRY --quiet

      - name: Build Docker image
        run: |
          docker build \\
            -t \$IMAGE:\${{ github.sha }} \\
            -t \$IMAGE:latest \\
            -f apps/api/Dockerfile \\
            .

      - name: Push Docker image
        run: |
          docker push \$IMAGE:\${{ github.sha }}
          docker push \$IMAGE:latest

      - name: Deploy to Cloud Run
        run: |
          gcloud run deploy forklift-api \\
            --image=\$IMAGE:\${{ github.sha }} \\
            --region=\$REGION \\
            --network=default \\
            --subnet=cloud-run-subnet \\
            --vpc-egress=private-ranges-only \\
            --service-account=forklift-api@\$PROJECT_ID.iam.gserviceaccount.com \\
            --set-secrets=API_KEY=frontend-api-key:latest,API_KEY_PREV=frontend-api-key-prev:latest \\
            --set-env-vars=GCP_PROJECT_ID=\$PROJECT_ID \\
            --min-instances=1 \\
            --max-instances=20 \\
            --concurrency=80 \\
            --cpu-boost \\
            --timeout=900 \\
            --quiet
EOF
ok ".github/workflows/deploy-api.yml"

# Deploy worker-image workflow
cat > .github/workflows/deploy-worker-image.yml << EOF
name: Deploy Image Worker

on:
  push:
    branches: [main]
    paths:
      - 'apps/worker-image/**'
      - '.github/workflows/deploy-worker-image.yml'

permissions:
  id-token: write
  contents: read

env:
  PROJECT_ID: cleanshot-493512
  REGION: us-central1
  REGISTRY: us-central1-docker.pkg.dev
  IMAGE: us-central1-docker.pkg.dev/cleanshot-493512/cleanshot/worker-image

jobs:
  deploy:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4

      - name: Authenticate to GCP via WIF
        uses: google-github-actions/auth@v3
        with:
          workload_identity_provider: '${WIF_PROVIDER}'

      - uses: google-github-actions/setup-gcloud@v2

      - name: Configure Docker for Artifact Registry
        run: gcloud auth configure-docker \$REGISTRY --quiet

      - name: Build and push
        run: |
          docker build \\
            -t \$IMAGE:\${{ github.sha }} \\
            -t \$IMAGE:latest \\
            -f apps/worker-image/Dockerfile \\
            .
          docker push \$IMAGE:\${{ github.sha }}
          docker push \$IMAGE:latest

      - name: Deploy Worker Pool
        run: |
          gcloud run worker-pools deploy forklift-worker-image \\
            --image=\$IMAGE:\${{ github.sha }} \\
            --region=\$REGION \\
            --network=default \\
            --subnet=cloud-run-subnet \\
            --service-account=forklift-worker-image@\$PROJECT_ID.iam.gserviceaccount.com \\
            --set-env-vars=GCP_PROJECT_ID=\$PROJECT_ID \\
            --cpu=2 \\
            --memory=1Gi \\
            --quiet
EOF
ok ".github/workflows/deploy-worker-image.yml"

# Deploy worker-video workflow
cat > .github/workflows/deploy-worker-video.yml << EOF
name: Deploy Video Worker

on:
  push:
    branches: [main]
    paths:
      - 'apps/worker-video/**'
      - '.github/workflows/deploy-worker-video.yml'

permissions:
  id-token: write
  contents: read

env:
  PROJECT_ID: cleanshot-493512
  REGION: us-central1
  REGISTRY: us-central1-docker.pkg.dev
  IMAGE: us-central1-docker.pkg.dev/cleanshot-493512/cleanshot/worker-video

jobs:
  deploy:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4

      - name: Authenticate to GCP via WIF
        uses: google-github-actions/auth@v3
        with:
          workload_identity_provider: '${WIF_PROVIDER}'

      - uses: google-github-actions/setup-gcloud@v2

      - name: Configure Docker for Artifact Registry
        run: gcloud auth configure-docker \$REGISTRY --quiet

      - name: Build and push
        run: |
          docker build \\
            -t \$IMAGE:\${{ github.sha }} \\
            -t \$IMAGE:latest \\
            -f apps/worker-video/Dockerfile \\
            .
          docker push \$IMAGE:\${{ github.sha }}
          docker push \$IMAGE:latest

      - name: Deploy Worker Pool
        run: |
          gcloud run worker-pools deploy forklift-worker-video \\
            --image=\$IMAGE:\${{ github.sha }} \\
            --region=\$REGION \\
            --network=default \\
            --subnet=cloud-run-subnet \\
            --service-account=forklift-worker-video@\$PROJECT_ID.iam.gserviceaccount.com \\
            --set-env-vars=GCP_PROJECT_ID=\$PROJECT_ID \\
            --cpu=0.5 \\
            --memory=512Mi \\
            --quiet
EOF
ok ".github/workflows/deploy-worker-video.yml"

# Deploy web workflow
cat > .github/workflows/deploy-web.yml << 'EOF'
name: Deploy Web

on:
  push:
    branches: [main]
    paths:
      - 'apps/web/**'
      - 'packages/types/**'
      - 'vercel.json'
      - '.github/workflows/deploy-web.yml'

jobs:
  deploy:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version-file: '.nvmrc'

      - run: corepack enable
      - run: corepack prepare pnpm@11.0.8 --activate

      - run: pnpm install --frozen-lockfile

      - name: Security audit
        run: pnpm audit --audit-level=high

      - name: Type check
        run: pnpm typecheck

      - name: Unit tests
        run: pnpm test

      - name: Deploy to Vercel
        uses: amondnet/vercel-action@v25
        with:
          vercel-token:      ${{ secrets.VERCEL_TOKEN }}
          vercel-org-id:     ${{ secrets.VERCEL_ORG_ID }}
          vercel-project-id: ${{ secrets.VERCEL_PROJECT_ID }}
          vercel-args:       '--prod'
          working-directory: apps/web
EOF
ok ".github/workflows/deploy-web.yml"

# =============================================================================
# DONE
# =============================================================================
header "Scaffold complete"

echo ""
echo -e "  ${BOLD}Next steps:${RESET}"
echo ""
echo "  1. Copy env example and fill in local values:"
echo "     cp .env.local.example apps/web/.env.local"
echo ""
echo "  2. Install dependencies:"
echo "     pnpm install"
echo ""
echo "  3. Verify TypeScript compiles:"
echo "     pnpm typecheck"
echo ""
echo "  4. Commit and push:"
echo "     git add -A"
echo '     git commit -m "feat: Phase 4 Step 1 — monorepo scaffold"'
echo "     git push origin main"
echo ""
echo -e "  ${BOLD}Structure created:${RESET}"
echo ""
find . -not -path './.git/*' -not -path './node_modules/*' \
  -not -path './.next/*' -not -name '.DS_Store' \
  | sort | sed 's|[^/]*/|  |g' | head -80
echo ""
