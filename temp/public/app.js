// Savor: a read-only viewer for backend/pipeline.sh output.
// Data comes from ./data/<experiment>/{inventory,expire,recipes,events}.json, copied there by
// `npm run sync` (scripts/sync.mjs). ./data/index.json lists the experiments available.
// Pick one with ?experiment=<name>; the view is in the hash (#inventory, #recipes, #activity).

const STEPS_KEY = 'savor-steps-v2';
const VIEWS = ['home', 'inventory', 'recipes', 'activity'];
const STATUS_ORDER = { expired: 0, expiring_soon: 1, ok: 2, unknown: 3 };
const STATUS_PILL = { expired: 'urgent', expiring_soon: 'soon', ok: 'fresh', unknown: 'unknown' };
const RECIPE_COLORS = ['#c56c40', '#d57672', '#d49a3f', '#5f8a5a', '#8a6fb5'];
// Emoji by keyword; earlier entries win, so the specific ones ("chili") sit above generic containers ("jar").
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
  index: null,          // ./data/index.json
  experiment: null,     // name currently shown
  data: null,           // joined model, see buildModel()
  loading: true,
  error: null,
  view: 'home',
  filter: 'All',
  query: '',
  doneSteps: loadSteps(),
};
let toastTimer;
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
function dataPath(file) { return `./data/${encodeURIComponent(state.experiment)}/${file}`; }

// ---------- data ----------

// Wrangler's SPA fallback answers missing files with index.html, so a 200 is not proof of JSON.
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
    if (!res.ok || (res.headers.get('content-type') || '').includes('text/html')) return null;
    return await res.text();
  } catch { return null; }
}

// Join the four pipeline files into one object the views can read directly.
function buildModel(name, inventory, expire, recipes, events) {
  const now = Date.now();
  const threshold = expire?.threshold_hours ?? 48;
  const expiryById = new Map((expire?.items || []).map(entry => [entry.item_id, entry]));

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
      emoji: emojiFor(raw.object),
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
    return {
      ...recipe,
      id: `r${index}`,
      color: RECIPE_COLORS[index % RECIPE_COLORS.length],
      fridge,
      matched: fridge.filter(f => f.item).length,
      total: fridge.length,
      urgent: (recipe.uses_expiring_items || []).length,
      totalMin: (recipe.prep_time_min || 0) + (recipe.cook_time_min || 0),
      ingredients: (recipe.ingredients || []).map(ing => ({ ...ing, fromFridge: fridgeNames.has(String(ing.item).toLowerCase()), emoji: emojiFor(ing.item) })),
    };
  }).sort((a, b) => (b.urgent - a.urgent) || (b.matched - a.matched) || (a.id < b.id ? -1 : 1));

  const counts = { total: items.length, expired: 0, expiring_soon: 0, ok: 0, unknown: 0 };
  items.forEach(item => { counts[item.status] += 1; });

  return {
    name,
    updatedAt: inventory.updated_at,
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
    events: [...(events?.events || [])].map(event => ({ ...event, emoji: emojiFor(event.object) })).sort((a, b) => Date.parse(b.time) - Date.parse(a.time)),
    missing: [['expire.json', expire], ['recipes.json', recipes], ['events.json', events]].filter(([, value]) => !value).map(([file]) => file),
  };
}

async function loadExperiment(name) {
  state.experiment = name;
  state.loading = true;
  state.error = null;
  state.data = null;
  state.filter = 'All';
  state.query = '';
  render();
  const [inventory, expire, recipes, events] = await Promise.all(['inventory.json', 'expire.json', 'recipes.json', 'events.json'].map(file => fetchJson(dataPath(file))));
  if (state.experiment !== name) return; // user switched again while this was in flight
  if (!inventory) state.error = `No inventory.json for “${name}”. Run <code>npm run sync</code> in frontend/ after the pipeline finishes.`;
  else state.data = buildModel(name, inventory, expire, recipes, events);
  state.loading = false;
  render();
}

async function boot() {
  state.index = await fetchJson('./data/index.json');
  const requested = new URLSearchParams(location.search).get('experiment');
  const hash = location.hash.replace('#', '');
  if (VIEWS.includes(hash)) state.view = hash;
  const names = (state.index?.experiments || []).map(e => e.name);
  const name = requested && names.includes(requested) ? requested : (state.index?.latest || names[0] || requested);
  renderExperimentPicker();
  if (!name) {
    state.loading = false;
    state.error = 'No experiments synced yet. Run <code>backend/pipeline.sh VIDEO EXPERIMENT</code>, then <code>npm run sync</code> in frontend/.';
    render();
    return;
  }
  if (requested && !names.includes(requested) && names.length) showToast(`No experiment “${requested}”, showing ${name}`);
  await loadExperiment(name);
}

