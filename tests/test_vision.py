"""The vision agent turns a door-cycle clip into a VisionDiff.

The model reports crossings of the door plane; netting those into added/removed is pure,
deterministic code and is where the in-versus-out answer actually comes from. It is worth
pinning down hard, because every downstream agent trusts it.
"""

from __future__ import annotations

from backend.agents.vision import Crossing, VisionAgent, evidence_time, reduce_crossings
from backend.schemas import Category


def crossing(item_id: int, name: str, action: str, time_s: float, **kwargs) -> Crossing:
    return Crossing(item_id=item_id, name=name, action=action, time_s=time_s, **kwargs)


def test__reduce_crossings__counts_an_item_that_only_went_in_as_added():
    # Arrange
    crossings = [crossing(1, "bell pepper", "in", 2.0, confidence=0.9)]

    # Act
    diff = reduce_crossings(crossings)

    # Assert
    assert [i.name for i in diff.added] == ["bell pepper"]
    assert diff.removed == []


def test__reduce_crossings__counts_an_item_that_only_came_out_as_removed():
    # Arrange
    crossings = [crossing(1, "greek yogurt", "out", 1.5, confidence=0.8)]

    # Act
    diff = reduce_crossings(crossings)

    # Assert
    assert [i.name for i in diff.removed] == ["greek yogurt"]
    assert diff.added == []


def test__reduce_crossings__nets_an_item_put_in_and_taken_back_out_to_nothing():
    # Arrange: the same physical item crosses twice, so the fridge ends up unchanged.
    crossings = [
        crossing(1, "milk", "in", 1.0, confidence=0.9),
        crossing(1, "milk", "out", 4.0, confidence=0.9),
    ]

    # Act
    diff = reduce_crossings(crossings)

    # Assert
    assert diff.added == []
    assert diff.removed == []


def test__reduce_crossings__nets_an_item_taken_out_and_put_back_to_nothing():
    # Arrange: read the label, put it back. Nothing changed.
    crossings = [
        crossing(1, "ketchup", "out", 1.0, confidence=0.9),
        crossing(1, "ketchup", "in", 6.0, confidence=0.9),
    ]

    # Act
    diff = reduce_crossings(crossings)

    # Assert
    assert diff.added == []
    assert diff.removed == []


def test__reduce_crossings__orders_by_time_not_by_the_order_the_model_listed_them():
    # Arrange: same item, reported out-of-order. Chronology decides the net result.
    crossings = [
        crossing(1, "butter", "out", 9.0, confidence=0.9),
        crossing(1, "butter", "in", 2.0, confidence=0.9),
    ]

    # Act
    diff = reduce_crossings(crossings)

    # Assert: in at 2s then out at 9s nets to nothing, despite the listing order.
    assert diff.added == []
    assert diff.removed == []


def test__reduce_crossings__keeps_every_field_the_curator_and_store_need():
    # Arrange
    crossings = [
        crossing(
            1,
            "Chicken Breast",
            "in",
            3.0,
            category=Category.MEAT,
            quantity=2.0,
            unit="fillet",
            confidence=0.91,
            note="seen clearly",
        )
    ]

    # Act
    item = reduce_crossings(crossings).added[0]

    # Assert: the name is normalised the way the two-frame path normalised it.
    assert item.name == "chicken breast"
    assert item.category is Category.MEAT
    assert item.quantity == 2.0
    assert item.unit == "fillet"
    assert item.confidence == 0.91
    assert item.note == "seen clearly"


def test__reduce_crossings__clamps_a_confidence_the_model_reported_out_of_range():
    # Arrange: models occasionally answer 1.2. That must not blow up validation downstream.
    crossings = [crossing(1, "apple", "in", 1.0, confidence=1.4)]

    # Act
    diff = reduce_crossings(crossings)

    # Assert
    assert diff.added[0].confidence == 1.0


def test__reduce_crossings__takes_the_confidence_of_the_crossing_that_decided_the_outcome():
    # Arrange: two separate items, each with its own confidence.
    crossings = [
        crossing(1, "spinach", "in", 1.0, confidence=0.95),
        crossing(2, "salmon", "in", 3.0, confidence=0.42),
    ]

    # Act
    by_name = {i.name: i for i in reduce_crossings(crossings).added}

    # Assert
    assert by_name["spinach"].confidence == 0.95
    assert by_name["salmon"].confidence == 0.42


def test__reduce_crossings__returns_an_empty_diff_when_nothing_crossed():
    # Arrange: someone opened the door and stared. A correct, common answer.
    # Act
    diff = reduce_crossings([], scene_note="door opened, nothing moved")

    # Assert
    assert diff.added == []
    assert diff.removed == []
    assert diff.scene_note == "door opened, nothing moved"


def test__evidence_time__points_at_the_first_item_going_in():
    # Arrange: the thumbnail should show something arriving, not something leaving.
    crossings = [
        crossing(1, "juice", "out", 1.0, confidence=0.9),
        crossing(2, "eggs", "in", 5.0, confidence=0.9),
    ]

    # Act / Assert
    assert evidence_time(crossings) == 5.0


def test__evidence_time__falls_back_to_the_first_crossing_when_nothing_went_in():
    # Arrange
    crossings = [crossing(1, "juice", "out", 2.5, confidence=0.9)]

    # Act / Assert
    assert evidence_time(crossings) == 2.5


def test__evidence_time__is_none_when_nothing_crossed():
    # Act / Assert
    assert evidence_time([]) is None


def test__vision__returns_an_empty_diff_when_no_model_is_reachable(ctx, tmp_path):
    # Arrange
    agent = VisionAgent(ctx)
    clip = tmp_path / "cycle.mp4"
    clip.write_bytes(b"not really a video")

    # Act
    reading = agent.watch(clip)

    # Assert: no invented items, and the reason is stated.
    assert reading.diff.added == []
    assert reading.diff.removed == []
    assert "offline" in reading.diff.scene_note
    assert reading.crossings == []


def test__vision__still_answers_a_frame_pair_for_providers_without_video(ctx, tmp_path):
    # Arrange: the two-frame path stays available for OpenAI and for offline mode.
    agent = VisionAgent(ctx)
    frame = tmp_path / "frame.jpg"
    frame.write_bytes(b"not really a jpeg")

    # Act
    diff = agent.diff(frame, frame)

    # Assert
    assert diff.added == []
    assert "offline" in diff.scene_note
