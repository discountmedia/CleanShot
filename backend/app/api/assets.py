"""
Assets API — direct-to-GCS upload via signed PUT URLs, and preview/download URLs.

Flow:
  1. Frontend POSTs /assets/upload-url { session_id, mime_type } → receives { asset_id, signed_put_url }
  2. Frontend PUTs the file bytes directly to signed_put_url (15 min expiry)
  3. Frontend POSTs /enhance { session_id, asset_id, ... } to start a job
  4. Frontend GETs /assets/{asset_id}/preview-url for inline display
"""

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from app.config import settings

router = APIRouter(tags=["assets"])


# -----------------------------------------------------------------------------
# Request / Response models
# -----------------------------------------------------------------------------

class UploadUrlRequest(BaseModel):
    session_id: str
    mime_type: str = Field(default="image/jpeg")
    byte_size: int = Field(default=0, ge=0)


class UploadUrlResponse(BaseModel):
    asset_id: str
    signed_put_url: str
    gcs_uri: str
    mime_type: str
    expires_in_seconds: int


class PreviewUrlResponse(BaseModel):
    url: str
    expires_in_seconds: int


# -----------------------------------------------------------------------------
# Endpoints
# -----------------------------------------------------------------------------

ALLOWED_MIME_TYPES = {"image/jpeg", "image/png", "image/webp"}


@router.post("/assets/upload-url", response_model=UploadUrlResponse)
async def get_upload_url(request: Request, body: UploadUrlRequest) -> UploadUrlResponse:
    """Issue a signed PUT URL for direct browser-to-GCS upload."""
    storage_svc = request.app.state.storage_service
    session_svc = request.app.state.session_service

    if body.mime_type not in ALLOWED_MIME_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported mime_type. Allowed: {sorted(ALLOWED_MIME_TYPES)}",
        )
    if body.byte_size and body.byte_size > settings.max_upload_bytes:
        raise HTTPException(
            status_code=413,
            detail=f"File too large. Max: {settings.max_upload_bytes} bytes",
        )

    if not await session_svc.touch_session(body.session_id):
        raise HTTPException(status_code=404, detail="session not found")

    # Reserve an asset_id, then sign the URL using that path
    asset_id = await session_svc.create_asset(
        session_id=body.session_id,
        gcs_uri="",  # filled in below
        mime_type=body.mime_type,
    )
    signed_url, gcs_uri = storage_svc.generate_upload_url(
        asset_id=asset_id,
        mime_type=body.mime_type,
    )
    # Update the asset record with the now-known URI
    await session_svc.redis.hset(f"asset:{asset_id}", "gcs_uri", gcs_uri)

    return UploadUrlResponse(
        asset_id=asset_id,
        signed_put_url=signed_url,
        gcs_uri=gcs_uri,
        mime_type=body.mime_type,
        expires_in_seconds=settings.signed_url_ttl_seconds,
    )


@router.get("/assets/{asset_id}/preview-url", response_model=PreviewUrlResponse)
async def get_preview_url(request: Request, asset_id: str) -> PreviewUrlResponse:
    """Issue a signed GET URL so the browser can display the image."""
    storage_svc = request.app.state.storage_service
    session_svc = request.app.state.session_service

    asset = await session_svc.get_asset(asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="asset not found")

    url = storage_svc.generate_download_url(gcs_uri=asset["gcs_uri"])
    return PreviewUrlResponse(
        url=url,
        expires_in_seconds=settings.signed_url_ttl_seconds,
    )
