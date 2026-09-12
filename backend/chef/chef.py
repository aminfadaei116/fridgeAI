#!/usr/bin/env python3
"""Suggest recipes from what is in the fridge, prioritising items that are about to expire.

    cd backend && python -m chef.chef --experiment experiments/<run> [--count 3] [--model M] [--no-pantry]
    cd backend && python -m chef.chef --inventory inv.json --expire exp.json

Reads inventory.json (detection/detect.py) and expire.json (check_expire/check.py), asks a Gemini
Flash model for recipes, and writes <experiment>/recipes.json:

    {
      "generated_at": "2026-09-12T14:10:00-04:00",
      "model": "gemini-3.8-flash",
      "inventory": "experiments/<run>/inventory.json",
      "expire": "experiments/<run>/expire.json",
      "available": [
        {"item_id": 3, "object": "raw chicken", "hours_left": 20.5, "status": "expiring_soon"},
        {"item_id": 1, "object": "milk carton", "hours_left": 150.0, "status": "ok"},
        {"item_id": 4, "object": "mystery jar", "hours_left": null, "status": "unknown"}
      ],
      "excluded_expired": ["sushi"],
      "use_first": ["raw chicken"],
      "recipes": [
        {
          "name": "Creamy chicken skillet",
          "description": "One-pan ...",
          "uses_fridge_items": ["raw chicken", "milk carton"],
          "uses_expiring_items": ["raw chicken"],
          "pantry_items": ["olive oil", "salt", "garlic"],
          "servings": 2,
          "prep_time_min": 10,
          "cook_time_min": 20,
          "ingredients": [{"item": "chicken", "amount": "300 g"}],
          "steps": ["Season chicken ...", "..."]
        }
      ]
    }

available = everything in the fridge that is not expired (inventory.json is the source of truth,
expire.json supplies hours_left/status; items missing from expire.json are "unknown").
Expired items are never offered to the model. use_first = expiring-soon items, most urgent first;
every recipe must use at least one of them when any exist.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import sys
from pathlib import Path

from google import genai
from google.genai import errors as genai_errors
from google.genai import types
from pydantic import BaseModel, Field, ValidationError

BACKEND_DIR = Path(__file__).resolve().parents[1]
DEFAULT_API_KEY_FILE = BACKEND_DIR / "api_key" / "Gemini_API.txt"
DEFAULT_EXPERIMENT = BACKEND_DIR / "experiments" / "latest"
DEFAULT_MODEL = "gemini-3.8-flash"
DEFAULT_COUNT = 3

PANTRY_RULE = (
    "You may assume common pantry staples that are not in the fridge: cooking oil, butter for frying, "
    "salt, pepper, dried herbs and spices, garlic, onion, flour, sugar, rice, pasta, bread, stock cubes, "
    "vinegar, soy sauce. List every staple you rely on under pantry_items."
)
NO_PANTRY_RULE = (
    "Use ONLY the fridge items listed, plus water, salt and pepper. Do not assume any other pantry "
    "ingredient. pantry_items must be empty."
)

PROMPT = """\
You are a practical home cook. Below is what is currently in the fridge, with how many hours each
item has left before it should be thrown out.

Fridge contents (JSON):
{available_json}

Items to use up first (closest to expiring):
{use_first_json}

Propose exactly {count} different recipes for a home cook, following these rules:
- Every recipe must use at least one item from "use first" when that list is non-empty, and across
  the {count} recipes try to use every "use first" item at least once.
- Use only fridge items from the list above (refer to them by their exact "object" name in
  uses_fridge_items) — do not invent fridge items that are not listed.
- {pantry_rule}
- Recipes should be genuinely different from each other (different dish types, cooking methods or
  meals of the day).
- If an item's name is vague (e.g. "snack bar", "leftovers"), make a sensible assumption and say
  what you assumed in the description.
