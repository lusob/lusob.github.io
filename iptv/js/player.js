// Fullscreen overlay player. Each item resolves to a list of attempts ([engine, url]);
// on a fatal error the next attempt is tried (e.g. hls.js → native HLS → mpegts.js).
// Built for slow/overloaded servers: long timeouts, retry rounds with backoff, and a stall
// watchdog that reconnects when playback freezes.

import { startEngine, resetVideo } from './engines.js';

const ROUNDS = 3;            // passes over all engines before giving up on the first load
const MAX_RECONNECTS = 6;    // consecutive reconnects after playback had started
const LOAD_TIMEOUT = 60;     // s without playback before an attempt is considered failed

export class Player {
  // getSettings() → { buffer: seconds }
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
    this.token = 0;
    this.pushed = false;

    root.querySelector('#pClose').onclick = () => this.close();
    this.prevBtn.onclick = () => this.step(-1);
    this.nextBtn.onclick = () => this.step(1);
    this.retryBtn.onclick = () => this.load();
    root.querySelector('#pFs').onclick = () => this.fullscreen();

    const v = this.video;
    v.addEventListener('playing', () => this.onPlaying());
    v.addEventListener('timeupdate', () => { if (!v.paused && v.currentTime > this.lastTime + 0.2) this.onPlaying(); });
    v.addEventListener('waiting', () => this.onWaiting());

    // Show the bar on interaction, hide it after a few seconds of playback.
    const wake = () => {
      root.classList.remove('idle');
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => { if (!v.paused) root.classList.add('idle'); }, 4000);
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
  open(queue, index, resolve) {
    this.queue = queue;
    this.index = index;
    this.resolve = resolve;
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
    this.wake();
    this.onchange?.(this.current);
    this.attempt(0, 'Conectando…');
  }

  setInfo(html) {
    this.info.innerHTML = html;
    this.info.hidden = !html;
  }

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
    const buffer = Math.max(2, +this.getSettings().buffer || 10);
    this.engine = startEngine(this.video, engine, url, {
      buffer,
      resumeAt: this.resumeAt,
      prebuffer: this.live && engine === 'mpegts' ? Math.min(buffer, 10) : 0,
      onStatus: t => { if (tok === this.token) { this.stopTicker(); this.msg(t); } },
    }, fail);
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
    if (!this.played || !this.isOpen) return;
    const buffer = +this.getSettings().buffer || 10;
    this.status('Cargando…');
    this.armTimer(Math.max(20, buffer + 15));   // frozen this long → reconnect
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

  teardown() {
    this.clearTimer();
    this.stopTicker();
    clearTimeout(this.healthy);
    this.engine?.destroy();
    this.engine = null;
    resetVideo(this.video);
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
    this.root.hidden = true;
    this.msg('');
    this.retryBtn.hidden = true;
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    if (this.pushed && !fromPopstate) { this.pushed = false; history.back(); }
    this.onclose?.();
  }
}
