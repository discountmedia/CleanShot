from __future__ import annotations

import asyncio
import io
import json
import logging
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
from cleanshot_api.services.image_processing import (
    export_custom,
    export_pro,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1", tags=["export"])


def _require_saved_project(project):
    """Export gate: 403 if no saved project."""
    if project is None or project.saved_at is None:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Project must be saved before export",
        )


_FILENAME_PART_RE = __import__("re").compile(r"[^a-zA-Z0-9_-]+")


def _sanitize_filename_part(s: str) -> str:
    """
    Filesystem-safe version of a free-text field. Mirrors the
    `sanitize` helper in apps/web/lib/compress.buildEnhanceFilename
    so resize output filenames feel like a natural successor to the
    upload filenames the operator already sees on the Enhance tab.
    """
    import re
    s = (s or "").strip()
    s = _FILENAME_PART_RE.sub("_", s)
    s = re.sub(r"_+", "_", s)
    return s.strip("_")


def _build_pro_filename(
    *,
    make: str,
    model: str,
    year: int,
    index: int,
    total: int,
    provider: str | None = None,
) -> str:
    """
    Deterministic PRO-export filename built from the saved project
    metadata + a 1-indexed sequence number, optionally suffixed with
    the AI provider that produced the output. Examples:

      Toyota_8FGU25_2019_01.jpg               (single-provider batch)
      Toyota_8FGU25_2019_01_Gemini.jpg        (multi-provider; Gemini variant)
      Toyota_8FGU25_2019_01_Openai.jpg        (multi-provider; OpenAI variant)

    The padding width grows with the batch size so sequencing sorts
    correctly in any file explorer (1-9 → 1-digit, 10-99 → 2-digit, etc.).
    Provider suffix lets the operator tell duplicate variants apart in
    the ZIP — see ExportProRequest.providers (parallel to asset_ids).
    Falls back to 'forklift_NN[.jpg|_Provider.jpg]' if every meta part
    sanitizes to empty.
    """
    parts = [
        _sanitize_filename_part(make),
        _sanitize_filename_part(model),
        _sanitize_filename_part(str(year)),
    ]
    parts = [p for p in parts if p]
    base = "_".join(parts) if parts else "forklift"
    if total >= 100:
        width = 3
    elif total >= 10:
        width = 2
    else:
        width = 1
    seq = str(index + 1).zfill(width)
    provider_part = ""
    if provider:
        # Capitalise just the first letter — easier to read in a file
        # explorer than ALL CAPS, and consistent with the brand chips
        # in the Enhance tab UI.
        provider_part = f"_{_sanitize_filename_part(provider).capitalize()}"
    return f"{base}_{seq}{provider_part}.jpg"


