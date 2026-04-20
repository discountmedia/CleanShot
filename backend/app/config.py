"""
CleanShot Backend Configuration
Pydantic settings for environment variables and app config.
"""

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""
    
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore"
    )
    
    # ═══ GCP Configuration ═══════════════════════════════════════════
    gcp_project_id: str = Field(default="cleanshot-493512")
    gcp_location: str = Field(default="us-central1")
    google_application_credentials: str = Field(
        default="/app/credentials/forklift-pipeline.json"
    )
    
    # ═══ Gemini Configuration ════════════════════════════════════════
    gemini_model: str = Field(default="gemini-2.5-flash-image")
    use_vertex_ai: bool = Field(default=True)
    
    # ═══ Storage Configuration ═══════════════════════════════════════
    gcs_sessions_bucket: str = Field(default="cleanshot-sessions-df-2026")
    gcs_references_bucket: str = Field(default="cleanshot-training-df-2026")
    
    # ═══ Redis Configuration ═════════════════════════════════════════
    redis_url: str = Field(default="redis://localhost:6379/0")
    
    # ═══ API Configuration ═══════════════════════════════════════════
    api_host: str = Field(default="0.0.0.0")
    api_port: int = Field(default=8000)
    log_level: str = Field(default="INFO")
    
    # ═══ Session Behavior ════════════════════════════════════════════
    session_ttl_seconds: int = Field(default=86400)  # 24 hours
    signed_url_ttl_seconds: int = Field(default=900)  # 15 minutes
    
    # ═══ Performance Settings ════════════════════════════════════════
    # Based on "10 simultaneously" requirement for bursty workloads
    max_concurrent_jobs: int = Field(default=10)
    job_timeout_seconds: int = Field(default=300)  # 5 minutes per job max


# Global settings instance
settings = Settings()
