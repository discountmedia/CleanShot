"""
All database access for the CleanShot API.

Rules:
- No ORM. Raw asyncpg for full control over query plans.
- Every function accepts a `conn: asyncpg.Connection` or `pool: asyncpg.Pool`.
- UUID parameters are passed as Python uuid.UUID — asyncpg codec handles them.
- JSONB columns are passed as json.dumps strings.
"""

from __future__ import annotations

import json
import uuid
from datetime import datetime
from typing import Any

import asyncpg

from cleanshot_api.models.schemas import (
    AssetRecord,
    ConsensusResultRecord,
    JobRecord,
    JobStatusEnum,
    OperationEnum,
    ProjectRecord,
    ScanResultRecord,
    SessionRecord,
)


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------


async def create_session(conn: asyncpg.Connection) -> SessionRecord:
    row = await conn.fetchrow(
        "INSERT INTO sessions DEFAULT VALUES RETURNING id, created_at, last_seen_at"
    )
    assert row is not None
    return SessionRecord(**dict(row))


async def touch_session(conn: asyncpg.Connection, session_id: uuid.UUID) -> None:
    await conn.execute(
        "UPDATE sessions SET last_seen_at = now() WHERE id = $1",
        session_id,
    )


async def get_session(
    conn: asyncpg.Connection, session_id: uuid.UUID
) -> SessionRecord | None:
    row = await conn.fetchrow(
        "SELECT id, created_at, last_seen_at FROM sessions WHERE id = $1",
        session_id,
    )
    return SessionRecord(**dict(row)) if row else None


# ---------------------------------------------------------------------------
# Assets
# ---------------------------------------------------------------------------


async def create_asset(
    conn: asyncpg.Connection,
    *,
    session_id: uuid.UUID,
    operation: OperationEnum,
    gcs_uri: str,
    content_hash: str,
    project_id: uuid.UUID | None = None,
) -> AssetRecord:
    row = await conn.fetchrow(
        """
        INSERT INTO assets (project_id, session_id, operation, gcs_uri, content_hash)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, project_id, session_id, operation, gcs_uri, content_hash, created_at
        """,
        project_id,
        session_id,
        operation.value,
        gcs_uri,
        content_hash,
    )
    assert row is not None
    return AssetRecord(**dict(row))


async def get_asset(
    conn: asyncpg.Connection, asset_id: uuid.UUID
) -> AssetRecord | None:
    row = await conn.fetchrow(
        "SELECT * FROM assets WHERE id = $1",
        asset_id,
    )
    return AssetRecord(**dict(row)) if row else None


async def get_assets_for_session(
    conn: asyncpg.Connection, session_id: uuid.UUID
) -> list[AssetRecord]:
    rows = await conn.fetch(
        "SELECT * FROM assets WHERE session_id = $1 ORDER BY created_at",
        session_id,
    )
    return [AssetRecord(**dict(r)) for r in rows]


# ---------------------------------------------------------------------------
# Jobs
# ---------------------------------------------------------------------------


async def create_job(
    conn: asyncpg.Connection,
    *,
    session_id: uuid.UUID,
    operation: OperationEnum,
    input_asset_id: uuid.UUID,
    idempotency_key: str,
) -> JobRecord:
    row = await conn.fetchrow(
        """
        INSERT INTO jobs (session_id, operation, input_asset_id, idempotency_key)
        VALUES ($1, $2, $3, $4)
        RETURNING *
        """,
        session_id,
        operation.value,
        input_asset_id,
        idempotency_key,
    )
    assert row is not None
    return JobRecord(**dict(row))


async def set_job_tasks_name(
    conn: asyncpg.Connection,
    job_id: uuid.UUID,
    cloud_tasks_name: str,
) -> None:
    await conn.execute(
        "UPDATE jobs SET cloud_tasks_name = $1, updated_at = now() WHERE id = $2",
        cloud_tasks_name,
        job_id,
    )


async def update_job_status(
    conn: asyncpg.Connection,
    job_id: uuid.UUID,
    status: JobStatusEnum,
    *,
    output_asset_id: uuid.UUID | None = None,
    error: str | None = None,
) -> None:
    await conn.execute(
        """
        UPDATE jobs
        SET    status = $1,
               output_asset_id = COALESCE($2, output_asset_id),
               error  = $3,
               updated_at = now()
        WHERE  id = $4
        """,
        status.value,
        output_asset_id,
        error,
        job_id,
    )


async def get_job(
    conn: asyncpg.Connection, job_id: uuid.UUID
) -> JobRecord | None:
    row = await conn.fetchrow("SELECT * FROM jobs WHERE id = $1", job_id)
    return JobRecord(**dict(row)) if row else None


