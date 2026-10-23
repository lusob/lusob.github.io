import { Xtream, parseServerInput, isMixedContent } from './xtream.js?v=20261023a';
import * as store from './store.js?v=20261023a';
import { $, esc, norm, ago, isNew, initials, toast, loading, VList } from './ui.js?v=20261023a';
import { Player } from './player.js?v=20261023a';
import { Epg, hhmm, artUrl, MATCH_EARLY } from './epg.js?v=20261023a';
import { Grid } from './grid.js?v=20261023a';
import { Mosaic } from './mosaic.js?v=20261023a';
import { initRemote } from './remote.js?v=20261023a';
import { autoBackups, groupVersions, sportsChannels, SPORTS, findChannels, isForeign } from './backups.js?v=20261023a';
import { Agenda, eventRow, channelVariants, matchTitle, crest, icon, elapsed, hhmmOf, dayOf, NOW as AG_NOW, DAY as AG_DAY, MINE as AG_MINE, COMPS as AG_COMPS } from './agenda.js?v=20261023a';
import { Zapper } from './zap.js?v=20261023a';
import { initTouch } from './touch.js?v=20261023a';
import { initSync } from './sync.js?v=20261023a';

const VERSION = '2026-10-23a';
const TYPES = { live: 'Directo', vod: 'Películas', series: 'Series' };
const FAV = '__fav', ALL = '__all', REC = '__rec', SPORT = '__sport';
const isSport = id => id === SPORT || String(id).startsWith('sport:');
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
let gridOn = false;   // horizontal guide of the folder instead of the list
let playerKind = '';           // 'live' | 'vod' | 'series'
const seriesCache = new Map();
const ui = Object.assign({ tab: 'live', folder: {} }, store.get('ui', {}));
// vod: Películas / Series tabs (hidden: the provider stopped sending them); autoRec: record the
// favourite teams' matches on the Pi; hideSports: agenda sports not shown.
const settings = Object.assign({ buffer: 10, bufferMax: 60, scan: 1, epg: true, cuShift: 0, fit: 'contain', autoFs: true, vod: false, autoRec: false, hideSports: [] }, store.get('settings', {}));
if (!settings.v2) { settings.scan = 1; settings.v2 = true; }   // mosaic now captures after 1 s by default
if (!settings.v3) { settings.fit = 'contain'; settings.v3 = true; }   // zoom cut the channel logos: show the whole picture
ui.hideDead ??= false;

const player = new Player($('#player'), () => settings);
player.guard = () => confirmBusy();   // changing channel while the Pi records
player.saveSettings = () => store.set('settings', settings);
delete settings.bufLearned;      // one learned buffer for every channel (before 2026-10-19)
delete settings.bufLearnedVod;
const folderList = new VList($('#folders'), 64, renderFolderRow, onFolderClick);
const itemList = new VList($('#items'), 76, renderItemRow, onItemClick, () => scheduleEpg());
let epg = null;
const mosaic = new Mosaic($('#mosaic'), {
  getSettings: () => settings,
  attempts: it => liveAttempts(it),
  canScan: () => !recorder?.recording?.length,
  onOpen: async (items, i) => { mosaic.stop(); if (!(await confirmBusy())) return mosaic.resume(); openLive(items, i, $('#listTitle').textContent, ui.folder.live); },
  info: it => esc(epgNow(it)?.title || ''),
  onVisible: items => { if (settings.epg && epg) epg.want(items.map(i => i.id)); },
  onStats: ({ dead }) => { $('#deadCount').textContent = dead ? ` (${dead})` : ''; },
});

const saveUi = () => store.set('ui', ui);

// Channel list on the left and "pilot" footer over the live player.
const zap = new Zapper({
  player,
  epg: () => settings.epg ? epg : null,
  enabled: () => player.isOpen && playerKind === 'live' && !player.cu && !player.sk && !!player.current && !!liveById(player.current.id),
  folders: zapFolders,
  folderItems: zapItems,
  folderOf: it => folderName(it, 'live'),
  play: async (items, i, title, folderId) => { if (await confirmBusy()) openLive(items, i, title, folderId); },
  lastName: () => prevCh && player.current?.id !== prevCh.item.id ? prevCh.item.name : '',
  goLast: () => goLast(),
});
player.onChoose = () => zap.openChans();
initTouch(player, { zapOn: () => zap.ctx.enabled(), openList: () => setTimeout(() => zap.openChans(), 60) });

const grid = new Grid($('#grid'), {
  guide: it => epg?.byName(it.name) || epg?.cache.get(it.id)?.list || null,
  wantEpg: items => { if (settings.epg) epg?.want(items.map(i => i.id)); },
  play: (items, i) => confirmBusy().then(ok => { if (ok) openLive(items, i, $('#listTitle').textContent, query ? null : ui.folder.live); }),
  later: (it, p) => progMenu(it, p),
  mark: (it, p) => (reminderAt(it.id, p.start) ? '🔔 ' : '') + (recList().some(r => r.ch === it.id && r.prog === p.start) ? '⏺ ' : ''),
});

const remote = initRemote({
  folderList, itemList, player, zap,
  mosaicEl: $('#mosaic'),
  homeEl: $('#home'),
  gridEl: $('#grid'),
  seriesEl: $('#series'),
  openFolder: i => onFolderClick(folderList.items[i], i, null),
  openItem: (i, act) => onItemClick(itemList.items[i], i, act),
  closeSeries: () => closeSeries(),
  narrow: () => matchMedia('(max-width: 760px)').matches,
  showFolders: () => document.body.classList.remove('show-items'),
  heroStep: d => heroStep(d),
});

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
  epg = new Epg(api, onEpg, id => data.live?.byId.get(id)?.name);
  loadFavs();
  showView('main');
  if (!info) api.login().catch(() => {});
  selectTab('home');   // the app always opens on the home page
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

let backups = {};   // channel id → [backup channel ids] chosen by hand (otherwise: automatic, by name)
let recs = [];      // saved programmes: { id, ch, title, start, end, backups }
const saveBackups = () => store.set('bk:' + account, backups);
const saveRecs = () => store.set('rec:' + account, recs);

function loadFavs() {
  backups = store.get('bk:' + account, {});
  hiddenF = new Set(store.get('hideF:' + account, []));
  hiddenVer++;
  reminders = store.get('remind:' + account, []);
  hist = store.get('hist:' + account, []);
  aliases = store.get('alias:' + account, {});
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

// The API gave no folders: look for the section elsewhere, logging every try (shown on screen).
// Order: full API list, M3U playlist variants, the old panel_api.php, the host from server_info.
async function discover(type) {
  const name = TYPES[type].toLowerCase();
  const log = ['API: 0 carpetas'];
  const progress = { text: '' };
  const stop = paneLoading(type, progress);
  const step = t => { progress.text = `La API no devuelve ${name}. ${t}`; };
  const ok = (src, r, x = api) => ({ cats: r.cats, items: r.items, source: src, log: log.join(' · '), server: x === api ? null : x.server });
  try {
    // The API again, past any cache and as POST: some servers answer an empty list from a cache
    // (or while they are still building the catalog, which other apps wait for).
    const viaApi = async (label, opt) => {
      try {
        const cats = await api.categories(type, opt);
        const items = await api.streams(type, null, { timeout: 180000, retries: 0, ...opt });
        log.push(`${label}: ${cats.length} carpetas, ${items.length} ${name}`);
        return items.length ? ok('API', { cats, items }) : null;
      } catch (ex) { log.push(`${label}: ${ex.message}`); return null; }
    };
    step('Pidiendo la mediateca sin caché…');
    let r0 = await viaApi('API sin caché', { bust: true });
    if (r0) return r0;
    step('Pidiendo la mediateca por POST…');
    r0 = await viaApi('API por POST', { post: true });
    if (r0) return r0;

    for (const [t, o] of [['m3u_plus', 'ts'], ['m3u_plus', 'm3u8'], ['m3u', 'ts']]) {
      step(`Leyendo la lista M3U (${t}, ${o}); puede tardar…`);
      try {
        const m = await api.m3u(t, o);
        log.push(`M3U ${t}/${o}: ${fmtSize(m.bytes)}, ${m.live} directo, ${m.vod.items.length} pelis, ${m.series.items.length} series`);
        if (m[type].items.length) return ok('M3U', m[type]);
        if (!m.live && !m.vod.items.length) continue;
        break;   // a valid playlist without this section: other variants won't have it either
      } catch (ex) { log.push(`M3U ${t}/${o}: ${ex.message}`); }
    }

    step('Probando panel_api.php…');
    try {
      const r = await api.panelStreams(type);
      log.push(`panel_api: ${r.total} canales, ${r.items.length} ${name}`);
      if (r.items.length) return ok('panel_api', r);
    } catch (ex) { log.push(`panel_api: ${ex.message}`); }

    // Last: give the server time to prepare the catalog, like other apps that take a while.
    for (const wait of [10, 30, 60]) {
      for (let s = wait; s > 0; s--) {
        step(`El servidor aún no la da; reintento en ${s} s…`);
        await new Promise(r => setTimeout(r, 1000));
      }
      step('Reintentando…');
      r0 = await viaApi(`API tras ${wait} s`, { bust: true });
      if (r0) return r0;
    }

    const alt = api.announcedServer();
    if (alt) {
      step(`Probando el servidor anunciado ${alt}…`);
      const x = api.withServer(alt);
      try {
        const r = await x.fetchType(type);
        log.push(`${alt}: ${r.items.length} ${name}`);
        if (r.items.length) return ok(alt, r, x);
      } catch (ex) { log.push(`${alt}: ${ex.message}`); }
    }
  } finally {
    stop();
  }
  const err = new Error(`Tu servidor no devuelve ${name} a esta app por ninguna vía`);
  err.detail = log.join(' · ');
  throw err;
}

const fmtSize = n => !n ? '0 KB' : n > 1e9 ? (n / 1e9).toFixed(n > 1e10 ? 0 : 1) + ' GB' : n > 1e6 ? Math.round(n / 1e6) + ' MB' : Math.round(n / 1e3) + ' KB';

// Section served by another host (found by discover()): use it for its requests and URLs.
const apiFor = type => data[type]?.server ? (altApis[data[type].server] ||= api.withServer(data[type].server)) : api;
const altApis = {};

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
      stop();
      const found = await discover(type);
      found.ts = Date.now();
      store.cachePut(key, found);
      data[type] = build(found);
      data[type].diag = found.log;
      return data[type];
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
function build(src, partial = null) {
  let { cats, items } = src;
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
  return { items, safeItems, folders, folderById, byId, hasAdult, partial, anyArchive: items.some(i => i.archive > 0), noDate: items.some(i => i.noDate), server: src.server || null };
}

const visItems = d => unlocked ? d.items : d.safeItems;

// Live folders hidden in Ajustes (per account): out of the folder list, «Todo» and the search
// (their channels still play from the agenda and as backups).
let hiddenF = new Set(), hiddenVer = 0, shownCache = null;
function shownItems(d) {
  const vis = visItems(d);
  if (d !== data.live || !hiddenF.size) return vis;
  if (shownCache?.vis !== vis || shownCache.ver !== hiddenVer) {
    shownCache = { vis, ver: hiddenVer, list: vis.filter(it => !it.cats.length || it.cats.some(c => !hiddenF.has(c))) };
  }
  return shownCache.list;
}
const folderShown = (type, f) => type !== 'live' || !hiddenF.has(f.id);

// Favourites in the order chosen (⇅ Ordenar), newest marked last.
const favList = type => [...favs[type].items].map(id => data[type]?.byId.get(id)).filter(it => it && (unlocked || !it.hide));
const folderItems = f => unlocked ? f.items : f.safe;
const folderDate = f => unlocked ? f.date : f.safeDate;
const pending = (d, f) => !!d.partial && !d.partial.loaded.has(f.id) && (unlocked || !f.adult);   // not loaded yet
const folderVisible = (d, f) => folderItems(f).length > 0 || pending(d, f);

// Spanish M+ / DAZN sports channels without repeats, one folder per sport: the newest version
// of each channel, the other Spanish versions as its backups.
let sportCache = null;
function sports() {
  const d = data.live;
  if (!d) return { groups: new Map(), alts: new Map(), all: [] };
  const vis = visItems(d);
  if (sportCache?.vis !== vis || sportCache.n !== d.items.length) {
    const ok = new Set(vis);
    const folderOf = it => it.cats.map(c => d.folderById.get(c)?.name || '').join(' ');
    const r = sportsChannels(d.items, it => ok.has(it), folderOf);
    sportCache = { vis, n: d.items.length, ...r, all: [...r.groups.values()].flat() };
  }
  return sportCache;
}

// Folder rows: the parent, then (when unfolded, or always in the player's list) one per sport.
function sportRows(open) {
  const s = sports();
  if (!s.all.length) return [];
  const rows = [{ id: SPORT, name: `${open ? '▾' : '▸'} M+/DAZN Deportes`, count: s.all.length, virtual: true, extra: 'España · sin repetidos' }];
  if (open) {
    for (const [id, name] of SPORTS) {
      const n = s.groups.get(id).length;
      if (n) rows.push({ id: 'sport:' + id, name, count: n, virtual: true, child: true });
    }
  }
  return rows;
}

function sportList(id) {
  const s = sports();
  if (id === SPORT) return { list: s.all, title: 'M+/DAZN Deportes' };
  const sp = SPORTS.find(x => 'sport:' + x[0] === id);
  return { list: s.groups.get(sp?.[0]) || [], title: sp ? `M+/DAZN · ${sp[1]}` : '' };
}

// ---------------------------------------------------------------- sports agenda

const agenda = new Agenda();
const eventChanCache = new Map();

// Channels of an event, with the live channel that plays each (null when not in the list); playable first.
function eventChannels(e) {
  const items = data.live?.items;
  const tag = (items ? items.length : 0) + (epg?.pub ? 'g' : '') + (epg?.prov ? 'x' : '') + (unlocked ? 'u' : '');
  const hit = eventChanCache.get(e.id);
  if (hit?.tag === tag) return hit.chans;
  const seen = new Set();
  // The guide says where the match really is: those channels first.
  const byGuide = items && e.home ? (epg?.matchAt(e.t, e.home, e.away) || []).map(l => guideChannel(l)).filter(Boolean)
    .map(item => ({ raw: null, name: shortName(item.name), item, guide: true })) : [];
  // Once the guide has found it, a channel of the agenda's whose guide shows something else is a wrong guess.
  const named = e.channels.map(name => ({ raw: name, name: name.replace(/\s*\([^)]*\)/g, ''), item: items ? channelFor(name) : null }))
    .filter(c => !byGuide.length || !c.item || !epg.byName(c.item.name));
  const chans = [...byGuide, ...named]
    .filter(c => !c.item || (!seen.has(c.item.id) && seen.add(c.item.id)));   // "M+ LALIGA" and "M+ LALIGA HDR": one channel here
  chans.sort((a, b) => !!b.item - !!a.item);
  eventChanCache.set(e.id, { tag, chans });
  return chans;
}

