/* savor · fridge agent
 *
 * Three views over one state fetch, repainted live by a server-sent event stream.
 * No framework, no build step - the interesting part of this project is behind the API.
 *
 * Visual spec: docs/DESIGN.md. The rule that shapes the rendering is that urgency carries on
 * three channels - colour, shape and the day count in words - never colour alone.
 */

import { foodIcon } from "/static/food-icons.js";

const $ = (id) => document.getElementById(id);

const CATEGORIES = [
  "all", "produce", "dairy", "meat", "seafood", "bakery",
  "pantry", "leftovers", "beverage", "condiment", "other",
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
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
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
  if (days === 1) return { tier: "crit", word: "Tomorrow" };
  if (days <= 3) return { tier: "warn", word: `${days} days` };
  return { tier: "fine", word: `${days} days` };
}

const COUNTABLE_UNITS = new Set([
  "piece", "unit", "bag", "tub", "block", "container", "bunch", "fillet",
  "can", "jar", "box", "pack", "bottle", "loaf", "head", "clove", "slice", "portion", "carton",
]);

function quantityLabel(quantity, unit) {
  const amount = Number(quantity);
  const plural = amount !== 1 && COUNTABLE_UNITS.has(unit) ? `${unit}s` : unit;
  return `${amount % 1 === 0 ? amount : amount.toFixed(1)} ${plural}`;
}

function handledNote(count) {
  if (count >= 2) return `picked up ${count}× and still here`;
  if (count === 1) return "picked up once";
  return "not touched since intake";
}

function listOf(names) {
  if (!names.length) return "";
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
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
  renderPageHead();
  if (view === "inventory") renderInventoryGrid();
  if (view === "plan") renderPlanGrid();
}

function renderPageHead() {
  const items = state.inventory;
  const spoilToday = items.filter((i) => (i.days_left ?? 99) <= 0);
  const atRisk = spoilToday.reduce((sum, i) => sum + Number(i.est_cost || 0), 0);

  const copy = {
    today: {
      eyebrow: "Seven agents, one fridge",
      heading: !items.length
        ? "Nothing in here yet"
        : spoilToday.length === 0
          ? "Nothing spoils today"
          : `${spoilToday.length === 1 ? "One thing" : `${spoilToday.length} things`} spoil${spoilToday.length === 1 ? "s" : ""} today`,
      sub: !items.length
        ? "The camera wakes on the door switch. Put something in and it starts tracking."
        : spoilToday.length
          ? `${listOf(spoilToday.map((i) => i.name))} ${spoilToday.length === 1 ? "is" : "are"} out of time.`
          : "Everything has a few days left. The menu still builds around whatever goes first.",
    },
    inventory: {
      eyebrow: "Everything tracked",
      heading: "Inventory",
      sub:
        (items.length === 0
          ? "Nothing tracked yet. "
          : items.length === 1
            ? "One item, sorted by how long it has left. "
            : `${items.length} items, sorted by how long they have left. `) +
        "Colour, shape and words all carry the same urgency.",
    },
    plan: {
      eyebrow: "Waste less, eat better",
      heading: "What should we make?",
      sub: "Every one of these is built around what expires first, not what sounds nice.",
    },
  }[state.view];

  $("eyebrow").textContent = copy.eyebrow;
  $("heading").textContent = copy.heading;
  $("subheading").textContent = copy.sub;
  $("date-chip").textContent = `${money(atRisk)} at risk today`;
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

  renderTopbar();
  renderPageHead();
  renderStats();
  renderConfirm();
  renderItems();
  renderLedger();
  renderActivity();
  renderHousehold();
  if (state.view === "inventory") renderInventoryGrid();

  if (!state.greeted) {
    state.greeted = true;
    const history = data.messages || [];
    if (history.length) history.forEach((m) => addBubble(m.role, m.content, [], false));
    else addBubble("assistant", openingLine(), [], false);
  }
}

function renderTopbar() {
  const lastScan = state.events.find((e) =>
    ["vision_diff", "added", "removed"].includes(e.kind)
  );
  $("scan-line").textContent = state.doorOpen
    ? "scanning now"
    : lastScan
      ? `last scan ${clock(lastScan.ts)} · ${state.inventory.length} items`
      : "no scans yet";
  $("nav-count").textContent = String(state.inventory.length);
  $("btn-camera").textContent = state.camera.running ? "Stop camera" : "Start camera";
}

