from __future__ import annotations

import json
import uuid

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Request, status

from cleanshot_api.core.security import require_api_key
from cleanshot_api.db import queries
from cleanshot_api.db.pool import get_pool
from cleanshot_api.models.schemas import (
    CleanupBatchRequest,
    CleanupBatchResponse,
    CleanupTaskPayload,
    EnhanceJudgeRequest,
    EnhanceJudgeResponse,
    EnhanceRequest,
    EnhanceResponse,
    EnhanceTaskPayload,
    EraseRequest,
    EraseResponse,
    EraseTaskPayload,
    JobStatusEnum,
    OperationEnum,
    OptimizePromptRequest,
    OptimizePromptResponse,
    ScanBatchRequest,
    ScanBatchResponse,
    ScanTaskPayload,
    TweakRequest,
    TweakResponse,
    TweakTaskPayload,
)
from cleanshot_api.services.tasks import (
    enqueue_cleanup,
    enqueue_enhance,
    enqueue_erase,
    enqueue_scan,
    enqueue_tweak,
)
from cleanshot_api.workers.enhance_worker import judge_variants
from cleanshot_api.workers.prompt_optimizer import optimize_prompt

router = APIRouter(prefix="/api/v1", tags=["operations"])

# IPM Tier 1: 1 image / 10s → 10 images / 100s for a 10-image batch
_CLEANUP_ETA_PER_IMAGE = 15  # seconds (conservative, accounts for queue depth)


@router.post(
    "/enhance",
    response_model=EnhanceResponse,
    dependencies=[Depends(require_api_key)],
    status_code=202,
)
async def enqueue_enhance_job(
    body: EnhanceRequest,
    pool: asyncpg.Pool = Depends(get_pool),
) -> EnhanceResponse:
    """
    Validate toggles, write job row (status=queued), enqueue Cloud Tasks, return {job_id}.
    Returns 202 immediately — the actual Gemini work is async.
    """
    async with pool.acquire() as conn:
        # Verify asset exists and belongs to this session
        asset = await queries.get_asset(conn, body.asset_id)
        if asset is None or asset.session_id != body.session_id:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Asset not found"
            )

        job = await queries.create_job(
            conn,
            session_id=body.session_id,
            operation=OperationEnum.enhance,
            input_asset_id=body.asset_id,
            idempotency_key=body.idempotency_key,
        )

    task_payload = EnhanceTaskPayload(
        job_id=job.id,
        session_id=body.session_id,
        input_asset_id=body.asset_id,
        input_gcs_uri=asset.gcs_uri,
        toggles=body.toggles,
        provider=body.provider,
        equipment_type=body.equipment_type,
        fork_visibility=body.fork_visibility,
        fork_framing_in_prompt=body.fork_framing_in_prompt,
        custom_prompt=body.custom_prompt,
        prompt_choice=body.prompt_choice,
    )
    tasks_name = enqueue_enhance(task_payload)

    async with pool.acquire() as conn:
        await queries.set_job_tasks_name(conn, job.id, tasks_name)

    return EnhanceResponse(job_id=job.id)


@router.post(
    "/enhance/erase",
    response_model=EraseResponse,
    dependencies=[Depends(require_api_key)],
    status_code=202,
)
async def enqueue_erase_job(
    body: EraseRequest,
    pool: asyncpg.Pool = Depends(get_pool),
) -> EraseResponse:
    """
    Mask-based object erase via Ideogram v3 inpaint. The source
    asset_id is typically the outputAssetId of a completed enhance
    variant — the operator drew a mask over something they want
    removed (a sticker, a scratch, background clutter, etc.).
    Returns 202 immediately; the vendor call happens on the Cloud Tasks
    hop. (Ideogram inpaint itself is synchronous, unlike the old BFL poll.)
    """
    async with pool.acquire() as conn:
        asset = await queries.get_asset(conn, body.asset_id)
        if asset is None or asset.session_id != body.session_id:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Asset not found"
            )

        job = await queries.create_job(
            conn,
            session_id=body.session_id,
            operation=OperationEnum.erase,
            input_asset_id=body.asset_id,
            idempotency_key=body.idempotency_key,
        )

    task_payload = EraseTaskPayload(
        job_id=job.id,
        session_id=body.session_id,
        input_asset_id=body.asset_id,
        input_gcs_uri=asset.gcs_uri,
        mask_png_base64=body.mask_png_base64,
        instruction=body.instruction,
        tool=body.tool,
    )
    tasks_name = enqueue_erase(task_payload)

    async with pool.acquire() as conn:
        await queries.set_job_tasks_name(conn, job.id, tasks_name)

    return EraseResponse(job_id=job.id)


