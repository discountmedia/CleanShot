"""
CleanShot domain models (Pydantic v2).

Schema mirrors the Postgres 17 spec from Phase 2 Playbook v2.5 exactly.
Every enum value is lowercase to match DB enum literals.
"""

from __future__ import annotations

import uuid
from datetime import datetime
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, Field, field_validator


# ---------------------------------------------------------------------------
# Enums — match Postgres enum literals verbatim
# ---------------------------------------------------------------------------


class OperationEnum(StrEnum):
    upload = "upload"
    enhance = "enhance"
    scan = "scan"
    cleanup = "cleanup"
    export = "export"


class JobStatusEnum(StrEnum):
    queued = "queued"
    processing = "processing"
    complete = "complete"
    failed = "failed"
    cancelled = "cancelled"


class VerdictEnum(StrEnum):
    pass_ = "pass"
    fail = "fail"


class ConsensusVerdictEnum(StrEnum):
    pass_ = "pass"
    fail = "fail"
    split = "split"


class PhotoTypeEnum(StrEnum):
    auction = "auction"
    studio = "studio"


class ScanProviderEnum(StrEnum):
    gemini = "gemini"
    openai = "openai"
    anthropic = "anthropic"


# ---------------------------------------------------------------------------
# DB row shapes (used as return types from DB layer)
# ---------------------------------------------------------------------------


class SessionRecord(BaseModel):
    id: uuid.UUID
    created_at: datetime
    last_seen_at: datetime


class ProjectRecord(BaseModel):
    id: uuid.UUID
    session_id: uuid.UUID
    title: str
    make: str
    year: int
    model: str
    tire_type: str
    capacity: str
    fuel_type: str
    username: str
    photo_type: PhotoTypeEnum
    saved_at: datetime | None = None
    created_at: datetime


class AssetRecord(BaseModel):
    id: uuid.UUID
    project_id: uuid.UUID | None
    session_id: uuid.UUID
    operation: OperationEnum
    gcs_uri: str
    content_hash: str
    created_at: datetime


class JobRecord(BaseModel):
    id: uuid.UUID
    session_id: uuid.UUID
    operation: OperationEnum
    status: JobStatusEnum
    input_asset_id: uuid.UUID
    output_asset_id: uuid.UUID | None = None
    cloud_tasks_name: str | None = None
    idempotency_key: str
    error: str | None = None
    created_at: datetime
    updated_at: datetime


class ScanResultRecord(BaseModel):
    id: uuid.UUID
    job_id: uuid.UUID
    asset_id: uuid.UUID
    provider: ScanProviderEnum
    verdict: VerdictEnum
    confidence: float
    anomalies: list[dict[str, Any]]
    summary: str
    latency_ms: int
    created_at: datetime


class ConsensusResultRecord(BaseModel):
    id: uuid.UUID
    job_id: uuid.UUID
    asset_id: uuid.UUID
    verdict: ConsensusVerdictEnum
    confidence: float
    provider_count: int
    pass_count: int
    fail_count: int
    unanimous: bool
    divergent_providers: list[str]
    merged_anomalies: list[dict[str, Any]]
    high_confidence_anomalies: list[dict[str, Any]]
    created_at: datetime


# ---------------------------------------------------------------------------
# Request / Response shapes for API layer
# ---------------------------------------------------------------------------


class CreateSessionResponse(BaseModel):
    session_id: uuid.UUID


class SignedUploadUrlRequest(BaseModel):
    filename: str
    content_type: str = "image/jpeg"
    session_id: uuid.UUID


class SignedUploadUrlResponse(BaseModel):
    upload_url: str          # V4 signed PUT URL
    asset_id: uuid.UUID      # Pre-minted asset row ID
    gcs_uri: str             # gs:// URI stored permanently


class SignedGetUrlResponse(BaseModel):
    url: str                 # V4 signed GET URL (1-hour expiry)
    expires_at: datetime


class EnhanceRequest(BaseModel):
    session_id: uuid.UUID
    asset_id: uuid.UUID
    toggles: EnhanceToggles
    # Image generation provider. Default = gemini (fast, cheap). "openai"
    # routes through gpt-image-1 (slower + costlier but sometimes better
    # on photorealism / awkward shots). Frontend exposes this as a single
    # "Use ChatGPT instead" checkbox.
    provider: Literal["gemini", "openai"] = "gemini"
    idempotency_key: str = Field(default_factory=lambda: str(uuid.uuid4()))


class EnhanceToggles(BaseModel):
    """
    7 enhancement toggles — must match frontend types.ts EnhanceToggles exactly.
    Field names are camelCase from the frontend; FastAPI/Pydantic receives them
    via JSON so the names must match the camelCase keys the frontend sends.
    We use model_config alias_generator or explicit aliases to accept camelCase.
    """
    model_config = {"populate_by_name": True}

    new_paint_job: bool = Field(False, alias="newPaintJob")
    remove_rust: bool = Field(False, alias="removeRust")
    restore_decals: bool = Field(False, alias="restoreDecals")
    remove_people: bool = Field(False, alias="removePeople")
    paint_forks_red_yellow_tips: bool = Field(False, alias="paintForksRedYellowTips")
    shine_tires: bool = Field(False, alias="shineTires")
    improve_lighting: bool = Field(False, alias="improveLighting")


class EnhanceResponse(BaseModel):
    job_id: uuid.UUID


