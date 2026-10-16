// Microsoft Word .docx: reading into our HTML, and writing our HTML out.
// Written from the Office Open XML spec (ECMA-376); no outside code.
import { readZip, writeZip } from '../../kit/zip.js';
import { esc, parseXml, all, first, kids, kid, attr, XML_HEAD } from '../../kit/xml.js';
import { bytesToBase64, dataUrlToBytes } from '../../kit/dom.js';
import { PAGE_SIZES, PX_PER_IN, defaultMeta } from './editor.js';

const TWIP = 15; // twentieths of a point per CSS pixel (1440 per inch / 96)
const EMU = 9525; // English Metric Units per CSS pixel

const NS = {
  w: 'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  r: 'http://schemas.openxmlformats.org/officeDocument/2006/relationships',
  wp: 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing',
  a: 'http://schemas.openxmlformats.org/drawingml/2006/main',
  pic: 'http://schemas.openxmlformats.org/drawingml/2006/picture',
};

// ===========================================================================
// Reading
// ===========================================================================
const HIGHLIGHT = {
  yellow: '#ffff00', green: '#00ff00', cyan: '#00ffff', magenta: '#ff00ff', blue: '#0000ff', red: '#ff0000',
  darkBlue: '#000080', darkCyan: '#008080', darkGreen: '#008000', darkMagenta: '#800080', darkRed: '#800000',
  darkYellow: '#808000', darkGray: '#808080', lightGray: '#c0c0c0', black: '#000000', white: '#ffffff',
};

function relsOf(xmlText) {
  const map = {};
  if (!xmlText) return map;
  for (const r of all(parseXml(xmlText), 'Relationship')) {
    map[r.getAttribute('Id')] = { target: r.getAttribute('Target'), type: r.getAttribute('Type'), external: r.getAttribute('TargetMode') === 'External' };
  }
  return map;
}

const val = (el, name) => {
  const k = first(el, name);
  return k ? attr(k, 'val') : null;
};
const on = (rPr, name) => {
  const k = rPr && kid(rPr, name);
  if (!k) return false;
  const v = attr(k, 'val');
  return v === null || !['0', 'false', 'off', 'none'].includes(v);
};

