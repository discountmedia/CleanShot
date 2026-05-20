"""
Additional API routes required by Phase 2 v2.5 UI:

  GET  /api/v1/scan/results/{job_id}
       Returns per-provider ScanResults + ConsensusResult for a completed scan job.
       Used by the Scan tab to populate per-provider cards after polling /jobs/{id}.

  POST /api/v1/enhance/regen
       Single-image regen from the Scan tab regenerate button.
       Auto-prompt is built client-side and sent as `regen_prompt`.
       Identical to /enhance but with an explicit prompt override.
"""

from __future__ import annotations

import uuid

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel
from typing import Literal

from cleanshot_api.core.security import require_api_key
from cleanshot_api.db import queries
from cleanshot_api.db.pool import get_pool
from cleanshot_api.models.schemas import (
    EnhanceToggles,
    EnhanceTaskPayload,
    JobStatusEnum,
    OperationEnum,
)
from cleanshot_api.services.tasks import enqueue_enhance

router = APIRouter(prefix="/api/v1", tags=["scan-results", "regen"])


# ─── GET scan results for a job ──────────────────────────────────────────────

@router.get(
    "/scan/results/{job_id}",
    dependencies=[Depends(require_api_key)],
)
async def get_scan_results(
    job_id: uuid.UUID,
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict:
    """
    Returns all ScanResult rows + ConsensusResult for a completed scan job.
    The Scan tab calls this after the poll job returns status=complete.
    """
    async with pool.acquire() as conn:
        job = await queries.get_job(conn, job_id)
        if job is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Job not found")

        if job.status != JobStatusEnum.complete:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=f"Job not complete (status={job.status})",
            )

        # Fetch per-provider rows
        rows = await conn.fetch(
            "SELECT * FROM scan_results WHERE job_id = $1 ORDER BY created_at",
            job_id,
        )
        import json
        provider_results = []
        for r in rows:
            data = dict(r)
            data["anomalies"] = json.loads(data["anomalies"])
            provider_results.append({
                "provider":    data["provider"],
                "verdict":     data["verdict"],
                "confidence":  data["confidence"],
                "anomalies":   data["anomalies"],
                "summary":     data["summary"],
                "latencyMs":   data["latency_ms"],
            })

        # Fetch consensus if present
        consensus_row = await conn.fetchrow(
            "SELECT * FROM consensus_results WHERE job_id = $1 ORDER BY created_at DESC LIMIT 1",
            job_id,
        )
        consensus = None
        if consensus_row:
            cd = dict(consensus_row)
            consensus = {
                "verdict":    cd["verdict"],
                "confidence": cd["confidence"],
            }

    return {
        "jobId": str(job_id),
        "providerResults": provider_results,
        "consensusVerdict":    consensus["verdict"]    if consensus else None,
        "consensusConfidence": consensus["confidence"] if consensus else None,
    }


# ─── POST single-image regen (from Scan tab) ─────────────────────────────────

class RegenRequest(BaseModel):
    session_id: uuid.UUID
    asset_id: uuid.UUID
    regen_prompt: str
    idempotency_key: str
    # Operator-selected provider for the regen pass. Defaults to gemini for
    # backward compatibility with existing callers that don't pass one.
    provider: Literal["gemini", "openai", "flux", "reve", "grok"] = "gemini"


class RegenResponse(BaseModel):
    job_id: uuid.UUID


@router.post(
    "/enhance/regen",
    response_model=RegenResponse,
    dependencies=[Depends(require_api_key)],
    status_code=202,
)
async def enqueue_regen(
    body: RegenRequest,
    pool: asyncpg.Pool = Depends(get_pool),
) -> RegenResponse:
    """
    Single-image regen triggered from the Scan tab.
    Uses the same enhance pipeline (default provider: gemini) but with an
    explicit regen_prompt instead of toggle-derived instructions, and an
    operator-selected provider. The prompt flows through
    EnhanceTaskPayload.custom_prompt; the worker treats that as a verbatim
    override and skips _build_enhance_prompt.
    """
    async with pool.acquire() as conn:
        asset = await queries.get_asset(conn, body.asset_id)
        if asset is None or asset.session_id != body.session_id:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Asset not found")

        job = await queries.create_job(
            conn,
            session_id=body.session_id,
            operation=OperationEnum.enhance,
            input_asset_id=body.asset_id,
            idempotency_key=body.idempotency_key,
        )

    # Encode the regen prompt in the toggles field using a sentinel pattern.
    # The enhance worker detects this and uses the prompt verbatim.
    # All toggles are False — the prompt IS the instruction.
    task_payload = EnhanceTaskPayload(
        job_id=job.id,
        session_id=body.session_id,
        input_asset_id=body.asset_id,
        input_gcs_uri=asset.gcs_uri,
        toggles=EnhanceToggles(),           # all False
        provider=body.provider,
        custom_prompt=body.regen_prompt,
    )
    tasks_name = enqueue_enhance(task_payload)

    async with pool.acquire() as conn:
        await queries.set_job_tasks_name(conn, job.id, tasks_name)

    return RegenResponse(job_id=job.id)
