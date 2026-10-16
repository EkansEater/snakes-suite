// The slide canvas: selecting, moving with smart guides, resizing, rotating,
// marquee selection, editing text in place, and hover zoom.
import { h, clamp, uid, rafOnce, drag } from '../../kit/dom.js';
import { hoverZoom, keepAnchor } from '../../kit/zoom.js';
import { sanitizeHtml } from '../../kit/sanitize.js';
import { renderSlide, settle, THEMES } from './model.js';

const SNAP = 6;

export class SlideEditor {
  constructor({ pres, settings, onChange = () => {}, onSelect = () => {}, onContext = () => {}, onDblClick = () => {}, onDropFiles = null }) {
    this.pres = pres;
    this.settings = settings;
    this.onChange = onChange;
    this.onSelect = onSelect;
    this.onContext = onContext;
    this.onDblClick = onDblClick;
    this.onDropFiles = onDropFiles;
    this.index = 0;
    this.sel = new Set();
    this.editing = null;
    this.zoom = 1;
    this.fitMode = true;
    this.frame = h('div.slide-frame');
    this.layer = h('div.sel-layer');
    this.holder = h('div.slide-holder', this.frame, this.layer);
    this.el = h('div.slide-ws', { tabindex: 0 }, this.holder);
    this.renderSoon = rafOnce(() => this.render());
    this.bind();
    hoverZoom(this.el, { get: () => this.zoom, set: (z, anchor) => this.setZoom(z, anchor), min: 0.1, max: 6 });
    new ResizeObserver(() => { if (this.fitMode) this.fit(); else this.place(); }).observe(this.el);
  }

  get slide() { return this.pres.slides[this.index]; }
  get theme() { return THEMES[this.pres.theme] || THEMES.snake; }
  item(id) { return this.slide.items.find((it) => it.id === id); }
  get selected() { return this.slide ? this.slide.items.filter((it) => this.sel.has(it.id)) : []; }

  setPres(p) { this.pres = p; this.index = Math.min(this.index, p.slides.length - 1); this.sel.clear(); this.editing = null; this.fit(); }

  show(i) {
    this.stopEditing();
    this.index = clamp(i, 0, this.pres.slides.length - 1);
    this.sel.clear();
    this.render();
    this.onSelect();
  }

  // ---- zoom and placement ----
  fit() {
    this.fitMode = true;
    const W = this.el.clientWidth - 60;
    const H = this.el.clientHeight - 60;
    if (W <= 0 || H <= 0) return;
    this.zoom = clamp(Math.min(W / this.pres.size.w, H / this.pres.size.h), 0.05, 6);
    this.place();
    this.onSelect();
  }

  setZoom(z, anchor) {
    const old = this.zoom;
    this.fitMode = false;
    this.zoom = clamp(z, 0.1, 6);
    this.place();
    keepAnchor(this.el, anchor, old, this.zoom);
    this.onSelect();
  }

  place() {
    const z = this.zoom;
    const W = this.pres.size.w * z;
    const H = this.pres.size.h * z;
    const padX = Math.max(30, (this.el.clientWidth - W) / 2);
    const padY = Math.max(30, (this.el.clientHeight - H) / 2);
    Object.assign(this.holder.style, { width: `${W + padX * 2}px`, height: `${H + padY * 2}px` });
    Object.assign(this.frame.style, { left: `${padX}px`, top: `${padY}px`, width: `${W}px`, height: `${H}px` });
    const sl = this.frame.firstElementChild;
    if (sl) sl.style.transform = `scale(${z})`;
    this.drawSelection();
  }

  /** Pointer position in slide coordinates. */
  local(e) {
    const r = this.frame.getBoundingClientRect();
    return { x: (e.clientX - r.left) / this.zoom, y: (e.clientY - r.top) / this.zoom };
  }

  // ---- rendering ----
  render() {
    if (!this.slide) return;
    if (this.editing) { this.drawSelection(); return; }
    const el = renderSlide(this.slide, this.pres, { editing: true });
    el.style.transform = `scale(${this.zoom})`;
    el.style.transformOrigin = '0 0';
    this.frame.replaceChildren(el);
    settle(el, this.zoom);
    this.place();
  }

