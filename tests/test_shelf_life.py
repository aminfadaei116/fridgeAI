"""The shelf-life agent must answer from the seed table without touching a model."""

from __future__ import annotations

from backend.agents.shelf_life import DEFAULT_DAYS, ShelfLifeAgent


def test__seed__loads_the_reference_table(shelf_life: ShelfLifeAgent, store):
    # Arrange / Act: the fixture already seeded.
    names = store.shelf_life_names()

    # Assert
    assert "spinach" in names
    assert len(names) > 40


def test__resolve__answers_seeded_food_without_a_model(shelf_life: ShelfLifeAgent):
    # Act
    verdict = shelf_life.resolve("chicken breast")

    # Assert: raw chicken is the food-safety number, not the optimistic one.
    assert verdict.shelf_life_days == 2
    assert verdict.est_cost > 0
    assert verdict.storage_tip


def test__resolve__is_case_and_whitespace_insensitive(shelf_life: ShelfLifeAgent):
    assert (
        shelf_life.resolve("  SPINACH ").shelf_life_days
        == shelf_life.resolve("spinach").shelf_life_days
    )


def test__resolve__falls_back_to_a_safe_default_for_unknown_food(shelf_life: ShelfLifeAgent):
    # Act: nothing in the seed table and no model reachable.
    verdict = shelf_life.resolve("dragonfruit compote")

    # Assert
    assert verdict.shelf_life_days == DEFAULT_DAYS


def test__resolve__caches_the_fallback_so_it_is_asked_once(shelf_life: ShelfLifeAgent, store):
    # Act
    shelf_life.resolve("dragonfruit compote")

    # Assert
    assert store.get_shelf_life("dragonfruit compote") is not None
