// Savor: a read-only viewer for backend/pipeline.sh output, served live by frontend/serve.py.
// /api/experiments lists the experiment folders; /api/experiments/<name> returns that folder's
// inventory.json, expire.json, recipes.json and events.json in one document. The page polls it
// and re-renders when the folder changes, so re-running the pipeline shows up by itself.
// Pick an experiment with ?experiment=<name>; the view is in the hash (#inventory, #recipes, #activity).
// "Fresh scan" uploads a video to POST /api/experiments/<name>/upload; the server runs backend/pipeline.sh
// and /api/jobs/<id> reports progress, which the scan modal shows until the run is folded in.

const STEPS_KEY = 'savor-steps-v3';
const POLL_MS = 5000;        // how often to ask the server whether the experiment folder changed
const TICK_MS = 60000;       // how often to recompute "hours left" from expires_at without new data
const JOB_POLL_MS = 1500;    // how often to ask about a running scan
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/;          // same rule as serve.py
const VIDEO_EXTS = ['.mp4', '.m4v', '.mov', '.qt', '.webm', '.mkv', '.avi', '.mpg', '.mpeg', '.3gp', '.wmv', '.flv'];
// Pipeline stages in order, recognised by the prefix each script prints to the log.
const STAGES = [
  { key: 'detect.py', label: 'Detect', icon: '◉', re: /^detect: /m },
  { key: 'update.py', label: 'Inventory', icon: '▦', re: /^update: /m },
  { key: 'check.py', label: 'Expiry', icon: '♧', re: /^check: /m },
  { key: 'chef.py', label: 'Recipes', icon: '✦', re: /^chef: /m },
];
const VIEWS = ['home', 'inventory', 'recipes', 'activity'];
const STATUS_ORDER = { expired: 0, expiring_soon: 1, ok: 2, unknown: 3 };
const STATUS_PILL = { expired: 'urgent', expiring_soon: 'soon', ok: 'fresh', unknown: 'unknown' };
const RECIPE_COLORS = ['#c56c40', '#d57672', '#d49a3f', '#5f8a5a', '#8a6fb5'];
// Fallback emoji by keyword, used only when an item has no icon in backend/db/images
// (i.e. check.py found no shelf-life match). Earlier entries win, so "chili" sits above "jar".
const EMOJI = [
  ['pasta', '🍝'], ['spaghetti', '🍝'], ['noodle', '🍜'], ['rice', '🍚'], ['bread', '🍞'], ['toast', '🍞'],
  ['oil', '🫒'], ['olive', '🫒'], ['butter', '🧈'], ['garlic', '🧄'], ['onion', '🧅'], ['chili', '🌶️'], ['pepper', '🫑'],
  ['parsley', '🌿'], ['basil', '🌿'], ['cilantro', '🌿'], ['herb', '🌿'], ['salt', '🧂'], ['parmesan', '🧀'], ['cheese', '🧀'],
  ['snack', '🍫'], ['chocolate', '🍫'], ['milk', '🥛'], ['yogurt', '🥣'], ['egg', '🥚'], ['chicken', '🍗'], ['beef', '🥩'],
  ['steak', '🥩'], ['meat', '🥩'], ['fish', '🐟'], ['salmon', '🐟'], ['shrimp', '🦐'], ['tofu', '🧊'], ['tomato', '🍅'],
  ['lettuce', '🥬'], ['spinach', '🥬'], ['kale', '🥬'], ['carrot', '🥕'], ['broccoli', '🥦'], ['cucumber', '🥒'],
  ['avocado', '🥑'], ['potato', '🥔'], ['corn', '🌽'], ['mushroom', '🍄'], ['apple', '🍎'], ['banana', '🍌'],
  ['lemon', '🍋'], ['lime', '🍋'], ['orange', '🍊'], ['strawberr', '🍓'], ['berr', '🫐'], ['grape', '🍇'],
  ['juice', '🧃'], ['soda', '🥤'], ['beer', '🍺'], ['wine', '🍷'], ['water', '💧'], ['honey', '🍯'], ['jam', '🫙'],
  ['sauce', '🥫'], ['ketchup', '🥫'], ['cake', '🍰'], ['pizza', '🍕'], ['sushi', '🍣'], ['bar', '🍫'], ['jar', '🫙'],
  ['can', '🥫'], ['bottle', '🍶'], ['box', '📦'],
];

const state = {
  index: null,          // /api/experiments
  icons: {},            // db/images/index.json items: shelf-life key -> {file, emoji}
  experiment: null,     // name currently shown
  raw: null,            // last /api/experiments/<name> document
  data: null,           // joined model, see buildModel()
  loading: true,
  error: null,
  view: 'home',
  filter: 'All',
  query: '',
  doneSteps: loadSteps(),
  lastPoll: null,
  modal: null,          // 'upload' | 'job' | null — which modal is open, so job polls can redraw it
  job: null,            // the scan job being watched (from /api/jobs/<id>)
  upload: null,         // { percent, file, experiment } while a video is being sent
};
let toastTimer;
let pollTimer;
let tickTimer;
let jobTimer;
let uploadXhr;
const app = document.querySelector('#app');
const modalRoot = document.querySelector('#modalRoot');

// ---------- helpers ----------

