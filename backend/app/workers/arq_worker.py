"""
Arq Worker — single image queue for v1.

v2.3: Toggleable brand rules in enhance.
v2.4: Adds 'scan' operation for multi-provider artifact detection.

Job lifecycle:
  1. API enqueues 'process_image' with stable _job_id (idempotency)
  2. Worker reads asset metadata from Redis
  3. Worker calls the right service (gemini.enhance_image or scan.scan_image)
  4. Worker writes result (image or JSON) and updates job hash
  5. API's GET /jobs/{id} polls that hash
"""

import json
import time
import structlog
from typing import Optional

from arq.connections import RedisSettings
from redis.asyncio import Redis
from google.cloud import storage as gcs

from app.config import settings
from app.services import gemini, scan as scan_service
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
    apply_fork_paint: bool = True,
    apply_tire_shine: bool = True,
    apply_rust_removal: bool = True,
    extra_instructions: Optional[str] = None,
):
    """
    Single worker function handling all image operations:
      - operation="enhance" -> gemini.enhance_image() with toggleable brand rules
      - operation="scan"    -> scan.scan_image() multi-provider artifact detection
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

        if operation == "enhance":
            await _progress(15, "Calling Gemini (enhance)")

            image_bytes = await gemini.enhance_image(
                image_gcs_uri=gcs_uri,
                mime_type=mime_type,
                enhancement_level=enhancement_level,
                apply_fork_paint=apply_fork_paint,
                apply_tire_shine=apply_tire_shine,
                apply_rust_removal=apply_rust_removal,
                extra_instructions=extra_instructions,
            )

            await _progress(80, "Writing result to GCS")
            derivative_uri = storage_svc.save_derivative(
                image_data=image_bytes,
                original_uri=gcs_uri,
                operation=operation,
                mime_type="image/png",
            )

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
            log.info("Enhance job complete", derivative_uri=derivative_uri)
            return derivative_uri

        elif operation == "scan":
            await _progress(15, "Downloading image bytes")
            image_bytes = _download_gcs_bytes(gcs_uri)

            await _progress(30, "Calling Gemini + OpenAI + Anthropic (scan)")
            scan_result = await scan_service.scan_image(
                image_gcs_uri=gcs_uri,
                image_bytes=image_bytes,
                mime_type=mime_type,
            )

            await _progress(95, "Storing scan results")
            # Scan output is JSON, not an image. Store inline in Redis hash.
            await redis.hset(
                f"job:{job_id}",
                mapping={
                    "status": "done",
                    "progress": 100,
                    "message": "Complete",
                    "scan_result": json.dumps(scan_result),
                    "updated_at": time.time(),
                },
            )
            await redis.expire(f"job:{job_id}", settings.job_ttl_seconds)
            log.info("Scan job complete",
                     verdict=scan_result.get("verdict"),
                     source=scan_result.get("source"))
            return scan_result

        else:
            raise ValueError(f"Unknown operation: {operation!r}")

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
# Helpers
# -----------------------------------------------------------------------------

_gcs_client: Optional[gcs.Client] = None


def _download_gcs_bytes(gcs_uri: str) -> bytes:
    """Download an object's bytes given a gs://bucket/key URI."""
    global _gcs_client
    if _gcs_client is None:
        _gcs_client = gcs.Client()
    if not gcs_uri.startswith("gs://"):
        raise ValueError(f"Expected gs:// URI, got: {gcs_uri}")
    without_scheme = gcs_uri[5:]
    bucket_name, _, blob_name = without_scheme.partition("/")
    bucket = _gcs_client.bucket(bucket_name)
    blob = bucket.blob(blob_name)
    return blob.download_as_bytes()


# -----------------------------------------------------------------------------
# Lifecycle
# -----------------------------------------------------------------------------

async def startup(ctx):
    logger.info("Worker starting up")
    ctx["redis_pool"] = Redis.from_url(settings.redis_url, decode_responses=False)
    ctx["session_service"] = SessionService(ctx["redis_pool"])
    ctx["storage_service"] = StorageService()
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
    redis_settings = RedisSettings.from_dsn(settings.redis_url)
    functions = [process_image]
    on_startup = startup
    on_shutdown = shutdown
    queue_name = settings.image_queue_name
    max_jobs = settings.max_jobs_per_worker
    job_timeout = settings.job_timeout_seconds
    keep_result = settings.job_ttl_seconds
    max_tries = 3
    health_check_interval = 30
    log_results = True