def _build_zip_filename(*, make: str, model: str, year: int) -> str:
    """
    Meta-derived name for the bundled ZIP so the operator's download is
    labelled with the unit instead of a generic 'cleanshot_pro_export.zip'.
    Mirrors the base of `_build_pro_filename`. Example:

      Toyota_8FGU25_2019.zip

    Falls back to 'cleanshot_pro_export.zip' if every meta part is empty.
    """
    parts = [
        _sanitize_filename_part(make),
        _sanitize_filename_part(model),
        _sanitize_filename_part(str(year) if year else ""),
    ]
    parts = [p for p in parts if p]
    return f"{'_'.join(parts)}.zip" if parts else "cleanshot_pro_export.zip"


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

        result = export_pro(input_bytes, ai_disclaimer=body.ai_disclaimer)
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
    dependencies=[Depends(require_api_key)],
)
async def export_pro_preview(
    body: ExportProRequest,
    request: Request,
    pool: asyncpg.Pool = Depends(get_pool),
) -> StreamingResponse:
    """
    Streaming variant of the PRO preview. Returns NDJSON events:

      {"event": "started",  "total": N}
      {"event": "progress", "current": K, "total": N, "filename": "..."}
      {"event": "result",   "items": [...], "zip_url": "...", ...}
      {"event": "error",    "message": "..."}

    Filenames are built deterministically from the saved project's
    make / model / year + a 1-indexed sequence number — no AI captioning.
    Captioning was tried but added ~2s per image of Vertex Gemini round-
    trips for no operator-visible benefit; the saved project metadata is
    the canonical source for naming anyway, and the operator has already
    typed it on the Save Project form.

    GCS downloads + uploads run in parallel; the pyvips resize loop and
    ZIP-builder are sequential (CPU-bound and single-writer respectively).

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

    # Build a per-asset_id → provider lookup before the stream starts.
    # `body.providers` is a parallel list to `body.asset_ids`; missing /
    # short / None entries default to None so the filename builder
    # falls back to the un-suffixed form.
    provider_by_asset_id: dict[uuid.UUID, str | None] = {}
    if body.providers is not None:
        for aid, p in zip(body.asset_ids, body.providers):
            provider_by_asset_id[aid] = p if p else None

    async def event_stream():
        try:
            # ── Phase 0: resolve + download all source bytes in parallel ──
            async def fetch_asset(asset_id):
                async with pool.acquire() as conn:
                    asset = await queries.get_asset(conn, asset_id)
                if asset is None:
                    return None
                without_scheme = asset.gcs_uri[len("gs://"):]
                src_bucket_name, _, src_obj = without_scheme.partition("/")
                blob_obj = gcs_client.bucket(src_bucket_name).blob(src_obj)
                input_bytes = await asyncio.to_thread(blob_obj.download_as_bytes)
                return (asset_id, input_bytes, src_obj)

            fetch_results = await asyncio.gather(
                *[fetch_asset(aid) for aid in body.asset_ids]
            )
            assets_data = [r for r in fetch_results if r is not None]
            total = len(assets_data)

            yield json.dumps({"event": "started", "total": total}) + "\n"

            # ── Phase 1: per-image resize + write (sequential — ZIP is
            # single-writer and pyvips is CPU-bound; parallelising would
            # only fight the GIL). Captioning is gone — filenames are
            # built from project.make / .model / .year + sequence number.
            items: list[dict] = []
            zip_buf = io.BytesIO()
            any_warning = False

            import pyvips

            with zipfile.ZipFile(zip_buf, "w", zipfile.ZIP_DEFLATED) as zf:
                for i, (asset_id, input_bytes, _src_obj) in enumerate(assets_data):
                    # Run pyvips in a worker thread so the event loop stays
                    # responsive (the yielded progress events should keep
                    # flowing even on slow images).
                    result = await asyncio.to_thread(
                        export_pro,
                        input_bytes,
                        ai_disclaimer=body.ai_disclaimer,
                    )
                    if result.size_warning:
                        any_warning = True

                    out_filename = _build_pro_filename(
                        make=project.make,
                        model=project.model,
                        year=project.year,
                        index=i,
                        total=total,
                        provider=provider_by_asset_id.get(asset_id),
                    )
                    out_object = f"session/{body.session_id}/pro/{asset_id}.jpg"
                    out_uri    = f"gs://{settings.gcs_bucket_derivatives}/{out_object}"

                    # Upload (I/O bound) — thread it so we don't block.
                    out_blob = derivatives_bucket.blob(out_object)
                    await asyncio.to_thread(
                        out_blob.upload_from_string,
                        result.data,
                        content_type="image/jpeg",
                    )

                    # download_filename so the per-image "Download" link
                    # saves under the meta name (Toyota_8FGU25_2019_01.jpg)
                    # instead of the raw {asset_id}.jpg object name — the
                    # HTML download attr can't override a cross-origin href.
                    preview_url, _ = gcs_service.mint_read_url(
                        out_uri,
                        download_filename=out_filename,
                    )
                    zf.writestr(out_filename, result.data)

                    probe = pyvips.Image.new_from_buffer(result.data, "")

                    items.append({
                        "asset_id":     str(asset_id),
                        "filename":     out_filename,
                        "url":          preview_url,
                        "width":        probe.width,
                        "height":       probe.height,
                        "size_bytes":   len(result.data),
                        "size_warning": result.size_warning,
                    })

                    yield json.dumps({
                        "event":    "progress",
                        "current":  i + 1,
                        "total":    total,
                        "filename": out_filename,
                    }) + "\n"

            # ── Phase 3: upload bundled ZIP, mint URL, emit result ──
            zip_bytes = zip_buf.getvalue()
            zip_object = f"session/{body.session_id}/pro/export_pro.zip"
            zip_uri    = f"gs://{settings.gcs_bucket_derivatives}/{zip_object}"
            zip_blob = derivatives_bucket.blob(zip_object)
            await asyncio.to_thread(
                zip_blob.upload_from_string,
                zip_bytes,
                content_type="application/zip",
            )
            zip_download_name = _build_zip_filename(
                make=project.make,
                model=project.model,
                year=project.year,
            )
            zip_url, _ = gcs_service.mint_read_url(
                zip_uri,
                download_filename=zip_download_name,
            )

            yield json.dumps({
                "event":            "result",
                "items":            items,
                "zip_url":          zip_url,
                "zip_filename":     zip_download_name,
                "zip_size_bytes":   len(zip_bytes),
                "any_size_warning": any_warning,
            }) + "\n"

        except Exception as exc:
            logger.exception("export_pro_preview stream failed")
            yield json.dumps({"event": "error", "message": str(exc)}) + "\n"

    return StreamingResponse(
        event_stream(),
        media_type="application/x-ndjson",
        # x-accel-buffering=no asks intermediate proxies (Cloud Run's
        # frontend, Vercel) to flush each chunk immediately instead of
        # buffering — without this the browser may not see the first
        # progress events until well into the process.
        headers={"X-Accel-Buffering": "no", "Cache-Control": "no-cache"},
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