function loadSteps() { try { return JSON.parse(localStorage.getItem(STEPS_KEY)) || {}; } catch { return {}; } }
function saveSteps() { try { localStorage.setItem(STEPS_KEY, JSON.stringify(state.doneSteps)); } catch { /* private mode */ } }
function escapeHtml(value = '') { return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[char])); }
function emojiFor(name = '') { const n = name.toLowerCase(); const hit = EMOJI.find(([key]) => n.includes(key)); return hit ? hit[1] : '🥡'; }
function plural(n, word) { return `${n} ${word}${n === 1 ? '' : 's'}`; }
function pct(value) { return value == null ? '—' : `${Math.round(value * 100)}%`; }
function todayDate() { return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date()); }
function fmtDate(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).format(t) : '—';
}
function fmtClock(iso) {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(t) : '—';
}
function fmtHours(hours) {
  if (hours == null) return '—';
  const h = Math.abs(hours);
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${Math.round(h)} h`;
  return `${Math.round(h / 24)} days`;
}
function expiryLabel(item) {
  if (item.status === 'expired') return `Expired ${fmtHours(item.hoursLeft)} ago`;
  if (item.status === 'unknown') return 'No shelf life';
  return `${fmtHours(item.hoursLeft)} left`;
}
function urgency(a, b) {
  return (STATUS_ORDER[a.status] - STATUS_ORDER[b.status]) || ((a.hoursLeft ?? Infinity) - (b.hoursLeft ?? Infinity)) || (a.item_id - b.item_id);
}
function apiUrl(name) { return `/api/experiments/${encodeURIComponent(name)}`; }
function fileUrl(file) { return `${apiUrl(state.experiment)}/files/${file.split('/').map(encodeURIComponent).join('/')}`; }

// Icon for a food: the Fluent Emoji PNG for its shelf-life key when check.py matched one, else a keyword emoji.
function iconFile(matched) { return matched && state.icons[matched] ? state.icons[matched].file : null; }
function iconHtml(subject, extraClass = '') {
  const file = iconFile(subject.matched);
  if (file) return `<span class="food-icon is-img ${extraClass}"><img src="/images/${encodeURIComponent(file)}" alt=""></span>`;
  return `<span class="food-icon ${extraClass}">${emojiFor(subject.object)}</span>`;
}

// ---------- data ----------

async function fetchJson(path) {
  try {
    const res = await fetch(path, { cache: 'no-store' });
    if (!res.ok || !(res.headers.get('content-type') || '').includes('json')) return null;
    return await res.json();
  } catch { return null; }
}
async function fetchText(path) {
  try {
    const res = await fetch(path, { cache: 'no-store' });
    if (!res.ok) return null;
    return await res.text();
  } catch { return null; }
}

// Join the four pipeline files into one object the views can read directly.
function buildModel(doc) {
  const { name, inventory, expire, recipes, events } = doc;
  const now = Date.now();
  const threshold = expire?.threshold_hours ?? 48;
  const expiryById = new Map((expire?.items || []).map(entry => [entry.item_id, entry]));
  const matchedById = new Map((expire?.items || []).map(entry => [entry.item_id, entry.matched]));

  // hours_left in expire.json is as of checked_at; recompute from expires_at so the page stays honest over time.
  const items = (inventory.in_fridge || []).map(raw => {
    const entry = expiryById.get(raw.item_id);
    let hoursLeft = null;
    let status = 'unknown';
    if (entry) {
      const at = Date.parse(entry.expires_at);
      hoursLeft = Number.isFinite(at) ? (at - now) / 36e5 : entry.hours_left;
      status = hoursLeft <= 0 ? 'expired' : hoursLeft <= threshold ? 'expiring_soon' : 'ok';
    }
    return {
      ...raw,
      matched: entry?.matched ?? null,
      shelfLifeHours: entry?.shelf_life_hours ?? null,
      expiresAt: entry?.expires_at ?? null,
      hoursLeft,
      status,
    };
  }).sort(urgency);

  const byName = new Map();
  items.forEach(item => { const key = item.object.toLowerCase(); if (!byName.has(key)) byName.set(key, item); });

  const recipeList = (recipes?.recipes || []).map((recipe, index) => {
    const fridge = (recipe.uses_fridge_items || []).map(itemName => ({ name: itemName, item: byName.get(itemName.toLowerCase()) || null }));
    const fridgeNames = new Set(fridge.map(f => f.name.toLowerCase()));
    const pantryNames = new Set((recipe.pantry_items || []).map(p => String(p).toLowerCase()));
    const urgentNames = new Set((recipe.uses_expiring_items || []).map(n => String(n).toLowerCase()));
    return {
      ...recipe,
      id: `r${index}`,
      color: RECIPE_COLORS[index % RECIPE_COLORS.length],
      fridge,
      matched: fridge.filter(f => f.item).length,
      total: fridge.length,
      urgent: (recipe.uses_expiring_items || []).length,
      totalMin: (recipe.prep_time_min || 0) + (recipe.cook_time_min || 0),
      // An ingredient is labelled only when its name is exactly a fridge item or a declared pantry staple.
      ingredients: (recipe.ingredients || []).map(ing => {
        const key = String(ing.item).toLowerCase();
        const source = fridgeNames.has(key) ? 'fridge' : pantryNames.has(key) ? 'pantry' : null;
        return { ...ing, source, fridgeItem: byName.get(key) || null, urgent: urgentNames.has(key) };
      }),
    };
  }).sort((a, b) => (b.urgent - a.urgent) || (b.matched - a.matched) || (a.id < b.id ? -1 : 1));

  const counts = { total: items.length, expired: 0, expiring_soon: 0, ok: 0, unknown: 0 };
  items.forEach(item => { counts[item.status] += 1; });

  return {
    name,
    updatedAt: inventory.updated_at,
    folderUpdatedAt: doc.updated_at,
    checkedAt: expire?.checked_at ?? null,
    generatedAt: recipes?.generated_at ?? null,
    model: recipes?.model || events?.runs?.[0]?.model || null,
    threshold,
    items,
    counts,
    removed: [...(inventory.removed || [])].sort((a, b) => Date.parse(b.removed_at) - Date.parse(a.removed_at)),
    recipes: recipeList,
    useFirst: recipes?.use_first || [],
    excludedExpired: recipes?.excluded_expired || [],
    runs: [...(events?.runs || [])].sort((a, b) => Date.parse(b.recorded_at) - Date.parse(a.recorded_at)),
    events: [...(events?.events || [])].map(event => ({ ...event, matched: matchedById.get(event.item_id) ?? null })).sort((a, b) => Date.parse(b.time) - Date.parse(a.time)),
    missing: [['expire.json', expire], ['recipes.json', recipes], ['events.json', events]].filter(([, value]) => !value).map(([file]) => file),
  };
}

function applyDoc(doc) {
  state.raw = doc;
  if (!doc.inventory) {
    state.data = null;
    state.error = `“${escapeHtml(doc.name)}” has no inventory.json yet. Run <code>bash backend/pipeline.sh VIDEO ${escapeHtml(doc.name)}</code>.`;
  } else {
    state.data = buildModel(doc);
    state.error = null;
  }
}

async function loadExperiment(name) {
  state.experiment = name;
  state.loading = true;
  state.error = null;
  state.data = null;
  state.raw = null;
  state.filter = 'All';
  state.query = '';
  render();
  const doc = await fetchJson(apiUrl(name));
  if (state.experiment !== name) return; // user switched again while this was in flight
  if (!doc) state.error = `Could not load “${escapeHtml(name)}”. Is <code>frontend/serve.py</code> still running?`;
  else applyDoc(doc);
  state.loading = false;
  render();
}

async function boot() {
  const [index, icons, jobs] = await Promise.all([fetchJson('/api/experiments'), fetchJson('/images/index.json'), fetchJson('/api/jobs')]);
  state.index = index;
  state.icons = icons?.items || {};
  const active = (jobs?.jobs || []).find(j => j.status === 'queued' || j.status === 'running');
  if (active) { state.job = active; startJobPolling(); }
  const requested = new URLSearchParams(location.search).get('experiment');
  const hash = location.hash.replace('#', '');
  if (VIEWS.includes(hash)) state.view = hash;
  const names = (state.index?.experiments || []).map(e => e.name);
  const name = requested && names.includes(requested) ? requested : (state.index?.latest || names[0] || null);
  renderExperimentPicker();
  startPolling();
  if (!name) {
    state.loading = false;
    state.error = state.index
      ? 'No experiments yet. Run <code>bash backend/pipeline.sh VIDEO EXPERIMENT</code> and this page will pick it up.'
      : 'Could not reach the server. Start it with <code>python3 frontend/serve.py</code> and open the address it prints.';
    render();
    return;
  }
  if (requested && requested !== name) showToast(`No experiment “${requested}”, showing ${name}`);
  await loadExperiment(name);
}

function setExperiment(name) {
  const url = new URL(location.href);
  url.searchParams.set('experiment', name);
  history.replaceState(null, '', url);
  loadExperiment(name);
}

// Re-rendering while the user is typing in the search box would drop their caret; wait for the next poll instead.
function canRerender() { return document.activeElement?.id !== 'inventorySearch'; }

// Every POLL_MS: has the experiment list or the current folder changed on disk?
async function poll() {
  const index = await fetchJson('/api/experiments');
  state.lastPoll = new Date().toISOString();
  if (index) {
    const before = JSON.stringify(state.index?.experiments || []);
    state.index = index;
    if (JSON.stringify(index.experiments) !== before) renderExperimentPicker();
    if (!state.experiment && index.latest) { loadExperiment(index.latest); return; }
  }
  if (!state.experiment || state.loading) return;
  const doc = await fetchJson(apiUrl(state.experiment));
  if (!doc || doc.name !== state.experiment) return;
  if (state.raw && doc.updated_at === state.raw.updated_at) return;
  const hadData = Boolean(state.data);
  applyDoc(doc);
  if (canRerender()) {
    render();
    if (hadData) showToast(`${doc.name} updated ${fmtClock(doc.updated_at)}`);
  }
}

// Every TICK_MS: same data, fresh clock, so "hours left" and "expired" flip on time.
function tick() {
  if (!state.raw?.inventory || !canRerender()) return;
  state.data = buildModel(state.raw);
  render();
}

function startPolling() {
  clearInterval(pollTimer);
  clearInterval(tickTimer);
  pollTimer = setInterval(poll, POLL_MS);
  tickTimer = setInterval(tick, TICK_MS);
}

// ---------- fragments ----------

function pill(item) { return `<span class="expiry ${STATUS_PILL[item.status]}">${expiryLabel(item)}</span>`; }

function foodRow(item, compact = false) {
  const name = escapeHtml(item.object);
  if (compact) {
    return `<button class="food-row" data-action="open-item" data-id="${item.item_id}">${iconHtml(item)}<span class="food-copy"><strong>${name}</strong><small>${item.matched ? `as “${escapeHtml(item.matched)}”` : 'not in shelf-life database'} · in ${fmtDate(item.entered_at)}</small></span>${pill(item)}</button>`;
  }
  return `<button class="inventory-item" data-action="open-item" data-id="${item.item_id}">${iconHtml(item)}<span class="food-copy"><strong>${name}</strong><small>${item.matched ? `${escapeHtml(item.matched)} · ${item.shelfLifeHours} h shelf life${item.expiresAt ? ` · expires ${fmtDate(item.expiresAt)}` : ''}` : 'not in shelf-life database'}</small></span><span class="item-qty">#${item.item_id} · ${pct(item.confidence)}<small>in ${fmtDate(item.entered_at)}</small></span>${pill(item)}<i class="row-chevron">›</i></button>`;
}

