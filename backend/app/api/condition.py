"""
Enhance API — submits a condition-enhancement job to the worker.
The endpoint returns immediately with a job_id; the frontend polls
GET /jobs/{job_id} for progress and the final result URL.

v2.3 additions:
  - Brand rule toggles (apply_fork_paint, apply_tire_shine, apply_rust_removal)
    each default on, can be disabled per-photo when Gemini produces bad output
  - extra_instructions: optional per-photo prompt addition (max 1000 chars)
  - Idempotency hash now includes the toggles so the same photo with different
    toggle settings produces a different job_id (each variation is a new run)
"""

import hashlib
import json

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field
from typing import Optional

from app.config import settings


router = APIRouter(tags=["enhance"])


class EnhanceRequest(BaseModel):
    session_id: str
    asset_id: str
    enhancement_level: str = Field(
        default="moderate", pattern="^(light|moderate|heavy)$"
    )
    # Brand rule toggles. Default on; user can disable per-photo if Gemini
    # produces bad output for a specific image (e.g. weird fork paint).
    apply_fork_paint: bool = True
    apply_tire_shine: bool = True
    apply_rust_removal: bool = True
    # Optional per-photo extra instructions. Length-capped so users can't
    # blow up the prompt or token budget.
    extra_instructions: Optional[str] = Field(default=None, max_length=1000)


class EnhanceResponse(BaseModel):
    job_id: str
    status: str


def _stable_job_id(prefix: str, payload: dict) -> str:
    """SHA-derived ID. Same inputs -> same job_id (idempotency)."""
    digest = hashlib.sha256(
        json.dumps(payload, sort_keys=True).encode()
    ).hexdigest()[:16]
    return f"{prefix}_{digest}"


@router.post("/enhance", response_model=EnhanceResponse)
async def submit_enhance(request: Request, body: EnhanceRequest) -> EnhanceResponse:
    """Enqueue an enhance job. Returns job_id for polling."""
    session_svc = request.app.state.session_service
    arq_pool = request.app.state.arq_pool

    # Verify asset exists and belongs to a real session
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

    # Stable, idempotent job ID. Includes ALL knobs so different toggle
    # combinations on the same asset produce different job IDs (allowing
    # users to compare variations side-by-side).
    job_id = _stable_job_id(
        "enhance",
        {
            "asset": body.asset_id,
            "level": body.enhancement_level,
            "fork_paint": body.apply_fork_paint,
            "tire_shine": body.apply_tire_shine,
            "rust_removal": body.apply_rust_removal,
            "extras": body.extra_instructions or "",
        },
    )

    # Initialize the job record so /jobs/{id} responds immediately
    await session_svc.create_job_record(
        job_id=job_id,
        asset_id_in=body.asset_id,
        operation="enhance",
    )

    # Enqueue. Arq dedupes by _job_id while a job with that ID is in-flight
    # or its result is still being held (keep_result window).
    await arq_pool.enqueue_job(
        "process_image",
        asset_id=body.asset_id,
        operation="enhance",
        enhancement_level=body.enhancement_level,
        apply_fork_paint=body.apply_fork_paint,
        apply_tire_shine=body.apply_tire_shine,
        apply_rust_removal=body.apply_rust_removal,
        extra_instructions=body.extra_instructions,
        _queue_name=settings.image_queue_name,
        _job_id=job_id,
    )

    return EnhanceResponse(job_id=job_id, status="queued")
