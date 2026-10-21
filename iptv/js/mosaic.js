// Channel mosaic for accounts with a single connection: one <video> visits the tiles one by one,
// plays each channel for a moment (1 s by default), leaves a snapshot behind and moves on.
// Only one stream is ever open. No pages: with few channels the tiles fill the pane, with many
// they shrink to a comfortable minimum and the grid scrolls; tiles on screen are scanned first.
// Channels without signal can be hidden.

import { startEngine, resetVideo } from './engines.js?v=20261021b';
import { esc, initials } from './ui.js?v=20261021b';

const LOAD_TIMEOUT = 20;     // s to get a picture before marking the channel as "no signal"
const GAP = 600;             // ms between streams so the server frees the connection
const MIN_W = 240;           // smallest tile width (px) before the grid starts scrolling
const GAP_PX = 8;
const RETRY_DEAD = 10 * 60e3; // re-check channels without signal after this long

export class Mosaic {
  // opt: { getSettings, attempts(item), onOpen(items, index), info(item) → html, onVisible(items), onStats({dead, total}) }
  constructor(el, opt) {
    this.el = el;
    this.opt = opt;
    this.items = [];
    this.token = 0;
    this.running = false;
    this.hideDead = false;
    this.shots = new Map();   // item id → { canvas, at, failed, tried }
    this.visible = new Set(); // indexes of tiles on screen
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.className = 'm-video';
    el.addEventListener('click', e => {
      const t = e.target.closest('[data-i]');
      if (t) this.opt.onOpen(this.items, +t.dataset.i);
    });
    new ResizeObserver(() => { if (!this.el.hidden) this.fit(); }).observe(el);
    this.io = new IntersectionObserver(entries => {
      for (const e of entries) {
        const i = +e.target.dataset.i;
        if (e.isIntersecting) this.visible.add(i); else this.visible.delete(i);
      }
      clearTimeout(this.visTimer);
      this.visTimer = setTimeout(() => this.opt.onVisible?.([...this.visible].map(i => this.items[i]).filter(Boolean)), 300);
    }, { root: el });
    this.ageTimer = setInterval(() => this.stamp(), 30000);
  }

  show(items) {
    this.stop();
    this.items = items;
    this.visible.clear();
    this.io.disconnect();
    this.el.scrollTop = 0;
    this.el.innerHTML = `<div class="m-grid${this.hideDead ? ' hide-dead' : ''}">${items.map((it, i) => `
      <div class="tile" data-i="${i}">
        <div class="m-screen"><span class="m-ph">${initials(it.name)}</span></div>
        <div class="m-label"><div class="name">${esc(it.name)}</div><div class="meta m-info"></div></div>
        <span class="m-state"></span>
      </div>`).join('')}</div>`;
    this.grid = this.el.firstElementChild;
    items.forEach((it, i) => {
      const t = this.tile(i);
      this.io.observe(t);
      const shot = this.shots.get(it.id);
      if (shot?.at) { t.querySelector('.m-screen').appendChild(shot.canvas); t.classList.add('shot'); }
      if (shot?.failed && !shot.at) t.classList.add('dead');
    });
    this.fit();
    this.stamp();
    this.refreshInfo();
    this.stats();
    this.resume();
  }

  hide() {
    this.stop();
  }

  setHideDead(on) {
    this.hideDead = on;
    this.grid?.classList.toggle('hide-dead', on);
    this.fit();
  }

  // Few tiles: the grid shape that makes them as large as possible (16:9) and fills the pane.
  // Many tiles: as many columns of at least MIN_W as fit, 16:9 rows, vertical scroll.
  fit() {
    const grid = this.grid;
    if (!grid) return;
    const n = this.hideDead ? grid.querySelectorAll('.tile:not(.dead)').length : this.items.length;
    const w = this.el.clientWidth - GAP_PX * 2, h = this.el.clientHeight - GAP_PX * 2;
    if (!n || w <= 0 || h <= 0) return;
    let best = { c: 1, r: n, score: -1, tw: 0 };
    for (let c = 1; c <= n; c++) {
      const r = Math.ceil(n / c);
      const tw = (w - GAP_PX * (c - 1)) / c, th = (h - GAP_PX * (r - 1)) / r;
      const size = Math.min(tw, th * 16 / 9);
      const score = size - (r * c - n) * 0.5;   // big pictures, few empty cells
      if (score > best.score) best = { c, r, score, tw: size };
    }
    if (best.tw >= MIN_W) {
      grid.classList.remove('scroll');
      grid.style.gridTemplateColumns = `repeat(${best.c}, 1fr)`;
      grid.style.gridTemplateRows = `repeat(${best.r}, 1fr)`;
      grid.style.gridAutoRows = '';
    } else {
      const c = Math.max(1, Math.floor((w + GAP_PX) / (MIN_W + GAP_PX)));
      const tw = (w - GAP_PX * (c - 1)) / c;
      grid.classList.add('scroll');
      grid.style.gridTemplateColumns = `repeat(${c}, 1fr)`;
      grid.style.gridTemplateRows = '';
      grid.style.gridAutoRows = `${Math.round(tw * 9 / 16)}px`;
    }
  }

  tile(i) { return this.grid?.children[i]; }

  refreshInfo(item) {
    this.items.forEach((it, i) => {
      if (item && it !== item) return;
      const el = this.tile(i)?.querySelector('.m-info');
      if (el) el.innerHTML = this.opt.info(it);
    });
  }

