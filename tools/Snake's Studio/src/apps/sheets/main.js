// Snake's Spreadsheets.
import { h, uid, clamp, debounce, extOf, baseName, escapeHtml, drag } from '../../kit/dom.js';
import { icon } from '../../kit/icons.js';
import { host, inElectron, decodeText } from '../../kit/host.js';
import * as commands from '../../kit/commands.js';
import { createShell, tb, sep, combo, select, startScreen, onDropFiles, guardClose, refresh } from '../../kit/shell.js';
import { showMenu, contextMenu, popover, closeMenus } from '../../kit/menu.js';
import { modal, toast, errorToast, busy, promptBox, confirmBox } from '../../kit/dialogs.js';
import { pickColor, colorPicker } from '../../kit/color.js';
import { knownFonts, allFonts, FONT_SIZES } from '../../kit/fonts.js';
import { stepZoom } from '../../kit/zoom.js';
import { drawChart, seriesFromGrid, CHART_TYPES } from '../../kit/charts.js';
import { Book, key, rowOf, colOf, rangeText, guessFormat, DEF_W, DEF_H } from './engine.js';
import { colName, parseRange, parseAddr, shiftFormula, MAX_ROWS, MAX_COLS, isErr, quoteSheet, refSpans } from './formula.js';
import { FN, FN_NAMES, cmpValues, parseNumber, Spark } from './functions.js';
import { formatValue, FORMATS, changeDecimals } from './numfmt.js';
import { Grid } from './grid.js';
import { parseCSV, toCSV, bookFromCSV, toSnake, fromSnake, readXlsx, writeXlsx } from './io.js';
import { splitRef } from './xlsxparts.js';
import { TEMPLATES, templateThumb } from './templates.js';

const FILTERS = [
  { name: 'All spreadsheets', exts: ['snakesheet', 'xlsx', 'csv', 'tsv', 'txt'] },
  { name: "Snake's Spreadsheets", exts: ['snakesheet'] },
  { name: 'Excel workbook', exts: ['xlsx'] },
  { name: 'CSV', exts: ['csv'] },
  { name: 'Tab-separated', exts: ['tsv', 'txt'] },
];
const SAVE = {
  snakesheet: { name: "Snake's Spreadsheets", exts: ['snakesheet'] },
  xlsx: { name: 'Excel workbook', exts: ['xlsx'] },
  csv: { name: 'CSV (this sheet)', exts: ['csv'] },
  tsv: { name: 'Tab-separated (this sheet)', exts: ['tsv'] },
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let book = new Book();
book.addSheet('Sheet1');
const file = { handle: null, name: 'Untitled', format: 'snakesheet', id: uid('book'), opened: false };
let clip = null; // our own clipboard: { text, sid, range, cells, cut }
let painter = null;

const shell = await createShell({
  id: 'sheets', name: "Snake's Spreadsheets",
  quick: ['file.save', 'edit.undo', 'edit.redo'],
  menus: [
    { label: '&File', items: () => fileMenu() },
    { label: '&Edit', items: () => editMenu() },
    { label: '&View', items: () => viewMenu() },
    { label: '&Insert', items: () => insertMenu() },
    { label: 'F&ormat', items: () => formatMenu() },
    { label: '&Data', items: () => dataMenu() },
    { label: '&Help', items: () => [I('app.palette'), I('app.shortcuts'), I('fn.insert', { label: 'Function reference…' }), { type: 'separator' }, I('app.about')] },
  ],
  about: 'A spreadsheet with over 300 functions (including XLOOKUP, FILTER, LET, LAMBDA, SUBTOTAL and XIRR), charts, filters and conditional formatting. Reads and writes Excel (.xlsx) with its charts, notes and rules, and CSV.',
});
const settings = host.settings;

// ---------------------------------------------------------------------------
// Layout: formula bar, grid, sheet tabs
// ---------------------------------------------------------------------------
const nameBox = h('input.input.name-box', { spellcheck: false, 'data-tip': 'Name box: type a cell, a range or a name and press Enter', 'aria-label': 'Name box' });
const fxBtn = h('button.tb', { 'data-tip': 'Insert a function', html: icon('fx', 16) });
const formula = h('textarea.input.formula-input', { spellcheck: false, rows: 1, 'aria-label': 'Formula bar' });
const expandBtn = h('button.tb', { 'data-tip': 'Make the formula bar taller', html: icon('chevronDown', 14) });
const formulaBar = h('div.formula-bar', nameBox, h('span.fb-sep'), fxBtn, formula, expandBtn);
const tabs = h('div.sheet-tabs');
const addSheetBtn = h('button.tb', { 'data-tip': 'New sheet', 'data-keys': 'Shift+F11', html: icon('plus', 16) });
const tabBar = h('div.tab-bar', addSheetBtn, tabs);
const statsBox = h('div.row.sel-stats', { style: { gap: '0', height: '100%' } });

const grid = new Grid({
  book, settings,
  onSelect: () => selectionChanged(),
  onEdit: (what, text, info) => editEvent(what, text, info),
  onContext: (e, hit) => cellMenu(e, hit),
  onPick: (kind, hit, rc) => pick(kind, hit, rc),
});
const main = h('div.sheets-main', formulaBar, grid.el, tabBar);
shell.main.append(main);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
const sheet = () => grid.sheet;
const I = (id, extra) => commands.item(id, extra);
const sel = () => grid.range;
const active = () => ({ r: grid.sel.r, c: grid.sel.c });
const styleAt = (r, c) => { const cell = sheet().get(r, c); return book.styles.get(cell ? cell.s : 0); };

/** Selected ranges clamped to the used area (whole rows and columns would be huge). */
function cellsIn(g, { includeEmpty = true } = {}) {
  const u = sheet().used();
  const r1 = Math.min(g.r1, Math.max(u.r, g.r0, grid.extent.r - 1));
  const c1 = Math.min(g.c1, Math.max(u.c, g.c0, grid.extent.c - 1));
  const out = [];
  if (!includeEmpty) {
    for (const k of sheet().cells.keys()) {
      const r = rowOf(k);
      const c = colOf(k);
      if (r >= g.r0 && r <= r1 && c >= g.c0 && c <= c1) out.push([r, c]);
    }
    return out;
  }
  for (let r = g.r0; r <= r1; r++) for (let c = g.c0; c <= c1; c++) out.push([r, c]);
  return out;
}

function eachSelected(fn) {
  const seen = new Set();
  for (const g of grid.sel.ranges) {
    for (const [r, c] of cellsIn(g)) {
      const k = key(r, c);
      if (seen.has(k)) continue;
      seen.add(k);
      fn(r, c);
    }
  }
}

function applyStyle(patch, label = 'Format') {
  book.edit(label, () => {
    eachSelected((r, c) => {
      const cell = sheet().get(r, c);
      book.setStyle(sheet(), r, c, book.styles.with(cell ? cell.s : 0, patch));
    });
  });
  grid.drawSoon();
  refresh();
}

function toggleStyle(prop, label) {
  const on = !styleAt(active().r, active().c)[prop];
  applyStyle({ [prop]: on || undefined }, label);
}

/** The block of data around the active cell (for sort, filter, charts). */
function currentRegion() {
  const g = sel();
  if (g.r0 !== g.r1 || g.c0 !== g.c1) return { ...g, r1: Math.min(g.r1, Math.max(g.r0, sheet().used().r)), c1: Math.min(g.c1, Math.max(g.c0, sheet().used().c)) };
  const filled = (r, c) => r >= 0 && c >= 0 && book.value(sheet(), r, c) !== null && book.value(sheet(), r, c) !== '';
  let r0 = g.r0; let r1 = g.r0; let c0 = g.c0; let c1 = g.c0;
  let grew = true;
  while (grew) {
    grew = false;
    const rowHas = (r) => { for (let c = c0 - 1; c <= c1 + 1; c++) if (filled(r, c)) return true; return false; };
    const colHas = (c) => { for (let r = r0 - 1; r <= r1 + 1; r++) if (filled(r, c)) return true; return false; };
    if (r0 > 0 && rowHas(r0 - 1)) { r0--; grew = true; }
    if (rowHas(r1 + 1) && r1 < MAX_ROWS - 1) { r1++; grew = true; }
    if (c0 > 0 && colHas(c0 - 1)) { c0--; grew = true; }
    if (colHas(c1 + 1) && c1 < MAX_COLS - 1) { c1++; grew = true; }
    if (r1 - r0 > 100000) break;
  }
  return { r0, c0, r1, c1 };
}

function hasHeader(g) {
  const first = [];
  const second = [];
  for (let c = g.c0; c <= g.c1; c++) { first.push(book.value(sheet(), g.r0, c)); second.push(book.value(sheet(), g.r0 + 1, c)); }
  return first.every((v) => typeof v === 'string' && v !== '') && second.some((v) => typeof v === 'number' || v === null || typeof v === 'string');
}

const refOf = (g, sh = null) => `${sh && sh !== sheet() ? `${quoteSheet(sh.name)}!` : ''}${rangeText(g)}`;

// ---------------------------------------------------------------------------
// Selection, formula bar, status
// ---------------------------------------------------------------------------
function selectionChanged() {
  const { r, c } = active();
  const g = sel();
  const multi = g.r0 !== g.r1 || g.c0 !== g.c1;
  if (document.activeElement !== nameBox) {
    const name = [...book.names.values()].find((n) => { const rg = book.calc.nameRange(n.ref); return rg && rg.sheet === sheet() && rg.r0 === g.r0 && rg.c0 === g.c0 && rg.r1 === g.r1 && rg.c1 === g.c1; });
    nameBox.value = name ? name.name : (grid.sel.ranges.length > 1 ? `${grid.sel.ranges.length} ranges` : multi ? `${g.r1 - g.r0 + 1}R × ${g.c1 - g.c0 + 1}C` : `${colName(c)}${r + 1}`);
  }
  if (!grid.editing && document.activeElement !== formula) formula.value = book.editText(sheet(), r, c);
  stats();
  refresh();
  if (painter && painter.armed && !grid.editing) applyPainter();
}

const statKinds = [['sum', 'Sum'], ['average', 'Average'], ['count', 'Count'], ['numCount', 'Numbers'], ['min', 'Min'], ['max', 'Max']];
const stats = debounce(() => {
  const shown = settings.get('stats', ['sum', 'average', 'count']);
  let sum = 0; let count = 0; let numCount = 0; let min = Infinity; let max = -Infinity;
  let n = 0;
  for (const g of grid.sel.ranges) {
    for (const [r, c] of cellsIn(g, { includeEmpty: false })) {
      if (++n > 200000) break;
      const v = book.value(sheet(), r, c);
      if (v === null || v === '') continue;
      count++;
      if (typeof v === 'number') { numCount++; sum += v; min = Math.min(min, v); max = Math.max(max, v); }
    }
    for (const k of sheet().spill.keys()) {
      const r = rowOf(k); const c = colOf(k);
      if (r < g.r0 || r > g.r1 || c < g.c0 || c > g.c1) continue;
      const v = sheet().spill.get(k);
      count++;
      if (typeof v === 'number') { numCount++; sum += v; min = Math.min(min, v); max = Math.max(max, v); }
    }
  }
  const g = sel();
  const fmt = styleAt(active().r, active().c).fmt;
  const f = (v) => formatValue(v, fmt && !/@/.test(fmt) ? fmt : '#,##0.##').text;
  const vals = { sum: numCount ? f(sum) : null, average: numCount ? f(sum / numCount) : null, count: count > 1 ? count.toLocaleString() : null, numCount: numCount > 1 ? numCount.toLocaleString() : null, min: numCount ? f(min) : null, max: numCount ? f(max) : null };
  statsBox.replaceChildren();
  if (count > 1 || (g.r0 !== g.r1 || g.c0 !== g.c1)) {
    for (const [k, label] of statKinds) {
      if (!shown.includes(k) || vals[k] === null) continue;
      const b = h('button.item', { 'data-tip': `Click to copy ${label.toLowerCase()}` }, `${label}: `, h('b', { style: { color: 'var(--fg)', fontWeight: 500 } }, vals[k]));
      b.addEventListener('click', () => { navigator.clipboard.writeText(vals[k].replace(/[^\d.\-E+]/g, '')); toast(`Copied ${label.toLowerCase()}`, { timeout: 1200 }); });
      statsBox.append(b);
    }
  }
}, 80);
statsBox.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const shown = settings.get('stats', ['sum', 'average', 'count']);
  showMenu(statKinds.map(([k, label]) => ({ label, checked: shown.includes(k), run: () => { settings.set('stats', shown.includes(k) ? shown.filter((x) => x !== k) : [...shown, k]); stats(); } })), { x: e.clientX, y: e.clientY });
});

// Name box: jump to a cell, a range or a name; type a new name to define it.
nameBox.addEventListener('focus', () => nameBox.select());
nameBox.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { selectionChanged(); grid.input.focus(); return; }
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const t = nameBox.value.trim();
  const named = book.names.get(t.toUpperCase());
  if (named) {
    const rg = book.calc.nameRange(named.ref);
    if (rg) { if (rg.sheet !== sheet()) switchSheet(rg.sheet); grid.selectRange(rg); }
  } else {
    const m = /^(?:'?([^'!]+)'?!)?(.+)$/.exec(t);
    const target = m && m[1] ? book.sheet(m[1]) : sheet();
    const g = m && parseRange(m[2].replace(/\$/g, ''));
    if (g && target) { if (target !== sheet()) switchSheet(target); grid.selectRange(g); }
    else if (/^[A-Za-z_][\w.]*$/.test(t)) {
      book.edit('Define name', () => book.defineName(t, `${quoteSheet(sheet().name)}!${absRef(sel())}`));
      toast(`Defined the name “${t}”`);
    } else toast('That is not a cell, a range or a name.', { type: 'warn' });
  }
  grid.input.focus();
});
const absRef = (g) => (g.r0 === g.r1 && g.c0 === g.c1 ? `$${colName(g.c0)}$${g.r0 + 1}` : `$${colName(g.c0)}$${g.r0 + 1}:$${colName(g.c1)}$${g.r1 + 1}`);

// The formula bar edits the active cell.
formula.addEventListener('focus', () => {
  if (!grid.editing) grid.startEdit(null, 'edit');
  formula.value = grid.input.value;
  setTimeout(() => grid.input.blur(), 0);
});
formula.addEventListener('input', () => {
  if (!grid.editing) grid.startEdit('', 'edit');
  grid.input.value = formula.value;
  grid.updateRefs();
  grid.placeEditor();
});
formula.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.altKey) { e.preventDefault(); grid.input.value = formula.value; grid.commitEdit(e.shiftKey ? -1 : 1, 0, { all: e.ctrlKey }); grid.input.focus(); }
  else if (e.key === 'Tab') { e.preventDefault(); grid.input.value = formula.value; grid.commitEdit(0, e.shiftKey ? -1 : 1); grid.input.focus(); }
  else if (e.key === 'Escape') { e.preventDefault(); grid.cancelEdit(); selectionChanged(); grid.input.focus(); }
  else if (e.key === 'Enter' && e.altKey) { e.preventDefault(); formula.setRangeText('\n', formula.selectionStart, formula.selectionEnd, 'end'); formula.dispatchEvent(new Event('input')); }
});
expandBtn.addEventListener('click', () => { formulaBar.classList.toggle('tall'); expandBtn.innerHTML = icon(formulaBar.classList.contains('tall') ? 'chevronUp' : 'chevronDown', 14); });
fxBtn.addEventListener('click', () => functionDialog());

function editEvent(what, text, info) {
  if (what === 'start' || what === 'input') {
    if (document.activeElement !== formula) formula.value = text;
    return;
  }
  if (what === 'cancel') { selectionChanged(); return; }
  if (what === 'commit') return commitText(text, info);
  if (what === 'fill') return fill(text);
  if (what === 'fillDown') return fillDownToData();
  if (what === 'move') return moveCells(text);
  if (what === 'autofit') return autofit(text.axis, [text.i]);
  if (what === 'link') return host.openExternal(text);
}

