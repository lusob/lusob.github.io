import { Xtream, parseServerInput, isMixedContent } from './xtream.js?v=20261016c';
import * as store from './store.js?v=20261016c';
import { $, esc, norm, ago, isNew, initials, toast, loading, VList } from './ui.js?v=20261016c';
import { Player } from './player.js?v=20261016c';
import { Epg, hhmm } from './epg.js?v=20261016c';
import { Mosaic } from './mosaic.js?v=20261016c';

const VERSION = '2026-10-16c';
const TYPES = { live: 'Directo', vod: 'Películas', series: 'Series' };
const FAV = '__fav', ALL = '__all', REC = '__rec';
const PAD_START = 120, PAD_END = 900;   // catch-up margins (s): matches start late and run over
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
const settings = Object.assign({ buffer: 10, bufferMax: 60, scan: 6, epg: true, cuShift: 0 }, store.get('settings', {}));

const player = new Player($('#player'), () => settings);
const folderList = new VList($('#folders'), 64, renderFolderRow, onFolderClick);
const itemList = new VList($('#items'), 76, renderItemRow, onItemClick, () => scheduleEpg());
let epg = null;
const mosaic = new Mosaic($('#mosaic'), {
  getSettings: () => settings,
  attempts: it => liveAttempts(it),
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

let backups = {};   // channel id → [backup channel ids]
let recs = [];      // saved programmes: { id, ch, title, start, end, backups }
const saveBackups = () => store.set('bk:' + account, backups);
const saveRecs = () => store.set('rec:' + account, recs);

function loadFavs() {
  backups = store.get('bk:' + account, {});
  recs = store.get('rec:' + account, []);
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
  if (type !== 'live') return loadLazy(type, key, force ? null : usable);
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

// Movies / series: catalogs can be huge, so (like IPTVnator) the folders come first and each
// folder is loaded when opened; the full catalog (needed for "newest first" across folders)
// downloads in the background and replaces the partial view when it arrives.
async function loadLazy(type, key, stale) {
  if (stale) {
    data[type] = build(stale);
    loadFull(type, key, null);
    return data[type];
  }
  delete data[type];
  const stop = paneLoading(type, { text: `Cargando carpetas de ${TYPES[type].toLowerCase()}…` });
  try {
    const cats = await api.categories(type);
    if (!cats.length) {
      // No categories: try the full list, then the M3U playlist (some panels only list
      // movies/series there).
      let fresh = null, apiNote = 'la API no devuelve carpetas';
      try {
        fresh = await api.fetchType(type);
        if (!fresh.items.length) fresh = null;
      } catch (ex) { apiNote = ex.message; }
      if (!fresh) {
        stop();
        const stopM3u = paneLoading(type, { text: `La API no devuelve ${TYPES[type].toLowerCase()}; leyendo la lista M3U (puede tardar)…` });
        try {
          const m = await api.m3u();
          if (!m[type].items.length) {
            const err = new Error(`El servidor no ofrece ${TYPES[type].toLowerCase()} ni por la API ni en la lista M3U`);
            err.detail = `${apiNote}; M3U: ${m.vod.items.length} pelis, ${m.series.items.length} series`;
            throw err;
          }
          fresh = { ...m[type], m3u: true };
        } finally {
          stopM3u();
        }
      }
      fresh.ts = Date.now();
      store.cachePut(key, fresh);
      return (data[type] = build(fresh));
    }
    const partial = { cats, byId: new Map(), loaded: new Set(), loading: new Set(), errors: new Map(), fullLoading: true, fullError: '' };
    data[type] = build({ cats, items: [] }, partial);
    loadFull(type, key, cats);
  } catch (ex) {
    data[type] = build({ cats: [], items: [] });
    data[type].error = ex.message;
    data[type].diag = [ex.detail, api.diag].filter(Boolean).join(' · ');
  } finally {
    stop();
  }
  return data[type];
}

function loadFull(type, key, cats) {
  const a = api, d0 = data[type];
  // Opening folders rebuilds data[type] but keeps the same `partial` object.
  const same = () => api === a && data[type] && (data[type].partial || data[type]) === (d0.partial || d0);
  a.streams(type, null, { timeout: 180000, retries: 1 }).then(async items => {
    if (!items.length) throw new Error('lista completa vacía');
    cats ||= await a.categories(type);
    const fresh = { cats, items, ts: Date.now() };
    store.cachePut(key, fresh);
    if (!same()) return;
    data[type] = build(fresh);
    if (ui.tab === type) { renderFolders(); if (!series) refreshItems(false); }
  }).catch(ex => {
    if (!same() || !d0.partial) return;
    d0.partial.fullLoading = false;
    d0.partial.fullError = `${ACTION_NAMES[type]}: ${ex.message}`;
    if (ui.tab === type && !series) refreshItems(false);
  });
}

const ACTION_NAMES = { vod: 'get_vod_streams', series: 'get_series' };

async function loadFolder(type, id) {
  const d = data[type];
  const p = d?.partial;
  if (!p || p.loaded.has(id) || p.loading.has(id)) return;
  p.loading.add(id);
  p.errors.delete(id);
  try {
    const items = await api.streams(type, id, { timeout: 90000, retries: 2 });
    for (const it of items) {
      const prev = p.byId.get(it.id);
      if (prev) { for (const c of it.cats) if (!prev.cats.includes(c)) prev.cats.push(c); }
      else p.byId.set(it.id, it);
    }
    p.loaded.add(id);
  } catch (ex) {
    p.errors.set(id, ex.message);
  } finally {
    p.loading.delete(id);
  }
  if (data[type] !== d) return;
  data[type] = build({ cats: p.cats, items: [...p.byId.values()] }, p);
  if (ui.tab === type) {
    renderFolders();
    if (!series && !query && ui.folder[type] === id) refreshItems(false);
  }
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
function build({ cats, items }, partial = null) {
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
  const folders = [...folderById.values()].filter(f => partial || f.items.length);
  for (const f of folders) {
    f.safe = f.adult ? [] : f.items.filter(i => !i.hide);
    f.date = f.items[0]?.added || 0;
    f.safeDate = f.safe[0]?.added || 0;
  }
  const safeItems = items.filter(i => !i.hide);
  const hasAdult = items.length !== safeItems.length || folders.some(f => f.adult);
  return { items, safeItems, folders, folderById, byId, hasAdult, partial, noDate: items.some(i => i.noDate) };
}

const visItems = d => unlocked ? d.items : d.safeItems;
const folderItems = f => unlocked ? f.items : f.safe;
const folderDate = f => unlocked ? f.date : f.safeDate;
const pending = (d, f) => !!d.partial && !d.partial.loaded.has(f.id) && (unlocked || !f.adult);   // not loaded yet
const folderVisible = (d, f) => folderItems(f).length > 0 || pending(d, f);

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
  if (f !== FAV && f !== ALL && f !== REC && !(d.folderById.has(f) && folderVisible(d, d.folderById.get(f)))) f = ALL;
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
  // Partial catalog: dates are unknown until the full list arrives, keep the server order.
  const folders = d.folders.filter(f => folderVisible(d, f));
  if (!d.partial) folders.sort((a, b) => folderDate(b) - folderDate(a));
  const rows = [
    { id: FAV, name: '★ Favoritos', count: favItems.length, date: favItems[0]?.added, virtual: true },
    { id: ALL, name: 'Todo', count: all.length, date: all[0]?.added, virtual: true },
    ...(ui.tab === 'live' ? [{ id: REC, name: '⏺ Grabaciones', count: recs.length, virtual: true }] : []),
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
  const p = data[ui.tab].partial;
  const meta = !f.virtual && pending(data[ui.tab], f)
    ? (p.loading.has(f.id) ? 'Cargando…' : p.errors.has(f.id) ? 'Error · toca para reintentar' : 'Toca para abrir')
    : [count + (count === 1 ? ' elemento' : ' elementos'), !data[ui.tab].noDate && ago(date)].filter(Boolean).join(' · ');
  return `<div class="row${active ? ' active' : ''}">
    <div class="grow"><div class="name">${esc(f.name)}</div><div class="meta">${meta}</div></div>
    ${!data[ui.tab].noDate && isNew(date) && f.id !== FAV ? '<span class="badge">Nuevo</span>' : ''}
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
  data[ui.tab]?.partial?.errors.delete(f.id);
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
  } else if (id === REC && ui.tab === 'live') {
    list = sortedRecs();
    title = 'Grabaciones';
  } else {
    const f = d.folderById.get(id);
    list = f ? folderItems(f) : [];
    title = f?.name || '';
    if (f && pending(d, f) && !d.partial.errors.has(f.id)) loadFolder(ui.tab, f.id);
  }
  if (!series) {
    $('#listTitle').textContent = title;
    $('#listCount').textContent = list.length ? list.length : '';
  }
  $('#itemsPane').classList.toggle('poster', ui.tab !== 'live');

  const useMosaic = mosaicOn && ui.tab === 'live' && !series && !(id === REC && !query);
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

  // Empty pane: why, plus a retry when it makes sense.
  const p = d.partial;
  const f = d.folderById.get(id);
  let text, diag = '';
  retryAction = reload;
  if (d.error) {
    text = `No se pudo cargar la lista: ${d.error}`;
    diag = d.diag;
  } else if (query) {
    text = p ? 'Sin resultados en las carpetas cargadas' + (p.fullLoading ? ' (el catálogo completo aún se está descargando)' : '') : 'Sin resultados';
  } else if (id === REC) {
    text = 'Aún no hay grabaciones. Toca ≡ en un canal para abrir su guía y pulsa ⏺ en un programa (o «Programar a mano»).';
  } else if (id === FAV) {
    text = 'Aún no hay favoritos. Pulsa ★ en cualquier elemento.' + (p ? ' Los de carpetas aún no abiertas aparecerán al cargar el catálogo.' : '');
  } else if (p && f && pending(d, f)) {
    const err = p.errors.get(f.id);
    text = err ? `No se pudo cargar la carpeta: ${err}` : '<span class="spinner small"></span>Cargando carpeta…';
    if (err) { diag = `${ACTION_NAMES[ui.tab]}&category_id=${f.id}`; retryAction = () => loadFolder(ui.tab, f.id).then(() => refreshItems(false)); }
  } else if (p && id === ALL) {
    text = p.fullLoading ? '<span class="spinner small"></span>Descargando el catálogo completo… Mientras tanto, abre cualquier carpeta.'
      : 'El catálogo completo no está disponible; abre las carpetas de una en una.';
    diag = p.fullError;
  } else {
    text = 'No hay elementos';
    if (!d.items.length) diag = d.diag || 'el servidor devolvió una lista vacía';
  }
  $('#empty').hidden = !!list.length || !!series;
  $('#emptyText').innerHTML = text.startsWith('<span') ? text : esc(text);
  $('#emptyDiag').textContent = diag ? `Detalle: ${diag}` : '';
  $('#emptyRetry').hidden = !(d.error || diag || (!d.items.length && !p));
}

let retryAction = null;

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
  if (it.rec) return renderRecRow(it);
  const showFolder = query || (ui.folder[ui.tab] || ALL) === FAV || ui.folder[ui.tab] === ALL;
  const meta = [showFolder && folderName(it), !it.noDate && ago(it.added), it.rating && `★ ${it.rating}`].filter(Boolean).map(esc).join(' · ');
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
    ${!it.noDate && isNew(it.added) ? '<span class="badge">Nuevo</span>' : ''}
    ${ui.tab === 'live' && it.archive ? `<span class="badge arch" title="Archivo de ${it.archive} días">⏪ ${it.archive} d</span>` : ''}
    ${ui.tab === 'live' ? '<button class="star gbtn" data-act="guide" aria-label="Guía">≡</button>' : ''}
    <button class="star${favs[ui.tab].items.has(it.id) ? ' on' : ''}" data-act="fav" aria-label="Favorito">★</button>
  </div>`;
}

function onItemClick(it, i, act) {
  if (it.rec) return onRecClick(it, act);
  if (act === 'guide') return openGuide(it);
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

function liveAttempts(it) {
  const attempts = [];
  for (const fmt of api.liveFormats()) {
    const url = api.path('live', it.id, fmt);
    if (fmt === 'm3u8') attempts.push(['hls', url], ['native-hls', url]);
    else attempts.push(['mpegts', url]);
  }
  return attempts;
}

const liveSources = chans => chans.map(c => ({ name: c.name, attempts: () => liveAttempts(c) }));

function resolveLive(it) {
  return { title: it.name, live: true, sources: liveSources([it, ...backupsOf(it.id)]) };
}

function resolveVod(it) {
  const url = it.url ? api.wrap(it.url) : api.path('movie', it.id, it.ext);
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
  updatePlayerButtons(it);
  if (player.cu) return player.setInfo(player.cuInfo || '');
  const e = epg?.get(it.id);
  if (!e?.now) return player.setInfo('');
  player.setInfo(`<b>Ahora</b> ${esc(e.now.title)} <span class="dim">${hhmm(e.now.start)}–${hhmm(e.now.end)}</span>` +
    (e.next ? ` · <b>Después</b> ${esc(e.next.title)} <span class="dim">${hhmm(e.next.start)}</span>` : ''));
}

player.onchange = it => {
  updatePlayerButtons(it);
  if (playerKind !== 'live' || !epg) return;
  epg.want([it.id], true);
  updatePlayerEpg(it);
};

player.onclose = () => {
  updatePlayerButtons(null);
  if (mosaicOn && !$('#mosaic').hidden) mosaic.resume();
};

// Refresh progress bars / current programme every minute.
setInterval(() => {
  if (ui.tab === 'live' && settings.epg && data.live && !$('#items').hidden) { itemList.refresh(); scheduleEpg(); }
}, 60000);

// ---------------------------------------------------------------- catch-up, backups, recordings
// Catch-up plays the provider's archive (timeshift) of a channel. A "recording" is a saved
// programme played later from that archive, with backup channels tried in order when the
// main one has no archive or cuts out.

const liveById = id => data.live?.byId.get(String(id));
const backupsOf = id => (backups[id] || []).map(liveById).filter(Boolean);
const hasArchive = chans => chans.some(c => c.archive > 0);
const archiveDays = chans => Math.max(0, ...chans.map(c => c.archive || 0));

// Play programme `prog` ({title, start, end}) of channel `ch` from `pos` (default: its start).
function playCatchup(ch, prog, pos = null, backupIds = null) {
  const chans = [ch, ...(backupIds ? backupIds.map(liveById).filter(Boolean) : backupsOf(ch.id))];
  const withArchive = chans.filter(c => c.archive > 0);
  const use = withArchive.length ? withArchive : [ch];
  const start = prog.start - PAD_START, end = prog.end + PAD_END;
  mosaic.stop();
  playerKind = 'live';
  player.cuInfo = `<b>Diferido</b> ${esc(prog.title || '')} <span class="dim">${dayLabel(prog.start)} ${hhmm(prog.start)}–${hhmm(prog.end)}</span>`;
  player.open([ch], 0, () => ({
    title: ch.name,
    live: true,
    sources: use.map(c => ({ name: c.name, attempts: at => api.timeshift(c.id, at, (end - at) / 60, settings.cuShift || 0) })),
    catchup: { start, end, pos: pos ?? start },
    liveSources: liveSources(chans),
  }), favCtl('live'));
}

function updatePlayerButtons(it) {
  const live = !!it && player.isOpen && playerKind === 'live' && !!liveById(it.id);
  const now = live && epg?.get(it.id)?.now;
  $('#pGuide').hidden = !live;
  $('#pBackup').hidden = !live;
  $('#pStart').hidden = !(live && !player.cu && now && hasArchive([it, ...backupsOf(it.id)]));
}

$('#pStart').addEventListener('click', () => {
  const it = player.current, now = epg?.get(it.id)?.now;
  if (now) playCatchup(it, now);
});
$('#pGuide').addEventListener('click', () => openGuide(player.current));
$('#pBackup').addEventListener('click', () => editBackups(player.current));

const DAY = 86400;
function dayLabel(sec) {
  const d = new Date(sec * 1000), t = new Date();
  const diff = Math.round((new Date(d.toDateString()) - new Date(t.toDateString())) / DAY / 1000);
  if (diff === 0) return 'hoy';
  if (diff === -1) return 'ayer';
  if (diff === 1) return 'mañana';
  return d.toLocaleDateString('es-ES', { weekday: 'short', day: 'numeric', month: 'short' });
}

// ---- guide

const tableCache = new Map();   // channel id → { list, ts }
let guideCh = null;

async function openGuide(ch) {
  guideCh = ch;
  const dlg = $('#guide');
  $('#gTitle').textContent = ch.name;
  const chans = [ch, ...backupsOf(ch.id)];
  $('#gNote').textContent = hasArchive(chans)
    ? `Archivo del proveedor: ${archiveDays(chans)} días${ch.archive ? '' : ' (en los canales de respaldo)'}. Toca un programa pasado para verlo entero.`
    : 'Este canal no tiene archivo en tu proveedor: solo se puede ver en directo. Añade canales de respaldo con archivo para poder verlo después.';
  $('#gBody').innerHTML = '<div class="empty-note"><span class="spinner small"></span>Cargando guía…</div>';
  if (!dlg.open) dlg.showModal();
  let c = tableCache.get(ch.id);
  if (!c || Date.now() - c.ts > 10 * 60e3) {
    try {
      c = { list: await api.epgTable(ch.id), ts: Date.now() };
      tableCache.set(ch.id, c);
    } catch (ex) {
      c = null;
      if (guideCh === ch) $('#gBody').innerHTML = `<div class="empty-note">No se pudo cargar la guía: ${esc(ex.message)}</div>`;
      return;
    }
  }
  if (guideCh !== ch || !dlg.open) return;
  renderGuide(ch, c.list);
}

function progAvailable(ch, p) {
  const chans = [ch, ...backupsOf(ch.id)];
  const days = archiveDays(chans);
  return (p.archive || days > 0) && p.start > Date.now() / 1000 - Math.max(days, 1) * DAY;
}

function renderGuide(ch, list) {
  const now = Date.now() / 1000;
  const days = archiveDays([ch, ...backupsOf(ch.id)]);
  // Past programmes only as far back as the archive goes (a few hours if there is none).
  const from = now - (days ? days * DAY : 3 * 3600);
  const progs = list.filter(p => p.end > from);
  if (!progs.length) {
    $('#gBody').innerHTML = '<div class="empty-note">Sin guía para este canal. Puedes usar «Programar a mano».</div>';
    return;
  }
  let lastDay = '', html = '';
  progs.forEach((p, i) => {
    const day = dayLabel(p.start);
    if (day !== lastDay) { html += `<div class="g-day">${esc(day[0].toUpperCase() + day.slice(1))}</div>`; lastDay = day; }
    const state = p.end <= now ? 'past' : p.start <= now ? 'now' : 'future';
    const avail = progAvailable(ch, p);
    const saved = recs.some(r => r.ch === ch.id && r.start === p.start);
    let btns = '', meta = '';
    if (state === 'past') {
      meta = avail ? 'En el archivo' : 'Sin archivo';
      if (avail) btns = '<button data-act="play">▶ Ver</button>';
    } else if (state === 'now') {
      meta = `En directo · empezó hace ${Math.round((now - p.start) / 60)} min`;
      if (avail) btns = '<button data-act="play">⏮ Desde el inicio</button>';
    } else {
      meta = `Dentro de ${fmtDur(p.start - now)}`;
    }
    if (state !== 'past') btns += `<button data-act="rec" class="${saved ? 'on' : ''}">${saved ? '✓ Guardado' : '⏺ Guardar'}</button>`;
    html += `<div class="g-row ${state}${state === 'past' && !avail ? ' gone' : ''}" data-i="${i}">
      <div class="g-time">${hhmm(p.start)}–${hhmm(p.end)}</div>
      <div class="grow"><div class="name">${esc(p.title || 'Sin título')}</div><div class="meta">${esc(meta)}</div></div>
      ${btns}</div>`;
  });
  const body = $('#gBody');
  body.innerHTML = html;
  body.onclick = e => {
    const row = e.target.closest('.g-row');
    if (!row) return;
    const p = progs[+row.dataset.i];
    const act = e.target.closest('button')?.dataset.act || (p.start <= now && progAvailable(ch, p) ? 'play' : p.end > now ? 'rec' : '');
    if (act === 'play') {
      $('#guide').close();
      playCatchup(ch, p);
    } else if (act === 'rec') {
      const r = recs.find(r => r.ch === ch.id && r.start === p.start);
      if (r) editRec(r);
      else saveRec({ ch: ch.id, title: p.title, start: p.start, end: p.end, backups: backups[ch.id] || [] }, true);
      renderGuide(ch, list);
    }
  };
  const cur = body.querySelector('.g-row.now') || body.querySelector('.g-row:not(.past)');
  if (cur) body.scrollTop = Math.max(0, cur.offsetTop - body.offsetTop - 60);
}

function fmtDur(s) {
  const m = Math.max(1, Math.round(s / 60));
  if (m < 60) return `${m} min`;
  if (m < 1440) return m % 60 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${m / 60} h`;
  return `${Math.round(m / 1440)} días`;
}

$('#gClose').addEventListener('click', () => $('#guide').close());
$('#gManual').addEventListener('click', () => {
  const start = Math.ceil(Date.now() / 1000 / 900) * 900;
  editRec({ ch: guideCh.id, title: '', start, end: start + 2 * 3600, backups: backups[guideCh.id] || [] }, true);
});
$('#gBackups').addEventListener('click', () => editBackups(guideCh));

// ---- recordings

function saveRec(r, announce = false) {
  r.id ||= Math.random().toString(36).slice(2);
  recs = recs.filter(x => x.id !== r.id).concat(r);
  saveRecs();
  if (announce) {
    const chans = [r.ch, ...r.backups].map(liveById).filter(Boolean);
    toast(hasArchive(chans)
      ? `Guardado en ⏺ Grabaciones: podrás verlo entero durante ${archiveDays(chans)} días`
      : 'Guardado, pero ninguno de estos canales tiene archivo: solo podrás verlo en directo. Añade respaldos con ⏪.', 5000);
  }
  if (ui.tab === 'live' && data.live) { renderFolders(); if (ui.folder.live === REC && !query) refreshItems(false); }
}

function sortedRecs() {
  const now = Date.now() / 1000;
  const rank = r => r.end <= now ? 2 : r.start <= now ? 0 : 1;
  return recs.map(r => ({ ...r, rec: true, name: r.title }))
    .sort((a, b) => rank(a) - rank(b) || (rank(a) === 2 ? b.start - a.start : a.start - b.start));
}

function recStatus(r) {
  const now = Date.now() / 1000;
  const chans = [r.ch, ...r.backups].map(liveById).filter(Boolean);
  const days = archiveDays(chans);
  if (now < r.start) return `Programada · ${dayLabel(r.start)} ${hhmm(r.start)}–${hhmm(r.end)}`;
  if (now < r.end) return `● En curso desde las ${hhmm(r.start)} · toca para verlo desde el principio`;
  if (!days) return `${dayLabel(r.start)} ${hhmm(r.start)} · sin archivo en estos canales`;
  const until = r.start + days * DAY;
  return now < until ? `${dayLabel(r.start)} ${hhmm(r.start)} · disponible hasta ${dayLabel(until)} ${hhmm(until)}` : `${dayLabel(r.start)} · caducada (fuera del archivo)`;
}

function renderRecRow(r) {
  const ch = liveById(r.ch);
  const bk = r.backups.length ? ` · ${r.backups.length} de respaldo` : '';
  return `<div class="row rec">
    <div class="logo">⏺</div>
    <div class="grow"><div class="name">${esc(r.title || 'Sin título')}</div>
      <div class="meta">${esc(recStatus(r))} · ${esc(ch?.name || 'canal no disponible')}${bk}</div></div>
    <button class="star gbtn" data-act="edit" aria-label="Editar">✎</button>
  </div>`;
}

function onRecClick(r, act) {
  const saved = recs.find(x => x.id === r.id);
  if (!saved) return;
  if (act === 'edit') return editRec(saved);
  const ch = liveById(saved.ch);
  if (!ch) return toast('El canal de esta grabación ya no existe');
  if (Date.now() / 1000 < saved.start) return toast(`Empieza ${dayLabel(saved.start)} a las ${hhmm(saved.start)}. Desde ese momento podrás verlo desde el principio.`, 5000);
  playCatchup(ch, saved, null, saved.backups);
}

// ---- recording / backup dialog

let plan = null;   // { mode: 'rec' | 'backup', rec?, ch, picked: [ids] }

function editRec(r, isNew = false) {
  const ch = liveById(r.ch);
  if (!ch) return;
  plan = { mode: 'rec', rec: r, ch, picked: [...r.backups], isNew };
  $('#planTitle').textContent = isNew ? `Programar en ${ch.name}` : `Grabación en ${ch.name}`;
  $('#planHint').textContent = 'Se reproduce desde el archivo del proveedor (catch-up), incluso si llegas tarde o después de que termine.';
  $('#planFields').hidden = false;
  $('#planName').value = r.title || '';
  $('#planStart').value = toLocalInput(r.start);
  const dur = Math.round((r.end - r.start) / 60);
  const sel = $('#planDur');
  if (![...sel.options].some(o => +o.value === dur)) sel.add(new Option(`${dur} min`, dur));
  sel.value = String(dur);
  $('#planDelete').hidden = isNew;
  openPlan();
}

function editBackups(ch) {
  plan = { mode: 'backup', ch, picked: [...(backups[ch.id] || [])] };
  $('#planTitle').textContent = `Respaldo de ${ch.name}`;
  $('#planHint').textContent = 'Si el canal no carga o se corta, se pasa al siguiente de la lista (y en diferido, al mismo minuto). Usa canales que emitan lo mismo; los marcados con ⏪ tienen archivo.';
  $('#planFields').hidden = true;
  $('#planDelete').hidden = true;
  openPlan();
}

function openPlan() {
  $('#planSearch').value = '';
  $('#planResults').innerHTML = '';
  renderPicked();
  $('#planDialog').returnValue = '';
  $('#planDialog').showModal();
}

function renderPicked() {
  $('#planChips').innerHTML = plan.picked.map((id, i) => {
    const c = liveById(id);
    return c ? `<button type="button" data-rm="${i}">${i + 1}. ${esc(c.name)}${c.archive ? ' ⏪' : ''} ✕</button>` : '';
  }).join('');
}

$('#planChips').addEventListener('click', e => {
  const b = e.target.closest('[data-rm]');
  if (!b) return;
  plan.picked.splice(+b.dataset.rm, 1);
  renderPicked();
});

$('#planSearch').addEventListener('input', e => {
  const q = norm(e.target.value.trim());
  const res = q ? visItems(data.live).filter(c => c.key.includes(q) && c.id !== plan.ch.id && !plan.picked.includes(c.id)).slice(0, 8) : [];
  $('#planResults').innerHTML = res.map(c => `<button type="button" data-add="${esc(c.id)}">＋ ${esc(c.name)}${c.archive ? ` <span class="dim">⏪ ${c.archive} d</span>` : ''}</button>`).join('');
});

$('#planResults').addEventListener('click', e => {
  const b = e.target.closest('[data-add]');
  if (!b) return;
  plan.picked.push(b.dataset.add);
  $('#planSearch').value = '';
  $('#planResults').innerHTML = '';
  renderPicked();
  $('#planSearch').focus();
});

// Enter in the search box must not submit the dialog.
$('#planSearch').addEventListener('keydown', e => { if (e.key === 'Enter') e.preventDefault(); });

$('#planDialog').addEventListener('close', () => {
  const v = $('#planDialog').returnValue;
  const p = plan;
  plan = null;
  if (!p || (v !== 'save' && v !== 'delete')) return;
  if (p.mode === 'backup') {
    backups[p.ch.id] = p.picked;
    if (!p.picked.length) delete backups[p.ch.id];
    saveBackups();
    if (player.isOpen && player.current?.id === p.ch.id) {
      player.setSources(liveSources([p.ch, ...backupsOf(p.ch.id)]));
      updatePlayerButtons(p.ch);
    }
    if ($('#guide').open && guideCh?.id === p.ch.id) openGuide(p.ch);
    toast(p.picked.length ? `${p.picked.length} canal${p.picked.length > 1 ? 'es' : ''} de respaldo guardado${p.picked.length > 1 ? 's' : ''}` : 'Sin canales de respaldo', 2500);
    return;
  }
  if (v === 'delete') {
    recs = recs.filter(x => x.id !== p.rec.id);
    saveRecs();
    if (ui.tab === 'live' && data.live) { renderFolders(); if (ui.folder.live === REC) refreshItems(false); }
  } else {
    const start = Math.floor(new Date($('#planStart').value).getTime() / 1000) || p.rec.start;
    const end = start + +$('#planDur').value * 60;
    saveRec({ ...p.rec, title: $('#planName').value.trim() || 'Sin título', start, end, backups: p.picked }, p.isNew);
  }
  if ($('#guide').open && guideCh) { const c = tableCache.get(guideCh.id); if (c) renderGuide(guideCh, c.list); }
});

function toLocalInput(sec) {
  const d = new Date(sec * 1000);
  const z = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${z(d.getMonth() + 1)}-${z(d.getDate())}T${z(d.getHours())}:${z(d.getMinutes())}`;
}

// Heads-up when a saved programme starts while the app is open.
const announced = new Set();
setInterval(() => {
  const now = Date.now() / 1000;
  for (const r of recs) {
    if (r.start <= now && now - r.start < 120 && !announced.has(r.id)) {
      announced.add(r.id);
      toast(`Empieza «${r.title}». Está en ⏺ Grabaciones.`, 8000);
    }
  }
}, 30000);

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
    let info = it.episodes ? { info: {}, episodes: it.episodes } : seriesCache.get(it.id);   // M3U series carry their episodes
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
    const url = x.url ? api.wrap(x.url) : api.path('series', x.id, ext);
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
$('#emptyRetry').addEventListener('click', () => (retryAction || reload)());

// ---------------------------------------------------------------- settings

$('#settingsBtn').addEventListener('click', () => {
  const u = api?.info?.user_info;
  const lines = [`<b>${esc(api.username)}</b> @ ${esc(api.server)}`];
  if (u) {
    if (u.exp_date) lines.push(`Caduca: ${new Date(u.exp_date * 1000).toLocaleDateString('es-ES')}`);
    if (u.max_connections) lines.push(`Conexiones: ${esc(u.active_cons ?? 0)} / ${esc(u.max_connections)}`);
    if (u.status) lines.push(`Estado: ${esc(u.status)}`);
  }
  lines.push(`<span class="dim">Versión de la app: ${VERSION}</span>`);
  $('#accountInfo').innerHTML = lines.join('<br>');
  $('#diagOut').hidden = true;
  $('#proxyInput').value = api.proxy;
  $('#bufferInput').value = String(settings.buffer);
  $('#bufferMaxInput').value = String(settings.bufferMax);
  $('#scanInput').value = String(settings.scan);
  $('#epgInput').checked = !!settings.epg;
  $('#cuShiftInput').value = String(settings.cuShift || 0);
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
    settings.cuShift = +$('#cuShiftInput').value;
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

// Connection test: every list request with its time, size and number of items.
$('#diagBtn').addEventListener('click', async () => {
  const out = $('#diagOut');
  const btn = $('#diagBtn');
  out.hidden = false;
  btn.disabled = true;
  const lines = [`App ${VERSION} · ${navigator.userAgent.match(/Chrome\/[\d.]+/)?.[0] || ''}`];
  const show = () => { out.textContent = lines.join('\n'); out.scrollTop = out.scrollHeight; };
  const run = async (label, action, extra, timeout) => {
    lines.push(`${label}: …`); show();
    lines[lines.length - 1] = `${label}: ${await api.probe(action, extra, timeout)}`; show();
  };
  await run('login', null, {}, 30000);
  const si = api.info?.server_info;
  if (si && (si.url || si.port)) lines.push(`server_info: ${[si.url, si.port, si.https_port, si.server_protocol, si.timezone].filter(Boolean).join(' · ')}`);
  for (const t of ['vod', 'series']) {
    const [ca, ia] = t === 'vod' ? ['get_vod_categories', 'get_vod_streams'] : ['get_series_categories', 'get_series'];
    await run(ca, ca, {}, 45000);
    const first = data[t]?.partial?.cats[0] || data[t]?.folders[0];
    if (first && !String(first.id).startsWith('m3u:')) await run(`${ia} (carpeta ${first.name})`, ia, { category_id: first.id }, 90000);
    await run(`${ia} (completa)`, ia, {}, 180000);
  }
  await run('get.php (lista M3U)', 'm3u', { type: 'm3u_plus', output: 'ts' }, 240000);
  for (const t of ['vod', 'series']) {
    const d = data[t];
    lines.push(`${TYPES[t]} en la app: ${!d ? 'sin cargar' : d.error ? `error: ${d.error} (${d.diag || ''})` : `${d.items.length} elementos, ${d.folders.length} carpetas${d.noDate ? ' (de la lista M3U)' : ''}${d.partial ? `, por carpetas (completa: ${d.partial.fullLoading ? 'descargando' : d.partial.fullError || 'ok'})` : ''}`}`);
  }
  show();
  btn.disabled = false;
});

// ---------------------------------------------------------------- boot

const saved = store.get('creds');
if (saved?.server && saved.username) startSession(saved);
else showLogin();