// Up to three icons of the fridge items a recipe uses, on top of its colour block.
function iconCluster(recipe) {
  const subjects = recipe.fridge.filter(f => f.item).slice(0, 3).map(f => f.item);
  return subjects.length ? `<span class="icon-cluster">${subjects.map(s => iconHtml(s)).join('')}</span>` : '';
}
function recipeArt(recipe) { const cluster = iconCluster(recipe); return `<div class="mini-recipe-art ${cluster ? 'has-icons' : ''}" style="--recipe-color:${recipe.color}">${cluster}</div>`; }

function recipeMeta(recipe) {
  return `<span class="recipe-meta"><span>◷ ${recipe.totalMin} min</span><span>◌ ${plural(recipe.servings, 'serving')}</span>${recipe.pantry_items?.length ? `<span>＋ ${plural(recipe.pantry_items.length, 'pantry item')}</span>` : ''}</span>`;
}

function emptyState(icon, title, copy, action = '') { return `<div class="empty-state"><span>${icon}</span><h3>${title}</h3><p>${copy}</p>${action}</div>`; }

// ---------- views ----------

function renderHome() {
  const d = state.data;
  const urgent = d.items.filter(item => item.status === 'expired' || item.status === 'expiring_soon');
  const useFirst = d.items.filter(item => item.status !== 'unknown').slice(0, 3);
  const featured = d.recipes[0];
  const first = urgent[0];
  let headline, copy;
  if (d.counts.expired) {
    headline = `${plural(d.counts.expired, 'ingredient')} past ${d.counts.expired === 1 ? 'its' : 'their'} best.`;
    copy = `${escapeHtml(first.object)} ${expiryLabel(first).toLowerCase()}${urgent.length > 1 ? `, and ${urgent.length - 1} more need${urgent.length - 1 === 1 ? 's' : ''} using soon` : ''}.`;
  } else if (d.counts.expiring_soon) {
    headline = `${plural(d.counts.expiring_soon, 'ingredient')} to use within ${d.threshold} hours.`;
    copy = `${escapeHtml(first.object)} has ${expiryLabel(first).toLowerCase()}${urgent.length > 1 ? `, ${urgent.length - 1} more close behind` : ''}.${featured ? ' We found a meal that uses them.' : ''}`;
  } else if (d.counts.total) {
    headline = 'Your fridge is looking wonderfully fresh.';
    copy = `${plural(d.counts.total, 'item')} inside, nothing due within ${d.threshold} hours.${d.counts.unknown ? ` ${plural(d.counts.unknown, 'item')} ${d.counts.unknown === 1 ? 'has' : 'have'} no shelf-life entry yet.` : ''}`;
  } else {
    headline = 'Nothing in the fridge yet.';
    copy = 'Run the pipeline on a video and everything it spots will show up here.';
  }
  const featuredCluster = featured ? iconCluster(featured) : '';
  return `
    <section class="page-heading">
      <div><p class="eyebrow">Experiment · ${escapeHtml(d.name)}</p><h1>Make the good stuff<br>last longer.</h1><p>Inventory updated ${fmtDate(d.updatedAt)} · ${plural(d.runs.length, 'scan')}${d.model ? ` · ${escapeHtml(d.model)}` : ''}</p></div>
      <span class="date-chip">◷ ${todayDate()}</span>
    </section>
    <section class="content-grid">
      <div class="stack">
        <article class="panel alert-card">
          <p class="eyebrow">Eat this first</p>
          <h2>${headline}</h2>
          <p>${copy}</p>
          ${featured ? `<button class="button light" data-action="open-recipe" data-recipe="${featured.id}">See what to make <span>→</span></button>` : `<button class="button light" data-view="inventory">Open inventory <span>→</span></button>`}
        </article>
        <article class="panel panel-pad">
          <div class="section-top"><h2 class="section-title">Use these first</h2><button class="text-link" data-view="inventory">See all</button></div>
          <div class="food-list">${useFirst.length ? useFirst.map(item => foodRow(item, true)).join('') : emptyState('✦', 'Nothing to hurry', d.counts.unknown ? 'Everything inside is missing a shelf-life entry.' : 'No ingredients are on the clock.')}</div>
          ${d.counts.total > useFirst.length ? `<button class="more-link" data-view="inventory">View ${plural(d.counts.total - useFirst.length, 'more item')} →</button>` : ''}
        </article>
      </div>
      <div class="stack">
        <article class="panel panel-pad">
          <div class="section-top"><h2 class="section-title">At a glance</h2></div>
          <div class="stat-grid">
            <button class="stat-tile" data-view="inventory"><b>${d.counts.total}</b><span>In fridge</span></button>
            <button class="stat-tile ${urgent.length ? 'is-warm' : ''}" data-view="inventory" data-filter="Use soon"><b>${urgent.length}</b><span>Use soon</span></button>
            <button class="stat-tile" data-view="inventory" data-filter="Unknown"><b>${d.counts.unknown}</b><span>No shelf life</span></button>
            <button class="stat-tile" data-view="activity"><b>${d.runs.length}</b><span>Scans</span></button>
          </div>
        </article>
        ${featured ? `<article class="panel plan-card">
          <div class="recipe-image ${featuredCluster ? 'has-icons' : ''}" style="--recipe-color:${featured.color}">${featuredCluster}<span class="match">${featured.matched}/${featured.total} ingredients on hand</span></div>
          <div class="plan-copy"><p class="eyebrow">Tonight's idea</p><h3>${escapeHtml(featured.name)}</h3><p>${escapeHtml(featured.description)}</p><div class="section-top" style="margin:0">${recipeMeta(featured)}<button class="text-link" data-action="open-recipe" data-recipe="${featured.id}">Make it →</button></div></div>
        </article>` : `<article class="panel panel-pad">${emptyState('✦', 'No recipes yet', 'recipes.json was not found for this experiment.')}</article>`}
      </div>
    </section>`;
}

