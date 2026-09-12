const STORAGE_KEY = 'savor-kitchen-v1';

const defaultItems = [
  { id: 'chicken', name: 'Chicken breast', emoji: '🍗', category: 'Protein', expires: 1, qty: '2 portions' },
  { id: 'spinach', name: 'Baby spinach', emoji: '🥬', category: 'Produce', expires: 1, qty: '1 bag' },
  { id: 'yogurt', name: 'Greek yogurt', emoji: '🥣', category: 'Dairy', expires: 2, qty: '3 cups' },
  { id: 'strawberries', name: 'Strawberries', emoji: '🍓', category: 'Produce', expires: 2, qty: '1 punnet' },
  { id: 'milk', name: 'Whole milk', emoji: '🥛', category: 'Dairy', expires: 5, qty: '1 carton' },
  { id: 'peppers', name: 'Sweet peppers', emoji: '🫑', category: 'Produce', expires: 5, qty: '3 peppers' },
  { id: 'eggs', name: 'Free-range eggs', emoji: '🥚', category: 'Protein', expires: 9, qty: '6 eggs' },
  { id: 'rice', name: 'Jasmine rice', emoji: '🍚', category: 'Pantry', expires: 30, qty: '1 jar' },
];

const recipes = [
  { id: 'chicken-bowl', title: 'Chicken & greens bowl', time: '25 min', calories: '540 cal', use: ['chicken', 'spinach', 'yogurt'], description: 'A bright, hearty bowl that gives your closest-to-expiry ingredients a delicious purpose.', color: '#c56c40', steps: ['Season chicken with paprika, salt, and olive oil.', 'Sear in a hot pan for 5–6 minutes per side.', 'Wilt the spinach with a splash of water.', 'Serve with yogurt, herbs, and any cooked grains.'] },
  { id: 'berry-parfait', title: 'Strawberry yogurt parfait', time: '8 min', calories: '310 cal', use: ['strawberries', 'yogurt'], description: 'A quick, creamy breakfast that tastes like a little weekend ritual.', color: '#d57672', steps: ['Slice strawberries and add a pinch of salt.', 'Layer yogurt, berries, and granola in a glass.', 'Finish with honey or a squeeze of lemon.', 'Enjoy right away.'] },
  { id: 'pepper-eggs', title: 'Jammy eggs & peppers', time: '18 min', calories: '420 cal', use: ['peppers', 'eggs', 'spinach'], description: 'A colourful one-pan dinner that makes a few everyday staples feel new.', color: '#d49a3f', steps: ['Sauté sliced peppers until soft and sweet.', 'Add spinach and cook until just wilted.', 'Make two wells and crack in the eggs.', 'Cover and cook until the whites are set.'] },
];

function loadState() {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY));
    return saved && Array.isArray(saved.items) ? saved : { items: [...defaultItems], view: 'home', filter: 'All', query: '', doneSteps: {} };
  } catch { return { items: [...defaultItems], view: 'home', filter: 'All', query: '', doneSteps: {} }; }
}

let state = loadState();
let toastTimer;
const app = document.querySelector('#app');
const modalRoot = document.querySelector('#modalRoot');

