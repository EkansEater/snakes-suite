// Workbook, sheets, styles, the calculation engine and undo.
// No DOM, so it can be tested in Node.
import {
  parse, refsOf, namesOf, isVolatile, err, isErr, FormulaError, MAX_COLS, MAX_ROWS,
  shiftFormula, adjustForInsert, renameSheetRefs, parseRange, quoteSheet,
} from './formula.js';
import { FN, Rng, Arr, Spark, grid as toGrid, scalar, num, str, bool, parseNumber, cmpValues } from './functions.js';
import { formatValue } from './numfmt.js';

export const DEF_W = 100; // default column width (px)
export const DEF_H = 24; // default row height (px)
export const key = (r, c) => r * MAX_COLS + c;
export const rowOf = (k) => Math.floor(k / MAX_COLS);
export const colOf = (k) => k % MAX_COLS;

let sheetSeq = 0;

// ---------------------------------------------------------------------------
// Styles: shared, deduplicated objects; a cell keeps only the style's number
// ---------------------------------------------------------------------------
export class StylePool {
  constructor() {
    this.list = [{}];
    this.index = new Map([['{}', 0]]);
  }
  id(style) {
    const clean = {};
    for (const k of Object.keys(style).sort()) if (style[k] !== undefined && style[k] !== null && style[k] !== '' && style[k] !== false) clean[k] = style[k];
    const k = JSON.stringify(clean);
    let id = this.index.get(k);
    if (id === undefined) {
      id = this.list.length;
      this.list.push(clean);
      this.index.set(k, id);
    }
    return id;
  }
  get(id) { return this.list[id || 0] || this.list[0]; }
  /** The style `id` with some properties changed. */
  with(id, patch) {
    const s = { ...this.get(id), ...patch };
    if (patch.border) s.border = { ...(this.get(id).border || {}), ...patch.border };
    return this.id(s);
  }
}

// ---------------------------------------------------------------------------
// A sheet
// ---------------------------------------------------------------------------
export class Sheet {
  constructor(name) {
    this.id = ++sheetSeq;
    this.name = name;
    this.cells = new Map(); // key -> { v, f, s, val, ast, note }
    this.colW = new Map();
    this.rowH = new Map();
    this.hiddenR = new Set();
    this.hiddenC = new Set();
    this.merges = []; // { r0, c0, r1, c1 }
    this.freeze = { r: 0, c: 0 };
    this.filter = null; // { r0, c0, r1, c1, crit: { [col]: { values: [...] | null, cond } } }
    this.cf = []; // conditional formats
    this.valid = []; // data validation
    this.charts = [];
    this.tab = '';
    this.hidden = false;
    this.showGrid = true;
    this.spill = new Map(); // key -> value spilled from an anchor
    this.spillOwner = new Map(); // key -> anchor key
    this._used = null;
  }

  get(r, c) { return this.cells.get(key(r, c)); }

  /** Used range: { r, c } of the last row and column holding anything. */
  used() {
    if (this._used) return this._used;
    let r = -1;
    let c = -1;
    for (const k of this.cells.keys()) {
      const cell = this.cells.get(k);
      if (cell.v === null && !cell.f && !cell.s) continue;
      const rr = rowOf(k);
      const cc = colOf(k);
      if (rr > r) r = rr;
      if (cc > c) c = cc;
    }
    for (const k of this.spill.keys()) { r = Math.max(r, rowOf(k)); c = Math.max(c, colOf(k)); }
    this._used = { r, c };
    return this._used;
  }

  mergeAt(r, c) {
    for (const m of this.merges) if (r >= m.r0 && r <= m.r1 && c >= m.c0 && c <= m.c1) return m;
    return null;
  }

  props() {
    return {
      colW: [...this.colW], rowH: [...this.rowH], hiddenR: [...this.hiddenR], hiddenC: [...this.hiddenC], merges: this.merges.map((m) => ({ ...m })),
      freeze: { ...this.freeze }, filter: this.filter ? JSON.parse(JSON.stringify(this.filter)) : null, cf: JSON.parse(JSON.stringify(this.cf)),
      valid: JSON.parse(JSON.stringify(this.valid)), charts: JSON.parse(JSON.stringify(this.charts)), tab: this.tab, showGrid: this.showGrid, name: this.name, hidden: this.hidden,
    };
  }

  setProps(p) {
    this.colW = new Map(p.colW); this.rowH = new Map(p.rowH); this.hiddenR = new Set(p.hiddenR); this.hiddenC = new Set(p.hiddenC);
    this.merges = p.merges.map((m) => ({ ...m })); this.freeze = { ...p.freeze }; this.filter = p.filter ? JSON.parse(JSON.stringify(p.filter)) : null;
    this.cf = JSON.parse(JSON.stringify(p.cf)); this.valid = JSON.parse(JSON.stringify(p.valid)); this.charts = JSON.parse(JSON.stringify(p.charts));
    this.tab = p.tab; this.showGrid = p.showGrid; this.name = p.name; this.hidden = !!p.hidden;
  }
}

const cloneCell = (c) => (c ? { v: c.v, f: c.f, s: c.s, note: c.note } : null);

// ---------------------------------------------------------------------------
// The workbook
// ---------------------------------------------------------------------------
export class Book {
  constructor() {
    this.sheets = [];
    this.styles = new StylePool();
    this.names = new Map(); // NAME -> { name, ref }
    this.calc = new Calc(this);
    this.undoStack = [];
    this.redoStack = [];
    this.tx = null;
    this.savedAt = 0;
    this.listeners = new Set();
    this.version = 0;
  }

