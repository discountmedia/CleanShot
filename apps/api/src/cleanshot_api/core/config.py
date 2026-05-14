"""
Application settings.

All secrets arrive as environment variables injected by Cloud Run's
--set-secrets flag from Secret Manager. Never hardcode. Never log.
"""

from __future__ import annotations

from functools import lru_cache

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
    )

    # -------------------------------------------------------------------------
    # GCP
    # -------------------------------------------------------------------------
    gcp_project: str = Field("cleanshot-493512", alias="GCP_PROJECT")
    gcp_region: str = Field("us-central1", alias="GCP_REGION")

    # -------------------------------------------------------------------------
    # Cloud SQL (Postgres 17)
    # -------------------------------------------------------------------------
    # In Cloud Run: value is injected by --set-secrets DATABASE_URL=...
    # Locally: set in .env
    database_url: str = Field(..., alias="DATABASE_URL")

    # -------------------------------------------------------------------------
    # GCS buckets
    # -------------------------------------------------------------------------
    gcs_bucket_originals: str = Field(..., alias="GCS_BUCKET_ORIGINALS")
    gcs_bucket_derivatives: str = Field(..., alias="GCS_BUCKET_DERIVATIVES")

    # -------------------------------------------------------------------------
    # Valkey / Memorystore
    # -------------------------------------------------------------------------
    valkey_url: str = Field("valkey://localhost:6379", alias="VALKEY_URL")

    # -------------------------------------------------------------------------
    # Cloud Tasks
    # -------------------------------------------------------------------------
    tasks_queue_gen: str = Field("cleanshot-image-gen", alias="TASKS_QUEUE_GEN")
    tasks_queue_scan: str = Field("cleanshot-image-scan", alias="TASKS_QUEUE_SCAN")
    tasks_location: str = Field("us-central1", alias="TASKS_LOCATION")
    # OIDC service account email for Cloud Tasks → worker auth
    tasks_oidc_sa: str = Field(..., alias="TASKS_OIDC_SA")
    # Worker's own Cloud Run URL (target for Cloud Tasks dispatch)
    worker_url: str = Field(..., alias="WORKER_URL")

    # -------------------------------------------------------------------------
    # Internal API key (X-Api-Key header — Next.js BFF → FastAPI)
    # -------------------------------------------------------------------------
    api_key: str = Field(..., alias="API_KEY")
    api_key_prev: str = Field("", alias="API_KEY_PREV")  # Rotation: allow old key briefly

    # -------------------------------------------------------------------------
    # AI providers — only present when the feature flag is active
    # -------------------------------------------------------------------------
    # Gemini: no key needed — uses Vertex AI IAM / ADC
    scan_provider_openai: bool = Field(False, alias="SCAN_PROVIDER_OPENAI")
    scan_provider_anthropic: bool = Field(False, alias="SCAN_PROVIDER_ANTHROPIC")

    openai_api_key: str = Field("", alias="OPENAI_API_KEY")
    anthropic_api_key: str = Field("", alias="ANTHROPIC_API_KEY")

    # -------------------------------------------------------------------------
    # Operational
    # -------------------------------------------------------------------------
    log_level: str = Field("INFO", alias="LOG_LEVEL")
    environment: str = Field("production", alias="ENVIRONMENT")

    @field_validator("log_level")
    @classmethod
    def _validate_log_level(cls, v: str) -> str:
        allowed = {"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"}
        if v.upper() not in allowed:
            raise ValueError(f"LOG_LEVEL must be one of {allowed}")
        return v.upper()

    @property
    def is_local(self) -> bool:
        return self.environment == "local"

    @property
    def tasks_parent(self) -> str:
        return (
            f"projects/{self.gcp_project}"
            f"/locations/{self.tasks_location}"
            f"/queues/{self.tasks_queue_gen}"
        )

    @property
    def tasks_scan_parent(self) -> str:
        return (
            f"projects/{self.gcp_project}"
            f"/locations/{self.tasks_location}"
            f"/queues/{self.tasks_queue_scan}"
        )


@lru_cache(maxsize=1)
def get_settings() -> Settings:
    return Settings()  # type: ignore[call-arg]