async def get_jobs_for_session(
    conn: asyncpg.Connection, session_id: uuid.UUID
) -> list[JobRecord]:
    rows = await conn.fetch(
        "SELECT * FROM jobs WHERE session_id = $1 ORDER BY created_at",
        session_id,
    )
    return [JobRecord(**dict(r)) for r in rows]


async def get_jobs_by_ids(
    conn: asyncpg.Connection, job_ids: list[uuid.UUID]
) -> list[JobRecord]:
    rows = await conn.fetch(
        "SELECT * FROM jobs WHERE id = ANY($1::uuid[])",
        job_ids,
    )
    return [JobRecord(**dict(r)) for r in rows]


# ---------------------------------------------------------------------------
# Projects
# ---------------------------------------------------------------------------


async def save_project(
    conn: asyncpg.Connection,
    *,
    session_id: uuid.UUID,
    title: str,
    make: str,
    year: int,
    model: str,
    tire_type: str,
    capacity: str,
    fuel_type: str,
    username: str,
    photo_type: str,
) -> ProjectRecord:
    row = await conn.fetchrow(
        """
        INSERT INTO projects
            (session_id, title, make, year, model, tire_type,
             capacity, fuel_type, username, photo_type, saved_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now())
        ON CONFLICT (session_id, title) DO UPDATE
          SET make=$3, year=$4, model=$5, tire_type=$6,
              capacity=$7, fuel_type=$8, username=$9,
              photo_type=$10, saved_at=now()
        RETURNING *
        """,
        session_id, title, make, year, model,
        tire_type, capacity, fuel_type, username, photo_type,
    )
    assert row is not None
    return ProjectRecord(**dict(row))


async def get_project_for_session(
    conn: asyncpg.Connection, session_id: uuid.UUID
) -> ProjectRecord | None:
    row = await conn.fetchrow(
        "SELECT * FROM projects WHERE session_id = $1 ORDER BY saved_at DESC LIMIT 1",
        session_id,
    )
    return ProjectRecord(**dict(row)) if row else None


# ---------------------------------------------------------------------------
# Scan results
# ---------------------------------------------------------------------------


async def create_scan_result(
    conn: asyncpg.Connection,
    *,
    job_id: uuid.UUID,
    asset_id: uuid.UUID,
    provider: str,
    verdict: str,
    confidence: float,
    anomalies: list[dict[str, Any]],
    summary: str,
    latency_ms: int,
) -> ScanResultRecord:
    row = await conn.fetchrow(
        """
        INSERT INTO scan_results
            (job_id, asset_id, provider, verdict, confidence,
             anomalies, summary, latency_ms)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
        RETURNING *
        """,
        job_id, asset_id, provider, verdict, confidence,
        json.dumps(anomalies), summary, latency_ms,
    )
    assert row is not None
    data = dict(row)
    data["anomalies"] = json.loads(data["anomalies"])
    return ScanResultRecord(**data)


async def get_scan_results_for_session(
    conn: asyncpg.Connection, session_id: uuid.UUID
) -> list[ScanResultRecord]:
    rows = await conn.fetch(
        """
        SELECT sr.* FROM scan_results sr
        JOIN jobs j ON j.id = sr.job_id
        WHERE j.session_id = $1
        ORDER BY sr.created_at
        """,
        session_id,
    )
    results = []
    for r in rows:
        data = dict(r)
        data["anomalies"] = json.loads(data["anomalies"])
        results.append(ScanResultRecord(**data))
    return results


# ---------------------------------------------------------------------------
# Consensus results
# ---------------------------------------------------------------------------


async def create_consensus_result(
    conn: asyncpg.Connection,
    *,
    job_id: uuid.UUID,
    asset_id: uuid.UUID,
    verdict: str,
    confidence: float,
    provider_count: int,
    pass_count: int,
    fail_count: int,
    unanimous: bool,
    divergent_providers: list[str],
    merged_anomalies: list[dict[str, Any]],
    high_confidence_anomalies: list[dict[str, Any]],
) -> ConsensusResultRecord:
    row = await conn.fetchrow(
        """
        INSERT INTO consensus_results
            (job_id, asset_id, verdict, confidence, provider_count,
             pass_count, fail_count, unanimous, divergent_providers,
             merged_anomalies, high_confidence_anomalies)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
        RETURNING *
        """,
        job_id, asset_id, verdict, confidence, provider_count,
        pass_count, fail_count, unanimous,
        json.dumps(divergent_providers),
        json.dumps(merged_anomalies),
        json.dumps(high_confidence_anomalies),
    )
    assert row is not None
    data = dict(row)
    for key in ("divergent_providers", "merged_anomalies", "high_confidence_anomalies"):
        data[key] = json.loads(data[key])
    return ConsensusResultRecord(**data)
