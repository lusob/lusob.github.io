// Automatic backup channels: other versions of the same channel, found by name.
// "M+ LaLiga 1 HD" ≈ "LALIGA 1 FHD" ≈ "ES: LaLiga 1 ᴴᴰ HEVC" ≈ "LaLiga 1 SD": quality tags, country
// prefixes and the operator brand are ignored, everything else (including numbers) must match.

const MAX = 40;   // every version: they are tried one after another until one works
const QUALITY = new Set(['uhd', '4k', 'fhd', 'fullhd', 'hd', 'sd', 'hevc', 'h265', 'h264', 'x265', 'x264', 'fh', 'hq', 'lq',
  '1080', '1080p', '1080i', '720', '720p', '2160', '2160p', '50fps', '60fps', '25fps', 'fps', 'raw', 'vip', 'backup', 'bk', 'alt',
  'multi', 'multiaudio', 'dual', 'ott', 'hdr', 'sdr', 'low', 'high', 'tv', 'solo', 'eventos', 'fibra', 'ppv', 'avatel', 'test', 'gp']);
const BRAND = new Set(['movistar', 'movi', 'mov', 'm', 'plus', 'mplus']);
const DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine'];
const COUNTRY = new Set(['es', 'esp', 'spa', 'spain', 'espana']);

const lower = name => String(name).normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();

function words(name) {
  return lower(name)
    .replace(/(^|\s)\+\s?(\d)\b/g, (_, a, d) => ` timeshift${DIGITS[d]} `)   // "+1" channels are different channels
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
}

// The same channel spelled differently by each list ("M+ LA LIGA TV 3" / "M. LaLiga 3",
// "Liga DE Campeones 2" / "M+ Campeones 2", "DAZN Formula 1" / "DAZN F1", "DAZN 1 | OP2"…).
const SPELLINGS = [
  [/\bop\s?\d\b/g, ' '], [/\bh\.?26[45]\b/g, ' '], [/\besp-\d+\s*:/g, ' '],
  [/\bla\s?liga\s?tv\b|\bla\s+liga\b|\blaligatv\b/g, 'laliga'], [/\bliga\s+(de\s+)?campeones\b/g, 'campeones'],
  [/\bformula\s?(f\s?)?1\b/g, 'f1'], [/\bmoto\s?gp\b/g, 'motogp'], [/\bdeporte\b/g, 'deportes'], [/\bsmartbank\b/g, 'hypermotion'],
  [/\bref\s+federacion\b/g, 'primera federacion'], [/\bfdf\b/g, 'factoria de ficcion'], [/\b24\s?h\b/g, '24 horas'],
  [/\bdazn\s+baloncesto\b/g, 'dazn acb'],
  // Renamed or shortened: "M+ Cine" is the guide's "M+ Estrenos" (not "M+ Cine Español"),
  // "Hollywood" "Canal Hollywood", "MAX Avances" "HBO Max Avances", "Iberalia 100% Caza" "Iberalia caza"…
  [/\b(m\+|movistar\s*(plus\+?)?)\s*cine(?=(\s+(fhd|hd|sd|uhd|4k))*\s*$)/g, 'm+ estrenos'], [/\bcanal\s+hollywood\b/g, 'hollywood'],
  [/\bhbo\s+max\b/g, 'max'], [/\bclan\s+tve\b/g, 'clan'], [/\biberalia\s+100\s*%\s*/g, 'iberalia '], [/\bcataluna\b/g, 'catalunya'],
  [/\bcnn\s+internacional\b|\bcnn\s+international(\s+europe)?\b/g, 'cnn internacional'], [/\bandorra\s+television\b/g, 'andorra'],
];
const respell = name => SPELLINGS.reduce((t, [re, to]) => t.replace(re, to), lower(name));

