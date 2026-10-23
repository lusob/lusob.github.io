// Horizontal TV guide of a folder's channels: one row per channel, time across (12 h from just
// before now), a red line at the current time. A programme on now plays its channel; a later one
// opens its options (record, remind…). The corner button scrolls back to now.

import { esc, initials } from './ui.js?v=20261023a';
import { hhmm } from './epg.js?v=20261023a';

const PX = 4;               // px per minute (240 px per hour)
const SPAN = 12 * 60;       // minutes shown
const MAX = 300;            // channels drawn at most

export class Grid {
  // ctx: { guide(item) → [{ title, start, end }] | null, wantEpg(items), play(items, i), later(item, prog),
  //        mark(item, prog) → prefix ('🔔 ' reminder, '⏺ ' recording) }
  constructor(el, ctx) {
    this.el = el;
    this.ctx = ctx;
    this.items = [];
    el.addEventListener('click', e => {
      const c = e.target.closest('.gcell');
      if (!c) return;
      if (c.dataset.now != null) return this.toNow();
      const i = +c.dataset.i, it = this.items[i];
      const p = c.dataset.p != null ? this.progs[i][+c.dataset.p] : null;
      if (p && p.start > Date.now() / 1000) this.ctx.later(it, p);
      else this.ctx.play(this.items, i);
    });
    setInterval(() => { if (!el.hidden) this.tick(); }, 60e3);
  }

  // groups: [{ item, all: [its versions] }], one row each (the versions share the programmes).
  show(groups) {
    this.itemsTotal = groups.length;
    groups = groups.slice(0, MAX);
    this.items = groups.map(g => g.item);
    this.versions = groups.map(g => g.all);
    this.ctx.wantEpg(this.items.slice(0, 60));
    this.draw(true);
  }

  // Redraw keeping the scroll position (new guide data, a new minute).
  refresh() {
    if (!this.el.hidden && this.items.length) this.draw(false);
  }

  toNow() {
    const x = Math.round((Date.now() / 1000 - this.t0) / 60 * PX);
    this.el.scrollTo({ left: Math.max(0, x - 90), behavior: 'smooth' });
  }

  tick() {
    if (Date.now() / 1000 - this.t0 > 3 * 3600) return this.draw(false);   // window drifted: start again
    this.refresh();
  }

  draw(reset) {
    const now = Date.now() / 1000;
    const t0 = this.t0 = Math.floor((now - 1800) / 1800) * 1800, t1 = t0 + SPAN * 60;
    const x = t => Math.round((Math.max(t0, Math.min(t1, t)) - t0) / 60 * PX);
    const sl = this.el.scrollLeft, st = this.el.scrollTop;
    const cw = matchMedia('(max-width: 760px)').matches ? 120 : 230;   // channel column (as in the CSS)
    const focus = this.el.querySelector('.gcell.kfocus');
    const keep = focus && !reset ? `.gcell[data-i="${focus.dataset.i}"]${focus.dataset.p != null ? `[data-p="${focus.dataset.p}"]` : ':not([data-p])'}` : null;
    let head = '';
    for (let t = t0; t < t1; t += 1800) head += `<div class="g-tick" style="left:${x(t)}px">${hhmm(t)}</div>`;
    this.progs = [];
    const rows = this.items.map((it, i) => {
      let all = this.ctx.guide(it);
      for (const v of this.versions[i]) if (!all?.length) all = this.ctx.guide(v);
      all ||= [];
      const n = this.versions[i].length;
      const progs = this.progs[i] = all.filter(p => p.end > t0 && p.start < t1);
      const cells = progs.map((p, j) => {
        const on = p.start <= now && p.end > now, past = p.end <= now;
        return `<button class="gcell${on ? ' on' : ''}${past ? ' past' : ''}" data-i="${i}" data-p="${j}" style="left:${x(p.start)}px;width:${Math.max(x(p.end) - x(p.start) - 2, 6)}px" title="${esc(p.title)}">
          <span class="g-pt">${esc(this.ctx.mark?.(it, p) || '')}${esc(p.title || 'Sin título')}</span><span class="g-pm">${hhmm(p.start)}–${hhmm(p.end)}</span></button>`;
      }).join('');
      return `<div class="g-line">
        <button class="gcell gch" data-i="${i}" title="${esc(it.name)}"><span class="logo">${initials(it.name)}${it.icon ? `<img src="${esc(it.icon)}" alt="" loading="lazy" onerror="this.remove()">` : ''}</span><span class="g-nm"><span class="g-name">${esc(it.name)}</span>${n > 1 ? `<small class="g-vers">${n} versiones</small>` : ''}</span></button>
        <div class="g-track" style="width:${SPAN * PX}px">${cells || `<button class="gcell none" data-i="${i}" style="left:0;width:${SPAN * PX - 2}px"><span class="g-pt">Sin guía · toca para ver el canal</span></button>`}</div>
      </div>`;
    }).join('');
    const more = this.items.length < this.itemsTotal ? `<div class="g-more">Mostrando ${this.items.length} canales</div>` : '';
    this.el.innerHTML = `<div class="g-wrap" style="width:${SPAN * PX + cw}px">
      <div class="g-head"><button class="gcell g-corner" data-now title="Volver a la hora actual">⟲ Ahora</button><div class="g-ruler" style="width:${SPAN * PX}px">${head}</div></div>
      ${rows}${more}
      <div class="g-now" style="left:${cw + x(now)}px"></div>
    </div>`;
    if (reset) {
      this.el.scrollTop = 0;
      this.el.scrollLeft = Math.max(0, x(now) - 90);
    } else {
      this.el.scrollLeft = sl;
      this.el.scrollTop = st;
      if (keep) (this.el.querySelector(keep) || this.el.querySelector(`.gcell[data-i="${focus.dataset.i}"]`))?.classList.add('kfocus');
    }
  }
}
