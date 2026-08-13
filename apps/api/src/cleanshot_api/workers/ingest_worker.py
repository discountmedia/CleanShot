"""
media-auditor → CleanShot photo copy worker.

One Cloud Task per photo. Fetches the source URL, writes the bytes into the
originals bucket, creates the asset row tagged with the unit's stock number, and
moves the ingest item to a TERMINAL state — 'landed' or 'failed' with a reason.

Every item reaches terminal. That is the contract the frontend's placeholder
tiles depend on: a photo that never arrives must become a visible error, never a
permanent skeleton. So every failure path below writes a reason, and the bare
`except Exception` at the end exists specifically to guarantee it.

Partial failure is normal and non-fatal: what landed is usable immediately, and
what didn't is surfaced per-photo rather than failing the whole import.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import mimetypes
import os
from urllib.parse import unquote, urlparse

import httpx
from fastapi import BackgroundTasks, Request

from cleanshot_api.db import queries
from cleanshot_api.models.schemas import IngestCopyTaskPayload, OperationEnum
from cleanshot_api.services import gcs as gcs_service

logger = logging.getLogger(__name__)

# Photos come off a public listing CDN. Generous but bounded — a hung fetch must
# not hold a Cloud Tasks slot for the full 30-minute dispatch deadline.
_FETCH_TIMEOUT_S = 30.0

# Refuse anything implausible for a listing photo. The cap is about not writing
# a 200 MB surprise into the bucket, not about image quality.
_MAX_BYTES = 40 * 1024 * 1024

_ALLOWED_CONTENT_PREFIX = "image/"


def _derive_filename(source_url: str, supplied: str | None) -> str:
    """
    Display name for the grid.

    The asset row has no filename column — the frontend recovers the name from
    the GCS object basename — so whatever this returns is what the operator
    sees. Falls back to the URL basename, then to a generic name, and always
    ends up with an extension so content-type sniffing downstream behaves.
    """
    candidate = (supplied or "").strip()
    if not candidate:
        path = urlparse(source_url).path
        candidate = unquote(os.path.basename(path)).strip()
    if not candidate:
        candidate = "imported.jpg"
    # Strip any path separators a caller may have included; this becomes part of
    # a GCS object name and must stay a single segment.
    candidate = candidate.replace("\\", "/").split("/")[-1]
    if "." not in candidate:
        candidate = f"{candidate}.jpg"
    return candidate[:180]


async def _copy_one(payload: IngestCopyTaskPayload, pool) -> None:
    filename = _derive_filename(payload.source_url, payload.filename)

    try:
        async with httpx.AsyncClient(
            timeout=_FETCH_TIMEOUT_S, follow_redirects=True
        ) as client:
            resp = await client.get(payload.source_url)

        if resp.status_code != 200:
            async with pool.acquire() as conn:
                await queries.mark_ingest_item_failed(
                    conn,
                    item_id=payload.item_id,
                    error=f"Source returned HTTP {resp.status_code}",
                )
            return

        data = resp.content
        if not data:
            async with pool.acquire() as conn:
                await queries.mark_ingest_item_failed(
                    conn, item_id=payload.item_id, error="Source returned no data"
                )
            return

        if len(data) > _MAX_BYTES:
            async with pool.acquire() as conn:
                await queries.mark_ingest_item_failed(
                    conn,
                    item_id=payload.item_id,
                    error=f"Photo is too large ({len(data) // (1024 * 1024)} MB)",
                )
            return

        # Trust the response header when it's an image type; otherwise fall back
        # to the filename. A listing CDN that serves octet-stream shouldn't cost
        # the operator a photo.
        content_type = (resp.headers.get("content-type") or "").split(";")[0].strip()
        if not content_type.startswith(_ALLOWED_CONTENT_PREFIX):
            guessed, _ = mimetypes.guess_type(filename)
            if guessed and guessed.startswith(_ALLOWED_CONTENT_PREFIX):
                content_type = guessed
            else:
                async with pool.acquire() as conn:
                    await queries.mark_ingest_item_failed(
                        conn,
                        item_id=payload.item_id,
                        error="Source is not an image",
                    )
                return

        content_hash = hashlib.sha256(data).hexdigest()

        # Dedupe on (source_batch_id, checksum). Catches a re-sent batch AND a
        # Cloud Tasks retry that died after the asset was already written —
        # without this, a retry would duplicate the photo in the grid.
        async with pool.acquire() as conn:
            existing = await queries.find_landed_item_by_hash(
                conn, payload.source_batch_id, content_hash
            )
            if existing and existing.get("asset_id"):
                await queries.mark_ingest_item_landed(
                    conn,
                    item_id=payload.item_id,
                    asset_id=existing["asset_id"],
                    content_hash=content_hash,
                )
                logger.info(
                    "ingest item %s deduped onto existing asset %s",
                    payload.item_id,
                    existing["asset_id"],
                )
                return

        # Blocking GCS client — keep the event loop free. Same reason the image
        # workers thread their pyvips work out.
        gcs_uri = await asyncio.to_thread(
            gcs_service.upload_bytes,
            session_id=payload.session_id,
            filename=filename,
            content_type=content_type,
            data=data,
        )

        async with pool.acquire() as conn:
            asset = await queries.create_asset(
                conn,
                session_id=payload.session_id,
                # operation=upload so this asset is a SOURCE image, indistinguishable
                # from a browser upload to every downstream consumer (enhance,
                # export, the grid's operation filter). source_ref is what marks
                # it as imported.
                operation=OperationEnum.upload,
                gcs_uri=gcs_uri,
                content_hash=content_hash,
                source_ref=payload.stock_number,
            )
            await queries.mark_ingest_item_landed(
                conn,
                item_id=payload.item_id,
                asset_id=asset.id,
                content_hash=content_hash,
            )

        logger.info(
            "ingest item %s landed as asset %s (%d bytes)",
            payload.item_id,
            asset.id,
            len(data),
        )

    except httpx.TimeoutException:
        async with pool.acquire() as conn:
            await queries.mark_ingest_item_failed(
                conn, item_id=payload.item_id, error="Timed out fetching the photo"
            )
    except Exception as exc:  # noqa: BLE001 — terminality is the whole point
        # The frontend shows a placeholder per expected photo. If an unforeseen
        # error escaped here, that tile would spin forever. Catch everything,
        # record something the operator can act on, log the detail server-side.
        logger.exception("ingest item %s failed", payload.item_id)
        async with pool.acquire() as conn:
            await queries.mark_ingest_item_failed(
                conn,
                item_id=payload.item_id,
                error=f"Copy failed: {type(exc).__name__}",
            )


async def handle_ingest_copy_task(
    payload: IngestCopyTaskPayload,
    background_tasks: BackgroundTasks,
    request: Request,
) -> dict:
    """
    Cloud Tasks target. Quick-acknowledge: HTTP 200 first, copy in the
    background — same shape as the enhance/scan workers.
    """
    background_tasks.add_task(_copy_one, payload, request.app.state.pool)
    return {"status": "accepted", "item_id": str(payload.item_id)}
