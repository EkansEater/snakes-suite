// Files for Snake's Spreadsheets: Excel .xlsx (read and write), CSV/TSV, and our
// own .snakesheet (everything, as JSON). Written from the Office Open XML spec.
import { readZip, writeZip } from '../../kit/zip.js';
import { esc, parseXml, all, first, kids, kid, attr, XML_HEAD } from '../../kit/xml.js';
import { Book, key, rowOf, colOf, DEF_W, DEF_H } from './engine.js';
import { parseAddr, colName, shiftFormula, err, isErr, MAX_COLS } from './formula.js';
import { formatValue } from './numfmt.js';

// ===========================================================================
// CSV
// ===========================================================================
export function detectDelimiter(text) {
  const sample = text.split(/\r?\n/).slice(0, 20).join('\n');
  let best = ',';
  let bestScore = -1;
  for (const d of [',', '\t', ';', '|']) {
    const counts = sample.split('\n').filter(Boolean).map((l) => l.split(d).length - 1);
    if (!counts.length) continue;
    const avg = counts.reduce((a, b) => a + b, 0) / counts.length;
    const steady = counts.every((c) => c === counts[0]) ? 2 : 1;
    const score = avg * steady;
    if (score > bestScore) { bestScore = score; best = d; }
  }
  return best;
}

