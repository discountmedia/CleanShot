"""
media-auditor to CleanShot photo import.

Three endpoints:

  POST /api/v1/ingest/handoff
       Called server-to-server by media-auditor. Creates an empty CleanShot
       session owned by the requesting user, enqueues one copy task per photo,
       and returns immediately with {handoff_id, exchange_token}. It does NOT
       wait for ingest -- the session exists before any asset does, so the
       browser can be redirected instantly and watch photos arrive.

  POST /api/v1/ingest/handoff/exchange
       Called by the CleanShot web BFF when the browser lands carrying the
       token. Trades the token for the session.

  GET  /api/v1/ingest/handoff/{handoff_id}
       Per-photo status for the progress poller.

Token discipline
----------------
The token is short-TTL, single-use, and bound to the requesting user's identity.
It reaches the browser in a URL FRAGMENT (never a query string -- app/page.tsx is
force-dynamic, so a query-string token would land in Vercel's function logs and
in Referer headers).

Rules enforced here:
  * Only the SHA-256 is persisted. A database dump must not yield a live token.
  * It is never logged -- not the value, not a prefix, not a truncation. Failures
    are logged against handoff_id instead, so "my photos didn't come through" is
    still diagnosable.
  * Rejections return FIXED strings and echo nothing from the request.
  * Re-presenting a CONSUMED token by the same user returns the session it
    already created. Reload, back-navigation and React StrictMode's double
    effect all do this; refusing them would break normal use, not an attack.
    Reject only on expiry or user mismatch.
  * The success response does not include the token.
"""

from __future__ import annotations

import datetime
import hashlib
import logging
import secrets
import uuid

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, status

from cleanshot_api.core.security import require_api_key, require_authenticated_user
from cleanshot_api.db import queries
from cleanshot_api.db.pool import get_pool
from cleanshot_api.models.schemas import (
    IngestCopyTaskPayload,
    IngestExchangeRequest,
    IngestExchangeResponse,
    IngestHandoffRequest,
    IngestHandoffResponse,
    IngestHandoffStatus,
    IngestItemStatus,
)
from cleanshot_api.services.tasks import enqueue_ingest_copy

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1", tags=["ingest"])

# 60s is plenty for a redirect and keeps the theft window tiny. Note this bounds
# only the FIRST exchange; once consumed, the handoff row keeps answering the
# same user indefinitely so reloads keep working.
_TOKEN_TTL = datetime.timedelta(seconds=60)

# Fixed rejection copy. Says nothing about which check failed -- that lives in
# the server log, keyed by handoff_id.
_REJECTED = "Import link is no longer valid."


def _hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


@router.post(
    "/ingest/handoff",
    response_model=IngestHandoffResponse,
    dependencies=[Depends(require_api_key)],
    status_code=202,
)
async def create_handoff(
    body: IngestHandoffRequest,
    # Identity comes from the dependency's RETURN VALUE, not a second Header()
    # declaration: a required header param turns a missing header into a Pydantic
    # 422, and FastAPI's default 422 body echoes the offending input. There is no
    # custom validation handler on this app, so that reflection is real.
    # require_authenticated_user raises a fixed-string 404 instead.
    user_email: str = Depends(require_authenticated_user),
    pool: asyncpg.Pool = Depends(get_pool),
) -> IngestHandoffResponse:
    """
    Create the session, enqueue the copies, hand back a token. Returns 202
    immediately -- the copy work is async and the caller redirects the browser
    right away.

    Ordering matters: the session and all item rows are committed BEFORE the
    token is returned. Otherwise the browser could exchange the token and read a
    session whose items don't exist yet, and the poller would report a complete
    import of zero photos.
    """
    token = secrets.token_urlsafe(32)
    expires_at = datetime.datetime.now(tz=datetime.timezone.utc) + _TOKEN_TTL

    payloads: list[IngestCopyTaskPayload] = []

    async with pool.acquire() as conn:
        async with conn.transaction():
            session = await queries.create_session(conn, user_email=user_email)
            handoff_id = await queries.create_handoff(
                conn,
                session_id=session.id,
                user_email=user_email,
                source_batch_id=body.source_batch_id,
                stock_number=body.stock_number,
                token_hash=_hash_token(token),
                token_expires_at=expires_at,
                expected_count=len(body.images),
            )
            # Reverse link so a reloaded page can find its import without the
            # handoff id being in the URL (the token is stripped from the
            # address bar the moment it is exchanged).
            await queries.set_session_handoff(conn, session.id, handoff_id)

            for image in body.images:
                item_id = await queries.create_ingest_item(
                    conn,
                    handoff_id=handoff_id,
                    session_id=session.id,
                    source_batch_id=body.source_batch_id,
                    source_url=image.url,
                    filename=(image.filename or "").strip(),
                )
                payloads.append(
                    IngestCopyTaskPayload(
                        item_id=item_id,
                        handoff_id=handoff_id,
                        session_id=session.id,
                        source_batch_id=body.source_batch_id,
                        source_url=image.url,
                        filename=(image.filename or "").strip(),
                        stock_number=body.stock_number,
                    )
                )

    # Enqueue AFTER the transaction commits -- a task that starts before its item
    # row is visible would fail its own lookup.
    #
    # An enqueue failure is per-photo and non-fatal: the item stays 'pending' and
    # the poller surfaces it. Failing the whole handoff here would throw away a
    # session that already exists and photos that may already be landing.
    enqueued = 0
    for payload in payloads:
        try:
            enqueue_ingest_copy(payload)
            enqueued += 1
        except Exception:
            logger.exception(
                "handoff %s: could not enqueue copy for item %s",
                handoff_id,
                payload.item_id,
            )

    logger.info(
        "handoff %s created for session %s: %d photos, %d enqueued",
        handoff_id,
        session.id,
        len(payloads),
        enqueued,
    )

    return IngestHandoffResponse(
        handoff_id=handoff_id,
        exchange_token=token,
        expected_count=len(payloads),
    )