@router.post(
    "/enhance/tweak",
    response_model=TweakResponse,
    dependencies=[Depends(require_api_key)],
    status_code=202,
)
async def enqueue_tweak_job(
    body: TweakRequest,
    pool: asyncpg.Pool = Depends(get_pool),
) -> TweakResponse:
    """
    Text-guided variant refinement via Gemini Flash Image. Source
    asset_id is typically the outputAssetId of a completed enhance
    variant — the operator typed a one-line instruction ("remove the
    propane tank", "add some surface scuffs to the side panel") that
    Gemini applies as a targeted edit without re-rendering the unit.
    Returns 202 immediately; actual Gemini work is async.
    """
    async with pool.acquire() as conn:
        asset = await queries.get_asset(conn, body.asset_id)
        if asset is None or asset.session_id != body.session_id:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Asset not found"
            )

        job = await queries.create_job(
            conn,
            session_id=body.session_id,
            operation=OperationEnum.tweak,
            input_asset_id=body.asset_id,
            idempotency_key=body.idempotency_key,
        )

    task_payload = TweakTaskPayload(
        job_id=job.id,
        session_id=body.session_id,
        input_asset_id=body.asset_id,
        input_gcs_uri=asset.gcs_uri,
        instruction=body.instruction,
        tool=body.tool,
    )
    tasks_name = enqueue_tweak(task_payload)

    async with pool.acquire() as conn:
        await queries.set_job_tasks_name(conn, job.id, tasks_name)

    return TweakResponse(job_id=job.id)


@router.post(
    "/enhance/judge",
    response_model=EnhanceJudgeResponse,
    dependencies=[Depends(require_api_key)],
)
async def judge_enhance_variants(
    body: EnhanceJudgeRequest,
    request: Request,
    pool: asyncpg.Pool = Depends(get_pool),
) -> EnhanceJudgeResponse:
    """
    Auto-pick "best of N" — SYNCHRONOUS (not a Cloud Tasks job). Given the
    completed enhance variants for one source image, run a single Claude
    vision call that ranks them against the operator's calibrated
    listing-readiness rubric and names a winner. Read-only: no asset or job
    row is written, so we return the ranking inline rather than a job_id.

    503s when the Anthropic client isn't configured so the frontend can fall
    back to a manual winner pick without treating it as a hard error.
    """
    anthropic_client = request.app.state.anthropic
    if anthropic_client is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Variant judge unavailable (Anthropic client not configured)",
        )

    async with pool.acquire() as conn:
        # Resolve the ORIGINAL (optional — differential mode when present).
        original_gcs_uri: str | None = None
        if body.original_asset_id:
            original = await queries.get_asset(conn, body.original_asset_id)
            if original is not None and original.session_id == body.session_id:
                original_gcs_uri = original.gcs_uri

        # Resolve every candidate's GCS URI, enforcing session ownership.
        resolved: list[tuple[str, uuid.UUID, str]] = []
        for cand in body.candidates:
            asset = await queries.get_asset(conn, cand.asset_id)
            if asset is None or asset.session_id != body.session_id:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"Candidate asset {cand.asset_id} not found",
                )
            resolved.append((cand.provider, cand.asset_id, asset.gcs_uri))

    result = await judge_variants(
        anthropic_client,
        resolved,
        original_gcs_uri,
        equipment_type=body.equipment_type,
        make=body.make,
    )
    return EnhanceJudgeResponse(**result)


@router.post(
    "/prompts/optimize",
    response_model=OptimizePromptResponse,
    dependencies=[Depends(require_api_key)],
)
async def optimize_saved_prompt(
    body: OptimizePromptRequest,
    request: Request,
) -> OptimizePromptResponse:
    """
    Condense a long enhance prompt — SYNCHRONOUS, like the judge, and for the
    same reason: nothing is written, so there is no job to poll. No pool
    dependency; this endpoint never touches the database.

    It lives here rather than in routers/saved_prompts.py because every route
    there is CRUD against the saved_prompts table and this one is not: the
    operator may optimize a prompt they never save, and saving still goes
    through the normal create path (a NEW row, a NEW title — templates are
    immutable, there is no PATCH).

    503s when the Anthropic client isn't configured, so the button can present
    itself as unavailable instead of erroring. Note the flag that gates the
    client is SCAN_PROVIDER_ANTHROPIC despite this not being a scan.
    """
    anthropic_client = request.app.state.anthropic
    if anthropic_client is None:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=(
                "Prompt optimizer unavailable (Anthropic client not configured)"
            ),
        )

    try:
        result = await optimize_prompt(
            anthropic_client,
            body.body,
            equipment_type=body.equipment_type,
        )
    except ValueError as exc:
        # The optimizer refuses to return a half-result: an empty or truncated
        # prompt that the operator might paste over a working one is worse than
        # a visible failure.
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"Optimizer returned an unusable result: {exc}",
        ) from exc

    return OptimizePromptResponse(**result)


