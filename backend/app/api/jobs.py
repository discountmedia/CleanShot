"""
Jobs API — polling endpoint for job progress.

Frontend polls GET /jobs/{job_id} every 2s for image jobs.
No SSE, no WebSocket, no Redis pub/sub on this path.

v2.4: Adds `scan_result` to the response — structured triple-provider scan output,
JSON-decoded server-side so the frontend gets an object, not a stringified blob.
Only populated when operation="scan" and status="done".
"""
import json
from typing import Any, Optional

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel


router = APIRouter(tags=["jobs"])


class JobStatusResponse(BaseModel):
    job_id: str
    status: str                 # queued | running | done | failed
    progress: int = 0           # 0..100
    message: Optional[str] = None
    operation: Optional[str] = None
    asset_id_in: Optional[str] = None
    result_uri: Optional[str] = None
    download_url: Optional[str] = None  # signed GET URL for the result, when done
    scan_result: Optional[dict] = None  # parsed scan output (operation="scan" only)


def _parse_scan_result(raw: Any) -> Optional[dict]:
    """Decode the worker's json.dumps(scan_result) safely. Returns None on any failure."""
    if raw is None:
        return None
    if isinstance(raw, dict):
        # Already decoded somewhere upstream
        return raw
    if isinstance(raw, bytes):
        try:
            raw = raw.decode("utf-8")
        except UnicodeDecodeError:
            return None
    if not isinstance(raw, str) or not raw.strip():
        return None
    try:
        decoded = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return None
    return decoded if isinstance(decoded, dict) else None


@router.get("/jobs/{job_id}", response_model=JobStatusResponse)
async def get_job_status(request: Request, job_id: str) -> JobStatusResponse:
    """Read job state from Redis. Frontend polls this every 2s."""
    session_svc = request.app.state.session_service
    storage_svc = request.app.state.storage_service

    job = await session_svc.get_job(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="job not found")

    # Mint a signed download URL on each poll for enhance results
    download_url: Optional[str] = None
    if job.get("status") == "done" and job.get("result_uri"):
        try:
            download_url = storage_svc.generate_download_url(
                gcs_uri=job["result_uri"],
                download_filename=job["result_uri"].rsplit("/", 1)[-1],
            )
        except Exception:
            # Don't fail the status read if signing has a hiccup
            download_url = None

    # Decode the scan result blob if present (operation="scan" only)
    scan_result = _parse_scan_result(job.get("scan_result"))

    return JobStatusResponse(
        job_id=job_id,
        status=job.get("status", "unknown"),
        progress=int(job.get("progress", 0)) if isinstance(job.get("progress"), (str, int)) else 0,
        message=job.get("message"),
        operation=job.get("operation"),
        asset_id_in=job.get("asset_id_in"),
        result_uri=job.get("result_uri"),
        download_url=download_url,
        scan_result=scan_result,
    )
