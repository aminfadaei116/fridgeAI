"""The vision agent: one call per door cycle, one clip, one answer.

The whole door cycle goes to the model as video. It reports *crossings* - a named item passing
through the door plane, in or out, at a time - and netting those crossings gives the change to
the fridge. That is a different question from "what do these two photographs disagree about",
and a better one: direction is watched rather than deduced, an item put in and taken straight
back out cancels itself, and something hidden behind the juice carton is still seen crossing.

Providers that cannot take video (and offline mode) fall back to the two-frame comparison,
using stills pulled from the same clip. Everything downstream sees a VisionDiff either way.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field

from backend.agents.base import Agent
from backend.capture import clip_duration, extract_still
from backend.llm import LLMUnavailable, image_part, text_part
from backend.schemas import Category, DetectedItem, VisionDiff

logger = logging.getLogger(__name__)

# Where in the clip to take the two fallback stills from, as a fraction of its length. Not the
# very first or last frame: the door is still swinging at both ends.
FALLBACK_BEFORE_FRACTION = 0.1
FALLBACK_AFTER_FRACTION = 0.9

CLIP_SYSTEM = """You are watching a video recorded by a camera inside a refrigerator. The clip \
starts as the door opens and ends as it closes.

List every event where an item crosses the plane of the fridge opening - going IN (it ends up \
inside the fridge) or OUT (it ends up outside).

For each crossing report:
- item_id: an integer identifying the physical item. Number distinct items 1, 2, 3, ... in
  order of first appearance. If the same physical item crosses more than once (put in, then
  taken back out), reuse its id. Two similar but separate items get different ids.
- name: what a shopper would call it - "bell pepper", "greek yogurt", "chicken breast".
  Lowercase, singular, no brand names unless the brand is the only way to identify it. Use the
  same name for every crossing that shares an item_id.
- category, quantity, unit: how the item would be written on a shopping list.
- action: "in" or "out".
- time_s: seconds from the start of the clip at which it crosses the opening. Use decimals.
- confidence: your honest probability that this crossing happened as described. A clear,
  well-lit, unobstructed item is 0.9+. A partly hidden or ambiguous one is 0.4-0.7. If you are
  guessing from a silhouette it is below 0.4, and say so in `note`.

Rules:
- Only count items that actually cross into or out of the fridge interior. Something merely
  held, touched, or moved around inside is not a crossing.
- One event per item per crossing. In and then back out is two events.
- The door, shelves, drawers and the person's hands or arms are never items.
- If several items are moved at once, report each separately.
- Order events chronologically.
- An empty list is a correct and common answer. Never invent a crossing to seem useful.
"""

CLIP_PROMPT = (
    "What crossed the door plane? Remember: a hand reaching past something is not a crossing, "
    "and an empty answer is better than a guess."
)

FRAME_SYSTEM = """You compare two photographs taken inside the same fridge, seconds apart, from a \
fixed camera. FRAME A is the moment the door opened. FRAME B is the moment before it closed.

Report only what genuinely changed between them.

Rules:
- `added`: items visible in B but not in A.
- `removed`: items visible in A but not in B.
- An item that merely moved, rotated, or became partly hidden is NOT a change. Say nothing.
- Lighting, shadow, door angle and a hand passing through are never changes.
- Name items as a shopper would: "bell pepper", "greek yogurt", "chicken breast". Lowercase,
  singular, no brand names unless the brand is the only way to identify it.
- Confidence is your honest probability that this specific change really happened. A clear,
  well-lit, unobstructed item is 0.9+. A partly hidden or ambiguous one is 0.4-0.7. If you are
  guessing from a silhouette, it is below 0.4 and you should say so in `note`.
- Returning an empty list for both is a correct and common answer. Never invent a change to
  seem useful.
"""


class Crossing(BaseModel):
    """One item passing through the fridge door plane, as the model reports it."""

    item_id: int
    name: str
    category: Category = Category.OTHER
    quantity: float = 1.0
    unit: str = "unit"
    action: Literal["in", "out"]
    time_s: float = 0.0
    # Deliberately unbounded: models occasionally answer 1.2, and a clamp downstream is
    # better than a validation error that costs us the whole door cycle.
    confidence: float = 0.0
    note: str = ""

    def as_detected(self) -> DetectedItem:
        return DetectedItem(
            name=self.name.strip().lower(),
            category=self.category,
            quantity=self.quantity,
            unit=self.unit,
            confidence=min(max(self.confidence, 0.0), 1.0),
            note=self.note,
        )


class ClipReport(BaseModel):
    """The model's raw answer for one clip. Bound to the request as the response schema."""

    crossings: list[Crossing] = Field(default_factory=list)
    scene_note: str = ""