@router.post(
    "/scan/batch",
    response_model=ScanBatchResponse,
    dependencies=[Depends(require_api_key)],
    status_code=202,
)
async def enqueue_scan_batch(
    body: ScanBatchRequest,
    request: Request,
    pool: asyncpg.Pool = Depends(get_pool),
) -> ScanBatchResponse:
    """Enqueue scan jobs for all requested asset IDs. Returns batch_id + job_ids."""
    batch_id = uuid.uuid4()
    job_ids: list[uuid.UUID] = []
    originals = body.original_asset_ids or {}

    async with pool.acquire() as conn:
        for asset_id in body.asset_ids:
            asset = await queries.get_asset(conn, asset_id)
            if asset is None or asset.session_id != body.session_id:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"Asset {asset_id} not found",
                )

            # If the caller supplied the original (pre-enhance) asset for this
            # enhanced asset, resolve its GCS URI so the worker runs a
            # DIFFERENTIAL scan. Silently fall back to isolated mode if the
            # original is missing or belongs to another session.
            original_asset_id = originals.get(asset_id)
            original_gcs_uri: str | None = None
            if original_asset_id:
                original = await queries.get_asset(conn, original_asset_id)
                if original is not None and original.session_id == body.session_id:
                    original_gcs_uri = original.gcs_uri
                else:
                    original_asset_id = None

            job = await queries.create_job(
                conn,
                session_id=body.session_id,
                operation=OperationEnum.scan,
                input_asset_id=asset_id,
                idempotency_key=f"{body.idempotency_key}-{asset_id}",
            )

            task_payload = ScanTaskPayload(
                job_id=job.id,
                session_id=body.session_id,
                input_asset_id=asset_id,
                input_gcs_uri=asset.gcs_uri,
                equipment_type=body.equipment_type,
                make=body.make,
                original_asset_id=original_asset_id,
                original_gcs_uri=original_gcs_uri,
                intended_edits=body.intended_edits,
            )
            tasks_name = enqueue_scan(task_payload)
            await queries.set_job_tasks_name(conn, job.id, tasks_name)
            job_ids.append(job.id)

    # Store batch → job mapping in Valkey for batch polling
    valkey = request.app.state.valkey
    if valkey:
        try:
            await valkey.setex(
                f"batch:{batch_id}",
                3600,  # 1 hour TTL
                json.dumps([str(j) for j in job_ids]),
            )
        except Exception:
            pass  # Non-fatal: batch polling degrades, individual polling still works

    return ScanBatchResponse(batch_id=batch_id, job_ids=job_ids)


@router.post(
    "/cleanup/batch",
    response_model=CleanupBatchResponse,
    dependencies=[Depends(require_api_key)],
    status_code=202,
)
async def enqueue_cleanup_batch(
    body: CleanupBatchRequest,
    request: Request,
    pool: asyncpg.Pool = Depends(get_pool),
) -> CleanupBatchResponse:
    """
    Enqueue cleanup jobs. Returns batch_id + job_ids + ETA.
    ETA is shown in QueueStatusBar — never hide queue depth at Tier 1.
    """
    batch_id = uuid.uuid4()
    job_ids: list[uuid.UUID] = []

    async with pool.acquire() as conn:
        for i, asset_id in enumerate(body.asset_ids):
            asset = await queries.get_asset(conn, asset_id)
            if asset is None or asset.session_id != body.session_id:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"Asset {asset_id} not found",
                )

            # Per-asset anomaly context (optional — passed in from scan results)
            anomaly_ctx = None
            if body.anomaly_context and i < len(body.anomaly_context):
                anomaly_ctx = body.anomaly_context[i].get("anomalies")

            job = await queries.create_job(
                conn,
                session_id=body.session_id,
                operation=OperationEnum.cleanup,
                input_asset_id=asset_id,
                idempotency_key=f"{body.idempotency_key}-{asset_id}",
            )

            task_payload = CleanupTaskPayload(
                job_id=job.id,
                session_id=body.session_id,
                input_asset_id=asset_id,
                input_gcs_uri=asset.gcs_uri,
                anomaly_context=anomaly_ctx,
            )
            tasks_name = enqueue_cleanup(task_payload)
            await queries.set_job_tasks_name(conn, job.id, tasks_name)
            job_ids.append(job.id)

    # Store batch in Valkey
    valkey = request.app.state.valkey
    if valkey:
        try:
            await valkey.setex(
                f"batch:{batch_id}",
                3600,
                json.dumps([str(j) for j in job_ids]),
            )
        except Exception:
            pass

    eta_seconds = len(body.asset_ids) * _CLEANUP_ETA_PER_IMAGE

    return CleanupBatchResponse(
        batch_id=batch_id,
        job_ids=job_ids,
        eta_seconds=eta_seconds,
    )
