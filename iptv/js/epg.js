// Now/next EPG. Most panels tag very few channels, so the guide comes, by channel name, from:
//  1. epg.json: the public Spanish guide (EPG_dobleM) (Movistar+, DAZN, TDT…), built daily by tools/epg.py;
//  2. the provider's xmltv.php (same names as the list);
//  3. get_short_epg per channel, fetched lazily for what is on screen
//     (few concurrent requests, newest request wins, cached until the current programme ends).

import { channelKey, isForeign } from './backups.js?v=20261023a';

const CONCURRENCY = 3;
// Daily by .github/workflows/epg.yml in lusob.github.io (tools/epg.py), on a branch of its own.
const GUIDE_BASE = 'https://raw.githubusercontent.com/lusob/lusob.github.io/epg/';
const GUIDE_URL = GUIDE_BASE + 'epg.json';
const EMPTY_TTL = 30 * 60e3;
// A match in a guide: "Granada CF - Cádiz CF", "Celtics @ Pistons", "Lakers vs. Suns", "Betis v Celta"…
const VERSUS = / (-|–|@|vs\.?|v|x) /i;
export const MATCH_EARLY = 45 * 60;
// …but not trailers, summaries or goals
const NOT_MATCH = / (proximo|resumen|resumenes|previa|highlights|mejores|goles|jugadas) /;
const WOMEN = /femenin|women|\bfem\b|\bf\.? /;

// Programme pictures of epg.json, shortened by tools/epg.py: "m<id>" Movistar+ (its 1920×1080
// still), "o<n>" Orange TV poster, "s<path>" Sincroguía, or a URL.
const ART = {
  m: id => `https://www.movistarplus.es/recorte/n/ficha/${id}`,
  o: n => `https://orangetv.orange.es/pc/api/rtv/v1/images/epg/VERTICAL/VERTICAL_${n}.jpg`,
  s: path => `https://cdn.sincroguia.tv/storage/${path}`,
};
const artSrc = code => !code ? '' : /^https?:/.test(code) ? code : ART[code[0]]?.(code.slice(1)) || '';
// Resized and cropped to w×h by images.weserv.nl (an open-source image proxy): a few KB instead
// of a 1920×1080 JPEG, which TV browsers would also have to decode in full.
export const artUrl = (src, w, h) => src ? `https://images.weserv.nl/?url=${encodeURIComponent(src)}&w=${w}&h=${h}&fit=cover&a=attention&output=jpg&q=72` : '';

export class Epg {
  constructor(api, onUpdate, nameOf) {
    this.api = api;
    this.onUpdate = onUpdate;   // (id) => void
    this.nameOf = nameOf;       // id → channel name
    this.cache = new Map();     // id → { list, exp }
    this.pending = new Set();
    this.queue = [];
    this.active = 0;
  }

  // { now, next, progress } or null if not loaded yet.
  get(id) {
    const e = this.cache.get(id);
    if (!e) return null;
    const t = Date.now() / 1000;
    const now = e.list.find(p => p.start <= t && t < p.end) || null;
    const next = e.list.find(p => p.start >= (now ? now.end : t)) || null;
    return { now, next, progress: now ? (t - now.start) / (now.end - now.start) : 0 };
  }