function saveState() { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
function escapeHtml(value = '') { return String(value).replace(/[&<>'"]/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#039;', '"': '&quot;' }[char])); }
function expiry(item) {
  if (item.expires <= 0) return { label: 'Use today', type: 'urgent' };
  if (item.expires === 1) return { label: '1 day left', type: 'urgent' };
  if (item.expires <= 3) return { label: `${item.expires} days left`, type: 'soon' };
  return { label: `${item.expires} days left`, type: 'fresh' };
}
function todayDate() {
  return new Intl.DateTimeFormat('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).format(new Date());
}
function foodRow(item, compact = false) {
  const e = expiry(item);
  if (compact) return `<div class="food-row"><span class="food-icon">${item.emoji}</span><span class="food-copy"><strong>${escapeHtml(item.name)}</strong><small>${escapeHtml(item.qty)}</small></span><span class="expiry ${e.type}">${e.label}</span></div>`;
  return `<article class="inventory-item"><span class="food-icon">${item.emoji}</span><span class="food-copy"><strong>${escapeHtml(item.name)}</strong><small>${item.category}</small></span><span class="item-qty">${escapeHtml(item.qty)}</span><span class="expiry ${e.type}">${e.label}</span><button class="icon-button" title="Remove ${escapeHtml(item.name)}" data-action="remove" data-id="${item.id}">×</button></article>`;
}
function getExpiring() { return [...state.items].sort((a, b) => a.expires - b.expires).filter(item => item.expires <= 3); }
function getRecipeScore(recipe) { return recipe.use.filter(id => state.items.some(item => item.id === id)).length; }
function recipeArt(recipe) { return `<div class="mini-recipe-art" style="--recipe-color:${recipe.color}"></div>`; }
function renderHome() {
  const expiring = getExpiring();
  const first = expiring[0] || state.items[0];
  const featured = recipes.map(recipe => ({ recipe, score: getRecipeScore(recipe) })).sort((a, b) => b.score - a.score)[0];
  return `
    <section class="page-heading">
      <div><p class="eyebrow">Good morning, Amir</p><h1>Make the good stuff<br>last longer.</h1><p>Your kitchen is calm and in sync.</p></div>
      <span class="date-chip">◷ ${todayDate()}</span>
    </section>
    <section class="content-grid">
      <div class="stack">
        <article class="panel alert-card">
          <p class="eyebrow">Eat this first</p>
          <h2>${expiring.length ? `${expiring.length} ingredients are at their best right now.` : 'Your fridge is looking wonderfully fresh.'}</h2>
          <p>${expiring.length ? `${escapeHtml(first.name)}${expiring.length > 1 ? ` and ${expiring.length - 1} more` : ''} ${expiry(first).label.toLowerCase()}. We found a meal that uses them.` : 'Everything has plenty of time. Add something new when you get back from the market.'}</p>
          <button class="button light" data-action="open-recipe" data-recipe="${featured.recipe.id}">See what to make <span>→</span></button>
        </article>
        <article class="panel panel-pad">
          <div class="section-top"><h2 class="section-title">Use these first</h2><button class="text-link" data-view="inventory">See all</button></div>
          <div class="food-list">${expiring.length ? expiring.slice(0,3).map(item => foodRow(item, true)).join('') : '<div class="empty-state"><span>✦</span><h3>All fresh here</h3><p>No ingredients need attention just yet.</p></div>'}</div>
          ${expiring.length > 3 ? `<button class="more-link" data-view="inventory">View ${expiring.length - 3} more ingredient${expiring.length - 3 === 1 ? '' : 's'} →</button>` : ''}
        </article>
      </div>
      <div class="stack">
        <article class="panel panel-pad">
          <div class="section-top"><h2 class="section-title">Quick actions</h2></div>
          <div class="quick-grid">
            <button class="quick-action" data-action="scan"><span>⌁</span><b>Scan fridge</b></button>
            <button class="quick-action" data-action="open-add"><span>＋</span><b>Add item</b></button>
            <button class="quick-action" data-view="plan"><span>✦</span><b>Plan a meal</b></button>
          </div>
        </article>
        <article class="panel plan-card">
          <div class="recipe-image"><span class="match">${featured.score}/${featured.recipe.use.length} ingredients on hand</span></div>
          <div class="plan-copy"><p class="eyebrow">Tonight's idea</p><h3>${featured.recipe.title}</h3><p>${featured.recipe.description}</p><div class="section-top" style="margin:0"><span class="recipe-meta"><span>◷ ${featured.recipe.time}</span><span>◌ ${featured.recipe.calories}</span></span><button class="text-link" data-action="open-recipe" data-recipe="${featured.recipe.id}">Make it →</button></div></div>
        </article>
      </div>
    </section>`;
}
function renderInventory() {
  const categories = ['All', ...new Set(state.items.map(item => item.category))];
  const query = state.query.toLowerCase().trim();
  const items = [...state.items].filter(item => (state.filter === 'All' || item.category === state.filter) && (!query || item.name.toLowerCase().includes(query))).sort((a, b) => a.expires - b.expires);
  return `<section class="page-heading"><div><p class="eyebrow">Keep tabs, effortlessly</p><h1>Fridge inventory</h1><p>${state.items.length} items in your kitchen, sorted by what needs you first.</p></div><button class="button" data-action="open-add">＋ Add item</button></section>
    <section class="panel panel-pad"><div class="inventory-toolbar"><label class="search-wrap"><span>⌕</span><input id="inventorySearch" value="${escapeHtml(state.query)}" placeholder="Search your fridge" aria-label="Search inventory"></label><button class="button outline" data-action="scan">⌁ Fresh scan</button></div><div class="filter-row">${categories.map(category => `<button class="filter-pill ${state.filter === category ? 'is-active' : ''}" data-filter="${category}">${category}</button>`).join('')}</div><div class="inventory-list">${items.length ? items.map(item => foodRow(item)).join('') : '<div class="empty-state"><span>⌕</span><h3>Nothing matches that</h3><p>Try another search or add an item to your inventory.</p><button class="button" data-action="open-add">Add item</button></div>'}</div></section>`;
}
function renderPlan() {
  const ordered = recipes.map(recipe => ({ ...recipe, score: getRecipeScore(recipe) })).sort((a, b) => b.score - a.score);
  return `<section class="page-heading"><div><p class="eyebrow">Waste less, eat better</p><h1>What should we make?</h1><p>Ideas built around what you already have on hand.</p></div><span class="date-chip">✦ ${getExpiring().length || 'No'} items to use soon</span></section><section class="plan-page-grid"><div class="panel panel-pad"><div class="section-top"><h2 class="section-title">Best matches</h2><span class="date-chip">This week</span></div><div class="recipe-list">${ordered.map(recipe => `<article class="recipe-row">${recipeArt(recipe)}<div><h3>${recipe.title}</h3><p>${recipe.description}</p></div><div><div class="match-number">${recipe.score}/${recipe.use.length} matched</div><button class="text-link" data-action="open-recipe" data-recipe="${recipe.id}">View recipe →</button></div></article>`).join('')}</div></div><div class="stack"><article class="panel tip-card"><span class="tip-icon">✦</span><h2>Food that gets used feels good.</h2><p>Make one flexible plan now and Savor will keep the rest of the week easy.</p><button class="button" data-action="open-recipe" data-recipe="${ordered[0].id}">Plan tonight's meal</button></article><article class="panel week-card"><div class="section-top"><h2 class="section-title">This week</h2><button class="text-link" data-action="toast" data-message="Weekly view is on its way.">View calendar</button></div><div class="week-days">${['M','T','W','T','F','S','S'].map((day, index) => `<span class="day ${index === 2 ? 'today' : ''}"><span>${day}</span><span>${12 + index}</span></span>`).join('')}</div></article></div></section>`;
}
function renderProfile() {
  return `<section class="page-heading"><div><p class="eyebrow">Your space</p><h1>Kitchen settings</h1><p>Keep your food routine feeling like yours.</p></div></section><section class="content-grid"><div class="stack"><article class="panel profile-card"><span class="profile-avatar">AM</span><div><h2>Amir</h2><p>Amir's kitchen · Toronto</p></div></article><article class="panel panel-pad"><div class="section-top"><h2 class="section-title">Preferences</h2></div><div class="setting-list"><div class="setting"><span>♧</span><span><strong>Expiry reminders</strong><small>Gentle alerts for ingredients to use soon</small></span><i>›</i></div><div class="setting"><span>◌</span><span><strong>Dietary preferences</strong><small>Everything is currently included</small></span><i>›</i></div><div class="setting"><span>⌂</span><span><strong>Kitchen members</strong><small>Just you for now</small></span><i>›</i></div></div></article></div><div class="stack"><article class="panel panel-pad"><div class="section-top"><h2 class="section-title">Demo controls</h2></div><p style="color:var(--muted);font-size:13px;line-height:1.5">This prototype saves changes on this device, so a visitor can genuinely try the flow.</p><button class="button danger" data-action="reset">Reset demo inventory</button></article></div></section>`;
}
function render() {
  const viewRenderers = { home: renderHome, inventory: renderInventory, plan: renderPlan, profile: renderProfile };
  app.innerHTML = viewRenderers[state.view]();
  document.querySelectorAll('[data-view]').forEach(button => button.classList.toggle('is-active', button.dataset.view === state.view));
  document.querySelector('#inventoryCount').textContent = state.items.length;
  document.querySelector('#notificationDot').style.display = getExpiring().length ? 'block' : 'none';
  saveState();
}

function showToast(message) { const toast = document.querySelector('#toast'); toast.textContent = message; toast.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(() => toast.classList.remove('show'), 2700); }
function closeModal() { modalRoot.innerHTML = ''; }
function addModal() { modalRoot.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="addTitle"><header class="modal-head"><h2 id="addTitle">Add to your fridge</h2><button class="modal-close" data-action="close-modal" aria-label="Close">×</button></header><form id="addForm" class="modal-body"><p>A little detail now makes meal suggestions much more useful later.</p><div class="form-grid"><label>Ingredient<input name="name" maxlength="32" placeholder="e.g. Avocado" required autofocus></label><div class="form-row"><label>Category<select name="category"><option>Produce</option><option>Dairy</option><option>Protein</option><option>Pantry</option><option>Other</option></select></label><label>Use within<select name="expires"><option value="1">1 day</option><option value="2">2 days</option><option value="3">3 days</option><option value="5" selected>5 days</option><option value="7">1 week</option></select></label></div><label>Amount<input name="qty" maxlength="24" placeholder="e.g. 2 avocados" required></label></div><div class="modal-actions"><button type="button" class="button outline" data-action="close-modal">Cancel</button><button class="button" type="submit">Add item</button></div></form></section></div>`; document.querySelector('#addForm').addEventListener('submit', handleAddForm); }
function handleAddForm(event) { event.preventDefault(); const form = new FormData(event.currentTarget); const name = form.get('name').trim(); if (!name) return; const emojiMap = { produce: '🥬', dairy: '🥛', protein: '🍗', pantry: '🫙', other: '🍽️' }; const category = form.get('category'); state.items.push({ id: `${Date.now()}-${name.toLowerCase().replace(/[^a-z0-9]/g, '')}`, name, emoji: emojiMap[category.toLowerCase()] || '🍽️', category, expires: Number(form.get('expires')), qty: form.get('qty').trim() }); closeModal(); render(); showToast(`${name} added to your fridge`); }
function scanModal(stage = 'scanning') { const detected = [{ id: 'milk', name: 'Whole milk', emoji: '🥛', category: 'Dairy', expires: 5, qty: '1 carton' }, { id: 'chicken', name: 'Chicken breast', emoji: '🍗', category: 'Protein', expires: 1, qty: '2 portions' }, { id: 'strawberries', name: 'Strawberries', emoji: '🍓', category: 'Produce', expires: 2, qty: '1 punnet' }]; if (stage === 'scanning') { modalRoot.innerHTML = `<div class="modal-backdrop"><section class="modal" role="dialog" aria-modal="true"><div class="scanner"><div><div class="scanner-orbit">⌁</div><h2>Looking inside your fridge…</h2><p>Finding fresh ingredients and checking what changed.</p></div></div></section></div>`; setTimeout(() => scanModal('detected'), 1500); return; } modalRoot.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true"><header class="modal-head"><h2>Fresh scan complete</h2><button class="modal-close" data-action="close-modal" aria-label="Close">×</button></header><div class="modal-body"><p>We spotted a few things worth keeping in sync.</p></div><div class="detected-list">${detected.map(item => `<div class="detected-row"><span class="food-icon">${item.emoji}</span>${item.name}<span>✓ found</span></div>`).join('')}<button class="button" data-action="confirm-scan">Update inventory</button></div></section></div>`; }
function confirmScan() { const additions = [{ id: 'milk', name: 'Whole milk', emoji: '🥛', category: 'Dairy', expires: 5, qty: '1 carton' }, { id: 'chicken', name: 'Chicken breast', emoji: '🍗', category: 'Protein', expires: 1, qty: '2 portions' }, { id: 'strawberries', name: 'Strawberries', emoji: '🍓', category: 'Produce', expires: 2, qty: '1 punnet' }]; additions.forEach(item => { const existing = state.items.findIndex(old => old.id === item.id); if (existing >= 0) state.items[existing] = item; else state.items.push(item); }); closeModal(); render(); showToast('Inventory updated automatically'); }
function recipeModal(recipeId) { const recipe = recipes.find(item => item.id === recipeId) || recipes[0]; const matching = recipe.use.map(id => state.items.find(item => item.id === id)).filter(Boolean); const checks = state.doneSteps[recipe.id] || []; modalRoot.innerHTML = `<div class="modal-backdrop recipe-modal" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true" aria-labelledby="recipeTitle"><div class="recipe-hero" style="background:linear-gradient(110deg,${recipe.color},#d89049 54%,#416a45)"><button class="modal-close" data-action="close-modal" aria-label="Close">×</button><p class="eyebrow">Tonight's idea · ${getRecipeScore(recipe)}/${recipe.use.length} matched</p><h2 id="recipeTitle">${recipe.title}</h2><p>◷ ${recipe.time} &nbsp;&nbsp; ◌ ${recipe.calories}</p></div><div class="recipe-details"><div><h3>You'll use</h3>${matching.map(item => `<div class="ingredient-check">${item.emoji} ${escapeHtml(item.name)}</div>`).join('') || '<p>Pick up a few ingredients to get started.</p>'}</div><div><h3>Why it works</h3><p style="margin:0;color:var(--muted);font-size:12px;line-height:1.55">${recipe.description}</p></div></div><div class="steps"><h3>Simple steps</h3>${recipe.steps.map((step, index) => `<button class="step-check ${checks.includes(index) ? 'is-done' : ''}" data-action="toggle-step" data-recipe="${recipe.id}" data-step="${index}"><span>${checks.includes(index) ? '✓' : index + 1}</span>${step}</button>`).join('')}<div class="modal-actions"><button class="button" data-action="complete-recipe" data-recipe="${recipe.id}">Save for lunch</button></div></div></section></div>`; }
function showAlerts() { const expiring = getExpiring(); modalRoot.innerHTML = `<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true"><header class="modal-head"><h2>Kitchen updates</h2><button class="modal-close" data-action="close-modal">×</button></header><div class="modal-body"><p>${expiring.length ? 'A few ingredients are ready to be enjoyed.' : 'Everything in your kitchen is looking fresh.'}</p>${expiring.map(item => foodRow(item, true)).join('') || ''}</div></section></div>`; }

document.addEventListener('click', event => {
  const target = event.target.closest('[data-action], [data-view], [data-filter]');
  if (!target) return;
  if (target.dataset.view) { state.view = target.dataset.view; state.query = ''; render(); window.scrollTo({ top: 0, behavior: 'smooth' }); return; }
  if (target.dataset.filter) { state.filter = target.dataset.filter; render(); return; }
  const action = target.dataset.action;
  if (action === 'close-modal') { if (target === event.target || event.target.closest('.modal-close')) closeModal(); }
  if (action === 'open-add') addModal();
  if (action === 'scan') scanModal();
  if (action === 'confirm-scan') confirmScan();
  if (action === 'open-recipe') recipeModal(target.dataset.recipe);
  if (action === 'show-alerts') showAlerts();
  if (action === 'remove') { const item = state.items.find(item => item.id === target.dataset.id); state.items = state.items.filter(item => item.id !== target.dataset.id); render(); showToast(`${item?.name || 'Item'} removed`); }
  if (action === 'toggle-step') { const recipeId = target.dataset.recipe; const step = Number(target.dataset.step); const done = state.doneSteps[recipeId] || []; state.doneSteps[recipeId] = done.includes(step) ? done.filter(i => i !== step) : [...done, step]; recipeModal(recipeId); saveState(); }
  if (action === 'complete-recipe') { closeModal(); showToast('Saved for lunch ✓'); }
  if (action === 'reset') { state = { items: [...defaultItems], view: 'profile', filter: 'All', query: '', doneSteps: {} }; render(); showToast('Demo inventory reset'); }
  if (action === 'toast') showToast(target.dataset.message || 'Coming soon');
});
document.addEventListener('input', event => { if (event.target.id === 'inventorySearch') { state.query = event.target.value; render(); const search = document.querySelector('#inventorySearch'); if (search) { search.focus(); search.setSelectionRange(state.query.length, state.query.length); } } });

render();