export function parseCSV(text, delimiter = null) {
  const d = delimiter || detectDelimiter(text);
  const rows = [];
  let row = [];
  let field = '';
  let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else q = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') { q = true; continue; }
    if (ch === d) { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function toCSV(book, sh, delimiter = ',', g = null) {
  const u = g || { r0: 0, c0: 0, r1: sh.used().r, c1: sh.used().c };
  const lines = [];
  for (let r = u.r0; r <= u.r1; r++) {
    const out = [];
    for (let c = u.c0; c <= u.c1; c++) {
      const v = book.value(sh, r, c);
      const cell = sh.get(r, c);
      const fmt = book.styles.get(cell ? cell.s : 0).fmt;
      let s = v === null ? '' : typeof v === 'number' && fmt && !/^(general|0|#,##0)/i.test(fmt) && /[dmyhs]/i.test(fmt) ? formatValue(v, fmt).text : isErr(v) ? v.code : typeof v === 'object' ? String(v.text ?? v) : String(typeof v === 'number' ? +v.toPrecision(15) : v);
      if (s.includes(delimiter) || s.includes('"') || s.includes('\n') || /^\s|\s$/.test(s)) s = `"${s.replace(/"/g, '""')}"`;
      out.push(s);
    }
    lines.push(out.join(delimiter));
  }
  return `${lines.join('\r\n')}\r\n`;
}

export function bookFromCSV(text, name = 'Sheet1', delimiter = null) {
  const book = new Book();
  const sh = book.addSheet(name.replace(/\.[^.]+$/, '').slice(0, 31) || 'Sheet1');
  const rows = parseCSV(text, delimiter);
  rows.forEach((row, r) => row.forEach((v, c) => {
    if (v === '') return;
    // CSV text is data, never formulas (a classic way to smuggle commands into sheets).
    const fmt = book.input(sh, r, c, v.startsWith('=') ? `'${v}` : v);
    if (fmt) book.setStyle(sh, r, c, book.styles.id({ fmt }));
  }));
  book.undoStack = [];
  book.calc.rebuild();
  return book;
}

// ===========================================================================
// Our own format: everything, as JSON
// ===========================================================================
export function toSnake(book) {
  return JSON.stringify({
    format: 'snakesheet', version: 1, app: "Snake's Spreadsheets",
    styles: book.styles.list,
    names: [...book.names.values()],
    sheets: book.sheets.map((sh) => ({
      name: sh.name, props: sh.props(),
      cells: [...sh.cells].map(([k, c]) => [rowOf(k), colOf(k), c.f ? `=${c.f}` : c.v, c.s || 0, c.note || null].map((x) => (x === undefined ? null : x))),
    })),
  });
}

export function fromSnake(text) {
  const j = JSON.parse(text);
  if (j.format !== 'snakesheet') throw new Error("This is not a Snake's Spreadsheets file.");
  const book = new Book();
  book.styles.list = [];
  book.styles.index = new Map();
  for (const s of j.styles || [{}]) book.styles.id(s);
  if (!book.styles.list.length) book.styles.id({});
  for (const n of j.names || []) book.names.set(n.name.toUpperCase(), n);
  for (const s of j.sheets) {
    const sh = book.addSheet(s.name);
    sh.setProps({ ...s.props, name: s.name });
    for (const [r, c, v, st, note] of s.cells) {
      const cell = { v: null, f: null, s: st || 0 };
      if (typeof v === 'string' && v.startsWith('=')) cell.f = v.slice(1);
      else cell.v = v;
      if (note) cell.note = note;
      sh.cells.set(key(r, c), cell);
    }
  }
  if (!book.sheets.length) book.addSheet('Sheet1');
  book.calc.rebuild();
  return book;
}

// ===========================================================================
// XLSX: reading
// ===========================================================================
const BUILTIN_FMT = {
  0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 11: '0.00E+00', 12: '# ?/?', 13: '# ??/??',
  14: 'm/d/yyyy', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 18: 'h:mm AM/PM', 19: 'h:mm:ss AM/PM', 20: 'h:mm', 21: 'h:mm:ss', 22: 'm/d/yyyy h:mm',
  37: '#,##0 ;(#,##0)', 38: '#,##0 ;[Red](#,##0)', 39: '#,##0.00;(#,##0.00)', 40: '#,##0.00;[Red](#,##0.00)', 45: 'mm:ss', 46: '[h]:mm:ss', 47: 'mm:ss.0', 48: '##0.0E+0', 49: '@',
};
const INDEXED = ['000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF', '000000', 'FFFFFF', 'FF0000', '00FF00', '0000FF', 'FFFF00', 'FF00FF', '00FFFF', '800000', '008000', '000080', '808000', '800080', '008080', 'C0C0C0', '808080', '9999FF', '993366', 'FFFFCC', 'CCFFFF', '660066', 'FF8080', '0066CC', 'CCCCFF', '000080', 'FF00FF', 'FFFF00', '00FFFF', '800080', '800000', '008080', '0000FF', '00CCFF', 'CCFFFF', 'CCFFCC', 'FFFF99', '99CCFF', 'FF99CC', 'CC99FF', 'FFCC99', '3366FF', '33CCCC', '99CC00', 'FFCC00', 'FF9900', 'FF6600', '666699', '969696', '003366', '339966', '003300', '333300', '993300', '993366', '333399', '333333'];

function tintColor(hex, tint) {
  if (!tint) return hex;
  const n = parseInt(hex, 16);
  const ch = [n >> 16, (n >> 8) & 255, n & 255].map((v) => (tint < 0 ? v * (1 + tint) : v + (255 - v) * tint));
  return ch.map((v) => Math.round(v).toString(16).padStart(2, '0')).join('').toUpperCase();
}

const FUTURE = ['FILTER', 'SORT', 'SORTBY', 'UNIQUE', 'SEQUENCE', 'RANDARRAY', 'XLOOKUP', 'XMATCH', 'LET', 'IFS', 'SWITCH', 'CONCAT', 'TEXTJOIN', 'MAXIFS', 'MINIFS',
  'STDEV.S', 'STDEV.P', 'VAR.S', 'VAR.P', 'MODE.SNGL', 'PERCENTILE.INC', 'PERCENTILE.EXC', 'QUARTILE.INC', 'RANK.EQ', 'RANK.AVG', 'CEILING.MATH', 'FLOOR.MATH',
  'IFNA', 'DAYS', 'ISOWEEKNUM', 'NUMBERVALUE', 'UNICHAR', 'UNICODE', 'FORECAST.LINEAR', 'NORM.DIST', 'COVARIANCE.S', 'COVARIANCE.P', 'TEXTBEFORE', 'TEXTAFTER',
  'TEXTSPLIT', 'VSTACK', 'HSTACK', 'TAKE', 'DROP', 'XOR', 'SHEET', 'FORMULATEXT', 'ISFORMULA'];
const WS = new Set(['FILTER', 'SORT', 'SORTBY']);

export function toExcelFormula(f) {
  return f.replace(/\b([A-Z][A-Z0-9.]*)\(/g, (m, name) => (FUTURE.includes(name) ? `_xlfn.${WS.has(name) ? '_xlws.' : ''}${name}(` : m));
}
export function fromExcelFormula(f) {
  return f.replace(/_xlfn\.(_xlws\.)?/g, '').replace(/_xll\./g, '').replace(/@(?=[A-Za-z_(])/g, '');
}

export async function readXlsx(bytes) {
  const zip = readZip(bytes);
  const text = async (n) => (zip.has(n) ? zip.get(n).text() : null);
  const wbXml = await text('xl/workbook.xml');
  if (!wbXml) throw new Error('This file has no workbook in it.');
  const wb = parseXml(wbXml);
  const relsDoc = parseXml((await text('xl/_rels/workbook.xml.rels')) || '<Relationships/>');
  const rels = {};
  for (const r of all(relsDoc, 'Relationship')) rels[r.getAttribute('Id')] = r.getAttribute('Target');
  const book = new Book();

  // Theme colours.
  const theme = [];
  const themeXml = await text('xl/theme/theme1.xml');
  if (themeXml) {
    const scheme = first(parseXml(themeXml), 'clrScheme');
    for (const n of ['lt1', 'dk1', 'lt2', 'dk2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6', 'hlink', 'folHlink']) {
      const el = scheme ? first(scheme, n) : null;
      const c = el ? (first(el, 'srgbClr') ? attr(first(el, 'srgbClr'), 'val') : first(el, 'sysClr') ? attr(first(el, 'sysClr'), 'lastClr') : null) : null;
      theme.push(c || '000000');
    }
  }
  const colorOf = (el) => {
    if (!el) return null;
    let hex = null;
    if (attr(el, 'rgb')) hex = attr(el, 'rgb').slice(-6);
    else if (attr(el, 'theme') !== null) hex = theme[Number(attr(el, 'theme'))] || null;
    else if (attr(el, 'indexed') !== null) { const i = Number(attr(el, 'indexed')); hex = i === 64 ? null : INDEXED[i] || null; }
    if (!hex) return null;
    return `#${tintColor(hex, Number(attr(el, 'tint') || 0)).toLowerCase()}`;
  };

  // Shared strings.
  const strings = [];
  const ssXml = await text('xl/sharedStrings.xml');
  if (ssXml) for (const si of all(parseXml(ssXml), 'si')) strings.push(all(si, 't').filter((t) => !t.closest || !t.parentNode || t.parentNode.localName !== 'rPh').map((t) => t.textContent).join(''));

  // Styles.
  const xfStyle = [];
  const stylesXml = await text('xl/styles.xml');
  if (stylesXml) {
    const sd = parseXml(stylesXml);
    const fmts = { ...BUILTIN_FMT };
    for (const nf of all(first(sd, 'numFmts'), 'numFmt')) fmts[attr(nf, 'numFmtId')] = attr(nf, 'formatCode');
    const fonts = all(first(sd, 'fonts'), 'font').map((f) => ({
      font: kid(f, 'name') ? attr(kid(f, 'name'), 'val') : null, size: kid(f, 'sz') ? Number(attr(kid(f, 'sz'), 'val')) : null,
      bold: !!kid(f, 'b') && attr(kid(f, 'b'), 'val') !== '0', italic: !!kid(f, 'i') && attr(kid(f, 'i'), 'val') !== '0',
      underline: !!kid(f, 'u') && attr(kid(f, 'u'), 'val') !== 'none', strike: !!kid(f, 'strike') && attr(kid(f, 'strike'), 'val') !== '0', color: colorOf(kid(f, 'color')),
    }));
    const fills = all(first(sd, 'fills'), 'fill').map((f) => {
      const p = kid(f, 'patternFill');
      if (!p || !attr(p, 'patternType') || attr(p, 'patternType') === 'none') return null;
      return colorOf(kid(p, 'fgColor')) || colorOf(kid(p, 'bgColor'));
    });
    const borders = all(first(sd, 'borders'), 'border').map((b) => {
      const out = {};
      for (const [side, k] of [['top', 't'], ['right', 'r'], ['bottom', 'b'], ['left', 'l']]) {
        const e = kid(b, side);
        const st = e && attr(e, 'style');
        if (st && st !== 'none') {
          const kind = /thick/.test(st) ? 'thick' : /medium/.test(st) ? 'medium' : /dash/.test(st) ? 'dashed' : /dot|hair/.test(st) ? 'dotted' : st === 'double' ? 'double' : 'thin';
          out[k] = `${kind} ${colorOf(kid(e, 'color')) || '#000000'}`;
        }
      }
      return Object.keys(out).length ? out : null;
    });
    const defaultFont = fonts[0] || {};
    for (const xf of all(first(sd, 'cellXfs'), 'xf')) {
      const st = {};
      const fmt = fmts[attr(xf, 'numFmtId') || '0'];
      if (fmt && !/^general$/i.test(fmt)) st.fmt = fmt;
      const f = fonts[Number(attr(xf, 'fontId') || 0)] || {};
      if (f.font && f.font !== defaultFont.font) st.font = f.font;
      if (f.size && f.size !== 11) st.size = f.size;
      if (f.bold) st.bold = true;
      if (f.italic) st.italic = true;
      if (f.underline) st.underline = true;
      if (f.strike) st.strike = true;
      if (f.color && f.color !== '#000000') st.color = f.color;
      const fill = fills[Number(attr(xf, 'fillId') || 0)];
      if (fill) st.fill = fill;
      const bd = borders[Number(attr(xf, 'borderId') || 0)];
      if (bd) st.border = bd;
      const al = kid(xf, 'alignment');
      if (al) {
        const hz = attr(al, 'horizontal');
        if (['left', 'center', 'right'].includes(hz)) st.align = hz;
        if (hz === 'centerContinuous') st.align = 'center';
        const vt = attr(al, 'vertical');
        if (vt === 'top' || vt === 'center') st.valign = vt === 'center' ? 'middle' : 'top';
        if (attr(al, 'wrapText') === '1') st.wrap = true;
        if (attr(al, 'indent')) st.indent = Number(attr(al, 'indent'));
      }
      xfStyle.push(book.styles.id(st));
    }
  }

  // Sheets.
  const sheetEls = all(first(wb, 'sheets'), 'sheet');
  for (const se of sheetEls) {
    const name = attr(se, 'name');
    const target = rels[attr(se, 'id')];
    if (!target) continue;
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    const xml = await text(path);
    if (!xml) continue;
    const sh = book.addSheet(name);
    if (attr(se, 'state') === 'hidden' || attr(se, 'state') === 'veryHidden') sh.hidden = true;
    const doc = parseXml(xml);
    const view = first(doc, 'sheetView');
    if (view && attr(view, 'showGridLines') === '0') sh.showGrid = false;
    const pane = first(doc, 'pane');
    if (pane && (attr(pane, 'state') === 'frozen' || attr(pane, 'state') === 'frozenSplit')) sh.freeze = { r: Number(attr(pane, 'ySplit') || 0), c: Number(attr(pane, 'xSplit') || 0) };
    const tab = first(doc, 'tabColor');
    if (tab) sh.tab = colorOf(tab) || '';
    for (const col of all(first(doc, 'cols'), 'col')) {
      const min = Number(attr(col, 'min')) - 1;
      const max = Math.min(Number(attr(col, 'max')) - 1, min + 500);
      const w = attr(col, 'width');
      for (let c = min; c <= max; c++) {
        if (w && attr(col, 'customWidth') !== '0') sh.colW.set(c, Math.round(Number(w) * 7 + 5));
        if (attr(col, 'hidden') === '1') sh.hiddenC.add(c);
      }
    }
    const shared = new Map();
    for (const row of all(first(doc, 'sheetData'), 'row')) {
      const r = Number(attr(row, 'r')) - 1;
      if (attr(row, 'ht') && attr(row, 'customHeight') === '1') sh.rowH.set(r, Math.round(Number(attr(row, 'ht')) / 0.75));
      if (attr(row, 'hidden') === '1') sh.hiddenR.add(r);
      for (const c of kids(row, 'c')) {
        const p = parseAddr(attr(c, 'r'));
        if (!p) continue;
        const t = attr(c, 't');
        const s = xfStyle[Number(attr(c, 's') || 0)] || 0;
        const fEl = kid(c, 'f');
        const vEl = kid(c, 'v');
        const cell = { v: null, f: null, s };
        if (fEl) {
          let f = fEl.textContent;
          const si = attr(fEl, 'si');
          if (attr(fEl, 't') === 'shared' && si !== null) {
            if (f) shared.set(si, { f, r: p.r, c: p.c });
            else if (shared.has(si)) { const m = shared.get(si); f = shiftFormula(m.f, p.r - m.r, p.c - m.c); }
          }
          if (f) cell.f = fromExcelFormula(f);
        }
        if (!cell.f) {
          const raw = vEl ? vEl.textContent : null;
          if (t === 's') cell.v = strings[Number(raw)] ?? '';
          else if (t === 'inlineStr') cell.v = all(c, 't').map((x) => x.textContent).join('');
          else if (t === 'b') cell.v = raw === '1';
          else if (t === 'e') cell.v = raw;
          else if (t === 'str') cell.v = raw ?? '';
          else if (raw !== null) cell.v = Number(raw);
        }
        if (cell.v === null && !cell.f && !s) continue;
        sh.cells.set(key(p.r, p.c), cell);
      }
    }
    for (const m of all(first(doc, 'mergeCells'), 'mergeCell')) {
      const [a, b] = attr(m, 'ref').split(':');
      const A = parseAddr(a);
      const B = parseAddr(b || a);
      if (A && B) sh.merges.push({ r0: A.r, c0: A.c, r1: B.r, c1: B.c });
    }
    const af = first(doc, 'autoFilter');
    if (af) {
      const [a, b] = attr(af, 'ref').split(':');
      const A = parseAddr(a);
      const B = parseAddr(b || a);
      if (A && B) sh.filter = { r0: A.r, c0: A.c, r1: B.r, c1: B.c, crit: {} };
    }
    for (const dv of all(first(doc, 'dataValidations'), 'dataValidation')) {
      if (attr(dv, 'type') !== 'list') continue;
      const f1 = kid(dv, 'formula1') ? kid(dv, 'formula1').textContent : '';
      for (const ref of (attr(dv, 'sqref') || '').split(' ')) {
        const [a, b] = ref.split(':');
        const A = parseAddr(a);
        const B = parseAddr(b || a);
        if (!A || !B) continue;
        const list = /^".*"$/.test(f1) ? f1.slice(1, -1).split(',') : null;
        sh.valid.push({ range: { r0: A.r, c0: A.c, r1: B.r, c1: B.c }, type: 'list', list, source: list ? null : f1 });
      }
    }
    for (const cf of all(doc, 'conditionalFormatting')) {
      const ref = (attr(cf, 'sqref') || '').split(' ')[0];
      const [a, b] = ref.split(':');
      const A = parseAddr(a);
      const B = parseAddr(b || a);
      if (!A || !B) continue;
      const range = { r0: A.r, c0: A.c, r1: B.r, c1: B.c };
      for (const rule of kids(cf, 'cfRule')) {
        const type = attr(rule, 'type');
        if (type === 'colorScale') {
          const colors = all(rule, 'color').map(colorOf).filter(Boolean);
          if (colors.length >= 2) sh.cf.push({ range, type: 'scale', colors });
        } else if (type === 'dataBar') sh.cf.push({ range, type: 'bar', color: colorOf(first(rule, 'color')) || '#3fb950' });
        else if (type === 'duplicateValues') sh.cf.push({ range, type: 'dup', style: { fill: '#fde8e8', color: '#9c0006' } });
        else if (type === 'cellIs') {
          const op = attr(rule, 'operator');
          const fs = all(rule, 'formula').map((x) => Number(x.textContent));
          const map = { greaterThan: 'gt', lessThan: 'lt', between: 'between', equal: 'eq' };
          if (map[op]) sh.cf.push({ range, type: map[op], a: fs[0], b: fs[1], style: { fill: '#fde8e8', color: '#9c0006' } });
        }
      }
    }
  }
  for (const dn of all(first(wb, 'definedNames'), 'definedName')) {
    const n = attr(dn, 'name');
    if (!n || n.startsWith('_xlnm')) continue;
    book.names.set(n.toUpperCase(), { name: n, ref: dn.textContent });
  }
  if (!book.sheets.length) book.addSheet('Sheet1');
  book.calc.rebuild();
  return book;
}

// ===========================================================================
// XLSX: writing
// ===========================================================================
export async function writeXlsx(book) {
  const strings = [];
  const stringIndex = new Map();
  const sIdx = (s) => {
    let i = stringIndex.get(s);
    if (i === undefined) { i = strings.length; strings.push(s); stringIndex.set(s, i); }
    return i;
  };
  // Styles: our style ids -> xf indexes.
  const numFmts = new Map();
  const builtinByCode = Object.fromEntries(Object.entries(BUILTIN_FMT).map(([k, v]) => [v, Number(k)]));
  const fonts = ['<font><sz val="11"/><name val="Calibri"/><family val="2"/></font>'];
  const fills = ['<fill><patternFill patternType="none"/></fill>', '<fill><patternFill patternType="gray125"/></fill>'];
  const borders = ['<border><left/><right/><top/><bottom/><diagonal/></border>'];
  const xfs = ['<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'];
  const xfOf = new Map([[0, 0]]);
  const idx = (list, xml) => { let i = list.indexOf(xml); if (i < 0) { i = list.length; list.push(xml); } return i; };
  const hex = (c) => `FF${String(c || '#000000').replace('#', '').slice(0, 6).toUpperCase().padStart(6, '0')}`;
  const xfFor = (sid) => {
    if (xfOf.has(sid)) return xfOf.get(sid);
    const st = book.styles.get(sid);
    let fmtId = 0;
    if (st.fmt) {
      if (builtinByCode[st.fmt] !== undefined) fmtId = builtinByCode[st.fmt];
      else { if (!numFmts.has(st.fmt)) numFmts.set(st.fmt, 164 + numFmts.size); fmtId = numFmts.get(st.fmt); }
    }
    const font = `<font>${st.bold ? '<b/>' : ''}${st.italic ? '<i/>' : ''}${st.strike ? '<strike/>' : ''}${st.underline ? '<u/>' : ''}<sz val="${st.size || 11}"/>${st.color ? `<color rgb="${hex(st.color)}"/>` : ''}<name val="${esc(st.font || 'Calibri')}"/><family val="2"/></font>`;
    const fontId = idx(fonts, font);
    const fillId = st.fill ? idx(fills, `<fill><patternFill patternType="solid"><fgColor rgb="${hex(st.fill)}"/><bgColor indexed="64"/></patternFill></fill>`) : 0;
    let borderId = 0;
    if (st.border) {
      const side = (name, k) => {
        const spec = st.border[k];
        if (!spec) return `<${name}/>`;
        const [kind, color] = spec.split(' ');
        const xs = { thick: 'thick', medium: 'medium', dashed: 'dashed', dotted: 'dotted', double: 'double' }[kind] || 'thin';
        return `<${name} style="${xs}"><color rgb="${hex(color)}"/></${name}>`;
      };
      borderId = idx(borders, `<border>${side('left', 'l')}${side('right', 'r')}${side('top', 't')}${side('bottom', 'b')}<diagonal/></border>`);
    }
    const align = st.align || st.valign || st.wrap || st.indent ? `<alignment${st.align ? ` horizontal="${st.align}"` : ''}${st.valign ? ` vertical="${st.valign === 'middle' ? 'center' : st.valign}"` : ''}${st.wrap ? ' wrapText="1"' : ''}${st.indent ? ` indent="${st.indent}"` : ''}/>` : '';
    const xf = `<xf numFmtId="${fmtId}" fontId="${fontId}" fillId="${fillId}" borderId="${borderId}" xfId="0"${fmtId ? ' applyNumberFormat="1"' : ''}${fontId ? ' applyFont="1"' : ''}${fillId ? ' applyFill="1"' : ''}${borderId ? ' applyBorder="1"' : ''}${align ? ' applyAlignment="1">' + align + '</xf>' : '/>'}`;
    const i = idx(xfs, xf);
    xfOf.set(sid, i);
    return i;
  };

  const sheetFiles = [];
  book.sheets.forEach((sh, si) => {
    const u = sh.used();
    const rows = new Map();
    for (const [k, cell] of sh.cells) {
      const r = rowOf(k);
      if (!rows.has(r)) rows.set(r, []);
      rows.get(r).push([colOf(k), cell]);
    }
    for (const [k, v] of sh.spill) {
      const r = rowOf(k);
      if (!rows.has(r)) rows.set(r, []);
      if (!rows.get(r).some(([c]) => c === colOf(k))) rows.get(r).push([colOf(k), { spillValue: v, s: 0 }]);
    }
    for (const [r] of sh.rowH) if (!rows.has(r)) rows.set(r, []);
    for (const r of sh.hiddenR) if (!rows.has(r)) rows.set(r, []);
    const anchors = new Map();
    for (const a of book.calc.anchors.values()) if (a.sh === sh) anchors.set(key(a.r, a.c), a);
    let data = '';
    for (const r of [...rows.keys()].sort((a, b) => a - b)) {
      const cells = rows.get(r).sort((a, b) => a[0] - b[0]);
      const ht = sh.rowH.get(r);
      data += `<row r="${r + 1}"${ht !== undefined ? ` ht="${(ht * 0.75).toFixed(2)}" customHeight="1"` : ''}${sh.hiddenR.has(r) ? ' hidden="1"' : ''}>`;
      for (const [c, cell] of cells) {
        const ref = `${colName(c)}${r + 1}`;
        const s = cell.s ? ` s="${xfFor(cell.s)}"` : '';
        const v = cell.spillValue !== undefined ? cell.spillValue : cell.f ? book.value(sh, r, c) : cell.v;
        let fx = '';
        if (cell.f) {
          const a = anchors.get(key(r, c));
          fx = a ? `<f t="array" ref="${ref}:${colName(c + a.cols - 1)}${r + a.rows}">${esc(toExcelFormula(cell.f))}</f>` : `<f>${esc(toExcelFormula(cell.f))}</f>`;
        }
        if (v === null || v === undefined || v === '') { data += `<c r="${ref}"${s}>${fx}</c>`; continue; }
        if (typeof v === 'number') data += `<c r="${ref}"${s}>${fx}<v>${Number.isFinite(v) ? v : 0}</v></c>`;
        else if (typeof v === 'boolean') data += `<c r="${ref}"${s} t="b">${fx}<v>${v ? 1 : 0}</v></c>`;
        else if (isErr(v)) data += `<c r="${ref}"${s} t="e">${fx}<v>${esc(['#SPILL!', '#CALC!', '#CIRC!'].includes(v.code) ? '#VALUE!' : v.code)}</v></c>`;
        else if (cell.f) data += `<c r="${ref}"${s} t="str">${fx}<v>${esc(String(typeof v === 'object' ? v.text ?? '' : v))}</v></c>`;
        else data += `<c r="${ref}"${s} t="s"><v>${sIdx(String(typeof v === 'object' ? v.text ?? '' : v))}</v></c>`;
      }
      data += '</row>';
    }
    const colKeys = [...new Set([...sh.colW.keys(), ...sh.hiddenC])].sort((a, b) => a - b);
    const cols = colKeys.length ? `<cols>${colKeys.map((c) => `<col min="${c + 1}" max="${c + 1}" width="${Math.max(0, ((sh.colW.get(c) ?? DEF_W) - 5) / 7).toFixed(2)}" customWidth="1"${sh.hiddenC.has(c) ? ' hidden="1"' : ''}/>`).join('')}</cols>` : `<sheetFormatPr defaultRowHeight="${(DEF_H * 0.75).toFixed(1)}"/>`;
    const fz = sh.freeze;
    const pane = fz.r || fz.c ? `<pane${fz.c ? ` xSplit="${fz.c}"` : ''}${fz.r ? ` ySplit="${fz.r}"` : ''} topLeftCell="${colName(fz.c)}${fz.r + 1}" activePane="${fz.r && fz.c ? 'bottomRight' : fz.r ? 'bottomLeft' : 'topRight'}" state="frozen"/>` : '';
    const view = `<sheetViews><sheetView${si === 0 ? ' tabSelected="1"' : ''}${sh.showGrid ? '' : ' showGridLines="0"'} workbookViewId="0">${pane}</sheetView></sheetViews>`;
    const merges = sh.merges.length ? `<mergeCells count="${sh.merges.length}">${sh.merges.map((m) => `<mergeCell ref="${colName(m.c0)}${m.r0 + 1}:${colName(m.c1)}${m.r1 + 1}"/>`).join('')}</mergeCells>` : '';
    const filter = sh.filter ? `<autoFilter ref="${colName(sh.filter.c0)}${sh.filter.r0 + 1}:${colName(sh.filter.c1)}${sh.filter.r1 + 1}"/>` : '';
    const rng = (g) => `${colName(g.c0)}${g.r0 + 1}:${colName(g.c1)}${g.r1 + 1}`;
    let dvs = '';
    const lists = sh.valid.filter((v) => v.type === 'list');
    if (lists.length) {
      dvs = `<dataValidations count="${lists.length}">${lists.map((v) => `<dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="${rng(v.range)}"><formula1>${esc(v.list ? `"${v.list.join(',')}"` : v.source || '')}</formula1></dataValidation>`).join('')}</dataValidations>`;
    }
    const dim = `<dimension ref="A1${u.r >= 0 ? `:${colName(Math.max(0, u.c))}${u.r + 1}` : ''}"/>`;
    const tabColor = sh.tab ? `<sheetPr><tabColor rgb="${hex(sh.tab)}"/></sheetPr>` : '';
    sheetFiles.push({
      name: `xl/worksheets/sheet${si + 1}.xml`,
      data: `${XML_HEAD}<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${tabColor}${dim}${view}${colKeys.length ? `<sheetFormatPr defaultRowHeight="${(DEF_H * 0.75).toFixed(1)}"/>${cols}` : cols}<sheetData>${data}</sheetData>${filter}${merges}${dvs}<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/></worksheet>`,
    });
  });

  const fmtXml = numFmts.size ? `<numFmts count="${numFmts.size}">${[...numFmts].map(([code, id]) => `<numFmt numFmtId="${id}" formatCode="${esc(code)}"/>`).join('')}</numFmts>` : '';
  const styles = `${XML_HEAD}<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${fmtXml}<fonts count="${fonts.length}">${fonts.join('')}</fonts><fills count="${fills.length}">${fills.join('')}</fills><borders count="${borders.length}">${borders.join('')}</borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="${xfs.length}">${xfs.join('')}</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  const shared = `${XML_HEAD}<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${strings.length}" uniqueCount="${strings.length}">${strings.map((s) => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join('')}</sst>`;
  const names = [...book.names.values()];
  const wb = `${XML_HEAD}<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView/></bookViews><sheets>${book.sheets.map((sh, i) => `<sheet name="${esc(sh.name)}" sheetId="${i + 1}"${sh.hidden ? ' state="hidden"' : ''} r:id="rId${i + 1}"/>`).join('')}</sheets>${names.length ? `<definedNames>${names.map((n) => `<definedName name="${esc(n.name)}">${esc(n.ref.replace(/^=/, ''))}</definedName>`).join('')}</definedNames>` : ''}<calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>`;
  const n = book.sheets.length;
  const wbRels = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${book.sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('')}<Relationship Id="rId${n + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId${n + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>`;
  const ct = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>${book.sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('')}<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  return writeZip([
    { name: '[Content_Types].xml', data: ct },
    { name: '_rels/.rels', data: `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: wb },
    { name: 'xl/_rels/workbook.xml.rels', data: wbRels },
    { name: 'xl/styles.xml', data: styles },
    { name: 'xl/sharedStrings.xml', data: shared },
    ...sheetFiles,
    { name: 'docProps/core.xml', data: `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>` },
    { name: 'docProps/app.xml', data: `${XML_HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Snake's Spreadsheets</Application></Properties>` },
  ]);
}

export { err, MAX_COLS };
