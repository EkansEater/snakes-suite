// Phones and narrow windows: the same apps, rearranged for a small touch screen.
//
// Below 720 px the page gets the class "phone" (kit.css does most of the work):
// the menu bar folds into one button, side panels become drawers that slide in
// over the work (their buttons sit in the title bar), and start screens stack.
// On iPhones and iPads a long press opens the right-click menu; Android browsers
// do that themselves.
import { h } from './dom.js';
import { icon } from './icons.js';

const query = window.matchMedia('(max-width: 720px)');
export const isPhone = () => query.matches;
const apply = () => document.documentElement.classList.toggle('phone', query.matches);
apply();
query.addEventListener('change', () => {
  apply();
  closeDrawers();
});

/** Was the last pointer a finger? (Menus then wait for a tap instead of hovering.) */
let touching = false;
export const lastWasTouch = () => touching;
window.addEventListener('pointerdown', (e) => { touching = e.pointerType === 'touch'; }, true);
window.addEventListener('pointermove', (e) => { if (e.pointerType === 'mouse') touching = false; }, { capture: true, passive: true });

// ---------------------------------------------------------------------------
// Drawers
// ---------------------------------------------------------------------------
const drawers = [];
let scrim = null;
/** The drawer buttons (createShell puts them in the title bar; CSS shows them on phones). */
export const drawerButtons = h('div.drawer-btns');

export function closeDrawers() {
  for (const d of drawers) {
    d.panel.classList.remove('drawer-open');
    d.button.classList.remove('on');
  }
  if (scrim) {
    scrim.remove();
    scrim = null;
  }
}

function openDrawer(d) {
  closeDrawers();
  d.panel.classList.add('drawer-open');
  d.button.classList.add('on');
  scrim = h('div.drawer-scrim');
  scrim.addEventListener('pointerdown', (e) => { e.preventDefault(); closeDrawers(); });
  document.body.append(scrim);
  // Lists and canvases inside measure themselves on resize.
  window.dispatchEvent(new Event('resize'));
}

/** On phones, a side panel slides in from its edge when its title-bar button is tapped. */
export function drawer(panel, { side = 'left', title = null, icon: ic = null } = {}) {
  panel.dataset.drawer = side;
  const head = panel.querySelector('.panel-head, h2, h3');
  const name = title || (head && head.textContent.trim()) || 'Panel';
  const button = h('button.tb', { 'data-tip': name, 'aria-label': name, html: icon(ic || (side === 'left' ? 'list' : 'sliders'), 16) });
  const d = { panel, button };
  button.addEventListener('click', () => (panel.classList.contains('drawer-open') ? closeDrawers() : openDrawer(d)));
  drawers.push(d);
  if (side === 'left') drawerButtons.prepend(button);
  else drawerButtons.append(button);
  const api = {
    open: () => openDrawer(d),
    close: closeDrawers,
    toggle: () => (panel.classList.contains('drawer-open') ? closeDrawers() : openDrawer(d)),
  };
  panel.snakeDrawer = api;
  return api;
}

/**
 * For an app's "show or hide this panel" command: on a phone it slides the
 * drawer in or out (and returns true); elsewhere it does nothing (false).
 */
export function toggleDrawer(panel) {
  if (!isPhone() || !panel.snakeDrawer) return false;
  panel.classList.remove('hidden');
  panel.snakeDrawer.toggle();
  return true;
}

window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && scrim) { e.stopPropagation(); closeDrawers(); } }, true);

// ---------------------------------------------------------------------------
// Long press = right click, where the browser does not do it (iOS)
// ---------------------------------------------------------------------------
const iOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
if (iOS) {
  let timer = 0;
  let start = null;
  const cancel = () => { clearTimeout(timer); start = null; };
  window.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || !e.isPrimary) { cancel(); return; }
    start = { x: e.clientX, y: e.clientY, target: e.target };
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!start) return;
      const t = document.elementFromPoint(start.x, start.y) || start.target;
      t.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: start.x, clientY: start.y, button: 2 }));
      start = null;
    }, 550);
  }, true);
  window.addEventListener('pointermove', (e) => {
    if (start && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel();
  }, { capture: true, passive: true });
  window.addEventListener('pointerup', cancel, true);
  window.addEventListener('pointercancel', cancel, true);
}
