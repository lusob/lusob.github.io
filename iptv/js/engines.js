// Playback engines shared by the player and the mosaic scanner.
// startEngine() attaches one engine to a <video>; it calls fail() (always asynchronously)
// on a fatal error and returns a handle with destroy().

export function startEngine(v, engine, url, opt, fail) {
  const { buffer = 10, light = false, resumeAt = 0, prebuffer = 0, onStatus } = opt;
  const failLater = () => { Promise.resolve().then(fail); return { destroy() {} }; };
  const play = () => { const p = v.play(); if (p) p.catch(() => {}); };

  if (engine === 'hls') {
    const Hls = window.Hls;
    if (!Hls?.isSupported()) return failLater();
    const hls = new Hls(light ? {
      // Mosaic: first frame as fast as possible, minimal download.
      enableWorker: true,
      startLevel: 0,
      liveSyncDurationCount: 1,
      maxBufferLength: 4,
      backBufferLength: 0,
      manifestLoadingTimeOut: 20000, manifestLoadingMaxRetry: 1,
      levelLoadingTimeOut: 20000, levelLoadingMaxRetry: 1,
      fragLoadingTimeOut: 25000, fragLoadingMaxRetry: 2,
    } : {
      enableWorker: true,
      startFragPrefetch: true,
      // Live: play `buffer` seconds behind the edge, so that much is always downloaded ahead.
      liveSyncDuration: buffer,
      liveMaxLatencyDuration: buffer * 3 + 10,
      maxBufferLength: Math.max(30, buffer * 2),
      maxMaxBufferLength: Math.max(120, buffer * 4),
      backBufferLength: 30,
      // Patient with overloaded servers.
      manifestLoadingTimeOut: 30000, manifestLoadingMaxRetry: 3, manifestLoadingRetryDelay: 1500,
      levelLoadingTimeOut: 30000, levelLoadingMaxRetry: 6, levelLoadingRetryDelay: 1500,
      fragLoadingTimeOut: 45000, fragLoadingMaxRetry: 8, fragLoadingRetryDelay: 1000,
      nudgeMaxRetry: 10,
    });
    let recovered = false;
    hls.on(Hls.Events.ERROR, (_, d) => {
      if (!d.fatal) return;
      if (d.type === Hls.ErrorTypes.MEDIA_ERROR && !recovered) { recovered = true; hls.recoverMediaError(); }
      else fail();
    });
    hls.on(Hls.Events.MANIFEST_PARSED, () => {
      if (resumeAt) v.currentTime = resumeAt;
      play();
    });
    hls.loadSource(url);
    hls.attachMedia(v);
    return { destroy: () => hls.destroy() };
  }

  if (engine === 'mpegts') {
    const m = window.mpegts;
    if (!m?.getFeatureList?.().mseLivePlayback) return failLater();
    const p = m.createPlayer({ type: 'mpegts', isLive: true, url }, {
      enableWorker: true,
      enableStashBuffer: !light,
      stashInitialSize: light ? undefined : 512 * 1024,
      liveBufferLatencyChasing: light,   // full player: never skip ahead, keep the cushion
      autoCleanupSourceBuffer: true,
    });
    p.on(m.Events.ERROR, fail);
    p.attachMediaElement(v);
    p.load();
    let timer = 0;
    if (prebuffer > 0) {
      // A raw TS stream arrives in real time, so the cushion has to be built before starting.
      const t0 = Date.now();
      timer = setInterval(() => {
        const ahead = v.buffered.length ? v.buffered.end(v.buffered.length - 1) - v.currentTime : 0;
        if (ahead > 0) onStatus?.(`Llenando buffer… ${Math.floor(ahead)}/${prebuffer} s`);
        if (ahead >= prebuffer || (ahead > 0 && Date.now() - t0 > prebuffer * 2000)) {
          clearInterval(timer);
          play();
        }
      }, 500);
    } else {
      play();
    }
    return { destroy: () => { clearInterval(timer); try { p.destroy(); } catch {} } };
  }

  // 'native' (files) or 'native-hls'
  if (engine === 'native-hls' && !v.canPlayType('application/vnd.apple.mpegurl')) return failLater();
  v.onerror = fail;
  v.src = url;
  if (resumeAt) v.addEventListener('loadedmetadata', () => { v.currentTime = resumeAt; }, { once: true });
  play();
  return { destroy() {} };
}

export function resetVideo(v) {
  v.onerror = null;
  v.removeAttribute('src');
  v.load();
}
