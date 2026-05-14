from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends
from fastapi.responses import JSONResponse

from cleanshot_api.core.security import require_api_key
from cleanshot_api.db.pool import get_pool
from cleanshot_api.db import queries
from cleanshot_api.models.schemas import (
    CreateSessionResponse,
    SessionState,
)

import asyncpg

router = APIRouter(prefix="/api/v1", tags=["sessions"])


@router.post(
    "/sessions",
    response_model=CreateSessionResponse,
    dependencies=[Depends(require_api_key)],
    status_code=201,
)
async def create_session(pool: asyncpg.Pool = Depends(get_pool)) -> CreateSessionResponse:
    async with pool.acquire() as conn:
        session = await queries.create_session(conn)
    return CreateSessionResponse(session_id=session.id)


@router.get(
    "/sessions/{session_id}",
    response_model=SessionState,
    dependencies=[Depends(require_api_key)],
)
async def get_session(
    session_id: uuid.UUID,
    pool: asyncpg.Pool = Depends(get_pool),
) -> SessionState:
    """
    Full session state reconstruction — called on every page load.
    Returns all assets, jobs, scan results, and consensus results for the session.
    """
    async with pool.acquire() as conn:
        session = await queries.get_session(conn, session_id)
        if session is None:
            return JSONResponse(status_code=404, content={"detail": "Session not found"})

        await queries.touch_session(conn, session_id)

        project = await queries.get_project_for_session(conn, session_id)
        assets = await queries.get_assets_for_session(conn, session_id)
        jobs = await queries.get_jobs_for_session(conn, session_id)
        scan_results = await queries.get_scan_results_for_session(conn, session_id)

    return SessionState(
        session=session,
        project=project,
        assets=assets,
        jobs=jobs,
        scan_results=scan_results,
    )