  sheet(nameOrIndex) {
    if (typeof nameOrIndex === 'number') return this.sheets[nameOrIndex];
    const low = String(nameOrIndex).toLowerCase();
    return this.sheets.find((s) => s.name.toLowerCase() === low) || null;
  }

  addSheet(name, at = this.sheets.length) {
    let n = name || `Sheet${this.sheets.length + 1}`;
    let i = 1;
    while (this.sheet(n)) n = `${name || 'Sheet'}${name ? ` (${++i})` : this.sheets.length + ++i}`;
    const s = new Sheet(n);
    this.sheets.splice(at, 0, s);
    return s;
  }

  // ---- transactions: every change is recorded so it can be undone ----
  begin(label) {
    if (this.tx) { this.tx.depth++; return; }
    this.tx = { label, cells: new Map(), props: new Map(), struct: null, depth: 1, sheets: null, names: null };
  }

  commit() {
    if (!this.tx) return;
    if (--this.tx.depth > 0) return;
    const tx = this.tx;
    this.tx = null;
    // Turn "before" records into before/after pairs.
    const cells = [];
    for (const [id, before] of tx.cells) {
      const [sid, k] = id.split(':').map(Number);
      const sh = this.sheets.find((s) => s.id === sid);
      if (!sh) continue;
      const after = cloneCell(sh.cells.get(k));
      if (JSON.stringify(before) !== JSON.stringify(after)) cells.push({ sid, k, before, after });
    }
    const props = [];
    for (const [sid, before] of tx.props) {
      const sh = this.sheets.find((s) => s.id === sid);
      if (sh) props.push({ sid, before, after: sh.props() });
    }
    const sheetsAfter = tx.sheets ? this.sheets.slice() : null;
    const namesAfter = tx.names ? new Map(this.names) : null;
    if (!cells.length && !props.length && !tx.struct && !tx.sheets && !tx.names) return;
    this.undoStack.push({ label: tx.label, cells, props, struct: tx.struct, sheets: tx.sheets ? { before: tx.sheets, after: sheetsAfter } : null, names: tx.names ? { before: tx.names, after: namesAfter } : null });
    if (this.undoStack.length > 300) { this.undoStack.shift(); this.savedAt--; }
    this.redoStack = [];
    this.changed();
  }

  /** Run fn as one undoable change. */
  edit(label, fn) {
    this.begin(label);
    try { return fn(); } finally { this.commit(); this.calc.recalc(); }
  }

  touchCell(sh, k) {
    if (!this.tx) return;
    const id = `${sh.id}:${k}`;
    if (!this.tx.cells.has(id)) this.tx.cells.set(id, cloneCell(sh.cells.get(k)));
  }

  touchProps(sh) {
    if (this.tx && !this.tx.props.has(sh.id)) this.tx.props.set(sh.id, sh.props());
  }

  touchSheets() {
    if (this.tx && !this.tx.sheets) this.tx.sheets = this.sheets.slice();
  }

  touchNames() {
    if (this.tx && !this.tx.names) this.tx.names = new Map(this.names);
  }

  /** Structural changes (inserting rows, sorting) keep whole snapshots of the sheet. */
  touchStruct(sh) {
    if (!this.tx) return;
    if (!this.tx.struct) this.tx.struct = { snaps: new Map() };
    if (!this.tx.struct.snaps.has(sh.id)) {
      this.tx.struct.snaps.set(sh.id, { cells: new Map([...sh.cells].map(([k, c]) => [k, cloneCell(c)])), props: sh.props() });
      // Other sheets' formulas may point into this one: snapshot their formulas too.
      for (const other of this.sheets) {
        if (other === sh || this.tx.struct.snaps.has(other.id)) continue;
        this.tx.struct.snaps.set(other.id, { cells: new Map([...other.cells].map(([k, c]) => [k, cloneCell(c)])), props: other.props() });
      }
    }
  }

  undo() { this.step(this.undoStack, this.redoStack, 'before'); }
  redo() { this.step(this.redoStack, this.undoStack, 'after'); }

