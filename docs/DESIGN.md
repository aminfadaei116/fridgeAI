<!-- Visual spec for the dashboard, from the Claude Design handoff (2026-09-12).
     Implemented in frontend/. Where the build deviates, the deviations are listed at
     the bottom of this file. -->

# Handoff: Fridge Agent dashboard

## Overview
Fridge Agent is a camera-in-the-fridge app: the camera wakes on the door switch, compares
before/after frames, works out what went in or came out, and tracks what is about to spoil.
Seven agents (vision, curator, shelf_life, chef, nutrition, sentinel, concierge) do the work.
This handoff covers the redesigned dashboard: light theme, two columns on desktop, one
column at 400px, big numbers readable from across a room. It is built for a live hackathon
demo judged on a projector in two minutes.

## About the design files
`Fridge Agent.dc.html` in this bundle is a **design reference created in HTML** — a prototype
showing the intended look and behavior, not production code to copy. The task is to recreate
it in the target codebase's existing environment using its established patterns. The stated
tech constraints for the demo build are: plain HTML + CSS + vanilla JS, no React, no build
step, no Tailwind, system font stack, works offline (no image CDN). If you are implementing
inside an existing app instead, follow that app's conventions and keep the visual spec below.

Note the prototype file uses a small internal templating runtime (`<sc-for>`, `<sc-if>`,
`{{ }}` holes, a `Component` logic class). **Do not port that runtime.** Read it as markup +
data and rewrite the loops/conditionals in your target environment.

## Fidelity
**High fidelity.** Colors, type sizes, spacing, radii, shapes and copy are final. Recreate
pixel-accurately. The one deliberately unfinished element is imagery: food icons are emoji
(final choice), and real fridge-camera photos are striped placeholders.

## Screens / views

The prototype is a canvas holding five artboards, top to bottom:

### 1. Urgency system legend (documentation, not a shipped screen)
Three cards, `repeat(auto-fit, minmax(300px, 1fr))`, 16px gap, showing the three tiers.
Ship the *system*, not the legend.

### 2. Main dashboard — desktop, 1280px fixed frame
Frame: white, `border: 1px solid oklch(0.9 0.008 85)`, `border-radius: 22px`,
`box-shadow: 0 22px 60px -30px oklch(0.4 0.02 85 / 0.4)`, `overflow: hidden`.
The frame is intentionally NOT `max-width: 100%` in the prototype (the canvas pans); in a real
app the frame is the page and the two-column body should be fluid with `minmax(0, …)` tracks.

Vertical order:

**a. Header** — `padding: 22px 32px`, bottom border `1px solid oklch(0.93 0.008 85)`,
flex, space-between.
- Left: "Fridge Agent" 19px/680 weight, `letter-spacing: -0.02em`; beside it a mono 12px
  status line — `last scan 14:12:58 · 7 items tracked` / `scanning now` / `no scans yet`.
- Right: mono 11.5px uppercase household profile `2 adults · no shellfish · 2 100 kcal target`,
  then a door pill: 1px border `oklch(0.88 0.01 85)`, `border-radius: 999px`, `padding: 6px 13px`,
  8px dot + label. Closed = grey dot `oklch(0.7 0.02 85)`; open = `oklch(0.55 0.12 240)`
  with `pulse 1s infinite`.

**b. Door-open banner** (only in the door state) — background `oklch(0.96 0.03 240)`,
bottom border `oklch(0.86 0.04 240)`, `padding: 18px 32px`. Contains:
- A 22%-wide absolutely-positioned white gradient bar sweeping left to right,
  `animation: sweep 1.5s linear infinite` (`translateX(-100%) → translateX(320%)`).
- "Door open" 26px/680, then 16px `Comparing frames — 4 s elapsed, 2 changes detected`.
- Three 9px dots at the right, `pulse 1s infinite` staggered 0s / 0.2s / 0.4s.

**c. Focal stat band** — three equal flex cells, `padding: 26px 32px`, 1px dividers.
Numbers are **58px / weight 700 / line-height 1 / letter-spacing -0.04em**; captions 16px
`oklch(0.45 0.015 85)` with 8px top margin.
1. `2` (count of `days_left === 0`) — "items spoil today" (singular form when 1; empty state
   shows `0` / "items tracked").