function commitText(text, { sheet: sh, r, c, targets }) {
  // Lists in data validation reject other values.
  const v = grid.validationAt(r, c);
  if (v && v.type === 'list' && text !== '' && !text.startsWith('=')) {
    const options = listOptions(v);
    if (!options.some((o) => String(o).toLowerCase() === text.toLowerCase())) {
      toast(`“${text}” is not one of the choices for this cell.`, { type: 'warn' });
      return;
    }
  }
  if (v && v.type === 'number' && text !== '') {
    const n = parseNumber(text);
    if (n === null || (v.min !== undefined && n < v.min) || (v.max !== undefined && n > v.max)) {
      toast(`This cell takes a number${v.min !== undefined ? ` from ${v.min}` : ''}${v.max !== undefined ? ` to ${v.max}` : ''}.`, { type: 'warn' });
      return;
    }
  }
  book.edit('Type', () => {
    for (const g of targets) {
      const cells = g.r0 === g.r1 && g.c0 === g.c1 ? [[g.r0, g.c0]] : cellsIn(g);
      for (const [rr, cc] of cells) {
        const t = text.startsWith('=') && (rr !== r || cc !== c) ? `=${shiftFormula(text.slice(1), rr - r, cc - c)}` : text;
        const fmt = book.input(sh, rr, cc, t);
        const cell = sh.get(rr, cc);
        if (fmt && cell && !book.styles.get(cell.s).fmt) book.setStyle(sh, rr, cc, book.styles.with(cell.s, { fmt }));
      }
    }
  });
  grid.drawSoon();
  selectionChanged();
  charts.redraw();
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------
function switchSheet(sh) {
  if (grid.editing && !grid.canPoint()) grid.commitEdit(0, 0);
  grid.rememberSheet();
  if (grid.editing) {
    // Pointing at another sheet while typing a formula.
    grid.sheet = sh;
    grid.geoStamp = null;
    grid.draw();
  } else grid.setSheet(sh);
  drawTabs();
  charts.render();
  grid.input.focus({ preventScroll: true });
}

function drawTabs() {
  tabs.replaceChildren();
  book.sheets.forEach((sh, i) => {
    if (sh.hidden) return;
    const tab = h(`button.sheet-tab${sh === sheet() ? '.on' : ''}`, { draggable: 'true', style: sh.tab ? { '--tab': sh.tab } : null }, sh.name);
    if (sh.tab) tab.classList.add('colored');
    tab.addEventListener('click', () => switchSheet(sh));
    tab.addEventListener('dblclick', () => renameSheet(sh));
    tab.addEventListener('dragstart', (e) => e.dataTransfer.setData('text/snake-sheet', String(i)));
    tab.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/snake-sheet')) { e.preventDefault(); tab.classList.add('drop'); } });
    tab.addEventListener('dragleave', () => tab.classList.remove('drop'));
    tab.addEventListener('drop', (e) => {
      e.preventDefault();
      const from = Number(e.dataTransfer.getData('text/snake-sheet'));
      if (from === i) return;
      book.edit('Move sheet', () => { book.touchSheets(); const [s] = book.sheets.splice(from, 1); book.sheets.splice(i, 0, s); });
      drawTabs();
    });
    contextMenu(tab, () => tabMenu(sh));
    tabs.append(tab);
  });
  const hidden = book.sheets.filter((s) => s.hidden);
  if (hidden.length) {
    const b = h('button.tb', { 'data-tip': `${hidden.length} hidden ${hidden.length === 1 ? 'sheet' : 'sheets'}` }, `+${hidden.length} hidden`);
    b.addEventListener('click', () => showMenu(hidden.map((s) => ({ label: `Unhide ${s.name}`, run: () => { book.edit('Unhide sheet', () => { book.touchProps(s); s.hidden = false; }); drawTabs(); } })), { anchor: b }));
    tabs.append(b);
  }
}
tabs.addEventListener('wheel', (e) => { tabs.scrollLeft += e.deltaY + e.deltaX; e.preventDefault(); }, { passive: false });

function tabMenu(sh) {
  const i = book.sheets.indexOf(sh);
  const colors = ['#e5534b', '#f0883e', '#d4a72c', '#3fb950', '#2f81f7', '#a371f7', '#db61a2', '#6e7781'];
  return [
    { label: 'Insert sheet', icon: 'plus', run: () => addSheet(i + 1) },
    { label: 'Duplicate', icon: 'duplicate', run: () => duplicateSheet(sh) },
    { label: 'Rename…', icon: 'text', run: () => renameSheet(sh) },
    { label: 'Tab colour', icon: 'palette', submenu: [{ label: 'None', run: () => setTab(sh, '') }, ...colors.map((c) => ({ label: c, swatch: c, run: () => setTab(sh, c) }))] },
    { type: 'separator' },
    { label: 'Move left', disabled: i === 0, run: () => moveSheet(i, i - 1) },
    { label: 'Move right', disabled: i === book.sheets.length - 1, run: () => moveSheet(i, i + 1) },
    { label: 'Hide', disabled: book.sheets.filter((s) => !s.hidden).length < 2, run: () => { book.edit('Hide sheet', () => { book.touchProps(sh); sh.hidden = true; }); if (sh === sheet()) switchSheet(book.sheets.find((s) => !s.hidden)); drawTabs(); } },
    { type: 'separator' },
    { label: 'Delete sheet', icon: 'trash', danger: true, disabled: book.sheets.length < 2, run: () => deleteSheet(sh) },
  ];
}

function setTab(sh, color) { book.edit('Tab colour', () => { book.touchProps(sh); sh.tab = color; }); drawTabs(); }
function moveSheet(a, b) { book.edit('Move sheet', () => { book.touchSheets(); const [s] = book.sheets.splice(a, 1); book.sheets.splice(b, 0, s); }); drawTabs(); }
function addSheet(at = book.sheets.length) {
  let sh;
  book.edit('New sheet', () => { book.touchSheets(); sh = book.addSheet(null, at); });
  switchSheet(sh);
}
function duplicateSheet(sh) {
  let copy;
  book.edit('Duplicate sheet', () => {
    book.touchSheets();
    copy = book.addSheet(`${sh.name} (copy)`, book.sheets.indexOf(sh) + 1);
    copy.setProps({ ...sh.props(), name: copy.name });
    for (const [k, c] of sh.cells) copy.cells.set(k, { v: c.v, f: c.f, s: c.s, note: c.note });
    book.calc.rebuild();
  });
  switchSheet(copy);
}
async function renameSheet(sh) {
  const name = await promptBox('Rename sheet', { value: sh.name, validate: (v) => (!v.trim() ? 'A sheet needs a name.' : v.length > 31 ? 'At most 31 characters.' : /[\\/?*[\]:]/.test(v) ? 'These characters are not allowed: \\ / ? * [ ] :' : book.sheets.some((s) => s !== sh && s.name.toLowerCase() === v.trim().toLowerCase()) ? 'Another sheet has that name.' : '') });
  if (name) { book.edit('Rename sheet', () => book.renameSheet(sh, name.trim())); drawTabs(); }
}
async function deleteSheet(sh) {
  if (sh.cells.size && !(await confirmBox(`Delete “${sh.name}” and everything on it?`, { ok: 'Delete', danger: true }))) return;
  book.edit('Delete sheet', () => { book.touchSheets(); book.sheets.splice(book.sheets.indexOf(sh), 1); book.calc.rebuild(); });
  switchSheet(book.sheets.find((s) => !s.hidden) || book.sheets[0]);
}
addSheetBtn.addEventListener('click', () => addSheet());

// ---------------------------------------------------------------------------
// Clipboard: our own cells inside the app, tables and text with other apps
// ---------------------------------------------------------------------------
function selectionTable(g) {
  const rows = [];
  const html = ['<table>'];
  for (let r = g.r0; r <= g.r1; r++) {
    const row = [];
    html.push('<tr>');
    for (let c = g.c0; c <= g.c1; c++) {
      const v = book.value(sheet(), r, c);
      const st = styleAt(r, c);
      const text = v === null ? '' : v instanceof Spark ? '' : formatValue(v, st.fmt).text;
      row.push(/[\t\n"]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text);
      const css = [st.bold ? 'font-weight:bold' : '', st.italic ? 'font-style:italic' : '', st.color ? `color:${st.color}` : '', st.fill ? `background:${st.fill}` : '', st.align ? `text-align:${st.align}` : ''].filter(Boolean).join(';');
      html.push(`<td${css ? ` style="${css}"` : ''}>${escapeHtml(text)}</td>`);
    }
    rows.push(row.join('\t'));
    html.push('</tr>');
  }
  html.push('</table>');
  return { text: `${rows.join('\n')}\n`, html: html.join('') };
}

function copySelection(cut = false) {
  const g = sel();
  if ((g.r1 - g.r0 + 1) * (g.c1 - g.c0 + 1) > 2000000) { toast('That is too much to copy at once.', { type: 'warn' }); return null; }
  const clamped = { ...g, r1: Math.min(g.r1, Math.max(g.r0, sheet().used().r)), c1: Math.min(g.c1, Math.max(g.c0, sheet().used().c)) };
  const cells = [];
  for (let r = clamped.r0; r <= clamped.r1; r++) {
    const row = [];
    for (let c = clamped.c0; c <= clamped.c1; c++) {
      const cell = sheet().get(r, c);
      row.push(cell ? { v: cell.v, f: cell.f, s: cell.s, note: cell.note } : null);
    }
    cells.push(row);
  }
  const t = selectionTable(clamped);
  clip = { ...t, sid: sheet().id, range: clamped, cells, cut };
  grid.copyMark = { sid: sheet().id, range: clamped };
  grid.drawSoon();
  return t;
}

grid.input.addEventListener('copy', (e) => {
  if (grid.editing) return;
  e.preventDefault();
  const t = copySelection(false);
  if (t) { e.clipboardData.setData('text/plain', t.text); e.clipboardData.setData('text/html', t.html); }
});
grid.input.addEventListener('cut', (e) => {
  if (grid.editing) return;
  e.preventDefault();
  const t = copySelection(true);
  if (t) { e.clipboardData.setData('text/plain', t.text); e.clipboardData.setData('text/html', t.html); }
});
grid.input.addEventListener('paste', (e) => {
  if (grid.editing) return;
  e.preventDefault();
  pasteData({ text: e.clipboardData.getData('text/plain'), html: e.clipboardData.getData('text/html') });
});

function pasteData({ text, html }, mode = 'all') {
  const { r, c } = active();
  // From this app: formulas move with the cells, formats come along.
  if (clip && (text === clip.text || (!text && mode !== 'all'))) {
    const src = clip;
    const rows = mode === 'transpose' ? src.cells[0].map((_, i) => src.cells.map((row) => row[i])) : src.cells;
    // A small copy pasted onto a bigger selection fills it.
    const g = sel();
    const reps = mode === 'all' && (g.r1 - g.r0 + 1) % rows.length === 0 && (g.c1 - g.c0 + 1) % rows[0].length === 0 && (g.r1 - g.r0 + 1) * (g.c1 - g.c0 + 1) <= 100000
      ? { r: (g.r1 - g.r0 + 1) / rows.length, c: (g.c1 - g.c0 + 1) / rows[0].length } : { r: 1, c: 1 };
    const target = { r0: reps.r > 1 || reps.c > 1 ? g.r0 : r, c0: reps.r > 1 || reps.c > 1 ? g.c0 : c };
    const srcSheet = book.sheets.find((s) => s.id === src.sid);
    book.edit(src.cut ? 'Move' : 'Paste', () => {
      if (src.cut && srcSheet) {
        for (let i = 0; i < src.cells.length; i++) for (let j = 0; j < src.cells[0].length; j++) { book.setValue(srcSheet, src.range.r0 + i, src.range.c0 + j, null); book.setStyle(srcSheet, src.range.r0 + i, src.range.c0 + j, 0); }
      }
      for (let ri = 0; ri < reps.r; ri++) {
        for (let ci = 0; ci < reps.c; ci++) {
          rows.forEach((row, i) => row.forEach((cell, j) => {
            const rr = target.r0 + ri * rows.length + i;
            const cc = target.c0 + ci * row.length + j;
            if (rr >= MAX_ROWS || cc >= MAX_COLS) return;
            const srcR = mode === 'transpose' ? src.range.r0 + j : src.range.r0 + i;
            const srcC = mode === 'transpose' ? src.range.c0 + i : src.range.c0 + j;
            if (mode === 'formats') { book.setStyle(sheet(), rr, cc, cell ? cell.s || 0 : 0); return; }
            if (mode === 'values') {
              const v = srcSheet ? book.value(srcSheet, srcR, srcC) : cell && cell.v;
              book.setValue(sheet(), rr, cc, v instanceof Spark || (v && typeof v === 'object' && !isErr(v)) ? null : isErr(v) ? v.code : v);
              return;
            }
            if (!cell) { book.setValue(sheet(), rr, cc, null); book.setStyle(sheet(), rr, cc, 0); return; }
            if (cell.f) book.setFormula(sheet(), rr, cc, src.cut ? cell.f : shiftFormula(cell.f, rr - srcR, cc - srcC));
            else book.setValue(sheet(), rr, cc, cell.v);
            book.setStyle(sheet(), rr, cc, cell.s || 0);
            if (cell.note) book.setNote(sheet(), rr, cc, cell.note);
          }));
        }
      }
    });
    if (src.cut) { clip = null; grid.copyMark = null; }
    const h2 = rows.length * reps.r;
    const w2 = rows[0].length * reps.c;
    grid.selectRange({ r0: target.r0, c0: target.c0, r1: Math.min(MAX_ROWS - 1, target.r0 + h2 - 1), c1: Math.min(MAX_COLS - 1, target.c0 + w2 - 1) });
    charts.redraw();
    return;
  }
  // From other apps: an HTML table keeps its cells; otherwise tab-separated text.
  let rows = null;
  if (html && /<table/i.test(html)) {
    const doc = new DOMParser().parseFromString(html, 'text/html');
    const table = doc.querySelector('table');
    if (table) {
      rows = [];
      [...table.rows].forEach((tr, ri) => {
        rows[ri] = rows[ri] || [];
        let ci = 0;
        for (const td of tr.cells) {
          while (rows[ri][ci] !== undefined) ci++;
          const span = Number(td.colSpan) || 1;
          const t = td.innerText.replace(/ /g, ' ').trim();
          for (let k = 0; k < span; k++) rows[ri][ci + k] = k ? '' : t;
          ci += span;
        }
      });
    }
  }
  if (!rows) {
    if (!text) return;
    rows = parseCSV(text.replace(/\r\n?/g, '\n').replace(/\n$/, ''), text.includes('\t') ? '\t' : '\u0000');
  }
  if (rows.length * Math.max(...rows.map((x) => x.length)) > 2000000) { toast('That is too much to paste at once.', { type: 'warn' }); return; }
  book.edit('Paste', () => {
    rows.forEach((row, i) => row.forEach((t, j) => {
      const rr = r + i;
      const cc = c + j;
      if (rr >= MAX_ROWS || cc >= MAX_COLS) return;
      // Pasted text never becomes a live formula unless it was typed as one in a single cell.
      const value = rows.length * row.length > 1 && /^[=+@-]/.test(t) && !/^-?\d/.test(t) ? `'${t}` : t;
      const fmt = book.input(sheet(), rr, cc, mode === 'transpose' ? value : value);
      if (fmt) book.setStyle(sheet(), rr, cc, book.styles.with(sheet().get(rr, cc) ? sheet().get(rr, cc).s : 0, { fmt }));
    }));
  });
  grid.selectRange({ r0: r, c0: c, r1: r + rows.length - 1, c1: c + Math.max(...rows.map((x) => x.length)) - 1 });
  charts.redraw();
}

async function pasteFromMenu(mode = 'all') {
  if (mode !== 'all' && clip) { pasteData({ text: clip.text }, mode); return; }
  try {
    const items = await navigator.clipboard.read();
    let text = '';
    let html = '';
    for (const it of items) {
      if (it.types.includes('text/plain')) text = await (await it.getType('text/plain')).text();
      if (it.types.includes('text/html')) html = await (await it.getType('text/html')).text();
    }
    pasteData({ text, html }, mode);
  } catch {
    if (clip) pasteData({ text: clip.text }, mode);
    else toast('Press Ctrl+V to paste.', { type: 'warn' });
  }
}

// ---------------------------------------------------------------------------
// Fill handle: series, dates, weekdays, months, formulas
// ---------------------------------------------------------------------------
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

function seriesOf(cells, values, n, copyOnly) {
  // cells: source cells along the fill direction; returns n new { v | f, s } entries.
  const out = [];
  const nums = values.every((v) => typeof v === 'number');
  const anyFormula = cells.some((c) => c && c.f);
  const listMatch = (list, short) => {
    const idx = values.map((v) => (typeof v === 'string' ? list.findIndex((x) => (short ? x.slice(0, 3) : x).toLowerCase() === v.toLowerCase()) : -1));
    return idx.every((i) => i >= 0) ? idx : null;
  };
  let step = 1;
  if (nums && values.length >= 2) {
    // Least-squares step, like Excel's linear trend.
    const k = values.length;
    const mx = (k - 1) / 2;
    const my = values.reduce((a, b) => a + b, 0) / k;
    let sxy = 0; let sxx = 0;
    values.forEach((v, i) => { sxy += (i - mx) * (v - my); sxx += (i - mx) ** 2; });
    step = sxx ? sxy / sxx : 0;
  }
  const textNum = values.length && values.every((v) => typeof v === 'string' && /\d+$/.test(v)) ? values.map((v) => /^(.*?)(\d+)$/.exec(v)) : null;
  for (let i = 0; i < n; i++) {
    const srcIdx = i % cells.length;
    const src = cells[srcIdx];
    const s = src ? src.s : 0;
    if (anyFormula || copyOnly) { out.push({ ...src, srcIdx, s }); continue; }
    const k = values.length + i;
    if (nums) {
      out.push({ v: values.length === 1 ? values[0] + (copyOnly ? 0 : i + 1) * 1 : values[0] + step * k, s });
      continue;
    }
    let idx;
    if ((idx = listMatch(DAYS, false)) || (idx = listMatch(DAYS, true))) {
      const short = values[0].length <= 3;
      const d = (idx[idx.length - 1] + (idx.length > 1 ? idx[1] - idx[0] : 1) * (i + 1) + 70) % 7;
      out.push({ v: short ? DAYS[d].slice(0, 3) : DAYS[d], s });
      continue;
    }
    if ((idx = listMatch(MONTHS, false)) || (idx = listMatch(MONTHS, true))) {
      const short = values[0].length <= 3;
      const m = (idx[idx.length - 1] + (idx.length > 1 ? idx[1] - idx[0] : 1) * (i + 1) + 120) % 12;
      out.push({ v: short ? MONTHS[m].slice(0, 3) : MONTHS[m], s });
      continue;
    }
    if (textNum) {
      const last = textNum[textNum.length - 1];
      const d = textNum.length > 1 ? Number(textNum[1][2]) - Number(textNum[0][2]) : 1;
      const v = Number(last[2]) + d * (i + 1);
      out.push({ v: `${last[1]}${String(v).padStart(last[2].length, '0')}`, s });
      continue;
    }
    out.push({ ...src, srcIdx, s });
  }
  return out;
}

function fill({ from, to, copy }) {
  const dir = to.dir;
  const vertical = dir === 'down' || dir === 'up';
  book.edit('Fill', () => {
    const lanes = vertical ? Array.from({ length: from.c1 - from.c0 + 1 }, (_, i) => from.c0 + i) : Array.from({ length: from.r1 - from.r0 + 1 }, (_, i) => from.r0 + i);
    for (const lane of lanes) {
      const srcPos = vertical ? Array.from({ length: from.r1 - from.r0 + 1 }, (_, i) => [from.r0 + i, lane]) : Array.from({ length: from.c1 - from.c0 + 1 }, (_, i) => [lane, from.c0 + i]);
      const ordered = dir === 'up' || dir === 'left' ? [...srcPos].reverse() : srcPos;
      const cells = ordered.map(([r, c]) => sheet().get(r, c));
      const values = ordered.map(([r, c]) => (sheet().get(r, c) && !sheet().get(r, c).f ? sheet().get(r, c).v : null)).filter((v) => v !== null);
      const n = vertical ? (to.r1 - to.r0 + 1) - (from.r1 - from.r0 + 1) : (to.c1 - to.c0 + 1) - (from.c1 - from.c0 + 1);
      const items = seriesOf(cells, values.length === cells.length ? values : [], n, copy);
      items.forEach((it, i) => {
        let r; let c;
        if (dir === 'down') { r = from.r1 + 1 + i; c = lane; }
        else if (dir === 'up') { r = from.r0 - 1 - i; c = lane; }
        else if (dir === 'right') { r = lane; c = from.c1 + 1 + i; }
        else { r = lane; c = from.c0 - 1 - i; }
        if (it.f) {
          const [sr, sc] = ordered[it.srcIdx];
          book.setFormula(sheet(), r, c, shiftFormula(it.f, r - sr, c - sc));
        } else book.setValue(sheet(), r, c, it.v === undefined ? null : it.v);
        book.setStyle(sheet(), r, c, it.s || 0);
      });
    }
  });
  grid.selectRange({ r0: Math.min(from.r0, to.r0), c0: Math.min(from.c0, to.c0), r1: Math.max(from.r1, to.r1), c1: Math.max(from.c1, to.c1) });
  charts.redraw();
}

function fillDownToData() {
  // Double-clicking the fill handle fills down as far as the column beside it has data.
  const g = sel();
  const side = g.c0 > 0 ? g.c0 - 1 : g.c1 + 1;
  let r = g.r1;
  while (r + 1 < MAX_ROWS && book.value(sheet(), r + 1, side) !== null) r++;
  if (r > g.r1) fill({ from: g, to: { ...g, r1: r, dir: 'down' }, copy: false });
}

function fillCmd(dir) {
  const g = sel();
  if (dir === 'down') {
    if (g.r0 === g.r1) { if (g.r0 === 0) return; fill({ from: { ...g, r0: g.r0 - 1, r1: g.r0 - 1 }, to: { ...g, r0: g.r0 - 1, dir: 'down' }, copy: true }); }
    else fill({ from: { ...g, r1: g.r0 }, to: { ...g, dir: 'down' }, copy: true });
  } else if (g.c0 === g.c1) { if (g.c0 === 0) return; fill({ from: { ...g, c0: g.c0 - 1, c1: g.c0 - 1 }, to: { ...g, c0: g.c0 - 1, dir: 'right' }, copy: true }); }
  else fill({ from: { ...g, c1: g.c0 }, to: { ...g, dir: 'right' }, copy: true });
}

function moveCells({ from, to, copy }) {
  book.edit(copy ? 'Copy cells' : 'Move cells', () => {
    const cells = [];
    for (let r = from.r0; r <= from.r1; r++) for (let c = from.c0; c <= from.c1; c++) { const cell = sheet().get(r, c); cells.push([r - from.r0, c - from.c0, cell ? { ...cell } : null]); }
    if (!copy) for (let r = from.r0; r <= from.r1; r++) for (let c = from.c0; c <= from.c1; c++) { book.setValue(sheet(), r, c, null); book.setStyle(sheet(), r, c, 0); }
    for (const [dr, dc, cell] of cells) {
      const r = to.r0 + dr;
      const c = to.c0 + dc;
      if (!cell) { book.setValue(sheet(), r, c, null); book.setStyle(sheet(), r, c, 0); continue; }
      if (cell.f) book.setFormula(sheet(), r, c, copy ? shiftFormula(cell.f, to.r0 - from.r0, to.c0 - from.c0) : cell.f);
      else book.setValue(sheet(), r, c, cell.v);
      book.setStyle(sheet(), r, c, cell.s || 0);
    }
  });
  grid.selectRange(to);
  charts.redraw();
}

// ---------------------------------------------------------------------------
// Rows, columns, sizes
// ---------------------------------------------------------------------------
function autofit(axis, list) {
  book.edit(axis === 'col' ? 'Fit column width' : 'Fit row height', () => {
    book.touchProps(sheet());
    const u = sheet().used();
    for (const i of list) {
      if (axis === 'col') {
        let w = 30;
        for (let r = 0; r <= Math.min(u.r, 20000); r++) {
          const v = book.value(sheet(), r, i);
          if (v === null) continue;
          const st = styleAt(r, i);
          if (st.wrap) continue;
          const text = formatValue(v, st.fmt).text;
          w = Math.max(w, grid.textWidth(grid.fontOf({ ...st, size: st.size }), text) / grid.zoom + 14);
        }
        sheet().colW.set(i, Math.min(800, Math.ceil(w)));
        sheet().hiddenC.delete(i);
      } else {
        let hh = DEF_H;
        for (let c = 0; c <= Math.min(u.c, 500); c++) {
          const st = styleAt(i, c);
          const v = book.value(sheet(), i, c);
          if (v === null) continue;
          const lines = st.wrap ? Math.ceil(grid.textWidth(grid.fontOf(st), formatValue(v, st.fmt).text) / grid.zoom / Math.max(20, grid.colW(c) - 8)) : String(formatValue(v, st.fmt).text).split('\n').length;
          hh = Math.max(hh, Math.ceil(lines * (st.size || 11) * 1.6 + 6));
        }
        sheet().rowH.set(i, hh);
        sheet().hiddenR.delete(i);
      }
    }
  });
  grid.geoStamp = null;
  grid.draw();
}

function selectedLines(axis) {
  const out = new Set();
  for (const g of grid.sel.ranges) {
    const [a, b] = axis === 'col' ? [g.c0, Math.min(g.c1, g.c0 + 2000)] : [g.r0, Math.min(g.r1, g.r0 + 100000)];
    for (let i = a; i <= b; i++) out.add(i);
  }
  return [...out].sort((x, y) => x - y);
}

function insertLines(axis, after = false) {
  const g = sel();
  const at = axis === 'row' ? (after ? g.r1 + 1 : g.r0) : (after ? g.c1 + 1 : g.c0);
  const count = axis === 'row' ? g.r1 - g.r0 + 1 : g.c1 - g.c0 + 1;
  if (count > 10000) { toast('Insert fewer at once (10,000 at most).', { type: 'warn' }); return; }
  book.edit(axis === 'row' ? 'Insert rows' : 'Insert columns', () => book.insert(sheet(), axis, at, Math.min(count, 10000)));
  grid.geoStamp = null;
  grid.drawSoon();
  charts.render();
  selectionChanged();
}

function deleteLines(axis) {
  const g = sel();
  const at = axis === 'row' ? g.r0 : g.c0;
  const count = axis === 'row' ? Math.min(g.r1, Math.max(g.r0, sheet().used().r)) - g.r0 + 1 : Math.min(g.c1, Math.max(g.c0, sheet().used().c)) - g.c0 + 1;
  book.edit(axis === 'row' ? 'Delete rows' : 'Delete columns', () => book.insert(sheet(), axis, at, -count));
  grid.geoStamp = null;
  grid.drawSoon();
  charts.render();
  selectionChanged();
}

function hideLines(axis, hide) {
  book.edit(hide ? 'Hide' : 'Unhide', () => {
    book.touchProps(sheet());
    for (const i of selectedLines(axis)) {
      if (axis === 'col') { if (hide) sheet().hiddenC.add(i); else { sheet().hiddenC.delete(i); if (sheet().colW.get(i) === 0) sheet().colW.delete(i); } }
      else if (hide) sheet().hiddenR.add(i); else { sheet().hiddenR.delete(i); if (sheet().rowH.get(i) === 0) sheet().rowH.delete(i); }
    }
  });
  grid.geoStamp = null;
  grid.draw();
}

async function sizeDialog(axis) {
  const list = selectedLines(axis);
  const cur = axis === 'col' ? grid.colW(list[0]) : grid.rowH(list[0]);
  const v = await promptBox(axis === 'col' ? 'Column width' : 'Row height', { label: 'Size in pixels', value: String(cur) });
  const n = Number(v);
  if (v === null || !(n >= 0)) return;
  book.edit(axis === 'col' ? 'Column width' : 'Row height', () => {
    book.touchProps(sheet());
    for (const i of list) (axis === 'col' ? sheet().colW : sheet().rowH).set(i, Math.min(2000, Math.round(n)));
  });
  grid.geoStamp = null;
  grid.draw();
}

// ---------------------------------------------------------------------------
// Merging, freezing, borders
// ---------------------------------------------------------------------------
function merge(kind) {
  const g = sel();
  if (kind === 'unmerge') {
    book.edit('Unmerge', () => { book.touchProps(sheet()); sheet().merges = sheet().merges.filter((m) => m.r1 < g.r0 || m.r0 > g.r1 || m.c1 < g.c0 || m.c0 > g.c1); });
    grid.drawSoon();
    return;
  }
  if (g.r0 === g.r1 && g.c0 === g.c1) return;
  let lost = 0;
  for (const [r, c] of cellsIn(g, { includeEmpty: false })) if ((r !== g.r0 || c !== g.c0) && book.value(sheet(), r, c) !== null) lost++;
  const go = () => {
    book.edit('Merge', () => {
      book.touchProps(sheet());
      const areas = kind === 'across' ? Array.from({ length: g.r1 - g.r0 + 1 }, (_, i) => ({ r0: g.r0 + i, r1: g.r0 + i, c0: g.c0, c1: g.c1 })) : [g];
      for (const a of areas) {
        sheet().merges = sheet().merges.filter((m) => m.r1 < a.r0 || m.r0 > a.r1 || m.c1 < a.c0 || m.c0 > a.c1);
        sheet().merges.push({ ...a });
        for (let r = a.r0; r <= a.r1; r++) for (let c = a.c0; c <= a.c1; c++) if (r !== a.r0 || c !== a.c0) book.setValue(sheet(), r, c, null);
        if (kind === 'center') { const cell = sheet().get(a.r0, a.c0); book.setStyle(sheet(), a.r0, a.c0, book.styles.with(cell ? cell.s : 0, { align: 'center', valign: 'middle' })); }
      }
    });
    grid.selectRange(g);
  };
  if (lost) confirmBox('Merging keeps only the top-left value. The others will be cleared.', { ok: 'Merge' }).then((ok) => ok && go());
  else go();
}

function freeze(kind) {
  book.edit('Freeze panes', () => {
    book.touchProps(sheet());
    const { r, c } = active();
    if (kind === 'none') sheet().freeze = { r: 0, c: 0 };
    else if (kind === 'row') sheet().freeze = { r: grid.firstVisibleRow() + 1, c: 0 };
    else if (kind === 'col') sheet().freeze = { r: 0, c: 1 };
    else sheet().freeze = { r, c };
  });
  grid.drawSoon();
}

function borders(kind, style = 'thin', color = '') {
  const spec = `${style}${color ? ` ${color}` : ''}`;
  book.edit('Borders', () => {
    for (const g of grid.sel.ranges) {
      for (const [r, c] of cellsIn(g)) {
        const cell = sheet().get(r, c);
        const cur = book.styles.get(cell ? cell.s : 0).border || {};
        let b = { ...cur };
        const top = r === g.r0; const bottom = r === Math.min(g.r1, r); const left = c === g.c0; const right = c === g.c1;
        const lastRow = r === Math.min(g.r1, Math.max(g.r0, sheet().used().r, grid.extent.r - 1));
        switch (kind) {
          case 'all': b = { t: spec, r: spec, b: spec, l: spec }; break;
          case 'outer': if (top) b.t = spec; if (lastRow || r === g.r1) b.b = spec; if (left) b.l = spec; if (right) b.r = spec; break;
          case 'inner': if (!top) b.t = spec; if (!left) b.l = spec; break;
          case 'top': if (top) b.t = spec; break;
          case 'bottom': if (r === g.r1 || lastRow) b.b = spec; break;
          case 'left': if (left) b.l = spec; break;
          case 'right': if (right) b.r = spec; break;
          case 'double': if (r === g.r1 || lastRow) b.b = `double${color ? ` ${color}` : ''}`; break;
          case 'none': b = {}; break;
          default: break;
        }
        void bottom;
        const st = { ...book.styles.get(cell ? cell.s : 0) };
        if (Object.keys(b).length) st.border = b; else delete st.border;
        book.setStyle(sheet(), r, c, book.styles.id(st));
      }
    }
  });
  grid.drawSoon();
}

// ---------------------------------------------------------------------------
// Sorting and filtering
// ---------------------------------------------------------------------------
function sortBy(desc, col = null) {
  const g = currentRegion();
  const header = hasHeader(g);
  book.edit('Sort', () => book.sort(sheet(), g, [{ col: col ?? active().c, desc }], header));
  grid.drawSoon();
  charts.redraw();
}

async function sortDialog() {
  const g = currentRegion();
  const header = h('input', { type: 'checkbox', checked: hasHeader(g) });
  const cols = () => Array.from({ length: g.c1 - g.c0 + 1 }, (_, i) => {
    const c = g.c0 + i;
    const name = header.checked ? book.value(sheet(), g.r0, c) : null;
    return { value: String(c), label: name ? `${colName(c)}: ${name}` : `Column ${colName(c)}` };
  });
  const levels = h('div.col');
  const addLevel = (c = g.c0, desc = false) => {
    const s = select({ options: cols(), value: String(c), onChange: () => {} });
    const o = select({ options: [{ value: 'asc', label: 'A to Z / smallest first' }, { value: 'desc', label: 'Z to A / largest first' }], value: desc ? 'desc' : 'asc', onChange: () => {} });
    const x = h('button.tb', { html: icon('x', 14), 'data-tip': 'Remove level' });
    const row = h('div.row', h('span.muted', { style: { width: '70px' } }, levels.children.length ? 'then by' : 'Sort by'), s, o, x);
    x.addEventListener('click', () => row.remove());
    levels.append(row);
  };
  addLevel(active().c);
  const add = h('button.btn.small', 'Add level');
  add.addEventListener('click', () => addLevel());
  const ok = await modal({ title: `Sort ${rangeText(g)}`, body: h('div.col', { style: { minWidth: '480px' } }, h('label.check', header, 'My data has a header row'), levels, add),
    buttons: [{ label: 'Cancel', value: false }, { label: 'Sort', value: true, primary: true }] });
  if (!ok) return;
  const keys = [...levels.children].map((row) => { const [s, o] = row.querySelectorAll('select'); return { col: Number(s.value), desc: o.value === 'desc' }; });
  book.edit('Sort', () => book.sort(sheet(), g, keys, header.checked));
  grid.drawSoon();
  charts.redraw();
}

function toggleFilter() {
  book.edit('Filter', () => {
    book.touchProps(sheet());
    if (sheet().filter) {
      for (const r of sheet().filter.hidden || []) sheet().hiddenR.delete(r);
      sheet().filter = null;
    } else {
      const g = currentRegion();
      sheet().filter = { r0: g.r0, c0: g.c0, r1: Math.max(g.r1, g.r0 + 1), c1: g.c1, crit: {}, hidden: [] };
    }
  });
  grid.geoStamp = null;
  grid.drawSoon();
  refresh();
}

function applyFilter() {
  const f = sheet().filter;
  if (!f) return;
  book.touchProps(sheet());
  for (const r of f.hidden || []) sheet().hiddenR.delete(r);
  const hidden = [];
  const last = Math.min(f.r1, Math.max(f.r0, sheet().used().r));
  for (let r = f.r0 + 1; r <= last; r++) {
    for (const [c, crit] of Object.entries(f.crit || {})) {
      if (!crit) continue;
      const v = book.value(sheet(), r, Number(c));
      const text = v === null ? '' : formatValue(v, styleAt(r, Number(c)).fmt).text;
      let pass = true;
      if (crit.values) pass = crit.values.includes(text);
      if (pass && crit.cond) pass = condTest(crit.cond, v, text);
      if (!pass) { hidden.push(r); break; }
    }
  }
  for (const r of hidden) sheet().hiddenR.add(r);
  f.hidden = hidden;
  book.calc.recalc(); // SUBTOTAL and AGGREGATE leave filtered rows out
  grid.geoStamp = null;
  grid.drawSoon();
  toast(hidden.length ? `${(last - f.r0 - hidden.length).toLocaleString()} of ${(last - f.r0).toLocaleString()} rows shown` : 'Showing every row', { timeout: 1800 });
}

function condTest(cond, v, text) {
  const n = typeof v === 'number' ? v : parseNumber(text);
  const a = cond.a;
  switch (cond.op) {
    case 'contains': return text.toLowerCase().includes(String(a).toLowerCase());
    case 'notcontains': return !text.toLowerCase().includes(String(a).toLowerCase());
    case 'starts': return text.toLowerCase().startsWith(String(a).toLowerCase());
    case 'gt': return n !== null && n > Number(a);
    case 'lt': return n !== null && n < Number(a);
    case 'eq': return text.toLowerCase() === String(a).toLowerCase() || n === Number(a);
    case 'ne': return !(text.toLowerCase() === String(a).toLowerCase() || n === Number(a));
    case 'blank': return text === '';
    case 'notblank': return text !== '';
    default: return true;
  }
}

function filterPopup(hit, rc) {
  const f = sheet().filter;
  const c = hit.c;
  const last = Math.min(f.r1, Math.max(f.r0, sheet().used().r));
  const counts = new Map();
  for (let r = f.r0 + 1; r <= last; r++) {
    const v = book.value(sheet(), r, c);
    const t = v === null ? '' : formatValue(v, styleAt(r, c).fmt).text;
    counts.set(t, (counts.get(t) || 0) + 1);
  }
  const values = [...counts.keys()].sort((a, b) => cmpValues(parseNumber(a) ?? a, parseNumber(b) ?? b));
  const crit = (f.crit && f.crit[c]) || {};
  const chosen = new Set(crit.values || values);
  const search = h('input.input', { placeholder: 'Search', spellcheck: false });
  const list = h('div.filter-list');
  const all = h('input', { type: 'checkbox', checked: chosen.size === values.length });
  const render = () => {
    const q = search.value.toLowerCase();
    list.replaceChildren(...values.filter((v) => v.toLowerCase().includes(q)).slice(0, 2000).map((v) => {
      const cb = h('input', { type: 'checkbox', checked: chosen.has(v) });
      cb.addEventListener('change', () => { if (cb.checked) chosen.add(v); else chosen.delete(v); all.checked = chosen.size === values.length; });
      return h('label.check', cb, v === '' ? h('i.muted', '(empty)') : v, h('span.muted', { style: { marginLeft: 'auto' } }, String(counts.get(v))));
    }));
  };
  all.addEventListener('change', () => { if (all.checked) values.forEach((v) => chosen.add(v)); else chosen.clear(); render(); });
  search.addEventListener('input', render);
  render();
  const condOp = select({ options: [{ value: '', label: 'No condition' }, { value: 'contains', label: 'Text contains' }, { value: 'notcontains', label: 'Does not contain' }, { value: 'starts', label: 'Starts with' }, { value: 'eq', label: 'Equals' }, { value: 'ne', label: 'Is not' }, { value: 'gt', label: 'Greater than' }, { value: 'lt', label: 'Less than' }, { value: 'blank', label: 'Is empty' }, { value: 'notblank', label: 'Is not empty' }], value: crit.cond ? crit.cond.op : '', onChange: () => {} });
  const condVal = h('input.input', { value: crit.cond ? crit.cond.a ?? '' : '', placeholder: 'Value', style: { width: '120px' } });
  const done = () => {
    book.edit('Filter', () => {
      book.touchProps(sheet());
      f.crit = f.crit || {};
      const filtered = chosen.size !== values.length;
      f.crit[c] = filtered || condOp.value ? { values: filtered ? [...chosen] : null, cond: condOp.value ? { op: condOp.value, a: condVal.value } : null } : null;
      applyFilter();
    });
    closeMenus();
  };
  const ok = h('button.btn.small.primary', 'OK');
  ok.addEventListener('click', done);
  const clear = h('button.btn.small', 'Clear');
  clear.addEventListener('click', () => { chosen.clear(); values.forEach((v) => chosen.add(v)); condOp.value = ''; done(); });
  const sortBtn = (desc) => {
    const b = h('button.btn.small', { style: { justifyContent: 'flex-start' } }, h('span', { html: icon(desc ? 'sortDesc' : 'sortAsc', 14) }), desc ? 'Sort Z → A' : 'Sort A → Z');
    b.addEventListener('click', () => { closeMenus(); book.edit('Sort', () => book.sort(sheet(), { ...f, r1: last }, [{ col: c, desc }], true)); applyFilter(); grid.drawSoon(); });
    return b;
  };
  const box = h('div.col.filter-pop', sortBtn(false), sortBtn(true), h('div.menu-sep'), h('div.row', condOp, condVal), search, h('label.check', all, h('b', 'Select all')), list, h('div.row', { style: { justifyContent: 'flex-end' } }, clear, ok));
  const wr = grid.el.getBoundingClientRect();
  popover(box, { x: wr.left + rc.x, y: wr.top + rc.y + rc.h });
}

function filterByValue() {
  const { r, c } = active();
  const v = book.value(sheet(), r, c);
  const text = v === null ? '' : formatValue(v, styleAt(r, c).fmt).text;
  book.edit('Filter', () => {
    book.touchProps(sheet());
    if (!sheet().filter) { const g = currentRegion(); sheet().filter = { r0: g.r0, c0: g.c0, r1: g.r1, c1: g.c1, crit: {}, hidden: [] }; }
    sheet().filter.crit[c] = { values: [text], cond: null };
    applyFilter();
  });
}

// ---------------------------------------------------------------------------
// Data tools
// ---------------------------------------------------------------------------
async function removeDuplicates() {
  const g = currentRegion();
  const header = hasHeader(g);
  const checks = Array.from({ length: g.c1 - g.c0 + 1 }, (_, i) => {
    const c = g.c0 + i;
    const cb = h('input', { type: 'checkbox', checked: true });
    return [c, cb, h('label.check', cb, header ? String(book.value(sheet(), g.r0, c) ?? colName(c)) : `Column ${colName(c)}`)];
  });
  const ok = await modal({ title: 'Remove duplicates', body: h('div.col', h('div.muted', `Rows of ${rangeText(g)} with the same values in these columns:`), ...checks.map((x) => x[2])), buttons: [{ label: 'Cancel', value: false }, { label: 'Remove', value: true, primary: true }] });
  if (!ok) return;
  const cols = checks.filter((x) => x[1].checked).map((x) => x[0]);
  const seen = new Set();
  const keep = [];
  const start = g.r0 + (header ? 1 : 0);
  for (let r = start; r <= g.r1; r++) {
    const k = JSON.stringify(cols.map((c) => { const v = book.value(sheet(), r, c); return typeof v === 'string' ? v.toLowerCase() : v; }));
    if (seen.has(k)) continue;
    seen.add(k);
    keep.push(r);
  }
  const removed = g.r1 - start + 1 - keep.length;
  book.edit('Remove duplicates', () => {
    const rows = keep.map((r) => Array.from({ length: g.c1 - g.c0 + 1 }, (_, i) => { const cell = sheet().get(r, g.c0 + i); return cell ? { ...cell, r } : null; }));
    for (let r = start; r <= g.r1; r++) for (let c = g.c0; c <= g.c1; c++) { book.setValue(sheet(), r, c, null); book.setStyle(sheet(), r, c, 0); }
    rows.forEach((row, i) => row.forEach((cell, j) => {
      if (!cell) return;
      const r = start + i;
      const c = g.c0 + j;
      if (cell.f) book.setFormula(sheet(), r, c, shiftFormula(cell.f, r - cell.r, 0)); else book.setValue(sheet(), r, c, cell.v);
      book.setStyle(sheet(), r, c, cell.s || 0);
    }));
  });
  toast(removed ? `Removed ${removed} duplicate ${removed === 1 ? 'row' : 'rows'}; ${keep.length} left.` : 'No duplicates found.');
  grid.drawSoon();
}

async function textToColumns() {
  const g = sel();
  const delim = select({ options: [{ value: ',', label: 'Comma' }, { value: '\t', label: 'Tab' }, { value: ';', label: 'Semicolon' }, { value: ' ', label: 'Space' }, { value: '|', label: 'Bar |' }, { value: 'custom', label: 'Other…' }], value: ',', onChange: () => {} });
  const other = h('input.input', { placeholder: 'Character', style: { width: '80px' } });
  const ok = await modal({ title: 'Split text into columns', body: h('div.col', h('div.muted', `Splits the text in column ${colName(g.c0)} across the columns to its right.`), h('label.field', h('span', 'Split at'), delim), h('label.field', h('span', 'Other'), other)), buttons: [{ label: 'Cancel', value: false }, { label: 'Split', value: true, primary: true }] });
  if (!ok) return;
  const d = delim.value === 'custom' ? other.value || ',' : delim.value;
  book.edit('Text to columns', () => {
    for (const [r] of cellsIn({ ...g, c1: g.c0 })) {
      const v = book.value(sheet(), r, g.c0);
      if (typeof v !== 'string') continue;
      v.split(d).forEach((part, i) => { const fmt = book.input(sheet(), r, g.c0 + i, part.trim().startsWith('=') ? `'${part.trim()}` : part.trim()); if (fmt) book.setStyle(sheet(), r, g.c0 + i, book.styles.id({ fmt })); });
    }
  });
  grid.drawSoon();
}

function trimSpaces() {
  book.edit('Trim spaces', () => eachSelected((r, c) => {
    const cell = sheet().get(r, c);
    if (cell && typeof cell.v === 'string') { const t = cell.v.replace(/\s+/g, ' ').trim(); if (t !== cell.v) book.setValue(sheet(), r, c, t); }
  }));
  grid.drawSoon();
}

function changeCase(kind) {
  book.edit('Change case', () => eachSelected((r, c) => {
    const cell = sheet().get(r, c);
    if (!cell || typeof cell.v !== 'string') return;
    const t = kind === 'upper' ? cell.v.toUpperCase() : kind === 'lower' ? cell.v.toLowerCase() : cell.v.toLowerCase().replace(/(^|\s)(\p{L})/gu, (m, a, b) => a + b.toUpperCase());
    book.setValue(sheet(), r, c, t);
  }));
  grid.drawSoon();
}

/** Summarize (a pivot table made of live SUMIFS formulas). */
async function summarize() {
  const g = currentRegion();
  if (!hasHeader(g)) { toast('Summarize needs a block of data with a header row. Select it first.', { type: 'warn' }); return; }
  const headers = Array.from({ length: g.c1 - g.c0 + 1 }, (_, i) => ({ value: String(g.c0 + i), label: String(book.value(sheet(), g.r0, g.c0 + i)) }));
  const rowsSel = select({ options: headers, value: headers[0].value, onChange: () => {} });
  const colsSel = select({ options: [{ value: '', label: '(none)' }, ...headers], value: '', onChange: () => {} });
  const numeric = headers.find((x) => typeof book.value(sheet(), g.r0 + 1, Number(x.value)) === 'number');
  const valSel = select({ options: headers, value: (numeric || headers[headers.length - 1]).value, onChange: () => {} });
  const agg = select({ options: [{ value: 'SUM', label: 'Sum' }, { value: 'COUNT', label: 'Count' }, { value: 'AVERAGE', label: 'Average' }, { value: 'MAX', label: 'Largest' }, { value: 'MIN', label: 'Smallest' }], value: 'SUM', onChange: () => {} });
  const ok = await modal({
    title: 'Summarize data', body: h('div.col', { style: { minWidth: '420px' } }, h('div.muted', `Builds a summary of ${rangeText(g)} on a new sheet. Its numbers are formulas, so they update when the data changes.`),
      h('label.field', h('span', 'Rows'), rowsSel), h('label.field', h('span', 'Columns'), colsSel), h('label.field', h('span', 'Values'), valSel), h('label.field', h('span', 'Show'), agg)),
    buttons: [{ label: 'Cancel', value: false }, { label: 'Summarize', value: true, primary: true }],
  });
  if (!ok) return;
  const src = sheet();
  const rc = Number(rowsSel.value);
  const cc = colsSel.value === '' ? null : Number(colsSel.value);
  const vc = Number(valSel.value);
  const uniq = (c) => {
    const s = new Map();
    for (let r = g.r0 + 1; r <= g.r1; r++) { const v = book.value(src, r, c); if (v !== null && v !== '') s.set(typeof v === 'string' ? v.toLowerCase() : v, v); }
    return [...s.values()].sort(cmpValues);
  };
  const rowsVals = uniq(rc);
  const colVals = cc === null ? [null] : uniq(cc);
  const col = (c) => `${quoteSheet(src.name)}!$${colName(c)}$${g.r0 + 2}:$${colName(c)}$${g.r1 + 1}`;
  const lit = (v) => (typeof v === 'number' ? String(v) : `"${String(v).replace(/"/g, '""')}"`);
  const fn = agg.value;
  let out;
  book.edit('Summarize', () => {
    book.touchSheets();
    out = book.addSheet(`Summary of ${src.name}`.slice(0, 31), book.sheets.indexOf(src) + 1);
    const head = book.styles.id({ bold: true, fill: '#2ea043', color: '#ffffff' });
    const bold = book.styles.id({ bold: true });
    book.setValue(out, 0, 0, `${agg.selectedOptions[0].label} of ${book.value(src, g.r0, vc)} by ${book.value(src, g.r0, rc)}${cc !== null ? ` and ${book.value(src, g.r0, cc)}` : ''}`);
    book.setStyle(out, 0, 0, book.styles.id({ bold: true, size: 13 }));
    book.setValue(out, 2, 0, String(book.value(src, g.r0, rc)));
    book.setStyle(out, 2, 0, head);
    colVals.forEach((cv, j) => { book.setValue(out, 2, 1 + j, cv === null ? fn[0] + fn.slice(1).toLowerCase() : cv); book.setStyle(out, 2, 1 + j, head); });
    if (cc !== null) { book.setValue(out, 2, 1 + colVals.length, 'Total'); book.setStyle(out, 2, 1 + colVals.length, head); }
    const crit = (rv, cv) => `${col(rc)},${lit(rv)}${cv !== null ? `,${col(cc)},${lit(cv)}` : ''}`;
    const make = (rv, cv) => {
      if (fn === 'COUNT') return `COUNTIFS(${crit(rv, cv)})`;
      if (fn === 'SUM') return `SUMIFS(${col(vc)},${crit(rv, cv)})`;
      if (fn === 'AVERAGE') return `IFERROR(AVERAGEIFS(${col(vc)},${crit(rv, cv)}),"")`;
      return `${fn}IFS(${col(vc)},${crit(rv, cv)})`;
    };
    rowsVals.forEach((rv, i) => {
      const r = 3 + i;
      book.setValue(out, r, 0, rv);
      colVals.forEach((cv, j) => book.setFormula(out, r, 1 + j, make(rv, cv)));
      if (cc !== null) book.setFormula(out, r, 1 + colVals.length, `${fn === 'COUNT' || fn === 'SUM' ? 'SUM' : fn}(B${r + 1}:${colName(colVals.length)}${r + 1})`);
    });
    const tr = 3 + rowsVals.length;
    book.setValue(out, tr, 0, 'Total');
    book.setStyle(out, tr, 0, bold);
    for (let j = 1; j <= colVals.length + (cc !== null ? 1 : 0); j++) {
      book.setFormula(out, tr, j, `${fn === 'COUNT' ? 'SUM' : fn === 'AVERAGE' ? 'AVERAGE' : fn === 'SUM' ? 'SUM' : fn}(${colName(j)}4:${colName(j)}${tr})`);
      book.setStyle(out, tr, j, book.styles.id({ bold: true, border: { t: 'medium #2ea043' }, fmt: fn === 'COUNT' ? '#,##0' : '#,##0.##' }));
    }
    for (let r = 3; r < tr; r++) for (let j = 1; j <= colVals.length + 1; j++) book.setStyle(out, r, j, book.styles.id({ fmt: fn === 'COUNT' ? '#,##0' : '#,##0.##' }));
    out.colW.set(0, 160);
    out.freeze = { r: 3, c: 1 };
  });
  switchSheet(out);
}

// ---------------------------------------------------------------------------
// Conditional formatting and validation
// ---------------------------------------------------------------------------
const HL = { fill: '#fde8e8', color: '#9c0006' };
const STYLES_CF = [['Light red with dark red text', { fill: '#fde8e8', color: '#9c0006' }], ['Yellow with dark yellow text', { fill: '#fff2cc', color: '#7f6000' }], ['Green with dark green text', { fill: '#dcf5e1', color: '#1a7f37' }], ['Bold red text', { color: '#cf222e', bold: true }], ['Light blue fill', { fill: '#dbe9fb' }]];

async function cfRuleDialog(type, title, needs = 1) {
  const a = h('input.input', { placeholder: 'Value' });
  const b = h('input.input', { placeholder: 'and' });
  const style = select({ options: STYLES_CF.map(([n], i) => ({ value: String(i), label: n })), value: '0', onChange: () => {} });
  const ok = await modal({ title, body: h('div.col', { style: { minWidth: '360px' } }, needs ? h('div.row', a, needs > 1 ? b : null) : null, h('label.field', h('span', 'Show with'), style)), buttons: [{ label: 'Cancel', value: false }, { label: 'Apply', value: true, primary: true }] });
  if (!ok) return;
  const num = (v) => (parseNumber(v) ?? v);
  addCf({ type, a: num(a.value), b: num(b.value), style: STYLES_CF[Number(style.value)][1] });
}

function addCf(rule) {
  book.edit('Conditional format', () => {
    book.touchProps(sheet());
    for (const g of grid.sel.ranges) {
      const u = sheet().used();
      sheet().cf.push({ ...rule, range: { r0: g.r0, c0: g.c0, r1: Math.min(g.r1, Math.max(u.r, g.r0)), c1: Math.min(g.c1, Math.max(u.c, g.c0)) } });
    }
  });
  grid.cfCache = null;
  grid.drawSoon();
}

function clearCf(all) {
  book.edit('Clear rules', () => {
    book.touchProps(sheet());
    if (all) sheet().cf = [];
    else { const g = sel(); sheet().cf = sheet().cf.filter((x) => x.range.r1 < g.r0 || x.range.r0 > g.r1 || x.range.c1 < g.c0 || x.range.c0 > g.c1); }
  });
  grid.cfCache = null;
  grid.drawSoon();
}

function cfMenu() {
  return [
    { label: 'Highlight cells', icon: 'conditional', submenu: [
      { label: 'Greater than…', run: () => cfRuleDialog('gt', 'Highlight cells greater than') },
      { label: 'Less than…', run: () => cfRuleDialog('lt', 'Highlight cells less than') },
      { label: 'Between…', run: () => cfRuleDialog('between', 'Highlight cells between', 2) },
      { label: 'Equal to…', run: () => cfRuleDialog('eq', 'Highlight cells equal to') },
      { label: 'Text that contains…', run: () => cfRuleDialog('text', 'Highlight text that contains') },
      { label: 'Duplicate values', run: () => addCf({ type: 'dup', style: HL }) },
      { label: 'Unique values', run: () => addCf({ type: 'unique', style: { fill: '#dcf5e1', color: '#1a7f37' } }) },
      { label: 'Empty cells', run: () => addCf({ type: 'blank', style: { fill: '#fff2cc' } }) },
      { label: 'Errors', run: () => addCf({ type: 'error', style: HL }) },
    ] },
    { label: 'Top and bottom', icon: 'barChart', submenu: [
      { label: 'Top 10 items', run: () => addCf({ type: 'top', n: 10, style: { fill: '#dcf5e1', color: '#1a7f37' } }) },
      { label: 'Top 10%', run: () => addCf({ type: 'top', n: 10, percent: true, style: { fill: '#dcf5e1', color: '#1a7f37' } }) },
      { label: 'Bottom 10 items', run: () => addCf({ type: 'bottom', n: 10, style: HL }) },
      { label: 'Above average', run: () => addCf({ type: 'above', style: { fill: '#dcf5e1', color: '#1a7f37' } }) },
      { label: 'Below average', run: () => addCf({ type: 'below', style: HL }) },
    ] },
    { label: 'Data bars', icon: 'hbarChart', submenu: ['#3fb950', '#2f81f7', '#f0883e', '#a371f7', '#e5534b'].map((c) => ({ label: c, swatch: c, run: () => addCf({ type: 'bar', color: c }) })) },
    { label: 'Colour scales', icon: 'gradient', submenu: [
      ['Red – yellow – green', ['#f8696b', '#ffeb84', '#63be7b']], ['Green – yellow – red', ['#63be7b', '#ffeb84', '#f8696b']], ['White – green', ['#ffffff', '#63be7b']], ['White – blue', ['#ffffff', '#5a8ac6']], ['Blue – white – red', ['#5a8ac6', '#ffffff', '#f8696b']],
    ].map(([n, colors]) => ({ label: n, run: () => addCf({ type: 'scale', colors }) })) },
    { type: 'separator' },
    { label: 'Clear rules from selection', run: () => clearCf(false) },
    { label: 'Clear rules from the sheet', run: () => clearCf(true) },
    { label: 'Manage rules…', run: () => manageCf() },
  ];
}

function manageCf() {
  const list = h('div.col');
  const render = () => {
    list.replaceChildren();
    if (!sheet().cf.length) list.append(h('div.empty', 'This sheet has no rules.'));
    sheet().cf.forEach((rule, i) => {
      const x = h('button.tb', { html: icon('trash', 14), 'data-tip': 'Delete rule' });
      x.addEventListener('click', () => { book.edit('Delete rule', () => { book.touchProps(sheet()); sheet().cf.splice(i, 1); }); grid.cfCache = null; grid.drawSoon(); render(); });
      const desc = { gt: `Greater than ${rule.a}`, lt: `Less than ${rule.a}`, between: `Between ${rule.a} and ${rule.b}`, eq: `Equal to ${rule.a}`, ne: `Not equal to ${rule.a}`, ge: `${rule.a} or more`, le: `${rule.a} or less`, nb: `Not between ${rule.a} and ${rule.b}`, raw: 'Excel rule (kept as it is)', text: `Contains “${rule.a}”`, dup: 'Duplicates', unique: 'Unique values', blank: 'Empty', error: 'Errors', top: `Top ${rule.n}${rule.percent ? '%' : ''}`, bottom: `Bottom ${rule.n}`, above: 'Above average', below: 'Below average', scale: 'Colour scale', bar: 'Data bars' }[rule.type] || rule.type;
      list.append(h('div.row.list-item', h('span', { style: { width: '14px', height: '14px', borderRadius: '3px', background: rule.style ? rule.style.fill || rule.style.color : rule.color || (rule.colors || ['#888'])[0] } }), h('span.grow', desc), h('span.muted', rangeText(rule.range)), x));
    });
  };
  render();
  modal({ title: 'Conditional formatting rules', body: h('div', { style: { minWidth: '460px' } }, list), buttons: [{ label: 'Close', value: true, primary: true }] });
}

function listOptions(v) {
  if (v.list) return v.list.map((x) => x.trim());
  if (v.source) {
    const m = /^=?(?:'?([^'!]+)'?!)?(.+)$/.exec(v.source);
    const src = m && m[1] ? book.sheet(m[1]) : sheet();
    const g = m && parseRange(m[2].replace(/\$/g, ''));
    if (src && g) {
      const out = [];
      for (let r = g.r0; r <= Math.min(g.r1, g.r0 + 1000); r++) for (let c = g.c0; c <= g.c1; c++) { const val = book.value(src, r, c); if (val !== null && val !== '') out.push(String(val)); }
      return out;
    }
  }
  return [];
}

async function validationDialog() {
  const g = sel();
  const cur = grid.validationAt(g.r0, g.c0);
  const kind = select({ options: [{ value: 'list', label: 'A list of choices' }, { value: 'number', label: 'A number between' }, { value: 'none', label: 'Anything (remove the rule)' }], value: cur ? cur.type : 'list', onChange: (v) => { listRow.classList.toggle('hidden', v !== 'list'); numRow.classList.toggle('hidden', v !== 'number'); } });
  const list = h('input.input', { value: cur && cur.list ? cur.list.join(', ') : cur && cur.source ? cur.source : '', placeholder: 'Yes, No, Maybe   or   =A1:A10', style: { width: '100%' } });
  const min = h('input.input.num', { type: 'number', value: cur && cur.min !== undefined ? cur.min : '' });
  const max = h('input.input.num', { type: 'number', value: cur && cur.max !== undefined ? cur.max : '' });
  const listRow = h('label.field', h('span', 'Choices'), list);
  const numRow = h('div.field', h('span', 'Between'), h('div.row', min, 'and', max));
  if (kind.value !== 'list') listRow.classList.add('hidden');
  if (kind.value !== 'number') numRow.classList.add('hidden');
  const ok = await modal({ title: 'Allowed values', body: h('div.col', { style: { minWidth: '460px' } }, h('label.field', h('span', 'Allow'), kind), listRow, numRow), buttons: [{ label: 'Cancel', value: false }, { label: 'Apply', value: true, primary: true }] });
  if (!ok) return;
  book.edit('Allowed values', () => {
    book.touchProps(sheet());
    for (const sg of grid.sel.ranges) {
      sheet().valid = sheet().valid.filter((v) => v.range.r1 < sg.r0 || v.range.r0 > sg.r1 || v.range.c1 < sg.c0 || v.range.c0 > sg.c1);
      const range = { ...sg, r1: Math.min(sg.r1, sg.r0 + 100000) };
      if (kind.value === 'list') {
        const t = list.value.trim();
        sheet().valid.push(t.startsWith('=') || parseRange(t.replace(/\$/g, '').replace(/^.*!/, '')) ? { range, type: 'list', source: t } : { range, type: 'list', list: t.split(',').map((x) => x.trim()).filter(Boolean) });
      } else if (kind.value === 'number') sheet().valid.push({ range, type: 'number', min: min.value === '' ? undefined : Number(min.value), max: max.value === '' ? undefined : Number(max.value) });
    }
  });
  grid.drawSoon();
}

function pick(kind, hit, rc) {
  if (kind === 'filter') { filterPopup(hit, rc); return; }
  const v = grid.validationAt(hit.r, hit.c);
  const wr = grid.el.getBoundingClientRect();
  const options = listOptions(v);
  showMenu([...options.map((o) => ({ label: o, checked: String(book.value(sheet(), hit.r, hit.c) ?? '') === o, run: () => commitText(o, { sheet: sheet(), r: hit.r, c: hit.c, targets: [{ r0: hit.r, c0: hit.c, r1: hit.r, c1: hit.c }] }) })),
    { type: 'separator' }, { label: 'Clear', run: () => commitText('', { sheet: sheet(), r: hit.r, c: hit.c, targets: [{ r0: hit.r, c0: hit.c, r1: hit.r, c1: hit.c }] }) }], { x: wr.left + rc.x, y: wr.top + rc.y + rc.h });
}

// ---------------------------------------------------------------------------
// Charts: floating over the grid, live with the data
// ---------------------------------------------------------------------------
const charts = (() => {
  const boxes = new Map();
  let selected = null;
  const dataOf = (ch) => {
    // A chart from an Excel file names its own cells, perhaps on other sheets.
    if (ch.refs) {
      const valuesOf = (ref) => {
        const p = splitRef(ref);
        if (!p) return [];
        const sh = p.sheet ? book.sheets.find((x) => x.name === p.sheet) : sheet();
        if (!sh) return [];
        const out = [];
        for (let r = p.g.r0; r <= Math.min(p.g.r1, p.g.r0 + 5000); r++) for (let c = p.g.c0; c <= Math.min(p.g.c1, p.g.c0 + 200); c++) { if (!sh.hiddenR.has(r)) out.push(book.value(sh, r, c)); }
        return out;
      };
      const cats = ch.refs.cats ? valuesOf(ch.refs.cats).map((v) => (v === null || v === undefined ? '' : String(typeof v === 'object' ? v.text ?? '' : v))) : null;
      const series = ch.refs.series.map((x, i) => {
        const values = valuesOf(x.values).map((v) => (typeof v === 'number' ? v : Number.isFinite(Number(v)) && v !== '' && v !== null ? Number(v) : null));
        const name = x.nameRef ? String(valuesOf(x.nameRef)[0] ?? x.name ?? '') : x.name || `Series ${i + 1}`;
        return { name, values };
      });
      return { categories: cats || (series[0] ? series[0].values.map((_, i) => String(i + 1)) : []), series };
    }
    const g = parseRange(ch.range);
    if (!g) return { categories: [], series: [] };
    const sh = ch.sheet ? book.sheet(ch.sheet) || sheet() : sheet();
    const rows = [];
    for (let r = g.r0; r <= Math.min(g.r1, g.r0 + 5000); r++) {
      const row = [];
      for (let c = g.c0; c <= Math.min(g.c1, g.c0 + 50); c++) { if (sh.hiddenR.has(r)) continue; const v = book.value(sh, r, c); row.push(v instanceof Spark || isErr(v) ? null : v); }
      if (row.length) rows.push(row);
    }
    if (ch.range2) {
      const g2 = parseRange(ch.range2);
      const vals = [];
      for (let r = g2.r0; r <= g2.r1; r++) for (let c = g2.c0; c <= g2.c1; c++) vals.push(book.value(sh, r, c));
      return { categories: rows.flat().map(String), series: [{ name: ch.title || 'Values', values: vals.map((v) => (typeof v === 'number' ? v : null)) }] };
    }
    return seriesFromGrid(rows, !ch.byRows);
  };
  const draw = (ch, box) => {
    const z = grid.zoom;
    box.style.left = `${grid.headW + ch.x * z}px`;
    box.style.top = `${24 * z + ch.y * z}px`;
    box.style.width = `${ch.w * z}px`;
    box.style.height = `${ch.h * z}px`;
    const data = dataOf(ch);
    box.hit = drawChart(box.canvas, { ...ch, ...data, theme: document.documentElement.dataset.theme === 'light' || settings.get('lightCells', false) ? 'light' : 'dark' }, { width: ch.w * z, height: ch.h * z });
  };
  const render = () => {
    for (const [, b] of boxes) b.remove();
    boxes.clear();
    for (const ch of sheet().charts) {
      const canvas = h('canvas');
      const tools = h('div.chart-tools',
        tb({ icon: 'settings', tip: 'Edit chart', run: () => editChart(ch) }),
        tb({ icon: 'trash', tip: 'Delete chart', run: () => removeChart(ch) }));
      const handle = h('span.chart-resize');
      const tipEl = h('div.chart-tip.hidden');
      const box = h('div.chart-box', canvas, tools, handle, tipEl);
      box.canvas = canvas;
      box.addEventListener('pointerdown', (e) => {
        if (e.target.closest('.chart-tools')) return;
        selectChart(ch, box);
        if (e.target === handle) {
          const w0 = ch.w; const h0 = ch.h;
          book.begin('Resize chart'); book.touchProps(sheet());
          drag(e, (dx, dy) => { ch.w = Math.max(160, w0 + dx / grid.zoom); ch.h = Math.max(110, h0 + dy / grid.zoom); draw(ch, box); }, () => book.commit());
          return;
        }
        const x0 = ch.x; const y0 = ch.y;
        book.begin('Move chart'); book.touchProps(sheet());
        drag(e, (dx, dy) => { ch.x = Math.max(0, x0 + dx / grid.zoom); ch.y = Math.max(0, y0 + dy / grid.zoom); draw(ch, box); }, () => book.commit());
      });
      box.addEventListener('dblclick', () => editChart(ch));
      box.addEventListener('contextmenu', (e) => {
        e.preventDefault(); e.stopPropagation();
        selectChart(ch, box);
        showMenu([{ label: 'Edit chart…', icon: 'settings', run: () => editChart(ch) }, { label: 'Change type', icon: 'chart', submenu: CHART_TYPES.map(([t, n]) => ({ label: n, checked: ch.type === t, run: () => { book.edit('Chart type', () => { book.touchProps(sheet()); ch.type = t; }); render(); } })) },
          { label: 'Select its data', icon: 'table', run: () => { const g = parseRange(ch.range); if (g) grid.selectRange(g); } },
          { label: 'Save as picture…', icon: 'image', run: () => chartPng(box, ch) }, { type: 'separator' }, { label: 'Delete chart', icon: 'trash', danger: true, run: () => removeChart(ch) }], { x: e.clientX, y: e.clientY });
      });
      canvas.addEventListener('mousemove', (e) => {
        const r = canvas.getBoundingClientRect();
        const t = box.hit && box.hit(e.clientX - r.left, e.clientY - r.top);
        if (!t) { tipEl.classList.add('hidden'); return; }
        tipEl.textContent = `${t.series ? `${t.series} · ` : ''}${t.label}: ${typeof t.value === 'number' ? t.value.toLocaleString() : t.value}${t.pct !== undefined ? ` (${Math.round(t.pct * 100)}%)` : ''}`;
        tipEl.classList.remove('hidden');
        tipEl.style.left = `${e.clientX - r.left + 12}px`;
        tipEl.style.top = `${e.clientY - r.top + 8}px`;
      });
      canvas.addEventListener('mouseleave', () => tipEl.classList.add('hidden'));
      grid.layer.append(box);
      boxes.set(ch, box);
      draw(ch, box);
    }
  };
  const selectChart = (ch, box) => {
    selected = ch;
    for (const b of boxes.values()) b.classList.toggle('on', b === box);
  };
  document.addEventListener('pointerdown', (e) => { if (!(e.target.closest && e.target.closest('.chart-box'))) { selected = null; for (const b of boxes.values()) b.classList.remove('on'); } }, true);
  window.addEventListener('keydown', (e) => { if (selected && (e.key === 'Delete' || e.key === 'Backspace') && !grid.editing) { e.preventDefault(); removeChart(selected); } }, true);
  const redraw = debounce(() => { for (const [ch, box] of boxes) if (sheet().charts.includes(ch)) draw(ch, box); else render(); }, 120);
  window.addEventListener('snake-theme', () => redraw());
  return { render, redraw, get selected() { return selected; } };
})();

function insertChart(type = 'column') {
  const g = currentRegion();
  if (g.r0 === g.r1 && g.c0 === g.c1 && book.value(sheet(), g.r0, g.c0) === null) { toast('Select the data for the chart first (with its labels).', { type: 'warn' }); return; }
  const z = grid.zoom;
  const x = (grid.colX(g.c1 + 1) + 20);
  const y = Math.max(10, grid.rowY(g.r0));
  const ch = { id: uid('ch'), type, range: rangeText(g), title: '', x, y, w: 480, h: 300 };
  const header = hasHeader(g);
  if (header && g.c1 > g.c0) ch.title = String(book.value(sheet(), g.r0, g.c0 + 1) ?? '');
  void z;
  book.edit('Insert chart', () => { book.touchProps(sheet()); sheet().charts.push(ch); });
  charts.render();
}

function removeChart(ch) {
  book.edit('Delete chart', () => { book.touchProps(sheet()); sheet().charts = sheet().charts.filter((x) => x !== ch); });
  charts.render();
}

async function editChart(ch) {
  const type = select({ options: CHART_TYPES.map(([v, l]) => ({ value: v, label: l })), value: ch.type, onChange: () => {} });
  const title = h('input.input', { value: ch.title || '', placeholder: 'Chart title' });
  const range = h('input.input', { value: ch.range, spellcheck: false });
  const legend = select({ options: [{ value: 'bottom', label: 'Below' }, { value: 'right', label: 'Right' }, { value: 'none', label: 'Hidden' }], value: ch.legend || 'bottom', onChange: () => {} });
  const byRows = h('input', { type: 'checkbox', checked: !!ch.byRows });
  const labels = h('input', { type: 'checkbox', checked: !!ch.dataLabels });
  const smooth = h('input', { type: 'checkbox', checked: !!ch.smooth });
  const xt = h('input.input', { value: ch.xTitle || '', placeholder: 'Horizontal axis title' });
  const yt = h('input.input', { value: ch.yTitle || '', placeholder: 'Vertical axis title' });
  const preview = h('canvas', { style: { width: '100%', height: '240px', borderRadius: '6px', border: '1px solid var(--border2)' } });
  const spec = () => ({ ...ch, type: type.value, title: title.value, range: range.value, legend: legend.value, byRows: byRows.checked, dataLabels: labels.checked, smooth: smooth.checked, xTitle: xt.value, yTitle: yt.value });
  const upd = () => {
    const s = spec();
    const g = parseRange(s.range);
    if (!g) return;
    const rows = [];
    for (let r = g.r0; r <= Math.min(g.r1, g.r0 + 2000); r++) { const row = []; for (let c = g.c0; c <= g.c1; c++) row.push(book.value(sheet(), r, c)); rows.push(row); }
    drawChart(preview, { ...s, ...seriesFromGrid(rows, !s.byRows), theme: 'light' }, { width: preview.clientWidth || 440, height: 240 });
  };
  const body = h('div.col', { style: { width: '520px' } }, preview,
    h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' } }, type, legend, title, range, xt, yt),
    h('div.row', h('label.check', byRows, 'Series in rows'), h('label.check', labels, 'Show values'), h('label.check', smooth, 'Smooth lines')));
  for (const el of [type, title, range, legend, byRows, labels, smooth, xt, yt]) { el.addEventListener('input', upd); el.addEventListener('change', upd); }
  const ok = await modal({ title: 'Chart', body, onOpen: () => setTimeout(upd, 30), buttons: [{ label: 'Cancel', value: false }, { label: 'Apply', value: true, primary: true }] });
  if (!ok) return;
  book.edit('Edit chart', () => { book.touchProps(sheet()); Object.assign(sheet().charts.find((x) => x.id === ch.id) || ch, spec()); });
  charts.render();
}

async function chartPng(box, ch) {
  const blob = await new Promise((res) => box.canvas.toBlob(res, 'image/png'));
  const data = new Uint8Array(await blob.arrayBuffer());
  const f = await host.saveAs({ name: `${ch.title || 'Chart'}.png`, filters: [{ name: 'PNG picture', exts: ['png'] }] }, data);
  if (f) toast(`Saved ${f.name}`);
}

// ---------------------------------------------------------------------------
// Dialogs: format cells, functions, find, go to, names
// ---------------------------------------------------------------------------
async function formatDialog(tab = 'number') {
  const { r, c } = active();
  const st = styleAt(r, c);
  const v = book.value(sheet(), r, c);
  const sample = typeof v === 'number' ? v : 1234.5678;
  const code = h('input.input', { value: st.fmt || 'General', spellcheck: false, style: { width: '100%', fontFamily: 'var(--mono)' } });
  const preview = h('div.fmt-preview');
  const list = h('div.fmt-list');
  for (const f of FORMATS) {
    const row = h('div.list-item', h('span.grow', f.name), h('span.muted', formatValue(sample, f.code).text));
    row.addEventListener('click', () => { code.value = f.code; upd(); for (const x of list.children) x.classList.remove('on'); row.classList.add('on'); });
    if (f.code === (st.fmt || 'General')) row.classList.add('on');
    list.append(row);
  }
  const upd = () => { const res = formatValue(sample, code.value); preview.textContent = res.text; preview.style.color = res.color || ''; };
  code.addEventListener('input', upd);
  upd();
  const align = select({ options: [{ value: '', label: 'Automatic' }, { value: 'left', label: 'Left' }, { value: 'center', label: 'Centre' }, { value: 'right', label: 'Right' }], value: st.align || '', onChange: () => {} });
  const valign = select({ options: [{ value: '', label: 'Bottom' }, { value: 'middle', label: 'Middle' }, { value: 'top', label: 'Top' }], value: st.valign || '', onChange: () => {} });
  const wrap = h('input', { type: 'checkbox', checked: !!st.wrap });
  const indent = h('input.input.num', { type: 'number', min: 0, max: 15, value: st.indent || 0 });
  const tabsEl = h('div.tabs');
  const pages = {
    number: h('div.col', h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' } }, list, h('div.col', h('span.muted', 'Preview'), preview, h('span.muted', 'Format code'), code,
      h('div.muted', { style: { fontSize: '12px' } }, '0 = digit, # = optional digit, , = thousands, % = percent, "text", [Red] colour, ; separates positive;negative;zero;text. Dates: yyyy mm dd hh mm ss AM/PM.')))),
    alignment: h('div.col', h('label.field', h('span', 'Horizontal'), align), h('label.field', h('span', 'Vertical'), valign), h('label.field', h('span', 'Indent'), indent), h('label.check', wrap, 'Wrap text onto several lines')),
  };
  const body = h('div.col', { style: { width: '620px' } }, tabsEl, pages.number, pages.alignment);
  for (const [id, label] of [['number', 'Number'], ['alignment', 'Alignment']]) {
    const b = h('button', label);
    b.addEventListener('click', () => { for (const x of tabsEl.children) x.classList.remove('on'); b.classList.add('on'); for (const [k, p] of Object.entries(pages)) p.classList.toggle('hidden', k !== id); });
    if (id === tab) b.classList.add('on'); else pages[id].classList.add('hidden');
    tabsEl.append(b);
  }
  const ok = await modal({ title: 'Format cells', body, buttons: [{ label: 'Cancel', value: false }, { label: 'Apply', value: true, primary: true }] });
  if (!ok) return;
  applyStyle({ fmt: /^general$/i.test(code.value) ? undefined : code.value, align: align.value || undefined, valign: valign.value || undefined, wrap: wrap.checked || undefined, indent: Number(indent.value) || undefined }, 'Format cells');
}

