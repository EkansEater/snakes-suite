// Small helpers shared by the page: elements, icons, events, platform.

export const platform = { os: 'linux', mac: false, win: false, android: false };
export function setPlatform(os) {
  platform.os = os === 'darwin' ? 'macos' : os === 'win32' ? 'windows' : os === 'android' ? 'android' : 'linux';
  platform.mac = platform.os === 'macos';
  platform.win = platform.os === 'windows';
  platform.android = platform.os === 'android';
}

/** el('div.a.b', {attrs, on: {click}}, ...children) */
export function el(spec, attrs = {}, ...children) {
  const [tag, ...classes] = spec.split('.');
  const node = document.createElement(tag || 'div');
  if (classes.length) node.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'on') for (const [ev, fn] of Object.entries(v)) node.addEventListener(ev, fn);
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k === 'text') node.textContent = v;
    else if (k in node && typeof v !== 'string') node[k] = v;
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) if (c != null && c !== false) node.append(c instanceof Node ? c : String(c));
  return node;
}

// Icons: simple strokes in a 16-unit box, drawn for this app.
const PATHS = {
  plus: 'M8 3v10M3 8h10',
  menu: 'M2.5 4h11M2.5 8h11M2.5 12h11',
  close: 'M4 4l8 8M12 4l-8 8',
  chevron: 'M4 6l4 4 4-4',
  right: 'M6 4l4 4-4 4',
  splitRight: 'M2.5 3.5h11v9h-11zM8 3.5v9',
  splitDown: 'M2.5 3.5h11v9h-11zM2.5 8h11',
  devices: 'M2 3.5h8v6H2zM4 12h4M6 9.5V12M11.5 6h3v6.5h-3zM13 11h0',
  gear: 'M8 5.5a2.5 2.5 0 1 0 0 5 2.5 2.5 0 0 0 0-5zM8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4',
  search: 'M7 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM10 10l3.5 3.5',
  min: 'M3.5 8h9',
  max: 'M3.5 3.5h9v9h-9z',
  restore: 'M5.5 3.5h7v7M3.5 5.5h7v7h-7z',
  key: 'M5.5 7.5a3 3 0 1 0 0 .01M8.5 8h6M12 8v2.5M14 8v2',
  refresh: 'M13 8a5 5 0 1 1-1.5-3.5M13 2.5v3h-3',
  link: 'M6.5 9.5l3-3M7 4.5l1-1a2.5 2.5 0 0 1 3.5 3.5l-1 1M9 11.5l-1 1a2.5 2.5 0 0 1-3.5-3.5l1-1',
  more: 'M3.5 8h0M8 8h0M12.5 8h0',
  up: 'M4 10l4-4 4 4',
  down: 'M4 6l4 4 4-4',
  check: 'M3 8.5l3 3 7-7',
  terminal: 'M2.5 3.5h11v9h-11zM4.5 6l2 2-2 2M8 10h3',
  globe: 'M8 2a6 6 0 1 0 0 12A6 6 0 0 0 8 2zM2 8h12M8 2c2 2 2 10 0 12M8 2c-2 2-2 10 0 12',
  copy: 'M5.5 5.5h7v7h-7zM3.5 10.5v-7h7',
  broadcast: 'M8 8h0M5 5a4.2 4.2 0 0 0 0 6M11 5a4.2 4.2 0 0 1 0 6M3 3a7 7 0 0 0 0 10M13 3a7 7 0 0 1 0 10',
  maximize: 'M3 6V3h3M10 3h3v3M13 10v3h-3M6 13H3v-3',
  edit: 'M3 13l1-3.5 7-7 2.5 2.5-7 7zM9.5 4l2.5 2.5',
  trash: 'M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.7 8.5h5.6l.7-8.5',
  star: 'M8 2.5l1.7 3.5 3.8.5-2.8 2.7.7 3.8L8 11.2 4.6 13l.7-3.8L2.5 6.5l3.8-.5z',
};

export function icon(name, extra = '') {
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('class', `icon ${extra}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', PATHS[name] || PATHS.more);
  svg.append(p);
  return svg;
}

export class Emitter {
  constructor() { this.map = new Map(); }
  on(ev, fn) {
    if (!this.map.has(ev)) this.map.set(ev, new Set());
    this.map.get(ev).add(fn);
    return () => this.map.get(ev)?.delete(fn);
  }
  emit(ev, ...args) { for (const fn of [...(this.map.get(ev) || [])]) { try { fn(...args); } catch (err) { console.error(err); } } }
}
export const bus = new Emitter();

export function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

export const basename = (p) => String(p || '').replace(/[\\/]+$/, '').split(/[\\/]/).pop() || p;
export const uid = () => Math.random().toString(36).slice(2, 10);

/** Simple subsequence match; returns a score (higher is better) or -1. */
export function fuzzy(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return 0;
  const at = t.indexOf(q);
  if (at >= 0) return 1000 - at * 2 - t.length * 0.1;
  let i = 0;
  let score = 0;
  let last = -1;
  for (let j = 0; j < t.length && i < q.length; j++) {
    if (t[j] === q[i]) { score += last === j - 1 ? 5 : 1; last = j; i++; }
  }
  return i === q.length ? score : -1;
}
