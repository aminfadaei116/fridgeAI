"""Camera capture and the door trigger.

There is no door sensor and no wiring. A camera inside a closed fridge sees black, so mean
frame brightness crossing a threshold IS the door sensor. Two thresholds rather than one, so a
flickering light or a hand shadow cannot rattle the state machine.

The trigger does not decide what the model looks at, only *when* to look: everything between
the door opening and the door closing is recorded to one clip and handed over whole.
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

CycleHandler = Callable[[Path], None]

# Container and codec for recorded door cycles. mp4v ships with opencv-python on every
# platform we run on, and Gemini accepts video/mp4 either inline or through the Files API.
CLIP_SUFFIX = ".mp4"
CLIP_FOURCC = "mp4v"


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


def clip_duration(clip: Path) -> float:
    """Clip length in seconds, or 0.0 if it cannot be read."""
    capture = cv2.VideoCapture(str(clip))
    try:
        if not capture.isOpened():
            return 0.0
        fps = capture.get(cv2.CAP_PROP_FPS)
        frames = capture.get(cv2.CAP_PROP_FRAME_COUNT)
        return float(frames / fps) if fps and frames else 0.0
    finally:
        capture.release()


def extract_still(
    clip: Path, time_s: float | None, settings: Settings | None = None
) -> Path | None:
    """Pull one frame out of a clip and save it as a jpeg.

    This is the evidence photo the dashboard shows next to an item. Taking it at the moment the
    item crossed the door beats the old end-of-cycle shelf shot, because the item is in shot and
    in a hand rather than buried behind whatever was put in after it.

    Returns None if the clip cannot be read - a missing thumbnail must never cost us the cycle.
    """
    capture = cv2.VideoCapture(str(clip))
    try:
        if not capture.isOpened():
            return None
        if time_s:
            capture.set(cv2.CAP_PROP_POS_MSEC, max(0.0, time_s) * 1000.0)
        ok, frame = capture.read()
        if not ok:  # asked for a moment past the end; fall back to the first frame
            capture.set(cv2.CAP_PROP_POS_MSEC, 0)
            ok, frame = capture.read()
        return save_frame(frame, "crossing", settings) if ok else None
    finally:
        capture.release()


class ClipRecorder:
    """Writes one door cycle to one video file.

    Lazy about opening the file, because the frame size is only known once a frame arrives, and
    a door cycle that produced no frames at all should leave nothing behind.
    """

    def __init__(self, path: Path, fps: float, max_seconds: float | None = None) -> None:
        self.path = path
        self.fps = max(1.0, fps)
        self.max_frames = int(self.fps * max_seconds) if max_seconds else None
        self.frames = 0
        self._writer: cv2.VideoWriter | None = None

    @property
    def full(self) -> bool:
        return self.max_frames is not None and self.frames >= self.max_frames

    def write(self, frame: np.ndarray) -> None:
        if self.full:
            return
        if self._writer is None:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            height, width = frame.shape[:2]
            self._writer = cv2.VideoWriter(
                str(self.path), cv2.VideoWriter_fourcc(*CLIP_FOURCC), self.fps, (width, height)
            )
            if not self._writer.isOpened():
                self._writer = None
                raise RuntimeError(f"could not open {self.path} for writing ({CLIP_FOURCC})")
        self._writer.write(frame)
        self.frames += 1

    def close(self) -> Path | None:
        """Finish the file. Returns the clip, or None if nothing was ever written."""
        if self._writer is None:
            return None
        self._writer.release()
        self._writer = None
        return self.path


class DoorWatcher:
    """Watches the fridge camera and calls `on_cycle(clip)` once per door cycle.

    The clip runs from the frame the door opened to the frame it shut. Nothing is thrown away
    in between, because the in-versus-out answer lives in the motion across the door plane and
    not in any single frame.
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
        fps = self._camera_fps(capture)
        recorder: ClipRecorder | None = None

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
                    recorder = ClipRecorder(
                        self._new_clip_path(), fps, self.settings.clip_max_seconds
                    )
                    self._announce("door_opened", brightness)

                if self.door_open:
                    if brightness >= self.settings.door_close_brightness:
                        self._record(recorder, frame)
                    else:
                        self.door_open = False
                        self._announce("door_closed", brightness)
                        self._finish_cycle(recorder)
                        recorder = None
                else:
                    # Only idle when the door is shut. While it is open the camera's own frame
                    # rate paces the loop, so the clip runs at something close to real time.
                    time.sleep(self.settings.poll_interval_seconds)
        finally:
            if recorder is not None:
                recorder.close()
            capture.release()
            self.running = False

    def _camera_fps(self, capture: cv2.VideoCapture) -> float:
        """The camera's own frame rate, or the configured fallback if it will not say.

        Webcams routinely report 0. Getting this wrong only skews the clip's playback speed -
        and with it the model's timestamps - so it is worth asking rather than assuming.
        """
        reported = capture.get(cv2.CAP_PROP_FPS)
        if reported and 1.0 <= reported <= 120.0:
            return float(reported)
        return self.settings.clip_fps

    def _new_clip_path(self) -> Path:
        self.settings.clip_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")
        return self.settings.clip_dir / f"{stamp}-cycle{CLIP_SUFFIX}"

    def _record(self, recorder: ClipRecorder | None, frame: np.ndarray) -> None:
        if recorder is None:
            return
        try:
            recorder.write(frame)
        except RuntimeError:  # no codec, full disk - log once and let the cycle end empty
            logger.exception("could not record door cycle")

    def _finish_cycle(self, recorder: ClipRecorder | None) -> None:
        clip = recorder.close() if recorder else None
        if clip is None:
            logger.info("door cycle produced no frames - ignoring")
            return
        try:
            self.on_cycle(clip)
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
