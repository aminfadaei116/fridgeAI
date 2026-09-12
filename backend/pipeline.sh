#!/usr/bin/env bash
# Run fridge in/out detection on a video, then the expiry check, then recipe suggestions.
# Results land in backend/experiments/<YYYY-MM-DD_HH-MM-SS>/.
# Works from any cwd; every path below is resolved relative to this file.
#
# Usage:
#   backend/pipeline.sh                  # analyses backend/fridge.mp4
#   backend/pipeline.sh path/to/video.mov   # analyses given video
#   backend/pipeline.sh video.mp4 --fps 5 --model gemini-2.5-flash
#
# Args after the video path go straight to detection/detect.py (see backend/pipeline.sh --help);
# --quiet is also forwarded to the later stages.
#
# Each run folder contains:
#   events.json      what went in/out and when                     (detection/detect.py)
#   inventory.json   net result: what is still inside / removed    (detection/detect.py)
#   expire.json      hours left before each item goes bad          (check_expire/check.py)
#   recipes.json     3 recipes using what's there, expiring first    (chef/chef.py)
#   run.log          everything the scripts printed while running
# backend/experiments/latest is a symlink to the most recent run.
#
# Re-run the later stages on an old run (from inside backend/; hours_left is relative to now):
#   python -m check_expire.check --experiment experiments/<run> [--threshold-hours 48]
#   python -m chef.chef          --experiment experiments/<run> [--count 3] [--no-pantry]
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

HELP=0
if [ "${1:-}" = "-h" ] || [ "${1:-}" = "--help" ]; then
  HELP=1
fi

# First positional arg (not starting with "-") is the video.
# Otherwise default to the bundled test clip (whichever container is present).
if [ $# -gt 0 ] && [ "${1#-}" = "$1" ]; then
  VIDEO="$1"; shift
elif [ "$HELP" = 1 ]; then
  VIDEO=""
else
  VIDEO=""
  for cand in fridge.mp4 fridge.MOV fridge.mov; do
    if [ -f "$BACKEND_DIR/$cand" ]; then VIDEO="$BACKEND_DIR/$cand"; break; fi
  done
  if [ -z "$VIDEO" ]; then
    echo "pipeline.sh: no video given and no backend/fridge.{mp4,MOV,mov} found" >&2
    echo "usage: $SELF [VIDEO] [--model M] [--fps N]" >&2
    exit 2
  fi
fi

# Resolve video to an absolute path relative to the caller's cwd, before we cd.
if [ "$HELP" != 1 ]; then
  if [ ! -f "$VIDEO" ]; then
    echo "pipeline.sh: video not found: $VIDEO" >&2
    exit 2
  fi
  VIDEO="$(cd "$(dirname "$VIDEO")" && pwd)/$(basename "$VIDEO")"
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

# New run folder: experiments/<timestamp>, suffixed _2, _3, ... if two runs land in the same second.
STAMP="$(date +%Y-%m-%d_%H-%M-%S)"
RUN_DIR="$EXPERIMENTS_DIR/$STAMP"
n=1
while [ -e "$RUN_DIR" ]; do
  n=$((n + 1)); RUN_DIR="$EXPERIMENTS_DIR/${STAMP}_$n"
done
mkdir -p "$RUN_DIR"
echo "pipeline.sh: run folder $RUN_DIR" >&2

# Run detect.py. Its stdout (the JSON) passes through untouched; its stderr is mirrored
# into run.log. Exit status is detect.py's, not tee's.
exec 3>&1
set +e
"$VENV/bin/python" -m detection.detect \
  --video "$VIDEO" \
  --out-dir "$RUN_DIR" \
  --api-key-file "$API_KEY_FILE" \
  "$@" 2>&1 >&3 | tee "$RUN_DIR/run.log" >&2
STATUS=${PIPESTATUS[0]}
set -e

ln -sfn "$(basename "$RUN_DIR")" "$EXPERIMENTS_DIR/latest"

if [ "$STATUS" -ne 0 ]; then
  exec 3>&-
  echo "pipeline.sh: detect.py failed (exit $STATUS); see $RUN_DIR/run.log" >&2
  exit "$STATUS"
fi

# Expiry check on the fresh inventory; expire.json goes into the same run folder,
# stderr is appended to the same run.log.
set +e
"$VENV/bin/python" -m check_expire.check \
  --database "$BACKEND_DIR/db/expire.json" \
  --experiment "$RUN_DIR" ${QUIET[@]+"${QUIET[@]}"} 2>&1 >&3 | tee -a "$RUN_DIR/run.log" >&2
STATUS=${PIPESTATUS[0]}
set -e

if [ "$STATUS" -ne 0 ]; then
  exec 3>&-
  echo "pipeline.sh: check.py failed (exit $STATUS); see $RUN_DIR/run.log" >&2
  exit "$STATUS"
fi

# Recipe suggestions from inventory.json + expire.json; recipes.json goes into the run folder.
set +e
"$VENV/bin/python" -m chef.chef \
  --experiment "$RUN_DIR" \
  --api-key-file "$API_KEY_FILE" ${QUIET[@]+"${QUIET[@]}"} 2>&1 >&3 | tee -a "$RUN_DIR/run.log" >&2
STATUS=${PIPESTATUS[0]}
set -e
exec 3>&-

if [ "$STATUS" -ne 0 ]; then
  echo "pipeline.sh: chef.py failed (exit $STATUS); see $RUN_DIR/run.log" >&2
  exit "$STATUS"
fi
echo "pipeline.sh: done -> $RUN_DIR" >&2
