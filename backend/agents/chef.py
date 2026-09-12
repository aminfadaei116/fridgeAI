"""The chef agent: meals built around what is closest to spoiling.

The ordering of the inventory it receives is the whole trick. Items arrive sorted by days
remaining, and the prompt is told the top of that list is the point of the exercise.
"""

from __future__ import annotations

import logging

from backend.agents.base import Agent
from backend.llm import LLMUnavailable
from backend.schemas import (
    InventoryItem,
    MealRequest,
    Recipe,
    RecipeBoard,
    RecipeIngredient,
)

logger = logging.getLogger(__name__)

SYSTEM = """You are the cook for one household. You are given exactly what is in their fridge, \
sorted by how soon it spoils, and a request.

Your job is to propose meals that use up the top of that list first.

Hard rules:
- Every recipe must use at least one item from the fridge, and you should prefer the ones with
  the fewest days left. A recipe that uses nothing urgent is a wasted suggestion.
- Mark each ingredient `from_fridge: true` only if it is genuinely on the list you were given.
  Everything else is `from_fridge: false` and must also appear in `missing`.
- Assume a normal pantry: salt, pepper, oil, common dried spices, flour, sugar, rice, pasta.
  Those count as `from_fridge: false` but do NOT list them in `missing`.
- `uses_expiring` names only the fridge items with 3 or fewer days left that the recipe uses.
- `why_this` is one plain sentence connecting the recipe to what is about to spoil. State the
  evidence - the item and its days left. Do not comment on the person's eating habits, weight,
  or discipline. You are solving a spoilage problem, not judging anyone.
- Respect every dietary constraint absolutely. An excluded ingredient or allergen must not
  appear anywhere in the recipe, including as a garnish or a substitution note.
- Scale quantities to the requested number of servings.
- Give real, cookable steps. Five to eight steps, each an actual instruction.

Give the requested number of options per meal. Make them genuinely different from each other -
different techniques, not the same dish twice."""


class ChefAgent(Agent):
    name = "chef"
    role = "Proposes meals that use up whatever is closest to spoiling."

    def propose(
        self,
        request: MealRequest,
        *,
        options_per_meal: int = 2,
        profile: dict | None = None,
    ) -> RecipeBoard:
        inventory = self.store.list_inventory()
        if not inventory:
            return RecipeBoard(recipes=[])

        if not self.llm.available:
            return self._fallback(request, inventory)

        try:
            return self.llm.structured(
                schema=RecipeBoard,
                system=SYSTEM,
                user=self._prompt(request, inventory, options_per_meal, profile or {}),
                model=self.settings.reasoning_model,
                temperature=0.7,
            )
        except LLMUnavailable as exc:
            logger.warning("chef unavailable: %s", exc)
            return self._fallback(request, inventory)

    # --- prompt construction -------------------------------------------------

    def _prompt(
        self,
        request: MealRequest,
        inventory: list[InventoryItem],
        options_per_meal: int,
        profile: dict,
    ) -> str:
        lines = ["IN THE FRIDGE (soonest to spoil first):"]
        for item in inventory:
            days = item.days_left
            urgency = (
                "USE TODAY"
                if days is not None and days <= 1
                else f"{days}d left"
                if days is not None
                else "no date"
            )
            lines.append(
                f"- {item.name} ({item.quantity:g} {item.unit}, {item.category.value}) - {urgency}"
            )

        lines.append("")
        lines.append("REQUEST:")
        lines.append(f"- meals: {', '.join(request.meals)}")
        lines.append(f"- options per meal: {options_per_meal}")
        lines.append(f"- servings: {request.servings}")
        if request.diet:
            lines.append(f"- diet, non-negotiable: {', '.join(request.diet)}")
        if request.exclude:
            lines.append(f"- must not contain: {', '.join(request.exclude)}")
        if request.calorie_target:
            lines.append(f"- calorie target: {request.calorie_target} kcal")
        if request.max_minutes:
            lines.append(f"- time limit: {request.max_minutes} minutes per meal")
        if request.notes:
            lines.append(f"- note from the household: {request.notes}")

        standing = {k: v for k, v in profile.items() if k in {"diet_plan", "allergies", "dislikes"}}
        if standing:
            lines.append("")
            lines.append("STANDING HOUSEHOLD PROFILE (applies unless today's request overrides):")
            for key, value in standing.items():
                lines.append(f"- {key}: {value}")

        return "\n".join(lines)

    # --- offline fallback ----------------------------------------------------

    def _fallback(self, request: MealRequest, inventory: list[InventoryItem]) -> RecipeBoard:
        """No model reachable: still name the urgent items so the board is never blank."""
        urgent = [i for i in inventory if i.days_left is not None and i.days_left <= 3][:4]
        if not urgent:
            urgent = inventory[:3]
        names = [i.name for i in urgent]

        recipes = [
            Recipe(
                title=f"Use-it-up skillet with {names[0]}" if names else "Use-it-up skillet",
                meal=meal,
                servings=request.servings,
                minutes=25,
                ingredients=[
                    RecipeIngredient(
                        name=n,
                        amount="as available",
                        from_fridge=True,
                        expiring=True,
                    )
                    for n in names
                ],
                steps=[
                    "Heat oil in a wide pan over medium-high.",
                    f"Add the firmest of {', '.join(names)} first and cook until coloured.",
                    "Add the softer items and cook two minutes more.",
                    "Season with salt, pepper and whatever dried spice you reach for.",
                    "Serve over rice or with bread.",
                ],
                uses_expiring=names,
                why_this=(
                    f"Offline fallback: {', '.join(names)} are the closest to their date."
                    if names
                    else "Offline fallback."
                ),
            )
            for meal in request.meals
        ]
        return RecipeBoard(recipes=recipes)
