"""The door trigger. There is no sensor - brightness is the sensor - so the threshold
behaviour is worth pinning down."""

from __future__ import annotations

import cv2
import numpy as np

from backend.capture import ClipRecorder, extract_still, frame_brightness


def test__frame_brightness__reads_a_closed_fridge_as_dark():
    # Arrange: the camera sees black when the door is shut and the light is off.
    closed = np.zeros((48, 64, 3), dtype=np.uint8)

    # Act / Assert
    assert frame_brightness(closed) < 5


def test__frame_brightness__reads_an_open_fridge_as_bright():
    # Arrange: door open, interior light on.
    lit = np.full((48, 64, 3), 200, dtype=np.uint8)

    # Act / Assert
    assert frame_brightness(lit) > 150


def test__frame_brightness__crosses_the_default_threshold_between_the_two(settings):
    # Arrange
    closed = np.zeros((48, 64, 3), dtype=np.uint8)
    lit = np.full((48, 64, 3), 200, dtype=np.uint8)

    # Act / Assert: the default open threshold separates the two states cleanly.
    assert frame_brightness(closed) < settings.door_open_brightness
    assert frame_brightness(lit) >= settings.door_open_brightness


def test__frame_brightness__accepts_a_single_channel_frame():
    # Arrange: already-grayscale input must not blow up the colour conversion.
    gray = np.full((48, 64), 120, dtype=np.uint8)

    # Act / Assert
    assert 119 <= frame_brightness(gray) <= 121


def test__clip_recorder__writes_a_readable_clip_of_everything_it_was_given(tmp_path):
    # Arrange: a door cycle's worth of frames, brightening as the door swings open.
    recorder = ClipRecorder(tmp_path / "cycle.mp4", fps=10.0)
    for i in range(20):
        recorder.write(np.full((48, 64, 3), 100 + i, dtype=np.uint8))

    # Act
    clip = recorder.close()

    # Assert
    assert clip is not None and clip.is_file()
    capture = cv2.VideoCapture(str(clip))
    try:
        assert capture.get(cv2.CAP_PROP_FRAME_COUNT) == 20
    finally:
        capture.release()


def test__clip_recorder__returns_nothing_when_no_frame_was_ever_written(tmp_path):
    # Arrange: a door cycle so short the camera gave us nothing is not a clip.
    recorder = ClipRecorder(tmp_path / "empty.mp4", fps=10.0)

    # Act / Assert
    assert recorder.close() is None


def test__clip_recorder__stops_writing_once_the_clip_hits_its_cap(tmp_path):
    # Arrange: a door left hanging open must not record forever.
    recorder = ClipRecorder(tmp_path / "long.mp4", fps=10.0, max_seconds=1.0)

    # Act: offer three seconds of frames to a one-second cap.
    for _ in range(30):
        recorder.write(np.full((48, 64, 3), 120, dtype=np.uint8))
    clip = recorder.close()

    # Assert
    capture = cv2.VideoCapture(str(clip))
    try:
        assert capture.get(cv2.CAP_PROP_FRAME_COUNT) == 10
    finally:
        capture.release()


def test__extract_still__saves_the_frame_at_the_moment_asked_for(tmp_path, settings):
    # Arrange: a clip whose brightness rises one step per frame, so each moment is identifiable.
    recorder = ClipRecorder(tmp_path / "cycle.mp4", fps=10.0)
    for i in range(30):
        recorder.write(np.full((48, 64, 3), 10 + i * 5, dtype=np.uint8))
    clip = recorder.close()

    # Act: the frame two seconds in.
    still = extract_still(clip, 2.0, settings=settings)

    # Assert: a real jpeg, and it is the bright end of the clip rather than the dark start.
    assert still is not None and still.is_file()
    assert frame_brightness(cv2.imread(str(still))) > 100


def test__extract_still__returns_none_for_a_clip_that_cannot_be_read(tmp_path, settings):
    # Arrange
    broken = tmp_path / "broken.mp4"
    broken.write_bytes(b"not a video")

    # Act / Assert: a missing thumbnail is not a reason to lose the whole door cycle.
    assert extract_still(broken, 1.0, settings=settings) is None


def test__extract_still__falls_back_to_the_first_frame_when_no_time_is_given(tmp_path, settings):
    # Arrange
    recorder = ClipRecorder(tmp_path / "cycle.mp4", fps=10.0)
    for _ in range(10):
        recorder.write(np.full((48, 64, 3), 90, dtype=np.uint8))
    clip = recorder.close()

    # Act
    still = extract_still(clip, None, settings=settings)

    # Assert
    assert still is not None and still.is_file()