// Best live channel for a TV channel name of the agenda: one chosen by hand, else Spanish M+/DAZN
// versions first, then any non-foreign one (trying looser spellings of the name).
function channelFor(name) {
  const d = data.live, s = sports();
  if (aliases[name]) return liveById(aliases[name]) || null;
  const vis = new Set(visItems(d));
  for (const n of channelVariants(name)) {
    const all = findChannels(n, d.items).filter(it => vis.has(it));
    const c = all.find(it => s.alts.has(it.id)) || all.find(it => !isForeign(it.name));
    if (c) return c;
  }
  return null;
}

// Best live channel showing a guide (programme list): Spanish M+/DAZN versions first, then any non-foreign one.
let guideIdx = null;
function guideChannel(list) {
  const d = data.live, s = sports();
  const key = `${d.items.length}${!!epg.prov}${unlocked}`;
  if (guideIdx?.items !== d.items || guideIdx.key !== key) {
    const by = new Map();
    const pref = it => (s.alts.has(it.id) ? 0 : 2) + (/\bsd\b/i.test(it.name) ? 1 : 0);
    for (const it of visItems(d)) {
      if (isForeign(it.name)) continue;
      const l = epg.byName(it.name);
      if (!l) continue;
      const cur = by.get(l);
      if (!cur || pref(it) < pref(cur)) by.set(l, it);
    }
    guideIdx = { items: d.items, key, by };
  }
  return guideIdx.by.get(list) || null;
}

// "┃ES┃ LALIGA TV HYPERMOTION FHD" → "LALIGA TV HYPERMOTION"
const shortName = n => n.replace(/^\s*[┃|]?\s*[A-Z]{2}\s*[┃|:]\s*/, '').replace(/\s+(SD|HD|FHD|UHD|4K|HEVC|1080p?|720p?)\b.*$/i, '').trim() || n;

// Agenda channel names assigned by hand to a live channel (per account).
let aliases = {};
let aliasFor = null;
const saveAliases = () => store.set('alias:' + account, aliases);

function editAlias(name) {
  aliasFor = name;
  $('#aliasTitle').textContent = `¿Qué canal de tu lista es «${name.replace(/\s*\([^)]*\)/g, '')}»?`;
  const cur = aliases[name] && liveById(aliases[name]);
  $('#aliasHint').textContent = cur ? `Ahora: ${cur.name}` : 'No lo he encontrado por el nombre. Búscalo y elígelo; se recordará para toda la agenda.';
  $('#aliasClear').hidden = !aliases[name];
  $('#aliasSearch').value = channelVariants(name).at(-1).split(' ').find(w => w.length > 2 && !/^(m\+|tv)$/i.test(w)) || '';
  aliasResults();
  $('#aliasDialog').showModal();
  $('#aliasSearch').focus();
}

function aliasResults() {
  const q = norm($('#aliasSearch').value.trim());
  const res = q ? visItems(data.live).filter(c => c.key.includes(q)).slice(0, 12) : [];
  $('#aliasResults').innerHTML = res.map(c => `<button type="button" data-pick="${esc(c.id)}">${esc(c.name)}</button>`).join('')
    || `<p class="muted">${q ? 'Ningún canal con ese nombre' : 'Escribe parte del nombre'}</p>`;
}

function setAlias(id) {
  if (id) aliases[aliasFor] = id; else delete aliases[aliasFor];
  saveAliases();
  eventChanCache.clear();
  $('#aliasDialog').close();
  renderFolders();
  refreshItems(false);
  toast(id ? `Asignado: ${liveById(id)?.name}` : 'Asignación quitada', 2500);
}

$('#aliasSearch').addEventListener('input', aliasResults);
$('#aliasSearch').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); $('#aliasResults button')?.focus(); } });
$('#aliasResults').addEventListener('click', e => { const b = e.target.closest('[data-pick]'); if (b) setAlias(b.dataset.pick); });
$('#aliasClear').addEventListener('click', () => setAlias(null));

// By default only what can be played here; «Mostrar todos» adds the rest, dimmed. Never the sports hidden in Ajustes.
const sportShown = e => !settings.hideSports?.includes(e.sport);
const playable = e => eventChannels(e).some(c => c.item);
const agendaEvents = () => agenda.events.filter(e => sportShown(e) && (ui.agendaAll || playable(e)));
const eventName = e => e.home ? `${e.home} – ${e.away}` : e.title;

// ---- favourite teams (all accounts): their matches stand out, «★ Mis equipos», optional recording
let teams = store.get('teams', []);
let teamKeys = new Set(teams.map(norm));
const isTeam = n => !!n && teamKeys.has(norm(n));
const isMine = e => isTeam(e.home) || isTeam(e.away);
function setTeams(list) {
  teams = [...new Set(list)];
  teamKeys = new Set(teams.map(norm));
  store.set('teams', teams);
  eventChanCache.clear();
  if (ui.tab === 'agenda') { renderFolders(); refreshItems(false); }
  if (ui.tab === 'home') renderHome();
  autoRecTeams();
}
function toggleTeam(n) {
  const on = !isTeam(n);
  setTeams(on ? [...teams, n] : teams.filter(t => norm(t) !== norm(n)));
  toast(on ? `Sigues a ${n}: sus partidos salen en ★ Mis equipos y en Inicio` : `Ya no sigues a ${n}`, 3500);
}

// Recording of a match on the Pi (the first playable channel, the others as backups).
const eventRec = e => piRecs.find(r => r.prog === e.t && r.title === eventName(e) && r.state !== 'failed');
function recEvent(e, announce = true) {
  const chans = eventChannels(e).filter(c => c.item);
  if (!chans.length) { toast('Ninguno de sus canales está en tu lista', 3000); return null; }
  const main = chans[0].item, now = Date.now() / 1000;
  const bk = [...new Set([...chans.slice(1).map(c => c.item.id), ...backupIds(main.id)])].filter(id => id !== main.id);
  return saveRec({ ch: main.id, title: eventName(e), prog: e.t, start: Math.max(now, e.t - PAD_START), end: e.end + PAD_END, backups: bk }, announce);
}

// The favourite teams' matches of the next 2 days are scheduled on the Pi when the app sees them
// (once each: deleting one does not bring it back). Never two at once: one connection.
let autoRecBusy = false;
async function autoRecTeams() {
  if (autoRecBusy || !settings.autoRec || !recorder || !teams.length || !data.live || !agenda.events.length) return;
  autoRecBusy = true;
  try {
    const now = Date.now() / 1000, key = 'autoRec:' + account;
    const done = new Set(store.get(key, []));
    for (const e of agenda.events) {
      const k = `${e.t}|${eventName(e)}`;
      if (!isMine(e) || e.end <= now || e.t > now + 2 * DAY || done.has(k) || eventRec(e) || !playable(e)) continue;
      const start = e.t - PAD_START, end = e.end + PAD_END;
      if (piRecs.some(r => (r.state === 'scheduled' || r.state === 'recording') && r.start < end && r.end > start)) continue;
      done.add(k);
      store.set(key, [...done].slice(-200));
      if (await recEvent(e, false)) toast(`Programada la grabación de ${eventName(e)} (${dayLabel(e.t)} ${hhmm(e.t)})`, 5000);
    }
  } finally { autoRecBusy = false; }
}

// ---- reminders («Avisarme cuando empiece»): shown on screen when the app is open at that time
let reminders = [];   // { id, t, title, sub, ch?, ev?: { t, name } }
const saveReminders = () => store.set('remind:' + account, reminders);
const reminderAt = (ch, t) => reminders.find(r => r.ch === ch && r.t === t);
const reminderFor = e => reminders.find(r => r.ev && r.ev.t === e.t && r.ev.name === eventName(e));
function addReminder(r) {
  reminders = reminders.filter(x => !(x.t === r.t && x.title === r.title)).concat({ id: Math.random().toString(36).slice(2), ...r });
  saveReminders();
  remindersChanged();
  toast(`Te avisaré ${dayLabel(r.t)} a las ${hhmm(r.t)} si la app está abierta`, 3500);
}
function removeReminder(id) {
  reminders = reminders.filter(r => r.id !== id);
  saveReminders();
  remindersChanged();
}
function remindersChanged() {
  if (ui.tab === 'agenda' || query) itemList.refresh();
  if (!$('#grid').hidden) grid.refresh();
  if (ui.tab === 'home') renderHome();
}
let remindShown = null, remindTimer;
function checkReminders() {
  const now = Date.now() / 1000;
  const due = reminders.filter(r => r.t - 60 <= now);
  if (!due.length) return;
  reminders = reminders.filter(r => r.t - 60 > now);
  saveReminders();
  remindersChanged();
  const r = due.filter(x => now < x.t + 1800).at(-1);
  if (!r) return;
  remindShown = r;
  $('#remindText').innerHTML = `<b>🔔 Empieza ${now < r.t ? 'ya' : `a las ${hhmm(r.t)}`}</b> ${esc(r.title)}${r.sub ? ` <span class="dim">· ${esc(r.sub)}</span>` : ''}`;
  $('#remind').hidden = false;
  if (!matchMedia('(pointer: coarse)').matches) $('#remindGo').focus();
  clearTimeout(remindTimer);
  remindTimer = setTimeout(hideReminder, 3 * 60e3);
}
function hideReminder() {
  $('#remind').hidden = true;
  remindShown = null;
  if ($('#remind').contains(document.activeElement)) document.activeElement.blur();
}
$('#remindX').addEventListener('click', hideReminder);
$('#remindGo').addEventListener('click', () => {
  const r = remindShown;
  hideReminder();
  if (!r) return;
  const e = r.ev && agenda.events.find(x => x.t === r.ev.t && eventName(x) === r.ev.name);
  if (e) return playEvent(e);
  const ch = r.ch && liveById(r.ch);
  if (!ch) return toast('El canal ya no está en tu lista');
  if (player.isOpen && playerKind === 'live' && player.current?.id === ch.id) return;
  confirmBusy().then(ok => { if (ok) openLive([ch], 0, ch.name, null); });
});
setInterval(checkReminders, 15000);

// ---- options of a match (⋯) and of a later programme in the horizontal guide

// opts: { img (programme picture), titleHtml, prog (guide programme: its synopsis is fetched) }
let menuFns = [], menuSeq = 0;
function showMenu(title, sub, entries, opts = {}) {
  menuFns = entries.map(x => x.fn);
  const seq = ++menuSeq;
  const art = $('#menuArt');
  art.innerHTML = opts.img ? artImg(opts.img, 960, 540, 'menu-img') : opts.artHtml || '';
  art.hidden = !art.innerHTML;
  $('#menuDialog').classList.toggle('sheet', !art.hidden || !!opts.prog);
  if (opts.titleHtml) $('#menuTitle').innerHTML = opts.titleHtml; else $('#menuTitle').textContent = title;
  $('#menuSub').innerHTML = sub;
  $('#menuSub').hidden = !sub;
  $('#menuInfo').hidden = $('#menuDesc').hidden = true;
  if (opts.prog && epg) {
    epg.details(opts.prog).then(({ desc, info }) => {
      if (seq !== menuSeq) return;
      $('#menuInfo').textContent = info;
      $('#menuInfo').hidden = !info;
      $('#menuDesc').textContent = desc;
      $('#menuDesc').hidden = !desc;
    });
  }
  $('#menuList').innerHTML = entries.map((x, i) => `<button type="button" data-m="${i}"${x.main ? ' class="primary"' : ''}>${esc(x.label)}</button>`).join('');
  $('#menuDialog').showModal();
  $('#menuDialog .card').scrollTop = 0;
  $('#menuList button')?.focus();
}
$('#menuList').addEventListener('click', e => {
  const b = e.target.closest('[data-m]');
  if (!b) return;
  $('#menuDialog').close();
  menuFns[+b.dataset.m]?.();
});
$('#menuClose').addEventListener('click', () => $('#menuDialog').close());

// The info sheet of a match: the broadcaster's picture and synopsis (public guide), Watch first.
function eventMenu(e) {
  const now = Date.now() / 1000, chans = eventChannels(e), entries = [];
  chans.forEach((c, i) => { if (c.item) entries.push({ label: `▶ ${e.t > now ? 'Ver' : 'Ver ahora'} en ${c.name}`, main: !entries.length, fn: () => playEvent(e, 'ch:' + i) }); });
  if (recorder && e.end > now && playable(e)) {
    const r = eventRec(e);
    entries.push(r ? { label: '⏺ Grabación programada: cambiar o borrar', fn: () => editRec(r) } : { label: '⏺ Grabar en la Raspberry Pi', fn: () => recEvent(e) });
  }
  if (e.t > now) {
    const r = reminderFor(e);
    entries.push(r ? { label: '🔕 Quitar el aviso', fn: () => removeReminder(r.id) }
      : { label: '🔔 Avisarme cuando empiece', fn: () => addReminder({ t: e.t, title: eventName(e), sub: e.comp, ev: { t: e.t, name: eventName(e) } }) });
  }
  if (e.home) for (const n of [e.home, e.away]) entries.push({ label: isTeam(n) ? `☆ Dejar de seguir a ${n}` : `★ Seguir a ${n}`, fn: () => toggleTeam(n) });
  chans.forEach(c => { if (!c.item && c.raw) entries.push({ label: `Elegir qué canal de tu lista es «${c.name}»`, fn: () => editAlias(c.raw) }); });
  const p = eventProg(e), live = e.t <= now && e.end > now;
  const when = live ? `<b class="ag-live">DIRECTO</b> · empezó a las ${hhmm(e.t)}` : `${esc(dayLabel(e.t))} ${hhmm(e.t)}${e.end <= now ? ' (terminado)' : ''}`;
  const where = chans.map(c => c.item ? esc(c.name) : `<span class="dim">${esc(c.name)}</span>`).join(', ');
  showMenu(eventName(e), `${icon(e.sport)} ${esc(e.comp)}${e.stage ? ` · ${esc(e.stage)}` : ''}<br>${when}${where ? `<br>📺 ${where}` : ''}`, entries, {
    img: p?.img, titleHtml: matchTitle(e, isTeam), prog: p,
    artHtml: e.home ? `<span class="menu-crests">${bigCrests(e)}</span>` : '',
  });
}

