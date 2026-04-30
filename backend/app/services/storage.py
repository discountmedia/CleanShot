"""
Storage Service — GCS operations.

Two buckets used at runtime:
  - originals (versioned): customer-uploaded source images
  - derivatives (unversioned, 30d lifecycle): Gemini outputs, resize outputs

Auth uses Application Default Credentials everywhere:
  - Cloud Run: attached service account
  - Local docker-compose: ~/.config/gcloud/application_default_credentials.json
    is mounted into the container

Signed URLs use IAM-based signing (signBlob API) so we don't need a JSON key.
This requires roles/iam.serviceAccountTokenCreator granted to the active SA on itself.
"""

import datetime
import structlog
from typing import Optional

from google.auth import default as google_auth_default
from google.auth.transport import requests as gauth_requests
from google.cloud import storage

from app.config import settings


logger = structlog.get_logger()


class StorageService:
    """GCS operations using Application Default Credentials."""

    def __init__(self):
        self.client = storage.Client(project=settings.gcp_project_id)
        self.originals_bucket = self.client.bucket(settings.gcs_originals_bucket)
        self.derivatives_bucket = self.client.bucket(settings.gcs_derivatives_bucket)

        # Cache the auth credentials so we don't re-auth on every signed URL.
        # IAM-signing impersonates `gcp_service_account_email` to sign blobs
        # without ever holding a private key locally.
        self._creds, _ = google_auth_default()
        self._auth_request = gauth_requests.Request()

    # -------------------------------------------------------------------------
    # Signed URL generation (PUT for upload, GET for download/preview)
    # -------------------------------------------------------------------------

    def generate_upload_url(
        self,
        asset_id: str,
        mime_type: str = "image/jpeg",
    ) -> tuple[str, str]:
        """
        Mint a signed PUT URL for direct browser-to-GCS upload.

        Returns (signed_url, gcs_uri).
        The browser PUTs raw bytes to signed_url; the object lands at gcs_uri.
        """
        blob_path = f"sessions/{asset_id}.bin"
        blob = self.originals_bucket.blob(blob_path)

        # Refresh credentials before signing (token may have expired)
        if not self._creds.valid:
            self._creds.refresh(self._auth_request)

        url = blob.generate_signed_url(
            version="v4",
            expiration=datetime.timedelta(seconds=settings.signed_url_ttl_seconds),
            method="PUT",
            content_type=mime_type,
            service_account_email=settings.gcp_service_account_email,
            access_token=self._creds.token,
        )
        gcs_uri = f"gs://{settings.gcs_originals_bucket}/{blob_path}"
        logger.info("Generated upload URL", asset_id=asset_id, gcs_uri=gcs_uri)
        return url, gcs_uri

    def generate_download_url(
        self,
        gcs_uri: str,
        download_filename: Optional[str] = None,
    ) -> str:
        """Mint a signed GET URL for browser download / inline preview."""
        bucket_name, blob_path = self._parse_gcs_uri(gcs_uri)
        bucket = self.client.bucket(bucket_name)
        blob = bucket.blob(blob_path)

        if not self._creds.valid:
            self._creds.refresh(self._auth_request)

        kwargs = {
            "version": "v4",
            "expiration": datetime.timedelta(seconds=settings.signed_url_ttl_seconds),
            "method": "GET",
            "service_account_email": settings.gcp_service_account_email,
            "access_token": self._creds.token,
        }
        if download_filename:
            kwargs["response_disposition"] = (
                f'attachment; filename="{download_filename}"'
            )

        return blob.generate_signed_url(**kwargs)

    # -------------------------------------------------------------------------
    # Direct writes (used by the worker after Gemini returns bytes)
    # -------------------------------------------------------------------------

    def save_derivative(
        self,
        image_data: bytes,
        original_uri: str,
        operation: str,
        mime_type: str = "image/png",
    ) -> str:
        """
        Save a worker-generated derivative (Gemini output, resize output, etc.)
        to the derivatives bucket. Returns the new GCS URI.

        Filename pattern: derivatives/{operation}/{original_basename}_{operation}.{ext}
        """
        original_basename = original_uri.rsplit("/", 1)[-1].rsplit(".", 1)[0]
        ext = mime_type.split("/")[-1] if mime_type else "png"
        if ext == "jpeg":
            ext = "jpg"

        blob_path = f"{operation}/{original_basename}_{operation}.{ext}"
        blob = self.derivatives_bucket.blob(blob_path)
        blob.upload_from_string(image_data, content_type=mime_type)

        derivative_uri = f"gs://{settings.gcs_derivatives_bucket}/{blob_path}"
        logger.info(
            "Derivative saved",
            original_uri=original_uri,
            derivative_uri=derivative_uri,
            operation=operation,
            bytes=len(image_data),
        )
        return derivative_uri

    def read_blob(self, gcs_uri: str) -> bytes:
        """Read raw bytes from any GCS URI (originals or derivatives)."""
        bucket_name, blob_path = self._parse_gcs_uri(gcs_uri)
        bucket = self.client.bucket(bucket_name)
        blob = bucket.blob(blob_path)
        return blob.download_as_bytes()

    # -------------------------------------------------------------------------
    # Helpers
    # -------------------------------------------------------------------------

    @staticmethod
    def _parse_gcs_uri(gcs_uri: str) -> tuple[str, str]:
        """Parse 'gs://bucket/path' into (bucket, path)."""
        if not gcs_uri.startswith("gs://"):
            raise ValueError(f"Not a valid GCS URI: {gcs_uri}")
        without_scheme = gcs_uri[len("gs://"):]
        bucket_name, _, blob_path = without_scheme.partition("/")
        return bucket_name, blob_path
