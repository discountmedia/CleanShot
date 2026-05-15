"""
GCS service — signed URL minting for direct browser uploads and asset reads.

Pattern: browser uploads directly to GCS via a V4 signed PUT URL.
The API never receives image bytes — it only mints URLs.
Signed GET URLs expire in 1 hour (3600s). Hard ceiling is 7 days (604800s).

Cloud Run signing pattern:
  On Cloud Run, ADC gives a token-based credential (no private key on disk).
  We pass service_account_email + access_token to generate_signed_url() which
  triggers IAM signBlob under the hood.

  Requires: roles/iam.serviceAccountTokenCreator on forklift-api SA (already granted).
"""

from __future__ import annotations

import datetime
import uuid

import google.auth
import google.auth.transport.requests
from google.cloud import storage

from cleanshot_api.core.config import get_settings

_SIGNED_URL_EXPIRY_PUT = datetime.timedelta(minutes=15)
_SIGNED_URL_EXPIRY_GET = datetime.timedelta(hours=1)


def _get_credentials():
    """Return refreshed ADC credentials scoped for Cloud Platform."""
    credentials, project = google.auth.default(
        scopes=["https://www.googleapis.com/auth/cloud-platform"]
    )
    credentials.refresh(google.auth.transport.requests.Request())
    return credentials, project


def _client() -> storage.Client:
    credentials, project = _get_credentials()
    return storage.Client(
        project=project or get_settings().gcp_project,
        credentials=credentials,
    )


def mint_upload_url(
    *,
    session_id: uuid.UUID,
    filename: str,
    content_type: str,
) -> tuple[str, str, str]:
    """
    Mint a V4 signed PUT URL for direct-to-GCS upload.
    Returns: (signed_url, gcs_uri, object_name)
    """
    settings = get_settings()
    credentials, _ = _get_credentials()
    client = storage.Client(project=settings.gcp_project, credentials=credentials)

    object_name = f"session/{session_id}/{uuid.uuid4()}/{filename}"
    blob = client.bucket(settings.gcs_bucket_originals).blob(object_name)

    signed_url: str = blob.generate_signed_url(
        version="v4",
        expiration=_SIGNED_URL_EXPIRY_PUT,
        method="PUT",
        content_type=content_type,
        service_account_email=settings.service_account_email,
        access_token=credentials.token,
    )

    return signed_url, f"gs://{settings.gcs_bucket_originals}/{object_name}", object_name


def mint_read_url(gcs_uri: str) -> tuple[str, datetime.datetime]:
    """
    Mint a V4 signed GET URL for an existing GCS object.
    Returns: (signed_url, expires_at_utc)
    """
    settings = get_settings()
    credentials, _ = _get_credentials()
    client = storage.Client(project=settings.gcp_project, credentials=credentials)

    assert gcs_uri.startswith("gs://"), f"Expected gs:// URI, got: {gcs_uri}"
    without_scheme = gcs_uri[len("gs://"):]
    bucket_name, _, object_name = without_scheme.partition("/")

    blob = client.bucket(bucket_name).blob(object_name)
    expires_at = datetime.datetime.now(tz=datetime.timezone.utc) + _SIGNED_URL_EXPIRY_GET

    signed_url: str = blob.generate_signed_url(
        version="v4",
        expiration=_SIGNED_URL_EXPIRY_GET,
        method="GET",
        service_account_email=settings.service_account_email,
        access_token=credentials.token,
    )

    return signed_url, expires_at


def gcs_object_exists(gcs_uri: str) -> bool:
    """Check whether a GCS object exists."""
    client = _client()
    without_scheme = gcs_uri[len("gs://"):]
    bucket_name, _, object_name = without_scheme.partition("/")
    return client.bucket(bucket_name).blob(object_name).exists()
