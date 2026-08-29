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
    # Mask-based object removal via Ideogram v3 inpaint. Source is
    # an existing enhanced variant (its outputAssetId from a prior
    # enhance job); the operator paints a binary mask client-side and
    # the worker dispatches both to Ideogram v3 inpaint.
    erase = "erase"
    # Text-guided variant refinement via Gemini Flash Image (same model
    # as primary enhance, different intent). Operator writes a free-text
    # instruction ("remove the propane tank", "add some surface scuffs
    # to the side panel"), backend sends variant + instruction to
    # Gemini. Used when the erase tool's mask flow is overkill /
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
    # Set when this session was created by a media-auditor handoff. Lets a
    # reloaded page discover it has an import worth polling without the handoff
    # id being in the URL — the token is stripped from the address bar
    # immediately after exchange, so the URL cannot be the carrier.
    handoff_id: uuid.UUID | None = None


class ProjectRecord(BaseModel):
    id: uuid.UUID
    session_id: uuid.UUID
    title: str
    make: str
    # Nullable -- an unknown year is stored as unknown, never guessed.
    year: int | None
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
    # Provenance for assets copied in by the media-auditor handoff — the source
    # unit's stock number. NULL for everything the operator uploaded in the
    # browser. Display only; nothing is keyed off it beyond showing it on the
    # imported card and selecting which assets hydrate into the Enhance grid.
    source_ref: str | None = None


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
    # >0 while a provider call is being re-run for a correctable defect.
    # Default keeps older rows valid.
    retry_count: int = 0
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


class ForkVisibility(BaseModel):
    """
    Which parts of the fork are actually in frame in THIS source photo.

    Per-image, not per-batch: whether the fork tips got cropped is a property
    of one camera angle, not of the job the operator queued.

    Both default True — "the fork is fully visible" — so every existing caller
    and every photo where this isn't a problem produces byte-identical prompts
    to before these fields existed.

    These REMOVE prompt fragments rather than adding counter-instructions on
    top of them. Emphatic "do not draw X" phrasing backfires on Gemini (see the
    reverted Phase A guardrail experiment, CLAUDE.md 2026-07-13), so the fix
    for "the model invents a fork shank" is to stop asking for one, not to ask
    harder for its absence.
    """
    model_config = {"populate_by_name": True}

    # False → the upright/shank portion is out of frame. The prompt drops the
    # clause that describes painting it, so the model has nothing to satisfy
    # by painting part of the overhead guard or carriage into a shank.
    vertical_visible: bool = Field(True, alias="verticalVisible")
    # False → the tips are cropped out. The yellow-tip clause is SUBSTITUTED
    # (not merely deleted) with a red-only instruction, because leaving the
    # tips unmentioned lets the model fall back on its yellow-tip prior, and
    # asking for yellow tips that aren't in frame makes it shorten the forks
    # to bring some into view.
    tips_visible: bool = Field(True, alias="tipsVisible")