function progMenu(ch, p) {
  // On now: watch first; later: record / remind first, the channel's current programme further down
  const now = Date.now() / 1000, on = p.start <= now, entries = [];
  const watch = { label: on ? `▶ Ver ${ch.name}` : `▶ Ver ${ch.name} ahora (lo que echan ya)`, fn: () => confirmBusy().then(ok => { if (ok) openLive([ch], 0, ch.name, null); }) };
  if (on) entries.push(watch);
  if (recorder) {
    const r = recList().find(x => x.ch === ch.id && x.prog === p.start);
    entries.push(r ? { label: '⏺ Grabación programada: cambiar o borrar', fn: () => editRec(r) }
      : { label: '⏺ Grabar en la Raspberry Pi', fn: () => saveRec({ ch: ch.id, title: p.title, prog: p.start, start: Math.max(now, p.start - PAD_START), end: p.end + PAD_END, backups: backupIds(ch.id) }, true).then(() => grid.refresh()) });
  }
  if (!on) {
    const r = reminderAt(ch.id, p.start);
    entries.push(r ? { label: '🔕 Quitar el aviso', fn: () => removeReminder(r.id) }
      : { label: '🔔 Avisarme cuando empiece', fn: () => addReminder({ t: p.start, title: p.title, sub: ch.name, ch: ch.id }) });
    entries.push(watch);
  }
  entries.push({ label: '≡ Guía completa del canal', fn: () => openGuide(ch, p.start) });
  entries[0].main = true;
  showMenu(p.title || 'Sin título', `${esc(ch.name)} · ${esc(dayLabel(p.start))} ${hhmm(p.start)}–${hhmm(p.end)}`, entries, { img: p.img, prog: p });
}

const eventMark = e => ({ fav: isTeam, remind: !!reminderFor(e), rec: !!eventRec(e) });

async function selectAgenda() {
  $('#deadBtn').hidden = true;
  $('#itemsPane').classList.remove('poster');
  if (!agenda.events.length) {
    folderList.set([]);
    itemList.set([]);
    $('#listTitle').textContent = 'Agenda';
    $('#listCount').textContent = '';
    $('#empty').hidden = false;
    $('#emptyText').innerHTML = '<span class="spinner small"></span>Cargando la agenda deportiva…';
    $('#emptyDiag').textContent = '';
    $('#emptyRetry').hidden = true;
  }
  await Promise.all([agenda.load(), ensureData('live').catch(() => {})]);
  autoRecTeams();
  if (ui.tab !== 'agenda') return;
  // The guide finds the channel of matches the agenda names vaguely: redraw once it is in.
  if (epg && !epg.pub) epg.guides().then(() => { eventChanCache.clear(); if (ui.tab === 'agenda') { renderFolders(false); refreshItems(false); } });
  renderFolders(false);
  refreshItems(true);
}

function renderAgendaFolders(keepScroll) {
  folderList.set(agenda.folders(agendaEvents(), { mine: teams.length ? isMine : null, compsOpen: !!ui.compsOpen }), !keepScroll);
}

function agendaFolderRow(f) {
  const active = (ui.folder.agenda || AG_NOW) === f.id && !query;
  const [one, many] = f.unit || ['evento', 'eventos'];
  return `<div class="row${active ? ' active' : ''}${f.child ? ' child' : ''}"><div class="grow"><div class="name">${esc(f.name)}</div>
    <div class="meta">${[`${f.count} ${f.count === 1 ? one : many}`, f.extra].filter(Boolean).join(' · ')}</div></div></div>`;
}

function refreshAgenda(resetScroll) {
  const evs = agendaEvents();
  let id = ui.folder.agenda || AG_NOW;
  if (id !== AG_NOW && !folderList.items.some(f => f.id === id)) id = ui.folder.agenda = AG_NOW;
  const r = agenda.list(evs, id, '', isMine);
  list = r.list;
  $('#listTitle').textContent = r.title;
  $('#listCount').textContent = list.length || '';
  const mine = $('#mineBtn');
  mine.hidden = false;
  const now = Date.now() / 1000, next = agenda.events.filter(e => e.end > now && sportShown(e));
  const hidden = next.length - next.filter(playable).length;
  mine.firstChild.textContent = ui.agendaAll ? 'Ocultar no reproducibles' : 'Mostrar todos';
  mine.title = ui.agendaAll ? 'Ver solo los eventos de canales que están en tu lista' : 'Ver también los eventos de canales que no están en tu lista (atenuados)';
  $('#mineCount').textContent = hidden > 0 ? `${ui.agendaAll ? '−' : '+'}${hidden}` : '';
  $('#items').hidden = false;
  $('#mosaic').hidden = true;
  $('#grid').hidden = true;
  itemList.set(list, resetScroll);
  if (resetScroll) {
    // A day: start at what is on now
    const now = Date.now() / 1000;
    const i = Math.max(0, list.findIndex(e => e.end > now));
    itemList.el.scrollTop = i * itemList.rowH;
    itemList.cursor = i;
    remote.reset();
    itemList.cursor = i;
  }
  const when = agenda.updated ? new Date(agenda.updated * 1000).toLocaleString('es-ES', { weekday: 'long', hour: '2-digit', minute: '2-digit' }) : '';
  $('#empty').hidden = !!list.length;
  $('#emptyText').textContent = agenda.error ? `No se pudo cargar la agenda: ${agenda.error}`
    : id === AG_MINE ? 'Tus equipos no tienen partidos próximos en la agenda'
    : !agenda.events.length ? 'La agenda está vacía' : ui.agendaAll ? 'No hay eventos' : 'No hay eventos en los canales de tu lista. Pulsa «Mostrar todos» para verlos todos.';
  $('#emptyDiag').textContent = when ? `Agenda de futbolenlatv.es, actualizada el ${when}` : '';
  $('#emptyRetry').hidden = !agenda.error;
  retryAction = reload;
}

function playEvent(e, act) {
  if (act?.startsWith('as:')) return editAlias(eventChannels(e)[+act.slice(3)].raw);
  const chans = eventChannels(e).filter(c => c.item);
  const n = act?.startsWith('ch:') ? +act.slice(3) : 0;
  const c = eventChannels(e)[n]?.item ? eventChannels(e)[n] : chans[0];
  if (!c) return toast('Ninguno de sus canales está en tu lista', 3000);
  // The queue: every playable channel of the event (Up / Down switches between them)
  const items = chans.map(x => x.item);
  confirmBusy().then(ok => { if (ok) openLive(items, Math.max(0, items.indexOf(c.item)), eventName(e), null); });
}

// ---------------------------------------------------------------- home page
// Rows of cards: continue watching, favourite channels with what is on, the favourite teams'
// matches, matches on now / today, recordings, reminders. Remote: the cards move like the mosaic.

let hist = [];   // last things watched: { k: 'live' | 'rec', id, t, pos? (s, recordings) }
function remember(k, id, pos) {
  const old = hist.find(h => h.k === k && h.id === id);
  hist = [{ k, id, t: Date.now() / 1000, ...(pos != null ? { pos } : old?.pos != null ? { pos: old.pos } : {}) }, ...hist.filter(h => h !== old)].slice(0, 20);
  store.set('hist:' + account, hist);
}

let homeActs = [];
async function selectHome() {
  folderList.set([]);
  itemList.set([]);
  list = [];
  $('#listTitle').textContent = '';
  $('#listCount').textContent = '';
  renderHome();
  await Promise.all([ensureData('live').catch(() => {}), agenda.load()]);
  if (ui.tab !== 'home') return;
  autoRecTeams();
  renderHome();
  if (settings.epg && epg) {
    homeWantEpg();
    if (!epg.pub) epg.guides().then(() => { eventChanCache.clear(); if (ui.tab === 'home') renderHome(); });
  }
}

function homeWantEpg() {
  const ids = [...favList('live'), ...hist.filter(h => h.k === 'live').map(h => liveById(h.id)).filter(Boolean)].slice(0, 60).map(i => i.id);
  if (ids.length) epg?.want(ids);
}

let homeTimer;
function scheduleHome() {
  if (homeTimer || $('#home').hidden) return;
  homeTimer = setTimeout(() => { homeTimer = 0; if (!$('#home').hidden) renderHome(); }, 1200);
}

const logoHtml = it => `<span class="logo">${initials(it.name)}${it.icon ? `<img src="${esc(it.icon)}" alt="" loading="lazy" onerror="this.remove()">` : ''}</span>`;

// Picture of a programme (public guide), resized: see artUrl in epg.js.
const artImg = (src, w, h, cls = 'hc-img') => src ? `<img class="${cls}" src="${esc(artUrl(src, w, h))}" alt="" loading="lazy" onerror="this.remove()">` : '';

// The guide's programme of a match (it carries the broadcaster's picture), or null.
function eventProg(e) {
  if (!e.home || !epg?.pub) return null;
  for (const l of epg.matchAt(e.t, e.home, e.away)) {
    const p = l.find(x => Math.abs(x.start - e.t) <= MATCH_EARLY);
    if (p) return p;
  }
  return null;
}

// Picture of a recording: its programme in the channel's guide.
function recProg(r) {
  const ch = [r.ch, ...(r.backups || [])].map(liveById).find(Boolean), l = ch && epg?.byName(ch.name || r.chName);
  const mid = (r.prog || r.start) + 600;   // a match recording: r.prog is the match's start, not the programme's
  return l?.find(p => p.start === r.prog) || l?.find(p => p.start <= mid && p.end > mid) || null;
}

const bigCrests = e => `<span class="hc-vs">${crest(e.hi)}<b>–</b>${crest(e.ai)}</span>`;

function chanCard(it, key, act, label = '') {
  const e = settings.epg && epg?.get(it.id);
  return card(key, act, 'ch', `<span class="hc-art${e?.now?.img ? '' : ' noimg'}">${artImg(e?.now?.img, 480, 270)}${logoHtml(it)}</span><span class="hc-body">
      ${label ? `<span class="hc-tag">${esc(label)}</span>` : ''}
      <span class="hc-name">${esc(it.name)}</span>
      ${e?.now ? `<span class="hc-sub"><b>${hhmm(e.now.start)}</b> ${esc(e.now.title)}</span><span class="bar"><i style="width:${Math.round(e.progress * 100)}%"></i></span>` : '<span class="hc-sub dim">En directo</span>'}
    </span>`);
}

function eventCard(e, key) {
  const now = Date.now() / 1000, live = e.t <= now && e.end > now;
  const ch = eventChannels(e).find(c => c.item);
  const img = eventProg(e)?.img;
  return card(key, () => eventMenu(e), 'ev' + (live ? ' live' : ''), `<span class="hc-art${img ? '' : ' plain'}">${img ? artImg(img, 480, 270) : e.home ? bigCrests(e) : `<span class="hc-sport">${icon(e.sport)}</span>`}</span><span class="hc-body">
      <span class="hc-tag">${live ? '<b class="ag-live">DIRECTO</b>' : `${esc(dayLabel(e.t)[0].toUpperCase() + dayLabel(e.t).slice(1))} ${hhmmOf(e.t)}`}${reminderFor(e) ? ' 🔔' : ''}${eventRec(e) ? ' ⏺' : ''} · ${esc(e.comp)}</span>
      <span class="hc-match">${matchTitle(e, isTeam)}</span>
      <span class="hc-sub">${ch ? `▶ ${esc(ch.name)}` : '<span class="dim">No está en tu lista</span>'}</span>
      ${live ? `<span class="bar"><i style="width:${Math.round(elapsed(e) * 100)}%"></i></span>` : ''}
    </span>`);
}

function recCard(r, key, pos) {
  const dur = r.duration || 0, img = recProg(r)?.img;
  return card(key, () => recMenu(r, pos), 'rec' + (r.state === 'recording' ? ' on-air' : ''), `<span class="hc-art${img ? '' : ' plain'}">${img ? artImg(img, 480, 270) : '<span class="hc-sport">⏺</span>'}</span><span class="hc-body">
      <span class="hc-tag">${r.state === 'recording' ? '● Grabando' : '⏺ Grabación'}${pos ? ` · seguir en ${fmtClock(pos)}` : ''}${r.gaps?.length ? ` · <span class="cuts">⚠ ${r.gaps.length === 1 ? '1 corte' : `${r.gaps.length} cortes`}</span>` : ''}</span>
      <span class="hc-name">${esc(r.title || 'Sin título')}</span>
      <span class="hc-sub dim">${esc(piStatus(r))}</span>
      ${pos && dur ? `<span class="bar"><i style="width:${Math.round(Math.min(1, pos / dur) * 100)}%"></i></span>` : ''}
    </span>`);
}

// ---- hero: a big picture of what is worth watching now (live matches, the favourite teams'
// first; then what the favourite channels show), rotating every few seconds.
let heroList = [], heroAt = 0;

function heroItems() {
  const now = Date.now() / 1000, out = [], d = data.live;
  const add = x => { if (x?.img && !out.some(o => o.key === x.key || o.img === x.img)) out.push(x); };   // one card per programme
  const live = agenda.events.filter(e => e.t <= now && e.end > now && sportShown(e) && playable(e)).sort((a, b) => isMine(b) - isMine(a));
  const soon = agenda.events.filter(e => e.t > now && e.t < now + 3 * 3600 && isMine(e) && playable(e));
  for (const e of [...live, ...soon]) {
    const p = eventProg(e), ch = eventChannels(e).find(c => c.item);
    add(p && {
      key: 'ev:' + e.id, img: p.img, act: () => playEvent(e),
      tag: e.t <= now ? `<b class="ag-live">DIRECTO</b> ${esc(e.comp)}` : `${isTeam(e.home) || isTeam(e.away) ? '★ ' : ''}Hoy ${hhmmOf(e.t)} · ${esc(e.comp)}`,
      title: matchTitle(e, isTeam), sub: ch ? `▶ ${esc(ch.name)}` : '', progress: e.t <= now ? elapsed(e) : null,
    });
  }
  if (d) {
    const favItems = favList('live');
    favItems.forEach((it, i) => {
      const e = settings.epg && epg?.get(it.id);
      if (!e?.now) return;
      add({
        key: 'ch:' + it.id, img: e.now.img, act: () => confirmBusy().then(ok => { if (ok) openLive(favItems, i, 'Favoritos', FAV); }),
        tag: `<b class="ag-live">DIRECTO</b> ${esc(it.name)}`, title: esc(e.now.title),
        sub: `${hhmm(e.now.start)}–${hhmm(e.now.end)}${e.next ? ` · Después: ${esc(e.next.title)}` : ''}`, progress: e.progress,
      });
    });
  }
  return out.slice(0, 6);
}

