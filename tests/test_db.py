"""Storage behaviour the rest of the system takes for granted."""

from __future__ import annotations

from datetime import datetime, timedelta

from backend.schemas import ItemStatus
from tests.conftest import detected


def test__expiring_within__returns_soonest_first(store):
    # Arrange
    store.add_item(detected("carrot"), shelf_life_days=28)
    store.add_item(detected("spinach"), shelf_life_days=2)
    store.add_item(detected("milk"), shelf_life_days=5)

    # Act
    soon = store.expiring_within(days=6)

    # Assert: the carrot is outside the window and the rest are in date order.
    assert [i.name for i in soon] == ["spinach", "milk"]


def test__find_present__returns_the_oldest_of_a_duplicate(store):
    # Arrange: two tubs of yogurt, bought a week apart.
    older = store.add_item(
        detected("yogurt"), shelf_life_days=14, added_at=datetime.now() - timedelta(days=7)
    )
    store.add_item(detected("yogurt"), shelf_life_days=14)

    # Act
    found = store.find_present("yogurt")

    # Assert: first in, first out.
    assert found.id == older


def test__find_present__ignores_items_already_taken_out(store):
    # Arrange
    item_id = store.add_item(detected("milk"), shelf_life_days=7)
    store.mark_removed(item_id, ItemStatus.CONSUMED)

    # Act / Assert
    assert store.find_present("milk") is None


def test__ledger_totals__separates_money_used_from_money_lost(store):
    # Arrange
    store.record_ledger("spinach", "wasted", 4.49, "went slimy")
    store.record_ledger("chicken breast", "saved", 12.99, "cooked in time")
    store.record_ledger("milk", "saved", 5.49, "finished")

    # Act
    totals = store.ledger_totals()

    # Assert
    assert totals.saved_cad == 18.48
    assert totals.wasted_cad == 4.49
    assert totals.items_saved == 2
    assert totals.items_wasted == 1


def test__ledger_totals__ignores_entries_outside_the_window(store):
    # Arrange
    store.record_ledger("spinach", "wasted", 4.49)

    # Act: a window that ends before the entry was written.
    totals = store.ledger_totals(since_days=-1)

    # Assert
    assert totals.items_wasted == 0


def test__add_item__leaves_expiry_empty_when_shelf_life_is_unknown(store):
    # Act
    store.add_item(detected("mystery jar"), shelf_life_days=None)

    # Assert
    item = store.find_present("mystery jar")
    assert item.expires_at is None
    assert item.days_left is None


def test__bump_removal_count__tracks_repeated_handling(store):
    # Arrange
    item_id = store.add_item(detected("mushroom"), shelf_life_days=6)

    # Act: picked up and put back three times.
    for _ in range(3):
        store.bump_removal_count(item_id)

    # Assert - this is the evidence the sentinel cites.
    assert store.find_present("mushroom").removal_count == 3


def test__profile__round_trips_structured_values(store):
    # Arrange / Act
    store.set_profile("allergies", ["shellfish", "walnut"])
    store.set_profile("household_size", 4)

    # Assert
    profile = store.get_profile()
    assert profile["allergies"] == ["shellfish", "walnut"]
    assert profile["household_size"] == 4


def test__set_profile__overwrites_rather_than_duplicating(store):
    # Arrange
    store.set_profile("diet_plan", "vegetarian")

    # Act
    store.set_profile("diet_plan", "vegan")

    # Assert
    assert store.get_profile()["diet_plan"] == "vegan"


def test__inventory__carries_the_frame_it_was_seen_in(store):
    # Arrange: a real door cycle records which frame the item was spotted in.
    store.add_item(
        detected("bell pepper"), shelf_life_days=12, frame_ref="20260912-141258-after.jpg"
    )

    # Act
    item = store.find_present("bell pepper")

    # Assert: the dashboard uses this to show the actual photo the camera took.
    assert item.frame_ref == "20260912-141258-after.jpg"


def test__manually_added_item__has_no_frame(store):
    # Arrange: typed in by hand, so there is no photo behind it.
    store.add_item(detected("milk"), shelf_life_days=7)

    # Act / Assert: the UI must treat the photo as optional.
    assert store.find_present("milk").frame_ref is None


def test__serialised_item__carries_days_left(store):
    """days_left must survive model_dump, not just attribute access.

    The SSE payloads and the dashboard toasts read it off the dumped model; as a plain
    property it vanished and every toast read "no date".
    """
    # Arrange
    store.add_item(detected("spinach"), shelf_life_days=5)

    # Act
    dumped = store.find_present("spinach").model_dump(mode="json")

    # Assert
    assert dumped["days_left"] == 5