  step(from, to, side) {
    const t = from.pop();
    if (!t) return null;
    if (t.struct) {
      // Swap the stored snapshots with the current state.
      const now = new Map();
      for (const [sid, snap] of t.struct.snaps) {
        const sh = this.sheets.find((s) => s.id === sid);
        if (!sh) continue;
        now.set(sid, { cells: new Map([...sh.cells].map(([k, c]) => [k, cloneCell(c)])), props: sh.props() });
        sh.cells = new Map([...snap.cells].map(([k, c]) => [k, cloneCell(c)]));
        sh.setProps(snap.props);
        sh._used = null;
      }
      t.struct.snaps = now;
    }
    if (t.sheets) this.sheets = t.sheets[side].slice();
    if (t.names) this.names = new Map(t.names[side]);
    for (const p of t.props) {
      const sh = this.sheets.find((s) => s.id === p.sid);
      if (sh) sh.setProps(p[side]);
    }
    for (const c of t.cells) {
      const sh = this.sheets.find((s) => s.id === c.sid);
      if (!sh) continue;
      const v = c[side];
      if (v) sh.cells.set(c.k, cloneCell(v)); else sh.cells.delete(c.k);
      sh._used = null;
    }
    to.push(t);
    if (t.struct || t.sheets || t.names) this.calc.rebuild();
    else {
      for (const c of t.cells) {
        const sh = this.sheets.find((s) => s.id === c.sid);
        if (sh) this.calc.cellChanged(sh, Math.floor(c.k / MAX_COLS), c.k % MAX_COLS);
      }
      this.calc.recalc();
    }
    this.changed();
    return t;
  }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }
  get dirty() { return this.savedAt !== this.undoStack.length; }
  markSaved() { this.savedAt = this.undoStack.length; this.changed(); }

  onChange(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); }
  changed() { this.version++; for (const f of this.listeners) f(); }

  // ---- cells ----
  /**
   * Put what someone typed into a cell: a formula ("=..."), a number, a date,
   * a percentage, TRUE/FALSE or text. Returns the number format it suggests.
   */
  input(sh, r, c, text) {
    const t = String(text ?? '');
    if (t.startsWith('=') && t.length > 1) return this.setFormula(sh, r, c, t.slice(1));
    if (t.startsWith("'")) { this.setValue(sh, r, c, t.slice(1)); return null; }
    if (t === '') { this.setValue(sh, r, c, null); return null; }
    const up = t.trim().toUpperCase();
    if (up === 'TRUE' || up === 'FALSE') { this.setValue(sh, r, c, up === 'TRUE'); return null; }
    const n = parseNumber(t);
    if (n !== null) {
      this.setValue(sh, r, c, n);
      return guessFormat(t);
    }
    this.setValue(sh, r, c, t);
    return null;
  }

  setValue(sh, r, c, v) {
    const k = key(r, c);
    this.touchCell(sh, k);
    const cell = sh.cells.get(k);
    if (v === null && (!cell || (!cell.s && !cell.note))) sh.cells.delete(k);
    else sh.cells.set(k, { ...(cell || {}), v, f: null, ast: null, val: undefined });
    sh._used = null;
    this.calc.setFormula(sh, r, c, null);
    this.calc.cellChanged(sh, r, c);
  }

  setFormula(sh, r, c, f) {
    const k = key(r, c);
    this.touchCell(sh, k);
    const cell = sh.cells.get(k) || {};
    sh.cells.set(k, { ...cell, v: null, f, ast: null, val: undefined });
    sh._used = null;
    this.calc.setFormula(sh, r, c, f);
    this.calc.cellChanged(sh, r, c);
    return null;
  }

  setStyle(sh, r, c, s) {
    const k = key(r, c);
    this.touchCell(sh, k);
    const cell = sh.cells.get(k);
    if (!cell) { if (s) sh.cells.set(k, { v: null, f: null, s }); }
    else if (!s && cell.v === null && !cell.f && !cell.note) sh.cells.delete(k);
    else cell.s = s;
    sh._used = null;
  }

  setNote(sh, r, c, note) {
    const k = key(r, c);
    this.touchCell(sh, k);
    const cell = sh.cells.get(k);
    if (!cell) { if (note) sh.cells.set(k, { v: null, f: null, s: 0, note }); }
    else cell.note = note || undefined;
  }

  clear(sh, g, what = 'all') {
    const keys = [];
    for (const k of sh.cells.keys()) {
      const r = rowOf(k);
      const c = colOf(k);
      if (r >= g.r0 && r <= g.r1 && c >= g.c0 && c <= g.c1) keys.push([r, c]);
    }
    for (const [r, c] of keys) {
      const cell = sh.get(r, c);
      if (what === 'all') { this.setValue(sh, r, c, null); this.setStyle(sh, r, c, 0); this.setNote(sh, r, c, null); }
      else if (what === 'contents') { if (cell.f || cell.v !== null) this.setValue(sh, r, c, null); }
      else if (what === 'formats') this.setStyle(sh, r, c, 0);
      else if (what === 'notes') this.setNote(sh, r, c, null);
    }
  }

  /** The value shown in a cell (formulas calculated, spills included). */
  value(sh, r, c) {
    const cell = sh.cells.get(key(r, c));
    if (cell && cell.f) return this.calc.valueOf(sh, r, c);
    if (cell && cell.v !== null && cell.v !== undefined) return cell.v;
    const k = key(r, c);
    if (sh.spillOwner.has(k)) {
      this.calc.ensureAnchor(sh, sh.spillOwner.get(k));
      return sh.spill.has(k) ? sh.spill.get(k) : null;
    }
    return null;
  }

  /** What the editor shows for a cell: its formula, or its value as typed. */
  editText(sh, r, c) {
    const cell = sh.get(r, c);
    if (!cell) return '';
    if (cell.f) return `=${cell.f}`;
    const v = cell.v;
    if (v === null || v === undefined) return '';
    if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (typeof v === 'number') {
      const fmt = this.styles.get(cell.s).fmt || '';
      if (/[dmyhs]/i.test(fmt.replace(/"[^"]*"|\[[^\]]*\]/g, '')) && !/^[#0.,]/.test(fmt)) return formatValue(v, v % 1 ? 'yyyy-mm-dd h:mm:ss' : 'yyyy-mm-dd').text;
      if (/%/.test(fmt)) return `${Number((v * 100).toPrecision(15))}%`;
      return String(Number(v.toPrecision(15)));
    }
    return String(v);
  }

  // ---- rows and columns ----
  insert(sh, axis, at, count) {
    this.touchStruct(sh);
    const isRow = axis === 'row';
    const moved = new Map();
    for (const [k, cell] of sh.cells) {
      let r = rowOf(k);
      let c = colOf(k);
      if (isRow ? r >= at : c >= at) {
        if (isRow) r += count; else c += count;
        if (count < 0 && (isRow ? r < at : c < at)) continue; // deleted
      }
      if (r >= MAX_ROWS || c >= MAX_COLS) continue;
      moved.set(key(r, c), cell);
    }
    sh.cells = moved;
    // Formulas everywhere follow the move.
    for (const other of this.sheets) {
      for (const cell of other.cells.values()) {
        if (cell.f) cell.f = adjustForInsert(cell.f, other.name, sh.name, axis, at, count);
      }
    }
    for (const [n, def2] of this.names) this.names.set(n, { ...def2, ref: adjustForInsert(def2.ref, sh.name, sh.name, axis, at, count) });
    const shiftMap = (m) => {
      const out = new Map();
      for (const [i, v] of m) {
        if (i >= at) { if (count < 0 && i < at - count) continue; out.set(i + count, v); } else out.set(i, v);
      }
      return out;
    };
    const shiftSet = (s) => new Set([...shiftMap(new Map([...s].map((i) => [i, 1]))).keys()]);
    if (isRow) { sh.rowH = shiftMap(sh.rowH); sh.hiddenR = shiftSet(sh.hiddenR); } else { sh.colW = shiftMap(sh.colW); sh.hiddenC = shiftSet(sh.hiddenC); }
    const moveRange = (g) => {
      const a = isRow ? 'r0' : 'c0';
      const b = isRow ? 'r1' : 'c1';
      if (count > 0) {
        if (g[a] >= at) g[a] += count;
        if (g[b] >= at) g[b] += count;
      } else {
        const d1 = at - count - 1;
        if (g[a] >= at && g[b] <= d1) return false;
        if (g[a] > d1) g[a] += count; else if (g[a] >= at) g[a] = at;
        if (g[b] > d1) g[b] += count; else if (g[b] >= at) g[b] = at - 1;
        if (g[b] < g[a]) return false;
      }
      return true;
    };
    sh.merges = sh.merges.filter(moveRange);
    for (const list of [sh.cf, sh.valid]) for (let i = list.length - 1; i >= 0; i--) if (!moveRange(list[i].range)) list.splice(i, 1);
    if (sh.filter && !moveRange(sh.filter)) sh.filter = null;
    for (const ch of sh.charts) if (ch.range) { const g = parseRange(ch.range); if (g && moveRange(g)) ch.range = rangeText(g); }
    sh._used = null;
    this.calc.rebuild();
  }

  /** Sort the rows of a range by keys [{ col, desc }]. */
  sort(sh, g, keys, hasHeader = false) {
    this.touchStruct(sh);
    const r0 = g.r0 + (hasHeader ? 1 : 0);
    const rows = [];
    for (let r = r0; r <= g.r1; r++) {
      const cells = [];
      for (let c = g.c0; c <= g.c1; c++) cells.push(sh.get(r, c) ? cloneCell(sh.get(r, c)) : null);
      rows.push({ r, cells, vals: keys.map((k) => this.value(sh, r, k.col)) });
    }
    rows.sort((a, b) => {
      for (let i = 0; i < keys.length; i++) {
        const x = a.vals[i];
        const y = b.vals[i];
        const ex = x === null || x === '';
        const ey = y === null || y === '';
        if (ex !== ey) return ex ? 1 : -1; // blanks always last
        const cmp = cmpValues(x, y);
        if (cmp) return keys[i].desc ? -cmp : cmp;
      }
      return a.r - b.r;
    });
    rows.forEach((row, i) => {
      const r = r0 + i;
      row.cells.forEach((cell, j) => {
        const c = g.c0 + j;
        const k = key(r, c);
        if (cell) {
          if (cell.f && row.r !== r) cell.f = shiftFormula(cell.f, r - row.r, 0);
          sh.cells.set(k, { ...cell });
        } else sh.cells.delete(k);
      });
    });
    sh._used = null;
    this.calc.rebuild();
  }

  renameSheet(sh, name) {
    const old = sh.name;
    if (!name || name === old) return;
    this.touchSheets();
    this.touchProps(sh);
    for (const other of this.sheets) {
      for (const [k, cell] of other.cells) {
        if (cell.f && cell.f.includes(old)) {
          this.touchCell(other, k);
          cell.f = renameSheetRefs(cell.f, old, name);
        }
      }
    }
    sh.name = name;
    this.calc.rebuild();
  }

  // ---- names ----
  defineName(name, ref) {
    this.touchNames();
    this.names.set(name.toUpperCase(), { name, ref });
    this.calc.rebuild();
  }
}

export function rangeText(g) {
  const a = (r, c) => `${colLetters(c)}${r + 1}`;
  return g.r0 === g.r1 && g.c0 === g.c1 ? a(g.r0, g.c0) : `${a(g.r0, g.c0)}:${a(g.r1, g.c1)}`;
}
function colLetters(c) {
  let s = '';
  c += 1;
  while (c > 0) { const m = (c - 1) % 26; s = String.fromCharCode(65 + m) + s; c = Math.floor((c - 1) / 26); }
  return s;
}

/** The number format suggested by how a number was typed. */
export function guessFormat(t) {
  const s = t.trim();
  if (/^-?\(?\$/.test(s)) return /\.\d/.test(s) ? '$#,##0.00' : '$#,##0';
  if (/%$/.test(s)) return /\.\d+%$/.test(s) ? '0.00%' : '0%';
  if (/^\d{4}-\d{1,2}-\d{1,2}[ T]\d/.test(s)) return 'yyyy-mm-dd h:mm';
  if (/^\d{4}-\d{1,2}-\d{1,2}$/.test(s)) return 'yyyy-mm-dd';
  if (/^\d{1,2}\/\d{1,2}\/\d{2,4}$/.test(s)) return 'm/d/yyyy';
  if (/^\d{1,2}:\d{2}(:\d{2})?\s*[ap]m$/i.test(s)) return 'h:mm AM/PM';
  if (/^\d{1,2}:\d{2}:\d{2}$/.test(s)) return 'h:mm:ss';
  if (/^\d{1,2}:\d{2}$/.test(s)) return 'h:mm';
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(s)) return /\./.test(s) ? '#,##0.00' : '#,##0';
  if (/e/i.test(s)) return '0.00E+00';
  return null;
}

// ---------------------------------------------------------------------------
// Calculation
// ---------------------------------------------------------------------------
class Calc {
  constructor(book) {
    this.book = book;
    this.formulas = new Map(); // id "sid:key" -> { sh, r, c, refs, volatile }
    this.single = new Map(); // "sid:key" of a precedent -> Set of formula ids
    this.ranges = new Map(); // sid -> Map(col bucket -> [{ r0, c0, r1, c1, id }])
    this.wide = []; // ranges over many columns: { sid, r0, c0, r1, c1, id }
    this.nameUsers = new Map(); // NAME -> Set of formula ids
    this.dirty = new Set();
    this.computing = new Set();
    this.anchors = new Map(); // id -> { sh, r, c, rows, cols } current spill size
    this.blocked = new Map(); // id -> { sh, r, c, rows, cols } results that could not spill
  }

  sheetById(sid) { return this.book.sheets.find((s) => s.id === sid); }

  /** Forget everything and register every formula again (after big changes). */
  rebuild() {
    this.formulas.clear(); this.single.clear(); this.ranges.clear(); this.wide = []; this.nameUsers.clear(); this.anchors.clear(); this.blocked.clear();
    for (const sh of this.book.sheets) {
      sh.spill.clear();
      sh.spillOwner.clear();
      for (const [k, cell] of sh.cells) {
        cell.ast = null;
        if (cell.f) this.setFormula(sh, Math.floor(k / MAX_COLS), k % MAX_COLS, cell.f);
      }
    }
    for (const id of this.formulas.keys()) this.dirty.add(id);
    this.recalc();
  }

  setFormula(sh, r, c, f) {
    const id = `${sh.id}:${key(r, c)}`;
    const old = this.formulas.get(id);
    if (old) this.unregister(id, old);
    if (!f) { this.clearSpill(sh, key(r, c)); return; }
    const cell = sh.get(r, c);
    let ast;
    try { ast = parse(f); } catch (e) { ast = { k: 'e', v: '#NAME?', msg: e.message }; }
    cell.ast = ast;
    const refs = [];
    for (const ref of refsOf(ast)) {
      const target = ref.sheet ? this.book.sheet(ref.sheet) : sh;
      if (!target) continue;
      refs.push({ sid: target.id, r0: Math.min(ref.r0, ref.r1), c0: Math.min(ref.c0, ref.c1), r1: Math.max(ref.r0, ref.r1), c1: Math.max(ref.c0, ref.c1) });
    }
    for (const nm of namesOf(ast)) {
      const def2 = this.book.names.get(nm);
      if (!this.nameUsers.has(nm)) this.nameUsers.set(nm, new Set());
      this.nameUsers.get(nm).add(id);
      const rng = def2 && this.nameRange(def2.ref);
      if (rng) refs.push({ sid: rng.sheet.id, r0: rng.r0, c0: rng.c0, r1: rng.r1, c1: rng.c1 });
    }
    const entry = { sh, r, c, refs, volatile: isVolatile(ast) };
    this.formulas.set(id, entry);
    for (const g of refs) {
      if (g.r0 === g.r1 && g.c0 === g.c1) {
        const p = `${g.sid}:${key(g.r0, g.c0)}`;
        if (!this.single.has(p)) this.single.set(p, new Set());
        this.single.get(p).add(id);
      } else if (g.c1 - g.c0 > 40) this.wide.push({ ...g, id });
      else {
        if (!this.ranges.has(g.sid)) this.ranges.set(g.sid, new Map());
        const buckets = this.ranges.get(g.sid);
        for (let col = g.c0; col <= g.c1; col++) {
          if (!buckets.has(col)) buckets.set(col, []);
          buckets.get(col).push({ ...g, id });
        }
      }
    }
    this.dirty.add(id);
  }

  unregister(id, entry) {
    for (const g of entry.refs) {
      if (g.r0 === g.r1 && g.c0 === g.c1) {
        const s = this.single.get(`${g.sid}:${key(g.r0, g.c0)}`);
        if (s) s.delete(id);
      } else if (g.c1 - g.c0 > 40) this.wide = this.wide.filter((w) => w.id !== id);
      else {
        const buckets = this.ranges.get(g.sid);
        if (!buckets) continue;
        for (let col = g.c0; col <= g.c1; col++) {
          const list = buckets.get(col);
          if (list) buckets.set(col, list.filter((x) => x.id !== id));
        }
      }
    }
    for (const users of this.nameUsers.values()) users.delete(id);
    this.blocked.delete(id);
    this.formulas.delete(id);
    this.dirty.delete(id);
  }

  nameRange(ref) {
    const m = /^(?:(?:'((?:[^']|'')+)'|([^!]+))!)?(.+)$/.exec(String(ref || '').replace(/^=/, ''));
    if (!m) return null;
    const sheet = this.book.sheet(m[1] ? m[1].replace(/''/g, "'") : m[2] || this.book.sheets[0].name);
    const g = parseRange(m[3].replace(/\$/g, ''));
    return sheet && g ? { sheet, ...g } : null;
  }

  /** Formula cells that read cell (r, c) of sheet sh. */
  dependents(sh, r, c) {
    const out = new Set(this.single.get(`${sh.id}:${key(r, c)}`) || []);
    const buckets = this.ranges.get(sh.id);
    const list = buckets && buckets.get(c);
    if (list) for (const g of list) if (r >= g.r0 && r <= g.r1) out.add(g.id);
    for (const g of this.wide) if (g.sid === sh.id && r >= g.r0 && r <= g.r1 && c >= g.c0 && c <= g.c1) out.add(g.id);
    return out;
  }

  /** A cell changed: everything that depends on it, near or far, needs calculating. */
  cellChanged(sh, r, c) {
    const queue = [...this.dependents(sh, r, c)];
    const id0 = `${sh.id}:${key(r, c)}`;
    if (this.formulas.has(id0)) queue.push(id0);
    // Typing into (or clearing) the area a result spills over decides whether it can spill.
    const owner = sh.spillOwner.get(key(r, c));
    if (owner !== undefined) queue.push(`${sh.id}:${owner}`);
    for (const [bid, b] of this.blocked) {
      if (b.sh === sh && r >= b.r && r < b.r + b.rows && c >= b.c && c < b.c + b.cols) queue.push(bid);
    }
    while (queue.length) {
      const id = queue.pop();
      if (this.dirty.has(id) && id !== id0) continue;
      this.dirty.add(id);
      const f = this.formulas.get(id);
      if (!f) continue;
      for (const d of this.dependents(f.sh, f.r, f.c)) if (!this.dirty.has(d)) queue.push(d);
      const a = this.anchors.get(id);
      if (a) {
        for (let rr = a.r; rr < a.r + a.rows; rr++) {
          for (let cc = a.c; cc < a.c + a.cols; cc++) {
            if (rr === a.r && cc === a.c) continue;
            for (const d of this.dependents(f.sh, rr, cc)) if (!this.dirty.has(d)) queue.push(d);
          }
        }
      }
    }
  }

  /** Calculate everything that is out of date, precedents first. */
  recalc() {
    for (const [id, f] of this.formulas) if (f.volatile) this.dirty.add(id);
    if (!this.dirty.size) return;
    // Order the dirty cells so precedents come first (iteratively: long chains must not overflow the stack).
    const dirty = [...this.dirty];
    const order = [];
    const state = new Map();
    const bySheet = new Map();
    for (const id of dirty) {
      const f = this.formulas.get(id);
      if (!f) continue;
      if (!bySheet.has(f.sh.id)) bySheet.set(f.sh.id, []);
      bySheet.get(f.sh.id).push(f);
      f.id = id;
    }
    const precedents = (f) => {
      const out = [];
      for (const g of f.refs) {
        const list = bySheet.get(g.sid);
        if (!list) continue;
        if (g.r0 === g.r1 && g.c0 === g.c1) {
          const id = `${g.sid}:${key(g.r0, g.c0)}`;
          if (this.dirty.has(id)) out.push(id);
          else {
            const sh = this.sheetById(g.sid);
            const owner = sh && sh.spillOwner.get(key(g.r0, g.c0));
            if (owner !== undefined && this.dirty.has(`${g.sid}:${owner}`)) out.push(`${g.sid}:${owner}`);
          }
        } else {
          for (const p of list) if (p.r >= g.r0 && p.r <= g.r1 && p.c >= g.c0 && p.c <= g.c1) out.push(p.id);
          for (const [aid, a] of this.anchors) {
            if (a.sh.id === g.sid && this.dirty.has(aid) && a.r <= g.r1 && a.r + a.rows - 1 >= g.r0 && a.c <= g.c1 && a.c + a.cols - 1 >= g.c0) out.push(aid);
          }
        }
      }
      return out;
    };
    for (const id of dirty) {
      if (state.get(id)) continue;
      const stack = [[id, null]];
      while (stack.length) {
        const top = stack[stack.length - 1];
        const [cur] = top;
        if (!top[1]) {
          state.set(cur, 1);
          const f = this.formulas.get(cur);
          top[1] = f ? precedents(f) : [];
          top[2] = 0;
        }
        if (top[2] < top[1].length) {
          const nxt = top[1][top[2]++];
          if (!state.get(nxt) && this.formulas.has(nxt)) stack.push([nxt, null]);
          continue;
        }
        state.set(cur, 2);
        order.push(cur);
        stack.pop();
      }
    }
    for (const id of order) this.compute(id);
    this.dirty.clear();
  }

  valueOf(sh, r, c) {
    const id = `${sh.id}:${key(r, c)}`;
    if (this.dirty.has(id)) this.compute(id);
    const cell = sh.get(r, c);
    return cell ? cell.val : null;
  }

  ensureAnchor(sh, anchorKey) {
    const id = `${sh.id}:${anchorKey}`;
    if (this.dirty.has(id)) this.compute(id);
  }

  compute(id) {
    const f = this.formulas.get(id);
    if (!f) { this.dirty.delete(id); return; }
    if (!this.dirty.has(id)) return;
    const cell = f.sh.get(f.r, f.c);
    if (!cell) { this.dirty.delete(id); return; }
    if (this.computing.has(id)) {
      cell.val = err('#CIRC!', 'This formula refers to itself, directly or through other cells');
      return;
    }
    this.computing.add(id);
    let v;
    try {
      v = this.evaluate(cell.ast, f.sh, f.r, f.c);
    } catch (e) {
      v = e instanceof FormulaError ? e : err('#VALUE!', String(e && e.message || e));
    }
    this.computing.delete(id);
    this.dirty.delete(id);
    // Results that are ranges or arrays spill into the cells below and to the right.
    const k = key(f.r, f.c);
    let out = v;
    if (v instanceof Rng && !v.single) out = new Arr(toGrid(v, this.ctx(f.sh, f.r, f.c)));
    else if (v instanceof Rng) out = this.book.value(this.book.sheet(v.sheet), v.r0, v.c0);
    if (out instanceof Arr && (out.rows > 1 || out.cols > 1)) {
      const blocked = this.spillBlocked(f.sh, f.r, f.c, out.rows, out.cols, k);
      this.clearSpill(f.sh, k);
      if (blocked) {
        cell.val = err('#SPILL!', 'Something is in the way of the result: clear the cells it needs');
        this.blocked.set(id, { sh: f.sh, r: f.r, c: f.c, rows: out.rows, cols: out.cols });
      } else {
        this.blocked.delete(id);
        cell.val = norm(out.data[0][0]);
        for (let i = 0; i < out.rows; i++) {
          for (let j = 0; j < out.cols; j++) {
            if (!i && !j) continue;
            const sk = key(f.r + i, f.c + j);
            f.sh.spill.set(sk, norm(out.data[i][j]));
            f.sh.spillOwner.set(sk, k);
          }
        }
        this.anchors.set(id, { sh: f.sh, r: f.r, c: f.c, rows: out.rows, cols: out.cols });
        f.sh._used = null;
      }
    } else {
      this.clearSpill(f.sh, k);
      this.blocked.delete(id);
      cell.val = norm(out instanceof Arr ? out.data[0][0] : out);
    }
  }

  spillBlocked(sh, r, c, rows, cols, anchorKey) {
    if (r + rows > MAX_ROWS || c + cols > MAX_COLS) return true;
    for (let i = 0; i < rows; i++) {
      for (let j = 0; j < cols; j++) {
        if (!i && !j) continue;
        const k = key(r + i, c + j);
        const cell = sh.cells.get(k);
        if (cell && (cell.f || (cell.v !== null && cell.v !== undefined && cell.v !== ''))) return true;
        const owner = sh.spillOwner.get(k);
        if (owner !== undefined && owner !== anchorKey) return true;
      }
    }
    return false;
  }

  clearSpill(sh, anchorKey) {
    const id = `${sh.id}:${anchorKey}`;
    const a = this.anchors.get(id);
    if (!a) return;
    for (let i = 0; i < a.rows; i++) {
      for (let j = 0; j < a.cols; j++) {
        const k = key(a.r + i, a.c + j);
        if (sh.spillOwner.get(k) === anchorKey) { sh.spill.delete(k); sh.spillOwner.delete(k); }
      }
    }
    this.anchors.delete(id);
    sh._used = null;
  }

  ctx(sh, r, c) {
    const book = this.book;
    const ctx = {
      sheet: sh.name, row: r, col: c, locals: null,
      value: (sheetName, rr, cc) => {
        const s = sheetName === sh.name ? sh : book.sheet(sheetName);
        return s ? book.value(s, rr, cc) : err('#REF!');
      },
      clamp: (g) => {
        const s = book.sheet(g.sheet);
        const u = s ? s.used() : { r: -1, c: -1 };
        return { r1: Math.min(g.r1, Math.max(g.r0, u.r)), c1: Math.min(g.c1, Math.max(g.c0, u.c)) };
      },
      hasSheet: (n) => !!book.sheet(n),
      isFormula: (n, rr, cc) => { const s = book.sheet(n); const cell = s && s.get(rr, cc); return !!(cell && cell.f); },
      formulaText: (n, rr, cc) => { const s = book.sheet(n); const cell = s && s.get(rr, cc); return cell && cell.f ? `=${cell.f}` : null; },
      formatValue: (v, fmt) => formatValue(v, fmt).text,
    };
    return ctx;
  }

  evaluate(ast, sh, r, c) {
    const ctx = this.ctx(sh, r, c);
    const book = this.book;
    const ev = (n) => {
      switch (n.k) {
        case 'n': case 's': case 'b': return n.v;
        case 'e': return err(n.v, n.msg);
        case 'missing': return null;
        case 'g': return ev(n.a);
        case 'r': {
          const sheet = n.sheet ? book.sheet(n.sheet) : sh;
          if (!sheet) return err('#REF!');
          return new Rng(sheet.name, Math.min(n.r0, n.r1), Math.min(n.c0, n.c1), Math.max(n.r0, n.r1), Math.max(n.c0, n.c1));
        }
        case 'nm': {
          const up = n.v.toUpperCase();
          if (ctx.locals && ctx.locals.has(up)) return ctx.locals.get(up);
          const d = book.names.get(up);
          if (!d) return err('#NAME?', `There is no name or function called ${n.v}`);
          const rng = this.nameRange(d.ref);
          if (rng) return new Rng(rng.sheet.name, rng.r0, rng.c0, rng.r1, rng.c1);
          const lit = parseNumber(d.ref);
          return lit !== null ? lit : d.ref;
        }
        case 'a': return new Arr(n.rows.map((row) => row.slice()));
        case 'u': {
          const v = ev(n.a);
          return mapValues(v, ctx, (x) => { const y = num(x); return isErr(y) ? y : n.op === '-' ? -y : y; });
        }
        case 'p': return mapValues(ev(n.a), ctx, (x) => { const y = num(x); return isErr(y) ? y : y / 100; });
        case 'o': return binary(n.op, ev(n.a), ev(n.b), ctx);
        case 'f': {
          const spec = FN[n.name];
          if (!spec) return err('#NAME?', `There is no function called ${n.name}`);
          if (spec.lazy) return spec.fn(n.args, ctx, ev);
          const args = n.args.map((x) => (x.k === 'missing' ? undefined : ev(x)));
          if (!spec.acceptsErrors) {
            for (const a of args) if (isErr(a)) return a;
          }
          const v = spec.fn(args, ctx);
          return v === undefined ? null : v;
        }
        default: return err('#VALUE!');
      }
    };
    return ev(ast);
  }
}

