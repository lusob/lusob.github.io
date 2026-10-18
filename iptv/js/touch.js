// Touch gestures over the picture (phone, Tesla screen; not on buttons, menus or the channel list):
// - swipe left / right: next / previous channel (live)
// - swipe up: channel list (live) · swipe down: close the player
// - double tap on the left / right third: back / forward 30 s (catch-up, recordings)
// Films keep the browser's own controls (and its gestures): nothing here then.

const SWIPE = 70;        // px to count as a swipe
const DOUBLE = 320;      // ms between the taps of a double tap

export function initTouch(player, { zapOn, openList, onStep }) {
  const v = player.video;
  const bubble = player.root.querySelector('#pGest');
  let start = null, lastTap = null, bubbleTimer;

  const show = text => {
    bubble.textContent = text;
    bubble.hidden = false;
    bubble.classList.remove('pop');
    void bubble.offsetWidth;   // restart the animation
    bubble.classList.add('pop');
    clearTimeout(bubbleTimer);
    bubbleTimer = setTimeout(() => { bubble.hidden = true; }, 900);
  };

  const root = player.root;
  const skip = e => v.controls || !!e.target.closest?.('button, .pbar, #pCu, #pMenu, #pFail, #zap');

  // Touch events, not pointer events: Chrome cancels the pointer stream of a swipe over a <video>.
  root.addEventListener('touchstart', e => {
    if (skip(e) || e.touches.length > 1) { start = null; return; }
    const t = e.touches[0];
    start = { x: t.clientX, y: t.clientY, t: Date.now() };
  }, { passive: true });

  root.addEventListener('touchcancel', () => { start = null; });

  root.addEventListener('touchend', e => {
    if (!start || e.touches.length || v.controls) return;
    const pt = e.changedTouches[0];
    const dx = pt.clientX - start.x, dy = pt.clientY - start.y;
    const s = start;
    start = null;
    if (Math.abs(dx) > SWIPE && Math.abs(dx) > Math.abs(dy) * 1.5) {
      lastTap = null;
      if (!zapOn()) return;
      const d = dx < 0 ? 1 : -1;
      const n = player.queue?.length || 0, i = player.index + d;
      if (i < 0 || i >= n) return show(d > 0 ? 'Último canal de la lista' : 'Primer canal de la lista');
      show(d > 0 ? 'Canal siguiente ›' : '‹ Canal anterior');
      player.step(d);
      onStep?.();
      return;
    }
    if (Math.abs(dy) > SWIPE * 1.5 && Math.abs(dy) > Math.abs(dx) * 1.5) {
      lastTap = null;
      if (dy > 0) { show('Cerrar'); setTimeout(() => player.close(), 150); }
      else if (zapOn()) openList();
      return;
    }
    if (Math.abs(dx) > 20 || Math.abs(dy) > 20 || Date.now() - s.t > 500) return;
    // A tap: a second one soon after on the same side is a double tap
    const w = v.clientWidth || innerWidth;
    const side = pt.clientX < w / 3 ? -1 : pt.clientX > w * 2 / 3 ? 1 : 0;
    const now = Date.now();
    if (lastTap && now - lastTap.t < DOUBLE && side && side === lastTap.side) {
      lastTap = null;
      if (!(player.cu || player.sk)) return;
      const b = player.root.querySelector(side < 0 ? '#cuBack30' : '#cuFwd30');
      b?.click();
      show(side < 0 ? '« 30 s' : '30 s »');
      return;
    }
    lastTap = { t: now, side };
  });
}