const CATS = {
  Math: ['SUM', 'SUMIF', 'SUMIFS', 'SUMPRODUCT', 'PRODUCT', 'ROUND', 'ROUNDUP', 'ROUNDDOWN', 'INT', 'MOD', 'ABS', 'SQRT', 'POWER', 'RAND', 'RANDBETWEEN', 'SEQUENCE'],
  Statistics: ['AVERAGE', 'AVERAGEIF', 'AVERAGEIFS', 'COUNT', 'COUNTA', 'COUNTIF', 'COUNTIFS', 'COUNTBLANK', 'MAX', 'MIN', 'MAXIFS', 'MINIFS', 'MEDIAN', 'MODE', 'STDEV', 'LARGE', 'SMALL', 'RANK', 'PERCENTILE', 'CORREL', 'FORECAST'],
  Logic: ['IF', 'IFS', 'IFERROR', 'IFNA', 'AND', 'OR', 'NOT', 'XOR', 'SWITCH', 'CHOOSE', 'LET'],
  Text: ['CONCAT', 'TEXTJOIN', 'LEFT', 'RIGHT', 'MID', 'LEN', 'UPPER', 'LOWER', 'PROPER', 'TRIM', 'SUBSTITUTE', 'REPLACE', 'FIND', 'SEARCH', 'TEXT', 'VALUE', 'TEXTBEFORE', 'TEXTAFTER', 'TEXTSPLIT'],
  Lookup: ['XLOOKUP', 'VLOOKUP', 'HLOOKUP', 'INDEX', 'MATCH', 'XMATCH', 'FILTER', 'SORT', 'SORTBY', 'UNIQUE', 'TRANSPOSE', 'OFFSET', 'INDIRECT', 'ROW', 'COLUMN', 'ROWS', 'COLUMNS'],
  Dates: ['TODAY', 'NOW', 'DATE', 'TIME', 'YEAR', 'MONTH', 'DAY', 'WEEKDAY', 'WEEKNUM', 'EDATE', 'EOMONTH', 'DATEDIF', 'DAYS', 'NETWORKDAYS', 'WORKDAY'],
  Money: ['PMT', 'IPMT', 'PPMT', 'FV', 'PV', 'NPER', 'RATE', 'NPV', 'IRR', 'SLN', 'EFFECT'],
  "Snake's": ['SPARKLINE', 'PROGRESS', 'SHEETNAME'],
};

