// Microsoft Word .docx: reading into our HTML, and writing our HTML out.
// Written from the Office Open XML spec (ECMA-376); no outside code.
import { readZip, writeZip } from '../../kit/zip.js';
import { esc, parseXml, all, first, kids, kid, attr, XML_HEAD } from '../../kit/xml.js';
import { bytesToBase64, dataUrlToBytes } from '../../kit/dom.js';
import { PAGE_SIZES, PX_PER_IN, defaultMeta } from './editor.js';
import { fontStack } from '../../kit/fonts.js';
import { wrapRange } from './anchors.js';

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

  // Styles: each paragraph and character style, its basedOn chain and its formatting.
  // Headings are found by name: ids differ between languages.
  const styleDefs = {};
  let defaultParaStyle = null;
  let defaultCharStyle = null;
  let docDefaults = { rPr: null, pPr: null };
  const stylesXml = await text('word/styles.xml');
  if (stylesXml) {
    const sx = parseXml(stylesXml);
    const dd = first(sx, 'docDefaults');
    if (dd) {
      const r = first(dd, 'rPrDefault');
      const pp = first(dd, 'pPrDefault');
      docDefaults = { rPr: r ? kid(r, 'rPr') : null, pPr: pp ? kid(pp, 'pPr') : null };
    }
    for (const st of all(sx, 'style')) {
      const id = attr(st, 'styleId');
      const nm = kid(st, 'name');
      const based = kid(st, 'basedOn');
      const type = attr(st, 'type');
      styleDefs[id] = {
        name: (nm ? attr(nm, 'val') : id || '').toLowerCase(), based: based ? attr(based, 'val') : null, type,
        rPr: kid(st, 'rPr'), pPr: kid(st, 'pPr'), tblPr: kid(st, 'tblPr'), cond: kids(st, 'tblStylePr'),
      };
      const isDefault = ['1', 'true', 'on'].includes(attr(st, 'default'));
      if (isDefault && type === 'paragraph') defaultParaStyle = id;
      if (isDefault && type === 'character') defaultCharStyle = id;
    }
  }
  /** A style and the styles it is based on, the most basic first. */
  const chain = (id) => {
    const out = [];
    let st = styleDefs[id];
    for (let guard = 0; st && guard < 12; guard++) {
      out.unshift(st);
      st = st.based ? styleDefs[st.based] : null;
    }
    return out;
  };
  const styleName = (id) => {
    const list = chain(id);
    for (let i = list.length - 1; i >= 0; i--) {
      if (/^(heading [1-6]|title|subtitle|quote|intense quote|caption|code|html preformatted|list paragraph)$/.test(list[i].name)) return list[i].name;
    }
    return styleDefs[id] ? styleDefs[id].name : (id || '').toLowerCase();
  };

  // Theme fonts (Word 2007 and later refer to "the body font" rather than naming it).
  const theme = { major: '', minor: '' };
  const themeXml = await text('word/theme/theme1.xml');
  if (themeXml) {
    const tx = parseXml(themeXml);
    for (const k of ['major', 'minor']) {
      const f = first(tx, `${k}Font`);
      const l = f ? kid(f, 'latin') : null;
      theme[k] = l ? attr(l, 'typeface') || '' : '';
    }
  }
  const themeFace = (t) => (!t ? '' : /^major/.test(t) ? theme.major : /^minor/.test(t) ? theme.minor : '');

  /** Run formatting as plain values from rPr elements, later ones winning. */
  function runFormat(rPrs) {
    const f = {};
    for (const rPr of rPrs) {
      if (!rPr) continue;
      for (const k of ['b', 'i', 'strike', 'dstrike', 'caps', 'smallCaps', 'vanish']) if (kid(rPr, k)) f[k] = on(rPr, k);
      const u = kid(rPr, 'u');
      if (u) f.u = attr(u, 'val') !== 'none';
      const c = kid(rPr, 'color');
      if (c && attr(c, 'val')) f.color = attr(c, 'val') === 'auto' ? null : attr(c, 'val').toUpperCase();
      const sz = kid(rPr, 'sz');
      if (sz && Number(attr(sz, 'val'))) f.sz = Number(attr(sz, 'val')) / 2;
      const fonts = kid(rPr, 'rFonts');
      if (fonts) {
        const face = attr(fonts, 'ascii') || attr(fonts, 'hAnsi') || themeFace(attr(fonts, 'asciiTheme') || attr(fonts, 'hAnsiTheme'));
        if (face) f.font = face;
      }
      const hl = kid(rPr, 'highlight');
      if (hl) f.hl = HIGHLIGHT[attr(hl, 'val')] || null;
      const shd = kid(rPr, 'shd');
      if (shd) { const fill = attr(shd, 'fill'); f.shd = fill && !/^(auto|FFFFFF)$/i.test(fill) ? `#${fill}` : null; }
      const va = kid(rPr, 'vertAlign');
      if (va) f.va = attr(va, 'val');
    }
    return f;
  }
  const styleRPrs = (id) => chain(id).map((x) => x.rPr);
  const stylePPrs = (id) => chain(id).map((x) => x.pPr);
  // What every paragraph looks like unless told otherwise: the page's own font and size.
  const baseFmt = runFormat([docDefaults.rPr, ...styleRPrs(defaultParaStyle)]);
  const basePPrs = [docDefaults.pPr, ...stylePPrs(defaultParaStyle)];
  const lastKid = (pPrs, name) => { for (let i = pPrs.length - 1; i >= 0; i--) { const k = pPrs[i] && kid(pPrs[i], name); if (k) return k; } return null; };
  const lineOf = (sp) => {
    if (!sp) return null;
    const line = attr(sp, 'line');
    const rule = attr(sp, 'lineRule');
    return line && (!rule || rule === 'auto') ? Math.round((Number(line) / 240) * 100) / 100 : null;
  };
  const baseLine = lineOf(lastKid(basePPrs, 'spacing')) || 1.15;

  // Numbering: numId -> level -> format.
  const numFmt = {};
  const numXml = await text('word/numbering.xml');
  if (numXml) {
    const nx = parseXml(numXml);
    const abstract = {};
    for (const a of all(nx, 'abstractNum')) {
      abstract[attr(a, 'abstractNumId')] = Object.fromEntries(all(a, 'lvl').map((l) => [attr(l, 'ilvl'),
        { fmt: val(l, 'numFmt') || 'bullet', text: val(l, 'lvlText') || '', start: Number(val(l, 'start') || 1), pPr: kid(l, 'pPr') }]));
    }
    for (const n of all(nx, 'num')) {
      const aid = first(n, 'abstractNumId');
      const levels = { ...(abstract[aid ? attr(aid, 'val') : ''] || {}) };
      for (const o of kids(n, 'lvlOverride')) {
        const so = kid(o, 'startOverride');
        const il = attr(o, 'ilvl');
        if (so && levels[il]) levels[il] = { ...levels[il], start: Number(attr(so, 'val') || 1) };
      }
      numFmt[attr(n, 'numId')] = levels;
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
  const escAttr = (s) => escText(s).replace(/"/g, '&quot;');

  // Footnotes and endnotes, by id (read before the body, which refers to them).
  const notes = { foot: {}, end: {} };
  const noteParts = [];
  for (const [kind, part, tag] of [['foot', 'word/footnotes.xml', 'footnote'], ['end', 'word/endnotes.xml', 'endnote']]) {
    const xml = await text(part);
    if (xml) noteParts.push([kind, parseXml(xml), tag]);
  }

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
      } else if (['ins', 'moveTo', 'smartTag', 'customXml', 'fldSimple', 'sdtContent', 'dir', 'bdo'].includes(ln)) out += await runs(node);
      else if (ln === 'oMathPara' || ln === 'oMath') out += `<i>${escText(all(node, 't').map((t) => t.textContent).join(''))}</i>`;
      else if (ln === 'sdt') out += await runs(kid(node, 'sdtContent') || node);
      else if (ln === 'commentRangeStart') out += `<span data-cs="${escAttr(attr(node, 'id') || '')}"></span>`;
      else if (ln === 'commentRangeEnd') out += `<span data-ce="${escAttr(attr(node, 'id') || '')}"></span>`;
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
      else if (ln === 'footnoteReference' || ln === 'endnoteReference') {
        // A note: its text travels with its mark (the number is counted where it is shown).
        const note = notes[ln === 'footnoteReference' ? 'foot' : 'end'][attr(c, 'id')];
        if (note !== undefined) content += `<sup class="fn-ref" contenteditable="false" data-note="${escAttr(note)}"></sup>`;
      }
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
    // A note's mark is its own superscript: the run's formatting is not wrapped around it.
    if (/^(<sup class="fn-ref"[^>]*><\/sup>)+$/.test(content)) return content;
    const rs = rPr ? val(rPr, 'rStyle') : null;
    const f = runFormat([...cur.rPrs, ...styleRPrs(rs || defaultCharStyle), rPr]);
    if (f.vanish) return '';
    const styles = [];
    if ((f.color || null) !== (cur.base.color || null)) styles.push(`color: ${f.color ? `#${f.color}` : '#000000'}`);
    if (f.sz && f.sz !== cur.base.sz) styles.push(`font-size: ${f.sz}pt`);
    // Its look-alikes and kind come along, for a computer without the font (Consolas -> any monospace).
    if (f.font && f.font !== cur.base.font) styles.push(`font-family: ${fontStack(f.font).replace(/"/g, "'")}`);
    if (f.hl) styles.push(`background-color: ${f.hl}`);
    else if (f.shd) styles.push(`background-color: ${f.shd}`);
    if (f.caps) styles.push('text-transform: uppercase');
    if (f.smallCaps) styles.push('font-variant: small-caps');
    let out = styles.length ? `<span style="${styles.join('; ')}">${content}</span>` : content;
    // A heading is bold by itself: only its runs that say otherwise are marked.
    if (f.b && !(cur.bold || cur.th || (cur.base.b && f.b === cur.base.b && cur.base !== baseFmt))) out = `<b>${out}</b>`;
    if (f.i && !(cur.italic || (cur.base.i && f.i === cur.base.i && cur.base !== baseFmt))) out = `<i>${out}</i>`;
    if (f.u) out = `<u>${out}</u>`;
    if (f.strike || f.dstrike) out = `<s>${out}</s>`;
    if (f.va === 'superscript') out = `<sup>${out}</sup>`;
    if (f.va === 'subscript') out = `<sub>${out}</sub>`;
    return out;
  }

  // The paragraph being read: its style's run formatting, and what its tag shows by itself.
  let cur = { rPrs: [], base: baseFmt, bold: false, italic: false };

  /** CSS for a paragraph from its own and its style's properties (later pPr elements win). */
  function pStyleAttrs(pPrs, listed) {
    const st = [];
    const jc = lastKid(pPrs, 'jc');
    const j = jc ? attr(jc, 'val') : null;
    if (j === 'center') st.push('text-align: center');
    else if (j === 'right' || j === 'end') st.push('text-align: right');
    else if (j === 'both' || j === 'distribute') st.push('text-align: justify');
    const ind = lastKid(pPrs, 'ind');
    if (ind) {
      const left = Number(attr(ind, 'left') || attr(ind, 'start') || 0);
      const right = Number(attr(ind, 'right') || attr(ind, 'end') || 0);
      const firstLine = Number(attr(ind, 'firstLine') || 0) - Number(attr(ind, 'hanging') || 0);
      if (left && !listed) st.push(`margin-left: ${Math.round(left / TWIP)}px`);
      if (right) st.push(`margin-right: ${Math.round(right / TWIP)}px`);
      if (firstLine && !listed) st.push(`text-indent: ${Math.round(firstLine / TWIP)}px`);
    }
    const lh = lineOf(lastKid(pPrs, 'spacing'));
    if (lh && Math.abs(lh - baseLine) > 0.04 && lh > 0.5 && lh < 5) st.push(`line-height: ${lh}`);
    const shd = lastKid(pPrs, 'shd');
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

  // How far each list has counted, so a list interrupted by a paragraph carries on.
  const counters = {};
  // The document's heading, title and subtitle styles.
  const docStyles = {};
  async function paragraph(p) {
    const pPr = kid(p, 'pPr');
    const sid = (pPr ? val(pPr, 'pStyle') : null) || defaultParaStyle;
    const sname = styleName(sid);
    const pPrs = [docDefaults.pPr, ...stylePPrs(sid), pPr];
    // A list item by its own numbering, or by its style's (Word's "List Bullet" and friends).
    let numId = null;
    let lvl = 0;
    for (const x of pPrs) {
      const np = x && kid(x, 'numPr');
      if (!np) continue;
      const nid = kid(np, 'numId');
      const il = kid(np, 'ilvl');
      if (nid) numId = attr(nid, 'val');
      if (il) lvl = Number(attr(il, 'val') || 0);
    }
    // How far in the item sits: numbering level's indent, under the paragraph's own.
    let left = 0;
    if (numId && numId !== '0') {
      const lvlPPr = ((numFmt[numId] || {})[String(lvl)] || {}).pPr || null;
      const ind = lastKid([docDefaults.pPr, ...stylePPrs(sid), lvlPPr, pPr], 'ind');
      left = ind ? Number(attr(ind, 'left') || attr(ind, 'start') || 0) : 0;
      // An item of a different list, indented further than the open one, sits inside it.
      const top = listStack[listStack.length - 1];
      if (top && top.numId !== numId && left) {
        let d = 0;
        while (d < listStack.length && listStack[d].left && listStack[d].left < left - 90) d++;
        lvl = d;
      }
    }
    const heading = /^heading [1-6]$|^title$/.test(sname);
    const rPrs = [...styleRPrs(sid), ...(tableRPrs || [])];
    cur = { rPrs, base: baseFmt, bold: heading, th: tableHead, italic: sname === 'quote' || sname === 'intense quote' };
    // Headings, title and subtitle look as the document's own styles say (meta.styles):
    // what the style gives is not repeated on each run.
    const key = /^heading [1-6]$/.test(sname) ? `h${sname.slice(-1)}` : sname === 'title' || sname === 'subtitle' ? sname : null;
    if (key) {
      const sf = runFormat([docDefaults.rPr, ...styleRPrs(sid)]);
      if (!tableRPrs && !docStyles[key]) docStyles[key] = { color: sf.color || null, size: sf.sz || null, font: sf.font || null, bold: !!sf.b, italic: !!sf.i };
      cur.base = { ...baseFmt, ...sf };
    } else if (cur.italic) cur.base = { ...baseFmt, ...runFormat(rPrs) };
    const listed = numId && numId !== '0';
    let body = await runs(p);
    let pageBreakAfter = false;
    if (body.includes('<!--PAGEBREAK-->')) {
      pageBreakAfter = body.trim().endsWith('<!--PAGEBREAK-->') || body.replace('<!--PAGEBREAK-->', '').trim() === '';
      body = body.replace(/<!--PAGEBREAK-->/g, '');
    }
    const st = pStyleAttrs(pPrs, listed);
    const styleAttr = st.length ? ` style="${st.join('; ')}"` : '';
    const inner = body || '<br>';
    let out = '';
    if (listed) {
      const f = (numFmt[numId] || {})[String(lvl)] || { fmt: 'bullet', start: 1 };
      const tag = f.fmt === 'bullet' || f.fmt === 'none' ? 'ul' : 'ol';
      const type = { lowerLetter: 'lower-alpha', upperLetter: 'upper-alpha', lowerRoman: 'lower-roman', upperRoman: 'upper-roman' }[f.fmt];
      // Word's counting: each level counts on; a higher level starts the deeper ones again.
      const cnt = counters[numId] || (counters[numId] = {});
      for (const k of Object.keys(cnt)) if (Number(k) > lvl) delete cnt[k];
      const n = cnt[lvl] = (cnt[lvl] || (f.start || 1) - 1) + 1;
      if (listStack.length > lvl + 1) out += closeLists(lvl);
      if (listStack.length === lvl + 1) {
        const top = listStack[lvl];
        if (top.tag !== tag || (top.numId !== numId && lvl === 0)) { out += closeLists(lvl - 1); }
        else out += '</li>';
      }
      while (listStack.length < lvl + 1) {
        const opening = listStack.length === lvl;
        listStack.push({ tag, numId, left: listStack.length === lvl ? left : 0 });
        const start = opening && tag === 'ol' && n > 1 ? ` start="${n}"` : '';
        out += `<${tag}${start}${type ? ` style="list-style-type: ${type}"` : ''}>`;
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

  // Inside a table: its style's run formatting (and its header row's).
  let tableRPrs = null;
  let tableHead = false;
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
    const tstyle = tblPr ? val(tblPr, 'tblStyle') : null;
    const tchain = chain(tstyle);
    const tborders = tblPr ? kid(tblPr, 'tblBorders') : null;
    const borders = tborders || [...tchain].reverse().map((x) => x.tblPr && kid(x.tblPr, 'tblBorders')).find(Boolean) || null;
    const noBorders = borders && kids(borders).every((b) => ['nil', 'none'].includes(attr(b, 'val')));
    // The table style's look for its first row, when the table uses it (Word's "Header Row" box).
    const look = tblPr ? kid(tblPr, 'tblLook') : null;
    const lookFirst = look && (attr(look, 'firstRow') === '1' || (parseInt(attr(look, 'val') || '0', 16) & 0x20) !== 0);
    const firstCond = lookFirst ? tchain.flatMap((x) => x.cond).filter((c) => attr(c, 'type') === 'firstRow').pop() : null;
    const firstTc = firstCond ? kid(firstCond, 'tcPr') : null;
    const firstShd = firstTc ? kid(firstTc, 'shd') : null;
    const firstFill = firstShd && attr(firstShd, 'fill') && !/^(auto|FFFFFF)$/i.test(attr(firstShd, 'fill')) ? attr(firstShd, 'fill') : null;
    const firstRPr = firstCond ? kid(firstCond, 'rPr') : null;
    const headRow = (r) => r === 0 && rows[0] && (kid(kid(rows[0], 'trPr'), 'tblHeader') || (firstCond && (firstFill || (firstRPr && on(firstRPr, 'b')))));
    let out = `<table class="${noBorders ? 'tbl-plain' : 'tbl-grid'}">`;
    if (cols.length && cols.every((w) => w > 0)) out += `<colgroup>${cols.map((w) => `<col style="width:${w}px">`).join('')}</colgroup>`;
    out += '<tbody>';
    for (let r = 0; r < grid.length; r++) {
      out += '<tr>';
      const th = headRow(r);
      for (const cell of grid[r]) {
        if (cell.skip) continue;
        const tcPr = kid(cell.tc, 'tcPr');
        const st = [];
        const shd = tcPr ? kid(tcPr, 'shd') : null;
        if (shd && attr(shd, 'fill') && !/^(auto|FFFFFF)$/i.test(attr(shd, 'fill'))) st.push(`background-color: #${attr(shd, 'fill')}`);
        else if (th && firstFill) st.push(`background-color: #${firstFill}`);
        const va = val(tcPr, 'vAlign');
        if (va === 'center') st.push('vertical-align: middle');
        else if (va === 'bottom') st.push('vertical-align: bottom');
        let inner = '';
        listStack = [];
        const outer = [tableRPrs, tableHead];
        tableRPrs = th && firstRPr ? [...styleRPrs(tstyle), firstRPr] : styleRPrs(tstyle);
        tableHead = !!th;
        for (const child of kids(cell.tc)) {
          if (child.localName === 'p') inner += await paragraph(child);
          else if (child.localName === 'tbl') inner += closeLists() + await table(child);
        }
        [tableRPrs, tableHead] = outer;
        inner += closeLists();
        // A cell with one plain paragraph keeps just its text.
        const single = /^<p>(.*)<\/p>$/s.exec(inner);
        if (single && !single[1].includes('<p')) inner = single[1];
        const tag = th ? 'th' : 'td';
        out += `<${tag}${cell.span > 1 ? ` colspan="${cell.span}"` : ''}${cell.rowspan > 1 ? ` rowspan="${cell.rowspan}"` : ''}${st.length ? ` style="${st.join('; ')}"` : ''}>${inner || '<br>'}</${tag}>`;
      }
      out += '</tr>';
    }
    return `${out}</tbody></table>`;
  }

  for (const [kind, nx, tag] of noteParts) {
    for (const n of all(nx, tag)) {
      const type = attr(n, 'type');
      if (type && type !== 'normal') continue;
      const paras = [];
      for (const p of kids(n, 'p')) paras.push(await runs(p));
      notes[kind][attr(n, 'id')] = paras.filter((x) => x.trim()).join('<br>').trim();
    }
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

  // Comments: comments.xml, threads and resolved marks from commentsExtended.xml, and the
  // stretches of text they are about (commentRangeStart/End) as comment spans.
  const comments = [];
  const cxml = await text('word/comments.xml');
  if (cxml) {
    const byId = {};
    const byPara = {};
    for (const c of all(parseXml(cxml), 'comment')) {
      const paras = kids(c, 'p');
      const textOf = (p) => all(p, 't').map((t) => t.textContent).join('');
      const item = {
        id: `c${attr(c, 'id')}`, author: attr(c, 'author') || '', initials: attr(c, 'initials') || '', date: attr(c, 'date') || '',
        text: paras.map(textOf).join('\n').trim(), done: false, replies: [],
      };
      byId[attr(c, 'id')] = item;
      const last = paras[paras.length - 1];
      if (last && attr(last, 'paraId')) byPara[attr(last, 'paraId')] = item;
    }
    const ext = await text('word/commentsExtended.xml');
    const parentOf = new Map();
    if (ext) {
      for (const e of all(parseXml(ext), 'commentEx')) {
        const item = byPara[attr(e, 'paraId')];
        if (!item) continue;
        if (['1', 'true'].includes(attr(e, 'done'))) item.done = true;
        const parent = byPara[attr(e, 'paraIdParent')];
        if (parent && parent !== item) parentOf.set(item, parent);
      }
    }
    for (const item of Object.values(byId)) {
      const parent = parentOf.get(item);
      if (parent) parent.replies.push({ author: item.author, initials: item.initials, date: item.date, text: item.text });
    }
    const box = document.createElement('div');
    box.innerHTML = html;
    for (const [wid, item] of Object.entries(byId)) {
      const a = box.querySelector(`span[data-cs="${CSS.escape(wid)}"]`);
      const b = box.querySelector(`span[data-ce="${CSS.escape(wid)}"]`);
      if (parentOf.has(item) || !a || !b || (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_PRECEDING)) continue;
      const r = document.createRange();
      r.setStartAfter(a);
      r.setEndBefore(b);
      wrapRange(r, box, item.id);
      if (box.querySelector(`span.cmt[data-cmt="${CSS.escape(item.id)}"]`)) comments.push(item);
    }
    for (const m of box.querySelectorAll('span[data-cs], span[data-ce]')) m.remove();
    html = box.innerHTML;
  } else html = html.replace(/<span data-c[se]="[^"]*"><\/span>/g, '');

  // Page setup, header and footer; the document's own font, size and line spacing.
  const meta = defaultMeta();
  if (baseFmt.font) meta.font = baseFmt.font;
  meta.fontSize = baseFmt.sz || (stylesXml ? 10 : 11);
  meta.lineHeight = baseLine;
  if (Object.keys(docStyles).length) meta.styles = docStyles;
  if (comments.length) meta.comments = comments;
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

  // Comments: Word's ids in document order (replies after), and where each one's text starts and ends.
  const cmtSpans = [...root.querySelectorAll('span.cmt[data-cmt]')];
  const cmtList = [];
  for (const sp of cmtSpans) {
    const c = (meta.comments || []).find((x) => x.id === sp.dataset.cmt);
    if (c && !cmtList.includes(c)) cmtList.push(c);
  }
  const cmtIds = new Map();
  let cmtSeq = 0;
  for (const c of cmtList) cmtIds.set(c, [cmtSeq++, ...(c.replies || []).map(() => cmtSeq++)]);
  const cmtFirst = new Map();
  const cmtLast = new Map();
  for (const sp of cmtSpans) { if (!cmtFirst.has(sp.dataset.cmt)) cmtFirst.set(sp.dataset.cmt, sp); cmtLast.set(sp.dataset.cmt, sp); }
  const cmtOf = (sp) => cmtList.find((x) => x.id === sp.dataset.cmt);
  // Footnotes, numbered from 1 in document order.
  const footnotes = [];

  // Inline content of a block -> runs.
  async function inline(node, f) {
    let out = '';
    for (const c of node.childNodes) {
      if (c.nodeType === 3) { out += textRun(c.data, f); continue; }
      if (c.nodeType !== 1) continue;
      const tag = c.tagName;
      if (tag === 'BR') { out += '<w:r><w:br/></w:r>'; continue; }
      if (tag === 'SUP' && c.classList.contains('fn-ref')) {
        footnotes.push(c.dataset.note || '');
        out += `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="${footnotes.length}"/></w:r>`;
        continue;
      }
      if (tag === 'SPAN' && c.classList.contains('cmt') && cmtOf(c)) {
        const ids = cmtIds.get(cmtOf(c));
        if (cmtFirst.get(c.dataset.cmt) === c) out += ids.map((n) => `<w:commentRangeStart w:id="${n}"/>`).join('');
        out += await inline(c, f);
        if (cmtLast.get(c.dataset.cmt) === c) out += ids.map((n) => `<w:commentRangeEnd w:id="${n}"/><w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:commentReference w:id="${n}"/></w:r>`).join('');
        continue;
      }
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
  // Heading, title and subtitle looks: the document's own (from a file it was opened from), else ours.
  const own = meta.styles || {};
  const look = (k, d) => {
    const v = own[k];
    if (!v) return d;
    const sz = v.size ? Math.round(v.size * 2) : null;
    return `${v.font ? `<w:rFonts w:ascii="${esc(v.font)}" w:hAnsi="${esc(v.font)}"/>` : ''}${v.bold ? '<w:b/>' : ''}${v.italic ? '<w:i/>' : ''}${v.color ? `<w:color w:val="${esc(v.color)}"/>` : ''}${sz ? `<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>` : ''}`;
  };
  const head = (n, size, before, after) => style(`Heading${n}`, `heading ${n}`, `<w:keepNext/><w:spacing w:before="${before}" w:after="${after}"/><w:outlineLvl w:val="${n - 1}"/>`, look(`h${n}`, `<w:b/><w:color w:val="1F5B3A"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/>`));
  const styles = `${XML_HEAD}<w:styles xmlns:w="${NS.w}"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="${esc(font)}" w:hAnsi="${esc(font)}" w:eastAsia="${esc(font)}" w:cs="${esc(font)}"/><w:sz w:val="${fs}"/><w:szCs w:val="${fs}"/><w:lang w:val="en-US"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="${Math.round((meta.lineHeight || 1.15) * 240)}" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>
${head(1, 40, 360, 120)}${head(2, 32, 280, 80)}${head(3, 26, 240, 60)}${head(4, 24, 200, 40)}${head(5, 22, 200, 40)}${head(6, 22, 200, 40)}
${style('Title', 'Title', '<w:spacing w:after="80"/>', look('title', '<w:sz w:val="56"/><w:szCs w:val="56"/><w:spacing w:val="-10"/>'))}
${style('Subtitle', 'Subtitle', '<w:spacing w:after="240"/>', look('subtitle', '<w:color w:val="5A6560"/><w:sz w:val="28"/>'))}
${style('Quote', 'Quote', '<w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="3FB950"/></w:pBdr><w:ind w:left="240"/>', '<w:i/><w:color w:val="3B443E"/>')}
${style('Caption', 'caption', '', '<w:i/><w:color w:val="5A6560"/><w:sz w:val="18"/>')}
${style('Code', 'Code', '<w:shd w:val="clear" w:color="auto" w:fill="F3F5F3"/><w:spacing w:after="0" w:line="240" w:lineRule="auto"/>', '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="20"/>')}
${style('ListParagraph', 'List Paragraph', '<w:spacing w:after="40"/><w:contextualSpacing/>', '')}
${style('Header', 'header', '', '<w:color w:val="555555"/><w:sz w:val="18"/>')}${style('Footer', 'footer', '', '<w:color w:val="555555"/><w:sz w:val="18"/>')}
${style('TOCHeading', 'TOC Heading', '', '<w:b/><w:sz w:val="28"/>')}
<w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="1F6FEB"/><w:u w:val="single"/></w:rPr></w:style>
${style('CommentText', 'annotation text', '<w:spacing w:after="0" w:line="240" w:lineRule="auto"/>', '<w:sz w:val="20"/><w:szCs w:val="20"/>')}
<w:style w:type="character" w:styleId="CommentReference"><w:name w:val="annotation reference"/><w:rPr><w:sz w:val="16"/><w:szCs w:val="16"/></w:rPr></w:style>
${style('FootnoteText', 'footnote text', '<w:spacing w:after="0" w:line="240" w:lineRule="auto"/>', '<w:sz w:val="20"/><w:szCs w:val="20"/>')}
<w:style w:type="character" w:styleId="FootnoteReference"><w:name w:val="footnote reference"/><w:rPr><w:vertAlign w:val="superscript"/></w:rPr></w:style>
</w:styles>`;

  // Comments (comments.xml) and their threads and resolved marks (commentsExtended.xml).
  const W14 = 'http://schemas.microsoft.com/office/word/2010/wordml';
  const W15 = 'http://schemas.microsoft.com/office/word/2012/wordml';
  const MC = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
  if (cmtList.length) {
    let para = 0x10000000;
    const commentXml = [];
    const exXml = [];
    const one = (n, who, initials, date, textBody, parentPara, done) => {
      const lines = String(textBody || '').split('\n');
      const ids = lines.map(() => (++para).toString(16).toUpperCase());
      const ps = lines.map((line, i) => `<w:p w14:paraId="${ids[i]}" w14:textId="77777777"><w:pPr><w:pStyle w:val="CommentText"/></w:pPr>${i === 0 ? '<w:r><w:rPr><w:rStyle w:val="CommentReference"/></w:rPr><w:annotationRef/></w:r>' : ''}<w:r><w:t xml:space="preserve">${esc(line)}</w:t></w:r></w:p>`).join('');
      commentXml.push(`<w:comment w:id="${n}" w:author="${esc(who || 'Author')}" w:date="${esc((date || new Date().toISOString()).replace(/\.\d+Z$/, 'Z'))}" w:initials="${esc(initials || '')}">${ps}</w:comment>`);
      const last = ids[ids.length - 1];
      exXml.push(`<w15:commentEx w15:paraId="${last}"${parentPara ? ` w15:paraIdParent="${parentPara}"` : ''} w15:done="${done ? 1 : 0}"/>`);
      return last;
    };
    for (const c of cmtList) {
      const ids = cmtIds.get(c);
      const top = one(ids[0], c.author, c.initials, c.date, c.text, null, c.done);
      (c.replies || []).forEach((r, i) => one(ids[i + 1], r.author, r.initials, r.date, r.text, top, c.done));
    }
    extraParts.push({ name: 'word/comments.xml', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml',
      data: `${XML_HEAD}<w:comments xmlns:w="${NS.w}" xmlns:w14="${W14}" xmlns:mc="${MC}" mc:Ignorable="w14">${commentXml.join('')}</w:comments>` });
    extraParts.push({ name: 'word/commentsExtended.xml', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml',
      data: `${XML_HEAD}<w15:commentsEx xmlns:w15="${W15}" xmlns:mc="${MC}" mc:Ignorable="w15">${exXml.join('')}</w15:commentsEx>` });
    addRel('http://schemas.openxmlformats.org/officeDocument/2006/relationships/comments', 'comments.xml');
    addRel('http://schemas.microsoft.com/office/2011/relationships/commentsExtended', 'commentsExtended.xml');
  }
  // Footnotes (footnotes.xml), after Word's two separator notes.
  if (footnotes.length) {
    const sep = (id, type, what) => `<w:footnote w:type="${type}" w:id="${id}"><w:p><w:pPr><w:spacing w:after="0" w:line="240" w:lineRule="auto"/></w:pPr><w:r><w:${what}/></w:r></w:p></w:footnote>`;
    const parts = [sep(-1, 'separator', 'separator'), sep(0, 'continuationSeparator', 'continuationSeparator')];
    for (let i = 0; i < footnotes.length; i++) {
      const box = document.createElement('div');
      box.innerHTML = footnotes[i];
      parts.push(`<w:footnote w:id="${i + 1}"><w:p><w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr><w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r><w:r><w:t xml:space="preserve"> </w:t></w:r>${await inline(box, {})}</w:p></w:footnote>`);
    }
    extraParts.push({ name: 'word/footnotes.xml', type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml',
      data: `${XML_HEAD}<w:footnotes xmlns:w="${NS.w}" xmlns:r="${NS.r}">${parts.join('')}</w:footnotes>` });
    addRel('http://schemas.openxmlformats.org/officeDocument/2006/relationships/footnotes', 'footnotes.xml');
  }
  const ct = `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/><Default Extension="bmp" ContentType="image/bmp"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/><Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>${extraParts.map((p) => `<Override PartName="/${p.name}" ContentType="${p.type || `application/vnd.openxmlformats-officedocument.wordprocessingml.${p.name.includes('header') ? 'header' : 'footer'}+xml`}"/>`).join('')}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/></Types>`;
  const docRels = `${XML_HEAD}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/numbering" Target="numbering.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>${rels.map((r) => `<Relationship Id="${r.id}" Type="${r.type}" Target="${esc(r.target)}"${r.external ? ' TargetMode="External"' : ''}/>`).join('')}</Relationships>`;
  const now = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
  const core = `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(meta.title || '')}</dc:title><dc:creator>${esc(meta.author || '')}</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified></cp:coreProperties>`;
  const app = `${XML_HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>Snake's Word</Application></Properties>`;
  const settings = `${XML_HEAD}<w:settings xmlns:w="${NS.w}"><w:defaultTabStop w:val="720"/>${footnotes.length ? '<w:footnotePr><w:footnote w:id="-1"/><w:footnote w:id="0"/></w:footnotePr>' : ''}<w:compat><w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/></w:compat></w:settings>`;

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
  const escAttr = (s) => escText(s).replace(/"/g, '&quot;');

  // Footnotes and endnotes, by id (read before the body, which refers to them).
  const notes = { foot: {}, end: {} };
  const noteParts = [];
  for (const [kind, part, tag] of [['foot', 'word/footnotes.xml', 'footnote'], ['end', 'word/endnotes.xml', 'endnote']]) {
    const xml = await text(part);
    if (xml) noteParts.push([kind, parseXml(xml), tag]);
  }
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
