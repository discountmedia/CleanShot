"""
Session & Asset Tracking — Redis-backed.

Schema:
  sess:{session_id}            HASH   { user_id?, created_at, last_activity }
                                       TTL settings.session_ttl_seconds
  asset:{asset_id}             HASH   { session_id, gcs_uri, mime_type, created_at, current_op_uri? }
                                       TTL settings.asset_ttl_seconds
  job:{job_id}                 HASH   { status, progress, message,
                                        asset_id_in, asset_id_out?, result_uri?,
                                        created_at, updated_at }
                                       TTL settings.job_ttl_seconds

IDs are UUIDv7 (sortable by creation time, no DB needed for ordering).
"""

import time
import structlog
from typing import Optional
from uuid6 import uuid7
from redis.asyncio import Redis

from app.config import settings


logger = structlog.get_logger()


class SessionService:
    """Manages sessions, assets, and job records in Redis."""

    def __init__(self, redis: Redis):
        self.redis = redis

    # -------------------------------------------------------------------------
    # Sessions
    # -------------------------------------------------------------------------

    async def create_session(self, user_id: Optional[str] = None) -> str:
        """Create a new session, return session_id."""
        session_id = f"sess_{uuid7().hex[:16]}"
        now = time.time()
        await self.redis.hset(
            f"sess:{session_id}",
            mapping={
                "user_id": user_id or "",
                "created_at": now,
                "last_activity": now,
            },
        )
        await self.redis.expire(f"sess:{session_id}", settings.session_ttl_seconds)
        logger.info("Session created", session_id=session_id)
        return session_id

    async def touch_session(self, session_id: str) -> bool:
        """Refresh session activity timestamp + TTL. Returns True if session exists."""
        key = f"sess:{session_id}"
        if not await self.redis.exists(key):
            return False
        await self.redis.hset(key, "last_activity", time.time())
        await self.redis.expire(key, settings.session_ttl_seconds)
        return True

    # -------------------------------------------------------------------------
    # Assets
    # -------------------------------------------------------------------------

    async def create_asset(
        self,
        session_id: str,
        gcs_uri: str,
        mime_type: str,
    ) -> str:
        """Register a new asset (uploaded image) in Redis."""
        asset_id = f"asset_{uuid7().hex[:16]}"
        await self.redis.hset(
            f"asset:{asset_id}",
            mapping={
                "session_id": session_id,
                "gcs_uri": gcs_uri,
                "mime_type": mime_type,
                "created_at": time.time(),
            },
        )
        await self.redis.expire(f"asset:{asset_id}", settings.asset_ttl_seconds)
        logger.info("Asset registered", asset_id=asset_id, session_id=session_id)
        return asset_id

    async def get_asset(self, asset_id: str) -> Optional[dict]:
        """Read asset metadata. Returns None if not found."""
        data = await self.redis.hgetall(f"asset:{asset_id}")
        if not data:
            return None
        # redis.asyncio returns bytes; decode for sane consumption
        return {k.decode(): v.decode() for k, v in data.items()}

    # -------------------------------------------------------------------------
    # Jobs
    # -------------------------------------------------------------------------

    async def create_job_record(
        self,
        job_id: str,
        asset_id_in: str,
        operation: str,
    ) -> None:
        """Initialize a job record. Worker will update progress as it runs."""
        now = time.time()
        await self.redis.hset(
            f"job:{job_id}",
            mapping={
                "status": "queued",
                "progress": 0,
                "message": "Queued",
                "asset_id_in": asset_id_in,
                "operation": operation,
                "created_at": now,
                "updated_at": now,
            },
        )
        await self.redis.expire(f"job:{job_id}", settings.job_ttl_seconds)

    async def get_job(self, job_id: str) -> Optional[dict]:
        """Read job state. Returns None if not found."""
        data = await self.redis.hgetall(f"job:{job_id}")
        if not data:
            return None
        decoded = {k.decode(): v.decode() for k, v in data.items()}
        # Coerce numeric fields
        if "progress" in decoded:
            try:
                decoded["progress"] = int(decoded["progress"])
            except ValueError:
                decoded["progress"] = 0
        return decoded
