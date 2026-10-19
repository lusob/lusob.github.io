// localStorage for small state (credentials, favorites, UI); IndexedDB for large cached lists.

const PREFIX = 'iptv.';

export function get(key, fallback = null) {
  try {
    const v = localStorage.getItem(PREFIX + key);
    return v == null ? fallback : JSON.parse(v);
  } catch {
    return fallback;
  }
}

// Called with the key after every change made by the app (see sync.js); quiet = from the sync itself.
let onChange = null;
export const watch = fn => { onChange = fn; };

export function set(key, value, quiet = false) {
  try { localStorage.setItem(PREFIX + key, JSON.stringify(value)); } catch {}
  if (!quiet) onChange?.(key);
}

export function del(key, quiet = false) {
  try { localStorage.removeItem(PREFIX + key); } catch {}
  if (!quiet) onChange?.(key);
}

let dbPromise;
function db() {
  return dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open('iptv', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('cache');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(mode, fn) {
  return db().then(d => new Promise((resolve, reject) => {
    const t = d.transaction('cache', mode);
    const req = fn(t.objectStore('cache'));
    t.oncomplete = () => resolve(req?.result ?? null);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

// Never blocks the app: some browsers leave IndexedDB requests hanging.
const within = (p, ms) => Promise.race([p, new Promise(r => setTimeout(() => r(null), ms))]);

export async function cacheGet(key) {
  try { return await within(tx('readonly', s => s.get(key)), 4000); } catch { return null; }
}

export async function cachePut(key, value) {
  try { await within(tx('readwrite', s => s.put(value, key)), 15000); } catch {}
}

export async function cacheClear() {
  try { await within(tx('readwrite', s => s.clear()), 4000); } catch {}
}
