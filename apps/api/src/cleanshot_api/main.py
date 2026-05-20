"""
CleanShot FastAPI backend — Phase 2 v2.5

Startup sequence (lifespan):
  1. asyncpg pool → Postgres 17
  2. Run schema migrations (idempotent)
  3. Gemini client (Vertex AI ADC — no static key)
  4. OpenAI client (if SCAN_PROVIDER_OPENAI=true)
  5. Anthropic client (if SCAN_PROVIDER_ANTHROPIC=true)
  6. Valkey client (Memorystore for Valkey 9.0)
  7. asyncio.Semaphore(2) for Gemini Pro Image concurrency

Models in use:
  Generation / Cleanup (default):  gemini-2.5-flash-image
  Generation (OpenAI opt-in):      gpt-image-2-2026-04-21
  Scan (Gemini):                   gemini-2.5-flash
  Scan (OpenAI):                   gpt-5.4
  Scan (Anthropic std):            claude-sonnet-4-6
  Scan (Anthropic hard):           claude-opus-4-7
Pinned in apps/api/src/cleanshot_api/workers/enhance_worker.py + cleanup_worker.py.
"""

from __future__ import annotations

import asyncio
import logging
import os
from contextlib import asynccontextmanager

import anthropic
import openai
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from google import genai

import valkey.asyncio as valkey_client

from cleanshot_api.core.config import get_settings
from cleanshot_api.db.migrate import run_migrations
from cleanshot_api.db.migrate_auth import run_auth_migrations
from cleanshot_api.db.pool import create_pool
from cleanshot_api.routers import (
    approvals,
    export,
    jobs,
    operations,
    projects,
    scan_results,
    sessions,
    upload,
    worker,
)
from cleanshot_api.services.rate_limit import AsyncRateLimiter

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    logger.info("Starting CleanShot API (env=%s)", settings.environment)

    # --- Database ---
    app.state.pool = await create_pool(settings.database_url)
    logger.info("asyncpg pool created")

    # Idempotent migrations on every startup (additive only — CREATE TABLE
    # IF NOT EXISTS / ON CONFLICT DO NOTHING). Auth migration takes a
    # pg_advisory_xact_lock so concurrent cold-start replicas serialize
    # against each other. Anything destructive (ALTER, DROP) must be
    # applied manually via psql, not by adding to these files.
    await run_migrations(app.state.pool)
    logger.info("Core schema migrations applied")
    await run_auth_migrations(app.state.pool)
    logger.info("Auth schema migrations applied")

    # --- Gemini via Vertex AI IAM (ADC — no static key) ---
    # Used by the scan worker. Scan stays on Vertex because gemini-2.5-flash
    # (vision/JSON) is published there, and Vertex's GCS-URI image input
    # (Part.from_uri) saves us downloading bytes per request.
    app.state.genai = genai.Client(
        vertexai=True,
        project=settings.gcp_project,
        location=settings.gcp_region,
    )
    logger.info("Gemini Vertex client initialised (Vertex AI ADC)")

    # --- Gemini via AI Studio (static API key) ---
    # Used by the enhance / cleanup workers. Image-gen preview models
    # like gemini-3.1-flash-image-preview ship to AI Studio first and may
    # never reach Vertex's Publisher Models catalog. AI Studio requires a
    # static API key (mounted via Secret Manager as GEMINI_API_KEY) and
    # accepts image input only as inline base64 — see _enhance_with_gemini
    # which now downloads from GCS and inlines via Part.from_bytes.
    if settings.gemini_api_key:
        app.state.genai_aistudio = genai.Client(api_key=settings.gemini_api_key)
        logger.info("Gemini AI Studio client initialised (static API key)")
    else:
        app.state.genai_aistudio = None
        logger.warning(
            "GEMINI_API_KEY not set — enhance/cleanup Gemini calls will fail. "
            "Mount cleanshot-gemini-key:latest via Cloud Run --set-secrets."
        )

    # --- OpenAI (feature-flagged) ---
    if settings.scan_provider_openai:
        if not settings.openai_api_key:
            raise RuntimeError("SCAN_PROVIDER_OPENAI=true but OPENAI_API_KEY is not set")
        app.state.openai = openai.AsyncOpenAI(
            api_key=settings.openai_api_key,
            # Bumped 3 → 8 so the SDK's built-in 429 backoff can ride out
            # OpenAI's per-minute rate windows (Tier-1 gpt-image-2 is
            # capped at 5 input-images/min). Safety net on top of the
            # explicit rate limiter below.
            max_retries=8,
            # 300s budget. /v1/responses (scan, GPT-5.4) returns in ~5s
            # so the higher ceiling is harmless there, but /v1/images/edits
            # with quality="high" on full-res forklift photos was reliably
            # exceeding the prior 90s cap with zero successes in a run of
            # 12 attempts. Cloud Run task timeout is 900s so we have
            # headroom; once Phase 3 input-resize-to-2048 ships, this can
            # come back down.
            timeout=300.0,
        )
        logger.info("OpenAI client initialised (gpt-5.4 scan provider)")
    else:
        app.state.openai = None

    # --- Anthropic (feature-flagged) ---
    if settings.scan_provider_anthropic:
        if not settings.anthropic_api_key:
            raise RuntimeError("SCAN_PROVIDER_ANTHROPIC=true but ANTHROPIC_API_KEY is not set")
        app.state.anthropic = anthropic.AsyncAnthropic(
            api_key=settings.anthropic_api_key,
            max_retries=3,
            timeout=90.0,
        )
        logger.info("Anthropic client initialised (claude-sonnet-4-6 / opus-4-7 scan provider)")
    else:
        app.state.anthropic = None

    # --- Valkey (Memorystore for Valkey 9.0) ---
    app.state.valkey = valkey_client.from_url(
        settings.valkey_url,
        decode_responses=True,
        socket_connect_timeout=2,
        socket_timeout=2,
    )
    logger.info("Valkey client initialised (%s)", settings.valkey_url)

    # --- Gemini Pro Image concurrency semaphore ---
    # Layer 3 throttle: max concurrent Gemini calls per Cloud Run instance.
    # Layer 1: Cloud Tasks max_concurrent_dispatches (global cap).
    # Layer 2: Cloud Run max-instances (per deploy-api.yml).
    # Bumped 2 → 4 to roughly halve batch wall-clock time. Vertex AI quota
    # is the next ceiling; back off here if you start seeing 429s.
    app.state.gemini_semaphore = asyncio.Semaphore(4)

    # --- OpenAI image-edit rate limiter ---
    # OpenAI Tier-1 gpt-image-2 caps /v1/images/edits at 5 input-images
    # per minute per organisation. The limiter serialises enhance jobs
    # through a 5-per-60s sliding window so 10-image batches queue
    # instead of erroring with 429. See services/rate_limit.py for the
    # cross-instance caveat (it's process-local; bump to Valkey-backed
    # if max-instances > 1 and you run heavy OpenAI batches).
    app.state.openai_image_rate_limiter = AsyncRateLimiter(
        max_events=5,
        interval_seconds=60.0,
        name="openai_image_edit",
    )

    logger.info("CleanShot API ready")
    yield

    # --- Cleanup ---
    logger.info("CleanShot API shutting down")
    await app.state.pool.close()

    # google-genai 1.75.0 async close
    try:
        await app.state.genai.aio.aclose()
    except Exception:
        pass
    try:
        app.state.genai.close()
    except Exception:
        pass

    if app.state.openai:
        await app.state.openai.close()
    if app.state.anthropic:
        await app.state.anthropic.close()
    await app.state.valkey.aclose()
    logger.info("CleanShot API shutdown complete")