function heroInner(h) {
  return `${artImg(h.img, 1280, 720, 'hero-img')}<span class="hero-shade"></span>
    <span class="hero-txt"><span class="hero-tag">${h.tag}</span><span class="hero-title">${h.title}</span>
      ${h.sub ? `<span class="hero-sub">${h.sub}</span>` : ''}
      ${h.progress != null ? `<span class="bar"><i style="width:${Math.round(h.progress * 100)}%"></i></span>` : ''}
      <span class="hero-go">▶ Ver ahora</span></span>
    ${heroList.length > 1 ? `<span class="hero-nav prev" data-hn="-1" aria-label="Anterior">‹</span><span class="hero-nav next" data-hn="1" aria-label="Siguiente">›</span>
      <span class="hero-dots">${heroList.map((_, i) => `<i class="${i === heroAt ? 'on' : ''}" data-hi="${i}"></i>`).join('')}</span>` : ''}`;
}

// Show another picture of the hero (‹ ›, the dots, a swipe, Left / Right on the remote); the
// rotation waits a while after that.
let heroHeld = 0;
function heroShow(i) {
  const b = $('#home .hcard.hero');
  if (!b || heroList.length < 2) return false;
  heroAt = (i + heroList.length) % heroList.length;
  b.innerHTML = heroInner(heroList[heroAt]);
  heroHeld = Date.now();
  const n = heroList[(heroAt + 1) % heroList.length];
  if (n) new Image().src = artUrl(n.img, 1280, 720);
  return true;
}
const heroStep = d => heroShow(heroAt + d);

function heroHtml() {
  const prev = heroList[heroAt]?.key;
  heroList = heroItems();
  heroAt = Math.max(0, heroList.findIndex(h => h.key === prev));
  const h = heroList[heroAt];
  if (!h) return '';
  return `<section class="h-hero">${card('hero', () => heroList[heroAt]?.act(), 'hero', heroInner(h))}</section>`;
}

setInterval(() => {
  const b = $('#home .hcard.hero');
  if (!b || $('#home').hidden || document.hidden || player.isOpen || heroList.length < 2 || b.classList.contains('kfocus') || b.matches(':hover') || Date.now() - heroHeld < 20000) return;
  heroShow(heroAt + 1);
  heroHeld = 0;
}, 9000);

const fmtClock = s => { s = Math.floor(s); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60; return h ? `${h}:${String(m).padStart(2, '0')} h` : `${m} min`; };

function card(key, act, cls, html) {
  homeActs.push(act);
  const pic = html.startsWith('<span class="hc-art') ? ' pic' : '';
  return `<button class="hcard ${cls}${pic}" data-h="${homeActs.length - 1}" data-key="${esc(key)}">${html}</button>`;
}

function renderHome() {
  const el = $('#home');
  if (ui.tab !== 'home') return;
  // Keep the remote's card and each row's scroll across redraws
  const focusKey = el.querySelector('.hcard.kfocus')?.dataset.key;
  const scrolls = Object.fromEntries([...el.querySelectorAll('.h-row')].map(r => [r.dataset.sec, r.scrollLeft]));
  homeActs = [];
  const now = Date.now() / 1000, d = data.live, secs = [];
  const sec = (id, title, cards, more = null) => {
    if (!cards.length) return;
    if (more) cards.push(card('more:' + id, more.fn, 'more', `<span class="hc-body"><span class="hc-name">${esc(more.label)} ›</span></span>`));
    secs.push(`<section class="h-sec"><h3>${esc(title)}</h3><div class="h-row" data-sec="${id}">${cards.join('')}</div></section>`);
  };

  if (!d && !agenda.events.length) {
    el.innerHTML = '<div class="empty-note"><span class="spinner small"></span>Cargando…</div>';
    return;
  }
  const hero = heroHtml();
  if (hero) secs.push(hero);
  // Continue watching
  const cont = [];
  for (const h of hist) {
    if (h.k === 'live') {
      const it = d && liveById(h.id);
      if (it) cont.push(chanCard(it, 'h:' + h.id, () => confirmBusy().then(ok => { if (ok) openLive([it], 0, it.name, null); }), `Visto ${ago(h.t)}`));
    } else if (h.k === 'rec') {
      const r = piRecs.find(x => x.id === h.id);
      if (r && (r.duration > 0 || r.state === 'recording')) cont.push(recCard(r, 'hr:' + h.id, h.pos));
    }
    if (cont.length >= 10) break;
  }
  sec('cont', 'Seguir viendo', cont);

  // Favourite channels
  if (d) {
    const favItems = favList('live');
    sec('fav', '★ Tus canales favoritos', favItems.length
      ? favItems.slice(0, 30).map((it, i) => chanCard(it, 'f:' + it.id, () => confirmBusy().then(ok => { if (ok) openLive(favItems, i, 'Favoritos', FAV); })))
      : [card('fav-hint', () => selectTab('live'), 'hint', '<span class="hc-body"><span class="hc-name">Aún no tienes favoritos</span><span class="hc-sub dim">Pulsa ★ en un canal de Directo para tenerlo aquí</span></span>')]);
  }

  // Matches
  const upcoming = agenda.events.filter(e => e.end > now && sportShown(e));
  const mine = teams.length ? upcoming.filter(isMine).slice(0, 12) : [];
  if (teams.length) {
    sec('teams', '★ Tus equipos', mine.length ? mine.map(e => eventCard(e, 'te:' + e.id))
      : [card('teams-none', () => editTeams(), 'hint', `<span class="hc-body"><span class="hc-name">Sin partidos próximos</span><span class="hc-sub dim">${esc(teams.slice(0, 3).join(', '))}${teams.length > 3 ? '…' : ''}</span></span>`)],
    { label: 'Elegir equipos', fn: () => editTeams() });
  }
  const shown = new Set(mine);
  const endOfDay = new Date().setHours(23, 59, 59, 999) / 1000;
  const today = upcoming.filter(e => !shown.has(e) && e.t < endOfDay && playable(e)).slice(0, 15);
  sec('today', 'Partidos de hoy', today.map(e => eventCard(e, 'ev:' + e.id)), { label: 'Ver la agenda', fn: () => selectTab('agenda') });
  if (!teams.length && agenda.events.length) {
    sec('teams', '★ Tus equipos', [card('teams-hint', () => editTeams(), 'hint', '<span class="hc-body"><span class="hc-name">Sigue a tus equipos</span><span class="hc-sub dim">Sus partidos saldrán aquí primero (y se pueden grabar solos). Pulsa para elegirlos.</span></span>')]);
  }

  // Recordings
  if (recorder) {
    const rs = sortedRecs().slice(0, 12);
    sec('recs', '⏺ Grabaciones', rs.map(r => recCard(r, 'r:' + r.id, hist.find(h => h.k === 'rec' && h.id === r.id)?.pos)), { label: 'Todas las grabaciones', fn: () => { ui.folder.live = REC; selectTab('live'); } });
  }

  // Reminders
  const rem = reminders.filter(r => r.t > now - 1800).sort((a, b) => a.t - b.t);
  sec('remind', '🔔 Avisos', rem.map(r => card('rm:' + r.id, () => showMenu(r.title, `${esc(r.sub || '')} · ${esc(dayLabel(r.t))} ${hhmm(r.t)}`, [{ label: '🔕 Quitar el aviso', fn: () => removeReminder(r.id) }]), 'rem',
    `<span class="hc-body"><span class="hc-tag">${esc(dayLabel(r.t))} ${hhmm(r.t)}</span><span class="hc-name">${esc(r.title)}</span><span class="hc-sub dim">${esc(r.sub || '')}</span></span>`)));

  el.innerHTML = secs.join('') || '<div class="empty-note">Nada que mostrar todavía.</div>';
  for (const r of el.querySelectorAll('.h-row')) if (scrolls[r.dataset.sec]) r.scrollLeft = scrolls[r.dataset.sec];
  if (focusKey) el.querySelector(`.hcard[data-key="${CSS.escape(focusKey)}"]`)?.classList.add('kfocus');
}

$('#home').addEventListener('click', e => {
  const nav = e.target.closest('[data-hn], [data-hi]');
  if (nav) return nav.dataset.hn ? heroStep(+nav.dataset.hn) : heroShow(+nav.dataset.hi);
  const c = e.target.closest('.hcard');
  if (c) homeActs[+c.dataset.h]?.();
});
// Swiping the hero sideways (phone, Tesla screen)
let heroTouch = null;
$('#home').addEventListener('touchstart', e => {
  heroTouch = e.touches.length === 1 && e.target.closest('.hcard.hero') ? { x: e.touches[0].clientX, y: e.touches[0].clientY } : null;
}, { passive: true });
$('#home').addEventListener('touchend', e => {
  if (!heroTouch) return;
  const t = e.changedTouches[0], dx = t.clientX - heroTouch.x, dy = t.clientY - heroTouch.y;
  heroTouch = null;
  if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.5) { e.preventDefault(); heroStep(dx < 0 ? 1 : -1); }
});
setInterval(() => { if (!$('#home').hidden) renderHome(); }, 60000);

// ---------------------------------------------------------------- tabs & folders

async function selectTab(type) {
  if ((type === 'vod' || type === 'series') && !settings.vod) type = 'home';
  ui.tab = type;
  saveUi();
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.tab === type);
  closeSeries();
  mosaic.hide();
  mosaic.source = null;
  sorting = false;
  layout();
  $('#mosaicBtn').hidden = type !== 'live';
  $('#gridBtn').hidden = type !== 'live';
  if (type !== 'live') $('#grid').hidden = true;
  $('#mineBtn').hidden = type !== 'agenda';
  $('#sortBtn').hidden = true;
  if (type === 'home') return selectHome();
  if (type === 'agenda') return selectAgenda();
  if (!data[type]) {
    folderList.set([]);
    itemList.set([]);
    $('#mosaic').hidden = true;
    $('#grid').hidden = true;
    $('#items').hidden = false;
    $('#listTitle').textContent = '';
    $('#listCount').textContent = '';
  }
  await ensureData(type);
  if (ui.tab !== type) return;
  renderFolders(false);
  const d = data[type];
  let f = ui.folder[type] || ALL;
  if (f !== FAV && f !== ALL && f !== REC && !isSport(f) && !(d.folderById.has(f) && folderVisible(d, d.folderById.get(f)))) f = ALL;
  ui.folder[type] = f;
  refreshItems(true);
}

function renderFolders(keepScroll = true) {
  if (ui.tab === 'agenda') return renderAgendaFolders(keepScroll);
  const d = data[ui.tab];
  if (!d) return;
  const fc = favs[ui.tab].cats;
  const all = shownItems(d);
  const favItems = favList(ui.tab);
  // Partial catalog: dates are unknown until the full list arrives, keep the server order.
  const folders = d.folders.filter(f => folderVisible(d, f) && folderShown(ui.tab, f));
  if (!d.partial) folders.sort((a, b) => folderDate(b) - folderDate(a));
  const rows = [
    { id: FAV, name: '★ Favoritos', count: favItems.length, date: Math.max(0, ...favItems.map(i => i.added || 0)), virtual: true },
    { id: ALL, name: 'Todo', count: all.length, date: all[0]?.added, virtual: true },
    ...(ui.tab === 'live' && (recorder || d.anyArchive || recs.length) ? [{ id: REC, name: '⏺ Grabaciones', count: recList().length, virtual: true,
      extra: recorder?.disk?.total ? `${fmtSize(recorder.disk.free)} libres` : '' }] : []),
    ...(ui.tab === 'live' ? sportRows(!!ui.sportsOpen) : []),
    ...folders.filter(f => fc.has(f.id)),
    ...folders.filter(f => !fc.has(f.id)),
  ];
  if (d.hasAdult) rows.push({ lock: true, name: unlocked ? '🔓 Ocultar contenido adulto' : '🔒 Contenido adulto' });
  folderList.set(rows, !keepScroll);
}

