"""
Approval routes — Phase 2 v2.5 extension.

POST /api/v1/approvals
  Called when user clicks "Approve All" in the Scan tab.
  - Reads X-User-Email header (injected by BFF from Better Auth session).
  - Copies each asset to GCS path:
    approved/{email}/{YYYY-MM-DD}_{make}_{model}_{session-short}/{filename}
  - The session-short suffix prevents collisions when a user approves multiple
    sessions of the same make/model on the same day.
  - Creates approval_set + approval_set_assets rows in Postgres.
  - Returns { approvalSetId, gcsDir, assetCount }.

GET /api/v1/history?user_email={email}
  Returns the user's approval sets (stored indefinitely as of
  2026-05-26 — operator decided photo library is infinite), with
  per-asset signed GET URLs for thumbnail display. Legacy rows with
  non-NULL expires_at in the past are still excluded because their
  GCS objects were already deleted by the prior 60-day lifecycle rule.
"""

from __future__ import annotations

import asyncio
import datetime
import json
import re
import uuid
from typing import Any

import asyncpg
from fastapi import APIRouter, Depends, Header, HTTPException, Request, status
from google.cloud import storage as gcs
from pydantic import BaseModel

from cleanshot_api.core.config import get_settings
from cleanshot_api.core.security import require_api_key
from cleanshot_api.db import queries
from cleanshot_api.db.pool import get_pool
from cleanshot_api.services.gcs import (
    SIGNING_EXECUTOR,
    build_signing_client,
    sign_read_url_with,
)

router = APIRouter(prefix="/api/v1", tags=["approvals"])

# GCS folder for approved/archived images (separate from working derivatives)
APPROVED_PREFIX = "approved"

# ─── Helpers ──────────────────────────────────────────────────────────────────


def _sanitize(s: str) -> str:
    """Make a string safe for use in a GCS path / directory name."""
    s = s.strip().lower()
    s = re.sub(r"[^a-z0-9_\-]", "_", s)
    s = re.sub(r"_+", "_", s)
    return s[:40]


def _build_gcs_dir(
    user_email: str,
    make: str,
    model: str,
    session_id: uuid.UUID,
) -> str:
    """
    Build the human-readable GCS directory path for an approval set.
    Format: approved/{email}/{YYYY-MM-DD}_{make}_{model}_{session-short}

    The {session-short} suffix is the first hex segment of the session UUID
    (8 chars) and guarantees uniqueness when the same user approves multiple
    sessions of the same make/model on the same day.
    """
    today = datetime.date.today().strftime("%Y-%m-%d")
    safe_make  = _sanitize(make)  or "unknown"
    safe_model = _sanitize(model) or "unknown"
    # Email: replace @ and . with _ for path safety
    safe_email = re.sub(r"[^a-z0-9_\-]", "_", user_email.lower())
    session_short = str(session_id).split("-", 1)[0]  # first 8 hex chars
    dir_name   = f"{today}_{safe_make}_{safe_model}_{session_short}"
    return f"{APPROVED_PREFIX}/{safe_email}/{dir_name}"


# ─── Request / Response models ────────────────────────────────────────────────


class ApprovalRequest(BaseModel):
    session_id:  uuid.UUID
    asset_ids:   list[uuid.UUID]
    user_email:  str
    project_meta: dict[str, str] = {}  # {make, model, year}


class ApprovalResponse(BaseModel):
    approval_set_id: uuid.UUID
    gcs_dir:         str
    asset_count:     int


# ─── POST /api/v1/approvals ───────────────────────────────────────────────────


@router.post(
    "/approvals",
    response_model=ApprovalResponse,
    dependencies=[Depends(require_api_key)],
    status_code=201,
)
async def create_approval_set(
    body: ApprovalRequest,
    request: Request,
    x_user_email: str = Header(..., alias="X-User-Email"),
    pool: asyncpg.Pool = Depends(get_pool),
) -> ApprovalResponse:
    """
    Save approved images to GCS and record the approval set in Postgres.
    The user_email in the body and X-User-Email header must match
    (defence-in-depth — BFF sets both from the same session).
    """
    if x_user_email.lower() != body.user_email.lower():
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Email header/body mismatch",
        )

    user_email = x_user_email.lower()
    make  = body.project_meta.get("make",  "")
    model = body.project_meta.get("model", "")

    gcs_dir = _build_gcs_dir(user_email, make, model, body.session_id)
    settings = get_settings()
    gcs_client = gcs.Client(project=settings.gcp_project)
    dest_bucket = gcs_client.bucket(settings.gcs_bucket_derivatives)

    copied_assets: list[dict[str, Any]] = []

    for asset_id in body.asset_ids:
        async with pool.acquire() as conn:
            asset = await queries.get_asset(conn, asset_id)

        if asset is None:
            continue

        # Determine filename from GCS URI
        src_uri      = asset.gcs_uri
        src_filename = src_uri.split("/")[-1]
        dest_path    = f"{gcs_dir}/{src_filename}"

        # Copy within GCS (server-side copy — no bytes transit through API)
        src_without_scheme = src_uri.replace("gs://", "")
        src_bucket_name, _, src_obj = src_without_scheme.partition("/")

        src_blob  = gcs_client.bucket(src_bucket_name).blob(src_obj)
        dest_blob = dest_bucket.blob(dest_path)
        dest_bucket.copy_blob(src_blob, dest_bucket, dest_path)

        full_gcs_path = f"gs://{settings.gcs_bucket_derivatives}/{dest_path}"
        copied_assets.append({
            "asset_id":  str(asset_id),
            "gcs_path":  full_gcs_path,
            "filename":  src_filename,
        })

    if not copied_assets:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="No valid assets found to approve",
        )

    # Persist approval set. expires_at is intentionally omitted from the
    # INSERT column list — the column is nullable (see migrate_auth.py)
    # and NULL is our canonical "stored indefinitely" sentinel. The GCS
    # lifecycle rule that previously enforced the 60-day deletion was
    # removed 2026-05-26 (infra/gcs-lifecycle-approved.json deleted),
    # so the column is now informational-only for legacy rows.
    async with pool.acquire() as conn:
        # Look up project for FK (optional — may not be saved yet)
        project = await queries.get_project_for_session(conn, body.session_id)

        row = await conn.fetchrow(
            """
            INSERT INTO approval_sets
                (user_email, session_id, project_id, gcs_dir, make, model,
                 image_count)
            VALUES ($1, $2, $3, $4, $5, $6, $7)
            RETURNING id
            """,
            user_email,
            body.session_id,
            project.id if project else None,
            gcs_dir,
            make,
            model,
            len(copied_assets),
        )
        approval_set_id = row["id"]

        # Insert junction rows
        for ca in copied_assets:
            await conn.execute(
                """
                INSERT INTO approval_set_assets
                    (approval_set_id, asset_id, gcs_path, filename)
                VALUES ($1, $2, $3, $4)
                """,
                approval_set_id,
                uuid.UUID(ca["asset_id"]),
                ca["gcs_path"],
                ca["filename"],
            )

    return ApprovalResponse(
        approval_set_id=approval_set_id,
        gcs_dir=gcs_dir,
        asset_count=len(copied_assets),
    )


