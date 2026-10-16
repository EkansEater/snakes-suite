// The editing surface of Snake's Word: pages, the document flow, formatting,
// undo, input rules (Markdown shortcuts, smart quotes, the slash menu), paste,
// tables, pictures, find and the ruler.
//
// The document is plain HTML in one contenteditable element. Pages are drawn
// behind it; blocks that would cross a page edge are pushed onto the next page
// by a generated stylesheet (nothing is added to the document itself).
import { h, clamp, rafOnce, debounce, drag, uid, escapeHtml } from '../../kit/dom.js';
import { History } from '../../kit/history.js';
import { sanitizeHtml } from '../../kit/sanitize.js';
import { hoverZoom, keepAnchor } from '../../kit/zoom.js';
import { showMenu, closeMenus } from '../../kit/menu.js';
import { icon } from '../../kit/icons.js';

export const PX_PER_IN = 96;
export const PAGE_SIZES = {
  letter: { name: 'Letter', w: 8.5, h: 11 },
  legal: { name: 'Legal', w: 8.5, h: 14 },
  a4: { name: 'A4', w: 8.27, h: 11.69 },
  a5: { name: 'A5', w: 5.83, h: 8.27 },
  a3: { name: 'A3', w: 11.69, h: 16.54 },
  executive: { name: 'Executive', w: 7.25, h: 10.5 },
  tabloid: { name: 'Tabloid', w: 11, h: 17 },
};
const GAP = 28;
const BLOCKS = 'P,H1,H2,H3,H4,H5,H6,LI,PRE,BLOCKQUOTE,TD,TH,DIV,FIGCAPTION,DT,DD';
const BLOCK_SET = new Set(BLOCKS.split(','));
export const DOC_CLASSES = ['title', 'subtitle', 'quote', 'caption', 'checklist', 'page-break', 'toc', 'cols', 'col',
  'img-left', 'img-right', 'img-center', 'img-border', 'img-shadow', 'tbl-plain', 'tbl-grid', 'tbl-rows', 'tbl-green',
  'tbl-grey', 'tbl-dark', 'note', 'highlight-box'];

export function defaultMeta() {
  return {
    page: { size: 'letter', orientation: 'portrait', margins: { top: 1, right: 1, bottom: 1, left: 1 } },
    header: { left: '', center: '', right: '' },
    footer: { left: '', center: '{page}', right: '' },
    firstPageDifferent: true,
    font: '',
    fontSize: 11,
    lineHeight: 1.15,
    pageColor: '#ffffff',
    title: '',
    author: '',
    goal: 0,
  };
}

export class WordEditor {
  constructor({ onChange = () => {}, onSelection = () => {}, onStats = () => {}, settings }) {
    this.onChange = onChange;
    this.onSelection = onSelection;
    this.onStats = onStats;
    this.settings = settings;
    this.meta = defaultMeta();
    this.zoom = settings.get('zoom', 1);
    this.pages = 1;
    this.typing = false;
    this.history = new History({ onChange: () => this.onChange() });

    // ---- DOM ----
    this.doc = h('div.doc', { contenteditable: 'true', spellcheck: settings.get('spellcheck', true), role: 'textbox', 'aria-multiline': 'true' });
    this.sheets = h('div.sheets');
    this.overlay = h('div.overlay-layer'); // picture handles, table tools
    this.stack = h('div.stack', this.sheets, this.doc, this.overlay);
    this.scroller = h('div.ws', this.stack);
    this.ruler = h('div.ruler');
    this.el = h('div.word', this.ruler, this.scroller);
    this.pushSheet = h('style');
    this.pageStyle = h('style');
    document.head.append(this.pushSheet, this.pageStyle);

    document.execCommand('defaultParagraphSeparator', false, 'p');
    this.layoutSoon = rafOnce(() => this.layout());
    this.statsSoon = debounce(() => this.stats(), 350);
    this.commitTypingSoon = debounce(() => this.commit('Typing'), 700);

    this.bindEvents();
    hoverZoom(this.scroller, {
      get: () => this.zoom,
      set: (z, anchor) => this.setZoom(z, anchor),
      min: 0.25, max: 5,
    });
    new ResizeObserver(() => { this.layoutSoon(); this.drawRuler(); }).observe(this.scroller);
  }

  // =========================================================================
  // Loading, saving and undo
  // =========================================================================
  load(html, meta = {}) {
    this.meta = { ...defaultMeta(), ...meta, page: { ...defaultMeta().page, ...(meta.page || {}) } };
    this.doc.innerHTML = html || '<p><br></p>';
    this.normalize();
    this.applyPage();
    this.history.clear();
    this.last = this.snapshot();
    this.layout();
    this.stats();
    this.placeCaretAtStart();
  }

  /** The document as clean HTML (no editor-only marks). */
  html() {
    const clone = this.doc.cloneNode(true);
    for (const el of clone.querySelectorAll('.cell-sel')) el.classList.remove('cell-sel');
    for (const el of clone.querySelectorAll('[class=""]')) el.removeAttribute('class');
    return clone.innerHTML;
  }

  snapshot() {
    return { html: this.doc.innerHTML, meta: JSON.stringify(this.meta), sel: this.saveSelection() };
  }

  restore(s) {
    this.doc.innerHTML = s.html;
    const meta = JSON.parse(s.meta);
    const pageChanged = JSON.stringify(meta.page) !== JSON.stringify(this.meta.page) || meta.pageColor !== this.meta.pageColor || meta.font !== this.meta.font;
    this.meta = meta;
    if (pageChanged) this.applyPage();
    this.restoreSelection(s.sel);
    this.last = s;
    this.layout();
    this.statsSoon();
    this.onSelection();
  }

  /** Record what changed since the last record as one undo step. */
  commit(label = 'Edit') {
    this.commitTypingSoon.cancel();
    this.typing = false;
    const now = this.snapshot();
    const prev = this.last;
    if (prev && now.html === prev.html && now.meta === prev.meta) return;
    this.last = now;
    this.history.push({ label, undo: () => this.restore(prev), redo: () => this.restore(now) });
    this.layoutSoon();
    this.statsSoon();
  }

  /** Run a change as one undo step. */
  change(label, fn) {
    if (this.typing) this.commit('Typing');
    const r = fn();
    this.normalize();
    this.commit(label);
    this.onSelection();
    return r;
  }

  undo() { if (this.typing) this.commit('Typing'); this.history.undo(); }
  redo() { this.history.redo(); }

  // =========================================================================
  // Selection helpers
  // =========================================================================
  range() {
    const sel = window.getSelection();
    if (!sel.rangeCount) return null;
    const r = sel.getRangeAt(0);
    return this.doc.contains(r.commonAncestorContainer) ? r : null;
  }

  pathOf(node) {
    const path = [];
    while (node && node !== this.doc) {
      const parent = node.parentNode;
      if (!parent) return null;
      path.unshift(Array.prototype.indexOf.call(parent.childNodes, node));
      node = parent;
    }
    return node === this.doc ? path : null;
  }

  nodeAt(path) {
    let n = this.doc;
    for (const i of path || []) {
      if (!n.childNodes[i]) return null;
      n = n.childNodes[i];
    }
    return n;
  }

  saveSelection() {
    const r = this.range();
    if (!r) return null;
    return { sp: this.pathOf(r.startContainer), so: r.startOffset, ep: this.pathOf(r.endContainer), eo: r.endOffset };
  }

  restoreSelection(s) {
    if (!s) return;
    const a = this.nodeAt(s.sp);
    const b = this.nodeAt(s.ep);
    if (!a || !b) return;
    try {
      const r = document.createRange();
      r.setStart(a, Math.min(s.so, a.nodeType === 3 ? a.length : a.childNodes.length));
      r.setEnd(b, Math.min(s.eo, b.nodeType === 3 ? b.length : b.childNodes.length));
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
    } catch {}
  }

  focus() { this.doc.focus({ preventScroll: true }); }

  placeCaretAtStart() {
    const first = this.doc.firstElementChild;
    if (!first) return;
    const r = document.createRange();
    r.setStart(first, 0);
    r.collapse(true);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }

  blockOf(node) {
    while (node && node !== this.doc) {
      if (node.nodeType === 1 && BLOCK_SET.has(node.tagName) && !(node.tagName === 'DIV' && (node.classList.contains('cols') || node.classList.contains('col')))) return node;
      node = node.parentNode;
    }
    return null;
  }

  /** The blocks the selection touches, innermost only. */
  selectedBlocks() {
    const r = this.range();
    if (!r) return [];
    if (r.collapsed) {
      const b = this.blockOf(r.startContainer);
      return b ? [b] : [];
    }
    const out = [];
    for (const el of this.doc.querySelectorAll(BLOCKS)) {
      if (el.tagName === 'DIV' && (el.classList.contains('cols') || el.classList.contains('col'))) continue;
      if (!r.intersectsNode(el)) continue;
      if ([...el.children].some((c) => BLOCK_SET.has(c.tagName) && r.intersectsNode(c))) continue;
      out.push(el);
    }
    return out;
  }

