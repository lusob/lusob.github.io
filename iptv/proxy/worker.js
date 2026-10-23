// CORS / HTTPS proxy for the IPTV player.
// Usage: https://<worker>/?url=<encoded target URL>
//
// - Adds CORS headers so the page (served over HTTPS) can read http:// Xtream servers.
// - Rewrites URLs inside .m3u8 playlists so segments also go through the proxy.
// - Forwards Range headers (seeking in movies/series).
//
// Optional environment variables:
//   ALLOWED_ORIGINS  comma separated, e.g. "https://lusob.github.io"  (recommended, avoids abuse)
//   ALLOWED_HOSTS    comma separated target hosts, e.g. "mi-proveedor.com:8080"

export default {
  async fetch(request, env = {}) {
    const origin = request.headers.get('Origin') || '';
    const allowedOrigins = list(env.ALLOWED_ORIGINS);
    if (allowedOrigins.length && origin && !allowedOrigins.includes(origin)) {
      return new Response('Origin not allowed', { status: 403 });
    }
    const cors = {
      'Access-Control-Allow-Origin': origin || '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range, Content-Type',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type',
      'Vary': 'Origin',
    };
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    const self = new URL(request.url);
    const target = self.searchParams.get('url');
    let targetUrl;
    try { targetUrl = new URL(target); } catch { return new Response('Missing or invalid ?url=', { status: 400, headers: cors }); }
    if (!/^https?:$/.test(targetUrl.protocol)) return new Response('Bad protocol', { status: 400, headers: cors });
    const allowedHosts = list(env.ALLOWED_HOSTS);
    if (allowedHosts.length && !allowedHosts.includes(targetUrl.host)) {
      return new Response('Host not allowed', { status: 403, headers: cors });
    }

    const headers = new Headers({ 'User-Agent': 'VLC/3.0.20 LibVLC/3.0.20' });
    const range = request.headers.get('Range');
    if (range) headers.set('Range', range);

    let upstream;
    try {
      upstream = await fetch(targetUrl.toString(), { method: request.method, headers, redirect: 'follow' });
    } catch (e) {
      return new Response('Upstream error: ' + e.message, { status: 502, headers: cors });
    }

    const finalUrl = upstream.url || targetUrl.toString();
    const type = upstream.headers.get('Content-Type') || '';
    const isPlaylist = /mpegurl/i.test(type) || /\.m3u8$/i.test(new URL(finalUrl).pathname);

    if (isPlaylist && request.method === 'GET' && upstream.ok) {
      const base = `${self.origin}${self.pathname}?url=`;
      const wrap = u => base + encodeURIComponent(new URL(u, finalUrl).toString());
      const body = (await upstream.text())
        .split('\n')
        .map(line => {
          const l = line.trim();
          if (!l) return line;
          if (l.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${wrap(u)}"`);
          return wrap(l);
        })
        .join('\n');
      return new Response(body, {
        status: upstream.status,
        headers: { ...cors, 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache' },
      });
    }

    const out = new Headers();
    for (const h of ['Content-Type', 'Content-Length', 'Content-Range', 'Accept-Ranges', 'Cache-Control', 'Last-Modified', 'ETag']) {
      const v = upstream.headers.get(h);
      if (v) out.set(h, v);
    }
    for (const [k, v] of Object.entries(cors)) out.set(k, v);
    return new Response(upstream.body, { status: upstream.status, headers: out });
  },
};

function list(v) {
  return String(v || '').split(',').map(s => s.trim()).filter(Boolean);
}
