import { Xtream, parseServerInput, isMixedContent } from './xtream.js';
import * as store from './store.js';
import { $, esc, norm, ago, isNew, initials, toast, loading, VList } from './ui.js';
import { Player } from './player.js';
import { Epg, hhmm } from './epg.js';
import { Mosaic } from './mosaic.js';

const TYPES = { live: 'Directo', vod: 'Películas', series: 'Series' };
const FAV = '__fav', ALL = '__all';
const MAX_AGE = 12 * 3600e3;   // refetch lists older than 12 h
const ADULT_RE = /(^|[^\p{L}])(adult[oa]?s?|xxx|porn\p{L}*|er[oó]tic\p{L}*|hentai)(?!\p{L})|18\s*\+|\+\s*18/iu;
const isAdultName = n => ADULT_RE.test(n) && !/adult\s*swim/i.test(n);

let api = null;
let account = '';
let favs = null;               // { [type]: { items: Set, cats: Set } }
let data = {};                 // { [type]: built lists }
const inflight = new Map();    // type → Promise while a list is downloading
let query = '';
let list = [];                 // items currently shown in the right pane
let series = null;             // open series: { item, eps, seasons, season }
let unlocked = false;          // adult content visible (this page load only)
let mosaicOn = false;
let playerKind = '';           // 'live' | 'vod' | 'series'
const seriesCache = new Map();
const ui = Object.assign({ tab: 'live', folder: {} }, store.get('ui', {}));
const settings = Object.assign({ buffer: 10, bufferMax: 60, scan: 6, epg: true }, store.get('settings', {}));

const player = new Player($('#player'), () => settings);
const folderList = new VList($('#folders'), 64, renderFolderRow, onFolderClick);
const itemList = new VList($('#items'), 76, renderItemRow, onItemClick, () => scheduleEpg());
let epg = null;
const mosaic = new Mosaic($('#mosaic'), {
  getSettings: () => settings,
  attempts: it => resolveLive(it).attempts,
  onOpen: (items, i) => { mosaic.stop(); playerKind = 'live'; player.open(items, i, resolveLive, favCtl('live')); },
  info: it => esc(epgNow(it)?.title || ''),
  onVisible: items => { if (settings.epg && epg) epg.want(items.map(i => i.id)); },
  pager: { root: $('#mosaicPager'), prev: $('#mPrev'), next: $('#mNext'), label: $('#mPage') },
});

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
  inflight.clear();
  epg = new Epg(api, onEpg);
  loadFavs();
  showView('main');
  if (!info) api.login().catch(() => {});
  selectTab(ui.tab in TYPES ? ui.tab : 'live');
}

