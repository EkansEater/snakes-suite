// Ergonomics shared by every app:
//  * hoverZoom: Ctrl+wheel (and touchpad pinch) zooms what is under the pointer,
//    anchored at the pointer; canvas apps may also zoom on a plain wheel.
//  * wheel-adjust: turning the wheel over a slider, number box or drop-down
//    changes it without clicking first (Alt = fine steps).
import { clamp } from './dom.js';

/** Zoom presets the status bar and menus offer. */
export const ZOOM_STEPS = [0.1, 0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3, 4, 5, 6, 8, 12, 16, 24, 32];

/** The next preset above or below `z`. */
export function stepZoom(z, dir, min = 0.1, max = 32) {
  const list = ZOOM_STEPS.filter((s) => s >= min && s <= max);
  if (dir > 0) return list.find((s) => s > z + 1e-6) || max;
  return [...list].reverse().find((s) => s < z - 1e-6) || min;
}

/**
 * hoverZoom(el, { get, set(z, anchor), min, max, plain: (e) => bool })
 * anchor is { x, y } in client coordinates: keep that point still while zooming.
 */
export function hoverZoom(el, { get, set, min = 0.1, max = 8, plain = null }) {
  el.addEventListener('wheel', (e) => {
    const pinchOrCtrl = e.ctrlKey || e.metaKey;
    if (!pinchOrCtrl && !(plain && !e.shiftKey && !e.altKey && plain(e))) return;
    e.preventDefault();
    e.stopPropagation();
    const z = get();
    let next;
    const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
    if (Math.abs(dy) >= 40 && Number.isInteger(dy)) {
      // A mouse wheel notch: one preset at a time.
      next = stepZoom(z, dy < 0 ? 1 : -1, min, max);
    } else {
      // A touchpad: smooth, proportional to the gesture.
      next = z * Math.exp(-dy * 0.01);
      if ((z < 1 && next > 1) || (z > 1 && next < 1)) next = 1; // stick at 100% for a moment
    }
    next = clamp(next, min, max);
    if (Math.abs(next - z) > 1e-6) set(next, { x: e.clientX, y: e.clientY });
  }, { passive: false });
}

/**
 * Keep the content point under `anchor` still when a scroll container's
 * content scales from oldZ to newZ. Call after the content has its new size.
 */
export function keepAnchor(scroller, anchor, oldZ, newZ) {
  const r = scroller.getBoundingClientRect();
  const ax = (anchor ? anchor.x : r.left + r.width / 2) - r.left;
  const ay = (anchor ? anchor.y : r.top + r.height / 2) - r.top;
  const k = newZ / oldZ;
  scroller.scrollLeft = (scroller.scrollLeft + ax) * k - ax;
  scroller.scrollTop = (scroller.scrollTop + ay) * k - ay;
}

// ---------------------------------------------------------------------------
// Wheel over controls changes them
// ---------------------------------------------------------------------------
let lastScrollWheel = 0;

function adjustable(el) {
  if (!(el instanceof Element)) return null;
  const c = el.closest('input[type="range"], input[type="number"], input.num, select, [data-wheel]');
  if (!c || c.disabled || c.closest('[data-no-wheel]')) return null;
  return c;
}

function nudge(c, dir, fine) {
  if (c.tagName === 'SELECT') {
    const opts = [...c.options].filter((o) => !o.disabled);
    const i = opts.findIndex((o) => o.selected);
    const j = clamp(i + dir, 0, opts.length - 1);
    if (j === i) return false;
    c.value = opts[j].value;
  } else if (c.dataset.wheel !== undefined && c.tagName !== 'INPUT') {
    c.dispatchEvent(new CustomEvent('wheelstep', { detail: { dir, fine } }));
    return true;
  } else {
    const step = Number(c.dataset.step || c.step) || 1;
    const min = c.min !== '' && c.min !== undefined ? Number(c.min) : -Infinity;
    const max = c.max !== '' && c.max !== undefined ? Number(c.max) : Infinity;
    const cur = parseFloat(c.value) || 0;
    const delta = (fine ? step / (step >= 1 ? step : 10) : step) * dir;
    let next = clamp(Math.round((cur + delta) * 1e6) / 1e6, min, max);
    if (c.type === 'range' || c.type === 'number') {
      if (next === cur) return false;
      c.value = String(next);
    } else {
      const unit = String(c.value).replace(/^[-\d.\s]+/, '');
      c.value = `${next}${unit}`;
    }
  }
  c.dispatchEvent(new Event('input', { bubbles: true }));
  c.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
}

window.addEventListener('wheel', (e) => {
  // Ctrl+wheel never zooms the whole window: the thing under the pointer zooms instead.
  if (e.ctrlKey && !e.defaultPrevented) e.preventDefault();
  const c = adjustable(e.target);
  const now = performance.now();
  // While the page is being scrolled, passing over a slider does not grab the wheel.
  if (!c || e.ctrlKey || e.shiftKey || (now - lastScrollWheel < 350 && document.activeElement !== c)) {
    if (!c) lastScrollWheel = now;
    return;
  }
  if (Math.abs(e.deltaY) < 1) return;
  e.preventDefault();
  nudge(c, e.deltaY < 0 ? 1 : -1, e.altKey);
}, { passive: false, capture: true });
