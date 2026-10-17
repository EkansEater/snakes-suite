// The parts of an Excel workbook around the cells: charts (DrawingML), notes (comments
// with their VML boxes), conditional formatting and data validation. Reading and writing,
// from the Office Open XML spec (ECMA-376).
import { esc, parseXml, all, first, kids, kid, attr, XML_HEAD } from '../../kit/xml.js';
import { DEF_W, DEF_H } from './engine.js';
import { parseAddr, parseRange, colName, quoteSheet } from './formula.js';

const EMU = 9525; // per pixel
export const NS_REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL = {
  drawing: `${NS_REL}/drawing`, chart: `${NS_REL}/chart`, comments: `${NS_REL}/comments`, vml: `${NS_REL}/vmlDrawing`, link: `${NS_REL}/hyperlink`,
};
export const CT = {
  drawing: 'application/vnd.openxmlformats-officedocument.drawing+xml',
  chart: 'application/vnd.openxmlformats-officedocument.drawingml.chart+xml',
  comments: 'application/vnd.openxmlformats-officedocument.spreadsheetml.comments+xml',
  vml: 'application/vnd.openxmlformats-officedocument.vmlDrawing',
};

/** "Sheet 1"!$A$2:$A$7 -> { sheet, g } (sheet null when not named). */
export function splitRef(ref) {
  const m = /^(?:'((?:[^']|'')+)'|([^'!]+))?!?(.*)$/.exec(String(ref || '').trim().replace(/^=/, ''));
  if (!m) return null;
  const hasSheet = String(ref).includes('!');
  const sheet = hasSheet ? (m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2]) : null;
  const g = parseRange((hasSheet ? m[3] : String(ref).replace(/^=/, '')).replace(/\$/g, ''));
  return g ? { sheet, g } : null;
}
const absRef = (sheetName, g) => `${quoteSheet(sheetName)}!$${colName(g.c0)}$${g.r0 + 1}${g.r0 === g.r1 && g.c0 === g.c1 ? '' : `:$${colName(g.c1)}$${g.r1 + 1}`}`;

// Pixel position of a column or row edge, as the grid lays them out.
const colX = (sh, c) => { let x = 0; for (let i = 0; i < c; i++) x += sh.hiddenC.has(i) ? 0 : (sh.colW.get(i) ?? DEF_W); return x; };
const rowY = (sh, r) => { let y = 0; for (let i = 0; i < r; i++) y += sh.hiddenR.has(i) ? 0 : (sh.rowH.get(i) ?? DEF_H); return y; };
function cellAt(sh, x, y) {
  let c = 0;
  let cx = 0;
  while (c < 16000) { const w = sh.hiddenC.has(c) ? 0 : (sh.colW.get(c) ?? DEF_W); if (cx + w > x) break; cx += w; c++; }
  let r = 0;
  let ry = 0;
  while (r < 1048000) { const hh = sh.hiddenR.has(r) ? 0 : (sh.rowH.get(r) ?? DEF_H); if (ry + hh > y) break; ry += hh; r++; }
  return { c, dx: Math.max(0, x - cx), r, dy: Math.max(0, y - ry) };
}

// ===========================================================================
// Reading
// ===========================================================================
export function relsMap(xml) {
  const map = {};
  if (!xml) return map;
  for (const r of all(parseXml(xml), 'Relationship')) map[attr(r, 'Id')] = { target: attr(r, 'Target'), type: attr(r, 'Type'), external: attr(r, 'TargetMode') === 'External' };
  return map;
}
/** A part's path from a relationship target, relative to the part that refers to it. */
export function resolvePath(from, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = from.split('/').slice(0, -1);
  for (const p of target.split('/')) {
    if (p === '..') parts.pop();
    else if (p !== '.') parts.push(p);
  }
  return parts.join('/');
}

const CHART_KIND = { barChart: 'column', bar3DChart: 'column', lineChart: 'line', line3DChart: 'line', areaChart: 'area', area3DChart: 'area', pieChart: 'pie', pie3DChart: 'pie', doughnutChart: 'doughnut', scatterChart: 'scatter' };

