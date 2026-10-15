// Minimal Xtream Codes API client.

const ACTIONS = {
  live:   ['get_live_categories',   'get_live_streams'],
  vod:    ['get_vod_categories',    'get_vod_streams'],
  series: ['get_series_categories', 'get_series'],
};

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

  async api(action, extra = {}) {
    const q = new URLSearchParams({ username: this.username, password: this.password, ...extra });
    if (action) q.set('action', action);
    const url = `${this.server}/player_api.php?${q}`;
    let res;
    try {
      res = await fetch(this.wrap(url));
    } catch {
      throw new Error(isMixedContent(this.server, this.proxy)
        ? 'El navegador bloquea servidores http:// desde una página https://. Configura un proxy (Avanzado).'
        : 'No se pudo conectar con el servidor (¿caído o sin CORS?). Prueba a configurar un proxy.');
    }
    if (!res.ok) throw new Error(`El servidor respondió HTTP ${res.status}`);
    const text = await res.text();
    try { return JSON.parse(text); } catch { throw new Error('Respuesta no válida del servidor'); }
  }

  async login() {
    const d = await this.api();
    if (!d?.user_info || String(d.user_info.auth) !== '1') throw new Error('Usuario o contraseña incorrectos');
    this.info = d;
    return d;
  }

  async fetchType(type) {
    const [catAction, itemAction] = ACTIONS[type];
    const [cats, items] = await Promise.all([this.api(catAction), this.api(itemAction)]);
    return {
      cats: (Array.isArray(cats) ? cats : []).map(c => ({ id: String(c.category_id), name: String(c.category_name ?? '') })),
      items: (Array.isArray(items) ? items : []).map(s => normalize(type, s)),
    };
  }

  seriesInfo(id) {
    return this.api('get_series_info', { series_id: id });
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

function catIds(s) {
  if (Array.isArray(s.category_ids) && s.category_ids.length) return s.category_ids.map(String);
  return [String(s.category_id ?? '')];
}

function normalize(type, s) {
  if (type === 'series') {
    return {
      id: String(s.series_id),
      name: String(s.name ?? ''),
      icon: s.cover || '',
      cats: catIds(s),
      added: +s.last_modified || (Date.parse(s.releaseDate || s.release_date) / 1000) || 0,
      rating: s.rating || '',
    };
  }
  const it = {
    id: String(s.stream_id),
    name: String(s.name ?? ''),
    icon: s.stream_icon || '',
    cats: catIds(s),
    added: +s.added || 0,
  };
  if (type === 'vod') {
    it.ext = s.container_extension || 'mp4';
    it.rating = s.rating || '';
  }
  return it;
}
