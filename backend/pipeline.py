"""The spine: one door cycle in, one committed inventory change out.

Everything the camera triggers flows through `process_cycle`. The web API calls the same
function for simulated cycles, so the demo path and the real path are the same code.
"""

from __future__ import annotations

import logging
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
from backend.capture import DoorWatcher
from backend.events import bus
from backend.schemas import VisionDiff

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

        self.shelf_life.seed()

    @property
    def store(self):
        return self.ctx.store

    # --- the door cycle ------------------------------------------------------

    def process_cycle(self, frame_before: Path, frame_after: Path) -> CurationResult:
        """Two frames to a committed inventory change. Called from the camera thread."""
        bus.publish(
            "analyzing",
            {"frame_before": frame_before.name, "frame_after": frame_after.name},
        )

        diff = self.vision.diff(frame_before, frame_after)
        self.store.log_event(
            "vision_diff",
            frame_before=frame_before.name,
            frame_after=frame_after.name,
            payload=diff.model_dump(mode="json"),
        )

        result = self.curator.reconcile(diff, frame_ref=frame_after.name)
        self._publish_result(result, diff)
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