2. `$30.15` in `oklch(0.5 0.13 150)` — "saved in 7 days · 5 items eaten in time".
3. `$7.48` in `oklch(0.5 0.14 28)` — "wasted in 7 days · 2 items binned".

**d. Body** — `display: grid; grid-template-columns: minmax(0,1.5fr) minmax(0,1fr)`, no gap,
1px divider between columns. Right column background `oklch(0.985 0.006 85)`. Both columns
`padding: 28px 32px 34px`.

**Left column**
- *Confirmation card* (unsure state only) — see screen 3.
- Section head "Eat these next" 21px/660 + mono 12px right-aligned count
  (`7 items · sorted by days left`; in the door state `… · just added at the top`).
- *Empty state* (empty state only) — see screen 5.
- **Item card**, one per inventory item, 10px bottom margin:
  - `border: 1px solid <tier.border>`, `border-left: <tier.rule>`, `border-radius: 16px`,
    white, `padding: 16px 18px`.
  - Left: 58px square, `border-radius: 14px`, background `<tier.tint>`, centred 30px emoji.
    Overlapping its bottom-right corner (`right: -7px; bottom: -7px`) a **26px rounded square
    with a 2px white border** — this is where the fridge-camera intake photo thumbnail goes.
    Currently a 135° 3px/3px stripe placeholder. Layout must not depend on the photo existing.
  - Middle: item `name` 20px/640; mono 12px uppercase `category`; then 14.5px
    `{quantity} {unit} · ${est_cost} · <removal note>`.
  - Right: tier shape, then the day count in words at 19px/660 in the tier colour with
    `min-width: 88px; text-align: right`, then a 34px square +/− expand button
    (1px `oklch(0.9 0.01 85)`, radius 10px).
  - Expanded: top border, then an 86×64 striped **intake-photo slot** (mono 8.5px caption
    "intake photo"), beside a mono 11px uppercase label `shelf_life · storage tip`, the
    `storage_tip` at 15px/1.5, and mono 12px `expires {expires_at} · shelf life {n} days`.
  - Removal note copy, derived from `removal_count`: `>= 2` → "picked up 6× and still here";
    `=== 1` → "picked up once"; `0` → "not touched since intake".
- Section head "Cooks with what spoils today" + recipe cards (see screen 4).

**Right column** (28px gap between blocks, each block headed by mono 11.5px uppercase label
`oklch(0.55 0.02 85)`):
- `waste ledger · 7 days` — rows of `item_name` (15px/600) / `reason` (13.5px) /
  signed amount (15px/640, green `oklch(0.45 0.11 150)` for `kind: "saved"`, red
  `oklch(0.5 0.14 28)` for `wasted`), 1px bottom rule, `padding: 9px 0`.
- `activity` — mono 12px timestamp + 14.5px text per entry.
- `ask the fridge` — white card, radius 16px: user bubble right-aligned
  (`oklch(0.95 0.01 85)`, radius `14px 14px 4px 14px`), assistant bubble left
  (`oklch(0.97 0.012 240)`, 1px `oklch(0.92 0.02 240)`, radius `14px 14px 14px 4px`),
  under it mono 10.5px pills naming the agents that ran on that turn. Input row: faux text
  field ("Ask about what's inside…") + 44px circular mic button.
- `seven agents` — mono 12.5px name (86px column) + 14px one-line role, 1px rule per row.

### 3. The confirmation ("unsure") card
The demo's key beat. Lives at the top of the left column, `animation: arrive 500ms ease-out both`.
- `border: 1px solid oklch(0.8 0.06 240)`, background `oklch(0.985 0.012 240)`,
  `border-radius: 18px`, `padding: 24px 26px`, flex row, 22px gap.
- 74px rounded tile (`oklch(0.95 0.02 240)`) with the candidate food emoji at 38px.
- Mono 11.5px uppercase `vision · curator` with a 7px pulsing dot before it.
- The question at **25px / weight 640 / line-height 1.25**, verbatim:
  "I think a tomato went in, but I'm only 65% sure. Is that right?"
- A 6px confidence bar, `max-width: 320px`, track `oklch(0.9 0.02 240)`, fill 65% in
  `oklch(0.6 0.1 240)`.
- 14px meta: `65% confidence · frame captured 14:12:58 · produce, 1 piece`.
- Buttons: **Yes** filled `oklch(0.45 0.09 240)` white text, hover `oklch(0.38 0.09 240)`;
  **No** white with 1px `oklch(0.8 0.02 240)`. Both 16px/600, `padding: 11px 30px`, radius 11px.