// Normalized identity of a channel ('' when nothing meaningful is left).
export function channelKey(name) {
  const keep = w => !QUALITY.has(w) && !BRAND.has(w) && !COUNTRY.has(w);
  const all = words(respell(name));
  const toks = all.filter(keep).flatMap(w => w.split(/(?<=[a-z])(?=\d)|(?<=\d)(?=[a-z])/)).filter(keep);
  // Nothing but the brand ("Movistar Plus+", "M+ Plus", "M+ 2"): the Movistar Plus+ channel itself
  if (!toks.some(w => /[a-z]/.test(w)) && all.some(w => BRAND.has(w))) toks.unshift('movistarplus');
  if (!toks.length) return '';
  // "DAZN LaLiga" is "DAZN LaLiga 1"
  if (!toks.some(w => /^\d+$/.test(w))) toks.push('1');
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

// SD versions last; otherwise most recently added first (dead copies tend to be the old ones), then by quality.
const isSd = it => rank(it.name) === 5;
const newest = (a, b) => isSd(a) - isSd(b) || (b.added || 0) - (a.added || 0) || rank(a.name) - rank(b.name) || a.name.localeCompare(b.name);

// channelKey → versions of that channel, newest first.
function index(items) {
  if (cache.items !== items || cache.n !== items.length) {
    const index = new Map();
    for (const it of items) {
      const k = channelKey(it.name);
      if (!k) continue;
      let a = index.get(k);
      if (!a) index.set(k, a = []);
      a.push(it);
    }
    for (const a of index.values()) a.sort(newest);
    Object.assign(cache, { items, n: items.length, index });
  }
  return cache.index;
}

// ids of the other versions of channel `ch` among `items`, newest first.
export function autoBackups(ch, items) {
  const k = channelKey(ch.name);
  if (!k) return [];
  return (index(items).get(k) || []).filter(c => c.id !== ch.id).slice(0, MAX).map(c => c.id);
}

// One entry per channel among `items` (its preferred version, in the place of the first one seen):
// [{ item, all: [versions, preferred first] }]. Nameless keys stay on their own.
export function groupVersions(items) {
  const groups = new Map(), out = [];
  for (const it of items) {
    const k = channelKey(it.name) || '#' + it.id;
    let g = groups.get(k);
    if (!g) { groups.set(k, g = { item: it, all: [] }); out.push(g); }
    g.all.push(it);
  }
  for (const g of out) if (g.all.length > 1) g.item = (g.all = [...g.all].sort(newest))[0];
  return out;
}

// Spanish Movistar+ / DAZN sports channels, one entry per channel (its newest version; the
// others become its backups), in one folder per sport.
export const SPORTS = [
  ['futbol', '⚽ Fútbol', ['laliga', 'liga', 'campeones', 'champions', 'futbol', 'copa', 'hypermotion', 'federacion', 'ref', 'replay', 'highlights', 'uefa', 'europa', 'premier', 'bundesliga', 'calcio']],
  ['basket', '🏀 Baloncesto', ['nba', 'acb', 'euroleague', 'euroliga', 'baloncesto', 'basket']],
  ['f1', '🏎 Fórmula 1', ['f1']],
  ['moto', '🏍 MotoGP', ['motogp', 'moto', 'superbike', 'sbk']],
  ['golf', '⛳ Golf', ['golf']],
  ['tenis', '🎾 Tenis', ['tenis', 'tennis', 'atp', 'wta']],
  ['lucha', '🥊 Boxeo y UFC', ['box', 'boxeo', 'ufc', 'mma', 'wwe']],
  ['toros', '🐂 Toros', ['toros']],
  ['otros', '🏅 Deportes y eventos', []],
];
const FOREIGN = /┃(?!es┃)[a-z]{2}┃|^\s*(?!es\b|esp\b)[a-z]{2,3}\s*[:|]|^\s*lat\b|^\s*#\d|\((?!es\))[a-z]{2,3}\)\s*$|\[(?!esp\])[a-z]{3}\]/;
const SPANISH = /┃es┃|^\s*esp?\s*[:|]|\(es\)|\bspain\b|\[esp\]|\besp-\d|\bespana\b|\besp\b/;
const BRANDED = /\bm\s?\+|\bm\.\s|\bmovistar\b|\bdazn\b|^\W*vamos\b|\bliga\s+(de\s+)?campeones\b/;

// Versions of a channel called `name` among `items` (newest first, SD last).
export const findChannels = (name, items) => index(items).get(channelKey(name)) || [];
export const isForeign = name => FOREIGN.test(lower(name));

function isSpanishSport(it, folder) {
  const n = lower(it.name), f = lower(folder);
  if (FOREIGN.test(n) || /24\s*\/\s*7/.test(n)) return false;
  if (!(SPANISH.test(n) || SPANISH.test(f))) return false;
  return BRANDED.test(n) || BRANDED.test(f);
}

function sportOf(key) {
  const t = key.split(' ');
  if (t.includes('f')) return 'f1';    // "F1" → "f 1"
  const sport = SPORTS.find(([, , kw]) => kw.some(w => t.includes(w)))?.[0];
  // Anything else only when it is clearly a sports channel (not M+ Cine, Series…)
  return sport || (['dazn', 'deportes', 'vamos', 'ellas'].some(w => t.includes(w)) ? 'otros' : null);
}

// → { groups: Map sportId → entries (each a copy of the newest visible version, with `versions`),
//     alts: Map id → ids of the other Spanish versions (their backups, instead of any country's) }
export function sportsChannels(items, visible, folderOf) {
  const out = new Map(SPORTS.map(([id]) => [id, []]));
  const alts = new Map();
  for (const [k, versions] of index(items)) {
    const sport = sportOf(k);
    if (!sport) continue;
    const es = versions.filter(it => isSpanishSport(it, folderOf(it)));
    for (const it of es) alts.set(it.id, es.filter(c => c !== it).slice(0, MAX).map(c => c.id));
    const vis = es.filter(visible);
    if (vis.length) out.get(sport).push({ ...vis[0], versions: es.length });
  }
  const label = it => words(it.name).filter(w => !QUALITY.has(w) && !COUNTRY.has(w)).join(' ');
  for (const a of out.values()) a.sort((a, b) => label(a).localeCompare(label(b), 'es', { numeric: true }));
  return { groups: out, alts };
}