async function functionDialog() {
  const search = h('input.input', { placeholder: 'Search functions', spellcheck: false });
  const list = h('div.fn-list');
  const info = h('div.fn-info');
  let chosen = 'SUM';
  const show = (n) => { chosen = n; info.replaceChildren(h('div', { style: { fontFamily: 'var(--mono)', fontWeight: 600 } }, `${n}(${FN[n].args || ''})`), h('div.muted', FN[n].desc || '')); };
  const render = () => {
    const q = search.value.trim().toUpperCase();
    list.replaceChildren();
    const groups = q ? { Results: FN_NAMES.filter((n) => n.includes(q) || (FN[n].desc || '').toUpperCase().includes(q)) } : CATS;
    for (const [cat, names] of Object.entries(groups)) {
      list.append(h('div.menu-head', cat));
      for (const n of names) {
        if (!FN[n]) continue;
        const row = h('div.list-item', h('b', { style: { fontFamily: 'var(--mono)', fontSize: '12px', minWidth: '120px' } }, n), h('span.muted', { style: { fontSize: '12px' } }, FN[n].desc || ''));
        row.addEventListener('click', () => { for (const x of list.querySelectorAll('.on')) x.classList.remove('on'); row.classList.add('on'); show(n); });
        row.addEventListener('dblclick', () => { show(n); document.querySelector('.dialog .btn.primary').click(); });
        list.append(row);
      }
    }
  };
  search.addEventListener('input', render);
  render();
  show(chosen);
  const ok = await modal({ title: 'Insert function', body: h('div.col', { style: { width: '600px' } }, search, list, info, h('div.muted', { style: { fontSize: '12px' } }, `${FN_NAMES.length} functions. Tip: type = and the first letters of a name in a cell to get suggestions.`)), buttons: [{ label: 'Cancel', value: false }, { label: 'Insert', value: true, primary: true }] });
  if (!ok) return;
  const cur = grid.editing ? grid.input.value : '';
  if (!grid.editing) grid.startEdit(`=${chosen}(`, 'enter');
  else {
    const pos = grid.input.selectionStart;
    grid.input.value = `${cur.slice(0, pos)}${cur.startsWith('=') ? '' : '='}${chosen}(${cur.slice(pos)}`;
    const p = pos + chosen.length + (cur.startsWith('=') ? 1 : 2);
    grid.input.setSelectionRange(p, p);
    grid.updateRefs();
  }
  grid.input.focus();
  grid.placeHint();
}

