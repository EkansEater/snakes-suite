// PowerPoint .pptx: reading into our presentations and writing them out.
// Written from the Office Open XML spec (ECMA-376), no outside code.
import { readZip, writeZip } from '../../kit/zip.js';
import { esc, parseXml, all, first, kids, kid, attr, XML_HEAD } from '../../kit/xml.js';
import { uid, bytesToBase64, dataUrlToBytes, escapeHtml } from '../../kit/dom.js';
import { drawChart } from '../../kit/charts.js';
import { fontStack } from '../../kit/fonts.js';
import { Book } from '../sheets/engine.js';
import { writeXlsx } from '../sheets/io.js';
import { chartXml } from '../sheets/xlsxparts.js';
import { themeOf, themeColor, newPresentation, slideBackground } from './model.js';

const EMU = 9525; // per CSS pixel at 96 dpi
const NS = {
  p: 'http://schemas.openxmlformats.org/presentationml/2006/main',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
};
const GEOM = {
  rect: 'rect', roundRect: 'roundRect', ellipse: 'ellipse', triangle: 'triangle', rightTriangle: 'rtTriangle', diamond: 'diamond', pentagon: 'pentagon',
  hexagon: 'hexagon', star: 'star5', arrowRight: 'rightArrow', arrowLeft: 'leftArrow', chevron: 'chevron', callout: 'wedgeRoundRectCallout', heart: 'heart',
  plus: 'plus', cloud: 'cloud', parallelogram: 'parallelogram', ring: 'donut',
};
const GEOM_BACK = Object.fromEntries(Object.entries(GEOM).map(([k, v]) => [v, k]));

