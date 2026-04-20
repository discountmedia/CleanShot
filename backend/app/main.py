"""
CleanShot Backend - Main FastAPI Application
Sets up the API server with dependency injection and lifespan management.
"""

import structlog
from contextlib import asynccontextmanager
from fastapi import FastAPI, Depends
from google import genai

from app.config import settings
from app.api import health
# TODO: Enable these imports once the endpoints are fully implemented
# from app.api import jobs, condition
from app.services.gemini import GeminiService
from app.services.storage import StorageService
from app.services.session import SessionService


# Configure structured logging
structlog.configure(
    processors=[
        structlog.stdlib.filter_by_level,
        structlog.stdlib.add_logger_name,
        structlog.stdlib.PositionalArgumentsFormatter(),
        structlog.processors.TimeStamper(fmt="ISO"),
        structlog.processors.StackInfoRenderer(),
        structlog.processors.JSONRenderer()
    ],
    logger_factory=structlog.stdlib.LoggerFactory(),
    wrapper_class=structlog.stdlib.BoundLogger,
    cache_logger_on_first_use=True,
)

logger = structlog.get_logger()


class AppState:
    """Global application state container."""
    gemini_client: genai.Client = None
    gemini_service: GeminiService = None
    storage_service: StorageService = None
    session_service: SessionService = None


app_state = AppState()


@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Application lifespan manager.
    Initialize services on startup, cleanup on shutdown.
    """
    logger.info("Starting CleanShot backend", 
                gcp_project=settings.gcp_project_id,
                gemini_model=settings.gemini_model)
    
    # Initialize Gemini client (once per app lifetime, not per request)
    app_state.gemini_client = genai.Client(
        vertexai=settings.use_vertex_ai,
        project=settings.gcp_project_id,
        location=settings.gcp_location
    )
    
    # Initialize services with dependency injection
    app_state.storage_service = StorageService()
    app_state.session_service = SessionService()
    app_state.gemini_service = GeminiService(
        client=app_state.gemini_client,
        storage_service=app_state.storage_service
    )
    
    logger.info("CleanShot backend initialized successfully")
    
    yield  # App runs here
    
    # Cleanup
    logger.info("Shutting down CleanShot backend")
    if app_state.gemini_client:
        app_state.gemini_client.close()
        if hasattr(app_state.gemini_client, 'aio'):
            await app_state.gemini_client.aio.aclose()


# Create FastAPI app with lifespan management
app = FastAPI(
    title="CleanShot Backend",
    description="Multi-tool forklift image processing pipeline built on Gemini 2.5 Flash Image",
    version="2.1.0",
    lifespan=lifespan
)


# ═══════════════════════════════════════════════════════════════════
#  Dependency Injection Functions
# ═══════════════════════════════════════════════════════════════════

def get_gemini_service() -> GeminiService:
    """Dependency: Get the Gemini service instance."""
    return app_state.gemini_service


def get_storage_service() -> StorageService:
    """Dependency: Get the storage service instance."""
    return app_state.storage_service


def get_session_service() -> SessionService:
    """Dependency: Get the session service instance."""
    return app_state.session_service


# ═══════════════════════════════════════════════════════════════════
#  API Routes
# ═══════════════════════════════════════════════════════════════════

# Health check
app.include_router(health.router, prefix="/health", tags=["health"])

# TODO: Enable these routers once the endpoints are fully implemented
# Job status and progress (SSE endpoint)
# app.include_router(jobs.router, prefix="/api/v1/jobs", tags=["jobs"])

# Condition enhancement pipeline  
# app.include_router(condition.router, prefix="/api/v1/condition", tags=["condition"])


@app.get("/")
async def root():
    """Root endpoint - basic info about the API."""
    return {
        "service": "CleanShot Backend",
        "version": "2.1.0",
        "status": "running",
        "gemini_model": settings.gemini_model,
        "docs": "/docs"
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(
        "app.main:app",
        host=settings.api_host,
        port=settings.api_port,
        log_level=settings.log_level.lower(),
        reload=True
    )
