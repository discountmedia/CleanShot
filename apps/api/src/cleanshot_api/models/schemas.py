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
    # Mask-based object removal via BFL's flux-tools/erase-v1. Source is
    # an existing enhanced variant (its outputAssetId from a prior
    # enhance job); the operator paints a binary mask client-side and
    # the worker dispatches both to BFL.
    erase = "erase"
    # Text-guided variant refinement via Gemini Flash Image (same model
    # as primary enhance, different intent). Operator writes a free-text
    # instruction ("remove the propane tank", "add some surface scuffs
    # to the side panel"), backend sends variant + instruction to
    # Gemini. Used when the Flux erase tool's mask flow is overkill /
    # under-powered for the kind of edit needed.
    tweak = "tweak"
    # Deterministic pixel-level adjustments via pyvips (Modify tab):
    # brightness, contrast, saturation. Non-AI darkroom pass.
    modify = "modify"


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
    # Image generation provider. Defaults to gemini (gemini-2.5-flash-image:
    # fastest, cheapest, decent). "openai" routes through
    # gpt-image-2-2026-04-21 (slower + costlier, sometimes more literal).
    # "flux" routes through Black Forest Labs FLUX 2 [PRO] — the recommended
    # default for image editing per BFL's own docs; async polling pattern;
    # ~$0.03–0.08 per image. Model IDs pinned in
    # apps/api/.../workers/enhance_worker.py.
    provider: Literal["gemini", "openai", "grok", "kontext", "ideogram", "reve"] = "gemini"
    # What kind of equipment is in the photo — drives the per-type
    # anatomy guardrail block in _build_enhance_prompt + the equipment
    # display name in the master goal ("USED forklift" / "USED scissor
    # lift" / "USED telehandler"). Defaults to forklift for backward
    # compatibility with callers that don't pass it.
    equipment_type: Literal["forklift", "scissor_lift", "telehandler", "reach_truck", "order_picker", "pallet_jack", "walkie_stacker"] = "forklift"
    # Optional custom prompt — when present, overrides the toggle-derived
    # prompt and is passed to the model verbatim. The frontend's
    # "Custom prompt (advanced)" section produces this; the toggles
    # are disabled in the UI when it's in use.
    custom_prompt: str | None = None
    idempotency_key: str = Field(default_factory=lambda: str(uuid.uuid4()))


class EnhanceToggles(BaseModel):
    """
    Optional emphasis / action toggles — must match frontend types.ts
    EnhanceToggles exactly. Field names are camelCase from the frontend;
    FastAPI/Pydantic receives them via JSON so the names must match the
    camelCase keys the frontend sends. We use model_config alias_generator
    or explicit aliases to accept camelCase.
    """
    model_config = {"populate_by_name": True}

    new_paint_job: bool = Field(False, alias="newPaintJob")
    remove_rust: bool = Field(False, alias="removeRust")
    restore_decals: bool = Field(False, alias="restoreDecals")
    remove_people: bool = Field(False, alias="removePeople")
    remove_background_signage: bool = Field(False, alias="removeBackgroundSignage")
    # Default ON — painted forks (red w/ yellow tips, LBR stays black) are
    # part of Discount Forklift's standard treatment. Operators can
    # uncheck for special cases (e.g. when forks should stay as-is).
    paint_forks_red_yellow_tips: bool = Field(True, alias="paintForksRedYellowTips")
    shine_tires: bool = Field(False, alias="shineTires")
    improve_lighting: bool = Field(False, alias="improveLighting")
    # Default ON — most batches are ex-rental units. Surfaces as a
    # visible toggle in the Advanced section so operators can opt out
    # if they know the unit doesn't have rental-fleet branding.
    remove_rental_branding: bool = Field(True, alias="removeRentalBranding")
    # When the source photo was shot inside a showroom / studio with a
    # solid-colour floor (white / black / grey seamless), tells the
    # enhance prompt to clean the floor to a uniform studio finish —
    # remove tape marks, scuff streaks, footprints, debris, and any
    # background-floor seam. Off by default; operators should only flip
    # it on for actual studio shots (it'll over-clean a real yard floor
    # if mis-applied).
    showroom_floor: bool = Field(False, alias="showroomFloor")


