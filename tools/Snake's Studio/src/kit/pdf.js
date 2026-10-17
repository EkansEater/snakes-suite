// A small PDF writer, for when there is no printer to ask (the Converter in the browser):
//   htmlToPdf(html)        a document: headings, paragraphs with bold/italic/underline, lists,
//                          quotes, code, tables, pictures, page breaks; flowed onto pages
//   imagesToPdf(canvases)  one picture per page
// Text uses the PDF standard fonts (Helvetica, Courier), so it needs no embedding; letters
// outside Western European ones become "?". The desktop and Android Converters keep any text.

const PAGE = { a4: [595.28, 841.89], letter: [612, 792] };
export const PAGE_SIZES = PAGE;

// ---------------------------------------------------------------------------
// The file itself
// ---------------------------------------------------------------------------
class PdfFile {
  constructor() {
    this.objects = []; // [number, bytes]
    this.pages = [];
    this.fonts = {};
    this.next = 3; // 1: catalog, 2: page tree
  }
  obj(body) {
    const n = this.next++;
    this.objects.push([n, body]);
    return n;
  }
  font(name) {
    if (!this.fonts[name]) this.fonts[name] = this.obj(enc(`<< /Type /Font /Subtype /Type1 /BaseFont /${name} /Encoding /WinAnsiEncoding >>`));
    return this.fonts[name];
  }
  /** A JPEG as an image object. */
  jpeg(bytes, w, h) {
    return this.obj(concat(enc(`<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${bytes.length} >>\nstream\n`), bytes, enc('\nendstream')));
  }
  async page(w, h, content, { fonts = [], images = {} } = {}) {
    const data = await deflate(enc(content));
    const stream = this.obj(concat(enc(`<< /Length ${data.length} /Filter /FlateDecode >>\nstream\n`), data, enc('\nendstream')));
    const fontRes = fonts.map((f) => `/${f} ${this.font(FONT_NAMES[f])} 0 R`).join(' ');
    const imgRes = Object.entries(images).map(([k, n]) => `/${k} ${n} 0 R`).join(' ');
    const n = this.obj(enc(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(w)} ${num(h)}] /Contents ${stream} 0 R /Resources << /Font << ${fontRes} >> /XObject << ${imgRes} >> >> >>`));
    this.pages.push(n);
  }
  bytes(title = '') {
    const parts = [enc('%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')];
    let at = parts[0].length;
    const offsets = {};
    const add = (n, body) => {
      offsets[n] = at;
      const b = concat(enc(`${n} 0 obj\n`), body, enc('\nendobj\n'));
      parts.push(b);
      at += b.length;
    };
    const info = this.obj(enc(`<< /Producer (Snake's Master Suite) /Title ${pdfString(title)} >>`));
    add(1, enc('<< /Type /Catalog /Pages 2 0 R >>'));
    add(2, enc(`<< /Type /Pages /Kids [${this.pages.map((p) => `${p} 0 R`).join(' ')}] /Count ${this.pages.length} >>`));
    for (const [n, body] of this.objects) add(n, body);
    const count = this.next;
    let xref = `xref\n0 ${count}\n0000000000 65535 f \n`;
    for (let i = 1; i < count; i++) xref += `${String(offsets[i] || 0).padStart(10, '0')} 00000 n \n`;
    xref += `trailer\n<< /Size ${count} /Root 1 0 R /Info ${info} 0 R >>\nstartxref\n${at}\n%%EOF\n`;
    parts.push(enc(xref));
    return concat(...parts);
  }
}

const FONT_NAMES = { F1: 'Helvetica', F2: 'Helvetica-Bold', F3: 'Helvetica-Oblique', F4: 'Helvetica-BoldOblique', F5: 'Courier', F6: 'Courier-Bold' };

// Windows-1252 (WinAnsi), which the standard fonts use. Anything else becomes "?".
const CP1252 = { 0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
  0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98,
  0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f };
function winAnsi(s) {
  const out = [];
  for (const ch of s) {
    const c = ch.codePointAt(0);
    if ((c >= 0x20 && c < 0x7f) || (c >= 0xa0 && c <= 0xff)) out.push(c);
    else if (CP1252[c]) out.push(CP1252[c]);
    else if (c === 0x09) out.push(0x20);
    else if (c === 0x2212) out.push(0x2d);
    else if (c === 0xa0 || c === 0x202f) out.push(0x20);
    else out.push(0x3f);
  }
  return out;
}
const pdfText = (s) => {
  let r = '(';
  for (const b of winAnsi(s)) {
    if (b === 0x28 || b === 0x29 || b === 0x5c) r += `\\${String.fromCharCode(b)}`;
    else if (b < 0x20 || b > 0x7e) r += `\\${b.toString(8).padStart(3, '0')}`;
    else r += String.fromCharCode(b);
  }
  return `${r})`;
};
const pdfString = (s) => pdfText(s || '');
const num = (v) => (Math.round(v * 100) / 100).toString();
const enc = (s) => {
  // Latin-1 bytes (our content strings are ASCII plus the escapes above).
  const b = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255;
  return b;
};
function concat(...parts) {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
async function deflate(bytes) {
  const s = new Blob([bytes]).stream().pipeThrough(new CompressionStream('deflate'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}

// ---------------------------------------------------------------------------
// Measuring: Arial, Arimo and Liberation Sans share Helvetica's widths
// ---------------------------------------------------------------------------
const measurer = document.createElement('canvas').getContext('2d');
const SANS = 'Arimo, "Liberation Sans", Arial, Helvetica, sans-serif';
function width(text, f, size) {
  if (f === 'F5' || f === 'F6') return text.length * 0.6 * size;
  measurer.font = `${f === 'F3' || f === 'F4' ? 'italic ' : ''}${f === 'F2' || f === 'F4' ? 'bold ' : ''}100px ${SANS}`;
  return (measurer.measureText(text).width / 100) * size;
}

/** A picture (canvas) as JPEG bytes, on white. */
async function jpegOf(canvas, quality = 0.88) {
  const c = document.createElement('canvas');
  c.width = canvas.width;
  c.height = canvas.height;
  const x = c.getContext('2d');
  x.fillStyle = '#fff';
  x.fillRect(0, 0, c.width, c.height);
  x.drawImage(canvas, 0, 0);
  const blob = await new Promise((r) => c.toBlob(r, 'image/jpeg', quality));
  return new Uint8Array(await blob.arrayBuffer());
}

// ---------------------------------------------------------------------------
// Pictures, one per page
// ---------------------------------------------------------------------------
/** page: 'fit' (each page the picture's size) or 'a4' / 'letter' (the picture centred). */
export async function imagesToPdf(canvases, { page = 'fit', margin = 36, quality = 0.88, title = '' } = {}) {
  const pdf = new PdfFile();
  for (const c of canvases) {
    const img = pdf.jpeg(await jpegOf(c, quality), c.width, c.height);
    let pw;
    let ph;
    let w = c.width * 0.75; // 96 dpi pixels to points
    let h = c.height * 0.75;
    if (page === 'fit') { pw = w; ph = h; } else {
      [pw, ph] = PAGE[page] || PAGE.a4;
      if (w > h && pw < ph) [pw, ph] = [ph, pw]; // landscape pictures on landscape pages
      const k = Math.min(1, (pw - margin * 2) / w, (ph - margin * 2) / h);
      w *= k;
      h *= k;
    }
    await pdf.page(pw, ph, `q ${num(w)} 0 0 ${num(h)} ${num((pw - w) / 2)} ${num((ph - h) / 2)} cm /Im0 Do Q`, { images: { Im0: img } });
  }
  return pdf.bytes(title);
}

// ---------------------------------------------------------------------------
// Documents: HTML flowed onto pages
// ---------------------------------------------------------------------------
const BLOCK = { h1: [22, 'bold', 14, 8], h2: [17, 'bold', 12, 6], h3: [14, 'bold', 10, 4], h4: [12, 'bold', 8, 4], h5: [11, 'bold', 8, 2], h6: [10, 'bold', 6, 2] };

export async function htmlToPdf(html, { page = 'a4', margin = 56, size = 11, title = '' } = {}) {
  const [PW, PH] = PAGE[page] || PAGE.a4;
  const pdf = new PdfFile();
  const root = new DOMParser().parseFromString(`<body>${html}</body>`, 'text/html').body;
  const left = margin;
  const right = PW - margin;
  let y = PH - margin;
  let ops = [];
  let fonts = new Set();
  let images = {};
  let imgSeq = 0;

  const flushPage = async () => {
    await pdf.page(PW, PH, ops.join('\n'), { fonts: [...fonts], images });
    ops = [];
    fonts = new Set();
    images = {};
    y = PH - margin;
  };
  const need = async (h) => { if (y - h < margin && ops.length) await flushPage(); };

  /** Words of a block with their font, size and decoration. */
  const runsOf = (el, style = { b: false, i: false, u: false, mono: false, link: false }) => {
    const out = [];
    for (const n of el.childNodes) {
      if (n.nodeType === 3) {
        out.push({ text: n.textContent.replace(/\s+/g, ' '), ...style });
      } else if (n.nodeType === 1) {
        const t = n.tagName.toLowerCase();
        if (t === 'br') { out.push({ br: true }); continue; }
        if (['ul', 'ol', 'table', 'img'].includes(t)) continue;
        const s = { ...style };
        if (t === 'b' || t === 'strong' || /bold|[6-9]00/.test(n.style.fontWeight)) s.b = true;
        if (t === 'i' || t === 'em' || n.style.fontStyle === 'italic') s.i = true;
        if (t === 'u' || /underline/.test(n.style.textDecoration)) s.u = true;
        if (t === 'code' || t === 'kbd' || t === 'samp') s.mono = true;
        if (t === 'a') s.link = true;
        out.push(...runsOf(n, s));
      }
    }
    return out;
  };
  const fontOf = (r) => (r.mono ? (r.b ? 'F6' : 'F5') : r.b && r.i ? 'F4' : r.b ? 'F2' : r.i ? 'F3' : 'F1');

  /** Wrap runs into lines of at most `w` points. */
  const lines = (runs, w, sz) => {
    const out = [];
    let line = [];
    let lw = 0;
    const push = () => { out.push({ items: line, w: lw }); line = []; lw = 0; };
    for (const r of runs) {
      if (r.br) { push(); continue; }
      const f = fontOf(r);
      for (const piece of r.text.split(/(\s+)/)) {
        if (!piece) continue;
        if (/^\s+$/.test(piece)) { if (line.length) { const sw = width(' ', f, sz); line.push({ text: ' ', f, w: sw, r }); lw += sw; } continue; }
        let word = piece;
        let ww = width(word, f, sz);
        while (ww > w && word.length > 1) {
          // A word longer than the line: cut it.
          let k = word.length - 1;
          while (k > 1 && width(word.slice(0, k), f, sz) > w) k--;
          if (line.length) push();
          line.push({ text: word.slice(0, k), f, w: width(word.slice(0, k), f, sz), r });
          lw = line[0].w;
          push();
          word = word.slice(k);
          ww = width(word, f, sz);
        }
        if (lw + ww > w && line.length) {
          while (line.length && line[line.length - 1].text === ' ') lw -= line.pop().w;
          push();
        }
        line.push({ text: word, f, w: ww, r });
        lw += ww;
      }
    }
    while (line.length && line[line.length - 1].text === ' ') lw -= line.pop().w;
    if (line.length) push();
    return out;
  };

  const drawLine = (ln, x, yy, sz, align = 'left', boxW = 0) => {
    let cx = x + (align === 'center' ? (boxW - ln.w) / 2 : align === 'right' ? boxW - ln.w : 0);
    for (const it of ln.items) {
      fonts.add(it.f);
      const colour = it.r.link ? '0.05 0.35 0.8 rg' : '0 0 0 rg';
      ops.push(`BT ${colour} /${it.f} ${num(sz)} Tf ${num(cx)} ${num(yy)} Td ${pdfText(it.text)} Tj ET`);
      if (it.r.u || it.r.link) ops.push(`${it.r.link ? '0.05 0.35 0.8' : '0 0 0'} RG 0.6 w ${num(cx)} ${num(yy - 1.5)} m ${num(cx + it.w)} ${num(yy - 1.5)} l S`);
      cx += it.w;
    }
  };

  const paragraph = async (el, { sz = size, indent = 0, before = 0, after = 6, prefix = null, align = null } = {}) => {
    const runs = runsOf(el);
    if (!runs.some((r) => r.br || r.text.trim())) { y -= after; return; }
    if (runs[0] && runs[0].text) runs[0].text = runs[0].text.replace(/^\s+/, '');
    const lh = sz * 1.35;
    const al = align || el.style.textAlign || el.getAttribute('align') || 'left';
    const ls = lines(runs, right - left - indent, sz);
    y -= before;
    for (let k = 0; k < ls.length; k++) {
      await need(lh);
      y -= sz;
      if (k === 0 && prefix) {
        fonts.add('F1');
        ops.push(`BT 0 0 0 rg /F1 ${num(sz)} Tf ${num(left + indent - width(prefix, 'F1', sz) - 4)} ${num(y)} Td ${pdfText(prefix)} Tj ET`);
      }
      drawLine(ls[k], left + indent, y, sz, al === 'center' || al === 'right' ? al : 'left', right - left - indent);
      y -= lh - sz;
    }
    y -= after;
  };

  const picture = async (img, indent = 0) => {
    const src = img.getAttribute('src') || '';
    if (!/^(data:|blob:)/.test(src)) return;
    const pic = new Image();
    pic.src = src;
    try { await pic.decode(); } catch { return; }
    const c = document.createElement('canvas');
    c.width = pic.naturalWidth;
    c.height = pic.naturalHeight;
    c.getContext('2d').drawImage(pic, 0, 0);
    let w = (Number(img.getAttribute('width')) || pic.naturalWidth) * 0.75;
    let h = w * pic.naturalHeight / Math.max(1, pic.naturalWidth);
    const k = Math.min(1, (right - left - indent) / w, (PH - margin * 2) / h);
    w *= k;
    h *= k;
    await need(h + 6);
    const name = `Im${imgSeq++}`;
    images[name] = pdf.jpeg(await jpegOf(c), c.width, c.height);
    y -= h;
    ops.push(`q ${num(w)} 0 0 ${num(h)} ${num(left + indent)} ${num(y)} cm /${name} Do Q`);
    y -= 6;
  };

  const table = async (tbl, indent = 0) => {
    const rows = [...tbl.querySelectorAll(':scope > tr, :scope > thead > tr, :scope > tbody > tr, :scope > tfoot > tr')];
    const cols = Math.max(1, ...rows.map((r) => [...r.children].reduce((n, c) => n + (Number(c.getAttribute('colspan')) || 1), 0)));
    const sz = Math.min(size, cols > 6 ? 8 : cols > 4 ? 9 : size);
    const total = right - left - indent;
    const cw = total / cols;
    const pad = 3;
    for (const row of rows) {
      const cells = [...row.children];
      let col = 0;
      const laid = cells.map((cell) => {
        const span = Number(cell.getAttribute('colspan')) || 1;
        const header = cell.tagName.toLowerCase() === 'th';
        const runs = runsOf(cell, { b: header, i: false, u: false, mono: false, link: false });
        if (runs[0] && runs[0].text) runs[0].text = runs[0].text.replace(/^\s+/, '');
        const out = { x: left + indent + col * cw, w: cw * span, ls: lines(runs, cw * span - pad * 2, sz), header };
        col += span;
        return out;
      });
      const lh = sz * 1.3;
      const rh = Math.max(...laid.map((c) => c.ls.length), 1) * lh + pad * 2;
      await need(rh);
      const top = y;
      for (const c of laid) {
        if (c.header) ops.push(`0.93 0.95 0.93 rg ${num(c.x)} ${num(top - rh)} ${num(c.w)} ${num(rh)} re f`);
        ops.push(`0.6 0.6 0.6 RG 0.5 w ${num(c.x)} ${num(top - rh)} ${num(c.w)} ${num(rh)} re S`);
        let yy = top - pad;
        for (const ln of c.ls) { yy -= sz; drawLine(ln, c.x + pad, yy, sz); yy -= lh - sz; }
      }
      y -= rh;
    }
    y -= 8;
  };

  const walk = async (el, indent = 0) => {
    for (const n of el.childNodes) {
      if (n.nodeType === 3) {
        if (n.textContent.trim()) { const p = document.createElement('p'); p.textContent = n.textContent; await paragraph(p, { indent }); }
        continue;
      }
      if (n.nodeType !== 1) continue;
      const t = n.tagName.toLowerCase();
      if (n.classList.contains('page-break') || n.style.pageBreakBefore === 'always' || n.style.breakBefore === 'page') { if (ops.length) await flushPage(); if (t !== 'p' && t !== 'div') continue; }
      if (BLOCK[t]) { const [sz, , before, after] = BLOCK[t]; await need(sz * 3); await paragraph(n, { sz, before, after, indent }); continue; }
      // Word's Title and Subtitle paragraph styles.
      if (n.classList.contains('title')) { await need(80); await paragraph(n, { sz: 26, before: 4, after: 6, indent }); continue; }
      if (n.classList.contains('subtitle')) { await paragraph(n, { sz: 15, after: 12, indent }); continue; }
      if (t === 'p') { await paragraph(n, { indent }); for (const img of n.querySelectorAll('img')) await picture(img, indent); continue; }
      if (t === 'ul' || t === 'ol') {
        let k = Number(n.getAttribute('start')) || 1;
        for (const li of n.children) {
          if (li.tagName.toLowerCase() !== 'li') continue;
          const done = li.querySelector('input[type="checkbox"]');
          const mark = done ? (done.checked ? '[x]' : '[ ]') : t === 'ol' ? `${k++}.` : '•';
          await paragraph(li, { indent: indent + 20, prefix: mark, after: 3 });
          for (const sub of li.querySelectorAll(':scope > ul, :scope > ol')) await walk({ childNodes: [sub] }, indent + 20);
        }
        y -= 4;
        continue;
      }
      if (t === 'blockquote') {
        const start = y;
        await walk(n, indent + 16);
        if (start > y) ops.push(`0.6 0.7 0.6 RG 2 w ${num(left + indent + 6)} ${num(start)} m ${num(left + indent + 6)} ${num(y + 4)} l S`);
        continue;
      }
      if (t === 'pre') {
        const p = document.createElement('p');
        const code = document.createElement('code');
        // Line breaks written as <br> count as new lines too.
        const copy = n.cloneNode(true);
        for (const br of copy.querySelectorAll('br')) br.replaceWith('\n');
        code.innerHTML = copy.textContent.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c])).replace(/\n/g, '<br>');
        p.append(code);
        await paragraph(p, { indent: indent + 8, sz: size - 1 });
        continue;
      }
      if (t === 'table') { await table(n, indent); continue; }
      if (t === 'img') { await picture(n, indent); continue; }
      if (t === 'hr') { await need(12); y -= 6; ops.push(`0.7 0.7 0.7 RG 0.7 w ${num(left)} ${num(y)} m ${num(right)} ${num(y)} l S`); y -= 6; continue; }
      if (['script', 'style', 'head', 'title', 'meta'].includes(t)) continue;
      // Containers (div, section, article...): their contents.
      if ([...n.childNodes].some((c) => c.nodeType === 1 && /^(p|h[1-6]|ul|ol|table|div|blockquote|pre|img|hr|section|article)$/i.test(c.tagName))) await walk(n, indent);
      else await paragraph(n, { indent });
    }
  };

  await walk(root);
  if (ops.length || !pdf.pages.length) await flushPage();
  return pdf.bytes(title);
}