// ===========================================================================
// Writing
// ===========================================================================
const hex6 = (c) => {
  const s = String(c || '').trim();
  let m = /^#?([0-9a-f]{6})$/i.exec(s);
  if (m) return m[1].toUpperCase();
  m = /^#?([0-9a-f]{3})$/i.exec(s);
  if (m) return [...m[1]].map((x) => x + x).join('').toUpperCase();
  m = /rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)/.exec(s);
  if (m) return [m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('').toUpperCase();
  return null;
};
const firstColor = (css) => { const m = /#[0-9a-f]{6}|#[0-9a-f]{3}\b|rgba?\([^)]+\)/i.exec(css || ''); return m ? hex6(m[0]) : null; };
const allColors = (css) => (String(css || '').match(/#[0-9a-f]{6}|rgba?\([^)]+\)/gi) || []).map(hex6).filter(Boolean);
const fontName = (stack) => String(stack || '').split(',')[0].replace(/["']/g, '').trim() || 'Calibri';

function solid(c) { return c ? `<a:solidFill><a:srgbClr val="${c}"/></a:solidFill>` : ''; }

/** Our rich text (HTML) -> DrawingML paragraphs. */
function paragraphsXml(html, base, theme) {
  const box = document.createElement('div');
  box.innerHTML = html || '';
  const paras = [];
  const walkBlocks = (node, level = 0, bullet = null) => {
    let inline = [];
    const flush = (extra = {}) => {
      if (inline.length || extra.force) paras.push({ runs: inline, level, bullet, align: extra.align });
      inline = [];
    };
    for (const c of node.childNodes) {
      if (c.nodeType === 3) { if (c.data.trim() || inline.length) inline.push({ text: c.data, fmt: {} }); continue; }
      if (c.nodeType !== 1) continue;
      const tag = c.tagName;
      if (['P', 'DIV', 'H1', 'H2', 'H3', 'BLOCKQUOTE'].includes(tag)) {
        flush();
        const runs = [];
        const pf = {};
        if (c.style.fontSize) pf.size = /pt$/.test(c.style.fontSize) ? parseFloat(c.style.fontSize) / 0.75 : parseFloat(c.style.fontSize);
        if (c.style.color) pf.color = c.style.color;
        collectRuns(c, pf, runs);
        paras.push({ runs, level: level + Number((c.dataset && c.dataset.lvl) || 0), bullet, align: c.style.textAlign, nobullet: !!(c.dataset && c.dataset.nobullet) });
      } else if (tag === 'UL' || tag === 'OL') {
        flush();
        let n = 1;
        for (const li of c.children) {
          const runs = [];
          collectRuns(li, {}, runs, true);
          paras.push({ runs, level, bullet: tag === 'OL' ? { num: n++ } : { char: '•' }, align: li.style.textAlign });
          for (const sub of li.children) if (sub.tagName === 'UL' || sub.tagName === 'OL') walkBlocks({ childNodes: [sub] }, level + 1);
        }
      } else if (tag === 'BR') { flush({ force: true }); }
      else collectRuns(c, {}, inline);
    }
    flush();
  };
  walkBlocks(box);
  if (!paras.length) paras.push({ runs: [], level: 0 });
  const sz = Math.round((base.size || 24) * 0.75 * 100);
  return paras.map((p) => {
    const algn = { center: 'ctr', right: 'r', justify: 'just' }[p.align || base.align] || 'l';
    const listed = !p.nobullet && (p.bullet || base.bullets || base.numbered);
    const bu = p.nobullet ? '<a:buNone/>' : (p.bullet && p.bullet.num) || (!p.bullet && base.numbered) ? '<a:buFont typeface="+mj-lt"/><a:buAutoNum type="arabicPeriod"/>' : p.bullet || base.bullets ? `<a:buFont typeface="Arial"/><a:buChar char="${['•', '–', '▪'][p.level % 3]}"/>` : '<a:buNone/>';
    const ind = `${p.level ? ` lvl="${Math.min(8, p.level)}"` : ''}${listed ? ` marL="${342900 + p.level * 342900}" indent="-342900"` : p.level ? ` marL="${p.level * 342900}"` : ''}`;
    const runs = p.runs.map((r) => {
      if (r.br) return '<a:br/>';
      const f = r.fmt;
      const color = hex6(f.color) || hex6(themeColor(theme, base.color)) || null;
      const size = f.size ? Math.round(f.size * 0.75 * 100) : sz;
      return `<a:r><a:rPr lang="en-US" sz="${size}"${f.b || base.bold ? ' b="1"' : ''}${f.i || base.italic ? ' i="1"' : ''}${f.u || base.underline ? ' u="sng"' : ''}${f.s ? ' strike="sngStrike"' : ''} dirty="0">${color ? solid(color) : ''}${f.font || base.font ? `<a:latin typeface="${esc(f.font || base.font)}"/>` : ''}</a:rPr><a:t>${esc(r.text)}</a:t></a:r>`;
    }).join('');
    return `<a:p><a:pPr algn="${algn}"${ind}>${bu}</a:pPr>${runs}<a:endParaRPr lang="en-US" sz="${sz}" dirty="0"/></a:p>`;
  }).join('');
}

function collectRuns(node, fmt, out, skipLists = false) {
  for (const c of node.childNodes) {
    if (c.nodeType === 3) { if (c.data) out.push({ text: c.data.replace(/​/g, ''), fmt }); continue; }
    if (c.nodeType !== 1) continue;
    const t = c.tagName;
    if (skipLists && (t === 'UL' || t === 'OL')) continue;
    if (t === 'BR') { out.push({ br: true }); continue; }
    const f = { ...fmt };
    if (t === 'B' || t === 'STRONG') f.b = true;
    if (t === 'I' || t === 'EM') f.i = true;
    if (t === 'U') f.u = true;
    if (t === 'S' || t === 'STRIKE') f.s = true;
    if (c.style) {
      if (c.style.color) f.color = c.style.color;
      if (c.style.fontSize && /px$/.test(c.style.fontSize)) f.size = parseFloat(c.style.fontSize);
      if (c.style.fontSize && /pt$/.test(c.style.fontSize)) f.size = parseFloat(c.style.fontSize) / 0.75;
      if (c.style.fontWeight === 'bold' || Number(c.style.fontWeight) >= 600) f.b = true;
      if (c.style.fontStyle === 'italic') f.i = true;
      if (c.style.fontFamily) f.font = fontName(c.style.fontFamily);
    }
    if (t === 'FONT' && c.getAttribute('color')) f.color = c.getAttribute('color');
    collectRuns(c, f, out, skipLists);
  }
}

async function chartPng(item, theme) {
  const canvas = document.createElement('canvas');
  drawChart(canvas, { ...item.chart, theme: 'light', background: '#ffffff', font: theme.body }, { width: item.w, height: item.h, dpr: 2 });
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  return new Uint8Array(await blob.arrayBuffer());
}

export async function writePptx(pres) {
  const theme = themeOf(pres);
  const W = Math.round(pres.size.w * EMU);
  const H = Math.round(pres.size.h * EMU);
  const media = [];
  const mediaIndex = new Map();
  const addMedia = (bytes, ext) => {
    const name = `image${media.length + 1}.${ext}`;
    media.push({ name: `ppt/media/${name}`, data: bytes });
    return name;
  };
  const assetMedia = (assetId) => {
    if (mediaIndex.has(assetId)) return mediaIndex.get(assetId);
    const url = pres.assets[assetId];
    const m = /^data:image\/(png|jpeg|gif|webp|svg\+xml);base64,/.exec(url || '');
    if (!m) return null;
    const ext = m[1] === 'jpeg' ? 'jpeg' : m[1] === 'svg+xml' ? 'svg' : m[1];
    const name = addMedia(dataUrlToBytes(url), ext);
    mediaIndex.set(assetId, name);
    return name;
  };
  const files = [];
  const slideRels = [];
  const charts = [];
  let chartSeq = 0;
  let shapeId = 2;

  for (let si = 0; si < pres.slides.length; si++) {
    const slide = pres.slides[si];
    const rels = [{ id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout', target: '../slideLayouts/slideLayout1.xml' }];
    const rel = (type, target) => { const id = `rId${rels.length + 1}`; rels.push({ id, type, target }); return id; };
    let shapes = '';
    for (const it of slide.items) {
      const st = it.style || {};
      const id = shapeId++;
      const xfrm = `<a:xfrm${it.rot ? ` rot="${Math.round(it.rot * 60000)}"` : ''}${it.flipH ? ' flipH="1"' : ''}${it.flipV ? ' flipV="1"' : ''}><a:off x="${Math.round(it.x * EMU)}" y="${Math.round(it.y * EMU)}"/><a:ext cx="${Math.max(1, Math.round(it.w * EMU))}" cy="${Math.max(1, Math.round(it.h * EMU))}"/></a:xfrm>`;
      if (it.type === 'text' || it.type === 'shape') {
        const fill = hex6(themeColor(theme, st.fill)) || (it.type === 'shape' && !st.fill ? hex6(theme.accents[0]) : null);
        const grad = st.gradient && fill ? `<a:gradFill><a:gsLst><a:gs pos="0"><a:srgbClr val="${fill}"/></a:gs><a:gs pos="100000"><a:srgbClr val="${hex6(themeColor(theme, st.gradient))}"/></a:gs></a:gsLst><a:lin ang="2700000" scaled="0"/></a:gradFill>` : '';
        const stroke = hex6(themeColor(theme, st.stroke));
        const geom = it.type === 'text' ? (st.radius ? 'roundRect' : 'rect') : GEOM[it.shape] || 'rect';
        const color = st.color || (it.type === 'shape' ? '#ffffff' : (st.role === 'title' ? theme.title : st.role === 'subtitle' ? theme.muted : st.role === 'accent' ? theme.accents[0] : theme.text));
        const base = { ...st, color };
        const anchor = st.valign === 'middle' ? 'ctr' : st.valign === 'bottom' ? 'b' : 't';
        const pad = Math.round((st.padding !== undefined ? st.padding : it.type === 'shape' ? 16 : 8) * EMU);
        const font = fontName(st.font === 'heading' || (!st.font && st.role === 'title') ? theme.heading : st.font && st.font !== 'body' ? st.font : theme.body);
        const bodyWithFont = `<p:txBody><a:bodyPr wrap="square" lIns="${pad}" tIns="${pad}" rIns="${pad}" bIns="${pad}" anchor="${anchor}" rtlCol="0">${st.autofit !== false && it.type === 'text' ? '<a:normAutofit/>' : '<a:noAutofit/>'}</a:bodyPr><a:lstStyle/>${paragraphsXml(it.html, { ...base, font }, theme)}</p:txBody>`;
        shapes += `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${it.type === 'text' ? 'TextBox' : 'Shape'} ${id}"/><p:cNvSpPr${it.type === 'text' ? ' txBox="1"' : ''}/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm}<a:prstGeom prst="${geom}"><a:avLst/></a:prstGeom>${grad || (fill && fill !== 'NONE' && st.fill !== 'none' ? solid(fill) : '<a:noFill/>')}${stroke ? `<a:ln w="${Math.round((st.strokeWidth || 2) * 9525)}">${solid(stroke)}</a:ln>` : '<a:ln><a:noFill/></a:ln>'}</p:spPr>${bodyWithFont}</p:sp>`;
      } else if (it.type === 'line') {
        const color = hex6(themeColor(theme, st.stroke)) || hex6(theme.text);
        const flipV = it.dir === 'up' ? ' flipV="1"' : '';
        shapes += `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="Line ${id}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm${flipV}><a:off x="${Math.round(it.x * EMU)}" y="${Math.round(it.y * EMU)}"/><a:ext cx="${Math.round(it.w * EMU)}" cy="${Math.round(it.h * EMU)}"/></a:xfrm><a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="${Math.round((st.strokeWidth || 4) * 9525)}">${solid(color)}${st.dash ? `<a:prstDash val="${st.dash === 'dot' ? 'sysDot' : 'dash'}"/>` : ''}${st.arrow ? '<a:tailEnd type="triangle"/>' : ''}</a:ln></p:spPr></p:cxnSp>`;
      } else if (it.type === 'chart' && it.chart && (it.chart.series || []).length) {
        // A real PowerPoint chart, with its numbers in an embedded workbook (Edit Data works).
        const n = ++chartSeq;
        const c = it.chart;
        const book = new Book();
        const sh = book.addSheet('Sheet1');
        const cats = c.categories || [];
        c.series.forEach((ser, j) => book.setValue(sh, 0, j + 1, String(ser.name || `Series ${j + 1}`)));
        cats.forEach((cat, i) => book.setValue(sh, i + 1, 0, String(cat)));
        c.series.forEach((ser, j) => (ser.values || []).forEach((v, i) => { if (typeof v === 'number') book.setValue(sh, i + 1, j + 1, v); }));
        const last = Math.max(cats.length, ...c.series.map((x) => (x.values || []).length));
        const col = (j) => String.fromCharCode(66 + j);
        const refs = { cats: cats.length ? `Sheet1!$A$2:$A$${last + 1}` : null, series: c.series.map((ser, j) => ({ name: ser.name, nameRef: `Sheet1!$${col(j)}$1`, values: `Sheet1!$${col(j)}$2:$${col(j)}$${last + 1}` })) };
        const xml = chartXml(book, { type: c.type || 'column', title: c.title || '' }, refs).replace('</c:chartSpace>', '<c:externalData r:id="rId1"><c:autoUpdate val="0"/></c:externalData></c:chartSpace>');
        files.push({ name: `ppt/charts/chart${n}.xml`, data: xml });
        files.push({ name: `ppt/charts/_rels/chart${n}.xml.rels`, data: relsXml([{ id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/package', target: `../embeddings/Microsoft_Excel_Worksheet${n}.xlsx` }]) });
        files.push({ name: `ppt/embeddings/Microsoft_Excel_Worksheet${n}.xlsx`, data: await writeXlsx(book), store: true });
        charts.push(n);
        const rid = rel('http://schemas.openxmlformats.org/officeDocument/2006/relationships/chart', `../charts/chart${n}.xml`);
        shapes += `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Chart ${id}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${Math.round(it.x * EMU)}" y="${Math.round(it.y * EMU)}"/><a:ext cx="${Math.max(1, Math.round(it.w * EMU))}" cy="${Math.max(1, Math.round(it.h * EMU))}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart" r:id="${rid}"/></a:graphicData></a:graphic></p:graphicFrame>`;
      } else if (it.type === 'image' || it.type === 'chart') {
        let name;
        if (it.type === 'chart') name = addMedia(await chartPng(it, theme), 'png');
        else name = it.asset ? assetMedia(it.asset) : null;
        if (!name) continue;
        const rid = rel('http://schemas.openxmlformats.org/officeDocument/2006/relationships/image', `../media/${name}`);
        shapes += `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="Picture ${id}" descr="${esc(it.alt || '')}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm}<a:prstGeom prst="${st.radius ? 'roundRect' : 'rect'}"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
      } else if (it.type === 'table') {
        const rows = it.rows || [];
        const cols = rows[0] ? rows[0].length : 1;
        const cw = Math.round((it.w * EMU) / cols);
        const rh = Math.round((it.h * EMU) / Math.max(1, rows.length));
        const head = hex6(themeColor(theme, st.header || 'accent0'));
        const color = hex6(themeColor(theme, st.color)) || hex6(theme.text);
        const tbl = `<a:tbl><a:tblPr firstRow="1" bandRow="1"/><a:tblGrid>${Array.from({ length: cols }, () => `<a:gridCol w="${cw}"/>`).join('')}</a:tblGrid>${rows.map((row, r) => `<a:tr h="${rh}">${row.map((cell) => {
          const text = (() => { const d = document.createElement('div'); d.innerHTML = cell.html || ''; return d.textContent; })();
          return `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:r><a:rPr lang="en-US" sz="${Math.round((st.size || 20) * 75)}"${r === 0 ? ' b="1"' : ''}>${solid(r === 0 ? 'FFFFFF' : color)}</a:rPr><a:t>${esc(text)}</a:t></a:r></a:p></a:txBody><a:tcPr>${r === 0 ? solid(head) : '<a:noFill/>'}</a:tcPr></a:tc>`;
        }).join('')}</a:tr>`).join('')}</a:tbl>`;
        shapes += `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="Table ${id}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${Math.round(it.x * EMU)}" y="${Math.round(it.y * EMU)}"/><a:ext cx="${Math.round(it.w * EMU)}" cy="${Math.round(it.h * EMU)}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table">${tbl}</a:graphicData></a:graphic></p:graphicFrame>`;
      }
    }
    // Background.
    const bgCss = slideBackground(slide, theme, pres);
    let bg = '';
    if (slide.bg && slide.bg.image && pres.assets[slide.bg.image]) {
      const name = assetMedia(slide.bg.image);
      if (name) bg = `<p:bg><p:bgPr><a:blipFill><a:blip r:embed="${rel('http://schemas.openxmlformats.org/officeDocument/2006/relationships/image', `../media/${name}`)}"/><a:stretch><a:fillRect/></a:stretch></a:blipFill><a:effectLst/></p:bgPr></p:bg>`;
    } else {
      const colors = allColors(bgCss);
      if (colors.length > 1) bg = `<p:bg><p:bgPr><a:gradFill><a:gsLst>${colors.slice(0, 2).map((c, i) => `<a:gs pos="${i * 100000}"><a:srgbClr val="${c}"/></a:gs>`).join('')}</a:gsLst><a:lin ang="2700000" scaled="0"/></a:gradFill><a:effectLst/></p:bgPr></p:bg>`;
      else if (colors.length) bg = `<p:bg><p:bgPr>${solid(colors[0])}<a:effectLst/></p:bgPr></p:bg>`;
    }
    const trans = slide.transition && slide.transition.type && slide.transition.type !== 'none'
      ? `<p:transition spd="${(slide.transition.duration || 0.5) > 0.8 ? 'slow' : 'med'}">${{ fade: '<p:fade/>', slide: '<p:push dir="l"/>', push: '<p:push dir="u"/>', zoom: '<p:zoom/>', cover: '<p:cover dir="l"/>', flip: '<p:fade/>' }[slide.transition.type] || '<p:fade/>'}</p:transition>` : '';
    let notesRel = '';
    if (slide.notes) notesRel = rel('http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide', `../notesSlides/notesSlide${si + 1}.xml`);
    files.push({ name: `ppt/slides/slide${si + 1}.xml`, data: `${XML_HEAD}<p:sld xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}"${slide.hidden ? ' show="0"' : ''}><p:cSld>${bg}<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>${trans}</p:sld>` });
    files.push({ name: `ppt/slides/_rels/slide${si + 1}.xml.rels`, data: relsXml(rels) });
    if (slide.notes) {
      files.push({ name: `ppt/notesSlides/notesSlide${si + 1}.xml`, data: `${XML_HEAD}<p:notes xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/><p:sp><p:nvSpPr><p:cNvPr id="2" name="Slide Image"/><p:cNvSpPr><a:spLocks noGrp="1" noRot="1" noChangeAspect="1"/></p:cNvSpPr><p:nvPr><p:ph type="sldImg"/></p:nvPr></p:nvSpPr><p:spPr/></p:sp><p:sp><p:nvSpPr><p:cNvPr id="3" name="Notes"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${slide.notes.split('\n').map((l) => `<a:p><a:r><a:rPr lang="en-US"/><a:t>${esc(l)}</a:t></a:r></a:p>`).join('')}</p:txBody></p:sp></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>` });
      files.push({ name: `ppt/notesSlides/_rels/notesSlide${si + 1}.xml.rels`, data: relsXml([{ id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster', target: '../notesMasters/notesMaster1.xml' }, { id: 'rId2', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide', target: `../slides/slide${si + 1}.xml` }]) });
    }
    slideRels.push(si + 1);
  }

  const hasNotes = pres.slides.some((s) => s.notes);
  const presRels = [{ id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster', target: 'slideMasters/slideMaster1.xml' }];
  slideRels.forEach((n) => presRels.push({ id: `rId${presRels.length + 1}`, type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide', target: `slides/slide${n}.xml` }));
  const themeRelId = `rId${presRels.length + 1}`;
  presRels.push({ id: themeRelId, type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme', target: 'theme/theme1.xml' });
  let notesMasterRel = '';
  if (hasNotes) { notesMasterRel = `rId${presRels.length + 1}`; presRels.push({ id: notesMasterRel, type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesMaster', target: 'notesMasters/notesMaster1.xml' }); }
  const presentation = `${XML_HEAD}<p:presentation xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}" saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>${hasNotes ? `<p:notesMasterIdLst><p:notesMasterId r:id="${notesMasterRel}"/></p:notesMasterIdLst>` : ''}<p:sldIdLst>${slideRels.map((n, i) => `<p:sldId id="${256 + i}" r:id="rId${i + 2}"/>`).join('')}</p:sldIdLst><p:sldSz cx="${W}" cy="${H}"/><p:notesSz cx="6858000" cy="9144000"/></p:presentation>`;
  const fontH = fontName(theme.heading);
  const fontB = fontName(theme.body);
  const acc = theme.accents.map(hex6);
  const themeXml = `${XML_HEAD}<a:theme xmlns:a="${NS.a}" name="${esc(theme.name)}"><a:themeElements><a:clrScheme name="${esc(theme.name)}"><a:dk1><a:srgbClr val="000000"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="${hex6(theme.title) || '1B1F1C'}"/></a:dk2><a:lt2><a:srgbClr val="E7EBE8"/></a:lt2>${acc.map((c, i) => `<a:accent${i + 1}><a:srgbClr val="${c || '3FB950'}"/></a:accent${i + 1}>`).join('')}<a:hlink><a:srgbClr val="2F81F7"/></a:hlink><a:folHlink><a:srgbClr val="A371F7"/></a:folHlink></a:clrScheme><a:fontScheme name="${esc(theme.name)}"><a:majorFont><a:latin typeface="${esc(fontH)}"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="${esc(fontB)}"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="Snake"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="12700"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln w="19050"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>`;
  const master = `${XML_HEAD}<p:sldMaster xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}"><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="4400"/></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="2400"/></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr sz="1800"/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>`;
  const layout = `${XML_HEAD}<p:sldLayout xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}" type="blank" preserve="1"><p:cSld name="Blank"><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>`;
  const notesMaster = `${XML_HEAD}<p:notesMaster xmlns:a="${NS.a}" xmlns:r="${NS.r}" xmlns:p="${NS.p}"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr/></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:notesMaster>`;
  const exts = new Set(media.map((m) => m.name.split('.').pop()));
  const ct = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${[...exts].map((e) => `<Default Extension="${e}" ContentType="${e === 'svg' ? 'image/svg+xml' : `image/${e}`}"/>`).join('')}${charts.length ? '<Default Extension="xlsx" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"/>' : ''}${charts.map((n) => `<Override PartName="/ppt/charts/chart${n}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawingml.chart+xml"/>`).join('')}<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${hasNotes ? '<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/><Override PartName="/ppt/theme/theme2.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' : ''}${pres.slides.map((s, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>${s.notes ? `<Override PartName="/ppt/notesSlides/notesSlide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>` : ''}`).join('')}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const out = [
    { name: '[Content_Types].xml', data: ct },
    { name: '_rels/.rels', data: relsXml([{ id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument', target: 'ppt/presentation.xml' }, { id: 'rId2', type: 'http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties', target: 'docProps/core.xml' }, { id: 'rId3', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties', target: 'docProps/app.xml' }]) },
    { name: 'ppt/presentation.xml', data: presentation },
    { name: 'ppt/_rels/presentation.xml.rels', data: relsXml(presRels) },
    { name: 'ppt/slideMasters/slideMaster1.xml', data: master },
    { name: 'ppt/slideMasters/_rels/slideMaster1.xml.rels', data: relsXml([{ id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideLayout', target: '../slideLayouts/slideLayout1.xml' }, { id: 'rId2', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme', target: '../theme/theme1.xml' }]) },
    { name: 'ppt/slideLayouts/slideLayout1.xml', data: layout },
    { name: 'ppt/slideLayouts/_rels/slideLayout1.xml.rels', data: relsXml([{ id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster', target: '../slideMasters/slideMaster1.xml' }]) },
    { name: 'ppt/theme/theme1.xml', data: themeXml },
    ...files,
    ...media.map((m) => ({ ...m, store: true })),
    { name: 'docProps/core.xml', data: `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(pres.title || '')}</dc:title><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>` },
    { name: 'docProps/app.xml', data: `${XML_HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Snake's Slides</Application><Slides>${pres.slides.length}</Slides></Properties>` },
  ];
  if (hasNotes) {
    out.push({ name: 'ppt/notesMasters/notesMaster1.xml', data: notesMaster });
    out.push({ name: 'ppt/notesMasters/_rels/notesMaster1.xml.rels', data: relsXml([{ id: 'rId1', type: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/theme', target: '../theme/theme2.xml' }]) });
    out.push({ name: 'ppt/theme/theme2.xml', data: themeXml });
  }
  return writeZip(out);
}

function relsXml(list) {
  return `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${list.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${esc(r.target)}"/>`).join('')}</Relationships>`;
}

// ===========================================================================
// Reading
// ===========================================================================
export async function readPptx(bytes) {
  const zip = readZip(bytes);
  const text = async (n) => (zip.has(n) ? zip.get(n).text() : null);
  const presXml = await text('ppt/presentation.xml');
  if (!presXml) throw new Error('This file has no presentation in it.');
  const pd = parseXml(presXml);
  const sz = first(pd, 'sldSz');
  const W = sz ? Number(attr(sz, 'cx')) / EMU : 1280;
  const H = sz ? Number(attr(sz, 'cy')) / EMU : 720;
  const pres = newPresentation('clean');
  pres.size = { w: Math.round(W), h: Math.round(H), name: 'From PowerPoint' };
  pres.sizeId = 'custom';
  pres.slides = [];
  const relsCache = new Map();
  const rels = async (path) => {
    if (relsCache.has(path)) return relsCache.get(path);
    const dir = path.slice(0, path.lastIndexOf('/'));
    const file = path.slice(path.lastIndexOf('/') + 1);
    const xml = await text(`${dir}/_rels/${file}.rels`);
    const map = {};
    if (xml) {
      for (const r of all(parseXml(xml), 'Relationship')) {
        const t = r.getAttribute('Target');
        map[r.getAttribute('Id')] = { type: r.getAttribute('Type'), target: t, path: resolvePath(dir, t), external: r.getAttribute('TargetMode') === 'External' };
      }
    }
    relsCache.set(path, map);
    return map;
  };
  const presRels = await rels('ppt/presentation.xml');

  // The theme: its colours and its two fonts (headings and body).
  const scheme = {};
  const fonts = { major: '', minor: '' };
  const themeRel = Object.values(presRels).find((r) => /theme$/.test(r.type));
  const themeXml = themeRel ? await text(themeRel.path) : null;
  if (themeXml) {
    const tdoc = parseXml(themeXml);
    const cs = first(tdoc, 'clrScheme');
    for (const el of kids(cs)) {
      const c = first(el, 'srgbClr') || first(el, 'sysClr');
      scheme[el.localName] = c ? (attr(c, 'val') && c.localName === 'srgbClr' ? attr(c, 'val') : attr(c, 'lastClr')) : null;
    }
    for (const k of ['major', 'minor']) { const f = first(tdoc, `${k}Font`); const l = f ? kid(f, 'latin') : null; fonts[k] = l ? attr(l, 'typeface') || '' : ''; }
  }
  scheme.bg1 = scheme.lt1; scheme.tx1 = scheme.dk1; scheme.bg2 = scheme.lt2; scheme.tx2 = scheme.dk2;
  const colorOf = (el) => {
    if (!el) return null;
    const s = first(el, 'srgbClr');
    const sc = first(el, 'schemeClr');
    const sys = first(el, 'sysClr');
    let hex = s ? attr(s, 'val') : sc ? scheme[attr(sc, 'val')] : sys ? attr(sys, 'lastClr') : null;
    const src = s || sc || sys;
    if (!hex) return null;
    if (src) {
      const lm = first(src, 'lumMod');
      const lo = first(src, 'lumOff');
      const tint = first(src, 'tint');
      const shade = first(src, 'shade');
      let n = parseInt(hex, 16);
      let rgb = [n >> 16, (n >> 8) & 255, n & 255];
      if (lm || lo) rgb = rgb.map((v) => v * (lm ? Number(attr(lm, 'val')) / 100000 : 1) + 255 * (lo ? Number(attr(lo, 'val')) / 100000 : 0));
      if (tint) rgb = rgb.map((v) => v + (255 - v) * (1 - Number(attr(tint, 'val')) / 100000));
      if (shade) rgb = rgb.map((v) => v * (Number(attr(shade, 'val')) / 100000));
      n = 0;
      hex = rgb.map((v) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, '0')).join('');
    }
    return `#${hex.toLowerCase()}`;
  };
  const faceOf = (tf) => (!tf ? null : tf === '+mj-lt' ? fonts.major || null : tf === '+mn-lt' ? fonts.minor || null : tf.startsWith('+') ? null : tf);

  // Text formatting at each outline level (lvl1pPr ... lvl9pPr) of a list style.
  const levels = (el) => {
    const out = [];
    if (!el) return out;
    const one = (p) => {
      if (!p) return null;
      const o = {};
      if (attr(p, 'algn')) o.align = { ctr: 'center', r: 'right', just: 'justify', dist: 'justify' }[attr(p, 'algn')] || 'left';
      if (attr(p, 'marL') !== null) o.marL = Number(attr(p, 'marL')) / EMU;
      if (kid(p, 'buNone')) o.bullet = 'none';
      else if (kid(p, 'buAutoNum')) o.bullet = 'num';
      else if (kid(p, 'buChar')) o.bullet = 'char';
      const d = kid(p, 'defRPr');
      if (d) {
        if (attr(d, 'sz')) o.size = Number(attr(d, 'sz')) / 100;
        if (attr(d, 'b') !== null) o.bold = attr(d, 'b') === '1';
        if (attr(d, 'i') !== null) o.italic = attr(d, 'i') === '1';
        const c = colorOf(kid(d, 'solidFill'));
        if (c) o.color = c;
        const l = kid(d, 'latin');
        if (l) o.font = attr(l, 'typeface');
      }
      return o;
    };
    const def = one(kid(el, 'defPPr'));
    for (let i = 1; i <= 9; i++) out[i - 1] = { ...(def || {}), ...(one(kid(el, `lvl${i}pPr`)) || {}) };
    return out;
  };
  // A layout's or master's placeholders: where they sit, their text styles, their anchor.
  const partCache = new Map();
  const partInfo = async (path) => {
    if (!path) return { phs: [], bg: null, tx: null };
    if (partCache.has(path)) return partCache.get(path);
    const xml = await text(path);
    const info = { phs: [], bg: null, tx: null };
    if (xml) {
      const d = parseXml(xml);
      for (const sp of all(d, 'sp')) {
        const ph = first(first(sp, 'nvPr'), 'ph');
        if (!ph) continue;
        const txBody = kid(sp, 'txBody');
        const bodyPr = txBody ? kid(txBody, 'bodyPr') : null;
        info.phs.push({ type: attr(ph, 'type') || 'body', idx: attr(ph, 'idx'), xfrm: first(first(sp, 'spPr'), 'xfrm'), lst: levels(txBody ? kid(txBody, 'lstStyle') : null), anchor: bodyPr ? attr(bodyPr, 'anchor') : null });
      }
      const bgPr = first(first(d, 'bg'), 'bgPr');
      const bgRef = first(first(d, 'bg'), 'bgRef');
      if (bgPr) info.bg = bgPr;
      else if (bgRef) info.bg = bgRef;
      const txs = first(d, 'txStyles');
      if (txs) info.tx = { title: levels(kid(txs, 'titleStyle')), body: levels(kid(txs, 'bodyStyle')), other: levels(kid(txs, 'otherStyle')) };
    }
    partCache.set(path, info);
    return info;
  };
  const defaultText = levels(first(pd, 'defaultTextStyle'));
  const findPh = (list, type, idx) => list.find((p) => idx !== null && idx !== undefined && p.idx === idx && idx !== '0')
    || list.find((p) => p.type === type) || list.find((p) => (type === 'ctrTitle' && p.type === 'title') || (type === 'subTitle' && p.type === 'body') || (type === 'obj' && p.type === 'body'));

  const assetFrom = async (relsMap, rid) => {
    const r = relsMap[rid];
    if (!r || r.external || !zip.has(r.path)) return null;
    const ext = r.path.split('.').pop().toLowerCase();
    const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', svg: 'image/svg+xml' }[ext];
    if (!mime || mime === 'image/svg+xml') return null;
    const id = uid('as');
    pres.assets[id] = `data:${mime};base64,${bytesToBase64(await zip.get(r.path).read())}`;
    return id;
  };
  const backgroundOf = async (bg, relsMap) => {
    if (!bg) return null;
    if (bg.localName === 'bgRef') { const c = colorOf(bg); return c ? { color: c } : null; }
    const blip = first(bg, 'blip');
    if (blip) { const a = await assetFrom(relsMap, attr(blip, 'embed')); return a ? { image: a } : null; }
    if (first(bg, 'gradFill')) { const stops = all(bg, 'gs').map((g) => colorOf(g)); return { color: stops[0], gradient: stops[stops.length - 1], angle: 135 }; }
    const c = colorOf(first(bg, 'solidFill'));
    return c ? { color: c } : null;
  };

  // The file's own theme, as one of ours: its background, title and text colours, fonts.
  const masterRel0 = Object.values(presRels).find((r) => /slideMaster$/.test(r.type));
  const master0 = await partInfo(masterRel0 && masterRel0.path);
  const masterBg = master0.bg ? await backgroundOf(master0.bg, masterRel0 ? await rels(masterRel0.path) : {}) : null;
  const titleLvl = (master0.tx && master0.tx.title[0]) || {};
  const bodyLvl = (master0.tx && master0.tx.body[0]) || {};
  const bgHex = (masterBg && masterBg.color) || `#${scheme.lt1 || 'ffffff'}`;
  const textHex = bodyLvl.color || `#${scheme.dk1 || '000000'}`;
  const mix = (a, b, t) => { const p = (x) => [1, 3, 5].map((i) => parseInt(x.slice(i, i + 2), 16)); const A = p(a); const B = p(b); return `#${A.map((v, i) => Math.round(v + (B[i] - v) * t).toString(16).padStart(2, '0')).join('')}`; };
  pres.customTheme = {
    name: 'From the file', bg: masterBg && masterBg.gradient ? `linear-gradient(135deg, ${masterBg.color} 0%, ${masterBg.gradient} 100%)` : bgHex,
    title: titleLvl.color || textHex, text: textHex, muted: /^#[0-9a-f]{6}$/i.test(bgHex) && /^#[0-9a-f]{6}$/i.test(textHex) ? mix(textHex, bgHex, 0.4) : textHex,
    accents: [1, 2, 3, 4, 5, 6].map((i) => `#${(scheme[`accent${i}`] || '3fb950').toLowerCase()}`),
    heading: fontStack(faceOf(titleLvl.font) || fonts.major || 'Calibri Light'), body: fontStack(faceOf(bodyLvl.font) || fonts.minor || 'Calibri'),
    titleWeight: titleLvl.bold ? 700 : 400,
  };
  pres.theme = 'file';

  const sldIds = all(first(pd, 'sldIdLst'), 'sldId');
  for (const sid of sldIds) {
    const r = presRels[sid.getAttributeNS(NS.r, 'id') || attr(sid, 'id')];
    if (!r) continue;
    const sx = await text(r.path);
    if (!sx) continue;
    const sd = parseXml(sx);
    const srels = await rels(r.path);
    const layoutRel = Object.values(srels).find((x) => /slideLayout$/.test(x.type));
    const layout = await partInfo(layoutRel && layoutRel.path);
    const layoutRels = layoutRel ? await rels(layoutRel.path) : {};
    const masterRel = Object.values(layoutRels).find((x) => /slideMaster$/.test(x.type));
    const master = await partInfo(masterRel && masterRel.path);
    const tx = master.tx || { title: [], body: [], other: [] };
    const slide = { id: uid('sl'), layout: 'blank', items: [], notes: '', transition: { type: 'fade', duration: 0.5 }, hidden: attr(first(sd, 'sld'), 'show') === '0' };
    // Background: the slide's, else its layout's, else the master's (which the theme has).
    const own = first(first(sd, 'bg'), 'bgPr') || first(first(sd, 'bg'), 'bgRef');
    if (own) slide.bg = await backgroundOf(own, srels);
    else if (layout.bg) slide.bg = await backgroundOf(layout.bg, layoutRels);
    if (!slide.bg) delete slide.bg;

    const xfrmOf = (el, ph) => {
      let xf = first(first(el, 'spPr') || el, 'xfrm');
      if (!xf && ph) {
        const type = attr(ph, 'type') || 'body';
        const idx = attr(ph, 'idx');
        const hit = [findPh(layout.phs, type, idx), findPh(master.phs, type, idx)].find((p) => p && p.xfrm);
        xf = hit && hit.xfrm;
      }
      if (!xf) return null;
      const off = kid(xf, 'off');
      const ext = kid(xf, 'ext');
      return { x: Number(attr(off, 'x')) / EMU, y: Number(attr(off, 'y')) / EMU, w: Number(attr(ext, 'cx')) / EMU, h: Number(attr(ext, 'cy')) / EMU, rot: Number(attr(xf, 'rot') || 0) / 60000, flipH: attr(xf, 'flipH') === '1', flipV: attr(xf, 'flipV') === '1' };
    };
    // Text of a shape, through the levels it inherits (master text styles, master and layout
    // placeholders, its own list style), as our HTML plus the box's own style.
    const textOf = (el, ph) => {
      const txBody = kid(el, 'txBody');
      if (!txBody) return { html: '', style: {} };
      const type = ph ? attr(ph, 'type') || 'body' : null;
      const idx = ph ? attr(ph, 'idx') : null;
      const kind = !ph ? 'other' : type === 'title' || type === 'ctrTitle' ? 'title' : 'body';
      const chain = [kind === 'other' ? (defaultText.length ? defaultText : tx.other) : tx[kind]];
      if (ph) { const m = findPh(master.phs, type, idx); const l = findPh(layout.phs, type, idx); if (m) chain.push(m.lst); if (l) chain.push(l.lst); }
      chain.push(levels(kid(txBody, 'lstStyle')));
      const at = (lvl) => Object.assign({}, ...chain.map((c) => (c && c[lvl]) || {}));
      const base = at(0);
      let html = '';
      for (const p of kids(txBody, 'p')) {
        const pPr = kid(p, 'pPr');
        const lvl = Math.min(8, Number((pPr && attr(pPr, 'lvl')) || 0));
        const L = { ...at(lvl) };
        if (pPr) {
          if (attr(pPr, 'algn')) L.align = { ctr: 'center', r: 'right', just: 'justify', dist: 'justify' }[attr(pPr, 'algn')] || 'left';
          if (kid(pPr, 'buNone')) L.bullet = 'none'; else if (kid(pPr, 'buAutoNum')) L.bullet = 'num'; else if (kid(pPr, 'buChar')) L.bullet = 'char';
        }
        let inner = '';
        for (const rr of kids(p)) {
          if (rr.localName === 'br') { inner += '<br>'; continue; }
          if (rr.localName !== 'r' && rr.localName !== 'fld') continue;
          const rPr = kid(rr, 'rPr');
          let t = escapeHtml((kid(rr, 't') || { textContent: '' }).textContent);
          const st = [];
          const size = rPr && attr(rPr, 'sz') ? Number(attr(rPr, 'sz')) / 100 : null;
          if (size && Math.abs(size - (L.size || 18)) > 0.01) st.push(`font-size: ${Math.round((size / 0.75) * 10) / 10}px`);
          const c = rPr ? colorOf(kid(rPr, 'solidFill')) : null;
          if (c && c !== L.color) st.push(`color: ${c}`);
          const face = rPr && kid(rPr, 'latin') ? faceOf(attr(kid(rPr, 'latin'), 'typeface')) : null;
          if (face && face !== faceOf(L.font)) st.push(`font-family: ${fontStack(face).replace(/"/g, "'")}`);
          if (st.length) t = `<span style="${st.join('; ')}">${t}</span>`;
          const b = rPr && attr(rPr, 'b') !== null ? attr(rPr, 'b') === '1' : !!L.bold;
          const it = rPr && attr(rPr, 'i') !== null ? attr(rPr, 'i') === '1' : !!L.italic;
          if (b && !base.bold) t = `<b>${t}</b>`;
          if (it && !base.italic) t = `<i>${t}</i>`;
          if (rPr && attr(rPr, 'u') && attr(rPr, 'u') !== 'none') t = `<u>${t}</u>`;
          if (rPr && attr(rPr, 'strike') && attr(rPr, 'strike') !== 'noStrike') t = `<s>${t}</s>`;
          const link = rPr && kid(rPr, 'hlinkClick');
          const url = link && srels[attr(link, 'id')] && srels[attr(link, 'id')].external ? srels[attr(link, 'id')].target : null;
          if (url && /^(https?:|mailto:)/i.test(url)) t = `<a href="${escapeHtml(url)}">${t}</a>`;
          inner += t;
        }
        const pst = [];
        if (L.align && L.align !== (base.align || 'left')) pst.push(`text-align: ${L.align}`);
        if (lvl && L.size && L.size !== base.size) pst.push(`font-size: ${Math.round((L.size / 0.75) * 10) / 10}px`);
        if (L.color && L.color !== base.color) pst.push(`color: ${L.color}`);
        const noBullet = (base.bullet === 'char' || base.bullet === 'num') && L.bullet === 'none';
        html += `<p${lvl ? ` data-lvl="${lvl}"` : ''}${noBullet ? ' data-nobullet="1"' : ''}${pst.length ? ` style="${pst.join('; ')}"` : ''}>${inner || '<br>'}</p>`;
      }
      const bodyPr = kid(txBody, 'bodyPr');
      const anchor = (bodyPr && attr(bodyPr, 'anchor')) || (ph && [findPh(layout.phs, type, idx), findPh(master.phs, type, idx)].map((p) => p && p.anchor).find(Boolean)) || 't';
      const font = faceOf(base.font);
      const themeFont = kind === 'title' ? pres.customTheme.heading : pres.customTheme.body;
      return {
        html: html.replace(/^(<p><br><\/p>)+$/, ''),
        style: {
          size: Math.round(((base.size || (kind === 'title' ? 44 : 18)) / 0.75) * 10) / 10, align: base.align || 'left', valign: anchor === 'ctr' ? 'middle' : anchor === 'b' ? 'bottom' : 'top',
          bullets: base.bullet === 'char' || undefined, numbered: base.bullet === 'num' || undefined,
          role: kind === 'title' ? 'title' : type === 'subTitle' ? 'subtitle' : 'body',
          color: base.color || null, bold: base.bold && kind !== 'title' ? true : undefined, italic: base.italic || undefined,
          font: font && fontStack(font) !== themeFont ? font : undefined, autofit: bodyPr && kid(bodyPr, 'normAutofit') ? undefined : false,
        },
      };
    };
    const chartOf = async (rid) => {
      const rel = srels[rid];
      const xml = rel ? await text(rel.path) : null;
      if (!xml) return null;
      const cx = parseXml(xml);
      const plot = first(cx, 'plotArea');
      const KIND = { barChart: 'column', bar3DChart: 'column', lineChart: 'line', line3DChart: 'line', areaChart: 'area', area3DChart: 'area', pieChart: 'pie', pie3DChart: 'pie', doughnutChart: 'doughnut', scatterChart: 'scatter' };
      const kindEl = plot ? kids(plot).find((k) => KIND[k.localName]) : null;
      if (!kindEl) return null;
      let type = KIND[kindEl.localName];
      if (type === 'column') {
        const dir = first(kindEl, 'barDir');
        const grouping = first(kindEl, 'grouping');
        type = dir && attr(dir, 'val') === 'bar' ? 'bar' : grouping && /stacked/i.test(attr(grouping, 'val') || '') ? 'stacked' : 'column';
      }
      const pts = (el) => {
        if (!el) return [];
        const cache = first(el, 'strCache') || first(el, 'numCache') || first(el, 'strLit') || first(el, 'numLit');
        if (!cache) return [];
        const n = Number(attr(first(cache, 'ptCount'), 'val') || 0);
        const out = Array(n).fill(null);
        for (const pt of all(cache, 'pt')) out[Number(attr(pt, 'idx'))] = first(pt, 'v') ? first(pt, 'v').textContent : null;
        return out;
      };
      const sers = kids(kindEl, 'ser');
      if (!sers.length) return null;
      const categories = pts(kid(sers[0], 'cat') || kid(sers[0], 'xVal')).map((v) => (v === null ? '' : String(v)));
      const series = sers.map((s, i) => ({ name: pts(kid(s, 'tx'))[0] || (first(kid(s, 'tx'), 'v') || {}).textContent || `Series ${i + 1}`, values: pts(kid(s, 'val') || kid(s, 'yVal')).map((v) => (v === null || v === '' ? null : Number(v))) }));
      const titleEl = kid(first(cx, 'chart'), 'title');
      const title = titleEl ? all(titleEl, 't').map((t) => t.textContent).join('') : '';
      return { type, title, categories: categories.length ? categories : series[0].values.map((_, i) => String(i + 1)), series };
    };
    const walk = async (tree, off = { dx: 0, dy: 0, sx: 1, sy: 1 }) => {
      for (const el of kids(tree)) {
        const ln = el.localName;
        if (ln === 'grpSp') {
          const gx = first(kid(el, 'grpSpPr'), 'xfrm');
          if (gx) {
            const o = kid(gx, 'off'); const e = kid(gx, 'ext'); const co = kid(gx, 'chOff'); const ce = kid(gx, 'chExt');
            const sx = ce && Number(attr(ce, 'cx')) ? Number(attr(e, 'cx')) / Number(attr(ce, 'cx')) : 1;
            const sy = ce && Number(attr(ce, 'cy')) ? Number(attr(e, 'cy')) / Number(attr(ce, 'cy')) : 1;
            await walk(el, { dx: off.dx + (Number(attr(o, 'x')) / EMU - (co ? Number(attr(co, 'x')) / EMU : 0) * sx) * off.sx, dy: off.dy + (Number(attr(o, 'y')) / EMU - (co ? Number(attr(co, 'y')) / EMU : 0) * sy) * off.sy, sx: sx * off.sx, sy: sy * off.sy });
          } else await walk(el, off);
          continue;
        }
        const ph = first(first(el, 'nvPr'), 'ph');
        if (ph && ['sldNum', 'dt', 'ftr'].includes(attr(ph, 'type'))) continue;
        const box = xfrmOf(el, ph);
        if (!box) continue;
        const pos = { x: off.dx + box.x * off.sx, y: off.dy + box.y * off.sy, w: box.w * off.sx, h: box.h * off.sy, rot: box.rot, flipH: box.flipH, flipV: box.flipV };
        if (ln === 'sp') {
          const spPr = kid(el, 'spPr');
          const geom = first(spPr, 'prstGeom');
          const prst = geom ? attr(geom, 'prst') : 'rect';
          const styleEl = kid(el, 'style');
          const fill = spPr && kid(spPr, 'solidFill') ? colorOf(kid(spPr, 'solidFill')) : spPr && kid(spPr, 'gradFill') ? colorOf(first(kid(spPr, 'gradFill'), 'gs')) : spPr && kid(spPr, 'noFill') ? null : styleEl && geom && !ph ? colorOf(kid(styleEl, 'fillRef')) : null;
          const lnEl = spPr && kid(spPr, 'ln');
          const lnRef = styleEl ? kid(styleEl, 'lnRef') : null;
          const stroke = lnEl && kid(lnEl, 'solidFill') ? colorOf(kid(lnEl, 'solidFill')) : lnEl && kid(lnEl, 'noFill') ? null : !ph && lnRef && Number(attr(lnRef, 'idx')) > 0 ? colorOf(lnRef) : null;
          const t = textOf(el, ph);
          const isShape = !ph && (prst !== 'rect' || fill) && !attr(first(el, 'cNvSpPr'), 'txBox');
          const item = { id: uid('it'), type: isShape && GEOM_BACK[prst] ? 'shape' : 'text', ...pos, html: t.html, style: t.style };
          if (ph) item.ph = { ctrTitle: 'title', subTitle: 'subtitle' }[attr(ph, 'type') || 'body'] || attr(ph, 'type') || 'body';
          if (item.type === 'shape') {
            item.shape = GEOM_BACK[prst] || 'rect';
            item.style.fill = fill || 'none';
            // A shape's text takes its theme style's colour (white on the fill, as PowerPoint draws it).
            const fontRef = styleEl ? colorOf(kid(styleEl, 'fontRef')) : null;
            if (fontRef) item.style.color = fontRef;
            else if (!t.style.color) item.style.color = '#ffffff';
          } else if (fill) item.style.fill = fill;
          if (stroke) { item.style.stroke = stroke; item.style.strokeWidth = Math.max(1, Math.round(Number(attr(lnEl, 'w') || 12700) / 9525)); }
          if (!t.html && item.type === 'text' && !fill && !stroke) continue;
          slide.items.push(item);
        } else if (ln === 'pic') {
          const blip = first(el, 'blip');
          const a = blip ? await assetFrom(srels, attr(blip, 'embed')) : null;
          if (a) slide.items.push({ id: uid('it'), type: 'image', ...pos, asset: a, style: { fit: 'fill' }, alt: attr(first(el, 'cNvPr'), 'descr') || '' });
        } else if (ln === 'cxnSp') {
          const lnEl = first(el, 'ln');
          slide.items.push({ id: uid('it'), type: 'line', ...pos, dir: box.flipV ? 'up' : 'down', style: { stroke: lnEl ? colorOf(kid(lnEl, 'solidFill')) : '#000000', strokeWidth: Math.max(1, Math.round(Number(attr(lnEl, 'w') || 19050) / 9525)), arrow: !!(lnEl && kid(lnEl, 'tailEnd') && attr(kid(lnEl, 'tailEnd'), 'type') !== 'none') } });
        } else if (ln === 'graphicFrame') {
          const xf = kid(el, 'xfrm');
          const o = xf && kid(xf, 'off'); const e = xf && kid(xf, 'ext');
          const gp = xf ? { x: off.dx + Number(attr(o, 'x')) / EMU, y: off.dy + Number(attr(o, 'y')) / EMU, w: Number(attr(e, 'cx')) / EMU, h: Number(attr(e, 'cy')) / EMU } : pos;
          const chartRef = first(el, 'chart');
          if (chartRef) {
            const chart = await chartOf(attr(chartRef, 'id'));
            if (chart) slide.items.push({ id: uid('it'), type: 'chart', ...gp, rot: 0, chart });
            continue;
          }
          const tbl = first(el, 'tbl');
          if (!tbl) continue;
          const tblPr = kid(tbl, 'tblPr');
          const rows = kids(tbl, 'tr').map((tr) => kids(tr, 'tc').map((tc) => ({ html: kids(kid(tc, 'txBody'), 'p').map((p) => escapeHtml(all(p, 't').map((x) => x.textContent).join(''))).join('<br>') })));
          const sizes = all(tbl, 'rPr').map((x) => Number(attr(x, 'sz') || 0)).filter(Boolean);
          slide.items.push({ id: uid('it'), type: 'table', ...gp, rot: 0, rows, style: { size: sizes.length ? Math.round((sizes[0] / 100 / 0.75) * 10) / 10 : 24, headerRow: tblPr ? attr(tblPr, 'firstRow') === '1' : true, striped: tblPr && attr(tblPr, 'bandRow') === '1' ? true : undefined } });
        }
      }
    };
    await walk(first(sd, 'spTree'));
    const tr = first(sd, 'transition');
    if (tr) {
      const kind = kids(tr)[0] ? kids(tr)[0].localName : 'fade';
      slide.transition = { type: { push: 'push', wipe: 'slide', cover: 'cover', zoom: 'zoom', fade: 'fade', split: 'fade' }[kind] || 'fade', duration: attr(tr, 'spd') === 'slow' ? 1 : attr(tr, 'spd') === 'fast' ? 0.3 : 0.5 };
    } else slide.transition = { type: 'none', duration: 0.5 };
    const notesRel = Object.values(srels).find((x) => /notesSlide$/.test(x.type));
    if (notesRel) {
      const nx = await text(notesRel.path);
      if (nx) {
        const body = all(parseXml(nx), 'sp').find((sp) => { const p = first(sp, 'ph'); return p && attr(p, 'type') === 'body'; });
        if (body) slide.notes = all(body, 'p').map((p) => all(p, 't').map((t) => t.textContent).join('')).join('\n').trim();
      }
    }
    pres.slides.push(slide);
  }
  if (!pres.slides.length) pres.slides.push({ id: uid('sl'), layout: 'blank', items: [], notes: '', transition: { type: 'fade', duration: 0.5 } });
  return pres;
}

function resolvePath(dir, target) {
  if (target.startsWith('/')) return target.slice(1);
  const parts = `${dir}/${target}`.split('/');
  const out = [];
  for (const p of parts) { if (p === '..') out.pop(); else if (p !== '.' && p !== '') out.push(p); }
  return out.join('/');
}
