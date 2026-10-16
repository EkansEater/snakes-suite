// Colours: parsing and conversions, plus the colour picker every app uses.
import { h, clamp, drag } from './dom.js';
import { popover, closeMenus } from './menu.js';

export function parseColor(str) {
  if (!str) return null;
  const s = String(str).trim().toLowerCase();
  if (s === 'transparent' || s === 'none') return { r: 0, g: 0, b: 0, a: 0 };
  let m = /^#?([0-9a-f]{3,8})$/.exec(s);
  if (m) {
    let x = m[1];
    if (x.length === 3 || x.length === 4) x = [...x].map((c) => c + c).join('');
    if (x.length !== 6 && x.length !== 8) return null;
    return { r: parseInt(x.slice(0, 2), 16), g: parseInt(x.slice(2, 4), 16), b: parseInt(x.slice(4, 6), 16), a: x.length === 8 ? parseInt(x.slice(6, 8), 16) / 255 : 1 };
  }
  m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) {
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(parseFloat);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? (m[1].includes('%') && p[3] > 1 ? p[3] / 100 : p[3]) : 1 };
  }
  m = /^hsla?\(([^)]+)\)$/.exec(s);
  if (m) {
    const p = m[1].split(/[,\s/]+/).filter(Boolean).map(parseFloat);
    const { r, g, b } = hslToRgb(p[0], p[1] / 100, p[2] / 100);
    return { r, g, b, a: p.length > 3 ? p[3] : 1 };
  }
  const named = NAMED[s];
  return named ? parseColor(named) : null;
}

const NAMED = {
  black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00',
  orange: '#ffa500', purple: '#800080', gray: '#808080', grey: '#808080', silver: '#c0c0c0', maroon: '#800000',
  navy: '#000080', teal: '#008080', lime: '#00ff00', aqua: '#00ffff', cyan: '#00ffff', magenta: '#ff00ff', fuchsia: '#ff00ff',
  pink: '#ffc0cb', brown: '#a52a2a', olive: '#808000', gold: '#ffd700', indigo: '#4b0082', violet: '#ee82ee',
};