function autosum(fn = 'SUM') {
  const g = sel();
  if (g.r0 !== g.r1 || g.c0 !== g.c1) {
    // A selection of numbers: totals go in the row below.
    book.edit('AutoSum', () => {
      for (let c = g.c0; c <= Math.min(g.c1, g.c0 + 500); c++) book.setFormula(sheet(), g.r1 + 1, c, `${fn}(${colName(c)}${g.r0 + 1}:${colName(c)}${g.r1 + 1})`);
    });
    grid.drawSoon();
    return;
  }
  const { r, c } = active();
  let r0 = r - 1;
  while (r0 >= 0 && typeof book.value(sheet(), r0, c) === 'number') r0--;
  let ref;
  if (r0 < r - 1) ref = `${colName(c)}${r0 + 2}:${colName(c)}${r}`;
  else {
    let c0 = c - 1;
    while (c0 >= 0 && typeof book.value(sheet(), r, c0) === 'number') c0--;
    ref = c0 < c - 1 ? `${colName(c0 + 1)}${r + 1}:${colName(c - 1)}${r + 1}` : '';
  }
  grid.startEdit(`=${fn}(${ref})`, 'enter');
  if (ref) grid.pointSpan = { s: fn.length + 2, e: fn.length + 2 + ref.length, g: parseRange(ref) };
}