const FILTERS = {
  'All': () => true,
  'Use soon': item => item.status === 'expired' || item.status === 'expiring_soon',
  'Fresh': item => item.status === 'ok',
  'Unknown': item => item.status === 'unknown',
};

function renderInventory() {
  const d = state.data;
  const query = state.query.toLowerCase().trim();
  const filter = FILTERS[state.filter] || FILTERS.All;
  const items = d.items.filter(item => filter(item) && (!query || item.object.toLowerCase().includes(query) || (item.matched || '').toLowerCase().includes(query)));
  const filterCounts = { 'All': d.counts.total, 'Use soon': d.counts.expired + d.counts.expiring_soon, 'Fresh': d.counts.ok, 'Unknown': d.counts.unknown };
  return `
    <section class="page-heading"><div><p class="eyebrow">Keep tabs, effortlessly</p><h1>Fridge inventory</h1><p>${plural(d.counts.total, 'item')} detected across ${plural(d.runs.length, 'scan')}, sorted by what needs you first.</p></div><span class="date-chip">◷ Expiry checked ${fmtDate(d.checkedAt)}</span></section>
    <section class="panel panel-pad">
      <div class="inventory-toolbar"><label class="search-wrap"><span>⌕</span><input id="inventorySearch" value="${escapeHtml(state.query)}" placeholder="Search your fridge" aria-label="Search inventory"></label><button class="button outline" data-action="show-alerts">♧ ${plural(filterCounts['Use soon'], 'alert')}</button><button class="button outline" data-action="open-upload">⌁ Fresh scan</button></div>
      <div class="filter-row">${Object.keys(FILTERS).map(name => `<button class="filter-pill ${state.filter === name ? 'is-active' : ''}" data-filter="${name}">${name} <b>${filterCounts[name]}</b></button>`).join('')}</div>
      <div class="inventory-list">${items.length ? items.map(item => foodRow(item)).join('') : emptyState('⌕', 'Nothing matches that', d.counts.total ? 'Try another search or filter.' : 'The pipeline has not put anything in this fridge yet.')}</div>
    </section>
    ${d.counts.unknown ? `<section class="panel note-card"><span class="tip-icon">?</span><div><h2 class="section-title">${plural(d.counts.unknown, 'item')} without a shelf life</h2><p>${d.items.filter(item => item.status === 'unknown').map(item => escapeHtml(item.object)).join(', ')} did not match anything in <code>backend/db/expire.json</code>. Add an alias there and re-run <code>python -m check_expire.check --experiment experiments/${escapeHtml(d.name)}</code> from backend/ to track ${d.counts.unknown === 1 ? 'it' : 'them'}.</p></div></section>` : ''}
    ${d.removed.length ? `<section class="panel panel-pad"><div class="section-top"><h2 class="section-title">Taken out</h2><span class="date-chip">${plural(d.removed.length, 'item')}</span></div><div class="food-list">${d.removed.map(item => `<div class="food-row is-static">${iconHtml(item)}<span class="food-copy"><strong>${escapeHtml(item.object)}</strong><small>${item.entered_at ? `in ${fmtDate(item.entered_at)} · ` : 'never seen going in · '}out ${fmtDate(item.removed_at)}</small></span><span class="badge out">out</span></div>`).join('')}</div></section>` : ''}`;
}

function renderRecipes() {
  const d = state.data;
  const featured = d.recipes[0];
  const pantry = [...new Set(d.recipes.flatMap(recipe => recipe.pantry_items || []))];
  return `
    <section class="page-heading"><div><p class="eyebrow">Waste less, eat better</p><h1>What should we make?</h1><p>${plural(d.recipes.length, 'idea')} built around what the camera saw${d.model ? ` · ${escapeHtml(d.model)}` : ''}${d.generatedAt ? ` · ${fmtDate(d.generatedAt)}` : ''}.</p></div><span class="date-chip">✦ ${d.useFirst.length || 'No'} item${d.useFirst.length === 1 ? '' : 's'} to use first</span></section>
    <section class="plan-page-grid">
      <div class="panel panel-pad">
        <div class="section-top"><h2 class="section-title">Best matches</h2><span class="date-chip">Sorted by urgency</span></div>
        <div class="recipe-list">${d.recipes.length ? d.recipes.map(recipe => `<article class="recipe-row">${recipeArt(recipe)}<div><h3>${escapeHtml(recipe.name)}</h3><p>${escapeHtml(recipe.description)}</p>${recipeMeta(recipe)}</div><div><div class="match-number">${recipe.matched}/${recipe.total} in fridge${recipe.urgent ? `<br><em>${plural(recipe.urgent, 'expiring item')}</em>` : ''}</div><button class="text-link" data-action="open-recipe" data-recipe="${recipe.id}">View recipe →</button></div></article>`).join('') : emptyState('✦', 'No recipes yet', `recipes.json was not found for this experiment. Run <code>python -m chef.chef --experiment experiments/${escapeHtml(d.name)}</code> from backend/.`)}</div>
      </div>
      <div class="stack">
        <article class="panel tip-card"><span class="tip-icon">✦</span><h2>${d.useFirst.length ? 'Cook these before they turn.' : 'Food that gets used feels good.'}</h2><p>${d.useFirst.length ? `${d.useFirst.map(escapeHtml).join(', ')} ${d.useFirst.length === 1 ? 'is' : 'are'} inside the ${d.threshold} hour window, so the chef was told to build around ${d.useFirst.length === 1 ? 'it' : 'them'}.` : `Nothing is inside the ${d.threshold} hour window, so the chef was free to use anything in the fridge.`}</p>${featured ? `<button class="button" data-action="open-recipe" data-recipe="${featured.id}">Open the top match</button>` : ''}</article>
        <article class="panel panel-pad">
          <div class="section-top"><h2 class="section-title">Chef notes</h2></div>
          <div class="setting-list">
            <div class="setting"><span>◌</span><span><strong>Model</strong><small>${escapeHtml(d.model || 'unknown')}</small></span></div>
            <div class="setting"><span>▦</span><span><strong>Ingredients offered</strong><small>${plural(d.counts.total - d.excludedExpired.length, 'item')} from the fridge${d.counts.unknown ? `, ${d.counts.unknown} with no shelf life` : ''}</small></span></div>
            <div class="setting"><span>✕</span><span><strong>Left out as expired</strong><small>${d.excludedExpired.length ? d.excludedExpired.map(escapeHtml).join(', ') : 'nothing'}</small></span></div>
            <div class="setting"><span>＋</span><span><strong>Pantry staples assumed</strong><small>${pantry.map(escapeHtml).join(', ') || 'none'}</small></span></div>
          </div>
        </article>
      </div>
    </section>`;
}