function renderStats() {
  const spoilToday = state.inventory.filter((i) => (i.days_left ?? 99) <= 0).length;
  const hasItems = state.inventory.length > 0;

  $("stat-today").textContent = hasItems ? String(spoilToday) : "0";
  $("stat-today-cap").textContent = hasItems
    ? `${spoilToday === 1 ? "item spoils" : "items spoil"} today`
    : "items tracked";

  const l = state.ledger;
  $("stat-saved").textContent = money(l.saved_cad);
  $("stat-saved-cap").textContent = `saved in 7 days · ${l.items_saved || 0} items eaten in time`;
  $("stat-wasted").textContent = money(l.wasted_cad);
  $("stat-wasted-cap").textContent = `wasted in 7 days · ${l.items_wasted || 0} items binned`;
}

/* --- items ----------------------------------------------------------------- */

function itemCard(item, { isNew = false, compact = false } = {}) {
  const { tier, word } = tierOf(item.days_left);
  const card = el("article", "item");
  card.dataset.tier = tier;
  if (isNew) card.classList.add("is-arriving");

  const row = el("div", "item-row");

  const wrap = el("div", "icon-wrap");
  const tile = el("div", "icon-tile", foodIcon(item.name, item.category));
  const photo = el("span", "icon-photo");
  if (item.frame_ref) {
    photo.dataset.hasPhoto = "true";
    photo.style.backgroundImage = `url("/api/frames/${encodeURIComponent(item.frame_ref)}")`;
    photo.title = "Intake photo from the fridge camera";
  }
  wrap.append(tile, photo);
  row.append(wrap);

  const main = el("div", "item-main");
  const title = el("div", "item-title");
  title.append(el("span", "item-name", item.name));
  if (!compact) title.append(el("span", "item-cat", item.category));
  main.append(title);
  main.append(
    el("div", "item-meta",
      `${quantityLabel(item.quantity, item.unit)} · ${money(item.est_cost)} · ` +
      handledNote(item.removal_count))
  );
  row.append(main);

  const right = el("div", "item-right");
  right.append(shape(tier));
  right.append(el("span", "item-word", word));

  if (!compact) {
    const open = state.expanded.has(item.id);
    const caret = el("button", "caret", open ? "−" : "+");
    caret.setAttribute("aria-expanded", String(open));
    caret.setAttribute("aria-label", `Details for ${item.name}`);
    caret.addEventListener("click", () => {
      if (state.expanded.has(item.id)) state.expanded.delete(item.id);
      else state.expanded.add(item.id);
      renderItems();
    });
    right.append(caret);
  }
  row.append(right);
  card.append(row);

  if (!compact && state.expanded.has(item.id)) card.append(itemDetail(item));
  return card;
}

function itemDetail(item) {
  const detail = el("div", "item-detail");

  const photo = el("div", "detail-photo");
  if (item.frame_ref) {
    photo.style.backgroundImage = `url("/api/frames/${encodeURIComponent(item.frame_ref)}")`;
  } else {
    photo.textContent = "intake photo";
  }
  detail.append(photo);

  const body = el("div", "detail-body");
  body.append(el("p", "detail-label", "shelf_life · storage tip"));
  body.append(el("p", "detail-tip", item.storage_tip || "No storage note for this one."));
  const expires = item.expires_at ? item.expires_at.replace("T", " ").slice(0, 16) : "unknown";
  body.append(
    el("p", "detail-dates", `expires ${expires} · shelf life ${item.shelf_life_days ?? "?"} days`)
  );
  detail.append(body);
  return detail;
}

