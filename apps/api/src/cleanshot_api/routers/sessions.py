from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, Header, HTTPException, status

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
    dependencies=[Depends(require_api_key)],
)
async def get_session(
    session_id: uuid.UUID,
    x_user_email: str | None = Header(default=None, alias="X-User-Email"),
    pool: asyncpg.Pool = Depends(get_pool),
) -> SessionState:
    """
    Full session state reconstruction — assets, jobs, scan results and
    consensus results for one session.

    This is the hydration source for the Enhance-tab grid: it is how imported
    photos appear after a media-auditor handoff, and how they survive a page
    reload (the handoff record is TTL'd; the assets are not).

    ACCESS: session-scoped. The caller must be the user the session is
    attributed to. Sessions with a NULL `user_email` are unowned (pre-SSO rows,
    or created by a direct API call that sent no identity header) and stay
    readable — there is no owner to protect, and denying them would break
    legacy rows. Everything else requires a matching X-User-Email.
    """
    async with pool.acquire() as conn:
        session = await queries.get_session(conn, session_id)
        owner = await queries.get_session_user_email(conn, session_id)

        # Missing and forbidden return the SAME 404 with the SAME fixed body,
        # deliberately: a distinct 403 on mismatch would confirm that a session
        # id exists, which is exactly what an id-guessing probe wants to learn.
        # Nothing from the request reaches the response — same no-echo
        # discipline as the handoff exchange route.
        if session is None or (
            owner is not None
            and (x_user_email is None or x_user_email.lower() != owner.lower())
        ):
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
