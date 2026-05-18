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

Models per v2.5 spec:
  Generation / Cleanup:  gemini-2.5-flash-image
  Scan (Gemini):         gemini-2.5-flash-image
  Scan (OpenAI):         gpt-5.4
  Scan (Anthropic std):  claude-sonnet-4-6
  Scan (Anthropic hard): claude-opus-4-7
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

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"))
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    settings = get_settings()
    logger.info("Starting CleanShot API (env=%s)", settings.environment)

    # --- Database ---
    app.state.pool = await create_pool(settings.database_url)
    logger.info("asyncpg pool created")

    # Run idempotent migrations on startup (local/dev only in prod use Alembic)
    if settings.is_local:
        await run_migrations(app.state.pool)
        logger.info("Schema migrations applied")

    # --- Gemini via Vertex AI IAM (ADC — no static key) ---
    app.state.genai = genai.Client(
        vertexai=True,
        project=settings.gcp_project,
        location=settings.gcp_region,
    )
    logger.info("Gemini client initialised (Vertex AI ADC)")

    # --- OpenAI (feature-flagged) ---
    if settings.scan_provider_openai:
        if not settings.openai_api_key:
            raise RuntimeError("SCAN_PROVIDER_OPENAI=true but OPENAI_API_KEY is not set")
        app.state.openai = openai.AsyncOpenAI(
            api_key=settings.openai_api_key,
            max_retries=3,
            timeout=90.0,
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
    # Layer 3 throttle: max 2 concurrent calls per Cloud Run instance.
    # Layer 1: Cloud Tasks max_concurrent_dispatches (global cap).
    # Layer 2: Cloud Run max-instances=1 at Tier 1.
    app.state.gemini_semaphore = asyncio.Semaphore(2)

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
