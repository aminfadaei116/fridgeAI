"""The shelf-life agent: how long does this keep, and what did it cost?

Seeded table first, cache second, model last. The demo must never wait on a network round
trip to put a pepper on the board.
"""

from __future__ import annotations

import json
import logging
from pathlib import Path

from backend.agents.base import Agent
from backend.config import REPO_ROOT
from backend.llm import LLMUnavailable
from backend.schemas import ShelfLifeVerdict

logger = logging.getLogger(__name__)

SEED_PATH = REPO_ROOT / "data" / "shelf_life_seed.json"

SYSTEM = """You are a food safety reference. Given a food name, state how many days it keeps \
in a home fridge at 4C from the moment it goes in, its typical Canadian retail cost in CAD, \
and one short storage tip.

Be conservative: this number decides when someone is told to throw food away. For raw meat and \
fish, use the food-safety limit, not the optimistic one. For shelf-stable items that merely \
live in the fridge, a long number is correct."""

DEFAULT_DAYS = 7
DEFAULT_COST = 4.0


class ShelfLifeAgent(Agent):
    name = "shelf_life"
    role = "Resolves how long a food keeps and roughly what it cost."

    def seed(self, seed_path: Path = SEED_PATH) -> int:
        """Load the seed table into the cache. Idempotent."""
        if not seed_path.exists():
            logger.warning("shelf life seed missing at %s", seed_path)
            return 0
        payload = json.loads(seed_path.read_text())
        for entry in payload.get("items", []):
            self.store.put_shelf_life(
                entry["name"],
                entry["days"],
                entry.get("cost", DEFAULT_COST),
                entry.get("tip", ""),
                "seed",
            )
        return len(payload.get("items", []))

    def resolve(self, name: str) -> ShelfLifeVerdict:
        """Look the food up. Cache hit, then model, then a safe default."""
        key = name.lower().strip()
        cached = self.store.get_shelf_life(key)
        if cached:
            return ShelfLifeVerdict(
                name=key,
                shelf_life_days=cached["shelf_life_days"],
                est_cost=cached["est_cost"],
                storage_tip=cached["storage_tip"],
            )

        verdict = self._ask_model(key)
        self.store.put_shelf_life(
            verdict.name,
            verdict.shelf_life_days,
            verdict.est_cost,
            verdict.storage_tip,
            "model" if self.llm.available else "default",
        )
        return verdict

    def _ask_model(self, key: str) -> ShelfLifeVerdict:
        if not self.llm.available:
            return ShelfLifeVerdict(
                name=key,
                shelf_life_days=DEFAULT_DAYS,
                est_cost=DEFAULT_COST,
                storage_tip="Unknown item - assuming one week.",
            )
        try:
            verdict = self.llm.structured(
                schema=ShelfLifeVerdict,
                system=SYSTEM,
                user=f"Food: {key}",
                model=self.settings.fast_model,
                temperature=0.0,
            )
            verdict.name = key
            return verdict
        except LLMUnavailable as exc:
            logger.warning("shelf life lookup failed for %s: %s", key, exc)
            return ShelfLifeVerdict(
                name=key,
                shelf_life_days=DEFAULT_DAYS,
                est_cost=DEFAULT_COST,
                storage_tip="Could not reach the reference - assuming one week.",
            )
