// Fullscreen overlay player. Each item resolves to one or more sources (a channel and its
// backups), each with a list of attempts ([engine, url]); on a fatal error the next attempt is
// tried (e.g. hls.js → native HLS → mpegts.js), and when a source is dead or keeps cutting out
// the next source takes over. Catch-up (the provider's archive) is played the same way, with
// the wall-clock position kept across reconnects and source switches.
// Built for slow/overloaded servers: long timeouts, retry rounds with backoff, a stall
// watchdog that reconnects when playback freezes, and an adaptive buffer that grows
// (up to the configured maximum) when playback keeps cutting out.

import { startEngine, resetVideo } from './engines.js?v=20261021b';

const IOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const ROUNDS = 3;            // passes over all engines before giving up on the first load
const MAX_RECONNECTS = 6;    // consecutive reconnects after playback had started
const LOAD_TIMEOUT = 60;     // s without playback before an attempt is considered failed
const BACKUP_TIMEOUT = 25;   // same, when there are backup channels to switch to
const STALL_WINDOW = 180e3;  // a second cut within this time grows the buffer
const RELAX_AFTER = 15 * 60e3; // ms of smooth live playback before the buffer shrinks again
const VOD_STUCK = 30;        // s waiting in a recording / film → reconnect at the same point
const FILL_STUCK = 25;       // s without the buffer growing while refilling → reconnect
const BACKUP_RECONNECTS = 2; // with backups: reconnects before switching source
const LIVE_EDGE = 90;        // catch-up closer than this (s) to now → switch to live
// Picture framing, first = default. 'safe': whole picture with a margin, for TVs that crop the
// edges of the screen (overscan), which cuts the channel logos.
const FITS = [['contain', 'Ajustar'], ['safe', 'Margen TV'], ['cover', 'Zoom'], ['fill', 'Estirar']];

