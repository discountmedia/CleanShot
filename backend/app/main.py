"""
CleanShot Backend — FastAPI application entrypoint.

Lifespan:
  - Connects Redis (for /jobs reads + asset/session storage)
  - Connects Arq pool (for enqueueing jobs to the worker)
  - Pre-warms Gemini SDK client
  - Builds StorageService and SessionService
"""

import structlog
from contextlib import asynccontextmanager

from arq import create_pool
from arq.connections import RedisSettings
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from redis.asyncio import Redis

from app.config import settings
from app.api import health, sessions, assets, condition, jobs
from app.services import gemini
from app.services.session import SessionService
from app.services.storage import StorageService


# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

structlog.configure(
    processors=[
        structlog.stdlib.filter_by_level,
        structlog.stdlib.add_logger_name,
        structlog.stdlib.PositionalArgumentsFormatter(),
        structlog.processors.TimeStamper(fmt="ISO"),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.JSONRenderer(),
    ],
    logger_factory=structlog.stdlib.LoggerFactory(),
    wrapper_class=structlog.stdlib.BoundLogger,
    cache_logger_on_first_use=True,
)
logger = structlog.get_logger()


# ---------------------------------------------------------------------------
# Lifespan
# ---------------------------------------------------------------------------

@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info(
        "Starting CleanShot API",
        project=settings.gcp_project_id,
        model=settings.gemini_model,
        region=settings.gcp_location,
    )

    # Redis (used by SessionService for hash reads/writes)
    app.state.redis = Redis.from_url(settings.redis_url, decode_responses=False)
    await app.state.redis.ping()  # fail fast if Redis is unreachable

    # Arq pool (used by /enhance to enqueue jobs)
    app.state.arq_pool = await create_pool(
        RedisSettings.from_dsn(settings.redis_url)
    )

    # Services
    app.state.storage_service = StorageService()
    app.state.session_service = SessionService(app.state.redis)

    # Pre-warm Gemini client (saves ~150ms on the first /enhance call)
    gemini.get_client()

    logger.info("CleanShot API ready")
    yield

    logger.info("Shutting down CleanShot API")
    await app.state.arq_pool.aclose()
    await app.state.redis.aclose()


# ---------------------------------------------------------------------------
# App
# ---------------------------------------------------------------------------

app = FastAPI(
    title="CleanShot Backend",
    description="Multi-tool forklift image processing on Gemini 2.5 Flash Image",
    version="2.2.0",
    lifespan=lifespan,
)


# CORS — locked down to known origins. Add Vercel URLs when frontend deploys.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:3000",   # local Vite dev
        "http://localhost:5173",   # Vite default port
        # "https://cleanshot.app", # production frontend (uncomment when live)
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ---------------------------------------------------------------------------
# Routes (all v1 under /api/v1)
# ---------------------------------------------------------------------------

# Health endpoints at root (Cloud Run / Dockerfile expect /healthz, /readyz)
app.include_router(health.router)

# Versioned API
app.include_router(sessions.router, prefix="/api/v1")
app.include_router(assets.router, prefix="/api/v1")
app.include_router(condition.router, prefix="/api/v1")
app.include_router(jobs.router, prefix="/api/v1")


@app.get("/", tags=["meta"])
async def root():
    return {
        "service": "CleanShot Backend",
        "version": "2.2.0",
        "model": settings.gemini_model,
        "docs": "/docs",
    }


# Local dev entrypoint: `python -m app.main`
if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "app.main:app",
        host=settings.api_host,
        port=settings.api_port,
        log_level=settings.log_level.lower(),
        reload=True,
    )
