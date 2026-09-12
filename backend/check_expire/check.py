#!/usr/bin/env python3
"""Check which fridge items are close to going bad.

    cd backend && python -m check_expire.check --database db/expire.json --experiment experiments/<name> [--threshold-hours 48]

Reads <experiment>/inventory.json (the cumulative one kept by inventory/update.py) and the shelf-life
database (hours an item keeps in the fridge), then writes <experiment>/expire.json and prints it:

    {
      "checked_at": "2026-09-14T09:00:00-04:00",
      "threshold_hours": 48,
      "inventory": "experiments/experiment1/inventory.json",
      "items": [
        {"item_id": 1, "object": "milk carton", "matched": "milk", "shelf_life_hours": 168,
         "entered_at": "2026-09-12T13:28:53-04:00", "expires_at": "2026-09-19T13:28:53-04:00",
         "hours_left": 124.5, "status": "ok"}
      ],
      "unknown": [{"item_id": 2, "object": "mystery jar"}]
    }

status: "expired" (hours_left <= 0), "expiring_soon" (<= threshold), else "ok".
Items are sorted most-urgent first. entered_at is taken from the inventory entry; for a raw
detect.py inventory (per-video, no entered_at) it is recorded_at + entered_at_s instead.

Name matching is offline and heuristic (inventory names are model-generated, db keys are canonical):
names are lower-cased, singularised and stripped of packaging words; then
  1. a db key whose words all appear in the item name -> longest key wins
     ("chocolate milk carton" -> "chocolate milk", not "milk")
  2. a db key that contains all of the item's words -> prefer keys whose last word is one of
     the item's words ("greens" -> "leafy greens", not "green beans"), then shortest shelf life
     ("chicken" -> "raw chicken", 48 h - the conservative choice)
Anything else lands in "unknown"; add an alias to db/expire.json to teach it.
"""

from __future__ import annotations

import argparse
import datetime as dt
import functools
import json
import re
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
DEFAULT_DATABASE = BACKEND_DIR / "db" / "expire.json"
DEFAULT_EXPERIMENT = BACKEND_DIR / "experiments" / "latest"
DEFAULT_THRESHOLD_HOURS = 48.0

# Words that describe packaging/quantity rather than the food; ignored when matching.
PACKAGING_WORDS = {
    "a", "an", "the", "of", "some", "fresh", "leftover",
    "carton", "bottle", "can", "jar", "bag", "box", "pack", "package", "packet", "container",
    "tub", "cup", "piece", "slice", "block", "wrapped", "plastic", "glass", "tin", "pouch",
    "gallon", "quart", "pint", "liter", "litre", "dozen", "bunch", "head",
    "small", "large", "big", "little", "mini", "whole",
}


# ---------------------------------------------------------------------------
# Name matching
# ---------------------------------------------------------------------------

def singular(word: str) -> str:
    """Cheap English singulariser. Only needs to be *consistent* on both sides, not perfect."""
    if len(word) <= 3:
        return word
    if word.endswith("ies") and len(word) > 4:
        return word[:-3] + "y"            # berries -> berry
    if word.endswith(("ches", "shes", "sses", "xes", "zes", "oes")):
        return word[:-2]                  # peaches -> peach, tomatoes -> tomato
    if word.endswith("s") and not word.endswith(("ss", "us")):
        return word[:-1]                  # eggs -> egg; hummus, asparagus unchanged
    return word


def normalize_words(name: str) -> list[str]:
    words = re.findall(r"[a-z0-9]+", name.lower())
    return [singular(w) for w in words if w not in PACKAGING_WORDS]


def normalize(name: str) -> frozenset[str]:
    return frozenset(normalize_words(name))


class DbEntry:
    __slots__ = ("key", "words", "hours", "head")

    def __init__(self, key: str, hours: float):
        self.key = key
        self.hours = hours
        ordered = normalize_words(key)
        self.words = frozenset(ordered)
        self.head = ordered[-1] if ordered else ""   # last word = head noun ("leafy greens" -> greens)