async function findDialog(replace = false) {
  const what = h('input.input', { placeholder: 'Find', spellcheck: false });
  const withEl = h('input.input', { placeholder: 'Replace with', spellcheck: false });
  const caseEl = h('input', { type: 'checkbox' });
  const whole = h('input', { type: 'checkbox' });
  const formulas = h('input', { type: 'checkbox' });
  const everywhere = h('input', { type: 'checkbox' });
  const results = h('div.find-results');
  const status = h('div.muted');
  let found = [];
  let idx = -1;
  const search = () => {
    found = [];
    const q = caseEl.checked ? what.value : what.value.toLowerCase();
    if (!q) { status.textContent = ''; results.replaceChildren(); return; }
    for (const sh of everywhere.checked ? book.sheets : [sheet()]) {
      for (const [k, cell] of sh.cells) {
        const r = rowOf(k); const c = colOf(k);
        let t = formulas.checked && cell.f ? `=${cell.f}` : formatValue(book.value(sh, r, c), book.styles.get(cell.s).fmt).text;
        if (!caseEl.checked) t = t.toLowerCase();
        if (whole.checked ? t === q : t.includes(q)) found.push({ sh, r, c });
      }
    }
    found.sort((a, b) => book.sheets.indexOf(a.sh) - book.sheets.indexOf(b.sh) || a.r - b.r || a.c - b.c);
    status.textContent = found.length ? `${found.length.toLocaleString()} found` : 'Nothing found';
    results.replaceChildren(...found.slice(0, 300).map((f, i) => {
      const row = h('div.list-item', h('span.muted', { style: { width: '120px' } }, `${f.sh.name}!${colName(f.c)}${f.r + 1}`), h('span', String(formatValue(book.value(f.sh, f.r, f.c), styleAt(f.r, f.c).fmt).text).slice(0, 80)));
      row.addEventListener('click', () => go(i));
      return row;
    }));
  };
  const go = (i) => {
    if (!found.length) return;
    idx = (i + found.length) % found.length;
    const f = found[idx];
    if (f.sh !== sheet()) switchSheet(f.sh);
    grid.selectRange({ r0: f.r, c0: f.c, r1: f.r, c1: f.c });
    status.textContent = `${idx + 1} of ${found.length}`;
  };
  const replaceOne = () => {
    const f = found[idx];
    if (!f) { go(0); return; }
    replaceIn(f);
    search();
    go(idx);
  };
  const replaceIn = (f) => {
    const cell = f.sh.get(f.r, f.c);
    if (!cell) return;
    const src = cell.f ? `=${cell.f}` : String(cell.v ?? '');
    const re = new RegExp(what.value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), caseEl.checked ? 'g' : 'gi');
    const next = whole.checked ? withEl.value : src.replace(re, withEl.value);
    if (next !== src) book.input(f.sh, f.r, f.c, next);
  };
  const replaceAll = () => {
    book.edit('Replace all', () => { for (const f of found) replaceIn(f); });
    toast(`Replaced in ${found.length} ${found.length === 1 ? 'cell' : 'cells'}`);
    search();
    grid.drawSoon();
  };
  for (const el of [what, caseEl, whole, formulas, everywhere]) { el.addEventListener('input', search); el.addEventListener('change', search); }
  what.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); go(idx + (e.shiftKey ? -1 : 1)); } });
  const repRow = h('div.row', withEl, h('button.btn.small', { onclick: replaceOne }, 'Replace'), h('button.btn.small', { onclick: replaceAll }, 'Replace all'));
  if (!replace) repRow.classList.add('hidden');
  const toggle = h('button.btn.small', replace ? 'Hide replace' : 'Replace…');
  toggle.addEventListener('click', () => { repRow.classList.toggle('hidden'); toggle.textContent = repRow.classList.contains('hidden') ? 'Replace…' : 'Hide replace'; });
  const g = grid.range;
  const v = book.value(sheet(), g.r0, g.c0);
  if (typeof v === 'string' && v.length < 60) what.value = v;
  setTimeout(search, 0);
  modal({ title: 'Find', body: h('div.col', { style: { width: '520px' } }, h('div.row', what, h('button.btn.small', { onclick: () => go(idx - 1) }, 'Previous'), h('button.btn.small.primary', { onclick: () => go(idx + 1) }, 'Next')), repRow,
    h('div.row', { style: { flexWrap: 'wrap' } }, h('label.check', caseEl, 'Match case'), h('label.check', whole, 'Whole cell'), h('label.check', formulas, 'Search formulas'), h('label.check', everywhere, 'All sheets'), toggle), status, results), buttons: [] });
}

async function gotoDialog() {
  const v = await promptBox('Go to', { label: 'A cell (B12), a range (A1:D20), Sheet2!A1 or a name', placeholder: 'A1' });
  if (!v) return;
  nameBox.value = v;
  nameBox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
}