function setExperiment(name) {
  const url = new URL(location.href);
  url.searchParams.set('experiment', name);
  history.replaceState(null, '', url);
  loadExperiment(name);
}

// ---------- fragments ----------

function pill(item) { return `<span class="expiry ${STATUS_PILL[item.status]}">${expiryLabel(item)}</span>`; }

function foodRow(item, compact = false) {
  const name = escapeHtml(item.object);
  if (compact) {
    return `<button class="food-row" data-action="open-item" data-id="${item.item_id}"><span class="food-icon">${item.emoji}</span><span class="food-copy"><strong>${name}</strong><small>${item.matched ? `as “${escapeHtml(item.matched)}”` : 'not in shelf-life database'} · seen ${fmtDate(item.entered_at)}</small></span>${pill(item)}</button>`;
  }
  return `<button class="inventory-item" data-action="open-item" data-id="${item.item_id}"><span class="food-icon">${item.emoji}</span><span class="food-copy"><strong>${name}</strong><small>${item.matched ? `${escapeHtml(item.matched)} · ${item.shelfLifeHours} h shelf life` : 'not in shelf-life database'}</small></span><span class="item-qty">#${item.item_id} · ${pct(item.confidence)}<small>${fmtDate(item.entered_at)}</small></span>${pill(item)}<i class="row-chevron">›</i></button>`;
}