function renderActivity() {
  const d = state.data;
  const options = (state.index?.experiments || []).map(e => `<option value="${escapeHtml(e.name)}" ${e.name === d.name ? 'selected' : ''}>${escapeHtml(e.name)}</option>`).join('');
  return `
    <section class="page-heading"><div><p class="eyebrow">Under the hood</p><h1>Scan activity</h1><p>${plural(d.runs.length, 'video')} processed · ${plural(d.events.length, 'event')} · ${plural(d.removed.length, 'item')} taken out.</p></div><label class="date-chip picker-chip">Experiment <select class="experiment-select" data-role="experiment">${options}</select></label></section>
    <section class="content-grid">
      <div class="stack">
        <article class="panel panel-pad">
          <div class="section-top"><h2 class="section-title">Runs</h2><span class="date-chip">Newest first</span></div>
          <div class="run-list">${d.runs.length ? d.runs.map(run => `<article class="run-row"><div class="run-main"><strong>${escapeHtml(run.video)}</strong><small>${fmtDate(run.recorded_at)} · ${run.duration_s != null ? `${run.duration_s.toFixed(1)} s` : '—'} · ${escapeHtml(run.model || '')}</small><code>${escapeHtml(run.run)}</code></div><div class="run-stats"><span class="badge in">+${run.added ?? 0} in</span><span class="badge out">−${run.removed ?? 0} out</span>${run.untracked_removed ? `<span class="badge">${run.untracked_removed} untracked</span>` : ''}</div><button class="button outline" data-action="open-log" data-run="${escapeHtml(run.run)}">Log</button></article>`).join('') : emptyState('⌁', 'No runs yet', 'events.json has no run summaries.')}</div>
        </article>
        <article class="panel panel-pad">
          <div class="section-top"><h2 class="section-title">Timeline</h2><span class="date-chip">${plural(d.events.length, 'event')}</span></div>
          <div class="timeline">${d.events.length ? d.events.map(event => `<button class="event-row" data-action="open-item" data-id="${event.item_id}"><span class="badge ${event.action === 'in' ? 'in' : 'out'}">${escapeHtml(event.action)}</span>${iconHtml(event)}<span class="food-copy"><strong>${escapeHtml(event.object)}</strong><small>${fmtDate(event.time)} · ${escapeHtml(event.video)} @ ${event.time_s != null ? `${event.time_s.toFixed(1)} s` : '—'}</small></span><span class="item-qty">#${event.item_id}<small>${pct(event.confidence)}</small></span></button>`).join('') : emptyState('⌁', 'Quiet so far', 'No in/out events recorded.')}</div>
        </article>
      </div>
      <div class="stack">
        <article class="panel panel-pad">
          <div class="section-top"><h2 class="section-title">This experiment</h2></div>
          <div class="setting-list">
            <div class="setting"><span>⌂</span><span><strong>Folder</strong><small><code>backend/experiments/${escapeHtml(d.name)}</code></small></span></div>
            <div class="setting"><span>◷</span><span><strong>Inventory updated</strong><small>${fmtDate(d.updatedAt)}</small></span></div>
            <div class="setting"><span>♧</span><span><strong>Expiry checked</strong><small>${fmtDate(d.checkedAt)} · ${d.threshold} h threshold · hours shown are live</small></span></div>
            <div class="setting"><span>✦</span><span><strong>Recipes generated</strong><small>${fmtDate(d.generatedAt)}</small></span></div>
            <div class="setting"><span>↻</span><span><strong>Auto-refresh</strong><small>Folder checked every ${POLL_MS / 1000} s${state.lastPoll ? ` · last ${fmtClock(state.lastPoll)}` : ''} · files last changed ${fmtClock(d.folderUpdatedAt)}</small></span></div>
          </div>
        </article>
        <article class="panel panel-pad">
          <div class="section-top"><h2 class="section-title">Raw files</h2></div>
          <div class="file-links">${['inventory.json', 'expire.json', 'recipes.json', 'events.json'].map(file => `<a class="file-link ${d.missing.includes(file) ? 'is-missing' : ''}" href="${fileUrl(file)}" target="_blank" rel="noopener">${file}<span>${d.missing.includes(file) ? 'missing' : 'open ↗'}</span></a>`).join('')}</div>
        </article>
        <article class="panel tip-card"><span class="tip-icon">⌁</span><h2>Add another video.</h2><p>Every run folds into this experiment: new items join, items seen leaving are taken off, expiry and recipes are recomputed. This page updates on its own.</p><code class="cmd">bash backend/pipeline.sh clip.mp4 ${escapeHtml(d.name)}</code></article>
      </div>
    </section>`;
}

function renderStatus() {
  if (state.loading) return `<section class="panel state-panel"><span class="state-orbit">⌁</span><h2>Reading ${escapeHtml(state.experiment || 'experiments')}…</h2><p>Fetching inventory, expiry, recipes, and events.</p></section>`;
  return `<section class="panel state-panel"><span class="state-orbit is-quiet">▦</span><h2>Nothing to show</h2><p>${state.error || 'The experiment could not be loaded.'}</p><button class="button" data-action="reload">Try again</button></section>`;
}

function renderExperimentPicker() {
  const select = document.querySelector('#experimentSelect');
  const experiments = state.index?.experiments || [];
  select.innerHTML = experiments.length
    ? experiments.map(e => `<option value="${escapeHtml(e.name)}">${escapeHtml(e.name)}${e.name === state.index.latest ? ' · latest' : ''}</option>`).join('')
    : '<option value="">No experiments yet</option>';
  select.disabled = !experiments.length;
  if (state.experiment) select.value = state.experiment;
}

function render() {
  const d = state.data;
  const views = { home: renderHome, inventory: renderInventory, recipes: renderRecipes, activity: renderActivity };
  app.innerHTML = d ? views[state.view]() : renderStatus();
  document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('is-active', button.dataset.view === state.view));
  document.querySelector('#inventoryCount').textContent = d ? d.counts.total : 0;
  const alerts = d ? d.counts.expired + d.counts.expiring_soon : 0;
  document.querySelector('#notificationDot').style.display = alerts ? 'block' : 'none';
  const select = document.querySelector('#experimentSelect');
  if (state.experiment && select.value !== state.experiment) select.value = state.experiment;
  const card = document.querySelector('#experimentCard');
  card.querySelector('strong').textContent = state.experiment || 'No experiment';
  card.querySelector('small').textContent = d ? `${plural(d.counts.total, 'item')} · ${plural(d.runs.length, 'scan')}` : (state.loading ? 'Loading…' : 'Run backend/pipeline.sh');
  updateScanBadge();
}

// Sidebar "Fresh scan" card and the topbar dot reflect the job being watched.
function updateScanBadge() {
  const job = state.job;
  const busy = Boolean(job && (job.status === 'queued' || job.status === 'running'));
  const card = document.querySelector('#scanCard');
  card.classList.toggle('is-busy', busy);
  card.dataset.action = busy ? 'open-job' : 'open-upload';
  card.querySelector('strong').textContent = busy ? (job.status === 'queued' ? 'Scan queued' : 'Scanning…') : 'Fresh scan';
  card.querySelector('small').textContent = busy ? `${job.video} · ${stageOf(job).label}` : 'Upload a fridge video';
  document.querySelector('.scan-button').classList.toggle('is-busy', busy);
  document.querySelector('.scan-button').dataset.action = busy ? 'open-job' : 'open-upload';
}

// ---------- modals ----------

function showToast(message) { const toast = document.querySelector('#toast'); toast.textContent = message; toast.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 2700); }
function closeModal() { modalRoot.innerHTML = ''; state.modal = null; if (state.upload && uploadXhr) { uploadXhr.abort(); } state.upload = null; }
function modalShell(inner, extraClass = '') { return `<div class="modal-backdrop ${extraClass}" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true">${inner}</section></div>`; }

function recipeModal(recipeId) {
  const d = state.data;
  const recipe = d.recipes.find(r => r.id === recipeId) || d.recipes[0];
  if (!recipe) return;
  const key = `${d.name}::${recipe.name}`;
  const checks = state.doneSteps[key] || [];
  // ✓ = named exactly like a fridge item, ＋ = a pantry staple the chef declared, · = neither (not guessed).
  const ingredientLine = ing => {
    const cls = ing.source === 'fridge' ? 'from-fridge' : ing.source === 'pantry' ? 'from-pantry' : 'from-other';
    const mark = ing.source === 'fridge' ? '✓' : ing.source === 'pantry' ? '＋' : '·';
    const note = ing.source === 'fridge' ? ' · from the fridge' : ing.source === 'pantry' ? ' · pantry' : '';
    return `<div class="ingredient-line ${cls} ${ing.urgent ? 'is-urgent' : ''}"><span class="ingredient-mark">${mark}</span><span class="ingredient-copy"><strong>${escapeHtml(ing.item)}</strong><small>${escapeHtml(ing.amount)}${note}</small></span></div>`;
  };
  modalRoot.innerHTML = modalShell(`
    <div class="recipe-hero" style="background:linear-gradient(110deg,${recipe.color},#d89049 54%,#416a45)"><button class="modal-close" data-action="close-modal" aria-label="Close">×</button><p class="eyebrow">${recipe.matched}/${recipe.total} from your fridge${recipe.urgent ? ` · ${plural(recipe.urgent, 'expiring item')}` : ''}</p><h2 id="recipeTitle">${escapeHtml(recipe.name)}</h2><p>◷ ${recipe.prep_time_min} min prep + ${recipe.cook_time_min} min cook &nbsp;&nbsp; ◌ ${plural(recipe.servings, 'serving')}</p></div>
    <div class="recipe-details">
      <div><h3>Ingredients</h3>${recipe.ingredients.length ? recipe.ingredients.map(ingredientLine).join('') : '<p>No ingredient list.</p>'}</div>
      <div><h3>Why it works</h3><p class="recipe-why">${escapeHtml(recipe.description)}</p><p class="recipe-why">Uses from the fridge: ${recipe.fridge.map(f => escapeHtml(f.name)).join(', ') || 'nothing listed'}.</p>${recipe.fridge.some(f => !f.item) ? `<p class="recipe-why is-muted">Not in the fridge any more: ${recipe.fridge.filter(f => !f.item).map(f => escapeHtml(f.name)).join(', ')}.</p>` : ''}</div>
    </div>
    <div class="steps"><h3>Steps</h3>${recipe.steps.map((step, index) => `<button class="step-check ${checks.includes(index) ? 'is-done' : ''}" data-action="toggle-step" data-recipe="${recipe.id}" data-step="${index}"><span>${checks.includes(index) ? '✓' : index + 1}</span>${escapeHtml(step)}</button>`).join('')}${checks.length ? `<div class="modal-actions"><button class="button outline" data-action="clear-steps" data-recipe="${recipe.id}">Clear progress</button></div>` : ''}</div>`, 'recipe-modal');
}

function itemModal(itemId) {
  const d = state.data;
  const id = Number(itemId);
  const item = d.items.find(i => i.item_id === id);
  const gone = !item && d.removed.find(i => i.item_id === id);
  const subject = item || gone;
  if (!subject) return;
  const history = d.events.filter(event => event.item_id === id);
  const usedIn = d.recipes.filter(recipe => recipe.fridge.some(f => f.name.toLowerCase() === subject.object.toLowerCase()));
  const row = (label, value) => `<div class="detail-row"><span>${label}</span><strong>${value}</strong></div>`;
  modalRoot.innerHTML = modalShell(`
    <header class="modal-head"><div><p class="eyebrow">Item #${subject.item_id}${gone ? ' · taken out' : ''}</p><h2>${escapeHtml(subject.object)}</h2></div><button class="modal-close" data-action="close-modal" aria-label="Close">×</button></header>
    <div class="modal-body">
      ${item ? `<div class="detail-status">${pill(item)}<span>${item.expiresAt ? `expires ${fmtDate(item.expiresAt)}` : 'add an alias in db/expire.json to track this'}</span></div>` : `<div class="detail-status"><span class="badge out">out</span><span>removed ${fmtDate(gone.removed_at)}</span></div>`}
      <div class="detail-grid">
        ${row('Went in', subject.entered_at ? fmtDate(subject.entered_at) : 'never seen')}
        ${row('Confidence', pct(subject.confidence))}
        ${row('Run', `<code>${escapeHtml(subject.run || '—')}</code>`)}
        ${row('Video', escapeHtml(subject.video || '—'))}
        ${item ? row('Matched as', item.matched ? escapeHtml(item.matched) : 'no match') : ''}
        ${item?.shelfLifeHours != null ? row('Shelf life', `${item.shelfLifeHours} h`) : ''}
      </div>
      ${usedIn.length ? `<h3 class="detail-title">Used in</h3>${usedIn.map(recipe => `<button class="food-row" data-action="open-recipe" data-recipe="${recipe.id}"><span class="food-icon" style="background:${recipe.color}22">✦</span><span class="food-copy"><strong>${escapeHtml(recipe.name)}</strong><small>${recipe.matched}/${recipe.total} in fridge</small></span><i class="row-chevron">›</i></button>`).join('')}` : ''}
      ${history.length ? `<h3 class="detail-title">History</h3>${history.map(event => `<div class="food-row is-static"><span class="badge ${event.action === 'in' ? 'in' : 'out'}">${escapeHtml(event.action)}</span><span class="food-copy"><strong>${fmtDate(event.time)}</strong><small>${escapeHtml(event.video)} @ ${event.time_s != null ? `${event.time_s.toFixed(1)} s` : '—'} · ${pct(event.confidence)}</small></span></div>`).join('')}` : ''}
    </div>`);
}

async function logModal(run) {
  modalRoot.innerHTML = modalShell(`<header class="modal-head"><div><p class="eyebrow">run.log</p><h2>${escapeHtml(run)}</h2></div><button class="modal-close" data-action="close-modal" aria-label="Close">×</button></header><div class="modal-body"><pre class="log-pre">Loading…</pre></div>`, 'log-modal');
  const text = await fetchText(fileUrl(`runs/${run}/run.log`));
  const pre = modalRoot.querySelector('.log-pre');
  if (!pre) return; // closed while loading
  pre.textContent = text ?? 'run.log not found for this run.';
}

function showAlerts() {
  const d = state.data;
  const urgent = d ? d.items.filter(item => item.status === 'expired' || item.status === 'expiring_soon') : [];
  modalRoot.innerHTML = modalShell(`<header class="modal-head"><h2>Kitchen updates</h2><button class="modal-close" data-action="close-modal" aria-label="Close">×</button></header><div class="modal-body"><p>${urgent.length ? `${plural(urgent.length, 'ingredient')} inside the ${d.threshold} hour window.` : 'Everything in your kitchen is looking fresh.'}</p>${urgent.map(item => foodRow(item, true)).join('')}</div>`);
}

// ---------- fresh scan: upload a video, watch the pipeline ----------

function fmtBytes(n) { return n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(2)} GB` : n >= 1024 ** 2 ? `${(n / 1024 ** 2).toFixed(1)} MB` : `${Math.round(n / 1024)} KB`; }

function uploadModal() {
  if (state.job && (state.job.status === 'queued' || state.job.status === 'running')) { jobModal(); return; }
  state.modal = 'upload';
  const names = (state.index?.experiments || []).map(e => e.name);
  const suggested = state.experiment || names[0] || 'experiment1';
  modalRoot.innerHTML = modalShell(`
    <header class="modal-head"><div><p class="eyebrow">Fresh scan</p><h2>Upload a fridge video</h2></div><button class="modal-close" data-action="close-modal" aria-label="Close">×</button></header>
    <div class="modal-body">
      <p>The video goes to <code>backend/experiments/&lt;experiment&gt;/uploads/</code>, then <code>pipeline.sh</code> runs: items seen going in join the inventory, items seen leaving come off it, expiry and recipes are recomputed.</p>
      <form id="uploadForm" class="upload-form">
        <label class="field"><span>Experiment</span><input type="text" name="experiment" value="${escapeHtml(suggested)}" list="experimentNames" autocomplete="off" spellcheck="false" required><small>An existing folder adds to it; a new name starts a new experiment.</small></label>
        <datalist id="experimentNames">${names.map(n => `<option value="${escapeHtml(n)}">`).join('')}</datalist>
        <label class="drop" for="uploadFile"><input id="uploadFile" type="file" name="video" accept="video/*,.mov,.mp4,.m4v,.webm,.mkv,.avi,.mpg,.mpeg,.3gp,.wmv,.flv"><b>Drop a video here or click to choose</b><small>${VIDEO_EXTS.join(' · ')}</small><span class="picked" id="pickedFile"></span></label>
        <div id="uploadError"></div>
        <div id="uploadProgress" hidden><div class="progress"><b style="width:0%"></b></div><small class="refresh-note" id="uploadProgressText">Uploading…</small></div>
        <div class="modal-actions"><button type="button" class="button outline" data-action="close-modal">Cancel</button><button type="submit" class="button" id="uploadSubmit">Scan this video →</button></div>
      </form>
    </div>`);
}

function showPickedFile(file) { const el = modalRoot.querySelector('#pickedFile'); if (el) el.textContent = file ? `${file.name} · ${fmtBytes(file.size)}` : ''; setUploadError(''); }
function setUploadError(message) { const el = modalRoot.querySelector('#uploadError'); if (el) el.innerHTML = message ? `<p class="form-error">${escapeHtml(message)}</p>` : ''; }

function startUpload(file, experiment) {
  state.upload = { percent: 0, file, experiment };
  const form = modalRoot.querySelector('#uploadForm');
  form.querySelector('#uploadSubmit').disabled = true;
  form.querySelector('#uploadProgress').hidden = false;
  setUploadError('');
  const xhr = uploadXhr = new XMLHttpRequest();
  xhr.open('POST', `${apiUrl(experiment)}/upload?filename=${encodeURIComponent(file.name)}`);
  xhr.upload.onprogress = event => {
    if (!event.lengthComputable) return;
    const percent = Math.round(event.loaded / event.total * 100);
    const bar = modalRoot.querySelector('#uploadProgress b'), text = modalRoot.querySelector('#uploadProgressText');
    if (bar) bar.style.width = `${percent}%`;
    if (text) text.textContent = `Uploading ${file.name} · ${percent}% of ${fmtBytes(file.size)}`;
  };
  xhr.onerror = () => { state.upload = null; setUploadError('Upload failed — is frontend/serve.py still running?'); form.querySelector('#uploadSubmit').disabled = false; };
  xhr.onload = () => {
    state.upload = null;
    let body = null;
    try { body = JSON.parse(xhr.responseText); } catch { /* not JSON */ }
    if (xhr.status !== 202 || !body?.job) {
      setUploadError(body?.error || `Server answered ${xhr.status}.`);
      form.querySelector('#uploadSubmit').disabled = false;
      form.querySelector('#uploadProgress').hidden = true;
      return;
    }
    state.job = body.job;
    jobModal();
    startJobPolling();
  };
  xhr.send(file);
}

function startJobPolling() {
  clearInterval(jobTimer);
  jobTimer = setInterval(pollJob, JOB_POLL_MS);
  updateScanBadge();
}

async function pollJob() {
  const job = state.job;
  if (!job) { clearInterval(jobTimer); return; }
  const res = await fetchJson(`/api/jobs/${encodeURIComponent(job.id)}`);
  if (!res?.job) return;
  const wasActive = job.status === 'queued' || job.status === 'running';
  state.job = res.job;
  const active = res.job.status === 'queued' || res.job.status === 'running';
  if (state.modal === 'job') jobModal();
  updateScanBadge();
  if (!active) {
    clearInterval(jobTimer);
    if (wasActive) {
      if (res.job.status === 'done') showToast(`Scan of ${res.job.video} finished`);
      else showToast(`Scan of ${res.job.video} failed`);
      // Pull the new files straight away (the picker may also gain a new experiment), then redraw
      // the result with the icons the fresh inventory knows about.
      await poll();
      if (state.modal === 'job') jobModal();
    }
  }
}

// Which stage the pipeline is in, from what it has printed so far.
function stageOf(job) {
  const log = job.log || '';
  let index = -1;
  STAGES.forEach((stage, i) => { if (stage.re.test(log)) index = i; });
  if (job.status === 'queued') return { index: -1, label: 'waiting' };
  if (index < 0) return { index: 0, label: 'starting' };
  return { index, label: STAGES[index].label.toLowerCase() };
}

function failedStage(job) { const m = /^pipeline\.sh: (\S+) failed \(exit/m.exec(job.log || ''); return m ? m[1] : null; }

function elapsed(job) {
  const start = Date.parse(job.started_at || job.queued_at), end = Date.parse(job.finished_at) || Date.now();
  if (!Number.isFinite(start)) return '';
  const s = Math.max(0, Math.round((end - start) / 1000));
  return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`;
}