function renderFolderRow(f) {
  if (ui.tab === 'agenda') return agendaFolderRow(f);
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
    : [count + (count === 1 ? ' elemento' : ' elementos'), !data[ui.tab].noDate && ago(date), f.extra].filter(Boolean).join(' · ');
  return `<div class="row${active ? ' active' : ''}${f.child ? ' child' : ''}">
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
  if (ui.tab === 'agenda' && f.id === AG_COMPS) {
    ui.compsOpen = !ui.compsOpen;
    saveUi();
    renderFolders();
    return;
  }
  if (f.id === SPORT) {
    // Unfold / fold the sports; opening it also lists every channel of them
    ui.sportsOpen = !(ui.sportsOpen && ui.folder[ui.tab] === SPORT);
    renderFolders();
  }
  data[ui.tab]?.partial?.errors.delete(f.id);
  ui.folder[ui.tab] = f.id;
  saveUi();
  closeSeries();
  folderList.refresh();
  refreshItems(true);
  document.body.classList.add('show-items');
}

// ---------------------------------------------------------------- items

// Home page, or the panes (folders + list); the search always shows its results in the panes.
function layout() {
  const home = ui.tab === 'home' && !query;
  $('#home').hidden = !home;
  $('.panes').hidden = home;
  document.body.classList.toggle('no-folders', ui.tab === 'home');
}

// Buttons of the list header that depend on the tab / folder.
function paneButtons() {
  const t = ui.tab, live = t === 'live' && !query;
  $('#mosaicBtn').hidden = !live;
  $('#gridBtn').hidden = !live;
  $('#mineBtn').hidden = t !== 'agenda' || !!query;
  const fav = !query && t in TYPES && (ui.folder[t] || ALL) === FAV && list.length > 1;
  if (!fav) sorting = false;
  $('#sortBtn').hidden = !fav;
  $('#sortBtn').classList.toggle('on', sorting);
  $('#sortBtn').textContent = sorting ? '✓ Hecho' : '⇅ Ordenar';
}

function refreshItems(resetScroll) {
  layout();
  if (query) return refreshSearch(resetScroll);
  if (ui.tab === 'home') return;
  if (ui.tab === 'agenda') return refreshAgenda(resetScroll);
  const d = data[ui.tab];
  if (!d) return;
  const id = ui.folder[ui.tab] || ALL;
  const all = shownItems(d);
  let title;
  if (id === FAV) {
    list = favList(ui.tab);
    title = 'Favoritos';
  } else if (id === ALL) {
    list = all;
    title = 'Todo';
  } else if (isSport(id) && ui.tab === 'live') {
    ({ list, title } = sportList(id));
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
  paneButtons();

  const views = ui.tab === 'live' && !series && id !== REC;
  const useGrid = gridOn && views;
  const useMosaic = mosaicOn && views && !useGrid;
  $('#mosaicBtn').classList.toggle('on', useMosaic);
  $('#gridBtn').classList.toggle('on', useGrid);
  $('#deadBtn').hidden = !useMosaic;
  $('#items').hidden = useMosaic || useGrid || !!series;
  $('#mosaic').hidden = !useMosaic;
  $('#grid').hidden = !useGrid;
  if (useGrid) {
    mosaic.hide();
    mosaic.source = null;
    itemList.set(list, resetScroll);
    grid.show(groupVersions(list.filter(it => !it.prog)));
    if (!epg?.pub && settings.epg) epg?.guides().then(() => grid.refresh());
  } else if (useMosaic) {
    if (mosaic.source !== list) { mosaic.source = list; mosaic.show(list); }
  } else {
    mosaic.hide();
    mosaic.source = null;
    itemList.set(list, resetScroll);
  }
  if (resetScroll) remote.reset();

  // Empty pane: why, plus a retry when it makes sense.
  const p = d.partial;
  const f = d.folderById.get(id);
  let text, diag = '';
  retryAction = reload;
  if (d.error) {
    text = `No se pudo cargar la lista: ${d.error}`;
    diag = d.diag;
  } else if (id === REC) {
    text = recorder ? 'Aún no hay grabaciones. Toca ≡ en un canal para abrir su guía y pulsa ⏺ en un programa (o «Programar a mano»).'
      : 'Las grabaciones de la Raspberry Pi solo se ven abriendo la app desde su dirección (la que termina en :8090) en la red de casa.';
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

// ---------------------------------------------------------------- search (everything at once)

const expanded = new Set();   // result sections shown in full («Ver los N…»)
const SEARCH_MAX = { live: 30, ev: 15, prog: 30, rec: 20, vod: 30, series: 30 };

function refreshSearch(resetScroll) {
  const q = norm(query), now = Date.now() / 1000, out = [];
  const add = (kind, name, rows) => {
    if (!rows.length) return;
    const max = expanded.has(kind) ? Infinity : SEARCH_MAX[kind];
    out.push({ sec: true, id: 'sec:' + kind, name, count: rows.length }, ...rows.slice(0, max));
    if (rows.length > max) out.push({ more: kind, id: 'more:' + kind, name: `Ver los ${rows.length} resultados de «${name}»` });
  };
  const d = data.live;
  if (d) add('live', 'Canales', shownItems(d).filter(i => i.key.includes(q)).map(it => ({ ...it, _k: 'live' })));
  if (!agenda.events.length && !agenda.error) agenda.load().then(() => { if (query && norm(query) === q) refreshItems(false); });
  add('ev', 'Partidos y eventos', agenda.events.filter(e => e.end > now && e.key.includes(q) && sportShown(e))
    .sort((a, b) => !!eventChannels(b).some(c => c.item) - !!eventChannels(a).some(c => c.item) || a.t - b.t));
  // Programmes with that title in the guide (on now or later).
  if (d && settings.epg && epg) {
    if (!epg.pub) epg.guides().then(() => { if (query && norm(query) === q) refreshItems(false); });
    add('prog', 'Programas en la guía', epg.search(q, shownItems(d), norm).map(({ item, prog }) => ({ ...item, prog, base: item, _k: 'live' })));
  }
  add('rec', 'Grabaciones', sortedRecs().filter(r => norm(r.title || '').includes(q)));
  for (const t of ['vod', 'series']) {
    if (settings.vod && data[t]) add(t, TYPES[t], visItems(data[t]).filter(i => i.key.includes(q)).map(it => ({ ...it, _k: t })));
  }
  list = out;
  closeSeries();
  paneButtons();
  $('#listTitle').textContent = `“${query}”`;
  $('#listCount').textContent = out.filter(x => !x.sec && !x.more).length || '';
  $('#itemsPane').classList.remove('poster');
  $('#deadBtn').hidden = true;
  $('#items').hidden = false;
  $('#mosaic').hidden = true;
  $('#grid').hidden = true;
  mosaic.hide();
  mosaic.source = null;
  itemList.set(list, resetScroll);
  if (resetScroll) remote.reset();
  $('#empty').hidden = !!list.length;
  $('#emptyText').textContent = 'Sin resultados';
  $('#emptyDiag').textContent = '';
  $('#emptyRetry').hidden = true;
}

// Recent searches: shown under the empty search box.
let recentQ = store.get('recentQ', []);
function pushRecent(q) {
  q = q.trim();
  if (q.length < 2) return;
  recentQ = [q, ...recentQ.filter(x => norm(x) !== norm(q))].slice(0, 8);
  store.set('recentQ', recentQ);
}
function showRecent() {
  const el = $('#recentQ'), box = $('#search');
  const show = (document.activeElement === box || el.contains(document.activeElement)) && !box.value && recentQ.length > 0;
  el.hidden = !show;
  if (show) el.innerHTML = '<div class="rq-title">Búsquedas recientes</div>' + recentQ.map((q, i) => `<button type="button" data-q="${i}">🕘 ${esc(q)}</button>`).join('');
}

function folderName(it, tab = ui.tab) {
  for (const c of it.cats) {
    const f = data[tab]?.folderById.get(c);
    if (f) return f.name;
  }
  return '';
}

function epgNow(it) {
  return settings.epg && epg ? epg.get(it.id)?.now : null;
}

// A programme found by the search: its title, the channel and when.
function renderProgRow(it) {
  const p = it.prog, now = Date.now() / 1000, on = p.start <= now;
  const when = on ? `<b class="live-tag">EN DIRECTO</b> hasta ${hhmm(p.end)}` : `${esc(dayLabel(p.start))} ${hhmm(p.start)}–${hhmm(p.end)}`;
  return `<div class="row prog${on ? ' on' : ''}">
    <div class="logo">${initials(it.name)}${it.icon ? `<img src="${esc(it.icon)}" alt="" loading="lazy" onerror="this.remove()">` : ''}</div>
    <div class="grow"><div class="name">${esc(p.title)}</div>
      <div class="meta">🗓 ${when} · ${esc(it.name)}</div>
      ${on ? `<div class="bar"><i style="width:${Math.round((now - p.start) / (p.end - p.start) * 100)}%"></i></div>` : ''}</div>
    <button class="star gbtn" data-act="guide" aria-label="Guía">≡</button>
  </div>`;
}

function renderItemRow(it) {
  if (it.sec) return `<div class="row sec"><span class="name">${esc(it.name)}</span><span class="muted">${it.count}</span></div>`;
  if (it.more) return `<div class="row more"><span class="name">＋ ${esc(it.name)}</span></div>`;
  if (it.rec) return renderRecRow(it);
  if (it.prog) return renderProgRow(it);
  if (it.ev) return eventRow(it, eventChannels(it), !String(ui.folder.agenda || '').startsWith(AG_DAY) || !!query, eventMark(it));
  const k = it._k || ui.tab;
  const showFolder = query || (ui.folder[ui.tab] || ALL) === FAV || ui.folder[ui.tab] === ALL;
  const meta = [!it.versions && showFolder && folderName(it, k), !it.noDate && ago(it.added), it.rating && `★ ${it.rating}`].filter(Boolean).map(esc).join(' · ');
  let sub = `<div class="meta">${meta}</div>`;
  // Football list: shortcuts to the original channels, always say which folder each one is in.
  const from = it.versions ? ` <span class="from">· 📁 ${esc(folderName(it))}${it.versions > 1 ? ` · ${it.versions} versiones` : ''}</span>` : '';
  if (k === 'live') {
    const e = settings.epg && epg?.get(it.id);
    if (e?.now) {
      sub = `<div class="meta epg"><b>${hhmm(e.now.start)}</b> ${esc(e.now.title)}${e.next ? `<span class="dim"> · ${hhmm(e.next.start)} ${esc(e.next.title)}</span>` : ''}</div>
        <div class="bar"><i style="width:${Math.round(e.progress * 100)}%"></i></div>`;
    }
  }
  return `<div class="row">
    <div class="logo">${initials(it.name)}${it.icon ? `<img src="${esc(it.icon)}" alt="" loading="lazy" onerror="this.remove()">` : ''}</div>
    <div class="grow"><div class="name">${esc(it.name)}${from}</div>${sub}</div>
    ${!it.noDate && isNew(it.added) && !sorting ? '<span class="badge">Nuevo</span>' : ''}
    ${k === 'live' && it.archive ? `<span class="badge arch" title="Archivo de ${it.archive} días">⏪ ${it.archive} d</span>` : ''}
    ${sorting ? '<button class="star gbtn" data-act="up" aria-label="Subir">▲</button><button class="star gbtn" data-act="down" aria-label="Bajar">▼</button>'
      : `${k === 'live' ? '<button class="star gbtn" data-act="guide" aria-label="Guía">≡</button>' : ''}
    <button class="star${favs[k].items.has(it.id) ? ' on' : ''}" data-act="fav" aria-label="Favorito">★</button>`}
  </div>`;
}

// ⇅ Ordenar (favourites): ▲ / ▼ move a favourite one place.
let sorting = false;
function moveFav(it, d) {
  const t = ui.tab, arr = favList(t).map(x => x.id);
  const i = arr.indexOf(it.id), j = i + d;
  if (i < 0 || j < 0 || j >= arr.length) return;
  [arr[i], arr[j]] = [arr[j], arr[i]];
  // Hidden ones (adult, locked) keep their place at the end
  favs[t].items = new Set([...arr, ...[...favs[t].items].filter(id => !arr.includes(id))]);
  saveFavs();
  refreshItems(false);
  itemList.setCursor(j, !!itemList.showCursor);
}

$('#sortBtn').addEventListener('click', () => { sorting = !sorting; refreshItems(false); });

function onItemClick(it, i, act) {
  if (it.sec) return;
  if (it.more) { expanded.add(it.more); return refreshItems(false); }
  if (query) pushRecent(query);
  if (it.rec) return act ? onRecClick(it, act) : recMenu(it);
  if (it.ev) return !act || act === 'menu' ? eventMenu(it) : playEvent(it, act);
  // A programme from the search: on now → watch its channel; later → its guide (to record it).
  if (it.prog) {
    if (act === 'guide') return openGuide(it.base, it.prog.start);
    return progMenu(it.base, it.prog);
  }
  if (act === 'guide') return openGuide(it);
  if (act === 'up' || act === 'down') return moveFav(it, act === 'up' ? -1 : 1);
  const k = it._k || ui.tab;
  if (act === 'fav') {
    toggle(favs[k].items, it.id);
    if ((ui.folder[ui.tab] || ALL) === FAV && !query) refreshItems(false);
    else itemList.updateRow(i);
    renderFolders();
    return;
  }
  if (k === 'series') return openSeries(it);
  // The queue: the results of the same kind (the search mixes channels, matches, programmes…)
  const items = list.filter(x => (x._k || ui.tab) === k && !x.sec && !x.more && !x.prog && !x.ev && !x.rec);
  const at = Math.max(0, items.indexOf(it)), title = $('#listTitle').textContent;
  confirmBusy().then(ok => {
    if (!ok) return;
    if (k === 'live') return openLive(items, at, title, query ? null : ui.folder.live);
    playerKind = k;
    player.open(items, at, resolveVod, favCtl(k));
  });
}

// Live channel `i` of `items` (a folder, favourites, search results…), named `title` in the side list.
function openLive(items, i, title, folderId) {
  playerKind = 'live';
  player.queueTitle = title || 'Canales';
  player.queueFolder = folderId ?? null;
  player.open(items, i, resolveLive, favCtl('live'));
}

// Folders for the side list in the player: favourites, everything, then as in the main list.
function zapFolders() {
  const d = data.live;
  if (!d) return [];
  const fc = favs.live.cats, all = shownItems(d);
  const favCount = favList('live').length;
  const folders = d.folders.filter(f => folderVisible(d, f) && folderShown('live', f));
  if (!d.partial) folders.sort((a, b) => folderDate(b) - folderDate(a));
  return [
    ...(favCount ? [{ id: FAV, name: '★ Favoritos', count: favCount }] : []),
    { id: ALL, name: 'Todo', count: all.length },
    ...sportRows(true).map(f => ({ ...f, name: f.child ? `· ${f.name}` : 'M+/DAZN Deportes' })),
    ...[...folders.filter(f => fc.has(f.id)), ...folders.filter(f => !fc.has(f.id))]
      .map(f => ({ id: f.id, name: f.name, count: pending(d, f) ? '' : folderItems(f).length })),
  ];
}

async function zapItems(id) {
  if (id === FAV) return favList('live');
  if (id === ALL) return shownItems(data.live);
  if (isSport(id)) return sportList(id).list;
  const f = data.live.folderById.get(id);
  if (f && pending(data.live, f)) await loadFolder('live', id);
  const g = data.live.folderById.get(id);
  return g ? folderItems(g) : [];
}

$('#pList').addEventListener('click', e => { e.stopPropagation(); zap.isOpen ? zap.close() : zap.openChans(); });

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
  const url = it.url ? api.wrap(it.url) : apiFor('vod').path('movie', it.id, it.ext);
  return { title: it.name, attempts: it.ext === 'm3u8' ? [['hls', url], ['native-hls', url]] : [['native', url]] };
}

// ---------------------------------------------------------------- EPG

let epgTimer;
function scheduleEpg() {
  if (ui.tab !== 'live' || !settings.epg || !epg) return;
  clearTimeout(epgTimer);
  epgTimer = setTimeout(() => epg.want(itemList.visibleItems().map(i => i.id)), 300);
}

let gridTimer;
function onEpg(id) {
  if (!$('#grid').hidden && !gridTimer) gridTimer = setTimeout(() => { gridTimer = 0; grid.refresh(); }, 1500);
  if (ui.tab === 'live') itemList.updateWhere(it => it.id === id);
  const it = data.live?.byId.get(id);
  if (it && !$('#mosaic').hidden) mosaic.refreshInfo(it);
  if (player.isOpen && playerKind === 'live' && player.current?.id === id) updatePlayerEpg(player.current);
  if (player.isOpen) zap.onEpg(id);
  if (ui.tab === 'home') scheduleHome();
}

function updatePlayerEpg(it) {
  updatePlayerButtons(it);
  if (player.cu) return player.setInfo(player.cuInfo || '');
  const e = epg?.get(it.id);
  player.setArt(artUrl(e?.now?.img, 1280, 720));
  if (!e?.now) return player.setInfo('');
  player.setInfo(`<b>Ahora</b> ${esc(e.now.title)} <span class="dim">${hhmm(e.now.start)}–${hhmm(e.now.end)}</span>` +
    (e.next ? ` · <b>Después</b> ${esc(e.next.title)} <span class="dim">${hhmm(e.next.start)}</span>` : ''));
}

// The channel watched before (⇆ Anterior, Right in the info footer, 0) and the history of Inicio.
let curCh = null, prevCh = null;
function goLast() {
  const p = prevCh;
  if (!p) return;
  confirmBusy().then(ok => { if (ok) openLive(p.queue, p.index, p.title, p.folder); });
}
$('#pLast').addEventListener('click', e => { e.stopPropagation(); goLast(); });

player.onchange = it => {
  if (playerKind === 'live' && !player.cu && liveById(it.id)) {
    if (curCh && curCh.item.id !== it.id) prevCh = curCh;
    curCh = { item: it, queue: player.queue, index: player.index, title: player.queueTitle, folder: player.queueFolder };
    remember('live', it.id);
  }
  updatePlayerButtons(it);
  zap.changed();
  if (playerKind !== 'live' || !epg) return;
  epg.want([it.id], true);
  updatePlayerEpg(it);
};

player.onclose = () => {
  updatePlayerButtons(null);
  zap.reset();
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
// Backups chosen by hand, or else the other versions of the channel (HD / FHD / SD…) found by name.
const autoBackupIds = id => { const ch = liveById(id); return ch ? sports().alts.get(id) ?? autoBackups(ch, data.live.items) : []; };
const backupIds = id => backups[id] ?? autoBackupIds(id);
const backupsOf = id => backupIds(id).map(liveById).filter(Boolean);
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
  player.queueTitle = ch.name;
  player.queueFolder = null;
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
  $('#pList').hidden = !(live && !player.cu && !player.sk);
  $('#pBackup').hidden = !live;
  $('#pStart').hidden = !(live && !player.cu && now && hasArchive([it, ...backupsOf(it.id)]));
  $('#pRec').hidden = !(live && recorder && !player.cu);
  const last = live && !player.cu && prevCh && prevCh.item.id !== it.id;
  $('#pLast').hidden = !last;
  if (last) $('#pLast').title = `Volver a ${prevCh.item.name}`;
}

// Record what is on screen on the Raspberry Pi and keep watching it from the recording
// (the account allows a single connection: live + recorder at once would cut each other).
$('#pRec').addEventListener('click', e => {
  e.stopPropagation();
  const ch = player.current, now = Date.now() / 1000;
  const prog = epg?.get(ch.id)?.now;
  const active = activeRec();
  const go = async (end, label) => {
    const r = await saveRec({
      ch: ch.id, title: prog?.title ? `${ch.name} · ${prog.title}` : ch.name,
      start: now, end, backups: backupIds(ch.id),
    }, false);
    if (!r) return;
    // Watch it from the recording: the account allows a single connection.
    player.close();
    loading(`Empezando a grabar ${label}…`);
    setTimeout(() => { loading(''); playPiRec(r); }, 12000);
  };
  const entries = [];
  if (active) entries.push({ label: `■ Detener la grabación de «${active.title}»`, fn: () => stopPiRec(active) });
  else {
    if (prog) entries.push({ label: `Hasta el final de «${prog.title}» (${hhmm(prog.end + PAD_END)})`, fn: () => go(prog.end + PAD_END, 'hasta el final del programa') });
    for (const h of [1, 2, 3, 4]) entries.push({ label: `${h} hora${h > 1 ? 's' : ''} (hasta las ${hhmm(now + h * 3600)})`, fn: () => go(now + h * 3600, `${h} h`) });
  }
  player.showMenu(active ? 'Grabación en marcha' : 'Grabar en la Raspberry Pi', entries);
});

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
let guideCh = null, guideAt = null;   // guideAt: start (unix s) of a programme to show first

async function openGuide(ch, at = null) {
  guideCh = ch;
  guideAt = at;
  const dlg = $('#guide');
  $('#gTitle').textContent = ch.name;
  const chans = [ch, ...backupsOf(ch.id)];
  $('#gManual').hidden = !(recorder || data.live?.anyArchive);
  $('#gNote').textContent = hasArchive(chans)
    ? `Archivo del proveedor: ${archiveDays(chans)} días${ch.archive ? '' : ' (en los canales de respaldo)'}. Toca un programa pasado para verlo entero.`
    : data.live?.anyArchive ? 'Este canal no tiene archivo en tu proveedor: solo se puede ver en directo. Añade canales de respaldo con archivo para poder verlo después.'
    : 'Tu proveedor no ofrece archivo (catch-up): la guía es informativa. Los canales de respaldo sí funcionan en directo.';
  $('#gBody').innerHTML = '<div class="empty-note"><span class="spinner small"></span>Cargando guía…</div>';
  if (!dlg.open) dlg.showModal();
  let c = tableCache.get(ch.id);
  if (!c || Date.now() - c.ts > 10 * 60e3) {
    try {
      // The provider's table (with its archive flags) when it has one, else the guide by name.
      const own = await api.epgTable(ch.id).catch(() => []);
      c = { list: own.length ? own : await epg.listFor(ch.name), ts: Date.now() };
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
  const pics = progs.some(p => p.img);
  progs.forEach((p, i) => {
    const day = dayLabel(p.start);
    if (day !== lastDay) { html += `<div class="g-day">${esc(day[0].toUpperCase() + day.slice(1))}</div>`; lastDay = day; }
    const state = p.end <= now ? 'past' : p.start <= now ? 'now' : 'future';
    const avail = progAvailable(ch, p);
    const saved = recList().some(r => r.ch === ch.id && r.prog === p.start);
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
    if (state !== 'past' && (recorder || hasArchive([ch, ...backupsOf(ch.id)]))) {
      btns += `<button data-act="rec" class="${saved ? 'on' : ''}">${saved ? (recorder ? '✓ Programada' : '✓ Guardado') : (recorder ? '⏺ Grabar' : '⏺ Guardar')}</button>`;
    }
    html += `<div class="g-row ${state}${state === 'past' && !avail ? ' gone' : ''}" data-i="${i}">
      ${pics ? `<div class="g-img">${artImg(p.img, 192, 108, '')}</div>` : ''}
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
      const r = recList().find(r => r.ch === ch.id && r.prog === p.start);
      if (r) editRec(r);
      else if (recorder) {
        // The Pi records with margins: matches start late and run over.
        saveRec({ ch: ch.id, title: p.title, prog: p.start, start: Math.max(now, p.start - PAD_START), end: p.end + PAD_END, backups: backupIds(ch.id) }, true)
          .then(() => renderGuide(ch, list));
      } else saveRec({ ch: ch.id, title: p.title, prog: p.start, start: p.start, end: p.end, backups: backupIds(ch.id) }, true);
      renderGuide(ch, list);
    }
  };
  const at = guideAt != null ? progs.findIndex(p => p.start === guideAt) : -1;
  if (at >= 0) body.querySelector(`.g-row[data-i="${at}"]`).classList.add('hit');
  const cur = body.querySelector('.g-row.hit') || body.querySelector('.g-row.now') || body.querySelector('.g-row:not(.past)');
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
  editRec({ ch: guideCh.id, title: guideCh.name, start, end: start + 2 * 3600, backups: backupIds(guideCh.id) }, true);
});
$('#gBackups').addEventListener('click', () => editBackups(guideCh));

