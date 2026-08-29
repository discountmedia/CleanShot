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
  Scan (Anthropic std):            claude-opus-5
  Scan (Anthropic hard):           claude-opus-5
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
    admin,
    approvals,
    export,
    ingest,
    jobs,
    modify,
    operations,
    profiles,
    projects,
    saved_prompts,
    scan_results,
    sessions,
    support,
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

    # Report whether this container can decode HEIC, because we cannot tell
    # from the Dockerfile. It installs Debian's libvips42, and whether that
    # build carries the libheif loader is a property of the package, not of
    # anything in this repo — so it is checked at boot rather than assumed.
    #
    # The BROWSER path does not depend on this: apps/web/lib/compress.ts
    # decodes HEIC client-side and uploads JPEG, so iPhone photos work either
    # way. What this decides is the API-KEY INGEST path (df-auto-edit and
    # media-auditor POST bytes straight to a signed URL, with no browser in
    # between). If a caller ever sends HEIC there, this line is the difference
    # between "add a conversion step" and "it already works".
    try:
        import pyvips

        _heif = pyvips.type_find("VipsOperation", "heifload") != 0
    except Exception:  # pragma: no cover - diagnostic only, never fatal
        _heif = False
    logger.info(
        "image codecs: HEIC/HEIF decode %s (browser uploads are converted "
        "client-side regardless; this governs the API-key ingest path)",
        "AVAILABLE" if _heif else "NOT available",
    )

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
            # Was 8, cut to 2 on 2026-08-27. Eight retries against the
            # 300s timeout below is a worst case near 40 minutes holding
            # one rate-limiter slot, and now that /worker/enhance runs
            # inline that worst case also blows through Cloud Run's 900s
            # request timeout and earns a Cloud Tasks retry on top. The
            # explicit rate limiter below - not SDK retries - is what
            # keeps us inside the Tier-1 5-input-images/min window.
            max_retries=2,
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
        logger.info("Anthropic client initialised (claude-opus-5 — scan, judge, prompt optimizer)")
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
    # Bumped 4 → 8 alongside the 1024px input downsize — smaller inputs
    # mean each call holds less memory and finishes faster, so we can
    # afford more in flight. AI Studio key's per-minute RPM is now the
    # binding ceiling (was Vertex quota); back off here if you see 429s.
    app.state.gemini_semaphore = asyncio.Semaphore(8)

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

    # --- fal.ai rate limiter ---
    # fal publishes no per-minute cap for model endpoints; concurrency is
    # account-tier dependent. This is a DEFENSIVE GUESS, not a measured
    # limit. It matters more than the other limiters because matting sits
    # INSIDE the enhance request now: a 429 here fails the whole job (a
    # cutout must never degrade to an opaque image), so back-pressure is
    # cheaper than a retry. Raise it once a real batch shows headroom.
    app.state.fal_rate_limiter = AsyncRateLimiter(
        max_events=8,
        interval_seconds=10.0,
        name="fal",
    )

    # --- xAI / Grok image-edit rate limiter ---
    # xAI doesn't publish a per-minute cap for /v1/images/edits, so this
    # is a DEFENSIVE GUESS, not a measured limit: 3 events per 30s, i.e.
    # steady-state ~6/min with a small burst of 3. It was originally set
    # to mirror the Reve limiter (since removed), which had been pulled
    # down to these numbers after the operator watched 7 requests in a
    # row succeed before 429s began. Retune against real burst behaviour
    # — at ~6/min this is nearly as slow as OpenAI's hard 5/min cap, so
    # it is a plausible throughput bottleneck, not a safe default to
    # leave unexamined.
    app.state.grok_image_rate_limiter = AsyncRateLimiter(
        max_events=3,
        interval_seconds=30.0,
        name="grok_image_edit",
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
app.include_router(ingest.router)
app.include_router(operations.router)
app.include_router(modify.router)
app.include_router(upload.router)
app.include_router(projects.router)
app.include_router(export.router)
app.include_router(scan_results.router)
app.include_router(approvals.router)
app.include_router(profiles.router)
app.include_router(saved_prompts.router)
app.include_router(support.router)
app.include_router(admin.router)
app.include_router(worker.router)


# ---------------------------------------------------------------------------
# Health check — unauthenticated (Cloud Run requires a working health endpoint)
# ---------------------------------------------------------------------------
@app.get("/health", tags=["health"])
async def health() -> dict:
    return {"status": "ok", "version": "2.5.0"}
