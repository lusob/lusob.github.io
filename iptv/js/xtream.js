// Minimal Xtream Codes API client, patient with slow/overloaded servers.

const ACTIONS = {
  live:   ['get_live_categories',   'get_live_streams'],
  vod:    ['get_vod_categories',    'get_vod_streams'],
  series: ['get_series_categories', 'get_series'],
};

const sleep = ms => new Promise(r => setTimeout(r, ms));

// Accepts "host:port", "http://host:port/" or a full get.php / player_api.php URL with credentials.
export function parseServerInput(input) {
  let s = String(input || '').trim();
  if (!s) return { server: '' };
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  try {
    const u = new URL(s);
    return {
      server: u.origin,
      username: u.searchParams.get('username') || '',
      password: u.searchParams.get('password') || '',
    };
  } catch {
    return { server: s.replace(/\/+$/, '') };
  }
}

export function isMixedContent(server, proxy) {
  return location.protocol === 'https:' && /^http:\/\//i.test(server) && !proxy;
}

class ApiError extends Error {
  constructor(msg, retry) { super(msg); this.retry = retry; }
}

export class Xtream {
  constructor({ server, username, password, proxy }) {
    this.server = server;
    this.username = username;
    this.password = password;
    this.proxy = (proxy || '').trim();
    this.info = null;
  }

  wrap(url) {
    if (!this.proxy) return url;
    return this.proxy + (this.proxy.includes('?') ? '&' : '?') + 'url=' + encodeURIComponent(url);
  }

  // bust: unique URL so no cache (browser, CDN in front of the panel) can answer;
  // post: same parameters as a form POST (some panels/CDNs treat it differently).
  async api(action, extra = {}, { timeout = 45000, retries = 2, bust = false, post = false } = {}) {
    const q = new URLSearchParams({ username: this.username, password: this.password, ...extra });
    if (action) q.set('action', action);
    if (bust) q.set('_', Date.now().toString(36));
    const url = this.wrap(post ? `${this.server}/player_api.php` : `${this.server}/player_api.php?${q}`);
    const init = post ? { method: 'POST', body: q } : {};
    for (let n = 0; ; n++) {
      try {
        return await this.request(url, timeout, init);
      } catch (e) {
        if (!e.retry || n >= retries) throw e;
        await sleep(2000 * (n + 1));
      }
    }
  }