export async function readDocx(bytes) {
  const zip = readZip(bytes);
  const text = async (name) => (zip.has(name) ? zip.get(name).text() : null);
  const docXml = await text('word/document.xml');
  if (!docXml) throw new Error('This file has no document in it (word/document.xml is missing).');
  const doc = parseXml(docXml);
  const rels = relsOf(await text('word/_rels/document.xml.rels'));

  // Style names (headings are found by name: ids differ between languages).
  const styleNames = {};
  const stylesXml = await text('word/styles.xml');
  if (stylesXml) {
    for (const s of all(parseXml(stylesXml), 'style')) {
      const id = attr(s, 'styleId');
      const nm = first(s, 'name');
      const based = first(s, 'basedOn');
      styleNames[id] = { name: (nm ? attr(nm, 'val') : id || '').toLowerCase(), based: based ? attr(based, 'val') : null };
    }
  }
  const styleName = (id) => {
    let s = styleNames[id];
    let guard = 0;
    while (s && guard++ < 6) {
      if (/^(heading [1-6]|title|subtitle|quote|intense quote|caption|code|html preformatted|list paragraph)$/.test(s.name)) return s.name;
      s = s.based ? styleNames[s.based] : null;
    }
    return styleNames[id] ? styleNames[id].name : (id || '').toLowerCase();
  };

  // Numbering: numId -> level -> format.
  const numFmt = {};
  const numXml = await text('word/numbering.xml');
  if (numXml) {
    const nx = parseXml(numXml);
    const abstract = {};
    for (const a of all(nx, 'abstractNum')) {
      abstract[attr(a, 'abstractNumId')] = Object.fromEntries(all(a, 'lvl').map((l) => [attr(l, 'ilvl'), { fmt: val(l, 'numFmt') || 'bullet', text: val(l, 'lvlText') || '' }]));
    }
    for (const n of all(nx, 'num')) {
      const aid = first(n, 'abstractNumId');
      numFmt[attr(n, 'numId')] = abstract[aid ? attr(aid, 'val') : ''] || {};
    }
  }

  const imageCache = {};
  const imageUrl = async (rid) => {
    const rel = rels[rid];
    if (!rel || rel.external) return '';
    if (imageCache[rid]) return imageCache[rid];
    const path = rel.target.startsWith('/') ? rel.target.slice(1) : `word/${rel.target.replace(/^\.\//, '')}`;
    const entry = zip.get(path);
    if (!entry) return '';
    const ext = path.split('.').pop().toLowerCase();
    const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', bmp: 'image/bmp', webp: 'image/webp', tif: 'image/tiff', tiff: 'image/tiff' }[ext];
    if (!mime) return '';
    imageCache[rid] = `data:${mime};base64,${bytesToBase64(await entry.read())}`;
    return imageCache[rid];
  };

  const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  async function runs(parent) {
    let out = '';
    for (const node of kids(parent)) {
      const ln = node.localName;
      if (ln === 'r') out += await run(node);
      else if (ln === 'hyperlink') {
        const rid = attr(node, 'id');
        const anchor = attr(node, 'anchor');
        let href = '';
        if (rid && rels[rid] && /^(https?:|mailto:)/i.test(rels[rid].target)) href = rels[rid].target;
        else if (anchor) href = `#h-${anchor.replace(/[^\w-]/g, '')}`;
        const inner = await runs(node);
        out += href ? `<a href="${escText(href)}">${inner}</a>` : inner;
      } else if (ln === 'ins' || ln === 'smartTag' || ln === 'customXml' || ln === 'fldSimple' || ln === 'sdtContent') out += await runs(node);
      else if (ln === 'sdt') out += await runs(kid(node, 'sdtContent') || node);
      else if (ln === 'bookmarkStart') {
        const nm = attr(node, 'name');
        if (nm && !nm.startsWith('_')) out += `<span id="h-${nm.replace(/[^\w-]/g, '')}"></span>`;
      }
    }
    return out;
  }

  let fieldDepth = 0;
  async function run(r) {
    const rPr = kid(r, 'rPr');
    let content = '';
    for (const c of kids(r)) {
      const ln = c.localName;
      if (ln === 'fldChar') {
        const t = attr(c, 'fldCharType');
        if (t === 'begin') fieldDepth = 1;
        else if (t === 'separate') fieldDepth = 0;
        else if (t === 'end') fieldDepth = 0;
      } else if (ln === 'instrText' || fieldDepth) continue;
      else if (ln === 't') content += escText(c.textContent);
      else if (ln === 'tab' || ln === 'ptab') content += '\t';
      else if (ln === 'br' || ln === 'cr') content += attr(c, 'type') === 'page' ? '<!--PAGEBREAK-->' : '<br>';
      else if (ln === 'noBreakHyphen') content += '‑';
      else if (ln === 'softHyphen') content += '­';
      else if (ln === 'sym') {
        // Symbol-font characters (Wingdings and friends) have no Unicode meaning: show a bullet.
        const cp = parseInt(attr(c, 'char') || '', 16);
        if (Number.isFinite(cp)) content += cp >= 0xf000 ? '•' : escText(String.fromCodePoint(cp));
      } else if (ln === 'drawing' || ln === 'pict' || ln === 'object') {
        const blip = first(c, 'blip');
        const rid = blip ? attr(blip, 'embed') : (first(c, 'imagedata') ? attr(first(c, 'imagedata'), 'id') : null);
        const url = rid ? await imageUrl(rid) : '';
        const ext = first(c, 'extent');
        const w = ext ? Math.round(Number(attr(ext, 'cx')) / EMU) : 0;
        const docPr = first(c, 'docPr');
        const alt = docPr ? (attr(docPr, 'descr') || attr(docPr, 'name') || '') : '';
        const anchor = first(c, 'anchor');
        let cls = '';
        if (anchor) {
          const ph = first(anchor, 'positionH');
          const align = ph ? first(ph, 'align') : null;
          const a = align ? align.textContent : '';
          cls = a === 'right' ? ' class="img-right"' : a === 'center' ? ' class="img-center"' : ' class="img-left"';
        }
        if (url) content += `<img src="${url}" alt="${escText(alt)}"${w ? ` width="${w}"` : ''}${cls}>`;
        else content += `[${escText(alt || 'picture')}]`;
      }
    }
    if (!content) return '';
    if (!rPr) return content;
    const styles = [];
    if (val(rPr, 'color') && val(rPr, 'color') !== 'auto') styles.push(`color: #${val(rPr, 'color')}`);
    const sz = val(rPr, 'sz');
    if (sz) styles.push(`font-size: ${Number(sz) / 2}pt`);
    const fonts = kid(rPr, 'rFonts');
    const face = fonts ? (attr(fonts, 'ascii') || attr(fonts, 'hAnsi')) : null;
    if (face) {
      // Keep the kind of font when it is not installed here (Consolas -> any monospace).
      const generic = /mono|consol|courier|menlo|code/i.test(face) ? 'monospace' : /times|georgia|garamond|cambria|serif|book|palatino|minion/i.test(face) && !/sans/i.test(face) ? 'serif' : 'sans-serif';
      styles.push(`font-family: '${face.replace(/'/g, '')}', ${generic}`);
    }
    const hl = val(rPr, 'highlight');
    const shd = kid(rPr, 'shd');
    if (hl && HIGHLIGHT[hl]) styles.push(`background-color: ${HIGHLIGHT[hl]}`);
    else if (shd && attr(shd, 'fill') && !/^(auto|FFFFFF)$/i.test(attr(shd, 'fill'))) styles.push(`background-color: #${attr(shd, 'fill')}`);
    if (on(rPr, 'caps')) styles.push('text-transform: uppercase');
    if (on(rPr, 'smallCaps')) styles.push('font-variant: small-caps');
    let out = styles.length ? `<span style="${styles.join('; ')}">${content}</span>` : content;
    if (on(rPr, 'b')) out = `<b>${out}</b>`;
    if (on(rPr, 'i')) out = `<i>${out}</i>`;
    const u = kid(rPr, 'u');
    if (u && attr(u, 'val') !== 'none') out = `<u>${out}</u>`;
    if (on(rPr, 'strike') || on(rPr, 'dstrike')) out = `<s>${out}</s>`;
    const va = val(rPr, 'vertAlign');
    if (va === 'superscript') out = `<sup>${out}</sup>`;
    if (va === 'subscript') out = `<sub>${out}</sub>`;
    return out;
  }

  function pStyleAttrs(pPr) {
    const st = [];
    if (!pPr) return st;
    const jc = val(pPr, 'jc');
    if (jc === 'center') st.push('text-align: center');
    else if (jc === 'right' || jc === 'end') st.push('text-align: right');
    else if (jc === 'both' || jc === 'distribute') st.push('text-align: justify');
    const ind = kid(pPr, 'ind');
    if (ind) {
      const left = Number(attr(ind, 'left') || attr(ind, 'start') || 0);
      const right = Number(attr(ind, 'right') || attr(ind, 'end') || 0);
      const firstLine = Number(attr(ind, 'firstLine') || 0) - Number(attr(ind, 'hanging') || 0);
      if (left && !kid(pPr, 'numPr')) st.push(`margin-left: ${Math.round(left / TWIP)}px`);
      if (right) st.push(`margin-right: ${Math.round(right / TWIP)}px`);
      if (firstLine && !kid(pPr, 'numPr')) st.push(`text-indent: ${Math.round(firstLine / TWIP)}px`);
    }
    const sp = kid(pPr, 'spacing');
    if (sp) {
      const line = attr(sp, 'line');
      const rule = attr(sp, 'lineRule');
      if (line && (!rule || rule === 'auto')) {
        const lh = Math.round((Number(line) / 240) * 100) / 100;
        if (Math.abs(lh - 1.15) > 0.04 && lh > 0.5 && lh < 5) st.push(`line-height: ${lh}`);
      }
    }
    const shd = kid(pPr, 'shd');
    if (shd && attr(shd, 'fill') && !/^(auto|FFFFFF)$/i.test(attr(shd, 'fill'))) st.push(`background-color: #${attr(shd, 'fill')}`);
    return st;
  }

  // Lists: open <ul>/<ol> elements per level while list paragraphs follow each other.
  let listStack = []; // [{ tag, numId }]
  const closeLists = (level = -1) => {
    let s = '';
    while (listStack.length > level + 1) s += `</li></${listStack.pop().tag}>`;
    return s;
  };

  async function paragraph(p) {
    const pPr = kid(p, 'pPr');
    const sid = pPr ? val(pPr, 'pStyle') : null;
    const sname = styleName(sid);
    const numPr = pPr ? kid(pPr, 'numPr') : null;
    let body = await runs(p);
    let pageBreakAfter = false;
    if (body.includes('<!--PAGEBREAK-->')) {
      pageBreakAfter = body.trim().endsWith('<!--PAGEBREAK-->') || body.replace('<!--PAGEBREAK-->', '').trim() === '';
      body = body.replace(/<!--PAGEBREAK-->/g, '');
    }
    const st = pStyleAttrs(pPr);
    const styleAttr = st.length ? ` style="${st.join('; ')}"` : '';
    const inner = body || '<br>';
    let out = '';
    if (numPr && first(numPr, 'numId') && attr(first(numPr, 'numId'), 'val') !== '0') {
      const numId = attr(first(numPr, 'numId'), 'val');
      const lvl = Number(val(numPr, 'ilvl') || 0);
      const f = (numFmt[numId] || {})[String(lvl)] || { fmt: 'bullet' };
      const tag = f.fmt === 'bullet' || f.fmt === 'none' ? 'ul' : 'ol';
      const type = { lowerLetter: 'lower-alpha', upperLetter: 'upper-alpha', lowerRoman: 'lower-roman', upperRoman: 'upper-roman' }[f.fmt];
      if (listStack.length > lvl + 1) out += closeLists(lvl);
      if (listStack.length === lvl + 1) {
        const top = listStack[lvl];
        if (top.tag !== tag) { out += closeLists(lvl - 1); }
        else out += '</li>';
      }
      while (listStack.length < lvl + 1) {
        listStack.push({ tag, numId });
        out += `<${tag}${type ? ` style="list-style-type: ${type}"` : ''}>`;
      }
      out += `<li${styleAttr}>${inner}`;
      return out;
    }
    out += closeLists();
    let html;
    if (/^heading [1-6]$/.test(sname)) {
      const n = sname.slice(-1);
      html = `<h${n}${styleAttr}>${inner}</h${n}>`;
    } else if (sname === 'title') html = `<p class="title"${styleAttr}>${inner}</p>`;
    else if (sname === 'subtitle') html = `<p class="subtitle"${styleAttr}>${inner}</p>`;
    else if (sname === 'quote' || sname === 'intense quote') html = `<p class="quote"${styleAttr}>${inner}</p>`;
    else if (sname === 'caption') html = `<p class="caption"${styleAttr}>${inner}</p>`;
    else if (sname === 'code' || sname === 'html preformatted') html = `<pre${styleAttr}>${inner}</pre>`;
    else if (body === '' && pageBreakAfter) html = '';
    else html = `<p${styleAttr}>${inner}</p>`;
    if (pageBreakAfter) html += '<div class="page-break" contenteditable="false"></div>';
    return out + html;
  }

  async function table(tbl) {
    const cols = all(kid(tbl, 'tblGrid'), 'gridCol').map((g) => Math.round(Number(attr(g, 'w') || 0) / TWIP));
    const rows = kids(tbl, 'tr');
    // vMerge: count how many rows each "restart" cell spans.
    const grid = rows.map((tr) => {
      let c = 0;
      return kids(tr, 'tc').map((tc) => {
        const tcPr = kid(tc, 'tcPr');
        const span = Number(val(tcPr, 'gridSpan') || 1);
        const vm = tcPr ? kid(tcPr, 'vMerge') : null;
        const cell = { tc, col: c, span, vmerge: vm ? (attr(vm, 'val') === 'restart' ? 'restart' : 'continue') : null, rowspan: 1 };
        c += span;
        return cell;
      });
    });
    for (let r = 0; r < grid.length; r++) {
      for (const cell of grid[r]) {
        if (cell.vmerge !== 'restart') continue;
        for (let rr = r + 1; rr < grid.length; rr++) {
          const below = grid[rr].find((x) => x.col === cell.col);
          if (below && below.vmerge === 'continue') { cell.rowspan++; below.skip = true; } else break;
        }
      }
    }
    const tblPr = kid(tbl, 'tblPr');
    const borders = tblPr ? kid(tblPr, 'tblBorders') : null;
    const noBorders = borders && kids(borders).every((b) => ['nil', 'none'].includes(attr(b, 'val')));
    let out = `<table class="${noBorders ? 'tbl-plain' : 'tbl-grid'}">`;
    if (cols.length && cols.every((w) => w > 0)) out += `<colgroup>${cols.map((w) => `<col style="width:${w}px">`).join('')}</colgroup>`;
    out += '<tbody>';
    for (let r = 0; r < grid.length; r++) {
      out += '<tr>';
      for (const cell of grid[r]) {
        if (cell.skip) continue;
        const tcPr = kid(cell.tc, 'tcPr');
        const st = [];
        const shd = tcPr ? kid(tcPr, 'shd') : null;
        if (shd && attr(shd, 'fill') && !/^(auto|FFFFFF)$/i.test(attr(shd, 'fill'))) st.push(`background-color: #${attr(shd, 'fill')}`);
        const va = val(tcPr, 'vAlign');
        if (va === 'center') st.push('vertical-align: middle');
        else if (va === 'bottom') st.push('vertical-align: bottom');
        let inner = '';
        listStack = [];
        for (const child of kids(cell.tc)) {
          if (child.localName === 'p') inner += await paragraph(child);
          else if (child.localName === 'tbl') inner += closeLists() + await table(child);
        }
        inner += closeLists();
        // A cell with one plain paragraph keeps just its text.
        const single = /^<p>(.*)<\/p>$/s.exec(inner);
        if (single && !single[1].includes('<p')) inner = single[1];
        out += `<td${cell.span > 1 ? ` colspan="${cell.span}"` : ''}${cell.rowspan > 1 ? ` rowspan="${cell.rowspan}"` : ''}${st.length ? ` style="${st.join('; ')}"` : ''}>${inner || '<br>'}</td>`;
      }
      out += '</tr>';
    }
    return `${out}</tbody></table>`;
  }

  const body = first(doc, 'body');
  let html = '';
  async function blocks(parent) {
    for (const node of kids(parent)) {
      const ln = node.localName;
      if (ln === 'p') html += await paragraph(node);
      else if (ln === 'tbl') { html += closeLists(); html += await table(node); listStack = []; }
      else if (ln === 'sdt') await blocks(kid(node, 'sdtContent') || node);
      else if (ln === 'customXml' || ln === 'ins') await blocks(node);
    }
  }
  await blocks(body);
  html += closeLists();
  // Checklists come back from Word as paragraphs starting with a box character.
  html = html.replace(/(?:<p[^>]*>[☐☒☑]\s?.*?<\/p>)+/g, (run) => {
    const items = [...run.matchAll(/<p[^>]*>([☐☒☑])\s?(.*?)<\/p>/g)]
      .map((m) => `<li data-checked="${m[1] === '☐' ? 'false' : 'true'}">${m[2] || '<br>'}</li>`);
    return `<ul class="checklist">${items.join('')}</ul>`;
  });

  // Page setup, header and footer.
  const meta = defaultMeta();
  const sect = kids(body, 'sectPr')[0] || all(body, 'sectPr').pop();
  if (sect) {
    const pg = kid(sect, 'pgSz');
    if (pg) {
      const w = Number(attr(pg, 'w')) / 1440;
      const hh = Number(attr(pg, 'h')) / 1440;
      const land = attr(pg, 'orient') === 'landscape' || w > hh;
      const pw = Math.min(w, hh);
      const ph = Math.max(w, hh);
      let best = 'letter';
      let bestD = Infinity;
      for (const [k, s] of Object.entries(PAGE_SIZES)) {
        const d = Math.abs(s.w - pw) + Math.abs(s.h - ph);
        if (d < bestD) { bestD = d; best = k; }
      }
      meta.page.size = best;
      meta.page.orientation = land ? 'landscape' : 'portrait';
    }
    const mar = kid(sect, 'pgMar');
    if (mar) {
      for (const side of ['top', 'right', 'bottom', 'left']) {
        const v = Number(attr(mar, side));
        if (Number.isFinite(v) && v >= 0) meta.page.margins[side] = Math.round((v / 1440) * 100) / 100;
      }
    }
    meta.firstPageDifferent = !!kid(sect, 'titlePg');
    for (const [refName, key] of [['headerReference', 'header'], ['footerReference', 'footer']]) {
      const ref = kids(sect, refName).find((r) => attr(r, 'type') === 'default') || kids(sect, refName)[0];
      const rel = ref ? rels[attr(ref, 'id')] : null;
      if (!rel) { meta[key] = { left: '', center: '', right: '' }; continue; }
      const partXml = await text(`word/${rel.target}`);
      if (!partXml) continue;
      const part = parseXml(partXml);
      const zones = { left: '', center: '', right: '' };
      const ps = all(part, 'p');
      const lines = ps.map((p) => {
        let s = '';
        let field = '';
        let inField = false;
        for (const r of all(p, 'r')) {
          for (const c of kids(r)) {
            if (c.localName === 'fldChar') {
              const t = attr(c, 'fldCharType');
              if (t === 'begin') { inField = true; field = ''; }
              if (t === 'separate' || t === 'end') {
                // The field's code is known at "separate"; its cached result follows and is skipped.
                if (inField === true) {
                  if (/\bNUMPAGES\b/.test(field)) s += '{pages}';
                  else if (/\bPAGE\b/.test(field)) s += '{page}';
                  else if (/\b(DATE|TIME)\b/.test(field)) s += '{date}';
                }
                inField = t === 'separate' ? 'skip' : false;
              }
            } else if (c.localName === 'instrText') field += c.textContent;
            else if (inField === 'skip' || inField === true) continue;
            else if (c.localName === 't') s += c.textContent;
            else if (c.localName === 'tab') s += '\t';
          }
        }
        for (const f of all(p, 'fldSimple')) {
          const instr = attr(f, 'instr') || '';
          s += /NUMPAGES/.test(instr) ? '{pages}' : /PAGE/.test(instr) ? '{page}' : '';
        }
        return { s, jc: val(kid(p, 'pPr'), 'jc') };
      }).filter((l) => l.s.trim());
      if (lines.length) {
        const l = lines[0];
        const parts = l.s.split('\t');
        if (parts.length >= 3) { zones.left = parts[0]; zones.center = parts[1]; zones.right = parts.slice(2).join(' '); }
        else if (parts.length === 2) { zones.left = parts[0]; zones.right = parts[1]; }
        else zones[l.jc === 'center' ? 'center' : l.jc === 'right' ? 'right' : 'left'] = l.s;
      }
      meta[key] = zones;
    }
  }
  const core = await text('docProps/core.xml');
  if (core) {
    const c = parseXml(core);
    meta.title = (first(c, 'title') || {}).textContent || '';
    meta.author = (first(c, 'creator') || {}).textContent || '';
  }
  return { html, meta };
}

