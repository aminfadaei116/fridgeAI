# Fridge Agent

A camera lives inside the fridge. When you open the door it wakes up, works out what you put in
or took out, and remembers the date. From then on it knows what you have, what is about to
spoil, and what you could cook tonight to stop that happening.

You can also just talk to it. *"Four guests tonight, one is vegetarian"* re-plans dinner around
the spinach that dies tomorrow.

```
┌─ the door opens ─────────────────────────────────────────────────────────────┐
│                                                                              │
│  camera  →  brightness trigger  →  door-cycle clip  →  vision agent          │
│                                                              ↓               │
│                                          "bell pepper in, yogurt out, 0.94"  │
│                                                              ↓               │
│                                                        curator agent         │
│                                            ┌─────────────────┴──────────┐    │
│                                     ≥ 0.80 │                            │    │
│                                       commit                      ask the    │
│                                            │                       human     │
│                                            ↓                               │
│  shelf-life agent  →  expires_at  →  ██ SQLite ██                           │
│                                            │                                │
│              ┌─────────────────────────────┼──────────────────────────┐     │
│              ↓                             ↓                          ↓     │
│      sentinel agent               concierge agent              waste ledger  │
│    "spinach dies tomorrow"     ← you talk to this one →      "$30 used, $7   │
│                                   ↓            ↓               thrown out"   │
│                              chef agent → nutrition agent                    │
│                            "3 dinners, all    "612 kcal,                     │
│                             using the spinach"  fits your target"            │
└──────────────────────────────────────────────────────────────────────────────┘
```

---

## The two decisions that make this work

**1. Watch the crossing, don't diff the shelf.** The whole door cycle is recorded and sent to
the model as one clip, and the question asked is *what crossed the door plane, in or out, and
when?* Not *what do these two photographs disagree about?* Direction is observed rather than
deduced, an item put in and taken straight back out cancels itself, and something hidden behind
the juice carton is still seen crossing. Netting those crossings per item is deterministic code
([`reduce_crossings`](backend/agents/vision.py)), not a second model call. Still one API call
per door cycle, and still no hand tracking to write.

