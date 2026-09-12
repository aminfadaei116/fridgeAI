/* Fridge Agent dashboard.
 *
 * One state fetch paints everything; a server-sent event stream repaints it when the door
 * opens. No framework, no build step - the interesting part of this project is behind the API.
 */

const $ = (id) => document.getElementById(id);

/* The expiry meter is scaled to one week, so bar length is comparable across foods. */
const METER_WINDOW_DAYS = 7;

const state = {
  inventory: [],
  expiring: [],
  pending: [],
  ledger: null,
  messages: [],
  camera: {},
  modelAvailable: false,
  knownItemIds: new Set(),
  recording: false,
  recorder: null,
};

/* --- helpers --------------------------------------------------------------- */

const money = (n) => `$${Number(n || 0).toFixed(2)}`;

function urgencyOf(days) {
  if (days === null || days === undefined) return { tier: "good", glyph: "●", label: "no date" };
  if (days < 0) return { tier: "critical", glyph: "■", label: "Overdue" };
  if (days === 0) return { tier: "critical", glyph: "■", label: "Today" };
  if (days === 1) return { tier: "critical", glyph: "■", label: "Tomorrow" };
  if (days <= 3) return { tier: "warning", glyph: "▲", label: `${days} days` };
  return { tier: "good", glyph: "●", label: `${days} days` };
}