/** Charts in a sheet's drawing: the chart model of Snake's Spreadsheets (with Excel's own references). */
export async function readCharts(text, drawingPath, sh) {
  const xml = await text(drawingPath);
  if (!xml) return [];
  const rels = relsMap(await text(resolvePath(drawingPath, `_rels/${drawingPath.split('/').pop()}.rels`)));
  const out = [];
  for (const anchor of [...all(parseXml(xml), 'twoCellAnchor'), ...all(parseXml(xml), 'oneCellAnchor')]) {
    const chartEl = first(anchor, 'chart');
    const rid = chartEl ? attr(chartEl, 'id') : null;
    if (!rid || !rels[rid]) continue;
    const chartXml = await text(resolvePath(drawingPath, rels[rid].target));
    if (!chartXml) continue;
    const cx = parseXml(chartXml);
    const plot = first(cx, 'plotArea');
    const kindEl = plot ? kids(plot).find((k) => CHART_KIND[k.localName]) : null;
    if (!kindEl) continue;
    let type = CHART_KIND[kindEl.localName];
    if (type === 'column') {
      const dir = val(kindEl, 'barDir');
      const grouping = val(kindEl, 'grouping');
      type = dir === 'bar' ? 'bar' : /stacked/i.test(grouping || '') ? 'stacked' : 'column';
    }
    const series = kids(kindEl, 'ser').map((s) => {
      const f = (name) => { const el = kid(s, name); const ff = el ? first(el, 'f') : null; return ff ? ff.textContent : null; };
      const txEl = kid(s, 'tx');
      const nameLit = txEl ? all(txEl, 'v').map((v) => v.textContent).join('') || all(txEl, 't').map((t) => t.textContent).join('') : '';
      return { name: nameLit, nameRef: f('tx'), values: f('val') || f('yVal'), x: f('xVal'), cats: f('cat') };
    }).filter((s) => s.values);
    if (!series.length) continue;
    const titleEl = kid(first(cx, 'chart'), 'title');
    const title = titleEl ? all(titleEl, 't').map((t) => t.textContent).join('') : '';
    // Where it sits: from its anchor cells and offsets.
    const from = kid(anchor, 'from');
    const to = kid(anchor, 'to');
    const pos = (el) => ({ c: Number(kid(el, 'col').textContent), dx: Number(kid(el, 'colOff').textContent) / EMU, r: Number(kid(el, 'row').textContent), dy: Number(kid(el, 'rowOff').textContent) / EMU });
    const a = pos(from);
    const x = colX(sh, a.c) + a.dx;
    const y = rowY(sh, a.r) + a.dy;
    let w = 480;
    let hgt = 300;
    if (to) { const b = pos(to); w = colX(sh, b.c) + b.dx - x; hgt = rowY(sh, b.r) + b.dy - y; } else {
      const ext = kid(anchor, 'ext');
      if (ext) { w = Number(attr(ext, 'cx')) / EMU; hgt = Number(attr(ext, 'cy')) / EMU; }
    }
    out.push({
      id: `ch${Math.random().toString(36).slice(2, 9)}`, type, title, x: Math.round(x), y: Math.round(y), w: Math.max(120, Math.round(w)), h: Math.max(90, Math.round(hgt)),
      range: '', refs: { cats: series[0].cats || series[0].x || null, series: series.map((s) => ({ name: s.name, nameRef: s.nameRef, values: s.values, x: s.x })) },
    });
  }
  return out;
}
const val = (el, name) => { const k = el ? first(el, name) : null; return k ? attr(k, 'val') : null; };