function recipeArt(recipe) { return `<div class="mini-recipe-art" style="--recipe-color:${recipe.color}"></div>`; }

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
          <div class="recipe-image" style="--recipe-color:${featured.color}"><span class="match">${featured.matched}/${featured.total} ingredients on hand</span></div>
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
      <div class="inventory-toolbar"><label class="search-wrap"><span>⌕</span><input id="inventorySearch" value="${escapeHtml(state.query)}" placeholder="Search your fridge" aria-label="Search inventory"></label><button class="button outline" data-action="show-alerts">♧ ${plural(filterCounts['Use soon'], 'alert')}</button></div>
      <div class="filter-row">${Object.keys(FILTERS).map(name => `<button class="filter-pill ${state.filter === name ? 'is-active' : ''}" data-filter="${name}">${name} <b>${filterCounts[name]}</b></button>`).join('')}</div>
      <div class="inventory-list">${items.length ? items.map(item => foodRow(item)).join('') : emptyState('⌕', 'Nothing matches that', d.counts.total ? 'Try another search or filter.' : 'The pipeline has not put anything in this fridge yet.')}</div>
    </section>
    ${d.counts.unknown ? `<section class="panel note-card"><span class="tip-icon">?</span><div><h2 class="section-title">${plural(d.counts.unknown, 'item')} without a shelf life</h2><p>${d.items.filter(item => item.status === 'unknown').map(item => escapeHtml(item.object)).join(', ')} did not match anything in <code>backend/db/expire.json</code>. Add an alias there and re-run <code>check_expire.check</code> to track ${d.counts.unknown === 1 ? 'it' : 'them'}.</p></div></section>` : ''}
    ${d.removed.length ? `<section class="panel panel-pad"><div class="section-top"><h2 class="section-title">Taken out</h2><span class="date-chip">${plural(d.removed.length, 'item')}</span></div><div class="food-list">${d.removed.map(item => `<div class="food-row is-static"><span class="food-icon">${emojiFor(item.object)}</span><span class="food-copy"><strong>${escapeHtml(item.object)}</strong><small>${item.entered_at ? `in ${fmtDate(item.entered_at)} · ` : 'never seen going in · '}out ${fmtDate(item.removed_at)}</small></span><span class="badge out">out</span></div>`).join('')}</div></section>` : ''}`;
}

function renderRecipes() {
  const d = state.data;
  const featured = d.recipes[0];
  return `
    <section class="page-heading"><div><p class="eyebrow">Waste less, eat better</p><h1>What should we make?</h1><p>${plural(d.recipes.length, 'idea')} built around what the camera saw${d.model ? ` · ${escapeHtml(d.model)}` : ''}${d.generatedAt ? ` · ${fmtDate(d.generatedAt)}` : ''}.</p></div><span class="date-chip">✦ ${d.useFirst.length || 'No'} item${d.useFirst.length === 1 ? '' : 's'} to use first</span></section>
    <section class="plan-page-grid">
      <div class="panel panel-pad">
        <div class="section-top"><h2 class="section-title">Best matches</h2><span class="date-chip">Sorted by urgency</span></div>
        <div class="recipe-list">${d.recipes.length ? d.recipes.map(recipe => `<article class="recipe-row">${recipeArt(recipe)}<div><h3>${escapeHtml(recipe.name)}</h3><p>${escapeHtml(recipe.description)}</p>${recipeMeta(recipe)}</div><div><div class="match-number">${recipe.matched}/${recipe.total} in fridge${recipe.urgent ? `<br><em>${plural(recipe.urgent, 'expiring item')}</em>` : ''}</div><button class="text-link" data-action="open-recipe" data-recipe="${recipe.id}">View recipe →</button></div></article>`).join('') : emptyState('✦', 'No recipes yet', 'recipes.json was not found for this experiment. Run <code>python -m chef.chef --experiment experiments/' + escapeHtml(d.name) + '</code> from backend/.')}</div>
      </div>
      <div class="stack">
        <article class="panel tip-card"><span class="tip-icon">✦</span><h2>${d.useFirst.length ? 'Cook these before they turn.' : 'Food that gets used feels good.'}</h2><p>${d.useFirst.length ? `${d.useFirst.map(escapeHtml).join(', ')} ${d.useFirst.length === 1 ? 'is' : 'are'} inside the ${d.threshold} hour window, so the chef was told to build around ${d.useFirst.length === 1 ? 'it' : 'them'}.` : `Nothing is inside the ${d.threshold} hour window, so the chef was free to use anything in the fridge.`}</p>${featured ? `<button class="button" data-action="open-recipe" data-recipe="${featured.id}">Plan tonight's meal</button>` : ''}</article>
        <article class="panel panel-pad">
          <div class="section-top"><h2 class="section-title">Chef notes</h2></div>
          <div class="setting-list">
            <div class="setting"><span>◌</span><span><strong>Model</strong><small>${escapeHtml(d.model || 'unknown')}</small></span></div>
            <div class="setting"><span>▦</span><span><strong>Ingredients offered</strong><small>${plural(d.counts.total - d.excludedExpired.length, 'item')} from the fridge${d.counts.unknown ? `, ${d.counts.unknown} with no shelf life` : ''}</small></span></div>
            <div class="setting"><span>✕</span><span><strong>Left out as expired</strong><small>${d.excludedExpired.length ? d.excludedExpired.map(escapeHtml).join(', ') : 'nothing'}</small></span></div>
            <div class="setting"><span>＋</span><span><strong>Pantry staples assumed</strong><small>${[...new Set(d.recipes.flatMap(recipe => recipe.pantry_items || []))].map(escapeHtml).join(', ') || 'none'}</small></span></div>
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
          <div class="timeline">${d.events.length ? d.events.map(event => `<button class="event-row" data-action="open-item" data-id="${event.item_id}"><span class="badge ${event.action === 'in' ? 'in' : 'out'}">${escapeHtml(event.action)}</span><span class="food-icon">${event.emoji}</span><span class="food-copy"><strong>${escapeHtml(event.object)}</strong><small>${fmtDate(event.time)} · ${escapeHtml(event.video)} @ ${event.time_s != null ? `${event.time_s.toFixed(1)} s` : '—'}</small></span><span class="item-qty">#${event.item_id}<small>${pct(event.confidence)}</small></span></button>`).join('') : emptyState('⌁', 'Quiet so far', 'No in/out events recorded.')}</div>
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
            <div class="setting"><span>↻</span><span><strong>Synced to site</strong><small>${fmtDate(state.index?.synced_at)}</small></span></div>
          </div>
        </article>
        <article class="panel panel-pad">
          <div class="section-top"><h2 class="section-title">Raw files</h2></div>
          <div class="file-links">${['inventory.json', 'expire.json', 'recipes.json', 'events.json'].map(file => `<a class="file-link ${d.missing.includes(file) ? 'is-missing' : ''}" href="${dataPath(file)}" target="_blank" rel="noopener">${file}<span>${d.missing.includes(file) ? 'missing' : 'open ↗'}</span></a>`).join('')}</div>
        </article>
        <article class="panel tip-card"><span class="tip-icon">⌁</span><h2>Add another video.</h2><p>Every run folds into this experiment: new items join, items seen leaving are taken off, expiry and recipes are recomputed.</p><code class="cmd">backend/pipeline.sh clip.mp4 ${escapeHtml(d.name)}<br>cd frontend && npm run sync</code></article>
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
    : '<option value="">No experiments synced</option>';
  select.disabled = !experiments.length;
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
  card.querySelector('small').textContent = d ? `${plural(d.counts.total, 'item')} · ${plural(d.runs.length, 'scan')}` : (state.loading ? 'Loading…' : 'Run npm run sync');
}

// ---------- modals ----------

function showToast(message) { const toast = document.querySelector('#toast'); toast.textContent = message; toast.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 2700); }
function closeModal() { modalRoot.innerHTML = ''; }
function modalShell(inner, extraClass = '') { return `<div class="modal-backdrop ${extraClass}" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true">${inner}</section></div>`; }

