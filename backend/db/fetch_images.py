#!/usr/bin/env python3
"""Download a small icon for every item in db/expire.json into db/images/.

    cd backend && python -m db.fetch_images   # fetch missing icons
    python -m db.fetch_images --force    # re-download everything
    python -m db.fetch_images --check    # only report keys with no icon mapping (no network)

Icons come from Microsoft's Fluent Emoji set (MIT licence), 3D style, 256x256 RGBA PNG:
https://github.com/microsoft/fluentui-emoji. The download is pinned to one commit so the
result is reproducible.

Output:
    db/images/<slug>.png     one file per expire.json key, slug = key with spaces -> "_"
                             ("chocolate milk" -> chocolate_milk.png)
    db/images/index.json     key -> {"file", "emoji"} plus source/licence info
    db/images/LICENSE.txt    the Fluent Emoji MIT licence (ships with the icons)

Every key must appear in ICON below, otherwise the script exits with the list of missing
keys. Add a line there whenever a key is added to expire.json. Emoji names are the folder
names in the Fluent repo's assets/ directory (CLDR short names, e.g. "Glass of milk").
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
DEFAULT_DATABASE = BACKEND_DIR / "db" / "expire.json"
DEFAULT_OUT_DIR = BACKEND_DIR / "db" / "images"

FLUENT_REPO = "microsoft/fluentui-emoji"
FLUENT_COMMIT = "1ffb34c752ecf5d402f04cfb4b392c77f57c54bc"  # main @ 2026-08-24
FLUENT_LICENSE = "MIT"
RAW_BASE = f"https://raw.githubusercontent.com/{FLUENT_REPO}/{FLUENT_COMMIT}"
WORKERS = 8

# expire.json key -> Fluent Emoji asset folder name. Many keys share one icon on purpose
# (every cheese is "Cheese wedge"); a few are nearest-fit where no emoji exists (plum ->
# Peach, beets -> Roasted sweet potato, tofu -> Oden).
ICON: dict[str, str] = {
    # dairy & eggs
    "milk": "Glass of milk",
    "chocolate milk": "Glass of milk",
    "almond milk": "Glass of milk",
    "soy milk": "Glass of milk",
    "oat milk": "Glass of milk",
    "cream": "Pouring liquid",
    "half and half": "Pouring liquid",
    "sour cream": "Bowl with spoon",
    "yogurt": "Bowl with spoon",
    "greek yogurt": "Bowl with spoon",
    "cottage cheese": "Cheese wedge",
    "cream cheese": "Cheese wedge",
    "ricotta cheese": "Cheese wedge",
    "mozzarella": "Cheese wedge",
    "cheddar cheese": "Cheese wedge",
    "parmesan cheese": "Cheese wedge",
    "feta cheese": "Cheese wedge",
    "brie": "Cheese wedge",
    "butter": "Butter",
    "margarine": "Butter",
    "eggs": "Egg",
    "hard boiled eggs": "Egg",
    # meat & fish
    "raw chicken": "Poultry leg",
    "cooked chicken": "Poultry leg",
    "chicken breast": "Poultry leg",
    "ground chicken": "Poultry leg",
    "raw turkey": "Poultry leg",
    "cooked turkey": "Poultry leg",
    "ground turkey": "Poultry leg",
    "raw beef": "Cut of meat",
    "ground beef": "Cut of meat",
    "cooked beef": "Cut of meat",
    "steak": "Cut of meat",
    "roast beef": "Cut of meat",
    "ham": "Meat on bone",
    "deli ham": "Meat on bone",
    "deli turkey": "Poultry leg",
    "salami": "Bacon",
    "bacon": "Bacon",
    "sausage": "Hot dog",
    "hot dogs": "Hot dog",
    "raw pork": "Cut of meat",
    "ground pork": "Cut of meat",
    "cooked pork": "Meat on bone",
    "raw fish": "Fish",
    "cooked fish": "Fish",
    "salmon": "Fish",
    "tuna": "Fish",
    "shrimp": "Shrimp",
    "cooked shrimp": "Fried shrimp",
    "smoked salmon": "Fish",
    "canned tuna": "Canned food",
    # fruit
    "apple": "Red apple",
    "banana": "Banana",
    "orange": "Tangerine",
    "lemon": "Lemon",
    "lime": "Lime",
    "grapefruit": "Tangerine",
    "pear": "Pear",
    "peach": "Peach",
    "nectarine": "Peach",
    "plum": "Peach",
    "mango": "Mango",
    "pineapple": "Pineapple",
    "kiwi": "Kiwi fruit",
    "grapes": "Grapes",
    "strawberries": "Strawberry",
    "blueberries": "Blueberries",
    "raspberries": "Strawberry",
    "blackberries": "Blueberries",
    "cherries": "Cherries",
    "watermelon": "Watermelon",
    "cantaloupe": "Melon",
    "honeydew": "Melon",
    "avocado": "Avocado",
    "cut fruit": "Watermelon",
    "fruit salad": "Bowl with spoon",
    # vegetables
    "lettuce": "Leafy green",
    "romaine lettuce": "Leafy green",
    "spinach": "Leafy green",
    "kale": "Leafy green",
    "arugula": "Leafy green",
    "cabbage": "Leafy green",
    "broccoli": "Broccoli",
    "cauliflower": "Broccoli",
    "carrots": "Carrot",
    "celery": "Leafy green",
    "cucumber": "Cucumber",
    "zucchini": "Cucumber",
    "bell pepper": "Bell pepper",
    "mushrooms": "Brown mushroom",
    "asparagus": "Herb",
    "green beans": "Pea pod",
    "snap peas": "Pea pod",
    "brussels sprouts": "Broccoli",
    "corn": "Ear of corn",
    "eggplant": "Eggplant",
    "beets": "Roasted sweet potato",
    "radishes": "Carrot",
    "fresh herbs": "Herb",
    "onion": "Onion",
    "garlic": "Garlic",
    "potato": "Potato",
    "sweet potato": "Roasted sweet potato",
    "tomato": "Tomato",
    "cherry tomatoes": "Tomato",
    "cut vegetables": "Carrot",
    # bread, staples, condiments
    "bread": "Bread",
    "bagels": "Bagel",
    "tortillas": "Flatbread",
    "english muffins": "Bagel",
    "pita bread": "Flatbread",
    "pizza dough": "Flatbread",
    "fresh pasta": "Spaghetti",
    "cooked pasta": "Spaghetti",
    "cooked rice": "Cooked rice",
    "cooked quinoa": "Cooked rice",
    "cooked beans": "Beans",
    "tofu": "Oden",
    "tempeh": "Beans",
    "hummus": "Bowl with spoon",
    "guacamole": "Avocado",
    "salsa": "Hot pepper",
    "pesto": "Herb",
    "tomato sauce": "Tomato",
    "mayonnaise": "Jar",
    "ketchup": "Tomato",
    "mustard": "Jar",
    "soy sauce": "Jar",
    "salad dressing": "Jar",
    "jam": "Honey pot",
    "peanut butter": "Peanuts",
    # prepared food
    "leftovers": "Takeout box",
    "soup": "Pot of food",
    "stew": "Pot of food",
    "chili": "Pot of food",
    "curry": "Curry rice",
    "casserole": "Shallow pan of food",
    "pizza": "Pizza",
    "sandwich": "Sandwich",
    "burger": "Hamburger",
    "fried chicken": "Poultry leg",
    "rotisserie chicken": "Poultry leg",
    "takeout": "Takeout box",
    "prepared salad": "Green salad",
    "pasta salad": "Green salad",
    "potato salad": "Potato",
    "egg salad": "Egg",
    "tuna salad": "Fish",
    "coleslaw": "Leafy green",
    "macaroni and cheese": "Spaghetti",
    "lasagna": "Shallow pan of food",
    "burrito": "Burrito",
    "taco filling": "Taco",
    # drinks
    "orange juice": "Beverage box",
    "apple juice": "Beverage box",
    "lemonade": "Cup with straw",
    "smoothie": "Cup with straw",
    "coffee": "Hot beverage",
    "iced tea": "Cup with straw",
    "beer": "Beer mug",
    "wine": "Wine glass",
    "sparkling water": "Droplet",
    # aliases & generic names
    "cheese": "Cheese wedge",
    "meat": "Cut of meat",
    "chicken": "Poultry leg",
    "beef": "Cut of meat",
    "pork": "Cut of meat",
    "fish": "Fish",
    "seafood": "Shrimp",
    "deli meat": "Bacon",
    "lunch meat": "Bacon",
    "vegetables": "Broccoli",
    "fruit": "Red apple",
    "berries": "Blueberries",
    "salad": "Green salad",
    "leafy greens": "Leafy green",
    "salad greens": "Leafy green",
    "herbs": "Herb",
    "sauce": "Jar",
    "dip": "Bowl with spoon",
    "dressing": "Jar",
    "condiment": "Jar",
    "juice": "Beverage box",
    "soda": "Cup with straw",
    "cola": "Cup with straw",
    "soft drink": "Cup with straw",
    "energy drink": "Cup with straw",
    "water": "Droplet",
    "bottled water": "Droplet",
    "sports drink": "Cup with straw",
    "drink": "Cup with straw",
    "beverage": "Cup with straw",
    "yoghurt": "Bowl with spoon",
    "mayo": "Jar",
    "string cheese": "Cheese wedge",
    "cheese stick": "Cheese wedge",
    "mozzarella stick": "Cheese wedge",
    "sliced cheese": "Cheese wedge",
    "shredded cheese": "Cheese wedge",
    "cheese slices": "Cheese wedge",
    "hotdog": "Hot dog",
    "frankfurter": "Hot dog",
    "wiener": "Hot dog",
    "cold cuts": "Bacon",
    "scallion": "Herb",
    "green onion": "Herb",
    "chili pepper": "Hot pepper",
    "jalapeno": "Hot pepper",
    "capsicum": "Bell pepper",
    "cilantro": "Herb",
    "parsley": "Herb",
    "basil": "Herb",
    "ginger": "Ginger root",
    "leftover": "Takeout box",
    "takeaway": "Takeout box",
    "meal prep": "Bento box",
    "cooked meal": "Fork and knife with plate",
    "dinner": "Fork and knife with plate",
    "lunch": "Bento box",
    "noodles": "Steaming bowl",
    "rice": "Cooked rice",
    "dumplings": "Dumpling",
    "sushi": "Sushi",
    "snack": "Pretzel",
    "snack bar": "Chocolate bar",
    "protein bar": "Chocolate bar",
    "granola bar": "Chocolate bar",
    "energy bar": "Chocolate bar",
    "chocolate": "Chocolate bar",
    "chocolate bar": "Chocolate bar",
    "candy": "Candy",
    "candy bar": "Chocolate bar",
    "cookie": "Cookie",
    "cake": "Shortcake",
    "pie": "Pie",
    "pastry": "Croissant",
    "dessert": "Cupcake",
    "pudding": "Custard",
    "jello": "Custard",
    "whipped cream": "Soft ice cream",
    "ice cream": "Ice cream",
}


def slug(key: str) -> str:
    return key.strip().lower().replace(" ", "_")


def asset_url(emoji: str) -> str:
    """assets/<Name>/3D/<name>_3d.png — Fluent names the file after the folder, lower-cased."""
    file = emoji.lower().replace(" ", "_").replace("-", "_") + "_3d.png"
    return f"{RAW_BASE}/assets/{urllib.parse.quote(emoji)}/3D/{file}"


def fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": "fridgeAI/db.fetch_images"})
    with urllib.request.urlopen(req, timeout=60) as resp:
        return resp.read()


def load_keys(database: Path) -> list[str]:
    try:
        doc = json.loads(database.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as e:
        sys.exit(f"error: cannot read {database}: {e}")
    if not isinstance(doc, dict):
        sys.exit(f"error: {database} must be a JSON object of item -> hours")
    return list(doc)


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n", 1)[0])
    p.add_argument("--database", type=Path, default=DEFAULT_DATABASE, help="expire.json to take keys from")
    p.add_argument("--out-dir", type=Path, default=DEFAULT_OUT_DIR, help="where PNGs + index.json go")
    p.add_argument("--force", action="store_true", help="re-download even if the PNG already exists")
    p.add_argument("--check", action="store_true", help="only verify every key has an icon mapping")
    args = p.parse_args(argv)

    keys = load_keys(args.database)
    missing = [k for k in keys if k not in ICON]
    if missing:
        print(f"error: {len(missing)} key(s) in {args.database} have no entry in ICON:", file=sys.stderr)
        for k in missing:
            print(f"  {k!r}", file=sys.stderr)
        return 1
    unused = sorted(set(ICON) - set(keys))
    if unused:
        print(f"note: {len(unused)} ICON entries not in {args.database.name}: {', '.join(unused)}", file=sys.stderr)
    if args.check:
        print(f"ok: all {len(keys)} keys mapped to {len(set(ICON[k] for k in keys))} icons")
        return 0

    out = args.out_dir
    out.mkdir(parents=True, exist_ok=True)

    todo = [k for k in keys if args.force or not (out / f"{slug(k)}.png").exists()]
    emojis = sorted({ICON[k] for k in todo})
    print(f"fetch_images: {len(keys)} keys, {len(todo)} to write, {len(emojis)} icons to download", file=sys.stderr)

    # Each distinct emoji is downloaded once, then copied to every key that uses it.
    png: dict[str, bytes] = {}
    failed: list[str] = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=WORKERS) as pool:
        futures = {pool.submit(fetch, asset_url(e)): e for e in emojis}
        for fut in concurrent.futures.as_completed(futures):
            emoji = futures[fut]
            try:
                data = fut.result()
            except (urllib.error.URLError, OSError) as e:
                print(f"  FAIL {emoji}: {e}", file=sys.stderr)
                failed.append(emoji)
                continue
            if not data.startswith(b"\x89PNG"):
                print(f"  FAIL {emoji}: not a PNG", file=sys.stderr)
                failed.append(emoji)
                continue
            png[emoji] = data
    if failed:
        print(f"error: {len(failed)} icon(s) failed to download; nothing written", file=sys.stderr)
        return 1

    for k in todo:
        (out / f"{slug(k)}.png").write_bytes(png[ICON[k]])

    try:
        (out / "LICENSE.txt").write_bytes(fetch(f"{RAW_BASE}/LICENSE"))
    except (urllib.error.URLError, OSError) as e:
        print(f"error: could not fetch licence: {e}", file=sys.stderr)
        return 1

    index = {
        "source": {
            "name": "Fluent Emoji (3D)",
            "repo": f"https://github.com/{FLUENT_REPO}",
            "commit": FLUENT_COMMIT,
            "license": FLUENT_LICENSE,
            "size": "256x256 RGBA PNG",
        },
        "items": {k: {"file": f"{slug(k)}.png", "emoji": ICON[k]} for k in keys},
    }
    (out / "index.json").write_text(json.dumps(index, indent=2) + "\n", encoding="utf-8")
    print(f"fetch_images: wrote {len(todo)} PNG(s) + index.json to {out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
