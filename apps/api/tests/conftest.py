"""pytest fixtures for CleanShot API tests."""

from __future__ import annotations

import asyncio
import os
from typing import AsyncGenerator
from unittest.mock import AsyncMock, MagicMock

import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient

# Set test env vars before importing the app
os.environ.setdefault("DATABASE_URL", "postgresql://cleanshot:test@localhost:5432/cleanshot_test")
os.environ.setdefault("GCS_BUCKET_ORIGINALS", "test-originals")
os.environ.setdefault("GCS_BUCKET_DERIVATIVES", "test-derivatives")
os.environ.setdefault("TASKS_OIDC_SA", "test@test.iam.gserviceaccount.com")
os.environ.setdefault("WORKER_URL", "http://localhost:8080")
os.environ.setdefault("API_KEY", "test-api-key-for-ci")
os.environ.setdefault("ENVIRONMENT", "local")


@pytest.fixture(scope="session")
def api_key() -> str:
    return "test-api-key-for-ci"


@pytest_asyncio.fixture
async def api_client() -> AsyncGenerator[AsyncClient, None]:
    """
    Returns an httpx AsyncClient wired to the FastAPI app.
    Mocks out Gemini, OpenAI, Anthropic, Valkey, and GCS — tests DB only.
    """
    from cleanshot_api.main import app

    # Inject mock state so lifespan doesn't need real GCP
    app.state.genai = MagicMock()
    app.state.openai = None
    app.state.anthropic = None
    app.state.valkey = None
    app.state.gemini_semaphore = asyncio.Semaphore(2)

    # Real asyncpg pool against test DB
    from cleanshot_api.db.pool import create_pool
    from cleanshot_api.db.migrate import run_migrations

    pool = await create_pool(os.environ["DATABASE_URL"])
    await run_migrations(pool)
    app.state.pool = pool

    async with AsyncClient(
        transport=ASGITransport(app=app),
        base_url="http://test",
    ) as client:
        yield client

    await pool.close()
