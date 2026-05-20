"""
Support / feature-request endpoints.

User-facing:
  POST /api/v1/support  — submit a ticket (support | feature)

Admin endpoints live under /api/v1/admin/support and are defined in
admin.py so they stay grouped with the rest of the admin surface.
"""

from __future__ import annotations

import asyncpg
from fastapi import APIRouter, Depends, Header

from cleanshot_api.core.security import require_api_key
from cleanshot_api.db import queries
from cleanshot_api.db.pool import get_pool
from cleanshot_api.models.schemas import (
    CreateSupportTicketRequest,
    SupportTicketRecord,
)

router = APIRouter(prefix="/api/v1", tags=["support"])


@router.post(
    "/support",
    response_model=SupportTicketRecord,
    dependencies=[Depends(require_api_key)],
    status_code=201,
)
async def create_ticket(
    body: CreateSupportTicketRequest,
    pool: asyncpg.Pool = Depends(get_pool),
    x_user_email: str = Header(..., alias="X-User-Email"),
) -> SupportTicketRecord:
    """
    File a new support ticket or feature request. user_email is taken
    from the BFF-injected X-User-Email header (set from the Better Auth
    session) — clients can't spoof which user submitted.
    """
    async with pool.acquire() as conn:
        row = await queries.create_support_ticket(
            conn,
            user_email=x_user_email,
            type_=body.type.value,
            subject=body.subject,
            body=body.body,
        )
    return SupportTicketRecord(**row)