- Blue, not amber or red: this is the product thinking, not an error.

### 4. Recipe card (expandable)
Collapsed: 1px `oklch(0.91 0.008 85)`, radius 16px, `padding: 18px 20px`.
- `title` 20px/640; meta 14.5px `{meal} · {minutes} min · {servings} servings · {calories_per_serving} kcal a serving`;
  `why_this` 15px/1.5.
- Right: "Steps & nutrition" / "Collapse" button, 14px/600, radius 10px.
- Ingredient chips, radius 999px, `padding: 5px 12px`, 13.5px. A chip for an ingredient with
  `expiring: true` gets the **critical triangle** (6px/10px borders), red-tinted background
  `oklch(0.975 0.02 28)` and border `oklch(0.55 0.15 28 / 0.35)`. `from_fridge` chips are white
  with the neutral border; `missing` chips are grey-filled `oklch(0.96 0.006 85)`.
- Expanded (`animation: arrive 320ms ease-out both`): grid `minmax(0,1.3fr) minmax(0,1fr)`,
  22px gap. Left: mono "steps" label + numbered `steps` (mono 12px index, 15px/1.5 text).
  Right: mono "nutrition · per serving" label, then a 2×2 grid of bordered tiles
  (24px/680 value + 12.5px label) for `calories_per_serving`, `protein_g`, `carbs_g`, `fat_g`;
  then, when `fits_target: false`, a dashed amber note (`1px dashed oklch(0.8 0.06 75)`,
  background `oklch(0.985 0.015 75)`) carrying the warning diamond and the `adjustment` text;
  then 14px `Missing: parmesan.`

### 5. Empty state
Dashed 1px `oklch(0.84 0.01 85)`, radius 18px, `padding: 56px 32px`, centred column:
56px tile with a basket emoji, "Nothing tracked yet" 22px/640, then 15px/1.55 body
(max-width 380px): "Open the door and put something in. The camera wakes on the door switch,
compares the before and after frame, and logs what changed." Under it mono 12px
`$0.00 saved · $0.00 wasted · 0 items`. Header stat band shows `0` / "items tracked".

### 6. Mobile — 400px
Two artboards: door-open and resting. Same frame treatment at radius 20px. Single column,
`padding: 16–18px`. Changes from desktop:
- Header: title 17px, compact door pill.
- Scan banner: "Comparing frames…" 19px/660 + 13.5px "2 changes detected", same sweep.
- Confirmation card: icon 48px, question 18px, Yes/No are `flex: 1` full-width buttons at
  `padding: 13px 0` (48px+ hit targets).
- Stat pair: two bordered tiles side by side, numbers 27px.
- Hero number 40px/700 with "items spoil today · $8.28 on the line".
- Item rows: 46px icon tile, 20px photo-thumb corner, name 16.5px, shape + word at 14.5px,
  no expand button.
- One recipe summary card, then the input row with a 48px mic button.
- No horizontal scroll at 400px; everything is flex/grid with gap.

## Urgency system (hard requirement)
Urgency is never carried by colour alone. Each tier uses **three channels**: colour, a distinct
shape, and the day count written in words.

| Tier | `days_left` | Shape | Colour | Left rule | Words |
|---|---|---|---|---|---|
| Critical | 0–1 | Triangle (CSS borders: 9px transparent sides, 15px bottom) | `oklch(0.55 0.15 28)`; text `oklch(0.5 0.14 28)` | `5px solid` | "Today", "Tomorrow" |
| Warning | 2–3 | Diamond (13px square, `rotate(45deg)`) | `oklch(0.55 0.15 75)`; text `oklch(0.47 0.13 75)` | `5px dashed` | "2 days", "3 days" |
| Fine | 4+ | Hollow circle (13px, 2.5px border, 50% radius) | `oklch(0.55 0.15 150)`; text `oklch(0.45 0.11 150)` | `5px solid oklch(0.92 0.01 85)` (neutral) | "4 days" and up |

Card borders / tints per tier: critical `oklch(0.55 0.15 28 / 0.3)` / `oklch(0.96 0.025 28)`;
warning `oklch(0.55 0.15 75 / 0.32)` / `oklch(0.965 0.03 75)`; fine `oklch(0.91 0.008 85)` /
`oklch(0.965 0.012 150)`.

