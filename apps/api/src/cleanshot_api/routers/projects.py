from __future__ import annotations

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, status

from cleanshot_api.core.security import require_api_key
from cleanshot_api.db import queries
from cleanshot_api.db.pool import get_pool
from cleanshot_api.models.schemas import SaveProjectRequest, SaveProjectResponse

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
            username=body.username,
            photo_type=body.photo_type.value,
        )

    return SaveProjectResponse(project_id=project.id)