async function namesDialog() {
  const list = h('div.col');
  const render = () => {
    list.replaceChildren();
    if (!book.names.size) list.append(h('div.empty', 'No names yet. Select cells, type a name in the name box and press Enter.'));
    for (const [k, n] of book.names) {
      const del = h('button.tb', { html: icon('trash', 14), 'data-tip': 'Delete name' });
      del.addEventListener('click', () => { book.edit('Delete name', () => { book.touchNames(); book.names.delete(k); book.calc.rebuild(); }); render(); grid.drawSoon(); });
      const go = h('button.tb', { html: icon('external', 14), 'data-tip': 'Go to' });
      go.addEventListener('click', () => { closeMenus(); nameBox.value = n.name; nameBox.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' })); });
      list.append(h('div.row.list-item', h('b.grow', n.name), h('span.muted.mono', n.ref), go, del));
    }
  };
  render();
  const add = h('button.btn.small', 'New name for the selection…');
  add.addEventListener('click', async () => {
    const n = await promptBox('New name', { label: `Refers to ${sheet().name}!${absRef(sel())}`, validate: (v) => (/^[A-Za-z_][\w.]*$/.test(v) && !parseAddr(v) ? '' : 'Use letters, digits, _ and . (not a cell address).') });
    if (n) { book.edit('Define name', () => book.defineName(n, `${quoteSheet(sheet().name)}!${absRef(sel())}`)); render(); }
  });
  modal({ title: 'Names', body: h('div.col', { style: { minWidth: '480px' } }, list, add), buttons: [{ label: 'Close', value: true, primary: true }] });
}

async function noteDialog() {
  const { r, c } = active();
  const cell = sheet().get(r, c);
  const v = await promptBox(`Note on ${colName(c)}${r + 1}`, { value: (cell && cell.note) || '', multiline: true, ok: 'Save' });
  if (v === null) return;
  book.edit('Note', () => book.setNote(sheet(), r, c, v.trim() || null));
  grid.drawSoon();
}

async function linkDialog() {
  const { r, c } = active();
  const url = h('input.input', { placeholder: 'https://example.com', spellcheck: false });
  const text = h('input.input', { placeholder: 'Text to show', value: String(book.value(sheet(), r, c) ?? '') });
  const ok = await modal({ title: 'Link', body: h('div.col', { style: { minWidth: '400px' } }, h('label.field', h('span', 'Address'), url), h('label.field', h('span', 'Text'), text)), buttons: [{ label: 'Cancel', value: false }, { label: 'Insert', value: true, primary: true }] });
  if (!ok || !url.value.trim()) return;
  const u = /^(https?:|mailto:)/i.test(url.value.trim()) ? url.value.trim() : `https://${url.value.trim()}`;
  commitText(`=HYPERLINK("${u.replace(/"/g, '""')}","${(text.value || u).replace(/"/g, '""')}")`, { sheet: sheet(), r, c, targets: [{ r0: r, c0: c, r1: r, c1: c }] });
}

// ---------------------------------------------------------------------------
// Format painter
// ---------------------------------------------------------------------------
function startPainter() {
  if (painter) { painter = null; refresh(); return; }
  const g = sel();
  painter = { styles: [], w: g.c1 - g.c0 + 1, h: g.r1 - g.r0 + 1 };
  for (let r = g.r0; r <= Math.min(g.r1, g.r0 + 200); r++) for (let c = g.c0; c <= Math.min(g.c1, g.c0 + 50); c++) painter.styles.push(sheet().get(r, c) ? sheet().get(r, c).s : 0);
  setTimeout(() => { if (painter) painter.armed = true; }, 0);
  toast('Click or drag over the cells to format. Esc to stop.', { timeout: 2200 });
  refresh();
}
const applyPainter = debounce(() => {
  if (!painter) return;
  const g = sel();
  const p = painter;
  painter = null;
  book.edit('Paste formatting', () => {
    for (const [r, c] of cellsIn(g)) {
      const i = ((r - g.r0) % Math.min(p.h, 201)) * Math.min(p.w, 51) + ((c - g.c0) % Math.min(p.w, 51));
      book.setStyle(sheet(), r, c, p.styles[i] || 0);
    }
  });
  grid.drawSoon();
  refresh();
}, 250);

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
const C = (id, label, keys, run, extra = {}) => ({ id, label, keys, run, ...extra });
const st = () => styleAt(active().r, active().c);
const notEditing = () => !grid.editing;
commands.register(
  C('file.new', 'New Workbook', 'Ctrl+N', () => newBook(), { icon: 'new', category: 'File' }),
  C('file.open', 'Open…', 'Ctrl+O', () => openDialog(), { icon: 'open', category: 'File' }),
  C('file.save', 'Save', 'Ctrl+S', () => save(), { icon: 'save', category: 'File' }),
  C('file.saveAs', 'Save As…', 'Ctrl+Shift+S', () => saveAs(), { icon: 'saveAs', category: 'File' }),
  C('file.xlsx', 'Export as Excel (.xlsx)…', null, () => saveAs('xlsx'), { icon: 'export', category: 'File' }),
  C('file.csv', 'Export This Sheet as CSV…', null, () => saveAs('csv'), { icon: 'export', category: 'File' }),
  C('file.pdf', 'Export as PDF…', 'Ctrl+Shift+E', () => printSheet(true), { icon: 'pdf', category: 'File' }),
  C('file.print', 'Print…', 'Ctrl+P', () => printSheet(false), { icon: 'print', category: 'File' }),
  C('file.home', 'Start Screen', null, () => start.show(), { icon: 'home', category: 'File' }),
  C('edit.undo', 'Undo', 'Ctrl+Z', () => { if (grid.editing) return; book.undo(); grid.geoStamp = null; drawTabs(); grid.setSheet(book.sheets.includes(sheet()) ? sheet() : book.sheets[0]); charts.render(); }, { icon: 'undo', category: 'Edit', when: () => book.canUndo && notEditing() }),
  C('edit.redo', 'Redo', ['Ctrl+Y', 'Ctrl+Shift+Z'], () => { if (grid.editing) return; book.redo(); grid.geoStamp = null; drawTabs(); grid.setSheet(book.sheets.includes(sheet()) ? sheet() : book.sheets[0]); charts.render(); }, { icon: 'redo', category: 'Edit', when: () => book.canRedo && notEditing() }),
  C('edit.cut', 'Cut', null, () => { grid.input.focus(); document.execCommand('cut'); }, { icon: 'cut', category: 'Edit' }),
  C('edit.copy', 'Copy', null, () => { grid.input.focus(); document.execCommand('copy'); }, { icon: 'copy', category: 'Edit' }),
  C('edit.paste', 'Paste', null, () => pasteFromMenu('all'), { icon: 'paste', category: 'Edit' }),
  C('edit.pasteValues', 'Paste Values Only', 'Ctrl+Shift+V', () => pasteFromMenu('values'), { icon: 'paste', category: 'Edit', when: notEditing }),
  C('edit.pasteFormats', 'Paste Formatting Only', null, () => pasteFromMenu('formats'), { category: 'Edit' }),
  C('edit.pasteTranspose', 'Paste Transposed (rows ↔ columns)', null, () => pasteFromMenu('transpose'), { category: 'Edit' }),
  C('edit.clear', 'Clear Contents', 'Delete', () => { book.edit('Clear', () => { for (const g of grid.sel.ranges) book.clear(sheet(), g, 'contents'); }); grid.drawSoon(); charts.redraw(); selectionChanged(); }, { icon: 'eraser', category: 'Edit', when: notEditing }),
  C('edit.clearAll', 'Clear Everything', null, () => { book.edit('Clear', () => { for (const g of grid.sel.ranges) book.clear(sheet(), g, 'all'); }); grid.drawSoon(); }, { category: 'Edit' }),
  C('edit.clearFormats', 'Clear Formatting', 'Ctrl+\\', () => { book.edit('Clear formats', () => { for (const g of grid.sel.ranges) book.clear(sheet(), g, 'formats'); }); grid.drawSoon(); }, { icon: 'clearFormat', category: 'Edit' }),
  C('edit.selectAll', 'Select All', 'Ctrl+A', () => { const u = sheet().used(); const g = currentRegion(); const reg = sel(); if (reg.r0 === g.r0 && reg.c0 === g.c0 && reg.r1 === g.r1 && reg.c1 === g.c1) grid.selectRange({ r0: 0, c0: 0, r1: MAX_ROWS - 1, c1: MAX_COLS - 1 }); else grid.selectRange(g); void u; }, { category: 'Edit', when: notEditing }),
  C('edit.find', 'Find…', 'Ctrl+F', () => findDialog(false), { icon: 'search', category: 'Edit' }),
  C('edit.replace', 'Replace…', 'Ctrl+H', () => findDialog(true), { icon: 'replace', category: 'Edit' }),
  C('edit.goto', 'Go To…', 'Ctrl+G', () => gotoDialog(), { category: 'Edit' }),
  C('edit.fillDown', 'Fill Down', 'Ctrl+D', () => fillCmd('down'), { category: 'Edit', when: notEditing }),
  C('edit.fillRight', 'Fill Right', 'Ctrl+R', () => fillCmd('right'), { category: 'Edit', when: notEditing }),
  C('edit.date', "Insert Today's Date", 'Ctrl+;', () => { const d = new Date(); commitText(`${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`, { sheet: sheet(), ...active(), targets: [{ r0: active().r, c0: active().c, r1: active().r, c1: active().c }] }); }, { category: 'Insert', when: notEditing }),
  C('edit.time', 'Insert the Time Now', 'Ctrl+Shift+;', () => { const d = new Date(); commitText(`${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`, { sheet: sheet(), ...active(), targets: [{ r0: active().r, c0: active().c, r1: active().r, c1: active().c }] }); }, { category: 'Insert', when: notEditing }),
  C('fmt.bold', 'Bold', 'Ctrl+B', () => toggleStyle('bold', 'Bold'), { icon: 'bold', category: 'Format', checked: () => !!st().bold, when: notEditing }),
  C('fmt.italic', 'Italic', 'Ctrl+I', () => toggleStyle('italic', 'Italic'), { icon: 'italic', category: 'Format', checked: () => !!st().italic, when: notEditing }),
  C('fmt.underline', 'Underline', 'Ctrl+U', () => toggleStyle('underline', 'Underline'), { icon: 'underline', category: 'Format', checked: () => !!st().underline, when: notEditing }),
  C('fmt.strike', 'Strikethrough', 'Ctrl+5', () => toggleStyle('strike', 'Strikethrough'), { icon: 'strike', category: 'Format', checked: () => !!st().strike, when: notEditing }),
  C('fmt.wrap', 'Wrap Text', null, () => toggleStyle('wrap', 'Wrap'), { icon: 'wrap', category: 'Format', checked: () => !!st().wrap }),
  C('fmt.left', 'Align Left', null, () => applyStyle({ align: st().align === 'left' ? undefined : 'left' }), { icon: 'alignLeft', category: 'Format', checked: () => st().align === 'left' }),
  C('fmt.center', 'Centre', 'Ctrl+E', () => applyStyle({ align: st().align === 'center' ? undefined : 'center' }), { icon: 'alignCenter', category: 'Format', checked: () => st().align === 'center', when: notEditing }),
  C('fmt.right', 'Align Right', null, () => applyStyle({ align: st().align === 'right' ? undefined : 'right' }), { icon: 'alignRight', category: 'Format', checked: () => st().align === 'right' }),
  C('fmt.top', 'Align Top', null, () => applyStyle({ valign: 'top' }), { icon: 'alignObjTop', category: 'Format', checked: () => st().valign === 'top' }),
  C('fmt.middle', 'Align Middle', null, () => applyStyle({ valign: 'middle' }), { icon: 'alignObjMiddle', category: 'Format', checked: () => st().valign === 'middle' }),
  C('fmt.bottom', 'Align Bottom', null, () => applyStyle({ valign: undefined }), { icon: 'alignObjBottom', category: 'Format', checked: () => !st().valign }),
  C('fmt.currency', 'Currency Format', 'Ctrl+Shift+4', () => applyStyle({ fmt: '$#,##0.00' }, 'Currency'), { icon: 'currency', category: 'Number' }),
  C('fmt.percent', 'Percent Format', 'Ctrl+Shift+5', () => applyStyle({ fmt: '0%' }, 'Percent'), { icon: 'percent', category: 'Number' }),
  C('fmt.comma', 'Thousands Separator', 'Ctrl+Shift+1', () => applyStyle({ fmt: '#,##0.00' }, 'Number format'), { icon: 'sigma', category: 'Number' }),
  C('fmt.dateFmt', 'Date Format', 'Ctrl+Shift+3', () => applyStyle({ fmt: 'yyyy-mm-dd' }, 'Date format'), { icon: 'calendar', category: 'Number' }),
  C('fmt.general', 'General Format', 'Ctrl+Shift+`', () => applyStyle({ fmt: undefined }, 'Number format'), { category: 'Number' }),
  C('fmt.moreDec', 'More Decimals', null, () => applyStyle({ fmt: changeDecimals(st().fmt, 1) }, 'Decimals'), { icon: 'decimalUp', category: 'Number' }),
  C('fmt.lessDec', 'Fewer Decimals', null, () => applyStyle({ fmt: changeDecimals(st().fmt, -1) }, 'Decimals'), { icon: 'decimalDown', category: 'Number' }),
  C('fmt.cells', 'Format Cells…', 'Ctrl+1', () => formatDialog(), { icon: 'settings', category: 'Format' }),
  C('fmt.painter', 'Copy Formatting (Format Painter)', null, () => startPainter(), { icon: 'painter', category: 'Format', checked: () => !!painter }),
  C('fmt.grow', 'Bigger Text', 'Ctrl+Shift+.', () => applyStyle({ size: FONT_SIZES.find((s) => s > (st().size || 11)) || 96 }, 'Font size'), { icon: 'plus', category: 'Format' }),
  C('fmt.shrink', 'Smaller Text', 'Ctrl+Shift+,', () => applyStyle({ size: [...FONT_SIZES].reverse().find((s) => s < (st().size || 11)) || 6 }, 'Font size'), { icon: 'minus', category: 'Format' }),
  C('cells.merge', 'Merge and Centre', null, () => merge('center'), { icon: 'merge', category: 'Cells' }),
  C('cells.mergeAcross', 'Merge Across', null, () => merge('across'), { category: 'Cells' }),
  C('cells.unmerge', 'Unmerge', null, () => merge('unmerge'), { category: 'Cells' }),
  C('rows.insertAbove', 'Insert Rows Above', 'Ctrl+Shift+=', () => insertLines('row'), { icon: 'insertRow', category: 'Rows', when: notEditing }),
  C('rows.insertBelow', 'Insert Rows Below', null, () => insertLines('row', true), { icon: 'insertRow', category: 'Rows' }),
  C('cols.insertLeft', 'Insert Columns Left', null, () => insertLines('col'), { icon: 'insertCol', category: 'Columns' }),
  C('cols.insertRight', 'Insert Columns Right', null, () => insertLines('col', true), { icon: 'insertCol', category: 'Columns' }),
  C('rows.delete', 'Delete Rows', 'Ctrl+-', () => deleteLines('row'), { icon: 'deleteRow', category: 'Rows', when: notEditing }),
  C('cols.delete', 'Delete Columns', null, () => deleteLines('col'), { icon: 'trash', category: 'Columns' }),
  C('rows.hide', 'Hide Rows', 'Ctrl+9', () => hideLines('row', true), { category: 'Rows', when: notEditing }),
  C('rows.unhide', 'Unhide Rows', 'Ctrl+Shift+9', () => hideLines('row', false), { category: 'Rows', when: notEditing }),
  C('cols.hide', 'Hide Columns', 'Ctrl+0', () => hideLines('col', true), { category: 'Columns', when: notEditing }),
  C('cols.unhide', 'Unhide Columns', 'Ctrl+Shift+0', () => hideLines('col', false), { category: 'Columns', when: notEditing }),
  C('cols.fit', 'Fit Column Width to Contents', null, () => autofit('col', selectedLines('col')), { icon: 'resize', category: 'Columns' }),
  C('rows.fit', 'Fit Row Height to Contents', null, () => autofit('row', selectedLines('row')), { category: 'Rows' }),
  C('cols.width', 'Column Width…', null, () => sizeDialog('col'), { category: 'Columns' }),
  C('rows.height', 'Row Height…', null, () => sizeDialog('row'), { category: 'Rows' }),
  C('data.sortAsc', 'Sort A → Z', null, () => sortBy(false), { icon: 'sortAsc', category: 'Data' }),
  C('data.sortDesc', 'Sort Z → A', null, () => sortBy(true), { icon: 'sortDesc', category: 'Data' }),
  C('data.sort', 'Sort…', null, () => sortDialog(), { icon: 'sortAsc', category: 'Data' }),
  C('data.filter', 'Filter', 'Ctrl+Shift+L', () => toggleFilter(), { icon: 'filter', category: 'Data', checked: () => !!sheet().filter }),
  C('data.clearFilter', 'Show All Rows (Clear Filters)', null, () => { if (sheet().filter) { book.edit('Clear filters', () => { sheet().filter.crit = {}; applyFilter(); }); } }, { category: 'Data', when: () => !!sheet().filter }),
  C('data.dedupe', 'Remove Duplicates…', null, () => removeDuplicates(), { icon: 'duplicate', category: 'Data' }),
  C('data.split', 'Split Text into Columns…', null, () => textToColumns(), { icon: 'columns', category: 'Data' }),
  C('data.trim', 'Trim Extra Spaces', null, () => trimSpaces(), { category: 'Data' }),
  C('data.validate', 'Allowed Values (Validation)…', null, () => validationDialog(), { icon: 'validation', category: 'Data' }),
  C('data.summarize', 'Summarize (Pivot)…', null, () => summarize(), { icon: 'table', category: 'Data' }),
  C('data.recalc', 'Recalculate Now', 'F9', () => { book.calc.rebuild(); grid.drawSoon(); charts.redraw(); toast('Recalculated', { timeout: 1000 }); }, { category: 'Data' }),
  C('fn.insert', 'Insert Function…', 'Shift+F3', () => functionDialog(), { icon: 'fx', category: 'Formulas', inputs: true }),
  C('fn.autosum', 'AutoSum', 'Alt+=', () => autosum('SUM'), { icon: 'sigma', category: 'Formulas', when: notEditing }),
  C('fn.names', 'Names…', 'Ctrl+F3', () => namesDialog(), { category: 'Formulas' }),
  C('fn.trace', 'Show What This Formula Uses', null, () => {
    const cell = sheet().get(active().r, active().c);
    if (!cell || !cell.f) { toast('The selected cell has no formula.'); return; }
    grid.refHighlights = refSpansOf(`=${cell.f}`);
    grid.drawSoon();
    setTimeout(() => { grid.refHighlights = []; grid.drawSoon(); }, 4000);
  }, { category: 'Formulas' }),
  C('view.formulas', 'Show Formulas', 'Ctrl+`', () => { grid.showFormulas = !grid.showFormulas; grid.drawSoon(); refresh(); }, { icon: 'fx', category: 'View', checked: () => grid.showFormulas }),
  C('view.grid', 'Gridlines', null, () => { book.edit('Gridlines', () => { book.touchProps(sheet()); sheet().showGrid = !sheet().showGrid; }); grid.drawSoon(); refresh(); }, { icon: 'grid', category: 'View', checked: () => sheet().showGrid }),
  C('view.lightCells', 'Light Cells in Dark Theme', null, () => { settings.set('lightCells', !settings.get('lightCells', false)); grid.drawSoon(); charts.redraw(); refresh(); }, { icon: 'sun', category: 'View', checked: () => settings.get('lightCells', false) }),
  C('view.freezeSel', 'Freeze Panes at the Selection', null, () => freeze('sel'), { icon: 'freeze', category: 'View' }),
  C('view.freezeRow', 'Freeze Top Row', null, () => freeze('row'), { category: 'View' }),
  C('view.freezeCol', 'Freeze First Column', null, () => freeze('col'), { category: 'View' }),
  C('view.unfreeze', 'Unfreeze Panes', null, () => freeze('none'), { category: 'View', when: () => !!(sheet().freeze.r || sheet().freeze.c) }),
  C('view.zoomIn', 'Zoom In', 'Ctrl+=', () => grid.setZoom(stepZoom(grid.zoom, 1, 0.25, 4)), { icon: 'zoomIn', category: 'View', when: notEditing }),
  C('view.zoomOut', 'Zoom Out', null, () => grid.setZoom(stepZoom(grid.zoom, -1, 0.25, 4)), { icon: 'zoomOut', category: 'View' }),
  C('view.zoom100', 'Actual Size', null, () => grid.setZoom(1), { category: 'View' }),
  C('view.zoomSel', 'Zoom to the Selection', null, () => zoomToSelection(), { icon: 'fit', category: 'View' }),
  C('view.formulaBar', 'Formula Bar', null, () => { formulaBar.classList.toggle('hidden'); settings.set('formulaBar', !formulaBar.classList.contains('hidden')); refresh(); }, { category: 'View', checked: () => !formulaBar.classList.contains('hidden') }),
  C('ins.chart', 'Chart', 'Alt+F1', () => insertChart('column'), { icon: 'chart', category: 'Insert' }),
  C('ins.sparkline', 'Sparkline (tiny chart in a cell)', null, () => sparkline(), { icon: 'lineChart', category: 'Insert' }),
  C('ins.note', 'Note…', 'Shift+F2', () => noteDialog(), { icon: 'comment', category: 'Insert' }),
  C('ins.link', 'Link…', 'Ctrl+K', () => linkDialog(), { icon: 'link', category: 'Insert' }),
  C('sheet.new', 'New Sheet', 'Shift+F11', () => addSheet(), { icon: 'plus', category: 'Sheet' }),
  C('sheet.next', 'Next Sheet', 'Ctrl+PageDown', () => { const v = book.sheets.filter((s) => !s.hidden); switchSheet(v[(v.indexOf(sheet()) + 1) % v.length]); }, { category: 'Sheet', inputs: true }),
  C('sheet.prev', 'Previous Sheet', 'Ctrl+PageUp', () => { const v = book.sheets.filter((s) => !s.hidden); switchSheet(v[(v.indexOf(sheet()) - 1 + v.length) % v.length]); }, { category: 'Sheet', inputs: true }),
);

function refSpansOf(text) {
  return refSpans(text).map((x, i) => ({ ...x, color: ['#2f81f7', '#e5534b', '#a371f7', '#3fb950', '#d4a72c'][i % 5] }));
}

function zoomToSelection() {
  const g = sel();
  const w = grid.colX(Math.min(g.c1 + 1, MAX_COLS - 1)) - grid.colX(g.c0);
  const hh = grid.rowY(Math.min(g.r1 + 1, MAX_ROWS - 1)) - grid.rowY(g.r0);
  const z = clamp(Math.min((grid.el.clientWidth - grid.headW - 30) / w, (grid.el.clientHeight - 60) / hh), 0.25, 4);
  grid.setZoom(z);
  grid.reveal(g.r0, g.c0);
}

function sparkline() {
  const g = sel();
  const target = { r: g.r0, c: g.c1 + 1 };
  if (g.r0 === g.r1) commitText(`=SPARKLINE(${rangeText(g)})`, { sheet: sheet(), r: target.r, c: target.c, targets: [{ r0: target.r, c0: target.c, r1: target.r, c1: target.c }] });
  else {
    book.edit('Sparklines', () => { for (let r = g.r0; r <= Math.min(g.r1, g.r0 + 5000); r++) book.setFormula(sheet(), r, g.c1 + 1, `SPARKLINE(${colName(g.c0)}${r + 1}:${colName(g.c1)}${r + 1})`); });
    grid.drawSoon();
  }
}

// ---------------------------------------------------------------------------
// Ribbon
// ---------------------------------------------------------------------------
let fontList = knownFonts();
const fontBox = combo({ values: () => fontList, width: 150, tip: 'Font', itemStyle: (f) => ({ fontFamily: `"${f}"` }), onCommit: (v) => { applyStyle({ font: v.trim() || undefined }, 'Font'); grid.input.focus(); }, update: (w) => w.set(st().font || 'Carlito') });
fontBox.input.addEventListener('focus', async () => { fontList = await allFonts(); });
const sizeBox = combo({ values: FONT_SIZES, width: 64, tip: 'Font size', numeric: true, min: 1, max: 400, onCommit: (v) => { const n = parseFloat(v); if (n > 0) applyStyle({ size: n === 11 ? undefined : n }, 'Font size'); grid.input.focus(); }, update: (w) => w.set(String(st().size || 11)) });
let lastColor = settings.get('lastColor', '#e5534b');
let lastFill = settings.get('lastFill', '#fff2cc');
const colorBtn = tb({ icon: 'textColor', tip: 'Text colour', split: true, cls: 'color-bar', run: () => applyStyle({ color: lastColor }, 'Text colour'), menu: () => [{ custom: colorPicker({ value: lastColor, allowNone: true, noneLabel: 'Automatic', onPick: (c) => { closeMenus(); if (c !== 'none') { lastColor = c; settings.set('lastColor', c); colorBtn.button.style.setProperty('--swatch', c); } applyStyle({ color: c === 'none' ? undefined : c }, 'Text colour'); } }) }] });
colorBtn.button.style.setProperty('--swatch', lastColor);
const fillBtn = tb({ icon: 'bucket', tip: 'Fill colour', split: true, cls: 'color-bar', run: () => applyStyle({ fill: lastFill }, 'Fill'), menu: () => [{ custom: colorPicker({ value: lastFill, allowNone: true, noneLabel: 'No fill', onPick: (c) => { closeMenus(); if (c !== 'none') { lastFill = c; settings.set('lastFill', c); fillBtn.button.style.setProperty('--swatch', c); } applyStyle({ fill: c === 'none' ? undefined : c }, 'Fill'); } }) }] });
fillBtn.button.style.setProperty('--swatch', lastFill);
const borderMenu = () => [
  ['All borders', 'all'], ['Outside borders', 'outer'], ['Inside borders', 'inner'], ['Top border', 'top'], ['Bottom border', 'bottom'], ['Left border', 'left'], ['Right border', 'right'], ['Double bottom border', 'double'],
].map(([n, k]) => ({ label: n, icon: 'borders', run: () => borders(k) }))
  .concat([{ label: 'Thick outside borders', run: () => borders('outer', 'thick') }, { type: 'separator' }, { label: 'No borders', icon: 'x', run: () => borders('none') }]);
const numFmtSelect = select({
  options: [{ value: '', label: 'General' }, ...FORMATS.slice(1).map((f) => ({ value: f.code, label: f.name })), { value: '__more', label: 'More formats…' }], width: 130, tip: 'Number format',
  onChange: (v) => { if (v === '__more') { formatDialog('number'); return; } applyStyle({ fmt: v || undefined }, 'Number format'); grid.input.focus(); },
  update: (el) => { const f = st().fmt || ''; el.value = FORMATS.some((x) => x.code === f) ? f : f ? '__more' : ''; },
});

shell.setRibbon([
  {
    id: 'home', label: 'Home', groups: [
      { label: 'Clipboard', items: [tb({ icon: 'paste', label: 'Paste', big: true, split: true, run: () => commands.run('edit.paste'), menu: () => [I('edit.paste'), I('edit.pasteValues'), I('edit.pasteFormats'), I('edit.pasteTranspose')] }), h('div.rstack', tb('edit.cut'), tb('edit.copy'), tb('fmt.painter'))] },
      { label: 'Font', items: [h('div.rstack', h('div.row', { style: { gap: '2px' } }, fontBox, sizeBox, tb('fmt.grow'), tb('fmt.shrink')),
        h('div.row', { style: { gap: '2px' } }, tb('fmt.bold'), tb('fmt.italic'), tb('fmt.underline'), tb('fmt.strike'), sep(), tb({ icon: 'borders', tip: 'Borders', menu: borderMenu }), fillBtn, colorBtn))] },
      { label: 'Alignment', items: [h('div.rstack', h('div.row', { style: { gap: '2px' } }, tb('fmt.top'), tb('fmt.middle'), tb('fmt.bottom'), tb('fmt.wrap')),
        h('div.row', { style: { gap: '2px' } }, tb('fmt.left'), tb('fmt.center'), tb('fmt.right'), tb('cells.merge', { split: true, menu: () => [I('cells.merge'), I('cells.mergeAcross'), I('cells.unmerge')] })))] },
      { label: 'Number', items: [h('div.rstack', numFmtSelect, h('div.row', { style: { gap: '2px' } }, tb('fmt.currency'), tb('fmt.percent'), tb('fmt.comma'), tb('fmt.moreDec'), tb('fmt.lessDec')))] },
      { label: 'Styles', items: [tb({ icon: 'conditional', label: 'Conditional', big: true, menu: cfMenu }), tb('data.validate', { big: true, label: 'Allowed values' })] },
      { label: 'Cells', items: [tb({ icon: 'insertRow', label: 'Insert', big: true, menu: () => [I('rows.insertAbove'), I('rows.insertBelow'), I('cols.insertLeft'), I('cols.insertRight')] }),
        tb({ icon: 'trash', label: 'Delete', big: true, menu: () => [I('rows.delete'), I('cols.delete')] }),
        tb({ icon: 'resize', label: 'Size', big: true, menu: () => [I('cols.fit'), I('rows.fit'), I('cols.width'), I('rows.height'), { type: 'separator' }, I('rows.hide'), I('rows.unhide'), I('cols.hide'), I('cols.unhide')] })] },
      { label: 'Editing', items: [h('div.rstack', tb('fn.autosum', { split: true, showLabel: true, menu: () => ['SUM', 'AVERAGE', 'COUNT', 'MAX', 'MIN'].map((f) => ({ label: f[0] + f.slice(1).toLowerCase(), run: () => autosum(f) })) }),
        tb({ icon: 'eraser', label: 'Clear', showLabel: true, menu: () => [I('edit.clearAll'), I('edit.clear'), I('edit.clearFormats')] }),
        tb({ icon: 'sortAsc', label: 'Sort & filter', showLabel: true, menu: () => [I('data.sortAsc'), I('data.sortDesc'), I('data.sort'), { type: 'separator' }, I('data.filter'), I('data.clearFilter')] })),
      tb('edit.find', { big: true, label: 'Find' })] },
    ],
  },
  {
    id: 'insert', label: 'Insert', groups: [
      { label: 'Charts', items: CHART_TYPES.map(([t, n]) => tb({ icon: { column: 'chart', stacked: 'chart', bar: 'hbarChart', line: 'lineChart', area: 'areaChart', pie: 'pieChart', doughnut: 'pieChart', scatter: 'scatter' }[t], label: n, big: true, run: () => insertChart(t) })) },
      { label: 'In a cell', items: [tb('ins.sparkline', { big: true, label: 'Sparkline' }), tb({ icon: 'gauge', label: 'Progress bar', big: true, run: () => { const { r, c } = active(); commitText(`=PROGRESS(${colName(Math.max(0, c - 1))}${r + 1},100)`, { sheet: sheet(), r, c, targets: [{ r0: r, c0: c, r1: r, c1: c }] }); } })] },
      { label: 'Other', items: [tb('fn.insert', { big: true, label: 'Function' }), tb('ins.link', { big: true, label: 'Link' }), tb('ins.note', { big: true, label: 'Note' }), tb('data.summarize', { big: true, label: 'Summary' })] },
    ],
  },
  {
    id: 'formulas', label: 'Formulas', groups: [
      { label: 'Functions', items: [tb('fn.insert', { big: true, label: 'Insert' }), tb('fn.autosum', { big: true, label: 'AutoSum' }),
        ...Object.keys(CATS).map((cat) => tb({ icon: { Math: 'sigma', Statistics: 'barChart', Logic: 'help', Text: 'text', Lookup: 'search', Dates: 'calendar', Money: 'currency', "Snake's": 'star' }[cat], label: cat, big: true, menu: () => CATS[cat].filter((n) => FN[n]).map((n) => ({ label: n, tip: FN[n].desc, run: () => { if (!grid.editing) grid.startEdit(`=${n}(`, 'enter'); else { grid.input.setRangeText(`${n}(`, grid.input.selectionStart, grid.input.selectionEnd, 'end'); grid.updateRefs(); } grid.input.focus(); grid.placeHint(); } })) }))] },
      { label: 'Names', items: [tb('fn.names', { big: true, icon: 'pin', label: 'Names' })] },
      { label: 'Checking', items: [tb('view.formulas', { big: true, label: 'Show formulas' }), tb('fn.trace', { big: true, icon: 'search', label: 'What it uses' }), tb('data.recalc', { big: true, icon: 'rotateCw', label: 'Recalculate' })] },
    ],
  },
  {
    id: 'data', label: 'Data', groups: [
      { label: 'Sort & Filter', items: [tb('data.sortAsc', { big: true, label: 'A → Z' }), tb('data.sortDesc', { big: true, label: 'Z → A' }), tb('data.sort', { big: true, label: 'Sort…' }), tb('data.filter', { big: true, label: 'Filter' }), tb('data.clearFilter', { big: true, icon: 'x', label: 'Clear' })] },
      { label: 'Tools', items: [tb('data.dedupe', { big: true, label: 'Duplicates' }), tb('data.split', { big: true, label: 'Split text' }), tb('data.trim', { big: true, icon: 'clearFormat', label: 'Trim' }),
        tb({ icon: 'text', label: 'Case', big: true, menu: () => [{ label: 'UPPERCASE', run: () => changeCase('upper') }, { label: 'lowercase', run: () => changeCase('lower') }, { label: 'Proper Case', run: () => changeCase('proper') }] }), tb('data.validate', { big: true, label: 'Allowed' })] },
      { label: 'Analyse', items: [tb('data.summarize', { big: true, label: 'Summarize' })] },
    ],
  },
  {
    id: 'view', label: 'View', groups: [
      { label: 'Show', items: [h('div.rstack', tb('view.grid', { showLabel: true }), tb('view.formulaBar', { showLabel: true, icon: 'fx' }), tb('view.lightCells', { showLabel: true, label: 'Light cells' }))] },
      { label: 'Freeze', items: [tb('view.freezeSel', { big: true, label: 'Freeze', split: true, menu: () => [I('view.freezeSel'), I('view.freezeRow'), I('view.freezeCol'), I('view.unfreeze')] })] },
      { label: 'Zoom', items: [tb('view.zoomOut', { big: true, label: 'Out' }), tb('view.zoom100', { big: true, icon: 'search', label: '100%' }), tb('view.zoomIn', { big: true, label: 'In' }), tb('view.zoomSel', { big: true, label: 'Selection' })] },
    ],
  },
]);

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------
let recentCache = [];
const refreshRecent = () => host.recent().then((r) => { recentCache = r; }).catch(() => {});
refreshRecent();
function fileMenu() {
  return [I('file.new'), I('app.newWindow'), I('file.open'),
    { label: 'Open Recent', icon: 'clock', submenu: () => (recentCache.length ? recentCache.slice(0, 15).map((r) => ({ label: r.name, tip: r.dir, disabled: !r.exists, run: () => openRecent(r) })) : [{ label: 'Nothing yet', disabled: true }]) },
    { type: 'separator' }, I('file.save'), I('file.saveAs'), { label: 'Export', icon: 'export', submenu: [I('file.xlsx'), I('file.csv'), I('file.pdf')] },
    { type: 'separator' }, I('file.print'), I('file.home'), I('app.close')];
}
function editMenu() {
  return [I('edit.undo', { label: book.undoStack.length ? `Undo ${book.undoStack[book.undoStack.length - 1].label}` : 'Undo' }), I('edit.redo'), { type: 'separator' },
    I('edit.cut'), I('edit.copy'), I('edit.paste'), { label: 'Paste special', submenu: [I('edit.pasteValues'), I('edit.pasteFormats'), I('edit.pasteTranspose')] }, { type: 'separator' },
    I('edit.fillDown'), I('edit.fillRight'), I('edit.clear'), I('edit.clearFormats'), I('edit.clearAll'), { type: 'separator' }, I('edit.selectAll'), I('edit.find'), I('edit.replace'), I('edit.goto')];
}
function viewMenu() {
  return [I('view.formulaBar'), I('view.grid'), I('view.formulas'), I('view.lightCells'), I('view.ribbon'), { type: 'separator' }, I('view.freezeSel'), I('view.freezeRow'), I('view.freezeCol'), I('view.unfreeze'),
    { type: 'separator' }, I('view.zoomIn'), I('view.zoomOut'), I('view.zoom100'), I('view.zoomSel'), { type: 'separator' }, I('view.themeDark'), I('view.themeLight'), I('view.themeSystem'), I('view.fullscreen')];
}
function insertMenu() {
  return [I('rows.insertAbove'), I('rows.insertBelow'), I('cols.insertLeft'), I('cols.insertRight'), I('sheet.new'), { type: 'separator' },
    { label: 'Chart', icon: 'chart', submenu: CHART_TYPES.map(([t, n]) => ({ label: n, run: () => insertChart(t) })) }, I('ins.sparkline'), I('fn.insert'), I('ins.link'), I('ins.note'), I('edit.date'), I('edit.time')];
}
function formatMenu() {
  return [I('fmt.cells'), { label: 'Number', submenu: () => FORMATS.map((f) => ({ label: f.name, checked: (st().fmt || 'General') === f.code, run: () => applyStyle({ fmt: f.code === 'General' ? undefined : f.code }, 'Number format') })) },
    I('fmt.bold'), I('fmt.italic'), I('fmt.underline'), I('fmt.strike'), { label: 'Borders', submenu: borderMenu }, { label: 'Conditional formatting', submenu: cfMenu },
    { type: 'separator' }, I('cells.merge'), I('cells.unmerge'), I('fmt.wrap'), I('cols.fit'), I('rows.fit'), I('fmt.painter'), I('edit.clearFormats')];
}
function dataMenu() {
  return [I('data.sortAsc'), I('data.sortDesc'), I('data.sort'), I('data.filter'), I('data.clearFilter'), { type: 'separator' }, I('data.dedupe'), I('data.split'), I('data.trim'), I('data.validate'), I('data.summarize'), { type: 'separator' }, I('fn.names'), I('data.recalc')];
}

function cellMenu(e, hit) {
  let items;
  if (hit.area === 'colhead') {
    items = [I('edit.cut'), I('edit.copy'), I('edit.paste'), { type: 'separator' }, I('cols.insertLeft'), I('cols.insertRight'), I('cols.delete'), I('edit.clear', { label: 'Clear column' }), { type: 'separator' },
      I('data.sortAsc', { label: 'Sort sheet A → Z by this column', run: () => { const u = sheet().used(); book.edit('Sort', () => book.sort(sheet(), { r0: 0, c0: 0, r1: u.r, c1: u.c }, [{ col: hit.c, desc: false }], hasHeader({ r0: 0, c0: 0, r1: u.r, c1: u.c }))); grid.drawSoon(); } }),
      I('data.sortDesc', { label: 'Sort sheet Z → A by this column', run: () => { const u = sheet().used(); book.edit('Sort', () => book.sort(sheet(), { r0: 0, c0: 0, r1: u.r, c1: u.c }, [{ col: hit.c, desc: true }], hasHeader({ r0: 0, c0: 0, r1: u.r, c1: u.c }))); grid.drawSoon(); } }),
      { type: 'separator' }, I('cols.width'), I('cols.fit'), I('cols.hide'), I('cols.unhide'), { label: 'Freeze up to here', icon: 'freeze', run: () => { book.edit('Freeze', () => { book.touchProps(sheet()); sheet().freeze = { r: sheet().freeze.r, c: hit.c + 1 }; }); grid.drawSoon(); } }];
  } else if (hit.area === 'rowhead') {
    items = [I('edit.cut'), I('edit.copy'), I('edit.paste'), { type: 'separator' }, I('rows.insertAbove'), I('rows.insertBelow'), I('rows.delete'), I('edit.clear', { label: 'Clear row' }), { type: 'separator' },
      I('rows.height'), I('rows.fit'), I('rows.hide'), I('rows.unhide'), { label: 'Freeze up to here', icon: 'freeze', run: () => { book.edit('Freeze', () => { book.touchProps(sheet()); sheet().freeze = { r: hit.r + 1, c: sheet().freeze.c }; }); grid.drawSoon(); } }];
  } else {
    const cell = sheet().get(hit.r, hit.c);
    const v = book.value(sheet(), hit.r, hit.c);
    items = [I('edit.cut'), I('edit.copy'), I('edit.paste'), { label: 'Paste special', icon: 'paste', submenu: [I('edit.pasteValues'), I('edit.pasteFormats'), I('edit.pasteTranspose')] }, { type: 'separator' },
      { label: 'Insert', icon: 'plus', submenu: [I('rows.insertAbove'), I('rows.insertBelow'), I('cols.insertLeft'), I('cols.insertRight')] },
      { label: 'Delete', icon: 'trash', submenu: [I('rows.delete'), I('cols.delete')] }, I('edit.clear'), { type: 'separator' },
      { label: 'Sort', icon: 'sortAsc', submenu: [I('data.sortAsc'), I('data.sortDesc'), I('data.sort')] },
      { label: 'Filter by this value', icon: 'filter', run: () => filterByValue() },
      { label: 'Quick analysis', icon: 'star', submenu: [
        { label: 'Data bars', run: () => addCf({ type: 'bar', color: '#3fb950' }) }, { label: 'Colour scale', run: () => addCf({ type: 'scale', colors: ['#f8696b', '#ffeb84', '#63be7b'] }) },
        { label: 'Highlight duplicates', run: () => addCf({ type: 'dup', style: HL }) }, { label: 'Top 10%', run: () => addCf({ type: 'top', n: 10, percent: true, style: { fill: '#dcf5e1', color: '#1a7f37' } }) },
        { type: 'separator' }, { label: 'Totals below (SUM)', run: () => autosum('SUM') }, { label: 'Averages below', run: () => autosum('AVERAGE') }, { label: 'Chart', run: () => insertChart('column') }, { label: 'Sparklines beside', run: () => sparkline() }] },
      { type: 'separator' },
      cell && cell.note ? { label: 'Edit note…', icon: 'comment', run: () => noteDialog() } : I('ins.note'),
      cell && cell.note ? { label: 'Delete note', run: () => { book.edit('Delete note', () => book.setNote(sheet(), hit.r, hit.c, null)); grid.drawSoon(); } } : null,
      v && typeof v === 'object' && v.link ? { label: 'Open link', icon: 'external', run: () => host.openExternal(v.link) } : I('ins.link'),
      I('fmt.cells'), { label: 'Number format', icon: 'percent', submenu: () => FORMATS.map((f) => ({ label: f.name, checked: (st().fmt || 'General') === f.code, run: () => applyStyle({ fmt: f.code === 'General' ? undefined : f.code }, 'Number format') })) },
      { label: 'Define name…', icon: 'pin', run: async () => { const n = await promptBox('Name for the selection', { validate: (x) => (/^[A-Za-z_][\w.]*$/.test(x) && !parseAddr(x) ? '' : 'Use letters, digits, _ and .') }); if (n) book.edit('Define name', () => book.defineName(n, `${quoteSheet(sheet().name)}!${absRef(sel())}`)); } },
    ];
  }
  showMenu(items, { x: e.clientX, y: e.clientY });
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------
const zoomBox = shell.zoomBox({ get: () => grid.zoom, set: (z) => grid.setZoom(z), min: 0.25, max: 4, fit: [{ label: 'Fit the selection', run: () => zoomToSelection() }] });
const modeItem = h('span.item', 'Ready');
const saveItem = h('span.item.muted');
shell.statusLeft.append(modeItem, saveItem);
shell.statusRight.append(statsBox, zoomBox);
const origOnSelect = grid.onSelect;
grid.onSelect = () => { origOnSelect(); zoomBox.update(); modeItem.textContent = grid.editing ? (grid.canPoint() ? 'Point' : grid.editing.mode === 'edit' ? 'Edit' : 'Enter') : painter ? 'Paint formatting' : 'Ready'; };
grid.input.addEventListener('keyup', () => { modeItem.textContent = grid.editing ? (grid.canPoint() ? 'Point' : grid.editing.mode === 'edit' ? 'Edit' : 'Enter') : 'Ready'; });

function updateTitle() {
  shell.setTitle(file.name, book.dirty);
  saveItem.textContent = book.dirty ? 'Not saved' : file.handle ? 'Saved' : '';
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------
function useBook(b, { name = 'Untitled', handle = null, format = 'snakesheet' } = {}) {
  book = b;
  grid.book = b;
  file.handle = handle;
  file.name = name;
  file.format = format;
  file.id = uid('book');
  file.opened = true;
  book.onChange(() => { updateTitle(); refresh(); });
  grid.savedSel = new Map();
  grid.setSheet(book.sheets.find((s) => !s.hidden) || book.sheets[0]);
  drawTabs();
  charts.render();
  start.hide();
  updateTitle();
  grid.input.focus({ preventScroll: true });
}

async function parseFile(f, bytes) {
  const ext = extOf(f.name);
  if (ext === 'xlsx') return { book: await readXlsx(bytes), format: 'xlsx' };
  const text = decodeText(bytes);
  if (ext === 'snakesheet') return { book: fromSnake(text), format: 'snakesheet' };
  if (ext === 'tsv') return { book: bookFromCSV(text, baseName(f.name), '\t'), format: 'tsv' };
  return { book: bookFromCSV(text, baseName(f.name)), format: 'csv' };
}

function pristine() { return !file.handle && !book.dirty && book.sheets.length === 1 && !book.sheets[0].cells.size; }

async function openFile(f, { here = false } = {}) {
  if (!here && !pristine() && host.openInNewWindow && f.id) { host.openInNewWindow(f); return; }
  if (!here && !pristine() && !(await confirmLeave())) return;
  const b = busy(`Opening ${f.name}…`);
  try {
    const bytes = await host.read(f);
    const res = await parseFile(f, bytes);
    useBook(res.book, { name: f.name, handle: f, format: res.format });
    if (res.format === 'csv' || res.format === 'tsv') toast('CSV keeps values only: use Save As for formulas, formats and charts.', { timeout: 4500 });
    refreshRecent();
  } catch (err) { errorToast(err); } finally { b.close(); }
}

async function confirmLeave() {
  if (!book.dirty) return true;
  const { saveChangesBox } = await import('../../kit/dialogs.js');
  const r = await saveChangesBox(file.name);
  if (r === 'save') return save();
  return r === 'discard';
}

async function openDialog() {
  const files = await host.openFiles({ filters: FILTERS, multiple: true });
  for (const f of files) await openFile(f);
}
async function openRecent(r) {
  try { await openFile(await host.openRecent(r.key)); } catch (err) { errorToast(err); refreshRecent(); }
}

async function newBook(t = TEMPLATES[0]) {
  if (!pristine() && file.opened) {
    if (inElectron) { host.win.newWindow(`new=${t.id}`); return; }
    if (!(await confirmLeave())) return;
  }
  useBook(t.build(), { name: t.id === 'blank' ? 'Untitled' : t.name });
  book.markSaved();
}

async function serialize(format) {
  if (grid.editing) grid.commitEdit(0, 0);
  if (format === 'xlsx') return writeXlsx(book);
  if (format === 'csv') return toCSV(book, sheet(), ',');
  if (format === 'tsv') return toCSV(book, sheet(), '\t');
  return toSnake(book);
}

async function save() {
  if (!file.handle || !file.handle.writable || !['snakesheet', 'xlsx'].includes(file.format)) {
    if (file.handle && (file.format === 'csv' || file.format === 'tsv') && book.sheets.length === 1 && !sheet().charts.length) {
      // A CSV saved back to itself.
      try { file.handle = await host.write(file.handle, await serialize(file.format)); book.markSaved(); updateTitle(); toast(`Saved ${file.name}`, { timeout: 1500 }); return true; } catch (err) { errorToast(err); return false; }
    }
    return saveAs();
  }
  try {
    file.handle = await host.write(file.handle, await serialize(file.format));
    book.markSaved();
    host.recovery.delete(file.id).catch(() => {});
    updateTitle();
    toast(`Saved ${file.name}`, { timeout: 1500 });
    return true;
  } catch (err) { errorToast(err); return false; }
}

async function saveAs(format = null) {
  const fmt = format || (['snakesheet', 'xlsx'].includes(file.format) ? file.format : 'snakesheet');
  const base = baseName(file.name === 'Untitled' ? 'Workbook' : file.name);
  try {
    const data = await serialize(fmt);
    const f = await host.saveAs({ name: `${base}.${SAVE[fmt].exts[0]}`, filters: format ? [SAVE[fmt]] : [SAVE[fmt], ...Object.entries(SAVE).filter(([k]) => k !== fmt).map(([, v]) => v)], near: file.handle && file.handle.id }, data);
    if (!f) return false;
    const real = SAVE[extOf(f.name)] ? extOf(f.name) : fmt;
    if (real !== fmt) await host.write(f, await serialize(real));
    if (real === 'snakesheet' || real === 'xlsx') {
      file.handle = f;
      file.name = f.name;
      file.format = real;
      book.markSaved();
      host.recovery.delete(file.id).catch(() => {});
    }
    updateTitle();
    refreshRecent();
    toast(`Saved ${f.name}`, { timeout: 1800 });
    return true;
  } catch (err) { errorToast(err); return false; }
}

/** Print or PDF: the used range (or the selection) as a table. */
async function printSheet(pdf) {
  const g0 = sel();
  const u = sheet().used();
  const g = g0.r0 !== g0.r1 || g0.c0 !== g0.c1 ? { r0: g0.r0, c0: g0.c0, r1: Math.min(g0.r1, u.r), c1: Math.min(g0.c1, u.c) } : { r0: 0, c0: 0, r1: Math.max(0, u.r), c1: Math.max(0, u.c) };
  const view = h('div.print-view');
  const table = h('table');
  const colgroup = h('colgroup');
  for (let c = g.c0; c <= g.c1; c++) if (!sheet().hiddenC.has(c)) colgroup.append(h('col', { style: { width: `${grid.colW(c)}px` } }));
  table.append(colgroup);
  for (let r = g.r0; r <= g.r1; r++) {
    if (sheet().hiddenR.has(r)) continue;
    const tr = h('tr', { style: { height: `${grid.rowH(r)}px` } });
    for (let c = g.c0; c <= g.c1; c++) {
      if (sheet().hiddenC.has(c)) continue;
      const m = sheet().mergeAt(r, c);
      if (m && (m.r0 !== r || m.c0 !== c)) continue;
      const v = book.value(sheet(), r, c);
      const s = styleAt(r, c);
      const res = formatValue(v instanceof Spark ? null : v, s.fmt);
      const td = h('td', { style: { textAlign: s.align || (typeof v === 'number' ? 'right' : 'left'), fontWeight: s.bold ? '700' : '', fontStyle: s.italic ? 'italic' : '', color: res.color || s.color || '', background: s.fill || '', fontFamily: s.font ? `"${s.font}"` : '', fontSize: s.size ? `${s.size}pt` : '', whiteSpace: s.wrap ? 'pre-wrap' : 'nowrap', verticalAlign: s.valign === 'top' ? 'top' : s.valign === 'middle' ? 'middle' : 'bottom' } }, res.text);
      if (m) { td.colSpan = m.c1 - m.c0 + 1; td.rowSpan = m.r1 - m.r0 + 1; }
      if (s.border) for (const [k, side] of [['t', 'Top'], ['r', 'Right'], ['b', 'Bottom'], ['l', 'Left']]) if (s.border[k]) { const [kind, color] = s.border[k].split(' '); td.style[`border${side}`] = `${kind === 'thick' ? 3 : kind === 'medium' ? 2 : 1}px ${kind === 'double' ? 'double' : kind === 'dashed' ? 'dashed' : kind === 'dotted' ? 'dotted' : 'solid'} ${color || '#000'}`; }
      tr.append(td);
    }
    table.append(tr);
  }
  if (sheet().showGrid) table.classList.add('grid-lines');
  view.append(h('div.print-title', sheet().name), table);
  document.body.append(view);
  document.body.classList.add('printing-sheet');
  try {
    if (pdf && inElectron) {
      const f = await host.printPDF({ name: `${baseName(file.name)} - ${sheet().name}`, landscape: g.c1 - g.c0 > 7 });
      if (f) toast(`Exported ${f.name}`, { action: { label: 'Show', run: () => host.reveal(f) } });
    } else if (pdf) await host.printPDF();
    else await host.print();
  } catch (err) { errorToast(err); } finally {
    document.body.classList.remove('printing-sheet');
    view.remove();
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const start = startScreen({
  shell, title: 'Start a new workbook', thumbRatio: 1.25,
  templates: TEMPLATES.map((t) => ({ ...t, thumb: () => templateThumb(t) })),
  onTemplate: (t) => newBook(t), onOpen: () => openDialog(), onRecent: (r) => openRecent(r),
});
shell.titlebar.querySelector('.menubar button').addEventListener('pointerdown', refreshRecent, true);

guardClose({ dirty: () => file.opened && book.dirty, save: () => save(), name: () => file.name });
onDropFiles((files) => {
  const ok = files.filter((f) => FILTERS[0].exts.includes(extOf(f.name)));
  ok.forEach((f, i) => openFile(f, { here: i === 0 && pristine() }));
}, 'Drop spreadsheets or CSV files to open them');
host.onOpen((files) => files.forEach((f) => openFile(f)));

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && painter) { painter = null; refresh(); }
});

// Crash recovery.
let lastBackup = -1;
setInterval(() => {
  if (!file.opened || !book.dirty || book.version === lastBackup) return;
  lastBackup = book.version;
  host.recovery.put(file.id, { name: file.name, data: toSnake(book), time: Date.now() }).catch(() => {});
}, 15000);

if (!settings.get('formulaBar', true)) formulaBar.classList.add('hidden');
book.onChange(() => { updateTitle(); refresh(); });
drawTabs();

(async () => {
  const params = new URLSearchParams(location.search);
  const recovered = await host.recovery.list().catch(() => []);
  if (recovered.length) {
    const box = h('div.recover', h('h2', 'Recovered workbooks'));
    for (const r of recovered.sort((a, b) => b.time - a.time).slice(0, 8)) {
      const rec = await host.recovery.get(r.key).catch(() => null);
      if (!rec || !rec.value) continue;
      const row = h('div.list-item', h('span', { html: icon('history', 18) }), h('div.grow', h('div', rec.value.name || 'Untitled'), h('div.dir', `Unsaved changes from ${new Date(rec.time).toLocaleString()}`)));
      const keep = h('button.btn.small.primary', 'Open');
      const drop = h('button.btn.small', 'Discard');
      keep.addEventListener('click', () => { useBook(fromSnake(rec.value.data), { name: rec.value.name || 'Recovered' }); book.savedAt = -1; updateTitle(); host.recovery.delete(r.key); });
      drop.addEventListener('click', () => { host.recovery.delete(r.key); row.remove(); });
      row.append(keep, drop);
      box.append(row);
    }
    if (box.children.length > 1) start.el.querySelector('.start-main').prepend(box);
  }
  if (shell.info.files && shell.info.files.length) await openFile(shell.info.files[0], { here: true });
  else if (params.get('new')) newBook(TEMPLATES.find((x) => x.id === params.get('new')) || TEMPLATES[0]);
})();

window.snakeApp = { get book() { return book; }, grid, commands, charts, readXlsx, writeXlsx, fromSnake, toSnake, useBook };
