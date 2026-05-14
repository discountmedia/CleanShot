"""
OIDC token verification for Cloud Tasks → /worker/* endpoint.

Cloud Tasks attaches an OIDC token signed by the tasks service account.
We verify: (1) valid Google-issued JWT, (2) email matches our TASKS_OIDC_SA,
(3) audience matches our WORKER_URL.

The worker routes call `require_tasks_auth` as a FastAPI dependency.
"""

from __future__ import annotations

import logging

import google.auth.transport.requests
import google.oauth2.id_token
from fastapi import HTTPException, Request, status

from cleanshot_api.core.config import get_settings

logger = logging.getLogger(__name__)

_GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v3/certs"


async def require_tasks_auth(request: Request) -> None:
    """Verify the OIDC bearer token injected by Cloud Tasks."""
    settings = get_settings()
    auth_header = request.headers.get("Authorization", "")
    if not auth_header.startswith("Bearer "):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Missing or malformed Authorization header",
        )

    token = auth_header.removeprefix("Bearer ")
    try:
        # Verify against Google's public keys
        transport = google.auth.transport.requests.Request()
        claims = google.oauth2.id_token.verify_oauth2_token(
            token,
            transport,
            audience=settings.worker_url,
        )
    except Exception as exc:
        logger.warning("OIDC token verification failed: %s", exc)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid OIDC token",
        ) from exc

    email: str = claims.get("email", "")
    if email != settings.tasks_oidc_sa:
        logger.warning(
            "OIDC token email mismatch: expected=%s got=%s",
            settings.tasks_oidc_sa,
            email,
        )
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="OIDC token service account mismatch",
        )