function logout() {
  mosaic.hide();
  store.del('creds');
  api = null;
  data = {};
  unlocked = false;
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

// ---------------------------------------------------------------- adult lock (PIN)

async function hashPin(pin, salt) {
  const text = salt + ':' + pin;
  if (crypto.subtle) {
    const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  let h = 0;
  for (const c of text) h = (h * 31 + c.charCodeAt(0)) | 0;
  return 'x' + h;
}

async function savePin(pin) {
  const salt = Math.random().toString(36).slice(2);
  store.set('pin', { salt, hash: await hashPin(pin, salt) });
}

const checkPin = async p => {
  const saved = store.get('pin');
  return (await hashPin(p, saved.salt)) === saved.hash ? null : 'PIN incorrecto';
};

function askPin({ title, hint = '', confirm = false, check }) {
  return new Promise(resolve => {
    const dlg = $('#pinDialog');
    $('#pinTitle').textContent = title;
    $('#pinHint').textContent = hint;
    $('#pinHint').hidden = !hint;
    $('#pinInput').value = '';
    $('#pinInput2').value = '';
    $('#pinInput2').hidden = !confirm;
    $('#pinError').hidden = true;
    $('#pinForm').onsubmit = async e => {
      e.preventDefault();
      if (e.submitter?.value === 'cancel') { dlg.close(); return resolve(null); }
      const pin = $('#pinInput').value;
      const err = pin.length < 4 ? 'Mínimo 4 caracteres'
        : confirm && pin !== $('#pinInput2').value ? 'Los PIN no coinciden'
        : check ? await check(pin) : null;
      if (err) {
        $('#pinError').textContent = err;
        $('#pinError').hidden = false;
        $('#pinInput').value = '';
        return;
      }
      dlg.close();
      resolve(pin);
    };
    dlg.oncancel = () => resolve(null);
    dlg.showModal();
    $('#pinInput').focus();
  });
}

async function unlock() {
  if (!store.get('pin')) {
    const pin = await askPin({
      title: 'Crea un PIN para adultos',
      hint: 'Se pedirá para mostrar el contenido adulto. Se guarda solo en este navegador.',
      confirm: true,
    });
    if (!pin) return false;
    await savePin(pin);
    return true;
  }
  return !!(await askPin({ title: 'PIN de contenido adulto', check: checkPin }));
}

async function changePin() {
  if (store.get('pin') && !(await askPin({ title: 'PIN actual', check: checkPin }))) return;
  const pin = await askPin({ title: 'Nuevo PIN', confirm: true });
  if (!pin) return;
  await savePin(pin);
  toast('PIN cambiado', 2000);
}

function setLocked(locked) {
  unlocked = !locked;
  const d = data[ui.tab];
  if (locked && d?.folderById.get(ui.folder[ui.tab])?.adult) ui.folder[ui.tab] = ALL;
  closeSeries();
  renderFolders();
  refreshItems(true);
}

// ---------------------------------------------------------------- data

function ensureData(type, force = false) {
  if (data[type] && !force) return Promise.resolve(data[type]);
  if (inflight.has(type)) return inflight.get(type);
  const p = loadData(type, force).finally(() => inflight.delete(type));
  inflight.set(type, p);
  return p;
}

async function loadData(type, force) {
  const key = account + '|' + type;
  const cached = await store.cacheGet(key);
  // Empty cached lists are ignored (an earlier version could cache a failed load as empty).
  const usable = cached?.items?.length ? cached : null;
  if (usable && !force && Date.now() - usable.ts < MAX_AGE) return (data[type] = build(usable));
  if (force) delete data[type];
  const label = `Cargando ${TYPES[type].toLowerCase()}…`;
  const progress = { text: label };
  const stop = paneLoading(type, progress);
  try {
    const fresh = await api.fetchType(type, (done, total) => { progress.text = `${label} carpeta ${done}/${total}`; });
    fresh.ts = Date.now();
    if (fresh.items.length) store.cachePut(key, fresh);
    data[type] = build(fresh);
    data[type].diag = api.diag;
  } catch (ex) {
    if (usable) {
      data[type] = build(usable);
      toast('No se pudo actualizar: mostrando la lista guardada');
    } else {
      data[type] = build({ cats: [], items: [] });
      data[type].error = ex.message;
      data[type].diag = [ex.detail, api.diag].filter(Boolean).join(' · ');
    }
  } finally {
    stop();
  }
  return data[type];
}

// Loading state inside the list pane (with elapsed time), so other tabs stay usable.
function paneLoading(type, progress) {
  const t0 = Date.now();
  const draw = () => {
    if (ui.tab !== type || data[type]) return;
    const s = Math.floor((Date.now() - t0) / 1000);
    $('#empty').hidden = false;
    $('#emptyRetry').hidden = true;
    $('#emptyText').innerHTML = `<span class="spinner small"></span>${esc(progress.text)}${s >= 3 ? ` ${s} s` : ''}` +
      (s >= 20 ? '<br><span class="muted">El servidor tarda en responder; seguimos intentándolo.</span>' : '');
  };
  draw();
  const timer = setInterval(draw, 1000);
  return () => clearInterval(timer);
}

// Folders and items newest first; a folder is as recent as its newest item.
function build({ cats, items }) {
  items = items.slice().sort((a, b) => b.added - a.added);
  const folderById = new Map(cats.map(c => [c.id, { id: c.id, name: c.name, items: [], adult: isAdultName(c.name) }]));
  const byId = new Map();
  let other = null;
  for (const it of items) {
    it.key = norm(it.name);
    byId.set(it.id, it);
    const known = [];
    for (const c of it.cats) {
      const f = folderById.get(c);
      if (f) { f.items.push(it); known.push(f); }
    }
    if (!known.length) {
      other ||= { id: '__other', name: 'Sin categoría', items: [], adult: false };
      other.items.push(it);
    }
    it.hide = !!it.adult || (known.length > 0 && known.every(f => f.adult));
  }
  if (other) folderById.set(other.id, other);
  const folders = [...folderById.values()].filter(f => f.items.length);
  for (const f of folders) {
    f.safe = f.adult ? [] : f.items.filter(i => !i.hide);
    f.date = f.items[0]?.added || 0;
    f.safeDate = f.safe[0]?.added || 0;
  }
  const safeItems = items.filter(i => !i.hide);
  const hasAdult = items.length !== safeItems.length || folders.some(f => f.adult);
  return { items, safeItems, folders, folderById, byId, hasAdult };
}

const visItems = d => unlocked ? d.items : d.safeItems;
const folderItems = f => unlocked ? f.items : f.safe;
const folderDate = f => unlocked ? f.date : f.safeDate;

// ---------------------------------------------------------------- tabs & folders

async function selectTab(type) {
  ui.tab = type;
  saveUi();
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.tab === type);
  closeSeries();
  mosaic.hide();
  mosaic.source = null;
  $('#mosaicBtn').hidden = type !== 'live';
  if (!data[type]) {
    folderList.set([]);
    itemList.set([]);
    $('#mosaic').hidden = true;
    $('#items').hidden = false;
    $('#listTitle').textContent = '';
    $('#listCount').textContent = '';
  }
  await ensureData(type);
  if (ui.tab !== type) return;
  renderFolders(false);
  const d = data[type];
  let f = ui.folder[type] || ALL;
  if (f !== FAV && f !== ALL && !(d.folderById.has(f) && folderItems(d.folderById.get(f)).length)) f = ALL;
  ui.folder[type] = f;
  refreshItems(true);
}

function renderFolders(keepScroll = true) {
  const d = data[ui.tab];
  if (!d) return;
  const fc = favs[ui.tab].cats;
  const fi = favs[ui.tab].items;
  const all = visItems(d);
  const favItems = all.filter(i => fi.has(i.id));
  const folders = d.folders
    .filter(f => folderItems(f).length)
    .sort((a, b) => folderDate(b) - folderDate(a));
  const rows = [
    { id: FAV, name: '★ Favoritos', count: favItems.length, date: favItems[0]?.added, virtual: true },
    { id: ALL, name: 'Todo', count: all.length, date: all[0]?.added, virtual: true },
    ...folders.filter(f => fc.has(f.id)),
    ...folders.filter(f => !fc.has(f.id)),
  ];
  if (d.hasAdult) rows.push({ lock: true, name: unlocked ? '🔓 Ocultar contenido adulto' : '🔒 Contenido adulto' });
  folderList.set(rows, !keepScroll);
}

function renderFolderRow(f) {
  if (f.lock) {
    return `<div class="row lock"><div class="grow"><div class="name">${esc(f.name)}</div>
      <div class="meta">${unlocked ? 'Visible hasta que recargues la página' : 'Oculto · requiere PIN'}</div></div></div>`;
  }
  const active = (ui.folder[ui.tab] || ALL) === f.id && !query;
  const count = f.virtual ? f.count : folderItems(f).length;
  const date = f.virtual ? f.date : folderDate(f);
  const meta = [count + (count === 1 ? ' elemento' : ' elementos'), ago(date)].filter(Boolean).join(' · ');
  return `<div class="row${active ? ' active' : ''}">
    <div class="grow"><div class="name">${esc(f.name)}</div><div class="meta">${meta}</div></div>
    ${isNew(date) && f.id !== FAV ? '<span class="badge">Nuevo</span>' : ''}
    ${f.virtual ? '' : `<button class="star${favs[ui.tab].cats.has(f.id) ? ' on' : ''}" data-act="fav" aria-label="Favorito">★</button>`}
  </div>`;
}

async function onFolderClick(f, i, act) {
  if (f.lock) {
    if (unlocked) setLocked(true);
    else if (await unlock()) setLocked(false);
    return;
  }
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
  if (!d) return;
  const id = ui.folder[ui.tab] || ALL;
  const all = visItems(d);
  let title;
  if (query) {
    const q = norm(query);
    list = all.filter(i => i.key.includes(q));
    title = `“${query}”`;
  } else if (id === FAV) {
    list = all.filter(i => favs[ui.tab].items.has(i.id));
    title = 'Favoritos';
  } else if (id === ALL) {
    list = all;
    title = 'Todo';
  } else {
    const f = d.folderById.get(id);
    list = f ? folderItems(f) : [];
    title = f?.name || '';
  }
  if (!series) {
    $('#listTitle').textContent = title;
    $('#listCount').textContent = list.length ? list.length : '';
  }
  $('#itemsPane').classList.toggle('poster', ui.tab !== 'live');

  const useMosaic = mosaicOn && ui.tab === 'live' && !series;
  $('#mosaicBtn').classList.toggle('on', useMosaic);
  $('#items').hidden = useMosaic || !!series;
  $('#mosaic').hidden = !useMosaic;
  if (useMosaic) {
    if (mosaic.source !== list) { mosaic.source = list; mosaic.show(list); }
  } else {
    mosaic.hide();
    mosaic.source = null;
    itemList.set(list, resetScroll);
  }

  $('#empty').hidden = !!list.length || !!series;
  $('#emptyRetry').hidden = !d.error;
  $('#emptyText').textContent = d.error ? `No se pudo cargar la lista: ${d.error}`
    : query ? 'Sin resultados'
    : id === FAV ? 'Aún no hay favoritos. Pulsa ★ en cualquier elemento.'
    : 'No hay elementos';
  $('#emptyDiag').textContent = d.error || (!d.items.length && !query) ? `Detalle: ${d.diag || 'el servidor devolvió una lista vacía'}` : '';
  if (!d.error && !d.items.length) $('#emptyRetry').hidden = false;
}

function folderName(it) {
  for (const c of it.cats) {
    const f = data[ui.tab].folderById.get(c);
    if (f) return f.name;
  }
  return '';
}

function epgNow(it) {
  return settings.epg && epg ? epg.get(it.id)?.now : null;
}

function renderItemRow(it) {
  const showFolder = query || (ui.folder[ui.tab] || ALL) === FAV || ui.folder[ui.tab] === ALL;
  const meta = [showFolder && folderName(it), ago(it.added), it.rating && `★ ${it.rating}`].filter(Boolean).map(esc).join(' · ');
  let sub = `<div class="meta">${meta}</div>`;
  if (ui.tab === 'live') {
    const e = settings.epg && epg?.get(it.id);
    if (e?.now) {
      sub = `<div class="meta epg"><b>${hhmm(e.now.start)}</b> ${esc(e.now.title)}${e.next ? `<span class="dim"> · ${hhmm(e.next.start)} ${esc(e.next.title)}</span>` : ''}</div>
        <div class="bar"><i style="width:${Math.round(e.progress * 100)}%"></i></div>`;
    }
  }
  return `<div class="row">
    <div class="logo">${initials(it.name)}${it.icon ? `<img src="${esc(it.icon)}" alt="" loading="lazy" onerror="this.remove()">` : ''}</div>
    <div class="grow"><div class="name">${esc(it.name)}</div>${sub}</div>
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
  playerKind = ui.tab;
  player.open(list, i, ui.tab === 'live' ? resolveLive : resolveVod, favCtl(ui.tab));
}

// Favorite toggle from inside the player. For episodes, the favorite is the series.
function favCtl(type, fixed = null) {
  const target = it => fixed || it;
  return {
    has: it => favs[type].items.has(target(it).id),
    toggle: it => {
      const id = target(it).id;
      toggle(favs[type].items, id);
      if (ui.tab !== type || !data[type]) return;
      if ((ui.folder[type] || ALL) === FAV && !query) refreshItems(false);
      else itemList.updateWhere(x => x.id === id);
      renderFolders();
    },
  };
}

function resolveLive(it) {
  const attempts = [];
  for (const fmt of api.liveFormats()) {
    const url = api.path('live', it.id, fmt);
    if (fmt === 'm3u8') attempts.push(['hls', url], ['native-hls', url]);
    else attempts.push(['mpegts', url]);
  }
  return { title: it.name, live: true, attempts };
}

function resolveVod(it) {
  const url = api.path('movie', it.id, it.ext);
  return { title: it.name, attempts: it.ext === 'm3u8' ? [['hls', url], ['native-hls', url]] : [['native', url]] };
}

// ---------------------------------------------------------------- EPG

let epgTimer;
function scheduleEpg() {
  if (ui.tab !== 'live' || !settings.epg || !epg) return;
  clearTimeout(epgTimer);
  epgTimer = setTimeout(() => epg.want(itemList.visibleItems().map(i => i.id)), 300);
}

function onEpg(id) {
  if (ui.tab === 'live') itemList.updateWhere(it => it.id === id);
  const it = data.live?.byId.get(id);
  if (it && !$('#mosaic').hidden) mosaic.refreshInfo(it);
  if (player.isOpen && playerKind === 'live' && player.current?.id === id) updatePlayerEpg(player.current);
}

function updatePlayerEpg(it) {
  const e = epg?.get(it.id);
  if (!e?.now) return player.setInfo('');
  player.setInfo(`<b>Ahora</b> ${esc(e.now.title)} <span class="dim">${hhmm(e.now.start)}–${hhmm(e.now.end)}</span>` +
    (e.next ? ` · <b>Después</b> ${esc(e.next.title)} <span class="dim">${hhmm(e.next.start)}</span>` : ''));
}

player.onchange = it => {
  if (playerKind !== 'live' || !epg) return;
  epg.want([it.id], true);
  updatePlayerEpg(it);
};

player.onclose = () => {
  if (mosaicOn && !$('#mosaic').hidden) mosaic.resume();
};

// Refresh progress bars / current programme every minute.
setInterval(() => {
  if (ui.tab === 'live' && settings.epg && data.live && !$('#items').hidden) { itemList.refresh(); scheduleEpg(); }
}, 60000);

// ---------------------------------------------------------------- mosaic

$('#mosaicBtn').addEventListener('click', () => {
  mosaicOn = !mosaicOn;
  closeSeries();
  refreshItems(true);
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) mosaic.stop();
  else if (mosaicOn && !$('#mosaic').hidden && !player.isOpen) mosaic.resume();
});

// ---------------------------------------------------------------- series

async function openSeries(it) {
  series = { item: it, eps: null, seasons: null, season: null };
  document.body.classList.add('in-series');
  $('#items').hidden = true;
  $('#mosaic').hidden = true;
  $('#empty').hidden = true;
  $('#listTitle').textContent = it.name;
  $('#listCount').textContent = '';
  const box = $('#series');
  box.hidden = false;
  box.innerHTML = '<p class="muted"><span class="spinner small"></span>Cargando episodios…</p>';
  try {
    let info = seriesCache.get(it.id);
    if (!info) { info = await api.seriesInfo(it.id); seriesCache.set(it.id, info); }
    if (series?.item !== it) return;
    let eps = info?.episodes || {};
    if (Array.isArray(eps)) eps = Object.fromEntries(eps.map((e, i) => [String(e?.[0]?.season ?? i + 1), e]));
    const seasons = Object.keys(eps).filter(k => eps[k]?.length).sort((a, b) => a - b);
    Object.assign(series, { info, eps, seasons, season: seasons[seasons.length - 1] });   // latest season first
    renderSeries();
  } catch (ex) {
    if (series?.item === it) box.innerHTML = `<p class="error">${esc(ex.message)}</p><button data-retry>Reintentar</button>`;
  }
}

function renderSeries() {
  const { item, info, eps, seasons, season } = series;
  const plot = info?.info?.plot || '';
  const cover = info?.info?.cover || item.icon;
  const episodes = eps[season] || [];
  $('#series').innerHTML = `
    <div class="s-head">
      ${cover ? `<img src="${esc(cover)}" alt="" onerror="this.remove()">` : ''}
      <div><div class="meta">${esc([info?.info?.genre, info?.info?.releaseDate || info?.info?.release_date].filter(Boolean).join(' · '))}</div><p>${esc(plot)}</p></div>
    </div>
    ${seasons.length > 1 ? `<div class="chips">${seasons.map(s => `<button data-season="${esc(s)}" class="${s === season ? 'active' : ''}">T${esc(s)}</button>`).join('')}</div>` : ''}
    ${episodes.length ? '' : '<p class="muted">Sin episodios</p>'}
    ${episodes.map((e, i) => `<div class="row ep" data-ep="${i}">
      <span class="num">${esc(e.episode_num ?? i + 1)}</span>
      <div class="grow"><div class="name">${esc(e.title || `Episodio ${e.episode_num ?? i + 1}`)}</div><div class="meta">${esc([e.info?.duration, ago(+e.added)].filter(Boolean).join(' · '))}</div></div>
    </div>`).join('')}`;
}

$('#series').addEventListener('click', e => {
  if (e.target.closest('[data-retry]')) return openSeries(series.item);
  const s = e.target.closest('[data-season]');
  if (s) { series.season = s.dataset.season; renderSeries(); return; }
  const ep = e.target.closest('[data-ep]');
  if (!ep) return;
  const eps = series.eps[series.season];
  const name = series.item.name;
  const season = series.season;
  playerKind = 'series';
  const fav = favCtl('series', series.item);
  player.open(eps, +ep.dataset.ep, x => {
    const ext = x.container_extension || 'mp4';
    const url = api.path('series', x.id, ext);
    return {
      title: `${name} · T${season}E${x.episode_num ?? ''} ${x.title && !x.title.includes(name) ? x.title : ''}`.trim(),
      attempts: ext === 'm3u8' ? [['hls', url], ['native-hls', url]] : [['native', url]],
    };
  }, fav);
});

function closeSeries() {
  if (!series) return;
  series = null;
  document.body.classList.remove('in-series');
  $('#series').hidden = true;
  $('#series').innerHTML = '';
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

async function reload() {
  const t = ui.tab;
  seriesCache.clear();
  epg?.clear();
  closeSeries();
  mosaic.hide();
  mosaic.source = null;
  await ensureData(t, true);
  if (ui.tab !== t) return;
  renderFolders();
  refreshItems(false);
  if (!data[t].error) toast('Listas actualizadas', 2000);
}

$('#refresh').addEventListener('click', reload);
$('#emptyRetry').addEventListener('click', reload);

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
  $('#bufferInput').value = String(settings.buffer);
  $('#bufferMaxInput').value = String(settings.bufferMax);
  $('#scanInput').value = String(settings.scan);
  $('#epgInput').checked = !!settings.epg;
  $('#settings').returnValue = '';
  $('#settings').showModal();
});

$('#settings').addEventListener('close', async () => {
  const v = $('#settings').returnValue;
  if (v === 'save') {
    settings.buffer = +$('#bufferInput').value;
    settings.bufferMax = Math.max(settings.buffer, +$('#bufferMaxInput').value);
    settings.scan = +$('#scanInput').value;
    settings.epg = $('#epgInput').checked;
    store.set('settings', settings);
    const proxy = $('#proxyInput').value.trim();
    if (proxy !== api.proxy) {
      const creds = { ...store.get('creds'), proxy };
      store.set('creds', creds);
      store.set('lastLogin', { server: creds.server, username: creds.username, proxy });
      api.proxy = proxy;
      api.login().then(() => toast('Ajustes guardados', 2000), ex => toast(ex.message, 8000));
    } else {
      toast('Ajustes guardados', 2000);
    }
    if (ui.tab === 'live' && data.live && !$('#items').hidden) { itemList.refresh(); scheduleEpg(); }
  } else if (v === 'pin') {
    changePin();
  } else if (v === 'cache') {
    await store.cacheClear();
    data = {};
    seriesCache.clear();
    epg?.clear();
    selectTab(ui.tab);
  } else if (v === 'logout') {
    logout();
  }
});

// ---------------------------------------------------------------- boot

const saved = store.get('creds');
if (saved?.server && saved.username) startSession(saved);
else showLogin();
