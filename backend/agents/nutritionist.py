"""The nutrition agent: a second opinion on the chef's board.

Kept separate from the chef on purpose. A single model asked to both invent a recipe and
score it will score its own work generously; a separate pass with only the recipe in front of
it will say when the number does not land.
"""

from __future__ import annotations

import logging

from backend.agents.base import Agent
from backend.llm import LLMUnavailable
from backend.schemas import MealRequest, NutritionEstimate, NutritionReport, Recipe

logger = logging.getLogger(__name__)

SYSTEM = """You estimate the nutrition of recipes you are given. You did not write them and you \
are not trying to make them look good.

For each recipe estimate calories, protein, carbohydrate and fat per serving from the actual \
ingredients and amounts listed. Be realistic about oil, dairy and portion size - those are where \
estimates usually go wrong.

If a calorie target was given, say plainly whether each recipe fits it, and when it misses give \
one concrete adjustment that would close the gap - a quantity to change, an ingredient to swap.

Report numbers and mechanics only. Do not praise, warn, or comment on the person's habits, \
weight, or discipline. The household asked for a number; give them the number."""


class NutritionAgent(Agent):
    name = "nutrition"
    role = "Estimates calories and macros for proposed meals and checks them against the target."

    def review(self, recipes: list[Recipe], request: MealRequest) -> NutritionReport:
        if not recipes:
            return NutritionReport(estimates=[], verdict="Nothing to review.")
        if not self.llm.available:
            return NutritionReport(
                estimates=[], verdict="Nutrition estimates need a model connection."
            )

        try:
            report = self.llm.structured(
                schema=NutritionReport,
                system=SYSTEM,
                user=self._prompt(recipes, request),
                model=self.settings.fast_model,
                temperature=0.2,
            )
        except LLMUnavailable as exc:
            logger.warning("nutrition review failed: %s", exc)
            return NutritionReport(estimates=[], verdict=f"Could not estimate: {exc}")

        report.day_total_calories = _day_total(report.estimates, recipes)
        return report

    def _prompt(self, recipes: list[Recipe], request: MealRequest) -> str:
        lines = []
        if request.calorie_target:
            lines.append(f"CALORIE TARGET: {request.calorie_target} kcal")
        if request.diet:
            lines.append(f"DIET: {', '.join(request.diet)}")
        lines.append(f"SERVINGS EACH RECIPE IS WRITTEN FOR: {request.servings}")
        lines.append("")

        for recipe in recipes:
            lines.append(f"RECIPE: {recipe.title} ({recipe.meal}, serves {recipe.servings})")
            for ing in recipe.ingredients:
                lines.append(f"  - {ing.amount} {ing.name}")
            lines.append("")
        return "\n".join(lines)


def _day_total(estimates: list[NutritionEstimate], recipes: list[Recipe]) -> int:
    """One serving of the first option for each distinct meal - what one person eats in a day."""
    by_title = {r.title: r.meal for r in recipes}
    seen: set[str] = set()
    total = 0
    for estimate in estimates:
        meal = by_title.get(estimate.recipe_title)
        if meal is None or meal in seen:
            continue
        seen.add(meal)
        total += estimate.calories_per_serving
    return total
