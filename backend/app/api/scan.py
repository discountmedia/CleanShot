"""
Scan API — submits a multi-provider artifact-scan job.
Returns immediately with a job_id; frontend polls /jobs/{id}.
"""

import hashlib
import json

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from app.config import settings


router = APIRouter(tags=["scan"])


class ScanRequest(BaseModel):
    session_id: str
    asset_id: str


class ScanResponse(BaseModel):
    job_id: str
    status: str


def _stable_job_id(prefix: str, payload: dict) -> str:
    digest = hashlib.sha256(
        json.dumps(payload, sort_keys=True).encode()
    ).hexdigest()[:16]
    return f"{prefix}_{digest}"


@router.post("/scan", response_model=ScanResponse)
async def submit_scan(request: Request, body: ScanRequest) -> ScanResponse:
    """Enqueue an artifact-scan job. Returns job_id for polling."""
    session_svc = request.app.state.session_service
    arq_pool = request.app.state.arq_pool

    asset = await session_svc.get_asset(body.asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="asset not found")
    if asset.get("session_id") != body.session_id:
        raise HTTPException(status_code=403, detail="asset does not belong to session")
    if not asset.get("gcs_uri"):
        raise HTTPException(
            status_code=409,
            detail="asset has no uploaded bytes yet — PUT to signed URL first",
        )

    job_id = _stable_job_id("scan", {"asset": body.asset_id})

    await session_svc.create_job_record(
        job_id=job_id,
        asset_id_in=body.asset_id,
        operation="scan",
    )

    await arq_pool.enqueue_job(
        "process_image",
        asset_id=body.asset_id,
        operation="scan",
        _queue_name=settings.image_queue_name,
        _job_id=job_id,
    )

    return ScanResponse(job_id=job_id, status="queued")
