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

  // Lists the whole section in one request; if that fails or comes back empty (huge list on a
  // struggling server), falls back to one lighter request per category.
  async fetchType(type, onProgress) {
    const [catAction, itemAction] = ACTIONS[type];
    let rawCats;
    try {
      rawCats = toArray(await this.api(catAction));
    } catch (e) {
      throw withStep(e, `${catAction}`);
    }
    const cats = (rawCats || []).map(c => ({ id: String(c.category_id), name: String(c.category_name ?? '') }));
    let raw, fullError = null;
    try {
      raw = toArray(await this.api(itemAction, {}, { timeout: 120000, retries: 1 }));
      if (!raw) fullError = new Error('Respuesta con formato inesperado');
      else if (!raw.length && cats.length) fullError = new Error('Lista completa vacía');
    } catch (e) {
      fullError = e;
    }
    this.diag = fullError ? `${itemAction}: ${fullError.message}` : '';
    if (fullError) {
      if (!cats.length) throw withStep(fullError, itemAction);
      raw = [];
      let done = 0, ok = 0, lastErr = null;
      onProgress?.(0, cats.length);
      await pool(cats, 3, async c => {
        try {
          const r = toArray(await this.api(itemAction, { category_id: c.id }, { timeout: 60000, retries: 2 }));
          if (r) { for (const x of r) raw.push(x); ok++; }
        } catch (e) { lastErr = e; }
        onProgress?.(++done, cats.length);
      });
      this.diag += ` · por carpetas: ${ok}/${cats.length} ok${lastErr ? ` (${lastErr.message})` : ''}`;
      if (!ok) throw withStep(lastErr || fullError, `${itemAction} (completa y por carpetas)`);
    }
    const seen = new Map();
    for (const s of raw) {
      if (!s || typeof s !== 'object') continue;
      const it = normalize(type, s);
      if (!it.id || it.id === 'undefined') continue;
      const prev = seen.get(it.id);
      if (prev) { for (const c of it.cats) if (!prev.cats.includes(c)) prev.cats.push(c); }
      else seen.set(it.id, it);
    }
    return { cats, items: [...seen.values()] };
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
  if (type === 'vod') {
    it.ext = s.container_extension || 'mp4';
    it.rating = s.rating || '';
  }
  return it;
}
