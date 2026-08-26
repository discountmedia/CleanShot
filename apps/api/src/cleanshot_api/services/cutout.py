"""
Background removal (matting) — turns a finished enhance output into a
transparent-background PNG for the new-equipment site.

WHY THIS IS A MATTING PASS AND NOT A PROMPT
-------------------------------------------
The obvious-looking implementation is to ask the image model for "a seamless
white backdrop" or "transparent background". That is a GENERATION: the model
re-draws the machine, which re-opens identity drift (the whole reason
identity-preserving editing exists in this stack), and it has to decide where
the machine ends. A forklift is the worst case for that — mast lattice, fork
gaps, overhead-guard openings — and this repo's durable findings already record
that Gemini handles exactly that kind of fine structure inconsistently, with no
background texture left to hide a mistake in.

So this runs AFTER enhancement, over the finished pixels, and only computes an
alpha channel. The RGB is untouched: whatever the operator approved is still
exactly what ships, just with the backdrop knocked out.

WHY IN-CONTAINER AND NOT A VENDOR
---------------------------------
Chosen 2026-08-26. A dedicated cutout vendor (remove.bg / Bria / Photoroom)
has better edges on fine lattice, but it means a new secret, a new rate
limiter, per-image spend on what is a bulk listing workflow, and one more
vendor that can 429 mid-batch. An ONNX model in the container has none of
those: no key, no network, no limiter, no marginal cost, and it cannot fail
because someone else is having an outage. The price is image size, cold-start
weight, and CPU time — which is why every call goes through asyncio.to_thread
(see remove_background) so a 2800x2000 matting pass never blocks the event
loop that Cloud Tasks callbacks are arriving on.

The model is baked into the image at BUILD time (see apps/api/Dockerfile) and
CUTOUT_MODEL_HOME points at it. Nothing here downloads anything at runtime:
the container runs as a non-root user, and a first-request download would turn
a cold start into a multi-hundred-megabyte fetch.
"""

from __future__ import annotations

import asyncio
import logging
import os
import threading
from typing import Any

import pyvips

logger = logging.getLogger(__name__)

# Which matting model to load. `isnet-general-use` is the default because it is
# a good accuracy/size trade for machinery silhouettes (~170 MB) and noticeably
# better than u2net on thin structure. `birefnet-general` is stronger still on
# lattice and considerably larger — swappable by env var precisely so that
# comparison is a redeploy, not a code change. Whatever is set here MUST also
# be pre-fetched in the Dockerfile, or the first request tries to download it.
CUTOUT_MODEL = os.environ.get("CUTOUT_MODEL", "isnet-general-use")

# Alpha matting (pymatting) refines the mask edge but is very expensive at
# 2800x2000 and can chew fine structure rather than help it. Off by default;
# flip via env after looking at real output, not before.
CUTOUT_ALPHA_MATTING = os.environ.get("CUTOUT_ALPHA_MATTING", "").lower() == "true"

# One session per process, built lazily on first use. Creating an
# InferenceSession is the expensive part (model parse + graph optimise);
# Run() on an existing one is thread-safe, so a single shared session is
# correct and a pool would only multiply memory.
_session: Any | None = None
_session_lock = threading.Lock()


class CutoutUnavailableError(RuntimeError):
    """
    Raised when the matting model cannot be loaded at all — a missing or
    corrupt baked model, or the optional dependency absent from the image.

    Deliberately its own type: the caller treats "the cutout engine is broken"
    differently from "this image failed". The first should not silently ship an
    opaque image to a site that requires transparency.
    """


def _get_session() -> Any:
    global _session
    if _session is not None:
        return _session
    with _session_lock:
        # Re-check inside the lock — two Cloud Tasks callbacks can arrive at
        # once and both find _session None outside it.
        if _session is not None:
            return _session
        try:
            from rembg import new_session
        except ImportError as exc:  # pragma: no cover - image build guarantees it
            raise CutoutUnavailableError(
                "rembg is not installed in this image; the transparent-background "
                "toggle cannot work. Check apps/api/pyproject.toml."
            ) from exc
        try:
            _session = new_session(CUTOUT_MODEL)
        except Exception as exc:
            raise CutoutUnavailableError(
                f"Could not load the matting model {CUTOUT_MODEL!r}. It must be "
                "pre-fetched into CUTOUT_MODEL_HOME at image build time."
            ) from exc
        logger.info("cutout: matting session ready (model=%s)", CUTOUT_MODEL)
    return _session


def has_alpha(image_bytes: bytes) -> bool:
    """
    True when these bytes already carry a transparency channel.

    Used by the per-variant erase/tweak paths to answer "was this variant a
    cutout?" without threading a flag through four schemas. A vendor edit
    returns opaque pixels, so without this check a tweak on a cutout would
    silently hand back a black background — worse than refusing.
    """
    try:
        return bool(pyvips.Image.new_from_buffer(image_bytes, "").hasalpha())
    except Exception:
        # An unreadable buffer is not this function's problem to report; the
        # caller is about to fail on it far more informatively.
        return False


def _remove_background_sync(image_bytes: bytes) -> bytes:
    from rembg import remove

    session = _get_session()
    out = remove(
        image_bytes,
        session=session,
        alpha_matting=CUTOUT_ALPHA_MATTING,
        # Morphological clean-up of the raw mask. Cheap, and it is what stops
        # speckle inside fork gaps and under the overhead guard.
        post_process_mask=True,
    )
    if not isinstance(out, (bytes, bytearray)):  # pragma: no cover - API contract
        raise CutoutUnavailableError(
            f"matting returned {type(out).__name__}, expected bytes"
        )
    return bytes(out)


async def remove_background(image_bytes: bytes) -> bytes:
    """
    Knock the backdrop out of a finished enhance output. Returns PNG bytes with
    a real alpha channel, at the SAME dimensions as the input — the caller has
    already standardised to 2800x2000 and this must not change that.

    CPU-bound, so it runs on a worker thread. At 2800x2000 the pass is on the
    order of a second or two, which is nothing next to the 20-75s vendor call
    it follows, but it is enough to stall the event loop if run inline.

    Raises CutoutUnavailableError if the engine cannot run. Callers must NOT
    swallow that into "ship it opaque": the whole point of the toggle is that
    the destination site needs transparency, so an opaque file is a wrong
    answer dressed as a success.
    """
    out = await asyncio.to_thread(_remove_background_sync, image_bytes)

    # Verify the contract rather than trusting it. A model or library upgrade
    # that started returning RGB would otherwise produce a silently opaque
    # "cutout" that only surfaces as a complaint from the website.
    if not has_alpha(out):
        raise CutoutUnavailableError(
            "matting produced an image with no alpha channel; refusing to pass "
            "it off as a cutout"
        )
    return out


def flatten_onto_white(image_bytes: bytes) -> bytes:
    """
    Composite a transparent image onto opaque white, for the paths that
    genuinely cannot carry alpha.

    Not used by the export route — that emits PNG and keeps the transparency —
    but kept here because it is the one correct way to do this and it is easy
    to get wrong: pyvips `flatten` needs an explicit background, and letting it
    default gives BLACK, which on a product cutout is the single most visible
    possible failure.
    """
    img = pyvips.Image.new_from_buffer(image_bytes, "")
    if not img.hasalpha():
        return image_bytes
    return img.flatten(background=[255, 255, 255]).write_to_buffer(".png")
