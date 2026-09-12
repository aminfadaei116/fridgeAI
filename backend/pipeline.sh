#!/usr/bin/env bash
# Feed one fridge video into a named experiment: detect what went in/out, fold it into that
# experiment's running inventory, recompute expiry, suggest recipes.
# Works from any cwd; every path below is resolved relative to this file.
#
# Usage:
#   backend/pipeline.sh VIDEO EXPERIMENT [detect args]
#   backend/pipeline.sh fridge.mp4 experiment1
#   backend/pipeline.sh clip2.mov  experiment1 --fps 5 --model gemini-2.5-flash
#
# EXPERIMENT is a folder name under backend/experiments/ (or a path if it contains a "/").
# Running again with the same EXPERIMENT adds to it: new items join the inventory, items seen
# leaving are taken off it, and every item keeps the wall-clock time it went in. Args after
# EXPERIMENT go straight to detection/detect.py (see backend/pipeline.sh --help);
# --quiet is also forwarded to the later stages.
#
# backend/experiments/<EXPERIMENT>/
#   inventory.json   what is in the fridge now (+ removed history), global item ids,
#                    entered_at = wall clock when it went in            (inventory/update.py)
#   events.json      every in/out event across all runs, wall-clock time (inventory/update.py)
#   expire.json      hours left for each item in the fridge, as of this run (check_expire/check.py)
#   recipes.json     3 recipes using what's there, expiring first        (chef/chef.py)
#   runs/<YYYY-MM-DD_HH-MM-SS>/
#     events.json, inventory.json   raw per-video output                (detection/detect.py)
#     run.log                       everything the scripts printed during this run
# backend/experiments/latest is a symlink to the experiment most recently run.
#
# To look at the result in a browser: python3 frontend/serve.py  (see frontend/README.md).
#
# Re-run the later stages by hand (from inside backend/; hours_left is relative to now):
#   python -m check_expire.check --experiment experiments/<EXPERIMENT> [--threshold-hours 48]
#   python -m chef.chef          --experiment experiments/<EXPERIMENT> [--count 3] [--no-pantry]
#
# First run creates backend/detection/.venv and installs detection/requirements.txt into it.
set -euo pipefail

BACKEND_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SELF="$BACKEND_DIR/$(basename "${BASH_SOURCE[0]}")"
DETECTION_DIR="$BACKEND_DIR/detection"
VENV="$DETECTION_DIR/.venv"
PYTHON="${PYTHON:-python3}"
EXPERIMENTS_DIR="$BACKEND_DIR/experiments"
API_KEY_FILE="${GEMINI_API_KEY_FILE:-$BACKEND_DIR/api_key/Gemini_API.txt}"
DATABASE="$BACKEND_DIR/db/expire.json"

usage() { echo "usage: $SELF VIDEO EXPERIMENT [--model M] [--fps N] [--quiet]" >&2; }

HELP=0
if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  HELP=1
fi

