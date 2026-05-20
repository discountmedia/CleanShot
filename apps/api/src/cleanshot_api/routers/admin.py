"""
Admin endpoints — surface aggregate data for the /admin dashboard.

Trust model:
  These endpoints are gated only by the standard X-Api-Key check that
  every other internal route uses. The actual "is this caller an admin"
  decision lives in the BFF (apps/web/app/api/admin/* checks
  ADMIN_EMAILS via lib/auth.isAdmin). The BFF is the only legitimate
  caller of FastAPI in production, so adding a second admin check here
  would be redundant. If we ever expose FastAPI publicly, add a
  per-route admin allowlist using the X-User-Email header.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

import uuid

import asyncpg
from fastapi import APIRouter, Depends, Query

from cleanshot_api.core.security import require_api_key
from cleanshot_api.db import queries
from cleanshot_api.db.pool import get_pool
from cleanshot_api.models.schemas import (
    SupportTicketRecord,
    UpdateSupportTicketRequest,
)

router = APIRouter(prefix="/api/v1/admin", tags=["admin"])


# ─── KPIs (top-of-dashboard cards) ────────────────────────────────────────────


@router.get(
    "/kpis",
    dependencies=[Depends(require_api_key)],
)
async def get_kpis(pool: asyncpg.Pool = Depends(get_pool)) -> dict:
    """
    Four headline counts for the admin dashboard's KPI row:

      • enhancedToday — successful enhance jobs (DATE(created_at) = today UTC)
      • scannedToday  — successful scan jobs    (DATE(created_at) = today UTC)
      • pendingReview — scan_results with verdict='fail' from the last 7 days
                        — represents the human-review backlog
      • storageGcsObjects — total rows in `assets` (one row per GCS object
                            we've created across all users). Proxy for
                            actual bucket size; cheap to compute. Use
                            `gcloud storage du gs://...` for real bytes.
    """
    async with pool.acquire() as conn:
        row = await conn.fetchrow(
            """
            SELECT
              (SELECT COUNT(*) FROM jobs
                 WHERE operation = 'enhance'
                   AND status    = 'complete'
                   AND created_at >= DATE_TRUNC('day', now())
              ) AS enhanced_today,

              (SELECT COUNT(*) FROM jobs
                 WHERE operation = 'scan'
                   AND status    = 'complete'
                   AND created_at >= DATE_TRUNC('day', now())
              ) AS scanned_today,

              (SELECT COUNT(*) FROM scan_results
                 WHERE verdict   = 'fail'
                   AND created_at >= now() - INTERVAL '7 days'
              ) AS pending_review,

              (SELECT COUNT(*) FROM assets) AS storage_gcs_objects
            """
        )

    assert row is not None
    return {
        "enhancedToday":     row["enhanced_today"],
        "scannedToday":      row["scanned_today"],
        "pendingReview":     row["pending_review"],
        "storageGcsObjects": row["storage_gcs_objects"],
    }


# ─── Users ────────────────────────────────────────────────────────────────────


@router.get(
    "/users",
    dependencies=[Depends(require_api_key)],
)
async def list_users(pool: asyncpg.Pool = Depends(get_pool)) -> dict:
    """
    Return every distinct user_email seen in `sessions`, with per-user
    counts of sessions, saved projects, approval sets, and last-seen
    timestamps. user_email NULL rows (pre-SSO sessions) are bucketed as
    'unknown' so admins can still see they exist.
    """
    async with pool.acquire() as conn:
        rows = await conn.fetch(
            """
            SELECT
                COALESCE(s.user_email, 'unknown')          AS user_email,
                COUNT(DISTINCT s.id)                       AS session_count,
                COUNT(DISTINCT p.id) FILTER (WHERE p.saved_at IS NOT NULL)
                                                           AS saved_project_count,
                COUNT(DISTINCT aset.id)                    AS approval_set_count,
                MIN(s.created_at)                          AS first_seen_at,
                MAX(s.last_seen_at)                        AS last_seen_at
            FROM sessions s
            LEFT JOIN projects p
                ON p.session_id = s.id
            LEFT JOIN approval_sets aset
                ON LOWER(aset.user_email) = LOWER(s.user_email)
            GROUP BY COALESCE(s.user_email, 'unknown')
            ORDER BY MAX(s.last_seen_at) DESC NULLS LAST
            """
        )

    return {
        "users": [
            {
                "userEmail":         r["user_email"],
                "sessionCount":      r["session_count"],
                "savedProjectCount": r["saved_project_count"],
                "approvalSetCount":  r["approval_set_count"],
                "firstSeenAt":       r["first_seen_at"].isoformat() if r["first_seen_at"] else None,
                "lastSeenAt":        r["last_seen_at"].isoformat()  if r["last_seen_at"]  else None,
            }
            for r in rows
        ],
    }


# ─── Projects ─────────────────────────────────────────────────────────────────


@router.get(
    "/projects",
    dependencies=[Depends(require_api_key)],
)
async def list_projects(
    pool: asyncpg.Pool = Depends(get_pool),
    user_email: str | None = Query(default=None),
    limit: int = Query(default=100, le=500),
) -> dict:
    """
    List saved projects across all users, or filtered by user_email.
    Joins through sessions for user attribution. Includes asset counts
    so admins can spot empty / partial projects.
    """
    if user_email:
        where = "WHERE s.user_email = $1 AND p.saved_at IS NOT NULL"
        params: list[Any] = [user_email.lower(), limit]
        limit_param = "$2"
    else:
        where = "WHERE p.saved_at IS NOT NULL"
        params = [limit]
        limit_param = "$1"

    async with pool.acquire() as conn:
        rows = await conn.fetch(
            f"""
            SELECT
                p.id, p.session_id, p.title, p.make, p.year, p.model,
                p.tire_type, p.capacity, p.fuel_type, p.username,
                p.photo_type, p.saved_at, p.created_at,
                COALESCE(s.user_email, 'unknown') AS user_email,
                (SELECT COUNT(*) FROM assets a WHERE a.session_id = p.session_id) AS asset_count
            FROM projects p
            LEFT JOIN sessions s ON s.id = p.session_id
            {where}
            ORDER BY p.saved_at DESC NULLS LAST
            LIMIT {limit_param}
            """,
            *params,
        )

    return {
        "projects": [
            {
                "id":         str(r["id"]),
                "sessionId":  str(r["session_id"]),
                "userEmail":  r["user_email"],
                "title":      r["title"],
                "make":       r["make"],
                "year":       r["year"],
                "model":      r["model"],
                "tireType":   r["tire_type"],
                "capacity":   r["capacity"],
                "fuelType":   r["fuel_type"],
                "username":   r["username"],
                "photoType":  r["photo_type"],
                "assetCount": r["asset_count"],
                "savedAt":    r["saved_at"].isoformat()    if r["saved_at"]    else None,
                "createdAt":  r["created_at"].isoformat(),
            }
            for r in rows
        ],
    }


# ─── Usage ────────────────────────────────────────────────────────────────────


@router.get(
    "/usage",
    dependencies=[Depends(require_api_key)],
)
async def usage_summary(
    pool: asyncpg.Pool = Depends(get_pool),
    days: int = Query(default=30, ge=1, le=365),
) -> dict:
    """
    Returns three aggregations over the last N days:
      • by_provider_model — counts + total latency by (provider, model, status)
      • by_user           — counts by user
      • daily             — daily timeseries of total event counts
    """
    since = datetime.now(tz=timezone.utc) - timedelta(days=days)

    async with pool.acquire() as conn:
        provider_rows = await conn.fetch(
            """
            SELECT
                provider, model, operation, status,
                COUNT(*)             AS call_count,
                AVG(latency_ms)::INT AS avg_latency_ms,
                MAX(latency_ms)      AS max_latency_ms,
                SUM(COALESCE(cost_estimate_usd, 0))::NUMERIC(12, 4) AS total_cost_usd
            FROM usage_events
            WHERE created_at >= $1
            GROUP BY provider, model, operation, status
            ORDER BY call_count DESC
            """,
            since,
        )

        user_rows = await conn.fetch(
            """
            SELECT
                COALESCE(user_email, 'unknown') AS user_email,
                COUNT(*) AS call_count,
                SUM(COALESCE(cost_estimate_usd, 0))::NUMERIC(12, 4) AS total_cost_usd
            FROM usage_events
            WHERE created_at >= $1
            GROUP BY COALESCE(user_email, 'unknown')
            ORDER BY call_count DESC
            """,
            since,
        )

        daily_rows = await conn.fetch(
            """
            SELECT
                DATE(created_at)     AS day,
                COUNT(*)             AS call_count,
                COUNT(*) FILTER (WHERE status = 'success') AS success_count,
                COUNT(*) FILTER (WHERE status = 'failed')  AS failed_count
            FROM usage_events
            WHERE created_at >= $1
            GROUP BY DATE(created_at)
            ORDER BY day ASC
            """,
            since,
        )

    return {
        "windowDays": days,
        "byProviderModel": [
            {
                "provider":     r["provider"],
                "model":        r["model"],
                "operation":    r["operation"],
                "status":       r["status"],
                "callCount":    r["call_count"],
                "avgLatencyMs": r["avg_latency_ms"],
                "maxLatencyMs": r["max_latency_ms"],
                "totalCostUsd": float(r["total_cost_usd"]) if r["total_cost_usd"] is not None else 0.0,
            }
            for r in provider_rows
        ],
        "byUser": [
            {
                "userEmail":    r["user_email"],
                "callCount":    r["call_count"],
                "totalCostUsd": float(r["total_cost_usd"]) if r["total_cost_usd"] is not None else 0.0,
            }
            for r in user_rows
        ],
        "daily": [
            {
                "day":          r["day"].isoformat(),
                "callCount":    r["call_count"],
                "successCount": r["success_count"],
                "failedCount":  r["failed_count"],
            }
            for r in daily_rows
        ],
    }


# ─── Support tickets ──────────────────────────────────────────────────────────


@router.get(
    "/support",
    dependencies=[Depends(require_api_key)],
)
async def list_tickets(
    pool: asyncpg.Pool = Depends(get_pool),
    status_filter: str | None = Query(default=None, alias="status"),
) -> dict:
    """
    Return every support ticket in the system, newest first. Optional
    `status` query param filters to open / in_progress / closed.
    """
    async with pool.acquire() as conn:
        rows = await queries.list_support_tickets(
            conn, status_filter=status_filter, limit=200,
        )

    return {
        "tickets": [
            {
                "id":          str(r["id"]),
                "userEmail":   r["user_email"],
                "type":        r["type"],
                "subject":     r["subject"],
                "body":        r["body"],
                "status":      r["status"],
                "adminNotes":  r["admin_notes"],
                "createdAt":   r["created_at"].isoformat(),
                "updatedAt":   r["updated_at"].isoformat(),
            }
            for r in rows
        ],
    }


@router.patch(
    "/support/{ticket_id}",
    response_model=SupportTicketRecord,
    dependencies=[Depends(require_api_key)],
)
async def update_ticket(
    ticket_id: uuid.UUID,
    body: UpdateSupportTicketRequest,
    pool: asyncpg.Pool = Depends(get_pool),
) -> SupportTicketRecord:
    """
    Partial update (status, admin_notes). Either field can be sent
    alone; passing neither no-ops and returns the row unchanged.
    """
    async with pool.acquire() as conn:
        row = await queries.update_support_ticket(
            conn,
            ticket_id,
            status=body.status.value if body.status else None,
            admin_notes=body.admin_notes,
        )
    if row is None:
        from fastapi import HTTPException, status as http_status
        raise HTTPException(status_code=http_status.HTTP_404_NOT_FOUND, detail="Ticket not found")
    return SupportTicketRecord(**row)
