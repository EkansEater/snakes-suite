// The grid of Snake's Spreadsheets: drawn on a canvas (so a million rows stay
// fast) under a native scrolling layer (so the scroll bars are real ones).
// Selection, editing, fill handle, resizing, frozen panes, pointing at cells
// while typing a formula, and hover zoom live here.
import { h, clamp, rafOnce } from '../../kit/dom.js';
import { keepAnchor, stepZoom, pinch, isPinching } from '../../kit/zoom.js';
import { key, rowOf, colOf, DEF_W, DEF_H } from './engine.js';
import { colName, MAX_ROWS, MAX_COLS, refSpans, cycleAbsolute, callAt, isErr } from './formula.js';
import { FN, FN_NAMES, Spark } from './functions.js';
import { formatValue } from './numfmt.js';

const HEAD_H = 24;
const REF_COLORS = ['#2f81f7', '#e5534b', '#a371f7', '#3fb950', '#d4a72c', '#db61a2', '#0e8a9a', '#f0883e'];

const THEMES = {
  light: { bg: '#ffffff', grid: '#e1e5e2', head: '#f2f4f2', headText: '#5d6a62', headSel: '#dbeedf', headSelText: '#1a7f37', text: '#1b1f1c', sel: 'rgba(31,136,61,.10)', selBorder: '#1f883d', frozen: '#b7c1ba' },
  dark: { bg: '#1b1f1c', grid: '#2b322d', head: '#151916', headText: '#8a978e', headSel: '#22382a', headSelText: '#7ee787', text: '#d5ddd7', sel: 'rgba(63,185,80,.14)', selBorder: '#3fb950', frozen: '#4a554d' },
};

export class Grid {
  constructor({ book, settings, onSelect = () => {}, onEdit = () => {}, onContext = () => {}, onPick = () => {} }) {
    this.book = book;
    this.settings = settings;
    this.onSelect = onSelect;
    this.onEdit = onEdit;
    this.onContext = onContext;
    this.onPick = onPick; // a validation list or filter button was clicked
    this.sheet = book.sheets[0];
    this.zoom = settings.get('zoom', 1);
    this.sel = { ranges: [{ r0: 0, c0: 0, r1: 0, c1: 0 }], r: 0, c: 0, ar: 0, ac: 0 };
    this.editing = null; // { r, c, mode: 'enter' | 'edit', start }
    this.extent = { r: 200, c: 30 };
    this.showFormulas = false;
    this.copyMark = null;
    this.refHighlights = [];
    this.headW = 46;

    this.canvas = h('canvas.grid-canvas');
    this.spacer = h('div.grid-spacer');
    this.layer = h('div.grid-layer'); // charts, inside the scrolling content
    this.spacer.append(this.layer);
    this.scroller = h('div.grid-scroll', { tabindex: -1 }, this.spacer);
    this.input = h('textarea.cell-editor', { spellcheck: false, autocomplete: 'off', wrap: 'off', 'aria-label': 'Cell' });
    this.hint = h('div.fn-hint.hidden');
    this.ac = h('div.menu.fn-ac.hidden');
    this.tip = h('div.cell-tip.hidden');
    this.el = h('div.grid-wrap', this.canvas, this.scroller, this.input, this.hint, this.ac, this.tip);
    this.ctx = this.canvas.getContext('2d');
    this.drawSoon = rafOnce(() => this.draw());
    this.measure = new Map();

    this.bind();
    new ResizeObserver(() => this.resize()).observe(this.el);
    window.addEventListener('snake-theme', () => this.drawSoon());
  }

  get theme() { return THEMES[document.documentElement.dataset.theme === 'light' || this.settings.get('lightCells', false) ? 'light' : 'dark']; }

  setSheet(sh) {
    this.cancelEdit();
    this.sheet = sh;
    this.copyMark = this.copyMark && this.copyMark.sid === sh.id ? this.copyMark : this.copyMark;
    const saved = this.savedSel && this.savedSel.get(sh.id);
    this.sel = saved ? saved.sel : { ranges: [{ r0: 0, c0: 0, r1: 0, c1: 0 }], r: 0, c: 0, ar: 0, ac: 0 };
    this.updateExtent(true);
    this.scroller.scrollTop = saved ? saved.st : 0;
    this.scroller.scrollLeft = saved ? saved.sl : 0;
    this.drawSoon();
    this.onSelect();
  }

  rememberSheet() {
    if (!this.savedSel) this.savedSel = new Map();
    this.savedSel.set(this.sheet.id, { sel: this.sel, st: this.scroller.scrollTop, sl: this.scroller.scrollLeft });
  }

  // =========================================================================
  // Geometry (in unzoomed pixels; the canvas scales by zoom)
  // =========================================================================
  geometry() {
    const sh = this.sheet;
    const stamp = `${sh.id}:${this.book.version}:${sh.colW.size}:${sh.rowH.size}:${sh.hiddenC.size}:${sh.hiddenR.size}`;
    if (this.geoStamp === stamp) return;
    this.geoStamp = stamp;
    const build = (sizes, hidden, def) => {
      const keys = new Set([...sizes.keys(), ...hidden]);
      const list = [...keys].sort((a, b) => a - b).map((i) => [i, (hidden.has(i) ? 0 : (sizes.get(i) ?? def)) - def]);
      const pre = [];
      let acc = 0;
      for (const [, d] of list) { pre.push(acc); acc += d; }
      return { idx: list.map((x) => x[0]), delta: list.map((x) => x[1]), pre, total: acc };
    };
    this.cg = build(sh.colW, sh.hiddenC, DEF_W);
    this.rg = build(sh.rowH, sh.hiddenR, DEF_H);
  }

  // Position of the start of column c / row r.
  posOf(g, i, def) {
    // sum of deltas for custom indexes < i
    let lo = 0;
    let hi = g.idx.length;
    while (lo < hi) { const m = (lo + hi) >> 1; if (g.idx[m] < i) lo = m + 1; else hi = m; }
    const extra = lo ? g.pre[lo - 1] + g.delta[lo - 1] : 0;
    return i * def + extra;
  }

  colX(c) { this.geometry(); return this.posOf(this.cg, c, DEF_W); }
  rowY(r) { this.geometry(); return this.posOf(this.rg, r, DEF_H); }
  colW(c) { const s = this.sheet; return s.hiddenC.has(c) ? 0 : (s.colW.get(c) ?? DEF_W); }
  rowH(r) { const s = this.sheet; return s.hiddenR.has(r) ? 0 : (s.rowH.get(r) ?? DEF_H); }

  indexAt(pos, isRow) {
    const max = isRow ? MAX_ROWS : MAX_COLS;
    let lo = 0;
    let hi = max - 1;
    const at = isRow ? (i) => this.rowY(i) : (i) => this.colX(i);
    while (lo < hi) {
      const m = (lo + hi + 1) >> 1;
      if (at(m) <= pos) lo = m; else hi = m - 1;
    }
    // Skip hidden ones.
    const size = isRow ? (i) => this.rowH(i) : (i) => this.colW(i);
    while (lo < max - 1 && size(lo) === 0) lo++;
    return lo;
  }

  get frozen() {
    const f = this.sheet.freeze;
    return { r: f.r, c: f.c, h: f.r ? this.rowY(f.r) : 0, w: f.c ? this.colX(f.c) : 0 };
  }

  /** Screen (canvas css px) rectangle of a cell range, or null when off screen. */
  rectOf(r0, c0, r1, c1) {
    const z = this.zoom;
    const fz = this.frozen;
    const sx = this.scroller.scrollLeft / z;
    const sy = this.scroller.scrollTop / z;
    const xOf = (c) => (c < fz.c ? this.colX(c) : this.colX(c) - sx);
    const yOf = (r) => (r < fz.r ? this.rowY(r) : this.rowY(r) - sy);
    const x0 = xOf(c0);
    const y0 = yOf(r0);
    const x1 = xOf(c1) + this.colW(c1);
    const y1 = yOf(r1) + this.rowH(r1);
    return { x: this.headW + x0 * z, y: HEAD_H * z + y0 * z, w: (x1 - x0) * z, h: (y1 - y0) * z };
  }

  /** Cell under a point in canvas css px: { r, c, area: 'cell'|'colhead'|'rowhead'|'corner' }. */
  hit(x, y) {
    const z = this.zoom;
    const fz = this.frozen;
    const hx = (x - this.headW) / z;
    const hy = (y - HEAD_H * z) / z;
    const cx = hx < fz.w ? hx : hx + this.scroller.scrollLeft / z;
    const cy = hy < fz.h ? hy : hy + this.scroller.scrollTop / z;
    const c = this.indexAt(Math.max(0, cx), false);
    const r = this.indexAt(Math.max(0, cy), true);
    const area = x < this.headW ? (y < HEAD_H * z ? 'corner' : 'rowhead') : (y < HEAD_H * z ? 'colhead' : 'cell');
    return { r, c, area, cx, cy };
  }

  // =========================================================================
  // Size, scrolling, zoom
  // =========================================================================
  resize() {
    const w = this.el.clientWidth;
    const hh = this.el.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(hh * dpr);
    this.canvas.style.width = `${w}px`;
    this.canvas.style.height = `${hh}px`;
    this.dpr = dpr;
    this.updateExtent();
    this.draw();
  }

  updateExtent(reset = false) {
    const u = this.sheet.used();
    const z = this.zoom;
    if (reset) this.extent = { r: 0, c: 0 };
    const viewRows = Math.ceil(this.el.clientHeight / (DEF_H * z)) + 2;
    const viewCols = Math.ceil(this.el.clientWidth / (DEF_W * z)) + 2;
    const lastR = this.indexAt((this.scroller.scrollTop + this.el.clientHeight) / z, true);
    const lastC = this.indexAt((this.scroller.scrollLeft + this.el.clientWidth) / z, false);
    this.extent.r = clamp(Math.max(this.extent.r, u.r + viewRows, lastR + viewRows, this.sel.r + viewRows, 100), 1, MAX_ROWS);
    this.extent.c = clamp(Math.max(this.extent.c, u.c + viewCols, lastC + viewCols, this.sel.c + viewCols, 26), 1, MAX_COLS);
    const digits = String(Math.min(MAX_ROWS, this.extent.r)).length;
    this.headW = Math.round(Math.max(40, 14 + digits * 8) * z);
    this.spacer.style.width = `${this.headW + this.colX(this.extent.c) * z}px`;
    this.spacer.style.height = `${HEAD_H * z + this.rowY(this.extent.r) * z}px`;
  }

