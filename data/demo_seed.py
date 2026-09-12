"""A pre-aged fridge for the demo.

Dates are set relative to now, so the expiry board is live the moment the seeder runs rather
than depending on when the fixture was written. The mushrooms have been picked up and put back
three times on purpose - that is the line the sentinel gets to use.
"""

from __future__ import annotations

from datetime import datetime, timedelta

from backend.db import Store
from backend.schemas import Category, DetectedItem

# (name, category, quantity, unit, days it has ALREADY been in the fridge)
DEMO_ITEMS: list[tuple[str, Category, float, str, int]] = [
    ("spinach", Category.PRODUCE, 1, "bag", 5),
    ("mushroom", Category.PRODUCE, 250, "g", 6),
    ("chicken breast", Category.MEAT, 2, "piece", 1),
    ("greek yogurt", Category.DAIRY, 1, "tub", 12),
    ("milk", Category.DAIRY, 2, "L", 5),
    ("egg", Category.DAIRY, 8, "unit", 6),
    ("bell pepper", Category.PRODUCE, 3, "unit", 3),
    ("cheddar cheese", Category.DAIRY, 1, "block", 9),
    ("carrot", Category.PRODUCE, 6, "unit", 8),
    ("tomato", Category.PRODUCE, 4, "unit", 5),
    ("feta cheese", Category.DAIRY, 1, "block", 14),
    ("lemon", Category.PRODUCE, 2, "unit", 6),
    ("cooked rice", Category.LEFTOVERS, 1, "container", 2),
    ("hummus", Category.CONDIMENT, 1, "tub", 5),
    ("green onion", Category.PRODUCE, 1, "bunch", 7),
]

# Last week's history, so the ledger opens with a number on it.
DEMO_LEDGER: list[tuple[str, str, float, str]] = [
    ("strawberry", "wasted", 5.49, "went furry at the back of the shelf"),
    ("cilantro", "wasted", 1.99, "turned to liquid in its bag"),
    ("chicken breast", "saved", 12.99, "used the night before its date"),
    ("broccoli", "saved", 3.49, "roasted on day seven"),
    ("yogurt", "saved", 5.99, "finished with two days to spare"),
    ("bell pepper", "saved", 2.19, "used in a stir fry"),
    ("milk", "saved", 5.49, "finished on time"),
]

# Items handled repeatedly without being used - the sentinel cites this.
HANDLED: dict[str, int] = {"mushroom": 3, "greek yogurt": 2}


def seed_demo_fridge(store: Store, shelf_life_agent) -> dict:
    """Wipe the fridge and refill it with a realistic, already-aging inventory."""
    store.reset()

    now = datetime.now()
    for name, category, quantity, unit, age_days in DEMO_ITEMS:
        verdict = shelf_life_agent.resolve(name)
        item_id = store.add_item(
            DetectedItem(
                name=name, category=category, quantity=quantity, unit=unit, confidence=1.0
            ),
            shelf_life_days=verdict.shelf_life_days,
            est_cost=verdict.est_cost,
            storage_tip=verdict.storage_tip,
            added_at=now - timedelta(days=age_days),
        )
        for _ in range(HANDLED.get(name, 0)):
            store.bump_removal_count(item_id)

    for item_name, kind, cost, reason in DEMO_LEDGER:
        store.record_ledger(item_name, kind, cost, reason)

    store.set_profile("household_size", 2)
    store.log_event("demo_seeded", payload={"items": len(DEMO_ITEMS)})

    expiring = store.expiring_within(3)
    return {
        "items": len(DEMO_ITEMS),
        "expiring_soon": [{"name": i.name, "days_left": i.days_left} for i in expiring],
        "ledger": store.ledger_totals().model_dump(),
    }
