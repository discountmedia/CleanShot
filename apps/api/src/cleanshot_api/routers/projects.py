from __future__ import annotations

import logging

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, status

from cleanshot_api.core.security import require_api_key
from cleanshot_api.db import queries
from cleanshot_api.db.pool import get_pool
from cleanshot_api.models.schemas import SaveProjectRequest, SaveProjectResponse
from cleanshot_api.services import known_models

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1", tags=["projects"])


@router.post(
    "/projects/save",
    response_model=SaveProjectResponse,
    dependencies=[Depends(require_api_key)],
)
async def save_project(
    body: SaveProjectRequest,
    pool: asyncpg.Pool = Depends(get_pool),
) -> SaveProjectResponse:
    """
    Save/upsert a project. All 8 fields validated server-side.
    UPSERT on (session_id, title) — re-saving updates metadata.
    Export endpoints return HTTP 403 until this endpoint is called.
    """
    async with pool.acquire() as conn:
        session = await queries.get_session(conn, body.session_id)
        if session is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Session not found"
            )

        project = await queries.save_project(
            conn,
            session_id=body.session_id,
            title=body.title,
            make=body.make,
            year=body.year,
            model=body.model,
            tire_type=body.tire_type,
            capacity=body.capacity,
            fuel_type=body.fuel_type,
            color=(body.color or "").strip() or None,
            dual_drive=body.dual_drive,
            cab=body.cab,
            username=body.username,
            photo_type=body.photo_type.value,
        )

        # A make + model typed through "Other" joins everyone's dropdown list
        # here, at save, when the values are final. Best effort: the list is a
        # convenience, and it must never cost the operator their export.
        try:
            if await known_models.record_from_project(
                conn,
                make=body.make, model=body.model, created_by=body.username,
                year=body.year, tire_type=body.tire_type, capacity=body.capacity,
                fuel_type=body.fuel_type, color=body.color,
                dual_drive=body.dual_drive, cab=body.cab,
            ):
                logger.info("known_models: added %s %s", body.make, body.model)
        except Exception:
            logger.exception("known_models: could not record %s %s", body.make, body.model)

    return SaveProjectResponse(project_id=project.id)