class EnhanceRequest(BaseModel):
    session_id: uuid.UUID
    asset_id: uuid.UUID
    toggles: EnhanceToggles
    # Image generation provider. Model IDs are pinned in
    # apps/api/.../workers/enhance_worker.py — the table in CLAUDE.md is the
    # readable version.
    #   gemini (default) — gemini-3.1-flash-image-preview via the AI Studio
    #                      backend. Fastest (~20s).
    #   openai           — gpt-5 with the image_generation tool forced via
    #                      tool_choice. Slowest (~45-75s) and shares
    #                      /v1/responses quota with the scan path.
    #   grok             — DORMANT since 2026-07-21. Still accepted here, but
    #                      dropped from ENHANCE_PROVIDERS so the picker can't
    #                      select it. One-line restore.
    # The LIVE picker is gemini + openai + grok (Grok restored 2026-08-27).
    # Kontext and Reve were removed from the picker 2026-06-05 and DELETED
    # from the worker 2026-08-27 — restoring either is a git revert now, not
    # a Literal edit. Ideogram is still not valid here; it remains live only
    # for the per-variant Tweak and Inpaint tools.
    provider: Literal["gemini", "openai", "grok"] = "gemini"
    # What kind of equipment is in the photo — drives the per-type
    # anatomy guardrail block in _build_enhance_prompt + the equipment
    # display name in the master goal ("USED forklift" / "USED scissor
    # lift" / "USED telehandler"). Defaults to forklift for backward
    # compatibility with callers that don't pass it.
    equipment_type: Literal["forklift", "rough_terrain", "scissor_lift", "telehandler", "reach_truck", "turret_truck", "articulated_forklift", "order_picker", "pallet_jack", "walkie_stacker"] = "forklift"
    # Per-image fork framing. See ForkVisibility.
    fork_visibility: ForkVisibility = Field(
        default_factory=ForkVisibility, alias="forkVisibility",
    )
    # True when the CALLER already composed the fork-framing wording into
    # `custom_prompt` (the Enhance tab does this when the operator's prompt is
    # still the recommended text — it rebuilds it from fragments per image,
    # which is a clean REMOVAL rather than a counter-instruction). The worker
    # then skips appending its own FORK FRAMING note, so the two paths can't
    # both fire and say the same thing twice.
    fork_framing_in_prompt: bool = Field(False, alias="forkFramingInPrompt")
    # Optional custom prompt — when present, overrides the toggle-derived
    # prompt and is passed to the model verbatim. The frontend's
    # "Custom prompt (advanced)" section produces this; the toggles
    # are disabled in the UI when it's in use.
    custom_prompt: str | None = None
    # Per-card master-prompt selection from the Enhance tab's "Prompt:"
    # dropdown. One opaque key:
    #   • None / "auto"        → legacy procedural builder (default; no regression)
    #   • "generic:<author>"   → one-size-fits-all master prompt by that author
    #   • "tailored:<author>"  → model-specific master prompt by that author
    # See workers/master_prompts.py. The chosen prompt REPLACES the
    # procedural spine; toggles + guardrails are still appended on top.
    # custom_prompt still outranks this.
    prompt_choice: str | None = None
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
    # Total background removal — a real alpha channel, for the new-equipment
    # site that wants the unit on no backdrop at all. NOT a prompt fragment:
    # it is a matting pass over the finished output (services/cutout.py), so
    # the machine pixels are untouched. Overrides showroom_floor, which is
    # about replacing a floor that is about to be deleted anyway.
    transparent_background: bool = Field(False, alias="transparentBackground")
    # A/B: route the matting pass through Photoroom instead of fal BiRefNet.
    # MEANINGLESS unless transparent_background is also on — this picks the
    # engine, it does not request a cutout. Exists because BiRefNet is a
    # salient-object detector and Photoroom is trained on product photography,
    # and which one is better on forklift lattice is unmeasured.
    # ⚠️ Photoroom's free tier is TEN IMAGES TOTAL.
    cutout_photoroom: bool = Field(False, alias="cutoutPhotoroom")
    # AUTO CROP — Florence-2 locates the machine and the image is reframed to
    # the house 7:5 composition (services/autocrop.py). Ported from
    # df-auto-edit, whose framing constants were measured, not chosen.
    # Independent of every other toggle: it changes framing, not pixels.
    auto_crop: bool = Field(False, alias="autoCrop")
    # Identity-preservation flag for 3-wheel forklifts (single rear
    # pivot/steer wheel under the counterweight). When ON, the prompt
    # adds a guardrail telling the AI to preserve the single-rear-wheel
    # layout instead of hallucinating a second rear wheel. UI only
    # surfaces this toggle when equipmentType=="forklift"; the backend
    # mirrors that gate (no-op for other equipment types).
    three_wheel: bool = Field(False, alias="threeWheel")


class EnhanceResponse(BaseModel):
    job_id: uuid.UUID


class EnhanceJudgeCandidate(BaseModel):
    """One enhanced variant to be judged. `provider` is opaque to the
    judge (it's never revealed to the model — candidates are labeled
    neutrally so brand identity can't bias the pick); it's only used to
    map the winner back to the frontend's per-file provider slot."""

    provider: str
    asset_id: uuid.UUID


