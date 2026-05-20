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
    EnhanceRequest,
    EnhanceResponse,
    EnhanceTaskPayload,
    JobStatusEnum,
    OperationEnum,
    ScanBatchRequest,
    ScanBatchResponse,
    ScanTaskPayload,
)
from cleanshot_api.services.tasks import enqueue_cleanup, enqueue_enhance, enqueue_scan

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
        make=body.make,
        custom_prompt=body.custom_prompt,
    )
    tasks_name = enqueue_enhance(task_payload)

    async with pool.acquire() as conn:
        await queries.set_job_tasks_name(conn, job.id, tasks_name)

    return EnhanceResponse(job_id=job.id)


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

    async with pool.acquire() as conn:
        for asset_id in body.asset_ids:
            asset = await queries.get_asset(conn, asset_id)
            if asset is None or asset.session_id != body.session_id:
                raise HTTPException(
                    status_code=status.HTTP_404_NOT_FOUND,
                    detail=f"Asset {asset_id} not found",
                )

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
