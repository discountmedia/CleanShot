"""
Photoroom background-removal client.

WHY IT EXISTS: an A/B against fal's BiRefNet, not a replacement. BiRefNet is a
SALIENT OBJECT detector, which is why the first production cutouts came back
with a potted plant and a wall banner attached. Photoroom is trained on PRODUCT
photography — one subject on a background — which is a better prior for "the
machine, not the scenery". Whether that actually shows up on forklift lattice is
unmeasured, hence the toggle.

⚠️ THE FREE TIER IS TEN IMAGES, TOTAL. Every flip of the Photoroom toggle on a
batch spends one credit per image. There is no metering here — the count lives
in Photoroom's dashboard.

THE CONTRACT
------------
  POST https://sdk.photoroom.com/v1/segment
  Header:  `x-api-key: <key>`   — NOT Bearer, and not Authorization at all.
                                  A wrong scheme returns 401, which reads
                                  exactly like a bad key.
  Body:    multipart/form-data, `image_file` plus form fields.
  Returns: the image BINARY directly (not JSON), so a JSON body in the response
           means something went wrong even on a 2xx.

`channels=alpha` should return a bare alpha mask rather than a finished cutout,
which is what we want — see cutout.py on why we never take a vendor's composite.
But we do NOT rely on that: `_mask_band` in cutout.py inspects what actually
arrived and pulls a mask out of either shape. That is deliberate. This contract
was written from the vendor's documentation rather than from a live call,
because a call costs one of ten credits, so the code treats the response shape
as something to detect rather than something to assume.
"""

from __future__ import annotations

import logging

import httpx

from cleanshot_api.core.config import get_settings

logger = logging.getLogger(__name__)

PHOTOROOM_ENDPOINT = "https://sdk.photoroom.com/v1/segment"

# Matting is a sub-10s operation, and the enhance request that wraps this is
# already inside Cloud Run's 900s ceiling. Long enough to survive a cold vendor,
# short enough that a hung one fails the job instead of eating the budget.
PHOTOROOM_TIMEOUT_S = 120.0


class PhotoroomError(RuntimeError):
    """
    A Photoroom call failed. Carries the HTTP status because the difference
    between 401 (key), 402 (out of credits — very live on a 10-image tier),
    and 429 (rate limit) is the whole diagnosis.
    """

    def __init__(self, message: str, *, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


async def segment(
    image_bytes: bytes,
    mime_type: str,
    *,
    channels: str = "alpha",
    output_size: str = "full",
) -> bytes:
    """
    Send one image for background removal. Returns the raw response bytes,
    which the caller normalises into an alpha channel.

    Does NOT interpret the payload: whether Photoroom honoured `channels=alpha`
    and sent a bare mask, or ignored it and sent a finished RGBA cutout, is the
    caller's problem to detect. Guessing here would put a silent wrong answer
    into the pipeline instead of a visible one.
    """
    settings = get_settings()
    key = getattr(settings, "photoroom_api_key", "")
    if not key:
        raise PhotoroomError(
            "PHOTOROOM_API_KEY is not set. It is mounted from "
            "cleanshot-photoroom-key via Cloud Run --set-secrets; check the "
            "deploy workflow if this fires in production."
        )

    files = {"image_file": ("image", image_bytes, mime_type)}
    data = {"format": "png", "channels": channels, "size": output_size}

    try:
        async with httpx.AsyncClient(timeout=PHOTOROOM_TIMEOUT_S) as client:
            resp = await client.post(
                PHOTOROOM_ENDPOINT,
                headers={"x-api-key": key, "Accept": "image/png, application/json"},
                files=files,
                data=data,
            )
    except httpx.HTTPError as exc:
        raise PhotoroomError(f"photoroom: transport error: {exc}") from exc

    if resp.status_code >= 400:
        # Body verbatim — Photoroom names the offending field on a 400, and a
        # 402 says which quota ran out. Summarising it wastes a credit's worth
        # of diagnosis.
        detail = resp.text[:800] if resp.text else "<empty body>"
        raise PhotoroomError(
            f"photoroom: HTTP {resp.status_code}: {detail}",
            status=resp.status_code,
        )

    content_type = resp.headers.get("Content-Type", "")
    if "json" in content_type.lower():
        # A 2xx carrying JSON is not a success — it is an error the vendor
        # chose not to give a status code to.
        raise PhotoroomError(
            f"photoroom: expected an image, got {content_type}: {resp.text[:400]}"
        )

    logger.info(
        "photoroom: segment ok, channels=%s size=%s, %d bytes in, %d bytes out (%s)",
        channels,
        output_size,
        len(image_bytes),
        len(resp.content),
        content_type or "no content-type",
    )
    return resp.content
