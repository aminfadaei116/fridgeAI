"""The vision agent: one call per door cycle, two frames, one answer.

We deliberately do not track hands or objects through video. Two still frames - one from
just after the door opened, one from just before it closed - carry everything we need, and
the in-versus-out direction falls straight out of the comparison.
"""

from __future__ import annotations

import logging
from pathlib import Path

from backend.agents.base import Agent
from backend.llm import LLMUnavailable, image_part, text_part
from backend.schemas import VisionDiff

logger = logging.getLogger(__name__)

SYSTEM = """You compare two photographs taken inside the same fridge, seconds apart, from a \
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


class VisionAgent(Agent):
    name = "vision"
    role = "Reads the before/after frame pair and reports what entered or left the fridge."

    def diff(self, frame_before: Path, frame_after: Path) -> VisionDiff:
        """Compare a frame pair. Returns an empty diff if no model is reachable."""
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
                system=SYSTEM,
                user=content,
                model=self.settings.vision_model,
                temperature=0.1,
            )
        except LLMUnavailable as exc:
            logger.warning("vision diff failed: %s", exc)
            return VisionDiff(scene_note=f"vision unavailable: {exc}")