function jobModal() {
  const job = state.job;
  if (!job) return;
  state.modal = 'job';
  const active = job.status === 'queued' || job.status === 'running';
  const current = stageOf(job).index;
  const failed = failedStage(job);
  const stages = STAGES.map((stage, i) => {
    let cls = '';
    if (job.status === 'done' || i < current) cls = 'is-done';
    else if (job.status === 'failed') cls = failed === stage.key || (!failed && i === current) ? 'is-failed' : (i < current ? 'is-done' : '');
    else if (i === current) cls = 'is-active';
    return `<div class="stage ${cls}"><span>${stage.icon}</span>${stage.label}</div>`;
  }).join('');
  const title = job.status === 'queued' ? 'Waiting for the previous scan…' : job.status === 'running' ? 'Looking inside your fridge…' : job.status === 'done' ? 'Scan complete' : 'Scan failed';
  const orbit = job.status === 'done' ? '<span class="state-orbit is-done">✓</span>' : job.status === 'failed' ? '<span class="state-orbit is-failed">✕</span>' : '<span class="state-orbit">⌁</span>';
  const sub = `${escapeHtml(job.video)} → <code>${escapeHtml(job.experiment)}</code>${job.started_at ? ` · ${elapsed(job)}` : ''}${job.exit_code != null && job.exit_code !== 0 ? ` · exit ${job.exit_code}` : ''}`;

  let result = '';
  if (job.status === 'done' && job.result) {
    const sum = job.result.summary;
    const ins = job.result.events.filter(e => e.action === 'in'), outs = job.result.events.filter(e => e.action === 'out');
    const row = e => `<div class="food-row is-static"><span class="badge ${e.action === 'in' ? 'in' : 'out'}">${escapeHtml(e.action)}</span>${iconHtml({ object: e.object, matched: state.data?.items.find(i => i.item_id === e.item_id)?.matched ?? null })}<span class="food-copy"><strong>${escapeHtml(e.object)}</strong><small>${fmtDate(e.time)} · #${e.item_id}</small></span></div>`;
    result = `<p>${sum ? `${plural(sum.events, 'event')} in ${sum.duration_s != null ? `${sum.duration_s.toFixed(1)} s of video` : 'the video'}: <b>+${sum.added}</b> in, <b>−${sum.removed}</b> out${sum.untracked_removed ? `, ${sum.untracked_removed} out that were never tracked` : ''}. Run <code>${escapeHtml(job.result.run)}</code>.` : 'The run finished but its summary is not in events.json yet.'}</p>
      <div class="result-lists">
        ${ins.length ? `<div><h3>Went in</h3><div class="food-list">${ins.map(row).join('')}</div></div>` : ''}
        ${outs.length ? `<div><h3>Came out</h3><div class="food-list">${outs.map(row).join('')}</div></div>` : ''}
        ${!job.result.events.length ? emptyState('⌁', 'Nothing crossed the door', 'The model saw no item enter or leave in this video.') : ''}
      </div>`;
  } else if (job.status === 'done') {
    result = '<p>Finished, but no run summary was found in events.json.</p>';
  } else if (job.status === 'failed') {
    result = `<p class="form-error">${escapeHtml(job.error || `${failed || 'The pipeline'} exited with code ${job.exit_code}. The log below has the reason.`)}</p>`;
  }

  const actions = active
    ? '<div class="modal-actions"><button class="button outline" data-action="close-modal">Keep scanning in the background</button></div>'
    : `<div class="modal-actions"><button class="button outline" data-action="open-upload">Scan another video</button>${job.status === 'done' ? `<button class="button" data-action="open-job-experiment">Open ${escapeHtml(job.experiment)} →</button>` : ''}</div>`;

  modalRoot.innerHTML = modalShell(`
    <div class="job-head">${orbit}<div><h2>${title}</h2><p>${sub}</p></div></div>
    <div class="modal-body">
      <div class="stage-list">${stages}</div>
      ${result}
      <details ${active || job.status === 'failed' ? 'open' : ''}><summary class="detail-title" style="cursor:pointer">Pipeline log${job.log_truncated ? ' (tail)' : ''} · <a href="/api/jobs/${encodeURIComponent(job.id)}/log" target="_blank" rel="noopener">full ↗</a></summary><pre class="log-pre job-log">${escapeHtml(job.log || (job.status === 'queued' ? 'Queued behind another scan.' : 'Starting…'))}</pre></details>
      ${actions}
    </div>`, 'log-modal');
  const pre = modalRoot.querySelector('.job-log');
  if (pre) pre.scrollTop = pre.scrollHeight;
}

