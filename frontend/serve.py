#!/usr/bin/env python3
"""Serve the fridge dashboard over backend/experiments/. Standard library only.

    python3 frontend/serve.py                 # http://127.0.0.1:8000, default experiment = experiments/latest
    python3 frontend/serve.py --port 9000
    python3 frontend/serve.py --experiments /elsewhere/experiments

Routes:
    /                                  frontend/public/index.html (+ styles.css, app.js)
    /api/experiments                   {"experiments": [{"name", "updated_at"}, ...], "latest": "<name>"|null}
    /api/experiments/<name>            the four JSON files of one experiment in a single document:
                                       {"name", "now", "updated_at", "inventory", "expire", "recipes", "events"}
                                       (a file that does not exist yet is null)
    /api/experiments/<name>/files/<f>  one raw file: inventory.json, expire.json, recipes.json, events.json,
                                       or runs/<stamp>/{events.json,inventory.json,run.log}
    /images/<file>.png, /images/index.json   icons from backend/db/images/

    POST /api/experiments/<name>/upload?filename=clip.mp4   body = the raw video bytes
        Saves the video under backend/experiments/<name>/uploads/ and queues
        `bash backend/pipeline.sh <video> <name> --quiet`; responds 202 with the job. <name> may be
        a new experiment. Jobs run one at a time (two runs on one experiment would race on its files).
    GET  /api/jobs                     jobs this server has queued (newest first), with a log tail
    GET  /api/jobs/<id>                one job: status queued|running|done|failed, exit_code, log tail,
                                       and once finished `result` = that run's summary + its events
    GET  /api/jobs/<id>/log            the job's full pipeline output as text

Everything is read from disk on every request, so re-running backend/pipeline.sh shows up on the
next poll (the page polls every few seconds and re-renders only when updated_at changes).
Binds to 127.0.0.1 unless --host is given; there is no auth and uploads start a subprocess, so
don't expose it as is.
"""

from __future__ import annotations

import argparse
import datetime as dt
import http.server
import json
import posixpath
import queue
import re
import subprocess
import sys
import threading
import uuid
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlsplit

FRONTEND_DIR = Path(__file__).resolve().parent
PUBLIC_DIR = FRONTEND_DIR / "public"
BACKEND_DIR = FRONTEND_DIR.parent / "backend"
DEFAULT_EXPERIMENTS_DIR = BACKEND_DIR / "experiments"
DEFAULT_IMAGES_DIR = BACKEND_DIR / "db" / "images"
PIPELINE = BACKEND_DIR / "pipeline.sh"

# Same containers detection/detect.py accepts.
VIDEO_EXTS = {".mp4", ".m4v", ".mov", ".qt", ".webm", ".mkv", ".avi", ".mpg", ".mpeg", ".3gp", ".wmv", ".flv"}
MAX_UPLOAD_BYTES = 2 * 1024 ** 3
UPLOAD_CHUNK = 1024 * 1024
LOG_TAIL_CHARS = 6000

EXPERIMENT_FILES = ("inventory", "expire", "recipes", "events")
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$")   # experiment folder names we will serve
# Raw files we hand out from an experiment folder; nothing else (no videos, no dotfiles).
RAW_FILE_RE = re.compile(r"^(?:(?:inventory|expire|recipes|events)\.json"
                         r"|runs/[A-Za-z0-9][A-Za-z0-9._-]{0,99}/(?:events\.json|inventory\.json|run\.log))$")


# ---------------------------------------------------------------------------
# Experiment folder
# ---------------------------------------------------------------------------

def iso(ts: float) -> str:
    return dt.datetime.fromtimestamp(ts).astimezone().isoformat(timespec="seconds")


def read_json(path: Path):
    """Parsed JSON, or None if the file is missing or half-written (pipeline mid-run)."""
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def is_experiment(path: Path) -> bool:
    return path.is_dir() and not path.is_symlink() and any((path / f"{f}.json").is_file() for f in EXPERIMENT_FILES)


def experiment_updated_at(path: Path) -> float:
    return max((p.stat().st_mtime for f in EXPERIMENT_FILES if (p := path / f"{f}.json").is_file()), default=0.0)