  setZoom(z, anchor) {
    const old = this.zoom;
    this.zoom = clamp(Math.round(z * 100) / 100, 0.25, 4);
    this.updateExtent();
    keepAnchor(this.scroller, anchor, old, this.zoom);
    this.settings.set('zoom', this.zoom);
    this.draw();
    this.placeEditor();
    this.onSelect();
  }

  /** Scroll so a cell is visible. */
  reveal(r, c) {
    const z = this.zoom;
    const fz = this.frozen;
    const viewW = (this.scroller.clientWidth - this.headW) / z - fz.w;
    const viewH = (this.scroller.clientHeight - HEAD_H * z) / z - fz.h;
    if (c >= fz.c) {
      const x = this.colX(c) - fz.w;
      const sx = this.scroller.scrollLeft / z;
      if (x < sx) this.scroller.scrollLeft = x * z;
      else if (x + this.colW(c) > sx + viewW) this.scroller.scrollLeft = (x + this.colW(c) - viewW) * z;
    }
    if (r >= fz.r) {
      const y = this.rowY(r) - fz.h;
      const sy = this.scroller.scrollTop / z;
      if (y < sy) this.scroller.scrollTop = y * z;
      else if (y + this.rowH(r) > sy + viewH) this.scroller.scrollTop = (y + this.rowH(r) - viewH) * z;
    }
  }

