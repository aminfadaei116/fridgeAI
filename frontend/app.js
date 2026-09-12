/* Fridge Agent dashboard.
 *
 * One state fetch paints everything; a server-sent event stream repaints it when the door
 * opens. No framework, no build step - the interesting part of this project is behind the API.
 *
 * Visual spec: docs/DESIGN.md. The rule that shapes the rendering is that urgency carries on
 * three channels - colour, shape and the day count in words - never colour alone.
 */

import { foodIcon } from "/static/food-icons.js";

const $ = (id) => document.getElementById(id);

const state = {
  inventory: [],
  pending: [],
  ledger: {},
  provider: { name: "openai", server_audio: true },
  camera: {},
  modelAvailable: false,
  seenItemIds: null,     // null until the first paint, so nothing animates on load
  expanded: new Set(),
  recipeOpen: new Set(),
  recipes: [],
  nutrition: null,
  planStatus: "idle",   // idle | planning | ready | empty | offline

  greeted: false,
  recording: false,
  recorder: null,
  recognition: null,
  agents: [],
  doorOpen: false,
};

/* --- small helpers --------------------------------------------------------- */

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

function shape(tier) {
  return el("i", `shape shape-${tier}`);
}

/** The three urgency tiers. Colour is the last channel, never the only one. */
function tierOf(days) {
  if (days === null || days === undefined) return { tier: "fine", words: "no date" };
  if (days < 0) return { tier: "critical", words: "Overdue" };
  if (days === 0) return { tier: "critical", words: "Today" };
  if (days === 1) return { tier: "critical", words: "Tomorrow" };
  if (days <= 3) return { tier: "warning", words: `${days} days` };
  return { tier: "fine", words: `${days} days` };
}

/* Units that are counted, so they take a plural. Measures (g, ml, L) never do. */
const COUNTABLE_UNITS = new Set([
  "piece", "unit", "bag", "tub", "block", "container", "bunch", "fillet",
  "can", "jar", "box", "pack", "bottle", "loaf", "head", "clove", "slice",
]);

function quantityLabel(quantity, unit) {
  const amount = Number(quantity);
  const plural = amount !== 1 && COUNTABLE_UNITS.has(unit) ? `${unit}s` : unit;
  return `${amount % 1 === 0 ? amount : amount.toFixed(1)} ${plural}`;
}

