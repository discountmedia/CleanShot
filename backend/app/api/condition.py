"""
Condition Enhancement API endpoints
"""

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
import structlog

from app.services.gemini import GeminiService

logger = structlog.get_logger()
router = APIRouter()


class EnhancementRequest(BaseModel):
    """Request model for condition enhancement."""
    image_uri: str
    enhancement_level: str = "moderate"
    

class EnhancementResponse(BaseModel):
    """Response model for enhancement job submission."""
    job_id: str
    status: str


@router.post("/enhance")
async def enhance_condition(
    request: EnhancementRequest,
    gemini_service: GeminiService = Depends()
) -> EnhancementResponse:
    """
    Submit a condition enhancement job.
    Returns immediately with job_id for tracking progress via SSE.
    """
    
    logger.info("Enhancement job requested", 
                image_uri=request.image_uri,
                level=request.enhancement_level)
    
    # TODO: Queue job with Arq, return job_id
    job_id = "placeholder_job_id"
    
    return EnhancementResponse(
        job_id=job_id,
        status="queued"
    )
