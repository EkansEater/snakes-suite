// Ergonomics shared by every app:
//  * hoverZoom: Ctrl+wheel (and touchpad pinch) zooms what is under the pointer,
//    anchored at the pointer; canvas apps may also zoom on a plain wheel.
//  * wheel-adjust: turning the wheel over a slider, number box or drop-down
//    changes it without clicking first (Alt = fine steps).
//  * pinch: two fingers on a touch screen zoom what is under them, the way
//    Ctrl+wheel does with a mouse (the wheel itself is left for mouse users).
import { clamp } from './dom.js';

// ---------------------------------------------------------------------------
// Two-finger pinch
// ---------------------------------------------------------------------------
const pinching = new WeakSet();
/** Is a two-finger gesture going on over this element? (Tools ignore its fingers then.) */
export const isPinching = (el) => pinching.has(el);

/**
 * pinch(el, { begin(center), change(scale, center, pan), end() })
 * scale is relative to the start of the gesture; center and pan are in client
 * pixels (pan: how far the midpoint moved since the start). A second finger
 * also fires a 'snake-pinchstart' event on el, so tools can drop a stroke
 * the first finger started.
 */
export function pinch(el, { begin = () => {}, change, end = () => {}, fallback = false }) {
  const pts = new Map();
  if (!fallback) el.dataset.pinch = '';
  let start = null;
  const mid = () => {
    const [a, b] = [...pts.values()];
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, d: Math.hypot(a.x - b.x, a.y - b.y) || 1 };
  };
  el.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch') return;
    // The page-wide fallback leaves alone anything that zooms itself.
    if (fallback && e.target.closest && e.target.closest('[data-pinch]')) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) {
      start = mid();
      pinching.add(el);
      el.dispatchEvent(new CustomEvent('snake-pinchstart'));
      begin({ x: start.x, y: start.y });
    }
  }, { capture: true });
  el.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (!start || pts.size < 2) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    const m = mid();
    change(m.d / start.d, { x: m.x, y: m.y }, { x: m.x - start.x, y: m.y - start.y });
  }, { capture: true, passive: false });
  const lift = (e) => {
    if (!pts.delete(e.pointerId)) return;
    if (start && pts.size < 2) {
      start = null;
      end();
    }
    // Until the last finger lifts it is still a pinch: the finger left behind
    // must not draw, drag or count as a tap.
    if (pts.size === 0) setTimeout(() => pinching.delete(el), 0);
  };
  // On the window: a finger may be captured by something else before it lifts.
  for (const t of ['pointerup', 'pointercancel']) window.addEventListener(t, lift, { capture: true });
}

// Pinching anywhere else (menus, panels) makes the whole interface bigger or smaller.
// Safari's own page zoom is turned off: every zoomable thing zooms itself.
document.addEventListener('gesturestart', (e) => e.preventDefault());
document.addEventListener('gesturechange', (e) => e.preventDefault());
let uiPinch = null;
pinch(document.documentElement, {
  fallback: true,
  begin: () => { uiPinch = { scale: 1 }; },
  change: (scale) => { if (uiPinch) uiPinch.scale = scale; },
  end: () => {
    if (uiPinch && Math.abs(Math.log(uiPinch.scale)) > 0.15) window.dispatchEvent(new CustomEvent('snake-ui-zoom', { detail: uiPinch.scale > 1 ? 0.1 : -0.1 }));
    uiPinch = null;
  },
});

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
  // Two fingers do the same on a touch screen.
  let z0 = 1;
  pinch(el, {
    begin: () => { z0 = get(); },
    change: (scale, center) => {
      const next = clamp(z0 * scale, min, max);
      if (Math.abs(next - get()) > 1e-4) set(next, center);
    },
  });
  // The page itself must not zoom or scroll sideways under a pinch here (one finger still scrolls).
  if (!el.style.touchAction) el.style.touchAction = 'pan-x pan-y';
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