  async request(url, timeout, init = {}) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      let res;
      try {
        res = await fetch(url, { signal: ctl.signal, cache: 'no-store', ...init });
      } catch (e) {
        if (e.name === 'AbortError') throw new ApiError('El servidor no respondió a tiempo (puede estar saturado).', true);
        throw new ApiError(isMixedContent(this.server, this.proxy)
          ? 'El navegador bloquea servidores http:// desde una página https://. Configura un proxy (Avanzado).'
          : 'No se pudo conectar con el servidor (¿caído o sin CORS?). Prueba a configurar un proxy.', true);
      }
      if (!res.ok) throw new ApiError(`El servidor respondió HTTP ${res.status}`, res.status >= 500 || res.status === 429);
      let text;
      try { text = await res.text(); } catch (e) {
        throw new ApiError(e.name === 'AbortError' ? 'El servidor no respondió a tiempo (puede estar saturado).' : 'Se cortó la descarga.', true);
      }
      try { return JSON.parse(text); } catch { throw new ApiError('Respuesta no válida del servidor', true); }
    } finally {
      clearTimeout(timer);
    }
  }

  async login() {
    const d = await this.api(null, {}, { timeout: 30000, retries: 1 });
    if (!d?.user_info || String(d.user_info.auth) !== '1') throw new Error('Usuario o contraseña incorrectos');
    this.info = d;
    return d;
  }

  async categories(type, opt = {}) {
    const action = ACTIONS[type][0];
    let raw;
    try {
      raw = toArray(await this.api(action, {}, { timeout: 45000, retries: 2, ...opt }));
    } catch (e) {
      throw withStep(e, action);
    }
    if (!raw) throw withStep(new Error('Respuesta con formato inesperado'), action);
    return raw.filter(c => c && typeof c === 'object').map(c => ({ id: String(c.category_id), name: String(c.category_name ?? '') }));
  }

  // Items of one category, or of the whole section when catId is null.
  async streams(type, catId = null, opt = {}) {
    const action = ACTIONS[type][1];
    const raw = toArray(await this.api(action, catId == null ? {} : { category_id: catId }, opt));
    if (!raw) throw new Error('Respuesta con formato inesperado');
    return dedupe(type, raw, catId);
  }

  // Lists the whole section in one request; if that fails or comes back empty (huge list on a
  // struggling server), falls back to one lighter request per category.
  async fetchType(type, onProgress) {
    const itemAction = ACTIONS[type][1];
    const cats = await this.categories(type);
    let items, fullError = null;
    try {
      items = await this.streams(type, null, { timeout: 120000, retries: 1 });
      if (!items.length && cats.length) fullError = new Error('Lista completa vacía');
    } catch (e) {
      fullError = e;
    }
    this.diag = fullError ? `${itemAction}: ${fullError.message}` : '';
    if (fullError) {
      if (!cats.length) throw withStep(fullError, itemAction);
      const raw = [];
      let done = 0, ok = 0, lastErr = null;
      onProgress?.(0, cats.length);
      await pool(cats, 3, async c => {
        try {
          for (const x of await this.streams(type, c.id, { timeout: 60000, retries: 2 })) raw.push(x);
          ok++;
        } catch (e) { lastErr = e; }
        onProgress?.(++done, cats.length);
      });
      this.diag += ` · por carpetas: ${ok}/${cats.length} ok${lastErr ? ` (${lastErr.message})` : ''}`;
      if (!ok) throw withStep(lastErr || fullError, `${itemAction} (completa y por carpetas)`);
      items = merge(raw);
    }
    return { cats, items };
  }

  // Fallback for panels whose API returns no movies/series: the M3U playlist (get.php), which
  // apps like IPTVnator read. Downloaded once per session and shared by both sections.
  m3u(type = 'm3u_plus', output = 'ts') {
    this.m3uCache ||= new Map();
    const k = type + '|' + output;
    if (this.m3uCache.has(k)) return this.m3uCache.get(k);
    const q = new URLSearchParams({ username: this.username, password: this.password, type, output });
    const url = this.wrap(`${this.server}/get.php?${q}`);
    const promise = (async () => {
      let text;
      for (let n = 0; ; n++) {
        try { text = await this.requestText(url, 240000); break; } catch (e) {
          if (!e.retry || n >= 1) throw withStep(e, 'get.php (lista M3U)');
          await sleep(3000);
        }
      }
      const r = parseM3u(text);
      r.bytes = text.length;
      return r;
    })();
    this.m3uCache.set(k, promise);
    promise.catch(() => this.m3uCache.delete(k));
    return promise;
  }

  // Old Xtream API: every stream of the account (live, movies and sometimes series) in one call.
  async panelStreams(type) {
    const q = new URLSearchParams({ username: this.username, password: this.password });
    const d = await this.request(this.wrap(`${this.server}/panel_api.php?${q}`), 180000);
    const all = toArray(d?.available_channels) || [];
    const want = type === 'vod' ? /^movie$/i : /^series$/i;
    const list = all.filter(s => s && want.test(String(s.stream_type || '')));
    const cats = new Map();
    for (const s of list) cats.set(String(s.category_id ?? ''), { id: String(s.category_id ?? ''), name: String(s.category_name || 'Sin categoría') });
    return { cats: [...cats.values()], items: dedupe(type, list, null), total: all.length };
  }

  // Same account on another host (e.g. the address announced in server_info).
  withServer(server) {
    const x = new Xtream({ server, username: this.username, password: this.password, proxy: this.proxy });
    x.info = this.info;
    return x;
  }

  // The host the panel says it serves from, when it differs from the one typed in.
  announcedServer() {
    const si = this.info?.server_info;
    if (!si?.url) return null;
    const proto = (si.server_protocol || location.protocol.replace(':', '')).toLowerCase() === 'https' ? 'https' : 'http';
    const port = proto === 'https' ? si.https_port : si.port;
    const def = proto === 'https' ? '443' : '80';
    const server = `${proto}://${si.url}${port && String(port) !== def ? ':' + port : ''}`;
    return server.replace(/\/+$/, '') === this.server.replace(/\/+$/, '') ? null : server;
  }

  async requestText(url, timeout) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      let res;
      try { res = await fetch(url, { signal: ctl.signal, cache: 'no-store' }); } catch (e) {
        throw new ApiError(e.name === 'AbortError' ? 'El servidor no respondió a tiempo.' : 'No se pudo conectar con el servidor.', true);
      }
      if (!res.ok) throw new ApiError(`El servidor respondió HTTP ${res.status}`, res.status >= 500 || res.status === 429);
      try { return await res.text(); } catch { throw new ApiError('Se cortó la descarga.', true); }
    } finally {
      clearTimeout(timer);
    }
  }

  // Diagnostics: time, size and item count of one API call.
  async probe(action, extra = {}, timeout = 120000, { post = false } = {}) {
    const q = new URLSearchParams({ username: this.username, password: this.password, ...extra });
    if (action && action !== 'm3u') q.set('action', action);
    q.set('_', Date.now().toString(36));
    const page = action === 'm3u' ? 'get.php' : 'player_api.php';
    const t0 = performance.now();
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeout);
      const res = await fetch(this.wrap(post ? `${this.server}/${page}` : `${this.server}/${page}?${q}`),
        { signal: ctl.signal, cache: 'no-store', ...(post ? { method: 'POST', body: q } : {}) });
      const text = await res.text();
      clearTimeout(timer);
      const ms = Math.round(performance.now() - t0);
      let count = '?';
      try { const j = JSON.parse(text); const a = toArray(j); count = a ? a.length : (j && typeof j === 'object' ? 'objeto' : typeof j); } catch { count = 'no es JSON'; }
      if (action === 'm3u') {
        const n = k => (text.match(new RegExp(`/${k}/`, 'g')) || []).length;
        count = `${n('live')} directo, ${n('movie')} pelis, ${n('series')} episodios`;
      }
      // Readable headers (CORS) that tell whether a cache answered, plus the start of an empty/odd body.
      const h = ['cache-control', 'expires', 'last-modified', 'content-type'].map(k => res.headers.get(k) && `${k}: ${res.headers.get(k)}`).filter(Boolean);
      const odd = action !== 'm3u' && (count === 0 || typeof count === 'string');
      return `HTTP ${res.status} · ${ms} ms · ${fmtBytes(text.length)} · ${count}` +
        (odd ? ` · respuesta: ${JSON.stringify(text.slice(0, 120))}${h.length ? ' · ' + h.join(' · ') : ''}` : '');
    } catch (e) {
      return `ERROR ${e.name === 'AbortError' ? 'tiempo agotado' : e.message} · ${Math.round(performance.now() - t0)} ms`;
    }
  }

  seriesInfo(id) {
    return this.api('get_series_info', { series_id: id }, { timeout: 45000, retries: 2 });
  }

  async shortEpg(id, limit = 4) {
    const d = await this.api('get_short_epg', { stream_id: id, limit }, { timeout: 20000, retries: 0 });
    return (d?.epg_listings || []).map(l => ({
      title: b64(l.title),
      desc: b64(l.description),
      start: +l.start_timestamp || Date.parse(l.start) / 1000 || 0,
      end: +l.stop_timestamp || Date.parse(l.end || l.stop) / 1000 || 0,
    })).filter(p => p.start && p.end).sort((a, b) => a.start - b.start);
  }

  // The provider's whole guide (XMLTV) as text; few panels fill it, but it names the channels
  // exactly like the list.
  xmltv() {
    const q = new URLSearchParams({ username: this.username, password: this.password });
    return this.requestText(this.wrap(`${this.server}/xmltv.php?${q}`), 120000);
  }

  // Full guide of a channel (past and future), with has_archive per programme.
  async epgTable(id) {
    const d = await this.api('get_simple_data_table', { stream_id: id }, { timeout: 30000, retries: 1 });
    return (d?.epg_listings || []).map(l => ({
      title: b64(l.title),
      desc: b64(l.description),
      start: +l.start_timestamp || Date.parse(l.start) / 1000 || 0,
      end: +l.stop_timestamp || Date.parse(l.end || l.stop) / 1000 || 0,
      archive: String(l.has_archive) === '1',
    })).filter(p => p.start && p.end).sort((a, b) => a.start - b.start);
  }

  // Catch-up: the provider's recording of channel `id` from `start` (unix s) for `minutes`.
  // The start time is written in the server's timezone (+ an optional manual shift in hours).
  timeshift(id, start, minutes, shiftHours = 0) {
    const t = formatTs(start + shiftHours * 3600, this.info?.server_info?.timezone);
    const u = encodeURIComponent(this.username), p = encodeURIComponent(this.password);
    const m = Math.max(1, Math.ceil(minutes));
    const q = new URLSearchParams({ username: this.username, password: this.password, stream: id, start: t, duration: m });
    return [
      ['mpegts', this.wrap(`${this.server}/timeshift/${u}/${p}/${m}/${t}/${id}.ts`)],
      ['mpegts', this.wrap(`${this.server}/streaming/timeshift.php?${q}`)],
      ['hls', this.wrap(`${this.server}/timeshift/${u}/${p}/${m}/${t}/${id}.m3u8`)],
    ];
  }

  path(kind, id, ext) {
    const u = encodeURIComponent(this.username), p = encodeURIComponent(this.password);
    return this.wrap(`${this.server}/${kind}/${u}/${p}/${id}.${ext}`);
  }

  liveFormats() {
    const allowed = this.info?.user_info?.allowed_output_formats || [];
    const order = ['m3u8', 'ts'];
    const f = allowed.length ? order.filter(x => allowed.includes(x)) : order;
    return f.length ? f : order;
  }
}

