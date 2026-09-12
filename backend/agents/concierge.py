"""The concierge agent: the only one the human talks to.

It owns no domain logic. It turns a sentence - typed or spoken - into calls on the other six
agents, then says what happened in one voice. Adding a capability to this system means adding
a tool here, not rewriting the conversation.
"""

from __future__ import annotations

import logging
from typing import Any

from backend.agents.base import Agent, AgentContext
from backend.agents.chef import ChefAgent
from backend.agents.nutritionist import NutritionAgent
from backend.agents.sentinel import SentinelAgent
from backend.llm import LLMUnavailable
from backend.schemas import ChatReply, MealRequest, NutritionReport, Recipe

logger = logging.getLogger(__name__)

SYSTEM = """You are the fridge. You know exactly what is inside it and when each thing goes off.

You speak for a team of specialists and you call them through your tools:
- `read_inventory` - what is on hand right now, with days remaining
- `check_expiring` - what is closest to its date
- `plan_meals` - the chef proposes meals, the nutritionist then scores them
- `save_profile` - remember a standing diet, allergy or household size
- `waste_report` - money used in time versus money thrown out

How to work:
- Call a tool before answering anything about the fridge. Never guess at contents or dates.
- When someone mentions guests, a diet, a calorie number or a craving, that is a `plan_meals`
  call with those fields filled in - do not ask them to repeat it as a form.
- When someone states a standing fact ("I am vegetarian", "my partner is allergic to shellfish",
  "we are two people"), call `save_profile` so it holds from now on, then carry on.
- A request can be both: save the standing fact AND plan the meal in the same turn.

How to speak:
- Short. Two or three sentences, then the substance. This is read on a screen and heard aloud,
  so no lists of headings, no markdown, no emoji.
- Lead with the evidence you actually have: the item, the days left, the dollar figure.
- You may be dry and a little pointed about food going to waste - that is the job. You are never
  pointed about the person. No remarks about their weight, their discipline, or whether they
  should be eating something. If they give you a calorie number, it is an input, not an opening.
- If a tool comes back empty, say so plainly rather than inventing something."""

TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "function": {
            "name": "read_inventory",
            "description": "Everything currently in the fridge with days remaining.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "check_expiring",
            "description": "Items closest to spoiling, soonest first.",
            "parameters": {
                "type": "object",
                "properties": {
                    "days": {
                        "type": "integer",
                        "description": "Look this many days ahead. Default 3.",
                    }
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "plan_meals",
            "description": (
                "Ask the chef for meal options anchored on what is about to spoil, then have "
                "the nutritionist score them. Use this for any cooking, guest, diet or calorie "
                "request."
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "meals": {
                        "type": "array",
                        "items": {
                            "type": "string",
                            "enum": ["breakfast", "lunch", "dinner", "snack"],
                        },
                        "description": "Which meals to plan. Default all three.",
                    },
                    "servings": {"type": "integer", "description": "People eating. Default 2."},
                    "diet": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "e.g. vegetarian, vegan, halal, keto, gluten-free",
                    },
                    "exclude": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "Allergens or dislikes that must not appear.",
                    },
                    "calorie_target": {"type": "integer", "description": "kcal target if given."},
                    "max_minutes": {"type": "integer", "description": "Time limit per meal."},
                    "options_per_meal": {"type": "integer", "description": "Default 2."},
                    "notes": {"type": "string", "description": "Anything else they asked for."},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "save_profile",
            "description": "Store a standing household fact so it applies to every future plan.",
            "parameters": {
                "type": "object",
                "properties": {
                    "diet_plan": {"type": "string", "description": "Their standing diet."},
                    "allergies": {"type": "array", "items": {"type": "string"}},
                    "dislikes": {"type": "array", "items": {"type": "string"}},
                    "household_size": {"type": "integer"},
                    "daily_calorie_target": {"type": "integer"},
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "waste_report",
            "description": "Money used in time versus money thrown out, over the last week.",
            "parameters": {"type": "object", "properties": {}, "required": []},
        },
    },
]


class ConciergeAgent(Agent):
    name = "concierge"
    role = "Talks to the household and routes the work to the other agents."

    def __init__(self, ctx: AgentContext) -> None:
        super().__init__(ctx)
        self.chef = ChefAgent(ctx)
        self.nutritionist = NutritionAgent(ctx)
        self.sentinel = SentinelAgent(ctx)

    def chat(self, user_text: str) -> ChatReply:
        """One conversational turn. Persists both sides so context survives a reload."""
        self.store.add_message("user", user_text)

        # Per-turn scratch space: tools write their structured output here so the API can
        # hand the UI real recipe cards instead of re-parsing prose.
        self._recipes: list[Recipe] = []
        self._nutrition: NutritionReport | None = None
        self._profile_updated = False

        if not self.llm.available:
            reply = self._offline_reply(user_text)
            self.store.add_message("assistant", reply.reply)
            return reply

        history = [
            {"role": m["role"], "content": m["content"]}
            for m in self.store.recent_messages(limit=10)
        ]
        try:
            text, called = self.llm.tool_loop(
                system=self._system_with_profile(),
                messages=history,
                tools=TOOLS,
                dispatch={
                    "read_inventory": self._tool_read_inventory,
                    "check_expiring": self._tool_check_expiring,
                    "plan_meals": self._tool_plan_meals,
                    "save_profile": self._tool_save_profile,
                    "waste_report": self._tool_waste_report,
                },
                model=self.settings.reasoning_model,
            )
        except LLMUnavailable as exc:
            logger.warning("concierge turn failed: %s", exc)
            reply = self._offline_reply(user_text)
            self.store.add_message("assistant", reply.reply)
            return reply

        self.store.add_message("assistant", text)
        return ChatReply(
            reply=text,
            agents_called=called,
            recipes=self._recipes,
            nutrition=self._nutrition,
            profile_updated=self._profile_updated,
        )

    def _system_with_profile(self) -> str:
        profile = self.store.get_profile()
        if not profile:
            return SYSTEM
        known = "\n".join(f"- {k}: {v}" for k, v in profile.items())
        return f"{SYSTEM}\n\nWHAT YOU ALREADY KNOW ABOUT THIS HOUSEHOLD:\n{known}"

    # --- tools ---------------------------------------------------------------

    def _tool_read_inventory(self) -> dict:
        items = self.store.list_inventory()
        return {
            "count": len(items),
            "items": [
                {
                    "name": i.name,
                    "quantity": f"{i.quantity:g} {i.unit}",
                    "category": i.category.value,
                    "days_left": i.days_left,
                    "times_handled": i.removal_count,
                }
                for i in items
            ],
        }

    def _tool_check_expiring(self, days: int = 3) -> dict:
        items = self.store.expiring_within(days)
        return {
            "window_days": days,
            "items": [
                {"name": i.name, "days_left": i.days_left, "est_cost": i.est_cost} for i in items
            ],
        }

    def _tool_plan_meals(
        self,
        meals: list[str] | None = None,
        servings: int = 2,
        diet: list[str] | None = None,
        exclude: list[str] | None = None,
        calorie_target: int | None = None,
        max_minutes: int | None = None,
        options_per_meal: int = 2,
        notes: str = "",
    ) -> dict:
        profile = self.store.get_profile()
        request = MealRequest(
            meals=meals or ["breakfast", "lunch", "dinner"],
            servings=servings or int(profile.get("household_size") or 2),
            diet=diet or ([profile["diet_plan"]] if profile.get("diet_plan") else []),
            exclude=exclude or list(profile.get("allergies") or []),
            calorie_target=calorie_target or profile.get("daily_calorie_target"),
            max_minutes=max_minutes,
            notes=notes,
        )

        board = self.chef.propose(request, options_per_meal=options_per_meal, profile=profile)
        self._recipes = board.recipes
        if not board.recipes:
            return {"recipes": [], "note": "The fridge is empty - nothing to build a meal from."}

        report = self.nutritionist.review(board.recipes, request)
        self._nutrition = report

        return {
            "recipes": [
                {
                    "title": r.title,
                    "meal": r.meal,
                    "minutes": r.minutes,
                    "uses_expiring": r.uses_expiring,
                    "missing": r.missing,
                    "why_this": r.why_this,
                }
                for r in board.recipes
            ],
            "nutrition": [e.model_dump() for e in report.estimates],
            "day_total_calories": report.day_total_calories,
        }

    def _tool_save_profile(self, **fields: Any) -> dict:
        stored = {k: v for k, v in fields.items() if v not in (None, "", [], {})}
        for key, value in stored.items():
            self.store.set_profile(key, value)
        self._profile_updated = bool(stored)
        return {"saved": stored} if stored else {"saved": {}, "note": "nothing to save"}

    def _tool_waste_report(self) -> dict:
        totals = self.store.ledger_totals()
        return {
            "window": "last 7 days",
            "saved_cad": totals.saved_cad,
            "wasted_cad": totals.wasted_cad,
            "items_saved": totals.items_saved,
            "items_wasted": totals.items_wasted,
            "recent": self.store.ledger_entries(limit=8),
        }

    # --- offline path --------------------------------------------------------

    def _offline_reply(self, user_text: str) -> ChatReply:
        """Keyword routing so the dashboard still does something without a key."""
        lowered = user_text.lower()
        cooking_words = ("cook", "recipe", "dinner", "lunch", "breakfast", "meal", "eat", "guest")

        if any(word in lowered for word in cooking_words):
            request = MealRequest(meals=["dinner"], servings=2)
            board = self.chef.propose(request)
            self._recipes = board.recipes
            titles = ", ".join(r.title for r in board.recipes) or "nothing"
            return ChatReply(
                reply=f"Running without a model key, so this is the offline board: {titles}.",
                agents_called=["chef"],
                recipes=board.recipes,
            )

        if any(word in lowered for word in ("expire", "spoil", "going off", "bad")):
            digest = self.sentinel.digest()
            return ChatReply(reply=digest.headline, agents_called=["sentinel"])

        items = self.store.list_inventory()
        return ChatReply(
            reply=(
                f"No model key is set, so I am limited to what the database knows: "
                f"{len(items)} items on hand."
            ),
            agents_called=[],
        )