// ===========================================================================
// Writing
// ===========================================================================
const STYLE_IDS = { H1: 'Heading1', H2: 'Heading2', H3: 'Heading3', H4: 'Heading4', H5: 'Heading5', H6: 'Heading6', PRE: 'Code' };

function cssColor(v) {
  if (!v) return null;
  const s = v.trim();
  let m = /^#([0-9a-f]{6})$/i.exec(s);
  if (m) return m[1].toUpperCase();
  m = /^#([0-9a-f]{3})$/i.exec(s);
  if (m) return [...m[1]].map((c) => c + c).join('').toUpperCase();
  m = /^rgba?\((\d+)[, ]+(\d+)[, ]+(\d+)(?:[, /]+([\d.]+))?\)$/.exec(s);
  if (m) {
    if (m[4] !== undefined && Number(m[4]) === 0) return null;
    return [m[1], m[2], m[3]].map((x) => Number(x).toString(16).padStart(2, '0')).join('').toUpperCase();
  }
  const named = { black: '000000', white: 'FFFFFF', red: 'FF0000', blue: '0000FF', green: '008000', yellow: 'FFFF00', gray: '808080', grey: '808080' };
  return named[s.toLowerCase()] || null;
}

function cssLen(v, base = 16) {
  if (!v) return null;
  const m = /^(-?[\d.]+)(px|pt|in|cm|mm|em|rem)?$/.exec(String(v).trim());
  if (!m) return null;
  const n = Number(m[1]);
  return { px: n, pt: (n * 96) / 72, in: n * 96, cm: (n * 96) / 2.54, mm: (n * 96) / 25.4, em: n * base, rem: n * 16 }[m[2] || 'px'];
}

