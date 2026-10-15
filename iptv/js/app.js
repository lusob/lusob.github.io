import { Xtream, parseServerInput, isMixedContent } from './xtream.js';
import * as store from './store.js';
import { $, esc, norm, ago, isNew, initials, toast, loading, VList } from './ui.js';
import { Player } from './player.js';

const TYPES = { live: 'Directo', vod: 'Películas', series: 'Series' };
const FAV = '__fav', ALL = '__all';
const MAX_AGE = 12 * 3600e3;   // refetch lists older than 12 h

let api = null;
let account = '';
let favs = null;               // { [type]: { items: Set, cats: Set } }
let data = {};                 // { [type]: { items, folders, folderById } }
let query = '';
let list = [];                 // items currently shown in the right pane
let series = null;             // open series: { item, seasons, season }
const seriesCache = new Map();
const ui = Object.assign({ tab: 'live', folder: {} }, store.get('ui', {}));

const player = new Player($('#player'));
const folderList = new VList($('#folders'), 64, renderFolderRow, onFolderClick);
const itemList = new VList($('#items'), 76, renderItemRow, onItemClick);

const saveUi = () => store.set('ui', ui);

// ---------------------------------------------------------------- session

function showView(id) {
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== id;
}

function showLogin(creds = store.get('lastLogin', {})) {
  const f = $('#loginForm');
  f.server.value = creds.server || '';
  f.username.value = creds.username || '';
  f.password.value = '';
  f.proxy.value = creds.proxy || '';
  if (creds.proxy) $('#advanced').open = true;
  updateLoginWarn();
  showView('login');
}

function updateLoginWarn() {
  const f = $('#loginForm');
  const { server } = parseServerInput(f.server.value);
  const warn = server && isMixedContent(server, f.proxy.value.trim());
  $('#loginWarn').hidden = !warn;
  if (warn) $('#loginWarn').textContent = 'Servidor http:// desde una página https://: el navegador lo bloqueará. Configura un proxy en Avanzado.';
}

$('#loginForm').server.addEventListener('change', e => {
  const p = parseServerInput(e.target.value);
  const f = $('#loginForm');
  if (p.username) { f.username.value = p.username; f.password.value = p.password; }
  if (p.server) f.server.value = p.server;
  updateLoginWarn();
});
$('#loginForm').server.addEventListener('input', updateLoginWarn);
$('#loginForm').proxy.addEventListener('input', updateLoginWarn);

$('#loginForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  const p = parseServerInput(f.server.value);
  const creds = {
    server: p.server,
    username: f.username.value.trim() || p.username || '',
    password: f.password.value || p.password || '',
    proxy: f.proxy.value.trim(),
  };
  const err = $('#loginError');
  err.hidden = true;
  loading('Conectando…');
  try {
    const x = new Xtream(creds);
    await x.login();
    store.set('creds', creds);
    store.set('lastLogin', { server: creds.server, username: creds.username, proxy: creds.proxy });
    startSession(creds, x.info);
  } catch (ex) {
    err.textContent = ex.message;
    err.hidden = false;
  } finally {
    loading('');
  }
});

function startSession(creds, info = null) {
  api = new Xtream(creds);
  api.info = info;
  account = creds.server + '|' + creds.username;
  data = {};
  loadFavs();
  showView('main');
  if (!info) api.login().catch(() => {});
  selectTab(ui.tab in TYPES ? ui.tab : 'live');
}

function logout() {
  store.del('creds');
  api = null;
  data = {};
  showLogin();
}

// ---------------------------------------------------------------- favorites

function loadFavs() {
  const raw = store.get('fav:' + account, {});
  favs = {};
  for (const t in TYPES) favs[t] = { items: new Set(raw[t]?.items), cats: new Set(raw[t]?.cats) };
}

function saveFavs() {
  const raw = {};
  for (const t in TYPES) raw[t] = { items: [...favs[t].items], cats: [...favs[t].cats] };
  store.set('fav:' + account, raw);
}

function toggle(set, id) {
  set.has(id) ? set.delete(id) : set.add(id);
  saveFavs();
}

// ---------------------------------------------------------------- data