/** Notes: comments<N>.xml -> { "A1": text }. */
export function readNotes(xml) {
  const out = {};
  if (!xml) return out;
  const doc = parseXml(xml);
  const authors = all(doc, 'author').map((a) => a.textContent);
  for (const c of all(doc, 'comment')) {
    const ref = attr(c, 'ref');
    const textEl = kid(c, 'text');
    if (!ref || !textEl) continue;
    let t = all(textEl, 't').filter((x) => !x.parentNode || x.parentNode.localName !== 'rPh').map((x) => x.textContent).join('');
    const who = authors[Number(attr(c, 'authorId') || 0)];
    // Excel starts a note with "Author:" in bold: keep the words, drop the label.
    if (who && t.startsWith(`${who}:`)) t = t.slice(who.length + 1).replace(/^\s*\n?/, '');
    out[ref.toUpperCase()] = t.trim();
  }
  return out;
}

/** Differential formats (the looks of conditional formats), from styles.xml. */
export function readDxfs(sd, colorOf) {
  return all(first(sd, 'dxfs'), 'dxf').map((d) => {
    const st = {};
    const font = kid(d, 'font');
    if (font) {
      const c = colorOf(kid(font, 'color'));
      if (c) st.color = c;
      if (kid(font, 'b') && attr(kid(font, 'b'), 'val') !== '0') st.bold = true;
      if (kid(font, 'i') && attr(kid(font, 'i'), 'val') !== '0') st.italic = true;
    }
    const pf = kid(kid(d, 'fill'), 'patternFill');
    if (pf) {
      const c = colorOf(kid(pf, 'bgColor')) || colorOf(kid(pf, 'fgColor'));
      if (c) st.fill = c;
    }
    return st;
  });
}

