"""
Arq Worker Configuration
Sets up background job processing for CleanShot enhancement pipeline.
"""

import structlog
from arq import create_pool
from arq.connections import RedisSettings
from google import genai

from app.config import settings
from app.services.gemini import GeminiService
from app.services.storage import StorageService


logger = structlog.get_logger()


async def condition_enhancement_job(
    ctx, 
    image_gcs_uri: str, 
    enhancement_level: str = "moderate",
    job_id: str = None
):
    """
    Background job for condition enhancement processing.
    
    Args:
        ctx: Arq job context
        image_gcs_uri: GCS URI of image to process
        enhancement_level: "light", "moderate", or "heavy"
        job_id: Unique job identifier for progress tracking
    """
    logger.info("Starting condition enhancement job", 
                job_id=job_id,
                image_uri=image_gcs_uri,
                level=enhancement_level)
    
    try:
        # Initialize services
        gemini_client = genai.Client(
            vertexai=settings.use_vertex_ai,
            project=settings.gcp_project_id,
            location=settings.gcp_location
        )
        
        storage_service = StorageService()
        gemini_service = GeminiService(
            client=gemini_client,
            storage_service=storage_service
        )
        
        # Update job progress: started
        await ctx['redis'].hset(
            f"job:{job_id}",
            mapping={
                "status": "processing",
                "progress": 10,
                "step": "Initializing enhancement pipeline"
            }
        )
        
        # Update job progress: AI processing
        await ctx['redis'].hset(
            f"job:{job_id}",
            mapping={
                "progress": 30,
                "step": "Calling Gemini 2.5 Flash Image"
            }
        )
        
        # Perform the enhancement
        enhanced_uri = await gemini_service.enhance_forklift_condition(
            image_gcs_uri=image_gcs_uri,
            enhancement_level=enhancement_level
        )
        
        # Update job progress: completed
        await ctx['redis'].hset(
            f"job:{job_id}",
            mapping={
                "status": "completed",
                "progress": 100,
                "step": "Enhancement complete",
                "result_uri": enhanced_uri
            }
        )
        
        logger.info("Condition enhancement job completed",
                    job_id=job_id,
                    enhanced_uri=enhanced_uri)
        
        # Cleanup
        gemini_client.close()
        if hasattr(gemini_client, 'aio'):
            await gemini_client.aio.aclose()
            
        return enhanced_uri
        
    except Exception as e:
        logger.error("Condition enhancement job failed",
                     job_id=job_id,
                     error=str(e))
        
        # Update job progress: failed
        await ctx['redis'].hset(
            f"job:{job_id}",
            mapping={
                "status": "failed",
                "progress": 0,
                "step": f"Error: {str(e)}"
            }
        )
        
        raise


async def startup(ctx):
    """Worker startup function - called when worker boots."""
    logger.info("CleanShot worker starting up")
    

async def shutdown(ctx):
    """Worker shutdown function - called when worker shuts down."""
    logger.info("CleanShot worker shutting down")


# Arq worker settings
class WorkerSettings:
    """
    Arq worker configuration for CleanShot.
    Optimized for bursty workloads with auto-scaling.
    """
    
    # Redis connection
    redis_settings = RedisSettings.from_dsn(settings.redis_url)
    
    # Job functions that workers can execute
    functions = [
        condition_enhancement_job,
    ]
    
    # Worker behavior
    on_startup = startup
    on_shutdown = shutdown
    
    # Performance settings based on "10 simultaneously" requirement
    max_jobs = 10  # Process up to 10 jobs simultaneously per worker
    job_timeout = settings.job_timeout_seconds  # 5 minutes per job
    keep_result = 3600  # Keep job results for 1 hour
    
    # Health check settings
    health_check_interval = 30
    
    # Logging
    log_results = True
    
    # Queue name for organizing different job types
    queue_name = "cleanshot:enhancement"
