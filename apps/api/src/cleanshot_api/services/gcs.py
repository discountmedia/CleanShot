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
from concurrent.futures import ThreadPoolExecutor

import google.auth
import google.auth.transport.requests
from google.cloud import storage

from cleanshot_api.core.config import get_settings

_SIGNED_URL_EXPIRY_PUT = datetime.timedelta(minutes=15)
_SIGNED_URL_EXPIRY_GET = datetime.timedelta(hours=1)

# Shared, process-wide pool for fanning out the network-bound IAM signBlob
# calls behind V4 signing (each generate_signed_url with an access token is one
# signBlob round-trip — confirmed: ADC on Cloud Run is token-only, so there's
# no local key to sign with). Reused across requests so we don't construct and
# tear down an executor on every batch-signing call, and bounded at 32 so
# concurrent batch-signing requests can't spawn unbounded OS threads on a small
# (1-vCPU) Cloud Run instance. signBlob releases the GIL while blocked on the
# socket, so a fixed pool parallelizes the I/O well regardless of vCPU count.
# Process-lifetime singleton — the interpreter reclaims it at exit.
SIGNING_EXECUTOR = ThreadPoolExecutor(max_workers=32, thread_name_prefix="gcs-sign")


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


def _originals_object_name(session_id: uuid.UUID, filename: str) -> str:
    """
    THE object layout for the originals bucket. One definition, because the
    filename is recovered from the basename on the way back out — the asset row
    has no filename column, so the frontend derives the display name from this
    path (see lib/import-hydrate.filenameFromGcsUri). Change the shape here and
    imported photos lose their names.
    """
    return f"session/{session_id}/{uuid.uuid4()}/{filename}"


def upload_bytes(
    *,
    session_id: uuid.UUID,
    filename: str,
    content_type: str,
    data: bytes,
) -> str:
    """
    Server-side write into the originals bucket. Returns the gs:// URI.

    Used by the media-auditor import, which copies photos in from URLs. That
    path is one-object-per-photo and reuses this bucket + object layout, but it
    does NOT round-trip through a signed PUT URL: minting a URL only to PUT to
    it from the same process would be two extra network hops for nothing. The
    browser upload path still uses `mint_upload_url` — it has to, the bytes are
    on the client.
    """
    settings = get_settings()
    client = _client()
    object_name = _originals_object_name(session_id, filename)
    blob = client.bucket(settings.gcs_bucket_originals).blob(object_name)
    blob.upload_from_string(data, content_type=content_type)
    return f"gs://{settings.gcs_bucket_originals}/{object_name}"


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

    object_name = _originals_object_name(session_id, filename)
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


def mint_read_url(
    gcs_uri: str,
    *,
    download_filename: str | None = None,
) -> tuple[str, datetime.datetime]:
    """
    Mint a V4 signed GET URL for an existing GCS object.
    Returns: (signed_url, expires_at_utc)

    When `download_filename` is given, the URL carries a
    `response-content-disposition` override so the browser saves the file
    under that name. This is the only reliable way to control the download
    name for a cross-origin fetch — the HTML `download` attribute is
    ignored by browsers for cross-origin (storage.googleapis.com) hrefs.
    """
    settings = get_settings()
    credentials, _ = _get_credentials()
    client = storage.Client(project=settings.gcp_project, credentials=credentials)

    assert gcs_uri.startswith("gs://"), f"Expected gs:// URI, got: {gcs_uri}"
    without_scheme = gcs_uri[len("gs://"):]
    bucket_name, _, object_name = without_scheme.partition("/")

    blob = client.bucket(bucket_name).blob(object_name)
    expires_at = datetime.datetime.now(tz=datetime.timezone.utc) + _SIGNED_URL_EXPIRY_GET

    sign_kwargs: dict = {}
    if download_filename:
        sign_kwargs["response_disposition"] = (
            f'attachment; filename="{download_filename}"'
        )

    signed_url: str = blob.generate_signed_url(
        version="v4",
        expiration=_SIGNED_URL_EXPIRY_GET,
        method="GET",
        service_account_email=settings.service_account_email,
        access_token=credentials.token,
        **sign_kwargs,
    )

    return signed_url, expires_at


def build_signing_client() -> tuple[storage.Client, str]:
    """
    Build a storage.Client with freshly-refreshed credentials and return it
    alongside the access token, so a CALLER can mint many signed URLs while
    only paying the credential-refresh + client-construction cost ONCE.

    Use with sign_read_url_with() for batch signing (e.g. the history endpoint,
    which signs one URL per asset across up to 200 sets). Calling the
    per-URL mint_read_url() in a loop instead re-refreshes credentials and
    rebuilds the client on every asset — the exact pattern that pushed
    /api/v1/history past Vercel's function timeout once the photo library
    grew unbounded.
    """
    credentials, project = _get_credentials()
    client = storage.Client(
        project=project or get_settings().gcp_project,
        credentials=credentials,
    )
    return client, credentials.token


def sign_read_url_with(
    client: storage.Client,
    access_token: str,
    gcs_uri: str,
) -> tuple[str, datetime.datetime]:
    """
    Mint a V4 signed GET URL using a pre-built client + access token from
    build_signing_client(). Same output as mint_read_url() but without the
    per-call credential refresh / client construction.

    Note: V4 signing with an access_token still triggers one IAM signBlob
    network round-trip per URL — callers signing many URLs should dispatch
    these concurrently (asyncio.to_thread + gather).
    """
    settings = get_settings()
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
        access_token=access_token,
    )

    return signed_url, expires_at


def gcs_object_exists(gcs_uri: str) -> bool:
    """Check whether a GCS object exists."""
    client = _client()
    without_scheme = gcs_uri[len("gs://"):]
    bucket_name, _, object_name = without_scheme.partition("/")
    return client.bucket(bucket_name).blob(object_name).exists()
