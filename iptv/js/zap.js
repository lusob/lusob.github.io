// Zapping over the live player without stopping it (like OTT Navigator):
// - Left opens a channel list on the left (the folder being watched); Left again shows the
//   folders; OK plays, Back / Right closes.
// - Up / Down ("pilot") browses the neighbouring channels in a translucent footer with their
//   programme; nothing changes until OK.

import { esc, initials, VList } from './ui.js?v=20261017g';
import { hhmm } from './epg.js?v=20261017g';

const PILOT_HIDE = 6000;   // ms without keys before the footer goes away (without switching)
const INFO_HIDE = 4000;    // footer shown briefly after every channel change

export class Zapper {
  // ctx: { player, epg() → Epg | null, enabled() → bool, folders() → [{ id, name, count }],
  //        folderItems(id) → Promise<items>, play(items, index, title, folderId) }
  constructor(ctx) {
    this.ctx = ctx;
    const root = ctx.player.root;
    this.side = root.querySelector('#zap');
    this.titleEl = root.querySelector('#zTitle');
    this.backBtn = root.querySelector('#zBack');
    this.pilotEl = root.querySelector('#pilot');
    this.mode = 'chans';
    this.items = [];
    this.list = new VList(root.querySelector('#zList'), 68, (x, i) => this.row(x, i), (x, i) => this.pick(i), () => this.wantEpg());
    this.backBtn.onclick = () => this.mode === 'chans' ? this.showFolders() : this.backToChans();
    root.querySelector('#zClose').onclick = () => this.close();
    this.side.addEventListener('click', e => e.stopPropagation());
    root.addEventListener('click', () => this.close());
    this.pilotEl.addEventListener('click', e => { e.stopPropagation(); this.go(); });
  }

  get isOpen() { return !this.side.hidden; }
  get pilotOn() { return !this.pilotEl.hidden; }

  // ---------------------------------------------------------------- side list

  openChans() {
    const p = this.ctx.player;
    this.folderId = p.queueFolder;
    this.showChans(p.queue || [], p.queueTitle || 'Canales', p.index);
  }

  showChans(items, title, cursor = 0) {
    this.hidePilot();
    this.mode = 'chans';
    this.items = items;
    this.title = title;
    this.titleEl.textContent = title;
    this.backBtn.textContent = '‹ Carpetas';
    this.side.hidden = false;
    this.side.classList.remove('folders');
    this.fill(items, cursor);
  }

  backToChans() {
    const cur = this.ctx.player.current;
    this.showChans(this.items, this.title, Math.max(0, this.items.findIndex(x => x.id === cur?.id)));
  }

  showFolders() {
    this.mode = 'folders';
    this.folders = this.ctx.folders();
    this.titleEl.textContent = 'Carpetas';
    this.backBtn.textContent = '‹ Canales';
    this.side.classList.add('folders');
    this.fill(this.folders, Math.max(0, this.folders.findIndex(f => f.id === this.folderId)));
  }

  fill(rows, cursor) {
    const l = this.list;
    l.set(rows);
    l.el.scrollTop = Math.max(0, cursor * l.rowH - l.el.clientHeight / 2 + l.rowH / 2);
    l.setCursor(cursor, true);
  }

  close() {
    if (this.isOpen) this.side.hidden = true;
  }

  async pick(i) {
    if (this.mode === 'chans') {
      if (!this.items[i]) return;
      this.close();
      this.ctx.play(this.items, i, this.title, this.folderId);
      return;
    }
    const f = this.folders[i];
    if (!f) return;
    this.titleEl.textContent = `${f.name} · cargando…`;
    const items = await this.ctx.folderItems(f.id);
    if (this.mode !== 'folders' || !this.isOpen) return;
    this.folderId = f.id;
    const cur = this.ctx.player.current;
    this.showChans(items, f.name, Math.max(0, items.findIndex(x => x.id === cur?.id)));
  }

  row(x, i) {
    if (this.mode === 'folders') {
      return `<div class="row${x.id === this.folderId ? ' active' : ''}"><div class="grow">
        <div class="name">${esc(x.name)}</div><div class="meta">${x.count === '' ? 'Toca para abrir' : `${x.count} canales`}</div></div></div>`;
    }
    const e = this.ctx.epg()?.get(x.id);
    const playing = this.ctx.player.current?.id === x.id;
    return `<div class="row${playing ? ' active' : ''}">
      <span class="z-num">${i + 1}</span>
      <div class="logo">${initials(x.name)}${x.icon ? `<img src="${esc(x.icon)}" alt="" loading="lazy" onerror="this.remove()">` : ''}</div>
      <div class="grow"><div class="name">${esc(x.name)}${x.versions ? ` <span class="from">· 📁 ${esc(this.ctx.folderOf(x))}</span>` : ''}</div>
        ${e?.now ? `<div class="meta epg"><b>${hhmm(e.now.start)}</b> ${esc(e.now.title)}</div><div class="bar"><i style="width:${Math.round(e.progress * 100)}%"></i></div>` : ''}
      </div></div>`;
  }

