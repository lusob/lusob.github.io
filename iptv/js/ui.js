// Small DOM helpers and a fixed-row-height virtual list (lists can have tens of thousands of items).

export const $ = sel => document.querySelector(sel);

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ESC[c]);

export const norm = s => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

const DAY = 86400;
export function ago(sec) {
  if (!sec) return '';
  const days = Math.floor((Date.now() / 1000 - sec) / DAY);
  if (days < 1) return 'hoy';
  if (days < 2) return 'ayer';
  if (days < 30) return `hace ${days} d`;
  return new Date(sec * 1000).toLocaleDateString('es-ES', { day: 'numeric', month: 'short', year: 'numeric' });
}

export const isNew = (sec, days = 7) => sec > 0 && Date.now() / 1000 - sec < days * DAY;

export function initials(name) {
  return esc(String(name).replace(/[^\p{L}\p{N} ]/gu, ' ').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase());
}

let toastTimer;
export function toast(msg, ms = 4000) {
  const el = $('#toast');
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

export function loading(text) {
  $('#loading').hidden = !text;
  $('#loadingText').textContent = text || '';
}

export class VList {
  constructor(el, rowH, render, onClick, onDraw) {
    this.el = el;
    this.rowH = rowH;
    this.render = render;
    this.onDraw = onDraw;
    this.items = [];
    this.nodes = new Map();
    el.classList.add('vlist');
    el.innerHTML = '<div class="vl-spacer"></div><div class="vl-win"></div>';
    this.spacer = el.firstChild;
    this.win = el.lastChild;
    el.addEventListener('scroll', () => this.schedule(), { passive: true });
    if (window.ResizeObserver) new ResizeObserver(() => this.draw()).observe(el);
    else window.addEventListener('resize', () => this.draw());
    el.addEventListener('click', e => {
      const row = e.target.closest('[data-i]');
      if (!row) return;
      const i = +row.dataset.i;
      const act = e.target.closest('[data-act]')?.dataset.act || null;
      onClick(this.items[i], i, act);
    });
  }

  set(items, resetScroll = true) {
    this.items = items;
    this.spacer.style.height = items.length * this.rowH + 'px';
    if (resetScroll) this.el.scrollTop = 0;
    this.draw(true);
  }

  refresh() { this.draw(true); }

  // Remote-control cursor: highlighted row, kept in view.
  setCursor(i, show = true) {
    this.cursor = Math.max(0, Math.min(i, this.items.length - 1));
    this.showCursor = show && this.items.length > 0;
    if (show && this.items.length) {
      const top = this.cursor * this.rowH, el = this.el;
      if (top < el.scrollTop) el.scrollTop = top;
      else if (top + this.rowH > el.scrollTop + el.clientHeight) el.scrollTop = top + this.rowH - el.clientHeight;
      this.draw();
    }
    this.paintCursor();
  }

  paintCursor() {
    for (const [i, n] of this.nodes) n.classList.toggle('kfocus', !!this.showCursor && i === this.cursor);
  }

  node(i) { return this.nodes.get(i); }

  updateRow(i) {
    const n = this.nodes.get(i);
    if (n) n.innerHTML = this.render(this.items[i], i);
    this.onUpdate?.(i);
  }

  // Re-render the visible rows matching pred(item).
  updateWhere(pred) {
    for (const [i, n] of this.nodes) if (pred(this.items[i])) n.innerHTML = this.render(this.items[i], i);
  }

  visibleItems() {
    return this.items.slice(this.s ?? 0, this.e ?? 0);
  }

  schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); });
  }

  draw(force = false) {
    const h = this.el.clientHeight || window.innerHeight;
    const top = this.el.scrollTop;
    const s = Math.max(0, Math.floor(top / this.rowH) - 6);
    const e = Math.min(this.items.length, Math.ceil((top + h) / this.rowH) + 6);
    if (!force && s === this.s && e === this.e) return;
    this.s = s; this.e = e;
    if (force) { this.win.textContent = ''; this.nodes.clear(); }
    for (const [i, n] of this.nodes) {
      if (i < s || i >= e) { n.remove(); this.nodes.delete(i); }
    }
    const frag = document.createDocumentFragment();
    for (let i = s; i < e; i++) {
      if (this.nodes.has(i)) continue;
      const d = document.createElement('div');
      d.className = 'vl-row';
      d.dataset.i = i;
      d.style.top = i * this.rowH + 'px';
      d.style.height = this.rowH + 'px';
      d.innerHTML = this.render(this.items[i], i);
      frag.appendChild(d);
      this.nodes.set(i, d);
    }
    this.win.appendChild(frag);
    this.paintCursor();
    this.onDraw?.();
  }
}