- Give realistic amounts, servings, prep/cook times, and clear numbered steps.
"""


# ---------------------------------------------------------------------------
# Structured response schema
# ---------------------------------------------------------------------------

class Ingredient(BaseModel):
    item: str = Field(description="Ingredient name.")
    amount: str = Field(description="Quantity with unit, e.g. '300 g', '2 cups', '1 tbsp'.")


class Recipe(BaseModel):
    name: str
    description: str = Field(description="One or two sentences: what the dish is and why it suits the fridge.")
    uses_fridge_items: list[str] = Field(description="Exact 'object' names from the fridge list used in this recipe.")
    pantry_items: list[str] = Field(description="Pantry staples assumed, not from the fridge list.")
    servings: int
    prep_time_min: int
    cook_time_min: int
    ingredients: list[Ingredient]
    steps: list[str] = Field(description="Ordered cooking steps.")


class RecipeBook(BaseModel):
    recipes: list[Recipe]


# ---------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------

def read_api_key(path: Path) -> str:
    """API key from $GEMINI_API_KEY, else the first non-empty line of `path`."""
    env = os.environ.get("GEMINI_API_KEY", "").strip()
    if env:
        return env
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as e:
        raise RuntimeError(f"cannot read API key file {path}: {e}") from e
    for line in text.splitlines():
        line = line.strip()
        if line:
            return line
    raise RuntimeError(f"API key file is empty: {path}")


def load_json(path: Path, what: str) -> dict:
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise RuntimeError(f"cannot read {what} {path}: {e}") from e
    if not isinstance(doc, dict):
        raise RuntimeError(f"{what} {path} is not a JSON object")
    return doc


def build_available(inventory: dict, expire: dict) -> tuple[list[dict], list[str]]:
    """(available items, names of expired items). inventory.in_fridge is the source of truth;
    expire.json supplies hours_left/status, matched by item_id (falling back to object name)."""
    by_id = {it["item_id"]: it for it in expire.get("items", []) if "item_id" in it}
    by_name = {it["object"]: it for it in expire.get("items", []) if "object" in it}

    available, expired = [], []
    for entry in inventory.get("in_fridge", []):
        info = by_id.get(entry.get("item_id")) or by_name.get(entry.get("object"))
        status = info["status"] if info else "unknown"
        hours_left = info.get("hours_left") if info else None
        if status == "expired":
            expired.append(entry["object"])
            continue
        available.append({
            "item_id": entry.get("item_id"),
            "object": entry["object"],
            "hours_left": hours_left,
            "status": status,
        })
    # Most urgent first; unknowns (no hours) last.
    available.sort(key=lambda a: (a["hours_left"] is None, a["hours_left"] if a["hours_left"] is not None else 0))
    return available, expired


# ---------------------------------------------------------------------------
# Gemini
# ---------------------------------------------------------------------------

def generate_recipes(client: genai.Client, model: str, available: list[dict], use_first: list[str],
                     count: int, pantry: bool) -> RecipeBook:
    prompt = PROMPT.format(
        available_json=json.dumps(available, indent=2),
        use_first_json=json.dumps(use_first),
        count=count,
        pantry_rule=PANTRY_RULE if pantry else NO_PANTRY_RULE,
    )
    response = client.models.generate_content(
        model=model,
        contents=prompt,
        config=types.GenerateContentConfig(
            temperature=0.7,
            response_mime_type="application/json",
            response_schema=RecipeBook,
            automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
        ),
    )
    usage = response.usage_metadata
    if usage:
        print(
            f"gemini: model={response.model_version or model} "
            f"tokens in={usage.prompt_token_count} out={usage.candidates_token_count} "
            f"thoughts={usage.thoughts_token_count or 0}",
            file=sys.stderr,
        )
    if not response.text:
        raise RuntimeError("Gemini returned an empty response")
    return RecipeBook.model_validate_json(response.text)


def clean_recipes(book: RecipeBook, available: list[dict], use_first: list[str], count: int,
                  pantry: bool) -> list[dict]:
    """Keep the model honest: fridge references must be real, expiring usage is derived, count is capped."""
    names = {a["object"].lower(): a["object"] for a in available}
    urgent = {u.lower() for u in use_first}
    out = []
    for r in book.recipes[:count]:
        fridge = []
        for item in r.uses_fridge_items:
            canon = names.get(item.strip().lower())
            if canon is None:
                print(f"chef: warning: recipe {r.name!r} lists {item!r} which is not in the fridge; dropped",
                      file=sys.stderr)
            elif canon not in fridge:
                fridge.append(canon)
        if not pantry and r.pantry_items:
            print(f"chef: warning: --no-pantry but recipe {r.name!r} assumes {r.pantry_items}", file=sys.stderr)
        out.append({
            "name": r.name,
            "description": r.description,
            "uses_fridge_items": fridge,
            "uses_expiring_items": [f for f in fridge if f.lower() in urgent],
            "pantry_items": r.pantry_items,
            "servings": r.servings,
            "prep_time_min": r.prep_time_min,
            "cook_time_min": r.cook_time_min,
            "ingredients": [{"item": i.item, "amount": i.amount} for i in r.ingredients],
            "steps": r.steps,
        })
    if len(out) < count:
        print(f"chef: warning: asked for {count} recipes, model returned {len(out)}", file=sys.stderr)
    return out


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="chef.py",
        description="Suggest recipes from the fridge inventory, using up items that are about to expire.",
    )
    p.add_argument("--experiment", type=Path, default=DEFAULT_EXPERIMENT,
                   help=f"experiment folder with inventory.json + expire.json (default: {DEFAULT_EXPERIMENT})")
    p.add_argument("--inventory", type=Path, default=None, help="inventory.json path (overrides --experiment)")
    p.add_argument("--expire", type=Path, default=None, help="expire.json path (overrides --experiment)")
    p.add_argument("--count", type=int, default=DEFAULT_COUNT, help=f"number of recipes (default: {DEFAULT_COUNT})")
    p.add_argument("--model", default=DEFAULT_MODEL, help=f"Gemini model name (default: {DEFAULT_MODEL})")
    p.add_argument("--no-pantry", action="store_true",
                   help="do not assume pantry staples; fridge items (plus water, salt, pepper) only")
    p.add_argument("--api-key-file", type=Path, default=DEFAULT_API_KEY_FILE,
                   help="file whose first non-empty line is the API key ($GEMINI_API_KEY overrides)")
    p.add_argument("--out", type=Path, default=None, help="output JSON path (default: <experiment>/recipes.json)")
    p.add_argument("--quiet", action="store_true", help="don't print the JSON to stdout")
    args = p.parse_args(argv)
    if args.count < 1:
        p.error("--count must be >= 1")
    return args


def label(path: Path) -> str:
    try:
        return str(path.relative_to(BACKEND_DIR))
    except ValueError:
        return str(path)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    experiment = args.experiment.expanduser().resolve()
    inventory_path = (args.inventory or experiment / "inventory.json").expanduser().resolve()
    expire_path = (args.expire or experiment / "expire.json").expanduser().resolve()
    out = (args.out or experiment / "recipes.json").expanduser().resolve()

    for path, what in ((inventory_path, "inventory"), (expire_path, "expire")):
        if not path.is_file():
            print(f"error: {what} file not found: {path}", file=sys.stderr)
            return 2

    try:
        inventory = load_json(inventory_path, "inventory")
        expire = load_json(expire_path, "expire")
        available, expired = build_available(inventory, expire)
    except (RuntimeError, KeyError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    use_first = [a["object"] for a in available if a["status"] == "expiring_soon"]
    for name in expired:
        print(f"chef: {name!r} is expired; excluded", file=sys.stderr)
    print(f"chef: {len(available)} usable item(s), {len(use_first)} to use first: {use_first}", file=sys.stderr)

    recipes: list[dict] = []
    if not available:
        print("chef: nothing usable in the fridge; writing empty recipe list", file=sys.stderr)
    else:
        try:
            client = genai.Client(api_key=read_api_key(args.api_key_file))
            book = generate_recipes(client, args.model, available, use_first, args.count, not args.no_pantry)
        except genai_errors.APIError as e:
            print(f"error: Gemini API {e.code}: {e.message}", file=sys.stderr)
            return 1
        except ValidationError as e:
            print(f"error: model returned JSON that does not match the schema:\n{e}", file=sys.stderr)
            return 1
        except RuntimeError as e:
            print(f"error: {e}", file=sys.stderr)
            return 1
        recipes = clean_recipes(book, available, use_first, args.count, not args.no_pantry)

    doc = {
        "generated_at": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "model": args.model,
        "inventory": label(inventory_path),
        "expire": label(expire_path),
        "available": available,
        "excluded_expired": expired,
        "use_first": use_first,
        "recipes": recipes,
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    if not args.quiet:
        print(json.dumps(doc, indent=2, ensure_ascii=False))
    for r in recipes:
        print(f"chef: {r['name']} — uses {r['uses_fridge_items']}"
              + (f", expiring: {r['uses_expiring_items']}" if r["uses_expiring_items"] else ""), file=sys.stderr)
    print(f"chef: {len(recipes)} recipe(s) -> {out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
