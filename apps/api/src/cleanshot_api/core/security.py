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

from fastapi import Header, HTTPException, Security, status
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


async def require_authenticated_user(
    x_user_email: str | None = Header(default=None, alias="X-User-Email"),
) -> str:
    """
    Require that a signed-in tenant user is behind this request.

    The access model is **authenticated-tenant-wide, not per-user ownership**.
    Both CleanShot and media-auditor sit behind Microsoft SSO on the same
    tenant, and editors work a SHARED queue — a second editor picking up
    someone else's queue item is normal, expected work, not an intrusion. So
    this checks that an identity is present, and deliberately does NOT compare
    it against any row's `user_email`. Comparing would 404 the shared-queue
    workflow, which is the whole point of the tool.

    `X-User-Email` is injected by the Next.js BFF from the Better Auth session
    (or `dev@local` while AUTH_ENABLED is false). Any route that depends on this
    needs its BFF proxy to forward the header — without it, every read 404s.

    Raises **404 with a fixed string**, not 401: an unauthenticated caller
    learns nothing about whether the id they asked for exists, and nothing from
    the request is echoed back. Ordering note — `require_api_key` is a separate
    dependency and still gates the transport; this is the user-identity layer on
    top of it.
    """
    if x_user_email is None or not x_user_email.strip():
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Not found",
        )
    return x_user_email.strip().lower()
