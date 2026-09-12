"""The door trigger. There is no sensor - brightness is the sensor - so the threshold
behaviour is worth pinning down."""

from __future__ import annotations

import numpy as np

from backend.capture import frame_brightness


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