export class Player {
  // getSettings() → { buffer, bufferMax } in seconds
  constructor(root, getSettings) {
    this.root = root;
    this.getSettings = getSettings;
    this.video = root.querySelector('video');
    this.title = root.querySelector('#pTitle');
    this.bufEl = root.querySelector('#pBuf');
    // Live: show the cushion every second, and give back buffer after a long time without cuts.
    setInterval(() => { this.drawBuf(); this.frozen(); this.applySkip(); }, 1000);
    setInterval(() => this.relax(), 60e3);
    this.info = root.querySelector('#pInfo');
    this.msgEl = root.querySelector('#pMsg');
    this.artEl = root.querySelector('#pArt');   // the programme's picture while the channel loads
    this.retryBtn = root.querySelector('#pRetry');
    // Failed: what can be done (retry, another version, another channel, close)
    this.failEl = root.querySelector('#pFail');
    this.otherBtn = root.querySelector('#pOther');
    this.chooseBtn = root.querySelector('#pChoose');
    this.otherBtn.onclick = e => { e.stopPropagation(); this.otherSource(); };
    this.chooseBtn.onclick = e => { e.stopPropagation(); this.onChoose?.(); };
    root.querySelector('#pQuit').onclick = e => { e.stopPropagation(); this.close(); };
    this.prevBtn = root.querySelector('#pPrev');
    this.nextBtn = root.querySelector('#pNext');
    this.favBtn = root.querySelector('#pFav');
    this.altBtn = root.querySelector('#pAlt');
    this.altBtn.onclick = e => { e.stopPropagation(); this.otherSource(); };
    this.audioBtn = root.querySelector('#pAudio');
    this.subsBtn = root.querySelector('#pSubs');
    this.menu = root.querySelector('#pMenu');
    this.cuBar = root.querySelector('#pCu');
    this.token = 0;
    this.pushed = false;
    this.eff = null;         // current adaptive buffer (s), learned per channel (see buffer())
    this.lastStall = 0;

    root.querySelector('#pClose').onclick = () => this.close();
    this.prevBtn.onclick = () => this.step(-1);
    this.nextBtn.onclick = () => this.step(1);
    this.retryBtn.onclick = e => { e.stopPropagation(); this.load(); };
    this.playBtn = root.querySelector('#pPlay');
    this.playBtn.onclick = e => { e.stopPropagation(); this.unblock(); };
    root.querySelector('#pFs').onclick = () => this.fullscreen();
    this.zoomBtn = root.querySelector('#pZoom');
    this.zoomBtn.onclick = () => {
      const s = this.getSettings();
      const i = FITS.findIndex(f => f[0] === s.fit);
      s.fit = FITS[(i + 1) % FITS.length][0];
      this.saveSettings?.();
      this.applyFit();
    };
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
      if (b && this.menu.dataset.kind === 'custom') {
        const fn = this.menuFns?.[+b.dataset.id];
        this.closeMenu();
        fn?.();
        return;
      }
      if (!b || !this.engine) return;
      const id = +b.dataset.id;
      if (this.menu.dataset.kind === 'audio') this.engine.setAudio?.(id);
      else this.engine.setSub?.(id);
      this.closeMenu();
      setTimeout(() => this.updateTracks(), 100);
    });
    root.addEventListener('click', () => this.closeMenu());
    const cuPlay = root.querySelector('#cuPlay');
    cuPlay.onclick = () => { if (this.video.paused) this.play(); else this.video.pause(); };
    for (const ev of ['play', 'pause', 'playing']) this.video.addEventListener(ev, () => { cuPlay.textContent = this.video.paused ? '▶' : '❚❚'; });
    for (const b of root.querySelectorAll('#pCu [data-s]')) {
      const d = +b.dataset.s;   // seconds back (−) or forward
      b.onclick = () => this.sk ? this.skSeek(this.video.currentTime + d) : this.seek(this.cuPos() + d);
    }
    root.querySelector('#cuLive').onclick = () => this.sk ? this.skSeek(Infinity) : this.goLive('');
    root.querySelector('#cuTrack').addEventListener('click', e => {
      const r = e.currentTarget.getBoundingClientRect();
      const f = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
      if (this.sk) this.skSeek(f * this.skSpan());
      else this.seek(this.cu.start + f * (this.cu.end - this.cu.start));
    });

    const v = this.video;
    v.addEventListener('playing', () => this.onPlaying());
    v.addEventListener('timeupdate', () => { if (!v.paused && v.currentTime > this.lastTime + 0.2) this.onPlaying(); });
    v.addEventListener('waiting', () => this.onWaiting());
    v.addEventListener('seeking', () => { this.lastSeek = Date.now(); });
    v.addEventListener('loadedmetadata', () => this.updateTracks());
    v.addEventListener('timeupdate', () => {
      if (this.cu && this.cuT0 != null && this.cuPos() >= this.cu.end) this.finish();
    });
    v.addEventListener('ended', () => {
      if (!this.cu) return;
      if (this.cuPos() >= this.cu.end - LIVE_EDGE) this.finish();
      else this.failNow?.();
    });

    // Show the bar on interaction, hide it after a few seconds of playback.
    const wake = () => {
      root.classList.remove('idle');
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => {
        if (!v.paused && this.menu.hidden) root.classList.add('idle');
      }, 4000);
    };
    ['pointerdown', 'pointermove'].forEach(ev => root.addEventListener(ev, wake));
    this.wake = wake;

    window.addEventListener('popstate', () => {
      if (this.pushed) { this.pushed = false; this.close(true); }
    });
  }

  get isOpen() { return !this.root.hidden; }
  get current() { return this.queue?.[this.index]; }

  // queue: items; resolve(item) → { title, live, attempts: [[engine, url], ...] } or
  //   { title, live, sources: [{ name, attempts(pos) }], catchup?: { start, end, pos }, liveSources? }
  //   (catch-up: positions are unix seconds; liveSources take over when catch-up reaches now)
  // fav (optional): { has(item), toggle(item) }
  open(queue, index, resolve, fav = null) {
    this.queue = queue;
    this.index = index;
    this.resolve = resolve;
    this.fav = fav;
    this.root.hidden = false;
    this.openedAt = Date.now();
    this.applyFit();
    if (this.getSettings().autoFs !== false && !document.fullscreenElement) this.fullscreen(true);
    if (!this.pushed) { history.pushState({ player: 1 }, ''); this.pushed = true; }
    this.load();
  }

  applyFit() {
    const f = FITS.find(f => f[0] === this.getSettings().fit) || FITS[0];
    this.video.style.objectFit = f[0] === 'safe' ? 'contain' : f[0];
    this.video.classList.toggle('safe', f[0] === 'safe');
    this.zoomBtn.textContent = f[1];
  }

  // guard: () => Promise<bool>, asked before changing channel (the app: the Pi may be recording)
  async step(d) {
    const i = this.index + d;
    if (!this.queue || i < 0 || i >= this.queue.length) return;
    if (this.guard && !(await this.guard())) return;
    if (!this.isOpen || this.index + d !== i) return;
    this.index = i;
    this.load();
  }

  load() {
    const r = this.resolve(this.current);
    this.baseTitle = r.title;
    this.setInfo('');
    this.prevBtn.disabled = this.index <= 0;
    this.nextBtn.disabled = this.index >= this.queue.length - 1;
    this.live = !!r.live;
    this.fromStart = !!r.fromStart;
    this.texts = r.texts || null;     // wording for something that is not a channel (e.g. a recording)   // e.g. a recording still in progress: start at its beginning
    this.sources = r.sources || [{ name: r.title, attempts: () => r.attempts }];
    this.liveSources = r.liveSources || null;
    this.cu = r.catchup ? { start: r.catchup.start, end: r.catchup.end, base: r.catchup.pos ?? r.catchup.start } : null;
    // A recording (possibly still growing): its own seek bar over what has been recorded so far.
    this.sk = r.seekbar ? { start: r.seekbar.start, planned: r.seekbar.planned, growing: () => !!r.seekbar.growing?.(), gaps: () => r.seekbar.gaps?.() || [] } : null;
    this.src = 0;
    this.switches = 0;
    this.resetCounters();
    this.resumeAt = r.resumeAt || 0;   // a recording / film: where it was left
    this.setArt('');
    this.closeMenu();
    this.updateFav();
    this.wake();
    this.startCuTimer();
    if (this.cu && this.cu.base > Date.now() / 1000 - LIVE_EDGE) return this.goLive('');
    this.prepare();
    this.onchange?.(this.current);
    this.attempt(0, this.cu ? 'Cargando diferido…' : this.texts?.loading || 'Conectando…');
  }

  resetCounters() {
    this.round = 0;
    this.reconnects = 0;
    this.played = false;
  }

  // Attempts of the current source (catch-up: starting at the current position, whole minutes).
  prepare() {
    // The provider's archive starts on whole minutes: the seconds left over are skipped once it plays.
    if (this.cu) {
      const b = Math.floor(this.cu.base / 60) * 60;
      this.cuSkip = this.cu.base - b;
      this.cu.base = b;
    }
    this.attempts = this.sources[this.src].attempts(this.cu ? this.cu.base : 0);
    // iPhone / iPad: Safari's own HLS player is far more reliable than hls.js there.
    if (IOS) this.attempts = [...this.attempts.filter(a => a[0] === 'native-hls'), ...this.attempts.filter(a => a[0] !== 'native-hls')];
    this.updateTitle();
  }

  updateTitle() {
    const s = this.sources[this.src];
    const n = this.sources.length;
    this.altBtn.hidden = n < 2 || !!this.sk;
    this.altBtn.textContent = `⇄ Versión ${this.src + 1}/${n}`;
    // Browser controls only for films and episodes: live, catch-up and recordings have our own bar.
    this.video.controls = !(this.live || this.cu || this.sk);
    // Our own controls: the browser must not scroll or zoom on swipes (touch gestures, see touch.js)
    this.video.style.touchAction = this.video.controls ? '' : 'none';
    this.title.textContent = this.baseTitle + (this.src > 0 ? ` · respaldo: ${s.name}` : '');
    this.root.classList.toggle('catchup', !!(this.cu || this.sk));
    this.drawCu();
  }

  setSources(sources) {
    if (this.cu || !sources?.length) return;
    this.sources = sources;
    if (this.src >= sources.length) this.src = 0;
    this.updateTitle();
  }

  // ---------------------------------------------------------------- catch-up

  cuPos() {
    if (!this.cu) return 0;
    const t = this.cuT0 == null ? 0 : Math.max(0, this.video.currentTime - this.cuT0);
    return this.cu.base + t;
  }

  seek(pos) {
    if (!this.cu) return;
    const now = Date.now() / 1000;
    pos = Math.max(this.cu.start, Math.min(pos, this.cu.end - 30));
    if (pos > now - LIVE_EDGE) return this.goLive('');
    // Short jumps (±30 s) within what is already downloaded: no need to reconnect.
    const v = this.video, to = v.currentTime + pos - this.cuPos();
    if (this.cuT0 != null && !this.cuSkip && this.inBuffer(to)) {
      v.currentTime = to;
      this.lastSeek = this.nudgedAt = Date.now();
      return this.drawCu();
    }
    this.cu.base = pos;
    this.resetCounters();
    this.prepare();
    this.attempt(this.cur && this.played ? this.cur : 0, 'Saltando…');
  }

  // Leave catch-up for the live channel (when the archive reaches "now", or on request).
  goLive(text) {
    if (!this.liveSources) return this.finish();
    this.cu = null;
    this.sources = this.liveSources;
    this.src = 0;
    this.switches = 0;
    this.resetCounters();
    this.prepare();
    this.onchange?.(this.current);
    this.attempt(0, text || 'Pasando al directo…');
  }

  drawSk() {
    const span = this.skSpan(), avail = this.skAvail(), t = this.video.currentTime || 0;
    // Still recording: wall-clock times (like catch-up). Finished: just elapsed / length, like any video.
    const dur = s => { s = Math.max(0, Math.floor(s)); const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = String(s % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };
    const hm = this.sk.growing() ? s => new Date((this.sk.start + s) * 1000).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' }) : dur;
    this.cuBar.querySelector('#cuFill').style.width = `${Math.min(1, t / span) * 100}%`;
    this.cuBar.querySelector('#cuAvail').style.width = `${Math.min(1, avail / span) * 100}%`;
    this.cuBar.querySelector('#cuTime').textContent = hm(t);
    this.cuBar.querySelector('#cuEnd').textContent = hm(span);
    // Cuts of the recording: red marks where something is missing
    const gaps = this.sk.gaps(), key = gaps.map(g => g.join(':')).join() + '|' + Math.round(span);
    if (this.gapKey !== key) {
      this.gapKey = key;
      const track = this.cuBar.querySelector('#cuTrack');
      track.querySelectorAll('.cu-gap').forEach(x => x.remove());
      track.insertAdjacentHTML('beforeend', gaps.map(([at, lost]) =>
        `<i class="cu-gap" style="left:${Math.min(100, at / span * 100)}%" title="Corte: faltan ${Math.round(lost)} s"></i>`).join(''));
    }
    const live = this.cuBar.querySelector('#cuLive');
    live.hidden = !this.sk.growing();
    live.textContent = avail - t > 30 ? 'Ir al final' : '● Al día';
  }

  // Menu with arbitrary actions: entries [{ label, on?, fn }].
  showMenu(title, entries) {
    this.menuFns = entries.map(e => e.fn);
    this.menu.innerHTML = `<div class="pm-title">${escHtml(title)}</div>` +
      entries.map((e, i) => `<button data-id="${i}" class="${e.on ? 'on' : ''}">${escHtml(e.label)}</button>`).join('');
    this.menu.dataset.kind = 'custom';
    this.menu.hidden = false;
    this.root.classList.remove('idle');
    this.menu.querySelector('button')?.focus();
  }

  finish() {
    if (!this.cu) return;
    this.teardown();
    this.token++;
    this.cu.base = this.cu.end;
    this.drawCu();
    this.msg('Fin del programa.');
    this.showFail('Ver de nuevo');
  }

  startCuTimer() {
    clearInterval(this.cuTimer);
    if (this.cu || this.sk) this.cuTimer = setInterval(() => this.drawCu(), 1000);
  }

  // ---- seek bar of a recording: plain seeking inside what the playlist already has

  skAvail() {
    const s = this.video.seekable;
    return s.length ? s.end(s.length - 1) : 0;
  }

  skSpan() { return Math.max(this.sk.planned || 0, this.skAvail(), 1); }

  skSeek(t) {
    const avail = this.skAvail();
    if (!avail) return;
    this.video.currentTime = Math.max(0, Math.min(t, avail - (this.sk.growing() ? 8 : 1)));
    this.play();
    this.drawCu();
  }

  drawCu() {
    this.cuBar.hidden = !(this.cu || this.sk);
    if (this.sk) return this.drawSk();
    if (!this.cu) return;
    const { start, end } = this.cu;
    const span = end - start, now = Date.now() / 1000;
    const pos = Math.min(end, this.cuPos());
    const hm = t => new Date(t * 1000).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
    this.cuBar.querySelector('#cuFill').style.width = `${(pos - start) / span * 100}%`;
    this.cuBar.querySelector('#cuAvail').style.width = `${Math.min(1, (now - start) / span) * 100}%`;
    this.cuBar.querySelector('#cuTime').textContent = hm(pos);
    this.cuBar.querySelector('#cuEnd').textContent = hm(end);
    this.cuBar.querySelector('#cuLive').hidden = !this.liveSources || now > end;
  }

  // Picture shown behind the loading / error messages until the picture plays.
  setArt(url) {
    if (url !== this.art) {
      this.art = url;
      this.artEl.style.backgroundImage = url ? `url("${url}")` : '';
    }
    this.artEl.hidden = !url || this.played;
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
    // Starts with what earlier sessions learned (frequent cuts), not from scratch every time.
    // Each live channel learns its own (the cuts usually come from that channel's server, so a bad
    // one must not delay the others); recordings / films share one (the home Wi-Fi).
    const key = this.live ? 'ch:' + (this.current?.id ?? '') : 'vod';
    if (this.eff == null || this.effBase !== base || this.effKey !== key) {
      this.eff = Math.max(base, Math.min(max, +(s.bufLearnedBy || {})[key] || 0));
      this.effBase = base;
      this.effKey = key;
    }
    this.eff = Math.min(Math.max(this.eff, base), max);
    return { eff: this.eff, max };
  }

  // After a cut: grow the buffer if cuts are frequent, then hold playback until that much is downloaded.
  refill() {
    const { eff, max } = this.buffer();
    const now = Date.now();
    let grown = false;
    // Cutting again with the buffer already at its maximum: more buffer won't help (the stream comes
    // slower than it plays, or the server keeps dropping it). Try another version of the channel.
    const st = this.engine?.stats?.();
    if (this.live && now - this.lastStall < STALL_WINDOW && eff >= max && this.sources.length > 1) {
      this.lastStall = now;
      const why = st?.need && st.speed < st.need ? `Llega a ${mbps(st.speed)} y necesita ${mbps(st.need)}.` : 'Se sigue cortando con el colchón al máximo.';
      if (this.nextSource(why)) return;
    }
    const starved = !this.live && st?.need && st.speed < st.need * 0.95;
    if ((now - this.lastStall < STALL_WINDOW || starved) && eff < max) {
      // Recording / film arriving slower than it plays: no point growing step by step.
      this.eff = starved ? max : Math.min(max, Math.round(eff + Math.max(5, eff * 0.5)));
      this.engine?.setBuffer?.(this.eff);
      grown = true;
      this.learn();
    }
    this.lastStall = now;
    const target = this.eff;
    const v = this.video;
    const tok = this.token;
    clearInterval(this.filling);
    v.pause();
    this.stopTicker();
    this.armTimer(FILL_STUCK);
    let best = -1, grewAt = Date.now();
    const t0 = Date.now();
    this.filling = setInterval(() => {
      if (tok !== this.token) return clearInterval(this.filling);
      let ahead = this.ahead();
      // Paused on a hole while the data piles up after it (it never fills): go to that data.
      if (ahead < 0.5) {
        const b = v.buffered, t = v.currentTime;
        for (let i = 0; i < b.length; i++) {
          if (b.start(i) > t && b.end(i) - b.start(i) > 1) { v.currentTime = b.start(i) + 0.1; this.nudgedAt = Date.now(); ahead = b.end(i) - b.start(i); break; }
        }
      }
      if (ahead > best + 0.5) { best = ahead; grewAt = Date.now(); this.armTimer(FILL_STUCK); }
      this.msg(`${grown ? `Cortes frecuentes: buffer ampliado a ${target} s. ` : ''}Llenando buffer… ${Math.floor(Math.max(0, ahead))}/${target} s`);
      // VOD: the browser may stop downloading before reaching the target; don't wait forever.
      // Live: the server may not keep that much behind the edge; once it stops growing, go on.
      if (ahead >= target || (!this.live && Date.now() - t0 > target * 1500 && ahead > 2) || (Date.now() - grewAt > 6000 && ahead > 3)) {
        clearInterval(this.filling);
        this.filling = 0;
        this.play();
      }
    }, 500);
  }

  learn() {
    const s = this.getSettings();
    // Only the channels that needed more than the setting, the last 60 of them
    const by = Object.entries(s.bufLearnedBy || {}).filter(([k]) => k !== this.effKey);
    if (this.eff > this.effBase) by.push([this.effKey, this.eff]);
    s.bufLearnedBy = Object.fromEntries(by.slice(-60));
    this.saveSettings?.();
  }

  // 15 min without cuts: 20 % less buffer (less delay), never below the setting.
  relax() {
    if (!this.isOpen || !this.played || this.filling || this.video.paused) return;
    const { eff } = this.buffer();
    const base = this.effBase, now = Date.now();
    const calm = now - Math.max(this.lastStall || 0, this.lastRelax || 0, this.openedAt || 0);
    if (eff <= base || calm < RELAX_AFTER) return;
    this.eff = Math.max(base, Math.round(eff * 0.8));
    this.lastRelax = now;
    this.engine?.setBuffer?.(this.eff);
    this.learn();
  }

  drawBuf() {
    const show = this.isOpen && !this.cu && this.played;
    this.bufEl.hidden = !show;
    if (!show) return;
    const a = Math.max(0, Math.floor(this.ahead()));
    const st = this.engine?.stats?.();
    const slow = st?.need && st.speed < st.need * 1.15;
    const net = st ? ` · llegan ${mbps(st.speed)}${st.need ? ` de ${mbps(st.need)}` : ''}` : '';
    // Live: the cushion kept behind the edge vs its target. Recordings / films download well ahead
    // of the target (it only matters after a cut): just say how much is loaded.
    this.bufEl.textContent = (this.live ? `Colchón ${a} s (objetivo ${this.eff} s)` : `Cargados ${a} s por delante`) + net +
      (slow ? (this.live ? ' · lento: prueba otra versión (⇄)' : ' · la red no da para este vídeo') : '');
    this.bufEl.classList.toggle('low', a < 3 || !!slow);
  }

  // Picture frozen with data in the buffer and no 'waiting' (a stuck decoder, a hole in one of
  // the tracks, a timestamp jump in the stream): the clock stops while the buffer keeps growing.
  // 3 s → small jump forward (or to the next buffered piece); 6 s → a bigger one; 9 s → reconnect.
  frozen() {
    const v = this.video;
    if (v.seeking) return;
    if (!this.isOpen || !this.played || this.filling || v.paused || v.ended) { this.frozenAt = null; return; }
    const t = v.currentTime;
    if (this.frozenAt == null || Math.abs(t - this.frozenT) > 0.05) { this.frozenAt = Date.now(); this.frozenT = t; this.frozenStep = 0; return; }
    const s = (Date.now() - this.frozenAt) / 1000, b = v.buffered;
    if (s < 3) return;
    let next = null, end = 0;
    for (let i = 0; i < b.length; i++) {
      end = Math.max(end, b.end(i));
      if (next == null && b.start(i) > t + 0.05) next = b.start(i);
    }
    if (end - t < 1) return;           // nothing to play: a real cut, handled by 'waiting'
    if (s >= 9) {
      this.frozenAt = null;
      this.msg('La imagen se ha congelado: reconectando…');
      return this.failNow?.();
    }
    const n = Math.floor(s / 3);           // 1: first try, 2: second
    if (this.frozenStep === n) return;
    this.frozenStep = n;
    const step = n >= 2 ? 2 : 0.3;
    const to = Math.min(end - 0.5, this.ahead() > 0.5 ? t + step : next ?? t + step);
    console.warn('frozen', s, t, '→', to);
    v.currentTime = to;
    this.frozenT = v.currentTime;          // our own jump is not progress: keep counting
    v.play?.().catch(() => {});
    this.lastSeek = this.nudgedAt = Date.now();
  }

  inBuffer(t) {
    const b = this.video.buffered;
    for (let i = 0; i < b.length; i++) if (b.start(i) <= t && t < b.end(i) - 1) return true;
    return false;
  }

  // Catch-up opened on the minute before the wanted second: jump the rest once it is downloaded.
  applySkip() {
    if (!this.cu || !this.cuSkip || this.cuT0 == null || this.filling) return;
    const to = this.cuT0 + this.cuSkip;
    if (!this.inBuffer(to)) return;
    this.cuSkip = 0;
    this.video.currentTime = to;
    this.lastSeek = this.nudgedAt = Date.now();
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
    this.cuT0 = null;
    this.video.muted = false;   // muted only as a fallback when the browser refuses to play
    this.status(status);
    this.failEl.hidden = true;
    this.armTimer(this.sources.length > 1 ? BACKUP_TIMEOUT : LOAD_TIMEOUT);
    const fail = () => { if (tok === this.token) this.failed(); };
    this.failNow = fail;
    const [engine, url] = this.attempts[i];
    const { eff } = this.buffer();
    this.engine = startEngine(this.video, engine, url, {
      buffer: eff,
      resumeAt: this.resumeAt,
      fromStart: this.fromStart,
      prebuffer: this.live && engine === 'mpegts' ? Math.min(eff, 20) : 0,   // raw TS: the cushion is built in real time
      onStatus: t => { if (tok === this.token) { this.stopTicker(); this.msg(t); } },
      onTracks: () => { if (tok === this.token) this.updateTracks(); },
      onBlocked: () => { if (tok === this.token) this.blockedPlay(); },
    }, fail);
    this.updateTracks();
  }

  failed() {
    const v = this.video;
    if (!this.live && v.currentTime > 1) this.resumeAt = v.currentTime;
    const multi = this.sources.length > 1;
    let next, label, delay;
    if (this.played) {
      // Was playing: reconnect with the same engine (catch-up: from where it stopped).
      const budget = multi ? BACKUP_RECONNECTS : MAX_RECONNECTS;
      if (++this.reconnects > budget) {
        return this.nextSource('Se ha cortado la señal.') || this.giveUp(this.texts?.fail || 'Se ha perdido la conexión con el canal.');
      }
      if (this.cu) {
        this.cu.base = this.cuPos();
        if (this.cu.base >= this.cu.end - 30) return this.finish();
        if (this.cu.base > Date.now() / 1000 - LIVE_EDGE) return this.goLive('Has alcanzado el directo.');
        this.prepare();
      }
      next = this.cur;
      label = `Reconectando… (${this.reconnects}/${budget})`;
      delay = Math.min(1000 * this.reconnects, 5000);
    } else {
      // Never played: next engine, then further rounds with increasing pauses.
      const rounds = multi ? 1 : ROUNDS;
      next = this.cur + 1;
      delay = 0;
      if (next >= this.attempts.length) {
        if (++this.round >= rounds) {
          if (this.nextSource(this.cu ? 'Sin archivo en este canal.' : 'Sin señal.')) return;
          if (this.cu && this.liveSources && this.cu.end > Date.now() / 1000) return this.goLive('Sin archivo disponible: mostrando el directo.');
          return this.giveUp(this.texts?.fail || (this.cu
            ? 'No se pudo cargar el diferido. Puede que el proveedor no tenga archivo de este programa o que la hora no cuadre (Ajustes → Ajuste de hora del diferido).'
            : 'No se pudo reproducir. El servidor puede estar saturado; prueba de nuevo en un momento. ' +
              'Si es http:// o no permite CORS, configura un proxy en Ajustes.'));
        }
        next = 0;
        delay = 3000 * this.round;
      }
      label = this.round ? `${this.texts ? 'Reintentando' : 'Servidor lento, reintentando'} (${this.round + 1}/${rounds})…` : this.cu ? 'Cargando diferido…' : this.texts?.loading || 'Conectando…';
    }
    this.teardown();
    this.status(label);
    const tok = ++this.token;
    setTimeout(() => { if (tok === this.token) this.attempt(next, label); }, delay);
  }

  // Switch to the next backup source (round-robin, limited); false when there is none left.
  nextSource(reason) {
    const n = this.sources.length;
    if (n < 2 || this.switches >= n * 2) return false;
    if (this.cu) this.cu.base = this.cuPos();
    this.switches++;
    this.src = (this.src + 1) % n;
    this.resetCounters();
    this.prepare();
    const label = `${reason ? reason + ' ' : ''}Probando versión ${this.src + 1}/${n}: ${this.sources[this.src].name}…`;
    this.updateTitle();
    this.teardown();
    this.status(label);
    const tok = ++this.token;
    setTimeout(() => { if (tok === this.token) this.attempt(0, label); }, 800);
    return true;
  }

  // By hand ("this one stutters"): next version of the channel, without counting towards the limit.
  otherSource() {
    if (this.sources.length < 2) return;
    this.switches = 0;
    this.nextSource('');
  }

  giveUp(text) {
    this.teardown();
    this.token++;
    this.msg(text);
    this.showFail('↻ Reintentar');
  }

  showFail(label) {
    this.retryBtn.textContent = label;
    this.otherBtn.hidden = this.sources.length < 2 || !!this.sk;
    this.chooseBtn.hidden = !this.live || !this.onChoose || !!this.cu;
    this.failEl.hidden = false;
    this.root.classList.remove('idle');
    if (document.body.classList.contains('kbd') || !matchMedia('(pointer: coarse)').matches) this.retryBtn.focus();
  }

  onPlaying() {
    if (this.filling) return;
    if (this.cu && this.cuT0 == null) { this.cuT0 = this.video.currentTime; this.applySkip(); }
    this.lastTime = this.video.currentTime;
    this.played = true;
    this.artEl.hidden = true;
    this.clearTimer();
    this.stopTicker();
    this.msg('');
    // Smooth playback for a while resets the reconnect budget.
    clearTimeout(this.healthy);
    this.healthy = setTimeout(() => { this.reconnects = 0; }, 30000);
  }

  onWaiting() {
    if (!this.played || !this.isOpen || this.filling) return;
    if (Date.now() - (this.nudgedAt || 0) < 2500) return;   // our own unfreezing jump (frozen())
    // Recordings, films: a jump is not a cut (no pause, no bigger buffer); keep playing as soon as
    // data arrives and reconnect at the same point only if nothing comes for a while.
    if (!this.live && (this.video.seeking || Date.now() - (this.lastSeek || 0) < 4000)) {
      this.status('Saltando…');
      this.armTimer(VOD_STUCK);
      return;
    }
    // A real cut (live or not): bigger buffer if they are frequent, refill, go on.
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
      this.msg(s >= 3 ? `${text} ${s} s${s >= 15 ? ` · ${this.texts?.slow || 'el servidor tarda en responder'}` : ''}` : text);
    };
    draw();
    this.ticker = setInterval(draw, 1000);
  }

  stopTicker() { clearInterval(this.ticker); }

  // ---------------------------------------------------------------- autoplay blocked

  // The browser would not start playback on its own: try muted (usually allowed), and offer
  // to turn the sound on; if even that is refused, a big button starts it with the next key press.
  blockedPlay() {
    const v = this.video, tok = this.token;
    this.clearTimer();
    this.stopTicker();
    if (v.muted) return this.showPlayBtn('▶ Reproducir');
    v.muted = true;
    const p = v.play();
    (p || Promise.resolve()).then(() => {
      if (tok === this.token) this.showPlayBtn('🔊 Activar sonido');
    }, () => {
      if (tok === this.token) this.showPlayBtn('▶ Reproducir');
    });
  }

  showPlayBtn(label) {
    this.blocked = true;
    this.msg(label.startsWith('▶') ? 'Pulsa OK para empezar' : '');
    this.playBtn.textContent = label;
    this.playBtn.hidden = false;
    this.root.classList.remove('idle');
    this.playBtn.focus();
  }

  // Called from a key press or a tap, which the browser accepts as permission to play.
  unblock() {
    const v = this.video;
    this.blocked = false;
    this.playBtn.hidden = true;
    this.playBtn.blur();
    v.muted = false;
    const p = v.play();
    if (p) p.catch(() => { v.muted = true; v.play()?.catch(() => {}); });
    if (!this.played) this.armTimer(LOAD_TIMEOUT);
  }

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
    if (p) p.catch(e => { if (e?.name === 'NotAllowedError') this.blockedPlay(); });
  }

  teardown() {
    this.clearTimer();
    this.playBtn.hidden = true;
    this.blocked = false;
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

  // auto: on opening. The iPhone only has the video's own fullscreen player, which hides our
  // messages and controls (black screen at 00:00 while loading): only on request there.
  fullscreen(auto = false) {
    if (document.fullscreenElement) return document.exitFullscreen?.();
    const r = this.root;
    if (r.requestFullscreen) r.requestFullscreen().catch(() => {});
    else if (r.webkitRequestFullscreen) r.webkitRequestFullscreen();
    else if (!auto) this.video.webkitEnterFullscreen?.();
  }

  close(fromPopstate = false) {
    if (!this.isOpen) return;
    this.token++;
    this.teardown();
    this.closeMenu();
    this.root.hidden = true;
    this.msg('');
    this.failEl.hidden = true;
    clearInterval(this.cuTimer);
    this.cu = null;
    this.sk = null;
    this.gapKey = null;
    this.cuBar?.querySelectorAll('.cu-gap').forEach(x => x.remove());
    this.cuBar.hidden = true;
    this.root.classList.remove('catchup');
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    if (this.pushed && !fromPopstate) { this.pushed = false; history.back(); }
    this.onclose?.();
  }
}

const mbps = bps => `${(bps / 1e6).toFixed(1).replace('.', ',')} Mbps`;
const escHtml = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