// ---- recordings

async function saveRec(r, announce = false) {
  if (recorder) return savePiRec(r, announce);
  r.id ||= Math.random().toString(36).slice(2);
  recs = recs.filter(x => x.id !== r.id).concat(r);
  saveRecs();
  if (announce) {
    const chans = [r.ch, ...r.backups].map(liveById).filter(Boolean);
    toast(hasArchive(chans)
      ? `Guardado en ⏺ Grabaciones: podrás verlo entero durante ${archiveDays(chans)} días`
      : 'Guardado, pero ninguno de estos canales tiene archivo: solo podrás verlo en directo. Añade respaldos con ⏪.', 5000);
  }
  recsChanged();
  return r;
}

function recsChanged() {
  if (ui.tab === 'live' && data.live) { renderFolders(); if (ui.folder.live === REC && !query) refreshItems(false); }
}

const recList = () => recorder ? piRecs : recs;

function sortedRecs() {
  const now = Date.now() / 1000;
  const rank = r => r.state === 'recording' ? 0 : r.end <= now || ['done', 'failed', 'missed'].includes(r.state) ? 2 : r.start <= now ? 0 : 1;
  return recList().map(r => ({ ...r, rec: true, name: r.title }))
    .sort((a, b) => rank(a) - rank(b) || (rank(a) === 2 ? b.start - a.start : a.start - b.start));
}

function recStatus(r) {
  if (r.pi) return piStatus(r);
  const now = Date.now() / 1000;
  const chans = [r.ch, ...r.backups].map(liveById).filter(Boolean);
  const days = archiveDays(chans);
  if (now < r.start) return `Programada · ${dayLabel(r.start)} ${hhmm(r.start)}–${hhmm(r.end)}`;
  if (now < r.end) return `● En curso desde las ${hhmm(r.start)} · toca para verlo desde el principio`;
  if (!days) return `${dayLabel(r.start)} ${hhmm(r.start)} · guardada en este navegador, no en la Raspberry · sin archivo en el proveedor, no se puede ver`;
  const until = r.start + days * DAY;
  return now < until ? `${dayLabel(r.start)} ${hhmm(r.start)} · disponible hasta ${dayLabel(until)} ${hhmm(until)}` : `${dayLabel(r.start)} · caducada (fuera del archivo)`;
}

function renderRecRow(r) {
  const chName = liveById(r.ch)?.name || r.chName || 'canal no disponible';
  const bk = r.backups.length ? ` · ${r.backups.length} de respaldo` : '';
  return `<div class="row rec${r.state === 'recording' ? ' on-air' : ''}">
    <div class="logo">⏺</div>
    <div class="grow"><div class="name">${esc(r.title || 'Sin título')}</div>
      <div class="meta">${esc(recStatus(r))}${r.current ? '' : ` · ${esc(chName)}${bk}`}</div></div>
    <button class="star gbtn" data-act="edit" aria-label="Editar">✎</button>
  </div>`;
}

// The info sheet of a recording: its programme's picture and synopsis, Watch first.
function recMenu(r, pos) {
  const saved = recList().find(x => x.id === r.id);
  if (!saved) return;
  pos ??= hist.find(h => h.k === 'rec' && h.id === saved.id)?.pos;
  const ready = !saved.pi || saved.duration > 0 || saved.state === 'recording', entries = [];
  if (ready && pos) entries.push({ label: `▶ Seguir viendo (desde ${fmtClock(pos)})`, fn: () => onRecClick(saved, null, pos) });
  if (ready) entries.push({ label: pos ? '⏮ Ver desde el principio' : saved.state === 'recording' ? '▶ Ver (desde el principio)' : '▶ Ver', fn: () => onRecClick(saved, null, 0) });
  entries.push({ label: saved.state === 'scheduled' || (!saved.pi && Date.now() / 1000 < saved.end) ? '✎ Cambiar o borrar la grabación' : '✎ Editar o borrar', fn: () => editRec(saved) });
  entries[0].main = true;
  const chName = liveById(saved.ch)?.name || saved.chName || '';
  const p = recProg(saved);
  showMenu(saved.title || 'Sin título', `⏺ ${esc(recStatus(saved))}${chName ? `<br>📺 ${esc(chName)}` : ''}`, entries,
    { img: p?.img, prog: p });
}

function onRecClick(r, act, pos = null) {
  const saved = recList().find(x => x.id === r.id);
  if (!saved) return;
  if (act === 'edit') return editRec(saved);
  if (saved.pi) {
    // the player waits for the first minutes; from Inicio it goes on where it was left
    if (saved.duration > 0 || saved.state === 'recording') return playPiRec(saved, pos);
    if (saved.state === 'scheduled') return toast(`Se grabará ${dayLabel(saved.start)} de ${hhmm(saved.start)} a ${hhmm(saved.end)} en la Raspberry Pi.`, 5000);
    return toast(`No se grabó: ${saved.log?.at(-1)?.[1] || 'sin señal en ningún canal'}`, 6000);
  }
  const ch = liveById(saved.ch);
  if (!ch) return toast('El canal de esta grabación ya no existe');
  // Not a Pi recording: a programme saved in this browser to be played from the provider's archive.
  // Without archive that would only open the channel live, which is not what was asked for.
  if (Date.now() / 1000 >= saved.end && !hasArchive([ch, ...saved.backups.map(liveById).filter(Boolean)])) {
    return toast('Esto no es una grabación de la Raspberry Pi: es un programa guardado en este navegador para verlo desde el archivo del proveedor, y tu proveedor no guarda archivo. ' +
      'Las grabaciones de la Raspberry se ven abriendo la app desde su dirección (la que termina en :8090) en la red de casa.', 12000);
  }
  if (Date.now() / 1000 < saved.start) return toast(`Empieza ${dayLabel(saved.start)} a las ${hhmm(saved.start)}. Desde ese momento podrás verlo desde el principio.`, 5000);
  playCatchup(ch, saved, null, saved.backups);
}

// ---- Raspberry Pi recorder
// When the app is served by recorder/recorder.py (http://<pi>:8090), recordings are made there:
// it records even with every screen off and switches to the backup channels when one cuts out.

let recorder = null;   // last /api/status when served by the recorder
let syncer = null;     // data shared with the other screens through the recorder (sync.js)

