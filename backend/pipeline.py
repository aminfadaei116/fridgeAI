"""The spine: one door-cycle clip in, one committed inventory change out.

Everything the camera triggers flows through `process_cycle`. The web API calls the same
function for simulated cycles, so the demo path and the real path are the same code.
"""

from __future__ import annotations

import logging
import threading
from datetime import date
from pathlib import Path

from backend.agents import (
    AgentContext,
    ChefAgent,
    ConciergeAgent,
    CuratorAgent,
    NutritionAgent,
    SentinelAgent,
    ShelfLifeAgent,
    VisionAgent,
)
from backend.agents.curator import CurationResult
from backend.agents.vision import evidence_time
from backend.capture import DoorWatcher, extract_still
from backend.events import bus
from backend.schemas import MealRequest, VisionDiff

logger = logging.getLogger(__name__)


class FridgePipeline:
    """Owns the agent roster and the camera. One instance per process."""

    def __init__(self, ctx: AgentContext | None = None) -> None:
        self.ctx = ctx or AgentContext.build()
        self.shelf_life = ShelfLifeAgent(self.ctx)
        self.vision = VisionAgent(self.ctx)
        self.curator = CuratorAgent(self.ctx, shelf_life=self.shelf_life)
        self.chef = ChefAgent(self.ctx)
        self.nutritionist = NutritionAgent(self.ctx)
        self.sentinel = SentinelAgent(self.ctx)
        self.concierge = ConciergeAgent(self.ctx)
        self.watcher = DoorWatcher(self.process_cycle, self.ctx.settings, on_state=self._on_state)
        self._planning = threading.Lock()

        self.shelf_life.seed()

    @property
    def store(self):
        return self.ctx.store

    # --- the door cycle ------------------------------------------------------

    def process_cycle(self, clip: Path) -> CurationResult:
        """One clip to a committed inventory change. Called from the camera thread."""
        bus.publish("analyzing", {"clip": clip.name})

        reading = self.vision.watch(clip)
        diff = reading.diff

        # Freeze the clip at the moment something crossed the door: that frame shows the item
        # in a hand rather than buried behind whatever went in after it.
        still = extract_still(clip, evidence_time(reading.crossings), self.ctx.settings)
        still_name = still.name if still else None

        # The event log keeps both artefacts: the clip that was watched, and the still shown
        # in the dashboard beside the item.
        self.store.log_event(
            "vision_diff",
            frame_before=clip.name,
            frame_after=still_name,
            payload=diff.model_dump(mode="json"),
        )

        result = self.curator.reconcile(diff, frame_ref=still_name)
        self._publish_result(result, diff)

        # The board is built around what is about to spoil, so a change to the fridge
        # invalidates it. Rebuild in the background rather than showing a stale plan.
        if (result.added or result.removed) and self.ctx.llm.available:
            self.plan_today_async()
        return result

    def _publish_result(self, result: CurationResult, diff: VisionDiff) -> None:
        bus.publish(
            "inventory_changed",
            {
                "added": [i.model_dump(mode="json") for i in result.added],
                "removed": [i.model_dump(mode="json") for i in result.removed],
                "questions": result.questions,
                "ignored": result.ignored,
                "scene_note": diff.scene_note,
            },
        )
        if result.questions:
            bus.publish("needs_confirmation", {"questions": result.questions})

    def _on_state(self, state: str, brightness: float) -> None:
        bus.publish(state, {"brightness": round(brightness, 1)})

    # --- the daily meal plan -------------------------------------------------

    def cached_plan(self) -> dict | None:
        """Today's board if it is still valid, else None.

        A plan goes stale two ways: the date rolls over, or the fridge changes under it.
        Both matter - a plan built around spinach is wrong once the spinach is eaten.
        """
        plan = self.store.get_daily_plan(date.today().isoformat())
        if plan is None:
            return None
        if plan["signature"] != self.store.inventory_signature():
            return None
        return plan

    def plan_today(self, options_per_meal: int = 2) -> dict:
        """Build breakfast, lunch and dinner around whatever is closest to spoiling.

        Blocking and slow - two model calls over the whole fridge. Callers that must stay
        responsive should use `plan_today_async`.
        """
        profile = self.store.get_profile()
        request = MealRequest(
            meals=["breakfast", "lunch", "dinner"],
            servings=int(profile.get("household_size") or 2),
            diet=[profile["diet_plan"]] if profile.get("diet_plan") else [],
            exclude=list(profile.get("allergies") or []),
            calorie_target=profile.get("daily_calorie_target"),
        )

        board = self.chef.propose(request, options_per_meal=options_per_meal, profile=profile)
        nutrition = self.nutritionist.review(board.recipes, request)

        payload = {
            "recipes": [r.model_dump(mode="json") for r in board.recipes],
            "nutrition": nutrition.model_dump(mode="json"),
        }
        # Signature is read AFTER generation, so a door cycle mid-plan invalidates it rather
        # than silently pinning a board to a fridge that has already moved on.
        self.store.put_daily_plan(
            date.today().isoformat(), self.store.inventory_signature(), payload
        )
        self.store.log_event("planned_day", payload={"recipes": len(board.recipes)})
        return {"date": date.today().isoformat(), **payload}

    def plan_today_async(self, options_per_meal: int = 2) -> bool:
        """Kick off a plan on a worker thread. Returns False if one is already running."""
        if not self._planning.acquire(blocking=False):
            return False

        def run() -> None:
            try:
                bus.publish("plan_started", {})
                plan = self.plan_today(options_per_meal)
                bus.publish("plan_ready", {"recipes": len(plan.get("recipes", []))})
            except Exception as exc:  # a failed plan must not take the process down
                logger.exception("daily plan failed")
                bus.publish("plan_failed", {"error": str(exc)})
            finally:
                self._planning.release()

        threading.Thread(target=run, daemon=True).start()
        return True

    @property
    def planning(self) -> bool:
        locked = self._planning.locked()
        return locked

    # --- camera --------------------------------------------------------------

    def start_camera(self) -> bool:
        started = self.watcher.start()
        bus.publish("camera_status", self.camera_status())
        return started

    def stop_camera(self) -> None:
        self.watcher.stop()
        bus.publish("camera_status", self.camera_status())

    def camera_status(self) -> dict:
        return {
            "running": self.watcher.running,
            "door_open": self.watcher.door_open,
            "brightness": round(self.watcher.last_brightness, 1),
            "open_threshold": self.ctx.settings.door_open_brightness,
            "error": self.watcher.error,
        }
