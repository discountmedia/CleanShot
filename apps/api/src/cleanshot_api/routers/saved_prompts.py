"""
Saved-prompt endpoints — per-user reusable enhance prompts.

  GET    /api/v1/prompts             — list the current user's saved prompts
  POST   /api/v1/prompts             — save a new one (409 on title collision
                                       unless overwrite=true)
  PATCH  /api/v1/prompts/{id}        — rename
  DELETE /api/v1/prompts/{id}        — delete

Enhance went prompt-first in July 2026, so the operator's own text drives the
result. Good prompts were being retyped from scratch every session; this is
where they live instead.

Identity comes from the BFF's X-User-Email header — the same pattern used by
/api/v1/profile, /api/v1/approvals and /api/v1/history, set from the Better
Auth session in apps/web/lib/auth.ts. Every query in this module is scoped by
that email in its WHERE clause, so a user can only ever see, edit, or delete
their own prompts; there is no shared or public prompt concept to widen that.
Ownership is enforced in the query, not by checking a returned row, so a
guessed UUID belonging to another user simply matches nothing.
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
    RenameSavedPromptRequest,
    SavedPrompt,
)

router = APIRouter(prefix="/api/v1", tags=["prompts"])


@router.get(
    "/prompts",
    response_model=list[SavedPrompt],
    dependencies=[Depends(require_api_key)],
)
async def list_prompts(
    pool: asyncpg.Pool = Depends(get_pool),
    x_user_email: str = Header(..., alias="X-User-Email"),
) -> list[SavedPrompt]:
    """Most-recently-updated first — the order the dropdown renders."""
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
    Save a prompt under a title.

    Title collisions are answered with 409 rather than resolved here. The
    caller (the operator, via the UI) decides between overwrite and rename;
    picking one for them would either lose a prompt or quietly create a
    near-duplicate, and neither is ours to choose. `overwrite=true` is that
    decision coming back.
    """
    email = x_user_email.lower()
    async with pool.acquire() as conn:
        if body.overwrite:
            row = await queries.overwrite_saved_prompt_body(
                conn, user_email=email, title=body.title, body=body.body,
            )
            if row is not None:
                return SavedPrompt(**row)
            # Nothing to overwrite — the title was deleted between the
            # collision response and this call. Fall through and insert.

        try:
            row = await queries.create_saved_prompt(
                conn, user_email=email, title=body.title, body=body.body,
            )
        except asyncpg.UniqueViolationError:
            # The unique index is the authority, not a prior SELECT — two tabs
            # racing on the same title both land here and exactly one wins.
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="A prompt with that title already exists.",
            ) from None
    return SavedPrompt(**row)


@router.patch(
    "/prompts/{prompt_id}",
    response_model=SavedPrompt,
    dependencies=[Depends(require_api_key)],
)
async def rename_prompt(
    prompt_id: uuid.UUID,
    body: RenameSavedPromptRequest,
    pool: asyncpg.Pool = Depends(get_pool),
    x_user_email: str = Header(..., alias="X-User-Email"),
) -> SavedPrompt:
    email = x_user_email.lower()
    async with pool.acquire() as conn:
        try:
            row = await queries.rename_saved_prompt(
                conn, user_email=email, prompt_id=prompt_id, title=body.title,
            )
        except asyncpg.UniqueViolationError:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="A prompt with that title already exists.",
            ) from None
    if row is None:
        # Covers both "no such prompt" and "not yours" — deliberately the same
        # response, so this can't be used to probe for other users' prompt ids.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Prompt not found.",
        )
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
) -> None:
    email = x_user_email.lower()
    async with pool.acquire() as conn:
        deleted = await queries.delete_saved_prompt(
            conn, user_email=email, prompt_id=prompt_id,
        )
    if not deleted:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Prompt not found.",
        )
