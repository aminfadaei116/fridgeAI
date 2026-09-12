"""HTTP surface. Thin by design: every route is a few lines that hand off to an agent."""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import tempfile
from contextlib import asynccontextmanager, suppress
from pathlib import Path

from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from backend.config import REPO_ROOT, get_settings
from backend.events import bus
from backend.llm import LLMUnavailable
from backend.pipeline import FridgePipeline
from backend.schemas import Category, DetectedItem, ItemStatus, MealRequest

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s")
logger = logging.getLogger(__name__)

FRONTEND_DIR = REPO_ROOT / "frontend"

pipeline: FridgePipeline | None = None


def get_pipeline() -> FridgePipeline:
    if pipeline is None:
        raise HTTPException(status_code=503, detail="pipeline not ready")
    return pipeline


@asynccontextmanager
async def lifespan(app: FastAPI):
    global pipeline
    bus.bind_loop(asyncio.get_running_loop())
    pipeline = FridgePipeline()
    logger.info("fridge agent ready (model access: %s)", pipeline.ctx.llm.available)
    yield
    if pipeline:
        pipeline.stop_camera()


app = FastAPI(title="Fridge Agent", version="0.1.0", lifespan=lifespan)


# --- request bodies -----------------------------------------------------------


class ChatBody(BaseModel):
    text: str


class ManualItemBody(BaseModel):
    name: str
    quantity: float = 1.0
    unit: str = "unit"
    category: Category = Category.OTHER


class ConfirmBody(BaseModel):
    confirmed: bool


class SpeakBody(BaseModel):
    text: str


class PlanBody(MealRequest):
    options_per_meal: int = 2


# --- state --------------------------------------------------------------------


@app.get("/api/state")
def read_state() -> dict:
    """Everything the dashboard paints, in one call."""
    fridge = get_pipeline()
    store = fridge.store
    settings = get_settings()
    inventory = store.list_inventory()

    return {
        "inventory": [item.model_dump(mode="json") for item in inventory],
        "expiring": [
            item.model_dump(mode="json")
            for item in store.expiring_within(settings.expiring_soon_days)
        ],
        "pending": [p.model_dump(mode="json") for p in store.list_pending()],
        "ledger": {
            **store.ledger_totals().model_dump(),
            "entries": store.ledger_entries(limit=8),
        },
        "events": store.recent_events(limit=20),
        "profile": store.get_profile(),
        "messages": store.recent_messages(limit=20),
        "camera": fridge.camera_status(),
        "model_available": fridge.ctx.llm.available,
        "provider": {
            "name": settings.llm_provider,
            "model": settings.reasoning_model,
            # False on Gemini: it has no /audio/* endpoints, so the browser speaks instead.
            "server_audio": settings.supports_audio_endpoints,
        },
    }