// Another screen changed shared data (already in localStorage): load it and redraw.
function syncedChanged(keys) {
  if (keys.includes('settings')) {
    Object.assign(settings, store.get('settings', {}));
    applyVod();
  }
  if (keys.includes('teams')) {
    teams = store.get('teams', []);
    teamKeys = new Set(teams.map(norm));
  }
  if (keys.includes('recentQ')) recentQ = store.get('recentQ', []);
  if (account && keys.some(k => k.endsWith(':' + account))) {
    if (!api) return;
    loadFavs();
    shownCache = null;
  }
  eventChanCache.clear();
  if (!api) return;
  if (ui.tab === 'home') renderHome();
  else { renderFolders(); refreshItems(false); }
  if (!$('#grid').hidden) grid.refresh();
}
let piRecs = [];

async function piApi(method, path, body) {
  const res = await fetch('/api/' + path, {
    method, cache: 'no-store',
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}

async function initRecorder() {
  try {
    const s = await piApi('GET', 'status');
    if (typeof s.version !== 'string') return;
    recorder = s;
  } catch { return; }
  syncer = initSync(piApi, syncedChanged);
  await loadPiRecs();
  setInterval(loadPiRecs, 10000);
  if (!recorder.ok) toast(`Grabador: ${recorder.error}`, 8000);
}

async function loadPiRecs() {
  try {
    recorder = await piApi('GET', 'status');
    const arr = await piApi('GET', 'recs');
    piRecs = arr.map(r => ({
      ...r, pi: true,
      ch: r.sources[0]?.id, chName: r.sources[0]?.name, backups: r.sources.slice(1).map(s => s.id),
    }));
  } catch { return; }
  if (ui.tab === 'live' && data.live) {
    renderFolders();
    if (ui.folder.live === REC && !query && !series) refreshItems(false);
  }
  if (player.isOpen) updatePlayerButtons(player.current);
  updateRecBanner();
}

async function savePiRec(r, announce) {
  const sources = [r.ch, ...r.backups].map(id => ({ id, name: liveById(id)?.name || id }));
  const body = { title: r.title, start: Math.round(r.start), end: Math.round(r.end), sources, prog: r.prog };
  try {
    let saved;
    if (r.id) saved = await piApi('PUT', 'recs/' + r.id, body);
    else saved = await piApi('POST', 'recs', { ...body, creds: store.get('creds'), formats: api.liveFormats() });
    await loadPiRecs();
    recsChanged();
    if (announce) toast(`Programada en la Raspberry Pi: ${dayLabel(r.start)} ${hhmm(r.start)}–${hhmm(r.end)}`
      + (r.backups.length ? ` con ${r.backups.length} canal${r.backups.length > 1 ? 'es' : ''} de respaldo` : ' (añade canales de respaldo por si se corta)'), 5000);
    return piRecs.find(x => x.id === saved.id) || saved;
  } catch (ex) {
    toast(`No se pudo programar: ${ex.message}`, 6000);
    return null;
  }
}

function playPiRec(r, pos = null) {
  mosaic.stop();
  playerKind = 'rec';
  remember('rec', r.id);
  const url = `/rec/${r.id}/index.m3u8`;
  const start = r.parts?.find(p => p.segments)?.start || r.start;
  player.open([{ ...r, name: r.title }], 0, () => ({
    title: `⏺ ${r.title}`, fromStart: true, attempts: [['hls', url], ['native-hls', url]], resumeAt: pos || 0,
    // Played from the Pi's USB stick: the provider (and the channel) are not involved at all.
    texts: {
      loading: 'Abriendo la grabación de la Raspberry Pi…',
      slow: 'la Raspberry Pi tarda en responder',
      fail: 'No se pudo reproducir la grabación desde la Raspberry Pi. Comprueba que este dispositivo está en la red de casa y vuelve a intentarlo.',
    },
    seekbar: { start, planned: r.state === 'recording' ? r.end - start : 0, growing: () => piRecs.find(x => x.id === r.id)?.state === 'recording',
      gaps: () => piRecs.find(x => x.id === r.id)?.gaps || r.gaps || [] },
  }));
  player.setArt(artUrl(recProg(r)?.img, 1280, 720));
  if (r.gaps?.length) toast(`Esta grabación tiene ${cutsText(r).slice(2)}: están marcados en rojo en la barra de tiempo`, 6000);
}

// Playing a recording across one of its cuts: say how much is missing there.
let recT = 0;
player.video.addEventListener('timeupdate', () => {
  const t = player.video.currentTime;
  if (playerKind === 'rec' && player.isOpen && t > recT && t - recT < 3) {
    const r = piRecs.find(x => x.id === player.current?.id) || player.current;
    const g = (r?.gaps || []).find(([at]) => at > 0 && at > recT && at <= t);
    if (g) toast(`Corte en la grabación: aquí faltan ≈${fmtLost(g[1])}`, 5000);
  }
  recT = t;
});

const activeRec = () => piRecs.find(r => r.state === 'recording');

// Where each recording was left (for «Seguir viendo»); near the end counts as seen.
setInterval(() => {
  if (!player.isOpen || playerKind !== 'rec' || !player.current || player.video.paused) return;
  const t = player.video.currentTime, dur = player.video.duration;
  const h = hist.find(x => x.k === 'rec' && x.id === player.current.id);
  if (!h || t < 30) return;
  const done = isFinite(dur) && dur > 0 && dur - t < 120 && player.current.state !== 'recording';
  if (done) delete h.pos; else h.pos = Math.floor(t);
  store.set('hist:' + account, hist);
}, 10000);

// wait: until the Pi has let go of the connection (up to ~10 s), to use it right after.
async function stopPiRec(r, wait = false) {
  try {
    await piApi('POST', `recs/${r.id}/stop`);
  } catch (ex) { toast(ex.message); return false; }
  toast('Grabación detenida', 2500);
  if (!wait) { setTimeout(loadPiRecs, 1500); return true; }
  for (let i = 0; i < 20; i++) {
    await new Promise(res => setTimeout(res, 500));
    await loadPiRecs();
    if (piRecs.find(x => x.id === r.id)?.state !== 'recording') break;
  }
  await new Promise(res => setTimeout(res, 1000));   // the provider takes a moment to free the slot
  return true;
}

// Always visible while the Pi records: the single connection is taken until it ends.
function updateRecBanner() {
  const r = activeRec();
  const b = $('#recBanner');
  b.hidden = !r;
  if (r) b.textContent = `● Grabando «${r.title}» hasta las ${hhmm(r.end)} · no veas otros canales hasta entonces`;
}
$('#recBanner').addEventListener('click', () => { const r = activeRec(); if (r) playPiRec(r); });

// Before using the connection for something else while recording.
function confirmBusy() {
  const r = activeRec();
  if (!r) return Promise.resolve(true);
  return new Promise(resolve => {
    const dlg = $('#busyDialog');
    $('#busyText').textContent = `La Raspberry Pi está grabando «${r.title}» hasta las ${hhmm(r.end)}. Tu cuenta solo permite una conexión: para ver este canal se detendrá la grabación (lo grabado hasta ahora se conserva).`;
    dlg.returnValue = '';
    dlg.onclose = async () => {
      const v = dlg.returnValue;
      if (v === 'rec') { playPiRec(r); return resolve(false); }
      if (v !== 'stop') return resolve(false);
      loading('Deteniendo la grabación…');
      const ok = await stopPiRec(r, true);
      loading('');
      resolve(ok);
    };
    dlg.showModal();
  });
}

// Cuts of a recording (recorder.py: gaps [[position s, lost s]]): "⚠ 2 cortes, ≈3 min perdidos".
const lostOf = r => (r.gaps || []).reduce((a, g) => a + g[1], 0);
const fmtLost = s => {
  s = Math.round(s);
  if (s < 60) return `${s} s`;
  if (s < 600) return `${Math.floor(s / 60)} min${s % 60 ? ` ${s % 60} s` : ''}`;
  return s < 3600 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.round(s / 60) % 60} min`;
};
const cutsText = r => r.gaps?.length ? `⚠ ${r.gaps.length === 1 ? '1 corte' : `${r.gaps.length} cortes`}, ≈${fmtLost(lostOf(r))} perdidos` : '';

function piStatus(r) {
  const size = r.size ? ` · ${fmtSize(r.size)}` : '';
  const cuts = r.gaps?.length ? ` · ${cutsText(r)}` : '';
  const switched = new Set((r.parts || []).filter(p => p.segments).map(p => p.source)).size > 1 ? ' · usó respaldo' : '';
  switch (r.state) {
    case 'scheduled': return `Programada · ${dayLabel(r.start)} ${hhmm(r.start)}–${hhmm(r.end)}`;
    case 'recording': return `● Grabando${r.current ? ` de ${r.current}` : ''} · ${fmtDur(r.duration || 1)}${size}${cuts} · toca para verla desde el principio`;
    case 'done': return r.duration ? `${dayLabel(r.start)} ${hhmm(r.start)} · ${fmtDur(r.duration)}${size}${switched}${cuts}` : 'No se grabó nada';
    default: return `No se pudo grabar · ${r.log?.at(-1)?.[1] || ''}`;
  }
}


// ---- recording / backup dialog

let plan = null;   // { mode: 'rec' | 'backup', rec?, ch, picked: [ids] }

function editRec(r, isNew = false) {
  // The channel may have left the list (renumbered by the provider): the recording can still be edited or deleted
  const ch = liveById(r.ch) || { id: String(r.ch), name: r.chName || 'un canal que ya no está en tu lista' };
  plan = { mode: 'rec', rec: r, ch, picked: [...r.backups], isNew };
  $('#planTitle').textContent = isNew ? `Programar en ${ch.name}` : `Grabación en ${ch.name}`;
  $('#planHint').textContent = recorder
    ? 'Lo graba la Raspberry Pi en el pendrive aunque no haya nada encendido. Si el canal se corta, sigue con los de respaldo.'
    : 'Se reproduce desde el archivo del proveedor (catch-up), incluso si llegas tarde o después de que termine.';
  $('#planFields').hidden = false;
  $('#planName').value = r.title || '';
  $('#planStart').value = toLocalInput(r.start);
  const dur = Math.round((r.end - r.start) / 60);
  const sel = $('#planDur');
  if (![...sel.options].some(o => +o.value === dur)) sel.add(new Option(`${dur} min`, dur));
  sel.value = String(dur);
  $('#planDelete').hidden = isNew;
  $('#planDelete').textContent = r.pi && r.state !== 'scheduled' ? 'Borrar grabación' : 'Borrar';
  $('#planStop').hidden = !(r.pi && r.state === 'recording');
  $('#planStart').disabled = !!r.pi && r.state !== 'scheduled';
  openPlan();
}

function editBackups(ch) {
  plan = { mode: 'backup', ch, picked: backupIds(ch.id) };
  $('#planTitle').textContent = `Respaldo de ${ch.name}`;
  $('#planHint').textContent = 'Si el canal no carga o se corta, se pasa al siguiente de la lista (y en diferido, al mismo minuto). ' +
    (ch.id in backups ? 'Lista elegida a mano.' : 'Marcados automáticamente: las otras versiones de este canal (FHD, HD, SD…); quita o añade los que quieras.') +
    ' Los marcados con ⏪ tienen archivo.';
  $('#planFields').hidden = true;
  $('#planDelete').hidden = true;
  $('#planStop').hidden = true;
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
  const auto = autoBackupIds(plan.ch.id);
  $('#planAuto').hidden = !auto.length || auto.join() === plan.picked.join();
}

$('#planAuto').addEventListener('click', () => { plan.picked = autoBackupIds(plan.ch.id); renderPicked(); });

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
  if (p && v === 'stop') return stopPiRec(p.rec);
  if (!p || (v !== 'save' && v !== 'delete')) return;
  if (p.mode === 'backup') {
    // Same as the automatic list: keep following it (it adapts when the channel list changes).
    if (p.picked.join() === autoBackupIds(p.ch.id).join()) delete backups[p.ch.id];
    else backups[p.ch.id] = p.picked;
    saveBackups();
    if (player.isOpen && player.current?.id === p.ch.id) {
      player.setSources(liveSources([p.ch, ...backupsOf(p.ch.id)]));
      updatePlayerButtons(p.ch);
    }
    if ($('#guide').open && guideCh?.id === p.ch.id) openGuide(p.ch);
    toast(p.picked.length ? `${p.picked.length} canal${p.picked.length > 1 ? 'es' : ''} de respaldo guardado${p.picked.length > 1 ? 's' : ''}` : 'Sin canales de respaldo', 2500);
    return;
  }
  if (v === 'delete' && p.rec.pi) {
    piApi('DELETE', 'recs/' + p.rec.id).then(loadPiRecs).then(recsChanged, ex => toast(ex.message));
  } else if (v === 'delete') {
    recs = recs.filter(x => x.id !== p.rec.id);
    saveRecs();
    recsChanged();
  } else {
    const start = Math.floor(new Date($('#planStart').value).getTime() / 1000) || p.rec.start;
    const end = start + +$('#planDur').value * 60;
    saveRec({ ...p.rec, title: $('#planName').value.trim() || 'Sin título', start: p.rec.pi && p.rec.state !== 'scheduled' ? p.rec.start : start, end, backups: p.picked }, p.isNew);
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

mosaic.hideDead = ui.hideDead;
$('#deadBtn').classList.toggle('on', ui.hideDead);
$('#deadBtn').addEventListener('click', () => {
  ui.hideDead = !ui.hideDead;
  saveUi();
  $('#deadBtn').classList.toggle('on', ui.hideDead);
  mosaic.setHideDead(ui.hideDead);
});

$('#mineBtn').addEventListener('click', () => {
  ui.agendaAll = !ui.agendaAll;
  saveUi();
  renderFolders();
  refreshItems(true);
});

$('#gridBtn').addEventListener('click', () => {
  gridOn = !gridOn;
  if (gridOn) mosaicOn = false;
  closeSeries();
  refreshItems(true);
});

$('#mosaicBtn').addEventListener('click', () => {
  mosaicOn = !mosaicOn;
  if (mosaicOn) gridOn = false;
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
  $('#grid').hidden = true;
  $('#empty').hidden = true;
  $('#listTitle').textContent = it.name;
  $('#listCount').textContent = '';
  const box = $('#series');
  box.hidden = false;
  box.innerHTML = '<p class="muted"><span class="spinner small"></span>Cargando episodios…</p>';
  try {
    let info = it.episodes ? { info: {}, episodes: it.episodes } : seriesCache.get(it.id);   // M3U series carry their episodes
    if (!info) { info = await apiFor('series').seriesInfo(it.id); seriesCache.set(it.id, info); }
    if (series?.item !== it) return;
    let eps = info?.episodes || {};
    if (Array.isArray(eps)) eps = Object.fromEntries(eps.map((e, i) => [String(e?.[0]?.season ?? i + 1), e]));
    const seasons = Object.keys(eps).filter(k => eps[k]?.length).sort((a, b) => a - b);
    Object.assign(series, { info, eps, seasons, season: seasons[seasons.length - 1] });   // latest season first
    renderSeries();
    remote.refocus();
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
    ${episodes.map((e, i) => `<div class="row ep" data-ep="${i}" tabindex="0">
      <span class="num">${esc(e.episode_num ?? i + 1)}</span>
      <div class="grow"><div class="name">${esc(e.title || `Episodio ${e.episode_num ?? i + 1}`)}</div><div class="meta">${esc([e.info?.duration, ago(+e.added)].filter(Boolean).join(' · '))}</div></div>
    </div>`).join('')}`;
}

$('#series').addEventListener('click', e => {
  if (e.target.closest('[data-retry]')) return openSeries(series.item);
  const s = e.target.closest('[data-season]');
  if (s) { series.season = s.dataset.season; renderSeries(); remote.refocus(); return; }
  const ep = e.target.closest('[data-ep]');
  if (!ep) return;
  const eps = series.eps[series.season];
  const name = series.item.name;
  const season = series.season;
  playerKind = 'series';
  const fav = favCtl('series', series.item);
  player.open(eps, +ep.dataset.ep, x => {
    const ext = x.container_extension || 'mp4';
    const url = x.url ? api.wrap(x.url) : apiFor('series').path('series', x.id, ext);
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
    // A tab shows its own content: the search is left
    if (query || $('#search').value) { $('#search').value = ''; query = ''; expanded.clear(); return selectTab(b.dataset.tab); }
    if (b.dataset.tab !== ui.tab || series) selectTab(b.dataset.tab);
  });
}

let searchTimer;
function runSearch(v) {
  query = v.trim();
  expanded.clear();
  closeSeries();
  if (!query && ui.tab === 'home') { layout(); renderHome(); return; }
  if (!query && ui.tab !== 'agenda' && !data[ui.tab]) return;
  folderList.refresh();
  refreshItems(true);
  if (query) document.body.classList.add('show-items');
  else if (ui.tab === 'agenda' || data[ui.tab]) renderFolders();
}
$('#search').addEventListener('input', e => {
  showRecent();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => runSearch(e.target.value), 250);
});
$('#search').addEventListener('focus', showRecent);
$('#search').addEventListener('blur', () => { if (query && list.length) pushRecent(query); setTimeout(showRecent, 150); });
$('#search').addEventListener('keydown', e => { if (e.key === 'Enter' && query) pushRecent(query); });
$('#recentQ').addEventListener('pointerdown', e => e.preventDefault());   // keep the focus in the box
$('#recentQ').addEventListener('focusout', () => setTimeout(showRecent, 150));
$('#recentQ').addEventListener('click', e => {
  const b = e.target.closest('[data-q]');
  if (!b) return;
  const q = recentQ[+b.dataset.q];
  $('#search').value = q;
  $('#recentQ').hidden = true;
  clearTimeout(searchTimer);
  runSearch(q);
  pushRecent(q);
  $('#search').blur();
});

$('#back').addEventListener('click', () => {
  if (series) closeSeries();
  else document.body.classList.remove('show-items');
});

async function reload() {
  const t = ui.tab;
  if (t === 'home') {
    await Promise.all([agenda.load(true), recorder ? loadPiRecs() : null]);
    eventChanCache.clear();
    homeWantEpg();
    renderHome();
    return;
  }
  if (t === 'agenda') {
    await agenda.load(true);
    eventChanCache.clear();
    renderFolders();
    refreshItems(false);
    if (!agenda.error) toast('Agenda actualizada', 2000);
    return;
  }
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
  lines.push(syncer ? (syncer.status.ok ? '🔄 Sincronizado con la Raspberry: favoritos, equipos, avisos y «Seguir viendo» son los mismos en todas las pantallas que la abren desde su dirección'
    : `🔄 Sin sincronizar con la Raspberry${syncer.status.error ? ` (${esc(syncer.status.error)})` : ''}`)
    : '<span class="dim">Para compartir favoritos, equipos y «Seguir viendo» entre pantallas, abre la app desde el grabador de Raspberry Pi (http://&lt;ip-de-la-pi&gt;:8090; ver las instrucciones)</span>');
  lines.push(`<span class="dim">Versión de la app: ${VERSION}</span>`);
  $('#accountInfo').innerHTML = lines.join('<br>');
  $('#diagOut').hidden = true;
  $('#proxyInput').value = api.proxy;
  $('#bufferInput').value = String(settings.buffer);
  $('#bufferMaxInput').value = String(settings.bufferMax);
  $('#scanInput').value = String(settings.scan);
  $('#epgInput').checked = !!settings.epg;
  $('#autoFsInput').checked = settings.autoFs !== false;
  $('#cuShiftInput').value = String(settings.cuShift || 0);
  $('#scaleInput').value = getScale();
  $('#vodInput').checked = !!settings.vod;
  $('#autoRecInput').checked = !!settings.autoRec;
  $('#autoRecRow').hidden = !recorder;
  $('#settings').returnValue = '';
  $('#settings').showModal();
});

