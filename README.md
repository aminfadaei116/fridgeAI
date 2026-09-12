# FridgeAI

FridgeAI turns a video of someone using a refrigerator into a live inventory. It uses Gemini to identify items entering and leaving the fridge, estimates their expiry dates from a local shelf-life database, and suggests recipes that use the most urgent ingredients first.

The included local web dashboard lets you browse inventory, expiry status, recipes, and scan activity, or upload a video to start a new scan.

## How it works

```text
Fridge video
    │
    ▼
Gemini event detection
    │  items in / items out
    ▼
Inventory + expiry calculation
    │
    ▼
Recipe generation
    │
    ▼
Local Savor dashboard
```

Each scan is saved to a named experiment, so scanning more videos into the same experiment updates its running fridge inventory.

## Requirements

- Python 3.10 or newer (with `venv` support)
- A [Gemini API key](https://aistudio.google.com/app/apikey)
- A video file supported by Gemini, such as `.mp4`, `.mov`, `.webm`, or `.mkv`
- Optional: `ffprobe` (from FFmpeg) for recording video duration

The pipeline creates `backend/detection/.venv` and installs its Python dependencies automatically on first run.

## Quick start

1. Clone the repository and enter it:

   ```bash
   git clone <your-repository-url>
   cd fridgeAI
   ```

2. Provide your Gemini API key. Either export it for the current shell:

   ```bash
   export GEMINI_API_KEY="your-api-key"
   ```

   Or put the key, by itself on one line, in `backend/api_key/Gemini_API.txt`:

   ```bash
   mkdir -p backend/api_key
   printf '%s\n' 'your-api-key' > backend/api_key/Gemini_API.txt
   ```

   The key file is ignored by Git. Do not commit it.

3. Run a scan, giving it an experiment name:

   ```bash
   bash backend/pipeline.sh backend/fridge.mp4 demo
   ```

4. Start the dashboard in a separate terminal:

   ```bash
   python3 frontend/serve.py
   ```

   Open <http://127.0.0.1:8000>. The dashboard defaults to the most recently run experiment.

## Run a scan

```bash
bash backend/pipeline.sh VIDEO EXPERIMENT [--model MODEL] [--fps FPS] [--quiet]
```

For example:

```bash
bash backend/pipeline.sh path/to/fridge-video.mp4 household --fps 2
```

Use the same experiment name for later videos from the same fridge. New items are added, items detected leaving are removed, and existing items retain their original entry time.

Useful options:

- `--model MODEL` selects the Gemini model used for video detection.
- `--fps FPS` controls video sampling frequency during detection (default: `2`).
- `--quiet` suppresses JSON output from the pipeline stages.

You can also use **Fresh scan** in the dashboard to upload a video. Uploads are stored under `backend/experiments/<name>/uploads/` and scans run one at a time.

## Dashboard

The frontend uses only Python's standard library; no frontend install is required.

```bash
python3 frontend/serve.py            # http://127.0.0.1:8000
python3 frontend/serve.py --port 9000
```

The dashboard provides:

- **Today** — urgent items, inventory counts, and the highest-priority recipe.
- **Inventory** — current and removed items, shelf-life matches, expiry times, and status.
- **Recipes** — Gemini-generated recipes that prioritise ingredients nearing expiry.
- **Activity** — scan history, item in/out events, raw JSON, and per-run logs.

For a particular experiment, add `?experiment=<name>` to the dashboard URL.

## Output structure

Each experiment is written under `backend/experiments/<experiment>/`:

```text
backend/experiments/<experiment>/
├── inventory.json       # cumulative items currently in the fridge and removal history
├── events.json          # cumulative in/out events
├── expire.json          # shelf-life matches, expiry timestamps, and status
├── recipes.json         # generated recipes
└── runs/
    └── <timestamp>/
        ├── events.json  # events extracted from this video
        ├── inventory.json
        └── run.log
```

`backend/experiments/latest` is updated to point to the most recently scanned experiment.

## Shelf-life data and icons

`backend/db/expire.json` maps food names to refrigerator shelf life in hours. If an item is reported as unknown, add a suitable entry there so future scans can calculate its expiry time. The name matcher normalizes case, singular/plural forms, and packaging words such as “carton” and “bottle.”

The dashboard icons live in `backend/db/images/`. See [backend/db/README.md](backend/db/README.md) for instructions on updating shelf-life entries and icons.

## Run individual stages

Normally you should use `pipeline.sh`, but the later stages can be re-run for an existing experiment:

```bash
cd backend
python -m check_expire.check --experiment experiments/demo --threshold-hours 48
python -m chef.chef --experiment experiments/demo --count 3
```

Pass `--no-pantry` to `chef.chef` to constrain recipes to fridge items plus water, salt, and pepper.

## Privacy and security

The dashboard binds to `127.0.0.1` and has no authentication. Keep it on a trusted local machine: uploading a video starts the processing pipeline, and videos are sent to Gemini for analysis. Never commit API keys or generated local experiment data.

## Project layout

```text
backend/
├── detection/       # Gemini video analysis
├── inventory/       # merges scan events into a persistent inventory
├── check_expire/    # shelf-life matching and expiry calculation
├── chef/            # Gemini recipe generation
├── db/              # shelf-life database and food icons
└── pipeline.sh      # runs the full workflow
frontend/
├── serve.py         # local HTTP server and scan-upload API
└── public/          # dashboard HTML, CSS, and JavaScript
```