async function ensureData(type, force = false) {
  if (data[type] && !force) return data[type];
  const key = account + '|' + type;
  const cached = await store.cacheGet(key);
  if (cached && !force && Date.now() - cached.ts < MAX_AGE) return (data[type] = build(cached));
  loading(`Cargando ${TYPES[type].toLowerCase()}…`);
  try {
    const fresh = await api.fetchType(type);
    fresh.ts = Date.now();
    store.cachePut(key, fresh);
    data[type] = build(fresh);
  } catch (ex) {
    if (cached) {
      data[type] = build(cached);
      toast('No se pudo actualizar: mostrando la lista guardada');
    } else {
      toast(ex.message, 8000);
      data[type] = build({ cats: [], items: [] });
    }
  } finally {
    loading('');
  }
  return data[type];
}

// Folders and items newest first; a folder is as recent as its newest item.
function build({ cats, items }) {
  items = items.slice().sort((a, b) => b.added - a.added);
  const folderById = new Map(cats.map(c => [c.id, { id: c.id, name: c.name, items: [], date: 0 }]));
  let other = null;
  for (const it of items) {
    it.key = norm(it.name);
    let placed = false;
    for (const c of it.cats) {
      const f = folderById.get(c);
      if (f) { f.items.push(it); placed = true; if (it.added > f.date) f.date = it.added; }
    }
    if (!placed) {
      other ||= { id: '__other', name: 'Sin categoría', items: [], date: 0 };
      other.items.push(it);
      if (it.added > other.date) other.date = it.added;
    }
  }
  if (other) folderById.set(other.id, other);
  const folders = [...folderById.values()].filter(f => f.items.length).sort((a, b) => b.date - a.date);
  return { items, folders, folderById };
}

// ---------------------------------------------------------------- tabs & folders

async function selectTab(type) {
  ui.tab = type;
  saveUi();
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.tab === type);
  closeSeries();
  if (!data[type]) { folderList.set([]); itemList.set([]); $('#listTitle').textContent = ''; $('#listCount').textContent = ''; $('#empty').hidden = true; }
  await ensureData(type);
  if (ui.tab !== type) return;
  renderFolders(false);
  const d = data[type];
  let f = ui.folder[type] || ALL;
  if (f !== FAV && f !== ALL && !d.folderById.has(f)) f = ALL;
  ui.folder[type] = f;
  refreshItems(true);
}

function renderFolders(keepScroll = true) {
  const d = data[ui.tab];
  const fc = favs[ui.tab].cats;
  const fi = favs[ui.tab].items;
  const favItems = d.items.filter(i => fi.has(i.id));
  const rows = [
    { id: FAV, name: '★ Favoritos', count: favItems.length, date: favItems[0]?.added, virtual: true },
    { id: ALL, name: 'Todo', count: d.items.length, date: d.items[0]?.added, virtual: true },
    ...d.folders.filter(f => fc.has(f.id)),
    ...d.folders.filter(f => !fc.has(f.id)),
  ];
  folderList.set(rows, !keepScroll);
}

function renderFolderRow(f) {
  const active = (ui.folder[ui.tab] || ALL) === f.id && !query;
  const count = f.virtual ? f.count : f.items.length;
  const meta = [count + (count === 1 ? ' elemento' : ' elementos'), ago(f.date)].filter(Boolean).join(' · ');
  return `<div class="row${active ? ' active' : ''}">
    <div class="grow"><div class="name">${esc(f.name)}</div><div class="meta">${meta}</div></div>
    ${isNew(f.date) && f.id !== FAV ? '<span class="badge">Nuevo</span>' : ''}
    ${f.virtual ? '' : `<button class="star${favs[ui.tab].cats.has(f.id) ? ' on' : ''}" data-act="fav" aria-label="Favorito">★</button>`}
  </div>`;
}

function onFolderClick(f, i, act) {
  if (act === 'fav') {
    toggle(favs[ui.tab].cats, f.id);
    renderFolders();
    return;
  }
  if (query) { query = ''; $('#search').value = ''; }
  ui.folder[ui.tab] = f.id;
  saveUi();
  closeSeries();
  folderList.refresh();
  refreshItems(true);
  document.body.classList.add('show-items');
}

// ---------------------------------------------------------------- items