$('#settings').addEventListener('close', async () => {
  const v = $('#settings').returnValue;
  if (v === 'save') {
    const buf = [settings.buffer, settings.bufferMax];
    settings.buffer = +$('#bufferInput').value;
    settings.bufferMax = Math.max(settings.buffer, +$('#bufferMaxInput').value);
    if (buf[0] !== settings.buffer || buf[1] !== settings.bufferMax) delete settings.bufLearnedBy;   // chosen by hand: start again from it
    settings.scan = +$('#scanInput').value;
    settings.epg = $('#epgInput').checked;
    settings.autoFs = $('#autoFsInput').checked;
    settings.cuShift = +$('#cuShiftInput').value;
    settings.vod = $('#vodInput').checked;
    settings.autoRec = $('#autoRecInput').checked;
    store.set('settings', settings);
    setScale($('#scaleInput').value);
    applyVod();
    autoRecTeams();
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

// ---- interface size: '' automatic (smaller on TVs), 's', 'm', 'l' (read by the script in index.html)
function getScale() { try { return localStorage.getItem('iptv-scale') || ''; } catch { return ''; } }
function setScale(z) {
  try { if (z) localStorage.setItem('iptv-scale', z); else localStorage.removeItem('iptv-scale'); } catch {}
  let tvLike = false;
  try { tvLike = /Android ?TV|GoogleTV|BRAVIA|\bAFT|SMART-?TV|SmartTV|Web0S|webOS|NetCast|Tizen|HbbTV|CrKey|\bTV\b/i.test(navigator.userAgent) || localStorage.getItem('iptv-tv') === '1'; } catch {}
  const c = document.documentElement.classList;
  c.toggle('tv', z === 's' || (!z && tvLike));
  c.toggle('big', z === 'l');
  if (!$('#grid').hidden) grid.refresh();
}

// ---- Películas / Series: hidden unless enabled (the provider stopped sending them)
function applyVod(redirect = true) {
  for (const b of document.querySelectorAll('.tabs [data-tab="vod"], .tabs [data-tab="series"]')) b.hidden = !settings.vod;
  if (redirect && api && !settings.vod && (ui.tab === 'vod' || ui.tab === 'series')) selectTab('home');
}
applyVod(false);

// ---- checklists (visible folders, agenda sports, favourite teams)
let checkSave = null;
function checklist({ title, hint, items, quick = [], onSave }) {
  $('#checkTitle').textContent = title;
  $('#checkHint').textContent = hint || '';
  $('#checkSearch').value = '';
  $('#checkSearch').hidden = items.length < 12;
  $('#checkList').innerHTML = items.map(x => `<label class="check" data-k="${esc(norm(x.name))}"><input type="checkbox" value="${esc(x.id)}"${x.on ? ' checked' : ''}> <span>${esc(x.name)}${x.sub ? ` <span class="dim">${esc(x.sub)}</span>` : ''}</span></label>`).join('')
    || '<p class="muted">No hay nada que elegir todavía.</p>';
  $('#checkQuick').innerHTML = quick.map((q, i) => `<button type="button" data-qi="${i}">${esc(q.label)}</button>`).join('');
  $('#checkQuick').hidden = !quick.length;
  $('#checkQuick').onclick = e => {
    const b = e.target.closest('[data-qi]');
    if (!b) return;
    const boxes = [...$('#checkList').querySelectorAll('input')];
    quick[+b.dataset.qi].fn(boxes, items);
  };
  checkSave = onSave;
  $('#checkDialog').returnValue = '';
  $('#checkDialog').showModal();
}
$('#checkSearch').addEventListener('input', e => {
  const q = norm(e.target.value.trim());
  for (const l of $('#checkList').querySelectorAll('label')) l.hidden = !!q && !l.dataset.k.includes(q);
});
$('#checkSearch').addEventListener('keydown', e => { if (e.key === 'Enter') e.preventDefault(); });
$('#checkDialog').addEventListener('close', () => {
  const fn = checkSave;
  checkSave = null;
  if ($('#checkDialog').returnValue !== 'save' || !fn) return;
  fn(new Set([...$('#checkList').querySelectorAll('input:checked')].map(i => i.value)));
});

// Folders of other countries (by name: "⛅ | Francia - Full", "Lat - Noticias", "24/7 | Kids - Ingles"…)
const FOREIGN_FOLDER = /\b(arabe|africa|australia|alemania|argentina|bolivia|brasil|belgica|bulgaria|canada|costa rica|colombia|chequia|chile|dinamarca|egipto|ecuador|el salvador|francia|finlandia|guatemala|grecia|honduras|hungria|italia|usa|marruecos|mexico|noruega|netherlands|holanda|nicaragua|paraguay|panama|portugal|polonia|peru|puerto rico|reino unido|rusia|rumania|dominicana|suiza|suecia|serbia|turquia|uruguay|venezuela|lat|latino|latinoamerica|aleman|ingles|italiano|portugues|uk|usa|india|pakistan|kurdish|albania|ex-?yu)\b/;

$('#foldersBtn').addEventListener('click', async () => {
  const d = await ensureData('live').catch(() => null);
  if (!d) return;
  const folders = d.folders.filter(f => unlocked || !f.adult);
  checklist({
    title: 'Carpetas visibles',
    hint: 'Las desmarcadas no salen en Directo, «Todo» ni en la búsqueda. Sus canales siguen sirviendo para la agenda y como respaldo.',
    items: folders.map(f => ({ id: f.id, name: f.name, on: !hiddenF.has(f.id), sub: `${folderItems(f).length}` })),
    quick: [
      { label: 'Ocultar las de otros países', fn: (boxes, items) => boxes.forEach((b, i) => { if (FOREIGN_FOLDER.test(norm(items[i].name))) b.checked = false; }) },
      { label: 'Mostrar todas', fn: boxes => boxes.forEach(b => { b.checked = true; }) },
    ],
    onSave: on => {
      hiddenF = new Set(folders.map(f => f.id).filter(id => !on.has(id)));
      hiddenVer++;
      store.set('hideF:' + account, [...hiddenF]);
      toast(hiddenF.size ? `${hiddenF.size} carpeta${hiddenF.size > 1 ? 's' : ''} oculta${hiddenF.size > 1 ? 's' : ''}` : 'Todas las carpetas visibles', 2500);
      if (ui.tab === 'live') { if (hiddenF.has(ui.folder.live)) ui.folder.live = ALL; renderFolders(); refreshItems(false); }
    },
  });
});

$('#sportsBtn').addEventListener('click', async () => {
  await agenda.load();
  const count = new Map();
  for (const e of agenda.events) count.set(e.sport, (count.get(e.sport) || 0) + 1);
  const sports = [...count].sort((a, b) => b[1] - a[1]);
  checklist({
    title: 'Deportes de la agenda',
    hint: 'Los desmarcados no salen en la agenda, en Inicio ni en la búsqueda.',
    items: sports.map(([sp, n]) => ({ id: sp, name: sp, on: !settings.hideSports.includes(sp), sub: `${n}` })),
    quick: [{ label: 'Solo fútbol', fn: (boxes, items) => boxes.forEach((b, i) => { b.checked = /^f[uú]tbol$/i.test(items[i].id); }) },
      { label: 'Todos', fn: boxes => boxes.forEach(b => { b.checked = true; }) }],
    onSave: on => {
      settings.hideSports = sports.map(x => x[0]).filter(sp => !on.has(sp));
      store.set('settings', settings);
      eventChanCache.clear();
      if (ui.tab === 'agenda') { renderFolders(); refreshItems(false); }
    },
  });
});

async function editTeams() {
  await agenda.load();
  const names = new Map(teams.map(t => [norm(t), t]));
  for (const e of agenda.events) for (const n of [e.home, e.away]) if (n && !names.has(norm(n))) names.set(norm(n), n);
  const all = [...names.values()].sort((a, b) => isTeam(b) - isTeam(a) || a.localeCompare(b, 'es'));
  checklist({
    title: 'Mis equipos',
    hint: 'Sus partidos salen primero en Inicio y en «★ Mis equipos» de la agenda. También desde ⋯ en cualquier partido. La lista son los equipos con partidos en la agenda de estos días.',
    items: all.map(n => ({ id: n, name: n, on: isTeam(n) })),
    onSave: on => setTeams(all.filter(n => on.has(n))),
  });
}
$('#teamsBtn').addEventListener('click', editTeams);

// Empty «Continue watching» (a second press confirms it)
let histArmed;
$('#histBtn').addEventListener('click', () => {
  const b = $('#histBtn');
  if (!histArmed) {
    b.textContent = '¿Seguro? Pulsa otra vez para vaciar';
    histArmed = setTimeout(() => { histArmed = null; b.textContent = 'Vaciar «Seguir viendo»'; }, 4000);
    return;
  }
  clearTimeout(histArmed);
  histArmed = null;
  b.textContent = 'Vaciar «Seguir viendo»';
  hist = [];
  store.set('hist:' + account, hist);
  renderHome();
  toast('«Seguir viendo» vaciado', 2500);
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
    lines.push(`${ia} (POST): …`); show();
    lines[lines.length - 1] = `${ia} (POST): ${await api.probe(ia, {}, 180000, { post: true })}`; show();
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

initRecorder();
const saved = store.get('creds');
if (saved?.server && saved.username) startSession(saved);
else showLogin();