  stats() {
    let dead = 0;
    for (const it of this.items) { const s = this.shots.get(it.id); if (s?.failed && !s.at) dead++; }
    this.opt.onStats?.({ dead, total: this.items.length });
  }

  resume() {
    if (this.running || !this.items.length || this.el.hidden) return;
    this.running = true;
    this.next();
  }

  // Releases the connection immediately (before the full player opens).
  stop() {
    this.running = false;
    this.token++;
    this.release();
    this.cur = null;
  }

  release() {
    clearTimeout(this.timer);
    this.engine?.destroy();
    this.engine = null;
    resetVideo(this.video);
    this.video.remove();
    this.el.querySelector('.tile.scanning')?.classList.remove('scanning');
  }

  // Next tile: on-screen tiles never captured, then off-screen ones never tried (in order),
  // then the on-screen capture that is oldest; dead channels are re-checked now and then.
  pick() {
    const n = this.items.length;
    if (!n) return null;
    const now = Date.now();
    const shown = i => !(this.hideDead && this.tile(i)?.classList.contains('dead'));
    const fresh = i => !this.shots.has(this.items[i].id);
    const vis = [...this.visible].filter(i => i < n).sort((a, b) => a - b);
    const first = vis.find(i => fresh(i));
    if (first != null) return first;
    for (let k = 0; k < n; k++) if (fresh(k)) return k;
    let best = null, bestAt = Infinity;
    for (const k of vis.length ? vis : [...Array(n).keys()]) {
      const s = this.shots.get(this.items[k].id);
      const at = s.at || (now - s.tried > RETRY_DEAD ? s.tried : Infinity);
      if (shown(k) && at < bestAt) { best = k; bestAt = at; }
    }
    return best;
  }

  next() {
    if (!this.running) return;
    const prev = this.cur;
    this.release();
    this.cur = null;
    const i = this.opt.canScan && !this.opt.canScan() ? null : this.pick();
    const tok = ++this.token;
    if (i == null) {
      // Nothing to do right now (e.g. every channel on screen is dead and hidden): look again later.
      this.timer = setTimeout(() => { if (tok === this.token) this.next(); }, 5000);
      return;
    }
    this.cur = i;
    this.timer = setTimeout(() => { if (tok === this.token) this.scan(i, tok, 0); }, prev == null ? 0 : GAP);
  }

  scan(i, tok, a) {
    const item = this.items[i];
    const attempts = this.opt.attempts(item);
    const t = this.tile(i);
    if (!t || a >= attempts.length) return this.done(i, false);
    t.classList.add('scanning');
    t.querySelector('.m-state').textContent = 'Cargando…';
    const v = this.video;
    t.querySelector('.m-screen').appendChild(v);
    let shown = false;
    const fail = () => {
      if (tok !== this.token || shown) return;
      clearTimeout(this.timer);
      this.engine?.destroy();
      resetVideo(v);
      this.scan(i, tok, a + 1);
    };
    const [engine, url] = attempts[a];
    this.engine = startEngine(v, engine, url, { light: true }, fail);
    clearTimeout(this.timer);
    this.timer = setTimeout(fail, LOAD_TIMEOUT * 1000);
    const onFrame = () => {
      if (tok !== this.token || shown || v.currentTime <= 0.1) return;
      shown = true;
      v.removeEventListener('timeupdate', onFrame);
      t.querySelector('.m-state').textContent = '● En directo';
      clearTimeout(this.timer);
      const dwell = Math.max(1, +this.opt.getSettings().scan || 1);
      this.timer = setTimeout(() => { if (tok === this.token) this.done(i, true); }, dwell * 1000);
    };
    v.addEventListener('timeupdate', onFrame);
  }

  done(i, ok) {
    const t = this.tile(i);
    const item = this.items[i];
    const shot = this.shots.get(item.id) || { canvas: document.createElement('canvas'), at: 0 };
    this.shots.set(item.id, shot);
    shot.tried = Date.now();
    if (t) {
      const v = this.video;
      if (ok && v.videoWidth) {
        const screen = t.querySelector('.m-screen');
        if (shot.canvas.parentNode !== screen) screen.appendChild(shot.canvas);
        const c = shot.canvas;
        c.width = 480;
        c.height = Math.round(480 * v.videoHeight / v.videoWidth) || 270;
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        shot.at = Date.now();
        shot.failed = false;
        t.classList.add('shot');
      } else if (!ok) {
        shot.failed = true;
        shot.at = 0;
        shot.canvas.remove();
        t.classList.remove('shot');
      }
      const wasDead = t.classList.contains('dead');
      t.classList.toggle('dead', !!shot.failed && !shot.at);
      t.classList.remove('scanning');
      if (wasDead !== t.classList.contains('dead')) { if (this.hideDead) this.fit(); this.stats(); }
    }
    this.stamp(i);
    this.next();
  }

  // Age label on each tile ("hace 2 min" / "Sin señal").
  stamp(only = null) {
    this.items.forEach((it, i) => {
      if (only != null && i !== only) return;
      const t = this.tile(i);
      if (!t || t.classList.contains('scanning')) return;
      const shot = this.shots.get(it.id);
      const el = t.querySelector('.m-state');
      if (!shot) el.textContent = '';
      else if (!shot.at) el.textContent = 'Sin señal';
      else {
        const s = Math.round((Date.now() - shot.at) / 1000);
        el.textContent = s < 60 ? 'hace un momento' : `hace ${Math.round(s / 60)} min`;
      }
    });
  }
}