  // Guides by name, loaded once: { pub: key → programmes, prov: key → programmes }.
  guides() {
    return this.guidesP ||= (async () => {
      const pub = new Map(), prov = new Map();
      try {
        const r = await fetch(GUIDE_URL);
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = await r.json();
        const imgs = (j.img || []).map(artSrc);
        this.updated = j.updated;
        for (const [ci, c] of j.ch.entries()) {
          const list = c.p.map(([a, m, title, img], pi) => ({ title, desc: '', img: img != null ? imgs[img] || '' : '', start: j.base + a * 60, end: j.base + (a + m) * 60, ci, pi }));
          for (const n of c.n) {
            const k = !isForeign(n) && channelKey(n);
            if (k && !pub.has(k)) pub.set(k, list);
          }
        }
      } catch (e) { console.warn('epg.json', e); }
      this.pub = pub;
      try {
        const x = await this.api.xmltv();
        const ids = new Map();
        for (const m of x.matchAll(/<channel id="([^"]*)"[^>]*>\s*<display-name[^>]*>([^<]*)/g)) ids.set(m[1], unxml(m[2]));
        const by = new Map();
        for (const m of x.matchAll(/<programme start="(\d{14}) ?([+-]\d{4})?" stop="(\d{14}) ?([+-]\d{4})?"[^>]*channel="([^"]*)"[^>]*>([\s\S]*?)<\/programme>/g)) {
          const t = /<title[^>]*>([\s\S]*?)<\/title>/.exec(m[6]);
          const d = /<desc[^>]*>([\s\S]*?)<\/desc>/.exec(m[6]);
          if (!by.has(m[5])) by.set(m[5], []);
          by.get(m[5]).push({ title: unxml(t?.[1] || ''), desc: unxml(d?.[1] || ''), start: xmlTs(m[1], m[2]), end: xmlTs(m[3], m[4]) });
        }
        for (const [id, name] of ids) {
          const k = channelKey(name), list = by.get(id);
          if (k && list?.length && !prov.has(k)) prov.set(k, list.sort((a, b) => a.start - b.start));
        }
      } catch (e) { console.warn('xmltv', e); }
      this.prov = prov;
      this.matchIdx = null;
    })();
  }

  // Synopsis and genre line of a programme: { desc, info } (the public guide keeps them in one
  // small file per channel, d/<channel>.json, fetched when first needed).
  async details(p) {
    if (!p) return { desc: '', info: '' };
    if (p.ci == null) return { desc: p.desc || '', info: '' };
    this.dFiles ||= new Map();
    if (!this.dFiles.has(p.ci)) this.dFiles.set(p.ci, fetch(`${GUIDE_BASE}d/${p.ci}.json?u=${this.updated || ''}`).then(r => r.ok ? r.json() : []).catch(() => []));
    const [desc = '', info = ''] = (await this.dFiles.get(p.ci))[p.pi] || [];
    return { desc, info };
  }

  // The whole guide of a channel by its name (public guide first), or null.
  byName(name) {
    if (!name) return null;
    const k = channelKey(name);
    return (!isForeign(name) && this.pub?.get(k)) || this.prov?.get(k) || null;
  }

  // Programmes of the match home–away in the guides (both teams in the title): [{ start, list, p }].
  matches(home, away) {
    if (!this.pub) return [];
    if (!this.matchIdx) {
      // Programmes that look like a match ("Granada CF - Cádiz CF"), not trailers or summaries.
      this.matchIdx = [];
      for (const map of [this.pub, this.prov || new Map()]) {
        for (const list of new Set(map.values())) {
          for (const p of list) {
            if (!VERSUS.test(p.title)) continue;
            const k = ' ' + norm(p.title).replace(/[^a-z0-9]+/g, ' ') + ' ';
            if (!NOT_MATCH.test(k)) this.matchIdx.push({ start: p.start, k, list, p });
          }
        }
      }
    }
    const ha = teamWords(home), aw = teamWords(away);
    if (!ha.length || !aw.length) return [];
    const has = (k, ws) => ws.some(w => k.includes(` ${w} `));
    // Women's match only with a women's programme, and the other way round
    const fem = WOMEN.test(' ' + norm(home + ' ' + away) + ' ');
    return this.matchIdx.filter(m => has(m.k, ha) && has(m.k, aw) && WOMEN.test(m.k) === fem);
  }

  // Guides that broadcast the match live, starting at about t (the broadcast may start up to
  // MATCH_EARLY before, with the build-up): [programme list], the agenda's own channel names
  // being often vague ("LaLiga TV M2").
  matchAt(t, home, away) {
    return [...new Set(this.matches(home, away).filter(m => Math.abs(m.start - t) <= MATCH_EARLY).map(m => m.list))];
  }

  // Programmes on now or later whose title contains q (already normalised), one channel per
  // guide (the best version among `items`), soonest first: [{ item, prog }].
  search(q, items, norm, max = 300) {
    if (!this.pub || q.length < 3) return [];
    this.names ||= new Map();
    const best = new Map();   // guide → item
    const score = n => (/\bsd\b/i.test(n) ? 0 : 2) + (/\bfhd\b|\bhd\b/i.test(n) ? 1 : 0);
    for (const it of items) {
      let l = this.names.get(it.name);
      if (l === undefined) this.names.set(it.name, l = this.byName(it.name));
      if (!l) continue;
      const cur = best.get(l);
      if (!cur || score(it.name) > score(cur.name)) best.set(l, it);
    }
    const now = Date.now() / 1000, out = [];
    for (const [l, item] of best) {
      for (const p of l) if (p.end > now && (p.k ??= norm(p.title)).includes(q)) out.push({ item, prog: p });
    }
    return out.sort((a, b) => a.prog.start - b.prog.start).slice(0, max);
  }

  async listFor(name) {
    await this.guides();
    return this.byName(name) || [];
  }

  // Replace the waiting queue with these ids (the ones currently visible).
  async want(ids, priority = false) {
    if (!this.pub) await this.guides();
    ids = ids.filter(id => {
      const e = this.cache.get(id);
      if (e && e.exp >= Date.now()) return true;
      const list = this.byName(this.nameOf?.(id));
      if (!list) return true;
      this.cache.set(id, { list, exp: Infinity });
      this.onUpdate(id);
      return false;
    });
    const fresh = ids.filter(id => {
      const e = this.cache.get(id);
      return !this.pending.has(id) && (!e || e.exp < Date.now());
    });
    this.queue = priority ? [...fresh, ...this.queue.filter(id => !fresh.includes(id))] : fresh;
    this.pump();
  }

  pump() {
    while (this.active < CONCURRENCY && this.queue.length) {
      const id = this.queue.shift();
      if (this.pending.has(id)) continue;
      this.pending.add(id);
      this.active++;
      this.api.shortEpg(id)
        .then(list => {
          const t = Date.now() / 1000;
          const now = list.find(p => p.start <= t && t < p.end);
          const exp = now ? now.end * 1000 : Date.now() + EMPTY_TTL;
          this.cache.set(id, { list, exp });
        }, () => this.cache.set(id, { list: [], exp: Date.now() + EMPTY_TTL }))
        .finally(() => {
          this.pending.delete(id);
          this.active--;
          this.onUpdate(id);
          this.pump();
        });
    }
  }

  clear() {
    this.cache.clear();
    this.queue = [];
  }
}

