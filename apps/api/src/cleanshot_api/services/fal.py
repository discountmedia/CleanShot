"""
fal.ai model-endpoint client.

Deliberately generic: this is the transport for ANY fal model, not just the
matting one. The first caller is services/cutout.py (fal-ai/birefnet/v2), and
more fal features are planned, so model-specific request shaping belongs in the
caller and only the HTTP contract lives here.

THE CONTRACT (verified against fal's docs 2026-08-28)
-----------------------------------------------------
  • Synchronous:  POST https://fal.run/{model_id}
  • Queued:       POST https://queue.fal.run/{model_id}
  • Auth header:  `Authorization: Key <FAL_KEY>`  — the literal word "Key",
                  not "Bearer". A Bearer prefix returns 401 and reads exactly
                  like a bad key, so check this first if auth fails.

We use the SYNCHRONOUS endpoint. Matting is a sub-10s operation and the worker
is already inside a Cloud Tasks request with a 900s ceiling; the queue endpoint
would add a submit/poll/result round trip and a second failure surface for no
benefit. If a future fal model is slow enough to need the queue, add a
`run_queued` alongside `run` rather than converting this one.

IMAGE INPUTS
------------
fal image fields take a URL. Whether they also accept `data:` URIs is NOT
documented, so `image_ref` below tries the data URI first (no round trip) and
the caller can fall back to a signed GCS URL. See cutout.py for how that
fallback is driven — the point is that neither path is guessed at runtime
without being logged, so the first real run tells us which one fal wants.
"""

from __future__ import annotations

import base64
import logging
from typing import Any

import httpx

from cleanshot_api.core.config import get_settings

logger = logging.getLogger(__name__)

FAL_SYNC_BASE = "https://fal.run"
FAL_QUEUE_BASE = "https://queue.fal.run"

# Generous: a cold fal worker can take a while on the first call of a batch,
# and the enhance path that wraps this already lives under Cloud Run's 900s
# request ceiling. Short enough that a hung vendor fails the job rather than
# eating the whole request budget.
FAL_TIMEOUT_S = 120.0


class FalError(RuntimeError):
    """
    A fal call failed — auth, validation, rate limit, or an upstream error.

    Its own type so callers can distinguish "the vendor said no" from "our
    bytes were wrong". Carries the HTTP status when there was one, because the
    difference between 401 (key), 422 (request shape) and 429 (rate limit) is
    the whole diagnosis.
    """

    def __init__(self, message: str, *, status: int | None = None) -> None:
        super().__init__(message)
        self.status = status


def data_uri(image_bytes: bytes, content_type: str = "image/png") -> str:
    """Inline bytes as a data: URI, for image fields that accept one."""
    return f"data:{content_type};base64,{base64.b64encode(image_bytes).decode()}"


async def run(model_id: str, payload: dict[str, Any]) -> dict[str, Any]:
    """
    Call a fal model synchronously and return its parsed JSON output.

    Raises FalError on any non-2xx, with the response body in the message —
    fal's validation errors name the offending field, and losing that turns a
    30-second fix into an afternoon.
    """
    settings = get_settings()
    if not settings.fal_key:
        raise FalError(
            "FAL_KEY is not set. Mount cleanshot-fal-key:latest via Cloud Run "
            "--set-secrets and re-deploy."
        )

    url = f"{FAL_SYNC_BASE}/{model_id}"
    headers = {
        "Authorization": f"Key {settings.fal_key}",
        "Content-Type": "application/json",
    }

    try:
        async with httpx.AsyncClient(timeout=FAL_TIMEOUT_S) as client:
            resp = await client.post(url, headers=headers, json=payload)
    except httpx.HTTPError as exc:
        raise FalError(f"fal {model_id}: transport error: {exc}") from exc

    if resp.status_code >= 400:
        try:
            detail = resp.text[:1200]
        except Exception:  # pragma: no cover - defensive
            detail = "<unreadable body>"
        raise FalError(
            f"fal {model_id}: HTTP {resp.status_code}: {detail}",
            status=resp.status_code,
        )

    try:
        return resp.json()
    except ValueError as exc:
        raise FalError(f"fal {model_id}: response was not JSON") from exc


async def fetch_output(ref: Any) -> bytes:
    """
    Resolve a fal output file reference to bytes.

    fal returns image outputs as `{"url": ..., "content_type": ..., ...}`. The
    url is normally an https link to fal's CDN, but with `sync_mode` it can be
    a `data:` URI instead — so both are handled here rather than at each call
    site, and a future model that returns one or the other needs no change.
    """
    if isinstance(ref, dict):
        ref = ref.get("url")
    if not isinstance(ref, str) or not ref:
        raise FalError(f"fal: expected a file reference with a url, got {ref!r}")

    if ref.startswith("data:"):
        _, _, b64 = ref.partition(",")
        try:
            return base64.b64decode(b64)
        except Exception as exc:
            raise FalError("fal: output data URI was not valid base64") from exc

    try:
        async with httpx.AsyncClient(timeout=FAL_TIMEOUT_S) as client:
            resp = await client.get(ref)
    except httpx.HTTPError as exc:
        raise FalError(f"fal: could not fetch output: {exc}") from exc

    if resp.status_code >= 400:
        raise FalError(
            f"fal: output fetch returned HTTP {resp.status_code}",
            status=resp.status_code,
        )
    return resp.content