function refreshItems(resetScroll) {
  const d = data[ui.tab];
  const id = ui.folder[ui.tab] || ALL;
  let title;
  if (query) {
    const q = norm(query);
    list = d.items.filter(i => i.key.includes(q));
    title = `“${query}”`;
  } else if (id === FAV) {
    list = d.items.filter(i => favs[ui.tab].items.has(i.id));
    title = 'Favoritos';
  } else if (id === ALL) {
    list = d.items;
    title = 'Todo';
  } else {
    const f = d.folderById.get(id);
    list = f ? f.items : [];
    title = f?.name || '';
  }
  $('#listTitle').textContent = title;
  $('#listCount').textContent = list.length ? list.length : '';
  $('#itemsPane').classList.toggle('poster', ui.tab !== 'live');
  itemList.set(list, resetScroll);
  const empty = $('#empty');
  empty.hidden = list.length > 0 || !!series;
  empty.textContent = query ? 'Sin resultados'
    : id === FAV ? 'Aún no hay favoritos. Pulsa ★ en cualquier elemento.'
    : 'No hay elementos';
}

function folderName(it) {
  for (const c of it.cats) {
    const f = data[ui.tab].folderById.get(c);
    if (f) return f.name;
  }
  return '';
}

function renderItemRow(it) {
  const showFolder = query || (ui.folder[ui.tab] || ALL) === FAV || ui.folder[ui.tab] === ALL;
  const meta = [showFolder && folderName(it), ago(it.added), it.rating && `★ ${it.rating}`].filter(Boolean).map(esc).join(' · ');
  return `<div class="row">
    <div class="logo">${initials(it.name)}${it.icon ? `<img src="${esc(it.icon)}" alt="" loading="lazy" onerror="this.remove()">` : ''}</div>
    <div class="grow"><div class="name">${esc(it.name)}</div><div class="meta">${meta}</div></div>
    ${isNew(it.added) ? '<span class="badge">Nuevo</span>' : ''}
    <button class="star${favs[ui.tab].items.has(it.id) ? ' on' : ''}" data-act="fav" aria-label="Favorito">★</button>
  </div>`;
}

function onItemClick(it, i, act) {
  if (act === 'fav') {
    toggle(favs[ui.tab].items, it.id);
    if ((ui.folder[ui.tab] || ALL) === FAV && !query) refreshItems(false);
    else itemList.updateRow(i);
    renderFolders();
    return;
  }
  if (ui.tab === 'series') return openSeries(it);
  player.open(list, i, ui.tab === 'live' ? resolveLive : resolveVod);
}

function resolveLive(it) {
  const attempts = [];
  for (const fmt of api.liveFormats()) {
    const url = api.path('live', it.id, fmt);
    if (fmt === 'm3u8') attempts.push(['hls', url], ['native-hls', url]);
    else attempts.push(['mpegts', url]);
  }
  return { title: it.name, attempts };
}

function resolveVod(it) {
  const url = api.path('movie', it.id, it.ext);
  return { title: it.name, attempts: it.ext === 'm3u8' ? [['hls', url], ['native-hls', url]] : [['native', url]] };
}

// ---------------------------------------------------------------- series

async function openSeries(it) {
  series = { item: it, seasons: null, season: null };
  document.body.classList.add('in-series');
  $('#items').hidden = true;
  $('#empty').hidden = true;
  $('#listTitle').textContent = it.name;
  $('#listCount').textContent = '';
  const box = $('#series');
  box.hidden = false;
  box.innerHTML = '<p class="muted">Cargando episodios…</p>';
  try {
    let info = seriesCache.get(it.id);
    if (!info) { info = await api.seriesInfo(it.id); seriesCache.set(it.id, info); }
    if (series?.item !== it) return;
    let eps = info?.episodes || {};
    if (Array.isArray(eps)) eps = Object.fromEntries(eps.map((e, i) => [String(e?.[0]?.season ?? i + 1), e]));
    const seasons = Object.keys(eps).filter(k => eps[k]?.length).sort((a, b) => a - b);
    series.info = info;
    series.eps = eps;
    series.seasons = seasons;
    series.season = seasons[seasons.length - 1];   // latest season first
    renderSeries();
  } catch (ex) {
    box.innerHTML = `<p class="error">${esc(ex.message)}</p>`;
  }
}

