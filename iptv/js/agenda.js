// Sports agenda: agenda.json (futbolenlatv.es, refreshed once a day by tools/agenda.py) shown as
// folders (now & next, days, sports) and a chronological list. Each event's channels are matched
// with the live list so a press plays the broadcast.

import { esc } from './ui.js?v=20261017e';

export const NOW = 'ag:now', DAY = 'ag:day:', SPORT = 'ag:sport:', MINE = 'ag:mine';

const ICONS = {
  'Fútbol': '⚽', 'Fútbol Sala': '⚽', 'Baloncesto': '🏀', 'Tenis': '🎾', 'Pádel': '🎾', 'Balonmano': '🤾', 'Ciclismo': '🚴',
  'Motociclismo': '🏍', 'Automovilismo': '🏎', 'Fórmula 1': '🏎', 'Golf': '⛳', 'Boxeo': '🥊', 'MMA': '🥊', 'Rugby U': '🏉',
  'Rugby': '🏉', 'Fútbol Americano': '🏈', 'Béisbol': '⚾', 'Atletismo': '🏃', 'Hockey Patines': '🏑', 'Hockey Hielo': '🏒',
  'Voleibol': '🏐', 'Natación': '🏊', 'Esquí': '⛷', 'Waterpolo': '🤽', 'Dardos': '🎯', 'Snooker': '🎱', 'Ajedrez': '♟',
};
export const icon = sport => ICONS[sport] || '🏅';

const DAYS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
const hm = t => new Date(t * 1000).toLocaleTimeString('es-ES', { hour: '2-digit', minute: '2-digit' });
const dayKey = t => { const d = new Date(t * 1000); return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`; };

function dayName(t) {
  const d = new Date(t * 1000), today = new Date();
  const diff = Math.round((new Date(d.getFullYear(), d.getMonth(), d.getDate()) - new Date(today.getFullYear(), today.getMonth(), today.getDate())) / 864e5);
  const base = `${DAYS[d.getDay()]} ${d.getDate()}`;
  return diff === 0 ? `Hoy, ${base}` : diff === 1 ? `Mañana, ${base}` : base[0].toUpperCase() + base.slice(1);
}

// "DAZN 1 (M72)" → "DAZN 1"; "LaLiga TV M2" → "M+ LaLiga 2"; "M+ #Vamos Bar (307)" → "M+ Vamos Bar".
export function cleanChannel(name) {
  return name.replace(/\([^)]*\)/g, ' ').replace(/#/g, ' ')
    .replace(/\blaliga\s+tv\s+m(\d+)\b/i, 'M+ LaLiga $1')
    .replace(/\s+/g, ' ').trim();
}

export class Agenda {
  constructor() {
    this.events = [];
    this.updated = 0;
    this.error = '';
  }

  async load(force = false) {
    if (this.events.length && !force && Date.now() - this.loadedAt < 3600e3) return;
    try {
      const r = await fetch(`agenda.json?d=${new Date().toISOString().slice(0, 13)}`, { cache: 'no-cache' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      this.events = j.events.map((e, i) => ({ ...e, id: 'ev' + i, ev: true, end: e.t + (e.dur || 120) * 60,
        key: [e.home, e.away, e.title, e.comp, e.stage, e.sport, ...e.channels].filter(Boolean).join(' ').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase() }));
      this.updated = j.updated;
      this.loadedAt = Date.now();
      this.error = '';
    } catch (e) {
      this.error = e.message || String(e);
    }
  }

  // events: those to show (already filtered by "only my channels")
  folders(events) {
    const now = Date.now() / 1000;
    const upcoming = events.filter(e => e.end > now);
    const rows = [{ id: NOW, name: '⏱ Ahora y próximos', count: upcoming.length, extra: `${upcoming.filter(e => e.t <= now).length} en directo` }];
    const days = new Map();
    for (const e of events) {
      const k = dayKey(e.t);
      if (!days.has(k)) days.set(k, { id: DAY + k, name: '📅 ' + dayName(e.t), count: 0 });
      days.get(k).count++;
    }
    rows.push(...[...days.values()].filter(d => d.id >= DAY + dayKey(now) || events.some(e => DAY + dayKey(e.t) === d.id && e.end > now)));
    const sports = new Map();
    for (const e of upcoming) sports.set(e.sport, (sports.get(e.sport) || 0) + 1);
    rows.push(...[...sports].sort((a, b) => b[1] - a[1]).map(([s, n]) => ({ id: SPORT + s, name: `${icon(s)} ${s}`, count: n })));
    return rows;
  }

  list(events, folder, query) {
    const now = Date.now() / 1000;
    if (query) {
      const q = query.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase();
      return { list: events.filter(e => e.end > now && e.key.includes(q)), title: `“${query}”` };
    }
    if (folder?.startsWith(DAY)) {
      const k = folder.slice(DAY.length);
      const list = events.filter(e => dayKey(e.t) === k);
      return { list, title: list.length ? dayName(list[0].t) : 'Agenda' };
    }
    if (folder?.startsWith(SPORT)) {
      const s = folder.slice(SPORT.length);
      return { list: events.filter(e => e.sport === s && e.end > now), title: `${icon(s)} ${s}` };
    }
    return { list: events.filter(e => e.end > now), title: 'Ahora y próximos' };
  }
}

// One list row. chans: [{ name, item | null }] (available first).
export function eventRow(e, chans, showDay) {
  const now = Date.now() / 1000;
  const live = e.t <= now && e.end > now, over = e.end <= now;
  const title = e.home
    ? `<span class="ag-team">${esc(e.home)}</span><span class="ag-vs">–</span><span class="ag-team">${esc(e.away)}</span>`
    : `<span class="ag-team">${esc(e.title)}</span>`;
  const shown = chans.slice(0, 3);
  const more = chans.length - shown.length;
  return `<div class="row ag${over ? ' over' : ''}${live ? ' live' : ''}">
    <div class="ag-time">${live ? '<b class="ag-live">DIRECTO</b>' : `<b>${hm(e.t)}</b>`}${showDay ? `<small>${esc(dayName(e.t).replace(/^(Hoy|Mañana), .*/, '$1'))}</small>` : ''}</div>
    <div class="ag-icon" title="${esc(e.sport)}">${icon(e.sport)}</div>
    <div class="grow">
      <div class="meta ag-comp">${esc(e.comp)}${e.stage ? ` · ${esc(e.stage)}` : ''}</div>
      <div class="name ag-title">${title}</div>
    </div>
    <div class="ag-chans">${shown.map((c, i) => c.item
      ? `<button class="chip on" data-act="ch:${i}" title="Ver en ${esc(c.item.name)}">▶ ${esc(c.name)}</button>`
      : `<span class="chip off" title="No está en tu lista">${esc(c.name)}</span>`).join('')}${more > 0 ? `<span class="chip more">+${more}</span>` : ''}</div>
  </div>`;
}