// ---------- events ----------

document.addEventListener('click', event => {
  const target = event.target.closest('[data-action], [data-view], [data-filter]');
  if (!target) return;
  if (target.dataset.view) {
    event.preventDefault();
    if (!state.data) return;
    state.view = target.dataset.view;
    state.query = '';
    state.filter = target.dataset.filter || 'All';
    closeModal();
    history.replaceState(null, '', `${location.pathname}${location.search}#${state.view}`);
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    return;
  }
  if (target.dataset.filter) { state.filter = target.dataset.filter; render(); return; }
  const action = target.dataset.action;
  if (action === 'close-modal') { if (target === event.target || event.target.closest('.modal-close')) closeModal(); return; }
  if (!state.data && !['reload', 'open-upload', 'open-job', 'pick-file', 'open-job-experiment'].includes(action)) return;
  if (action === 'reload') { closeModal(); if (state.experiment) loadExperiment(state.experiment); else boot(); showToast('Reloading experiment data'); }
  if (action === 'open-recipe') recipeModal(target.dataset.recipe);
  if (action === 'open-item') itemModal(target.dataset.id);
  if (action === 'open-log') logModal(target.dataset.run);
  if (action === 'show-alerts') showAlerts();
  if (action === 'open-upload') uploadModal();
  if (action === 'open-job') { if (state.job) jobModal(); else uploadModal(); }
  if (action === 'pick-file') modalRoot.querySelector('#uploadFile')?.click();
  if (action === 'open-job-experiment') {
    const job = state.job;
    closeModal();
    state.view = 'inventory'; state.filter = 'All'; state.query = '';
    if (job && job.experiment !== state.experiment) setExperiment(job.experiment); else { render(); poll(); }
  }
  if (action === 'toggle-step') {
    const recipe = state.data.recipes.find(r => r.id === target.dataset.recipe);
    const key = `${state.data.name}::${recipe.name}`;
    const step = Number(target.dataset.step);
    const done = state.doneSteps[key] || [];
    state.doneSteps[key] = done.includes(step) ? done.filter(i => i !== step) : [...done, step];
    saveSteps();
    recipeModal(recipe.id);
  }
  if (action === 'clear-steps') {
    const recipe = state.data.recipes.find(r => r.id === target.dataset.recipe);
    delete state.doneSteps[`${state.data.name}::${recipe.name}`];
    saveSteps();
    recipeModal(recipe.id);
  }
});

