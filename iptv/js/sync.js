// Shared data between screens through the Raspberry Pi (recorder.py, /api/sync) when the app is
// opened from it: favourites, hidden folders, teams, reminders, «continue watching», channel
// assignments, recent searches and a few settings. Each key: last change wins. The first time a
// screen connects its data is merged with the Pi's (lists joined) instead of being replaced.

import * as store from './store.js?v=20261023a';

const SHARED = /^(fav|bk|hideF|remind|hist|alias|autoRec|rec):|^(teams|recentQ|settings)$/;
// Settings that follow the user; the rest (buffer, picture fit, full screen…) belong to each screen.
const SHARED_SETTINGS = ['epg', 'cuShift', 'vod', 'autoRec', 'hideSports'];
const PUSH_DELAY = 1500;

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const isObj = x => x && typeof x === 'object' && !Array.isArray(x);

// First connection: both sides kept (arrays joined, objects key by key; otherwise the Pi's).
function merge(key, local, remote) {
  if (local == null) return remote;
  if (remote == null) return local;
  if (Array.isArray(local) && Array.isArray(remote)) {
    const out = [...remote];
    for (const x of local) if (!out.some(y => same(x, y))) out.push(x);
    if (key.startsWith('hist:')) {
      // The newest of each thing watched
      const seen = new Set();
      return out.sort((a, b) => (b.t || 0) - (a.t || 0)).filter(h => { const k = h.k + '|' + h.id; return !seen.has(k) && seen.add(k); }).slice(0, 20);
    }
    return out;
  }
  if (isObj(local) && isObj(remote)) {
    const out = { ...local };
    for (const k in remote) out[k] = merge(k, local[k], remote[k]);
    return out;
  }
  return remote;
}

// What is sent of a key, and how a received value is stored.
const outgoing = (key, v) => key === 'settings' && isObj(v) ? Object.fromEntries(SHARED_SETTINGS.filter(k => k in v).map(k => [k, v[k]])) : v;
const incoming = (key, v) => key === 'settings' ? { ...store.get('settings', {}), ...v } : v;

function localKeys() {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith('iptv.') && SHARED.test(k.slice(5))) out.push(k.slice(5));
    }
  } catch {}
  return out;
}

// onRemote(keys): data changed by another screen (already stored).
export function initSync(api, onRemote) {
  let rev = store.get('syncRev', -1);   // -1: never synced on this screen
  const dirty = new Set();
  let timer = null, chain = Promise.resolve();
  // One request at a time: a read crossing a send could bring back what was just replaced.
  const serial = fn => (chain = chain.then(fn, fn));
  const status = { ok: false, at: 0, error: '' };

  store.watch(key => {
    if (!SHARED.test(key)) return;
    dirty.add(key);
    clearTimeout(timer);
    timer = setTimeout(push, PUSH_DELAY);
  });

  const push = () => serial(doPush);
  const pull = () => serial(doPull);

  async function doPush() {
    if (rev < 0 || !dirty.size) return;
    const keys = [...dirty];
    dirty.clear();
    try {
      await api('PUT', 'sync', { keys: Object.fromEntries(keys.map(k => [k, outgoing(k, store.get(k))])) });
      status.ok = true; status.error = '';
    } catch (e) {
      keys.forEach(k => dirty.add(k));   // again later
      status.ok = false; status.error = e.message;
    }
  }

  async function doPull() {
    try {
      const first = rev < 0;
      const j = await api('GET', 'sync?since=' + Math.max(0, rev));
      if (j.rev < rev) rev = 0;   // the Pi's store was reset
      const changed = [];
      for (const [k, v] of Object.entries(j.keys || {})) {
        if (!SHARED.test(k) || dirty.has(k)) continue;   // a change of ours still to be sent wins
        const mine = store.get(k);
        let val = first ? merge(k, outgoing(k, mine), v) : v;
        if (first && !same(val, v)) dirty.add(k);
        val = incoming(k, val);
        if (same(val, mine)) continue;
        if (val == null) store.del(k, true); else store.set(k, val, true);
        changed.push(k);
      }
      if (first) for (const k of localKeys()) if (!(k in (j.keys || {}))) dirty.add(k);   // only here so far
      rev = j.rev;
      store.set('syncRev', rev, true);
      status.ok = true; status.at = Date.now(); status.error = '';
      if (changed.length) onRemote(changed);
      if (dirty.size) await doPush();
    } catch (e) {
      status.ok = false; status.error = e.message;
    }
  }

  pull();
  setInterval(pull, 8000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) pull(); else push(); });
  return { pull, push, status };
}
