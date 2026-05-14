"""
API key authentication for the BFF → FastAPI internal channel.

Two-key rotation: API_KEY is current, API_KEY_PREV is allowed briefly during
a rolling secret rotation in Secret Manager. Both are injected via Cloud Run
--set-secrets at deploy time; never hardcoded.

Cloud Tasks worker routes (/worker/*) are authenticated separately via OIDC
token verification — see core/tasks_auth.py.
"""

from __future__ import annotations

import secrets

from fastapi import HTTPException, Security, status
from fastapi.security import APIKeyHeader

from cleanshot_api.core.config import get_settings

_KEY_HEADER = APIKeyHeader(name="X-Api-Key", auto_error=False)


async def require_api_key(api_key: str | None = Security(_KEY_HEADER)) -> None:
    """FastAPI dependency — raises 401 if key is absent or invalid."""
    settings = get_settings()
    if api_key is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing X-Api-Key header",
        )

    valid_keys = [settings.api_key]
    if settings.api_key_prev:
        valid_keys.append(settings.api_key_prev)

    # Use secrets.compare_digest to prevent timing-oracle attacks
    if not any(secrets.compare_digest(api_key, k) for k in valid_keys):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid API key",
        )