  wantEpg() {
    if (this.mode !== 'chans' || this.side.hidden) return;
    clearTimeout(this.epgTimer);
    this.epgTimer = setTimeout(() => this.ctx.epg()?.want(this.list.visibleItems().map(x => x.id)), 300);
  }

  // ---------------------------------------------------------------- pilot footer

  pilot(d) {
    const p = this.ctx.player, n = p.queue?.length || 0;
    if (!n) return;
    const from = this.pilotOn ? this.pIdx : p.index;
    this.showPilot(((from + d) % n + n) % n, PILOT_HIDE);
  }

  showPilot(i, ms) {
    const it = this.ctx.player.queue?.[i];
    if (!it) return;
    this.pIdx = i;
    this.ctx.epg()?.want([it.id], true);
    this.drawPilot();
    this.pilotEl.hidden = false;
    clearTimeout(this.pilotTimer);
    this.pilotTimer = setTimeout(() => this.hidePilot(), ms);
  }

  drawPilot() {
    const p = this.ctx.player, it = p.queue?.[this.pIdx];
    if (!it) return;
    const e = this.ctx.epg()?.get(it.id);
    const here = this.pIdx === p.index;
    this.pilotEl.innerHTML = `
      <div class="logo">${initials(it.name)}${it.icon ? `<img src="${esc(it.icon)}" alt="" onerror="this.remove()">` : ''}</div>
      <div class="grow">
        <div class="pl-name"><span class="z-num">${this.pIdx + 1}</span> ${esc(it.name)}
          <span class="pl-tag${here ? ' here' : ''}">${here ? '● Viendo' : 'OK para ver'}</span></div>
        ${e?.now ? `<div class="pl-epg"><b>${hhmm(e.now.start)}–${hhmm(e.now.end)}</b> ${esc(e.now.title)}</div>
          <div class="bar"><i style="width:${Math.round(e.progress * 100)}%"></i></div>` : `<div class="pl-epg dim">${e ? 'Sin información de programación' : 'Cargando programación…'}</div>`}
        ${e?.next ? `<div class="pl-next dim">Después <b>${hhmm(e.next.start)}</b> ${esc(e.next.title)}</div>` : ''}
      </div>
      <div class="pl-keys dim">▲▼ canales · OK ver · ◀ lista</div>`;
  }

  hidePilot() {
    clearTimeout(this.pilotTimer);
    this.pilotEl.hidden = true;
  }

  go() {
    const p = this.ctx.player, i = this.pIdx;
    this.hidePilot();
    if (i != null && i !== p.index) p.step(i - p.index);
  }

  // ---------------------------------------------------------------- hooks

  // After every channel change: brief info footer (live only).
  changed() {
    if (this.isOpen && this.mode === 'chans') this.list.refresh();
    if (this.ctx.enabled()) this.showPilot(this.ctx.player.index, INFO_HIDE);
    else this.hidePilot();
  }

  onEpg(id) {
    if (this.isOpen && this.mode === 'chans') this.list.updateWhere(x => x.id === id);
    if (this.pilotOn && this.ctx.player.queue?.[this.pIdx]?.id === id) this.drawPilot();
  }

  reset() {
    this.close();
    this.hidePilot();
  }

  // Remote keys while the player is open; true when consumed.
  key(k, isBack) {
    if (this.isOpen) {
      const l = this.list, n = l.items.length, i = l.cursor ?? 0;
      if (k === 'ArrowDown') l.setCursor(Math.min(n - 1, i + 1));
      else if (k === 'ArrowUp') l.setCursor(Math.max(0, i - 1));
      else if (k === 'PageDown' || k === 'ChannelDown') l.setCursor(Math.min(n - 1, i + 8));
      else if (k === 'PageUp' || k === 'ChannelUp') l.setCursor(Math.max(0, i - 8));
      else if (k === 'Enter') this.pick(i);
      else if (k === 'ArrowLeft') { if (this.mode === 'chans') this.showFolders(); }
      else if (k === 'ArrowRight') { if (this.mode === 'folders') this.pick(i); else this.close(); }
      else if (isBack) { if (this.mode === 'folders') this.backToChans(); else this.close(); }
      else return false;
      return true;
    }
    if (!this.ctx.enabled()) return false;
    if (k === 'ArrowUp' || k === 'ArrowDown') { this.pilot(k === 'ArrowUp' ? -1 : 1); return true; }
    if (k === 'ArrowLeft') { this.openChans(); return true; }
    if (this.pilotOn) {
      if (k === 'Enter') { this.go(); return true; }
      if (isBack || k === 'ArrowRight') { this.hidePilot(); return isBack; }
      return false;
    }
    if (k === 'Enter') { this.showPilot(this.ctx.player.index, PILOT_HIDE); return true; }
    return false;
  }
}
