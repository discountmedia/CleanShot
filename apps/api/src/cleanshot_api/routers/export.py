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
    ExportProPreviewItem,
    ExportProPreviewResponse,
    ExportProRequest,
    ExportZipRequest,
)
from cleanshot_api.services import gcs as gcs_service
from cleanshot_api.services.captioning import (
    caption_image_for_filename,
    make_filename_unique,
)
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
    "/export/pro/preview",
    response_model=ExportProPreviewResponse,
    dependencies=[Depends(require_api_key)],
)
async def export_pro_preview(
    body: ExportProRequest,
    request: Request,
    pool: asyncpg.Pool = Depends(get_pool),
) -> ExportProPreviewResponse:
    """
    Like /export/pro but writes each resized JPEG to GCS and returns signed
    GET URLs instead of a binary response. Lets the UI render every
    1024×731 image inline so the operator can visually verify zoom-to-fill
    before pulling the bundle. Also writes a ZIP of all outputs to GCS and
    returns its signed URL — the "Download all" button is just a hyperlink,
    no second round of pyvips work.

    Each output is named by a short AI-generated slug describing the image
    (via services/captioning.py against gemini-2.5-flash on Vertex). On
    captioning failure the filename falls back to the source stem so the
    operator never sees a hex asset-id in the ZIP.

    GCS layout (cleanshot-derivatives-prod):
      session/{session_id}/pro/{asset_id}.jpg   ← per-image previews
      session/{session_id}/pro/export_pro.zip   ← bundle (overwritten per call)
    """
    async with pool.acquire() as conn:
        project = await queries.get_project_for_session(conn, body.session_id)
        _require_saved_project(project)

    from google.cloud import storage as gcs_lib
    from cleanshot_api.core.config import get_settings
    settings = get_settings()
    gcs_client = gcs_lib.Client(project=settings.gcp_project)
    derivatives_bucket = gcs_client.bucket(settings.gcs_bucket_derivatives)

    # Vertex Gemini client (proven path for vision — used by scan worker too)
    genai_client = request.app.state.genai

    items: list[ExportProPreviewItem] = []
    used_slugs: set[str] = set()
    zip_buf = io.BytesIO()
    any_warning = False

    with zipfile.ZipFile(zip_buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for asset_id in body.asset_ids:
            async with pool.acquire() as conn:
                asset = await queries.get_asset(conn, asset_id)
            if asset is None:
                continue

            # Download original from wherever it lives in GCS
            without_scheme = asset.gcs_uri[len("gs://"):]
            src_bucket_name, _, src_obj = without_scheme.partition("/")
            input_bytes = gcs_client.bucket(src_bucket_name).blob(src_obj).download_as_bytes()

            result = export_pro(input_bytes)
            if result.size_warning:
                any_warning = True

            # Generate a human-readable filename slug from the source image
            # (NOT the resized output — full-res preserves more visual
            # detail for captioning, and saves us re-running vision on a
            # quality-degraded JPEG).
            caption_slug = await caption_image_for_filename(
                input_bytes, genai_client=genai_client,
            )
            src_filename = src_obj.rsplit("/", 1)[-1]
            src_stem = src_filename.rsplit(".", 1)[0] if "." in src_filename else src_filename
            base_name = caption_slug or src_stem
            unique_name = make_filename_unique(base_name, used_slugs)
            out_filename = f"{unique_name}.jpg"
            out_object   = f"session/{body.session_id}/pro/{asset_id}.jpg"
            out_uri      = f"gs://{settings.gcs_bucket_derivatives}/{out_object}"

            # Write the processed JPEG to GCS (overwrites on re-preview)
            blob = derivatives_bucket.blob(out_object)
            blob.upload_from_string(result.data, content_type="image/jpeg")

            # Mint signed GET URL for inline preview rendering
            preview_url, _ = gcs_service.mint_read_url(out_uri)

            # Add to the ZIP
            zf.writestr(out_filename, result.data)

            # Read back actual dimensions for the response (verifies the
            # cover-fit fix to export_pro is producing the expected
            # 1024×731 output; pyvips loads metadata without decoding the
            # full image, so this is cheap).
            import pyvips
            probe = pyvips.Image.new_from_buffer(result.data, "")

            items.append(ExportProPreviewItem(
                asset_id=asset_id,
                filename=out_filename,
                url=preview_url,
                width=probe.width,
                height=probe.height,
                size_bytes=len(result.data),
                size_warning=result.size_warning,
            ))

    # Write the ZIP to GCS and mint its signed URL
    zip_bytes = zip_buf.getvalue()
    zip_object = f"session/{body.session_id}/pro/export_pro.zip"
    zip_uri    = f"gs://{settings.gcs_bucket_derivatives}/{zip_object}"
    derivatives_bucket.blob(zip_object).upload_from_string(
        zip_bytes, content_type="application/zip",
    )
    zip_url, _ = gcs_service.mint_read_url(zip_uri)

    return ExportProPreviewResponse(
        items=items,
        zip_url=zip_url,
        zip_size_bytes=len(zip_bytes),
        any_size_warning=any_warning,
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