function recipeModal(recipeId) {
  const d = state.data;
  const recipe = d.recipes.find(r => r.id === recipeId) || d.recipes[0];
  if (!recipe) return;
  const key = `${d.name}::${recipe.name}`;
  const checks = state.doneSteps[key] || [];
  const urgentNames = new Set((recipe.uses_expiring_items || []).map(n => n.toLowerCase()));
  const ingredientLine = ing => `<div class="ingredient-line ${ing.fromFridge ? 'from-fridge' : 'from-pantry'} ${urgentNames.has(String(ing.item).toLowerCase()) ? 'is-urgent' : ''}"><span class="ingredient-mark">${ing.fromFridge ? '✓' : '＋'}</span><span class="ingredient-copy"><strong>${ing.emoji} ${escapeHtml(ing.item)}</strong><small>${escapeHtml(ing.amount)}${ing.fromFridge ? '' : ' · pantry'}</small></span></div>`;
  modalRoot.innerHTML = modalShell(`
    <div class="recipe-hero" style="background:linear-gradient(110deg,${recipe.color},#d89049 54%,#416a45)"><button class="modal-close" data-action="close-modal" aria-label="Close">×</button><p class="eyebrow">${recipe.matched}/${recipe.total} from your fridge${recipe.urgent ? ` · ${plural(recipe.urgent, 'expiring item')}` : ''}</p><h2 id="recipeTitle">${escapeHtml(recipe.name)}</h2><p>◷ ${recipe.prep_time_min} min prep + ${recipe.cook_time_min} min cook &nbsp;&nbsp; ◌ ${plural(recipe.servings, 'serving')}</p></div>
    <div class="recipe-details">
      <div><h3>Ingredients</h3>${recipe.ingredients.length ? recipe.ingredients.map(ingredientLine).join('') : '<p>No ingredient list.</p>'}</div>
      <div><h3>Why it works</h3><p class="recipe-why">${escapeHtml(recipe.description)}</p>${recipe.fridge.some(f => !f.item) ? `<p class="recipe-why is-muted">Not in the fridge any more: ${recipe.fridge.filter(f => !f.item).map(f => escapeHtml(f.name)).join(', ')}.</p>` : ''}</div>
    </div>
    <div class="steps"><h3>Steps</h3>${recipe.steps.map((step, index) => `<button class="step-check ${checks.includes(index) ? 'is-done' : ''}" data-action="toggle-step" data-recipe="${recipe.id}" data-step="${index}"><span>${checks.includes(index) ? '✓' : index + 1}</span>${escapeHtml(step)}</button>`).join('')}<div class="modal-actions">${checks.length ? `<button class="button outline" data-action="clear-steps" data-recipe="${recipe.id}">Clear progress</button>` : ''}<button class="button" data-action="complete-recipe">Save for tonight</button></div></div>`, 'recipe-modal');
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
    <header class="modal-head"><div><p class="eyebrow">Item #${subject.item_id}${gone ? ' · taken out' : ''}</p><h2>${emojiFor(subject.object)} ${escapeHtml(subject.object)}</h2></div><button class="modal-close" data-action="close-modal" aria-label="Close">×</button></header>
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
  const text = await fetchText(dataPath(`runs/${encodeURIComponent(run)}/run.log`));
  const pre = modalRoot.querySelector('.log-pre');
  if (!pre) return; // closed while loading
  pre.textContent = text ?? 'run.log not found for this run. Re-run npm run sync.';
}

function showAlerts() {
  const d = state.data;
  const urgent = d ? d.items.filter(item => item.status === 'expired' || item.status === 'expiring_soon') : [];
  modalRoot.innerHTML = modalShell(`<header class="modal-head"><h2>Kitchen updates</h2><button class="modal-close" data-action="close-modal" aria-label="Close">×</button></header><div class="modal-body"><p>${urgent.length ? `${plural(urgent.length, 'ingredient')} inside the ${d.threshold} hour window.` : 'Everything in your kitchen is looking fresh.'}</p>${urgent.map(item => foodRow(item, true)).join('')}</div>`);
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
  if (!state.data && action !== 'reload') return;
  if (action === 'reload') { closeModal(); if (state.experiment) loadExperiment(state.experiment); else boot(); showToast('Reloading experiment data'); }
  if (action === 'open-recipe') recipeModal(target.dataset.recipe);
  if (action === 'open-item') itemModal(target.dataset.id);
  if (action === 'open-log') logModal(target.dataset.run);
  if (action === 'show-alerts') showAlerts();
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
  if (action === 'complete-recipe') { closeModal(); showToast('Saved for tonight ✓'); }
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

window.addEventListener('hashchange', () => {
  const hash = location.hash.replace('#', '');
  if (VIEWS.includes(hash) && hash !== state.view) { state.view = hash; state.query = ''; state.filter = 'All'; render(); }
});

boot();