const unxml = s => s.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&(amp|lt|gt|quot|apos|#\d+);/g, (_, e) =>
  ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[e] || String.fromCharCode(+e.slice(1))).trim();

// "20261013001001", "+0200" → unix s
function xmlTs(t, tz) {
  const utc = Date.UTC(+t.slice(0, 4), +t.slice(4, 6) - 1, +t.slice(6, 8), +t.slice(8, 10), +t.slice(10, 12), +t.slice(12, 14)) / 1000;
  const off = tz ? (tz[0] === '-' ? -1 : 1) * (+tz.slice(1, 3) * 3600 + +tz.slice(3, 5) * 60) : 0;
  return utc - off;
}

const norm = s => String(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
// Distinctive words of a team name: "Real Oviedo" → oviedo, "AD Ceuta FC" → ceuta.
const GENERIC = new Set(['real', 'club', 'fc', 'cf', 'cd', 'ud', 'sd', 'ad', 'rcd', 'sad', 'cp', 'ca', 'de', 'del', 'la', 'el', 'los', 'las', 'b', 'c', 'balompie', 'futbol', 'f', 'femenino', 'academy', 'baloncesto', 'basket']);
const teamWords = name => norm(name || '').replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(w => w.length > 2 && !GENERIC.has(w));

export const hhmm = sec => new Date(sec * 1000).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
