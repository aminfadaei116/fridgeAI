"""The contract every agent speaks. Structured outputs are bound to these models."""

from __future__ import annotations

from datetime import datetime
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, Field


class Category(StrEnum):
    PRODUCE = "produce"
    DAIRY = "dairy"
    MEAT = "meat"
    SEAFOOD = "seafood"
    BAKERY = "bakery"
    PANTRY = "pantry"
    LEFTOVERS = "leftovers"
    BEVERAGE = "beverage"
    CONDIMENT = "condiment"
    OTHER = "other"


class ItemStatus(StrEnum):
    PRESENT = "present"
    CONSUMED = "consumed"
    DISCARDED = "discarded"


# --- Vision -------------------------------------------------------------------


class DetectedItem(BaseModel):
    """One item the vision agent believes changed between two frames."""

    name: str = Field(description="Lowercase singular common name, e.g. 'bell pepper'")
    category: Category = Category.OTHER
    quantity: float = 1.0
    unit: str = "unit"
    confidence: float = Field(ge=0.0, le=1.0)
    note: str = ""


class VisionDiff(BaseModel):
    """The full result of comparing the before-frame with the after-frame."""

    added: list[DetectedItem] = Field(default_factory=list)
    removed: list[DetectedItem] = Field(default_factory=list)
    scene_note: str = ""


# --- Shelf life ---------------------------------------------------------------


class ShelfLifeVerdict(BaseModel):
    name: str
    shelf_life_days: int = Field(ge=0, le=3650)
    est_cost: float = Field(ge=0.0, description="Typical retail cost in CAD")
    storage_tip: str = ""


# --- Inventory ----------------------------------------------------------------


class InventoryItem(BaseModel):
    id: int
    name: str
    category: Category
    quantity: float
    unit: str
    added_at: datetime
    expires_at: datetime | None
    shelf_life_days: int | None
    status: ItemStatus
    confidence: float
    est_cost: float
    storage_tip: str = ""
    removal_count: int = 0
    frame_ref: str | None = Field(
        default=None,
        description="Camera frame captured when this item went in, served by /api/frames",
    )

    @property
    def days_left(self) -> int | None:
        if self.expires_at is None:
            return None
        return (self.expires_at.date() - datetime.now().date()).days


class PendingConfirmation(BaseModel):
    id: int
    created_at: datetime
    action: Literal["add", "remove"]
    item: DetectedItem
    question: str


# --- Cooking ------------------------------------------------------------------


class MealRequest(BaseModel):
    """A cooking request, after the concierge has turned plain speech into fields."""

    meals: list[Literal["breakfast", "lunch", "dinner", "snack"]] = Field(
        default_factory=lambda: ["breakfast", "lunch", "dinner"]
    )
    servings: int = 2
    diet: list[str] = Field(default_factory=list, description="e.g. vegetarian, halal, gluten-free")
    exclude: list[str] = Field(default_factory=list, description="allergens or dislikes")
    calorie_target: int | None = Field(default=None, description="kcal for the whole day or meal")
    max_minutes: int | None = None
    notes: str = ""


class RecipeIngredient(BaseModel):
    name: str
    amount: str
    from_fridge: bool
    expiring: bool = False


class Recipe(BaseModel):
    title: str
    meal: Literal["breakfast", "lunch", "dinner", "snack"]
    servings: int
    minutes: int
    ingredients: list[RecipeIngredient]
    steps: list[str]
    uses_expiring: list[str] = Field(default_factory=list)
    missing: list[str] = Field(default_factory=list)
    why_this: str = Field(default="", description="One line tying it to what is about to spoil")


class RecipeBoard(BaseModel):
    recipes: list[Recipe]


class NutritionEstimate(BaseModel):
    recipe_title: str
    calories_per_serving: int
    protein_g: int
    carbs_g: int
    fat_g: int
    fits_target: bool
    adjustment: str = Field(default="", description="How to hit the target if it currently misses")


class NutritionReport(BaseModel):
    estimates: list[NutritionEstimate]
    day_total_calories: int = 0
    verdict: str = ""


# --- Daily digest -------------------------------------------------------------


class DigestAlert(BaseModel):
    item_name: str
    days_left: int
    urgency: Literal["today", "soon", "watch"]
    line: str = Field(description="One sentence, evidence-led, no moralising about eating")


class DailyDigest(BaseModel):
    headline: str
    alerts: list[DigestAlert] = Field(default_factory=list)
    suggestion: str = ""


# --- Chat ---------------------------------------------------------------------


class ChatTurn(BaseModel):
    role: Literal["user", "assistant"]
    content: str
    created_at: datetime | None = None


class ChatReply(BaseModel):
    reply: str
    agents_called: list[str] = Field(default_factory=list)
    recipes: list[Recipe] = Field(default_factory=list)
    nutrition: NutritionReport | None = None
    profile_updated: bool = False


# --- Waste ledger -------------------------------------------------------------


class LedgerTotals(BaseModel):
    saved_cad: float = 0.0
    wasted_cad: float = 0.0
    items_saved: int = 0
    items_wasted: int = 0

    @property
    def save_rate(self) -> float:
        total = self.items_saved + self.items_wasted
        return self.items_saved / total if total else 0.0
