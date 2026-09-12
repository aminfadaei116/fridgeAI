"""The agent roster.

Seven specialists, each with one job:

- `VisionAgent`      reads a before/after frame pair and says what changed.
- `CuratorAgent`     decides whether a detection is trustworthy enough to commit.
- `ShelfLifeAgent`   resolves how long a food keeps and what it cost.
- `ChefAgent`        proposes meals anchored on what is about to spoil.
- `NutritionAgent`   scores those meals against the household's targets.
- `SentinelAgent`    writes the daily spoilage digest.
- `ConciergeAgent`   talks to the human and routes work to the other six.
"""

from backend.agents.base import Agent, AgentContext
from backend.agents.chef import ChefAgent
from backend.agents.concierge import ConciergeAgent
from backend.agents.curator import CuratorAgent
from backend.agents.nutritionist import NutritionAgent
from backend.agents.sentinel import SentinelAgent
from backend.agents.shelf_life import ShelfLifeAgent
from backend.agents.vision import VisionAgent

__all__ = [
    "Agent",
    "AgentContext",
    "ChefAgent",
    "ConciergeAgent",
    "CuratorAgent",
    "NutritionAgent",
    "SentinelAgent",
    "ShelfLifeAgent",
    "VisionAgent",
]