def load_database(path: Path) -> list[DbEntry]:
    """Entries in file order. Validates shape and rejects duplicate keys."""
    try:
        pairs = json.loads(path.read_text(encoding="utf-8"), object_pairs_hook=lambda p: p)
    except (OSError, ValueError) as e:
        raise RuntimeError(f"cannot read database {path}: {e}") from e
    if not isinstance(pairs, list):
        raise RuntimeError(f"database {path} must be a JSON object of name -> hours")
    seen: set[str] = set()
    db = []
    for key, hours in pairs:
        if key in seen:
            raise RuntimeError(f"database {path}: duplicate key {key!r}")
        if not isinstance(hours, (int, float)) or isinstance(hours, bool) or hours <= 0:
            raise RuntimeError(f"database {path}: {key!r} must map to a positive number of hours")
        seen.add(key)
        db.append(DbEntry(key, float(hours)))
    return db


def match(name: str, db: list[DbEntry]) -> tuple[str, float] | None:
    """Best database (key, hours) for an inventory object name, or None."""
    words = normalize(name)
    if not words:
        return None
    # 1. key words are a subset of the item words: longest key, then shortest shelf life.
    forward = [e for e in db if e.words and e.words <= words]
    if forward:
        e = min(forward, key=lambda e: (-len(e.words), e.hours))
        return e.key, e.hours
    # 2. item words are a subset of the key words: prefer a key whose head noun is one of the
    #    item's words, then shortest shelf life (conservative), then file order.
    reverse = [e for e in db if words <= e.words]
    if reverse:
        e = min(reverse, key=lambda e: (e.head not in words, e.hours))
        return e.key, e.hours
    return None


# ---------------------------------------------------------------------------
# Time handling
# ---------------------------------------------------------------------------

def parse_datetime(text: str) -> dt.datetime:
    """ISO-8601 -> aware datetime (naive input is taken as local time)."""
    d = dt.datetime.fromisoformat(text)
    return d if d.tzinfo else d.astimezone()


def recorded_at_for(inventory: dict, experiment: Path, inventory_path: Path) -> dt.datetime:
    """When the inventory was recorded: the JSON field, else the run-folder name, else file mtime."""
    if inventory.get("recorded_at"):
        return parse_datetime(inventory["recorded_at"])
    m = re.match(r"^(\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2})", experiment.name)
    if m:
        print(f"check: inventory has no recorded_at; using run folder timestamp", file=sys.stderr)
        return dt.datetime.strptime(m.group(1), "%Y-%m-%d_%H-%M-%S").astimezone()
    print(f"check: inventory has no recorded_at; using file mtime", file=sys.stderr)
    return dt.datetime.fromtimestamp(inventory_path.stat().st_mtime).astimezone()


def iso(d: dt.datetime) -> str:
    return d.isoformat(timespec="seconds")


# ---------------------------------------------------------------------------
# Report
# ---------------------------------------------------------------------------

def entered_at_for(entry: dict, recorded_at) -> dt.datetime:
    """Cumulative inventory entries carry an absolute entered_at; raw detect.py ones an offset."""
    if entry.get("entered_at"):
        return parse_datetime(entry["entered_at"])
    return recorded_at() + dt.timedelta(seconds=float(entry.get("entered_at_s") or 0))