class ScanBatchRequest(BaseModel):
    session_id: uuid.UUID
    asset_ids: list[uuid.UUID] = Field(min_length=1, max_length=50)
    idempotency_key: str = Field(default_factory=lambda: str(uuid.uuid4()))


class ScanBatchResponse(BaseModel):
    batch_id: uuid.UUID
    job_ids: list[uuid.UUID]


class CleanupBatchRequest(BaseModel):
    session_id: uuid.UUID
    asset_ids: list[uuid.UUID] = Field(min_length=1, max_length=50)
    anomaly_context: list[dict[str, Any]] | None = None  # Per-asset anomaly hints
    idempotency_key: str = Field(default_factory=lambda: str(uuid.uuid4()))


class CleanupBatchResponse(BaseModel):
    batch_id: uuid.UUID
    job_ids: list[uuid.UUID]
    eta_seconds: int          # Conservative ETA shown in QueueStatusBar


class SaveProjectRequest(BaseModel):
    """All 8 fields are required server-side — no field is optional after save."""
    session_id: uuid.UUID
    title: str = Field(min_length=1, max_length=200)
    make: str = Field(min_length=1, max_length=100)
    year: int = Field(ge=1900, le=2100)
    model: str = Field(min_length=1, max_length=100)
    tire_type: str = Field(min_length=1, max_length=100)
    capacity: str = Field(min_length=1, max_length=50)
    fuel_type: str = Field(min_length=1, max_length=50)
    username: str = Field(min_length=1, max_length=100)
    photo_type: PhotoTypeEnum


class SaveProjectResponse(BaseModel):
    project_id: uuid.UUID


class ExportFullsizeRequest(BaseModel):
    session_id: uuid.UUID
    asset_id: uuid.UUID


class ExportFullsizeResponse(BaseModel):
    url: str
    expires_at: datetime


class ExportProRequest(BaseModel):
    """PRO preset: 1024px, 7×5 crop, JPEG ≤100 kb."""
    session_id: uuid.UUID
    asset_ids: list[uuid.UUID] = Field(min_length=1, max_length=50)


class ExportCustomRequest(BaseModel):
    """Custom export — crop-not-letterbox enforced absolutely."""
    session_id: uuid.UUID
    asset_ids: list[uuid.UUID] = Field(min_length=1, max_length=50)
    width: int = Field(ge=100)
    height: int = Field(ge=100)
    quality: int = Field(ge=50, le=100)
    format: str = Field(default="jpeg", pattern="^(jpeg|png|webp|bmp|svg)$")


class ExportZipRequest(BaseModel):
    session_id: uuid.UUID
    asset_ids: list[uuid.UUID] = Field(min_length=1, max_length=200)


# ---------------------------------------------------------------------------
# Session state (full reconstruction payload for GET /sessions/{id})
# ---------------------------------------------------------------------------


class SessionState(BaseModel):
    session: SessionRecord
    project: ProjectRecord | None = None
    assets: list[AssetRecord] = []
    jobs: list[JobRecord] = []
    scan_results: list[ScanResultRecord] = []
    consensus_results: list[ConsensusResultRecord] = []


# ---------------------------------------------------------------------------
# Worker task payloads (Cloud Tasks HTTP body)
# ---------------------------------------------------------------------------


class EnhanceTaskPayload(BaseModel):
    job_id: uuid.UUID
    session_id: uuid.UUID
    input_asset_id: uuid.UUID
    input_gcs_uri: str
    toggles: EnhanceToggles
    # Provider for image generation. Worker dispatches on this. Regen-from-Scan
    # always uses Gemini regardless of caller preference (the scan-derived
    # prompt was tuned for Gemini's behaviour).
    provider: Literal["gemini", "openai"] = "gemini"
    # Optional regen prompt override — set when regen is triggered from Scan tab.
    # When present, the enhance worker uses this prompt verbatim instead of
    # building one from toggles. All toggles will be False in this case.
    regen_prompt_override: str | None = None


class ScanTaskPayload(BaseModel):
    job_id: uuid.UUID
    session_id: uuid.UUID
    input_asset_id: uuid.UUID
    input_gcs_uri: str
    scan_difficulty: str = "standard"  # "standard" | "hard" — routes claude-opus-4-7


class CleanupTaskPayload(BaseModel):
    job_id: uuid.UUID
    session_id: uuid.UUID
    input_asset_id: uuid.UUID
    input_gcs_uri: str
    anomaly_context: list[dict[str, Any]] | None = None


# ---------------------------------------------------------------------------
# Internal scan result schema (used by AI provider adapters → Pydantic output)
# ---------------------------------------------------------------------------


class ScanResult(BaseModel):
    """Structured output schema passed to all three AI providers as JSON schema."""
    verdict: str = Field(description="'pass' or 'fail'")
    confidence: float = Field(ge=0.0, le=1.0, description="0.0–1.0")
    anomalies: list[AnomalyItem] = Field(default_factory=list)
    summary: str = Field(description="One-sentence plain-English verdict")

    @field_validator("verdict")
    @classmethod
    def verdict_valid(cls, v: str) -> str:
        if v not in ("pass", "fail"):
            raise ValueError("verdict must be 'pass' or 'fail'")
        return v


class AnomalyItem(BaseModel):
    type: str              # e.g. "rust", "missing_fork_tine", "damaged_mast"
    location: str          # e.g. "left_fork", "mast_top", "data_plate"
    severity: str          # "low" | "medium" | "high"
    description: str


# Rebuild to resolve forward references
ScanResult.model_rebuild()
