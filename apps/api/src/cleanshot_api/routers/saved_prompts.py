"""
Shared-template endpoints — reusable enhance prompts, visible to everyone.

  GET    /api/v1/prompts             — list every shared template
  POST   /api/v1/prompts             — save a new one (409 on title collision)
  DELETE /api/v1/prompts/{id}        — delete (ADMIN ONLY)
  POST   /api/v1/prompts/{id}/vote   — upvote
  DELETE /api/v1/prompts/{id}/vote   — withdraw an upvote
  POST   /api/v1/prompts/{id}/use    — count one use

Enhance went prompt-first in July 2026, so the operator's own text drives the
result. Good prompts were being retyped from scratch every session; this is
where they live instead.

SHARED SINCE 2026-08-25. These used to be private per-user prompts. They are
now one company-wide library: a template user A writes for a sitdown Hyster is
picked straight out of the list by users B through E. The prompts that existed
before the change were published with it.

THREE RULES THAT LOOK LIKE OMISSIONS AND ARE NOT:

  • There is NO rename and NO overwrite. A template is written once. Votes and
    a use count accumulate against a specific text, and editing the row under
    them would leave that reputation pointing at something nobody endorsed —
    the top-rated template would be top-rated for a prompt that no longer
    exists. Customising is load → edit → save under a new title. If you are
    about to add a PATCH here, this is what it breaks.

  • Delete is ADMIN ONLY — not creator-or-admin. Once four other people rely
    on a template, its author is not the person with the most at stake in
    removing it. Curation is an owner's job, not a courtesy to whoever typed
    it first.

  • Votes are one-per-user, enforced by the composite primary key on
    saved_prompt_votes rather than by a check in this file.

Identity comes from the BFF's X-User-Email header — the same pattern used by
/api/v1/profile, /api/v1/approvals and /api/v1/history, set from the Better
Auth session in apps/web/lib/auth.ts. Reads are unscoped; the email decides
authorship on create, who a vote belongs to, and nothing else. The admin flag
arrives as X-User-Is-Admin, decided in the BFF exactly as /api/v1/admin/* does
it — the BFF is the only caller of FastAPI in production, so the allowlist
lives in one place rather than two.
"""

from __future__ import annotations

import uuid

import asyncpg
from fastapi import APIRouter, Depends, Header, HTTPException, status

from cleanshot_api.core.security import require_api_key
from cleanshot_api.db import queries
from cleanshot_api.db.pool import get_pool
from cleanshot_api.models.schemas import (
    CreateSavedPromptRequest,
    PromptUseResponse,
    PromptVoteResponse,
    SavedPrompt,
)

router = APIRouter(prefix="/api/v1", tags=["prompts"])


def _is_admin(header_value: str | None) -> bool:
    """
    The BFF sends "true" only for an email on the ADMIN_EMAILS allowlist.
    Anything else — absent, empty, spoofed nonsense — is not an admin. A
    direct caller can't set it anyway: require_api_key gates the whole route
    and the internal key is only held by the BFF.
    """
    return (header_value or "").strip().lower() == "true"


@router.get(
    "/prompts",
    response_model=list[SavedPrompt],
    dependencies=[Depends(require_api_key)],
)
async def list_prompts(
    pool: asyncpg.Pool = Depends(get_pool),
    x_user_email: str = Header(..., alias="X-User-Email"),
) -> list[SavedPrompt]:
    """
    Every shared template, most-recently-created first, with vote and use
    counts attached.

    The email doesn't filter anything — the set of rows is identical for
    everybody. It resolves one per-viewer field, `voted`, so the upvote
    control is in the right state on first paint instead of flickering.

    Ordering here is recency; top-rated and most-used are re-sorts of this
    same payload on the client. The library is small enough that shipping it
    whole beats three server-side sort modes, and it means switching sort is
    instant rather than a round-trip.
    """
    async with pool.acquire() as conn:
        rows = await queries.list_saved_prompts(conn, x_user_email.lower())
    return [SavedPrompt(**r) for r in rows]


