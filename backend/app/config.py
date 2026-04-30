"""
CleanShot Backend Configuration
Pydantic settings loaded from environment variables.

In Cloud Run: env vars come from --set-env-vars / --set-secrets on deploy
In local docker-compose: env vars come from the compose `environment:` block
In local Windows venv: env vars come from a `.env` file at repo root
"""

from pydantic import Field
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """Application settings loaded from environment variables."""

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        case_sensitive=False,
    )

    # --- GCP project & region ---
    gcp_project_id: str = Field(default="cleanshot-493512")
    gcp_location: str = Field(default="us-central1")

    # --- Gemini ---
    # GA model ID; the -preview suffix was retired Jan 2026
    gemini_model: str = Field(default="gemini-2.5-flash-image")
    use_vertex_ai: bool = Field(default=True)

    # --- Storage buckets ---
    # Must match the buckets created in Phase 4 setup.
    # Customer-uploaded source images land in originals (versioned).
    # All Gemini outputs / resize outputs land in derivatives (unversioned, 30d lifecycle).
    gcs_originals_bucket: str = Field(default="cleanshot-originals-prod")
    gcs_derivatives_bucket: str = Field(default="cleanshot-derivatives-prod")
    # Phase 1 reference dataset; read-only
    gcs_references_bucket: str = Field(default="cleanshot-training-df-2026")

    # --- Redis ---
    # Local: redis://redis:6379/0 (compose) or redis://localhost:6379/0 (host)
    # Cloud Run: redis://10.46.32.3:6379/0 (Memorystore private IP)
    redis_url: str = Field(default="redis://localhost:6379/0")

    # --- Service account email ---
    # Used for IAM-based signed URL generation (no private key needed).
    # On Cloud Run this is the attached service account.
    # Locally, set this to the SA that your `gcloud auth application-default login`
    # principal can impersonate (or skip and use compose-mounted creds).
    gcp_service_account_email: str = Field(
        default="forklift-api@cleanshot-493512.iam.gserviceaccount.com"
    )

    # --- API ---
    api_host: str = Field(default="0.0.0.0")
    api_port: int = Field(default=8000)
    log_level: str = Field(default="INFO")

    # --- Session & TTLs ---
    session_ttl_seconds: int = Field(default=86400)        # 24 hours
    job_ttl_seconds: int = Field(default=604800)           # 7 days
    asset_ttl_seconds: int = Field(default=604800)         # 7 days
    signed_url_ttl_seconds: int = Field(default=900)       # 15 minutes

    # --- Job queue ---
    job_timeout_seconds: int = Field(default=480)          # 8 min per image job
    max_jobs_per_worker: int = Field(default=8)
    max_upload_bytes: int = Field(default=25 * 1024 * 1024)  # 25 MB per image

    # --- Queue name (single queue for v1, split when video lands in Phase 4.5) ---
    image_queue_name: str = Field(default="image_queue")


# Global settings instance — import this everywhere
settings = Settings()
