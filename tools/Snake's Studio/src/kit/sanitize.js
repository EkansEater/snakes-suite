// HTML sanitiser for anything pasted or imported into a document: only known
// tags, attributes and styles survive, so a pasted page or a crafted .docx can
// never bring scripts, frames, forms or remote content in.

const TAGS = new Set([
  'p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'strike', 'del', 'ins', 'sub', 'sup', 'span', 'div', 'h1', 'h2', 'h3',
  'h4', 'h5', 'h6', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'a', 'img', 'table', 'thead', 'tbody', 'tfoot', 'tr',
  'td', 'th', 'caption', 'colgroup', 'col', 'hr', 'figure', 'figcaption', 'mark', 'small', 'kbd', 'q', 'cite', 'abbr',
  'dl', 'dt', 'dd', 'aside', 'label',
]);
// Tags whose content is kept but the tag itself becomes something we know.
const RENAME = {
  section: 'div', article: 'div', main: 'div', header: 'div', footer: 'div', nav: 'div', center: 'div',
  font: 'span', big: 'span', tt: 'code', var: 'i', dfn: 'i', address: 'p',
};
// Tags dropped together with everything inside them.
const DROP = new Set([
  'script', 'style', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'link', 'meta', 'base', 'title',
  'head', 'noscript', 'template', 'svg', 'math', 'canvas', 'audio', 'video', 'source', 'track', 'portal', 'xml',
  'form', 'input', 'button', 'select', 'textarea', 'option', 'dialog', 'map', 'area',
]);
const ATTRS = new Set(['href', 'src', 'alt', 'title', 'colspan', 'rowspan', 'width', 'height', 'start', 'type', 'dir', 'lang',
  'reversed', 'span', 'valign', 'align']);
const CSS = new Set([
  'color', 'background-color', 'font-family', 'font-size', 'font-weight', 'font-style', 'text-decoration',
  'text-decoration-line', 'text-decoration-color', 'text-decoration-style', 'text-align', 'line-height', 'margin',
  'margin-left', 'margin-right', 'margin-top', 'margin-bottom', 'padding', 'padding-left', 'padding-right',
  'padding-top', 'padding-bottom', 'text-indent', 'vertical-align', 'border', 'border-top', 'border-right',
  'border-bottom', 'border-left', 'border-color', 'border-width', 'border-style', 'border-collapse', 'width',
  'height', 'max-width', 'list-style-type', 'letter-spacing', 'text-transform', 'float', 'page-break-before',
  'page-break-after', 'break-before', 'break-after', 'white-space', 'font-variant', 'text-shadow', 'columns',
  'column-count', 'column-gap', 'display', 'object-fit', 'aspect-ratio',
]);