@app.get("/api/stream")
async def stream(request: Request) -> StreamingResponse:
    """Server-sent events. This is what makes the door cycle show up live on screen."""
    queue = bus.subscribe()

    async def generator():
        try:
            yield 'data: {"kind": "connected", "data": {}}\n\n'
            while True:
                if await request.is_disconnected():
                    break
                try:
                    message = await asyncio.wait_for(queue.get(), timeout=15.0)
                    yield f"data: {message}\n\n"
                except TimeoutError:
                    yield ": keepalive\n\n"
        finally:
            bus.unsubscribe(queue)

    return StreamingResponse(
        generator(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


# --- camera and door ----------------------------------------------------------


@app.post("/api/camera/start")
def camera_start() -> dict:
    fridge = get_pipeline()
    started = fridge.start_camera()
    return {"started": started, **fridge.camera_status()}


@app.post("/api/camera/stop")
def camera_stop() -> dict:
    fridge = get_pipeline()
    fridge.stop_camera()
    return fridge.camera_status()


@app.post("/api/door/simulate")
def simulate_door_cycle(
    frame_before: UploadFile = File(...), frame_after: UploadFile = File(...)
) -> dict:
    """Run the real pipeline on an uploaded frame pair.

    Same code path as the camera - this exists so the system can be demonstrated and tested
    without a fridge on the table.
    """
    fridge = get_pipeline()
    path_before = _persist_upload(frame_before, "sim-before")
    path_after = _persist_upload(frame_after, "sim-after")
    result = fridge.process_cycle(path_before, path_after)
    return {
        "added": [i.model_dump(mode="json") for i in result.added],
        "removed": [i.model_dump(mode="json") for i in result.removed],
        "questions": result.questions,
        "ignored": result.ignored,
    }


@app.get("/api/frames/{name}")
def get_frame(name: str) -> FileResponse:
    """Serve a captured frame so the dashboard can show what the agent actually looked at."""
    path = (get_settings().frame_dir / name).resolve()
    frame_dir = get_settings().frame_dir.resolve()
    if frame_dir not in path.parents or not path.is_file():
        raise HTTPException(status_code=404, detail="frame not found")
    return FileResponse(path, media_type="image/jpeg")


# --- inventory ----------------------------------------------------------------


@app.post("/api/items")
def add_item(body: ManualItemBody) -> dict:
    """Manual add - the override for when the camera gets it wrong."""
    fridge = get_pipeline()
    detected = DetectedItem(
        name=body.name.lower().strip(),
        category=body.category,
        quantity=body.quantity,
        unit=body.unit,
        confidence=1.0,
        note="entered by hand",
    )
    item = fridge.curator.commit_add(detected)
    bus.publish("inventory_changed", {"added": [item.model_dump(mode="json")], "removed": []})
    _replan_after_change(fridge)
    return item.model_dump(mode="json")


@app.delete("/api/items/{item_id}")
def remove_item(item_id: int, reason: str = "removed by hand") -> dict:
    fridge = get_pipeline()
    match = next((i for i in fridge.store.list_inventory() if i.id == item_id), None)
    if match is None:
        raise HTTPException(status_code=404, detail="item not in the fridge")
    fridge.curator.commit_remove(match)
    bus.publish("inventory_changed", {"added": [], "removed": [match.model_dump(mode="json")]})
    _replan_after_change(fridge)
    return {"removed": match.name, "reason": reason}


@app.post("/api/items/{item_id}/discard")
def discard_item(item_id: int) -> dict:
    """Thrown out. Goes on the ledger as a loss regardless of the date."""
    fridge = get_pipeline()
    match = next((i for i in fridge.store.list_inventory() if i.id == item_id), None)
    if match is None:
        raise HTTPException(status_code=404, detail="item not in the fridge")
    fridge.store.mark_removed(match.id, ItemStatus.DISCARDED)
    fridge.store.record_ledger(match.name, "wasted", match.est_cost, "thrown out", match.id)
    bus.publish("inventory_changed", {"added": [], "removed": [match.model_dump(mode="json")]})
    _replan_after_change(fridge)
    return {"discarded": match.name, "cost": match.est_cost}


@app.post("/api/pending/{pending_id}")
def resolve_pending(pending_id: int, body: ConfirmBody) -> dict:
    """The human answers the question the curator asked."""
    fridge = get_pipeline()
    item = fridge.curator.resolve_pending(pending_id, body.confirmed)
    bus.publish(
        "inventory_changed",
        {"added": [item.model_dump(mode="json")] if item and body.confirmed else [], "removed": []},
    )
    return {"resolved": pending_id, "confirmed": body.confirmed}


# --- agents -------------------------------------------------------------------


@app.get("/api/digest")
def daily_digest() -> dict:
    return get_pipeline().sentinel.digest().model_dump(mode="json")


@app.get("/api/today")
def todays_plan(refresh: bool = False) -> dict:
    """Today's meal board.

    Returns instantly. A valid cached plan comes back as `ready`; anything else starts a
    background generation and returns `planning`, with `plan_ready` following on the event
    stream. The dashboard must never block for the 30-60s a full board takes to build.
    """
    fridge = get_pipeline()

    if not refresh:
        cached = fridge.cached_plan()
        if cached is not None:
            return {"status": "ready", "plan": cached}

    if not fridge.store.list_inventory():
        return {"status": "empty", "plan": None}
    if not fridge.ctx.llm.available:
        return {"status": "offline", "plan": None}

    started = fridge.plan_today_async()
    return {"status": "planning", "plan": None, "already_running": not started}


@app.post("/api/plan")
def plan_meals(body: PlanBody) -> dict:
    """Structured cooking request - the form-shaped twin of asking in the chat."""
    fridge = get_pipeline()
    request = MealRequest(**body.model_dump(exclude={"options_per_meal"}))
    board = fridge.chef.propose(
        request,
        options_per_meal=body.options_per_meal,
        profile=fridge.store.get_profile(),
    )
    nutrition = fridge.nutritionist.review(board.recipes, request)
    return {
        "recipes": [r.model_dump(mode="json") for r in board.recipes],
        "nutrition": nutrition.model_dump(mode="json"),
    }


@app.post("/api/chat")
def chat(body: ChatBody) -> dict:
    text = body.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="empty message")
    reply = get_pipeline().concierge.chat(text)
    bus.publish("chat", {"role": "assistant", "content": reply.reply})
    return reply.model_dump(mode="json")


@app.post("/api/voice")
def voice(audio: UploadFile = File(...)) -> dict:
    """Speak to the fridge: transcribe, route through the concierge, answer."""
    fridge = get_pipeline()
    if not fridge.ctx.llm.available:
        raise HTTPException(status_code=503, detail="voice needs a model key")

    path = _persist_upload(audio, "voice", suffix=".webm")
    try:
        transcript = fridge.ctx.llm.transcribe(path)
    except LLMUnavailable as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        logger.warning("transcription failed: %s", exc)
        raise HTTPException(status_code=502, detail="could not transcribe that") from exc
    finally:
        with suppress(OSError):
            path.unlink()

    if not transcript:
        return {"transcript": "", "reply": "I did not catch that.", "agents_called": []}

    bus.publish("chat", {"role": "user", "content": transcript})
    reply = fridge.concierge.chat(transcript)
    bus.publish("chat", {"role": "assistant", "content": reply.reply})
    return {"transcript": transcript, **reply.model_dump(mode="json")}


@app.post("/api/speak")
def speak(body: SpeakBody) -> Response:
    fridge = get_pipeline()
    if not fridge.ctx.llm.available:
        raise HTTPException(status_code=503, detail="speech needs a model key")
    try:
        audio = fridge.ctx.llm.speak(body.text)
    except LLMUnavailable as exc:
        # Expected on a provider with no /audio/* endpoints; the dashboard then speaks
        # in the browser instead. Say which, rather than a generic failure.
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        logger.warning("speech synthesis failed: %s", exc)
        raise HTTPException(status_code=502, detail="could not synthesise speech") from exc
    return Response(content=audio, media_type="audio/mpeg")


@app.get("/api/agents")
def list_agents() -> dict:
    """The roster, for the dashboard panel that shows who did what."""
    fridge = get_pipeline()
    roster = [
        fridge.vision,
        fridge.curator,
        fridge.shelf_life,
        fridge.chef,
        fridge.nutritionist,
        fridge.sentinel,
        fridge.concierge,
    ]
    return {"agents": [{"name": a.name, "role": a.role} for a in roster]}


# --- demo ---------------------------------------------------------------------


@app.post("/api/demo/seed")
def seed_demo() -> dict:
    from data.demo_seed import seed_demo_fridge

    fridge = get_pipeline()
    summary = seed_demo_fridge(fridge.store, fridge.shelf_life)
    bus.publish("inventory_changed", {"added": [], "removed": [], "reseeded": True})
    return summary


# --- helpers and static -------------------------------------------------------


def _replan_after_change(fridge: FridgePipeline) -> None:
    """The menu is built around what spoils first, so any change to the fridge invalidates it."""
    if fridge.ctx.llm.available:
        fridge.plan_today_async()


def _persist_upload(upload: UploadFile, label: str, suffix: str | None = None) -> Path:
    suffix = suffix or Path(upload.filename or "").suffix or ".jpg"
    frame_dir = get_settings().frame_dir
    frame_dir.mkdir(parents=True, exist_ok=True)
    fd, name = tempfile.mkstemp(dir=frame_dir, prefix=f"{label}-", suffix=suffix)
    with os.fdopen(fd, "wb") as handle:
        shutil.copyfileobj(upload.file, handle)
    return Path(name)


@app.get("/")
def index() -> FileResponse:
    return FileResponse(FRONTEND_DIR / "index.html")


if FRONTEND_DIR.exists():
    app.mount("/static", StaticFiles(directory=FRONTEND_DIR), name="static")
