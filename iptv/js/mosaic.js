// Channel mosaic for accounts with a single connection: one hidden-ish <video> visits the
// visible tiles one by one, plays each channel for a few seconds, leaves a snapshot behind
// and moves on. Only one stream is ever open.

import { startEngine, resetVideo } from './engines.js';
import { esc, initials } from './ui.js';

const MAX_TILES = 60;
const LOAD_TIMEOUT = 25;   // s to get a picture before skipping the channel
const GAP = 700;           // ms between streams so the server frees the connection

export class Mosaic {
  // opt: { getSettings, attempts(item), onOpen(items, index), info(item) → html, onVisible(items) }
  constructor(el, opt) {
    this.el = el;
    this.opt = opt;
    this.items = [];
    this.token = 0;
    this.running = false;
    this.visible = new Set();
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.className = 'm-video';
    this.io = new IntersectionObserver(entries => {
      for (const e of entries) {
        const i = +e.target.dataset.i;
        e.isIntersecting ? this.visible.add(i) : this.visible.delete(i);
      }
      this.opt.onVisible?.([...this.visible].map(i => this.items[i]));
      if (this.running && this.cur == null) this.next();
    }, { root: el, threshold: 0.5 });
    el.addEventListener('click', e => {
      const t = e.target.closest('[data-i]');
      if (t) this.opt.onOpen(this.items, +t.dataset.i);
    });
  }

  show(items) {
    this.stop();
    this.items = items.slice(0, MAX_TILES);
    this.shots = new Map();   // i → time of last snapshot
    this.visible.clear();
    this.io.disconnect();
    this.el.innerHTML = (items.length > MAX_TILES ? `<p class="muted m-note">Mostrando ${MAX_TILES} de ${items.length} canales.</p>` : '') +
      `<div class="m-grid">${this.items.map((it, i) => `
        <div class="tile" data-i="${i}">
          <div class="m-screen"><span class="m-ph">${initials(it.name)}</span><canvas width="320" height="180"></canvas></div>
          <div class="m-label"><div class="name">${esc(it.name)}</div><div class="meta m-info"></div></div>
          <span class="m-state"></span>
        </div>`).join('')}</div>`;
    for (const t of this.el.querySelectorAll('.tile')) this.io.observe(t);
    this.refreshInfo();
    this.resume();
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
    if (this.running || !this.items.length) return;
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

  // Next visible tile after the current one, preferring tiles never captured.
  pick() {
    const vis = [...this.visible].sort((a, b) => a - b);
    if (!vis.length) return null;
    const fresh = vis.find(i => !this.shots.has(i));
    if (fresh != null) return fresh;
    return vis.find(i => i > (this.last ?? -1)) ?? vis[0];
  }

  next() {
    if (!this.running) return;
    const prev = this.cur;
    this.release();
    this.cur = null;
    const i = this.pick();
    if (i == null) return;   // nothing on screen; the observer restarts us
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
    if (t) {
      const v = this.video;
      if (ok && v.videoWidth) {
        const c = t.querySelector('canvas');
        c.width = 320;
        c.height = Math.round(320 * v.videoHeight / v.videoWidth) || 180;
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        t.classList.add('shot');
      }
      const hasShot = t.classList.contains('shot');
      t.classList.toggle('nosignal', !hasShot);
      if (ok) t.dataset.at = Date.now();
      else if (!hasShot) t.querySelector('.m-state').textContent = 'Sin señal';
      this.stamp();
    }
    this.shots.set(i, Date.now());
    this.last = i;
    this.next();
  }

  // Age label on each captured tile ("hace 2 min"), refreshed as the scanner moves.
  stamp() {
    for (const el of this.el.querySelectorAll('.tile.shot:not(.scanning)')) {
      const s = Math.round((Date.now() - +el.dataset.at) / 1000);
      el.querySelector('.m-state').textContent = s < 60 ? 'hace un momento' : `hace ${Math.round(s / 60)} min`;
    }
  }
}