class EnhanceJudgeRequest(BaseModel):
    """
    Auto-pick "best of N" — synchronous. The frontend fires this once
    per source image after that image's multi-provider enhance batch
    goes terminal with >= 2 successful variants. A single Claude vision
    call ranks the candidates against the operator's calibrated
    listing-readiness rubric and names a winner. Read-only: no new asset
    or job is created.
    """

    session_id: uuid.UUID
    # The ORIGINAL pre-enhance photo. When present the judge runs
    # DIFFERENTIAL (original vs each candidate) — the calibrated mode that
    # catches drift from the real machine. Optional: standalone runs (no
    # original) fall back to judging listing-readiness on the candidate
    # alone.
    original_asset_id: uuid.UUID | None = None
    candidates: list[EnhanceJudgeCandidate] = Field(..., min_length=1)
    # Optional equipment context so the judge weighs anatomy against the
    # right machine (mirrors the scan tab's KNOWN EQUIPMENT CONTEXT block).
    equipment_type: str | None = None
    make: str | None = None


class EnhanceJudgeRanking(BaseModel):
    provider: str
    asset_id: uuid.UUID
    # Would the dealer list this candidate? (holistic rubric verdict)
    verdict: Literal["pass", "fail"]
    # 0-100 listing-readiness — the ranking key. Higher is better.
    score: int
    reason: str


class EnhanceJudgeResponse(BaseModel):
    winner_provider: str
    winner_asset_id: uuid.UUID
    # True when EVERY candidate passed the rubric; when False the winner
    # is the least-bad option and the UI should flag "review recommended".
    all_pass: bool
    any_pass: bool
    rankings: list[EnhanceJudgeRanking]


