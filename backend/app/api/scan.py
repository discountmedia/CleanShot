"""
Scan API — synchronous multi-provider artifact scan.

Architectural note (May 2026 pivot):
    Originally Scan went through the same async worker queue as Enhance.
    That broke in production because Cloud Run Worker Pools (beta) don't
    reliably egress to public internet — Direct VPC didn't route through
    Cloud NAT, and the older Serverless VPC Access connector isn't a valid
    flag on worker pools. The API service has working unrestricted egress
    on its default Cloud Run network, so Scan now runs inline on the API.

    Scan latency is 6-25 seconds (max-of-three providers), which fits
    comfortably inside Cloud Run's request timeout. The frontend awaits
    the POST response directly — no /jobs polling required for scan.
    Enhance still runs through the worker pool because image generation
    is variable-length and benefits from async.

The scan service module (app/services/scan.py) is unchanged. Only the
delivery mechanism (worker queue → inline) shifted.
"""

import asyncio
import time
from typing import Optional

import structlog

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel

from google.cloud import storage as gcs

from app.services import scan as scan_service


logger = structlog.get_logger()

router = APIRouter(tags=["scan"])


# Module-level GCS client. Constructor is expensive; create once.
_gcs_client: Optional[gcs.Client] = None


def _get_gcs_client() -> gcs.Client:
    global _gcs_client
    if _gcs_client is None:
        _gcs_client = gcs.Client()
    return _gcs_client


def _download_gcs_bytes(gcs_uri: str) -> bytes:
    """Download object bytes given a gs://bucket/key URI."""
    if not gcs_uri.startswith("gs://"):
        raise ValueError(f"Expected gs:// URI, got: {gcs_uri}")
    without_scheme = gcs_uri[5:]
    bucket_name, _, blob_name = without_scheme.partition("/")
    bucket = _get_gcs_client().bucket(bucket_name)
    blob = bucket.blob(blob_name)
    return blob.download_as_bytes()


class ScanRequest(BaseModel):
    session_id: str
    asset_id: str


class ScanResponse(BaseModel):
    """Final merged scan result (matches Phase 2 v2.4 §2.4 schema)."""
    verdict: str
    confidence: int
    agreement: str
    summary: str
    issues: list[str] = []
    checks: dict = {}
    source: str
    individual: dict = {}
    warnings: list[str] = []
    elapsed_seconds: float


@router.post("/scan", response_model=ScanResponse)
async def submit_scan(request: Request, body: ScanRequest) -> ScanResponse:
    """
    Run a multi-provider artifact scan SYNCHRONOUSLY and return the merged
    verdict. Typical wall-clock is 6-25 seconds.

    Status codes:
        200 : Scan completed; merged verdict in body
        404 : Asset not found
        403 : Asset doesn't belong to this session
        409 : Asset has no uploaded bytes (signed PUT not yet executed)
        502 : All providers failed (network or upstream issue)
    """
    session_svc = request.app.state.session_service

    asset = await session_svc.get_asset(body.asset_id)
    if not asset:
        raise HTTPException(status_code=404, detail="asset not found")
    if asset.get("session_id") != body.session_id:
        raise HTTPException(status_code=403, detail="asset does not belong to session")
    if not asset.get("gcs_uri"):
        raise HTTPException(
            status_code=409,
            detail="asset has no uploaded bytes yet — PUT to signed URL first",
        )

    gcs_uri = asset["gcs_uri"]
    mime_type = asset.get("mime_type", "image/jpeg")

    log = logger.bind(asset_id=body.asset_id, gcs_uri=gcs_uri)
    log.info("Starting synchronous scan")

    # GCS download is sync (blocking) — run it in a thread to keep the event loop healthy.
    image_bytes = await asyncio.to_thread(_download_gcs_bytes, gcs_uri)

    started = time.time()
    try:
        result = await scan_service.scan_image(
            image_gcs_uri=gcs_uri,
            image_bytes=image_bytes,
            mime_type=mime_type,
        )
    except RuntimeError as exc:
        log.exception("All scan providers failed")
        raise HTTPException(status_code=502, detail=str(exc))

    elapsed = round(time.time() - started, 2)
    log.info(
        "Scan complete",
        verdict=result.get("verdict"),
        agreement=result.get("agreement"),
        source=result.get("source"),
        elapsed_seconds=elapsed,
    )

    return ScanResponse(
        verdict=result["verdict"],
        confidence=result["confidence"],
        agreement=result["agreement"],
        summary=result.get("summary", ""),
        issues=result.get("issues", []),
        checks=result.get("checks", {}),
        source=result["source"],
        individual=result.get("individual", {}),
        warnings=result.get("warnings", []),
        elapsed_seconds=elapsed,
    )
