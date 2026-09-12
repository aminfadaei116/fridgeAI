"""In-process pub/sub so the dashboard sees a door cycle the moment it happens.

The camera runs on its own thread while the web server runs an event loop, so publishing has
to cross that boundary safely - hence the captured loop and `call_soon_threadsafe`.
"""

from __future__ import annotations

import asyncio
import json
import logging
from datetime import datetime
from typing import Any

logger = logging.getLogger(__name__)


class EventBus:
    """Fan-out of live events to every connected dashboard."""

    def __init__(self, max_queue: int = 100) -> None:
        self._subscribers: list[asyncio.Queue[str]] = []
        self._loop: asyncio.AbstractEventLoop | None = None
        self._max_queue = max_queue

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    def subscribe(self) -> asyncio.Queue[str]:
        queue: asyncio.Queue[str] = asyncio.Queue(maxsize=self._max_queue)
        self._subscribers.append(queue)
        return queue

    def unsubscribe(self, queue: asyncio.Queue[str]) -> None:
        if queue in self._subscribers:
            self._subscribers.remove(queue)

    def publish(self, kind: str, payload: dict[str, Any] | None = None) -> None:
        """Safe to call from any thread."""
        message = json.dumps(
            {"kind": kind, "ts": datetime.now().isoformat(), "data": payload or {}},
            default=str,
        )
        if self._loop is None or self._loop.is_closed():
            return
        try:
            self._loop.call_soon_threadsafe(self._dispatch, message)
        except RuntimeError:  # loop shut down mid-publish
            logger.debug("event loop gone, dropping %s", kind)

    def _dispatch(self, message: str) -> None:
        for queue in list(self._subscribers):
            try:
                queue.put_nowait(message)
            except asyncio.QueueFull:
                # A dashboard that cannot keep up loses the backlog, not the connection.
                logger.debug("subscriber queue full, dropping event")


bus = EventBus()