/** Copy derived from how often an item has been picked up and put back. */
function handledNote(count) {
  if (count >= 2) return `picked up ${count}× and still here`;
  if (count === 1) return "picked up once";
  return "not touched since intake";
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

/* --- top-level paint ------------------------------------------------------- */

function renderAll(data) {
  state.inventory = data.inventory || [];
  state.pending = data.pending || [];
  state.ledger = data.ledger || {};
  state.camera = data.camera || {};
  state.modelAvailable = !!data.model_available;
  state.provider = data.provider || state.provider;

  renderHeader(data);
  renderStats();
  renderConfirm();
  renderItems();
  renderLedger();
  renderActivity(data.events || []);

  if (!state.greeted) {
    state.greeted = true;
    const history = data.messages || [];
    if (history.length) history.forEach((m) => addBubble(m.role, m.content, [], false));
    else addBubble("assistant", openingLine(), [], false);
  }
}

function renderHeader(data) {
  const lastScan = (data.events || []).find((e) =>
    ["vision_diff", "added", "removed"].includes(e.kind)
  );
  $("head-scan").textContent = state.doorOpen
    ? "scanning now"
    : lastScan
      ? `last scan ${clock(lastScan.ts)} · ${state.inventory.length} items tracked`
      : `no scans yet · ${state.inventory.length} items tracked`;

  const profile = data.profile || {};
  const bits = [];
  if (profile.household_size) bits.push(`${profile.household_size} adults`);
  if (profile.diet_plan) bits.push(profile.diet_plan);
  (profile.allergies || []).forEach((a) => bits.push(`no ${a}`));
  if (profile.daily_calorie_target) bits.push(`${profile.daily_calorie_target} kcal target`);
  $("head-profile").textContent = bits.join(" · ");

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
  $("stat-saved-cap").textContent =
    `saved in 7 days · ${l.items_saved || 0} items eaten in time`;
  $("stat-wasted").textContent = money(l.wasted_cad);
  $("stat-wasted-cap").textContent =
    `wasted in 7 days · ${l.items_wasted || 0} items binned`;
}

/* --- items ----------------------------------------------------------------- */

function renderItems() {
  const host = $("items");
  host.replaceChildren();

  if (!state.inventory.length) {
    $("items-count").textContent = "";
    host.append(emptyState());
    state.seenItemIds = new Set();
    return;
  }

  $("items-count").textContent = state.doorOpen
    ? `${state.inventory.length} items · just added at the top`
    : `${state.inventory.length} items · sorted by days left`;

  // First paint must not animate; after that, anything new arrives.
  const firstPaint = state.seenItemIds === null;
  const seen = state.seenItemIds || new Set();

  for (const item of state.inventory) {
    host.append(itemCard(item, !firstPaint && !seen.has(item.id)));
  }
  state.seenItemIds = new Set(state.inventory.map((i) => i.id));
}

function itemCard(item, isNew) {
  const { tier, words } = tierOf(item.days_left);
  const card = el("article", "item");
  card.dataset.tier = tier;
  if (isNew) card.classList.add("is-arriving");

  // Icon tile, with the real intake photo overlapping its corner when one exists.
  const icon = el("div", "item-icon");
  icon.append(document.createTextNode(foodIcon(item.name, item.category)));
  const photo = el("span", "item-photo");
  if (item.frame_ref) {
    photo.dataset.hasPhoto = "true";
    photo.style.backgroundImage = `url("/api/frames/${encodeURIComponent(item.frame_ref)}")`;
    photo.title = "Frame captured when this went in";
  }
  icon.append(photo);
  card.append(icon);

  const main = el("div", "item-main");
  main.append(el("div", "item-name", item.name));
  main.append(el("div", "item-cat mono", item.category));
  main.append(
    el(
      "div",
      "item-meta",
      `${quantityLabel(item.quantity, item.unit)} · ${money(item.est_cost)} · ${handledNote(item.removal_count)}`
    )
  );
  card.append(main);

  const right = el("div", "item-right");
  right.append(shape(tier));
  right.append(el("span", "item-days", words));

  const expanded = state.expanded.has(item.id);
  const toggle = el("button", "expand", expanded ? "−" : "+");
  toggle.setAttribute("aria-expanded", String(expanded));
  toggle.setAttribute("aria-label", `Details for ${item.name}`);
  toggle.addEventListener("click", () => {
    if (state.expanded.has(item.id)) state.expanded.delete(item.id);
    else state.expanded.add(item.id);
    renderItems();
  });
  right.append(toggle);
  card.append(right);

  if (expanded) card.append(itemDetail(item));
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

  const text = el("div", "detail-text");
  text.append(el("p", "detail-label", "shelf life · storage tip"));
  text.append(el("p", "detail-tip", item.storage_tip || "No storage note for this one."));
  const expires = item.expires_at ? new Date(item.expires_at).toLocaleDateString() : "unknown";
  text.append(
    el("p", "detail-dates", `expires ${expires} · shelf life ${item.shelf_life_days ?? "?"} days`)
  );
  detail.append(text);
  return detail;
}

function emptyState() {
  const box = el("div", "empty");
  const tile = el("div", "empty-tile", "🧺");
  box.append(tile);
  box.append(el("h3", null, "Nothing tracked yet"));
  box.append(
    el(
      "p",
      null,
      "Open the door and put something in. The camera wakes on the door switch, compares " +
        "the before and after frame, and logs what changed."
    )
  );
  const l = state.ledger;
  box.append(
    el("p", "empty-nums mono",
      `${money(l.saved_cad)} saved · ${money(l.wasted_cad)} wasted · 0 items`)
  );
  return box;
}

/* --- the confirmation card ------------------------------------------------- */

function renderConfirm() {
  const zone = $("confirm-zone");
  zone.replaceChildren();

  for (const pending of state.pending) {
    const card = el("section", "confirm");

    const tile = el("div", "confirm-tile", foodIcon(pending.item.name, pending.item.category));
    card.append(tile);

    const body = el("div", "confirm-body");
    body.append(el("p", "confirm-who", "vision · curator"));
    body.append(el("p", "confirm-q", pending.question));

    const bar = el("div", "confirm-bar");
    const fill = el("i");
    fill.style.width = `${Math.round(pending.item.confidence * 100)}%`;
    bar.append(fill);
    body.append(bar);

    body.append(
      el(
        "p",
        "confirm-meta",
        `${Math.round(pending.item.confidence * 100)}% confidence · ` +
          `frame captured ${clock(pending.created_at)} · ` +
          `${pending.item.category}, ${pending.item.quantity} ${pending.item.unit}`
      )
    );

    const actions = el("div", "confirm-actions");
    const yes = el("button", "btn-yes", "Yes, that's right");
    yes.addEventListener("click", () => resolvePending(pending.id, true));
    const no = el("button", "btn-no", "No");
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

function renderRecipes() {
  const host = $("recipes");
  host.replaceChildren();
  $("btn-replan").hidden = !state.recipes.length;

  if (!state.recipes.length) {
    $("recipes-count").textContent = "";
    host.append(planPlaceholder());
    return;
  }

  const macros = new Map((state.nutrition?.estimates || []).map((e) => [e.recipe_title, e]));
  const total = state.nutrition?.day_total_calories;
  $("recipes-count").textContent = total
    ? `${state.recipes.length} options · ~${total} kcal a day`
    : `${state.recipes.length} options`;

  // Grouped by meal so the board reads as a day, not a pile of dishes.
  const order = ["breakfast", "lunch", "dinner", "snack"];
  const byMeal = new Map();
  state.recipes.forEach((recipe, index) => {
    if (!byMeal.has(recipe.meal)) byMeal.set(recipe.meal, []);
    byMeal.get(recipe.meal).push({ recipe, index });
  });

  for (const meal of order) {
    const group = byMeal.get(meal);
    if (!group) continue;
    const section = el("section", "meal-group");
    section.append(el("p", "meal-label", meal));
    for (const { recipe, index } of group) {
      section.append(recipeCard(recipe, index, macros.get(recipe.title)));
    }
    host.append(section);
  }
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

/** Fetch today's board. Returns instantly; a background plan arrives over the event stream. */
async function loadPlan(refresh = false) {
  try {
    const result = await apiJson(`/api/today${refresh ? "?refresh=true" : ""}`);
    state.planStatus = result.status;
    if (result.status === "ready" && result.plan) {
      state.recipes = result.plan.recipes || [];
      state.nutrition = result.plan.nutrition || null;
      if (!state.recipeOpen.size) state.recipeOpen = new Set([0]);
    } else {
      state.recipes = [];
    }
    renderRecipes();
  } catch (error) {
    console.error("plan load failed", error);
  }
}

function recipeCard(recipe, index, macro) {
  const open = state.recipeOpen.has(index);
  const card = el("article", "recipe");

  const top = el("div", "recipe-top");
  const head = el("div", "recipe-head");
  head.append(el("div", "recipe-title", recipe.title));
  const meta = [
    recipe.meal,
    `${recipe.minutes} min`,
    `${recipe.servings} servings`,
    macro ? `${macro.calories_per_serving} kcal a serving` : null,
  ].filter(Boolean);
  head.append(el("div", "recipe-meta", meta.join(" · ")));
  top.append(head);

  const toggle = el("button", "recipe-toggle", open ? "Collapse" : "Steps & nutrition");
  toggle.setAttribute("aria-expanded", String(open));
  toggle.addEventListener("click", () => {
    if (state.recipeOpen.has(index)) state.recipeOpen.delete(index);
    else state.recipeOpen.add(index);
    renderRecipes();
  });
  top.append(toggle);
  card.append(top);

  if (recipe.why_this) card.append(el("p", "recipe-why", recipe.why_this));

  const chips = el("div", "chips");
  for (const ing of recipe.ingredients || []) {
    if (!ing.from_fridge) continue;
    const chip = el("span", ing.expiring ? "chip chip-expiring" : "chip");
    if (ing.expiring) chip.append(shape("critical"));
    chip.append(document.createTextNode(ing.name));
    chips.append(chip);
  }
  for (const missing of recipe.missing || []) {
    chips.append(el("span", "chip chip-missing", missing));
  }
  if (chips.childElementCount) card.append(chips);

  if (open) card.append(recipeDetail(recipe, macro));
  return card;
}

function recipeDetail(recipe, macro) {
  const detail = el("div", "recipe-detail");

  const left = el("div");
  left.append(el("p", "detail-label", "steps"));
  const steps = el("ol", "steps");
  (recipe.steps || []).forEach((step, i) => {
    const li = el("li");
    li.append(el("span", null, String(i + 1).padStart(2, "0")));
    li.append(el("p", null, step));
    steps.append(li);
  });
  left.append(steps);
  detail.append(left);

  const right = el("div");
  right.append(el("p", "detail-label", "nutrition · per serving"));
  if (macro) {
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
    right.append(grid);

    if (!macro.fits_target && macro.adjustment) {
      const note = el("div", "adjust");
      note.append(shape("warning"));
      note.append(el("span", null, macro.adjustment));
      right.append(note);
    }
  } else {
    right.append(el("p", "side-empty", "No estimate for this one."));
  }

  if ((recipe.missing || []).length) {
    right.append(el("p", "recipe-missing", `Missing: ${recipe.missing.join(", ")}.`));
  }
  detail.append(right);
  return detail;
}

/* --- side blocks ----------------------------------------------------------- */

function renderLedger() {
  const host = $("ledger");
  host.replaceChildren();
  const entries = state.ledger.entries || [];
  if (!entries.length) {
    host.append(el("p", "side-empty", "Nothing logged this week."));
    return;
  }
  for (const entry of entries) {
    const row = el("div", "ledger-row");
    row.append(el("span", "ledger-name", entry.item_name));
    const amount = el(
      "span",
      `ledger-amt ${entry.kind}`,
      `${entry.kind === "saved" ? "+" : "−"}${money(entry.est_cost)}`
    );
    row.append(amount);
    row.append(el("span", "ledger-reason", entry.reason || entry.kind));
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
  demo_seeded: () => "demo fridge loaded",
  note: (e) => e.payload?.reason || "note",
};

function renderActivity(events) {
  const host = $("activity");
  host.replaceChildren();
  if (!events.length) {
    host.append(el("p", "side-empty", "Nothing yet."));
    return;
  }
  for (const event of events.slice(0, 10)) {
    const row = el("div", "activity-row");
    row.append(el("time", null, clock(event.ts)));
    const describe = EVENT_COPY[event.kind] || ((e) => e.kind);
    row.append(el("p", null, describe(event)));
    host.append(row);
  }
}

function renderRoster(agents) {
  state.agents = agents;
  const host = $("roster");
  host.replaceChildren();
  for (const agent of agents) {
    const row = el("div", "agent-row");
    row.append(el("span", "agent-name", agent.name.replace("_", " ")));
    row.append(el("span", "agent-role", agent.role));
    host.append(row);
  }
}

/* --- chat ------------------------------------------------------------------ */

function openingLine() {
  if (!state.inventory.length) {
    return "Nothing in here that I know of. Open the door with the camera running, or load the demo fridge.";
  }
  const urgent = state.inventory
    .filter((i) => (i.days_left ?? 99) <= 1)
    .map((i) => i.name);
  const head = urgent.length
    ? `${listOf(urgent)} ${urgent.length === 1 ? "goes" : "go"} tomorrow or sooner.`
    : "Nothing goes off in the next day.";
  return `${state.inventory.length} things in here. ${head}\n\nAsk me what to cook, or tell me about tonight.`;
}

function listOf(names) {
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
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
    state.recipeOpen = new Set([0]);   // land the demo on a filled card
    state.planStatus = "ready";
    renderRecipes();
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
      event.error === "not-allowed"
        ? "Microphone permission refused."
        : `Speech failed: ${event.error}`;
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
  $("door-label").textContent = open ? "Door open" : "Door closed";
  const banner = $("scan-banner");
  banner.hidden = !open;
  if (open) {
    $("scan-title").textContent = title || "Door open";
    $("scan-sub").textContent = sub || "Comparing frames";
  }
}

function connectStream() {
  const source = new EventSource("/api/stream");

  source.addEventListener("message", (message) => {
    const event = JSON.parse(message.data);
    const data = event.data || {};

    switch (event.kind) {
      case "door_opened":
        setDoor(true, "Door open", "Watching the shelf");
        break;
      case "analyzing":
        setDoor(true, "Door closed", "Comparing frames — vision agent");
        break;
      case "door_closed":
        break;
      case "inventory_changed": {
        setDoor(false);
        (data.added || []).forEach((i) =>
          toast(`${i.name} went in — ${tierOf(i.days_left).words.toLowerCase()}`, "good"));
        (data.removed || []).forEach((i) => toast(`${i.name} came out`, "info"));
        (data.ignored || []).forEach((n) => toast(`Ignored ${n}`, "info"));
        refresh();
        break;
      }
      case "needs_confirmation":
        setDoor(false);
        refresh();
        break;
      case "plan_started":
        state.planStatus = "planning";
        state.recipes = [];
        renderRecipes();
        break;
      case "plan_ready":
        loadPlan();
        toast("Today's menu is ready", "good");
        break;
      case "plan_failed":
        state.planStatus = "offline";
        renderRecipes();
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
  $("composer").addEventListener("submit", (e) => {
    e.preventDefault();
    send($("chat-text").value);
  });

  $("chat-chips").addEventListener("click", (e) => {
    const chip = e.target.closest(".ghost-chip");
    if (chip) send(chip.dataset.say);
  });

  $("btn-mic").addEventListener("click", toggleRecording);

  $("btn-replan").addEventListener("click", () => {
    state.planStatus = "planning";
    state.recipes = [];
    renderRecipes();
    loadPlan(true);
  });

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
    renderRecipes();
    toast("Demo fridge reloaded", "good");
    refresh();
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
    const files = [...e.target.files];
    if (files.length !== 2) {
      toast("Pick exactly two images: the before frame, then the after frame.", "warn");
      e.target.value = "";
      return;
    }
    const form = new FormData();
    form.append("frame_before", files[0]);
    form.append("frame_after", files[1]);
    $("control-hint").textContent = "Comparing the two frames…";
    setDoor(true, "Door closed", "Comparing frames — vision agent");
    try {
      const result = await apiJson("/api/door/simulate", { method: "POST", body: form });
      const changes = (result.added?.length || 0) + (result.removed?.length || 0);
      $("control-hint").textContent = changes
        ? `${changes} change${changes > 1 ? "s" : ""} committed.`
        : result.questions?.length
          ? "The fridge has a question."
          : "No change detected between those frames.";
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
