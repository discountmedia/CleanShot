"""
asyncpg connection pool.

Opened once in FastAPI lifespan, closed on shutdown.
Access via `get_pool()` dependency or directly from `app.state.pool`.
"""

from __future__ import annotations

import asyncpg
from fastapi import Request


async def create_pool(database_url: str) -> asyncpg.Pool:
    """Create a pool sized for Cloud Run concurrency=80 with headroom."""
    return await asyncpg.create_pool(
        dsn=database_url,
        min_size=2,
        max_size=10,         # Cloud Run pod: 10 is ample for concurrency=80 (async I/O)
        command_timeout=30,
        statement_cache_size=200,
    )


def get_pool(request: Request) -> asyncpg.Pool:
    """FastAPI dependency: extracts pool from app state."""
    return request.app.state.pool  # type: ignore[no-any-return]
