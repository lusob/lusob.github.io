// Channel mosaic for accounts with a single connection: one <video> visits the tiles of the
// current page one by one, plays each channel for a few seconds, leaves a snapshot behind
// and moves on. Only one stream is ever open. Tiles always fill the available space:
// the page size follows the pane size and the grid shape follows the number of tiles.

import { startEngine, resetVideo } from './engines.js?v=20261016b';
import { esc, initials } from './ui.js?v=20261016b';

const LOAD_TIMEOUT = 25;   // s to get a picture before skipping the channel
const GAP = 700;           // ms between streams so the server frees the connection
const MIN_W = 300, MIN_H = 190;   // smallest comfortable tile (px)
const GAP_PX = 8;

export class Mosaic {
  // opt: { getSettings, attempts(item), onOpen(items, index), info(item) → html, onVisible(items), pager: {root, prev, next, label} }
  constructor(el, opt) {
    this.el = el;
    this.opt = opt;
    this.all = [];
    this.items = [];
    this.page = 0;
    this.perPage = 0;
    this.token = 0;
    this.running = false;
    this.shots = new Map();   // item id → { canvas, at }
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.className = 'm-video';
    el.addEventListener('click', e => {
      const t = e.target.closest('[data-i]');
      if (t) this.opt.onOpen(this.all, this.page * this.perPage + +t.dataset.i);
    });
    const { prev, next } = opt.pager;
    prev.onclick = () => this.goto(this.page - 1);
    next.onclick = () => this.goto(this.page + 1);
    new ResizeObserver(() => {
      if (this.el.hidden || !this.all.length) return;
      if (this.capacity() !== this.perPage) this.render();
      else this.fit();
    }).observe(el);
    this.ageTimer = setInterval(() => this.stamp(), 30000);
  }

  show(items) {
    this.all = items;
    this.page = 0;
    this.render();
  }

  hide() {
    this.stop();
    this.opt.pager.root.hidden = true;
  }

  // How many tiles fit in the pane.
  capacity() {
    const w = this.el.clientWidth - GAP_PX * 2, h = this.el.clientHeight - GAP_PX * 2;
    if (w <= 0 || h <= 0) return 12;
    return Math.max(1, Math.floor((w + GAP_PX) / (MIN_W + GAP_PX)) * Math.floor((h + GAP_PX) / (MIN_H + GAP_PX)));
  }

  goto(p) {
    const pages = Math.ceil(this.all.length / this.perPage);
    if (p < 0 || p >= pages) return;
    this.page = p;
    this.render(false);
  }

  render(recompute = true) {
    const wasRunning = this.running || recompute;
    this.stop();
    if (recompute || !this.perPage) {
      const first = this.page * this.perPage;
      this.perPage = this.capacity();
      this.page = Math.floor(first / this.perPage) || 0;
    }
    const pages = Math.max(1, Math.ceil(this.all.length / this.perPage));
    this.page = Math.min(this.page, pages - 1);
    this.items = this.all.slice(this.page * this.perPage, (this.page + 1) * this.perPage);
    const { root, prev, next, label } = this.opt.pager;
    root.hidden = pages < 2;
    label.textContent = `${this.page + 1}/${pages}`;
    prev.disabled = this.page === 0;
    next.disabled = this.page >= pages - 1;

    this.el.innerHTML = `<div class="m-grid">${this.items.map((it, i) => `
      <div class="tile" data-i="${i}">
        <div class="m-screen"><span class="m-ph">${initials(it.name)}</span></div>
        <div class="m-label"><div class="name">${esc(it.name)}</div><div class="meta m-info"></div></div>
        <span class="m-state"></span>
      </div>`).join('')}</div>`;
    this.items.forEach((it, i) => {
      const shot = this.shots.get(it.id);
      if (shot?.at) {
        const t = this.tile(i);
        t.querySelector('.m-screen').appendChild(shot.canvas);
        t.classList.add('shot');
      }
    });
    this.fit();
    this.stamp();
    this.refreshInfo();
    this.opt.onVisible?.(this.items);
    if (wasRunning) this.resume();
  }

  // Grid shape that makes n tiles as large as possible in the pane (16:9 pictures).
  fit() {
    const grid = this.el.querySelector('.m-grid');
    const n = this.items.length;
    if (!grid || !n) return;
    const w = this.el.clientWidth - GAP_PX * 2, h = this.el.clientHeight - GAP_PX * 2;
    let best = { c: 1, score: -1 };
    for (let c = 1; c <= n; c++) {
      const r = Math.ceil(n / c);
      const tw = (w - GAP_PX * (c - 1)) / c, th = (h - GAP_PX * (r - 1)) / r;
      const score = Math.min(tw, th * 16 / 9) - (r * c - n) * 0.5;   // big pictures, few empty cells
      if (score > best.score) best = { c, r, score };
    }
    grid.style.gridTemplateColumns = `repeat(${best.c}, 1fr)`;
    grid.style.gridTemplateRows = `repeat(${best.r}, 1fr)`;
  }

  tile(i) { return this.el.querySelector(`.tile[data-i="${i}"]`); }

  refreshInfo(item) {
    this.items.forEach((it, i) => {
      if (item && it !== item) return;
      const el = this.tile(i)?.querySelector('.m-info');
      if (el) el.innerHTML = this.opt.info(it);
    });
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

  // Next tile after the current one, preferring tiles never captured.
  pick() {
    if (!this.items.length) return null;
    const fresh = this.items.findIndex(it => !this.shots.has(it.id));
    if (fresh >= 0) return fresh;
    const after = (this.last ?? -1) + 1;
    return after < this.items.length ? after : 0;
  }

  next() {
    if (!this.running) return;
    const prev = this.cur;
    this.release();
    this.cur = null;
    const i = this.pick();
    if (i == null) return;
    const tok = ++this.token;
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
      const dwell = Math.max(3, +this.opt.getSettings().scan || 6);
      this.timer = setTimeout(() => { if (tok === this.token) this.done(i, true); }, dwell * 1000);
    };
    v.addEventListener('timeupdate', onFrame);
  }

  done(i, ok) {
    const t = this.tile(i);
    const item = this.items[i];
    if (t) {
      const v = this.video;
      if (ok && v.videoWidth) {
        const shot = this.shots.get(item.id) || { canvas: document.createElement('canvas') };
        this.shots.set(item.id, shot);
        const screen = t.querySelector('.m-screen');
        if (shot.canvas.parentNode !== screen) screen.appendChild(shot.canvas);
        shot.failed = false;
        const c = shot.canvas;
        c.width = 480;
        c.height = Math.round(480 * v.videoHeight / v.videoWidth) || 270;
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        shot.at = Date.now();
        t.classList.add('shot');
      } else if (!this.shots.has(item.id)) {
        this.shots.set(item.id, { canvas: document.createElement('canvas'), at: 0, failed: true });
      }
      const shot = this.shots.get(item.id);
      t.classList.toggle('nosignal', !!shot?.failed && !shot.at);
      t.classList.remove('scanning');
    }
    this.last = i;
    this.stamp();
    this.next();
  }

  // Age label on each tile ("hace 2 min" / "Sin señal").
  stamp() {
    this.items.forEach((it, i) => {
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