class EnhanceResponse(BaseModel):
    job_id: uuid.UUID


class EraseRequest(BaseModel):
    """
    BFF → FastAPI request body for mask-based object erase.

    The operator clicks "Erase" on a completed enhance variant, paints a
    binary mask in the browser, and submits both the source asset_id
    (the variant they want to clean up) and the mask as a base64 PNG.
    `instruction` is optional — when omitted, the vendor falls back to
    its default "fill with plausible background" behavior.

    `tool` chooses the backend:
      • "flux"     → BFL flux-tools/erase-v1 (default; identity-preserving)
      • "ideogram" → Ideogram 3.0 inpaint (text-rendering specialist;
                     stronger for OEM decals, model numbers, capacity
                     stickers, signage)
    """
    session_id: uuid.UUID
    asset_id: uuid.UUID
    # Base64-encoded PNG of the mask. White (>= 128) pixels mark areas
    # to erase, black pixels mark areas to preserve. Mask dimensions
    # must match the source image; the worker resizes if not.
    # NOTE: Ideogram's API inverts this convention (black = edit). The
    # worker handles the inversion server-side so the frontend can keep
    # producing the same WHITE=erase mask for either tool.
    mask_png_base64: str
    # Optional natural-language instruction for what should fill the
    # erased region. Leave empty for the vendor's default behaviour.
    instruction: str | None = None
    tool: Literal["flux", "ideogram"] = "flux"
    idempotency_key: str = Field(default_factory=lambda: str(uuid.uuid4()))


class EraseResponse(BaseModel):
    job_id: uuid.UUID


class EraseTaskPayload(BaseModel):
    job_id: uuid.UUID
    session_id: uuid.UUID
    input_asset_id: uuid.UUID
    input_gcs_uri: str
    mask_png_base64: str
    instruction: str | None = None
    tool: Literal["flux", "ideogram"] = "flux"


class TweakRequest(BaseModel):
    """
    BFF → FastAPI request body for text-guided variant refinement.

    Operator clicks Tweak on a completed enhance variant, types a
    natural-language instruction ("remove the propane tank from the
    side panel", "add some surface scuffs to the hood"), submits.

    `tool` chooses the backend:
      • "gemini"   → Gemini Flash Image (default; conversational, fast)
      • "ideogram" → Ideogram 3.0 /v1/edit (typography-strong; better
                     for decal restoration and embedded-text edits)

    No mask: this is the conversational sibling to /enhance/erase. Use
    Erase for surgical mask-based removal; Tweak for everything else.
    """
    session_id: uuid.UUID
    asset_id: uuid.UUID
    # 600-char cap is more than enough — both Gemini and Ideogram
    # respond best to short imperative instructions.
    instruction: str = Field(min_length=3, max_length=600)
    tool: Literal["gemini", "ideogram"] = "gemini"
    idempotency_key: str = Field(default_factory=lambda: str(uuid.uuid4()))


class TweakResponse(BaseModel):
    job_id: uuid.UUID


class TweakTaskPayload(BaseModel):
    job_id: uuid.UUID
    session_id: uuid.UUID
    input_asset_id: uuid.UUID
    input_gcs_uri: str
    instruction: str
    tool: Literal["gemini", "ideogram"] = "gemini"


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
    # Parallel list to asset_ids — entry [i] is the AI provider that
    # produced asset_ids[i] (or None when unknown). When present, the
    # export endpoint suffixes each output filename with the model name
    # so duplicate variants of the same source image stay distinguishable
    # in the ZIP (e.g. "..._01_Gemini.jpg" vs "..._01_Openai.jpg").
    providers: list[str | None] | None = None
    # When true, the export pipeline burns the AI-disclaimer watermark
    # string into the bottom-right corner of every exported JPEG. Off
    # by default — operator opts in via the Resize-tab checkbox.
    ai_disclaimer: bool = False


