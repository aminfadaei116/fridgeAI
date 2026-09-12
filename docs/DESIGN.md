# savor · visual spec

Implemented in `frontend/`. Source: the Claude Design "Savor Fridge Agent" prototype
(2026-09-12), re-cut to a sidebar layout from a second round of design stills (2026-09-12).
The prototype's internal templating runtime (`<sc-for>`, `{{ }}`, `DCLogic`) was deliberately
not ported — it was read as markup plus data and rewritten against the live API.

## Shape of the app

A fixed left rail over three views, switched client-side with no reload. The rail carries the
brand, the three destinations, the Fresh scan call to action, and who the kitchen belongs to.

| View | What it is |
|---|---|
| **Today** | The hero (what to eat first), the urgent shortlist, the menu, and a right column: quick actions, tonight's idea, ledger, household, activity, agents |
| **Inventory** | Everything tracked as rows, searchable and filterable by category, plus add-by-hand and the urgency key |
| **Meal plan** | Best matches as expandable rows, a plan-tonight promo, and the week strip |

The page head is the greeting, not the alarm: a small-caps eyebrow (`GOOD AFTERNOON, AMIR`), a
large Fraunces heading that stays put per view, a subheading derived from live state, and a
date or at-risk chip. The urgent count moved into the Today hero, which is where the live
number now lives (`3 ingredients are at their best right now.`).

## Type

Fraunces for display — headings, card titles, recipe names. Figtree for everything else. Both
are already loaded for the team section, so the sidebar layout added no new font request.

## Palette

Warm cream paper, deep green accent. Cards float on the paper rather than sitting in boxes.

| Role | Value |
|---|---|
| Paper | `#f4f2ea` · rail `#eeeee6` |
| Hero / promo | deep green `#10513a` on white; green block `#e3f0e4` |
| Card | `#fffcf7` · inner card `#ffffff` · wash `#f2f5ed` |
| Ink | `#17342d` · secondary `#40584f` · muted `#779087` / `#8a9a92` |
| Green | `#18714d` · dark `#0e4736` · mid `#3c6a56` |
| Green surfaces | tint `#e4f2e8` · soft `#dcefe2` · block `#daeeda` · edge `#c6ddcd` |
| Lines | `#e5e8df` · `#edf0e9` · `#eff0eb` |
| Shadow | `0 5px 22px rgba(28,61,48,.035)`, lifted `.05` |

## Urgency — the hard requirement

Urgency is never carried by colour alone. Three channels on every indicator: colour, a
distinct shape, and the day count written in words. Running the palette validator on the
obvious red/green scheme returns a deuteranopia separation of ΔE 4.1 — invisible to roughly
1 in 12 men.

| Tier | days_left | Shape | Colour | Left rule | Words |
|---|---|---|---|---|---|
| Critical | 0–1 | Triangle (9px sides, 15px bottom) | `#c2453f`, text `#b8443d`, tint `#fdeeec` | 6px solid | "Today", "Tomorrow" |
| Warning | 2–3 | Diamond (13px square, rotated 45°) | `#b3761b`, text `#8f5e11`, tint `#fdf4e3` | 6px dashed | "2 days", "3 days" |
| Fine | 4+ | Hollow circle (13px, 2.5px border) | `#18714d`, tint `#eaf3ec` | 6px solid `#dde3d8` | "4 days" and up |

## Type

System stack throughout; `ui-monospace` for labels, timestamps and eyebrows (uppercase,
`0.12em` tracking). Headings 700 weight with `-0.03em` tracking; the hero figure
`clamp(38px, 5.2vw, 56px)` at `-0.045em`; page heading `clamp(30px, 4vw, 46px)` at `-0.04em`.
Body 15px at 1.5, global tracking `-0.011em`.

## Motion

`arrive` (new items and panels), `leave`, `pulse` (door dot, thinking dot), `sweep` (the bar
crossing the door banner), `fade` (view change). All suppressed under
`prefers-reduced-motion`.

## Layout

A `224px` rail beside a `minmax(0,1.5fr) / minmax(0,1fr)` split. Three breakpoints: at 1080px
the split collapses to one column, at 860px the rail becomes a horizontal bar above the page
and its labels drop to icons, at 560px the quick-action tiles stack. No horizontal scroll at
any width.

Inventory and the Today shortlist share one row component. The only difference is the `×`,
which Inventory gets and the shortlist does not — an urgent list should read as a list, not a
control panel.

## Assets

**Food imagery is emoji**, looked up by exact name, then by any word in the name, then by
category (`produce 🥗 · dairy 🥛 · meat 🍖 · seafood 🐟 · bakery 🍞 · pantry 🥫 ·
leftovers 🍲 · beverage 🧃 · condiment 🧂 · other 📦`). No network call, no CDN — the demo
must not be able to fail because an image host is slow.

**Intake photos are real.** Every item carries `frame_ref`, the frame the camera captured when
it went in, served from `/api/frames/{name}` and shown as a thumbnail overlapping the icon
tile, plus an 84×62 slot in the expanded row.

---

## Deviations from the prototype

**No demo-state switcher.** The prototype's Resting / Unsure / Door open / Empty chips are a
design harness. All four states are reachable for real — seed the fridge, run a door cycle,
empty it — so shipping a switcher that fakes them onto a projector would be a liability.

**The intake photo shows nothing when there is no photo.** The prototype striped every slot
because it had no real frames. We have them, so the thumbnail appears only when one exists.
A permanent stripe on every card read as a smudge. Layout is identical either way.

**"Eat these next" is a shortlist, not the whole fridge.** The prototype rendered every item
into that card. With a real fridge that is a wall of rows and it buries the menu beneath it,
so Today shows the six most urgent and Inventory holds the rest.

**Quantities are pluralised.** "2 piece" reads as a typo on the most urgent card.

**Search and add-by-hand are wired.** The prototype showed them as static placeholders.

## Provenance

Designed in Claude Design, exported as a handoff bundle, rebuilt against the live API in plain
HTML, CSS and vanilla JS — no framework, no build step.