@router.post(
    "/ingest/handoff/exchange",
    response_model=IngestExchangeResponse,
    dependencies=[Depends(require_api_key)],
)
async def exchange_handoff_token(
    body: IngestExchangeRequest,
    # See create_handoff -- identity via the dependency, never a required Header().
    caller: str = Depends(require_authenticated_user),
    pool: asyncpg.Pool = Depends(get_pool),
) -> IngestExchangeResponse:
    """
    Trade the token for the session. See the module docstring for the rules.

    Every rejection is the same fixed string with the same status, so a caller
    learns only "no" -- never whether a token existed, expired, or belonged to
    someone else.
    """
    token = body.token.strip()

    if not token:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=_REJECTED)

    async with pool.acquire() as conn:
        handoff = await queries.get_handoff_by_token_hash(conn, _hash_token(token))

        if handoff is None:
            # Note the ABSENCE of the token in this log line. Deliberate.
            logger.warning("handoff exchange refused: unknown token (user=%s)", caller)
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=_REJECTED)

        handoff_id = handoff["id"]

        if handoff["user_email"].lower() != caller:
            logger.warning(
                "handoff %s exchange refused: user mismatch (caller=%s)",
                handoff_id,
                caller,
            )
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail=_REJECTED)

        # Expiry applies to the FIRST exchange only. Once consumed, the same user
        # may keep re-presenting it -- that is reload and back-button, not theft,
        # and the window it would otherwise open is bounded by the user check
        # directly above.
        already_consumed = handoff["consumed_at"] is not None
        if not already_consumed:
            expires_at = handoff["token_expires_at"]
            if expires_at.tzinfo is None:
                expires_at = expires_at.replace(tzinfo=datetime.timezone.utc)
            if datetime.datetime.now(tz=datetime.timezone.utc) > expires_at:
                logger.warning("handoff %s exchange refused: token expired", handoff_id)
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN, detail=_REJECTED
                )
            await queries.mark_handoff_consumed(conn, handoff_id)

    logger.info("handoff %s exchanged (repeat=%s)", handoff_id, already_consumed)

    # Whitelisted fields only. The token is not among them and must never be.
    return IngestExchangeResponse(
        session_id=handoff["session_id"],
        handoff_id=handoff_id,
        expected_count=handoff["expected_count"],
    )


@router.get(
    "/ingest/handoff/{handoff_id}",
    response_model=IngestHandoffStatus,
    dependencies=[Depends(require_api_key), Depends(require_authenticated_user)],
)
async def get_handoff_status(
    handoff_id: uuid.UUID,
    pool: asyncpg.Pool = Depends(get_pool),
) -> IngestHandoffStatus:
    """
    Per-photo import status for the progress poller.

    Envelope mirrors GET /api/v1/jobs/batch/{batch_id} -- same
    total / status_counts / complete triple -- so the frontend reuses a shape it
    already knows instead of learning a second one.

    Reads Postgres directly and has NO cache dependency, unlike /jobs/batch which
    503s without Valkey. This endpoint is the only way an operator sees their
    import land, so it cannot be the thing that goes down.

    `complete` means no item is still pending -- landed and failed both count.
    That is the poller's terminal signal, and it is reachable even when photos
    fail, which is what keeps a failed copy from spinning forever in the UI.
    """
    async with pool.acquire() as conn:
        handoff = await queries.get_handoff(conn, handoff_id)
        if handoff is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Not found"
            )
        rows = await queries.get_ingest_items(conn, handoff_id)

    counts: dict[str, int] = {}
    for row in rows:
        counts[row["status"]] = counts.get(row["status"], 0) + 1

    return IngestHandoffStatus(
        handoff_id=handoff_id,
        session_id=handoff["session_id"],
        total=len(rows),
        status_counts=counts,
        complete=counts.get("pending", 0) == 0,
        items=[
            IngestItemStatus(
                item_id=row["id"],
                filename=row["filename"],
                status=row["status"],
                asset_id=row["asset_id"],
                error=row["error"],
            )
            for row in rows
        ],
    )