@dataclass
class ClipReading:
    """What the vision agent made of one door cycle.

    `diff` is the only part the rest of the system consumes. `crossings` comes along so the
    pipeline can grab the evidence still at the moment something actually crossed.
    """

    diff: VisionDiff
    crossings: list[Crossing] = field(default_factory=list)


def reduce_crossings(crossings: list[Crossing], scene_note: str = "") -> VisionDiff:
    """Net a list of crossings into what actually changed about the fridge.

    Replaying per item_id is what makes in-and-straight-back-out cancel: an item is added only
    if it was not already inside and ended up in, and removed only if it was already inside and
    ended up out. Everything else nets to zero and is correctly reported as no change.
    """
    ordered = sorted(crossings, key=lambda c: c.time_s)
    first: dict[int, Crossing] = {}
    last: dict[int, Crossing] = {}
    for crossing in ordered:
        first.setdefault(crossing.item_id, crossing)
        last[crossing.item_id] = crossing

    added: list[DetectedItem] = []
    removed: list[DetectedItem] = []
    for item_id, final in last.items():
        was_inside_before = first[item_id].action == "out"
        if final.action == "in" and not was_inside_before:
            added.append(final.as_detected())
        elif final.action == "out" and was_inside_before:
            removed.append(final.as_detected())

    return VisionDiff(added=added, removed=removed, scene_note=scene_note)


def evidence_time(crossings: list[Crossing]) -> float | None:
    """When to freeze the clip for the photo shown beside an item.

    The first arrival, because that is the picture worth keeping. Failing that the first
    crossing of any kind, so a cycle that only took things out still gets a thumbnail.
    """
    if not crossings:
        return None
    arrivals = [c.time_s for c in crossings if c.action == "in"]
    return min(arrivals) if arrivals else min(c.time_s for c in crossings)


class VisionAgent(Agent):
    name = "vision"
    role = "Watches the door-cycle clip and reports what crossed into or out of the fridge."

    def watch(self, clip: Path) -> ClipReading:
        """Read one door-cycle clip. Returns an empty reading if no model is reachable."""
        if not self.llm.available:
            logger.info("vision agent offline; returning empty diff")
            return ClipReading(diff=VisionDiff(scene_note="offline - no model available"))

        if self.settings.supports_video_input:
            reading = self._watch_clip(clip)
            if reading is not None:
                return reading
            logger.info("falling back to a frame pair for %s", clip.name)

        return ClipReading(diff=self._compare_stills(clip))

    def diff(self, frame_before: Path, frame_after: Path) -> VisionDiff:
        """Compare a frame pair. The fallback path, and the whole of it for OpenAI."""
        if not self.llm.available:
            logger.info("vision agent offline; returning empty diff")
            return VisionDiff(scene_note="offline - no model available")

        content = [
            text_part("FRAME A (door just opened):"),
            image_part(frame_before),
            text_part("FRAME B (door about to close):"),
            image_part(frame_after),
            text_part(
                "What changed? Remember: movement is not a change, and an empty answer is "
                "better than a guess."
            ),
        ]
        try:
            return self.llm.structured(
                schema=VisionDiff,
                system=FRAME_SYSTEM,
                user=content,
                model=self.settings.vision_model,
                temperature=0.1,
            )
        except LLMUnavailable as exc:
            logger.warning("vision diff failed: %s", exc)
            return VisionDiff(scene_note=f"vision unavailable: {exc}")

    # --- the two paths -------------------------------------------------------

    def _watch_clip(self, clip: Path) -> ClipReading | None:
        """Send the clip to the model. None means the caller should try the frame pair."""
        try:
            report = self.llm.structured_video(
                schema=ClipReport,
                system=CLIP_SYSTEM,
                prompt=CLIP_PROMPT,
                video=clip,
                model=self.settings.vision_model,
                fps=self.settings.clip_sample_fps,
            )
        except LLMUnavailable as exc:
            logger.warning("clip reading failed: %s", exc)
            return None

        logger.info("vision read %s crossing(s) from %s", len(report.crossings), clip.name)
        return ClipReading(
            diff=reduce_crossings(report.crossings, report.scene_note),
            crossings=report.crossings,
        )

    def _compare_stills(self, clip: Path) -> VisionDiff:
        """Pull the old before/after pair out of the clip and ask the old question."""
        duration = clip_duration(clip)
        before = extract_still(clip, duration * FALLBACK_BEFORE_FRACTION, self.settings)
        after = extract_still(clip, duration * FALLBACK_AFTER_FRACTION, self.settings)
        if before is None or after is None:
            logger.warning("could not read frames out of %s", clip)
            return VisionDiff(scene_note="vision unavailable: the clip could not be read")
        return self.diff(before, after)