function clockOf(iso) {
  const d = iso ? new Date(iso) : new Date();
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function toast(message, tone = "info") {
  const node = el("div", "toast", message);
  node.dataset.tone = tone;
  $("toast-stack").append(node);
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

async function apiJson(path, options) {
  return (await api(path, options)).json();
}

function postJson(path, body) {
  return apiJson(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

/* --- rendering ------------------------------------------------------------- */

function renderAll(data) {
  state.inventory = data.inventory || [];
  state.expiring = data.expiring || [];
  state.pending = data.pending || [];
  state.ledger = data.ledger || {};
  state.camera = data.camera || {};
  state.modelAvailable = !!data.model_available;

  renderStatus();
  renderLedger();
  renderExpiring();
  renderInventory();
  renderPending();
  renderFeed(data.events || []);

  if (!state.greeted) {
    state.greeted = true;
    const history = data.messages || [];
    if (history.length) {
      history.forEach((m) => addBubble(m.role, m.content, [], false));
    } else {
      addBubble("assistant", openingLine(), [], false);
    }
  }
}

function openingLine() {
  if (!state.inventory.length) {
    return "The fridge is empty as far as I know. Open the door with the camera running, or load the demo fridge.";
  }
  const urgent = state.expiring.filter((i) => (i.days_left ?? 99) <= 1).map((i) => i.name);
  const head = urgent.length
    ? `${listOf(urgent)} ${urgent.length === 1 ? "goes" : "go"} tomorrow.`
    : `Nothing goes off in the next day.`;
  return `${state.inventory.length} things in here, ${state.expiring.length} of them within three days. ${head}\n\nAsk me what to cook, or just tell me about tonight — how many people, what you do and don't eat.`;
}

function listOf(names) {
  if (names.length === 1) return names[0];
  return `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`;
}

function renderStatus() {
  const camera = state.camera;
  const cameraPill = $("camera-pill");
  cameraPill.dataset.ok = String(!!camera.running);
  $("camera-text").textContent = camera.running
    ? `Camera live · ${camera.brightness}`
    : camera.error ? "Camera unavailable" : "Camera off";
  $("btn-camera").textContent = camera.running ? "Stop camera" : "Start camera";

  const modelPill = $("model-pill");
  modelPill.dataset.ok = String(state.modelAvailable);
  $("model-text").textContent = state.modelAvailable ? "Model connected" : "No model key";

  if (!camera.running) setDoor("closed", "Camera idle", "—");
}

function setDoor(stateName, text, meta) {
  const pill = $("door-pill");
  pill.dataset.state = stateName;
  $("door-text").textContent = text;
  if (meta !== undefined) $("door-meta").textContent = meta;
}

function renderLedger() {
  const l = state.ledger || {};
  const saved = Number(l.saved_cad || 0);
  const wasted = Number(l.wasted_cad || 0);
  const total = saved + wasted;

  $("kpi-saved").textContent = money(saved);
  $("kpi-saved-note").textContent = `${l.items_saved || 0} items used before their date`;
  $("kpi-wasted").textContent = money(wasted);
  $("kpi-wasted-note").textContent = `${l.items_wasted || 0} items past saving`;
  $("kpi-count").textContent = String(state.inventory.length);
  $("kpi-count-note").textContent = `${state.expiring.length} need attention`;

  const savedPct = total ? (saved / total) * 100 : 50;
  $("split-saved").style.width = `${savedPct}%`;
  $("split-wasted").style.width = `${100 - savedPct}%`;
  $("split-saved-pct").textContent = total ? `${Math.round(savedPct)}%` : "—";
  $("split-wasted-pct").textContent = total ? `${Math.round(100 - savedPct)}%` : "—";
}

function renderExpiring() {
  const host = $("expiring-list");
  host.replaceChildren();
  $("expiring-count").textContent = state.expiring.length
    ? `${state.expiring.length} within 3 days`
    : "all clear";

  if (!state.expiring.length) {
    host.append(el("p", "empty", "Nothing is close to its date. Rare, and worth noticing."));
    return;
  }

  for (const item of state.expiring) {
    const urgency = urgencyOf(item.days_left);
    const row = el("div", "expiry-row");
    if (!state.knownItemIds.has(item.id)) row.classList.add("is-new");

    row.append(el("i", `glyph g-${urgency.tier}`, urgency.glyph));

    const main = el("div", "expiry-main");
    main.append(el("div", "expiry-name", item.name));
    const handled = item.removal_count
      ? ` · picked up ${item.removal_count}×`
      : "";
    main.append(
      el("div", "expiry-meta", `${item.quantity} ${item.unit} · ${money(item.est_cost)}${handled}`)
    );

    // Days remaining against a fixed one-week window, NOT a fraction of shelf life:
    // two items both due tomorrow must show the same bar, whatever their shelf life.
    const meter = el("div", "meter");
    const fill = el("i");
    const left = Math.max(0, Math.min(1, (item.days_left ?? 0) / METER_WINDOW_DAYS));
    fill.style.width = `${Math.max(4, left * 100)}%`;
    fill.style.background = `var(--${urgency.tier})`;
    meter.setAttribute("role", "img");
    meter.setAttribute("aria-label", `${item.days_left} of ${METER_WINDOW_DAYS} days remaining`);
    meter.append(fill);
    main.append(meter);
    row.append(main);

    row.append(el("span", `days-chip chip-${urgency.tier}`, urgency.label));
    host.append(row);
  }
}

function renderInventory() {
  const host = $("inventory-list");
  host.replaceChildren();
  $("inventory-count").textContent = `${state.inventory.length} items`;

  if (!state.inventory.length) {
    host.append(el("p", "empty", "The fridge is empty. Reset the demo, or open the door."));
    return;
  }

  for (const item of state.inventory) {
    const urgency = urgencyOf(item.days_left);
    const row = el("div", "inv-row");
    row.append(el("i", `glyph g-${urgency.tier}`, urgency.glyph));
    row.append(el("span", "inv-name", item.name));
    row.append(el("span", "inv-qty", `${item.quantity} ${item.unit}`));
    row.append(el("span", "inv-days", urgency.label));

    const discard = el("button", "icon-btn", "✕");
    discard.title = `Throw out the ${item.name} (counts as waste)`;
    discard.setAttribute("aria-label", `Throw out the ${item.name}`);
    discard.addEventListener("click", async () => {
      await api(`/api/items/${item.id}/discard`, { method: "POST" });
      toast(`${item.name} logged as thrown out`, "bad");
      refresh();
    });
    row.append(discard);
    host.append(row);
  }

  state.knownItemIds = new Set(state.inventory.map((i) => i.id));
}

function renderPending() {
  const zone = $("confirm-zone");
  zone.replaceChildren();
  zone.hidden = !state.pending.length;

  for (const pending of state.pending) {
    const card = el("div", "confirm-card");
    card.append(el("div", "confirm-icon", "?"));

    const text = el("div", "confirm-text");
    text.append(el("strong", null, pending.question));
    text.append(
      el(
        "span",
        null,
        `The vision agent was ${Math.round(pending.item.confidence * 100)}% confident, ` +
          `below the ${80}% bar to write it in on its own.`
      )
    );
    card.append(text);

    const actions = el("div", "confirm-actions");
    const yes = el("button", "btn", "Yes, that's right");
    yes.addEventListener("click", () => resolvePending(pending.id, true));
    const no = el("button", "btn btn-ghost", "No");
    no.addEventListener("click", () => resolvePending(pending.id, false));
    actions.append(yes, no);
    card.append(actions);

    zone.append(card);
  }
}

async function resolvePending(id, confirmed) {
  await postJson(`/api/pending/${id}`, { confirmed });
  toast(confirmed ? "Confirmed - written to the inventory" : "Discarded that detection", confirmed ? "good" : "info");
  refresh();
}

function renderFeed(events) {
  const host = $("feed");
  host.replaceChildren();
  if (!events.length) {
    host.append(el("li", "empty", "Nothing yet."));
    return;
  }

  const labels = {
    added: ["ev-added", (e) => `${e.item_name} went in`],
    removed: ["ev-removed", (e) => `${e.item_name} came out`],
    rejected: ["ev-rejected", (e) => `ignored ${e.item_name} — ${e.payload?.reason || "low confidence"}`],
    correction: ["ev-warn", (e) => `you corrected ${e.item_name}`],
    vision_diff: ["ev-rejected", (e) => {
      const d = e.payload || {};
      const n = (d.added?.length || 0) + (d.removed?.length || 0);
      return n ? `vision saw ${n} change${n > 1 ? "s" : ""}` : "vision saw no change";
    }],
    demo_seeded: ["ev-warn", () => "demo fridge loaded"],
    note: ["ev-rejected", (e) => e.payload?.reason || "note"],
  };

  for (const event of events.slice(0, 22)) {
    const [cls, describe] = labels[event.kind] || ["ev-rejected", (e) => e.kind];
    const li = el("li");
    li.append(el("time", null, clockOf(event.ts)));
    li.append(el("span", cls, describe(event)));
    host.append(li);
  }
}

function renderRoster(agents, active = []) {
  const host = $("roster");
  host.replaceChildren();
  for (const agent of agents) {
    const li = el("li");
    li.dataset.active = String(active.includes(agent.name));
    const name = el("div", "roster-name");
    name.append(el("i"));
    name.append(document.createTextNode(agent.name.replace("_", " ")));
    li.append(name);
    li.append(el("div", "roster-role", agent.role));
    host.append(li);
  }
  state.agents = agents;
}

function flashRoster(called) {
  if (!state.agents) return;
  const mapped = called.map((tool) => {
    if (tool === "plan_meals") return "chef";
    if (tool === "check_expiring") return "sentinel";
    if (tool === "save_profile") return "concierge";
    return "concierge";
  });
  if (called.includes("plan_meals")) mapped.push("nutrition");
  renderRoster(state.agents, ["concierge", ...mapped]);
  setTimeout(() => renderRoster(state.agents, []), 4000);
}

/* --- chat ------------------------------------------------------------------ */

function addBubble(role, content, called = [], animate = true) {
  const log = $("chat-log");
  const bubble = el("div", `bubble bubble-${role === "user" ? "user" : "agent"}`);
  bubble.textContent = content;
  if (!animate) bubble.style.animation = "none";

  if (called.length) {
    const strip = el("div", "called");
    [...new Set(called)].forEach((name) => strip.append(el("span", null, name.replace("_", " "))));
    bubble.append(strip);
  }
  log.append(bubble);
  log.scrollTop = log.scrollHeight;
  return bubble;
}

function thinkingBubble(text = "thinking…") {
  const bubble = addBubble("assistant", text);
  bubble.classList.add("is-thinking");
  return bubble;
}

async function send(text) {
  if (!text.trim()) return;
  addBubble("user", text);
  $("chat-input").value = "";
  const thinking = thinkingBubble();

  try {
    const reply = await postJson("/api/chat", { text });
    thinking.remove();
    addBubble("assistant", reply.reply, reply.agents_called || []);
    afterReply(reply);
  } catch (error) {
    thinking.remove();
    addBubble("assistant", `Something broke: ${error.message}`);
  }
}

function afterReply(reply) {
  flashRoster(reply.agents_called || []);
  if (reply.recipes?.length) renderRecipes(reply.recipes, reply.nutrition);
  if (reply.profile_updated) toast("Saved that to your profile", "good");
  if (reply.reply && $("tts-toggle").checked && state.modelAvailable) speak(reply.reply);
  refresh();
}

function renderRecipes(recipes, nutrition) {
  const card = $("recipe-card");
  const host = $("recipe-list");
  host.replaceChildren();
  card.hidden = false;

  const macros = new Map(
    (nutrition?.estimates || []).map((e) => [e.recipe_title, e])
  );
  $("recipe-sub").textContent = nutrition?.day_total_calories
    ? `${recipes.length} options · ~${nutrition.day_total_calories} kcal/day`
    : `${recipes.length} options`;

  for (const recipe of recipes) {
    const details = el("details", "recipe");
    const summary = document.createElement("summary");

    const top = el("div", "recipe-top");
    top.append(el("span", "recipe-title", recipe.title));
    top.append(el("span", "recipe-meal", `${recipe.meal} · ${recipe.minutes} min`));
    summary.append(top);

    if (recipe.why_this) summary.append(el("div", "recipe-why", recipe.why_this));

    const tags = el("div", "recipe-tags");
    (recipe.uses_expiring || []).forEach((n) => tags.append(el("span", "tag tag-urgent", `uses ${n}`)));
    const macro = macros.get(recipe.title);
    if (macro) {
      tags.append(
        el("span", "tag tag-macro",
          `${macro.calories_per_serving} kcal · ${macro.protein_g}g protein`)
      );
    }
    (recipe.missing || []).forEach((n) => tags.append(el("span", "tag tag-missing", `need ${n}`)));
    if (tags.childElementCount) summary.append(tags);
    details.append(summary);

    const body = el("div", "recipe-body");
    body.append(el("h4", null, "Ingredients"));
    const ul = document.createElement("ul");
    for (const ing of recipe.ingredients || []) {
      const li = el("li", ing.from_fridge ? "have" : null, `${ing.amount} ${ing.name}`);
      ul.append(li);
    }
    body.append(ul);

    body.append(el("h4", null, "Method"));
    const ol = document.createElement("ol");
    (recipe.steps || []).forEach((step) => ol.append(el("li", null, step)));
    body.append(ol);

    if (macro?.adjustment) {
      body.append(el("h4", null, "To hit your target"));
      body.append(el("p", "recipe-why", macro.adjustment));
    }

    details.append(body);
    host.append(details);
  }
}

/* --- voice ----------------------------------------------------------------- */

async function speak(text) {
  try {
    const response = await api("/api/speak", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    const audio = new Audio(URL.createObjectURL(await response.blob()));
    audio.play().catch(() => {});   /* autoplay blocked until the user interacts - fine */
  } catch {
    /* speech is a nicety; never let it break the turn */
  }
}

async function toggleRecording() {
  const button = $("btn-mic");
  const hint = $("composer-hint");

  if (state.recording) {
    state.recorder?.stop();
    return;
  }
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
      const thinking = thinkingBubble("listening…");
      try {
        const reply = await apiJson("/api/voice", { method: "POST", body: form });
        thinking.remove();
        hint.textContent = "";
        if (reply.transcript) addBubble("user", reply.transcript);
        addBubble("assistant", reply.reply, reply.agents_called || []);
        afterReply(reply);
      } catch (error) {
        thinking.remove();
        hint.textContent = `Voice failed: ${error.message}`;
      }
    });

    recorder.start();
    state.recorder = recorder;
    state.recording = true;
    button.dataset.recording = "true";
    hint.textContent = "Listening — click again when you're done.";
  } catch {
    hint.textContent = "Microphone permission was refused.";
  }
}

/* --- live stream ----------------------------------------------------------- */

function connectStream() {
  const source = new EventSource("/api/stream");

  source.addEventListener("message", (message) => {
    const event = JSON.parse(message.data);
    const data = event.data || {};

    switch (event.kind) {
      case "door_opened":
        setDoor("open", "Door open", `brightness ${data.brightness}`);
        break;
      case "door_closed":
        setDoor("closed", "Door closed", `brightness ${data.brightness}`);
        break;
      case "analyzing":
        setDoor("analyzing", "Comparing frames…", "vision agent");
        break;
      case "inventory_changed": {
        setDoor("closed", "Door closed", "");
        (data.added || []).forEach((i) => toast(`${i.name} went in — ${i.days_left ?? "?"} days`, "good"));
        (data.removed || []).forEach((i) => toast(`${i.name} came out`, "info"));
        (data.ignored || []).forEach((n) => toast(`Ignored ${n}`, "info"));
        refresh();
        break;
      }
      case "needs_confirmation":
        toast("The fridge is not sure about something", "warn");
        refresh();
        break;
      case "camera_status":
        state.camera = data;
        renderStatus();
        break;
      default:
        break;
    }
  });

  source.addEventListener("error", () => {
    /* EventSource reconnects on its own; nothing to do but wait. */
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
    send($("chat-input").value);
  });

  $("quick-chips").addEventListener("click", (e) => {
    const chip = e.target.closest(".chip");
    if (chip) send(chip.dataset.say);
  });

  $("btn-mic").addEventListener("click", toggleRecording);

  $("btn-camera").addEventListener("click", async () => {
    const running = state.camera.running;
    const result = await apiJson(`/api/camera/${running ? "stop" : "start"}`, { method: "POST" });
    state.camera = result;
    renderStatus();
    if (!running && !result.running) {
      toast(result.error || "No camera found. Use a simulated cycle instead.", "warn");
    }
  });

  $("btn-seed").addEventListener("click", async () => {
    await apiJson("/api/demo/seed", { method: "POST" });
    state.knownItemIds = new Set();
    toast("Demo fridge reloaded", "good");
    refresh();
  });

  $("btn-digest").addEventListener("click", async () => {
    const thinking = thinkingBubble("writing the briefing…");
    try {
      const digest = await apiJson("/api/digest");
      thinking.remove();
      const lines = [digest.headline, ...(digest.alerts || []).map((a) => `• ${a.line}`)];
      if (digest.suggestion) lines.push(digest.suggestion);
      const text = lines.filter(Boolean).join("\n");
      addBubble("assistant", text, ["sentinel"]);
      flashRoster(["sentinel"]);
      if ($("tts-toggle").checked && state.modelAvailable) speak(text);
    } catch (error) {
      thinking.remove();
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
    $("toolbar-hint").textContent = "Comparing the two frames…";
    setDoor("analyzing", "Comparing frames…", "vision agent");
    try {
      const result = await apiJson("/api/door/simulate", { method: "POST", body: form });
      const changes = (result.added?.length || 0) + (result.removed?.length || 0);
      $("toolbar-hint").textContent = changes
        ? `${changes} change${changes > 1 ? "s" : ""} committed.`
        : result.questions?.length
          ? "The fridge has a question."
          : "No change detected between those frames.";
      setDoor("closed", "Door closed", "");
      refresh();
    } catch (error) {
      $("toolbar-hint").textContent = `That failed: ${error.message}`;
      setDoor("closed", "Door closed", "");
    }
    e.target.value = "";
  });
}

async function boot() {
  wire();
  connectStream();
  try {
    const { agents } = await apiJson("/api/agents");
    renderRoster(agents, []);
  } catch {
    /* roster is decoration; the dashboard works without it */
  }
  await refresh();
  if (!state.modelAvailable) {
    toast("No OPENAI_API_KEY - the fridge runs, but the agents are offline.", "warn");
  }
}

boot();
