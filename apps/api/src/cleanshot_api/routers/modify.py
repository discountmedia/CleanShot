"""
POST /api/v1/modify/batch — apply Brightness / Contrast / Saturation
adjustments to a batch of assets and return the new asset rows.

Backed by services.image_processing.apply_adjustments (pyvips). Each
incoming asset is downloaded from GCS, run through the pyvips pipeline,
re-uploaded as a fresh asset row with operation=modify, and returned
to the frontend with a signed GET URL.

Phase 1 is batch-only: same adjustments applied to every asset_id in
the request. Per-image variation is a follow-up.
"""

from __future__ import annotations

import asyncio
import hashlib
import logging
import uuid

import asyncpg
import pyvips
from fastapi import APIRouter, Depends, HTTPException, status

from cleanshot_api.core.security import require_api_key
from cleanshot_api.db import queries
from cleanshot_api.db.pool import get_pool
from cleanshot_api.models.schemas import (
    ModifyBatchItem,
    ModifyBatchRequest,
    ModifyBatchResponse,
    OperationEnum,
)
from cleanshot_api.services import gcs as gcs_service
from cleanshot_api.services.image_processing import apply_adjustments

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/v1", tags=["modify"])


@router.post(
    "/modify/batch",
    response_model=ModifyBatchResponse,
    dependencies=[Depends(require_api_key)],
)
async def modify_batch(
    body: ModifyBatchRequest,
    pool: asyncpg.Pool = Depends(get_pool),
) -> ModifyBatchResponse:
    """
    Apply the same Brightness/Contrast/Saturation adjustments to every
    asset in the batch. Returns one ModifyBatchItem per input, in the
    same order as `asset_ids`.

    Each output asset is written to
        gs://cleanshot-derivatives-prod/session/{session_id}/modify/{asset_id}.png
    and registered with operation=modify so the History/admin views can
    distinguish darkroom output from primary enhance output.
    """
    from google.cloud import storage as gcs_lib
    from cleanshot_api.core.config import get_settings
    settings = get_settings()
    gcs_client = gcs_lib.Client(project=settings.gcp_project)
    derivatives_bucket = gcs_client.bucket(settings.gcs_bucket_derivatives)

    adj = body.adjustments

    async def fetch_bytes(asset_id: uuid.UUID) -> tuple[uuid.UUID, bytes] | None:
        async with pool.acquire() as conn:
            asset = await queries.get_asset(conn, asset_id)
        if asset is None or asset.session_id != body.session_id:
            return None
        without_scheme = asset.gcs_uri[len("gs://"):]
        bucket_name, _, obj = without_scheme.partition("/")
        blob_bytes = await asyncio.to_thread(
            gcs_client.bucket(bucket_name).blob(obj).download_as_bytes,
        )
        return (asset_id, blob_bytes)

    fetched = await asyncio.gather(*[fetch_bytes(aid) for aid in body.asset_ids])
    missing = [aid for aid, blob in zip(body.asset_ids, fetched) if blob is None]
    if missing:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"Assets not found / wrong session: {missing}",
        )

    items: list[ModifyBatchItem] = []
    for aid, source in fetched:
        # pyvips is CPU-bound — dispatch to a worker thread so the event
        # loop stays responsive for any other in-flight requests.
        modified_bytes = await asyncio.to_thread(
            apply_adjustments,
            source,
            brightness=adj.brightness,
            contrast=adj.contrast,
            saturation=adj.saturation,
            rotation_deg=adj.rotation_deg,
            crop_aspect=adj.crop_aspect,
            crop_zoom=adj.crop_zoom,
        )

        # Probe the output dims so the frontend can render proper sized
        # thumbnails without a separate roundtrip.
        probe = pyvips.Image.new_from_buffer(modified_bytes, "")
        width, height = probe.width, probe.height

        # Write to GCS under the session's modify/ prefix.
        new_asset_uuid = uuid.uuid4()
        out_object = f"session/{body.session_id}/modify/{new_asset_uuid}.png"
        out_blob = derivatives_bucket.blob(out_object)
        await asyncio.to_thread(
            out_blob.upload_from_string,
            modified_bytes,
            content_type="image/png",
        )
        out_uri = f"gs://{settings.gcs_bucket_derivatives}/{out_object}"
        content_hash = hashlib.sha256(modified_bytes).hexdigest()

        # Register a new asset row so the rest of the pipeline (Resize,
        # History, admin usage) sees it as a first-class asset.
        async with pool.acquire() as conn:
            new_asset = await queries.create_asset(
                conn,
                session_id=body.session_id,
                operation=OperationEnum.modify,
                gcs_uri=out_uri,
                content_hash=content_hash,
            )

        # Mint a signed GET URL so the frontend can render the result
        # inline without another roundtrip.
        signed_url, _expires_at = gcs_service.mint_read_url(out_uri)

        items.append(ModifyBatchItem(
            asset_id=new_asset.id,
            filename=f"{aid}_modify.png",  # derivative filename — operator-facing
            url=signed_url,
            width=width,
            height=height,
        ))

    return ModifyBatchResponse(items=items)
