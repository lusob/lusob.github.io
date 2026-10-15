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

  async api(action, extra = {}, { timeout = 45000, retries = 2 } = {}) {
    const q = new URLSearchParams({ username: this.username, password: this.password, ...extra });
    if (action) q.set('action', action);
    const url = this.wrap(`${this.server}/player_api.php?${q}`);
    for (let n = 0; ; n++) {
      try {
        return await this.request(url, timeout);
      } catch (e) {
        if (!e.retry || n >= retries) throw e;
        await sleep(2000 * (n + 1));
      }
    }
  }

  async request(url, timeout) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeout);
    try {
      let res;
      try {
        res = await fetch(url, { signal: ctl.signal });
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

  async categories(type) {
    const action = ACTIONS[type][0];
    let raw;
    try {
      raw = toArray(await this.api(action, {}, { timeout: 45000, retries: 2 }));
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

  // Diagnostics: time, size and item count of one API call.
  async probe(action, extra = {}, timeout = 120000) {
    const q = new URLSearchParams({ username: this.username, password: this.password, ...extra });
    if (action) q.set('action', action);
    const t0 = performance.now();
    try {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeout);
      const res = await fetch(this.wrap(`${this.server}/player_api.php?${q}`), { signal: ctl.signal });
      const text = await res.text();
      clearTimeout(timer);
      const ms = Math.round(performance.now() - t0);
      let count = '?';
      try { const j = JSON.parse(text); const a = toArray(j); count = a ? a.length : (j && typeof j === 'object' ? 'objeto' : typeof j); } catch { count = 'no es JSON'; }
      return `HTTP ${res.status} · ${ms} ms · ${fmtBytes(text.length)} · ${count}`;
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
