#!/usr/bin/env python3
"""Detect objects entering/leaving a fridge in a video, using a Gemini Flash model.

    cd backend && python -m detection.detect --video path/to/video.mov [--model M] [--fps N] [--out-dir DIR]

Writes two JSON files into --out-dir (default: a new backend/experiments/<YYYY-MM-DD_HH-MM-SS>/ folder).
Normally launched via backend/pipeline.sh, which points --out-dir at
backend/experiments/<EXPERIMENT>/runs/<stamp>/, captures run.log there, and then folds events.json
into the experiment's cumulative inventory with inventory/update.py. Both files here describe this
one video only; item_id is per video and time_s is an offset into it.

1. events.json: which objects entered/exited the fridge and when.

    {
      "video": "test.mp4",
      "recorded_at": "2026-09-12T13:28:51-04:00",
      "duration_s": 5.47,
      "model": "gemini-3.8-flash",
      "events": [
        {"item_id": 1, "object": "milk carton", "action": "in", "time_s": 1.2, "timestamp": "00:01", "confidence": 0.92}
      ]
    }

2. inventory.json: net result of the events.
   in_fridge = items that entered and were not taken back out; removed = items taken out that
   never entered during the video (i.e. were already inside). Items whose in/out cancel are omitted.
   recorded_at is the wall-clock time the run started; check_expire/check.py adds entered_at_s to it.

    {
      "video": "test.mp4",
      "recorded_at": "2026-09-12T13:28:51-04:00",
      "model": "gemini-3.8-flash",
      "in_fridge": [{"item_id": 1, "object": "milk carton", "entered_at_s": 1.2, "timestamp": "00:01"}],
      "removed":   [{"item_id": 2, "object": "beer bottle", "exited_at_s": 4.1, "timestamp": "00:04"}]
    }
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import mimetypes
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Literal

from google import genai
from google.genai import errors as genai_errors
from google.genai import types
from pydantic import BaseModel, Field, ValidationError

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------

DETECTION_DIR = Path(__file__).resolve().parent
BACKEND_DIR = DETECTION_DIR.parent
DEFAULT_API_KEY_FILE = BACKEND_DIR / "api_key" / "Gemini_API.txt"
EXPERIMENTS_DIR = BACKEND_DIR / "experiments"

DEFAULT_MODEL = "gemini-3.8-flash"

# Frames/second the model samples from the video. Gemini's own default (1 fps)
# missed a ~0.5 s hand-through-door crossing on a 65 s test; 2 fps caught all of them.
DEFAULT_FPS = 2.0

# Gemini caps a single inline request at 20 MB; anything bigger goes through the Files API.
INLINE_LIMIT_BYTES = 20 * 1024 * 1024

# Files API processing poll settings.
POLL_INTERVAL_S = 2.0
POLL_TIMEOUT_S = 600.0

FALLBACK_MIME = {
    ".mov": "video/quicktime",
    ".qt": "video/quicktime",
    ".mp4": "video/mp4",
    ".m4v": "video/mp4",
    ".webm": "video/webm",
    ".mkv": "video/x-matroska",
    ".avi": "video/x-msvideo",
    ".mpg": "video/mpeg",
    ".mpeg": "video/mpeg",
    ".3gp": "video/3gpp",
    ".wmv": "video/x-ms-wmv",
    ".flv": "video/x-flv",
}

PROMPT = """\
You are analysing a video of a person interacting with a refrigerator.

Task: list every event where an object is put INTO the fridge ("in") or taken OUT of the fridge ("out").

For each event report:
- item_id: an integer identifying the physical item. Number distinct items 1, 2, 3, ... in order of first appearance. If the same physical item appears in more than one event (e.g. it is put in and later taken back out), reuse its item_id. Two similar-looking but separate items (e.g. two cans of soda) get different ids.
- object: a short, specific, lowercase noun phrase naming the item (e.g. "milk carton", "red apple", "can of soda", "egg carton"). Include brand or colour only if clearly visible and useful to tell items apart. Use exactly the same object name in every event that shares an item_id.
- action: "in" if the object ends up inside the fridge, "out" if it ends up outside the fridge.
- time_s: the time in seconds from the start of the video at which the object crosses the plane of the fridge opening (door threshold). Use decimals if you can be that precise.
- confidence: 0.0-1.0, how sure you are that this event happened as described.

