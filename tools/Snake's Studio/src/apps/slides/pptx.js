// PowerPoint .pptx: reading into our presentations and writing them out.
// Written from the Office Open XML spec (ECMA-376), no outside code.
import { readZip, writeZip } from '../../kit/zip.js';
import { esc, parseXml, all, first, kids, kid, attr, XML_HEAD } from '../../kit/xml.js';
import { uid, bytesToBase64, dataUrlToBytes, escapeHtml } from '../../kit/dom.js';
import { drawChart } from '../../kit/charts.js';
import { THEMES, themeColor, newPresentation, slideBackground } from './model.js';

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
        collectRuns(c, {}, runs);
        paras.push({ runs, level, bullet, align: c.style.textAlign });
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
    const bu = p.bullet && p.bullet.num ? `<a:buFont typeface="+mj-lt"/><a:buAutoNum type="arabicPeriod"/>` : p.bullet || base.bullets ? '<a:buFont typeface="Arial"/><a:buChar char="•"/>' : '<a:buNone/>';
    const ind = p.bullet || base.bullets ? ` marL="${342900 + p.level * 342900}" indent="-342900"` : p.level ? ` marL="${p.level * 342900}"` : '';
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
  const theme = THEMES[pres.theme] || THEMES.snake;
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
  const ct = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>${[...exts].map((e) => `<Default Extension="${e}" ContentType="${e === 'svg' ? 'image/svg+xml' : `image/${e}`}"/>`).join('')}<Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/><Override PartName="/ppt/slideMasters/slideMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme1.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>${hasNotes ? '<Override PartName="/ppt/notesMasters/notesMaster1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"/><Override PartName="/ppt/theme/theme2.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/>' : ''}${pres.slides.map((s, i) => `<Override PartName="/ppt/slides/slide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>${s.notes ? `<Override PartName="/ppt/notesSlides/notesSlide${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"/>` : ''}`).join('')}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
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
  const rels = async (path) => {
    const dir = path.slice(0, path.lastIndexOf('/'));
    const file = path.slice(path.lastIndexOf('/') + 1);
    const xml = await text(`${dir}/_rels/${file}.rels`);
    const map = {};
    if (!xml) return map;
    for (const r of all(parseXml(xml), 'Relationship')) {
      const t = r.getAttribute('Target');
      map[r.getAttribute('Id')] = { type: r.getAttribute('Type'), target: t, path: resolvePath(dir, t), external: r.getAttribute('TargetMode') === 'External' };
    }
    return map;
  };
  const presRels = await rels('ppt/presentation.xml');
  // Theme colours.
  const scheme = {};
  const themeRel = Object.values(presRels).find((r) => /theme$/.test(r.type));
  const themeXml = themeRel ? await text(themeRel.path) : null;
  if (themeXml) {
    const cs = first(parseXml(themeXml), 'clrScheme');
    for (const el of kids(cs)) {
      const c = first(el, 'srgbClr') || first(el, 'sysClr');
      scheme[el.localName] = c ? (attr(c, 'val') && c.localName === 'srgbClr' ? attr(c, 'val') : attr(c, 'lastClr')) : null;
    }
    scheme.bg1 = scheme.lt1; scheme.tx1 = scheme.dk1; scheme.bg2 = scheme.lt2; scheme.tx2 = scheme.dk2;
  }
  const colorOf = (el) => {
    if (!el) return null;
    const s = first(el, 'srgbClr');
    const sc = first(el, 'schemeClr');
    let hex = s ? attr(s, 'val') : sc ? scheme[attr(sc, 'val')] : null;
    const src = s || sc;
    if (!hex) return null;
    if (src) {
      const lm = first(src, 'lumMod');
      const lo = first(src, 'lumOff');
      if (lm || lo) {
        const n = parseInt(hex, 16);
        const f = (v) => Math.round(Math.min(255, v * (lm ? Number(attr(lm, 'val')) / 100000 : 1) + 255 * (lo ? Number(attr(lo, 'val')) / 100000 : 0)));
        hex = [f(n >> 16), f((n >> 8) & 255), f(n & 255)].map((v) => v.toString(16).padStart(2, '0')).join('');
      }
    }
    return `#${hex.toLowerCase()}`;
  };

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

  // Placeholder positions inherited from layouts and masters.
  const phMap = async (path) => {
    const xml = await text(path);
    const out = [];
    if (!xml) return out;
    for (const sp of all(parseXml(xml), 'sp')) {
      const ph = first(first(sp, 'nvPr'), 'ph');
      const xf = first(first(sp, 'spPr'), 'xfrm');
      if (ph && xf) out.push({ type: attr(ph, 'type') || 'body', idx: attr(ph, 'idx'), xfrm: xf });
    }
    return out;
  };

  const sldIds = all(first(pd, 'sldIdLst'), 'sldId');
  for (const sid of sldIds) {
    const r = presRels[sid.getAttributeNS(NS.r, 'id') || attr(sid, 'id')];
    if (!r) continue;
    const sx = await text(r.path);
    if (!sx) continue;
    const sd = parseXml(sx);
    const srels = await rels(r.path);
    const layoutRel = Object.values(srels).find((x) => /slideLayout$/.test(x.type));
    const layoutPh = layoutRel ? await phMap(layoutRel.path) : [];
    const layoutRels = layoutRel ? await rels(layoutRel.path) : {};
    const masterRel = Object.values(layoutRels).find((x) => /slideMaster$/.test(x.type));
    const masterPh = masterRel ? await phMap(masterRel.path) : [];
    const slide = { id: uid('sl'), layout: 'blank', items: [], notes: '', transition: { type: 'fade', duration: 0.5 }, hidden: attr(first(sd, 'sld'), 'show') === '0' };
    // Background.
    const bgPr = first(first(sd, 'bg'), 'bgPr');
    if (bgPr) {
      const blip = first(bgPr, 'blip');
      if (blip) { const a = await assetFrom(srels, attr(blip, 'embed')); if (a) slide.bg = { image: a }; }
      else if (first(bgPr, 'gradFill')) { const stops = all(bgPr, 'gs').map((g) => colorOf(g)); slide.bg = { color: stops[0], gradient: stops[stops.length - 1], angle: 135 }; }
      else { const c = colorOf(first(bgPr, 'solidFill')); if (c) slide.bg = { color: c }; }
    } else slide.bg = { color: '#ffffff' };
    const xfrmOf = (el, ph) => {
      let xf = first(first(el, 'spPr') || el, 'xfrm');
      if (!xf && ph) {
        const type = attr(ph, 'type') || 'body';
        const idx = attr(ph, 'idx');
        const hit = layoutPh.find((p) => (idx && p.idx === idx) || p.type === type) || masterPh.find((p) => p.type === type || (type === 'ctrTitle' && p.type === 'title') || (type === 'subTitle' && p.type === 'body'));
        xf = hit && hit.xfrm;
      }
      if (!xf) return null;
      const off = kid(xf, 'off');
      const ext = kid(xf, 'ext');
      return { x: Number(attr(off, 'x')) / EMU, y: Number(attr(off, 'y')) / EMU, w: Number(attr(ext, 'cx')) / EMU, h: Number(attr(ext, 'cy')) / EMU, rot: Number(attr(xf, 'rot') || 0) / 60000, flipH: attr(xf, 'flipH') === '1', flipV: attr(xf, 'flipV') === '1' };
    };
    const textOf = (txBody, defSize) => {
      let html = '';
      let maxSz = 0;
      let algn = null;
      let bullets = false;
      for (const p of kids(txBody, 'p')) {
        const pPr = kid(p, 'pPr');
        if (pPr && attr(pPr, 'algn')) algn = attr(pPr, 'algn');
        if (pPr && (kid(pPr, 'buChar') || kid(pPr, 'buAutoNum'))) bullets = true;
        let inner = '';
        for (const r of kids(p)) {
          if (r.localName === 'br') { inner += '<br>'; continue; }
          if (r.localName !== 'r' && r.localName !== 'fld') continue;
          const rPr = kid(r, 'rPr');
          const t = escapeHtml((kid(r, 't') || { textContent: '' }).textContent);
          const st = [];
          const szv = rPr && attr(rPr, 'sz') ? Number(attr(rPr, 'sz')) / 100 / 0.75 : null;
          if (szv) { maxSz = Math.max(maxSz, szv); st.push(`font-size: ${Math.round(szv)}px`); }
          const c = rPr ? colorOf(kid(rPr, 'solidFill')) : null;
          if (c) st.push(`color: ${c}`);
          let s = st.length ? `<span style="${st.join('; ')}">${t}</span>` : t;
          if (rPr && attr(rPr, 'b') === '1') s = `<b>${s}</b>`;
          if (rPr && attr(rPr, 'i') === '1') s = `<i>${s}</i>`;
          if (rPr && attr(rPr, 'u') && attr(rPr, 'u') !== 'none') s = `<u>${s}</u>`;
          inner += s;
        }
        html += `<p${pPr && attr(pPr, 'algn') && attr(pPr, 'algn') !== 'l' ? ` style="text-align: ${{ ctr: 'center', r: 'right', just: 'justify' }[attr(pPr, 'algn')] || 'left'}"` : ''}>${inner || '<br>'}</p>`;
      }
      return { html: html.replace(/^(<p><br><\/p>)+$/, ''), size: maxSz || defSize, align: { ctr: 'center', r: 'right', just: 'justify' }[algn] || 'left', bullets };
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
          const fill = spPr && kid(spPr, 'solidFill') ? colorOf(kid(spPr, 'solidFill')) : spPr && kid(spPr, 'gradFill') ? colorOf(first(kid(spPr, 'gradFill'), 'gs')) : null;
          const lnEl = spPr && kid(spPr, 'ln');
          const stroke = lnEl && kid(lnEl, 'solidFill') ? colorOf(kid(lnEl, 'solidFill')) : null;
          const type = ph ? attr(ph, 'type') || 'body' : null;
          const isTitle = type === 'title' || type === 'ctrTitle';
          const t = textOf(kid(el, 'txBody'), isTitle ? 44 / 0.75 * 0.75 : type === 'subTitle' ? 30 : 24);
          const bodyPr = first(kid(el, 'txBody'), 'bodyPr');
          const valign = bodyPr && attr(bodyPr, 'anchor') === 'ctr' ? 'middle' : bodyPr && attr(bodyPr, 'anchor') === 'b' ? 'bottom' : 'top';
          const isShape = prst !== 'rect' || fill;
          const item = {
            id: uid('it'), type: isShape && !ph && GEOM_BACK[prst] ? 'shape' : 'text', ...pos, html: t.html,
            style: { size: Math.round(t.size || 24), align: t.align, valign, bullets: t.bullets && !isTitle, role: isTitle ? 'title' : type === 'subTitle' ? 'subtitle' : 'body', color: null },
          };
          if (item.type === 'shape') { item.shape = GEOM_BACK[prst] || 'rect'; item.style.fill = fill || 'none'; item.style.color = '#ffffff'; }
          else if (fill) item.style.fill = fill;
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
          const tbl = first(el, 'tbl');
          if (!tbl) continue;
          const xf = kid(el, 'xfrm');
          const o = xf && kid(xf, 'off'); const e = xf && kid(xf, 'ext');
          const gp = xf ? { x: off.dx + Number(attr(o, 'x')) / EMU, y: off.dy + Number(attr(o, 'y')) / EMU, w: Number(attr(e, 'cx')) / EMU, h: Number(attr(e, 'cy')) / EMU } : pos;
          const rows = kids(tbl, 'tr').map((tr) => kids(tr, 'tc').map((tc) => ({ html: escapeHtml(all(tc, 't').map((x) => x.textContent).join('')) })));
          slide.items.push({ id: uid('it'), type: 'table', ...gp, rot: 0, rows, style: { size: 18 } });
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
        const body = all(parseXml(nx), 'sp').find((sp) => { const ph = first(sp, 'ph'); return ph && attr(ph, 'type') === 'body'; });
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
