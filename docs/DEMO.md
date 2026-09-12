# The two-minute demo

Rehearse this four times. Record a backup video after the third run and keep it open in a tab.

## Before you start

- [ ] `make seed` — the fridge should show **spinach, mushroom and chicken breast at 1 day left**
- [ ] `make serve`, dashboard open full screen, browser zoom ~110%
- [ ] Camera attached and **Start camera** pressed; the brightness reading should move when you
      wave a hand near the lens
- [ ] Microphone permission already granted (do the first voice prompt once in rehearsal, so the
      browser does not prompt on stage)
- [ ] **Speak replies** toggle on, laptop volume up
- [ ] Props on the table: a bell pepper, a yogurt tub, one thing in opaque packaging
- [ ] Backup video open in a second tab
- [ ] Phone photos of a before/after frame pair saved, in case the camera will not attach —
      the **Simulate a door cycle** button runs the identical pipeline

## The run sheet

| Time | Beat | What you say |
|---|---|---|
| **0:00–0:15** | Dashboard on screen, fridge on the table. Point at the `$7.48` thrown out. | "Canadian households throw out about $1,300 of food a year. Not from carelessness — because nobody knows what's actually in the fridge." |
| **0:15–0:40** | Open the door. Put the **bell pepper** in. Close it. Watch the door pill go amber → blue → the pepper lands on the board. | "There's no door sensor in here. A camera inside a closed fridge sees black, so brightness *is* the sensor. Two frames — door open, door closing — one question to the model: what changed?" |
| **0:40–1:00** | Open, take the **yogurt** out, close. It leaves the inventory and the ledger ticks up. | "Out works the same way. And because it left before its date, that's seven dollars it counts as used rather than wasted." |
| **1:00–1:15** | Open, put the **opaque item** in, close. The confirmation card appears. Press **Yes**. | "This is the part I actually care about. It's 61% sure, and its bar to write something in on its own is 80. So it asks instead of guessing." |
| **1:15–1:35** | Press **Today's briefing**. It speaks. | *(let it talk — the mushroom line lands on its own)* |
| **1:35–1:50** | Type or say: **"Four guests tonight, vegetarian."** Recipe cards appear, tagged `uses spinach`. | "Four guests, vegetarian. It re-plans — and it's still building around the spinach that dies tomorrow, because that's the whole point." |
| **1:50–2:00** | Point at the hero number. | "Thirty dollars used in time this week, seven thrown out. That's the number we're trying to move." |

## If something breaks

| Problem | Do this |
|---|---|
| Camera will not attach | **Simulate a door cycle** with the two phone photos. Same pipeline, same code path — say so out loud, it costs you nothing. |
| Vision misreads the item | Let it. Press **No** on the confirmation and say "and that's why it asks." A demo that handles being wrong is stronger than one that is never wrong. |
| API is slow or the venue wifi dies | Everything still boots. The board, the ledger and the expiry logic are local. Say "the model is offline, here's what it still knows." |
| Voice will not record | Type the same sentence. The chat and voice paths converge on the same concierge turn. |
| Total collapse | Backup video, second tab. |

## Lines worth keeping

- "A camera inside a closed fridge sees black. Brightness *is* the door sensor."
- "It's 61% sure. Its bar is 80. So it asks."
- "Those mushrooms have come out and gone back three times, and they expire tomorrow."
- "Thirty dollars used in time. Seven thrown out."

## What to say if asked "is this actually multi-agent, or one prompt?"

Seven agents, seven contracts in [`schemas.py`](../backend/schemas.py), structured outputs on
every call — nothing in the system parses prose. The concierge exposes the other six as tools
and runs a bounded tool-calling loop; the roster panel on the right lights up to show which
ones ran on the turn you just watched. The nutritionist is deliberately a separate pass from
the chef, because a model asked to score its own recipe marks its own homework.
