from __future__ import annotations

import uuid

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, status

from cleanshot_api.core.security import require_api_key
from cleanshot_api.db import queries
from cleanshot_api.db.pool import get_pool
from cleanshot_api.models.schemas import (
    OperationEnum,
    SignedGetUrlResponse,
    SignedUploadUrlRequest,
    SignedUploadUrlResponse,
)
from cleanshot_api.services import gcs as gcs_service

router = APIRouter(prefix="/api/v1", tags=["upload"])


@router.post(
    "/upload/signed-url",
    response_model=SignedUploadUrlResponse,
    dependencies=[Depends(require_api_key)],
)
async def mint_upload_url(
    body: SignedUploadUrlRequest,
    pool: asyncpg.Pool = Depends(get_pool),
) -> SignedUploadUrlResponse:
    """
    Mint a V4 signed PUT URL for direct browser-to-GCS upload.
    Pre-creates the asset row so the GCS URI is addressable before the upload completes.
    The browser uploads directly; the API pod never receives image bytes.
    """
    async with pool.acquire() as conn:
        # Verify session exists
        session = await queries.get_session(conn, body.session_id)
        if session is None:
            raise HTTPException(
                status_code=status.HTTP_404_NOT_FOUND, detail="Session not found"
            )

    signed_url, gcs_uri, _ = gcs_service.mint_upload_url(
        session_id=body.session_id,
        filename=body.filename,
        content_type=body.content_type,
    )

    # Create asset row immediately so the URI is addressable
    async with pool.acquire() as conn:
        asset = await queries.create_asset(
            conn,
            session_id=body.session_id,
            operation=OperationEnum.upload,
            gcs_uri=gcs_uri,
            content_hash="pending",  # Updated by worker or background job after upload
        )

    return SignedUploadUrlResponse(
        upload_url=signed_url,
        asset_id=asset.id,
        gcs_uri=gcs_uri,
    )


@router.get(
    "/assets/{asset_id}/url",
    response_model=SignedGetUrlResponse,
    dependencies=[Depends(require_api_key)],
)
async def mint_asset_read_url(
    asset_id: uuid.UUID,
    pool: asyncpg.Pool = Depends(get_pool),
) -> SignedGetUrlResponse:
    """
    Mint a fresh V4 signed GET URL for an existing asset (1-hour expiry).
    Called by the frontend's SignedImage component before URL expiry.
    """
    async with pool.acquire() as conn:
        asset = await queries.get_asset(conn, asset_id)

    if asset is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND, detail="Asset not found"
        )

    signed_url, expires_at = gcs_service.mint_read_url(asset.gcs_uri)
    return SignedGetUrlResponse(url=signed_url, expires_at=expires_at)