export async function writeDocx(html, meta) {
  const root = document.createElement('div');
  root.innerHTML = html;
  const rels = [];
  const media = [];
  const nums = []; // [{ abstract: 'bullet'|'decimal'|..., id }]
  let relSeq = 0;
  let bookmark = 0;
  const addRel = (type, target, external = false) => {
    const id = `rId${++relSeq + 10}`;
    rels.push({ id, type, target, external });
    return id;
  };

  const rPrOf = (f) => {
    const p = [];
    if (f.font) p.push(`<w:rFonts w:ascii="${esc(f.font)}" w:hAnsi="${esc(f.font)}" w:cs="${esc(f.font)}"/>`);
    if (f.b) p.push('<w:b/>');
    if (f.i) p.push('<w:i/>');
    if (f.caps) p.push('<w:caps/>');
    if (f.s) p.push('<w:strike/>');
    if (f.color) p.push(`<w:color w:val="${f.color}"/>`);
    if (f.size) p.push(`<w:sz w:val="${Math.round(f.size * 2)}"/><w:szCs w:val="${Math.round(f.size * 2)}"/>`);
    if (f.bg) p.push(`<w:shd w:val="clear" w:color="auto" w:fill="${f.bg}"/>`);
    if (f.u) p.push('<w:u w:val="single"/>');
    if (f.sup) p.push('<w:vertAlign w:val="superscript"/>');
    if (f.sub) p.push('<w:vertAlign w:val="subscript"/>');
    if (f.rstyle) p.unshift(`<w:rStyle w:val="${f.rstyle}"/>`);
    return p.length ? `<w:rPr>${p.join('')}</w:rPr>` : '';
  };

  const textRun = (text, f) => {
    const parts = text.replace(/​/g, '').split(/(\t|\n)/);
    let body = '';
    for (const part of parts) {
      if (part === '\t') body += '<w:tab/>';
      else if (part === '\n') body += '<w:br/>';
      else if (part) body += `<w:t xml:space="preserve">${esc(part)}</w:t>`;
    }
    return body ? `<w:r>${rPrOf(f)}${body}</w:r>` : '';
  };

  async function imageRun(img) {
    const src = img.getAttribute('src') || '';
    const m = /^data:(image\/(png|jpeg|gif|bmp|webp));base64,/.exec(src);
    if (!m) return '';
    let bytes = dataUrlToBytes(src);
    let ext = m[2] === 'jpeg' ? 'jpeg' : m[2];
    let natW = 0;
    let natH = 0;
    try {
      const bmp = await createImageBitmap(new Blob([bytes], { type: m[1] }));
      natW = bmp.width;
      natH = bmp.height;
      if (ext === 'webp') {
        // Word does not show WebP: store it as PNG.
        const c = new OffscreenCanvas(natW, natH);
        c.getContext('2d').drawImage(bmp, 0, 0);
        bytes = new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
        ext = 'png';
      }
    } catch { return ''; }
    const w = Number(img.getAttribute('width')) || natW;
    const hh = Number(img.getAttribute('height')) || (natW ? Math.round((w * natH) / natW) : natH);
    const name = `image${media.length + 1}.${ext}`;
    media.push({ name: `word/media/${name}`, data: bytes });
    const rid = addRel('http://schemas.openxmlformats.org/officeDocument/2006/relationships/image', `media/${name}`);
    const n = media.length;
    const cx = Math.round(w * EMU);
    const cy = Math.round(hh * EMU);
    const alt = esc(img.getAttribute('alt') || '');
    const graphic = `<a:graphic xmlns:a="${NS.a}"><a:graphicData uri="${NS.pic}"><pic:pic xmlns:pic="${NS.pic}"><pic:nvPicPr><pic:cNvPr id="${n}" name="${name}" descr="${alt}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${rid}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic>`;
    const float = img.classList.contains('img-left') ? 'left' : img.classList.contains('img-right') ? 'right' : null;
    if (float) {
      return `<w:r><w:drawing><wp:anchor distT="0" distB="0" distL="114300" distR="114300" simplePos="0" relativeHeight="${n}" behindDoc="0" locked="0" layoutInCell="1" allowOverlap="1"><wp:simplePos x="0" y="0"/><wp:positionH relativeFrom="column"><wp:align>${float}</wp:align></wp:positionH><wp:positionV relativeFrom="paragraph"><wp:posOffset>0</wp:posOffset></wp:positionV><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:wrapSquare wrapText="bothSides"/><wp:docPr id="${n}" name="Picture ${n}" descr="${alt}"/><wp:cNvGraphicFramePr/>${graphic}</wp:anchor></w:drawing></w:r>`;
    }
    return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${n}" name="Picture ${n}" descr="${alt}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="${NS.a}" noChangeAspect="1"/></wp:cNvGraphicFramePr>${graphic}</wp:inline></w:drawing></w:r>`;
  }

  // Inline content of a block -> runs.
  async function inline(node, f) {
    let out = '';
    for (const c of node.childNodes) {
      if (c.nodeType === 3) { out += textRun(c.data, f); continue; }
      if (c.nodeType !== 1) continue;
      const tag = c.tagName;
      if (tag === 'BR') { out += '<w:r><w:br/></w:r>'; continue; }
      if (tag === 'IMG') { out += await imageRun(c); continue; }
      if (['P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'TABLE', 'PRE', 'BLOCKQUOTE', 'LI'].includes(tag)) continue; // handled as blocks
      const g = { ...f };
      if (tag === 'B' || tag === 'STRONG') g.b = true;
      if (tag === 'I' || tag === 'EM' || tag === 'CITE') g.i = true;
      if (tag === 'U' || tag === 'INS') g.u = true;
      if (tag === 'S' || tag === 'STRIKE' || tag === 'DEL') g.s = true;
      if (tag === 'SUP') g.sup = true;
      if (tag === 'SUB') g.sub = true;
      if (tag === 'MARK') g.bg = 'FFFF00';
      if (tag === 'CODE' || tag === 'KBD') g.font = 'Consolas';
      const st = c.style;
      if (st) {
        if (st.fontWeight && (st.fontWeight === 'bold' || Number(st.fontWeight) >= 600)) g.b = true;
        if (st.fontStyle === 'italic') g.i = true;
        if (/underline/.test(st.textDecoration || st.textDecorationLine || '')) g.u = true;
        if (/line-through/.test(st.textDecoration || st.textDecorationLine || '')) g.s = true;
        if (st.color && cssColor(st.color)) g.color = cssColor(st.color);
        if (st.backgroundColor && cssColor(st.backgroundColor)) g.bg = cssColor(st.backgroundColor);
        if (st.fontSize) { const px = cssLen(st.fontSize); if (px) g.size = Math.round(((px * 72) / 96) * 2) / 2; }
        if (st.fontFamily) g.font = st.fontFamily.split(',')[0].replace(/["']/g, '').trim();
        if (st.textTransform === 'uppercase') g.caps = true;
      }
      if (tag === 'A') {
        const href = c.getAttribute('href') || '';
        const inner = await inline(c, { ...g, rstyle: 'Hyperlink' });
        if (href.startsWith('#')) out += `<w:hyperlink w:anchor="${esc(href.slice(1).replace(/^h-/, ''))}">${inner}</w:hyperlink>`;
        else if (/^(https?:|mailto:)/i.test(href)) {
          const rid = addRel('http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink', href, true);
          out += `<w:hyperlink r:id="${rid}">${inner}</w:hyperlink>`;
        } else out += inner;
        continue;
      }
      if (tag === 'SPAN' && c.id && /^h-/.test(c.id)) {
        const id = ++bookmark;
        out += `<w:bookmarkStart w:id="${id}" w:name="${esc(c.id.slice(2))}"/><w:bookmarkEnd w:id="${id}"/>`;
      }
      out += await inline(c, g);
    }
    return out;
  }

  function pPrOf(el, extra = '') {
    const p = [];
    let styleId = STYLE_IDS[el.tagName];
    if (el.tagName === 'P' || el.tagName === 'DIV') {
      if (el.classList.contains('title')) styleId = 'Title';
      else if (el.classList.contains('subtitle')) styleId = 'Subtitle';
      else if (el.classList.contains('quote')) styleId = 'Quote';
      else if (el.classList.contains('caption')) styleId = 'Caption';
    }
    if (styleId) p.push(`<w:pStyle w:val="${styleId}"/>`);
    p.push(extra);
    const st = el.style;
    const lh = parseFloat(st.lineHeight);
    if (lh && lh < 6) p.push(`<w:spacing w:line="${Math.round(lh * 240)}" w:lineRule="auto"/>`);
    const left = cssLen(st.marginLeft);
    const right = cssLen(st.marginRight);
    const ind = cssLen(st.textIndent);
    if (left || right || ind) {
      p.push(`<w:ind${left ? ` w:left="${Math.round(left * TWIP)}"` : ''}${right ? ` w:right="${Math.round(right * TWIP)}"` : ''}${ind ? (ind > 0 ? ` w:firstLine="${Math.round(ind * TWIP)}"` : ` w:hanging="${Math.round(-ind * TWIP)}"`) : ''}/>`);
    }
    const bg = cssColor(st.backgroundColor);
    if (bg) p.push(`<w:shd w:val="clear" w:color="auto" w:fill="${bg}"/>`);
    const a = st.textAlign;
    if (a === 'center' || a === 'right' || a === 'justify') p.push(`<w:jc w:val="${a === 'justify' ? 'both' : a}"/>`);
    const body = p.filter(Boolean).join('');
    return body ? `<w:pPr>${body}</w:pPr>` : '';
  }

  async function para(el, extra = '', f = {}) {
    let bm = '';
    if (el.id && /^h-/.test(el.id)) {
      const id = ++bookmark;
      bm = `<w:bookmarkStart w:id="${id}" w:name="${esc(el.id.slice(2))}"/><w:bookmarkEnd w:id="${id}"/>`;
    }
    return `<w:p>${pPrOf(el, extra)}${bm}${await inline(el, f)}</w:p>`;
  }

  function numFor(kind, start = 1) {
    nums.push({ kind, start });
    return nums.length;
  }

  async function list(listEl, level, numId) {
    let out = '';
    const ordered = listEl.tagName === 'OL';
    const check = listEl.classList.contains('checklist');
    const id = numId || (check ? 0 : numFor(ordered ? (listEl.style.listStyleType || 'decimal') : 'bullet', Number(listEl.getAttribute('start')) || 1));
    for (const li of listEl.children) {
      if (li.tagName !== 'LI') continue;
      const box = check ? `<w:r><w:t xml:space="preserve">${li.dataset.checked === 'true' ? '☒' : '☐'} </w:t></w:r>` : '';
      const extra = check ? `<w:ind w:left="${360 + level * 360}"/>` : `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${id}"/></w:numPr>`;
      // An item's own text, then any nested lists or blocks inside it.
      const own = await inline(li, {});
      out += `<w:p><w:pPr><w:pStyle w:val="ListParagraph"/>${extra}${pPrOf(li).replace(/<\/?w:pPr>/g, '')}</w:pPr>${box}${own}</w:p>`;
      for (const c of li.children) {
        if (c.tagName === 'UL' || c.tagName === 'OL') out += await list(c, level + 1, c.tagName === listEl.tagName && !c.classList.contains('checklist') ? 0 : 0);
        else if (c.tagName === 'P') out += await para(c, `<w:ind w:left="${720 + level * 360}"/>`);
      }
    }
    return out;
  }

  async function tableXml(table) {
    const rows = [...table.rows];
    const grid = rows.map(() => []);
    rows.forEach((tr, ri) => {
      let ci = 0;
      for (const cell of tr.cells) {
        while (grid[ri][ci]) ci++;
        for (let dr = 0; dr < (cell.rowSpan || 1); dr++) {
          for (let dc = 0; dc < (cell.colSpan || 1); dc++) {
            if (grid[ri + dr]) grid[ri + dr][ci + dc] = { cell, origin: dr === 0 && dc === 0, top: dr === 0, left: dc === 0 };
          }
        }
        ci += cell.colSpan || 1;
      }
    });
    const ncols = Math.max(...grid.map((r) => r.length), 1);
    const cols = [...table.querySelectorAll('col')].map((c) => cssLen(c.style.width) || 0);
    const usable = (pageInfo.w - pageInfo.ml - pageInfo.mr);
    const widths = Array.from({ length: ncols }, (_, i) => cols[i] || usable / ncols);
    const sum = widths.reduce((a, b) => a + b, 0);
    const tw = widths.map((w) => Math.round((w / sum) * usable * TWIP));
    const plain = table.classList.contains('tbl-plain');
    const rowsOnly = table.classList.contains('tbl-rows');
    const b = (side, on2) => `<w:${side} w:val="${on2 ? 'single' : 'nil'}" w:sz="4" w:space="0" w:color="B8C2BB"/>`;
    const borders = `<w:tblBorders>${b('top', !plain)}${b('left', !plain && !rowsOnly)}${b('bottom', !plain)}${b('right', !plain && !rowsOnly)}${b('insideH', !plain)}${b('insideV', !plain && !rowsOnly)}</w:tblBorders>`;
    let out = `<w:tbl><w:tblPr><w:tblW w:w="${tw.reduce((a, c) => a + c, 0)}" w:type="dxa"/>${borders}<w:tblLayout w:type="fixed"/><w:tblCellMar><w:left w:w="108" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>${tw.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>`;
    const headFill = table.classList.contains('tbl-green') ? '2EA043' : table.classList.contains('tbl-dark') ? '2D3330' : table.classList.contains('tbl-grey') ? 'D9DED9' : null;
    for (let r = 0; r < grid.length; r++) {
      out += `<w:tr>${r === 0 && rows[0].cells[0] && rows[0].cells[0].tagName === 'TH' ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}`;
      for (let c = 0; c < ncols; c++) {
        const g = grid[r][c];
        if (!g) { out += `<w:tc><w:tcPr><w:tcW w:w="${tw[c]}" w:type="dxa"/></w:tcPr><w:p/></w:tc>`; continue; }
        if (!g.left) continue;
        const cell = g.cell;
        const span = cell.colSpan || 1;
        const pr = [`<w:tcW w:w="${tw.slice(c, c + span).reduce((a, x) => a + x, 0)}" w:type="dxa"/>`];
        if (span > 1) pr.push(`<w:gridSpan w:val="${span}"/>`);
        if ((cell.rowSpan || 1) > 1) pr.push(g.top ? '<w:vMerge w:val="restart"/>' : '<w:vMerge/>');
        const fill = cssColor(cell.style.backgroundColor) || (r === 0 && headFill ? headFill : null);
        if (fill) pr.push(`<w:shd w:val="clear" w:color="auto" w:fill="${fill}"/>`);
        const va = cell.style.verticalAlign;
        if (va === 'middle') pr.push('<w:vAlign w:val="center"/>');
        if (va === 'bottom') pr.push('<w:vAlign w:val="bottom"/>');
        let content = '<w:p/>';
        if (g.top) {
          const f = { b: cell.tagName === 'TH', color: r === 0 && (headFill === '2EA043' || headFill === '2D3330') ? 'FFFFFF' : null };
          const hasBlocks = [...cell.children].some((k) => ['P', 'UL', 'OL', 'TABLE', 'H1', 'H2', 'H3', 'PRE'].includes(k.tagName));
          content = hasBlocks ? await blocksXml(cell, f) : `<w:p>${pPrOf(cell)}${await inline(cell, f)}</w:p>`;
          if (!/<w:p[ >]/.test(content)) content += '<w:p/>';
        }
        out += `<w:tc><w:tcPr>${pr.join('')}</w:tcPr>${content}</w:tc>`;
      }
      out += '</w:tr>';
    }
    return `${out}</w:tbl>`;
  }

  async function blocksXml(container, f = {}) {
    let out = '';
    for (const el of container.childNodes) {
      if (el.nodeType === 3) {
        if (el.data.trim()) out += `<w:p>${textRun(el.data, f)}</w:p>`;
        continue;
      }
      if (el.nodeType !== 1) continue;
      const tag = el.tagName;
      if (tag === 'UL' || tag === 'OL') out += await list(el, 0);
      else if (tag === 'TABLE') out += await tableXml(el);
      else if (tag === 'HR') out += '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="C8D0CA"/></w:pBdr></w:pPr></w:p>';
      else if (el.classList.contains('page-break')) out += '<w:p><w:r><w:br w:type="page"/></w:r></w:p>';
      else if (el.classList.contains('toc')) {
        for (const p of el.querySelectorAll('p')) {
          const lvl = Number((/toc-l(\d)/.exec(p.className) || [0, 0])[1]);
          out += await para(p, lvl ? `<w:ind w:left="${(lvl - 1) * 360}"/>` : '<w:pStyle w:val="TOCHeading"/>', p.classList.contains('toc-title') ? { b: true, size: 14 } : {});
        }
      } else if (el.classList.contains('cols')) {
        // Columns become a table without borders: it opens the same in every word processor.
        const colsEl = [...el.children].filter((c) => c.classList.contains('col'));
        const usable = (pageInfo.w - pageInfo.ml - pageInfo.mr) * TWIP;
        const w = Math.round(usable / Math.max(1, colsEl.length));
        let t = `<w:tbl><w:tblPr><w:tblW w:w="${w * colsEl.length}" w:type="dxa"/><w:tblBorders><w:top w:val="nil"/><w:left w:val="nil"/><w:bottom w:val="nil"/><w:right w:val="nil"/><w:insideH w:val="nil"/><w:insideV w:val="nil"/></w:tblBorders><w:tblLayout w:type="fixed"/></w:tblPr><w:tblGrid>${colsEl.map(() => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid><w:tr>`;
        for (const c of colsEl) t += `<w:tc><w:tcPr><w:tcW w:w="${w}" w:type="dxa"/></w:tcPr>${(await blocksXml(c)) || '<w:p/>'}</w:tc>`;
        out += `${t}</w:tr></w:tbl>`;
      } else if (el.classList.contains('note') || tag === 'BLOCKQUOTE' || tag === 'FIGURE' || (tag === 'DIV' && [...el.children].some((c) => ['P', 'UL', 'OL', 'TABLE'].includes(c.tagName)))) {
        out += await blocksXml(el, f);
      } else if (tag === 'PRE') {
        out += `<w:p>${pPrOf(el)}${await inline(el, { ...f, font: 'Consolas' })}</w:p>`;
      } else if (tag === 'IMG') {
        out += `<w:p>${await imageRun(el)}</w:p>`;
      } else out += await para(el, '', f);
    }
    return out;
  }

  const page = meta.page || defaultMeta().page;
  const size = PAGE_SIZES[page.size] || PAGE_SIZES.letter;
  const land = page.orientation === 'landscape';
  const pageInfo = {
    w: (land ? size.h : size.w) * PX_PER_IN, h: (land ? size.w : size.h) * PX_PER_IN,
    ml: page.margins.left * PX_PER_IN, mr: page.margins.right * PX_PER_IN,
  };
  const body = await blocksXml(root);

  // Header and footer: three zones on one line, with tab stops for centre and right.
  const usableTw = Math.round((pageInfo.w - pageInfo.ml - pageInfo.mr) * TWIP);
  const zoneXml = (z, styleId) => {
    const piece = (s) => String(s || '').split(/(\{page\}|\{pages\}|\{date\}|\{title\})/).filter(Boolean).map((p) => {
      if (p === '{page}') return '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> PAGE </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>';
      if (p === '{pages}') return '<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> NUMPAGES </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>1</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r>';
      if (p === '{date}') return `<w:r><w:t>${esc(new Date().toLocaleDateString())}</w:t></w:r>`;
      if (p === '{title}') return `<w:r><w:t xml:space="preserve">${esc(meta.title || '')}</w:t></w:r>`;
      return `<w:r><w:t xml:space="preserve">${esc(p)}</w:t></w:r>`;
    }).join('');
    return `<w:p><w:pPr><w:pStyle w:val="${styleId}"/><w:tabs><w:tab w:val="center" w:pos="${Math.round(usableTw / 2)}"/><w:tab w:val="right" w:pos="${usableTw}"/></w:tabs></w:pPr>${piece(z.left)}<w:r><w:tab/></w:r>${piece(z.center)}<w:r><w:tab/></w:r>${piece(z.right)}</w:p>`;
  };
  const partHead = (tag) => `${XML_HEAD}<w:${tag} xmlns:w="${NS.w}" xmlns:r="${NS.r}">`;
  const hasHeader = Object.values(meta.header || {}).some(Boolean);
  const hasFooter = Object.values(meta.footer || {}).some(Boolean);
  const extraParts = [];
  let refs = '';
  if (hasHeader) {
    extraParts.push({ name: 'word/header1.xml', data: `${partHead('hdr')}${zoneXml(meta.header, 'Header')}</w:hdr>` });
    refs += `<w:headerReference w:type="default" r:id="${addRel('http://schemas.openxmlformats.org/officeDocument/2006/relationships/header', 'header1.xml')}"/>`;
  }
  if (hasFooter) {
    extraParts.push({ name: 'word/footer1.xml', data: `${partHead('ftr')}${zoneXml(meta.footer, 'Footer')}</w:ftr>` });
    refs += `<w:footerReference w:type="default" r:id="${addRel('http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer', 'footer1.xml')}"/>`;
  }
  if ((hasHeader || hasFooter) && meta.firstPageDifferent) {
    extraParts.push({ name: 'word/header2.xml', data: `${partHead('hdr')}<w:p/></w:hdr>` });
    extraParts.push({ name: 'word/footer2.xml', data: `${partHead('ftr')}<w:p/></w:ftr>` });
    refs += `<w:headerReference w:type="first" r:id="${addRel('http://schemas.openxmlformats.org/officeDocument/2006/relationships/header', 'header2.xml')}"/>`;
    refs += `<w:footerReference w:type="first" r:id="${addRel('http://schemas.openxmlformats.org/officeDocument/2006/relationships/footer', 'footer2.xml')}"/>`;
  }
  const tw = (inch) => Math.round(inch * 1440);
  const m = page.margins;
  const sect = `<w:sectPr>${refs}<w:pgSz w:w="${tw(land ? size.h : size.w)}" w:h="${tw(land ? size.w : size.h)}"${land ? ' w:orient="landscape"' : ''}/><w:pgMar w:top="${tw(m.top)}" w:right="${tw(m.right)}" w:bottom="${tw(m.bottom)}" w:left="${tw(m.left)}" w:header="${tw(Math.min(0.5, m.top / 2))}" w:footer="${tw(Math.min(0.5, m.bottom / 2))}" w:gutter="0"/>${meta.firstPageDifferent && (hasHeader || hasFooter) ? '<w:titlePg/>' : ''}</w:sectPr>`;

  const document_ = `${XML_HEAD}<w:document xmlns:w="${NS.w}" xmlns:r="${NS.r}" xmlns:wp="${NS.wp}" xmlns:a="${NS.a}" xmlns:pic="${NS.pic}"><w:body>${body}${sect}</w:body></w:document>`;

  // Numbering: one abstract definition per kind; each list is its own instance so it restarts.
  const fmtOf = { bullet: 'bullet', decimal: 'decimal', 'lower-alpha': 'lowerLetter', 'upper-alpha': 'upperLetter', 'lower-roman': 'lowerRoman', 'upper-roman': 'upperRoman' };
  const bullets = ['•', '◦', '▪'];
  const kinds = [...new Set(nums.map((n) => n.kind))];
  const abstractXml = kinds.map((kind, ai) => {
    const lvls = Array.from({ length: 9 }, (_, l) => {
      const fmt = kind === 'bullet' ? 'bullet' : (l === 0 ? fmtOf[kind] || 'decimal' : ['lowerLetter', 'lowerRoman', 'decimal'][(l - 1) % 3]);
      const text = fmt === 'bullet' ? bullets[l % 3] : `%${l + 1}.`;
      return `<w:lvl w:ilvl="${l}"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 + l * 360}" w:hanging="360"/></w:pPr>${fmt === 'bullet' ? '<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/></w:rPr>' : ''}</w:lvl>`;
    }).join('');
    return `<w:abstractNum w:abstractNumId="${ai}"><w:multiLevelType w:val="hybridMultilevel"/>${lvls}</w:abstractNum>`;
  }).join('');
  const numXml = nums.map((n, i) => `<w:num w:numId="${i + 1}"><w:abstractNumId w:val="${kinds.indexOf(n.kind)}"/>${n.start > 1 ? `<w:lvlOverride w:ilvl="0"><w:startOverride w:val="${n.start}"/></w:lvlOverride>` : '<w:lvlOverride w:ilvl="0"><w:startOverride w:val="1"/></w:lvlOverride>'}</w:num>`).join('');
  const numbering = `${XML_HEAD}<w:numbering xmlns:w="${NS.w}">${abstractXml}${numXml}</w:numbering>`;

  const font = meta.font || 'Calibri';
  const fs = Math.round((meta.fontSize || 11) * 2);
  const style = (id, name, ppr, rpr, extra = '') => `<w:style w:type="paragraph" w:styleId="${id}"><w:name w:val="${name}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>${extra}${ppr ? `<w:pPr>${ppr}</w:pPr>` : ''}${rpr ? `<w:rPr>${rpr}</w:rPr>` : ''}</w:style>`;
  const head = (n, size, before, after) => style(`Heading${n}`, `heading ${n}`, `<w:keepNext/><w:spacing w:before="${before}" w:after="${after}"/><w:outlineLvl w:val="${n - 1}"/>`, `<w:b/><w:color w:val="1F5B3A"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/>`);
  const styles = `${XML_HEAD}<w:styles xmlns:w="${NS.w}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${esc(font)}" w:hAnsi="${esc(font)}" w:eastAsia="${esc(font)}" w:cs="${esc(font)}"/><w:sz w:val="${fs}"/><w:szCs w:val="${fs}"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="${Math.round((meta.lineHeight || 1.15) * 240)}" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
${head(1, 40, 360, 120)}${head(2, 32, 280, 80)}${head(3, 26, 240, 60)}${head(4, 24, 200, 40)}${head(5, 22, 200, 40)}${head(6, 22, 200, 40)}
${style('Title', 'Title', '<w:spacing w:after="80"/>', '<w:sz w:val="56"/><w:szCs w:val="56"/><w:spacing w:val="-10"/>')}
${style('Subtitle', 'Subtitle', '<w:spacing w:after="240"/>', '<w:color w:val="5A6560"/><w:sz w:val="28"/>')}
${style('Quote', 'Quote', '<w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="3FB950"/></w:pBdr><w:ind w:left="240"/>', '<w:i/><w:color w:val="3B443E"/>')}
${style('Caption', 'caption', '', '<w:i/><w:color w:val="5A6560"/><w:sz w:val="18"/>')}
${style('Code', 'Code', '<w:shd w:val="clear" w:color="auto" w:fill="F3F5F3"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/>', '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="20"/>')}
${style('ListParagraph', 'List Paragraph', '<w:spacing w:after="40"/><w:contextualSpacing/>', '')}
${style('Header', 'header', '', '<w:color w:val="555555"/><w:sz w:val="18"/>')}${style('Footer', 'footer', '', '<w:color w:val="555555"/><w:sz w:val="18"/>')}
${style('TOCHeading', 'TOC Heading', '', '<w:b/><w:sz w:val="28"/>')}
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="1F6FEB"/><w:u w:val="single"/></w:rPr></w:style>
</w:styles>`;

  const ct = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/><Default Extension="bmp" ContentType="image/bmp"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>${extraParts.map((p) => `<Override PartName="/${p.name}" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.${p.name.includes('header') ? 'header' : 'footer'}+xml"/>`).join('')}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
  const docRels = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>${rels.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${esc(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`).join('')}</Relationships>`;
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const core = `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(meta.title || '')}</dc:title><dc:creator>${esc(meta.author || '')}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;
  const app = `${XML_HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Snake's Word</Application></Properties>`;
  const settings = `${XML_HEAD}<w:settings xmlns:w="${NS.w}"><w:defaultTabStop w:val="720"/><w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;

  return writeZip([
    { name: '[Content_Types].xml', data: ct },
    { name: '_rels/.rels', data: `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>` },
    { name: 'word/document.xml', data: document_ },
    { name: 'word/styles.xml', data: styles },
    { name: 'word/numbering.xml', data: numbering },
    { name: 'word/settings.xml', data: settings },
    { name: 'word/_rels/document.xml.rels', data: docRels },
    ...extraParts,
    ...media.map((m2) => ({ ...m2, store: true })),
    { name: 'docProps/core.xml', data: core },
    { name: 'docProps/app.xml', data: app },
  ]);
}

// ===========================================================================
// OpenDocument text (.odt), read only: LibreOffice's own format
// ===========================================================================
export async function readOdt(bytes) {
  const zip = readZip(bytes);
  if (!zip.has('content.xml')) throw new Error('This file has no content.xml in it.');
  const doc = parseXml(await zip.get('content.xml').text());
  const escText = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const auto = {};
  for (const st of all(doc, 'style')) {
    const name = attr(st, 'name');
    const tp = first(st, 'text-properties');
    if (!tp) continue;
    auto[name] = { b: attr(tp, 'font-weight') === 'bold', i: attr(tp, 'font-style') === 'italic', u: (attr(tp, 'text-underline-style') || 'none') !== 'none' };
  }
  const inline = async (node) => {
    let out = '';
    for (const c of node.childNodes) {
      if (c.nodeType === 3) { out += escText(c.data); continue; }
      if (c.nodeType !== 1) continue;
      const ln = c.localName;
      if (ln === 's') out += ' '.repeat(Number(attr(c, 'c') || 1));
      else if (ln === 'tab') out += '\t';
      else if (ln === 'line-break') out += '<br>';
      else if (ln === 'a') {
        const href = attr(c, 'href') || '';
        out += /^(https?:|mailto:)/i.test(href) ? `<a href="${escText(href)}">${await inline(c)}</a>` : await inline(c);
      } else if (ln === 'span') {
        const st = auto[attr(c, 'style-name')] || {};
        let s = await inline(c);
        if (st.b) s = `<b>${s}</b>`;
        if (st.i) s = `<i>${s}</i>`;
        if (st.u) s = `<u>${s}</u>`;
        out += s;
      } else if (ln === 'frame') {
        const img = first(c, 'image');
        const href = img ? attr(img, 'href') : '';
        if (href && zip.has(href)) {
          const ext = href.split('.').pop().toLowerCase();
          const mime = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif' }[ext];
          if (mime) out += `<img src="data:${mime};base64,${bytesToBase64(await zip.get(href).read())}">`;
        }
      } else out += await inline(c);
    }
    return out;
  };
  const block = async (node) => {
    let out = '';
    for (const c of kids(node)) {
      const ln = c.localName;
      if (ln === 'p') out += `<p>${(await inline(c)) || '<br>'}</p>`;
      else if (ln === 'h') {
        const lvl = Math.min(6, Number(attr(c, 'outline-level') || 1));
        out += `<h${lvl}>${await inline(c)}</h${lvl}>`;
      } else if (ln === 'list') {
        out += '<ul>';
        for (const li of kids(c, 'list-item')) out += `<li>${(await block(li)).replace(/^<p>|<\/p>$/g, '')}</li>`;
        out += '</ul>';
      } else if (ln === 'table') {
        out += '<table class="tbl-grid"><tbody>';
        for (const tr of all(c, 'table-row')) {
          out += '<tr>';
          for (const tc of kids(tr, 'table-cell')) {
            const span = Number(attr(tc, 'number-columns-spanned') || 1);
            out += `<td${span > 1 ? ` colspan="${span}"` : ''}>${(await block(tc)) || '<br>'}</td>`;
          }
          out += '</tr>';
        }
        out += '</tbody></table>';
      } else if (ln === 'section' || ln === 'text') out += await block(c);
    }
    return out;
  };
  const body = first(doc, 'text');
  return { html: await block(body), meta: defaultMeta() };
}
