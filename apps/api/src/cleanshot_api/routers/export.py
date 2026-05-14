from __future__ import annotations

import io
import zipfile
import uuid

import asyncpg
from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from fastapi.responses import StreamingResponse

from cleanshot_api.core.security import require_api_key
from cleanshot_api.db import queries
from cleanshot_api.db.pool import get_pool
from cleanshot_api.models.schemas import (
    ExportCustomRequest,
    ExportFullsizeRequest,
    ExportFullsizeResponse,
    ExportProRequest,
    ExportZipRequest,
)
from cleanshot_api.services import gcs as gcs_service
from cleanshot_api.services.image_processing import export_custom, export_pro

router = APIRouter(prefix="/api/v1", tags=["export"])


def _require_saved_project(project):
    """Export gate: 403 if no saved project."""
    if project is None or project.saved_at is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Project must be saved before export",
        )


@router.post(
    "/export/fullsize",
    response_model=ExportFullsizeResponse,
    dependencies=[Depends(require_api_key)],
)
async def export_fullsize(
    body: ExportFullsizeRequest,
    pool: asyncpg.Pool = Depends(get_pool),
) -> ExportFullsizeResponse:
    """
    Export full-size PNG. Returns a V4 signed GET URL (1-hour expiry).
    Requires a saved project.
    """
    async with pool.acquire() as conn:
        project = await queries.get_project_for_session(conn, body.session_id)
        _require_saved_project(project)

        asset = await queries.get_asset(conn, body.asset_id)
        if asset is None or asset.session_id != body.session_id:
            raise HTTPException(status_code=404, detail="Asset not found")

    signed_url, expires_at = gcs_service.mint_read_url(asset.gcs_uri)
    return ExportFullsizeResponse(url=signed_url, expires_at=expires_at)


@router.post(
    "/export/pro",
    dependencies=[Depends(require_api_key)],
)
async def export_pro_preset(
    body: ExportProRequest,
    pool: asyncpg.Pool = Depends(get_pool),
) -> Response:
    """
    PRO preset: 1024px, 7×5 crop, JPEG ≤100 kb per asset.
    Returns a ZIP for multi-asset batches, single JPEG for single asset.
    X-Warning header set if target size was unachievable after 10 iterations.
    """
    async with pool.acquire() as conn:
        project = await queries.get_project_for_session(conn, body.session_id)
        _require_saved_project(project)

    results: list[tuple[str, bytes, bool]] = []
    for asset_id in body.asset_ids:
        async with pool.acquire() as conn:
            asset = await queries.get_asset(conn, asset_id)
        if asset is None:
            continue

        from google.cloud import storage as gcs
        from cleanshot_api.core.config import get_settings
        settings = get_settings()
        client = gcs.Client(project=settings.gcp_project)
        without_scheme = asset.gcs_uri[len("gs://"):]
        bucket_name, _, obj = without_scheme.partition("/")
        input_bytes = client.bucket(bucket_name).blob(obj).download_as_bytes()

        result = export_pro(input_bytes)
        filename = f"{asset_id}_pro.jpg"
        results.append((filename, result.data, result.size_warning))

    if len(results) == 1:
        filename, data, size_warning = results[0]
        headers = {"Content-Disposition": f'attachment; filename="{filename}"'}
        if size_warning:
            headers["X-Warning"] = "target-size-unachievable"
        return Response(content=data, media_type="image/jpeg", headers=headers)

    # Multi-asset: return ZIP
    buf = io.BytesIO()
    any_warning = False
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for filename, data, size_warning in results:
            zf.writestr(filename, data)
            if size_warning:
                any_warning = True

    headers = {"Content-Disposition": 'attachment; filename="cleanshot_pro_export.zip"'}
    if any_warning:
        headers["X-Warning"] = "target-size-unachievable-some-images"
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers=headers,
    )


@router.post(
    "/export/custom",
    dependencies=[Depends(require_api_key)],
)
async def export_custom_preset(
    body: ExportCustomRequest,
    pool: asyncpg.Pool = Depends(get_pool),
) -> Response:
    """
    Custom export: crop-not-letterbox enforced absolutely.
    Min 100px, min 50kb. Supports JPEG, PNG, WebP, BMP.
    """
    async with pool.acquire() as conn:
        project = await queries.get_project_for_session(conn, body.session_id)
        _require_saved_project(project)

    from google.cloud import storage as gcs
    from cleanshot_api.core.config import get_settings
    settings = get_settings()
    gcs_client = gcs.Client(project=settings.gcp_project)

    results: list[tuple[str, bytes, str]] = []
    for asset_id in body.asset_ids:
        async with pool.acquire() as conn:
            asset = await queries.get_asset(conn, asset_id)
        if asset is None:
            continue

        without_scheme = asset.gcs_uri[len("gs://"):]
        bucket_name, _, obj = without_scheme.partition("/")
        input_bytes = gcs_client.bucket(bucket_name).blob(obj).download_as_bytes()

        result = export_custom(
            input_bytes,
            width=body.width,
            height=body.height,
            quality=body.quality,
            fmt=body.format,
        )
        ext = body.format if body.format != "jpeg" else "jpg"
        filename = f"{asset_id}_custom_{body.width}x{body.height}.{ext}"
        results.append((filename, result.data, result.content_type))

    if len(results) == 1:
        filename, data, ct = results[0]
        return Response(
            content=data,
            media_type=ct,
            headers={"Content-Disposition": f'attachment; filename="{filename}"'},
        )

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for filename, data, _ in results:
            zf.writestr(filename, data)
    return Response(
        content=buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="cleanshot_custom_export.zip"'},
    )


@router.post(
    "/export/zip",
    dependencies=[Depends(require_api_key)],
)
async def export_zip(
    body: ExportZipRequest,
    pool: asyncpg.Pool = Depends(get_pool),
) -> StreamingResponse:
    """
    Streaming ZIP download for batch export.

    Streams chunks as they're generated — never buffers the full ZIP in memory.
    Cloud Run request timeout is 900s (15 min), sufficient for 200-image batches.
    The Next.js Route Handler sets maxDuration=60 for the BFF proxy.
    """
    async with pool.acquire() as conn:
        project = await queries.get_project_for_session(conn, body.session_id)
        _require_saved_project(project)

    from google.cloud import storage as gcs
    from cleanshot_api.core.config import get_settings
    settings = get_settings()

    async def generate():
        """Yield ZIP chunks using Python's zipfile streaming."""
        gcs_client = gcs.Client(project=settings.gcp_project)
        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as zf:
            for asset_id in body.asset_ids:
                async with pool.acquire() as conn:
                    asset = await queries.get_asset(conn, asset_id)
                if asset is None:
                    continue
                without_scheme = asset.gcs_uri[len("gs://"):]
                bucket_name, _, obj = without_scheme.partition("/")
                img_bytes = gcs_client.bucket(bucket_name).blob(obj).download_as_bytes()
                zf.writestr(f"{asset_id}.png", img_bytes)

                # Yield current buffer state in 64 KB chunks
                buf.seek(0)
                while True:
                    chunk = buf.read(65536)
                    if not chunk:
                        break
                    yield chunk
                buf.seek(0)
                buf.truncate()

        # Flush remaining ZIP footer
        buf.seek(0)
        remaining = buf.read()
        if remaining:
            yield remaining

    return StreamingResponse(
        generate(),
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="cleanshot_export.zip"'},
    )