class EraseRequest(BaseModel):
    """
    BFF → FastAPI request body for mask-based object erase.

    The operator clicks "Erase" on a completed enhance variant, paints a
    binary mask in the browser, and submits both the source asset_id
    (the variant they want to clean up) and the mask as a base64 PNG.
    `instruction` is optional — when omitted, the vendor falls back to
    its default "fill with plausible background" behavior.

    `tool` is Ideogram-only as of 2026-08-27. It used to choose between
    "flux" (BFL flux-tools/erase-v1) and "ideogram"; the Flux path and its
    worker helper `_erase_with_flux` were removed, so the Literal now admits
    one value. It is kept as a field rather than dropped so the request shape
    does not change under callers and a second backend can return without a
    schema migration.

      • "ideogram" → Ideogram 3.0 inpaint (text-rendering specialist;
                     stronger for OEM decals, model numbers, capacity
                     stickers, signage)

    ⚠️ ONE CALLER HAS NOT CAUGHT UP. `EraseDialog` now hardcodes
    `tool: "ideogram"`, but the BFF route
    `apps/web/app/api/enhance/erase/route.ts` still reads
    `tool: body.tool ?? "flux"` — so any caller that OMITS `tool` gets a 422
    from this Literal. Nothing omits it today, which is why it is latent rather
    than live. Change that default before adding a second caller.
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
    tool: Literal["ideogram"] = "ideogram"
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
    tool: Literal["ideogram"] = "ideogram"


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
    # Optional equipment context from the Scan-tab meta fields — sharpens
    # the QC inspector's anatomy judgement and cuts false geometry flags.
    equipment_type: str | None = None
    make: str | None = None
    # Optional map of {enhanced asset_id → original (pre-enhance) asset_id}.
    # When an entry is present, that asset is scanned in DIFFERENTIAL mode —
    # the inspector compares the enhanced output against its original and
    # flags UNINTENDED physical changes (shrunk forks, added damage, altered
    # text). Assets absent from the map (e.g. standalone uploads that were
    # never enhanced) fall back to the isolated single-image CYA scan.
    original_asset_ids: dict[uuid.UUID, uuid.UUID] | None = None
    # Optional human-readable list of edits the enhance step was asked to
    # make (repaint forks, remove people, …) so the differential inspector
    # treats them as expected rather than flagging them as defects.
    intended_edits: list[str] | None = None


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
    """
    Save-before-export payload.

    `year` is OPTIONAL and has NO default. It used to be required, and the web
    form silently substituted the current year when the operator left it blank —
    so a unit with an unknown year got confidently labelled 2026 and that wrong
    number went into the export filenames. A blank year is now carried through as
    NULL and simply omitted from the filename. Every other field stays required.
    """
    session_id: uuid.UUID
    title: str = Field(min_length=1, max_length=200)
    make: str = Field(min_length=1, max_length=100)
    year: int | None = Field(default=None, ge=1900, le=2100)
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


# ─── Saved prompts ────────────────────────────────────────────────────────────

# Titles are dropdown labels, bodies are enhance prompts. Both are bounded so a
# paste accident can't write an unbounded blob into a per-user table.
_PROMPT_TITLE_MAX = 120
# Raised 8000 -> 32000 on 2026-08-26. The old value was arbitrary and it
# rejected a REAL production prompt (a ~9.7k-character Hyster template with
# conditional fork/tip logic, a text-preservation block, and a verification
# checklist). Note what it was NOT protecting: `EnhanceRequest.custom_prompt`
# has no max_length at all, so that same prompt already enhanced fine — the
# cap only blocked SAVING it, which is the worst possible split. Prompts are
# the product here and they are long by nature.
#
# Not unbounded, for one specific reason: GET /prompts returns every
# template's full body (the client sorts and inserts locally), so the list
# payload is roughly template-count x body-size. At this cap a 30-template
# library is worst-case ~1 MB. If the library grows large, the fix is to drop
# `body` from the list response and fetch it on selection — not to lower this
# back and start rejecting real prompts again.
_PROMPT_BODY_MAX  = 32000


class SavedPrompt(BaseModel):
    """
    One shared template. `user_email` is the CREATOR, not an access scope —
    every signed-in user sees every row. `author_name` is their profile
    full_name when they have filled one in, and None when they haven't; the
    UI falls back to the email so the byline is never blank.

    Title and body are immutable after creation. `vote_count` / `use_count`
    are the two sortable reputation signals, and they are only meaningful
    because the text under them can't change.
    """
    id: uuid.UUID
    user_email: str
    title: str
    body: str
    author_name: str | None = None
    # Upvotes from distinct users. Defaults are for the create response, which
    # returns a brand-new row before any vote or use can exist.
    vote_count: int = 0
    # Whether the CALLER has upvoted it — per-viewer, not a property of the row.
    voted: bool = False
    # Times this template has been loaded into the prompt box.
    use_count: int = 0
    created_at: datetime
    updated_at: datetime


class PromptVoteResponse(BaseModel):
    """Authoritative state after a vote toggle — the UI replaces its optimistic
    guess with these rather than keeping its own running total."""
    vote_count: int
    voted: bool


class PromptUseResponse(BaseModel):
    use_count: int


class CreateSavedPromptRequest(BaseModel):
    title: str = Field(min_length=1, max_length=_PROMPT_TITLE_MAX)
    body: str = Field(min_length=1, max_length=_PROMPT_BODY_MAX)

    @field_validator("title", "body")
    @classmethod
    def _not_blank(cls, v: str) -> str:
        # min_length=1 accepts "   ". A whitespace title is an empty title as
        # far as the dropdown is concerned, so reject it here rather than
        # storing a row that renders as a blank option.
        stripped = v.strip()
        if not stripped:
            raise ValueError("must not be blank")
        return stripped


class OptimizePromptRequest(BaseModel):
    """Condense a long prompt. Reads and writes nothing — the result comes back
    inline for the operator to review before it goes anywhere near the box or
    the shared library.

    Same body ceiling as saving, deliberately: the whole point is that an
    already-saved 9.7k template can be fed straight back in. A tighter cap here
    would reject exactly the prompts this endpoint exists for.
    """
    body: str = Field(min_length=1, max_length=_PROMPT_BODY_MAX)
    equipment_type: str | None = None

    @field_validator("body")
    @classmethod
    def _not_blank(cls, v: str) -> str:
        stripped = v.strip()
        if not stripped:
            raise ValueError("must not be blank")
        return stripped


class OptimizePromptChange(BaseModel):
    """One line of the diff: what changed, and why it was allowed to."""
    text: str
    reason: str


class OptimizePromptResponse(BaseModel):
    """The condensed prompt plus a full account of the edit.

    `removed` and `kept` are not decoration — nothing is written anywhere
    without the operator reading them. The failure mode this guards against is
    the optimizer quietly dropping one of the five blocks the pipeline does NOT
    append on the prompt-first path (see workers/prompt_optimizer.py), which
    would degrade every future image made from the saved template while looking
    like a clean result.
    """
    optimized_prompt: str
    original_chars: int
    optimized_chars: int
    # The scanner's intended-edit whitelist window, echoed so the UI can show
    # the target it was aiming at without duplicating the constant.
    target_chars: int
    removed: list[OptimizePromptChange] = []
    kept: list[OptimizePromptChange] = []
    warnings: list[str] = []


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
    # Asset ids of the ORIGINAL pre-enhance photos, parallel-ish to asset_ids
    # (a source can appear once even if several of its variants export). Saved
    # into the project alongside the exported files so the library keeps the
    # before as well as the after. Optional: an export with no known originals
    # simply saves the exported files.
    original_asset_ids: list[uuid.UUID] = Field(default_factory=list)
    # When true, the export pipeline burns the AI-disclaimer watermark string
    # into the bottom-right corner of every exported JPEG.
    #
    # Defaults True, unlike the pre-2026-08-21 version of this field, because
    # the UI checkbox is now checked by default and the operator opts OUT. A
    # caller that omits it therefore gets the disclaimer rather than silently
    # dropping it.
    ai_disclaimer: bool = True


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


# ---------------------------------------------------------------------------
# media-auditor → CleanShot photo import (handoff)
# ---------------------------------------------------------------------------


class IngestImage(BaseModel):
    """
    One photo to copy in.

    A URL, not bytes: media-auditor never stores photo bytes — it crawls
    `image_urls` off the live listing and hands those to fal by reference. So the
    handoff passes references too and CleanShot fetches them server-side.
    """
    url: str
    # Optional display name. Falls back to the URL's basename, so the operator
    # sees something recognisable in the grid either way.
    filename: str | None = None


class IngestHandoffRequest(BaseModel):
    # Caller's stable id for this batch. Half the dedupe key with the per-photo
    # checksum, so re-sending the same batch cannot duplicate assets.
    source_batch_id: str = Field(min_length=1, max_length=200)
    # Source unit's stock number — media-auditor's unit ids ARE stock numbers.
    # Copied onto every asset's source_ref so an asset can still be traced back
    # to a unit after the handoff row is gone.
    stock_number: str | None = Field(default=None, max_length=64)
    images: list[IngestImage] = Field(min_length=1, max_length=150)
    # Optional equipment metadata, pre-filled into the workspace MetaCard so the
    # operator doesn't retype what media-auditor already knows.
    make: str | None = Field(default=None, max_length=100)
    model: str | None = Field(default=None, max_length=100)
    year: int | None = Field(default=None, ge=1900, le=2100)


class IngestHandoffResponse(BaseModel):
    handoff_id: uuid.UUID
    # Single-use, short-TTL. Travels to the browser in a URL FRAGMENT and is
    # exchanged for the session. Never logged, never echoed in an error.
    exchange_token: str
    expected_count: int


class IngestExchangeRequest(BaseModel):
    """
    The token is an UNCONSTRAINED `str` on purpose.

    There is no custom RequestValidationError handler on this app, so FastAPI's
    default 422 body echoes the offending `input` value for each error `loc`. A
    constrained token field (min_length / pattern / UUID) would therefore reflect
    a malformed token straight back to the caller, and the web BFF forwards
    upstream bodies. Validation happens in the handler, which returns fixed
    strings. Do not add validators here.
    """
    token: str


class IngestExchangeResponse(BaseModel):
    session_id: uuid.UUID
    handoff_id: uuid.UUID
    expected_count: int


class IngestItemStatus(BaseModel):
    item_id: uuid.UUID
    filename: str
    status: Literal["pending", "landed", "failed"]
    asset_id: uuid.UUID | None = None
    # Human-readable failure cause. Present only on status == "failed".
    error: str | None = None


class IngestHandoffStatus(BaseModel):
    """
    Mirrors GET /api/v1/jobs/batch/{batch_id}'s envelope — same
    total / status_counts / complete triple — rather than inventing a second
    progress shape for the frontend to learn.
    """
    handoff_id: uuid.UUID
    session_id: uuid.UUID
    total: int
    status_counts: dict[str, int]
    # True once no item is still pending. Terminal: the poller stops here.
    complete: bool
    items: list[IngestItemStatus]


class IngestCopyTaskPayload(BaseModel):
    item_id: uuid.UUID
    handoff_id: uuid.UUID
    session_id: uuid.UUID
    source_batch_id: str
    source_url: str
    filename: str
    stock_number: str | None = None


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
    # Narrowed 2026-06-05 — Kontext / Ideogram / Reve removed from picker.
    # workers/_enhance_with_* helpers remain as dead-but-harmless code.
    provider: Literal["gemini", "openai", "grok"] = "gemini"
    # Equipment type — feeds _build_enhance_prompt's per-type guardrails.
    # Ignored when custom_prompt is set (the operator's verbatim text wins).
    equipment_type: Literal["forklift", "rough_terrain", "scissor_lift", "telehandler", "reach_truck", "turret_truck", "articulated_forklift", "order_picker", "pallet_jack", "walkie_stacker"] = "forklift"
    # Per-image fork framing. See ForkVisibility.
    fork_visibility: ForkVisibility = Field(
        default_factory=ForkVisibility, alias="forkVisibility",
    )
    # True when the CALLER already composed the fork-framing wording into
    # `custom_prompt` (the Enhance tab does this when the operator's prompt is
    # still the recommended text — it rebuilds it from fragments per image,
    # which is a clean REMOVAL rather than a counter-instruction). The worker
    # then skips appending its own FORK FRAMING note, so the two paths can't
    # both fire and say the same thing twice.
    fork_framing_in_prompt: bool = Field(False, alias="forkFramingInPrompt")
    # The operator's prompt. Set by either:
    #   • Scan tab "Regenerate Image" (a COMPLETE anomaly-derived prompt), or
    #   • Enhance tab prompt box (the PRIMARY input, prompt-first redesign
    #     2026-07-21).
    # Since 2026-07-21 the Enhance-tab value is treated as a SPINE (toggles +
    # guardrails append on top via _build_enhance_prompt); the Scan-regen value
    # is used VERBATIM (see prompt_is_complete below). Toggles no longer take a
    # back seat to it on the Enhance path.
    custom_prompt: str | None = None
    # True when custom_prompt is a COMPLETE, self-contained prompt that must be
    # sent VERBATIM. Set by the Scan-tab "Regenerate" path (buildRegenPrompt
    # already composes spine + issues + its own equipment-correct GUARDRAILS
    # block). False (default = the Enhance-tab prompt-first path) means
    # custom_prompt is a SPINE and _build_enhance_prompt appends the toggle
    # add-ons + guardrails on top. Without this flag the 2026-07-21 prompt-first
    # reroute double-appends guardrails to regen prompts and attaches a
    # forklift-default guardrail to non-forklift regens.
    prompt_is_complete: bool = False
    # Master-prompt selection key carried through from EnhanceRequest.
    # None/"auto" → procedural builder; "generic:<author>" / "tailored:<author>"
    # → resolved via workers/master_prompts.py and used as the spine override.
    prompt_choice: str | None = None


class ScanTaskPayload(BaseModel):
    job_id: uuid.UUID
    session_id: uuid.UUID
    input_asset_id: uuid.UUID
    input_gcs_uri: str
    scan_difficulty: str = "standard"  # "standard" | "hard" — see SCAN_MODEL_ANTHROPIC_*
    # Optional equipment context carried through to the scan prompt builder.
    equipment_type: str | None = None
    make: str | None = None
    # DIFFERENTIAL SCAN — when both are set, the enhanced image
    # (input_asset_id/input_gcs_uri) is compared against the ORIGINAL
    # pre-enhance photo below. The scan worker branches into differential
    # mode: two images per provider + a "what changed?" prompt. When None,
    # the worker runs the legacy isolated single-image scan (standalone
    # uploads that have no original to compare against).
    original_asset_id: uuid.UUID | None = None
    original_gcs_uri: str | None = None
    # Human-readable edits the enhance step was asked to make. Threaded into
    # the differential prompt's whitelist so deliberate changes (repaint,
    # de-brand, remove people) are not flagged as defects.
    intended_edits: list[str] | None = None


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
    verdict: str = Field(
        description="'pass' or 'fail'. Default to 'pass'. Only 'fail' for a "
        "gross, obvious AI generation defect a customer would notice as fake."
    )
    confidence: float = Field(ge=0.0, le=1.0, description="0.0–1.0")
    anomalies: list[AnomalyItem] = Field(
        default_factory=list,
        description="Serious (medium/high) generation defects only. Empty "
        "when the image passes. Never list nitpicks or photography critique.",
    )
    summary: str = Field(
        description="One-sentence plain-English verdict. No advice or "
        "photography tips."
    )

    @field_validator("verdict")
    @classmethod
    def verdict_valid(cls, v: str) -> str:
        if v not in ("pass", "fail"):
            raise ValueError("verdict must be 'pass' or 'fail'")
        return v


class AnomalyItem(BaseModel):
    # NOTE: 'geometry_altered' was REMOVED from the differential vocabulary
    # 2026-07-30 — the operator's read was "no one understands what that
    # means," and it was the label on most of the false positives. Gross
    # deformity is still caught as 'size_changed' / 'part_added' /
    # 'part_removed' / 'hallucinated_object'. 'colour_changed' is likewise gone;
    # a genuinely wrong machine colour reports as 'wrong_colour'.
    #
    # 2026-08-21: this description used to end "Never invent a category about
    # altered geometry, reshaping, or paint/colour changes" while listing
    # 'wrong_colour' as valid in the same sentence. That contradiction sat in
    # the TOOL SCHEMA, so it constrained structured output directly: the model
    # was told the category existed and told not to use it, and resolved that
    # by reporting nothing. A full grey-to-orange body repaint scanned clean.
    # The geometry ban stays; the colour ban is now scoped to "don't invent
    # OTHER colour categories" instead of forbidding the one that exists.
    # Keep in sync with SCAN_DIFFERENTIAL_PROMPT_BASE in scan_worker.py.
    type: str = Field(description="Defect/change category. Isolated scan: 'duplicated_part', 'missing_part', 'deformed_part', 'garbled_text', 'wrong_colour', 'hallucinated_object'. Differential scan (vs original): 'size_changed', 'part_added', 'part_removed', 'damage_added', 'text_changed', 'wrong_colour', 'hallucinated_object'. Never invent a category about altered geometry or reshaping. Use 'wrong_colour' — and only 'wrong_colour' — for the colour cases the prompt calls defects: a body panel that changed colour family, or non-marking tyres turned black. Do not invent any other colour or paint category.")
    location: str = Field(description="Where on the unit, e.g. 'left_fork', 'mast_top', 'data_plate'")
    severity: str = Field(description="'medium' or 'high' only — do not report 'low'/nitpick issues at all")
    description: str = Field(description="What the defect or unintended change is. In differential mode, phrase it as a difference from the original. State the issue only; no advice or photography tips.")


# Rebuild to resolve forward references
ScanResult.model_rebuild()