class ExportCollageRequest(BaseModel):
    """
    COLLAGE preset: 1024px LONG EDGE (fit, NOT crop), JPEG ≤99 kb.
    Same input shape as ExportProRequest; difference is server-side —
    no 7:5 crop, just downsize to fit the long edge.
    """
    session_id: uuid.UUID
    asset_ids: list[uuid.UUID] = Field(min_length=1, max_length=50)
    # Parallel list to asset_ids — entry [i] is the AI provider that
    # produced asset_ids[i]. Same semantics as ExportProRequest.providers
    # (filename suffix for distinguishing duplicate variants in ZIPs).
    providers: list[str | None] | None = None
    # When true, the export pipeline burns the AI-disclaimer watermark
    # string into the bottom-right corner of every exported JPEG.
    ai_disclaimer: bool = False


class ExportBrandedCollageRequest(BaseModel):
    """
    BRANDED COLLAGE preset — composes the marketing-layout collage that
    Discount Forklift uses on listing sites: 1 large hero on the left
    (640×580) + 4 thumbnails stacked on the right (384×145 each), final
    canvas 1024×580, JPEG ≤99 kb.

    `asset_ids` must contain EXACTLY 5 ids in render order: index 0 is
    the hero, indices 1-4 fill the thumbnail strip top-to-bottom.

    `equipment_type` is informational — drives the output filename
    suffix so operators can tell forklift / scissor / telehandler
    collages apart in their downloads folder. The layout itself is the
    same across all three.
    """
    session_id: uuid.UUID
    equipment_type: Literal["forklift", "scissor_lift", "telehandler", "reach_truck", "order_picker", "pallet_jack", "walkie_stacker"]
    asset_ids: list[uuid.UUID] = Field(min_length=5, max_length=5)
    ai_disclaimer: bool = False


class ModifyAdjustments(BaseModel):
    """
    All Modify-tab adjustments combined. Operator can mix any subset
    of the three modes (Adjustments / Crop / Straighten) in a single
    Apply — backend pyvips runs them in the order: rotate → crop →
    brightness/contrast → saturation so the crop happens AFTER the
    rotation wedges are gone but BEFORE colour tweaks (final crop bounds
    map cleanly onto the colour-adjusted pixels).

    Slider ranges (frontend) → backend factors:
      brightness slider  -100..+100  → 0.5..1.5  (1.0 = neutral)
      contrast slider    -100..+100  → 0.5..1.5  (1.0 = neutral)
      saturation slider  -100..+100  → 0.0..2.0  (1.0 = neutral)
      rotation slider    -150..+150  → -15.0..+15.0 degrees (0 = neutral)
      crop zoom slider     50..100   → 0.5..1.0 (1.0 = no crop)
      crop_aspect: literal ("free" = keep source aspect; "1:1"/"4:3"/
        "7:5"/"16:9" = smart-crop to that aspect)

    Frontend does the slider-to-factor mapping client-side so the
    CSS-filter / CSS-transform preview matches what the backend
    renders. Backend just receives the final factors.
    """
    brightness:   float = Field(default=1.0, ge=0.0, le=3.0)
    contrast:     float = Field(default=1.0, ge=0.0, le=3.0)
    saturation:   float = Field(default=1.0, ge=0.0, le=3.0)
    rotation_deg: float = Field(default=0.0, ge=-15.0, le=15.0)
    crop_aspect:  Literal["free", "1:1", "4:3", "7:5", "16:9"] = "free"
    crop_zoom:    float = Field(default=1.0, ge=0.25, le=1.0)


class ModifyBatchRequest(BaseModel):
    """
    Modify-tab batch request. Operator sends a set of asset_ids and a
    default ModifyAdjustments applied to every asset, plus an optional
    `per_asset` map of per-image overrides keyed by asset_id (as str).
    When `per_asset[asset_id]` exists, it REPLACES the default
    `adjustments` for that asset's render. Backwards-compatible — batch
    mode just sends an empty `per_asset` dict.
    """
    session_id:  uuid.UUID
    asset_ids:   list[uuid.UUID] = Field(min_length=1, max_length=50)
    adjustments: ModifyAdjustments
    # Per-image overrides. Keys are stringified asset_ids that appear
    # in `asset_ids`; values are the adjustments to use for THAT asset
    # in lieu of the default. Empty by default → behaviour is identical
    # to the prior batch-only schema.
    per_asset:   dict[str, ModifyAdjustments] = Field(default_factory=dict)


