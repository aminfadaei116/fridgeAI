#!/usr/bin/env python3
"""Fold one detection run into an experiment's running inventory and event log.

    cd backend && python -m inventory.update --experiment experiments/<name> --run experiments/<name>/runs/<stamp>

Reads <run>/events.json (written by detection/detect.py for a single video) and updates two
cumulative files at the top of the experiment folder, creating them on first use:

1. events.json: every in/out event ever seen in this experiment, in wall-clock time.
   time = the run's recorded_at (when the pipeline started) + the event's offset in the video.

    {
      "experiment": "experiment1",
      "updated_at": "2026-09-12T15:02:10-04:00",
      "runs": [
        {"run": "2026-09-12_15-01-40", "video": "fridge.mp4", "recorded_at": "2026-09-12T15:01:40-04:00",
         "duration_s": 5.47, "model": "gemini-3.8-flash", "events": 3, "added": 2, "removed": 1,
         "untracked_removed": 0}
      ],
      "events": [
        {"item_id": 1, "object": "milk carton", "action": "in", "time": "2026-09-12T15:01:41-04:00",
         "run": "2026-09-12_15-01-40", "video": "fridge.mp4", "video_item_id": 1, "time_s": 1.2,
         "confidence": 0.92}
      ]
    }

2. inventory.json: what is inside right now, plus everything that has been taken out.
   item_id is global to the experiment (detect.py's per-video ids are remapped).

    {
      "experiment": "experiment1",
      "updated_at": "2026-09-12T15:02:10-04:00",
      "next_item_id": 3,
      "in_fridge": [
        {"item_id": 1, "object": "milk carton", "entered_at": "2026-09-12T15:01:41-04:00",
         "run": "2026-09-12_15-01-40", "video": "fridge.mp4", "confidence": 0.92}
      ],
      "removed": [
        {"item_id": 2, "object": "beer bottle", "entered_at": null, "removed_at": "2026-09-12T15:01:44-04:00",
         "run": "2026-09-12_15-01-40", "video": "fridge.mp4", "confidence": 0.8}
      ]
    }

Events are replayed in order. "in" adds the item (a new global id, or the same id if that item
went out earlier in the same video). "out" for an item this video put in removes it again. "out"
for an item the video never saw go in means it was already inside: it is matched against
in_fridge by name (exact, then same words after stripping packaging, then same db/expire.json
entry), oldest first; items added by this same run are never candidates. No match -> it is still
logged under "removed" with entered_at null (untracked_removed in the run summary).

A run can only be applied once; re-running with the same run folder is an error.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import sys
from pathlib import Path

from check_expire.check import DEFAULT_DATABASE, DbEntry, load_database, match, normalize

BACKEND_DIR = Path(__file__).resolve().parents[1]


# ---------------------------------------------------------------------------
# Files
# ---------------------------------------------------------------------------

def load_json(path: Path, what: str) -> dict:
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        raise RuntimeError(f"cannot read {what} {path}: {e}") from e
    if not isinstance(doc, dict):
        raise RuntimeError(f"{what} {path} is not a JSON object")
    return doc


def empty_events(name: str) -> dict:
    return {"experiment": name, "updated_at": None, "runs": [], "events": []}


def empty_inventory(name: str) -> dict:
    return {"experiment": name, "updated_at": None, "next_item_id": 1, "in_fridge": [], "removed": []}


def load_or_new(path: Path, what: str, factory) -> dict:
    return load_json(path, what) if path.exists() else factory()


def parse_datetime(text: str) -> dt.datetime:
    d = dt.datetime.fromisoformat(text)
    return d if d.tzinfo else d.astimezone()


def iso(d: dt.datetime) -> str:
    return d.isoformat(timespec="seconds")


def label(path: Path) -> str:
    try:
        return str(path.relative_to(BACKEND_DIR))
    except ValueError:
        return str(path)


# ---------------------------------------------------------------------------
# Name matching for "out" events of items that were already inside
# ---------------------------------------------------------------------------

def find_in_fridge(name: str, in_fridge: list[dict], exclude_ids: set[int], db: list[DbEntry]) -> dict | None:
    """Oldest in_fridge entry that is the same food as `name`, or None.

    Tiers, first non-empty wins: identical name; same normalised word set; same db/expire.json key;
    one name's words contained in the other's ("chicken" ~ "raw chicken"; closest, i.e. fewest
    extra words, first).
    """
    candidates = [e for e in in_fridge if e["item_id"] not in exclude_ids]
    if not candidates:
        return None
    entered = lambda e: parse_datetime(e["entered_at"])

    target = name.strip().lower()
    exact = [e for e in candidates if e["object"].strip().lower() == target]
    if exact:
        return min(exact, key=entered)

    words = normalize(name)
    if not words:
        return None
    same_words = [e for e in candidates if normalize(e["object"]) == words]
    if same_words:
        return min(same_words, key=entered)

    key = match(name, db)
    if key is not None:
        same_key = [e for e in candidates if match(e["object"], db) == key]
        if same_key:
            return min(same_key, key=entered)

    overlap = [(e, normalize(e["object"])) for e in candidates]
    overlap = [(e, w) for e, w in overlap if w and (words <= w or w <= words)]
    if overlap:
        return min(overlap, key=lambda ew: (len(ew[1] ^ words), entered(ew[0])))[0]
    return None


# ---------------------------------------------------------------------------
# Merge
# ---------------------------------------------------------------------------

def apply_run(run_name: str, run_events: dict, events_doc: dict, inventory: dict, db: list[DbEntry]) -> dict:
    """Replay one video's events into the cumulative documents (mutated in place). Returns the run summary."""
    recorded_at = parse_datetime(run_events["recorded_at"])
    video = run_events.get("video")
    in_fridge: list[dict] = inventory["in_fridge"]
    removed: list[dict] = inventory["removed"]
    next_id: int = inventory["next_item_id"]

    id_map: dict[int, int] = {}      # this video's item_id -> global item_id
    added_this_run: set[int] = set()  # global ids put in by this run (never matched by an "out" by name)
    n_added = n_removed = n_untracked = 0

    for ev in sorted(run_events["events"], key=lambda e: e["time_s"]):
        when = recorded_at + dt.timedelta(seconds=float(ev["time_s"]))
        vid_id = ev["item_id"]
        name = ev["object"]
        common = {"run": run_name, "video": video, "confidence": ev.get("confidence")}

        if ev["action"] == "in":
            gid = id_map.get(vid_id)
            if gid is None:
                gid = id_map[vid_id] = next_id
                next_id += 1
            if any(e["item_id"] == gid for e in in_fridge):
                print(f"update: warning: {name!r} (#{gid}) reported 'in' twice without leaving; ignored",
                      file=sys.stderr)
            else:
                in_fridge.append({"item_id": gid, "object": name, "entered_at": iso(when), **common})
                added_this_run.add(gid)
                n_added += 1
        else:  # "out"
            gid = id_map.get(vid_id)
            entry = None
            if gid is not None:
                entry = next((e for e in in_fridge if e["item_id"] == gid), None)
            else:
                entry = find_in_fridge(name, in_fridge, added_this_run, db)
                if entry is not None:
                    gid = id_map[vid_id] = entry["item_id"]
                    if entry["object"] != name:
                        print(f"update: {name!r} matched {entry['object']!r} (#{gid})", file=sys.stderr)
            if entry is not None:
                in_fridge.remove(entry)
                removed.append({"item_id": gid, "object": entry["object"], "entered_at": entry["entered_at"],
                                "removed_at": iso(when), **common})
                n_removed += 1
            else:
                if gid is None:
                    gid = id_map[vid_id] = next_id
                    next_id += 1
                print(f"update: {name!r} taken out but was not in the tracked inventory", file=sys.stderr)
                removed.append({"item_id": gid, "object": name, "entered_at": None,
                                "removed_at": iso(when), **common})
                n_untracked += 1

        events_doc["events"].append({
            "item_id": gid,
            "object": name,
            "action": ev["action"],
            "time": iso(when),
            "run": run_name,
            "video": video,
            "video_item_id": vid_id,
            "time_s": ev["time_s"],
            "confidence": ev.get("confidence"),
        })

    inventory["next_item_id"] = next_id
    in_fridge.sort(key=lambda e: parse_datetime(e["entered_at"]))
    removed.sort(key=lambda e: parse_datetime(e["removed_at"]))
    events_doc["events"].sort(key=lambda e: parse_datetime(e["time"]))

    summary = {
        "run": run_name,
        "video": video,
        "recorded_at": run_events["recorded_at"],
        "duration_s": run_events.get("duration_s"),
        "model": run_events.get("model"),
        "events": len(run_events["events"]),
        "added": n_added,
        "removed": n_removed,
        "untracked_removed": n_untracked,
    }
    events_doc["runs"].append(summary)
    return summary


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="update.py",
        description="Merge one detection run's events.json into an experiment's cumulative inventory + event log.",
    )
    p.add_argument("--experiment", required=True, type=Path, help="experiment folder (holds the cumulative files)")
    p.add_argument("--run", required=True, type=Path, help="run folder containing detect.py's events.json")
    p.add_argument("--database", type=Path, default=DEFAULT_DATABASE,
                   help=f"db/expire.json, used only to match 'out' items by food type (default: {DEFAULT_DATABASE})")
    p.add_argument("--quiet", action="store_true", help="don't print inventory.json to stdout")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    experiment = args.experiment.expanduser().resolve()
    run_dir = args.run.expanduser().resolve()
    run_events_path = run_dir / "events.json"
    if not run_events_path.is_file():
        print(f"error: run events not found: {run_events_path}", file=sys.stderr)
        return 2

    events_path = experiment / "events.json"
    inventory_path = experiment / "inventory.json"
    name = experiment.name

    try:
        db = load_database(args.database.expanduser().resolve())
        run_events = load_json(run_events_path, "run events")
        events_doc = load_or_new(events_path, "events", lambda: empty_events(name))
        inventory = load_or_new(inventory_path, "inventory", lambda: empty_inventory(name))
        if "recorded_at" not in run_events or "events" not in run_events:
            raise RuntimeError(f"{run_events_path} is missing recorded_at/events; not a detect.py output?")
        if any(r["run"] == run_dir.name for r in events_doc["runs"]):
            raise RuntimeError(f"run {run_dir.name!r} was already applied to {label(experiment)}")
        summary = apply_run(run_dir.name, run_events, events_doc, inventory, db)
    except (RuntimeError, KeyError, ValueError, OSError) as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    now = iso(dt.datetime.now().astimezone())
    events_doc["updated_at"] = inventory["updated_at"] = now
    experiment.mkdir(parents=True, exist_ok=True)
    for path, doc in ((events_path, events_doc), (inventory_path, inventory)):
        path.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")

    if not args.quiet:
        print(json.dumps(inventory, indent=2))
    print(f"update: run {summary['run']}: {summary['events']} event(s), +{summary['added']} in, "
          f"-{summary['removed']} out, {summary['untracked_removed']} untracked out", file=sys.stderr)
    print(f"update: {len(inventory['in_fridge'])} item(s) in fridge, {len(inventory['removed'])} removed total "
          f"-> {inventory_path}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
