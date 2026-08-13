from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Header, HTTPException, status

from cleanshot_api.core.security import require_api_key, require_authenticated_user
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
async def create_session(
    pool: asyncpg.Pool = Depends(get_pool),
    x_user_email: str | None = Header(default=None, alias="X-User-Email"),
) -> CreateSessionResponse:
    """
    Create a new session row. If the BFF forwarded an X-User-Email header
    (signed-in user from Better Auth), tag the session with it so the
    admin dashboard can attribute downstream projects + usage_events back
    to a person. Sessions created without auth leave user_email NULL.
    """
    user_email = x_user_email.lower() if x_user_email else None
    async with pool.acquire() as conn:
        session = await queries.create_session(conn, user_email=user_email)
    return CreateSessionResponse(session_id=session.id)


@router.get(
    "/sessions/{session_id}",
    response_model=SessionState,
    dependencies=[Depends(require_api_key), Depends(require_authenticated_user)],
)
async def get_session(
    session_id: uuid.UUID,
    pool: asyncpg.Pool = Depends(get_pool),
) -> SessionState:
    """
    Full session state reconstruction — assets, jobs, scan results and
    consensus results for one session.

    This is the hydration source for the Enhance-tab grid: it is how imported
    photos appear after a media-auditor handoff, and how they survive a page
    reload (the handoff record is TTL'd; the assets are not).

    ACCESS: any signed-in tenant user (`require_authenticated_user`). NOT
    ownership-scoped — editors work a shared queue, so a second editor opening
    a session someone else created is normal work. `sessions.user_email` exists
    for admin-dashboard attribution, not for access control; a NULL value is
    unremarkable here.
    """
    async with pool.acquire() as conn:
        session = await queries.get_session(conn, session_id)
        if session is None:
            # Fixed string, nothing from the request echoed back.
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Session not found",
            )

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
