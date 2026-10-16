// Automatic backup channels: other versions of the same channel, found by name.
// "M+ LaLiga 1 HD" ≈ "LALIGA 1 FHD" ≈ "ES: LaLiga 1 ᴴᴰ HEVC" ≈ "LaLiga 1 SD": quality tags, country
// prefixes and the operator brand are ignored, everything else (including numbers) must match.

const MAX = 6;
const QUALITY = new Set(['uhd', '4k', 'fhd', 'fullhd', 'hd', 'sd', 'hevc', 'h265', 'h264', 'x265', 'x264', 'fh', 'hq', 'lq',
  '1080', '1080p', '1080i', '720', '720p', '2160', '2160p', '50fps', '60fps', '25fps', 'fps', 'raw', 'vip', 'backup', 'bk', 'alt',
  'multi', 'multiaudio', 'dual', 'ott', 'hdr', 'sdr', 'low', 'high', 'tv']);
const BRAND = new Set(['movistar', 'movi', 'mov', 'm', 'plus', 'mplus']);
const DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const COUNTRY = new Set(['es', 'esp', 'spa', 'spain', 'espana']);

function words(name) {
  return String(name).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/(^|\s)\+\s?(\d)\b/g, (_, a, d) => ` timeshift${DIGITS[d]} `)   // "+1" channels are different channels
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

// Normalized identity of a channel ('' when nothing meaningful is left).
export function channelKey(name) {
  const keep = w => !QUALITY.has(w) && !BRAND.has(w) && !COUNTRY.has(w);
  const toks = words(name).filter(keep).flatMap(w => w.split(/(?<=[a-z])(?=\d)|(?<=\d)(?=[a-z])/)).filter(keep);
  return [...new Set(toks)].sort().join(' ');
}

// Preferred order: Full HD, HD, untagged, 4K, HEVC (not every browser decodes it), SD.
function rank(name) {
  const w = new Set(words(name).flatMap(x => x.split(/(?<=[a-z])(?=\d)|(?<=\d)(?=[a-z])/)));
  if (w.has('hevc') || w.has('h265') || w.has('x265')) return 4;
  if (w.has('fhd') || w.has('fullhd') || w.has('1080') || w.has('1080p') || (w.has('fh') && !w.has('sd'))) return 0;
  if (w.has('uhd') || w.has('4k') || w.has('2160') || w.has('2160p')) return 3;
  if (w.has('hd') || w.has('720') || w.has('720p')) return 1;
  if (w.has('sd') || w.has('lq') || w.has('low')) return 5;
  return 2;
}

const cache = { items: null, n: 0, index: null };

// ids of the other versions of channel `ch` among `items`, best first.
export function autoBackups(ch, items) {
  if (cache.items !== items || cache.n !== items.length) {
    const index = new Map();
    for (const it of items) {
      const k = channelKey(it.name);
      if (!k) continue;
      let a = index.get(k);
      if (!a) index.set(k, a = []);
      a.push(it);
    }
    Object.assign(cache, { items, n: items.length, index });
  }
  const k = channelKey(ch.name);
  if (!k) return [];
  return (cache.index.get(k) || [])
    .filter(c => c.id !== ch.id)
    .map(c => [c, rank(c.name)])
    .sort((a, b) => a[1] - b[1] || a[0].name.localeCompare(b[0].name))
    .slice(0, MAX)
    .map(([c]) => c.id);
}