  drawSelection() {
    this.layer.replaceChildren();
    const fr = this.frame;
    Object.assign(this.layer.style, { left: fr.style.left, top: fr.style.top, width: fr.style.width, height: fr.style.height });
    const z = this.zoom;
    for (const it of this.selected) {
      const box = h('div.sel-box', { style: { left: `${it.x * z}px`, top: `${it.y * z}px`, width: `${it.w * z}px`, height: `${it.h * z}px`, transform: `rotate(${it.rot || 0}deg)` } });
      if (this.sel.size === 1 && !it.locked) {
        for (const pos of ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']) {
          if (it.type === 'line' && !['nw', 'se'].includes(pos)) continue;
          const hd = h(`span.hd.${pos}`);
          hd.addEventListener('pointerdown', (e) => this.resizeDrag(e, it, pos));
          box.append(hd);
        }
        if (it.type !== 'line') {
          const rot = h('span.rot', { 'data-tip': 'Drag to rotate (Shift: 15° steps)' });
          rot.addEventListener('pointerdown', (e) => this.rotateDrag(e, it));
          box.append(rot);
        }
      }
      if (it.locked) box.classList.add('locked');
      if (this.editing === it.id) box.classList.add('editing');
      this.layer.append(box);
    }
    if (this.sel.size > 1) {
      const b = this.bounds(this.selected);
      this.layer.append(h('div.sel-group', { style: { left: `${b.x * z}px`, top: `${b.y * z}px`, width: `${b.w * z}px`, height: `${b.h * z}px` } }));
    }
    if (this.guides) {
      for (const g of this.guides) {
        this.layer.append(h(`div.guide.${g.axis}`, { style: g.axis === 'x' ? { left: `${g.at * z}px` } : { top: `${g.at * z}px` } }));
      }
    }
    if (this.marquee) {
      const m = this.marquee;
      this.layer.append(h('div.marquee', { style: { left: `${Math.min(m.x0, m.x1) * z}px`, top: `${Math.min(m.y0, m.y1) * z}px`, width: `${Math.abs(m.x1 - m.x0) * z}px`, height: `${Math.abs(m.y1 - m.y0) * z}px` } }));
    }
  }

  bounds(items) {
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (const it of items) { x0 = Math.min(x0, it.x); y0 = Math.min(y0, it.y); x1 = Math.max(x1, it.x + it.w); y1 = Math.max(y1, it.y + it.h); }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }

  // ---- selection ----
  select(ids, add = false) {
    this.stopEditing();
    if (!add) this.sel.clear();
    for (const id of ids) {
      const it = this.item(id);
      if (!it) continue;
      // Grouped items select together.
      const group = it.group ? this.slide.items.filter((x) => x.group === it.group).map((x) => x.id) : [id];
      for (const g of group) {
        if (add && this.sel.has(g) && ids.length === 1) this.sel.delete(g); else this.sel.add(g);
      }
    }
    this.drawSelection();
    this.onSelect();
  }

  hitItem(e) {
    const node = e.target.closest && e.target.closest('.item');
    if (!node || !this.frame.contains(node)) return null;
    return this.item(node.dataset.id);
  }