def list_experiments(root: Path) -> dict:
    exps = []
    if root.is_dir():
        for child in root.iterdir():
            if NAME_RE.match(child.name) and is_experiment(child):
                exps.append({"name": child.name, "updated_at": iso(experiment_updated_at(child))})
    exps.sort(key=lambda e: e["updated_at"], reverse=True)

    latest = None
    link = root / "latest"
    if link.is_symlink():
        target = link.resolve()
        if target.parent == root.resolve() and is_experiment(target):
            latest = target.name
    if latest is None and exps:
        latest = exps[0]["name"]
    return {"experiments": exps, "latest": latest}


def load_experiment(root: Path, name: str) -> dict | None:
    path = root / name
    if not NAME_RE.match(name) or not is_experiment(path):
        return None
    doc = {
        "name": name,
        "now": dt.datetime.now().astimezone().isoformat(timespec="seconds"),
        "updated_at": iso(experiment_updated_at(path)),
    }
    for f in EXPERIMENT_FILES:
        doc[f] = read_json(path / f"{f}.json")
    return doc


# ---------------------------------------------------------------------------
# Upload -> pipeline jobs
# ---------------------------------------------------------------------------

def now_iso() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def safe_filename(name: str) -> str | None:
    """Basename with anything odd replaced by "_"; None if it is not a video we can process."""
    base = re.sub(r"[^A-Za-z0-9._-]+", "_", Path(name).name).lstrip(".")
    if not base or Path(base).suffix.lower() not in VIDEO_EXTS:
        return None
    return base[:120]


def run_result(experiment_dir: Path, log_text: str) -> dict | None:
    """What the run this log belongs to did, from the experiment's events.json (None if not there yet)."""
    m = re.search(r"^pipeline\.sh: run folder (.+)$", log_text, re.MULTILINE)
    if not m:
        return None
    stamp = Path(m.group(1).strip()).name
    events = read_json(experiment_dir / "events.json") or {}
    summary = next((r for r in events.get("runs", []) if r.get("run") == stamp), None)
    if summary is None:
        return {"run": stamp, "summary": None, "events": []}
    evs = [{"item_id": e.get("item_id"), "object": e.get("object"), "action": e.get("action"), "time": e.get("time")}
           for e in events.get("events", []) if e.get("run") == stamp]
    return {"run": stamp, "summary": summary, "events": evs}


class Jobs:
    """One worker thread runs queued pipeline jobs in order; state is in memory for this server's life."""

    def __init__(self, experiments_dir: Path):
        self.experiments_dir = experiments_dir
        self.lock = threading.Lock()
        self.items: dict[str, dict] = {}
        self.order: list[str] = []            # newest last
        self.q: "queue.Queue[str]" = queue.Queue()
        threading.Thread(target=self._worker, name="pipeline-worker", daemon=True).start()

    def submit(self, experiment: str, video: Path) -> dict:
        job = {
            "id": uuid.uuid4().hex[:12],
            "experiment": experiment,
            "video": video.name,
            "size_bytes": video.stat().st_size,
            "status": "queued",
            "queued_at": now_iso(),
            "started_at": None,
            "finished_at": None,
            "exit_code": None,
            "result": None,
            "error": None,
            "_video_path": video,
            "_log_path": video.with_name(video.name + ".log"),
        }
        with self.lock:
            self.items[job["id"]] = job
            self.order.append(job["id"])
        self.q.put(job["id"])
        return self.public(job)

    def _worker(self) -> None:
        while True:
            job_id = self.q.get()
            with self.lock:
                job = self.items[job_id]
                job["status"] = "running"
                job["started_at"] = now_iso()
            cmd = ["bash", str(PIPELINE), str(job["_video_path"]), job["experiment"], "--quiet"]
            try:
                with open(job["_log_path"], "wb") as log:
                    log.write(f"$ {' '.join(cmd)}\n".encode())
                    log.flush()
                    proc = subprocess.run(cmd, stdout=log, stderr=subprocess.STDOUT, cwd=str(BACKEND_DIR.parent))
                code, error = proc.returncode, None
            except OSError as e:
                code, error = -1, f"could not start pipeline: {e}"
            result = run_result(self.experiments_dir / job["experiment"], self.log_text(job))
            with self.lock:
                job["exit_code"] = code
                job["error"] = error
                job["result"] = result
                job["status"] = "done" if code == 0 else "failed"
                job["finished_at"] = now_iso()

    def log_text(self, job: dict) -> str:
        try:
            return job["_log_path"].read_text(encoding="utf-8", errors="replace")
        except OSError:
            return ""

    def public(self, job: dict, tail: bool = True) -> dict:
        doc = {k: v for k, v in job.items() if not k.startswith("_")}
        if tail:
            text = self.log_text(job)
            doc["log"] = text[-LOG_TAIL_CHARS:]
            doc["log_truncated"] = len(text) > LOG_TAIL_CHARS
        return doc

    def get(self, job_id: str) -> dict | None:
        with self.lock:
            job = self.items.get(job_id)
            return self.public(job) if job else None

    def list(self) -> list[dict]:
        with self.lock:
            return [self.public(self.items[i]) for i in reversed(self.order)]

    def full_log(self, job_id: str) -> str | None:
        with self.lock:
            job = self.items.get(job_id)
        return self.log_text(job) if job else None


