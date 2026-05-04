"""
Arq Worker — single image queue for v1.

Job lifecycle:
  1. API enqueues 'process_image' with stable _job_id (idempotency)
  2. Worker reads asset metadata from Redis
  3. Worker calls Gemini, writes result to derivatives bucket
  4. Worker updates job:{id} hash with progress at each step
  5. API's GET /jobs/{id} polls that hash

Splitting into two queues (image + video) happens in Phase 4.5 when
Veo lands. For v1 launch, one queue is enough.
"""

import time
import structlog
from typing import Optional

from arq.connections import RedisSettings
from redis.asyncio import Redis

from app.config import settings
from app.services import gemini
from app.services.storage import StorageService
from app.services.session import SessionService


logger = structlog.get_logger()


# -----------------------------------------------------------------------------
# Job functions
# -----------------------------------------------------------------------------

async def process_image(
    ctx,
    *,
    asset_id: str,
    operation: str,
    enhancement_level: str = "moderate",
):
    """
    The single v1 worker function. Currently handles 'enhance';
    'clean' and 'resize' will be added as additional operation values.

    Args:
        ctx: Arq job context (contains 'redis', 'job_id', etc.)
        asset_id: ID of the asset to process (resolves to GCS URI via Redis)
        operation: "enhance" (more added later)
        enhancement_level: "light" | "moderate" | "heavy" (only used for enhance)
    """
    job_id = ctx["job_id"]
    redis: Redis = ctx["redis_pool"]
    session_svc: SessionService = ctx["session_service"]
    storage_svc: StorageService = ctx["storage_service"]

    log = logger.bind(job_id=job_id, asset_id=asset_id, operation=operation)
    log.info("Worker picked up job")

    async def _progress(pct: int, msg: str, status: str = "running"):
        await redis.hset(
            f"job:{job_id}",
            mapping={
                "status": status,
                "progress": pct,
                "message": msg,
                "updated_at": time.time(),
            },
        )
        await redis.expire(f"job:{job_id}", settings.job_ttl_seconds)

    try:
        await _progress(5, "Loading asset metadata")
        asset = await session_svc.get_asset(asset_id)
        if not asset:
            raise ValueError(f"Asset not found: {asset_id}")

        gcs_uri = asset["gcs_uri"]
        mime_type = asset.get("mime_type", "image/jpeg")

        await _progress(15, f"Calling Gemini ({operation})")

        if operation == "enhance":
            image_bytes = await gemini.enhance_image(
                image_gcs_uri=gcs_uri,
                mime_type=mime_type,
                enhancement_level=enhancement_level,
            )
        else:
            raise ValueError(f"Unknown operation: {operation!r}")

        await _progress(80, "Writing result to GCS")

        # Gemini 2.5 Flash Image returns PNG by default
        derivative_uri = storage_svc.save_derivative(
            image_data=image_bytes,
            original_uri=gcs_uri,
            operation=operation,
            mime_type="image/png",
        )

        # Final state — frontend stops polling on status in {done, failed}
        await redis.hset(
            f"job:{job_id}",
            mapping={
                "status": "done",
                "progress": 100,
                "message": "Complete",
                "result_uri": derivative_uri,
                "updated_at": time.time(),
            },
        )
        await redis.expire(f"job:{job_id}", settings.job_ttl_seconds)

        log.info("Job complete", derivative_uri=derivative_uri)
        return derivative_uri

    except Exception as exc:
        log.exception("Job failed")
        await redis.hset(
            f"job:{job_id}",
            mapping={
                "status": "failed",
                "message": f"Error: {type(exc).__name__}: {exc}",
                "updated_at": time.time(),
            },
        )
        await redis.expire(f"job:{job_id}", settings.job_ttl_seconds)
        raise


# -----------------------------------------------------------------------------
# Lifecycle
# -----------------------------------------------------------------------------

async def startup(ctx):
    """Initialize per-worker shared state (services, Redis pool, etc.)."""
    logger.info("Worker starting up")
    # Build a Redis client for the worker to write progress hashes.
    # ctx['redis'] is Arq's own pool; we add ours for clarity.
    ctx["redis_pool"] = Redis.from_url(settings.redis_url, decode_responses=False)
    ctx["session_service"] = SessionService(ctx["redis_pool"])
    ctx["storage_service"] = StorageService()
    # Pre-warm the Gemini client (saves ~150ms on the first job)
    gemini.get_client()
    logger.info("Worker ready")


async def shutdown(ctx):
    logger.info("Worker shutting down")
    pool: Optional[Redis] = ctx.get("redis_pool")
    if pool is not None:
        await pool.aclose()


# -----------------------------------------------------------------------------
# Arq WorkerSettings
# -----------------------------------------------------------------------------

class WorkerSettings:
    """Arq config — pointed at by the Dockerfile.worker CMD."""

    redis_settings = RedisSettings.from_dsn(settings.redis_url)

    functions = [process_image]

    on_startup = startup
    on_shutdown = shutdown

    queue_name = settings.image_queue_name
    max_jobs = settings.max_jobs_per_worker
    job_timeout = settings.job_timeout_seconds
    keep_result = settings.job_ttl_seconds  # 7 days
    max_tries = 3  # Arq's worker-process retries (separate from SDK retries)
    health_check_interval = 30
    log_results = True