const hex2 = (v) => Math.round(clamp(v, 0, 255)).toString(16).padStart(2, '0');
export function toHex({ r, g, b, a = 1 }, withAlpha = false) {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}${withAlpha && a < 1 ? hex2(a * 255) : ''}`;
}
export function toCss({ r, g, b, a = 1 }) {
  return a >= 1 ? toHex({ r, g, b }) : `rgba(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)}, ${+a.toFixed(3)})`;
}

export function rgbToHsv(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  let hh = 0;
  if (d) {
    if (max === r) hh = ((g - b) / d) % 6;
    else if (max === g) hh = (b - r) / d + 2;
    else hh = (r - g) / d + 4;
    hh *= 60;
    if (hh < 0) hh += 360;
  }
  return { h: hh, s: max ? d / max : 0, v: max };
}
export function hsvToRgb(hh, s, v) {
  const f = (n) => {
    const k = (n + hh / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  return { r: f(5) * 255, g: f(3) * 255, b: f(1) * 255 };
}
export function rgbToHsl(r, g, b) {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const l = (max + min) / 2;
  const d = max - min;
  let hh = 0;
  let s = 0;
  if (d) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === r) hh = ((g - b) / d) % 6;
    else if (max === g) hh = (b - r) / d + 2;
    else hh = (r - g) / d + 4;
    hh *= 60;
    if (hh < 0) hh += 360;
  }
  return { h: hh, s, l };
}
export function hslToRgb(hh, s, l) {
  const k = (n) => (n + hh / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = (n) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return { r: f(0) * 255, g: f(8) * 255, b: f(4) * 255 };
}
/** Lighter (amount > 0) or darker (amount < 0) version of a colour. */
export function shade(color, amount) {
  const c = typeof color === 'string' ? parseColor(color) : color;
  const t = amount > 0 ? 255 : 0;
  const p = Math.abs(amount);
  return toHex({ r: c.r + (t - c.r) * p, g: c.g + (t - c.g) * p, b: c.b + (t - c.b) * p });
}
/** Black or white, whichever reads better on `bg`. */
export function contrastText(bg) {
  const c = typeof bg === 'string' ? parseColor(bg) : bg;
  if (!c) return '#000';
  const lum = (0.299 * c.r + 0.587 * c.g + 0.114 * c.b) / 255;
  return lum > 0.6 ? '#1b1f1c' : '#ffffff';
}

// ---------------------------------------------------------------------------
// Palettes
// ---------------------------------------------------------------------------
export const THEME_COLORS = ['#000000', '#ffffff', '#e7ebe8', '#3a4a40', '#2f81f7', '#e5534b', '#f0883e', '#d4a72c', '#3fb950', '#a371f7'];
export const STANDARD_COLORS = ['#c00000', '#ff0000', '#ffc000', '#ffff00', '#92d050', '#00b050', '#00b0f0', '#0070c0', '#002060', '#7030a0'];
export function themeGrid() {
  const rows = [THEME_COLORS];
  for (const amt of [0.8, 0.6, 0.4, -0.25, -0.5]) {
    rows.push(THEME_COLORS.map((c, i) => {
      if (i === 0) return shade('#000000', amt > 0 ? amt * 0.6 + 0.1 : 0);
      if (i === 1) return shade('#ffffff', amt > 0 ? -(1 - amt) * 0.15 - 0.05 : amt * 0.9);
      return shade(c, amt);
    }));
  }
  return rows;
}

const RECENT = 'snake-recent-colors';
export function recentColors() {
  try { return JSON.parse(localStorage.getItem(RECENT) || '[]'); } catch { return []; }
}
export function addRecentColor(c) {
  if (!c || c === 'none') return;
  try { localStorage.setItem(RECENT, JSON.stringify([c, ...recentColors().filter((x) => x !== c)].slice(0, 10))); } catch {}
}

// ---------------------------------------------------------------------------
// The picker
// ---------------------------------------------------------------------------
/**
 * A colour picker element. onChange(css) fires while dragging; onPick(css)
 * when a swatch is clicked or Enter is pressed in the hex box.
 */
export function colorPicker({ value = '#3fb950', alpha = false, allowNone = false, onChange = () => {}, onPick = () => {}, noneLabel = 'No colour' } = {}) {
  let c = parseColor(value) || { r: 63, g: 185, b: 80, a: 1 };
  let hsv = rgbToHsv(c.r, c.g, c.b);
  let a = c.a;
  const sv = h('div.sv');
  const svKnob = h('div.knob');
  sv.append(svKnob);
  const hue = h('div.hue', h('div.knob'));
  const alphaFill = h('div');
  const alphaBar = h('div.alpha', alphaFill, h('div.knob'));
  const hexIn = h('input.input', { style: { flex: '1', fontFamily: 'var(--mono)' }, spellcheck: false });
  const preview = h('div', { style: { width: '28px', height: '28px', borderRadius: '6px', border: '1px solid var(--border2)' } });
  const css = () => toCss({ ...hsvToRgb(hsv.h, hsv.s, hsv.v), a });

  const paint = () => {
    sv.style.background = `linear-gradient(to top, #000, transparent), linear-gradient(to right, #fff, hsl(${hsv.h} 100% 50%))`;
    svKnob.style.left = `${hsv.s * 100}%`;
    svKnob.style.top = `${(1 - hsv.v) * 100}%`;
    hue.firstChild.style.left = `${(hsv.h / 360) * 100}%`;
    const rgb = hsvToRgb(hsv.h, hsv.s, hsv.v);
    alphaFill.style.background = `linear-gradient(to right, transparent, ${toHex(rgb)})`;
    alphaBar.lastChild.style.left = `${a * 100}%`;
    preview.style.background = css();
    if (document.activeElement !== hexIn) hexIn.value = toHex({ ...rgb, a }, alpha);
  };
  const changed = () => { paint(); onChange(css()); };

  const svAt = (e) => {
    const r = sv.getBoundingClientRect();
    hsv.s = clamp((e.clientX - r.left) / r.width, 0, 1);
    hsv.v = clamp(1 - (e.clientY - r.top) / r.height, 0, 1);
    changed();
  };
  sv.addEventListener('pointerdown', (e) => { svAt(e); drag(e, (_x, _y, ev) => svAt(ev), () => addRecentColor(css())); });
  const hueAt = (e) => {
    const r = hue.getBoundingClientRect();
    hsv.h = clamp((e.clientX - r.left) / r.width, 0, 1) * 359.9;
    changed();
  };
  hue.addEventListener('pointerdown', (e) => { hueAt(e); drag(e, (_x, _y, ev) => hueAt(ev)); });
  const alphaAt = (e) => {
    const r = alphaBar.getBoundingClientRect();
    a = Math.round(clamp((e.clientX - r.left) / r.width, 0, 1) * 100) / 100;
    changed();
  };
  alphaBar.addEventListener('pointerdown', (e) => { alphaAt(e); drag(e, (_x, _y, ev) => alphaAt(ev)); });
  hexIn.addEventListener('input', () => {
    const p = parseColor(hexIn.value);
    if (!p) return;
    hsv = rgbToHsv(p.r, p.g, p.b);
    a = alpha ? p.a : 1;
    paint();
    onChange(css());
  });
  hexIn.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { addRecentColor(css()); onPick(css()); }
  });

  const set = (col) => {
    const p = parseColor(col);
    if (!p) return;
    hsv = rgbToHsv(p.r, p.g, p.b);
    a = p.a;
    paint();
  };
  const sw = (col) => {
    const s = h('div.swatch', { style: { background: col }, title: col });
    s.addEventListener('click', () => { set(col); addRecentColor(col); onPick(col); });
    return s;
  };

  const grid = h('div.swatches', ...themeGrid().flat().map(sw));
  const std = h('div.swatches', ...STANDARD_COLORS.map(sw));
  const rec = recentColors();
  const eyedrop = window.EyeDropper ? h('button.btn.small', { title: 'Pick a colour from the screen' }, 'Pick') : null;
  if (eyedrop) {
    eyedrop.addEventListener('click', async () => {
      try {
        const res = await new window.EyeDropper().open();
        set(res.sRGBHex);
        addRecentColor(res.sRGBHex);
        onPick(res.sRGBHex);
      } catch {}
    });
  }
  const none = allowNone ? h('button.btn.small', noneLabel) : null;
  if (none) none.addEventListener('click', () => onPick('none'));

  const el = h('div.cpick',
    grid,
    h('div.muted', { style: { fontSize: '11px' } }, 'Standard'),
    std,
    rec.length ? h('div.muted', { style: { fontSize: '11px' } }, 'Recent') : null,
    rec.length ? h('div.swatches', ...rec.map(sw)) : null,
    sv, hue, alpha ? alphaBar : null,
    h('div.row', preview, hexIn, eyedrop),
    none ? h('div.row', none) : null);
  paint();
  el.setColor = set;
  return el;
}

/** Open the picker in a pop-up under `anchor`. */
export function pickColor(anchor, opts = {}) {
  let last = opts.value;
  let picked = false;
  const picker = colorPicker({
    ...opts,
    onChange: (c) => { last = c; if (opts.live && opts.onChange) opts.onChange(c); },
    onPick: (c) => { last = c; picked = true; closeMenus(); },
  });
  popover(picker, {
    anchor,
    onClose: () => {
      if ((picked || (!opts.live && last !== opts.value)) && opts.onChange) opts.onChange(last);
      if (last && last !== 'none') addRecentColor(last);
    },
  });
}
