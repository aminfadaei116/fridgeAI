"""The curator is the confidence gate. These tests pin the three outcomes - commit, ask,
ignore - and the consumed-versus-wasted call that feeds the ledger."""

from __future__ import annotations

from datetime import datetime, timedelta

from backend.agents.curator import CuratorAgent
from backend.schemas import ItemStatus, VisionDiff
from tests.conftest import detected


def test__reconcile__commits_a_confident_addition(curator: CuratorAgent, store):
    # Arrange
    diff = VisionDiff(added=[detected("bell pepper", 0.94)])

    # Act
    result = curator.reconcile(diff)

    # Assert
    assert [i.name for i in result.added] == ["bell pepper"]
    assert [i.name for i in store.list_inventory()] == ["bell pepper"]
    assert not result.questions


def test__reconcile__asks_instead_of_guessing_when_unsure(curator: CuratorAgent, store):
    # Arrange: 0.61 sits between the reject floor and the auto-commit bar.
    diff = VisionDiff(added=[detected("chicken breast", 0.61)])

    # Act
    result = curator.reconcile(diff)

    # Assert: nothing was written, and a question is waiting for the human.
    assert store.list_inventory() == []
    assert len(result.questions) == 1
    assert "61%" in result.questions[0]
    assert len(store.list_pending()) == 1


def test__reconcile__ignores_a_detection_below_the_reject_floor(curator: CuratorAgent, store):
    # Arrange
    diff = VisionDiff(added=[detected("something blurry", 0.12)])

    # Act
    result = curator.reconcile(diff)

    # Assert: no inventory row, and no question either - it is not worth asking about.
    assert store.list_inventory() == []
    assert store.list_pending() == []
    assert result.ignored


def test__reconcile__sets_an_expiry_date_from_the_shelf_life_table(curator: CuratorAgent, store):
    # Act
    curator.reconcile(VisionDiff(added=[detected("spinach", 0.95)]))

    # Assert: spinach is a five-day food, so it is due in five days.
    item = store.find_present("spinach")
    assert item is not None
    assert item.shelf_life_days == 5
    assert item.days_left == 5


def test__reconcile__ignores_a_removal_of_something_not_in_the_fridge(curator: CuratorAgent, store):
    # Act
    result = curator.reconcile(VisionDiff(removed=[detected("lobster", 0.99)]))

    # Assert
    assert result.removed == []
    assert result.ignored


def test__removal_before_the_date__books_the_money_as_saved(curator: CuratorAgent, store):
    # Arrange: fresh spinach, added today.
    curator.reconcile(VisionDiff(added=[detected("spinach", 0.95)]))

    # Act
    curator.reconcile(VisionDiff(removed=[detected("spinach", 0.95)]))

    # Assert
    totals = store.ledger_totals()
    assert totals.items_saved == 1
    assert totals.items_wasted == 0
    assert totals.saved_cad > 0


def test__removal_after_the_date__books_the_money_as_wasted(curator: CuratorAgent, store):
    # Arrange: spinach that went in three weeks ago is long past its five days.
    store.add_item(
        detected("spinach"),
        shelf_life_days=5,
        est_cost=4.49,
        added_at=datetime.now() - timedelta(days=21),
    )

    # Act
    result = curator.reconcile(VisionDiff(removed=[detected("spinach", 0.95)]))

    # Assert
    assert result.removed[0].name == "spinach"
    totals = store.ledger_totals()
    assert totals.items_wasted == 1
    assert totals.items_saved == 0
    assert store.list_inventory(ItemStatus.DISCARDED)[0].name == "spinach"


def test__removal__matches_a_differently_worded_name(curator: CuratorAgent, store):
    # Arrange: the fridge knows it as "bell pepper".
    curator.reconcile(VisionDiff(added=[detected("bell pepper", 0.95)]))

    # Act: the vision agent calls it a "red bell pepper" on the way out.
    result = curator.reconcile(VisionDiff(removed=[detected("red bell pepper", 0.95)]))

    # Assert: one item left the fridge, rather than a duplicate being ignored.
    assert len(result.removed) == 1
    assert store.list_inventory() == []


def test__removal__leaves_an_unrelated_item_alone(curator: CuratorAgent, store):
    # Arrange
    curator.reconcile(VisionDiff(added=[detected("bell pepper", 0.95)]))

    # Act: "black pepper" shares a word but is a different food.
    result = curator.reconcile(VisionDiff(removed=[detected("chicken breast", 0.95)]))

    # Assert
    assert result.removed == []
    assert len(store.list_inventory()) == 1


def test__resolve_pending__confirmed_writes_the_item_as_certain(curator: CuratorAgent, store):
    # Arrange
    curator.reconcile(VisionDiff(added=[detected("chicken breast", 0.61)]))
    pending = store.list_pending()[0]

    # Act
    item = curator.resolve_pending(pending.id, confirmed=True)

    # Assert: a human answer is ground truth, so the stored confidence is 1.
    assert item is not None
    assert store.find_present("chicken breast").confidence == 1.0
    assert store.list_pending() == []


def test__resolve_pending__rejected_writes_nothing(curator: CuratorAgent, store):
    # Arrange
    curator.reconcile(VisionDiff(added=[detected("chicken breast", 0.61)]))
    pending = store.list_pending()[0]

    # Act
    item = curator.resolve_pending(pending.id, confirmed=False)

    # Assert
    assert item is None
    assert store.list_inventory() == []
    assert store.list_pending() == []


def test__reconcile__handles_an_add_and_a_remove_in_one_door_cycle(curator: CuratorAgent, store):
    # Arrange
    curator.reconcile(VisionDiff(added=[detected("milk", 0.95)]))

    # Act: one trip to the fridge - put the peppers in, take the milk out.
    result = curator.reconcile(
        VisionDiff(added=[detected("bell pepper", 0.91)], removed=[detected("milk", 0.93)])
    )

    # Assert
    assert [i.name for i in result.added] == ["bell pepper"]
    assert [i.name for i in result.removed] == ["milk"]
    assert [i.name for i in store.list_inventory()] == ["bell pepper"]