function norm(v) {
  if (v === undefined) return null;
  if (typeof v === 'number' && !Number.isFinite(v)) return err('#NUM!');
  return v;
}

function mapValues(v, ctx, fn) {
  if (v instanceof Rng && v.single) return fn(scalar(v, ctx));
  if (v instanceof Rng || v instanceof Arr) {
    const g = toGrid(v, ctx);
    return new Arr(g.map((row) => row.map((x) => (isErr(x) ? x : fn(x)))));
  }
  return isErr(v) ? v : fn(v);
}

function compare(op, a, b) {
  if (isErr(a)) return a;
  if (isErr(b)) return b;
  const ea = a === null || a === undefined;
  const eb = b === null || b === undefined;
  let x = a;
  let y = b;
  if (ea) x = typeof b === 'string' ? '' : typeof b === 'boolean' ? false : 0;
  if (eb) y = typeof a === 'string' ? '' : typeof a === 'boolean' ? false : 0;
  let c;
  if (typeof x === 'string' && typeof y === 'string') c = x.toLowerCase() < y.toLowerCase() ? -1 : x.toLowerCase() > y.toLowerCase() ? 1 : 0;
  else c = cmpValues(x, y);
  return { '=': c === 0, '<>': c !== 0, '<': c < 0, '>': c > 0, '<=': c <= 0, '>=': c >= 0 }[op];
}

