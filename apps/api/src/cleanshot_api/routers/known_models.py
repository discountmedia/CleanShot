"""
GET /api/v1/known-models -- the Make + Model dropdown list for every user.

Visible entries only; hidden ones stay in the table so the inventory seed
cannot bring them back (see services/known_models.py). Renaming and hiding are
admin endpoints in routers/admin.py, gated by the BFF like the rest of
/api/v1/admin.
"""

from __future__ import annotations

import asyncpg
from fastapi import APIRouter, Depends

from cleanshot_api.core.security import require_api_key
from cleanshot_api.db.pool import get_pool
from cleanshot_api.services import known_models

router = APIRouter(prefix="/api/v1", tags=["known-models"])


@router.get("/known-models", dependencies=[Depends(require_api_key)])
async def list_known_models(pool: asyncpg.Pool = Depends(get_pool)) -> dict:
    async with pool.acquire() as conn:
        rows = await known_models.list_visible(conn)
    return {"models": [{"id": str(r["id"]), "make": r["make"], "model": r["model"]} for r in rows]}
