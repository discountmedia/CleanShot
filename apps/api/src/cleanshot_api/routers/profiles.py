"""
Per-user profile endpoints.

  GET  /api/v1/profile               — read current user's profile (lazy-creates row)
  PUT  /api/v1/profile               — update full_name / work_phone / location
  POST /api/v1/profile/avatar        — mint signed PUT URL for new avatar upload
  POST /api/v1/profile/avatar/commit — link the uploaded gs:// URI on the row

Identity comes from the BFF's X-User-Email header (same pattern used by
/api/v1/approvals + /api/v1/history). The header is set from the
Better Auth session in apps/web/lib/auth.ts so this endpoint can't be
hit anonymously when AUTH_ENABLED=true.
"""

from __future__ import annotations

import datetime
import uuid

import asyncpg
from fastapi import APIRouter, Depends, Header, HTTPException, status
from google.cloud import storage

from cleanshot_api.core.config import get_settings
from cleanshot_api.core.security import require_api_key
from cleanshot_api.db import queries
from cleanshot_api.db.pool import get_pool
from cleanshot_api.models.schemas import (
    AvatarUploadUrlResponse,
    UpdateProfileRequest,
    UserProfile,
)
from cleanshot_api.services import gcs as gcs_service
from cleanshot_api.services.gcs import _get_credentials  # type: ignore

router = APIRouter(prefix="/api/v1", tags=["profiles"])

# How long signed PUT URLs for avatar uploads live. Same window as the
# upload signed URLs minted for source images.
_AVATAR_PUT_EXPIRY = datetime.timedelta(minutes=15)


def _row_to_profile(row: dict) -> UserProfile:
    """
    Convert a user_profiles row (dict) into the UserProfile schema with
    avatar_url populated from a freshly-minted signed GET URL when
    avatar_uri is set.
    """
    avatar_url: str | None = None
    if row.get("avatar_uri"):
        try:
            avatar_url, _ = gcs_service.mint_read_url(row["avatar_uri"])
        except Exception:
            # Stale URI (object deleted, etc.) — surface as null avatar.
            avatar_url = None
    return UserProfile(
        user_email=row["user_email"],
        full_name=row.get("full_name"),
        work_phone=row.get("work_phone"),
        location=row.get("location"),
        avatar_uri=row.get("avatar_uri"),
        avatar_url=avatar_url,
        created_at=row["created_at"],
        updated_at=row["updated_at"],
    )


@router.get(
    "/profile",
    response_model=UserProfile,
    dependencies=[Depends(require_api_key)],
)
async def get_profile(
    pool: asyncpg.Pool = Depends(get_pool),
    x_user_email: str = Header(..., alias="X-User-Email"),
) -> UserProfile:
    """
    Read the signed-in user's profile, lazy-creating a blank row on
    first read so the UI never has to handle a 404.
    """
    email = x_user_email.lower()
    async with pool.acquire() as conn:
        row = await queries.get_user_profile(conn, email)
        if row is None:
            row = await queries.upsert_user_profile(
                conn,
                user_email=email,
                full_name=None, work_phone=None, location=None, avatar_uri=None,
            )
    return _row_to_profile(row)


@router.put(
    "/profile",
    response_model=UserProfile,
    dependencies=[Depends(require_api_key)],
)
async def update_profile(
    body: UpdateProfileRequest,
    pool: asyncpg.Pool = Depends(get_pool),
    x_user_email: str = Header(..., alias="X-User-Email"),
) -> UserProfile:
    """
    Upsert the editable text fields. Avatar is handled by the dedicated
    /profile/avatar endpoints so the upload + commit isn't coupled to
    every name/phone tweak.
    """
    email = x_user_email.lower()
    async with pool.acquire() as conn:
        # Read current avatar_uri so the upsert doesn't accidentally
        # clear it (the UPSERT logic uses COALESCE on avatar_uri).
        row = await queries.upsert_user_profile(
            conn,
            user_email=email,
            full_name=body.full_name,
            work_phone=body.work_phone,
            location=body.location,
            avatar_uri=None,         # COALESCE preserves existing value
        )
    return _row_to_profile(row)


@router.post(
    "/profile/avatar",
    response_model=AvatarUploadUrlResponse,
    dependencies=[Depends(require_api_key)],
)
async def mint_avatar_upload(
    x_user_email: str = Header(..., alias="X-User-Email"),
    content_type: str = Header(default="image/jpeg", alias="X-Avatar-Content-Type"),
) -> AvatarUploadUrlResponse:
    """
    Mint a V4 signed PUT URL the browser can use to upload the resized
    avatar bytes directly to GCS. The frontend then calls
    /profile/avatar/commit with the returned gcs_uri to link it on the
    user_profiles row.

    Object layout: gs://{derivatives_bucket}/avatars/{user_email}/{uuid}.{ext}
    """
    email = x_user_email.lower()
    if content_type not in {"image/jpeg", "image/png", "image/webp"}:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Unsupported avatar content-type: {content_type}",
        )
    settings = get_settings()
    credentials, _ = _get_credentials()
    client = storage.Client(project=settings.gcp_project, credentials=credentials)

    # Sanitise email for use as a GCS path component. Local-part letters
    # plus '_' for the @ separator. Keeps avatars grouped per user
    # without exposing raw email strings in the URL.
    safe_email = email.replace("@", "_").replace(".", "_")
    ext_map = {"image/jpeg": "jpg", "image/png": "png", "image/webp": "webp"}
    ext = ext_map[content_type]
    object_name = f"avatars/{safe_email}/{uuid.uuid4()}.{ext}"

    blob = client.bucket(settings.gcs_bucket_derivatives).blob(object_name)
    signed_url: str = blob.generate_signed_url(
        version="v4",
        expiration=_AVATAR_PUT_EXPIRY,
        method="PUT",
        content_type=content_type,
        service_account_email=settings.service_account_email,
        access_token=credentials.token,
    )
    gcs_uri = f"gs://{settings.gcs_bucket_derivatives}/{object_name}"
    return AvatarUploadUrlResponse(upload_url=signed_url, gcs_uri=gcs_uri)


@router.post(
    "/profile/avatar/commit",
    response_model=UserProfile,
    dependencies=[Depends(require_api_key)],
)
async def commit_avatar(
    payload: dict,
    pool: asyncpg.Pool = Depends(get_pool),
    x_user_email: str = Header(..., alias="X-User-Email"),
) -> UserProfile:
    """
    After the browser PUTs the new avatar bytes to GCS, it calls this
    endpoint with the gcs_uri it received from /profile/avatar so the
    user_profiles.avatar_uri row gets updated.
    """
    email = x_user_email.lower()
    gcs_uri = payload.get("gcs_uri")
    if not gcs_uri or not isinstance(gcs_uri, str) or not gcs_uri.startswith("gs://"):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="gcs_uri must be a gs:// URI returned from /profile/avatar",
        )
    # Defense-in-depth — make sure the operator can only commit a URI
    # that's inside their own avatars/ prefix.
    safe_email = email.replace("@", "_").replace(".", "_")
    if f"/avatars/{safe_email}/" not in gcs_uri:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="gcs_uri does not belong to the calling user's avatar folder",
        )

    async with pool.acquire() as conn:
        await queries.set_user_avatar(conn, email, gcs_uri)
        row = await queries.get_user_profile(conn, email)
    assert row is not None
    return _row_to_profile(row)