Shape sizes scale down in tight contexts (chips 6/10px triangle; mobile 8/13px triangle,
12px diamond/circle) but the shape language never changes per context.

## Interactions & behavior
- **Item card expand/collapse** — click the +/− button; toggles the storage-tip row and the
  larger intake-photo slot. Button glyph switches `+` ⇄ `−`.
- **Recipe expand/collapse** — button toggles steps + nutrition, `arrive 320ms ease-out`.
  Recipe 1 is open by default so the demo lands on a filled card.
- **Confirmation card** — Yes/No both dismiss the card and return to the resting state.
  In the real app: Yes commits the item to inventory, No discards the detection (and should
  feed back to `vision`). Nothing here blocks the rest of the UI — it is a card, not a modal.
- **Door open → live update** — while the door is open the banner sweeps and the pill dot
  pulses. An arriving item mounts at the **top** of the list with
  `arrive 700ms cubic-bezier(.2,.8,.2,1) both` (`opacity 0 → 1`, `translateY(-10px) → 0`,
  `scale(0.985) → 1`). Noticeable, not jarring: no colour flash, no layout jump elsewhere.
  Because the arriving item is out of sort order, the list count label switches to
  "… · just added at the top" for the duration; on close it re-sorts by `days_left`.
  Removal uses the mirrored `leave` keyframe (`opacity → 0`, `translateX(14px)`) before unmount.
- **Prefer `prefers-reduced-motion`** fallbacks: drop the sweep and pulse to static states and
  cross-fade arrivals.
- **Demo state switcher** — the four chips above the desktop frame (Resting / Unsure /
  Door open / Empty) are a demo control, labelled as such, and are **not part of the product UI**.
  Decide whether to keep them visible on the projector or move them to keyboard shortcuts.
- **Hover states** — every button lightens its border to `oklch(0.6–0.7 0.02 85)`; the filled
  Yes button darkens to `oklch(0.38 0.09 240)`. No hover-only information anywhere (the demo
  is driven from a projector).
- **Responsive** — one breakpoint: two columns become one stacked column; the three-up stat
  band becomes a 40px hero number plus a two-tile money pair.

## State
- `view`: `'normal' | 'unsure' | 'door' | 'empty'` (demo harness; in production these are
  real conditions: pending confirmation, door switch open, zero items).
- `open`: map of item id → expanded boolean.
- `recipeOpen`: map of recipe index → expanded boolean.
- Data: `items[]` (inventory), `ledger[]` (waste entries + the 7-day totals),
  `activity[]`, `recipes[]` with nutrition, `agents[]`, household profile.
- Real-time: the door switch drives add/remove events; items must be able to appear and
  disappear without a page reload. Keep `days_left` derived from `expires_at` on a timer so
  tiers re-evaluate at the day boundary.

## Data contract
Do not invent fields. The design consumes exactly:

- **Inventory item**: `id, name, category, quantity, unit, expires_at, shelf_life_days,
  est_cost, days_left, removal_count, storage_tip`.
  `category` ∈ `produce, dairy, meat, seafood, bakery, pantry, leftovers, beverage,
  condiment, other`.
- **Waste ledger**: `saved_cad, wasted_cad, items_saved, items_wasted` +
  entries `{ item_name, kind: "saved" | "wasted", est_cost, reason }`.
- **Recipe**: `title, meal, servings, minutes, ingredients[{ name, amount, from_fridge,
  expiring }], steps[], uses_expiring[], missing[], why_this`.
- **Nutrition**: `calories_per_serving, protein_g, carbs_g, fat_g, fits_target, adjustment`.
- **Chat**: user/assistant turns + the list of agents that ran per turn
  (`vision, curator, shelf_life, chef, nutrition, sentinel, concierge`). Voice via mic button.
- Plus: activity feed (item added/removed + timestamp), the seven agent role lines, and the
  household profile (diet, allergies, household size, calorie target).

## Design tokens

**Colour** (all oklch; warm-neutral paper)
- Page background `oklch(0.975 0.008 85)`; surface `#fff`; right column `oklch(0.985 0.006 85)`.
- Ink `oklch(0.28 0.012 85)`; secondary `oklch(0.45 0.015 85)`; tertiary/meta `oklch(0.58 0.02 85)`;
  placeholder `oklch(0.62 0.02 85)`.
