// Fullscreen overlay player. Each item resolves to a list of attempts ([engine, url]);
// on a fatal error the next attempt is tried (e.g. hls.js → native HLS → mpegts.js).

export class Player {
  constructor(root) {
    this.root = root;
    this.video = root.querySelector('video');
    this.title = root.querySelector('#pTitle');
    this.msgEl = root.querySelector('#pMsg');
    this.prevBtn = root.querySelector('#pPrev');
    this.nextBtn = root.querySelector('#pNext');
    this.token = 0;
    this.pushed = false;

    root.querySelector('#pClose').onclick = () => this.close();
    this.prevBtn.onclick = () => this.step(-1);
    this.nextBtn.onclick = () => this.step(1);
    root.querySelector('#pFs').onclick = () => this.fullscreen();

    this.video.addEventListener('playing', () => this.msg(''));
    this.video.addEventListener('timeupdate', () => {
      if (this.msgEl.textContent === 'Cargando…' && !this.video.paused) this.msg('');
    });
    this.video.addEventListener('waiting', () => this.msg('Cargando…'));

    // Show the bar on interaction, hide it after a few seconds of playback.
    const wake = () => {
      root.classList.remove('idle');
      clearTimeout(this.idleTimer);
      this.idleTimer = setTimeout(() => { if (!this.video.paused) root.classList.add('idle'); }, 3500);
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

  // queue: items; resolve(item) → { title, attempts: [[engine, url], ...] }
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
    const { title, attempts } = this.resolve(this.queue[this.index]);
    this.title.textContent = title;
    this.prevBtn.disabled = this.index <= 0;
    this.nextBtn.disabled = this.index >= this.queue.length - 1;
    this.attempts = attempts;
    this.wake();
    this.attempt(0);
  }

  attempt(i) {
    this.teardown();
    const tok = ++this.token;
    if (i >= this.attempts.length) {
      this.msg('No se pudo reproducir. Si el servidor es http:// o no permite CORS, configura un proxy en Ajustes.');
      return;
    }
    const [engine, url] = this.attempts[i];
    let failed = false;
    const fail = () => {
      if (tok !== this.token || failed) return;
      failed = true;
      this.attempt(i + 1);
    };
    this.msg('Cargando…');
    const v = this.video;

    if (engine === 'hls') {
      const Hls = window.Hls;
      if (!Hls?.isSupported()) return fail();
      const hls = this.hls = new Hls({ enableWorker: true, lowLatencyMode: false, backBufferLength: 30 });
      let recovered = false;
      hls.on(Hls.Events.ERROR, (_, d) => {
        if (!d.fatal) return;
        if (d.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) { recovered = true; hls.recoverMediaError(); }
        else fail();
      });
      hls.on(Hls.Events.MANIFEST_PARSED, () => this.play());
      hls.loadSource(url);
      hls.attachMedia(v);
    } else if (engine === 'native-hls') {
      if (!v.canPlayType('application/vnd.apple.mpegurl')) return fail();
      v.onerror = fail;
      v.src = url;
      this.play();
    } else if (engine === 'mpegts') {
      const m = window.mpegts;
      if (!m?.getFeatureList?.().mseLivePlayback) return fail();
      const p = this.mp = m.createPlayer({ type: 'mpegts', isLive: true, url }, { enableWorker: true, liveBufferLatencyChasing: true });
      p.on(m.Events.ERROR, fail);
      p.attachMediaElement(v);
      p.load();
      this.play();
    } else {
      v.onerror = fail;
      v.src = url;
      this.play();
    }
  }

  play() {
    const p = this.video.play();
    if (p) p.catch(() => {});
  }

  teardown() {
    this.hls?.destroy();
    this.hls = null;
    if (this.mp) { try { this.mp.destroy(); } catch {} this.mp = null; }
    const v = this.video;
    v.onerror = null;
    v.removeAttribute('src');
    v.load();
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
    this.token++;
    this.teardown();
    this.root.hidden = true;
    this.msg('');
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    if (this.pushed && !fromPopstate) { this.pushed = false; history.back(); }
    this.onclose?.();
  }
}
