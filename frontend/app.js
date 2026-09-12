/* savor · fridge agent
 *
 * Three views over one state fetch, repainted live by a server-sent event stream.
 * No framework, no build step - the interesting part of this project is behind the API.
 *
 * The rule that shapes the rendering is that urgency carries on three channels - colour,
 * shape and the day count in words - never colour alone.
 */

import { foodIcon } from "/static/food-icons.js";

const $ = (id) => document.getElementById(id);

const CATEGORIES = [
  "all", "produce", "dairy", "meat", "seafood", "bakery",
  "pantry", "leftovers", "beverage", "condiment", "other",
];

const DAY_LETTERS = ["M", "T", "W", "T", "F", "S", "S"];

/* Recipe cards get a colour block rather than a photo we do not have. Deterministic per
   title, so a recipe keeps its colour between repaints. */
const RECIPE_ART = [
  "linear-gradient(135deg, #e9a05a, #c2553f)",
  "linear-gradient(135deg, #e6b957, #c98a2e)",
  "linear-gradient(135deg, #d4736e, #b8443d)",
  "linear-gradient(135deg, #7fae6a, #46774a)",
  "linear-gradient(135deg, #6fa8a0, #3c7a72)",
];

const state = {
  view: "today",
  inventory: [],
  pending: [],
  ledger: {},
  events: [],
  profile: {},
  provider: { name: "openai", server_audio: true },
  camera: {},
  modelAvailable: false,
  seenItemIds: null,     // null until the first paint, so nothing animates on load
  expanded: new Set(),
  recipeOpen: new Set([0]),
  matchOpen: new Set(),
  recipes: [],
  nutrition: null,
  planStatus: "idle",
  search: "",
  category: "all",
  greeted: false,
  recording: false,
  recorder: null,
  recognition: null,
  doorOpen: false,
};

/* --- helpers --------------------------------------------------------------- */

const money = (n) => `$${Number(n || 0).toFixed(2)}`;
const clock = (iso) =>
  (iso ? new Date(iso) : new Date()).toLocaleTimeString([], {
    hour: "2-digit", minute: "2-digit", hour12: false,
  });

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

const shape = (tier) => el("i", `shape shape-${tier}`);

/** The three urgency tiers. Colour is the last channel, never the only one. */
function tierOf(days) {
  if (days === null || days === undefined) return { tier: "fine", word: "no date" };
  if (days < 0) return { tier: "crit", word: "Overdue" };
  if (days === 0) return { tier: "crit", word: "Today" };
  if (days === 1) return { tier: "crit", word: "1 day left" };
  if (days <= 3) return { tier: "warn", word: `${days} days left` };
  return { tier: "fine", word: `${days} days left` };
}

const COUNTABLE_UNITS = new Set([
  "piece", "unit", "bag", "tub", "block", "container", "bunch", "fillet",
  "can", "jar", "box", "pack", "bottle", "loaf", "head", "clove", "slice", "portion", "carton",
]);

function quantityLabel(quantity, unit) {
  const amount = Number(quantity);
  if (!unit) return `${amount % 1 === 0 ? amount : amount.toFixed(1)}`;
  const plural = amount !== 1 && COUNTABLE_UNITS.has(unit) ? `${unit}s` : unit;
  return `${amount % 1 === 0 ? amount : amount.toFixed(1)} ${plural}`;
}

function handledNote(count) {
  if (count >= 2) return `picked up ${count}× and still here`;
  if (count === 1) return "picked up once";
  return "not touched since intake";
}

const sentenceCase = (text) => (text ? text[0].toUpperCase() + text.slice(1) : text);

const titleCase = (text) => text.replace(/\b[a-z]/g, (c) => c.toUpperCase());

