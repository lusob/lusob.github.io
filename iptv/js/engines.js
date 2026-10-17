// Playback engines shared by the player and the mosaic scanner.
// startEngine() attaches one engine to a <video>; it calls fail() (always asynchronously)
// on a fatal error and returns a handle with destroy().

export function startEngine(v, engine, url, opt, fail) {
  const { buffer = 10, light = false, resumeAt = 0, prebuffer = 0, fromStart = false, onStatus, onTracks, onBlocked } = opt;
  const failLater = () => { Promise.resolve().then(fail); return { destroy() {} }; };
  // TV browsers (Android WebView) refuse to start a video outside a key press / tap: report it.
  const play = () => { const p = v.play(); if (p) p.catch(e => { if (e?.name === 'NotAllowedError') onBlocked?.(); }); };

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
      startPosition: fromStart ? 0 : -1,
      // Live: play `buffer` seconds behind the edge, so that much is always downloaded ahead.
      liveSyncDuration: buffer,
      // Generous: the adaptive buffer may leave us well behind the edge; don't jump back to live.
      // (a recording still growing is a "live" playlist to hls.js: never jump to its end on our own)
      liveMaxLatencyDuration: fromStart ? 1e9 : Math.max(buffer * 3 + 10, 600),
      maxBufferLength: Math.max(30, buffer * 2),
      // Recordings cut and resumed lose a frame or two between segments (0.1-0.2 s holes in the
      // video): with the default 0.1 s hls.js sees those segments as incomplete and downloads them
      // again and again (100 Mbit/s of nothing → stutter on Wi-Fi). Jump such holes instead.
      maxBufferHole: 0.5,
      maxMaxBufferLength: Math.max(120, buffer * 4),
      backBufferLength: 30,
      // Patient with overloaded servers.
      manifestLoadingTimeOut: 30000, manifestLoadingMaxRetry: 3, manifestLoadingRetryDelay: 1500,
      levelLoadingTimeOut: 30000, levelLoadingMaxRetry: 6, levelLoadingRetryDelay: 1500,
      fragLoadingTimeOut: 45000, fragLoadingMaxRetry: 8, fragLoadingRetryDelay: 1000,
      nudgeMaxRetry: 10,
    });
    // Network speed vs what the stream needs, over the last fragments (only while downloading).
    const frags = [];
    hls.on(Hls.Events.FRAG_LOADED, (_, d) => {
      const st = d.frag.stats, ms = st.loading.end - st.loading.start;
      if (st.loaded > 0 && ms > 0 && d.frag.duration > 0) frags.push({ bytes: st.loaded, ms, dur: d.frag.duration });
      if (frags.length > 12) frags.shift();
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
    if (!light && onTracks) {
      for (const ev of ['AUDIO_TRACKS_UPDATED', 'AUDIO_TRACK_SWITCHED', 'SUBTITLE_TRACKS_UPDATED', 'SUBTITLE_TRACK_SWITCH']) {
        hls.on(Hls.Events[ev], () => onTracks());
      }
    }
    hls.loadSource(url);
    hls.attachMedia(v);
    return {
      destroy: () => hls.destroy(),
      stats: () => {
        if (frags.length < 2) return null;
        const bits = frags.reduce((a, f) => a + f.bytes * 8, 0);
        return { speed: bits / frags.reduce((a, f) => a + f.ms / 1000, 0), need: bits / frags.reduce((a, f) => a + f.dur, 0) };
      },
      setBuffer: sec => {
        hls.config.liveSyncDuration = sec;
        hls.config.maxBufferLength = Math.max(30, sec * 2);
        hls.config.maxMaxBufferLength = Math.max(120, sec * 4);
      },
      audio: () => hls.audioTracks.map((t, i) => ({ id: i, label: trackLabel(t.name, t.lang, i), active: i === hls.audioTrack })),
      setAudio: id => { hls.audioTrack = id; },
      subs: () => hls.subtitleTracks.map((t, i) => ({ id: i, label: trackLabel(t.name, t.lang, i), active: hls.subtitleDisplay && i === hls.subtitleTrack })),
      setSub: id => {
        hls.subtitleDisplay = id >= 0;
        hls.subtitleTrack = id;
      },
    };
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
    return {
      destroy: () => { clearInterval(timer); try { p.destroy(); } catch {} },
      // A raw TS arrives as fast as it is sent: the speed is all we can tell.
      stats: () => { const k = p.statisticsInfo?.speed; return k ? { speed: k * 8192, need: 0 } : null; },
    };
  }

  // 'native' (files) or 'native-hls'
  if (engine === 'native-hls' && !v.canPlayType('application/vnd.apple.mpegurl')) return failLater();
  const stale = new Set(v.textTracks);   // tracks left behind by earlier hls.js sessions
  v.onerror = fail;
  v.src = url;
  if (resumeAt) v.addEventListener('loadedmetadata', () => { v.currentTime = resumeAt; }, { once: true });
  if (onTracks) {
    if (v.audioTracks) v.audioTracks.onaddtrack = onTracks;
    v.textTracks.onaddtrack = onTracks;
  }
  play();
  // Files: audio switching needs AudioTrackList (not exposed by every Chromium build).
  const texts = () => [...v.textTracks].filter(t => !stale.has(t) && (t.kind === 'subtitles' || t.kind === 'captions'));
  return {
    destroy() {},
    audio: () => v.audioTracks ? [...v.audioTracks].map((t, i) => ({ id: i, label: trackLabel(t.label, t.language, i), active: t.enabled })) : [],
    setAudio: id => { [...v.audioTracks].forEach((t, i) => { t.enabled = i === id; }); },
    subs: () => texts().map((t, i) => ({ id: i, label: trackLabel(t.label, t.language, i), active: t.mode === 'showing' })),
    setSub: id => { texts().forEach((t, i) => { t.mode = i === id ? 'showing' : 'disabled'; }); },
  };
}

let langNames;
try { langNames = new Intl.DisplayNames(['es'], { type: 'language' }); } catch {}

function trackLabel(name, lang, i) {
  let l = '';
  if (lang && langNames) { try { l = langNames.of(lang.replace('_', '-')); } catch {} }
  l = l ? l[0].toUpperCase() + l.slice(1) : '';
  if (name && l && !name.toLowerCase().includes(l.toLowerCase())) return `${name} (${l})`;
  return name || l || lang || `Pista ${i + 1}`;
}

export function resetVideo(v) {
  v.onerror = null;
  if (v.audioTracks) v.audioTracks.onaddtrack = null;
  v.textTracks.onaddtrack = null;
  for (const t of v.textTracks) t.mode = 'disabled';
  v.removeAttribute('src');
  v.load();
}