document.addEventListener('change', event => {
  if (event.target.id === 'experimentSelect' || event.target.dataset.role === 'experiment') {
    if (event.target.value && event.target.value !== state.experiment) setExperiment(event.target.value);
  }
});

document.addEventListener('input', event => {
  if (event.target.id === 'inventorySearch') {
    state.query = event.target.value;
    render();
    const search = document.querySelector('#inventorySearch');
    if (search) { search.focus(); search.setSelectionRange(state.query.length, state.query.length); }
  }
});

document.addEventListener('keydown', event => { if (event.key === 'Escape') closeModal(); });

document.addEventListener('submit', event => {
  if (event.target.id !== 'uploadForm') return;
  event.preventDefault();
  const name = event.target.elements.experiment.value.trim();
  const file = event.target.elements.video.files[0];
  const problem = !NAME_RE.test(name) ? 'Experiment name: letters, digits, dots, dashes and underscores only.'
    : name === 'latest' ? '“latest” is reserved.'
    : !file ? 'Choose a video first.'
    : !VIDEO_EXTS.some(ext => file.name.toLowerCase().endsWith(ext)) ? `Not a video the pipeline reads (${VIDEO_EXTS.join(', ')}).`
    : null;
  if (problem) { setUploadError(problem); return; }
  startUpload(file, name);
});

document.addEventListener('change', event => {
  if (event.target.id === 'uploadFile') showPickedFile(event.target.files[0]);
});

// Drag a video onto the drop zone.
document.addEventListener('dragover', event => { const zone = event.target.closest?.('.drop'); if (zone) { event.preventDefault(); zone.classList.add('is-over'); } });
document.addEventListener('dragleave', event => { event.target.closest?.('.drop')?.classList.remove('is-over'); });
document.addEventListener('drop', event => {
  const zone = event.target.closest?.('.drop');
  if (!zone) return;
  event.preventDefault();
  zone.classList.remove('is-over');
  const input = zone.querySelector('#uploadFile');
  if (input && event.dataTransfer?.files?.length) { input.files = event.dataTransfer.files; showPickedFile(input.files[0]); }
});

window.addEventListener('hashchange', () => {
  const hash = location.hash.replace('#', '');
  if (VIEWS.includes(hash) && hash !== state.view) { state.view = hash; state.query = ''; state.filter = 'All'; render(); }
});

boot();