function listOf(names) {
  if (!names.length) return "";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

/** The name the dashboard greets you by. Blank is a perfectly good answer. */
const who = () => (state.profile.household_name || "").trim();

function greeting() {
  const hour = new Date().getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

function artFor(title) {
  let hash = 0;
  for (const char of String(title)) hash = (hash * 31 + char.charCodeAt(0)) | 0;
  return RECIPE_ART[Math.abs(hash) % RECIPE_ART.length];
}

function toast(message, tone = "info") {
  const node = el("div", "toast", message);
  node.dataset.tone = tone;
  $("toasts").append(node);
  setTimeout(() => {
    node.style.opacity = "0";
    node.style.transition = "opacity .3s";
    setTimeout(() => node.remove(), 300);
  }, 4200);
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  if (!response.ok) {
    const detail = await response.json().catch(() => ({}));
    throw new Error(detail.detail || `${response.status} ${response.statusText}`);
  }
  return response;
}

const apiJson = async (path, options) => (await api(path, options)).json();

const postJson = (path, body) =>
  apiJson(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

/* --- view routing ---------------------------------------------------------- */

function setView(view) {
  state.view = view;
  for (const button of document.querySelectorAll(".nav-btn")) {
    if (button.dataset.view === view) button.setAttribute("aria-current", "page");
    else button.removeAttribute("aria-current");
  }
  $("view-today").hidden = view !== "today";
  $("view-inventory").hidden = view !== "inventory";
  $("view-plan").hidden = view !== "plan";
  $("btn-add-toggle").hidden = view !== "inventory";
  renderPageHead();
  if (view === "inventory") renderInventoryRows();
  if (view === "plan") renderPlanRows();
}

function renderPageHead() {
  const items = state.inventory;
  const spoilToday = items.filter((i) => (i.days_left ?? 99) <= 0);
  const soon = items.filter((i) => (i.days_left ?? 99) <= 3);
  const name = who();

  const copy = {
    today: {
      eyebrow: name ? `${greeting()}, ${name}` : greeting(),
      heading: "Make the good stuff last longer.",
      sub: spoilToday.length
        ? sentenceCase(
            `${listOf(spoilToday.map((i) => i.name))} ${spoilToday.length === 1 ? "is" : "are"} out of time.`
          )
        : items.length
          ? "Your kitchen is calm and in sync."
          : "Nothing tracked yet. Open the door with the camera running, or scan a clip.",
      chip: new Date().toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }),
    },
    inventory: {
      eyebrow: "Keep tabs, effortlessly",
      heading: "Fridge inventory",
      sub:
        items.length === 0
          ? "Nothing in your kitchen yet."
          : `${items.length === 1 ? "1 item" : `${items.length} items`} in your kitchen, sorted by what needs you first.`,
      chip: `${money(spoilToday.reduce((sum, i) => sum + Number(i.est_cost || 0), 0))} at risk today`,
    },
    plan: {
      eyebrow: "Waste less, eat better",
      heading: "What should we make?",
      sub: "Ideas built around what you already have on hand.",
      chip: soon.length ? `✦ ${soon.length} ${soon.length === 1 ? "item" : "items"} to use soon` : "✦ Nothing urgent",
    },
  }[state.view];

  $("eyebrow").textContent = copy.eyebrow;
  $("heading").textContent = copy.heading;
  $("subheading").textContent = copy.sub;
  $("date-chip").textContent = copy.chip;
}

/* --- top-level paint ------------------------------------------------------- */

function renderAll(data) {
  state.inventory = data.inventory || [];
  state.pending = data.pending || [];
  state.ledger = data.ledger || {};
  state.events = data.events || [];
  state.profile = data.profile || {};
  state.camera = data.camera || {};
  state.modelAvailable = !!data.model_available;
  state.provider = data.provider || state.provider;

  renderIdentity();
  renderPageHead();
  renderHero();
  renderMoney();
  renderConfirm();
  renderItems();
  renderLedger();
  renderActivity();
  renderHousehold();
  renderWeek();
  if (state.view === "inventory") renderInventoryRows();

  if (!state.greeted) {
    state.greeted = true;
    const history = data.messages || [];
    if (history.length) history.forEach((m) => addBubble(m.role, m.content, [], false));
    else addBubble("assistant", openingLine(), [], false);
  }
}

function renderIdentity() {
  const name = who();
  $("who-name").textContent = name || "Your kitchen";
  $("who-mark").textContent = name ? name.slice(0, 2) : "☺";
  $("crumb-name").textContent = name ? `${name}'s kitchen` : "Your kitchen";
  $("nav-count").textContent = String(state.inventory.length);
  $("btn-camera").textContent = state.camera.running ? "Stop camera" : "Start camera";

  const lastScan = state.events.find((e) =>
    ["vision_diff", "added", "removed"].includes(e.kind)
  );
  $("scan-cta-sub").textContent = state.doorOpen
    ? "Scanning now…"
    : lastScan
      ? `Last scan ${clock(lastScan.ts)}`
      : "Update your inventory";
}

function renderHero() {
  const soon = state.inventory.filter((i) => (i.days_left ?? 99) <= 1);
  const items = state.inventory;

  if (!items.length) {
    $("hero-eyebrow").textContent = "Start here";
    $("hero-title").textContent = "Your fridge is a blank page.";
    $("hero-body").textContent =
      "Record a door cycle and savor will read what crossed the door, date it, and cook around it.";
    $("btn-hero").textContent = "Scan the fridge";
    return;
  }

  $("btn-hero").replaceChildren(
    document.createTextNode(soon.length ? "See what to make " : "Plan today "),
    el("span", null, "→")
  );

  if (!soon.length) {
    $("hero-eyebrow").textContent = "All good";
    $("hero-title").textContent = "Nothing is racing the clock.";
    $("hero-body").textContent =
      `${items.length} ${items.length === 1 ? "item" : "items"} tracked, and the soonest has a few days left. ` +
      "The menu still builds around whatever goes first.";
    return;
  }

  $("hero-eyebrow").textContent = "Eat this first";
  $("hero-title").textContent =
    `${soon.length} ${soon.length === 1 ? "ingredient is" : "ingredients are"} at their best right now.`;
  const rest = soon.length - 1;
  $("hero-body").textContent =
    `${sentenceCase(soon[0].name)}${rest ? ` and ${rest} more` : ""} — ` +
    `${tierOf(soon[0].days_left).word.toLowerCase()}. ` +
    (state.recipes.length ? "We found a meal that uses them." : "Ask for a meal that uses them.");
}

function renderMoney() {
  const l = state.ledger;
  $("stat-saved").textContent = money(l.saved_cad);
  $("stat-saved-cap").textContent = `saved · ${l.items_saved || 0} eaten in time`;
  $("stat-wasted").textContent = money(l.wasted_cad);
  $("stat-wasted-cap").textContent = `wasted · ${l.items_wasted || 0} binned`;
}

/* --- item rows ------------------------------------------------------------- */

function daysPill(tier, word) {
  const pill = el("span", "days");
  pill.dataset.tier = tier;
  pill.append(shape(tier), document.createTextNode(word));
  return pill;
}

function iconFor(item) {
  const wrap = el("div", "icon-wrap");
  const tile = el("div", "icon-tile", foodIcon(item.name, item.category));
  const photo = el("span", "icon-photo");
  if (item.frame_ref) {
    photo.dataset.hasPhoto = "true";
    photo.style.backgroundImage = `url("/api/frames/${encodeURIComponent(item.frame_ref)}")`;
    photo.title = "Intake photo from the fridge camera";
  }
  wrap.append(tile, photo);
  return wrap;
}

/**
 * One inventory line. `removable` adds the × (Inventory view); the Today shortlist leaves
 * it off so the urgent list stays a list, not a control panel.
 */
function itemRow(item, { isNew = false, removable = false } = {}) {
  const { tier, word } = tierOf(item.days_left);
  const open = state.expanded.has(item.id);

  const wrap = el("div", "row-wrap");
  if (open) wrap.classList.add("is-open");

  const row = el("article", "row");
  row.dataset.tier = tier;
  if (isNew) row.classList.add("is-arriving");

  const opener = el("button", "row-open");
  opener.type = "button";
  opener.setAttribute("aria-expanded", String(open));
  opener.setAttribute("aria-label", `Details for ${item.name}`);
  opener.append(iconFor(item));

  const main = el("div", "row-main");
  main.append(el("span", "row-name", item.name));
  main.append(el("span", "row-sub", item.category));
  opener.append(main);
  opener.addEventListener("click", () => {
    if (state.expanded.has(item.id)) state.expanded.delete(item.id);
    else state.expanded.add(item.id);
    renderItems();
    if (state.view === "inventory") renderInventoryRows();
  });
  row.append(opener);

  const right = el("div", "row-right");
  right.append(el("span", "row-qty", quantityLabel(item.quantity, item.unit)));
  right.append(daysPill(tier, word));

  if (removable) {
    const remove = el("button", "row-x", "×");
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove ${item.name}`);
    remove.addEventListener("click", () => removeItem(item));
    right.append(remove);
  }
  row.append(right);
  wrap.append(row);

  if (open) wrap.append(itemDetail(item));
  return wrap;
}

function itemDetail(item) {
  const detail = el("div", "row-detail");

  const photo = el("div", "detail-photo");
  if (item.frame_ref) {
    photo.style.backgroundImage = `url("/api/frames/${encodeURIComponent(item.frame_ref)}")`;
  } else {
    photo.textContent = "intake photo";
  }
  detail.append(photo);

  const body = el("div", "detail-body");
  body.append(el("p", "detail-label", "shelf life · storage tip"));
  body.append(el("p", "detail-tip", item.storage_tip || "No storage note for this one."));
  const expires = item.expires_at ? item.expires_at.replace("T", " ").slice(0, 16) : "unknown";
  body.append(
    el("p", "detail-dates",
      `${money(item.est_cost)} · expires ${expires} · ${handledNote(item.removal_count)}`)
  );
  detail.append(body);
  return detail;
}

async function removeItem(item) {
  try {
    await api(`/api/items/${item.id}`, { method: "DELETE" });
    toast(`${item.name} removed`, "info");
    await refresh();
  } catch (error) {
    toast(`Could not remove that: ${error.message}`, "bad");
  }
}

function renderItems() {
  const host = $("items");
  host.replaceChildren();

  if (!state.inventory.length) {
    host.append(emptyBox());
    state.seenItemIds = new Set();
    return;
  }

  const firstPaint = state.seenItemIds === null;
  const seen = state.seenItemIds || new Set();

  // "Use these first" is the urgent shortlist, not the whole fridge - that is the Inventory view.
  for (const item of state.inventory.slice(0, 5)) {
    host.append(itemRow(item, { isNew: !firstPaint && !seen.has(item.id) }));
  }
  state.seenItemIds = new Set(state.inventory.map((i) => i.id));
}

function emptyBox() {
  const box = el("div", "empty-box");
  box.append(el("div", "empty-tile", "🧺"));
  box.append(el("h3", null, "Nothing tracked yet"));
  box.append(
    el("p", null,
      "Open the door and put something in. The camera wakes on the door switch, records " +
      "the cycle, and logs what crossed the door.")
  );
  const l = state.ledger;
  box.append(
    el("p", "empty-nums", `${money(l.saved_cad)} saved · ${money(l.wasted_cad)} wasted · 0 items`)
  );
  return box;
}

/* --- inventory view -------------------------------------------------------- */

function renderCategoryChips() {
  const host = $("cat-chips");
  host.replaceChildren();
  const present = new Set(state.inventory.map((i) => i.category));

  for (const category of CATEGORIES) {
    if (category !== "all" && !present.has(category)) continue;
    const chip = el("button", "pill", titleCase(category));
    chip.type = "button";
    chip.dataset.on = String(state.category === category);
    chip.addEventListener("click", () => {
      state.category = category;
      renderInventoryRows();
    });
    host.append(chip);
  }
}

function renderInventoryRows() {
  renderCategoryChips();
  const host = $("inventory-rows");
  host.replaceChildren();

  const query = state.search.trim().toLowerCase();
  const filtered = state.inventory.filter(
    (i) =>
      (state.category === "all" || i.category === state.category) &&
      (!query || i.name.toLowerCase().includes(query))
  );

  if (!filtered.length) {
    host.append(
      el("p", "muted",
        state.inventory.length
          ? "Nothing matches that filter."
          : "Nothing tracked yet. Scan a door cycle, or add something by hand.")
    );
    return;
  }
  for (const item of filtered) host.append(itemRow(item, { removable: true }));
}

/* --- confirmation ---------------------------------------------------------- */

function renderConfirm() {
  const zone = $("confirm-zone");
  zone.replaceChildren();

  for (const pending of state.pending) {
    const card = el("section", "confirm");
    card.append(el("div", "confirm-tile", foodIcon(pending.item.name, pending.item.category)));

    const body = el("div", "confirm-body");
    body.append(el("p", "confirm-who", "vision · curator"));
    body.append(el("p", "confirm-q", pending.question));

    const bar = el("div", "confirm-bar");
    const fill = el("i");
    fill.style.width = `${Math.round(pending.item.confidence * 100)}%`;
    bar.append(fill);
    body.append(bar);

    body.append(
      el("p", "confirm-meta",
        `${Math.round(pending.item.confidence * 100)}% confidence · ` +
        `seen ${clock(pending.created_at)} · ` +
        `${pending.item.category}, ${quantityLabel(pending.item.quantity, pending.item.unit)}`)
    );

    const actions = el("div", "confirm-actions");
    const yes = el("button", "btn-solid", "Yes");
    yes.addEventListener("click", () => resolvePending(pending.id, true));
    const no = el("button", "btn-outline", "No");
    no.addEventListener("click", () => resolvePending(pending.id, false));
    actions.append(yes, no);
    body.append(actions);

    card.append(body);
    zone.append(card);
  }
}

async function resolvePending(id, confirmed) {
  await postJson(`/api/pending/${id}`, { confirmed });
  toast(confirmed ? "Confirmed — written to the inventory" : "Discarded that detection",
        confirmed ? "good" : "info");
  refresh();
}

/* --- recipes --------------------------------------------------------------- */

function macroMap() {
  return new Map((state.nutrition?.estimates || []).map((e) => [e.recipe_title, e]));
}

function fromFridge(recipe) {
  return (recipe.ingredients || []).filter((i) => i.from_fridge);
}

function matchLabel(recipe) {
  const have = fromFridge(recipe).length;
  return `${have}/${have + (recipe.missing || []).length} matched`;
}

function recipeChips(recipe) {
  const chips = el("div", "chips");
  for (const ing of fromFridge(recipe)) {
    const chip = el("span", ing.expiring ? "chip chip-expiring" : "chip");
    if (ing.expiring) chip.append(shape("crit"));
    chip.append(document.createTextNode(`${ing.name}${ing.expiring ? " · expiring" : ""}`));
    chips.append(chip);
  }
  for (const missing of recipe.missing || []) {
    chips.append(el("span", "chip chip-missing", `${missing} · missing`));
  }
  return chips;
}

function macroGrid(macro) {
  const grid = el("div", "macros");
  for (const [value, label] of [
    [macro.calories_per_serving, "calories"],
    [`${macro.protein_g}g`, "protein"],
    [`${macro.carbs_g}g`, "carbs"],
    [`${macro.fat_g}g`, "fat"],
  ]) {
    const tile = el("div", "macro");
    tile.append(el("b", null, String(value)));
    tile.append(el("span", null, label));
    grid.append(tile);
  }
  return grid;
}

function stepList(recipe) {
  const list = el("ol", "steps");
  (recipe.steps || []).forEach((step, i) => {
    const li = el("li");
    li.append(el("span", null, String(i + 1).padStart(2, "0")));
    li.append(el("div", null, step));
    list.append(li);
  });
  return list;
}

function recipeMeta(recipe, macro) {
  return [
    recipe.meal,
    `${recipe.minutes} min`,
    `${recipe.servings} servings`,
    macro ? `${macro.calories_per_serving} kcal a serving` : null,
  ].filter(Boolean).join(" · ");
}

function recipeDetail(recipe, macro) {
  const detail = el("div", "recipe-detail");

  const left = el("div");
  left.append(el("p", "detail-label", "steps"));
  left.append(stepList(recipe));
  detail.append(left);

  const right = el("div");
  right.append(el("p", "detail-label", "nutrition · per serving"));
  if (macro) {
    right.append(macroGrid(macro));
    if (!macro.fits_target && macro.adjustment) {
      const note = el("div", "adjust");
      note.append(shape("warn"));
      note.append(el("span", null, macro.adjustment));
      right.append(note);
    }
  } else {
    right.append(el("p", "muted", "No estimate for this one."));
  }
  if ((recipe.missing || []).length) {
    right.append(el("p", "recipe-missing", `Missing: ${recipe.missing.join(", ")}.`));
  }
  detail.append(right);
  return detail;
}

/** Compact, collapsible card - used on the Today view. */
function recipeRow(recipe, index, macro) {
  const open = state.recipeOpen.has(index);
  const card = el("article", "recipe");

  const top = el("div", "recipe-top");
  const head = el("div", "recipe-head");
  head.append(el("div", "recipe-title", recipe.title));
  head.append(el("div", "recipe-meta", recipeMeta(recipe, macro)));
  if (recipe.why_this) head.append(el("div", "recipe-why", recipe.why_this));
  top.append(head);

  const toggle = el("button", "btn-outline", open ? "Hide" : "Steps & nutrition");
  toggle.setAttribute("aria-expanded", String(open));
  toggle.addEventListener("click", () => {
    if (state.recipeOpen.has(index)) state.recipeOpen.delete(index);
    else state.recipeOpen.add(index);
    renderTodayMenu();
  });
  top.append(toggle);
  card.append(top);
  card.append(recipeChips(recipe));

  if (open) card.append(recipeDetail(recipe, macro));
  return card;
}

/** Meal-plan row: colour block, title, match count, expandable recipe. */
function matchRow(recipe, index, macro) {
  const open = state.matchOpen.has(index);
  const card = el("article", "match");

  const top = el("div", "match-top");
  const art = el("div", "match-art");
  art.style.background = artFor(recipe.title);
  art.append(el("i"));
  top.append(art);

  const main = el("div", "match-main");
  main.append(el("div", "match-title", recipe.title));
  if (recipe.why_this) main.append(el("div", "match-why", recipe.why_this));
  top.append(main);

  const side = el("div", "match-side");
  side.append(el("span", "match-count", matchLabel(recipe)));
  const toggle = el("button", "link-btn");
  toggle.append(
    document.createTextNode(open ? "Hide recipe " : "View recipe "),
    el("span", null, open ? "↑" : "→")
  );
  toggle.setAttribute("aria-expanded", String(open));
  toggle.addEventListener("click", () => {
    if (state.matchOpen.has(index)) state.matchOpen.delete(index);
    else state.matchOpen.add(index);
    renderPlanRows();
  });
  side.append(toggle);
  top.append(side);
  card.append(top);

  if (open) {
    const detail = el("div", "match-detail");
    detail.append(el("div", "recipe-meta", recipeMeta(recipe, macro)));
    detail.append(recipeChips(recipe));
    detail.append(recipeDetail(recipe, macro));
    card.append(detail);
  }
  return card;
}

function planPlaceholder() {
  const box = el("div", "planning");
  const copy = {
    planning: "Building today's menu around what spoils first…",
    empty: "Nothing in the fridge to cook with yet.",
    offline: "Today's menu needs a model connection.",
    idle: "Working out today's menu…",
  };
  if (state.planStatus === "planning" || state.planStatus === "idle") box.append(el("i"));
  box.append(el("span", null, copy[state.planStatus] || copy.idle));
  return box;
}

function renderTodayMenu() {
  const host = $("today-menu");
  host.replaceChildren();
  $("btn-replan").hidden = !state.recipes.length;

  if (!state.recipes.length) {
    host.append(planPlaceholder());
    renderTonight();
    return;
  }
  const macros = macroMap();
  // The Today card shows the first option per meal; the full board lives on Meal plan.
  const seen = new Set();
  state.recipes.forEach((recipe, index) => {
    if (seen.has(recipe.meal)) return;
    seen.add(recipe.meal);
    host.append(recipeRow(recipe, index, macros.get(recipe.title)));
  });
  renderTonight();
}

/** The one idea worth acting on tonight: dinner if the chef planned one, else the first. */
function renderTonight() {
  const card = $("tonight-card");
  const dinner = state.recipes.find((r) => r.meal === "dinner") || state.recipes[0];

  if (!dinner) {
    card.hidden = true;
    return;
  }
  card.hidden = false;

  const macro = macroMap().get(dinner.title);
  $("tonight-art").style.background = artFor(dinner.title);
  $("tonight-badge").textContent = `${matchLabel(dinner)} on hand`;
  $("tonight-title").textContent = dinner.title;
  $("tonight-why").textContent = dinner.why_this || "";
  $("tonight-meta").textContent = [
    `${dinner.minutes} min`,
    macro ? `${macro.calories_per_serving} cal` : null,
  ].filter(Boolean).join(" · ");
}

function renderPlanRows() {
  const host = $("plan-rows");
  host.replaceChildren();
  if (!state.recipes.length) {
    host.append(planPlaceholder());
    return;
  }
  const macros = macroMap();
  const order = ["breakfast", "lunch", "dinner", "snack"];
  const ranked = [...state.recipes].sort(
    (a, b) => order.indexOf(a.meal) - order.indexOf(b.meal)
  );
  ranked.forEach((recipe, index) => {
    host.append(matchRow(recipe, index, macros.get(recipe.title)));
  });
}

function renderWeek() {
  const host = $("week");
  host.replaceChildren();

  const today = new Date();
  // Monday-first, matching the M T W T F S S strip.
  const monday = new Date(today);
  monday.setDate(today.getDate() - ((today.getDay() + 6) % 7));

  for (let i = 0; i < 7; i += 1) {
    const day = new Date(monday);
    day.setDate(monday.getDate() + i);
    const cell = el("div", "week-day");
    cell.dataset.today = String(day.toDateString() === today.toDateString());
    cell.append(el("span", "week-letter", DAY_LETTERS[i]));
    cell.append(el("span", "week-num", String(day.getDate())));
    host.append(cell);
  }
  $("week-note").textContent = state.recipes.length
    ? `${state.recipes.length} ${state.recipes.length === 1 ? "idea" : "ideas"} planned for today.`
    : "Nothing planned yet.";
}

async function loadPlan(refreshPlan = false) {
  try {
    const result = await apiJson(`/api/today${refreshPlan ? "?refresh=true" : ""}`);
    state.planStatus = result.status;
    if (result.status === "ready" && result.plan) {
      state.recipes = result.plan.recipes || [];
      state.nutrition = result.plan.nutrition || null;
    } else {
      state.recipes = [];
    }
    renderTodayMenu();
    renderPlanRows();
    renderWeek();
    renderHero();
  } catch (error) {
    console.error("plan load failed", error);
  }
}

/* --- side blocks ----------------------------------------------------------- */

function renderLedger() {
  const host = $("ledger");
  host.replaceChildren();
  const entries = state.ledger.entries || [];
  if (!entries.length) {
    host.append(el("p", "muted", "Nothing logged yet. Entries appear once items leave the fridge."));
    return;
  }
  for (const entry of entries.slice(0, 6)) {
    const row = el("div", "ledger-row");
    row.append(el("span", "ledger-name", entry.item_name));
    row.append(el("span", "ledger-reason", entry.reason || entry.kind));
    row.append(
      el("span", `ledger-amt ${entry.kind}`,
        `${entry.kind === "saved" ? "+" : "−"}${money(entry.est_cost)}`)
    );
    host.append(row);
  }
}

const EVENT_COPY = {
  added: (e) => `${e.item_name} went in`,
  removed: (e) => `${e.item_name} came out`,
  rejected: (e) => `ignored ${e.item_name} — ${e.payload?.reason || "low confidence"}`,
  correction: (e) => `you corrected ${e.item_name}`,
  vision_diff: (e) => {
    const n = (e.payload?.added?.length || 0) + (e.payload?.removed?.length || 0);
    return n ? `vision saw ${n} change${n > 1 ? "s" : ""}` : "vision saw no change";
  },
  planned_day: (e) => `chef planned ${e.payload?.recipes ?? ""} recipes`.trim(),
  demo_seeded: () => "demo fridge loaded",
  note: (e) => e.payload?.reason || "note",
};

function renderActivity() {
  const host = $("activity");
  host.replaceChildren();
  if (!state.events.length) {
    host.append(el("p", "muted", "Nothing yet."));
    return;
  }
  for (const event of state.events.slice(0, 8)) {
    const row = el("div", "activity-row");
    row.append(el("time", null, clock(event.ts)));
    const describe = EVENT_COPY[event.kind] || ((e) => e.kind);
    row.append(el("p", null, describe(event)));
    host.append(row);
  }
}

function renderRoster(agents) {
  const host = $("roster");
  host.replaceChildren();
  for (const agent of agents) {
    const row = el("div", "agent-row");
    row.append(el("span", "agent-name", agent.name.replace("_", " ")));
    row.append(el("span", "agent-role", agent.role));
    host.append(row);
  }
}

function renderHousehold() {
  const p = state.profile;
  const bits = [];
  if (p.household_size) bits.push(`${p.household_size} adults`);
  if (p.diet_plan) bits.push(p.diet_plan);
  (p.allergies || []).forEach((a) => bits.push(`no ${a}`));

  $("household-line").textContent = bits.length ? bits.join(" · ") : "Not set yet";
  $("household-note").textContent = p.daily_calorie_target
    ? `${p.daily_calorie_target} kcal a day target. Recipes are checked against it, and flagged ` +
      "when a serving pushes past."
    : "Tell the fridge your diet, allergies or how many you are and it applies to every plan.";
}

/* --- chat ------------------------------------------------------------------ */

function openingLine() {
  if (!state.inventory.length) {
    return "Nothing in here that I know of. Open the door with the camera running, or load the demo fridge.";
  }
  const urgent = state.inventory.filter((i) => (i.days_left ?? 99) <= 1).map((i) => i.name);
  const head = urgent.length
    ? `${listOf(urgent)} ${urgent.length === 1 ? "goes" : "go"} tomorrow or sooner.`
    : "Nothing goes off in the next day.";
  return `${state.inventory.length} things in here. ${head}\n\nAsk me what to cook, or tell me about tonight.`;
}

function addBubble(role, content, ran = [], animate = true) {
  const log = $("chat-log");
  const bubble = el("div", `bubble bubble-${role === "user" ? "user" : "agent"}`);
  bubble.textContent = content;
  if (!animate) bubble.style.animation = "none";
  if (ran.length) {
    const strip = el("div", "ran");
    [...new Set(ran)].forEach((name) => strip.append(el("span", null, name.replace("_", " "))));
    bubble.append(strip);
  }
  log.append(bubble);
  log.scrollTop = log.scrollHeight;
  return bubble;
}

function thinking(text = "thinking…") {
  const bubble = addBubble("assistant", text);
  bubble.classList.add("thinking");
  return bubble;
}

async function send(text) {
  if (!text.trim()) return;
  setView("today");
  addBubble("user", text);
  $("chat-text").value = "";
  const pending = thinking();
  try {
    const reply = await postJson("/api/chat", { text });
    pending.remove();
    addBubble("assistant", reply.reply, reply.agents_called || []);
    afterReply(reply);
  } catch (error) {
    pending.remove();
    addBubble("assistant", `Something broke: ${error.message}`);
  }
}

function afterReply(reply) {
  if (reply.recipes?.length) {
    state.recipes = reply.recipes;
    state.nutrition = reply.nutrition;
    state.planStatus = "ready";
    state.recipeOpen = new Set([0]);
    state.matchOpen = new Set();
    renderTodayMenu();
    renderPlanRows();
    renderWeek();
  }
  if (reply.profile_updated) toast("Saved that to your profile", "good");
  if (reply.reply && state.modelAvailable) speak(reply.reply);
  refresh();
}

/* --- voice ----------------------------------------------------------------- */

async function speak(text) {
  // Gemini's OpenAI-compatible surface has no /audio/speech, so fall back to the browser's
  // own synthesiser. Costs nothing, needs no network, keeps the demo intact.
  if (!state.provider?.server_audio) return speakInBrowser(text);
  try {
    const response = await api("/api/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const audio = new Audio(URL.createObjectURL(await response.blob()));
    audio.play().catch(() => {});
  } catch {
    speakInBrowser(text);
  }
}

function speakInBrowser(text) {
  if (!window.speechSynthesis) return;
  try {
    window.speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(text);
    utterance.rate = 1.05;
    window.speechSynthesis.speak(utterance);
  } catch {
    /* no synthesiser - silence is fine */
  }
}

function listenInBrowser() {
  const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  const hint = $("chat-hint");
  if (!Recognition) {
    hint.textContent = "No speech recognition in this browser. Chrome or Edge has it.";
    return;
  }
  const recognition = new Recognition();
  recognition.lang = navigator.language || "en-US";
  recognition.interimResults = false;

  recognition.addEventListener("result", (event) => {
    const transcript = event.results[0][0].transcript;
    if (transcript) send(transcript);
  });
  recognition.addEventListener("error", (event) => {
    hint.textContent =
      event.error === "not-allowed" ? "Microphone permission refused." : `Speech failed: ${event.error}`;
  });
  recognition.addEventListener("end", () => {
    state.recording = false;
    state.recognition = null;
    $("btn-mic").dataset.recording = "false";
    if (hint.textContent.startsWith("Listening")) hint.textContent = "";
  });

  recognition.start();
  state.recognition = recognition;
  state.recording = true;
  $("btn-mic").dataset.recording = "true";
  hint.textContent = "Listening — speak now.";
}

async function toggleRecording() {
  const button = $("btn-mic");
  const hint = $("chat-hint");

  if (state.recording) {
    state.recorder?.stop();
    state.recognition?.stop();
    return;
  }
  if (!state.provider?.server_audio) return listenInBrowser();
  if (!navigator.mediaDevices?.getUserMedia) {
    hint.textContent = "This browser will not give us a microphone.";
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const recorder = new MediaRecorder(stream);
    const chunks = [];
    recorder.addEventListener("dataavailable", (e) => e.data.size && chunks.push(e.data));
    recorder.addEventListener("stop", async () => {
      stream.getTracks().forEach((t) => t.stop());
      state.recording = false;
      button.dataset.recording = "false";
      hint.textContent = "Transcribing…";
      const form = new FormData();
      form.append("audio", new Blob(chunks, { type: "audio/webm" }), "speech.webm");
      const pending = thinking("listening…");
      try {
        const reply = await apiJson("/api/voice", { method: "POST", body: form });
        pending.remove();
        hint.textContent = "";
        if (reply.transcript) addBubble("user", reply.transcript);
        addBubble("assistant", reply.reply, reply.agents_called || []);
        afterReply(reply);
      } catch (error) {
        pending.remove();
        hint.textContent = `Voice failed: ${error.message}`;
      }
    });
    recorder.start();
    state.recorder = recorder;
    state.recording = true;
    button.dataset.recording = "true";
    hint.textContent = "Listening — click again when done.";
  } catch {
    hint.textContent = "Microphone permission refused.";
  }
}

/* --- live stream ----------------------------------------------------------- */

function setDoor(open, title, sub) {
  state.doorOpen = open;
  $("door-pill").dataset.state = open ? "open" : "closed";
  $("door-label").textContent = open ? "Door open" : "Closed";
  const banner = $("scan-banner");
  banner.hidden = !open;
  if (open) {
    $("scan-title").textContent = title || "Door open";
    $("scan-sub").textContent = sub || "Watching the door";
    $("scan-cta-sub").textContent = "Scanning now…";
  }
}

function connectStream() {
  const source = new EventSource("/api/stream");

  source.addEventListener("message", (message) => {
    const event = JSON.parse(message.data);
    const data = event.data || {};

    switch (event.kind) {
      case "door_opened":
        setDoor(true, "Door open", "Recording the door cycle");
        break;
      case "analyzing":
        setDoor(true, "Door closed", "Watching the clip — vision agent");
        break;
      case "inventory_changed":
        setDoor(false);
        (data.added || []).forEach((i) =>
          toast(`${i.name} went in — ${tierOf(i.days_left).word.toLowerCase()}`, "good"));
        (data.removed || []).forEach((i) => toast(`${i.name} came out`, "info"));
        (data.ignored || []).forEach((n) => toast(`Ignored ${n}`, "info"));
        refresh();
        break;
      case "needs_confirmation":
        setDoor(false);
        refresh();
        break;
      case "plan_started":
        state.planStatus = "planning";
        state.recipes = [];
        renderTodayMenu();
        renderPlanRows();
        break;
      case "plan_ready":
        loadPlan();
        toast("Today's menu is ready", "good");
        break;
      case "plan_failed":
        state.planStatus = "offline";
        renderTodayMenu();
        renderPlanRows();
        break;
      case "camera_status":
        state.camera = data;
        $("btn-camera").textContent = data.running ? "Stop camera" : "Start camera";
        break;
      default:
        break;
    }
  });

  source.addEventListener("error", () => {
    /* EventSource reconnects on its own */
  });
}

/* --- wiring ---------------------------------------------------------------- */

async function refresh() {
  try {
    renderAll(await apiJson("/api/state"));
  } catch (error) {
    console.error("state refresh failed", error);
  }
}

function pickClip() {
  $("sim-input").click();
}

function showAddRow() {
  setView("inventory");
  $("add-form").hidden = false;
  $("add-name").focus();
}

function wire() {
  $("nav").addEventListener("click", (e) => {
    const button = e.target.closest(".nav-btn");
    if (button) setView(button.dataset.view);
  });

  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    send($("chat-text").value);
  });

  $("chat-chips").addEventListener("click", (e) => {
    const chip = e.target.closest(".pill");
    if (chip) send(chip.dataset.say);
  });

  $("btn-mic").addEventListener("click", toggleRecording);

  $("search").addEventListener("input", (e) => {
    state.search = e.target.value;
    renderInventoryRows();
  });

  $("add-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("add-name").value.trim();
    if (!name) return;
    $("add-hint").textContent = `Adding ${name}…`;
    try {
      const item = await postJson("/api/items", { name });
      $("add-name").value = "";
      $("add-hint").textContent = `${item.name} added · ${item.shelf_life_days} day shelf life`;
      toast(`${item.name} added by hand`, "good");
      await refresh();
      loadPlan();
    } catch (error) {
      $("add-hint").textContent = `Could not add that: ${error.message}`;
    }
  });

  $("btn-add-toggle").addEventListener("click", showAddRow);
  $("btn-quick-add").addEventListener("click", showAddRow);
  $("btn-see-all").addEventListener("click", () => setView("inventory"));

  for (const id of ["btn-scan", "btn-quick-scan", "btn-scan-inv"]) {
    $(id).addEventListener("click", pickClip);
  }

  $("btn-hero").addEventListener("click", () => {
    if (!state.inventory.length) return pickClip();
    setView("plan");
  });

  $("btn-tonight").addEventListener("click", () => setView("plan"));
  $("btn-quick-plan").addEventListener("click", () => setView("plan"));
  $("btn-plan-tonight").addEventListener("click", () => {
    state.planStatus = "planning";
    state.recipes = [];
    renderTodayMenu();
    renderPlanRows();
    loadPlan(true);
  });

  for (const id of ["btn-replan", "btn-replan-2"]) {
    $(id).addEventListener("click", () => {
      state.planStatus = "planning";
      state.recipes = [];
      renderTodayMenu();
      renderPlanRows();
      loadPlan(true);
    });
  }

  $("btn-camera").addEventListener("click", async () => {
    const running = state.camera.running;
    const result = await apiJson(`/api/camera/${running ? "stop" : "start"}`, { method: "POST" });
    state.camera = result;
    $("btn-camera").textContent = result.running ? "Stop camera" : "Start camera";
    if (!running && !result.running) {
      toast(result.error || "No camera found. Use a simulated cycle instead.", "warn");
    }
  });

  $("btn-seed").addEventListener("click", async () => {
    await apiJson("/api/demo/seed", { method: "POST" });
    state.seenItemIds = null;
    state.recipes = [];
    state.planStatus = "planning";
    renderTodayMenu();
    renderPlanRows();
    toast("Demo fridge reloaded", "good");
    await refresh();
    loadPlan();
  });

  $("btn-digest").addEventListener("click", async () => {
    setView("today");
    const pending = thinking("writing the briefing…");
    try {
      const digest = await apiJson("/api/digest");
      pending.remove();
      const lines = [digest.headline, ...(digest.alerts || []).map((a) => `• ${a.line}`)];
      if (digest.suggestion) lines.push(digest.suggestion);
      const text = lines.filter(Boolean).join("\n");
      addBubble("assistant", text, ["sentinel"]);
      if (state.modelAvailable) speak(text);
    } catch (error) {
      pending.remove();
      addBubble("assistant", `Could not write the briefing: ${error.message}`);
    }
  });

  // Who this kitchen belongs to. Click the chip, type a name, and the greeting is yours.
  $("btn-who").addEventListener("click", () => {
    const form = $("who-form");
    form.hidden = !form.hidden;
    if (!form.hidden) {
      $("who-input").value = who();
      $("who-input").focus();
    }
  });

  $("who-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      state.profile = await postJson("/api/profile", {
        household_name: $("who-input").value,
      });
      $("who-form").hidden = true;
      renderIdentity();
      renderPageHead();
    } catch (error) {
      toast(`Could not save that: ${error.message}`, "bad");
    }
  });

  $("sim-input").addEventListener("change", async (e) => {
    const [clip] = e.target.files;
    if (!clip) return;
    const form = new FormData();
    form.append("clip", clip);
    $("control-hint").textContent = "Watching the clip…";
    setDoor(true, "Door closed", "Watching the clip — vision agent");
    try {
      const result = await apiJson("/api/door/simulate", { method: "POST", body: form });
      const changes = (result.added?.length || 0) + (result.removed?.length || 0);
      $("control-hint").textContent = changes
        ? `${changes} change${changes > 1 ? "s" : ""} committed.`
        : result.questions?.length
          ? "The fridge has a question."
          : "Nothing crossed the door in that clip.";
    } catch (error) {
      $("control-hint").textContent = `That failed: ${error.message}`;
    }
    setDoor(false);
    refresh();
    e.target.value = "";
  });
}

async function boot() {
  wire();
  setView("today");
  connectStream();
  try {
    const { agents } = await apiJson("/api/agents");
    renderRoster(agents);
  } catch {
    /* the roster is decoration */
  }
  await refresh();
  await loadPlan();
  if (!state.modelAvailable) {
    toast("No model key set — the fridge runs, but the agents are offline.", "warn");
  }
}

boot();
