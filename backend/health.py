"""
Health Check Endpoint
Simple health check for the CleanShot API.
"""

from fastapi import APIRouter, HTTPException
import structlog

logger = structlog.get_logger()
router = APIRouter()


@router.get("/")
async def health_check():
    """
    Health check endpoint for load balancers and monitoring.
    Returns basic service status.
    """
    try:
        return {
            "status": "healthy",
            "service": "cleanshot-api",
            "version": "2.1.0"
        }
    except Exception as e:
        logger.error("Health check failed", error=str(e))
        raise HTTPException(status_code=503, detail="Service unhealthy")


@router.get("/ready")
async def readiness_check():
    """
    Readiness check - verifies all dependencies are available.
    Used by Kubernetes/Cloud Run for traffic routing.
    """
    try:
        # TODO: Add checks for Redis, GCS connectivity when we implement those
        return {
            "status": "ready",
            "dependencies": {
                "redis": "not_implemented",
                "gcs": "not_implemented"
            }
        }
    except Exception as e:
        logger.error("Readiness check failed", error=str(e))
        raise HTTPException(status_code=503, detail="Service not ready")