if [ "$HELP" != 1 ]; then
  # Two positional args (neither starting with "-"): the video, then the experiment name.
  if [ $# -lt 2 ] || [ "${1#-}" != "$1" ] || [ "${2#-}" != "$2" ]; then
    echo "pipeline.sh: need a video and an experiment name" >&2
    usage
    exit 2
  fi
  VIDEO="$1"; EXPERIMENT="$2"; shift 2

  # Resolve video to an absolute path relative to the caller's cwd, before we cd.
  if [ ! -f "$VIDEO" ]; then
    echo "pipeline.sh: video not found: $VIDEO" >&2
    exit 2
  fi
  VIDEO="$(cd "$(dirname "$VIDEO")" && pwd)/$(basename "$VIDEO")"

  # Experiment: bare name -> experiments/<name>; anything with a "/" is a path from the caller's cwd.
  case "$EXPERIMENT" in
    latest|.|..) echo "pipeline.sh: '$EXPERIMENT' is not a valid experiment name" >&2; exit 2 ;;
    */*) mkdir -p "$EXPERIMENT"; EXP_DIR="$(cd "$EXPERIMENT" && pwd)" ;;
    *)   EXP_DIR="$EXPERIMENTS_DIR/$EXPERIMENT" ;;
  esac
fi

# Bootstrap the virtualenv on first run (or if deps went missing).
if [ ! -x "$VENV/bin/python" ]; then
  echo "pipeline.sh: creating virtualenv at $VENV" >&2
  "$PYTHON" -m venv "$VENV"
fi
if ! "$VENV/bin/python" -c "import google.genai, pydantic" >/dev/null 2>&1; then
  echo "pipeline.sh: installing dependencies" >&2
  "$VENV/bin/python" -m pip install --quiet --upgrade pip
  "$VENV/bin/python" -m pip install --quiet -r "$DETECTION_DIR/requirements.txt"
fi

cd "$BACKEND_DIR"
if [ "$HELP" = 1 ]; then
  # Print this file's leading comment block (minus the shebang) as usage text.
  awk 'NR > 1 && !/^#/ { exit } NR > 1 { sub(/^# ?/, ""); print }' "$SELF"
  echo
  exec "$VENV/bin/python" -m detection.detect --help
fi

# --quiet applies to every stage, not just detect.py.
QUIET=()
for arg in "$@"; do
  if [ "$arg" = "--quiet" ]; then QUIET=(--quiet); break; fi
done

# New run folder: <experiment>/runs/<timestamp>, suffixed _2, _3, ... if two runs land in the same second.
STAMP="$(date +%Y-%m-%d_%H-%M-%S)"
RUN_DIR="$EXP_DIR/runs/$STAMP"
n=1
while [ -e "$RUN_DIR" ]; do
  n=$((n + 1)); RUN_DIR="$EXP_DIR/runs/${STAMP}_$n"
done
mkdir -p "$RUN_DIR"
LOG="$RUN_DIR/run.log"
echo "pipeline.sh: experiment $EXP_DIR" >&2
echo "pipeline.sh: run folder $RUN_DIR" >&2

# Point experiments/latest at this experiment (relative link when it lives under experiments/).
if [ "$(dirname "$EXP_DIR")" = "$EXPERIMENTS_DIR" ]; then
  ln -sfn "$(basename "$EXP_DIR")" "$EXPERIMENTS_DIR/latest"
else
  ln -sfn "$EXP_DIR" "$EXPERIMENTS_DIR/latest"
fi

# Run one stage. Its stdout (the JSON) passes through untouched on fd 3; its stderr is mirrored
# into run.log. Exit status is the stage's, not tee's; a failure stops the pipeline.
exec 3>&1
stage() {
  local name="$1"; shift
  set +e
  "$@" 2>&1 >&3 | tee -a "$LOG" >&2
  local status=${PIPESTATUS[0]}
  set -e
  if [ "$status" -ne 0 ]; then
    echo "pipeline.sh: $name failed (exit $status); see $LOG" >&2
    exit "$status"
  fi
}

# 1. Detect in/out events in this video -> runs/<stamp>/events.json (+ per-video inventory.json).
stage detect.py "$VENV/bin/python" -m detection.detect \
  --video "$VIDEO" \
  --out-dir "$RUN_DIR" \
  --api-key-file "$API_KEY_FILE" \
  "$@"

# 2. Fold those events into the experiment's cumulative inventory.json + events.json.
stage update.py "$VENV/bin/python" -m inventory.update \
  --experiment "$EXP_DIR" \
  --run "$RUN_DIR" \
  --database "$DATABASE" ${QUIET[@]+"${QUIET[@]}"}

# 3. Hours left for everything currently inside -> expire.json.
stage check.py "$VENV/bin/python" -m check_expire.check \
  --database "$DATABASE" \
  --experiment "$EXP_DIR" ${QUIET[@]+"${QUIET[@]}"}

# 4. Recipes from inventory.json + expire.json -> recipes.json.
stage chef.py "$VENV/bin/python" -m chef.chef \
  --experiment "$EXP_DIR" \
  --api-key-file "$API_KEY_FILE" ${QUIET[@]+"${QUIET[@]}"}

exec 3>&-
echo "pipeline.sh: done -> $EXP_DIR" >&2