app = FastAPI(
    title="CleanShot API",
    version="2.5.0",
    description="AI-powered forklift image processing backend",
    lifespan=lifespan,
    # Disable the default /docs in production to reduce attack surface
    docs_url="/docs" if os.getenv("ENVIRONMENT") != "production" else None,
    redoc_url=None,
)

# ---------------------------------------------------------------------------
# CORS
# Configure allowlist explicitly — never use wildcard in production.
# Add preview deploy patterns for Vercel (*.vercel.app).
# ---------------------------------------------------------------------------
_settings = get_settings()
_ALLOWED_ORIGINS = [
    "https://cleanshot.vercel.app",
    "https://cleanshot.discountmedia.com",
]
if _settings.is_local:
    _ALLOWED_ORIGINS += ["http://localhost:3000", "http://127.0.0.1:3000"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_ALLOWED_ORIGINS,
    allow_origin_regex=r"https://cleanshot-.*\.vercel\.app",  # Preview deploys
    allow_credentials=True,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "X-Api-Key", "Authorization"],
)

# ---------------------------------------------------------------------------
# Routers
# ---------------------------------------------------------------------------
app.include_router(sessions.router)
app.include_router(jobs.router)
app.include_router(operations.router)
app.include_router(upload.router)
app.include_router(projects.router)
app.include_router(export.router)
app.include_router(scan_results.router)
app.include_router(approvals.router)
app.include_router(worker.router)


# ---------------------------------------------------------------------------
# Health check — unauthenticated (Cloud Run requires a working health endpoint)
# ---------------------------------------------------------------------------
@app.get("/health", tags=["health"])
async def health() -> dict:
    return {"status": "ok", "version": "2.5.0"}