# ─── GET /api/v1/history ─────────────────────────────────────────────────────


@router.get(
    "/history",
    dependencies=[Depends(require_api_key)],
)
async def get_history(
    user_email: str,
    x_user_email: str = Header(..., alias="X-User-Email"),
    pool: asyncpg.Pool = Depends(get_pool),
) -> dict:
    """
    Returns the user's approval sets. New sets have expires_at = NULL
    (stored indefinitely). Legacy rows with non-NULL expires_at in the
    past are excluded because their GCS objects were already deleted
    by the previous 60-day lifecycle rule.
    """
    if x_user_email.lower() != user_email.lower():
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Email mismatch")

    now = datetime.datetime.now(tz=datetime.timezone.utc)

    async with pool.acquire() as conn:
        sets = await conn.fetch(
            """
            SELECT id, gcs_dir, make, model, image_count, created_at, expires_at
            FROM   approval_sets
            WHERE  user_email = $1
              AND  (expires_at IS NULL OR expires_at > $2)
            ORDER  BY created_at DESC
            LIMIT  200
            """,
            user_email.lower(),
            now,
        )

    if not sets:
        return {"sets": [], "totalSets": 0}

    # Fetch every set's assets in ONE query (was N+1: one round-trip per set).
    set_ids = [s["id"] for s in sets]
    async with pool.acquire() as conn:
        asset_rows = await conn.fetch(
            """
            SELECT approval_set_id, asset_id, gcs_path, filename
            FROM   approval_set_assets
            WHERE  approval_set_id = ANY($1::uuid[])
            ORDER  BY approval_set_id, created_at
            """,
            set_ids,
        )

    # Mint every signed URL concurrently. mint_read_url() used to run inline,
    # sequentially, re-refreshing credentials + rebuilding the storage.Client
    # on EVERY asset — across up to 200 sets that serialized into hundreds of
    # IAM signBlob round-trips and blew past Vercel's function timeout once the
    # library grew unbounded ("infinite photo library storage"). Now: refresh
    # creds + build the client ONCE, then fan the per-asset signBlob calls out
    # across the shared SIGNING_EXECUTOR (process-wide, bounded at 32 — see
    # services/gcs.py). signBlob is network-IO-bound, so the default
    # CPU-count-sized executor would needlessly serialize on a 1-vCPU box.
    client, access_token = await asyncio.to_thread(build_signing_client)

    def _sign(gcs_path: str) -> str:
        try:
            signed_url, _ = sign_read_url_with(client, access_token, gcs_path)
            return signed_url
        except Exception:
            return ""

    loop = asyncio.get_running_loop()
    signed_urls = await asyncio.gather(
        *(loop.run_in_executor(SIGNING_EXECUTOR, _sign, a["gcs_path"]) for a in asset_rows)
    )

    # Group assets (with their freshly-signed URLs) by set id, preserving the
    # created_at ordering from the query above.
    assets_by_set: dict[Any, list[dict]] = {}
    for a, signed_url in zip(asset_rows, signed_urls):
        assets_by_set.setdefault(a["approval_set_id"], []).append({
            "assetId":      str(a["asset_id"]),
            "filename":     a["filename"],
            "thumbnailUrl": signed_url,
            "gcsPath":      a["gcs_path"],
        })

    result_sets = []
    for s in sets:
        set_id     = s["id"]
        dir_name   = s["gcs_dir"].split("/")[-1]  # YYYY-MM-DD_{make}_{model}
        expires_at = s["expires_at"]

        result_sets.append({
            "id":          str(set_id),
            "createdAt":   s["created_at"].isoformat(),
            # null for new "stored indefinitely" rows; ISO string for
            # legacy rows that still carry an expiry. Frontend handles
            # both (hides the expiry badge when null).
            "expiresAt":   expires_at.isoformat() if expires_at else None,
            "dirName":     dir_name,
            "make":        s["make"],
            "model":       s["model"],
            "imageCount":  s["image_count"],
            "assets":      assets_by_set.get(set_id, []),
        })

    return {
        "sets":      result_sets,
        "totalSets": len(result_sets),
    }
