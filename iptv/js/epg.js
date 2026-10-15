// Now/next EPG via get_short_epg, fetched lazily for what is on screen
// (few concurrent requests, newest request wins, cached until the current programme ends).

const CONCURRENCY = 3;
const EMPTY_TTL = 30 * 60e3;

export class Epg {
  constructor(api, onUpdate) {
    this.api = api;
    this.onUpdate = onUpdate;   // (id) => void
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

  // Replace the waiting queue with these ids (the ones currently visible).
  want(ids, priority = false) {
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

export const hhmm = sec => new Date(sec * 1000).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