function renderSeries() {
  const { item, info, eps, seasons, season } = series;
  const plot = info?.info?.plot || '';
  const cover = info?.info?.cover || item.icon;
  const list = eps[season] || [];
  $('#series').innerHTML = `
    <div class="s-head">
      ${cover ? `<img src="${esc(cover)}" alt="" onerror="this.remove()">` : ''}
      <div><div class="meta">${esc([info?.info?.genre, info?.info?.releaseDate || info?.info?.release_date].filter(Boolean).join(' · '))}</div><p>${esc(plot)}</p></div>
    </div>
    ${seasons.length > 1 ? `<div class="chips">${seasons.map(s => `<button data-season="${esc(s)}" class="${s === season ? 'active' : ''}">T${esc(s)}</button>`).join('')}</div>` : ''}
    ${list.length ? '' : '<p class="muted">Sin episodios</p>'}
    ${list.map((e, i) => `<div class="row ep" data-ep="${i}">
      <span class="num">${esc(e.episode_num ?? i + 1)}</span>
      <div class="grow"><div class="name">${esc(e.title || `Episodio ${e.episode_num ?? i + 1}`)}</div><div class="meta">${esc([e.info?.duration, ago(+e.added)].filter(Boolean).join(' · '))}</div></div>
    </div>`).join('')}`;
}

$('#series').addEventListener('click', e => {
  const s = e.target.closest('[data-season]');
  if (s) { series.season = s.dataset.season; renderSeries(); return; }
  const ep = e.target.closest('[data-ep]');
  if (!ep) return;
  const eps = series.eps[series.season];
  const name = series.item.name;
  const season = series.season;
  player.open(eps, +ep.dataset.ep, x => {
    const ext = x.container_extension || 'mp4';
    const url = api.path('series', x.id, ext);
    return {
      title: `${name} · T${season}E${x.episode_num ?? ''} ${x.title && !x.title.includes(name) ? x.title : ''}`.trim(),
      attempts: ext === 'm3u8' ? [['hls', url], ['native-hls', url]] : [['native', url]],
    };
  });
});

function closeSeries() {
  if (!series) return;
  series = null;
  document.body.classList.remove('in-series');
  $('#series').hidden = true;
  $('#series').innerHTML = '';
  $('#items').hidden = false;
  if (data[ui.tab]) refreshItems(false);
}

// ---------------------------------------------------------------- top bar

for (const b of document.querySelectorAll('.tabs button')) {
  b.addEventListener('click', () => {
    document.body.classList.remove('show-items');
    if (b.dataset.tab !== ui.tab || series) selectTab(b.dataset.tab);
  });
}

let searchTimer;
$('#search').addEventListener('input', e => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    if (!data[ui.tab]) return;
    query = e.target.value.trim();
    closeSeries();
    folderList.refresh();
    refreshItems(true);
    if (query) document.body.classList.add('show-items');
  }, 200);
});

$('#back').addEventListener('click', () => {
  if (series) closeSeries();
  else document.body.classList.remove('show-items');
});

$('#refresh').addEventListener('click', async () => {
  const t = ui.tab;
  seriesCache.clear();
  await ensureData(t, true);
  if (ui.tab !== t) return;
  closeSeries();
  renderFolders();
  refreshItems(false);
  toast('Listas actualizadas', 2000);
});

// ---------------------------------------------------------------- settings

$('#settingsBtn').addEventListener('click', () => {
  const u = api?.info?.user_info;
  const lines = [`<b>${esc(api.username)}</b> @ ${esc(api.server)}`];
  if (u) {
    if (u.exp_date) lines.push(`Caduca: ${new Date(u.exp_date * 1000).toLocaleDateString('es-ES')}`);
    if (u.max_connections) lines.push(`Conexiones: ${esc(u.active_cons ?? 0)} / ${esc(u.max_connections)}`);
    if (u.status) lines.push(`Estado: ${esc(u.status)}`);
  }
  $('#accountInfo').innerHTML = lines.join('<br>');
  $('#proxyInput').value = api.proxy;
  $('#settings').returnValue = '';
  $('#settings').showModal();
});

$('#settings').addEventListener('close', async () => {
  const v = $('#settings').returnValue;
  if (v === 'save') {
    const creds = { ...store.get('creds'), proxy: $('#proxyInput').value.trim() };
    store.set('creds', creds);
    store.set('lastLogin', { server: creds.server, username: creds.username, proxy: creds.proxy });
    api.proxy = creds.proxy;
    api.login().then(() => toast('Proxy guardado', 2000), ex => toast(ex.message, 8000));
  } else if (v === 'cache') {
    await store.cacheClear();
    data = {};
    seriesCache.clear();
    selectTab(ui.tab);
  } else if (v === 'logout') {
    logout();
  }
});

// ---------------------------------------------------------------- boot

const saved = store.get('creds');
if (saved?.server && saved.username) startSession(saved);
else showLogin();