function renderItems() {
  const host = $("items");
  host.replaceChildren();

  if (!state.inventory.length) {
    $("items-count").textContent = "0 items";
    host.append(emptyBox());
    state.seenItemIds = new Set();
    return;
  }

  $("items-count").textContent = state.doorOpen
    ? `${state.inventory.length} items · just added at the top`
    : `${state.inventory.length} items · sorted by days left`;

  const firstPaint = state.seenItemIds === null;
  const seen = state.seenItemIds || new Set();

  // "Eat these next" is the urgent shortlist, not the whole fridge - that is the Inventory view.
  for (const item of state.inventory.slice(0, 6)) {
    host.append(itemCard(item, { isNew: !firstPaint && !seen.has(item.id) }));
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
    const chip = el("button", "pill", category);
    chip.type = "button";
    chip.dataset.on = String(state.category === category);
    chip.addEventListener("click", () => {
      state.category = category;
      renderInventoryGrid();
    });
    host.append(chip);
  }
}

function renderInventoryGrid() {
  renderCategoryChips();
  const host = $("inventory-grid");
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
          : "Nothing tracked yet. Open the door, or add something by hand.")
    );
    return;
  }
  for (const item of filtered) host.append(itemCard(item, { compact: true }));
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

function recipeChips(recipe) {
  const chips = el("div", "chips");
  for (const ing of recipe.ingredients || []) {
    if (!ing.from_fridge) continue;
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

  if (open) {
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
    card.append(detail);
  }
  return card;
}

/** Full card, always expanded - used on the Meal plan view. */
function planCard(recipe, macro) {
  const card = el("article", "plan-card");
  card.append(el("div", "recipe-title", recipe.title));
  card.append(el("div", "recipe-meta", recipeMeta(recipe, macro)));
  if (recipe.why_this) card.append(el("div", "recipe-why", recipe.why_this));
  card.append(recipeChips(recipe));
  if (macro) card.append(macroGrid(macro));
  card.append(el("p", "detail-label", "steps"));
  card.append(stepList(recipe));
  if ((recipe.missing || []).length) {
    card.append(el("p", "recipe-missing", `Missing: ${recipe.missing.join(", ")}.`));
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
}

function renderPlanGrid() {
  const host = $("plan-grid");
  host.replaceChildren();
  if (!state.recipes.length) {
    host.append(planPlaceholder());
    return;
  }
  const macros = macroMap();
  const order = ["breakfast", "lunch", "dinner", "snack"];
  const byMeal = new Map();
  for (const recipe of state.recipes) {
    if (!byMeal.has(recipe.meal)) byMeal.set(recipe.meal, []);
    byMeal.get(recipe.meal).push(recipe);
  }
  for (const meal of order) {
    for (const recipe of byMeal.get(meal) || []) {
      host.append(planCard(recipe, macros.get(recipe.title)));
    }
  }
}

async function loadPlan(refresh = false) {
  try {
    const result = await apiJson(`/api/today${refresh ? "?refresh=true" : ""}`);
    state.planStatus = result.status;
    if (result.status === "ready" && result.plan) {
      state.recipes = result.plan.recipes || [];
      state.nutrition = result.plan.nutrition || null;
    } else {
      state.recipes = [];
    }
    renderTodayMenu();
    renderPlanGrid();
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
  for (const entry of entries) {
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
    renderTodayMenu();
    renderPlanGrid();
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
        renderPlanGrid();
        break;
      case "plan_ready":
        loadPlan();
        toast("Today's menu is ready", "good");
        break;
      case "plan_failed":
        state.planStatus = "offline";
        renderTodayMenu();
        renderPlanGrid();
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
    renderInventoryGrid();
  });

  $("add-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const name = $("add-name").value.trim();
    if (!name) return;
    $("add-hint").textContent = `Adding ${name}…`;
    try {
      const item = await postJson("/api/items", { name });
      $("add-name").value = "";
      $("add-hint").textContent =
        `${item.name} added · ${item.shelf_life_days} day shelf life`;
      toast(`${item.name} added by hand`, "good");
      await refresh();
      loadPlan();
    } catch (error) {
      $("add-hint").textContent = `Could not add that: ${error.message}`;
    }
  });

  $("btn-replan").addEventListener("click", () => {
    state.planStatus = "planning";
    state.recipes = [];
    renderTodayMenu();
    renderPlanGrid();
    loadPlan(true);
  });

  $("btn-scan").addEventListener("click", () => $("sim-input").click());

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
    renderPlanGrid();
    toast("Demo fridge reloaded", "good");
    await refresh();
    loadPlan();
  });

  $("btn-digest").addEventListener("click", async () => {
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
