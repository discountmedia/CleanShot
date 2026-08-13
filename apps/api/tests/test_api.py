"""
Integration tests for the CleanShot API.

Run with: pytest tests/ -v
Requires: local Postgres + Valkey running (see docker-compose.test.yml)
"""

from __future__ import annotations

import uuid

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

# Reads gated by `require_authenticated_user` need BOTH the transport key and a
# signed-in tenant identity. The value is never compared against a row — the
# access model is authenticated-tenant-wide, not per-user ownership — so any
# non-empty address exercises the same path the BFF takes.
TEST_USER = "editor@discountforklift.us"

# ---------------------------------------------------------------------------
# Health check
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_health(api_client: AsyncClient) -> None:
    resp = await api_client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"


# ---------------------------------------------------------------------------
# Session lifecycle
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_create_session(api_client: AsyncClient, api_key: str) -> None:
    resp = await api_client.post(
        "/api/v1/sessions",
        headers={"X-Api-Key": api_key},
    )
    assert resp.status_code == 201
    body = resp.json()
    assert "session_id" in body


@pytest.mark.asyncio
async def test_get_session_not_found(api_client: AsyncClient, api_key: str) -> None:
    # Authenticated: the 404 must come from the session genuinely not existing.
    # Without X-User-Email this would 404 on the auth check instead and pass for
    # the wrong reason, which is exactly the false-green this header guards.
    resp = await api_client.get(
        f"/api/v1/sessions/{uuid.uuid4()}",
        headers={"X-Api-Key": api_key, "X-User-Email": TEST_USER},
    )
    assert resp.status_code == 404


@pytest.mark.asyncio
async def test_session_roundtrip(api_client: AsyncClient, api_key: str) -> None:
    # Create
    resp = await api_client.post("/api/v1/sessions", headers={"X-Api-Key": api_key})
    assert resp.status_code == 201
    session_id = resp.json()["session_id"]

    # Fetch state
    resp = await api_client.get(
        f"/api/v1/sessions/{session_id}",
        headers={"X-Api-Key": api_key, "X-User-Email": TEST_USER},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["session"]["id"] == session_id
    assert body["assets"] == []
    assert body["jobs"] == []


@pytest.mark.asyncio
async def test_session_read_by_another_tenant_user_is_allowed(
    api_client: AsyncClient, api_key: str
) -> None:
    """
    Editors share a queue: whoever created the session, any signed-in tenant
    user can open it. This is the test that fails if someone reintroduces an
    ownership comparison.
    """
    resp = await api_client.post(
        "/api/v1/sessions",
        headers={"X-Api-Key": api_key, "X-User-Email": "creator@discountforklift.us"},
    )
    session_id = resp.json()["session_id"]

    resp = await api_client.get(
        f"/api/v1/sessions/{session_id}",
        headers={"X-Api-Key": api_key, "X-User-Email": "someone.else@discountforklift.us"},
    )
    assert resp.status_code == 200
    assert resp.json()["session"]["id"] == session_id


# ---------------------------------------------------------------------------
# Auth enforcement
# ---------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_missing_api_key_returns_401(api_client: AsyncClient) -> None:
    resp = await api_client.post("/api/v1/sessions")
    assert resp.status_code == 401


@pytest.mark.asyncio
async def test_wrong_api_key_returns_401(api_client: AsyncClient) -> None:
    resp = await api_client.post(
        "/api/v1/sessions",
        headers={"X-Api-Key": "wrong-key"},
    )
    assert resp.status_code == 401


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "path",
    [
        "/api/v1/sessions/{id}",
        "/api/v1/jobs/{id}",
        "/api/v1/jobs/batch/{id}",
        "/api/v1/scan/results/{id}",
        "/api/v1/assets/{id}/url",
    ],
)
async def test_reads_without_user_identity_return_404(
    api_client: AsyncClient, api_key: str, path: str
) -> None:
    """
    A valid transport key alone is not enough for the session / job / asset /
    scan-result reads: they also require a signed-in tenant user.

    404 rather than 401 is deliberate — an unauthenticated caller must not learn
    whether the id it guessed exists. The body is a fixed string and echoes
    nothing from the request.
    """
    resp = await api_client.get(
        path.format(id=uuid.uuid4()),
        headers={"X-Api-Key": api_key},
    )
    assert resp.status_code == 404
    assert resp.json() == {"detail": "Not found"}