// Some panels answer with {"0": {...}, "1": {...}} instead of an array.
function toArray(x) {
  if (Array.isArray(x)) return x;
  if (x && typeof x === 'object' && !('user_info' in x) && !('error' in x)) {
    const v = Object.values(x);
    if (v.every(e => e && typeof e === 'object')) return v;
  }
  return null;
}

// M3U → { vod: {cats, items}, series: {cats, items} }. Movies and episodes are told apart by
// their URL (/movie/ or /series/); episodes are grouped into series by name ("Show S01 E02").
export function parseM3u(text) {
  const out = { vod: { cats: new Map(), items: [] }, series: { cats: new Map(), items: new Map() } };
  const lines = text.split(/\r?\n/);
  let inf = null, order = 0, live = 0;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith('#EXTINF')) { inf = line; continue; }
    if (!line || line.startsWith('#') || !inf) continue;
    const m = /\/(movie|series)\/[^/]+\/[^/]+\/([^/?#]+?)\.([a-z0-9]+)(?:[?#]|$)/i.exec(line);
    const attrs = {};
    for (const a of inf.matchAll(/([\w-]+)="([^"]*)"/g)) attrs[a[1].toLowerCase()] = a[2];
    const name = (attrs['tvg-name'] || inf.slice(inf.lastIndexOf(',') + 1)).trim() || inf.slice(inf.lastIndexOf(',') + 1).trim();
    const group = attrs['group-title'] || 'Sin categoría';
    inf = null;
    if (!m) { live++; continue; }
    const kind = m[1].toLowerCase() === 'movie' ? 'vod' : 'series';
    const sec = out[kind];
    const catId = 'm3u:' + group;
    sec.cats.set(catId, { id: catId, name: group });
    const adult = /^1$/.test(attrs['is-adult'] || '');
    // Playlist order stands in for the date (later entries are usually newer).
    order++;
    if (kind === 'vod') {
      sec.items.push({ id: m[2], name, icon: attrs['tvg-logo'] || '', cats: [catId], added: order, ext: m[3], url: line, adult, noDate: true });
      continue;
    }
    const e = /^(.*?)[\s._-]*\bS(\d{1,3})[\s._-]*E(\d{1,4})\b(.*)$/i.exec(name);
    const show = (e ? e[1] : name).replace(/[\s._-]+$/, '') || name;
    const season = e ? String(+e[2]) : '1';
    let it = sec.items.get(show);
    if (!it) {
      it = { id: 'm3u:' + show, name: show, icon: attrs['tvg-logo'] || '', cats: [catId], added: order, adult, noDate: true, episodes: {} };
      sec.items.set(show, it);
    }
    if (!it.cats.includes(catId)) it.cats.push(catId);
    it.added = order;
    (it.episodes[season] ||= []).push({
      id: m[2], episode_num: e ? +e[3] : it.episodes[season].length + 1, title: (e && e[4].replace(/^[\s._-]+/, '')) || name,
      container_extension: m[3], url: line,
    });
  }
  for (const it of out.series.items.values()) {
    for (const k in it.episodes) it.episodes[k].sort((a, b) => a.episode_num - b.episode_num);
  }
  return {
    live,
    vod: { cats: [...out.vod.cats.values()], items: merge(out.vod.items) },
    series: { cats: [...out.series.cats.values()], items: [...out.series.items.values()] },
  };
}

