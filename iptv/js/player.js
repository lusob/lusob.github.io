// Fullscreen overlay player. Each item resolves to a list of attempts ([engine, url]);
// on a fatal error the next attempt is tried (e.g. hls.js → native HLS → mpegts.js).
// Built for slow/overloaded servers: long timeouts, retry rounds with backoff, a stall
// watchdog that reconnects when playback freezes, and an adaptive buffer that grows
// (up to the configured maximum) when playback keeps cutting out.

import { startEngine, resetVideo } from './engines.js?v=20261016a';

const ROUNDS = 3;            // passes over all engines before giving up on the first load
const MAX_RECONNECTS = 6;    // consecutive reconnects after playback had started
const LOAD_TIMEOUT = 60;     // s without playback before an attempt is considered failed
const STALL_WINDOW = 180e3;  // a second cut within this time grows the buffer
const FILL_STUCK = 25;       // s without the buffer growing while refilling → reconnect

export class Player {
  // getSettings() → { buffer, bufferMax } in seconds
  constructor(root, getSettings) {
    this.root = root;
    this.getSettings = getSettings;
    this.video = root.querySelector('video');
    this.title = root.querySelector('#pTitle');
    this.info = root.querySelector('#pInfo');
    this.msgEl = root.querySelector('#pMsg');
    this.retryBtn = root.querySelector('#pRetry');
    this.prevBtn = root.querySelector('#pPrev');
    this.nextBtn = root.querySelector('#pNext');
    this.favBtn = root.querySelector('#pFav');
    this.audioBtn = root.querySelector('#pAudio');
    this.subsBtn = root.querySelector('#pSubs');
    this.menu = root.querySelector('#pMenu');
    this.token = 0;
    this.pushed = false;
    this.eff = null;         // current adaptive buffer (s), kept across channels
    this.lastStall = 0;

    root.querySelector('#pClose').onclick = () => this.close();
    this.prevBtn.onclick = () => this.step(-1);
    this.nextBtn.onclick = () => this.step(1);
    this.retryBtn.onclick = () => this.load();
    root.querySelector('#pFs').onclick = () => this.fullscreen();
    this.favBtn.onclick = () => {
      if (!this.fav) return;
      this.fav.toggle(this.current);
      this.updateFav();
    };
    this.audioBtn.onclick = e => { e.stopPropagation(); this.openMenu('audio'); };
    this.subsBtn.onclick = e => { e.stopPropagation(); this.openMenu('subs'); };
    this.menu.addEventListener('click', e => {
      e.stopPropagation();
      const b = e.target.closest('[data-id]');
      if (!b || !this.engine) return;
      const id = +b.dataset.id;
      if (this.menu.dataset.kind === 'audio') this.engine.setAudio?.(id);
      else this.engine.setSub?.(id);
      this.closeMenu();
      setTimeout(() => this.updateTracks(), 100);
    });
    root.addEventListener('click', () => this.closeMenu());

    const v = this.video;
    v.addEventListener('playing', () => this.onPlaying());
    v.addEventListener('timeupdate', () => { if (!v.paused && v.currentTime > this.lastTime + 0.2) this.onPlaying(); });
    v.addEventListener('waiting', () => this.onWaiting());
    v.addEventListener('loadedmetadata', () => this.updateTracks());

    // Show the bar on interaction, hide it after a few seconds of playback.
    const wake = () => {
      root.classList.remove('idle');
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        if (!v.paused && this.menu.hidden) root.classList.add('idle');
      }, 4000);
    };
    ['pointerdown', 'pointermove', 'keydown'].forEach(ev => root.addEventListener(ev, wake));
    this.wake = wake;

    window.addEventListener('popstate', () => {
      if (this.pushed) { this.pushed = false; this.close(true); }
    });
    document.addEventListener('keydown', e => {
      if (this.root.hidden) return;
      if (e.key === 'Escape' && !document.fullscreenElement) this.close();
      else if (e.key === 'ArrowUp' || e.key === 'PageUp') this.step(-1);
      else if (e.key === 'ArrowDown' || e.key === 'PageDown') this.step(1);
    });
  }

  get isOpen() { return !this.root.hidden; }
  get current() { return this.queue?.[this.index]; }

  // queue: items; resolve(item) → { title, live, attempts: [[engine, url], ...] }
  // fav (optional): { has(item), toggle(item) }
  open(queue, index, resolve, fav = null) {
    this.queue = queue;
    this.index = index;
    this.resolve = resolve;
    this.fav = fav;
    this.root.hidden = false;
    if (!this.pushed) { history.pushState({ player: 1 }, ''); this.pushed = true; }
    this.load();
  }

  step(d) {
    const i = this.index + d;
    if (!this.queue || i < 0 || i >= this.queue.length) return;
    this.index = i;
    this.load();
  }

  load() {
    const { title, live, attempts } = this.resolve(this.current);
    this.title.textContent = title;
    this.setInfo('');
    this.prevBtn.disabled = this.index <= 0;
    this.nextBtn.disabled = this.index >= this.queue.length - 1;
    this.live = !!live;
    this.attempts = attempts;
    this.round = 0;
    this.reconnects = 0;
    this.played = false;
    this.resumeAt = 0;
    this.closeMenu();
    this.updateFav();
    this.wake();
    this.onchange?.(this.current);
    this.attempt(0, 'Conectando…');
  }

  setInfo(html) {
    this.info.innerHTML = html;
    this.info.hidden = !html;
  }

  updateFav() {
    this.favBtn.hidden = !this.fav;
    if (this.fav) this.favBtn.classList.toggle('on', !!this.fav.has(this.current));
  }

  // ---------------------------------------------------------------- adaptive buffer

  buffer() {
    const s = this.getSettings();
    const base = Math.max(2, +s.buffer || 10);
    const max = Math.max(base, +s.bufferMax || 60);
    if (this.eff == null || this.effBase !== base) { this.eff = base; this.effBase = base; }
    this.eff = Math.min(Math.max(this.eff, base), max);
    return { eff: this.eff, max };
  }

  // After a cut: grow the buffer if cuts are frequent, then hold playback until that much is downloaded.
  refill() {
    const { eff, max } = this.buffer();
    const now = Date.now();
    let grown = false;
    if (now - this.lastStall < STALL_WINDOW && eff < max) {
      this.eff = Math.min(max, Math.round(eff + Math.max(5, eff * 0.5)));
      this.engine?.setBuffer?.(this.eff);
      grown = true;
    }
    this.lastStall = now;
    const target = this.eff;
    const v = this.video;
    const tok = this.token;
    clearInterval(this.filling);
    v.pause();
    this.stopTicker();
    this.armTimer(FILL_STUCK);
    let best = -1;
    const t0 = Date.now();
    this.filling = setInterval(() => {
      if (tok !== this.token) return clearInterval(this.filling);
      const ahead = this.ahead();
      if (ahead > best + 0.5) { best = ahead; this.armTimer(FILL_STUCK); }
      this.msg(`${grown ? `Cortes frecuentes: buffer ampliado a ${target} s. ` : ''}Llenando buffer… ${Math.floor(Math.max(0, ahead))}/${target} s`);
      // VOD: the browser may stop downloading before reaching the target; don't wait forever.
      if (ahead >= target || (!this.live && Date.now() - t0 > target * 1500 && ahead > 2)) {
        clearInterval(this.filling);
        this.filling = 0;
        this.play();
      }
    }, 500);
  }

  ahead() {
    const v = this.video, b = v.buffered;
    for (let i = 0; i < b.length; i++) {
      if (b.start(i) <= v.currentTime + 0.5 && v.currentTime < b.end(i)) return b.end(i) - v.currentTime;
    }
    return 0;
  }

  // ---------------------------------------------------------------- engines

  attempt(i, status) {
    this.teardown();
    const tok = ++this.token;
    this.cur = i;
    this.lastTime = 0;
    this.status(status);
    this.retryBtn.hidden = true;
    this.armTimer(LOAD_TIMEOUT);
    const fail = () => { if (tok === this.token) this.failed(); };
    this.failNow = fail;
    const [engine, url] = this.attempts[i];
    const { eff } = this.buffer();
    this.engine = startEngine(this.video, engine, url, {
      buffer: eff,
      resumeAt: this.resumeAt,
      prebuffer: this.live && engine === 'mpegts' ? Math.min(eff, 10) : 0,
      onStatus: t => { if (tok === this.token) { this.stopTicker(); this.msg(t); } },
      onTracks: () => { if (tok === this.token) this.updateTracks(); },
    }, fail);
    this.updateTracks();
  }

  failed() {
    const v = this.video;
    if (!this.live && v.currentTime > 1) this.resumeAt = v.currentTime;
    let next, label, delay;
    if (this.played) {
      // Was playing: reconnect with the same engine.
      if (++this.reconnects > MAX_RECONNECTS) return this.giveUp('Se ha perdido la conexión con el canal.');
      next = this.cur;
      label = `Reconectando… (${this.reconnects}/${MAX_RECONNECTS})`;
      delay = Math.min(1000 * this.reconnects, 5000);
    } else {
      // Never played: next engine, then further rounds with increasing pauses.
      next = this.cur + 1;
      delay = 0;
      if (next >= this.attempts.length) {
        if (++this.round >= ROUNDS) {
          return this.giveUp('No se pudo reproducir. El servidor puede estar saturado; prueba de nuevo en un momento. ' +
            'Si es http:// o no permite CORS, configura un proxy en Ajustes.');
        }
        next = 0;
        delay = 3000 * this.round;
      }
      label = this.round ? `Servidor lento, reintentando (${this.round + 1}/${ROUNDS})…` : 'Conectando…';
    }
    this.teardown();
    this.status(label);
    const tok = ++this.token;
    setTimeout(() => { if (tok === this.token) this.attempt(next, label); }, delay);
  }

  giveUp(text) {
    this.teardown();
    this.token++;
    this.msg(text);
    this.retryBtn.hidden = false;
  }

  onPlaying() {
    if (this.filling) return;
    this.lastTime = this.video.currentTime;
    this.played = true;
    this.clearTimer();
    this.stopTicker();
    this.msg('');
    // Smooth playback for a while resets the reconnect budget.
    clearTimeout(this.healthy);
    this.healthy = setTimeout(() => { this.reconnects = 0; }, 30000);
  }

  onWaiting() {
    if (!this.played || !this.isOpen || this.filling) return;
    this.refill();
  }

  armTimer(sec) {
    this.clearTimer();
    const tok = this.token;
    this.watchdog = setTimeout(() => { if (tok === this.token) this.failNow?.(); }, sec * 1000);
  }

  clearTimer() { clearTimeout(this.watchdog); }

  // Status text with an elapsed-seconds counter, so a slow server doesn't look frozen.
  status(text) {
    this.stopTicker();
    const t0 = Date.now();
    const draw = () => {
      const s = Math.floor((Date.now() - t0) / 1000);
      this.msg(s >= 3 ? `${text} ${s} s${s >= 15 ? ' · el servidor tarda en responder' : ''}` : text);
    };
    draw();
    this.ticker = setInterval(draw, 1000);
  }

  stopTicker() { clearInterval(this.ticker); }

  // ---------------------------------------------------------------- audio / subtitles

  updateTracks() {
    const audio = this.engine?.audio?.() || [];
    const subs = this.engine?.subs?.() || [];
    this.audioBtn.hidden = audio.length < 2;
    this.subsBtn.hidden = !subs.length;
    this.subsBtn.classList.toggle('on', subs.some(t => t.active));
    if (!this.menu.hidden) this.openMenu(this.menu.dataset.kind);
  }

  openMenu(kind) {
    const tracks = (kind === 'audio' ? this.engine?.audio?.() : this.engine?.subs?.()) || [];
    const rows = tracks.map(t => `<button data-id="${t.id}" class="${t.active ? 'on' : ''}">${t.active ? '✓ ' : ''}${escHtml(t.label)}</button>`);
    if (kind === 'subs') rows.unshift(`<button data-id="-1" class="${tracks.some(t => t.active) ? '' : 'on'}">${tracks.some(t => t.active) ? '' : '✓ '}Desactivados</button>`);
    this.menu.innerHTML = `<div class="pm-title">${kind === 'audio' ? 'Audio' : 'Subtítulos'}</div>${rows.join('')}`;
    this.menu.dataset.kind = kind;
    this.menu.hidden = false;
    this.root.classList.remove('idle');
  }

  closeMenu() { this.menu.hidden = true; }

  // ---------------------------------------------------------------- lifecycle

  play() {
    const p = this.video.play();
    if (p) p.catch(() => {});
  }

  teardown() {
    this.clearTimer();
    this.stopTicker();
    clearInterval(this.filling);
    this.filling = 0;
    clearTimeout(this.healthy);
    this.engine?.destroy();
    this.engine = null;
    resetVideo(this.video);
    this.audioBtn.hidden = true;
    this.subsBtn.hidden = true;
  }

  msg(t) { this.msgEl.textContent = t; }

  fullscreen() {
    if (document.fullscreenElement) return document.exitFullscreen?.();
    const r = this.root;
    if (r.requestFullscreen) r.requestFullscreen().catch(() => {});
    else if (r.webkitRequestFullscreen) r.webkitRequestFullscreen();
    else this.video.webkitEnterFullscreen?.();
  }

  close(fromPopstate = false) {
    if (!this.isOpen) return;
    this.token++;
    this.teardown();
    this.closeMenu();
    this.root.hidden = true;
    this.msg('');
    this.retryBtn.hidden = true;
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    if (this.pushed && !fromPopstate) { this.pushed = false; history.back(); }
    this.onclose?.();
  }
}

const escHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