**2. The door sensor is free.** A camera inside a closed fridge sees black. Mean frame
brightness crossing a threshold **is** the door sensor — no wiring, no reed switch, no GPIO.
Two thresholds rather than one, so a shadow or a flickering bulb cannot rattle the state
machine. It is 15 lines in [capture.py](backend/capture.py#L86-L130).

## The thing most demos get wrong

Every other inventory demo pretends to be certain. This one shows its work:

> **"I think a chicken breast went in, but I am only 61% sure. Is that right?"**   `[Yes]` `[No]`

Detections above 0.80 confidence are written automatically. Between 0.25 and 0.80 the fridge
asks. Below 0.25 it says nothing at all, because a guess that bad is not worth interrupting you
for. A human answer is treated as ground truth and stored at confidence 1.0.

That gate lives in [curator.py](backend/agents/curator.py) and it is deliberately **deterministic** —
a threshold comparison, not a judgement call — so it behaves the same way on stage as it did in
rehearsal.

---

## The seven agents

Each one has a single job and a single output contract. All contracts live in
[schemas.py](backend/schemas.py) and are enforced with structured outputs, so nothing in this
system parses prose.

| Agent | Job | Contract |
|---|---|---|
| [`vision`](backend/agents/vision.py) | Watches the door-cycle clip, reports every crossing of the door plane with a confidence each, nets them into what changed | `VisionDiff` |
| [`curator`](backend/agents/curator.py) | Commits, asks, or ignores. Decides whether a departure was money used or money lost | `CurationResult` |
| [`shelf_life`](backend/agents/shelf_life.py) | How long does this keep, what did it cost, how should it be stored | `ShelfLifeVerdict` |
| [`chef`](backend/agents/chef.py) | Meals anchored on whatever is closest to spoiling, respecting diet and servings | `RecipeBoard` |
| [`nutrition`](backend/agents/nutritionist.py) | Independently scores the chef's board against a calorie target | `NutritionReport` |
| [`sentinel`](backend/agents/sentinel.py) | The daily briefing on what is about to go | `DailyDigest` |
| [`concierge`](backend/agents/concierge.py) | The only one you talk to. Routes your sentence to the other six | `ChatReply` |

**Why the nutritionist is separate from the chef.** One model asked to both invent a recipe and
score it will mark its own homework generously. A second pass that sees only the finished
ingredient list will tell you when the number does not land.

**How a sentence becomes work.** The concierge exposes the other agents as tools and runs a
bounded tool-calling loop. *"I'm vegetarian and there are four of us tonight"* becomes a
`save_profile` call (durable, applies to every future plan) **and** a `plan_meals` call in the
same turn. Adding a capability means adding a tool, not rewriting the conversation.

---

## Quickstart

```bash
git clone <this repo> && cd fridgeAI

uv venv --python 3.12
uv pip install -e ".[dev]"

cp .env.example .env.local          # add a key (see Providers below)
.venv/bin/fridge seed               # load a realistic, already-aging fridge
.venv/bin/fridge serve              # http://127.0.0.1:8000
```

### Providers

Either backend runs the whole system. Gemini is reached through its OpenAI-compatible
endpoint, so the provider seam is a base URL and a set of model names — no second client, no
branching in any agent.

```bash
# .env.local — OpenAI
LLM_PROVIDER=openai
OPENAI_API_KEY=sk-...

# .env.local — Gemini
LLM_PROVIDER=gemini
GEMINI_API_KEY=AIza...
```

`BASE_URL_OVERRIDE` points the same client at a LiteLLM proxy, an Azure OpenAI deployment, or
anything else OpenAI-compatible.

**One difference that matters.** Gemini's compatible surface serves no `/audio/*` endpoints, so
Whisper and TTS are unavailable there. The dashboard detects this from `/api/state` and falls
back to the browser's own Web Speech API for both dictation and playback — free, offline, and
the voice demo still works. Chrome and Edge support dictation; Firefox does not, so on Firefox
with Gemini you type instead.

| | OpenAI | Gemini |
|---|---|---|
| Vision diff, recipes, chat, tool calling | yes | yes |
| Structured outputs | strict schemas | strict schemas |
| Voice in / out | Whisper + TTS | browser Web Speech API |

No camera? The dashboard's **Simulate a door cycle** button takes two photos from your phone
and runs the identical pipeline. No API key? Everything still boots — the agents degrade to
honest offline behaviour rather than inventing results.

```bash
.venv/bin/fridge serve --reload     # dashboard + API
.venv/bin/fridge seed               # reset to the demo fridge
.venv/bin/fridge digest             # today's briefing, as JSON
.venv/bin/fridge cycle a.jpg b.jpg  # one door cycle from two files
```

---

## Design decisions worth defending

**Urgency never rides on colour alone.** Running the palette validator on the obvious
red/amber/green scheme returns a deuteranopia separation of ΔE 4.1 between "spoils today" and
"fresh" — invisible to roughly 1 in 12 men. So every row in the expiry board carries three
channels: the status colour, a distinct glyph (`■ ▲ ●`), and the day count spelled out in
words. Colour is confirmation, never the message.

**The menu arrives on its own.** Breakfast, lunch and dinner with two options each are
built every day around whatever is closest to spoiling — you never have to ask. A full board
is two model calls over the whole fridge, so it is cached per day and `/api/today` returns in
about 15ms; a miss starts a background plan and the dashboard fills in when `plan_ready`
arrives on the event stream. The board is invalidated by the date rolling over **and** by the
fridge changing, because a menu built around spinach is the wrong menu once the spinach has
been eaten. A door cycle that commits a change re-plans automatically.

**Shelf life is seeded, not asked.** [54 common foods](data/shelf_life_seed.json) ship with the
repo with their fridge life, typical cost and a storage tip. A cache miss falls through to a
model call and is then cached forever. Putting a pepper on the board never waits on a network
round trip, and raw chicken always resolves to the 2-day food-safety number rather than an
optimistic one.

**Used-versus-wasted is a date comparison.** When something leaves the fridge before its date,
the ledger books its cost as *used in time*. After its date, *thrown out*. That is a rule, not
an opinion, which is why the dollar figure on screen means something.

**Evidence, not nagging.** The fridge tracks how many times an item has been picked up and put
back, so the briefing can say *"those mushrooms have come out and gone back three times and
they expire tomorrow."* Every agent prompt is explicitly instructed to comment on food, dates
and money — never on the person's habits, weight or discipline. A calorie target is an input,
not an opening for an opinion.

---

## API

| Method | Route | What it does |
|---|---|---|
| `GET` | `/api/state` | Everything the dashboard paints, in one call |
| `GET` | `/api/stream` | Server-sent events — this is what makes the door cycle appear live |
| `POST` | `/api/door/simulate` | Run the real pipeline on an uploaded door-cycle clip |
| `POST` | `/api/camera/start` · `/stop` | Attach to the fridge camera |
| `POST` | `/api/chat` | One conversational turn through the concierge |
| `POST` | `/api/voice` | Speak to it: transcribe → route → reply |
| `POST` | `/api/speak` | Text to speech for the reply |
| `POST` | `/api/plan` | The form-shaped twin of asking the chef in the chat |
| `GET` | `/api/today` | Today's menu — cached, returns instantly, replans in the background |
| `GET` | `/api/digest` | Today's spoilage briefing |
| `POST` | `/api/pending/{id}` | Answer a question the curator asked |
| `POST` | `/api/items` · `DELETE /api/items/{id}` | Manual override when the camera is wrong |
| `POST` | `/api/items/{id}/discard` | Log something as thrown out |
| `GET` | `/api/agents` | The roster and what each one does |
| `POST` | `/api/demo/seed` | Reset to the demo fridge |

## Tests

```bash
.venv/bin/python -m pytest      # 98 tests, ~2s, no API key and no network
.venv/bin/ruff check . && .venv/bin/ruff format --check .
```

The suite covers the deterministic core — the confidence gate, the used-versus-wasted rule,
expiry arithmetic, FIFO matching, the brightness threshold, the crossing reducer — plus the
model plumbing against a
stub client, which proves that structured output binds to the right schema and that a
tool-calling turn really dispatches and feeds results back. LLM *judgement* is not asserted on;
what is asserted is that every agent degrades honestly when the model is unreachable.

## Layout

```
backend/
  agents/        the seven specialists, one file each
  capture.py     brightness door trigger + clip recording
  pipeline.py    one door cycle in, one committed change out
  db.py          all SQL lives here, nowhere else
  schemas.py     the contract every agent speaks
  llm.py         the only place that talks to a model provider
  main.py        FastAPI; every route is a few lines
frontend/        savor dashboard - vanilla HTML/CSS/JS, three views, no build step
docs/DESIGN.md   the visual spec the dashboard is built to
data/            shelf-life seed table + the demo fixture
docs/DEMO.md     the two-minute run sheet
```

## Honest limitations

- Vision accuracy depends on lighting and packaging. A $5 LED strip inside the fridge is the
  single highest-leverage improvement, and the confidence gate exists precisely because this
  will sometimes be wrong.
- Quantities are coarse. "3 bell peppers" is tracked; half a pepper going back in is not.
- Costs are typical Canadian retail figures from the seed table, not your actual receipts.
- Shelf life is a guideline from the date it entered the fridge. It does not know how long
  something sat in a hot car first.