@router.post(
    "/prompts",
    response_model=SavedPrompt,
    dependencies=[Depends(require_api_key)],
    status_code=status.HTTP_201_CREATED,
)
async def create_prompt(
    body: CreateSavedPromptRequest,
    pool: asyncpg.Pool = Depends(get_pool),
    x_user_email: str = Header(..., alias="X-User-Email"),
) -> SavedPrompt:
    """
    Save a template under a title. Titles are unique across the whole library
    and permanent, so a collision has exactly one resolution: pick a different
    title. Not even the creator can overwrite their own — see the module
    docstring for why. The 409 names the current holder, because "taken" is
    more useful with "…by Dana, on Aug 12" attached.
    """
    email = x_user_email.lower()
    async with pool.acquire() as conn:
        try:
            row = await queries.create_saved_prompt(
                conn, user_email=email, title=body.title, body=body.body,
            )
        except asyncpg.UniqueViolationError:
            # The unique index is the authority, not a prior SELECT — two tabs
            # racing on the same title both land here and exactly one wins.
            existing = await queries.get_saved_prompt_by_title(conn, body.title)
            owner = existing["user_email"] if existing else "another user"
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail=(
                    "You already have a template with that title."
                    if existing is not None and existing["user_email"] == email
                    else f"{owner} already has a template with that title."
                ),
            ) from None
    return SavedPrompt(**row)


@router.delete(
    "/prompts/{prompt_id}",
    status_code=status.HTTP_204_NO_CONTENT,
    dependencies=[Depends(require_api_key)],
)
async def delete_prompt(
    prompt_id: uuid.UUID,
    pool: asyncpg.Pool = Depends(get_pool),
    x_user_email: str = Header(..., alias="X-User-Email"),
    x_user_is_admin: str | None = Header(None, alias="X-User-Is-Admin"),
) -> None:
    """
    Remove a template for everyone. Admin only — deleting is curation of a
    shared library, not tidying your own drawer, and the author of a
    well-used template is the last person who should be able to pull it
    unilaterally. Its votes go with it (ON DELETE CASCADE).
    """
    if not _is_admin(x_user_is_admin):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=(
                "Only an admin can delete a shared template. "
                "Ask an admin if one needs removing."
            ),
        )
    async with pool.acquire() as conn:
        deleted = await queries.delete_saved_prompt(conn, prompt_id=prompt_id)
    if not deleted:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Template not found.",
        )


@router.post(
    "/prompts/{prompt_id}/vote",
    response_model=PromptVoteResponse,
    dependencies=[Depends(require_api_key)],
)
async def upvote_prompt(
    prompt_id: uuid.UUID,
    pool: asyncpg.Pool = Depends(get_pool),
    x_user_email: str = Header(..., alias="X-User-Email"),
) -> PromptVoteResponse:
    """
    Upvote a template. Idempotent — voting twice is the same as voting once,
    which is what makes "top rated" a headcount rather than a clicking
    contest. Anyone may vote for anything, including their own template;
    policing that would cost more than it saves in a room this size.
    """
    email = x_user_email.lower()
    async with pool.acquire() as conn:
        try:
            await queries.vote_saved_prompt(
                conn, prompt_id=prompt_id, user_email=email,
            )
        except asyncpg.ForeignKeyViolationError:
            # Deleted between the list render and the click.
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND,
                detail="Template not found.",
            ) from None
        count = await queries.count_saved_prompt_votes(conn, prompt_id)
    return PromptVoteResponse(vote_count=count, voted=True)


@router.delete(
    "/prompts/{prompt_id}/vote",
    response_model=PromptVoteResponse,
    dependencies=[Depends(require_api_key)],
)
async def withdraw_vote(
    prompt_id: uuid.UUID,
    pool: asyncpg.Pool = Depends(get_pool),
    x_user_email: str = Header(..., alias="X-User-Email"),
) -> PromptVoteResponse:
    """Withdraw an upvote. A no-op when there wasn't one — the control is a
    toggle, and either way the caller ends up in the state they asked for."""
    email = x_user_email.lower()
    async with pool.acquire() as conn:
        await queries.unvote_saved_prompt(
            conn, prompt_id=prompt_id, user_email=email,
        )
        count = await queries.count_saved_prompt_votes(conn, prompt_id)
    return PromptVoteResponse(vote_count=count, voted=False)


@router.post(
    "/prompts/{prompt_id}/use",
    response_model=PromptUseResponse,
    dependencies=[Depends(require_api_key)],
)
async def record_use(
    prompt_id: uuid.UUID,
    pool: asyncpg.Pool = Depends(get_pool),
) -> PromptUseResponse:
    """
    Count one use — fired when a template is loaded into the prompt box.

    Not authenticated per-user on purpose: this is a popularity counter, not
    an audit trail, and it stores no row saying who used what. If per-user
    template attribution is ever wanted, that is usage_events' job, not this
    column's.

    A missing template answers 200 with a zero count rather than 404. The
    caller is a fire-and-forget beacon behind a successful insert that already
    happened locally; failing it would surface an error for something the
    operator would rightly consider done.
    """
    async with pool.acquire() as conn:
        count = await queries.record_saved_prompt_use(conn, prompt_id)
    return PromptUseResponse(use_count=count or 0)