/** Conditional formats of a sheet (ours where we can show them; Excel's own XML kept otherwise). */
export function readCf(doc, colorOf, dxfs) {
  const out = [];
  for (const cf of all(doc, 'conditionalFormatting')) {
    for (const ref of (attr(cf, 'sqref') || '').split(/\s+/).filter(Boolean)) {
      const range = parseRange(ref.replace(/\$/g, ''));
      if (!range) continue;
      for (const rule of kids(cf, 'cfRule')) {
        const type = attr(rule, 'type');
        const style = dxfs[Number(attr(rule, 'dxfId'))] || { fill: '#fde8e8', color: '#9c0006' };
        const fs = all(rule, 'formula').map((x) => x.textContent);
        const num = (s) => (s === undefined ? undefined : /^".*"$/.test(s) ? s.slice(1, -1).replace(/""/g, '"') : Number.isFinite(Number(s)) ? Number(s) : null);
        if (type === 'colorScale') {
          const colors = all(rule, 'color').map(colorOf).filter(Boolean);
          if (colors.length >= 2) { out.push({ range, type: 'scale', colors }); continue; }
        } else if (type === 'dataBar') { out.push({ range, type: 'bar', color: colorOf(first(rule, 'color')) || '#3fb950' }); continue; }
        else if (type === 'duplicateValues') { out.push({ range, type: 'dup', style }); continue; }
        else if (type === 'uniqueValues') { out.push({ range, type: 'unique', style }); continue; }
        else if (type === 'containsBlanks') { out.push({ range, type: 'blank', style }); continue; }
        else if (type === 'containsErrors') { out.push({ range, type: 'error', style }); continue; }
        else if (type === 'containsText' && attr(rule, 'text') !== null) { out.push({ range, type: 'text', a: attr(rule, 'text'), style }); continue; }
        else if (type === 'top10') { out.push({ range, type: attr(rule, 'bottom') === '1' ? 'bottom' : 'top', n: Number(attr(rule, 'rank') || 10), percent: attr(rule, 'percent') === '1', style }); continue; }
        else if (type === 'aboveAverage') { out.push({ range, type: attr(rule, 'aboveAverage') === '0' ? 'below' : 'above', style }); continue; }
        else if (type === 'cellIs') {
          const map = { greaterThan: 'gt', lessThan: 'lt', between: 'between', equal: 'eq', notEqual: 'ne', greaterThanOrEqual: 'ge', lessThanOrEqual: 'le', notBetween: 'nb' };
          const t = map[attr(rule, 'operator')];
          const a = num(fs[0]);
          const b = num(fs[1]);
          if (t && a !== null && (b !== null || !['between', 'nb'].includes(t))) { out.push({ range, type: t, a, b, style }); continue; }
        }
        // Anything else (formula rules, icon sets...): kept as Excel wrote it, and written back.
        const copy = rule.cloneNode(true);
        copy.removeAttribute('dxfId');
        copy.removeAttribute('priority');
        out.push({ range, type: 'raw', xml: new XMLSerializer().serializeToString(copy).replace(/ xmlns="[^"]*"/, ''), style: rule.hasAttribute('dxfId') ? style : null });
      }
    }
  }
  return out;
}

/** Data validation: lists and number limits. */
export function readValidation(doc) {
  const out = [];
  for (const dv of all(first(doc, 'dataValidations'), 'dataValidation')) {
    const type = attr(dv, 'type');
    const f1 = kid(dv, 'formula1') ? kid(dv, 'formula1').textContent : '';
    const f2 = kid(dv, 'formula2') ? kid(dv, 'formula2').textContent : '';
    for (const ref of (attr(dv, 'sqref') || '').split(/\s+/).filter(Boolean)) {
      const range = parseRange(ref.replace(/\$/g, ''));
      if (!range) continue;
      if (type === 'list') {
        const list = /^".*"$/.test(f1) ? f1.slice(1, -1).split(',') : null;
        out.push({ range, type: 'list', list, source: list ? null : f1 });
      } else if ((type === 'whole' || type === 'decimal') && Number.isFinite(Number(f1))) {
        const op = attr(dv, 'operator') || 'between';
        const a = Number(f1);
        const b = Number(f2);
        const v = { range, type: 'number' };
        if (op === 'between') { v.min = a; if (Number.isFinite(b) && f2 !== '') v.max = b; } else if (op === 'greaterThanOrEqual' || op === 'greaterThan') v.min = a;
        else if (op === 'lessThanOrEqual' || op === 'lessThan') v.max = a;
        else continue;
        out.push(v);
      }
    }
  }
  return out;
}

// ===========================================================================
// Writing
// ===========================================================================
/** Excel references for a chart: its own, or worked out from its range like the chart draws it. */
export function chartRefs(book, sh, ch) {
  const sheetName = ch.sheet ? (book.sheet(ch.sheet) || sh).name : sh.name;
  if (ch.refs) return ch.refs;
  const g = parseRange(ch.range);
  if (!g) return null;
  const owner = book.sheets.find((s) => s.name === sheetName) || sh;
  if (ch.range2) {
    const g2 = parseRange(ch.range2);
    return g2 ? { cats: absRef(sheetName, g), series: [{ name: ch.title || 'Values', values: absRef(sheetName, g2) }] } : null;
  }
  const v = (r, c) => book.value(owner, r, c);
  const isText = (x) => typeof x === 'string' && x.trim() !== '' && Number.isNaN(Number(x));
  const byCols = !ch.byRows;
  // In the chart's own orientation: "lines" hold one series each.
  const nLines = byCols ? g.c1 - g.c0 + 1 : g.r1 - g.r0 + 1;
  const nPts = byCols ? g.r1 - g.r0 + 1 : g.c1 - g.c0 + 1;
  const at = (line, pt) => (byCols ? v(g.r0 + pt, g.c0 + line) : v(g.r0 + line, g.c0 + pt));
  const refOf = (line, p0, p1) => absRef(sheetName, byCols ? { r0: g.r0 + p0, c0: g.c0 + line, r1: g.r0 + p1, c1: g.c0 + line } : { r0: g.r0 + line, c0: g.c0 + p0, r1: g.r0 + line, c1: g.c0 + p1 });
  let header = false;
  for (let l = 0; l < nLines; l++) if (isText(at(l, 0))) header = true;
  header = header && nPts > 1;
  const p0 = header ? 1 : 0;
  let labels = nLines > 1;
  for (let p = p0; p < nPts && labels; p++) { const x = at(0, p); if (typeof x === 'number') labels = false; }
  const start = labels ? 1 : 0;
  const series = [];
  for (let l = start; l < nLines; l++) {
    series.push({ name: header ? String(at(l, 0) ?? '') : `Series ${l - start + 1}`, nameRef: header ? refOf(l, 0, 0) : null, values: refOf(l, p0, nPts - 1) });
  }
  return { cats: labels ? refOf(0, p0, nPts - 1) : null, series };
}

function cache(book, ref, numeric) {
  const p = splitRef(ref);
  if (!p) return '';
  const sh = p.sheet ? book.sheets.find((s) => s.name === p.sheet) : book.sheets[0];
  if (!sh) return '';
  const vals = [];
  for (let r = p.g.r0; r <= p.g.r1; r++) for (let c = p.g.c0; c <= p.g.c1; c++) vals.push(book.value(sh, r, c));
  const pts = vals.map((x, i) => (x === null || x === undefined || x === '' ? '' : `<c:pt idx="${i}"><c:v>${esc(String(numeric ? (typeof x === 'number' ? x : Number(x) || 0) : typeof x === 'object' ? x.text ?? '' : x))}</c:v></c:pt>`)).join('');
  return numeric ? `<c:numCache><c:formatCode>General</c:formatCode><c:ptCount val="${vals.length}"/>${pts}</c:numCache>` : `<c:strCache><c:ptCount val="${vals.length}"/>${pts}</c:strCache>`;
}

/** DrawingML for one chart. */
export function chartXml(book, ch, refs) {
  const t = ch.type || 'column';
  const ser = refs.series.map((s, i) => {
    const tx = s.nameRef ? `<c:tx><c:strRef><c:f>${esc(s.nameRef)}</c:f>${cache(book, s.nameRef, false)}</c:strRef></c:tx>` : s.name ? `<c:tx><c:v>${esc(s.name)}</c:v></c:tx>` : '';
    const cats = refs.cats ? (t === 'scatter' ? `<c:xVal><c:numRef><c:f>${esc(s.x || refs.cats)}</c:f>${cache(book, s.x || refs.cats, true)}</c:numRef></c:xVal>` : `<c:cat><c:strRef><c:f>${esc(refs.cats)}</c:f>${cache(book, refs.cats, false)}</c:strRef></c:cat>`) : '';
    const vals = t === 'scatter' ? `<c:yVal><c:numRef><c:f>${esc(s.values)}</c:f>${cache(book, s.values, true)}</c:numRef></c:yVal>` : `<c:val><c:numRef><c:f>${esc(s.values)}</c:f>${cache(book, s.values, true)}</c:numRef></c:val>`;
    const extra = t === 'line' ? '<c:marker><c:symbol val="circle"/><c:size val="5"/></c:marker>' : t === 'scatter' ? '<c:spPr><a:ln w="19050"><a:noFill/></a:ln></c:spPr><c:marker><c:symbol val="circle"/><c:size val="6"/></c:marker>' : '';
    return `<c:ser><c:idx val="${i}"/><c:order val="${i}"/>${tx}${extra}${cats}${vals}${t === 'line' || t === 'scatter' ? '<c:smooth val="0"/>' : ''}</c:ser>`;
  }).join('');
  const ax = (horizontal) => `<c:catAx><c:axId val="5001"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${horizontal ? 'l' : 'b'}"/><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="5002"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/><c:noMultiLvlLbl val="0"/></c:catAx><c:valAx><c:axId val="5002"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="${horizontal ? 'b' : 'l'}"/><c:majorGridlines/><c:numFmt formatCode="General" sourceLinked="1"/><c:majorTickMark val="none"/><c:minorTickMark val="none"/><c:tickLblPos val="nextTo"/><c:crossAx val="5001"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>`;
  const ids = '<c:axId val="5001"/><c:axId val="5002"/>';
  let plot;
  if (t === 'pie') plot = `<c:pieChart><c:varyColors val="1"/>${ser}<c:firstSliceAng val="0"/></c:pieChart>`;
  else if (t === 'doughnut') plot = `<c:doughnutChart><c:varyColors val="1"/>${ser}<c:firstSliceAng val="0"/><c:holeSize val="50"/></c:doughnutChart>`;
  else if (t === 'line') plot = `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${ser}<c:marker val="1"/>${ids}</c:lineChart>${ax(false)}`;
  else if (t === 'area') plot = `<c:areaChart><c:grouping val="standard"/><c:varyColors val="0"/>${ser}${ids}</c:areaChart>${ax(false)}`;
  else if (t === 'scatter') {
    plot = `<c:scatterChart><c:scatterStyle val="lineMarker"/><c:varyColors val="0"/>${ser}${ids}</c:scatterChart>`
      + '<c:valAx><c:axId val="5001"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:numFmt formatCode="General" sourceLinked="1"/><c:tickLblPos val="nextTo"/><c:crossAx val="5002"/><c:crosses val="autoZero"/><c:crossBetween val="midCat"/></c:valAx>'
      + '<c:valAx><c:axId val="5002"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/><c:majorGridlines/><c:numFmt formatCode="General" sourceLinked="1"/><c:tickLblPos val="nextTo"/><c:crossAx val="5001"/><c:crosses val="autoZero"/><c:crossBetween val="midCat"/></c:valAx>';
  } else {
    const bar = t === 'bar';
    const stacked = t === 'stacked';
    plot = `<c:barChart><c:barDir val="${bar ? 'bar' : 'col'}"/><c:grouping val="${stacked ? 'stacked' : 'clustered'}"/><c:varyColors val="0"/>${ser}<c:gapWidth val="150"/>${stacked ? '<c:overlap val="100"/>' : ''}${ids}</c:barChart>${ax(bar)}`;
  }
  const title = ch.title ? `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="1400" b="0"/></a:pPr><a:r><a:t>${esc(ch.title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>` : '<c:autoTitleDeleted val="1"/>';
  const legend = refs.series.length > 1 || t === 'pie' || t === 'doughnut' ? '<c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend>' : '';
  return `${XML_HEAD}<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${NS_REL}"><c:roundedCorners val="0"/><c:chart>${title}<c:plotArea><c:layout/>${plot}</c:plotArea>${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart></c:chartSpace>`;
}

/** A sheet's drawing with its charts, anchored to the cells under them. */
export function drawingXml(sh, charts) {
  const anchors = charts.map((ch, i) => {
    const a = cellAt(sh, ch.x, ch.y);
    const b = cellAt(sh, ch.x + ch.w, ch.y + ch.h);
    const p = (q) => `<xdr:col>${q.c}</xdr:col><xdr:colOff>${Math.round(q.dx * EMU)}</xdr:colOff><xdr:row>${q.r}</xdr:row><xdr:rowOff>${Math.round(q.dy * EMU)}</xdr:rowOff>`;
    return `<xdr:twoCellAnchor editAs="oneCell"><xdr:from>${p(a)}</xdr:from><xdr:to>${p(b)}</xdr:to><xdr:graphicFrame macro=""><xdr:nvGraphicFramePr><xdr:cNvPr id="${i + 2}" name="Chart ${i + 1}"/><xdr:cNvGraphicFramePr/></xdr:nvGraphicFramePr><xdr:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/></xdr:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="rId${i + 1}"/></a:graphicData></a:graphic></xdr:graphicFrame><xdr:clientData/></xdr:twoCellAnchor>`;
  }).join('');
  return `${XML_HEAD}<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="${NS_REL}">${anchors}</xdr:wsDr>`;
}

/** Notes: the comments part and the VML boxes Excel shows them in. */
export function notesXml(notes, idBase) {
  const comments = `${XML_HEAD}<comments xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><authors><author></author></authors><commentList>${notes.map((n) => `<comment ref="${colName(n.c)}${n.r + 1}" authorId="0"><text><r><t xml:space="preserve">${esc(n.text)}</t></r></text></comment>`).join('')}</commentList></comments>`;
  const shapes = notes.map((n, i) => `<v:shape id="_x0000_s${idBase * 1024 + i + 1}" type="#_x0000_t202" style="position:absolute;margin-left:80pt;margin-top:2pt;width:120pt;height:60pt;z-index:${i + 1};visibility:hidden" fillcolor="#ffffe1" o:insetmode="auto"><v:fill color2="#ffffe1"/><v:shadow on="t" color="black" obscured="t"/><v:path o:connecttype="none"/><v:textbox style="mso-direction-alt:auto"><div style="text-align:left"></div></v:textbox><x:ClientData ObjectType="Note"><x:MoveWithCells/><x:SizeWithCells/><x:Anchor>${n.c + 1}, 15, ${Math.max(0, n.r - 1)}, 10, ${n.c + 3}, 15, ${n.r + 3}, 4</x:Anchor><x:AutoFill>False</x:AutoFill><x:Row>${n.r}</x:Row><x:Column>${n.c}</x:Column></x:ClientData></v:shape>`).join('');
  const vml = `<xml xmlns:v="urn:schemas-microsoft-com:vml" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:x="urn:schemas-microsoft-com:office:excel"><o:shapelayout v:ext="edit"><o:idmap v:ext="edit" data="${idBase}"/></o:shapelayout><v:shapetype id="_x0000_t202" coordsize="21600,21600" o:spt="202" path="m,l,21600r21600,l21600,xe"><v:stroke joinstyle="miter"/><v:path gradientshapeok="t" o:connecttype="rect"/></v:shapetype>${shapes}</xml>`;
  return { comments, vml };
}

/** Conditional formats as Excel rules; `dxf(style)` gives a differential format's index. */
export function cfXml(rules, dxf) {
  let prio = 0;
  const rng = (g) => `${colName(g.c0)}${g.r0 + 1}${g.r0 === g.r1 && g.c0 === g.c1 ? '' : `:${colName(g.c1)}${g.r1 + 1}`}`;
  const lit = (v) => (typeof v === 'number' ? String(v) : `"${String(v ?? '').replace(/"/g, '""')}"`);
  return rules.map((r) => {
    const p = ++prio;
    const d = () => (r.style ? ` dxfId="${dxf(r.style)}"` : '');
    const tl = `${colName(r.range.c0)}${r.range.r0 + 1}`;
    let rule;
    const ops = { gt: 'greaterThan', lt: 'lessThan', between: 'between', eq: 'equal', ne: 'notEqual', ge: 'greaterThanOrEqual', le: 'lessThanOrEqual', nb: 'notBetween' };
    if (ops[r.type]) rule = `<cfRule type="cellIs"${d()} priority="${p}" operator="${ops[r.type]}"><formula>${esc(lit(r.a))}</formula>${['between', 'nb'].includes(r.type) ? `<formula>${esc(lit(r.b))}</formula>` : ''}</cfRule>`;
    else if (r.type === 'text') rule = `<cfRule type="containsText"${d()} priority="${p}" operator="containsText" text="${esc(String(r.a ?? ''))}"><formula>${esc(`NOT(ISERROR(SEARCH(${lit(String(r.a ?? ''))},${tl})))`)}</formula></cfRule>`;
    else if (r.type === 'blank') rule = `<cfRule type="containsBlanks"${d()} priority="${p}"><formula>${esc(`LEN(TRIM(${tl}))=0`)}</formula></cfRule>`;
    else if (r.type === 'error') rule = `<cfRule type="containsErrors"${d()} priority="${p}"><formula>${esc(`ISERROR(${tl})`)}</formula></cfRule>`;
    else if (r.type === 'dup') rule = `<cfRule type="duplicateValues"${d()} priority="${p}"/>`;
    else if (r.type === 'unique') rule = `<cfRule type="uniqueValues"${d()} priority="${p}"/>`;
    else if (r.type === 'top' || r.type === 'bottom') rule = `<cfRule type="top10"${d()} priority="${p}" rank="${r.n || 10}"${r.percent ? ' percent="1"' : ''}${r.type === 'bottom' ? ' bottom="1"' : ''}/>`;
    else if (r.type === 'above' || r.type === 'below') rule = `<cfRule type="aboveAverage"${d()} priority="${p}"${r.type === 'below' ? ' aboveAverage="0"' : ''}/>`;
    else if (r.type === 'scale') {
      const cs = (r.colors || ['#f8696b', '#ffeb84', '#63be7b']).slice(0, 3);
      const cfvo = cs.length === 3 ? '<cfvo type="min"/><cfvo type="percentile" val="50"/><cfvo type="max"/>' : '<cfvo type="min"/><cfvo type="max"/>';
      rule = `<cfRule type="colorScale" priority="${p}"><colorScale>${cfvo}${cs.map((c) => `<color rgb="FF${c.replace('#', '').toUpperCase()}"/>`).join('')}</colorScale></cfRule>`;
    } else if (r.type === 'bar') rule = `<cfRule type="dataBar" priority="${p}"><dataBar><cfvo type="min"/><cfvo type="max"/><color rgb="FF${String(r.color || '#3fb950').replace('#', '').toUpperCase()}"/></dataBar></cfRule>`;
    else if (r.type === 'raw' && r.xml) rule = r.xml.replace(/^<cfRule\b/, `<cfRule priority="${p}"${d()}`);
    else return '';
    return `<conditionalFormatting sqref="${rng(r.range)}">${rule}</conditionalFormatting>`;
  }).join('');
}

/** Data validation (lists and number limits). */
export function validationXml(list) {
  const rng = (g) => `${colName(g.c0)}${g.r0 + 1}:${colName(g.c1)}${g.r1 + 1}`;
  const items = list.map((v) => {
    if (v.type === 'list') return `<dataValidation type="list" allowBlank="1" showErrorMessage="1" sqref="${rng(v.range)}"><formula1>${esc(v.list ? `"${v.list.join(',')}"` : String(v.source || '').replace(/^=/, ''))}</formula1></dataValidation>`;
    if (v.type === 'number') {
      const has = (x) => x !== undefined && x !== null && x !== '';
      if (has(v.min) && has(v.max)) return `<dataValidation type="decimal" operator="between" allowBlank="1" showErrorMessage="1" sqref="${rng(v.range)}"><formula1>${v.min}</formula1><formula2>${v.max}</formula2></dataValidation>`;
      if (has(v.min)) return `<dataValidation type="decimal" operator="greaterThanOrEqual" allowBlank="1" showErrorMessage="1" sqref="${rng(v.range)}"><formula1>${v.min}</formula1></dataValidation>`;
      if (has(v.max)) return `<dataValidation type="decimal" operator="lessThanOrEqual" allowBlank="1" showErrorMessage="1" sqref="${rng(v.range)}"><formula1>${v.max}</formula1></dataValidation>`;
      return `<dataValidation type="decimal" operator="greaterThanOrEqual" allowBlank="1" showErrorMessage="1" sqref="${rng(v.range)}"><formula1>-1E+307</formula1></dataValidation>`;
    }
    return '';
  }).filter(Boolean);
  return items.length ? `<dataValidations count="${items.length}">${items.join('')}</dataValidations>` : '';
}

/** A differential format (conditional formatting's look) as styles.xml writes it. */
export function dxfXml(st) {
  const hex = (c) => `FF${String(c).replace('#', '').slice(0, 6).toUpperCase().padStart(6, '0')}`;
  const font = st.color || st.bold || st.italic ? `<font>${st.bold ? '<b/>' : ''}${st.italic ? '<i/>' : ''}${st.color ? `<color rgb="${hex(st.color)}"/>` : ''}</font>` : '';
  const fill = st.fill ? `<fill><patternFill><bgColor rgb="${hex(st.fill)}"/></patternFill></fill>` : '';
  return `<dxf>${font}${fill}</dxf>`;
}

export { REL, absRef, parseAddr };
