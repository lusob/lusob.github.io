// TV remote / keyboard navigation (Google TV browsers send arrows, Enter and Back as keys).
// Touch use is untouched: the highlight only appears after an arrow key and disappears on touch.
// Zones: 'top' (tab bar + pane header buttons), 'folders', 'items' (list, mosaic or series).

const BACK = new Set(['Escape', 'GoBack', 'BrowserBack', 'Backspace']);
const ARROWS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

const shown = el => !!el && !el.hidden && el.offsetParent !== null && !el.disabled;

export function initRemote(ctx) {
  // ctx: { folderList, itemList, mosaicEl, seriesEl, player, zap, openFolder(i), openItem(i, act),
  //        closeSeries() → bool, narrow() → bool, showFolders() }
  const { folderList, itemList, player, zap } = ctx;
  let zone = null;
  let act = -1;   // items zone: -1 = the row itself, otherwise index of its action button

  const topButtons = () => [...document.querySelectorAll('.top button, .top input, .pane-head button')].filter(shown);
  // The horizontal guide moves like the mosaic (its cells are the tiles).
  // So do the cards of the home page.
  const home = () => !ctx.homeEl.hidden;
  const mode = () => home() ? 'mosaic' : !ctx.seriesEl.hidden ? 'series' : !ctx.mosaicEl.hidden || !ctx.gridEl?.hidden ? 'mosaic' : 'list';
  const tileBox = () => home() ? [ctx.homeEl, '.hcard'] : !ctx.gridEl?.hidden ? [ctx.gridEl, '.gcell'] : [ctx.mosaicEl, '.tile'];

  function setZone(z) {
    if (z === 'folders' && home()) z = 'items';   // the home page has no folders
    zone = z;
    document.body.classList.toggle('kbd', !!z);
    // Driven by a remote on a non-touch screen of TV size (CSS px): treat it as a TV from now on
    // (unless a size was chosen in Ajustes).
    let scale = '';
    try { scale = localStorage.getItem('iptv-scale') || ''; } catch {}
    if (z && !scale && !matchMedia('(pointer: coarse)').matches && innerHeight <= 800 && !document.documentElement.classList.contains('tv')) {
      document.documentElement.classList.add('tv');
      try { localStorage.setItem('iptv-tv', '1'); } catch {}
    }
    folderList.setCursor(folderList.cursor ?? 0, z === 'folders');
    if (z !== 'items') { itemList.setCursor(itemList.cursor ?? 0, false); clearTile(); }
    if (z === 'items') enterItems();
    if (z !== 'top' && document.activeElement?.closest?.('.top, .pane-head')) document.activeElement.blur();
    paintAct();
  }

  function enterItems() {
    act = -1;
    const m = mode();
    if (m === 'list') itemList.setCursor(itemList.cursor ?? 0, true);
    else if (m === 'mosaic') focusTile(curTile() || (!ctx.gridEl?.hidden && ctx.gridEl.querySelector('.gcell.on')) || tiles()[0]);
    else (ctx.seriesEl.querySelector('.ep') || ctx.seriesEl.querySelector('.chips button, [data-retry]'))?.focus();
  }

  // ---- list rows with action buttons (★, guide…)
  function paintAct() {
    document.querySelectorAll('.kact').forEach(b => b.classList.remove('kact'));
    if (zone !== 'items' || mode() !== 'list' || act < 0) return;
    rowActs()[act]?.classList.add('kact');
  }
  const rowActs = () => [...(itemList.node(itemList.cursor)?.querySelectorAll('[data-act]') || [])];
  itemList.onUpdate = () => paintAct();

  // ---- mosaic tiles (geometric navigation)
  const tiles = () => { const [el, sel] = tileBox(); return [...el.querySelectorAll(sel)].filter(t => t.offsetParent !== null); };
  const curTile = () => { const [el, sel] = tileBox(); return el.querySelector(sel + '.kfocus'); };
  function clearTile() { document.querySelectorAll('.tile.kfocus, .gcell.kfocus, .hcard.kfocus').forEach(t => t.classList.remove('kfocus')); }
  function focusTile(t) {
    if (!t) return;
    clearTile();
    t.classList.add('kfocus');
    t.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  function moveTile(dx, dy) {
    const c = curTile();
    if (!c) return focusTile(tiles()[0]), true;
    const r = c.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    let best = null, bestD = Infinity;
    for (const t of tiles()) {
      if (t === c) continue;
      const q = t.getBoundingClientRect();
      const x = q.left + q.width / 2 - cx, y = q.top + q.height / 2 - cy;
      if ((dx && Math.sign(x) !== dx) || (dy && Math.sign(y) !== dy)) continue;
      if (dx && Math.abs(y) > r.height / 2) continue;      // same row
      const d = dx ? Math.abs(x) : Math.abs(y) * 10 + Math.abs(x);
      if (d < bestD) { bestD = d; best = t; }
    }
    if (!best) return false;
    focusTile(best);
    return true;
  }

  // ---- generic focus ring inside a container (dialogs, player bar, series)
  function moveFocus(list, d) {
    if (!list.length) return;
    const i = list.indexOf(document.activeElement);
    list[i < 0 ? (d > 0 ? 0 : list.length - 1) : Math.max(0, Math.min(list.length - 1, i + d))].focus();
  }
  const focusables = root => [...root.querySelectorAll('button, input, select, [tabindex]')].filter(shown);

  // ---------------------------------------------------------------- keys
  document.addEventListener('keydown', e => {
    const k = e.key;
    const isBack = BACK.has(k);
    const typing = document.activeElement?.matches?.('input[type=text], input[type=search], input[type=password], input:not([type]), input[type=datetime-local]');
    if (k === 'Backspace' && typing) return;

    // "Starting now" notice: its buttons take the keys while one of them has the focus.
    const rem = document.getElementById('remind');
    if (!rem.hidden && rem.contains(document.activeElement)) {
      if (isBack) { e.preventDefault(); document.getElementById('remindX').click(); }
      else if (k === 'ArrowLeft' || k === 'ArrowRight') { e.preventDefault(); moveFocus(focusables(rem), k === 'ArrowLeft' ? -1 : 1); }
      else if (k === 'ArrowUp' || k === 'ArrowDown') { e.preventDefault(); document.activeElement.blur(); }
      return;
    }

    // Recent searches under the search box.
    const recent = document.getElementById('recentQ');
    if (!recent.hidden && recent.contains(document.activeElement)) {
      const btns = focusables(recent), i = btns.indexOf(document.activeElement);
      if (isBack || (k === 'ArrowUp' && i <= 0)) { e.preventDefault(); document.getElementById('search').focus(); }
      else if (k === 'ArrowUp' || k === 'ArrowDown') { e.preventDefault(); moveFocus(btns, k === 'ArrowUp' ? -1 : 1); }
      else if (k === 'ArrowLeft' || k === 'ArrowRight') e.preventDefault();
      return;
    }

    // Dialogs: move between their controls.
    const dlg = document.querySelector('dialog[open]');
    if (dlg) {
      if (k === 'GoBack' || k === 'BrowserBack') { e.preventDefault(); dlg.close(); return; }
      if (!ARROWS.has(k)) return;
      const inField = typing || document.activeElement?.tagName === 'SELECT';
      if (inField && (k === 'ArrowLeft' || k === 'ArrowRight')) return;
      e.preventDefault();
      moveFocus(focusables(dlg), k === 'ArrowUp' || k === 'ArrowLeft' ? -1 : 1);
      return;
    }

    // Player.
    if (player.isOpen) {
      player.wake();
      const menu = player.menu;
      const bar = [...player.root.querySelectorAll('.pbar button, #pCu button, #pFail button, #pPlay')].filter(shown);
      // Playback refused by the browser: any OK starts it (a key press counts as permission).
      if (player.blocked && (k === 'Enter' || k === ' ' || k === 'MediaPlayPause' || k === 'MediaPlay')) {
        e.preventDefault();
        player.unblock();
        return;
      }
      const inBar = bar.includes(document.activeElement);
      // Live: Left = channel list, Up/Down = pilot footer, OK = info / switch (see zap.js).
      if (menu.hidden && (zap?.isOpen || !(inBar && (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'Enter'))) && zap?.key(k, isBack)) {
        e.preventDefault();
        if (bar.includes(document.activeElement)) document.activeElement.blur();
        return;
      }
      if (isBack) {
        e.preventDefault();
        if (!menu.hidden) player.closeMenu();
        else if (inBar) document.activeElement.blur();
        else if (document.fullscreenElement && player.getSettings().autoFs === false) document.exitFullscreen?.();
        else player.close();
      } else if (!menu.hidden && (k === 'ArrowUp' || k === 'ArrowDown')) {
        e.preventDefault();
        moveFocus([...menu.querySelectorAll('button')], k === 'ArrowUp' ? -1 : 1);
      } else if (k === 'ArrowUp' || k === 'ArrowDown' || k === 'PageUp' || k === 'PageDown' || k === 'ChannelUp' || k === 'ChannelDown') {
        e.preventDefault();
        if (inBar) document.activeElement.blur();
        player.step(k === 'ArrowUp' || k === 'PageUp' || k === 'ChannelUp' ? -1 : 1);
      } else if (k === 'ArrowLeft' || k === 'ArrowRight') {
        e.preventDefault();
        // Left on the first button leaves the bar (so the next Left opens the channel list).
        if (k === 'ArrowLeft' && inBar && bar.indexOf(document.activeElement) === 0) document.activeElement.blur();
        else moveFocus(bar, k === 'ArrowLeft' ? -1 : 1);
      } else if ((k === 'Enter' || k === ' ' || k === 'MediaPlayPause') && !inBar && menu.hidden) {
        e.preventDefault();
        const v = player.video;
        if (v.paused) v.play().catch(() => {}); else v.pause();
      }
      return;
    }

    // Search box: Enter / Down leave it towards the results.
    if (typing) {
      if (document.activeElement.id !== 'search') return;   // login form etc.: native behaviour
      const el = document.activeElement;
      const atEdge = k === 'ArrowLeft' ? el.selectionStart === 0 : el.selectionEnd === el.value.length;
      if ((k === 'ArrowLeft' || k === 'ArrowRight') && atEdge) {
        e.preventDefault();
        zone = 'top';
        document.body.classList.add('kbd');
        moveFocus(topButtons(), k === 'ArrowLeft' ? -1 : 1);
        return;
      }
      const el2 = document.activeElement;
      if (k === 'ArrowDown' && !el2.value && !recent.hidden) { e.preventDefault(); focusables(recent)[0]?.focus(); }
      else if (k === 'Enter' || k === 'ArrowDown') { e.preventDefault(); el2.blur(); setZone(home() || itemList.items.length ? 'items' : 'folders'); }
      else if (k === 'Escape') document.activeElement.blur();
      return;
    }

    if (document.getElementById('main').hidden) return;
    if (!ARROWS.has(k) && k !== 'Enter' && !isBack) return;
    if (!zone) {
      if (!ARROWS.has(k)) return;
      e.preventDefault();
      setZone(ctx.narrow() && document.body.classList.contains('show-items') ? 'items' : 'folders');
      return;
    }
    // Remote back on the home page: up to the tabs (another Back leaves the app as usual).
    if (zone === 'items' && home() && isBack) {
      e.preventDefault();
      setZone('top');
      topButtons()[0]?.focus();
      return;
    }
    e.preventDefault();

    if (zone === 'top') {
      const btns = topButtons();
      if (k === 'ArrowLeft' || k === 'ArrowRight') moveFocus(btns, k === 'ArrowLeft' ? -1 : 1);
      else if (k === 'ArrowDown') setZone(document.activeElement?.closest('.pane-head') ? 'items' : 'folders');
      else if (k === 'Enter') { const a = document.activeElement; if (a?.tagName === 'INPUT') a.focus(); else a?.click(); }
      else if (isBack) setZone('folders');
      return;
    }

    if (zone === 'folders') {
      const n = folderList.items.length;
      const i = folderList.cursor ?? 0;
      if (k === 'ArrowDown') folderList.setCursor(Math.min(n - 1, i + 1));
      else if (k === 'ArrowUp') { if (i === 0) { setZone('top'); topButtons()[0]?.focus(); } else folderList.setCursor(i - 1); }
      else if (k === 'ArrowRight') setZone('items');
      else if (k === 'Enter') {
        ctx.openFolder(i);
        if (!folderList.items[i]?.lock) { itemList.cursor = 0; setZone('items'); }
      }
      return;
    }

    // zone === 'items'
    const m = mode();
    if (isBack) {
      if (m === 'series') { ctx.closeSeries(); setZone('items'); }
      else { if (ctx.narrow()) ctx.showFolders(); setZone('folders'); }
      return;
    }
    if (m === 'mosaic') {
      // Home hero: Left / Right show its other pictures
      if ((k === 'ArrowLeft' || k === 'ArrowRight') && curTile()?.classList.contains('hero') && ctx.heroStep?.(k === 'ArrowLeft' ? -1 : 1)) return;
      if (k === 'Enter') curTile()?.click();
      else if (!moveTile(k === 'ArrowLeft' ? -1 : k === 'ArrowRight' ? 1 : 0, k === 'ArrowUp' ? -1 : k === 'ArrowDown' ? 1 : 0)) {
        if (k === 'ArrowLeft') { if (ctx.narrow()) ctx.showFolders(); setZone('folders'); }
        else if (k === 'ArrowUp') { setZone('top'); ([...document.querySelectorAll('.pane-head button')].filter(shown).pop() || topButtons()[0])?.focus(); }
      }
      return;
    }
    if (m === 'series') {
      const els = focusables(ctx.seriesEl);
      if (k === 'ArrowLeft' && !document.activeElement?.closest('.chips')) { ctx.closeSeries(); setZone('items'); }
      else if (k === 'ArrowUp' && els.indexOf(document.activeElement) <= 0) { setZone('top'); [...document.querySelectorAll('.pane-head button')].filter(shown)[0]?.focus(); }
      else if (k === 'ArrowUp' || k === 'ArrowLeft') moveFocus(els, -1);
      else if (k === 'ArrowDown' || k === 'ArrowRight') moveFocus(els, 1);
      else if (k === 'Enter') document.activeElement?.click();
      return;
    }
    // list
    const n = itemList.items.length;
    const i = itemList.cursor ?? 0;
    if (k === 'ArrowDown') { act = -1; itemList.setCursor(Math.min(n - 1, i + 1)); }
    else if (k === 'ArrowUp') {
      act = -1;
      if (i === 0) { setZone('top'); [...document.querySelectorAll('.pane-head button')].filter(shown).pop()?.focus() || topButtons()[0]?.focus(); }
      else itemList.setCursor(i - 1);
    } else if (k === 'ArrowRight') { const a = rowActs(); if (act < a.length - 1) act++; }
    else if (k === 'ArrowLeft') {
      if (act >= 0) act--;
      else { if (ctx.narrow()) ctx.showFolders(); setZone('folders'); return; }
    } else if (k === 'Enter' && n) {
      const a = act >= 0 ? rowActs()[act]?.dataset.act : null;
      ctx.openItem(i, a);
      if (mode() === 'series') setTimeout(() => setZone('items'), 0);
    }
    paintAct();
  });

  // Touch or mouse: back to the normal look.
  document.addEventListener('pointerdown', () => { if (zone) setZone(null); }, true);

  // Lists re-rendered by the app (new folder, search…): keep the cursor valid.
  return {
    reset() { itemList.cursor = 0; act = -1; if (zone === 'items') enterItems(); },
    refocus() { if (zone === 'items') enterItems(); },
  };
}