function dedupe(type, raw, catId) {
  const out = [];
  for (const s of raw) {
    if (!s || typeof s !== 'object') continue;
    const it = normalize(type, s);
    if (!it.id || it.id === 'undefined') continue;
    if (catId != null && !it.cats.includes(String(catId))) it.cats.push(String(catId));
    out.push(it);
  }
  return merge(out);
}

// One entry per id, with the union of its categories.
function merge(items) {
  const seen = new Map();
  for (const it of items) {
    const prev = seen.get(it.id);
    if (prev) { for (const c of it.cats) if (!prev.cats.includes(c)) prev.cats.push(c); }
    else seen.set(it.id, it);
  }
  return [...seen.values()];
}

const fmtBytes = n => n > 1e6 ? (n / 1e6).toFixed(1) + ' MB' : Math.round(n / 1e3) + ' KB';

function withStep(e, step) {
  const err = new Error(e.message);
  err.detail = step;
  return err;
}

async function pool(list, n, fn) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
    while (i < list.length) await fn(list[i++]);
  }));
}

function b64(s) {
  if (!s) return '';
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(s), c => c.charCodeAt(0)));
  } catch {
    return String(s);
  }
}

// "YYYY-MM-DD:HH-MM" in the given timezone (local time if unknown).
function formatTs(sec, tz) {
  const opt = { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' };
  let f;
  try { f = new Intl.DateTimeFormat('en-CA', { ...opt, timeZone: tz || undefined }); } catch { f = new Intl.DateTimeFormat('en-CA', opt); }
  const v = Object.fromEntries(f.formatToParts(new Date(sec * 1000)).map(x => [x.type, x.value]));
  return `${v.year}-${v.month}-${v.day}:${v.hour === '24' ? '00' : v.hour}-${v.minute}`;
}

function catIds(s) {
  if (Array.isArray(s.category_ids) && s.category_ids.length) return s.category_ids.map(String);
  return [String(s.category_id ?? '')];
}

function normalize(type, s) {
  const adult = String(s.is_adult) === '1';
  if (type === 'series') {
    return {
      id: String(s.series_id),
      name: String(s.name ?? ''),
      icon: s.cover || '',
      cats: catIds(s),
      added: +s.last_modified || (Date.parse(s.releaseDate || s.release_date) / 1000) || 0,
      rating: s.rating || '',
      adult,
    };
  }
  const it = {
    id: String(s.stream_id),
    name: String(s.name ?? ''),
    icon: s.stream_icon || '',
    cats: catIds(s),
    added: +s.added || 0,
    adult,
  };
  if (type === 'live') it.archive = String(s.tv_archive) === '1' ? (+s.tv_archive_duration || 1) : 0;   // days of catch-up
  if (type === 'vod') {
    it.ext = s.container_extension || 'mp4';
    it.rating = s.rating || '';
  }
  return it;
}