def build_report(inventory: dict, db: list, recorded_at, now: dt.datetime,
                 threshold_hours: float, inventory_label: str) -> dict:
    """recorded_at is a zero-arg callable, only invoked for entries without an absolute entered_at."""
    items, unknown = [], []
    for entry in inventory.get("in_fridge", []):
        found = match(entry["object"], db)
        if found is None:
            unknown.append({"item_id": entry["item_id"], "object": entry["object"]})
            continue
        key, shelf_life = found
        entered_at = entered_at_for(entry, recorded_at)
        expires_at = entered_at + dt.timedelta(hours=shelf_life)
        hours_left = (expires_at - now).total_seconds() / 3600
        if hours_left <= 0:
            status = "expired"
        elif hours_left <= threshold_hours:
            status = "expiring_soon"
        else:
            status = "ok"
        items.append({
            "item_id": entry["item_id"],
            "object": entry["object"],
            "matched": key,
            "shelf_life_hours": shelf_life if shelf_life % 1 else int(shelf_life),
            "entered_at": iso(entered_at),
            "expires_at": iso(expires_at),
            "hours_left": round(hours_left, 1),
            "status": status,
        })
    items.sort(key=lambda x: x["hours_left"])
    return {
        "checked_at": iso(now),
        "threshold_hours": threshold_hours if threshold_hours % 1 else int(threshold_hours),
        "inventory": inventory_label,
        "items": items,
        "unknown": unknown,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="check.py",
        description="Report which fridge items (from an experiment's inventory.json) are near expiry.",
    )
    p.add_argument("--database", type=Path, default=DEFAULT_DATABASE,
                   help=f"JSON map of item name -> hours it keeps (default: {DEFAULT_DATABASE})")
    p.add_argument("--experiment", type=Path, default=DEFAULT_EXPERIMENT,
                   help=f"experiment folder containing inventory.json (default: {DEFAULT_EXPERIMENT})")
    p.add_argument("--threshold-hours", type=float, default=DEFAULT_THRESHOLD_HOURS,
                   help=f"flag items with this many hours or fewer left (default: {DEFAULT_THRESHOLD_HOURS:g})")
    p.add_argument("--now", type=str, default=None,
                   help="ISO-8601 time to evaluate at (default: current time); handy for testing")
    p.add_argument("--out", type=Path, default=None,
                   help="output JSON path (default: <experiment>/expire.json)")
    p.add_argument("--quiet", action="store_true", help="don't print the JSON to stdout")
    args = p.parse_args(argv)
    if args.threshold_hours < 0:
        p.error("--threshold-hours must be >= 0")
    if args.now is not None:
        try:
            args.now = parse_datetime(args.now)
        except ValueError:
            p.error(f"--now is not ISO-8601: {args.now!r}")
    return args


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)

    experiment = args.experiment.expanduser().resolve()
    inventory_path = experiment / "inventory.json"
    if not inventory_path.is_file():
        print(f"error: inventory not found: {inventory_path}", file=sys.stderr)
        return 2
    out = (args.out or experiment / "expire.json").expanduser().resolve()

    try:
        db = load_database(args.database.expanduser().resolve())
        inventory = json.loads(inventory_path.read_text(encoding="utf-8"))
    except (RuntimeError, ValueError, OSError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    now = args.now or dt.datetime.now().astimezone()
    try:
        label = str(inventory_path.relative_to(BACKEND_DIR))
    except ValueError:
        label = str(inventory_path)

    # Only needed (and only computed, once) for a raw per-video inventory whose entries lack entered_at.
    recorded_at = functools.cache(lambda: recorded_at_for(inventory, experiment, inventory_path))
    try:
        report = build_report(inventory, db, recorded_at, now, args.threshold_hours, label)
    except (ValueError, KeyError, OSError) as e:
        print(f"error: bad inventory {inventory_path}: {e}", file=sys.stderr)
        return 1

    for item in report["items"]:
        print(f"check: {item['object']!r} -> {item['matched']!r} ({item['shelf_life_hours']} h): "
              f"{item['hours_left']} h left, {item['status']}", file=sys.stderr)
    for item in report["unknown"]:
        print(f"check: {item['object']!r} -> no match in database", file=sys.stderr)

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    if not args.quiet:
        print(json.dumps(report, indent=2))

    n_soon = sum(i["status"] == "expiring_soon" for i in report["items"])
    n_exp = sum(i["status"] == "expired" for i in report["items"])
    print(f"check: {len(report['items'])} item(s): {n_exp} expired, {n_soon} expiring within "
          f"{report['threshold_hours']} h, {len(report['unknown'])} unknown -> {out}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
