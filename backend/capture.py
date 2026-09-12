"""Camera capture and the door trigger.

There is no door sensor and no wiring. A camera inside a closed fridge sees black, so mean
frame brightness crossing a threshold IS the door sensor. Two thresholds rather than one, so a
flickering light or a hand shadow cannot rattle the state machine.
"""

from __future__ import annotations

import logging
import threading
import time
from collections.abc import Callable
from datetime import datetime
from pathlib import Path

import cv2
import numpy as np

from backend.config import Settings, get_settings

logger = logging.getLogger(__name__)

CycleHandler = Callable[[Path, Path], None]


def frame_brightness(frame: np.ndarray) -> float:
    """Mean luminance, 0-255. The whole door sensor is this one number."""
    if frame.ndim == 3:
        frame = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
    return float(np.mean(frame))


def save_frame(frame: np.ndarray, label: str, settings: Settings | None = None) -> Path:
    settings = settings or get_settings()
    settings.frame_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
    path = settings.frame_dir / f"{stamp}-{label}.jpg"
    cv2.imwrite(str(path), frame, [int(cv2.IMWRITE_JPEG_QUALITY), 88])
    return path


class DoorWatcher:
    """Watches the fridge camera and calls `on_cycle(frame_a, frame_b)` per door cycle.

    `frame_a` is captured a few frames after the door opens, once exposure has settled and
    before a hand is usually in the way. `frame_b` is the last well-lit frame before the door
    shut. Everything in between is discarded.
    """

    def __init__(
        self,
        on_cycle: CycleHandler,
        settings: Settings | None = None,
        on_state: Callable[[str, float], None] | None = None,
    ) -> None:
        self.settings = settings or get_settings()
        self.on_cycle = on_cycle
        self.on_state = on_state
        self._thread: threading.Thread | None = None
        self._stop = threading.Event()
        self.door_open = False
        self.last_brightness = 0.0
        self.running = False
        self.error: str | None = None

    # --- lifecycle -----------------------------------------------------------

    def start(self) -> bool:
        if self.running:
            return True
        capture = cv2.VideoCapture(self.settings.camera_index)
        if not capture.isOpened():
            capture.release()
            self.error = f"camera {self.settings.camera_index} would not open"
            logger.warning(self.error)
            return False
        self._stop.clear()
        self.running = True
        self.error = None
        self._thread = threading.Thread(target=self._loop, args=(capture,), daemon=True)
        self._thread.start()
        logger.info("door watcher started on camera %s", self.settings.camera_index)
        return True

    def stop(self) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=3.0)
        self.running = False

    # --- the state machine ---------------------------------------------------

    def _loop(self, capture: cv2.VideoCapture) -> None:
        frames_since_open = 0
        frame_a: np.ndarray | None = None
        last_lit: np.ndarray | None = None

        try:
            while not self._stop.is_set():
                ok, frame = capture.read()
                if not ok:
                    time.sleep(0.5)
                    continue

                brightness = frame_brightness(frame)
                self.last_brightness = brightness

                if not self.door_open and brightness >= self.settings.door_open_brightness:
                    self.door_open = True
                    frames_since_open = 0
                    frame_a = None
                    last_lit = None
                    self._announce("door_opened", brightness)

                elif self.door_open:
                    frames_since_open += 1
                    if frame_a is None and frames_since_open >= self.settings.settle_frames:
                        frame_a = frame.copy()
                    if brightness >= self.settings.door_close_brightness:
                        last_lit = frame.copy()
                    else:
                        self.door_open = False
                        self._announce("door_closed", brightness)
                        self._finish_cycle(frame_a, last_lit)
                        frame_a = None
                        last_lit = None

                time.sleep(self.settings.poll_interval_seconds)
        finally:
            capture.release()
            self.running = False

    def _finish_cycle(self, frame_a: np.ndarray | None, frame_b: np.ndarray | None) -> None:
        if frame_a is None or frame_b is None:
            logger.info("door cycle too short to compare - ignoring")
            return
        path_a = save_frame(frame_a, "before", self.settings)
        path_b = save_frame(frame_b, "after", self.settings)
        try:
            self.on_cycle(path_a, path_b)
        except Exception:  # a bad cycle must not take the camera thread down
            logger.exception("door cycle handler failed")

    def _announce(self, state: str, brightness: float) -> None:
        logger.info("%s (brightness %.1f)", state, brightness)
        if self.on_state:
            self.on_state(state, brightness)


def snapshot(settings: Settings | None = None) -> Path | None:
    """Grab a single frame. Used by the manual capture button in the dashboard."""
    settings = settings or get_settings()
    capture = cv2.VideoCapture(settings.camera_index)
    try:
        if not capture.isOpened():
            return None
        for _ in range(settings.settle_frames):  # let exposure settle
            capture.read()
        ok, frame = capture.read()
        return save_frame(frame, "manual", settings) if ok else None
    finally:
        capture.release()