  /** Formatting at the caret, for the ribbon's buttons. */
  state() {
    const r = this.range();
    const st = {};
    if (!r) return st;
    for (const c of ['bold', 'italic', 'underline', 'strikeThrough', 'subscript', 'superscript', 'insertUnorderedList', 'insertOrderedList']) {
      try { st[c] = document.queryCommandState(c); } catch { st[c] = false; }
    }
    let node = r.startContainer;
    if (node.nodeType === 3) node = node.parentNode;
    if (!(node instanceof Element) || !this.doc.contains(node)) node = this.doc;
    const cs = getComputedStyle(node);
    st.font = cs.fontFamily.split(',')[0].replace(/["']/g, '').trim();
    st.size = Math.round((parseFloat(cs.fontSize) * 72 / 96) * 2) / 2;
    st.color = cs.color;
    const block = this.blockOf(r.startContainer);
    st.block = block;
    st.align = block ? getComputedStyle(block).textAlign : 'left';
    st.style = block ? this.styleNameOf(block) : 'Normal';
    st.cell = node.closest && node.closest('td, th');
    st.table = st.cell ? st.cell.closest('table') : null;
    st.checklist = !!(node.closest && node.closest('ul.checklist'));
    st.link = node.closest && node.closest('a');
    st.collapsed = r.collapsed;
    return st;
  }

  styleNameOf(block) {
    const t = block.tagName;
    if (/^H[1-6]$/.test(t)) return `Heading ${t[1]}`;
    if (t === 'PRE') return 'Code';
    if (t === 'P' || t === 'DIV') {
      for (const [cls, name] of [['title', 'Title'], ['subtitle', 'Subtitle'], ['quote', 'Quote'], ['caption', 'Caption']]) {
        if (block.classList.contains(cls)) return name;
      }
    }
    if (t === 'LI') return 'List';
    return 'Normal';
  }

  // =========================================================================
  // Formatting
  // =========================================================================
  exec(cmd, value = null, css = false) {
    this.focus();
    document.execCommand('styleWithCSS', false, css);
    document.execCommand(cmd, false, value);
  }

  toggle(cmd, label) {
    this.change(label, () => this.exec(cmd));
  }

  /**
   * Put an inline style on the selection: a marker font is applied with the
   * browser's own command (which splits nodes correctly), then turned into spans.
   */
  inlineStyle(prop, value, label = 'Format') {
    const r = this.range();
    if (!r) return;
    this.change(label, () => {
      if (r.collapsed) {
        // Nothing selected: style the word at the caret, as Word does.
        if (!this.selectWordAtCaret()) {
          this.pendingStyle = { prop, value };
          return;
        }
      }
      const marker = `snake-mark-${uid('')}`;
      this.exec('fontName', marker, false);
      const fonts = this.doc.querySelectorAll(`font[face="${marker}"]`);
      const first = fonts[0];
      const last = fonts[fonts.length - 1];
      for (const f of fonts) {
        const span = document.createElement('span');
        span.style.setProperty(prop, value);
        for (const inner of f.querySelectorAll('span, font')) inner.style && inner.style.removeProperty(prop);
        while (f.firstChild) span.append(f.firstChild);
        f.replaceWith(span);
        if (f === first) this._firstMark = span;
        if (f === last) this._lastMark = span;
      }
      if (this._firstMark && this._lastMark) {
        const nr = document.createRange();
        nr.setStartBefore(this._firstMark);
        nr.setEndAfter(this._lastMark);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(nr);
      }
      this._firstMark = this._lastMark = null;
      this.cleanSpans();
    });
  }

  selectWordAtCaret() {
    const sel = window.getSelection();
    const r = this.range();
    if (!r || !r.collapsed || r.startContainer.nodeType !== 3) return false;
    const text = r.startContainer.data;
    let a = r.startOffset;
    let b = r.startOffset;
    while (a > 0 && /[\p{L}\p{N}_'’-]/u.test(text[a - 1])) a--;
    while (b < text.length && /[\p{L}\p{N}_'’-]/u.test(text[b])) b++;
    if (a === b) return false;
    const nr = document.createRange();
    nr.setStart(r.startContainer, a);
    nr.setEnd(r.startContainer, b);
    sel.removeAllRanges();
    sel.addRange(nr);
    return true;
  }

  /** Merge and drop empty spans left behind by formatting. */
  cleanSpans() {
    for (const s of this.doc.querySelectorAll('span:not([class]):not([data-c])')) {
      if (!s.getAttribute('style')) s.replaceWith(...s.childNodes);
    }
    for (const f of this.doc.querySelectorAll('font')) {
      const span = document.createElement('span');
      if (f.color) span.style.color = f.color;
      while (f.firstChild) span.append(f.firstChild);
      f.replaceWith(span);
    }
  }

  setFont(name) { this.inlineStyle('font-family', /\s/.test(name) ? `"${name}"` : name, 'Font'); }
  setSize(pt) { this.inlineStyle('font-size', `${pt}pt`, 'Font size'); }
  growFont(dir) {
    const st = this.state();
    const sizes = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 36, 48, 72, 96];
    const cur = st.size || 11;
    const next = dir > 0 ? sizes.find((s) => s > cur) || cur + 12 : [...sizes].reverse().find((s) => s < cur) || Math.max(1, cur - 1);
    this.setSize(next);
  }
  setColor(c) { this.change('Text colour', () => this.exec('foreColor', c === 'none' ? '#000000' : c, true)); }
  setHighlight(c) { this.change('Highlight', () => this.exec('hiliteColor', c === 'none' ? 'transparent' : c, true)); }

  clearFormatting() {
    this.change('Clear formatting', () => {
      this.exec('removeFormat');
      const r = this.range();
      if (!r) return;
      for (const el of this.doc.querySelectorAll('span, font, mark')) {
        if (r.intersectsNode(el) && !el.dataset.c) el.replaceWith(...el.childNodes);
      }
      for (const b of this.selectedBlocks()) {
        if (b.tagName !== 'LI' && b.tagName !== 'TD' && b.tagName !== 'TH') {
          const p = this.retag(b, 'P');
          p.removeAttribute('class');
          p.removeAttribute('style');
        }
      }
    });
  }

  retag(el, tag) {
    if (el.tagName === tag) return el;
    const n = document.createElement(tag);
    for (const a of el.attributes) n.setAttribute(a.name, a.value);
    while (el.firstChild) n.append(el.firstChild);
    el.replaceWith(n);
    return n;
  }

  /** Paragraph styles: Normal, Title, Heading 1-4, Quote, Code, ... */
  setStyle(name) {
    const map = {
      Normal: ['P', ''], Title: ['P', 'title'], Subtitle: ['P', 'subtitle'], Quote: ['P', 'quote'], Caption: ['P', 'caption'],
      Code: ['PRE', ''], 'Heading 1': ['H1', ''], 'Heading 2': ['H2', ''], 'Heading 3': ['H3', ''], 'Heading 4': ['H4', ''],
      'Heading 5': ['H5', ''], 'Heading 6': ['H6', ''],
    };
    const [tag, cls] = map[name] || map.Normal;
    const sel = this.saveSelection();
    this.change(name, () => {
      for (const b of this.selectedBlocks()) {
        if (b.tagName === 'TD' || b.tagName === 'TH') continue;
        if (b.tagName === 'LI') {
          // A list item becomes a paragraph of that style outside the list.
          this.exec(b.parentNode.tagName === 'OL' ? 'insertOrderedList' : 'insertUnorderedList');
          continue;
        }
        const n = this.retag(b, tag);
        n.classList.remove('title', 'subtitle', 'quote', 'caption');
        if (cls) n.classList.add(cls);
        if (!n.className) n.removeAttribute('class');
      }
      this.restoreSelection(sel);
    });
  }

  align(how) {
    this.change('Align', () => {
      for (const b of this.selectedBlocks()) {
        if (how === 'left') b.style.removeProperty('text-align');
        else b.style.textAlign = how;
        if (!b.getAttribute('style')) b.removeAttribute('style');
      }
    });
  }

  blockStyle(prop, value, label) {
    this.change(label, () => {
      for (const b of this.selectedBlocks()) {
        if (value === null || value === '') b.style.removeProperty(prop);
        else b.style.setProperty(prop, value);
        if (!b.getAttribute('style')) b.removeAttribute('style');
      }
    });
  }

  lineSpacing(v) { this.blockStyle('line-height', v ? String(v) : '', 'Line spacing'); }

  indent(dir) {
    const st = this.state();
    if (st.block && st.block.tagName === 'LI') {
      this.change(dir > 0 ? 'Indent' : 'Outdent', () => this.exec(dir > 0 ? 'indent' : 'outdent'));
      return;
    }
    this.change(dir > 0 ? 'Indent' : 'Outdent', () => {
      for (const b of this.selectedBlocks()) {
        const cur = parseFloat(b.style.marginLeft) || 0;
        const next = Math.max(0, cur + dir * 0.5);
        if (next) b.style.marginLeft = `${next}in`;
        else b.style.removeProperty('margin-left');
        if (!b.getAttribute('style')) b.removeAttribute('style');
      }
    });
  }

  list(kind, styleType = null) {
    const st = this.state();
    this.change('List', () => {
      const want = kind === 'ol' ? 'OL' : 'UL';
      const inList = st.block && st.block.tagName === 'LI' ? st.block.parentNode : null;
      if (inList && inList.tagName === want && !styleType && (kind !== 'check') === !inList.classList.contains('checklist')) {
        this.exec(want === 'OL' ? 'insertOrderedList' : 'insertUnorderedList'); // toggle off
        return;
      }
      if (!inList || inList.tagName !== want) this.exec(want === 'OL' ? 'insertOrderedList' : 'insertUnorderedList');
      const r = this.range();
      const li = r && this.blockOf(r.startContainer);
      const list = li && li.closest('ul, ol');
      if (!list) return;
      list.classList.toggle('checklist', kind === 'check');
      if (!list.className) list.removeAttribute('class');
      if (styleType) list.style.listStyleType = styleType;
    });
  }

  link(url, text) {
    this.change('Link', () => {
      const r = this.range();
      if (!r) return;
      const safe = /^(https?:|mailto:|#)/i.test(url) ? url : `https://${url}`;
      if (r.collapsed || text) {
        this.exec('insertHTML', `<a href="${escapeHtml(safe)}">${escapeHtml(text || url)}</a>`);
      } else this.exec('createLink', safe);
      for (const a of this.doc.querySelectorAll('a:not([rel])')) { a.rel = 'noopener noreferrer'; a.target = '_blank'; }
    });
  }

  unlink() {
    this.change('Remove link', () => {
      const st = this.state();
      if (st.link && st.collapsed) {
        const r = document.createRange();
        r.selectNodeContents(st.link);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
      }
      this.exec('unlink');
    });
  }

  insertHTML(html, label = 'Insert') {
    this.change(label, () => this.exec('insertHTML', html));
  }

  insertBlock(html, label = 'Insert') {
    // Put a block after the current one (not inside it).
    this.change(label, () => {
      const r = this.range();
      let b = r ? this.blockOf(r.startContainer) : null;
      while (b && b.parentNode !== this.doc && !(b.parentNode.classList && b.parentNode.classList.contains('col'))) b = b.parentNode;
      const tmp = document.createElement('div');
      tmp.innerHTML = html;
      const nodes = [...tmp.childNodes];
      const after = h('p', h('br'));
      if (b && b.parentNode) {
        const empty = b.textContent.trim() === '' && !b.querySelector('img, table, hr');
        if (empty && b.tagName === 'P') b.replaceWith(...nodes, after);
        else b.after(...nodes, after);
      } else this.doc.append(...nodes, after);
      const nr = document.createRange();
      nr.setStart(after, 0);
      nr.collapse(true);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(nr);
    });
  }

  /** Copy the formatting at the caret (format painter). */
  pickFormat() {
    const r = this.range();
    if (!r) return null;
    let node = r.startContainer.nodeType === 3 ? r.startContainer.parentNode : r.startContainer;
    const cs = getComputedStyle(node);
    return {
      bold: document.queryCommandState('bold'), italic: document.queryCommandState('italic'),
      underline: document.queryCommandState('underline'), strike: document.queryCommandState('strikeThrough'),
      color: cs.color, font: cs.fontFamily, size: cs.fontSize, bg: (node.closest && node.closest('[style*="background"]')) ? cs.backgroundColor : '',
      style: this.state().style,
    };
  }

  applyFormat(f) {
    if (!f) return;
    this.change('Paste formatting', () => {
      this.exec('removeFormat');
      if (f.bold) this.exec('bold');
      if (f.italic) this.exec('italic');
      if (f.underline) this.exec('underline');
      if (f.strike) this.exec('strikeThrough');
      this.exec('foreColor', f.color, true);
      if (f.bg && f.bg !== 'rgba(0, 0, 0, 0)') this.exec('hiliteColor', f.bg, true);
    });
    this.inlineStyle('font-family', f.font, 'Paste formatting');
    this.inlineStyle('font-size', f.size, 'Paste formatting');
  }

  // =========================================================================
  // Document structure
  // =========================================================================
  /** Keep the top level made of blocks, and never empty. */
  normalize() {
    const doc = this.doc;
    let run = null;
    for (const n of [...doc.childNodes]) {
      const block = n.nodeType === 1 && (BLOCK_SET.has(n.tagName) || ['UL', 'OL', 'TABLE', 'HR', 'FIGURE', 'DL'].includes(n.tagName));
      if (block) { run = null; continue; }
      if (n.nodeType === 3 && !n.data.trim() && !run) { n.remove(); continue; }
      if (n.nodeType === 8) { n.remove(); continue; }
      if (!run) {
        run = document.createElement('p');
        n.before(run);
      }
      run.append(n);
    }
    // A paragraph holding a list or table (left by some browser commands) is unwrapped.
    for (const p of doc.querySelectorAll('p')) {
      if ([...p.children].some((c) => ['UL', 'OL', 'TABLE', 'P', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE'].includes(c.tagName))) {
        p.replaceWith(...p.childNodes);
      }
    }
    if (!doc.firstElementChild) doc.append(h('p', h('br')));
    // A table or rule at the very end needs a paragraph after it to type into.
    const last = doc.lastElementChild;
    if (last && ['TABLE', 'HR', 'DIV', 'FIGURE'].includes(last.tagName) && !last.classList.contains('page-break-x')) {
      if (last.tagName !== 'DIV' || last.classList.contains('cols') || last.classList.contains('toc') || last.classList.contains('page-break')) doc.append(h('p', h('br')));
    }
  }

  headings() {
    return [...this.doc.querySelectorAll('h1, h2, h3, h4, p.title')].map((el) => ({
      el, level: el.classList.contains('title') ? 0 : Number(el.tagName[1]), text: el.textContent.trim() || '(empty heading)',
    }));
  }

  // =========================================================================
  // Pages
  // =========================================================================
  pageSize() {
    const p = PAGE_SIZES[this.meta.page.size] || PAGE_SIZES.letter;
    const land = this.meta.page.orientation === 'landscape';
    const w = (land ? p.h : p.w) * PX_PER_IN;
    const hh = (land ? p.w : p.h) * PX_PER_IN;
    const m = this.meta.page.margins;
    return {
      w, h: hh, mt: m.top * PX_PER_IN, mr: m.right * PX_PER_IN, mb: m.bottom * PX_PER_IN, ml: m.left * PX_PER_IN,
      inW: land ? p.h : p.w, inH: land ? p.w : p.h,
    };
  }

  applyPage() {
    const g = this.pageSize();
    const font = this.meta.font ? `"${this.meta.font}", ` : '';
    this.pageStyle.textContent = `
      .word .stack { width: ${g.w}px; }
      .word .doc { width: ${g.w - g.ml - g.mr}px; margin: ${g.mt}px 0 0 ${g.ml}px; min-height: ${g.h - g.mt - g.mb}px;
        font-family: ${font}var(--doc-font); font-size: ${this.meta.fontSize}pt; line-height: ${this.meta.lineHeight}; }
      .word .sheet { width: ${g.w}px; height: ${g.h}px; background: ${this.meta.pageColor}; }
      @page { size: ${g.inW}in ${g.inH}in; background: ${this.meta.pageColor || '#fff'}; margin: ${this.meta.page.margins.top}in ${this.meta.page.margins.right}in ${this.meta.page.margins.bottom}in ${this.meta.page.margins.left}in;
        ${this.printZones()} }
      ${this.meta.firstPageDifferent ? '@page :first { @top-left { content: none } @top-center { content: none } @top-right { content: none } @bottom-left { content: none } @bottom-center { content: none } @bottom-right { content: none } }' : ''}
    `;
    this.layoutSoon();
    this.drawRuler();
  }

  /** Header and footer for printing, as @page margin boxes. */
  printZones() {
    const field = (s) => {
      if (!s) return 'none';
      const parts = String(s).split(/(\{page\}|\{pages\}|\{title\}|\{date\})/);
      return parts.filter(Boolean).map((p) => {
        if (p === '{page}') return 'counter(page)';
        if (p === '{pages}') return 'counter(pages)';
        if (p === '{title}') return JSON.stringify(this.meta.title || '');
        if (p === '{date}') return JSON.stringify(new Date().toLocaleDateString());
        return JSON.stringify(p);
      }).join(' ');
    };
    const zone = (where, side, text) => `@${where}-${side} { content: ${field(text)}; font: 9pt var(--doc-font); color: #555; }`;
    const z = [];
    for (const side of ['left', 'center', 'right']) {
      z.push(zone('top', side, this.meta.header[side]));
      z.push(zone('bottom', side, this.meta.footer[side]));
    }
    return z.join('\n');
  }

  fieldText(s, page) {
    return String(s || '').replace(/\{page\}/g, page).replace(/\{pages\}/g, this.pages)
      .replace(/\{title\}/g, this.meta.title || '').replace(/\{date\}/g, new Date().toLocaleDateString());
  }

  /** Push blocks that would cross a page edge onto the next page, then draw the pages. */
  layout() {
    const g = this.pageSize();
    const stride = g.h + GAP;
    const content = g.h - g.mt - g.mb;
    this.pushSheet.textContent = '';
    const kids = [...this.doc.children];
    const tops = kids.map((k) => k.offsetTop);
    const heights = kids.map((k) => k.offsetHeight);
    const rules = [];
    let shift = 0;
    let forceNext = false;
    let bottom = 0;
    for (let i = 0; i < kids.length; i++) {
      const el = kids[i];
      const top = tops[i] + shift;
      const hgt = heights[i];
      const k = Math.floor(top / stride);
      const within = top - k * stride;
      let target = null;
      if (forceNext && within > 0.5) target = (k + 1) * stride;
      else if (within >= content - 0.5) target = (k + 1) * stride;
      else if (within + hgt > content + 0.5 && hgt <= content && within > 0.5) target = (k + 1) * stride;
      else if (/^H[1-6]$/.test(el.tagName) && i + 1 < kids.length) {
        // Keep a heading with the start of what follows it.
        const nextH = Math.min(heights[i + 1], 48);
        if (within + hgt + nextH > content && within > 0.5 && hgt + nextH < content) target = (k + 1) * stride;
      }
      forceNext = el.classList.contains('page-break');
      if (target !== null) {
        const delta = target - top;
        const gapBefore = i === 0 ? tops[0] : tops[i] - (tops[i - 1] + heights[i - 1]);
        rules.push(`.word .doc > :nth-child(${i + 1}) { margin-top: ${Math.max(0, gapBefore) + delta}px !important; }`);
        shift += delta;
      }
      bottom = top + (target !== null ? target - top : 0) + hgt;
    }
    // Only on screen: printing breaks pages by itself.
    this.pushSheet.textContent = `@media screen {\n${rules.join('\n')}\n}`;
    const pages = Math.max(1, Math.floor(Math.max(0, bottom - 1) / stride) + 1);
    if (pages !== this.pages || this.sheets.childElementCount !== pages || this._sheetKey !== this.sheetKey()) {
      this.pages = pages;
      this.drawSheets();
    }
    this.stack.style.height = `${pages * stride - GAP}px`;
    this.stack.style.zoom = String(this.zoom);
    this.updateOverlay();
    this.onStats({ pages: this.pages, page: this.currentPage() });
  }

  sheetKey() { return JSON.stringify([this.meta.header, this.meta.footer, this.meta.firstPageDifferent, this.meta.title]); }

  drawSheets() {
    const g = this.pageSize();
    this._sheetKey = this.sheetKey();
    this.sheets.replaceChildren();
    for (let i = 0; i < this.pages; i++) {
      const skip = this.meta.firstPageDifferent && i === 0;
      const zone = (z, where) => h(`div.hf.${where}`, { style: { [where === 'head' ? 'top' : 'bottom']: `${Math.max(24, (where === 'head' ? g.mt : g.mb) / 2 - 8)}px`, left: `${g.ml}px`, right: `${g.mr}px` } },
        h('span', skip ? '' : this.fieldText(z.left, i + 1)), h('span', skip ? '' : this.fieldText(z.center, i + 1)), h('span', skip ? '' : this.fieldText(z.right, i + 1)));
      const sheet = h('div.sheet', { style: { top: `${i * (g.h + GAP)}px` }, 'data-page': i + 1 },
        zone(this.meta.header, 'head'), zone(this.meta.footer, 'foot'));
      this.sheets.append(sheet);
    }
  }

  currentPage() {
    const g = this.pageSize();
    const mid = (this.scroller.scrollTop + this.scroller.clientHeight / 3) / this.zoom;
    return clamp(Math.floor(mid / (g.h + GAP)) + 1, 1, this.pages);
  }

  setZoom(z, anchor) {
    const old = this.zoom;
    this.zoom = clamp(Math.round(z * 100) / 100, 0.25, 5);
    this.stack.style.zoom = String(this.zoom);
    keepAnchor(this.scroller, anchor, old, this.zoom);
    this.settings.set('zoom', this.zoom);
    this.drawRuler();
    this.updateOverlay();
    this.onStats({ zoom: this.zoom });
  }

  fitWidth() {
    const g = this.pageSize();
    this.setZoom((this.scroller.clientWidth - 48) / g.w);
  }

  fitPage() {
    const g = this.pageSize();
    this.setZoom(Math.min((this.scroller.clientWidth - 48) / g.w, (this.scroller.clientHeight - 32) / g.h));
  }

  scrollToPage(n) {
    const g = this.pageSize();
    this.scroller.scrollTo({ top: (n - 1) * (g.h + GAP) * this.zoom, behavior: 'smooth' });
  }

  // =========================================================================
  // Ruler: margins, and the current paragraph's indents (draggable)
  // =========================================================================
  drawRuler() {
    if (!this.ruler.isConnected) return;
    const show = this.settings.get('ruler', true);
    this.ruler.classList.toggle('hidden', !show);
    if (!show) return;
    const g = this.pageSize();
    const z = this.zoom;
    const stackLeft = this.stack.getBoundingClientRect().left - this.ruler.getBoundingClientRect().left;
    const metric = this.settings.get('units', 'in') === 'cm';
    const unit = metric ? PX_PER_IN / 2.54 : PX_PER_IN;
    const ticks = metric ? 2 : 8;
    const parts = [];
    parts.push(`<div class="r-page" style="left:${stackLeft}px;width:${g.w * z}px">`);
    parts.push(`<div class="r-margin" style="left:0;width:${g.ml * z}px"></div><div class="r-margin" style="right:0;width:${g.mr * z}px"></div>`);
    const total = g.w / unit;
    for (let i = 0; i <= total * ticks; i++) {
      const x = g.ml * z + ((i / ticks) * unit - 0) * z;
      const xr = x - g.ml * z;
      if (x > g.w * z) break;
      const major = i % ticks === 0;
      const half = !metric && i % (ticks / 2) === 0;
      parts.push(`<i style="left:${x}px;height:${major ? 7 : half ? 5 : 3}px"></i>`);
      if (major && i) parts.push(`<b style="left:${x}px">${i / ticks}</b>`);
      void xr;
    }
    // Negative side (inside the left margin).
    for (let i = 1; i * unit / ticks <= g.ml; i++) {
      const x = g.ml * z - (i / ticks) * unit * z;
      parts.push(`<i style="left:${x}px;height:${i % ticks === 0 ? 7 : 3}px"></i>`);
    }
    const st = this.state();
    const b = st.block;
    if (b && this.doc.contains(b)) {
      const cs = getComputedStyle(b);
      const left = (parseFloat(cs.marginLeft) || 0) + (parseFloat(cs.paddingLeft) || 0) * (b.tagName === 'LI' ? 0 : 0);
      const first = parseFloat(cs.textIndent) || 0;
      const right = parseFloat(cs.marginRight) || 0;
      const docLeft = b.getBoundingClientRect().left - this.doc.getBoundingClientRect().left;
      const base = g.ml * z + docLeft * 1 - left * z;
      parts.push(`<span class="r-ind first" data-k="first" style="left:${base + (left + first) * z}px" title="First line indent"></span>`);
      parts.push(`<span class="r-ind left" data-k="left" style="left:${base + left * z}px" title="Left indent"></span>`);
      parts.push(`<span class="r-ind right" data-k="right" style="left:${(g.w - g.mr - right) * z}px" title="Right indent"></span>`);
    }
    parts.push('</div>');
    this.ruler.innerHTML = parts.join('');
    for (const m of this.ruler.querySelectorAll('.r-ind')) {
      m.addEventListener('pointerdown', (e) => this.dragIndent(e, m.dataset.k));
    }
  }

  dragIndent(e, kind) {
    e.preventDefault();
    const blocks = this.selectedBlocks();
    if (!blocks.length) return;
    const b0 = blocks[0];
    const cs = getComputedStyle(b0);
    const start = {
      left: parseFloat(cs.marginLeft) || 0, first: parseFloat(cs.textIndent) || 0, right: parseFloat(cs.marginRight) || 0,
    };
    const snap = (px) => Math.round(px / (PX_PER_IN / 16)) * (PX_PER_IN / 16); // sixteenths of an inch
    drag(e, (dx) => {
      const d = dx / this.zoom;
      for (const b of blocks) {
        if (kind === 'left') {
          b.style.marginLeft = `${Math.max(0, snap(start.left + d))}px`;
        } else if (kind === 'first') {
          b.style.textIndent = `${snap(start.first + d)}px`;
        } else {
          b.style.marginRight = `${Math.max(0, snap(start.right - d))}px`;
        }
      }
      this.drawRuler();
    }, () => {
      this.commit('Indent');
      this.layoutSoon();
    });
  }

  // =========================================================================
  // Events: typing rules, paste, keys, clicks
  // =========================================================================
  bindEvents() {
    const doc = this.doc;
    doc.addEventListener('input', (e) => {
      if (e.inputType === 'historyUndo' || e.inputType === 'historyRedo') return;
      this.typing = true;
      this.commitTypingSoon();
      this.layoutSoon();
      this.statsSoon();
      if (e.inputType === 'insertText' && e.data) this.afterTyping(e.data);
      this.onChange();
    });
    doc.addEventListener('beforeinput', (e) => {
      if (e.inputType === 'historyUndo') { e.preventDefault(); this.undo(); return; }
      if (e.inputType === 'historyRedo') { e.preventDefault(); this.redo(); return; }
      if (e.inputType === 'insertText' && this.pendingStyle) {
        // Formatting chosen with nothing selected applies to what is typed next.
        const { prop, value } = this.pendingStyle;
        this.pendingStyle = null;
        e.preventDefault();
        const span = document.createElement('span');
        span.style.setProperty(prop, value);
        span.textContent = e.data;
        const r = this.range();
        r.insertNode(span);
        const nr = document.createRange();
        nr.setStart(span.firstChild, span.firstChild.length);
        nr.collapse(true);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(nr);
        this.typing = true;
        this.commitTypingSoon();
        return;
      }
      if (e.inputType === 'insertText' && (e.data === '"' || e.data === "'") && this.settings.get('smartQuotes', true)) {
        const r = this.range();
        if (r && r.collapsed) {
          const before = this.textBefore(r, 1);
          const open = !before || /[\s([{—–-]/.test(before);
          const q = e.data === '"' ? (open ? '“' : '”') : (open ? '‘' : '’');
          e.preventDefault();
          document.execCommand('insertText', false, q);
        }
      }
    });
    doc.addEventListener('keydown', (e) => this.keydown(e));
    doc.addEventListener('paste', (e) => this.paste(e));
    doc.addEventListener('copy', (e) => this.copy(e, false));
    doc.addEventListener('cut', (e) => this.copy(e, true));
    doc.addEventListener('drop', (e) => this.dropInside(e));
    doc.addEventListener('click', (e) => this.click(e));
    doc.addEventListener('mousedown', (e) => this.mousedown(e));
    doc.addEventListener('mousemove', (e) => this.hoverTableEdge(e));
    doc.addEventListener('dblclick', (e) => {
      const img = e.target.closest && e.target.closest('img');
      if (img) this.onImageDblClick && this.onImageDblClick(img);
    });
    document.addEventListener('selectionchange', () => {
      if (!this.range()) return;
      this.selectionChanged();
    });
    this.scroller.addEventListener('scroll', () => {
      this.drawRulerSoon();
      this.updateOverlay();
      this.onStats({ page: this.currentPage() });
    });
    this.drawRulerSoon = rafOnce(() => this.drawRuler());
    this.sheets.addEventListener('dblclick', (e) => {
      if (e.target.closest('.hf')) this.onEditHeader && this.onEditHeader(e.target.closest('.hf').classList.contains('head') ? 'header' : 'footer');
    });
    this.scroller.addEventListener('mousedown', (e) => {
      // A click on the grey around the pages, or in a page margin, puts the caret at the nearest spot.
      if (e.target === this.scroller || e.target === this.stack || e.target.closest('.sheet')) {
        if (e.target.closest('.hf')) return;
        e.preventDefault();
        this.focus();
        const r = document.caretRangeFromPoint(clamp(e.clientX, this.doc.getBoundingClientRect().left + 2, this.doc.getBoundingClientRect().right - 2), e.clientY);
        if (r && this.doc.contains(r.startContainer)) {
          window.getSelection().removeAllRanges();
          window.getSelection().addRange(r);
        }
      }
    });
  }

  selectionChanged() {
    const img = this.selectedImage;
    const r = this.range();
    if (img && r && !(r.startContainer === img.parentNode && r.endOffset - r.startOffset === 1)) {
      // keep the picture selected only while it is the selection
    }
    this.drawRulerSoon();
    this.onSelection();
    if (this.settings.get('typewriter', false)) this.typewriterScroll();
    if (this.settings.get('focusMode', false)) this.markFocus();
  }

  textBefore(r, n) {
    const node = r.startContainer;
    if (node.nodeType === 3) return node.data.slice(Math.max(0, r.startOffset - n), r.startOffset);
    return '';
  }

  /** Markdown shortcuts and autocorrect, after a character is typed. */
  afterTyping(ch) {
    const r = this.range();
    if (!r || !r.collapsed || r.startContainer.nodeType !== 3) return;
    const node = r.startContainer;
    const off = r.startOffset;
    const block = this.blockOf(node);
    if (!block) return;
    const md = this.settings.get('markdown', true);
    const auto = this.settings.get('autocorrect', true);

    if (ch === '/' && this.settings.get('slashMenu', true)) {
      const before = node.data.slice(0, off - 1);
      const blockText = block.textContent;
      if ((blockText === '/' || /\s$/.test(before) || before === '') && block.tagName !== 'PRE') {
        this.openSlashMenu(node, off);
        return;
      }
    }

    if (ch === ' ' && md && block.tagName !== 'PRE') {
      // Text from the block start to the caret.
      const pre = document.createRange();
      pre.setStart(block, 0);
      pre.setEnd(node, off);
      const head = pre.toString();
      const rules = [
        [/^(#{1,6}) $/, (m) => this.blockRule(block, pre, `Heading ${m[1].length}`)],
        [/^[-*+] $/, () => this.listRule(pre, 'ul')],
        [/^1[.)] $/, () => this.listRule(pre, 'ol')],
        [/^\[[ xX]?\] $/, (m) => this.listRule(pre, 'check', /x/i.test(m[0]))],
        [/^> $/, () => this.blockRule(block, pre, 'Quote')],
      ];
      for (const [re, fn] of rules) {
        const m = re.exec(head);
        if (m && block.tagName !== 'LI') { fn(m); return; }
      }
    }
    if (md && (ch === '*' || ch === '_' || ch === '`' || ch === '~')) {
      const text = node.data.slice(0, off);
      const pats = [
        [/\*\*([^*\s][^*]*?)\*\*$/, 'bold'], [/__([^_\s][^_]*?)__$/, 'bold'],
        [/(?:^|[^*])\*([^*\s][^*]*?)\*$/, 'italic'], [/(?:^|[^_\w])_([^_\s][^_]*?)_$/, 'italic'],
        [/~~([^~\s][^~]*?)~~$/, 'strikeThrough'], [/`([^`]+)`$/, 'code'],
      ];
      for (const [re, kind] of pats) {
        const m = re.exec(text);
        if (!m) continue;
        const whole = m[0].replace(/^[^*_~`]/, '');
        const start = off - whole.length;
        this.inlineRule(node, start, off, m[1], kind);
        return;
      }
    }
    if (auto && /[\s.,;:!?)]/.test(ch)) {
      const text = node.data.slice(0, off - 1);
      const reps = [
        [/\(c\)$/i, '©'], [/\(r\)$/i, '®'], [/\(tm\)$/i, '™'], [/->$/, '→'], [/<-$/, '←'], [/=>$/, '⇒'], [/<=>$/, '⇔'],
        [/(\w|\s)--$/, (m) => `${m[1]}—`], [/\.\.\.$/, '…'], [/(^|\s)1\/2$/, (m) => `${m[1]}½`], [/(^|\s)1\/4$/, (m) => `${m[1]}¼`],
        [/(^|\s)3\/4$/, (m) => `${m[1]}¾`], [/!=$/, '≠'], [/\+-$/, '±'], [/<3$/, '♥'],
      ];
      for (const [re, rep] of reps) {
        const m = re.exec(text);
        if (!m) continue;
        const out = typeof rep === 'function' ? rep(m) : rep;
        const rr = document.createRange();
        rr.setStart(node, m.index);
        rr.setEnd(node, off - 1);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(rr);
        document.execCommand('insertText', false, out);
        // put the typed character back after the replacement (it is still in the node)
        this.commit('AutoCorrect');
        return;
      }
    }
    if (ch === '-' && md) {
      const t = block.textContent;
      if ((t === '---' || t === '***' || t === '___') && block.tagName === 'P') {
        this.change('Line', () => {
          const hr = h('hr');
          const p = h('p', h('br'));
          block.replaceWith(hr, p);
          const nr = document.createRange();
          nr.setStart(p, 0);
          window.getSelection().removeAllRanges();
          window.getSelection().addRange(nr);
        });
      }
    }
    if (ch === '`' && md && block.textContent === '```' && block.tagName === 'P') {
      this.change('Code block', () => {
        const pre = h('pre', h('br'));
        block.replaceWith(pre);
        const nr = document.createRange();
        nr.setStart(pre, 0);
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(nr);
      });
    }
  }

  deleteRange(pre) {
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(pre);
    document.execCommand('delete');
  }

  blockRule(block, pre, style) {
    this.commit('Typing');
    this.deleteRange(pre);
    this.setStyle(style);
  }

  listRule(pre, kind, checked = false) {
    // Turn the paragraph into a list item directly: the browser's list command
    // nests the list inside an emptied paragraph.
    this.commit('Typing');
    const block = this.blockOf(pre.startContainer);
    if (!block) return;
    this.change('List', () => {
      pre.deleteContents();
      const list = document.createElement(kind === 'ol' ? 'ol' : 'ul');
      if (kind === 'check') list.className = 'checklist';
      const li = document.createElement('li');
      if (kind === 'check') li.dataset.checked = checked ? 'true' : 'false';
      while (block.firstChild) li.append(block.firstChild);
      if (!li.textContent && !li.querySelector('br')) li.append(document.createElement('br'));
      list.append(li);
      // Join a list of the same kind just above.
      const prev = block.previousElementSibling;
      if (prev && prev.tagName === list.tagName && prev.className === list.className) {
        prev.append(li);
        block.remove();
      } else block.replaceWith(list);
      const r = document.createRange();
      r.setStart(li, 0);
      r.collapse(true);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(r);
    });
  }

  inlineRule(node, start, end, inner, kind) {
    this.commit('Typing');
    this.change('Format', () => {
      const rr = document.createRange();
      rr.setStart(node, start);
      rr.setEnd(node, end);
      const el = kind === 'code' ? h('code', inner) : kind === 'bold' ? h('b', inner) : kind === 'italic' ? h('i', inner) : h('s', inner);
      rr.deleteContents();
      rr.insertNode(el);
      // continue typing after the formatted word, unformatted
      const after = document.createTextNode('​');
      el.after(after);
      const nr = document.createRange();
      nr.setStart(after, 1);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(nr);
    });
  }

  keydown(e) {
    const r = this.range();
    if (!r) return;
    // Tab: next table cell, list level, or a tab character.
    if (e.key === 'Tab' && !e.ctrlKey && !e.altKey && !e.metaKey) {
      const cell = (r.startContainer.nodeType === 3 ? r.startContainer.parentNode : r.startContainer).closest('td, th');
      if (cell && this.doc.contains(cell)) {
        e.preventDefault();
        this.moveCell(cell, e.shiftKey ? -1 : 1);
        return;
      }
      const b = this.blockOf(r.startContainer);
      if (b && b.tagName === 'LI') {
        e.preventDefault();
        this.indent(e.shiftKey ? -1 : 1);
        return;
      }
      e.preventDefault();
      if (!e.shiftKey) document.execCommand('insertText', false, '\t');
      return;
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      const b = this.blockOf(r.startContainer);
      // Enter on an empty checklist/list item ends the list (the browser does this for plain lists).
      if (b && /^H[1-6]$/.test(b.tagName) && r.collapsed) {
        const after = document.createRange();
        after.selectNodeContents(b);
        after.setStart(r.endContainer, r.endOffset);
        if (!after.toString()) {
          // Enter at the end of a heading starts a normal paragraph.
          e.preventDefault();
          this.change('New paragraph', () => {
            const p = h('p', h('br'));
            b.after(p);
            const nr = document.createRange();
            nr.setStart(p, 0);
            window.getSelection().removeAllRanges();
            window.getSelection().addRange(nr);
          });
          return;
        }
      }
      if (b && b.classList && (b.classList.contains('title') || b.classList.contains('subtitle'))) {
        e.preventDefault();
        this.change('New paragraph', () => {
          const p = h('p', h('br'));
          b.after(p);
          const nr = document.createRange();
          nr.setStart(p, 0);
          window.getSelection().removeAllRanges();
          window.getSelection().addRange(nr);
        });
        return;
      }
      if (this.typing) this.commit('Typing');
    }
    if (e.key === 'Enter' && e.ctrlKey) {
      e.preventDefault();
      this.insertPageBreak();
      return;
    }
    if ((e.key === 'Backspace' || e.key === 'Delete') && this.selectedImage) {
      e.preventDefault();
      const img = this.selectedImage;
      this.change('Delete picture', () => img.remove());
      this.selectImage(null);
      return;
    }
    if (e.key === 'Backspace' && r.collapsed) {
      const b = this.blockOf(r.startContainer);
      // Backspace at the start of a styled paragraph turns it back into normal text first.
      if (b && b.tagName !== 'P' && b.tagName !== 'LI' && b.tagName !== 'TD' && b.tagName !== 'TH' && this.atBlockStart(r, b)) {
        e.preventDefault();
        this.setStyle('Normal');
        return;
      }
      if (b && b.tagName === 'P' && b.className && this.atBlockStart(r, b)) {
        e.preventDefault();
        this.setStyle('Normal');
        return;
      }
    }
    if (e.key === ' ' || e.key === 'Enter' || e.key === '.' || e.key === ',') {
      if (this.typing && e.key !== ' ') this.commit('Typing');
    }
  }

  atBlockStart(r, block) {
    const pre = document.createRange();
    pre.setStart(block, 0);
    pre.setEnd(r.startContainer, r.startOffset);
    return pre.toString().replace(/​/g, '') === '';
  }

  insertPageBreak() {
    this.insertBlock('<div class="page-break" contenteditable="false"></div>', 'Page break');
  }

  click(e) {
    const t = e.target;
    // Checklist boxes.
    if (t.tagName === 'LI' && t.parentNode.classList.contains('checklist')) {
      const rect = t.getBoundingClientRect();
      if (e.clientX < rect.left + 4 * this.zoom) {
        this.change('Check', () => { t.dataset.checked = t.dataset.checked === 'true' ? 'false' : 'true'; });
        e.preventDefault();
        return;
      }
    }
    const a = t.closest && t.closest('a');
    if (a && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      const href = a.getAttribute('href') || '';
      if (href.startsWith('#')) {
        const target = this.doc.querySelector(href.replace(/[^#\w-]/g, ''));
        if (target) target.scrollIntoView({ block: 'center' });
      } else this.onOpenLink && this.onOpenLink(href);
      return;
    }
    if (t.tagName === 'IMG') {
      this.selectImage(t);
      return;
    }
    if (this.selectedImage && !(t.closest && t.closest('.img-tools'))) this.selectImage(null);
  }

  mousedown(e) {
    // Checklist boxes sit left of the text: keep the caret out of them.
    const t = e.target;
    if (t.tagName === 'LI' && t.parentNode.classList.contains('checklist')) {
      const rect = t.getBoundingClientRect();
      if (e.clientX < rect.left + 4 * this.zoom) e.preventDefault();
    }
    if (t.tagName === 'IMG') {
      e.preventDefault();
      this.selectImage(t);
    }
    if (this.colDrag) this.startColumnDrag(e);
    this.startCellSelect(e);
  }

  // ---- copying and pasting ----
  copy(e, cut) {
    const r = this.range();
    if (!r || r.collapsed) return;
    const box = h('div');
    box.append(r.cloneContents());
    for (const el of box.querySelectorAll('.cell-sel')) el.classList.remove('cell-sel');
    e.clipboardData.setData('text/html', box.innerHTML);
    e.clipboardData.setData('text/plain', this.plainText(box));
    e.preventDefault();
    if (cut) this.change('Cut', () => document.execCommand('delete'));
  }

  plainText(root) {
    const out = [];
    const walk = (n) => {
      if (n.nodeType === 3) { out.push(n.data.replace(/​/g, '')); return; }
      if (n.nodeType !== 1) return;
      if (n.tagName === 'BR') { out.push('\n'); return; }
      const block = BLOCK_SET.has(n.tagName) || ['TR', 'UL', 'OL', 'TABLE'].includes(n.tagName);
      if (n.tagName === 'LI') out.push(n.parentNode && n.parentNode.tagName === 'OL' ? `${[...n.parentNode.children].indexOf(n) + 1}. ` : '• ');
      for (const c of n.childNodes) walk(c);
      if (n.tagName === 'TD' || n.tagName === 'TH') out.push('\t');
      else if (block) out.push('\n');
    };
    for (const c of root.childNodes) walk(c);
    return out.join('').replace(/\t\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  }

  async paste(e, { plain = false, markdown = false } = {}) {
    const cd = e.clipboardData;
    if (!cd) return;
    const files = [...cd.files].filter((f) => f.type.startsWith('image/'));
    if (files.length && !plain) {
      e.preventDefault();
      for (const f of files) await this.insertImageFile(f);
      return;
    }
    const html = cd.getData('text/html');
    const text = cd.getData('text/plain');
    e.preventDefault();
    if (this.typing) this.commit('Typing');
    if (markdown && this.markdownToHtml) {
      this.insertHTML(this.cleanPasted(this.markdownToHtml(text)), 'Paste');
      return;
    }
    if (html && !plain) {
      this.insertHTML(this.cleanPasted(html), 'Paste');
      return;
    }
    if (text) {
      const lines = text.replace(/\r\n?/g, '\n').split('\n');
      if (lines.length === 1) this.change('Paste', () => document.execCommand('insertText', false, text));
      else this.insertHTML(lines.map((l) => `<p>${escapeHtml(l) || '<br>'}</p>`).join(''), 'Paste');
    }
  }

  /** Pasted HTML, sanitised and with whitespace from the source markup collapsed. */
  cleanPasted(html) {
    const frag = sanitizeHtml(html.replace(/<!--StartFragment-->|<!--EndFragment-->/g, ''), { keepClasses: DOC_CLASSES });
    const walker = document.createTreeWalker(frag, NodeFilter.SHOW_TEXT);
    const texts = [];
    while (walker.nextNode()) texts.push(walker.currentNode);
    for (const t of texts) {
      if (t.parentNode && t.parentNode.closest && t.parentNode.closest('pre')) continue;
      t.data = t.data.replace(/[\r\n\t ]+/g, ' ');
      if (!t.data.trim() && t.parentNode && ['TABLE', 'TBODY', 'THEAD', 'TR', 'UL', 'OL'].includes(t.parentNode.nodeName)) t.remove();
    }
    // Pasted pages tend to bring fixed widths and huge margins; fit them to the page.
    for (const el of frag.querySelectorAll('[style]')) {
      el.style.removeProperty('width');
      el.style.removeProperty('height');
      if (el.tagName !== 'IMG') { el.style.removeProperty('margin'); el.style.removeProperty('padding'); }
      if (!el.getAttribute('style')) el.removeAttribute('style');
    }
    for (const img of frag.querySelectorAll('img')) img.removeAttribute('height');
    const box = h('div');
    box.append(frag);
    return box.innerHTML;
  }

  async dropInside(e) {
    const files = [...(e.dataTransfer && e.dataTransfer.files || [])].filter((f) => f.type.startsWith('image/'));
    if (!files.length) return;
    e.preventDefault();
    e.stopPropagation();
    const r = document.caretRangeFromPoint(e.clientX, e.clientY);
    if (r) {
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(r);
    }
    for (const f of files) await this.insertImageFile(f);
  }

  // =========================================================================
  // Pictures
  // =========================================================================
  async insertImageFile(file) {
    const url = await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = () => reject(fr.error);
      fr.readAsDataURL(file);
    });
    this.insertImageUrl(url, file.name || 'Picture');
  }

  insertImageUrl(url, alt = '') {
    const img = new Image();
    img.onload = () => {
      const g = this.pageSize();
      const maxW = g.w - g.ml - g.mr;
      const w = Math.min(img.naturalWidth, maxW);
      this.insertHTML(`<img src="${url}" alt="${escapeHtml(alt)}" width="${Math.round(w)}">`, 'Insert picture');
    };
    img.src = url;
  }

  selectImage(img) {
    if (this.selectedImage === img) return;
    this.selectedImage = img;
    this.updateOverlay();
    this.onSelection();
  }

  imageStyle(kind) {
    const img = this.selectedImage;
    if (!img) return;
    this.change('Picture layout', () => {
      img.classList.remove('img-left', 'img-right', 'img-center');
      if (kind !== 'inline') img.classList.add(`img-${kind}`);
      if (!img.className) img.removeAttribute('class');
    });
  }

  imageToggle(cls) {
    const img = this.selectedImage;
    if (!img) return;
    this.change('Picture style', () => { img.classList.toggle(cls); if (!img.className) img.removeAttribute('class'); });
  }

  imageSize(fraction) {
    const img = this.selectedImage;
    if (!img) return;
    const g = this.pageSize();
    this.change('Picture size', () => {
      if (fraction === 0) img.width = Math.min(img.naturalWidth, g.w - g.ml - g.mr);
      else img.width = Math.round((g.w - g.ml - g.mr) * fraction);
      img.removeAttribute('height');
    });
  }

  rotateImage(deg) {
    const img = this.selectedImage;
    if (!img) return;
    const c = document.createElement('canvas');
    const swap = Math.abs(deg) === 90;
    c.width = swap ? img.naturalHeight : img.naturalWidth;
    c.height = swap ? img.naturalWidth : img.naturalHeight;
    const ctx = c.getContext('2d');
    ctx.translate(c.width / 2, c.height / 2);
    ctx.rotate((deg * Math.PI) / 180);
    ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
    const w = img.width;
    const hh = img.height;
    this.change('Rotate picture', () => {
      img.src = c.toDataURL(img.src.startsWith('data:image/jpeg') ? 'image/jpeg' : 'image/png', 0.92);
      if (swap) img.width = Math.round(hh || w);
    });
    setTimeout(() => this.updateOverlay(), 50);
  }

  updateOverlay() {
    const img = this.selectedImage;
    this.overlay.replaceChildren();
    if (!img || !this.doc.contains(img)) { this.selectedImage = null; return; }
    const sr = this.stack.getBoundingClientRect();
    const ir = img.getBoundingClientRect();
    const z = this.zoom;
    const box = h('div.img-box', { style: {
      left: `${(ir.left - sr.left) / z}px`, top: `${(ir.top - sr.top) / z}px`, width: `${ir.width / z}px`, height: `${ir.height / z}px`,
    } });
    for (const pos of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
      const hd = h(`span.hd.${pos}`);
      hd.addEventListener('pointerdown', (e) => this.resizeImage(e, img, pos));
      box.append(hd);
    }
    box.append(h('span.size-tag', `${Math.round(img.width)} × ${Math.round(img.height)}`));
    this.overlay.append(box);
  }

  resizeImage(e, img, pos) {
    e.preventDefault();
    e.stopPropagation();
    const w0 = img.width;
    const h0 = img.height;
    const ratio = h0 / w0;
    const g = this.pageSize();
    const maxW = g.w - g.ml - g.mr;
    drag(e, (dx, dy, ev) => {
      let dw = /e/.test(pos) ? dx : /w/.test(pos) ? -dx : 0;
      const dh = /s/.test(pos) ? dy : /n/.test(pos) ? -dy : 0;
      if (!dw && dh) dw = dh / ratio;
      let w = clamp(w0 + dw / this.zoom, 16, maxW);
      if (ev.shiftKey && (pos.length === 1)) {
        // Shift on a side handle stretches without keeping the shape.
        img.width = Math.round(/[ew]/.test(pos) ? w : w0);
        img.height = Math.round(/[ns]/.test(pos) ? clamp(h0 + dh / this.zoom, 16, 4000) : h0);
      } else {
        img.width = Math.round(w);
        img.removeAttribute('height');
      }
      this.updateOverlay();
    }, () => {
      this.commit('Resize picture');
      this.layoutSoon();
    });
  }

  // =========================================================================
  // Tables
  // =========================================================================
  insertTable(rows, cols, cls = 'tbl-grid') {
    const g = this.pageSize();
    const colW = Math.floor((g.w - g.ml - g.mr) / cols);
    const head = `<colgroup>${'<col>'.repeat(cols).replace(/<col>/g, `<col style="width:${colW}px">`)}</colgroup>`;
    const body = Array.from({ length: rows }, () => `<tr>${'<td><br></td>'.repeat(cols)}</tr>`).join('');
    this.insertBlock(`<table class="${cls}">${head}<tbody>${body}</tbody></table>`, 'Insert table');
    const r = this.range();
    const table = r && r.startContainer.previousElementSibling;
    const firstCell = table && table.querySelector && table.querySelector('td');
    if (firstCell) this.caretIn(firstCell);
  }

  caretIn(el, end = false) {
    const r = document.createRange();
    r.selectNodeContents(el);
    r.collapse(!end);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(r);
  }

  /** Rows of a table as a grid of cells (spans repeat the cell). */
  grid(table) {
    const rows = [...table.rows];
    const grid = rows.map(() => []);
    rows.forEach((tr, ri) => {
      let ci = 0;
      for (const cell of tr.cells) {
        while (grid[ri][ci]) ci++;
        for (let dr = 0; dr < (cell.rowSpan || 1); dr++) {
          for (let dc = 0; dc < (cell.colSpan || 1); dc++) {
            if (grid[ri + dr]) grid[ri + dr][ci + dc] = cell;
          }
        }
        ci += cell.colSpan || 1;
      }
    });
    return grid;
  }

  cellPos(cell) {
    const table = cell.closest('table');
    const grid = this.grid(table);
    for (let r = 0; r < grid.length; r++) {
      const c = grid[r].indexOf(cell);
      if (c >= 0) return { table, grid, row: r, col: c };
    }
    return null;
  }

  moveCell(cell, dir) {
    const p = this.cellPos(cell);
    if (!p) return;
    const flat = [];
    p.grid.forEach((row) => row.forEach((c) => { if (!flat.includes(c)) flat.push(c); }));
    const i = flat.indexOf(cell) + dir;
    if (i >= flat.length) {
      this.tableOp('rowBelow');
      const rows = p.table.rows;
      this.caretIn(rows[rows.length - 1].cells[0]);
      return;
    }
    if (i < 0) return;
    const r = document.createRange();
    r.selectNodeContents(flat[i]);
    window.getSelection().removeAllRanges();
    window.getSelection().addRange(r);
  }

  currentCell() {
    const sel = this.doc.querySelectorAll('.cell-sel');
    if (sel.length) return sel[0];
    const r = this.range();
    if (!r) return null;
    const n = r.startContainer.nodeType === 3 ? r.startContainer.parentNode : r.startContainer;
    return n.closest ? n.closest('td, th') : null;
  }

  tableOp(op, arg) {
    const cell = this.currentCell();
    if (!cell || !this.doc.contains(cell)) return;
    const p = this.cellPos(cell);
    if (!p) return;
    const { table, grid, row, col } = p;
    const width = grid[0].length;
    const newCell = (tag = 'td') => h(tag, h('br'));
    this.change('Table', () => {
      switch (op) {
        case 'rowAbove': case 'rowBelow': {
          const at = op === 'rowAbove' ? row : row + (cell.rowSpan || 1) - 1;
          const ref = table.rows[at];
          const tr = h('tr');
          for (let c = 0; c < width; c++) tr.append(newCell(ref.cells[0] && ref.cells[0].tagName === 'TH' && op === 'rowAbove' ? 'th' : 'td'));
          if (op === 'rowAbove') ref.before(tr); else ref.after(tr);
          break;
        }
        case 'colLeft': case 'colRight': {
          const at = op === 'colLeft' ? col : col + (cell.colSpan || 1);
          grid.forEach((rowCells, ri) => {
            const tr = table.rows[ri];
            const ref = rowCells[at];
            const c = newCell(rowCells[0] && rowCells[0].tagName === 'TH' ? 'th' : 'td');
            if (ref && ref.parentNode === tr) ref.before(c);
            else tr.append(c);
          });
          const cg = table.querySelector('colgroup');
          if (cg) {
            const cols = cg.children;
            const ref = cols[Math.min(at, cols.length - 1)];
            const nc = h('col', { style: { width: ref ? ref.style.width : '' } });
            if (at >= cols.length) cg.append(nc); else cols[at].before(nc);
            this.fitColumns(table);
          }
          break;
        }
        case 'deleteRow': {
          if (table.rows.length <= 1) { table.remove(); break; }
          table.rows[row].remove();
          break;
        }
        case 'deleteCol': {
          if (width <= 1) { table.remove(); break; }
          const seen = new Set();
          grid.forEach((rowCells) => {
            const c = rowCells[col];
            if (!c || seen.has(c)) return;
            seen.add(c);
            if ((c.colSpan || 1) > 1) c.colSpan -= 1; else c.remove();
          });
          const cg = table.querySelector('colgroup');
          if (cg && cg.children[col]) { cg.children[col].remove(); this.fitColumns(table); }
          break;
        }
        case 'deleteTable': table.remove(); break;
        case 'merge': this.mergeCells(table, grid); break;
        case 'split': {
          const cs = cell.colSpan || 1;
          const rs = cell.rowSpan || 1;
          if (cs === 1 && rs === 1) break;
          cell.colSpan = 1;
          cell.rowSpan = 1;
          for (let dr = 0; dr < rs; dr++) {
            const tr = table.rows[row + dr];
            for (let dc = dr === 0 ? 1 : 0; dc < cs; dc++) {
              const after = grid[row + dr][col + dc + 1];
              const c = newCell(cell.tagName.toLowerCase());
              if (dr === 0) cell.after(c);
              else if (after && after.parentNode === tr && after !== cell) after.before(c);
              else tr.append(c);
            }
          }
          break;
        }
        case 'header': {
          const first = table.rows[0];
          const isHead = first.cells[0] && first.cells[0].tagName === 'TH';
          for (const c of [...first.cells]) this.retag(c, isHead ? 'TD' : 'TH');
          break;
        }
        case 'shade': {
          const cells = this.doc.querySelectorAll('.cell-sel');
          for (const c of cells.length ? cells : [cell]) {
            if (arg === 'none') c.style.removeProperty('background-color'); else c.style.backgroundColor = arg;
            if (!c.getAttribute('style')) c.removeAttribute('style');
          }
          break;
        }
        case 'style': {
          table.classList.remove('tbl-plain', 'tbl-grid', 'tbl-rows', 'tbl-green', 'tbl-grey', 'tbl-dark');
          table.classList.add(arg);
          break;
        }
        case 'valign': {
          const cells = this.doc.querySelectorAll('.cell-sel');
          for (const c of cells.length ? cells : [cell]) c.style.verticalAlign = arg;
          break;
        }
        case 'distribute': {
          const cg = table.querySelector('colgroup');
          if (cg) for (const c of cg.children) c.style.width = `${Math.floor(table.offsetWidth / cg.children.length)}px`;
          break;
        }
        default: break;
      }
    });
    this.clearCellSelection();
  }

  fitColumns(table) {
    const cg = table.querySelector('colgroup');
    if (!cg) return;
    const total = this.doc.clientWidth;
    const widths = [...cg.children].map((c) => parseFloat(c.style.width) || total / cg.children.length);
    const sum = widths.reduce((a, b) => a + b, 0);
    [...cg.children].forEach((c, i) => { c.style.width = `${Math.floor((widths[i] / sum) * total)}px`; });
  }

  mergeCells(table, grid) {
    const sel = [...this.doc.querySelectorAll('.cell-sel')].filter((c) => c.closest('table') === table);
    if (sel.length < 2) return;
    let r0 = Infinity; let c0 = Infinity; let r1 = -1; let c1 = -1;
    grid.forEach((row, ri) => row.forEach((c, ci) => {
      if (sel.includes(c)) { r0 = Math.min(r0, ri); c0 = Math.min(c0, ci); r1 = Math.max(r1, ri); c1 = Math.max(c1, ci); }
    }));
    const keep = grid[r0][c0];
    const seen = new Set([keep]);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const cell = grid[r][c];
        if (!cell || seen.has(cell)) continue;
        seen.add(cell);
        if (cell.textContent.trim()) {
          keep.append(h('br'));
          while (cell.firstChild) keep.append(cell.firstChild);
        }
        cell.remove();
      }
    }
    keep.colSpan = c1 - c0 + 1;
    keep.rowSpan = r1 - r0 + 1;
    for (const tr of [...table.rows]) if (!tr.cells.length) tr.remove();
  }

  // Selecting several cells by dragging across them.
  startCellSelect(e) {
    const cell = e.target.closest && e.target.closest('td, th');
    this.clearCellSelection();
    if (!cell || e.button !== 0) return;
    const table = cell.closest('table');
    const move = (ev) => {
      const over = document.elementFromPoint(ev.clientX, ev.clientY);
      const other = over && over.closest && over.closest('td, th');
      if (!other || other === cell || other.closest('table') !== table) {
        if (other === cell) this.clearCellSelection();
        return;
      }
      const grid = this.grid(table);
      const a = this.cellPos(cell);
      const b = this.cellPos(other);
      if (!a || !b) return;
      const r0 = Math.min(a.row, b.row); const r1 = Math.max(a.row, b.row);
      const c0 = Math.min(a.col, b.col); const c1 = Math.max(a.col, b.col);
      this.clearCellSelection();
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (grid[r][c]) grid[r][c].classList.add('cell-sel');
      window.getSelection().collapse(other, 0);
    };
    const up = () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
      this.onSelection();
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
  }

  clearCellSelection() {
    for (const c of this.doc.querySelectorAll('.cell-sel')) {
      c.classList.remove('cell-sel');
      if (!c.className) c.removeAttribute('class');
    }
  }

  // Dragging a column border to resize it.
  hoverTableEdge(e) {
    const cell = e.target.closest && e.target.closest('td, th');
    this.colDrag = null;
    if (!cell) { this.doc.style.cursor = ''; return; }
    const r = cell.getBoundingClientRect();
    const near = Math.abs(e.clientX - r.right) < 5 * Math.max(1, this.zoom);
    if (near && cell.nextElementSibling) {
      this.colDrag = cell;
      this.doc.style.cursor = 'col-resize';
    } else this.doc.style.cursor = '';
  }

  startColumnDrag(e) {
    const cell = this.colDrag;
    if (!cell) return;
    e.preventDefault();
    const p = this.cellPos(cell);
    const table = p.table;
    let cg = table.querySelector('colgroup');
    const width = p.grid[0].length;
    if (!cg) {
      cg = h('colgroup', ...Array.from({ length: width }, () => h('col')));
      table.prepend(cg);
    }
    const firstRow = p.grid[0];
    [...cg.children].forEach((c, i) => {
      const ref = firstRow[i];
      if (!c.style.width && ref) c.style.width = `${ref.getBoundingClientRect().width / this.zoom / (ref.colSpan || 1)}px`;
    });
    const i = p.col + (cell.colSpan || 1) - 1;
    const a = cg.children[i];
    const b = cg.children[i + 1];
    if (!a || !b) return;
    const wa = parseFloat(a.style.width);
    const wb = parseFloat(b.style.width);
    drag(e, (dx) => {
      const d = clamp(dx / this.zoom, -wa + 24, wb - 24);
      a.style.width = `${wa + d}px`;
      b.style.width = `${wb - d}px`;
    }, () => this.commit('Column width'));
  }

  // =========================================================================
  // Table of contents
  // =========================================================================
  tocHtml() {
    const items = this.headings().filter((x) => x.level >= 1 && x.level <= 3);
    for (const it of items) if (!it.el.id) it.el.id = `h-${uid('')}`;
    const rows = items.map((it) => `<p class="toc-l${it.level}"><a href="#${it.el.id}">${escapeHtml(it.text)}</a></p>`).join('');
    return `<div class="toc" contenteditable="false"><p class="toc-title">Contents</p>${rows || '<p>Add headings to your document to build the contents.</p>'}</div>`;
  }

  insertToc() { this.insertBlock(this.tocHtml(), 'Table of contents'); }

  updateToc() {
    const tocs = this.doc.querySelectorAll('.toc');
    if (!tocs.length) return false;
    this.change('Update contents', () => {
      for (const t of tocs) {
        const box = h('div');
        box.innerHTML = this.tocHtml();
        t.replaceWith(box.firstChild);
      }
    });
    return true;
  }

  // =========================================================================
  // Find and replace (highlights without touching the document)
  // =========================================================================
  find(query, { matchCase = false, word = false, regex = false } = {}) {
    this.matches = [];
    if (CSS.highlights) { CSS.highlights.delete('snake-find'); CSS.highlights.delete('snake-find-cur'); }
    if (!query) return 0;
    let re;
    try {
      const src = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      re = new RegExp(word ? `\\b(?:${src})\\b` : src, matchCase ? 'gu' : 'giu');
    } catch { return -1; }
    const blocks = [...this.doc.querySelectorAll(BLOCKS)].filter((b) => ![...b.children].some((c) => BLOCK_SET.has(c.tagName)));
    for (const b of blocks) {
      const map = [];
      let text = '';
      const walker = document.createTreeWalker(b, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const n = walker.currentNode;
        map.push([text.length, n]);
        text += n.data;
      }
      if (!text) continue;
      re.lastIndex = 0;
      let m;
      while ((m = re.exec(text))) {
        if (!m[0].length) { re.lastIndex++; continue; }
        const at = (pos, end) => {
          for (let i = map.length - 1; i >= 0; i--) {
            if (map[i][0] < pos || (map[i][0] === pos && !end)) return [map[i][1], pos - map[i][0]];
          }
          return [map[0][1], 0];
        };
        const [sn, so] = at(m.index, false);
        const [en, eo] = at(m.index + m[0].length, true);
        const r = document.createRange();
        r.setStart(sn, so);
        r.setEnd(en, eo);
        this.matches.push(r);
        if (this.matches.length > 5000) break;
      }
    }
    if (CSS.highlights && this.matches.length) CSS.highlights.set('snake-find', new Highlight(...this.matches));
    this.matchIndex = -1;
    return this.matches.length;
  }

  gotoMatch(dir = 1) {
    if (!this.matches || !this.matches.length) return -1;
    const r = this.range();
    if (this.matchIndex < 0 && r) {
      // Start from the caret.
      const idx = this.matches.findIndex((m) => m.compareBoundaryPoints(Range.START_TO_START, r) >= 0);
      this.matchIndex = dir > 0 ? (idx < 0 ? 0 : idx) : ((idx < 0 ? this.matches.length : idx) - 1 + this.matches.length) % this.matches.length;
    } else this.matchIndex = (this.matchIndex + dir + this.matches.length) % this.matches.length;
    const m = this.matches[this.matchIndex];
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(m.cloneRange());
    if (CSS.highlights) CSS.highlights.set('snake-find-cur', new Highlight(m));
    const el = m.startContainer.parentElement;
    if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    return this.matchIndex;
  }

  replaceCurrent(text) {
    const r = this.range();
    if (!r || r.collapsed) return;
    this.change('Replace', () => document.execCommand('insertText', false, text));
  }

  replaceAll(query, text, opts) {
    const n = this.find(query, opts);
    if (n <= 0) return 0;
    this.change('Replace all', () => {
      for (const m of [...this.matches].reverse()) {
        m.deleteContents();
        m.insertNode(document.createTextNode(text));
      }
      this.doc.normalize();
    });
    this.find('', {});
    return n;
  }

  clearFind() {
    this.matches = [];
    if (CSS.highlights) { CSS.highlights.delete('snake-find'); CSS.highlights.delete('snake-find-cur'); }
  }

  // =========================================================================
  // Writing aids: focus mode, typewriter scrolling, statistics
  // =========================================================================
  markFocus() {
    const r = this.range();
    if (!r) return;
    const b = this.blockOf(r.startContainer);
    if (CSS.highlights) CSS.highlights.delete('snake-focus');
    this.doc.classList.add('focus-mode');
    for (const el of this.doc.querySelectorAll('.focus-cur')) el.classList.remove('focus-cur');
    if (b) {
      let top = b;
      while (top.parentNode && top.parentNode !== this.doc) top = top.parentNode;
      top.classList.add('focus-cur');
    }
  }

  clearFocusMarks() {
    this.doc.classList.remove('focus-mode');
    for (const el of this.doc.querySelectorAll('.focus-cur')) {
      el.classList.remove('focus-cur');
      if (!el.className) el.removeAttribute('class');
    }
  }

  typewriterScroll() {
    const r = this.range();
    if (!r) return;
    const rect = r.getClientRects()[0] || (r.startContainer.parentElement && r.startContainer.parentElement.getBoundingClientRect());
    if (!rect) return;
    const sr = this.scroller.getBoundingClientRect();
    const want = sr.top + sr.height * 0.42;
    this.scroller.scrollTop += rect.top - want;
  }

  stats() {
    const text = this.doc.innerText || '';
    const words = (text.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) || []).length;
    const chars = text.replace(/\n/g, '').length;
    const r = this.range();
    let selWords = 0;
    if (r && !r.collapsed) selWords = (r.toString().match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) || []).length;
    const s = {
      words, chars, charsNoSpaces: text.replace(/\s/g, '').length, selWords,
      paragraphs: [...this.doc.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, pre')].filter((p) => p.textContent.trim()).length,
      pages: this.pages, readMinutes: Math.max(1, Math.round(words / 230)), speakMinutes: Math.max(1, Math.round(words / 140)),
    };
    s.chars = chars;
    this.lastStats = s;
    this.onStats(s);
    return s;
  }

  // =========================================================================
  // The slash menu: "/" at the start of a line offers blocks to insert
  // =========================================================================
  openSlashMenu(node, off) {
    const items = this.slashItems();
    let query = '';
    const slashStart = off - 1;
    const rect = (() => {
      const r = document.createRange();
      r.setStart(node, slashStart);
      r.setEnd(node, off);
      return r.getBoundingClientRect();
    })();
    let active = 0;
    const list = h('div.menu.slash', { style: { left: `${rect.left}px`, top: `${rect.bottom + 4}px` } });
    const close = () => {
      list.remove();
      this.doc.removeEventListener('keydown', key, true);
      this.doc.removeEventListener('input', input);
      window.removeEventListener('pointerdown', outside, true);
    };
    const filtered = () => items.filter((it) => !query || it.label.toLowerCase().includes(query) || (it.alias || '').includes(query));
    const render = () => {
      const f = filtered();
      list.replaceChildren(h('div.menu-head', 'Insert'), ...f.map((it, i) => {
        const row = h(`div.menu-item${i === active ? '.active' : ''}`, h('span.mi-icon', { html: icon(it.icon, 15) }), h('span.mi-label', it.label),
          it.hint ? h('span.mi-keys', it.hint) : null);
        row.addEventListener('mousedown', (e) => { e.preventDefault(); choose(it); });
        return row;
      }));
      if (!f.length) list.append(h('div.menu-head', 'Nothing matches'));
      const vh = window.innerHeight;
      if (rect.bottom + list.offsetHeight > vh - 8) list.style.top = `${Math.max(8, rect.top - list.offsetHeight - 4)}px`;
    };
    const choose = (it) => {
      close();
      // Remove "/query" first.
      const r = document.createRange();
      try {
        r.setStart(node, slashStart);
        r.setEnd(node, Math.min(node.length, slashStart + 1 + query.length));
        window.getSelection().removeAllRanges();
        window.getSelection().addRange(r);
        document.execCommand('delete');
      } catch {}
      this.commit('Typing');
      it.run();
    };
    const key = (e) => {
      const f = filtered();
      if (e.key === 'ArrowDown') { active = (active + 1) % Math.max(1, f.length); render(); e.preventDefault(); e.stopPropagation(); }
      else if (e.key === 'ArrowUp') { active = (active - 1 + f.length) % Math.max(1, f.length); render(); e.preventDefault(); e.stopPropagation(); }
      else if (e.key === 'Enter' || e.key === 'Tab') { if (f[active]) { e.preventDefault(); e.stopPropagation(); choose(f[active]); } else close(); }
      else if (e.key === 'Escape') { close(); e.preventDefault(); e.stopPropagation(); }
    };
    const input = () => {
      const r = this.range();
      if (!r || r.startContainer !== node || r.startOffset <= slashStart || node.data[slashStart] !== '/') { close(); return; }
      query = node.data.slice(slashStart + 1, r.startOffset).toLowerCase();
      if (/\s/.test(query) && !filtered().length) { close(); return; }
      active = 0;
      render();
    };
    const outside = (e) => { if (!list.contains(e.target)) close(); };
    this.doc.addEventListener('keydown', key, true);
    this.doc.addEventListener('input', input);
    window.addEventListener('pointerdown', outside, true);
    document.body.append(list);
    render();
  }

  slashItems() {
    return [
      { label: 'Heading 1', icon: 'heading', hint: '#', alias: 'h1 title', run: () => this.setStyle('Heading 1') },
      { label: 'Heading 2', icon: 'heading', hint: '##', alias: 'h2', run: () => this.setStyle('Heading 2') },
      { label: 'Heading 3', icon: 'heading', hint: '###', alias: 'h3', run: () => this.setStyle('Heading 3') },
      { label: 'Bulleted list', icon: 'listBullets', hint: '-', alias: 'ul bullet', run: () => this.list('ul') },
      { label: 'Numbered list', icon: 'listNumbers', hint: '1.', alias: 'ol number', run: () => this.list('ol') },
      { label: 'Checklist', icon: 'listCheck', hint: '[]', alias: 'todo task', run: () => this.list('check') },
      { label: 'Table', icon: 'table', alias: 'grid', run: () => this.insertTable(3, 3) },
      { label: 'Picture', icon: 'image', alias: 'image photo', run: () => this.onPickImage && this.onPickImage() },
      { label: 'Quote', icon: 'quote', hint: '>', run: () => this.setStyle('Quote') },
      { label: 'Code block', icon: 'code', hint: '```', run: () => this.setStyle('Code') },
      { label: 'Divider', icon: 'hr', hint: '---', alias: 'line rule', run: () => this.insertBlock('<hr>', 'Line') },
      { label: 'Page break', icon: 'pageBreak', hint: 'Ctrl+Enter', run: () => this.insertPageBreak() },
      { label: 'Two columns', icon: 'columns', alias: 'layout', run: () => this.insertColumns(2) },
      { label: 'Three columns', icon: 'columns', alias: 'layout', run: () => this.insertColumns(3) },
      { label: 'Note box', icon: 'info', alias: 'callout', run: () => this.insertBlock('<div class="note"><p>Note</p></div>', 'Note') },
      { label: 'Table of contents', icon: 'toc', alias: 'toc', run: () => this.insertToc() },
      { label: "Today's date", icon: 'calendar', alias: 'date', run: () => this.insertHTML(escapeHtml(new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })), 'Date') },
      { label: 'Title', icon: 'text', run: () => this.setStyle('Title') },
    ];
  }

  insertColumns(n) {
    const cols = Array.from({ length: n }, (_, i) => `<div class="col"><p>Column ${i + 1}</p></div>`).join('');
    this.insertBlock(`<div class="cols" style="--n:${n}">${cols}</div>`, 'Columns');
  }
}

export { closeMenus, showMenu };
