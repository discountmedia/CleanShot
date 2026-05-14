"""
Integration tests for the CleanShot API.

Run with: pytest tests/ -v
Requires: local Postgres + Valkey running (see docker-compose.test.yml)
"""

from __future__ import annotations

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

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
    import uuid
    resp = await api_client.get(
        f"/api/v1/sessions/{uuid.uuid4()}",
        headers={"X-Api-Key": api_key},
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
        headers={"X-Api-Key": api_key},
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["session"]["id"] == session_id
    assert body["assets"] == []
    assert body["jobs"] == []


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