class ModifyBatchItem(BaseModel):
    """One asset's worth of output in the Modify response."""
    asset_id: uuid.UUID
    filename: str
    url:      str  # signed GET URL, ~1 hour expiry
    width:    int
    height:   int


class ModifyBatchResponse(BaseModel):
    """Modify-tab batch response. Items in same order as request.asset_ids."""
    items: list[ModifyBatchItem]


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


class ExportProPreviewItem(BaseModel):
    """One processed PRO image, ready for inline preview in the UI."""
    asset_id: uuid.UUID
    filename: str
    url: str
    width: int
    height: int
    size_bytes: int
    size_warning: bool


class ExportProPreviewResponse(BaseModel):
    """
    Returned by POST /api/v1/export/pro/preview. Lets the UI render every
    resized image inline so the operator can verify zoom-to-fill before
    downloading the bundle.
    """
    items: list[ExportProPreviewItem]
    zip_url: str
    zip_size_bytes: int
    any_size_warning: bool


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
# User profiles + support tickets
# ---------------------------------------------------------------------------


class UserProfile(BaseModel):
    user_email: str
    full_name:  str | None = None
    work_phone: str | None = None
    location:   str | None = None
    avatar_uri: str | None = None        # gs:// path; UI receives signed GET URL
    avatar_url: str | None = None        # populated by API when reading (signed)
    created_at: datetime
    updated_at: datetime


class UpdateProfileRequest(BaseModel):
    full_name:  str | None = Field(default=None, max_length=120)
    work_phone: str | None = Field(default=None, max_length=40)
    location:   str | None = Field(default=None, max_length=120)


class AvatarUploadUrlResponse(BaseModel):
    upload_url: str
    gcs_uri:    str


class SupportTicketType(StrEnum):
    support = "support"
    feature = "feature"


class SupportTicketStatus(StrEnum):
    open        = "open"
    in_progress = "in_progress"
    closed      = "closed"


class CreateSupportTicketRequest(BaseModel):
    type:    SupportTicketType
    subject: str = Field(min_length=1, max_length=200)
    body:    str = Field(min_length=1, max_length=4000)


class SupportTicketRecord(BaseModel):
    id:          uuid.UUID
    user_email:  str
    type:        SupportTicketType
    subject:     str
    body:        str
    status:      SupportTicketStatus
    admin_notes: str | None = None
    created_at:  datetime
    updated_at:  datetime


class UpdateSupportTicketRequest(BaseModel):
    status:      SupportTicketStatus | None = None
    admin_notes: str | None = Field(default=None, max_length=4000)


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
    # passes the operator's selected provider through here (the scan-derived
    # prompt was originally tuned for Gemini, but other providers are now
    # accepted at the operator's discretion).
    provider: Literal["gemini", "openai", "grok", "kontext", "ideogram", "reve"] = "gemini"
    # Equipment type — feeds _build_enhance_prompt's per-type guardrails.
    # Ignored when custom_prompt is set (the operator's verbatim text wins).
    equipment_type: Literal["forklift", "scissor_lift", "telehandler", "reach_truck", "order_picker", "pallet_jack", "walkie_stacker"] = "forklift"
    # Optional verbatim prompt override. Set by either:
    #   • Scan tab "Regenerate Image" (anomaly-derived prompt), or
    #   • Enhance tab "Custom prompt (advanced)" textarea.
    # When present, the worker uses this prompt as-is and ignores toggles.
    # (Pydantic ignores unknown extra keys by default, so old in-flight
    # tasks that still use the legacy `regen_prompt_override` key during
    # a deploy will silently lose the override and fall back to toggles —
    # acceptable for the brief deploy window.)
    custom_prompt: str | None = None


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