function arith(op, a, b) {
  if (op === '&') {
    if (isErr(a)) return a;
    if (isErr(b)) return b;
    return str(a) + str(b);
  }
  if (['=', '<>', '<', '>', '<=', '>='].includes(op)) return compare(op, a, b);
  const x = num(a);
  if (isErr(x)) return x;
  const y = num(b);
  if (isErr(y)) return y;
  switch (op) {
    case '+': return x + y;
    case '-': return x - y;
    case '*': return x * y;
    case '/': return y === 0 ? err('#DIV/0!') : x / y;
    case '^': {
      if (x === 0 && y === 0) return err('#NUM!');
      const p = x ** y;
      return Number.isFinite(p) ? p : err('#NUM!');
    }
    default: return err('#VALUE!');
  }
}

function binary(op, a, b, ctx) {
  const isMulti = (v) => (v instanceof Rng && !v.single) || v instanceof Arr;
  if (!isMulti(a) && !isMulti(b)) {
    const x = a instanceof Rng ? scalar(a, ctx) : a;
    const y = b instanceof Rng ? scalar(b, ctx) : b;
    const v = arith(op, x, y);
    return typeof v === 'number' && !Number.isFinite(v) ? err('#NUM!') : v;
  }
  // Element by element, stretching single rows or columns (results spill).
  const ga = toGrid(a, ctx);
  const gb = toGrid(b, ctx);
  const rows = Math.max(ga.length, gb.length);
  const cols = Math.max(ga[0].length, gb[0].length);
  const at = (g, r, c) => {
    const rr = g.length === 1 ? 0 : r;
    const cc = g[0].length === 1 ? 0 : c;
    return g[rr] && g[rr][cc] !== undefined ? g[rr][cc] : err('#N/A');
  };
  const out = [];
  for (let r = 0; r < rows; r++) {
    const row = [];
    for (let c = 0; c < cols; c++) row.push(arith(op, at(ga, r, c), at(gb, r, c)));
    out.push(row);
  }
  return new Arr(out);
}

export { Rng, Arr, Spark, isErr, err, quoteSheet, num, str, bool };
