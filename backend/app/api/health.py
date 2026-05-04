"""
Health check endpoints.

/healthz       - Liveness  (Dockerfile HEALTHCHECK calls this)
/readyz        - Readiness (verifies Redis is reachable; Cloud Run uses this)
"""

from fastapi import APIRouter, HTTPException, Request
import structlog

logger = structlog.get_logger()
router = APIRouter()


@router.get("/healthz", tags=["health"])
async def liveness():
    """Cheap liveness check. No dependencies probed."""
    return {"status": "ok"}


@router.get("/readyz", tags=["health"])
async def readiness(request: Request):
    """
    Readiness check — verifies Redis connectivity.
    Cloud Run uses this to decide if traffic should route here.
    """
    redis = request.app.state.redis
    try:
        pong = await redis.ping()
        if not pong:
            raise RuntimeError("Redis PING returned falsy")
        return {"status": "ready", "redis": "ok"}
    except Exception as exc:
        logger.error("Readiness check failed", error=str(exc))
        raise HTTPException(status_code=503, detail=f"not ready: {exc}")
