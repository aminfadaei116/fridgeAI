"""The daily meal board.

The product promise is that recipes arrive every day without being asked for. That makes the
caching rules load-bearing: too eager and the demo blocks for a minute on every page load,
too lazy and the board on screen is built around food that has already been eaten.
"""

from __future__ import annotations

import threading
import time
from datetime import date, timedelta

from backend.pipeline import FridgePipeline
from tests.conftest import detected


def build_pipeline(ctx) -> FridgePipeline:
    pipeline = FridgePipeline(ctx)
    pipeline.shelf_life.seed()
    return pipeline


def test__cached_plan__is_none_before_anything_is_planned(ctx):
    # Act / Assert
    assert build_pipeline(ctx).cached_plan() is None


def test__plan_today__is_served_from_cache_on_the_same_fridge(ctx, store):
    # Arrange
    store.add_item(detected("spinach"), shelf_life_days=1, est_cost=4.49)
    pipeline = build_pipeline(ctx)

    # Act
    first = pipeline.plan_today()
    cached = pipeline.cached_plan()

    # Assert: the second read costs nothing.
    assert cached is not None
    assert cached["recipes"] == first["recipes"]


def test__cached_plan__goes_stale_when_an_item_is_added(ctx, store):
    # Arrange
    store.add_item(detected("spinach"), shelf_life_days=1, est_cost=4.49)
    pipeline = build_pipeline(ctx)
    pipeline.plan_today()

    # Act: someone puts the shopping away.
    store.add_item(detected("chicken breast"), shelf_life_days=2, est_cost=12.99)

    # Assert: yesterday's board no longer describes this fridge.
    assert pipeline.cached_plan() is None


def test__cached_plan__goes_stale_when_an_item_is_eaten(ctx, store, curator):
    # Arrange
    store.add_item(detected("spinach"), shelf_life_days=1, est_cost=4.49)
    store.add_item(detected("milk"), shelf_life_days=5, est_cost=5.49)
    pipeline = build_pipeline(ctx)
    pipeline.plan_today()

    # Act: the spinach the board was built around leaves the fridge.
    curator.commit_remove(store.find_present("spinach"))

    # Assert
    assert pipeline.cached_plan() is None


def test__cached_plan__is_ignored_once_the_date_rolls_over(ctx, store):
    # Arrange: a plan stored under yesterday's date, with a still-valid signature.
    store.add_item(detected("spinach"), shelf_life_days=1, est_cost=4.49)
    pipeline = build_pipeline(ctx)
    yesterday = (date.today() - timedelta(days=1)).isoformat()
    store.put_daily_plan(yesterday, store.inventory_signature(), {"recipes": [], "nutrition": {}})

    # Act / Assert: "every day" means a new board each day, not a stale one carried forward.
    assert pipeline.cached_plan() is None


def test__plan_today__covers_all_three_meals(ctx, store):
    # Arrange
    store.add_item(detected("spinach"), shelf_life_days=1, est_cost=4.49)

    # Act
    plan = build_pipeline(ctx).plan_today()

    # Assert: the offline chef still returns one per meal, so the promise holds without a model.
    meals = {r["meal"] for r in plan["recipes"]}
    assert meals == {"breakfast", "lunch", "dinner"}


def test__plan_today__uses_the_household_profile(ctx, store):
    # Arrange
    store.add_item(detected("spinach"), shelf_life_days=1, est_cost=4.49)
    store.set_profile("household_size", 5)

    # Act
    plan = build_pipeline(ctx).plan_today()

    # Assert: a standing fact applies to the daily board, not just to chat requests.
    assert all(r["servings"] == 5 for r in plan["recipes"])


def test__plan_today__anchors_on_what_spoils_soonest(ctx, store):
    # Arrange
    store.add_item(detected("carrot"), shelf_life_days=28, est_cost=2.49)
    store.add_item(detected("spinach"), shelf_life_days=1, est_cost=4.49)

    # Act
    plan = build_pipeline(ctx).plan_today()

    # Assert
    assert "spinach" in plan["recipes"][0]["uses_expiring"]


def test__reset__clears_the_stored_plan(ctx, store):
    # Arrange
    store.add_item(detected("spinach"), shelf_life_days=1, est_cost=4.49)
    pipeline = build_pipeline(ctx)
    pipeline.plan_today()

    # Act
    store.reset()

    # Assert: reseeding the demo must not leave the previous fridge's menu behind.
    assert store.get_daily_plan(date.today().isoformat()) is None


def test__plan_today_async__does_not_start_a_second_plan_while_one_runs(ctx, store, monkeypatch):
    """Two requests arriving together must produce one plan, not two.

    The dashboard polls and the door cycle re-plans, so concurrent triggers are normal. A
    full board is two model calls over the whole fridge; running it twice is real money and,
    worse, two writes racing for the same cache row.
    """
    # Arrange
    store.add_item(detected("spinach"), shelf_life_days=1, est_cost=4.49)
    pipeline = build_pipeline(ctx)

    started = threading.Event()
    release = threading.Event()
    runs = []

    def slow_plan(options_per_meal: int = 2) -> dict:
        runs.append(1)
        started.set()
        release.wait(timeout=5)
        return {"recipes": [], "nutrition": {}}

    monkeypatch.setattr(pipeline, "plan_today", slow_plan)

    # Act: the first call takes the lock and blocks inside the plan.
    assert pipeline.plan_today_async() is True
    assert started.wait(timeout=5)
    second = pipeline.plan_today_async()
    release.set()

    # Assert
    assert second is False, "a second plan started while one was already running"
    assert len(runs) == 1


def test__planning_flag__clears_after_a_failed_plan(ctx, store, monkeypatch):
    # Arrange: a chef that blows up.
    store.add_item(detected("spinach"), shelf_life_days=1, est_cost=4.49)
    pipeline = build_pipeline(ctx)

    def explode(options_per_meal: int = 2) -> dict:
        raise RuntimeError("chef is on fire")

    monkeypatch.setattr(pipeline, "plan_today", explode)

    # Act
    pipeline.plan_today_async()
    for _ in range(50):
        if not pipeline.planning:
            break
        time.sleep(0.05)

    # Assert: a failure must not wedge the lock and block every future plan.
    assert pipeline.planning is False
