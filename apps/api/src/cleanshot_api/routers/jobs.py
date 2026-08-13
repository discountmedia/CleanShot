from __future__ import annotations

import json
import uuid

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Request, status

from cleanshot_api.core.security import require_api_key, require_authenticated_user
from cleanshot_api.db import queries
from cleanshot_api.db.pool import get_pool
from cleanshot_api.models.schemas import JobRecord

router = APIRouter(prefix="/api/v1", tags=["jobs"])

_CACHE_TTL = 3  # seconds — matches frontend polling interval


@router.get(
    "/jobs/{job_id}",
    response_model=JobRecord,
    dependencies=[Depends(require_api_key), Depends(require_authenticated_user)],
)
async def get_job(
    job_id: uuid.UUID,
    request: Request,
    pool: asyncpg.Pool = Depends(get_pool),
) -> JobRecord:
    """
    Poll a single job. Checks Valkey cache first (3s TTL) to reduce DB load
    during high-frequency polling from multiple browser tabs.
    """
    valkey = request.app.state.valkey
    cache_key = f"job:{job_id}"

    # Try Valkey cache
    if valkey:
        try:
            cached = await valkey.get(cache_key)
            if cached:
                return JobRecord.model_validate_json(cached)
        except Exception:
            pass  # Valkey degraded — fall through to DB

    async with pool.acquire() as conn:
        job = await queries.get_job(conn, job_id)

    if job is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")

    # Cache completed/failed jobs longer (they won't change)
    ttl = 60 if job.status in ("complete", "failed", "cancelled") else _CACHE_TTL
    if valkey:
        try:
            await valkey.setex(cache_key, ttl, job.model_dump_json())
        except Exception:
            pass

    return job


@router.get(
    "/jobs/batch/{batch_id}",
    dependencies=[Depends(require_api_key), Depends(require_authenticated_user)],
)
async def get_batch_status(
    batch_id: uuid.UUID,
    request: Request,
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict:
    """
    Aggregate batch status. batch_id is stored in Valkey as a list of job_ids.
    Returns counts by status plus the constituent job records.
    """
    valkey = request.app.state.valkey
    if not valkey:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Batch polling requires Valkey cache",
        )

    raw = await valkey.get(f"batch:{batch_id}")
    if not raw:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Batch not found")

    job_ids = [uuid.UUID(j) for j in json.loads(raw)]

    async with pool.acquire() as conn:
        jobs = await queries.get_jobs_by_ids(conn, job_ids)

    status_counts: dict[str, int] = {}
    for job in jobs:
        status_counts[job.status] = status_counts.get(job.status, 0) + 1

    return {
        "batch_id": str(batch_id),
        "total": len(jobs),
        "status_counts": status_counts,
        "complete": status_counts.get("complete", 0) == len(jobs),
        "jobs": [j.model_dump() for j in jobs],
    }
