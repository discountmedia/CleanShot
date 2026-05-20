"""
Process-local async rate limiter — used to keep enhance jobs under
external-API request caps (e.g. OpenAI's 5 input-images/min on Tier 1
gpt-image-2). Multiple coroutines call .acquire() and the limiter
blocks just long enough to keep the rolling window under the cap, so
jobs queue instead of returning 429s.

Scope caveat:
  This limiter is in-process. Each Cloud Run instance maintains its own
  window — with max-instances=20 you could theoretically exceed the
  global cap by 20×. For current single-instance traffic the in-process
  variant is sufficient; if you bump max-instances and run heavy OpenAI
  batches, port this to Valkey-backed sorted-set state so the cap is
  enforced across the fleet.
"""

from __future__ import annotations

import asyncio
import logging
import time
from collections import deque

logger = logging.getLogger(__name__)


class AsyncRateLimiter:
    """Async sliding-window rate limiter: at most `max_events` per `interval_seconds`."""

    def __init__(self, *, max_events: int, interval_seconds: float, name: str = "rate_limiter"):
        if max_events < 1:
            raise ValueError("max_events must be >= 1")
        if interval_seconds <= 0:
            raise ValueError("interval_seconds must be > 0")
        self._max = max_events
        self._interval = interval_seconds
        self._name = name
        self._events: deque[float] = deque()
        self._lock = asyncio.Lock()

    async def acquire(self) -> None:
        """
        Block until a slot is available, then mark this acquisition.

        Multiple waiters serialize through the lock. Each waiter prunes
        expired entries, then either takes a slot immediately or sleeps
        until the oldest in-window entry ages out, plus a small buffer
        so we don't ride the boundary.
        """
        while True:
            async with self._lock:
                now = time.monotonic()
                # Drop entries that aged out of the rolling window.
                while self._events and now - self._events[0] >= self._interval:
                    self._events.popleft()
                if len(self._events) < self._max:
                    self._events.append(now)
                    return
                # At capacity — compute sleep until the oldest entry expires.
                wait = self._interval - (now - self._events[0]) + 0.25
            logger.info(
                "[%s] at capacity (%d events in last %.0fs) — sleeping %.2fs",
                self._name, self._max, self._interval, wait,
            )
            await asyncio.sleep(wait)
            # Re-acquire the lock and try again — between the sleep and
            # the re-check, another coroutine may have raced ahead.
