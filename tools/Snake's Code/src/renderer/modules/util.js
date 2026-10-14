// Small shared helpers: DOM building, paths, events, fuzzy matching.

export function el(tag, attrs = {}, ...children) {
  const [name, ...classes] = tag.split('.');
  const node = document.createElement(name || 'div');
  if (classes.length) node.className = classes.join(' ');
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className += (node.className ? ' ' : '') + v;
    else if (k === 'style' && typeof v === 'object') Object.assign(node.style, v);
    else if (k === 'dataset') Object.assign(node.dataset, v);
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'html') node.innerHTML = v;
    else if (k === 'text') node.textContent = v;
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}

export const icon = (name, extra = '') => el('span', { class: `codicon codicon-${name} ${extra}`.trim() });

export class Emitter {
  constructor() { this.listeners = new Map(); }
  on(evt, fn) {
    if (!this.listeners.has(evt)) this.listeners.set(evt, new Set());
    this.listeners.get(evt).add(fn);
    return () => this.listeners.get(evt)?.delete(fn);
  }
  emit(evt, ...args) {
    for (const fn of [...(this.listeners.get(evt) || [])]) {
      try { fn(...args); } catch (e) { console.error(`listener for ${evt} failed`, e); }
    }
  }
}

/** Global application event bus. */
export const bus = new Emitter();

export function debounce(fn, ms) {
  let t;
  const d = (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  d.cancel = () => clearTimeout(t);
  return d;
}

export function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ---- paths (POSIX + Windows tolerant) ----
export let SEP = '/';
export function setSep(s) { SEP = s; }
export function basename(p) {
  if (!p) return '';
  const parts = p.replace(/[\\/]+$/, '').split(/[\\/]/);
  return parts[parts.length - 1];
}
export function dirname(p) {
  const s = p.replace(/[\\/]+$/, '');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  if (i < 0) return '.';
  if (i === 0) return s[0];
  return s.slice(0, i);
}
export function join(...parts) {
  return parts
    .filter((p) => p !== '' && p != null)
    .join(SEP)
    .replace(/[\\/]+/g, SEP);
}
export function extname(p) {
  const b = basename(p);
  const i = b.lastIndexOf('.');
  return i > 0 ? b.slice(i).toLowerCase() : '';
}
export function relative(root, p) {
  if (!root || !p) return p;
  if (p === root) return '';
  const prefix = root.endsWith(SEP) ? root : root + SEP;
  return p.startsWith(prefix) ? p.slice(prefix.length) : p;
}
export function isInside(root, p) {
  return p === root || p.startsWith(root.endsWith(SEP) ? root : root + SEP);
}
export function tildify(p, home) {
  return home && p.startsWith(home) ? '~' + p.slice(home.length) : p;
}

export function formatBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GB`;
}

export function timeAgo(ms) {
  const s = Math.round((Date.now() - ms) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} hr ago`;
  return `${Math.floor(s / 86400)} days ago`;
}

/**
 * Fuzzy subsequence match. Returns { score, positions } or null.
 * Rewards consecutive characters, word starts and matches in the basename.
 */
export function fuzzyMatch(pattern, target) {
  const p = (pattern || '').toLowerCase().replace(/\s+/g, '');
  if (!p) return { score: 0, positions: [] };
  return fuzzyPass(p, pattern, target, true) || fuzzyPass(p, pattern, target, false);
}

function isWordStart(target, k) {
  if (k === 0) return true;
  const before = target[k - 1];
  const c = target[k];
  return /[\\/_\-. ]/.test(before) || (before === before.toLowerCase() && c !== c.toLowerCase());
}