  // ---- events ----
  bind() {
    this.el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (e.target.closest('.hd, .rot')) return;
      const it = this.hitItem(e);
      if (this.editing) {
        if (it && it.id === this.editing) return; // clicks inside the text being edited
        this.stopEditing();
      }
      this.el.focus({ preventScroll: true });
      if (!it) { this.marqueeDrag(e); return; }
      if (!this.sel.has(it.id) || e.shiftKey || e.ctrlKey) this.select([it.id], e.shiftKey || e.ctrlKey);
      if (it.locked) return;
      this.moveDrag(e);
    });
    this.el.addEventListener('dblclick', (e) => {
      const it = this.hitItem(e);
      if (!it) return;
      if (it.type === 'text' || it.type === 'shape') this.startEditing(it, e);
      else this.onDblClick(it, e);
    });
    this.el.addEventListener('contextmenu', (e) => {
      if (this.editing) return; // spelling and text menu
      e.preventDefault();
      const it = this.hitItem(e);
      if (it && !this.sel.has(it.id)) this.select([it.id]);
      if (!it) this.select([]);
      this.onContext(e, it);
    });
    this.el.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) { e.preventDefault(); e.stopPropagation(); } });
    this.el.addEventListener('drop', (e) => {
      if (!e.dataTransfer.files.length || !this.onDropFiles) return;
      e.preventDefault();
      e.stopPropagation();
      this.onDropFiles([...e.dataTransfer.files], this.local(e));
    });
  }

  marqueeDrag(e) {
    const p0 = this.local(e);
    const add = e.shiftKey || e.ctrlKey;
    const before = new Set(this.sel);
    if (!add) { this.sel.clear(); this.onSelect(); }
    this.marquee = { x0: p0.x, y0: p0.y, x1: p0.x, y1: p0.y };
    drag(e, (_dx, _dy, ev) => {
      const p = this.local(ev);
      this.marquee.x1 = p.x;
      this.marquee.y1 = p.y;
      const m = this.marquee;
      const x0 = Math.min(m.x0, m.x1); const x1 = Math.max(m.x0, m.x1); const y0 = Math.min(m.y0, m.y1); const y1 = Math.max(m.y0, m.y1);
      this.sel = new Set(add ? before : []);
      for (const it of this.slide.items) if (it.x < x1 && it.x + it.w > x0 && it.y < y1 && it.y + it.h > y0) this.sel.add(it.id);
      this.drawSelection();
    }, () => {
      this.marquee = null;
      this.drawSelection();
      this.onSelect();
    });
  }

  /** Snap a moving box to the slide and the other items; returns the shift and guide lines. */
  snap(box, ignore) {
    if (this.settings.get('snap', true) === false) return { dx: 0, dy: 0, guides: [] };
    const W = this.pres.size.w;
    const H = this.pres.size.h;
    const xs = [0, W / 2, W];
    const ys = [0, H / 2, H];
    for (const it of this.slide.items) {
      if (ignore.has(it.id)) continue;
      xs.push(it.x, it.x + it.w / 2, it.x + it.w);
      ys.push(it.y, it.y + it.h / 2, it.y + it.h);
    }
    const tol = SNAP / this.zoom;
    const best = (vals, edges) => {
      let found = null;
      for (const v of vals) for (const e of edges) { const d = v - e; if (Math.abs(d) <= tol && (!found || Math.abs(d) < Math.abs(found.d))) found = { d, at: v }; }
      return found;
    };
    const bx = best(xs, [box.x, box.x + box.w / 2, box.x + box.w]);
    const by = best(ys, [box.y, box.y + box.h / 2, box.y + box.h]);
    const guides = [];
    if (bx) guides.push({ axis: 'x', at: bx.at });
    if (by) guides.push({ axis: 'y', at: by.at });
    return { dx: bx ? bx.d : 0, dy: by ? by.d : 0, guides };
  }

  moveDrag(e) {
    const items = this.selected.filter((it) => !it.locked);
    if (!items.length) return;
    const start = items.map((it) => ({ it, x: it.x, y: it.y }));
    const b0 = this.bounds(items);
    let moved = false;
    const ignore = new Set(items.map((it) => it.id));
    drag(e, (dx, dy, ev) => {
      if (!moved && Math.hypot(dx, dy) < 3) return;
      moved = true;
      let mx = dx / this.zoom;
      let my = dy / this.zoom;
      if (ev.shiftKey) { if (Math.abs(mx) > Math.abs(my)) my = 0; else mx = 0; }
      const s = ev.altKey ? { dx: 0, dy: 0, guides: [] } : this.snap({ x: b0.x + mx, y: b0.y + my, w: b0.w, h: b0.h }, ignore);
      for (const st of start) { st.it.x = Math.round(st.x + mx + s.dx); st.it.y = Math.round(st.y + my + s.dy); }
      this.guides = s.guides;
      this.renderSoon();
    }, () => {
      this.guides = null;
      if (moved) this.onChange('Move');
      this.render();
    });
  }

  resizeDrag(e, it, pos) {
    e.preventDefault();
    e.stopPropagation();
    const s0 = { x: it.x, y: it.y, w: it.w, h: it.h };
    const ratio = s0.w / Math.max(1, s0.h);
    const keep = it.type === 'image' || it.type === 'chart';
    const rad = ((it.rot || 0) * Math.PI) / 180;
    drag(e, (dx, dy, ev) => {
      // Work in the item's own (rotated) frame.
      const ux = (dx * Math.cos(rad) + dy * Math.sin(rad)) / this.zoom;
      const uy = (-dx * Math.sin(rad) + dy * Math.cos(rad)) / this.zoom;
      let { x, y, w, h: hh } = s0;
      if (pos.includes('e')) w = s0.w + ux;
      if (pos.includes('s')) hh = s0.h + uy;
      if (pos.includes('w')) { w = s0.w - ux; x = s0.x + ux; }
      if (pos.includes('n')) { hh = s0.h - uy; y = s0.y + uy; }
      const lockRatio = (keep && !ev.shiftKey) || (!keep && ev.shiftKey);
      if (lockRatio && pos.length === 2) {
        if (Math.abs(w / ratio) > Math.abs(hh)) hh = w / ratio; else w = hh * ratio;
        if (pos.includes('w')) x = s0.x + s0.w - w;
        if (pos.includes('n')) y = s0.y + s0.h - hh;
      }
      if (it.type !== 'line') {
        if (w < 8) { if (pos.includes('w')) x -= 8 - w; w = 8; }
        if (hh < 8) { if (pos.includes('n')) y -= 8 - hh; hh = 8; }
      }
      if (ev.altKey) { x = s0.x - (w - s0.w) / 2; y = s0.y - (hh - s0.h) / 2; }
      Object.assign(it, { x: Math.round(x), y: Math.round(y), w: Math.round(w), h: Math.round(hh) });
      if (it.type === 'line') {
        if (it.w < 0) { it.x += it.w; it.w = -it.w; it.dir = it.dir === 'up' ? 'down' : 'up'; s0.x = it.x; s0.w = it.w; }
        if (it.h < 0) { it.y += it.h; it.h = -it.h; it.dir = it.dir === 'up' ? 'down' : 'up'; s0.y = it.y; s0.h = it.h; }
      }
      this.renderSoon();
    }, () => { this.onChange('Resize'); this.render(); });
  }

  rotateDrag(e, it) {
    e.preventDefault();
    e.stopPropagation();
    const r = this.frame.getBoundingClientRect();
    const cx = r.left + (it.x + it.w / 2) * this.zoom;
    const cy = r.top + (it.y + it.h / 2) * this.zoom;
    drag(e, (_dx, _dy, ev) => {
      let a = (Math.atan2(ev.clientY - cy, ev.clientX - cx) * 180) / Math.PI + 90;
      if (ev.shiftKey) a = Math.round(a / 15) * 15;
      else if (Math.abs(((a % 90) + 90) % 90) < 3 || Math.abs(((a % 90) + 90) % 90) > 87) a = Math.round(a / 90) * 90; // stick at right angles
      it.rot = Math.round(((a % 360) + 360) % 360);
      this.renderSoon();
    }, () => { this.onChange('Rotate'); this.render(); });
  }

  // ---- editing text in place ----
  startEditing(it, e = null) {
    this.stopEditing();
    this.sel = new Set([it.id]);
    if (!it.html && it.type === 'shape') { it.html = ''; this.render(); }
    const node = this.frame.querySelector(`.item[data-id="${it.id}"] .text-inner`);
    if (!node) return;
    this.editing = it.id;
    node.classList.remove('empty');
    delete node.dataset.prompt;
    node.style.zoom = '';
    node.contentEditable = 'true';
    node.spellcheck = true;
    node.focus();
    // Put the caret where the double-click was, or select everything in a placeholder.
    const sel = window.getSelection();
    if (e && document.caretRangeFromPoint) {
      const r = document.caretRangeFromPoint(e.clientX, e.clientY);
      if (r && node.contains(r.startContainer)) { sel.removeAllRanges(); sel.addRange(r); }
    } else {
      const r = document.createRange();
      r.selectNodeContents(node);
      r.collapse(false);
      sel.removeAllRanges();
      sel.addRange(r);
    }
    if (!node.innerHTML.trim()) node.innerHTML = '<p><br></p>';
    node.addEventListener('paste', this.onPaste);
    node.addEventListener('keydown', this.onEditKey);
    node.addEventListener('input', this.onEditInput);
    this.drawSelection();
    this.onSelect();
  }

  onPaste = (e) => {
    const html = e.clipboardData.getData('text/html');
    const text = e.clipboardData.getData('text/plain');
    e.preventDefault();
    if (html) {
      const frag = sanitizeHtml(html);
      for (const el of frag.querySelectorAll('[style]')) { el.style.removeProperty('font-size'); el.style.removeProperty('font-family'); el.style.removeProperty('background-color'); }
      const box = document.createElement('div');
      box.append(frag);
      document.execCommand('insertHTML', false, box.innerHTML);
    } else document.execCommand('insertText', false, text);
  };

  onEditKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.stopEditing(); this.el.focus(); }
    if (e.key === 'Tab') {
      e.preventDefault();
      document.execCommand(e.shiftKey ? 'outdent' : 'indent');
    }
    e.stopPropagation();
  };

  onEditInput = () => { this.dirtyText = true; this.drawSelection(); };

  stopEditing() {
    if (!this.editing) return;
    const id = this.editing;
    this.editing = null;
    const node = this.frame.querySelector(`.item[data-id="${id}"] .text-inner`);
    const it = this.item(id);
    if (node && it) {
      node.contentEditable = 'false';
      node.removeEventListener('paste', this.onPaste);
      node.removeEventListener('keydown', this.onEditKey);
      node.removeEventListener('input', this.onEditInput);
      const html = node.innerHTML.replace(/^<p><br><\/p>$/, '').trim();
      const clean = node.textContent.trim() || node.querySelector('img') ? html : '';
      if (clean !== (it.html || '')) {
        it.html = clean;
        this.onChange('Edit text');
      }
    }
    this.dirtyText = false;
    window.getSelection().removeAllRanges();
    this.render();
    this.onSelect();
  }

  /** The text element being edited, for formatting commands. */
  editNode() {
    return this.editing ? this.frame.querySelector(`.item[data-id="${this.editing}"] .text-inner`) : null;
  }

  // ---- item operations ----
  add(item) {
    this.slide.items.push({ id: uid('it'), rot: 0, ...item });
    const added = this.slide.items[this.slide.items.length - 1];
    this.sel = new Set([added.id]);
    this.onChange('Insert');
    this.render();
    this.onSelect();
    return added;
  }

  remove() {
    if (!this.sel.size) return;
    this.slide.items = this.slide.items.filter((it) => !this.sel.has(it.id) || it.locked);
    this.sel.clear();
    this.onChange('Delete');
    this.render();
    this.onSelect();
  }

  duplicate(offset = 24) {
    const copies = this.selected.map((it) => ({ ...JSON.parse(JSON.stringify(it)), id: uid('it'), x: it.x + offset, y: it.y + offset }));
    const groups = new Map();
    for (const c of copies) if (c.group) { if (!groups.has(c.group)) groups.set(c.group, uid('g')); c.group = groups.get(c.group); }
    this.slide.items.push(...copies);
    this.sel = new Set(copies.map((c) => c.id));
    this.onChange('Duplicate');
    this.render();
    this.onSelect();
  }

  nudge(dx, dy) {
    for (const it of this.selected) if (!it.locked) { it.x += dx; it.y += dy; }
    this.onChange('Nudge', 'nudge');
    this.render();
  }

  order(where) {
    const items = this.slide.items;
    const sel = items.filter((it) => this.sel.has(it.id));
    const rest = items.filter((it) => !this.sel.has(it.id));
    if (where === 'front') this.slide.items = [...rest, ...sel];
    else if (where === 'back') this.slide.items = [...sel, ...rest];
    else {
      const out = items.slice();
      const idxs = sel.map((it) => out.indexOf(it)).sort((a, b) => (where === 'forward' ? b - a : a - b));
      for (const i of idxs) {
        const j = where === 'forward' ? i + 1 : i - 1;
        if (j < 0 || j >= out.length || this.sel.has(out[j].id)) continue;
        [out[i], out[j]] = [out[j], out[i]];
      }
      this.slide.items = out;
    }
    this.onChange('Arrange');
    this.render();
  }

  align(how) {
    const items = this.selected;
    if (!items.length) return;
    const ref = items.length === 1 ? { x: 0, y: 0, w: this.pres.size.w, h: this.pres.size.h } : this.bounds(items);
    for (const it of items) {
      if (how === 'left') it.x = ref.x;
      if (how === 'center') it.x = Math.round(ref.x + (ref.w - it.w) / 2);
      if (how === 'right') it.x = ref.x + ref.w - it.w;
      if (how === 'top') it.y = ref.y;
      if (how === 'middle') it.y = Math.round(ref.y + (ref.h - it.h) / 2);
      if (how === 'bottom') it.y = ref.y + ref.h - it.h;
    }
    this.onChange('Align');
    this.render();
  }

  distribute(axis) {
    const items = [...this.selected].sort((a, b) => (axis === 'h' ? a.x - b.x : a.y - b.y));
    if (items.length < 3) return;
    const b = this.bounds(items);
    const total = items.reduce((s, it) => s + (axis === 'h' ? it.w : it.h), 0);
    const gap = ((axis === 'h' ? b.w : b.h) - total) / (items.length - 1);
    let pos = axis === 'h' ? b.x : b.y;
    for (const it of items) {
      if (axis === 'h') { it.x = Math.round(pos); pos += it.w + gap; } else { it.y = Math.round(pos); pos += it.h + gap; }
    }
    this.onChange('Distribute');
    this.render();
  }

  group() {
    if (this.sel.size < 2) return;
    const g = uid('g');
    for (const it of this.selected) it.group = g;
    this.onChange('Group');
    this.drawSelection();
  }

  ungroup() {
    for (const it of this.selected) delete it.group;
    this.onChange('Ungroup');
    this.drawSelection();
  }

  setStyle(patch, label = 'Format') {
    for (const it of this.selected) {
      it.style = { ...(it.style || {}), ...patch };
      for (const [k, v] of Object.entries(patch)) if (v === undefined) delete it.style[k];
    }
    this.onChange(label);
    this.render();
  }
}