Rules:
- Only count objects that actually cross into or out of the fridge interior. Ignore items that are merely held, touched, or moved around outside or inside without crossing the opening.
- One event per object per crossing. If the same object goes in and then comes back out, report two events.
- Do not report the fridge door, the person's hands/arms, or shelving as objects.
- If several distinct items are moved at once, report each separately.
- Order events chronologically.
- If nothing enters or leaves the fridge, return an empty events list.
"""


# ---------------------------------------------------------------------------
# Structured response schema (sent to Gemini as response_schema)
# ---------------------------------------------------------------------------

class Event(BaseModel):
    """One object crossing the fridge threshold."""

    item_id: int = Field(description="Stable integer id for the physical item; reused across events for the same item.")
    object: str = Field(description="Short, specific, lowercase noun phrase, e.g. 'milk carton'.")
    action: Literal["in", "out"] = Field(description="'in' = put into fridge, 'out' = taken out.")
    time_s: float = Field(description="Seconds from start of video when the object crosses the fridge opening.")
    confidence: float = Field(description="0.0-1.0 confidence in this event.")


class DetectionResult(BaseModel):
    events: list[Event]


# ---------------------------------------------------------------------------
# Gemini
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


def mime_type(video: Path) -> str:
    guessed, _ = mimetypes.guess_type(video.name)
    if guessed and guessed.startswith("video/"):
        return guessed
    ext = video.suffix.lower()
    if ext in FALLBACK_MIME:
        return FALLBACK_MIME[ext]
    raise RuntimeError(f"unsupported video type: {video.suffix!r}")


def wait_until_active(client: genai.Client, f: types.File) -> types.File:
    deadline = time.monotonic() + POLL_TIMEOUT_S
    while f.state == types.FileState.PROCESSING:
        if time.monotonic() > deadline:
            raise RuntimeError(f"timed out waiting for Gemini to process {f.name}")
        time.sleep(POLL_INTERVAL_S)
        f = client.files.get(name=f.name)
    if f.state != types.FileState.ACTIVE:
        msg = f.error.message if f.error else "unknown error"
        raise RuntimeError(f"Gemini failed to process uploaded video ({f.state}): {msg}")
    return f


def video_part(client: genai.Client, video: Path, fps: float) -> tuple[types.Part, types.File | None]:
    """Return (part, uploaded_file). uploaded_file is None when the video was sent inline."""
    mime = mime_type(video)
    meta = types.VideoMetadata(fps=fps)

    if video.stat().st_size <= INLINE_LIMIT_BYTES:
        part = types.Part.from_bytes(data=video.read_bytes(), mime_type=mime)
        part.video_metadata = meta
        return part, None

    print(f"gemini: uploading {video.name} via Files API ...", file=sys.stderr)
    uploaded = client.files.upload(
        file=video,
        config=types.UploadFileConfig(mime_type=mime, display_name=video.name),
    )
    uploaded = wait_until_active(client, uploaded)
    part = types.Part.from_uri(file_uri=uploaded.uri, mime_type=uploaded.mime_type or mime)
    part.video_metadata = meta
    return part, uploaded


def detect_events(client: genai.Client, model: str, video: Path, fps: float) -> DetectionResult:
    """Send the video to Gemini and return the parsed, schema-validated events."""
    print(f"gemini: sampling video at {fps:g} fps", file=sys.stderr)
    part, uploaded = video_part(client, video, fps)
    try:
        response = client.models.generate_content(
            model=model,
            contents=[part, PROMPT],
            config=types.GenerateContentConfig(
                temperature=0.0,
                response_mime_type="application/json",
                response_schema=DetectionResult,
                # No tools here; silences the SDK's "AFC in generate_content" warning.
                automatic_function_calling=types.AutomaticFunctionCallingConfig(disable=True),
            ),
        )
    finally:
        if uploaded is not None:
            try:
                client.files.delete(name=uploaded.name)
            except Exception as e:  # best-effort cleanup; not fatal
                print(f"gemini: warning: could not delete {uploaded.name}: {e}", file=sys.stderr)

    usage = response.usage_metadata
    if usage:
        print(
            f"gemini: model={response.model_version or model} "
            f"tokens in={usage.prompt_token_count} out={usage.candidates_token_count} "
            f"thoughts={usage.thoughts_token_count or 0}",
            file=sys.stderr,
        )

    text = response.text
    if not text:
        raise RuntimeError("Gemini returned an empty response")
    return DetectionResult.model_validate_json(text)


# ---------------------------------------------------------------------------
# Post-processing
# ---------------------------------------------------------------------------

def probe_duration(video: Path) -> float | None:
    """Video duration in seconds via ffprobe, or None if ffprobe is unavailable/fails."""
    ffprobe = shutil.which("ffprobe")
    if not ffprobe:
        return None
    try:
        out = subprocess.run(
            [ffprobe, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", str(video)],
            capture_output=True, text=True, check=True, timeout=60,
        ).stdout.strip()
        return round(float(out), 2)
    except (subprocess.SubprocessError, ValueError):
        return None


def format_timestamp(seconds: float) -> str:
    total = int(seconds)  # floor to whole second
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m:02d}:{s:02d}"


def build_events(video: Path, recorded_at: str, model: str, duration_s: float | None,
                 result: DetectionResult) -> dict:
    """Sort, clamp and round the raw model events into the event-log document."""
    events = []
    for ev in sorted(result.events, key=lambda e: e.time_s):
        t = max(0.0, ev.time_s)
        if duration_s is not None:
            t = min(t, duration_s)
        events.append({
            "item_id": ev.item_id,
            "object": ev.object.strip().lower(),
            "action": ev.action,
            "time_s": round(t, 2),
            "timestamp": format_timestamp(t),
            "confidence": round(min(max(ev.confidence, 0.0), 1.0), 2),
        })
    return {
        "video": video.name,
        "recorded_at": recorded_at,
        "duration_s": duration_s,
        "model": model,
        "events": events,
    }


def build_inventory(events_doc: dict) -> dict:
    """Replay the (already sorted) events per item_id to find what is left inside the fridge.

    An item is "in_fridge" if its last event is "in" and it was not already inside before the
    video (i.e. its first event was "in"). It is "removed" if its last event is "out" and it was
    already inside before the video (its first event was "out"). Everything else nets to zero.
    """
    first: dict[int, dict] = {}
    last: dict[int, dict] = {}
    for ev in events_doc["events"]:
        first.setdefault(ev["item_id"], ev)
        last[ev["item_id"]] = ev

    in_fridge, removed = [], []
    for item_id, ev in last.items():
        was_inside_before = first[item_id]["action"] == "out"
        if ev["action"] == "in" and not was_inside_before:
            in_fridge.append({
                "item_id": item_id,
                "object": ev["object"],
                "entered_at_s": ev["time_s"],
                "timestamp": ev["timestamp"],
            })
        elif ev["action"] == "out" and was_inside_before:
            removed.append({
                "item_id": item_id,
                "object": ev["object"],
                "exited_at_s": ev["time_s"],
                "timestamp": ev["timestamp"],
            })

    return {
        "video": events_doc["video"],
        "recorded_at": events_doc["recorded_at"],
        "model": events_doc["model"],
        "in_fridge": sorted(in_fridge, key=lambda x: x["entered_at_s"]),
        "removed": sorted(removed, key=lambda x: x["exited_at_s"]),
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------

def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(
        prog="detect.py",
        description="Detect objects entering/leaving a fridge in a video; write event log + inventory JSON.",
    )
    p.add_argument("--video", required=True, type=Path, help="path to input video")
    p.add_argument("--model", default=DEFAULT_MODEL, help=f"Gemini model name (default: {DEFAULT_MODEL})")
    p.add_argument("--fps", type=float, default=DEFAULT_FPS,
                   help=f"frames per second the model samples from the video (default: {DEFAULT_FPS:g}). "
                        "Higher = finer timestamps and fewer missed crossings, but more tokens.")
    p.add_argument("--out-dir", type=Path, default=None,
                   help="folder to write events.json + inventory.json into "
                        f"(default: new {EXPERIMENTS_DIR}/<YYYY-MM-DD_HH-MM-SS>/)")
    p.add_argument("--api-key-file", type=Path, default=DEFAULT_API_KEY_FILE,
                   help="file whose first non-empty line is the API key ($GEMINI_API_KEY overrides)")
    p.add_argument("--quiet", action="store_true", help="don't print the JSON to stdout")
    args = p.parse_args(argv)
    if args.fps <= 0:
        p.error("--fps must be > 0")
    return args


def new_run_dir(root: Path = EXPERIMENTS_DIR) -> Path:
    """Create and return root/<YYYY-MM-DD_HH-MM-SS>/ (suffixed _2, _3, ... on collision)."""
    stamp = dt.datetime.now().strftime("%Y-%m-%d_%H-%M-%S")
    run_dir, n = root / stamp, 1
    while run_dir.exists():
        n += 1
        run_dir = root / f"{stamp}_{n}"
    run_dir.mkdir(parents=True)
    return run_dir


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    recorded_at = dt.datetime.now().astimezone().isoformat(timespec="seconds")

    video = args.video.expanduser().resolve()
    if not video.is_file():
        print(f"error: video not found: {video}", file=sys.stderr)
        return 2

    out_dir = args.out_dir.expanduser().resolve() if args.out_dir else new_run_dir()
    out_dir.mkdir(parents=True, exist_ok=True)
    events_path = out_dir / "events.json"
    inventory_path = out_dir / "inventory.json"

    try:
        client = genai.Client(api_key=read_api_key(args.api_key_file))
        print(f"detect: {video.name} -> {args.model}", file=sys.stderr)
        result = detect_events(client, args.model, video, args.fps)
    except genai_errors.APIError as e:
        print(f"error: Gemini API {e.code}: {e.message}", file=sys.stderr)
        return 1
    except ValidationError as e:
        print(f"error: model returned JSON that does not match the schema:\n{e}", file=sys.stderr)
        return 1
    except RuntimeError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1

    events_doc = build_events(video, recorded_at, args.model, probe_duration(video), result)
    inventory = build_inventory(events_doc)

    for path, doc in ((events_path, events_doc), (inventory_path, inventory)):
        path.write_text(json.dumps(doc, indent=2) + "\n", encoding="utf-8")

    if not args.quiet:
        print(json.dumps(events_doc, indent=2))
        print(json.dumps(inventory, indent=2))
    print(f"detect: {len(events_doc['events'])} event(s) -> {events_path}", file=sys.stderr)
    print(f"detect: {len(inventory['in_fridge'])} in fridge, {len(inventory['removed'])} removed -> {inventory_path}",
          file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
