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
    # Service account email — used for IAM-based GCS signed URL generation on Cloud Run
    service_account_email: str = Field(
        "forklift-api@cleanshot-493512.iam.gserviceaccount.com",
        alias="SERVICE_ACCOUNT_EMAIL",
    )

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
    # Dedicated queue for media-auditor photo copies. NOT cleanshot-image-gen:
    # that queue dispatches at 1.5/s and a 60-job enhance batch sitting in front
    # of an 8-photo import would stall the import for minutes, which defeats
    # "photos appear as they land". Copies are cheap (HTTP GET + GCS write), so
    # this queue wants a high dispatch rate.
    # OPERATOR PREREQUISITE — create it before this ships:
    #   gcloud tasks queues create cleanshot-ingest-copy \
    #     --location=us-central1 --project=cleanshot-493512 \
    #     --max-dispatches-per-second=10 --max-concurrent-dispatches=20 \
    #     --max-attempts=3 --min-backoff=5s --max-backoff=60s
    tasks_queue_ingest: str = Field("cleanshot-ingest-copy", alias="TASKS_QUEUE_INGEST")
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
    # Black Forest Labs (FLUX) — image-edit provider opt-in. Mounted from
    # GCP Secret Manager (cleanshot-bfl-key) on Cloud Run; absent locally
    # unless the developer also sets BFL_API_KEY in their .env.
    bfl_api_key: str = Field("", alias="BFL_API_KEY")
    # xAI / Grok (https://api.x.ai) — image-edit provider via
    # /v1/images/edits with the grok-imagine-image-quality model.
    # Bearer-token auth. Mounted from GCP Secret Manager
    # (cleanshot-xai-key) on Cloud Run.
    xai_api_key: str = Field("", alias="XAI_API_KEY")
    # RunComfy (https://www.runcomfy.com) — proxies the Bytedance
    # Seedream-4.5/edit image-to-image model with an async submit →
    # poll → result flow. Bearer-token auth, image inputs are passed
    # by HTTPS URL (we mint a short-lived signed GCS GET URL). Mounted
    # from GCP Secret Manager (cleanshot-runcomfy-key) on Cloud Run.
    runcomfy_api_key: str = Field("", alias="RUNCOMFY_API_KEY")
    # Kontext tuning knob: when >= 0, every RunComfy/Kontext render reuses
    # this seed so a prompt change is the only variable between two outputs
    # (needed for the model-tuning phase). Default -1 omits the seed →
    # random per call, the right behaviour for production regenerate variety.
    # Transient if set via `gcloud run services update`; bake into
    # deploy-api.yml to persist across deploys (hard-won lesson #1).
    kontext_seed: int = Field(-1, alias="KONTEXT_SEED")
    # Google AI Studio API key — used for the enhance pipeline's Gemini
    # calls so we can access preview image-gen models (e.g.
    # gemini-3.1-flash-image-preview) that aren't yet published in this
    # project's Vertex AI catalog. Scan continues to use Vertex AI (IAM)
    # via the existing genai client; this key only feeds the second
    # AI-Studio-backed genai client built in main.py's lifespan.
    # Mounted from GCP Secret Manager (cleanshot-gemini-key) on Cloud Run.
    gemini_api_key: str = Field("", alias="GEMINI_API_KEY")
    # Ideogram (https://api.ideogram.ai) — used for the per-variant
    # Edit-with-prompt tool (POST /v1/edit, text-only sibling to Gemini
    # Tweak) and the Inpaint-with-prompt tool (POST /v1/ideogram-v3/inpaint,
    # mask-based sibling to Flux Erase). Sync API; the worker calls it
    # directly without async polling. Mounted from GCP Secret Manager
    # (cleanshot-ideogram-key) on Cloud Run.
    ideogram_api_key: str = Field("", alias="IDEOGRAM_API_KEY")
    # Reve (https://api.reve.com) — 6th primary enhance generator
    # (reinstated 2026-05-26 after a brief absence — operator preferred
    # it over Recraft on quality after re-evaluating both). Synchronous
    # /v1/image/edit endpoint with bearer-token auth and base64 JSON
    # image-in/image-out. Mounted from GCP Secret Manager
    # (cleanshot-reve-key) on Cloud Run.
    reve_api_key: str = Field("", alias="REVE_API_KEY")

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
