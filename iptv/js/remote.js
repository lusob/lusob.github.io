// TV remote / keyboard navigation (Google TV browsers send arrows, Enter and Back as keys).
// Touch use is untouched: the highlight only appears after an arrow key and disappears on touch.
// Zones: 'top' (tab bar + pane header buttons), 'folders', 'items' (list, mosaic or series).
// The same rules everywhere: arrows move, OK acts, Back goes one level up. In the player:
// - live: Left = channels, Right = options, Up / Down = pilot footer, OK = info;
// - recordings, catch-up, films: Left / Right = 30 s, OK = pause, Down = controls, Up = options.

const BACK = new Set(['Escape', 'GoBack', 'BrowserBack', 'Backspace']);
const ARROWS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

const TEXT = 'input[type=text], input[type=search], input[type=password], input:not([type]), input[type=datetime-local]';

const shown = el => !!el && !el.hidden && el.offsetParent !== null && !el.disabled;

export function initRemote(ctx) {
  // ctx: { folderList, itemList, mosaicEl, seriesEl, player, zap, openFolder(i), openItem(i, act),
  //        closeSeries() → bool, narrow() → bool, showFolders() }
  const { folderList, itemList, player, zap } = ctx;
  let zone = null;
  let act = -1;   // items zone: -1 = the row itself, otherwise index of its action button

  const topButtons = () => [...document.querySelectorAll('.top button, .top input')].filter(shown);
  const headButtons = () => [...document.querySelectorAll('.pane-head button')].filter(shown);
  const focusTab = () => (document.querySelector('.tabs button.active') || topButtons()[0])?.focus();
  // Up from a list: its header buttons, or the tabs when it has none.
  function goUp() {
    setZone('top');
    const b = headButtons()[0];
    if (b) b.focus(); else focusTab();
  }

  // Android opens its on-screen keyboard as soon as a text field has the focus, and the arrows then
  // go to the keyboard (the field traps you). With a remote a field takes the focus read-only and
  // the arrows go past it; OK starts typing.
  let editing = null;
  document.addEventListener('focus', e => {
    const el = e.target;
    if (document.body.classList.contains('kbd') && el.matches?.(TEXT) && el !== editing) { el.readOnly = true; el.dataset.nav = '1'; }
  }, true);
  document.addEventListener('blur', e => {
    const el = e.target;
    if (el === editing) editing = null;
    if (el.dataset?.nav) { delete el.dataset.nav; el.readOnly = false; }
  }, true);
  function edit(el) {
    el.blur();          // the keyboard only opens on a new focus
    editing = el;
    el.focus();
    if (el.type === 'datetime-local') try { el.showPicker(); } catch {}
  }
  function stopEdit(el) {
    editing = null;
    el.blur();
    el.focus();
  }
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
    if (m === 'list') itemList.setCursor(rowFrom(itemList.cursor ?? 0, 1) ?? 0, true);
    else if (m === 'mosaic') focusTile(curTile() || (!ctx.gridEl?.hidden && ctx.gridEl.querySelector('.gcell.on')) || tiles()[0]);
    else (ctx.seriesEl.querySelector('.ep') || ctx.seriesEl.querySelector('.chips button, [data-retry]'))?.focus();
  }

  // The next row that can be selected (section titles of the search can't), or null.
  function rowFrom(i, d) {
    const l = itemList.items;
    while (l[i]?.sec) i += d;
    return l[i] ? i : null;
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
      // Really that way (a focused card is scaled up: its centre is off by a hair, and the
      // cards of its own row looked "above" it)
      if ((dx && x * dx < r.width / 3) || (dy && y * dy < r.height / 3)) continue;
      if (dx && Math.abs(y) > r.height / 2) continue;      // same row
      // From a full-width card (the hero) down to the first card of the row, not the middle one
      const d = dx ? Math.abs(x) : Math.abs(y) * 10 + (r.width > innerWidth * 0.6 ? Math.abs(q.left - r.left) : Math.abs(x));
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
  const focusables = root => [...root.querySelectorAll('button, input, select, summary, a[href], [tabindex]')].filter(shown);
  // To the nearest control in that direction; false when there is none.
  function spatial(list, dx, dy) {
    const c = document.activeElement;
    if (!list.includes(c)) { list[0]?.focus(); return !!list[0]; }
    const r = c.getBoundingClientRect();
    let best = null, bestD = Infinity;
    for (const t of list) {
      if (t === c) continue;
      const q = t.getBoundingClientRect();
      if (dx > 0 ? q.left < r.right - 2 : dx < 0 ? q.right > r.left + 2 : dy > 0 ? q.top < r.bottom - 2 : q.bottom > r.top + 2) continue;
      const x = Math.abs(q.left + q.width / 2 - r.left - r.width / 2), y = Math.abs(q.top + q.height / 2 - r.top - r.height / 2);
      const d = dx ? x + y * 3 : y + x * 0.5;
      if (d < bestD) { bestD = d; best = t; }
    }
    best?.focus();
    return !!best;
  }

  // ---------------------------------------------------------------- keys
  document.addEventListener('keydown', e => {
    const k = e.key === 'Select' || e.key === 'Accept' ? 'Enter' : e.key;
    const isBack = BACK.has(k);
    if (ARROWS.has(k)) document.body.classList.add('kbd');
    const active = document.activeElement;
    // A field reached with the arrows: OK (or a real keyboard) starts typing.
    if (active?.dataset?.nav) {
      if (k === 'Enter') { e.preventDefault(); return edit(active); }
      if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) return edit(active);
    }
    const typing = active?.matches?.(TEXT) && !active.dataset.nav;
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
      if (isBack && k !== 'Escape') { e.preventDefault(); dlg.close(); return; }
      if (k === 'Enter' && active?.matches?.('input[type=checkbox]')) { e.preventDefault(); active.click(); return; }
      if (k === 'Enter' && active?.matches?.('div[tabindex]')) { e.preventDefault(); active.click(); return; }
      if (k === 'Enter' && active?.tagName === 'SELECT') { e.preventDefault(); try { active.showPicker(); } catch {} return; }
      if (!ARROWS.has(k)) return;
      const inField = typing || active?.tagName === 'SELECT';
      if (inField && (k === 'ArrowLeft' || k === 'ArrowRight')) return;
      e.preventDefault();
      const dy = k === 'ArrowUp' ? -1 : k === 'ArrowDown' ? 1 : 0;
      // Nothing further that way: scroll what is left of the text
      if (!spatial(focusables(dlg), k === 'ArrowLeft' ? -1 : k === 'ArrowRight' ? 1 : 0, dy) && dy) dlg.querySelector('.card')?.scrollBy(0, dy * 120);
      return;
    }

    // Login form.
    const login = document.getElementById('login');
    if (!login.hidden) {
      if (!ARROWS.has(k) || (typing && (k === 'ArrowLeft' || k === 'ArrowRight'))) return;
      e.preventDefault();
      spatial(focusables(login), k === 'ArrowLeft' ? -1 : k === 'ArrowRight' ? 1 : 0, k === 'ArrowUp' ? -1 : k === 'ArrowDown' ? 1 : 0);
      return;
    }

    // Player.
    if (player.isOpen) {
      player.wake();
      const menu = player.menu;
      const failing = !player.failEl.hidden;
      const bar = [...player.root.querySelectorAll(failing ? '#pFail button' : '#pCu button')].filter(shown);
      // Playback refused by the browser: any OK starts it (a key press counts as permission).
      if (player.blocked && (k === 'Enter' || k === ' ' || k === 'MediaPlayPause' || k === 'MediaPlay')) {
        e.preventDefault();
        player.unblock();
        return;
      }
      // Options, audio or subtitles panel (right side): Left or Back close it, OK is a normal click.
      if (!menu.hidden) {
        if (isBack || k === 'ArrowLeft') { e.preventDefault(); player.closeMenu(); }
        else if (k === 'ArrowUp' || k === 'ArrowDown') { e.preventDefault(); moveFocus([...menu.querySelectorAll('button')], k === 'ArrowUp' ? -1 : 1); }
        else if (k === 'ArrowRight') e.preventDefault();
        return;
      }
      const inBar = bar.includes(document.activeElement);
      // Live: channel list, pilot footer and OK (see zap.js).
      if ((zap?.isOpen || !inBar) && zap?.key(k, isBack)) {
        e.preventDefault();
        return;
      }
      // On the buttons of the time bar or of the failure screen
      if (inBar) {
        if (isBack) { e.preventDefault(); document.activeElement.blur(); }
        else if (k === 'ArrowLeft' || k === 'ArrowRight') { e.preventDefault(); moveFocus(bar, k === 'ArrowLeft' ? -1 : 1); }
        else if (k === 'ArrowUp' || k === 'ArrowDown') {
          e.preventDefault();
          if (failing) moveFocus(bar, k === 'ArrowUp' ? -1 : 1);
          else if (k === 'ArrowUp') document.activeElement.blur();
        }
        return;
      }
      if (failing && ARROWS.has(k)) { e.preventDefault(); bar[0]?.focus(); return; }
      if (isBack) {
        e.preventDefault();
        if (document.fullscreenElement && player.getSettings().autoFs === false) document.exitFullscreen?.();
        else player.close();
      } else if (k === 'PageUp' || k === 'PageDown' || k === 'ChannelUp' || k === 'ChannelDown') {
        e.preventDefault();
        player.step(k === 'PageUp' || k === 'ChannelUp' ? -1 : 1);
      } else if (zap?.ctx.enabled()) {
        if (k === 'ArrowRight') { e.preventDefault(); player.openOptions(); }
      } else if (k === 'ArrowLeft' || k === 'ArrowRight' || k === 'MediaRewind' || k === 'MediaFastForward') {
        e.preventDefault();
        player.seekBy(k === 'ArrowLeft' || k === 'MediaRewind' ? -30 : 30);
      } else if (k === 'ArrowDown') {
        e.preventDefault();
        (bar.find(b => b.id === 'cuPlay') || bar[0])?.focus();
      } else if (k === 'ArrowUp') {
        e.preventDefault();
        player.openOptions();
      } else if (k === 'Enter' || k === ' ' || k === 'MediaPlayPause') {
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
        moveFocus(topButtons(), k === 'ArrowLeft' ? -1 : 1);
        return;
      }
      if (k === 'ArrowDown' && !el.value && !recent.hidden) { e.preventDefault(); focusables(recent)[0]?.focus(); }
      else if (k === 'Enter' || k === 'ArrowDown') { e.preventDefault(); el.blur(); setZone(home() || itemList.items.length ? 'items' : 'folders'); }
      else if (k === 'ArrowUp' || isBack) { e.preventDefault(); zone = 'top'; stopEdit(el); }
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
      focusTab();
      return;
    }
    e.preventDefault();

    if (zone === 'top') {
      const inHead = !!document.activeElement?.closest('.pane-head');
      if (k === 'ArrowLeft' || k === 'ArrowRight') moveFocus(inHead ? headButtons() : topButtons(), k === 'ArrowLeft' ? -1 : 1);
      else if (k === 'ArrowUp') { if (inHead) focusTab(); }
      else if (k === 'ArrowDown') {
        if (!inHead && !home() && headButtons().length && ctx.narrow()) headButtons()[0].focus();
        else setZone(inHead ? 'items' : 'folders');
      } else if (k === 'Enter') document.activeElement?.click();
      else if (isBack) setZone('folders');
      return;
    }

    if (zone === 'folders') {
      const n = folderList.items.length;
      const i = folderList.cursor ?? 0;
      if (k === 'ArrowDown') folderList.setCursor(Math.min(n - 1, i + 1));
      else if (k === 'ArrowUp') { if (i === 0) { setZone('top'); focusTab(); } else folderList.setCursor(i - 1); }
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
        else if (k === 'ArrowUp') goUp();
      }
      return;
    }
    if (m === 'series') {
      const els = focusables(ctx.seriesEl);
      if (k === 'ArrowLeft' && !document.activeElement?.closest('.chips')) { ctx.closeSeries(); setZone('items'); }
      else if (k === 'ArrowUp' && els.indexOf(document.activeElement) <= 0) goUp();
      else if (k === 'ArrowUp' || k === 'ArrowLeft') moveFocus(els, -1);
      else if (k === 'ArrowDown' || k === 'ArrowRight') moveFocus(els, 1);
      else if (k === 'Enter') document.activeElement?.click();
      return;
    }
    // list
    const n = itemList.items.length;
    const i = itemList.cursor ?? 0;
    if (k === 'ArrowDown') { act = -1; itemList.setCursor(rowFrom(i + 1, 1) ?? i); }
    else if (k === 'ArrowUp') {
      act = -1;
      const j = rowFrom(i - 1, -1);
      if (j == null) goUp();
      else itemList.setCursor(j);
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
  document.addEventListener('pointerdown', () => {
    document.body.classList.remove('kbd');
    const a = document.activeElement;
    if (a?.dataset?.nav) { delete a.dataset.nav; a.readOnly = false; }
    if (zone) setZone(null);
  }, true);

  // Lists re-rendered by the app (new folder, search…): keep the cursor valid.
  return {
    reset() { itemList.cursor = 0; act = -1; if (zone === 'items') enterItems(); },
    refocus() { if (zone === 'items') enterItems(); },
  };
}
