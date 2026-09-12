# Savor — fridge dashboard

Read-only viewer for what `backend/pipeline.sh` writes into `backend/experiments/<name>/`:
what is in the fridge, when each item expires, the recipes the chef proposed, and the scan
activity behind it. Nothing on the page is typed in by hand — every number, name and time
comes from `inventory.json`, `expire.json`, `recipes.json` and `events.json`.

## Run

```bash
python3 frontend/serve.py            # → http://127.0.0.1:8000
python3 frontend/serve.py --port 9000
```

Standard library only; no install. Open the address it prints. The page shows
`backend/experiments/latest` by default; pick another experiment from the dropdown at the top
or with `?experiment=<name>`.

## Scan a video from the page

**Fresh scan** (sidebar card, the ⌁ button in the top bar, or the button on the Inventory page)
opens an upload dialog: pick an experiment (existing or a new name) and a video. The server
saves it to `backend/experiments/<name>/uploads/` and runs

```bash
bash backend/pipeline.sh backend/experiments/<name>/uploads/<stamp>_<file> <name> --quiet
```

The dialog shows upload progress, then which stage is running (detect → inventory → expiry →
recipes) with the live pipeline log, and finally what that run saw go in and out — read back
from `events.json`, not from the log. Close the dialog and the sidebar card keeps showing the
scan; reopen it from there. Scans queue one at a time. A failed run shows the log and the
stage that failed; nothing is written to the inventory unless `detect.py` succeeds.

Or run the pipeline yourself while the page is open:

```bash
bash backend/pipeline.sh fridge.mp4 experiment1
```

Either way the page checks the folder every 5 s and re-renders when the files change. "Hours
left" is recomputed from each item's `expires_at` in the browser, so it keeps counting down
between runs.

## Views

| View | Shows | Source |
|------|-------|--------|
| Today | most urgent items, counts, the top recipe | inventory + expire + recipes |
| Inventory | every item in the fridge: shelf-life match, expiry time, time left, status; items taken out | inventory + expire |
| Recipes | the chef's recipes, sorted by how many expiring items they use; ingredients and steps in a modal | recipes (+ inventory for "in fridge" counts) |
| Activity | runs, in/out timeline, links to the raw JSON and each run's `run.log` | events |

Item icons are the PNGs in `backend/db/images/`, keyed by the shelf-life entry `check.py`
matched. An item with no match ("No shelf life") falls back to a keyword emoji.

Step check-marks in a recipe are kept in the browser's `localStorage` only.

## Layout

```
frontend/
  serve.py          HTTP server: static files, /api/experiments[/<name>[/files/<f>]], /images/,
                    POST /api/experiments/<name>/upload, /api/jobs[/<id>[/log]]
  public/
    index.html
    styles.css
    app.js          fetches the API, joins the four files (buildModel), renders the views
```

`serve.py` binds to 127.0.0.1 and has no auth; uploads start `pipeline.sh` (and Gemini calls
on your API key), so keep it on your own machine.
