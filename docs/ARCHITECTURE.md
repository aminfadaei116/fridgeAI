# Architecture

## One door cycle, end to end

```
  ┌────────────┐   brightness      ┌──────────────┐   frame pair
  │  webcam    │──── crosses ─────▶│ DoorWatcher  │──── (A, B) ────┐
  │ in fridge  │    threshold      │  (thread)    │                │
  └────────────┘                   └──────────────┘                ▼
                                                        ┌────────────────────┐
                                                        │  FridgePipeline    │
                                                        │  .process_cycle()  │
                                                        └─────────┬──────────┘
                                                                  │
                                    ┌─────────────────────────────┤
                                    ▼                             ▼
                            ┌───────────────┐            ┌─────────────────┐
                            │ VisionAgent   │            │   EventBus      │
                            │ gpt-4o, 1 call│            │  → SSE → UI     │
                            └───────┬───────┘            └─────────────────┘
                                    │ VisionDiff
                                    ▼
                            ┌───────────────┐   confidence ≥ 0.80   ┌──────────┐
                            │ CuratorAgent  │──────── commit ──────▶│  SQLite  │
                            │  (the gate)   │                       └──────────┘
                            └───────┬───────┘   0.25 – 0.80              ▲
                                    │           ask the human            │
                                    │                                    │
                                    ▼ needs a date                       │
                            ┌────────────────┐                           │
                            │ShelfLifeAgent  │── expires_at ─────────────┘
                            │ seed → cache   │
                            │      → model   │
                            └────────────────┘
```

The camera runs on its own thread; the web server runs an event loop. `EventBus.publish` is
safe to call from either, which is why the dashboard updates the instant the door moves.

`process_cycle` is the only path into the inventory, and the simulate endpoint calls the same
function — so the demo path and the real path cannot drift apart.

## One sentence, end to end

```
 "4 guests tonight, vegetarian, keep it under 600 calories"
                        │
                        ▼
              ┌──────────────────┐
              │ ConciergeAgent   │   bounded tool-calling loop, max 4 rounds
              └────────┬─────────┘
                       │
      ┌────────────────┼─────────────────┬──────────────────┐
      ▼                ▼                 ▼                  ▼
 read_inventory   check_expiring     plan_meals        save_profile
      │                │                 │                  │
      │                │                 ▼                  ▼
      │                │          ┌────────────┐      durable, applies
      │                │          │ ChefAgent  │      to every future
      │                │          └─────┬──────┘      plan
      │                │                │ RecipeBoard
      │                │                ▼
      │                │        ┌──────────────────┐
      │                │        │ NutritionAgent   │  a separate pass, so it is
      │                │        └──────────────────┘  not marking its own homework
      ▼                ▼                │
   ───────────────────────────────────────
                       ▼
              reply text + structured recipe cards
```

## Why the pieces sit where they do

**All SQL is in `db.py`.** Nothing else in the codebase writes a query. Changing the schema
means touching one file.

**All OpenAI access is in `llm.py`.** Retries, structured-output binding, the tool loop and the
offline fallback are in one place, so no agent has to think about any of it.

**Agents receive their context, they never construct it.** `AgentContext` carries the store, the
LLM and the settings. That is what lets the whole suite run against a temp database with the
model switched off, in about a second, with no network.

**The contract layer is `schemas.py`.** Every model call is bound to a pydantic model via
structured outputs. Nothing in this system parses prose, so a model that drifts in style cannot
break a downstream feature.

**The curator is deterministic on purpose.** The most interesting behaviour in the demo — the
fridge admitting it is unsure — is a threshold comparison, not a judgement. It is testable, and
it behaves the same on stage as in rehearsal.