JOBS: Jobs | None = None


# ---------------------------------------------------------------------------
# HTTP
# ---------------------------------------------------------------------------

class Handler(http.server.SimpleHTTPRequestHandler):
    experiments_dir: Path = DEFAULT_EXPERIMENTS_DIR
    images_dir: Path = DEFAULT_IMAGES_DIR

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(PUBLIC_DIR), **kwargs)

    # Static files: /images/* comes from db/images (flat folder, so no subpaths), the rest from public/.
    def translate_path(self, path: str) -> str:
        p = urlsplit(path).path
        if p.startswith("/images/"):
            rel = posixpath.normpath(unquote(p[len("/images/"):]))
            if not rel or rel.startswith(".") or "/" in rel:
                return str(self.images_dir / "__forbidden__")
            return str(self.images_dir / rel)
        return super().translate_path(path)

    def do_GET(self) -> None:
        p = urlsplit(self.path).path
        if p == "/api/experiments":
            return self.send_json(list_experiments(self.experiments_dir))
        if p.startswith("/api/experiments/"):
            rest = unquote(p[len("/api/experiments/"):]).rstrip("/")
            name, _, sub = rest.partition("/")
            if not NAME_RE.match(name) or not is_experiment(self.experiments_dir / name):
                return self.send_json({"error": f"no experiment named {name!r}"}, status=404)
            if not sub:
                return self.send_json(load_experiment(self.experiments_dir, name))
            if sub.startswith("files/") and RAW_FILE_RE.match(sub[len("files/"):]):
                return self.send_raw(self.experiments_dir / name / sub[len("files/"):])
            return self.send_json({"error": "not found"}, status=404)
        if p == "/api/jobs":
            return self.send_json({"jobs": JOBS.list()})
        if p.startswith("/api/jobs/"):
            job_id, _, sub = p[len("/api/jobs/"):].partition("/")
            if sub == "log":
                text = JOBS.full_log(job_id)
                return self.send_json({"error": "no such job"}, status=404) if text is None else self.send_text(text)
            job = JOBS.get(job_id)
            return self.send_json({"job": job}) if job else self.send_json({"error": "no such job"}, status=404)
        if p.startswith("/api/"):
            return self.send_json({"error": "not found"}, status=404)
        super().do_GET()

    def do_POST(self) -> None:
        parts = urlsplit(self.path)
        m = re.match(r"^/api/experiments/([^/]+)/upload$", parts.path)
        if not m:
            return self.send_json({"error": "not found"}, status=404)
        name = unquote(m.group(1))
        if not NAME_RE.match(name) or name == "latest":
            return self.send_json({"error": f"{name!r} is not a valid experiment name (letters, digits, . _ -)"}, status=400)
        filename = safe_filename(parse_qs(parts.query).get("filename", [""])[0])
        if filename is None:
            return self.send_json({"error": "filename must be a video: " + ", ".join(sorted(VIDEO_EXTS))}, status=400)
        try:
            length = int(self.headers.get("Content-Length") or 0)
        except ValueError:
            length = 0
        if length <= 0:
            return self.send_json({"error": "empty upload"}, status=400)
        if length > MAX_UPLOAD_BYTES:
            return self.send_json({"error": f"video larger than {MAX_UPLOAD_BYTES // 1024 ** 2} MB"}, status=413)
        if not PIPELINE.is_file():
            return self.send_json({"error": f"{PIPELINE} not found"}, status=500)

        dest_dir = self.experiments_dir / name / "uploads"
        dest_dir.mkdir(parents=True, exist_ok=True)
        dest = dest_dir / f"{dt.datetime.now().strftime('%Y-%m-%d_%H-%M-%S')}_{filename}"
        n = 1
        while dest.exists():
            n += 1
            dest = dest_dir / f"{dt.datetime.now().strftime('%Y-%m-%d_%H-%M-%S')}_{n}_{filename}"

        remaining = length
        try:
            with open(dest, "wb") as out:
                while remaining:
                    chunk = self.rfile.read(min(UPLOAD_CHUNK, remaining))
                    if not chunk:
                        break
                    out.write(chunk)
                    remaining -= len(chunk)
        except OSError as e:
            dest.unlink(missing_ok=True)
            return self.send_json({"error": f"could not save upload: {e}"}, status=500)
        if remaining:
            dest.unlink(missing_ok=True)
            return self.send_json({"error": "upload ended early"}, status=400)

        job = JOBS.submit(name, dest)
        self.log_message("upload %s -> %s (job %s)", filename, dest, job["id"])
        return self.send_json({"job": job}, status=202)

    def send_text(self, text: str) -> None:
        body = text.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_raw(self, path: Path) -> None:
        try:
            body = path.read_bytes()
        except OSError:
            return self.send_json({"error": f"{path.name} not found"}, status=404)
        self.send_response(200)
        self.send_header("Content-Type", "application/json; charset=utf-8" if path.suffix == ".json"
                         else "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def send_json(self, doc, status: int = 200) -> None:
        body = json.dumps(doc, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self) -> None:
        # The page polls; never let the browser cache experiment data or the app itself.
        if not self.path.startswith("/images/"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt: str, *args) -> None:
        # Polling would flood the terminal; only log non-API requests, errors and uploads.
        if self.command == "GET" and self.path.startswith("/api/") and args and str(args[1]).startswith("2"):
            return
        super().log_message(fmt, *args)


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    p = argparse.ArgumentParser(prog="serve.py", description="Serve the fridge dashboard over backend/experiments/.")
    p.add_argument("--host", default="127.0.0.1", help="interface to bind (default: 127.0.0.1)")
    p.add_argument("--port", type=int, default=8000, help="port (default: 8000)")
    p.add_argument("--experiments", type=Path, default=DEFAULT_EXPERIMENTS_DIR,
                   help=f"experiments folder (default: {DEFAULT_EXPERIMENTS_DIR})")
    p.add_argument("--images", type=Path, default=DEFAULT_IMAGES_DIR,
                   help=f"icon folder (default: {DEFAULT_IMAGES_DIR})")
    return p.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    global JOBS
    args = parse_args(argv)
    Handler.experiments_dir = args.experiments.expanduser().resolve()
    Handler.images_dir = args.images.expanduser().resolve()
    JOBS = Jobs(Handler.experiments_dir)
    if not PUBLIC_DIR.is_dir():
        print(f"error: {PUBLIC_DIR} not found", file=sys.stderr)
        return 1
    if not Handler.experiments_dir.is_dir():
        print(f"serve: note: {Handler.experiments_dir} does not exist yet; run backend/pipeline.sh first",
              file=sys.stderr)

    server = http.server.ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"serve: http://{args.host}:{args.port}/  (experiments: {Handler.experiments_dir})", file=sys.stderr)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nserve: stopped", file=sys.stderr)
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
