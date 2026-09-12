"""Command line entry points: serve the app, seed the demo, run a cycle from two files."""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import uvicorn

from backend.config import get_settings


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="fridge", description="Fridge Agent")
    sub = parser.add_subparsers(dest="command", required=True)

    serve = sub.add_parser("serve", help="run the dashboard and API")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=8000)
    serve.add_argument("--reload", action="store_true")

    sub.add_parser("seed", help="reset the fridge to the demo inventory")
    sub.add_parser("digest", help="print today's spoilage briefing")

    cycle = sub.add_parser("cycle", help="run one door cycle from two image files")
    cycle.add_argument("before", type=Path)
    cycle.add_argument("after", type=Path)

    args = parser.parse_args(argv)

    if args.command == "serve":
        uvicorn.run("backend.main:app", host=args.host, port=args.port, reload=args.reload)
        return 0

    from backend.pipeline import FridgePipeline

    fridge = FridgePipeline()

    if args.command == "seed":
        from data.demo_seed import seed_demo_fridge

        print(json.dumps(seed_demo_fridge(fridge.store, fridge.shelf_life), indent=2, default=str))
        return 0

    if args.command == "digest":
        print(json.dumps(fridge.sentinel.digest().model_dump(mode="json"), indent=2))
        return 0

    if args.command == "cycle":
        for path in (args.before, args.after):
            if not path.is_file():
                print(f"no such file: {path}", file=sys.stderr)
                return 1
        result = fridge.process_cycle(args.before, args.after)
        print(
            json.dumps(
                {
                    "added": [i.name for i in result.added],
                    "removed": [i.name for i in result.removed],
                    "questions": result.questions,
                    "ignored": result.ignored,
                },
                indent=2,
            )
        )
        return 0

    return 1


if __name__ == "__main__":
    get_settings()
    raise SystemExit(main())