function fuzzyPass(p, pattern, target, preferWordStarts) {
  const t = target.toLowerCase();
  const positions = [];
  let score = 0;
  let ti = 0;
  let prev = -2;
  for (let pi = 0; pi < p.length; pi++) {
    const ch = p[pi];
    let found = -1;
    if (prev >= 0 && t[prev + 1] === ch) found = prev + 1;
    else if (preferWordStarts) {
      for (let k = ti; k < t.length; k++) if (t[k] === ch && isWordStart(target, k)) { found = k; break; }
    }
    if (found < 0) found = t.indexOf(ch, ti);
    if (found < 0) return null;
    let s = 1;
    if (found === prev + 1) s += 5;
    if (isWordStart(target, found)) s += 4;
    score += s;
    positions.push(found);
    prev = found;
    ti = found + 1;
  }
  const lastSep = Math.max(target.lastIndexOf('/'), target.lastIndexOf('\\'));
  if (positions[0] > lastSep) score += 10; // whole match within basename
  score -= target.length * 0.05;
  return { score, positions };
}

export function highlightPositions(text, positions, offset = 0) {
  const frag = document.createDocumentFragment();
  const set = new Set(positions.map((p) => p - offset).filter((p) => p >= 0 && p < text.length));
  let buf = '';
  let inMatch = false;
  const flush = () => {
    if (!buf) return;
    frag.append(inMatch ? el('span.hl', {}, buf) : document.createTextNode(buf));
    buf = '';
  };
  for (let i = 0; i < text.length; i++) {
    const m = set.has(i);
    if (m !== inMatch) { flush(); inMatch = m; }
    buf += text[i];
  }
  flush();
  return frag;
}

/** Make an element resizable via a sash. onDrag receives the pointer delta from start. */
export function makeSash(sash, { onStart, onDrag, onEnd, cursor }) {
  sash.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    sash.setPointerCapture(e.pointerId);
    sash.classList.add('active');
    document.body.style.cursor = cursor;
    document.body.classList.add('dragging');
    const start = { x: e.clientX, y: e.clientY };
    const ctx = onStart?.(e);
    const move = (ev) => onDrag(ev.clientX - start.x, ev.clientY - start.y, ctx);
    const up = () => {
      sash.classList.remove('active');
      document.body.style.cursor = '';
      document.body.classList.remove('dragging');
      sash.removeEventListener('pointermove', move);
      sash.removeEventListener('pointerup', up);
      sash.removeEventListener('pointercancel', up);
      onEnd?.(ctx);
    };
    sash.addEventListener('pointermove', move);
    sash.addEventListener('pointerup', up);
    sash.addEventListener('pointercancel', up);
  });
}

export const isMac = navigator.platform.toLowerCase().includes('mac');

/** Simple line diff (LCS) used for gutter change markers. Returns hunks against the original. */
export function lineDiff(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length - 1;
  let endB = b.length - 1;
  while (endA >= start && endB >= start && a[endA] === b[endB]) { endA--; endB--; }
  const A = a.slice(start, endA + 1);
  const B = b.slice(start, endB + 1);
  const n = A.length;
  const m = B.length;
  const hunks = [];
  if (n === 0 && m === 0) return hunks;
  if (n === 0 || m === 0 || n * m > 9_000_000) {
    hunks.push({ origStart: start, origLen: n, modStart: start, modLen: m });
    return hunks;
  }
  const dp = new Uint32Array((n + 1) * (m + 1));
  const W = m + 1;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i * W + j] = A[i] === B[j] ? dp[(i + 1) * W + j + 1] + 1 : Math.max(dp[(i + 1) * W + j], dp[i * W + j + 1]);
    }
  }
  let i = 0;
  let j = 0;
  let cur = null;
  const flush = () => { if (cur) { hunks.push(cur); cur = null; } };
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) { flush(); i++; j++; continue; }
    if (!cur) cur = { origStart: start + i, origLen: 0, modStart: start + j, modLen: 0 };
    if (j < m && (i >= n || dp[i * W + j + 1] >= dp[(i + 1) * W + j])) { cur.modLen++; j++; }
    else { cur.origLen++; i++; }
  }
  flush();
  return hunks;
}