  // =========================================================================
  // Drawing
  // =========================================================================
  draw() {
    const ctx = this.ctx;
    const z = this.zoom;
    const T = this.theme;
    const W = this.el.clientWidth;
    const H = this.el.clientHeight;
    if (!W || !H) return;
    this.geometry();
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = T.bg;
    ctx.fillRect(0, 0, W, H);
    const fz = this.frozen;
    const sx = this.scroller.scrollLeft / z;
    const sy = this.scroller.scrollTop / z;
    const viewW = (W - this.headW) / z;
    const viewH = (H - HEAD_H * z) / z;
    // Visible rows and columns of each pane.
    const rowsMain = this.span(true, fz.h + sy, fz.h + sy + viewH - fz.h, fz.r);
    const colsMain = this.span(false, fz.w + sx, fz.w + sx + viewW - fz.w, fz.c);
    const rowsTop = fz.r ? this.span(true, 0, fz.h, 0, fz.r - 1) : [];
    const colsLeft = fz.c ? this.span(false, 0, fz.w, 0, fz.c - 1) : [];
    this.visible = { rowsMain, colsMain, rowsTop, colsLeft };
    const panes = [
      [rowsMain, colsMain, this.headW + fz.w * z, HEAD_H * z + fz.h * z, W, H],
      [rowsTop, colsMain, this.headW + fz.w * z, HEAD_H * z, W, HEAD_H * z + fz.h * z],
      [rowsMain, colsLeft, this.headW, HEAD_H * z + fz.h * z, this.headW + fz.w * z, H],
      [rowsTop, colsLeft, this.headW, HEAD_H * z, this.headW + fz.w * z, HEAD_H * z + fz.h * z],
    ];
    this.cfCache = this.cfCache && this.cfCache.version === this.book.version && this.cfCache.sid === this.sheet.id ? this.cfCache : { version: this.book.version, sid: this.sheet.id, rules: new Map() };
    for (const [rows, cols, x0, y0, x1, y1] of panes) {
      if (!rows.length || !cols.length || x1 <= x0 || y1 <= y0) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x0, y0, x1 - x0, y1 - y0);
      ctx.clip();
      this.drawCells(rows, cols);
      this.drawSelection(rows, cols);
      ctx.restore();
    }
    this.drawHeaders(rowsMain, colsMain, rowsTop, colsLeft);
    if (fz.r || fz.c) {
      ctx.strokeStyle = T.frozen;
      ctx.lineWidth = 2;
      ctx.beginPath();
      if (fz.r) { ctx.moveTo(0, HEAD_H * z + fz.h * z); ctx.lineTo(W, HEAD_H * z + fz.h * z); }
      if (fz.c) { ctx.moveTo(this.headW + fz.w * z, 0); ctx.lineTo(this.headW + fz.w * z, H); }
      ctx.stroke();
    }
    this.placeEditor();
  }

  /** Visible indexes between content positions a..b (start at `from`, stop at `to`). */
  span(isRow, a, b, from, to = isRow ? MAX_ROWS - 1 : MAX_COLS - 1) {
    const out = [];
    let i = Math.max(from, this.indexAt(Math.max(0, a), isRow));
    const pos = isRow ? (k) => this.rowY(k) : (k) => this.colX(k);
    const size = isRow ? (k) => this.rowH(k) : (k) => this.colW(k);
    let p = pos(i);
    while (i <= to && p < b && out.length < 600) {
      if (size(i) > 0) out.push(i);
      p += size(i);
      i++;
    }
    return out;
  }

  styleOf(cell) { return this.book.styles.get(cell ? cell.s : 0); }

  fontOf(st) {
    const size = (st.size || 11) * (96 / 72) * this.zoom;
    const fam = st.font ? `"${st.font}", ${this.baseFont}` : this.baseFont;
    return `${st.italic ? 'italic ' : ''}${st.bold ? '700 ' : '400 '}${size}px ${fam}`;
  }

  get baseFont() { return '"Carlito", "Calibri", "Inter", "Segoe UI", "Noto Sans", "DejaVu Sans", Arial, sans-serif'; }

  textWidth(font, text) {
    const k = `${font}|${text}`;
    let w = this.measure.get(k);
    if (w === undefined) {
      this.ctx.font = font;
      w = this.ctx.measureText(text).width;
      if (this.measure.size > 20000) this.measure.clear();
      this.measure.set(k, w);
    }
    return w;
  }

  drawCells(rows, cols) {
    const ctx = this.ctx;
    const z = this.zoom;
    const T = this.theme;
    const sh = this.sheet;
    const book = this.book;
    const merges = sh.merges.filter((m) => m.r1 >= rows[0] && m.r0 <= rows[rows.length - 1] && m.c1 >= cols[0] && m.c0 <= cols[cols.length - 1]);
    const inMerge = (r, c) => merges.find((m) => r >= m.r0 && r <= m.r1 && c >= m.c0 && c <= m.c1);
    const texts = [];
    // Backgrounds and gridlines.
    if (sh.showGrid) {
      ctx.strokeStyle = T.grid;
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (const r of rows) {
        const rc = this.rectOf(r, cols[0], r, cols[cols.length - 1]);
        const y = Math.round(rc.y + rc.h) - 0.5;
        ctx.moveTo(rc.x, y); ctx.lineTo(rc.x + rc.w, y);
      }
      for (const c of cols) {
        const rc = this.rectOf(rows[0], c, rows[rows.length - 1], c);
        const x = Math.round(rc.x + rc.w) - 0.5;
        ctx.moveTo(x, rc.y); ctx.lineTo(x, rc.y + rc.h);
      }
      ctx.stroke();
    }
    const firstRow = rows[0];
    const lastRow = rows[rows.length - 1];
    for (const r of rows) {
      for (const c of cols) {
        const m = inMerge(r, c);
        if (m && (m.r0 !== r || m.c0 !== c)) {
          // Draw a merge once, from its first visible cell.
          if (!(r === Math.max(m.r0, firstRow) && c === Math.max(m.c0, cols[0]) && (m.r0 < firstRow || m.c0 < cols[0]))) continue;
        }
        const cell = sh.get(m ? m.r0 : r, m ? m.c0 : c);
        const val = this.showFormulas && cell && cell.f ? `=${cell.f}` : book.value(sh, m ? m.r0 : r, m ? m.c0 : c);
        let st = this.styleOf(cell);
        const cf = this.condFormat(m ? m.r0 : r, m ? m.c0 : c, val);
        if (cf) st = { ...st, ...cf.style };
        if (!cell && val === null && !cf && !m) continue;
        const rc = m ? this.rectOf(m.r0, m.c0, m.r1, m.c1) : this.rectOf(r, c, r, c);
        if (m || st.fill) {
          ctx.fillStyle = st.fill || T.bg;
          ctx.fillRect(rc.x, rc.y, rc.w - (m ? 1 : 0), rc.h - (m ? 1 : 0));
          if (m && sh.showGrid) { ctx.strokeStyle = T.grid; ctx.strokeRect(rc.x - 0.5, rc.y - 0.5, rc.w, rc.h); }
        }
        if (cf && cf.bar) {
          const bw = (rc.w - 4) * cf.bar.frac;
          const grad = ctx.createLinearGradient(rc.x, 0, rc.x + rc.w, 0);
          grad.addColorStop(0, cf.bar.color);
          grad.addColorStop(1, `${cf.bar.color}33`);
          ctx.fillStyle = grad;
          ctx.fillRect(rc.x + 2, rc.y + 3, bw, rc.h - 7);
        }
        if (val instanceof Spark) { this.drawSpark(val, rc, st); continue; }
        if (val !== null && val !== undefined && val !== '') texts.push({ r, c, rc, val, st, cell, merged: !!m });
        if (cell && cell.note) {
          ctx.fillStyle = '#e5534b';
          ctx.beginPath();
          ctx.moveTo(rc.x + rc.w - 7 * z, rc.y);
          ctx.lineTo(rc.x + rc.w - 1, rc.y);
          ctx.lineTo(rc.x + rc.w - 1, rc.y + 6 * z);
          ctx.fill();
        }
      }
    }
    // Text, after all backgrounds, so long text can run over empty neighbours.
    for (const t of texts) this.drawText(t, rows, cols, inMerge);
    // Borders on top.
    for (const r of rows) {
      for (const c of cols) {
        const cell = sh.get(r, c);
        if (!cell || !cell.s) continue;
        const b = this.styleOf(cell).border;
        if (!b) continue;
        const m = inMerge(r, c);
        const rc = m ? this.rectOf(m.r0, m.c0, m.r1, m.c1) : this.rectOf(r, c, r, c);
        for (const side of ['t', 'r', 'b', 'l']) {
          const spec = b[side];
          if (!spec) continue;
          const [style, color] = String(spec).split(' ');
          ctx.strokeStyle = color || (T === THEMES.dark ? '#c9d1cb' : '#1b1f1c');
          ctx.lineWidth = style === 'thick' ? 3 : style === 'medium' ? 2 : 1;
          ctx.setLineDash(style === 'dashed' ? [4, 3] : style === 'dotted' ? [1, 2] : []);
          ctx.beginPath();
          const x0 = Math.round(rc.x) - 0.5;
          const y0 = Math.round(rc.y) - 0.5;
          const x1 = Math.round(rc.x + rc.w) - 0.5;
          const y1 = Math.round(rc.y + rc.h) - 0.5;
          if (side === 't') { ctx.moveTo(x0, y0); ctx.lineTo(x1, y0); }
          if (side === 'b') { ctx.moveTo(x0, y1); ctx.lineTo(x1, y1); }
          if (side === 'l') { ctx.moveTo(x0, y0); ctx.lineTo(x0, y1); }
          if (side === 'r') { ctx.moveTo(x1, y0); ctx.lineTo(x1, y1); }
          ctx.stroke();
          if (style === 'double') { ctx.beginPath(); if (side === 'b') { ctx.moveTo(x0, y1 - 2); ctx.lineTo(x1, y1 - 2); } ctx.stroke(); }
        }
        ctx.setLineDash([]);
      }
    }
    // Filter buttons and validation arrows.
    const f = sh.filter;
    if (f && f.r0 >= rows[0] && f.r0 <= lastRow) {
      for (const c of cols) {
        if (c < f.c0 || c > f.c1) continue;
        const rc = this.rectOf(f.r0, c, f.r0, c);
        const active = f.crit && f.crit[c];
        this.drawDropButton(rc, active);
      }
    }
    const a = { r: this.sel.r, c: this.sel.c };
    const v = this.validationAt(a.r, a.c);
    if (v && v.type === 'list' && rows.includes(a.r) && cols.includes(a.c)) this.drawDropButton(this.rectOf(a.r, a.c, a.r, a.c), false);
  }

  drawDropButton(rc, active) {
    const ctx = this.ctx;
    const z = this.zoom;
    const s = Math.min(18 * z, rc.h - 4);
    const x = rc.x + rc.w - s - 2;
    const y = rc.y + (rc.h - s) / 2;
    ctx.fillStyle = active ? '#1f883d' : (this.theme === THEMES.dark ? '#2a302c' : '#eef1ef');
    ctx.strokeStyle = this.theme === THEMES.dark ? '#4a554d' : '#b7c1ba';
    ctx.fillRect(x, y, s, s);
    ctx.strokeRect(x + 0.5, y + 0.5, s - 1, s - 1);
    ctx.fillStyle = active ? '#fff' : this.theme.headText;
    ctx.beginPath();
    if (active) {
      ctx.moveTo(x + s * 0.25, y + s * 0.3); ctx.lineTo(x + s * 0.75, y + s * 0.3); ctx.lineTo(x + s * 0.55, y + s * 0.55); ctx.lineTo(x + s * 0.55, y + s * 0.75); ctx.lineTo(x + s * 0.45, y + s * 0.7); ctx.lineTo(x + s * 0.45, y + s * 0.55);
    } else { ctx.moveTo(x + s * 0.3, y + s * 0.4); ctx.lineTo(x + s * 0.7, y + s * 0.4); ctx.lineTo(x + s * 0.5, y + s * 0.65); }
    ctx.fill();
  }

  drawText({ r, c, rc, val, st, cell, merged }, rows, cols, inMerge) {
    const ctx = this.ctx;
    const z = this.zoom;
    const sh = this.sheet;
    const T = this.theme;
    const isNum = typeof val === 'number';
    const fmt = formatValue(val, this.showFormulas ? 'General' : st.fmt || 'General');
    let text = fmt.text;
    const link = val && typeof val === 'object' && val.link;
    let align = st.align || (isErr(val) || typeof val === 'boolean' ? 'center' : isNum ? 'right' : 'left');
    if (this.showFormulas && cell && cell.f) align = 'left';
    const font = this.fontOf(st);
    ctx.font = font;
    let color = fmt.color || st.color || (isErr(val) ? '#e5534b' : link ? '#2f81f7' : T.text);
    if (!st.color && !fmt.color && T === THEMES.dark && st.fill && isLightFill(st.fill)) color = '#1b1f1c';
    ctx.fillStyle = color;
    const pad = 4 * z + (st.indent || 0) * 10 * z;
    const lh = (st.size || 11) * (96 / 72) * z * 1.2;
    let clipX0 = rc.x;
    let clipX1 = rc.x + rc.w;
    const width = this.textWidth(font, text);
    if (st.wrap && !isNum) {
      const lines = wrapLines(ctx, text, rc.w - pad * 2);
      const total = lines.length * lh;
      let y = st.valign === 'top' ? rc.y + 2 * z : st.valign === 'middle' ? rc.y + (rc.h - total) / 2 : rc.y + rc.h - total - 3 * z;
      ctx.save();
      ctx.beginPath(); ctx.rect(rc.x, rc.y, rc.w, rc.h); ctx.clip();
      ctx.textBaseline = 'top';
      for (const line of lines) {
        const lw = ctx.measureText(line).width;
        const x = align === 'center' ? rc.x + (rc.w - lw) / 2 : align === 'right' ? rc.x + rc.w - pad - lw : rc.x + pad;
        ctx.fillText(line, x, y + lh * 0.1);
        y += lh;
      }
      ctx.restore();
      return;
    }
    if (isNum && width > rc.w - pad && !merged) text = '#'.repeat(Math.max(1, Math.floor((rc.w - pad) / this.textWidth(font, '#'))));
    else if (width > rc.w - pad * 2 && !merged) {
      // Let text run into empty cells beside it.
      const empty = (cc) => {
        if (cc < 0 || cc >= MAX_COLS) return false;
        if (inMerge(r, cc)) return false;
        const other = sh.get(r, cc);
        return !(other && (other.f || (other.v !== null && other.v !== undefined && other.v !== ''))) && !sh.spillOwner.has(key(r, cc));
      };
      if (align === 'left' || align === 'center') {
        let cc = c + 1;
        while (clipX1 - rc.x < width + pad * 2 && empty(cc) && cc <= cols[cols.length - 1] + 1) { clipX1 += this.colW(cc) * z; cc++; }
      }
      if (align === 'right' || align === 'center') {
        let cc = c - 1;
        while (rc.x + rc.w - clipX0 < width + pad * 2 && empty(cc) && cc >= cols[0] - 1) { clipX0 -= this.colW(cc) * z; cc--; }
      }
    }
    const tw = this.textWidth(font, text);
    let x;
    if (align === 'center') x = rc.x + (rc.w - tw) / 2;
    else if (align === 'right') x = rc.x + rc.w - pad - tw;
    else x = rc.x + pad;
    const y = st.valign === 'top' ? rc.y + lh * 0.85 : st.valign === 'middle' ? rc.y + rc.h / 2 + lh * 0.32 : rc.y + rc.h - 5 * z;
    ctx.save();
    ctx.beginPath();
    ctx.rect(clipX0 + 1, rc.y, clipX1 - clipX0 - 2, rc.h);
    ctx.clip();
    if (clipX1 > rc.x + rc.w || clipX0 < rc.x) {
      // Hide gridlines under text that runs across cells.
      ctx.fillStyle = st.fill || T.bg;
      ctx.fillRect(Math.max(clipX0, x - 2), rc.y + 1, Math.min(clipX1, x + tw + 2) - Math.max(clipX0, x - 2), rc.h - 2);
      ctx.fillStyle = color;
    }
    ctx.textBaseline = 'alphabetic';
    ctx.fillText(text, x, y);
    if (st.underline || link) { ctx.fillRect(x, y + 2 * z, tw, Math.max(1, z)); }
    if (st.strike) { ctx.fillRect(x, y - lh * 0.3, tw, Math.max(1, z)); }
    ctx.restore();
  }

  drawSpark(sp, rc, st) {
    const ctx = this.ctx;
    const z = this.zoom;
    const pad = 3 * z;
    const x0 = rc.x + pad;
    const y0 = rc.y + pad;
    const w = rc.w - pad * 2;
    const hgt = rc.h - pad * 2;
    const color = st.color || '#3fb950';
    if (sp.opts.type === 'progress') {
      ctx.fillStyle = this.theme === THEMES.dark ? '#2a302c' : '#e6ebe7';
      ctx.fillRect(x0, y0 + hgt * 0.2, w, hgt * 0.6);
      ctx.fillStyle = color;
      ctx.fillRect(x0, y0 + hgt * 0.2, w * sp.data[0], hgt * 0.6);
      return;
    }
    const data = sp.data;
    const nums = data.filter((v) => v !== null);
    if (!nums.length) return;
    const min = Math.min(0, ...nums);
    const max = Math.max(...nums, min + 1e-9);
    const yOf = (v) => y0 + hgt - ((v - min) / (max - min)) * hgt;
    if (sp.opts.type === 'column' || sp.opts.type === 'winloss') {
      const bw = w / data.length;
      data.forEach((v, i) => {
        if (v === null) return;
        ctx.fillStyle = v < 0 ? '#e5534b' : color;
        if (sp.opts.type === 'winloss') ctx.fillRect(x0 + i * bw + 1, v >= 0 ? y0 : y0 + hgt / 2, bw - 2, hgt / 2);
        else ctx.fillRect(x0 + i * bw + 1, Math.min(yOf(v), yOf(0)), Math.max(1, bw - 2), Math.abs(yOf(v) - yOf(0)));
      });
      return;
    }
    if (sp.opts.type === 'bar') {
      ctx.fillStyle = color;
      ctx.fillRect(x0, y0 + hgt * 0.2, (w * (nums[0] - min)) / (max - min), hgt * 0.6);
      return;
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5 * z;
    ctx.beginPath();
    let started = false;
    data.forEach((v, i) => {
      if (v === null) return;
      const x = x0 + (data.length > 1 ? (i / (data.length - 1)) * w : w / 2);
      if (!started) { ctx.moveTo(x, yOf(v)); started = true; } else ctx.lineTo(x, yOf(v));
    });
    ctx.stroke();
  }

  drawHeaders(rowsMain, colsMain, rowsTop, colsLeft) {
    const ctx = this.ctx;
    const z = this.zoom;
    const T = this.theme;
    const W = this.el.clientWidth;
    const H = this.el.clientHeight;
    ctx.fillStyle = T.head;
    ctx.fillRect(0, 0, W, HEAD_H * z);
    ctx.fillRect(0, 0, this.headW, H);
    const selCols = new Set();
    const selRows = new Set();
    for (const g of this.sel.ranges) {
      for (let c = g.c0; c <= Math.min(g.c1, g.c0 + 2000); c++) selCols.add(c);
      for (let r = g.r0; r <= Math.min(g.r1, g.r0 + 5000); r++) selRows.add(r);
    }
    const whole = (g) => g.r0 === 0 && g.r1 === MAX_ROWS - 1;
    const wholeR = (g) => g.c0 === 0 && g.c1 === MAX_COLS - 1;
    ctx.font = `${11 * z}px ${this.baseFont}`;
    ctx.textBaseline = 'middle';
    ctx.textAlign = 'center';
    const fz = this.frozen;
    const drawCol = (c, clipX0) => {
      const rc = this.rectOf(0, c, 0, c);
      if (rc.x + rc.w < clipX0) return;
      const on = selCols.has(c);
      const full = this.sel.ranges.some((g) => whole(g) && c >= g.c0 && c <= g.c1);
      if (on) { ctx.fillStyle = full ? T.selBorder : T.headSel; ctx.fillRect(rc.x, 0, rc.w, HEAD_H * z); }
      ctx.fillStyle = full ? '#fff' : on ? T.headSelText : T.headText;
      ctx.fillText(colName(c), rc.x + rc.w / 2, (HEAD_H * z) / 2 + 0.5);
      ctx.fillStyle = T.grid;
      ctx.fillRect(Math.round(rc.x + rc.w) - 1, 0, 1, HEAD_H * z);
    };
    const drawRow = (r, clipY0) => {
      const rc = this.rectOf(r, 0, r, 0);
      if (rc.y + rc.h < clipY0) return;
      const on = selRows.has(r);
      const full = this.sel.ranges.some((g) => wholeR(g) && r >= g.r0 && r <= g.r1);
      if (on) { ctx.fillStyle = full ? T.selBorder : T.headSel; ctx.fillRect(0, rc.y, this.headW, rc.h); }
      ctx.fillStyle = full ? '#fff' : on ? T.headSelText : T.headText;
      if (rc.h > 8 * z) ctx.fillText(String(r + 1), this.headW / 2, rc.y + rc.h / 2 + 0.5);
      ctx.fillStyle = T.grid;
      ctx.fillRect(0, Math.round(rc.y + rc.h) - 1, this.headW, 1);
    };
    ctx.save();
    ctx.beginPath(); ctx.rect(this.headW + fz.w * z, 0, W, HEAD_H * z); ctx.clip();
    for (const c of colsMain) drawCol(c, this.headW + fz.w * z);
    ctx.restore();
    for (const c of colsLeft) drawCol(c, this.headW);
    ctx.save();
    ctx.beginPath(); ctx.rect(0, HEAD_H * z + fz.h * z, this.headW, H); ctx.clip();
    for (const r of rowsMain) drawRow(r, HEAD_H * z + fz.h * z);
    ctx.restore();
    for (const r of rowsTop) drawRow(r, HEAD_H * z);
    ctx.textAlign = 'start';
    ctx.fillStyle = T.grid;
    ctx.fillRect(0, HEAD_H * z - 1, W, 1);
    ctx.fillRect(this.headW - 1, 0, 1, H);
    // The corner: select all.
    ctx.fillStyle = T.head;
    ctx.fillRect(0, 0, this.headW - 1, HEAD_H * z - 1);
    ctx.fillStyle = T.headText;
    ctx.beginPath();
    ctx.moveTo(this.headW - 5, HEAD_H * z - 5); ctx.lineTo(this.headW - 5, HEAD_H * z - 14 * z); ctx.lineTo(this.headW - 14 * z, HEAD_H * z - 5);
    ctx.fill();
  }

  drawSelection(rows, cols) {
    const ctx = this.ctx;
    const z = this.zoom;
    const T = this.theme;
    const clipR = (g) => ({ r0: Math.max(g.r0, rows[0]), c0: Math.max(g.c0, cols[0]), r1: Math.min(g.r1, rows[rows.length - 1]), c1: Math.min(g.c1, cols[cols.length - 1]) });
    const ranges = this.sel.ranges;
    // Tint the selection, leaving the active cell clear (even-odd fill).
    const act = this.sheet.mergeAt(this.sel.r, this.sel.c) || { r0: this.sel.r, c0: this.sel.c, r1: this.sel.r, c1: this.sel.c };
    const ar = this.rectOf(act.r0, act.c0, act.r1, act.c1);
    ctx.fillStyle = T.sel;
    for (const g of ranges) {
      const k = clipR(g);
      if (k.r0 > k.r1 || k.c0 > k.c1) continue;
      const rc = this.rectOf(k.r0, k.c0, k.r1, k.c1);
      ctx.beginPath();
      ctx.rect(rc.x, rc.y, rc.w, rc.h);
      if (this.sel.r >= g.r0 && this.sel.r <= g.r1 && this.sel.c >= g.c0 && this.sel.c <= g.c1) ctx.rect(ar.x, ar.y, ar.w, ar.h);
      ctx.fill('evenodd');
    }
    const last = ranges[ranges.length - 1];
    const lr = this.rectOf(last.r0, last.c0, last.r1, last.c1);
    ctx.strokeStyle = T.selBorder;
    ctx.lineWidth = 2;
    ctx.strokeRect(lr.x - 0.5, lr.y - 0.5, lr.w, lr.h);
    if (ranges.length > 1 || last.r0 !== last.r1 || last.c0 !== last.c1) {
      ctx.lineWidth = 1;
      ctx.strokeRect(ar.x + 1, ar.y + 1, ar.w - 3, ar.h - 3);
    }
    // Fill handle.
    if (!this.editing) {
      ctx.fillStyle = T.selBorder;
      ctx.fillRect(lr.x + lr.w - 4, lr.y + lr.h - 4, 7, 7);
      ctx.fillStyle = T.bg;
      ctx.fillRect(lr.x + lr.w - 4, lr.y + lr.h - 5, 7, 1);
      ctx.fillRect(lr.x + lr.w - 5, lr.y + lr.h - 4, 1, 7);
      this.handleRect = { x: lr.x + lr.w - 5, y: lr.y + lr.h - 5, w: 9, h: 9 };
    } else this.handleRect = null;
    // Copy marching ants.
    if (this.copyMark && this.copyMark.sid === this.sheet.id) {
      const g = this.copyMark.range;
      const rc = this.rectOf(g.r0, g.c0, g.r1, g.c1);
      ctx.setLineDash([5 * z, 3 * z]);
      ctx.lineDashOffset = -(performance.now() / 50) % 16;
      ctx.strokeStyle = T.selBorder;
      ctx.lineWidth = 2;
      ctx.strokeRect(rc.x, rc.y, rc.w - 1, rc.h - 1);
      ctx.setLineDash([]);
      if (!this.antsTimer) this.antsTimer = setInterval(() => { if (this.copyMark) this.drawSoon(); else { clearInterval(this.antsTimer); this.antsTimer = 0; } }, 90);
    }
    // References of the formula being typed.
    for (const hl of this.refHighlights) {
      if (hl.sheet && hl.sheet.toLowerCase() !== this.sheet.name.toLowerCase()) continue;
      const rc = this.rectOf(hl.r0, hl.c0, Math.min(hl.r1, MAX_ROWS - 1), Math.min(hl.c1, MAX_COLS - 1));
      ctx.strokeStyle = hl.color;
      ctx.fillStyle = `${hl.color}18`;
      ctx.lineWidth = 2;
      ctx.fillRect(rc.x, rc.y, rc.w, rc.h);
      ctx.setLineDash(hl.pointing ? [4, 3] : []);
      ctx.strokeRect(rc.x, rc.y, rc.w - 1, rc.h - 1);
      ctx.setLineDash([]);
    }
  }

  // =========================================================================
  // Conditional formatting and validation
  // =========================================================================
  condFormat(r, c, val) {
    const rules = this.sheet.cf;
    if (!rules.length) return null;
    let out = null;
    rules.forEach((rule, i) => {
      const g = rule.range;
      if (r < g.r0 || r > g.r1 || c < g.c0 || c > g.c1) return;
      const stats = this.cfStats(i, rule);
      const n = typeof val === 'number' ? val : null;
      let hit = false;
      switch (rule.type) {
        case 'gt': hit = n !== null && n > rule.a; break;
        case 'lt': hit = n !== null && n < rule.a; break;
        case 'between': hit = n !== null && n >= rule.a && n <= rule.b; break;
        case 'nb': hit = n !== null && (n < rule.a || n > rule.b); break;
        case 'ge': hit = n !== null && n >= rule.a; break;
        case 'le': hit = n !== null && n <= rule.a; break;
        case 'ne': hit = val !== null && val !== '' && String(val).toLowerCase() !== String(rule.a).toLowerCase() && n !== Number(rule.a); break;
        case 'eq': hit = String(val ?? '').toLowerCase() === String(rule.a).toLowerCase() || n === Number(rule.a); break;
        case 'text': hit = typeof val === 'string' && val.toLowerCase().includes(String(rule.a).toLowerCase()); break;
        case 'blank': hit = val === null || val === ''; break;
        case 'dup': hit = val !== null && val !== '' && (stats.counts.get(String(val).toLowerCase()) || 0) > 1; break;
        case 'unique': hit = val !== null && val !== '' && (stats.counts.get(String(val).toLowerCase()) || 0) === 1; break;
        case 'top': hit = n !== null && n >= stats.topCut; break;
        case 'bottom': hit = n !== null && n <= stats.bottomCut; break;
        case 'above': hit = n !== null && n > stats.mean; break;
        case 'below': hit = n !== null && n < stats.mean; break;
        case 'error': hit = isErr(val); break;
        case 'scale': {
          if (n === null || stats.max === stats.min) break;
          const t = (n - stats.min) / (stats.max - stats.min);
          out = { ...(out || {}), style: { ...((out && out.style) || {}), fill: scaleColor(rule.colors || ['#f8696b', '#ffeb84', '#63be7b'], t) } };
          return;
        }
        case 'bar': {
          if (n === null) break;
          const lo = Math.min(0, stats.min);
          const frac = stats.max === lo ? 0 : (n - lo) / (stats.max - lo);
          out = { ...(out || {}), style: (out && out.style) || {}, bar: { frac: clamp(frac, 0, 1), color: rule.color || '#3fb950' } };
          return;
        }
        default: break;
      }
      if (hit) out = { ...(out || {}), style: { ...((out && out.style) || {}), ...rule.style } };
    });
    return out;
  }

  cfStats(i, rule) {
    const cache = this.cfCache.rules;
    if (cache.has(i)) return cache.get(i);
    const g = rule.range;
    const u = this.sheet.used();
    const vals = [];
    for (let r = g.r0; r <= Math.min(g.r1, u.r); r++) for (let c = g.c0; c <= Math.min(g.c1, u.c); c++) vals.push(this.book.value(this.sheet, r, c));
    const nums = vals.filter((v) => typeof v === 'number').sort((a, b) => a - b);
    const counts = new Map();
    for (const v of vals) if (v !== null && v !== '') counts.set(String(v).toLowerCase(), (counts.get(String(v).toLowerCase()) || 0) + 1);
    const n = Number(rule.n || 10);
    const cut = (k) => (rule.percent ? Math.max(1, Math.round((nums.length * k) / 100)) : k);
    const s = {
      min: nums[0] ?? 0, max: nums[nums.length - 1] ?? 0, mean: nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : 0, counts,
      topCut: nums.length ? nums[Math.max(0, nums.length - cut(n))] : Infinity, bottomCut: nums.length ? nums[Math.min(nums.length - 1, cut(n) - 1)] : -Infinity,
    };
    cache.set(i, s);
    return s;
  }

  validationAt(r, c) {
    return this.sheet.valid.find((v) => r >= v.range.r0 && r <= v.range.r1 && c >= v.range.c0 && c <= v.range.c1) || null;
  }

  // =========================================================================
  // Selection
  // =========================================================================
  get range() { return this.sel.ranges[this.sel.ranges.length - 1]; }

  select(r, c, { extend = false, add = false } = {}) {
    r = clamp(r, 0, MAX_ROWS - 1);
    c = clamp(c, 0, MAX_COLS - 1);
    if (extend) {
      const g = { r0: Math.min(this.sel.ar, r), c0: Math.min(this.sel.ac, c), r1: Math.max(this.sel.ar, r), c1: Math.max(this.sel.ac, c) };
      this.sel.ranges[this.sel.ranges.length - 1] = this.expandMerges(g);
      this.sel.er = r;
      this.sel.ec = c;
    } else {
      const m = this.sheet.mergeAt(r, c);
      const g = m ? { ...m } : { r0: r, c0: c, r1: r, c1: c };
      if (add) this.sel.ranges.push(g); else this.sel.ranges = [g];
      this.sel.r = m ? m.r0 : r;
      this.sel.c = m ? m.c0 : c;
      this.sel.ar = this.sel.r;
      this.sel.ac = this.sel.c;
      this.sel.er = r;
      this.sel.ec = c;
    }
    this.updateExtent();
    this.drawSoon();
    this.onSelect();
  }

  selectRange(g) {
    this.sel = { ranges: [{ ...g }], r: g.r0, c: g.c0, ar: g.r0, ac: g.c0, er: g.r1, ec: g.c1 };
    this.reveal(g.r0, g.c0);
    this.drawSoon();
    this.onSelect();
  }

  expandMerges(g) {
    let changed = true;
    const out = { ...g };
    while (changed) {
      changed = false;
      for (const m of this.sheet.merges) {
        if (m.r1 < out.r0 || m.r0 > out.r1 || m.c1 < out.c0 || m.c0 > out.c1) continue;
        if (m.r0 < out.r0) { out.r0 = m.r0; changed = true; }
        if (m.c0 < out.c0) { out.c0 = m.c0; changed = true; }
        if (m.r1 > out.r1) { out.r1 = m.r1; changed = true; }
        if (m.c1 > out.c1) { out.c1 = m.c1; changed = true; }
      }
    }
    return out;
  }

  /** Ctrl+arrow: the edge of the data block in a direction. */
  edge(r, c, dr, dc) {
    const has = (rr, cc) => { const v = this.book.value(this.sheet, rr, cc); return v !== null && v !== ''; };
    const u = this.sheet.used();
    const maxR = dr > 0 ? Math.max(u.r, r) : MAX_ROWS - 1;
    const maxC = dc > 0 ? Math.max(u.c, c) : MAX_COLS - 1;
    let rr = r;
    let cc = c;
    const inside = (a, b) => a >= 0 && b >= 0 && a <= MAX_ROWS - 1 && b <= MAX_COLS - 1;
    const nextFilled = has(rr + dr, cc + dc);
    if (has(rr, cc) && nextFilled) {
      while (inside(rr + dr, cc + dc) && has(rr + dr, cc + dc)) { rr += dr; cc += dc; }
      return { r: rr, c: cc };
    }
    rr += dr; cc += dc;
    while (inside(rr, cc) && !has(rr, cc) && (dr <= 0 || rr <= maxR) && (dc <= 0 || cc <= maxC)) { rr += dr; cc += dc; }
    if (!inside(rr, cc) || (dr > 0 && rr > maxR) || (dc > 0 && cc > maxC)) {
      return { r: dr > 0 ? (rr > maxR && u.r < r ? MAX_ROWS - 1 : Math.min(rr, MAX_ROWS - 1)) : Math.max(0, rr), c: dc > 0 ? (cc > maxC && u.c < c ? MAX_COLS - 1 : Math.min(cc, MAX_COLS - 1)) : Math.max(0, cc) };
    }
    return { r: rr, c: cc };
  }

  move(dr, dc, { extend = false, jump = false } = {}) {
    let { r, c } = extend ? { r: this.sel.er ?? this.sel.r, c: this.sel.ec ?? this.sel.c } : this.sel;
    if (jump) ({ r, c } = this.edge(r, c, Math.sign(dr), Math.sign(dc)));
    else {
      // Step over hidden rows and columns, and across merges.
      const m = !extend && this.sheet.mergeAt(r, c);
      if (m) { if (dr > 0) r = m.r1; if (dc > 0) c = m.c1; }
      r += dr; c += dc;
      while (dr && r > 0 && r < MAX_ROWS - 1 && this.rowH(r) === 0) r += Math.sign(dr);
      while (dc && c > 0 && c < MAX_COLS - 1 && this.colW(c) === 0) c += Math.sign(dc);
    }
    this.select(r, c, { extend });
    this.reveal(clamp(r, 0, MAX_ROWS - 1), clamp(c, 0, MAX_COLS - 1));
  }

  /** Enter/Tab inside a multi-cell selection walk through it. */
  moveWithin(dr, dc) {
    const g = this.range;
    if (this.sel.ranges.length === 1 && (g.r0 !== g.r1 || g.c0 !== g.c1)) {
      let { r, c } = this.sel;
      if (dr) { r += dr; if (r > g.r1) { r = g.r0; c = c + 1 > g.c1 ? g.c0 : c + 1; } if (r < g.r0) { r = g.r1; c = c - 1 < g.c0 ? g.c1 : c - 1; } }
      if (dc) { c += dc; if (c > g.c1) { c = g.c0; r = r + 1 > g.r1 ? g.r0 : r + 1; } if (c < g.c0) { c = g.c1; r = r - 1 < g.r0 ? g.r1 : r - 1; } }
      this.sel.r = r; this.sel.c = c;
      this.reveal(r, c);
      this.drawSoon();
      this.onSelect();
    } else this.move(dr, dc);
  }

  // =========================================================================
  // Editing
  // =========================================================================
  startEdit(initial = null, mode = 'enter') {
    const { r, c } = this.sel;
    if (this.sheet.locked) return;
    this.editing = { r, c, mode, sid: this.sheet.id };
    const text = initial === null ? this.book.editText(this.sheet, r, c) : initial;
    this.input.value = text;
    this.input.classList.add('on');
    this.placeEditor();
    this.input.focus();
    const pos = text.length;
    this.input.setSelectionRange(pos, pos);
    this.updateRefs();
    this.onEdit('start', text);
    this.drawSoon();
  }

  placeEditor() {
    const ed = this.editing;
    if (!ed) {
      // Keep the (invisible) input over the active cell for IME and paste.
      const rc = this.rectOf(this.sel.r, this.sel.c, this.sel.r, this.sel.c);
      Object.assign(this.input.style, { left: `${rc.x}px`, top: `${rc.y}px`, width: '2px', height: `${rc.h}px` });
      return;
    }
    const m = this.sheet.mergeAt(ed.r, ed.c) || { r0: ed.r, c0: ed.c, r1: ed.r, c1: ed.c };
    const rc = this.rectOf(m.r0, m.c0, m.r1, m.c1);
    const st = this.styleOf(this.sheet.get(ed.r, ed.c));
    const z = this.zoom;
    const font = this.fontOf(st);
    // Grow to fit the text, up to the edge of the window.
    const lines = this.input.value.split('\n');
    const widest = Math.max(...lines.map((l) => this.textWidth(font, l))) + 16 * z;
    const maxW = this.el.clientWidth - rc.x - 8;
    const w = Math.max(rc.w + 1, Math.min(widest, maxW));
    const lh = (st.size || 11) * (96 / 72) * z * 1.3;
    const hh = Math.max(rc.h + 1, lines.length * lh + 6 * z);
    Object.assign(this.input.style, {
      left: `${rc.x - 1}px`, top: `${rc.y - 1}px`, width: `${w}px`, height: `${hh}px`, font, color: st.color || this.theme.text,
      background: st.fill || this.theme.bg, textAlign: st.align === 'right' && !this.input.value.startsWith('=') ? 'right' : st.align === 'center' ? 'center' : 'left',
      padding: `${Math.max(1, (rc.h - lh) / 2)}px ${4 * z}px`, lineHeight: `${lh}px`,
    });
    this.placeHint();
  }

  commitEdit(dr = 1, dc = 0, { all = false } = {}) {
    const ed = this.editing;
    if (!ed) return false;
    const text = this.input.value;
    this.editing = null;
    this.input.classList.remove('on');
    this.refHighlights = [];
    this.hideHints();
    const sh = this.book.sheets.find((s) => s.id === ed.sid) || this.sheet;
    const targets = all ? this.sel.ranges : [{ r0: ed.r, c0: ed.c, r1: ed.r, c1: ed.c }];
    this.onEdit('commit', text, { sheet: sh, r: ed.r, c: ed.c, targets });
    this.input.value = '';
    if (dr || dc) this.moveWithin(dr, dc);
    this.drawSoon();
    return true;
  }

  cancelEdit() {
    if (!this.editing) return;
    this.editing = null;
    this.input.classList.remove('on');
    this.input.value = '';
    this.refHighlights = [];
    this.hideHints();
    this.onEdit('cancel');
    this.drawSoon();
  }

  /** While typing a formula: colour its references on the grid. */
  updateRefs() {
    const text = this.input.value;
    this.refHighlights = text.startsWith('=') ? refSpans(text).map((s, i) => ({ ...s, color: REF_COLORS[i % REF_COLORS.length] })) : [];
    this.drawSoon();
  }

  /** Can a reference go at the caret (after an operator or an opening bracket)? */
  canPoint() {
    if (!this.editing || !this.input.value.startsWith('=')) return false;
    const pos = this.input.selectionStart;
    const before = this.input.value.slice(0, pos).trimEnd();
    if (this.pointSpan && this.pointSpan.e === pos) return true;
    return /[=(,;+\-*/^&<>:]$/.test(before);
  }

  /** Put (or replace) a reference to a range at the caret. */
  pointAt(g, sheetName = null) {
    const text = this.input.value;
    let s = this.input.selectionStart;
    let e = this.input.selectionEnd;
    if (this.pointSpan && this.pointSpan.e === s) { s = this.pointSpan.s; e = this.pointSpan.e; }
    const prefix = sheetName && this.editing.sid !== this.sheet.id ? `${/^[A-Za-z_][\w.]*$/.test(sheetName) ? sheetName : `'${sheetName.replace(/'/g, "''")}'`}!` : '';
    const ref = prefix + (g.r0 === g.r1 && g.c0 === g.c1 ? `${colName(g.c0)}${g.r0 + 1}` : `${colName(g.c0)}${g.r0 + 1}:${colName(g.c1)}${g.r1 + 1}`);
    this.input.value = text.slice(0, s) + ref + text.slice(e);
    const end = s + ref.length;
    this.input.setSelectionRange(end, end);
    this.pointSpan = { s, e: end, g };
    this.updateRefs();
    this.refHighlights.push({ ...g, color: '#2f81f7', pointing: true });
    this.placeEditor();
    this.onEdit('input', this.input.value);
  }

  // ---- function autocomplete and argument hints ----
  placeHint() {
    if (!this.editing) { this.hideHints(); return; }
    const text = this.input.value;
    const pos = this.input.selectionStart;
    const r = this.input.getBoundingClientRect();
    const wr = this.el.getBoundingClientRect();
    if (!text.startsWith('=')) { this.hideHints(); return; }
    const m = /([A-Za-z][A-Za-z0-9.]*)$/.exec(text.slice(0, pos));
    const before = m ? text.slice(0, pos - m[1].length) : '';
    if (m && /[=(,;+\-*/^&<>\s]$/.test(before)) {
      const q = m[1].toUpperCase();
      const list = FN_NAMES.filter((n) => n.startsWith(q)).slice(0, 10);
      if (list.length && !(list.length === 1 && list[0] === q)) {
        this.acList = list;
        this.acIndex = this.acIndex !== undefined && this.acIndex < list.length ? this.acIndex : 0;
        this.ac.replaceChildren(...list.map((n, i) => {
          const row = h(`div.menu-item${i === this.acIndex ? '.active' : ''}`, h('b', { style: { fontFamily: 'var(--mono)', fontSize: '12px' } }, n), h('span.mi-keys', FN[n].desc || ''));
          row.addEventListener('mousedown', (e) => { e.preventDefault(); this.acceptAc(n); });
          return row;
        }));
        this.ac.classList.remove('hidden');
        this.ac.style.left = `${r.left - wr.left}px`;
        this.ac.style.top = `${r.bottom - wr.top + 2}px`;
        this.acWord = m[1];
      } else { this.ac.classList.add('hidden'); this.acList = null; }
    } else { this.ac.classList.add('hidden'); this.acList = null; }
    const call = callAt(text, pos);
    if (call && FN[call.name]) {
      const args = (FN[call.name].args || '').split(',').map((a) => a.trim());
      const idx = Math.min(call.arg, args.length - 1);
      const repeating = args[args.length - 1] === '…';
      this.hint.replaceChildren(h('b', call.name), '(', ...args.flatMap((a, i) => [i ? ', ' : '', i === idx || (repeating && call.arg >= args.length - 1 && i === args.length - 2) ? h('u', a) : a]), ')',
        h('div.muted', FN[call.name].desc || ''));
      this.hint.classList.remove('hidden');
      this.hint.style.left = `${r.left - wr.left}px`;
      const top = r.top - wr.top - this.hint.offsetHeight - 4;
      this.hint.style.top = `${top < 0 ? r.bottom - wr.top + 4 + (this.acList ? this.ac.offsetHeight : 0) : top}px`;
    } else this.hint.classList.add('hidden');
  }

  acceptAc(name) {
    const pos = this.input.selectionStart;
    const word = this.acWord || '';
    const text = this.input.value;
    const next = `${text.slice(0, pos - word.length)}${name}(${text.slice(pos)}`;
    this.input.value = next;
    const caret = pos - word.length + name.length + 1;
    this.input.setSelectionRange(caret, caret);
    this.acList = null;
    this.ac.classList.add('hidden');
    this.updateRefs();
    this.placeEditor();
    this.onEdit('input', this.input.value);
  }

  hideHints() {
    this.ac.classList.add('hidden');
    this.hint.classList.add('hidden');
    this.acList = null;
  }

  /** Excel's AutoComplete: finish a word already typed in this column. */
  autoComplete() {
    const ed = this.editing;
    const text = this.input.value;
    if (!ed || !text || text.startsWith('=') || /^\d/.test(text) || this.input.selectionStart !== text.length) return;
    const low = text.toLowerCase();
    const u = this.sheet.used();
    for (let r = Math.max(0, ed.r - 500); r <= Math.min(u.r, ed.r + 500); r++) {
      if (r === ed.r) continue;
      const v = this.book.value(this.sheet, r, ed.c);
      if (typeof v === 'string' && v.length > text.length && v.toLowerCase().startsWith(low)) {
        this.input.value = text + v.slice(text.length);
        this.input.setSelectionRange(text.length, v.length);
        return;
      }
    }
  }

  // =========================================================================
  // Events
  // =========================================================================
  bind() {
    const sc = this.scroller;
    sc.addEventListener('scroll', () => {
      this.updateExtent();
      this.draw();
      this.hideTip();
    });
    // Ctrl+wheel (or pinch) zooms around the pointer.
    sc.addEventListener('wheel', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      const next = Math.abs(dy) >= 40 && Number.isInteger(dy) ? stepZoom(this.zoom, dy < 0 ? 1 : -1, 0.25, 4) : this.zoom * Math.exp(-dy * 0.01);
      this.setZoom(next, { x: e.clientX, y: e.clientY });
    }, { passive: false });
    // Two fingers zoom; one finger scrolls (the browser does that), and a tap selects.
    let z0 = 1;
    pinch(sc, { begin: () => { z0 = this.zoom; }, change: (scale, c) => this.setZoom(clamp(z0 * scale, 0.25, 4), c) });
    sc.style.touchAction = 'pan-x pan-y';
    let touch = null;
    sc.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'touch' && !this.editing) { touch = e; return; }
      this.pointerDown(e);
    });
    sc.addEventListener('pointerup', (e) => {
      const t = touch;
      touch = null;
      if (!t || isPinching(sc) || Math.hypot(e.clientX - t.clientX, e.clientY - t.clientY) > 10) return;
      // A tap: act as a click, then end the drag that started.
      this.pointerDown(t);
      window.dispatchEvent(new PointerEvent('pointerup', { clientX: t.clientX, clientY: t.clientY, pointerId: t.pointerId, pointerType: 'touch' }));
    });
    sc.addEventListener('pointercancel', () => { touch = null; });
    sc.addEventListener('pointermove', (e) => this.pointerHover(e));
    sc.addEventListener('pointerleave', () => this.hideTip());
    sc.addEventListener('dblclick', (e) => this.doubleClick(e));
    sc.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const p = this.local(e);
      const hit = this.hit(p.x, p.y);
      // Right-clicking outside the selection selects the cell first.
      if (hit.area === 'cell' && !this.inSelection(hit.r, hit.c)) this.select(hit.r, hit.c);
      if (hit.area === 'colhead' && !this.sel.ranges.some((g) => g.r0 === 0 && g.r1 === MAX_ROWS - 1 && hit.c >= g.c0 && hit.c <= g.c1)) this.selectRange({ r0: 0, c0: hit.c, r1: MAX_ROWS - 1, c1: hit.c });
      if (hit.area === 'rowhead' && !this.sel.ranges.some((g) => g.c0 === 0 && g.c1 === MAX_COLS - 1 && hit.r >= g.r0 && hit.r <= g.r1)) this.selectRange({ r0: hit.r, c0: 0, r1: hit.r, c1: MAX_COLS - 1 });
      this.onContext(e, hit);
    });
    this.input.addEventListener('input', () => {
      if (!this.editing) {
        // Typing on a selected cell starts editing with what was typed.
        const typed = this.input.value;
        this.input.value = '';
        this.startEdit(typed, 'enter');
        this.autoComplete();
        this.onEdit('input', this.input.value);
        return;
      }
      this.pointSpan = null;
      this.acIndex = 0;
      this.updateRefs();
      this.placeEditor();
      if (this.lastInputType !== 'deleteContentBackward') this.autoComplete();
      this.onEdit('input', this.input.value);
    });
    this.input.addEventListener('beforeinput', (e) => { this.lastInputType = e.inputType; });
    this.input.addEventListener('keydown', (e) => this.key(e));
    this.input.addEventListener('keyup', () => { if (this.editing) this.placeHint(); });
    this.input.addEventListener('click', () => { if (this.editing) { this.editing.mode = 'edit'; this.placeHint(); } });
  }

  local(e) {
    const r = this.el.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  }

  inSelection(r, c) {
    return this.sel.ranges.some((g) => r >= g.r0 && r <= g.r1 && c >= g.c0 && c <= g.c1);
  }

  /** Near a header border: which column or row edge it is. */
  edgeAt(p, hit) {
    const z = this.zoom;
    if (hit.area === 'colhead') {
      const rc = this.rectOf(0, hit.c, 0, hit.c);
      if (Math.abs(p.x - (rc.x + rc.w)) <= 4) return { axis: 'col', i: hit.c };
      if (Math.abs(p.x - rc.x) <= 4 && hit.c > 0) { let i = hit.c - 1; while (i > 0 && this.colW(i) === 0) i--; return { axis: 'col', i }; }
    }
    if (hit.area === 'rowhead') {
      const rc = this.rectOf(hit.r, 0, hit.r, 0);
      if (Math.abs(p.y - (rc.y + rc.h)) <= 3) return { axis: 'row', i: hit.r };
      if (Math.abs(p.y - rc.y) <= 3 && hit.r > 0) { let i = hit.r - 1; while (i > 0 && this.rowH(i) === 0) i--; return { axis: 'row', i }; }
    }
    void z;
    return null;
  }

  onSelectionBorder(p) {
    const g = this.range;
    const rc = this.rectOf(g.r0, g.c0, g.r1, g.c1);
    const near = (a, b) => Math.abs(a - b) <= 3;
    const inX = p.x >= rc.x - 3 && p.x <= rc.x + rc.w + 3;
    const inY = p.y >= rc.y - 3 && p.y <= rc.y + rc.h + 3;
    return (inY && (near(p.x, rc.x) || near(p.x, rc.x + rc.w))) || (inX && (near(p.y, rc.y) || near(p.y, rc.y + rc.h)));
  }

  pointerHover(e) {
    if (e.buttons) return;
    const p = this.local(e);
    const hit = this.hit(p.x, p.y);
    let cursor = 'cell';
    if (hit.area === 'colhead' || hit.area === 'rowhead') {
      const edge = this.edgeAt(p, hit);
      cursor = edge ? (edge.axis === 'col' ? 'col-resize' : 'row-resize') : (hit.area === 'colhead' ? 's-resize' : 'e-resize');
      if (!edge) cursor = 'default';
    } else if (hit.area === 'cell') {
      const hr = this.handleRect;
      if (hr && p.x >= hr.x && p.x <= hr.x + hr.w && p.y >= hr.y && p.y <= hr.y + hr.h) cursor = 'crosshair';
      else if (!this.editing && this.onSelectionBorder(p)) cursor = 'move';
      else {
        const cell = this.sheet.get(hit.r, hit.c);
        const v = cell && this.book.value(this.sheet, hit.r, hit.c);
        if (v && typeof v === 'object' && v.link && (e.ctrlKey || e.metaKey)) cursor = 'pointer';
        if (cell && cell.note) this.showTip(cell.note, hit);
        else if (isErr(v) && v.msg) this.showTip(`${v.code}: ${v.msg}`, hit);
        else this.hideTip();
      }
    }
    this.scroller.style.cursor = cursor;
  }

  showTip(text, hit) {
    if (this.tipFor === `${hit.r}:${hit.c}`) return;
    this.tipFor = `${hit.r}:${hit.c}`;
    const rc = this.rectOf(hit.r, hit.c, hit.r, hit.c);
    this.tip.textContent = text;
    this.tip.classList.remove('hidden');
    this.tip.style.left = `${rc.x + rc.w + 4}px`;
    this.tip.style.top = `${rc.y}px`;
  }

  hideTip() {
    this.tipFor = null;
    this.tip.classList.add('hidden');
  }

  pointerDown(e) {
    if (e.button === 2) return;
    const p = this.local(e);
    const hit = this.hit(p.x, p.y);
    this.hideTip();
    // Pointing at cells while typing a formula.
    if (this.editing && hit.area === 'cell' && this.canPoint()) {
      e.preventDefault();
      const start = { r: hit.r, c: hit.c };
      const otherSheet = this.editing.sid !== this.sheet.id ? this.sheet.name : null;
      this.pointAt({ r0: start.r, c0: start.c, r1: start.r, c1: start.c }, otherSheet);
      this.dragLoop(e, (q) => {
        const hh = this.hit(q.x, q.y);
        this.pointAt({ r0: Math.min(start.r, hh.r), c0: Math.min(start.c, hh.c), r1: Math.max(start.r, hh.r), c1: Math.max(start.c, hh.c) }, otherSheet);
      }, () => this.input.focus());
      return;
    }
    if (this.editing) this.commitEdit(0, 0);
    if (hit.area === 'corner') {
      this.selectRange({ r0: 0, c0: 0, r1: MAX_ROWS - 1, c1: MAX_COLS - 1 });
      this.input.focus({ preventScroll: true });
      return;
    }
    if (hit.area === 'colhead' || hit.area === 'rowhead') {
      const edge = this.edgeAt(p, hit);
      if (edge) { this.resizeDrag(e, edge); return; }
      const isCol = hit.area === 'colhead';
      const a = isCol ? hit.c : hit.r;
      const anchor = e.shiftKey ? (isCol ? this.sel.ac : this.sel.ar) : a;
      const mk = (b) => (isCol ? { r0: 0, c0: Math.min(anchor, b), r1: MAX_ROWS - 1, c1: Math.max(anchor, b) } : { r0: Math.min(anchor, b), c0: 0, r1: Math.max(anchor, b), c1: MAX_COLS - 1 });
      const add = e.ctrlKey || e.metaKey;
      if (add) this.sel.ranges.push(mk(a)); else this.sel.ranges = [mk(a)];
      if (!e.shiftKey) { this.sel.r = isCol ? this.firstVisibleRow() : a; this.sel.c = isCol ? a : 0; this.sel.ar = isCol ? 0 : a; this.sel.ac = isCol ? a : 0; }
      this.drawSoon();
      this.onSelect();
      this.dragLoop(e, (q) => {
        const hh = this.hit(q.x, q.y);
        this.sel.ranges[this.sel.ranges.length - 1] = mk(isCol ? hh.c : hh.r);
        this.drawSoon();
        this.onSelect();
      });
      this.input.focus({ preventScroll: true });
      return;
    }
    // Fill handle.
    const hr = this.handleRect;
    if (hr && p.x >= hr.x && p.x <= hr.x + hr.w && p.y >= hr.y && p.y <= hr.y + hr.h) { this.fillDrag(e); return; }
    if (this.onSelectionBorder(p) && !e.shiftKey) { this.moveDrag(e, hit); return; }
    // Links open with Ctrl+click.
    const v = this.book.value(this.sheet, hit.r, hit.c);
    if (v && typeof v === 'object' && v.link && (e.ctrlKey || e.metaKey)) { this.onEdit('link', v.link); return; }
    // Filter buttons and list arrows.
    const f = this.sheet.filter;
    if (f && hit.r === f.r0 && hit.c >= f.c0 && hit.c <= f.c1) {
      const rc = this.rectOf(hit.r, hit.c, hit.r, hit.c);
      if (p.x > rc.x + rc.w - 20 * this.zoom) { this.select(hit.r, hit.c); this.onPick('filter', hit, rc); return; }
    }
    const valid = this.validationAt(hit.r, hit.c);
    if (valid && valid.type === 'list' && hit.r === this.sel.r && hit.c === this.sel.c) {
      const rc = this.rectOf(hit.r, hit.c, hit.r, hit.c);
      if (p.x > rc.x + rc.w - 20 * this.zoom) { this.onPick('list', hit, rc); return; }
    }
    this.select(hit.r, hit.c, { extend: e.shiftKey, add: e.ctrlKey || e.metaKey });
    this.input.focus({ preventScroll: true });
    this.dragLoop(e, (q) => {
      const hh = this.hit(q.x, q.y);
      this.select(hh.r, hh.c, { extend: true });
    });
  }

  firstVisibleRow() {
    return this.indexAt(this.scroller.scrollTop / this.zoom + this.frozen.h, true);
  }

  /** Track a drag, scrolling when the pointer goes past the edges. */
  dragLoop(e, onMove, onEnd = () => {}) {
    let last = this.local(e);
    let timer = 0;
    const tick = () => {
      const W = this.el.clientWidth;
      const H = this.el.clientHeight;
      let dx = 0;
      let dy = 0;
      if (last.x > W - 20) dx = 20; else if (last.x < this.headW) dx = -20;
      if (last.y > H - 20) dy = 20; else if (last.y < HEAD_H * this.zoom) dy = -20;
      if (dx || dy) {
        this.scroller.scrollLeft += dx;
        this.scroller.scrollTop += dy;
        onMove(last);
      }
    };
    const move = (ev) => {
      last = this.local(ev);
      onMove(last);
      if (!timer) timer = setInterval(tick, 40);
    };
    const stop = () => {
      clearInterval(timer);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', stop);
    };
    const up = () => { stop(); onEnd(last); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    // The system took the finger over (scrolling, a pinch): give up without finishing.
    window.addEventListener('pointercancel', stop);
  }

  resizeDrag(e, edge) {
    const isCol = edge.axis === 'col';
    // Resize every selected column/row together when the edge belongs to one of them.
    const g = this.range;
    const many = isCol ? g.r0 === 0 && g.r1 === MAX_ROWS - 1 && edge.i >= g.c0 && edge.i <= g.c1 : g.c0 === 0 && g.c1 === MAX_COLS - 1 && edge.i >= g.r0 && edge.i <= g.r1;
    const list = many ? Array.from({ length: (isCol ? g.c1 - g.c0 : g.r1 - g.r0) + 1 }, (_, k) => (isCol ? g.c0 : g.r0) + k) : [edge.i];
    const start = isCol ? this.colW(edge.i) : this.rowH(edge.i);
    const p0 = this.local(e);
    this.book.begin(isCol ? 'Column width' : 'Row height');
    this.book.touchProps(this.sheet);
    this.dragLoop(e, (q) => {
      const d = ((isCol ? q.x - p0.x : q.y - p0.y) / this.zoom);
      const size = Math.max(0, Math.round(start + d));
      for (const i of list) {
        if (isCol) { this.sheet.colW.set(i, size); if (size === 0) this.sheet.hiddenC.add(i); else this.sheet.hiddenC.delete(i); }
        else { this.sheet.rowH.set(i, size); if (size === 0) this.sheet.hiddenR.add(i); else this.sheet.hiddenR.delete(i); }
      }
      this.geoStamp = null;
      this.updateExtent();
      this.draw();
      this.showTip(`${isCol ? 'Width' : 'Height'}: ${size} px`, { r: isCol ? this.firstVisibleRow() : edge.i, c: isCol ? edge.i : this.indexAt(this.scroller.scrollLeft / this.zoom, false) });
    }, () => { this.book.commit(); this.hideTip(); this.drawSoon(); });
  }

  doubleClick(e) {
    const p = this.local(e);
    const hit = this.hit(p.x, p.y);
    if (hit.area === 'colhead' || hit.area === 'rowhead') {
      const edge = this.edgeAt(p, hit);
      if (edge) this.onEdit('autofit', edge);
      return;
    }
    const hr = this.handleRect;
    if (hr && p.x >= hr.x - 2 && p.x <= hr.x + hr.w + 2 && p.y >= hr.y - 2 && p.y <= hr.y + hr.h + 2) { this.onEdit('fillDown'); return; }
    if (hit.area === 'cell') {
      this.select(hit.r, hit.c);
      this.startEdit(null, 'edit');
    }
  }

  fillDrag(e) {
    const g = { ...this.range };
    let target = null;
    this.dragLoop(e, (q) => {
      const hh = this.hit(q.x, q.y);
      const below = hh.r - g.r1;
      const above = g.r0 - hh.r;
      const right = hh.c - g.c1;
      const left = g.c0 - hh.c;
      const vert = Math.max(below, above);
      const horiz = Math.max(right, left);
      if (vert <= 0 && horiz <= 0) target = null;
      else if (vert >= horiz) target = below > 0 ? { r0: g.r0, c0: g.c0, r1: hh.r, c1: g.c1, dir: 'down' } : { r0: hh.r, c0: g.c0, r1: g.r1, c1: g.c1, dir: 'up' };
      else target = right > 0 ? { r0: g.r0, c0: g.c0, r1: g.r1, c1: hh.c, dir: 'right' } : { r0: g.r0, c0: hh.c, r1: g.r1, c1: g.c1, dir: 'left' };
      this.refHighlights = target ? [{ ...target, color: this.theme.selBorder, pointing: true }] : [];
      this.drawSoon();
    }, () => {
      this.refHighlights = [];
      if (target) this.onEdit('fill', { from: g, to: target, copy: e.ctrlKey || e.metaKey });
      this.drawSoon();
    });
  }

  moveDrag(e, hit0) {
    const g = { ...this.range };
    const off = { r: hit0.r - g.r0, c: hit0.c - g.c0 };
    let to = null;
    this.dragLoop(e, (q) => {
      const hh = this.hit(q.x, q.y);
      const r0 = clamp(hh.r - off.r, 0, MAX_ROWS - 1 - (g.r1 - g.r0));
      const c0 = clamp(hh.c - off.c, 0, MAX_COLS - 1 - (g.c1 - g.c0));
      to = { r0, c0, r1: r0 + g.r1 - g.r0, c1: c0 + g.c1 - g.c0 };
      this.refHighlights = [{ ...to, color: this.theme.selBorder, pointing: true }];
      this.drawSoon();
    }, () => {
      this.refHighlights = [];
      if (to && (to.r0 !== g.r0 || to.c0 !== g.c0)) this.onEdit('move', { from: g, to, copy: e.ctrlKey || e.metaKey });
      this.drawSoon();
    });
  }

  key(e) {
    const ed = this.editing;
    const ctrl = e.ctrlKey || e.metaKey;
    if (ed) {
      if (this.acList && !this.ac.classList.contains('hidden')) {
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { this.acIndex = (this.acIndex + (e.key === 'ArrowDown' ? 1 : -1) + this.acList.length) % this.acList.length; this.placeHint(); e.preventDefault(); return; }
        if (e.key === 'Tab' || (e.key === 'Enter' && !e.altKey)) { this.acceptAc(this.acList[this.acIndex]); e.preventDefault(); return; }
        if (e.key === 'Escape') { this.hideHints(); e.preventDefault(); return; }
      }
      if (e.key === 'Enter' && e.altKey) {
        const s = this.input.selectionStart;
        this.input.setRangeText('\n', s, this.input.selectionEnd, 'end');
        this.placeEditor();
        e.preventDefault();
        return;
      }
      if (e.key === 'Enter') { e.preventDefault(); this.commitEdit(e.shiftKey ? -1 : 1, 0, { all: ctrl }); return; }
      if (e.key === 'Tab') { e.preventDefault(); this.commitEdit(0, e.shiftKey ? -1 : 1); return; }
      if (e.key === 'Escape') { e.preventDefault(); this.cancelEdit(); return; }
      if (e.key === 'F2') { e.preventDefault(); ed.mode = ed.mode === 'edit' ? 'enter' : 'edit'; return; }
      if (e.key === 'F4') {
        const res = cycleAbsolute(this.input.value, this.input.selectionStart);
        if (res) { this.input.value = res.text; this.input.setSelectionRange(res.caret, res.caret); this.updateRefs(); this.onEdit('input', res.text); }
        e.preventDefault();
        return;
      }
      const arrows = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
      if (arrows[e.key] && ed.mode === 'enter') {
        const [dr, dc] = arrows[e.key];
        if (this.canPoint()) {
          // Point at a cell with the arrow keys.
          e.preventDefault();
          const base = this.pointSpan ? this.pointSpan.g : { r0: ed.r, c0: ed.c, r1: ed.r, c1: ed.c };
          const anchor = this.pointSpan && this.pointSpan.anchor ? this.pointSpan.anchor : { r: base.r0, c: base.c0 };
          let cur = this.pointSpan ? { r: base.r1 === anchor.r ? base.r0 : base.r1, c: base.c1 === anchor.c ? base.c0 : base.c1 } : { r: ed.r, c: ed.c };
          if (!this.pointSpan) cur = { r: ed.r, c: ed.c };
          const nr = clamp((e.shiftKey ? cur.r : (this.pointSpan ? base.r0 : ed.r)) + dr, 0, MAX_ROWS - 1);
          const nc = clamp((e.shiftKey ? cur.c : (this.pointSpan ? base.c0 : ed.c)) + dc, 0, MAX_COLS - 1);
          const g = e.shiftKey && this.pointSpan ? { r0: Math.min(anchor.r, nr), c0: Math.min(anchor.c, nc), r1: Math.max(anchor.r, nr), c1: Math.max(anchor.c, nc) } : { r0: nr, c0: nc, r1: nr, c1: nc };
          this.pointAt(g);
          this.pointSpan.anchor = e.shiftKey && anchor ? anchor : { r: nr, c: nc };
          this.reveal(nr, nc);
          return;
        }
        if (!this.input.value.startsWith('=')) {
          e.preventDefault();
          this.commitEdit(dr, dc);
        }
      }
      return;
    }

    // Not editing: navigation.
    const arrows = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (arrows[e.key]) {
      e.preventDefault();
      const [dr, dc] = arrows[e.key];
      this.move(dr, dc, { extend: e.shiftKey, jump: ctrl });
      return;
    }
    const pageRows = Math.max(1, Math.floor((this.el.clientHeight - HEAD_H * this.zoom) / (DEF_H * this.zoom)) - 1);
    switch (e.key) {
      case 'Enter': e.preventDefault(); this.moveWithin(e.shiftKey ? -1 : 1, 0); return;
      case 'Tab': e.preventDefault(); this.moveWithin(0, e.shiftKey ? -1 : 1); return;
      case 'PageDown': e.preventDefault(); if (e.altKey) this.move(0, 10, { extend: e.shiftKey }); else { this.move(pageRows, 0, { extend: e.shiftKey }); } return;
      case 'PageUp': e.preventDefault(); if (e.altKey) this.move(0, -10, { extend: e.shiftKey }); else this.move(-pageRows, 0, { extend: e.shiftKey }); return;
      case 'Home': e.preventDefault(); if (ctrl) this.select(0, 0, { extend: e.shiftKey }); else this.select(this.sel.r, 0, { extend: e.shiftKey }); this.reveal(ctrl ? 0 : this.sel.r, 0); return;
      case 'End': if (ctrl) { e.preventDefault(); const u = this.sheet.used(); this.select(Math.max(0, u.r), Math.max(0, u.c), { extend: e.shiftKey }); this.reveal(Math.max(0, u.r), Math.max(0, u.c)); } return;
      case 'F2': e.preventDefault(); this.startEdit(null, 'edit'); return;
      case 'Escape': if (this.copyMark) { this.copyMark = null; this.drawSoon(); } return;
      case 'Backspace': e.preventDefault(); this.startEdit('', 'enter'); return;
      default: break;
    }
    if (e.key === ' ' && e.ctrlKey && !e.shiftKey) { e.preventDefault(); const c0 = this.range.c0; const c1 = this.range.c1; this.selectRange({ r0: 0, c0, r1: MAX_ROWS - 1, c1 }); return; }
    if (e.key === ' ' && e.shiftKey && !e.ctrlKey) { e.preventDefault(); const r0 = this.range.r0; const r1 = this.range.r1; this.selectRange({ r0, c0: 0, r1, c1: MAX_COLS - 1 }); return; }
  }
}

function wrapLines(ctx, text, width) {
  const out = [];
  for (const para of String(text).split('\n')) {
    const words = para.split(/(\s+)/);
    let line = '';
    for (const w of words) {
      const test = line + w;
      if (ctx.measureText(test).width > width && line.trim()) { out.push(line.trimEnd()); line = w.trimStart(); }
      else line = test;
    }
    out.push(line);
  }
  return out;
}

function isLightFill(c) {
  const m = /^#([0-9a-f]{6})$/i.exec(c || '');
  if (!m) return false;
  const n = parseInt(m[1], 16);
  return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) > 150;
}

function scaleColor(colors, t) {
  const parse = (c) => { const n = parseInt(c.slice(1), 16); return [n >> 16, (n >> 8) & 255, n & 255]; };
  const seg = colors.length - 1;
  const i = Math.min(seg - 1, Math.floor(t * seg));
  const f = t * seg - i;
  const a = parse(colors[i]);
  const b = parse(colors[i + 1]);
  return `#${a.map((v, k) => Math.round(v + (b[k] - v) * f).toString(16).padStart(2, '0')).join('')}`;
}

export { rowOf, colOf, key, DEF_W, DEF_H };