function safeUrl(url, kind) {
  const u = String(url || '').trim();
  if (kind === 'src') {
    if (/^data:image\/(png|jpe?g|gif|webp|bmp|avif|svg\+xml);base64,/i.test(u)) return /svg/i.test(u) ? '' : u;
    if (/^blob:/i.test(u)) return u;
    return ''; // remote pictures would let a document phone home
  }
  if (/^(https?:|mailto:|#)/i.test(u)) return u;
  return '';
}

function cleanStyle(style) {
  const out = [];
  for (const decl of String(style).split(';')) {
    const i = decl.indexOf(':');
    if (i < 0) continue;
    const prop = decl.slice(0, i).trim().toLowerCase();
    let val = decl.slice(i + 1).trim();
    if (!CSS.has(prop) || !val) continue;
    if (/url\s*\(|expression\s*\(|javascript:|@import|behavior/i.test(val)) continue;
    if (prop === 'display' && !/^(inline-block|block|inline|none)$/.test(val)) continue;
    // Word's "mso-" leftovers and absolute sizes in odd units are dropped.
    if (/mso-/i.test(val)) continue;
    val = val.replace(/!important/gi, '').trim();
    out.push(`${prop}: ${val}`);
  }
  return out.join('; ');
}

/**
 * Sanitise an HTML string. Returns a DocumentFragment for `doc` (default: the page).
 * keepClasses: class names allowed through (our own document classes).
 */
export function sanitizeHtml(html, { doc = document, keepClasses = [], keepData = true, idPattern = null, customProps = [] } = {}) {
  const src = new DOMParser().parseFromString(`<!doctype html><body>${html}`, 'text/html');
  const keep = new Set(keepClasses);
  const frag = doc.createDocumentFragment();

  const walk = (node, out) => {
    for (const child of Array.from(node.childNodes)) {
      if (child.nodeType === 3) {
        out.append(doc.createTextNode(child.data));
        continue;
      }
      if (child.nodeType !== 1) continue; // comments, Office's conditional comments, processing instructions
      let tag = child.localName.toLowerCase();
      if (tag.includes(':')) { // o:p, v:shape, w:sdt from Word
        walk(child, out);
        continue;
      }
      if (DROP.has(tag)) continue;
      if (RENAME[tag]) tag = RENAME[tag];
      if (!TAGS.has(tag)) {
        walk(child, out);
        continue;
      }
      const el = doc.createElement(tag);
      for (const a of Array.from(child.attributes)) {
        const name = a.name.toLowerCase();
        if (name === 'style') {
          let st = cleanStyle(a.value);
          // Our own layout variables (numbers only), e.g. the column count of a column block.
          for (const prop of customProps) {
            const m = new RegExp(`(?:^|;)\\s*${prop}\\s*:\\s*(\\d{1,3})\\s*(?:;|$)`).exec(a.value);
            if (m) st = `${st ? `${st}; ` : ''}${prop}: ${m[1]}`;
          }
          if (st) el.setAttribute('style', st);
        } else if (name === 'id') {
          if (idPattern && idPattern.test(a.value)) el.id = a.value;
        } else if (name === 'contenteditable') {
          if (a.value === 'false') el.setAttribute('contenteditable', 'false');
        } else if (name === 'class') {
          const cls = a.value.split(/\s+/).filter((c) => keep.has(c));
          if (cls.length) el.className = cls.join(' ');
        } else if (keepData && /^data-[a-z0-9-]+$/.test(name) && !/^on/i.test(a.value)) {
          el.setAttribute(name, a.value.slice(0, 2000));
        } else if (ATTRS.has(name)) {
          if (name === 'href' || name === 'src') {
            const u = safeUrl(a.value, name);
            if (u) el.setAttribute(name, u);
          } else el.setAttribute(name, a.value.slice(0, 500));
        }
      }
      // <font color size face> becomes styles.
      if (child.localName === 'font') {
        const parts = [];
        if (child.getAttribute('color')) parts.push(`color: ${child.getAttribute('color')}`);
        if (child.getAttribute('face')) parts.push(`font-family: ${child.getAttribute('face')}`);
        const sz = { 1: '8pt', 2: '10pt', 3: '12pt', 4: '14pt', 5: '18pt', 6: '24pt', 7: '36pt' }[child.getAttribute('size')];
        if (sz) parts.push(`font-size: ${sz}`);
        if (parts.length) el.setAttribute('style', cleanStyle(parts.join(';')) + (el.getAttribute('style') ? `; ${el.getAttribute('style')}` : ''));
      }
      if (tag === 'a') {
        el.setAttribute('rel', 'noopener noreferrer');
        el.setAttribute('target', '_blank');
      }
      if (tag === 'img' && !el.getAttribute('src')) {
        const alt = child.getAttribute('alt');
        if (alt) out.append(doc.createTextNode(`[${alt}]`));
        continue;
      }
      walk(child, el);
      out.append(el);
    }
  };
  walk(src.body, frag);
  return frag;
}

/** Sanitise to an HTML string. */
export function sanitizeToString(html, opts) {
  const box = document.createElement('div');
  box.append(sanitizeHtml(html, opts));
  return box.innerHTML;
}