- Hairline `oklch(0.93 0.008 85)`; border `oklch(0.9 0.008 85)`; strong border `oklch(0.84 0.01 85)`.
- Urgency: red `oklch(0.55 0.15 28)`, amber `oklch(0.55 0.15 75)`, green `oklch(0.55 0.15 150)` —
  same lightness and chroma, hue only varies, so the shapes carry the weight.
- Agent blue (thinking / door open): `oklch(0.55 0.12 240)`, fill `oklch(0.45 0.09 240)`,
  tint `oklch(0.96 0.03 240)`.
- Links `oklch(0.52 0.1 240)`, hover `oklch(0.42 0.1 240)`.

**Type** — system stack only:
`-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif`;
mono `ui-monospace, SFMono-Regular, Menlo, monospace`.
Scale (px): 58 / 40 (mobile hero) / 27 / 26 / 25 / 24 / 21 / 20 / 19 / 17 / 16.5 / 16 / 15 /
14.5 / 13.5 / 12.5 / 12 / 11.5 / 10.5. Weights 640–700 for headings and numbers, 600 for
buttons, 400 body. Tracking: `-0.04em` on the 58/40px numbers, `-0.02em` on headings,
`-0.011em` global; mono labels `+0.1em` uppercase. Body line-height 1.45–1.55.

**Spacing** — 4 / 6 / 8 / 10 / 12 / 14 / 16 / 18 / 22 / 26 / 28 / 32 / 44 / 56.
**Radius** — 6 / 8 / 10 / 11 / 12 / 13 / 14 / 15 / 16 / 18 / 20 / 22 / 999.
**Shadow** — desktop frame `0 22px 60px -30px oklch(0.4 0.02 85 / 0.4)`;
mobile frame `0 18px 44px -26px oklch(0.4 0.02 85 / 0.4)`. No shadows inside the UI.
**Keyframes** — `arrive`, `leave`, `pulse`, `sweep`, `shimmer` (see the prototype's `<style>`).

## Assets
- **Food imagery: emoji only.** One emoji per food, with a per-category fallback for unknown
  items: produce 🥗, dairy 🥛, meat 🍖, seafood 🐟, bakery 🍞, pantry 🥫, leftovers 🍲,
  beverage 🧃, condiment 🧂, other 📦. No network call, works offline — required for the demo.
- **Fridge-camera photos: not included.** Every place a real intake photo belongs is a striped
  placeholder (`repeating-linear-gradient(135deg, oklch(0.86 0.01 85) 0 3px,
  oklch(0.93 0.008 85) 3px 6px)`): a 26px corner thumbnail on each desktop item tile, 20px on
  mobile, and an 86×64 slot in the expanded row. Treat the photo as strictly optional
  enrichment — the layout must be identical with it absent.
- No icon font, no SVG illustration, no image CDN.

## Tone of copy
Dry, evidence-led, a little pointed about waste — "those mushrooms have come out and gone back
three times and they expire tomorrow." It talks about food, dates and money, never about the
person, and it is never preachy about what someone eats. Keep the prototype's copy verbatim
where you reuse it.

## Files
- `Fridge Agent.dc.html` — the full prototype: urgency legend, desktop dashboard (with the
  four states), and both 400px mobile artboards.


---

## Deviations in the built version

Three places where the implementation departs from the spec above, and why.

**The intake-photo placeholder is not shown when there is no photo.** The spec renders a
striped placeholder everywhere a fridge-camera photo belongs, because the prototype had no
real photos to show. The build has them - `frame_ref` on each item resolves to the actual
frame the camera captured - so the corner thumbnail appears only when a photo exists and is
hidden otherwise. A permanent stripe on every card read as a smudge. Layout is unchanged
either way, as the spec requires.

**No demo state switcher.** The spec's Resting / Unsure / Door open / Empty chips are
explicitly not product UI. All four states are reachable for real - seed the fridge, run a
door cycle, open the door - so shipping a fake switcher onto the projector would have been a
liability rather than a help.

**Quantities are pluralised.** "2 piece" reads as a typo on the most urgent card. Counted
units take a plural; measures (g, ml, L) never do.

## Provenance

Designed in Claude Design, exported as a handoff bundle, and rebuilt against the live API in
plain HTML, CSS and vanilla JS. The prototype's internal templating runtime was deliberately
not ported, per the handoff's instruction to read it as markup plus data.
