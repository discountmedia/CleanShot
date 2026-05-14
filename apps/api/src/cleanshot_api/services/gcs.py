"""
GCS service — signed URL minting for direct browser uploads and asset reads.

Pattern: browser uploads directly to GCS via a V4 signed PUT URL.
The API never receives image bytes — it only mints URLs.
Signed GET URLs expire in 1 hour (3600s). Hard ceiling is 7 days (604800s).

Service account requires roles/iam.serviceAccountTokenCreator on itself
for credentials.sign_bytes() to work on Cloud Run.
"""

from __future__ import annotations

import datetime
import hashlib
import uuid

from google.cloud import storage

from cleanshot_api.core.config import get_settings

_SIGNED_URL_EXPIRY_PUT = datetime.timedelta(minutes=15)   # Upload window
_SIGNED_URL_EXPIRY_GET = datetime.timedelta(hours=1)       # View window


def _client() -> storage.Client:
    return storage.Client(project=get_settings().gcp_project)


def mint_upload_url(
    *,
    session_id: uuid.UUID,
    filename: str,
    content_type: str,
) -> tuple[str, str, str]:
    """
    Mint a V4 signed PUT URL for direct-to-GCS upload.

    Returns: (signed_url, gcs_uri, content_hash_placeholder)
    The asset_id is pre-minted by the DB layer before this call.
    """
    settings = get_settings()
    client = _client()
    bucket = client.bucket(settings.gcs_bucket_originals)

    # Deterministic GCS key: session/<session_id>/<uuid4>/<filename>
    object_name = f"session/{session_id}/{uuid.uuid4()}/{filename}"
    blob = bucket.blob(object_name)

    signed_url: str = blob.generate_signed_url(
        version="v4",
        expiration=_SIGNED_URL_EXPIRY_PUT,
        method="PUT",
        content_type=content_type,
    )

    gcs_uri = f"gs://{settings.gcs_bucket_originals}/{object_name}"
    return signed_url, gcs_uri, object_name


def mint_read_url(gcs_uri: str) -> tuple[str, datetime.datetime]:
    """
    Mint a V4 signed GET URL for an existing GCS object.

    Returns: (signed_url, expires_at_utc)
    """
    settings = get_settings()
    client = _client()

    # Parse gs://bucket/path
    assert gcs_uri.startswith("gs://"), f"Expected gs:// URI, got: {gcs_uri}"
    without_scheme = gcs_uri[len("gs://"):]
    bucket_name, _, object_name = without_scheme.partition("/")

    bucket = client.bucket(bucket_name)
    blob = bucket.blob(object_name)

    expires_at = datetime.datetime.now(tz=datetime.timezone.utc) + _SIGNED_URL_EXPIRY_GET
    signed_url: str = blob.generate_signed_url(
        version="v4",
        expiration=_SIGNED_URL_EXPIRY_GET,
        method="GET",
    )

    return signed_url, expires_at


def gcs_object_exists(gcs_uri: str) -> bool:
    """Check whether a GCS object exists (used to verify upload completed)."""
    client = _client()
    without_scheme = gcs_uri[len("gs://"):]
    bucket_name, _, object_name = without_scheme.partition("/")
    return client.bucket(bucket_name).blob(object_name).exists()
