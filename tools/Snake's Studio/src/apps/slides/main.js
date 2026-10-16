// Snake's Slides.
import { h, uid, clamp, debounce, extOf, baseName, escapeHtml, drag, fmtTime, rafOnce } from '../../kit/dom.js';
import { icon } from '../../kit/icons.js';
import { host, inElectron, decodeText } from '../../kit/host.js';
import * as commands from '../../kit/commands.js';
import { createShell, tb, sep, combo, select, startScreen, onDropFiles, guardClose, refresh, splitter } from '../../kit/shell.js';
import { toggleDrawer } from '../../kit/phone.js';
import { showMenu, contextMenu, popover, closeMenus } from '../../kit/menu.js';
import { modal, toast, errorToast, busy, promptBox, confirmBox } from '../../kit/dialogs.js';
import { pickColor, colorPicker } from '../../kit/color.js';
import { knownFonts, allFonts, FONT_SIZES } from '../../kit/fonts.js';
import { stepZoom, pinch } from '../../kit/zoom.js';
import { CHART_TYPES } from '../../kit/charts.js';
import { History } from '../../kit/history.js';
import { SIZES, THEMES, SHAPES, LAYOUTS, makeSlide, newPresentation, renderSlide, settle, shapePath, themeColor, textOf } from './model.js';
import { SlideEditor } from './editor.js';
import { Show } from './show.js';
import { readPptx, writePptx } from './pptx.js';
import { TEMPLATES, templateThumb } from './templates.js';

const FILTERS = [
  { name: 'Presentations', exts: ['snakeslides', 'pptx'] },
  { name: "Snake's Slides", exts: ['snakeslides'] },
  { name: 'PowerPoint', exts: ['pptx'] },
];
const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif', 'svg'];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let pres = newPresentation();
const file = { handle: null, name: 'Untitled', format: 'snakeslides', id: uid('deck'), opened: false };
const history = new History({ onChange: () => { updateTitle(); refresh(); } });
let snapshot = null;

const shell = await createShell({
  id: 'slides', name: "Snake's Slides",
  quick: ['file.save', 'edit.undo', 'edit.redo', 'show.start'],
  menus: [
    { label: '&File', items: () => fileMenu() },
    { label: '&Edit', items: () => editMenu() },
    { label: '&View', items: () => viewMenu() },
    { label: '&Insert', items: () => insertMenu() },
    { label: 'F&ormat', items: () => formatMenu() },
    { label: '&Slide', items: () => slideMenu() },
    { label: '&Help', items: () => [I('app.palette'), I('app.shortcuts'), { type: 'separator' }, I('app.about')] },
  ],
  about: 'Presentations with themes, smart guides, animations and a presenter view. Reads and writes PowerPoint (.pptx) and exports PDF.',
});
const settings = host.settings;
const I = (id, extra) => commands.item(id, extra);

// ---------------------------------------------------------------------------
// Layout: sorter | canvas + notes | format panel
// ---------------------------------------------------------------------------
const sorterList = h('div.sorter-list', { tabindex: 0 });
const sorter = h('div.panel.sorter', h('div.panel-head', 'Slides', h('span.grow'), tb({ icon: 'plus', tip: 'New slide', run: () => commands.run('slide.new') })), sorterList);
const sorterSplit = splitter(sorter, { side: 'left', key: 'sorterW', initial: 210, min: 130, max: 420, title: 'Slides', icon: 'slide' });
const notes = h('textarea.notes-input', { placeholder: 'Speaker notes: what to say on this slide. Only you see them in the presenter view.', spellcheck: true });
const notesPanel = h('div.notes-panel', notes);
const notesSplit = splitter(notesPanel, { side: 'bottom', key: 'notesH', initial: 110, min: 40, max: 400, vertical: true });
const format = h('div.panel.format-panel', h('div.panel-head', h('span.fp-title', 'Slide'), h('span.grow'), tb({ icon: 'x', tip: 'Hide panel', run: () => commands.run('view.format') })), h('div.panel-body.fp-body'));
const formatSplit = splitter(format, { side: 'right', key: 'formatW', initial: 270, min: 220, max: 480, title: 'Format', icon: 'sliders' });

const ed = new SlideEditor({
  pres, settings,
  onChange: (label, key) => commit(label, key),
  onSelect: () => { buildFormat(); refresh(); zoomBox.update(); },
  onContext: (e, it) => canvasMenu(e, it),
  onDblClick: (it) => itemDblClick(it),
  onDropFiles: (files, at) => dropFiles(files, at),
});
const center = h('div.slides-center', ed.el, notesSplit, notesPanel);
shell.main.append(sorter, sorterSplit, center, formatSplit, format);
if (!settings.get('notes', true)) { notesPanel.classList.add('hidden'); notesSplit.classList.add('hidden'); }
if (!settings.get('format', true)) { format.classList.add('hidden'); formatSplit.classList.add('hidden'); }

// ---------------------------------------------------------------------------
// Undo: snapshots of the deck (pictures live in pres.assets, shared)
// ---------------------------------------------------------------------------
const snap = () => JSON.stringify({ size: pres.size, sizeId: pres.sizeId, theme: pres.theme, slides: pres.slides, showNumbers: pres.showNumbers });
function commit(label = 'Edit', key = null) {
  const now = snap();
  if (now === snapshot) { drawSorterSoon(); return; }
  const before = snapshot;
  snapshot = now;
  const index = ed.index;
  history.push({ label, key, undo: () => restore(before, index), redo: () => restore(now, index) });
  drawSorterSoon();
  updateTitle();
}
function restore(json, index) {
  const j = JSON.parse(json);
  Object.assign(pres, j);
  snapshot = json;
  ed.pres = pres;
  ed.sel.clear();
  ed.editing = null;
  ed.index = clamp(index, 0, pres.slides.length - 1);
  ed.render();
  drawSorter();
  buildFormat();
  loadNotes();
}

// ---------------------------------------------------------------------------
// Slide sorter
// ---------------------------------------------------------------------------
const thumbCache = new Map();
let selectedSlides = new Set();
function drawSorter() {
  sorterList.replaceChildren();
  const tw = sorterList.clientWidth - 46 || 150;
  pres.slides.forEach((s, i) => {
    const key = JSON.stringify(s) + pres.theme + pres.size.w + tw;
    let thumb = thumbCache.get(s.id);
    if (!thumb || thumb.key !== key) {
      const el = renderSlide(s, pres, { editing: false });
      el.style.transformOrigin = '0 0';
      const scale = tw / pres.size.w;
      el.style.transform = `scale(${scale})`;
      const box = h('div.thumb-box', { style: { width: `${tw}px`, height: `${pres.size.h * scale}px` } }, el);
      thumb = { key, box, el, scale };
      thumbCache.set(s.id, thumb);
    }
    const row = h(`div.sorter-item${i === ed.index ? '.on' : ''}${selectedSlides.has(s.id) ? '.picked' : ''}${s.hidden ? '.hidden-slide' : ''}`, { draggable: 'true' },
      h('div.num', String(i + 1), s.hidden ? h('span', { html: icon('eyeOff', 11) }) : null, s.transition && s.transition.type !== 'none' ? h('span.tr', { html: icon('transition', 11), 'data-tip': `Transition: ${s.transition.type}` }) : null),
      thumb.box);
    row.addEventListener('click', (e) => {
      if (e.ctrlKey || e.metaKey) { if (selectedSlides.has(s.id)) selectedSlides.delete(s.id); else selectedSlides.add(s.id); drawSorter(); return; }
      if (e.shiftKey) { const a = Math.min(ed.index, i); const b = Math.max(ed.index, i); selectedSlides = new Set(pres.slides.slice(a, b + 1).map((x) => x.id)); drawSorter(); return; }
      selectedSlides = new Set([s.id]);
      goto(i);
    });
    row.addEventListener('dblclick', () => startShow(i));
    row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/snake-slide', String(i)); row.classList.add('dragging'); });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
    row.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/snake-slide')) { e.preventDefault(); const r = row.getBoundingClientRect(); row.classList.toggle('drop-before', e.clientY < r.top + r.height / 2); row.classList.toggle('drop-after', e.clientY >= r.top + r.height / 2); } });
    row.addEventListener('dragleave', () => row.classList.remove('drop-before', 'drop-after'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      const after = row.classList.contains('drop-after');
      row.classList.remove('drop-before', 'drop-after');
      const from = Number(e.dataTransfer.getData('text/snake-slide'));
      let to = i + (after ? 1 : 0);
      if (from === to || from + 1 === to) return;
      const [moved] = pres.slides.splice(from, 1);
      if (to > from) to--;
      pres.slides.splice(to, 0, moved);
      ed.index = to;
      commit('Move slide');
      drawSorter();
      ed.render();
    });
    contextMenu(row, () => { if (i !== ed.index) goto(i); return slideMenu(); });
    sorterList.append(row);
    requestAnimationFrame(() => settle(thumb.el, thumb.scale));
  });
  const add = h('button.add-slide', { html: `${icon('plus', 16)} New slide` });
  add.addEventListener('click', () => commands.run('slide.new'));
  sorterList.append(add);
  const on = sorterList.querySelector('.sorter-item.on');
  if (on) on.scrollIntoView({ block: 'nearest' });
}
const drawSorterSoon = debounce(drawSorter, 150);
new ResizeObserver(debounce(() => { thumbCache.clear(); drawSorter(); }, 200)).observe(sorter);
sorterList.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'PageDown') { e.preventDefault(); goto(ed.index + 1); }
  if (e.key === 'ArrowUp' || e.key === 'PageUp') { e.preventDefault(); goto(ed.index - 1); }
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); commands.run('slide.delete'); }
  if (e.key === 'Home') goto(0);
  if (e.key === 'End') goto(pres.slides.length - 1);
});

function goto(i) {
  saveNotes();
  ed.show(clamp(i, 0, pres.slides.length - 1));
  if (!selectedSlides.has(pres.slides[ed.index].id)) selectedSlides = new Set([pres.slides[ed.index].id]);
  drawSorter();
  loadNotes();
  updateStatus();
}

// ---------------------------------------------------------------------------
// Notes
// ---------------------------------------------------------------------------
function loadNotes() { notes.value = (ed.slide && ed.slide.notes) || ''; }
function saveNotes() {
  if (ed.slide && notes.value !== (ed.slide.notes || '')) { ed.slide.notes = notes.value; commit('Notes', 'notes'); }
}
notes.addEventListener('input', debounce(saveNotes, 600));
notes.addEventListener('blur', saveNotes);
notes.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  const size = clamp(settings.get('notesSize', 14) + (e.deltaY < 0 ? 1 : -1), 9, 40);
  settings.set('notesSize', size);
  notes.style.fontSize = `${size}px`;
}, { passive: false });
notes.style.fontSize = `${settings.get('notesSize', 14)}px`;

// ---------------------------------------------------------------------------
// Inserting things
// ---------------------------------------------------------------------------
const center0 = (w, hh) => ({ x: Math.round((pres.size.w - w) / 2), y: Math.round((pres.size.h - hh) / 2), w, h: hh });

function addText(at = null) {
  const it = ed.add({ type: 'text', ...(at ? { x: at.x, y: at.y, w: 520, h: 90 } : center0(520, 90)), html: '', style: { size: 28 } });
  ed.render();
  ed.startEditing(it);
}

function addShape(kind) {
  ed.add({ type: 'shape', shape: kind, ...center0(kind === 'arrowRight' || kind === 'arrowLeft' || kind === 'chevron' ? 320 : 240, kind === 'arrowRight' || kind === 'arrowLeft' || kind === 'chevron' ? 140 : 240), html: '', style: { fill: 'accent0', align: 'center', valign: 'middle', size: 24 } });
}

function addLine(arrow = false) {
  ed.add({ type: 'line', ...center0(360, 120), dir: 'down', style: { stroke: 'text', strokeWidth: 4, arrow } });
}

function addTable(rows = 3, cols = 3) {
  ed.add({ type: 'table', ...center0(Math.min(pres.size.w - 120, cols * 220), rows * 60), rows: Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => ({ html: r === 0 ? `Heading ${c + 1}` : '' }))), style: { size: 22, striped: true } });
}

function addChart(type = 'column') {
  ed.add({ type: 'chart', ...center0(Math.min(760, pres.size.w - 120), Math.min(440, pres.size.h - 120)), chart: { type, title: 'Chart title', categories: ['Q1', 'Q2', 'Q3', 'Q4'], series: [{ name: 'This year', values: [42, 55, 61, 78] }, { name: 'Last year', values: [35, 41, 50, 58] }] } });
}

function addEmoji(e) {
  ed.add({ type: 'text', ...center0(220, 220), html: `<p>${e}</p>`, style: { size: 150, align: 'center', valign: 'middle', autofit: false, padding: 0 } });
}

async function readImage(f) {
  const bytes = await host.read(f);
  const ext = extOf(f.name);
  const type = ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
  return blobToDataUrl(new Blob([bytes], { type }));
}
const blobToDataUrl = (blob) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob); });

async function addImageUrl(url, at = null, replace = null) {
  if (/^data:image\/svg/.test(url)) {
    // SVG pictures become PNG: nothing inside them can run.
    const img = new Image();
    img.src = url;
    await img.decode().catch(() => {});
    const c = document.createElement('canvas');
    c.width = img.naturalWidth || 800; c.height = img.naturalHeight || 600;
    c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
    url = c.toDataURL('image/png');
  }
  const id = uid('as');
  pres.assets[id] = url;
  const img = new Image();
  img.src = url;
  await img.decode().catch(() => {});
  const nw = img.naturalWidth || 800;
  const nh = img.naturalHeight || 600;
  if (replace) { replace.asset = id; commit('Replace picture'); ed.render(); return; }
  const max = Math.min(pres.size.w * 0.7, pres.size.h * 0.7 * (nw / nh));
  const w = Math.min(nw, max);
  const hh = w * (nh / nw);
  const pos = at ? { x: Math.round(at.x - w / 2), y: Math.round(at.y - hh / 2), w: Math.round(w), h: Math.round(hh) } : center0(Math.round(w), Math.round(hh));
  ed.add({ type: 'image', ...pos, asset: id, style: { fit: 'cover' } });
}

async function insertPicture(replace = null) {
  const files = await host.openFiles({ filters: [{ name: 'Pictures', exts: IMAGE_EXTS }], multiple: !replace, readOnly: true });
  for (const f of files) {
    try { await addImageUrl(await readImage(f), null, replace); } catch (err) { errorToast(err); }
  }
}

async function dropFiles(files, at) {
  for (const f of files) {
    if (!f.type.startsWith('image/')) continue;
    const ph = ed.slide.items.find((it) => it.type === 'image' && !it.asset && at.x >= it.x && at.x <= it.x + it.w && at.y >= it.y && at.y <= it.y + it.h);
    await addImageUrl(await blobToDataUrl(f), at, ph || null);
  }
}

function itemDblClick(it) {
  if (it.type === 'image') insertPicture(it);
  else if (it.type === 'chart') chartDialog(it);
  else if (it.type === 'table') tableDialog(it);
}

// ---------------------------------------------------------------------------
// Slides
// ---------------------------------------------------------------------------
function newSlide(layout = null) {
  const cur = ed.slide;
  const lay = layout || (cur && cur.layout === 'title' ? 'content' : (cur && cur.layout) || 'content');
  const s = makeSlide(lay === 'blank' ? 'blank' : lay, pres.size);
  if (cur && cur.transition) s.transition = { ...cur.transition };
  pres.slides.splice(ed.index + 1, 0, s);
  ed.index++;
  commit('New slide');
  goto(ed.index);
}

function duplicateSlides() {
  const ids = selectedSlides.size > 1 ? selectedSlides : new Set([ed.slide.id]);
  const copies = [];
  let last = ed.index;
  pres.slides.forEach((s, i) => { if (ids.has(s.id)) last = i; });
  for (const s of pres.slides.filter((x) => ids.has(x.id))) copies.push({ ...JSON.parse(JSON.stringify(s)), id: uid('sl'), items: s.items.map((it) => ({ ...JSON.parse(JSON.stringify(it)), id: uid('it') })) });
  pres.slides.splice(last + 1, 0, ...copies);
  commit('Duplicate slide');
  goto(last + 1);
}

async function deleteSlides() {
  const ids = selectedSlides.size > 1 ? selectedSlides : new Set([ed.slide.id]);
  if (ids.size >= pres.slides.length) { toast('A presentation needs at least one slide.', { type: 'warn' }); return; }
  pres.slides = pres.slides.filter((s) => !ids.has(s.id));
  selectedSlides.clear();
  commit('Delete slide');
  goto(Math.min(ed.index, pres.slides.length - 1));
}

function applyLayout(layout) {
  const s = ed.slide;
  const fresh = makeSlide(layout, pres.size);
  // Keep what was typed into placeholders of the same kind, and everything else.
  const keep = s.items.filter((it) => !it.ph);
  const filled = new Map(s.items.filter((it) => it.ph && (it.html || it.asset)).map((it) => [it.ph, it]));
  s.items = [...fresh.items.map((it) => { const old = filled.get(it.ph); return old ? { ...it, html: old.html, asset: old.asset } : it; }), ...keep];
  s.layout = layout;
  commit('Layout');
  ed.render();
}

function setTheme(t) {
  pres.theme = t;
  thumbCache.clear();
  commit('Theme');
  ed.render();
  drawSorter();
  buildFormat();
}

function setSize(id) {
  const s = SIZES[id];
  const sx = s.w / pres.size.w;
  const sy = s.h / pres.size.h;
  for (const sl of pres.slides) for (const it of sl.items) { it.x = Math.round(it.x * sx); it.w = Math.round(it.w * sx); it.y = Math.round(it.y * sy); it.h = Math.round(it.h * sy); }
  pres.size = { ...s };
  pres.sizeId = id;
  thumbCache.clear();
  commit('Slide size');
  ed.fit();
  ed.render();
  drawSorter();
}

function setTransition(type, all = false) {
  for (const s of all ? pres.slides : [ed.slide]) s.transition = { ...(s.transition || {}), type };
  commit('Transition');
  drawSorter();
  buildFormat();
}

// ---------------------------------------------------------------------------
// Text formatting: inside the text being edited, or the whole selected boxes
// ---------------------------------------------------------------------------
function textCmd(cmd, styleKey, label) {
  if (ed.editing) {
    document.execCommand('styleWithCSS', false, false);
    document.execCommand(cmd);
    ed.dirtyText = true;
    return;
  }
  const items = ed.selected.filter((it) => it.type === 'text' || it.type === 'shape' || it.type === 'table');
  if (!items.length) return;
  const on = !items[0].style[styleKey];
  ed.setStyle({ [styleKey]: on || undefined }, label);
}

function inlineStyle(prop, value, styleKey, styleValue, label) {
  if (ed.editing) {
    const node = ed.editNode();
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.getRangeAt(0).collapsed) {
      // Nothing selected inside: style the whole box instead.
      ed.stopEditing();
    } else {
      const marker = `snake-mark-${uid('')}`;
      document.execCommand('styleWithCSS', false, false);
      document.execCommand('fontName', false, marker);
      for (const f of node.querySelectorAll(`font[face="${marker}"]`)) {
        const span = document.createElement('span');
        span.style.setProperty(prop, value);
        while (f.firstChild) span.append(f.firstChild);
        f.replaceWith(span);
      }
      ed.dirtyText = true;
      return;
    }
  }
  ed.setStyle({ [styleKey]: styleValue }, label);
}

const st = () => (ed.selected[0] && ed.selected[0].style) || {};

// ---------------------------------------------------------------------------
// Format panel (right side)
// ---------------------------------------------------------------------------
const fpBody = format.querySelector('.fp-body');
const fpTitle = format.querySelector('.fp-title');

function numberField(label, value, onChange, { step = 1, min = -100000, max = 100000, unit = '' } = {}) {
  const input = h('input.input.num', { type: 'number', value: Math.round(value * 100) / 100, step, min, max, style: { width: '72px' } });
  input.addEventListener('change', () => onChange(Number(input.value)));
  // Dragging the label changes the number, like a slider.
  const lab = h('span.drag-label', { 'data-tip': 'Drag sideways or turn the wheel over the box to change' }, label);
  lab.addEventListener('pointerdown', (e) => {
    const v0 = Number(input.value);
    drag(e, (dx) => { input.value = String(clamp(Math.round((v0 + dx * step) * 100) / 100, min, max)); onChange(Number(input.value), true); }, () => onChange(Number(input.value)));
  });
  return h('label.fp-field', lab, input, unit ? h('span.muted', unit) : null);
}

function colorField(label, value, onChange, { allowNone = true, theme = true } = {}) {
  const T = THEMES[pres.theme];
  const resolved = themeColor(T, value) || 'transparent';
  const sw = h('button.fp-swatch', { style: { background: value === 'none' || !value ? 'transparent' : resolved }, 'data-tip': label });
  sw.addEventListener('click', () => {
    const picker = colorPicker({ value: resolved, allowNone, alpha: false, onPick: (c) => { closeMenus(); onChange(c === 'none' ? 'none' : c); } });
    const themeRow = theme ? h('div.row', { style: { gap: '3px', padding: '0 6px' } }, h('span.muted', { style: { fontSize: '11px', marginRight: '4px' } }, 'Theme'),
      ...T.accents.map((c, i) => { const b = h('div.swatch', { style: { background: c, width: '20px' }, title: `Accent ${i + 1}` }); b.addEventListener('click', () => { closeMenus(); onChange(`accent${i}`); }); return b; }),
      ...['title', 'text'].map((k) => { const b = h('div.swatch', { style: { background: T[k], width: '20px' }, title: k }); b.addEventListener('click', () => { closeMenus(); onChange(k); }); return b; })) : null;
    popover(h('div', themeRow, picker), { anchor: sw });
  });
  return h('label.fp-field', h('span', label), sw);
}

function section(title, ...children) { return h('div.fp-section', h('div.fp-head', title), ...children.filter(Boolean)); }

function buildFormat() {
  if (format.classList.contains('hidden')) return;
  const items = ed.selected;
  fpBody.replaceChildren();
  if (!items.length) {
    fpTitle.textContent = `Slide ${ed.index + 1}`;
    const s = ed.slide;
    if (!s) return;
    const layout = select({ options: LAYOUTS.map(([v, l]) => ({ value: v, label: l })), value: s.layout, onChange: (v) => applyLayout(v) });
    const bg = s.bg || {};
    const trans = select({ options: [['none', 'None'], ['fade', 'Fade'], ['slide', 'Slide in'], ['push', 'Push up'], ['zoom', 'Zoom'], ['cover', 'Cover'], ['flip', 'Flip']].map(([v, l]) => ({ value: v, label: l })), value: (s.transition && s.transition.type) || 'fade', onChange: (v) => setTransition(v) });
    const dur = numberField('Seconds', (s.transition && s.transition.duration) || 0.5, (v, live) => { s.transition = { ...(s.transition || {}), duration: clamp(v, 0.1, 5) }; if (!live) commit('Transition'); }, { step: 0.1, min: 0.1, max: 5 });
    const allBtn = h('button.btn.small', 'Use on every slide');
    allBtn.addEventListener('click', () => setTransition((s.transition && s.transition.type) || 'fade', true));
    const hidden = h('input', { type: 'checkbox', checked: !!s.hidden });
    hidden.addEventListener('change', () => { s.hidden = hidden.checked; commit('Hide slide'); drawSorter(); });
    const bgImg = h('button.btn.small', bg.image ? 'Change picture' : 'Picture…');
    bgImg.addEventListener('click', async () => {
      const files = await host.openFiles({ filters: [{ name: 'Pictures', exts: IMAGE_EXTS }], readOnly: true });
      if (!files[0]) return;
      const id = uid('as');
      pres.assets[id] = await readImage(files[0]);
      s.bg = { ...bg, image: id, overlay: bg.overlay ?? 0.25 };
      commit('Background');
      ed.render();
      buildFormat();
    });
    const bgReset = h('button.btn.small', 'Theme');
    bgReset.addEventListener('click', () => { delete s.bg; commit('Background'); ed.render(); buildFormat(); });
    fpBody.append(
      section('Layout', layout),
      section('Background',
        colorField('Colour', bg.color || null, (c) => { s.bg = { ...bg, color: c === 'none' ? undefined : c, image: undefined }; commit('Background'); ed.render(); buildFormat(); }, { theme: false }),
        colorField('Fade to', bg.gradient || null, (c) => { s.bg = { ...bg, color: bg.color || '#1b1f1c', gradient: c === 'none' ? undefined : c }; commit('Background'); ed.render(); buildFormat(); }, { theme: false }),
        bg.image ? numberField('Darken', (bg.overlay || 0) * 100, (v, live) => { s.bg.overlay = clamp(v, 0, 90) / 100; ed.render(); if (!live) commit('Background'); }, { min: 0, max: 90, unit: '%' }) : null,
        h('div.row', bgImg, bgReset)),
      section('Transition', trans, dur, allBtn),
      section('Show', h('label.check', hidden, 'Skip this slide in the show')),
    );
    return;
  }
  const it = items[0];
  const many = items.length > 1;
  fpTitle.textContent = many ? `${items.length} items` : { text: 'Text box', shape: 'Shape', image: 'Picture', chart: 'Chart', table: 'Table', line: 'Line' }[it.type];
  const S = it.style || {};
  const upd = (patch, label = 'Format') => ed.setStyle(patch, label);
  const pos = !many ? section('Position and size',
    h('div.fp-grid', numberField('X', it.x, (v, live) => { it.x = v; live ? ed.renderSoon() : (commit('Move'), ed.render()); }), numberField('Y', it.y, (v, live) => { it.y = v; live ? ed.renderSoon() : (commit('Move'), ed.render()); }),
      numberField('W', it.w, (v, live) => { it.w = Math.max(4, v); live ? ed.renderSoon() : (commit('Resize'), ed.render()); }), numberField('H', it.h, (v, live) => { it.h = Math.max(4, v); live ? ed.renderSoon() : (commit('Resize'), ed.render()); }),
      numberField('Turn', it.rot || 0, (v, live) => { it.rot = ((v % 360) + 360) % 360; live ? ed.renderSoon() : (commit('Rotate'), ed.render()); }, { min: -360, max: 360, unit: '°' }),
      numberField('Opacity', (S.opacity ?? 1) * 100, (v, live) => { it.style = { ...S, opacity: clamp(v, 0, 100) / 100 }; live ? ed.renderSoon() : (commit('Opacity'), ed.render()); }, { min: 0, max: 100, unit: '%' })),
    h('div.row', tb({ icon: 'lock', tip: 'Lock in place', on: () => !!it.locked, run: () => { it.locked = !it.locked; commit('Lock'); ed.drawSelection(); refresh(); } }),
      tb({ icon: 'flipH', tip: 'Flip horizontally', run: () => { it.flipH = !it.flipH; commit('Flip'); ed.render(); } }), tb({ icon: 'flipV', tip: 'Flip vertically', run: () => { it.flipV = !it.flipV; commit('Flip'); ed.render(); } }),
      tb({ icon: 'bringFront', tip: 'Bring to front', run: () => ed.order('front') }), tb({ icon: 'sendBack', tip: 'Send to back', run: () => ed.order('back') }))) : null;
  const arrange = section('Arrange', h('div.row', { style: { flexWrap: 'wrap', gap: '2px' } },
    ...['left', 'center', 'right', 'top', 'middle', 'bottom'].map((a) => tb({ icon: { left: 'alignObjLeft', center: 'alignObjCenter', right: 'alignObjRight', top: 'alignObjTop', middle: 'alignObjMiddle', bottom: 'alignObjBottom' }[a], tip: `Align ${a}${many ? '' : ' on the slide'}`, run: () => ed.align(a) })),
    many ? tb({ icon: 'distributeH', tip: 'Space evenly across', run: () => ed.distribute('h') }) : null, many ? tb({ icon: 'distributeV', tip: 'Space evenly down', run: () => ed.distribute('v') }) : null,
    many ? tb({ icon: 'group', tip: 'Group (Ctrl+G)', run: () => ed.group() }) : null, it.group ? tb({ icon: 'ungroup', tip: 'Ungroup', run: () => ed.ungroup() }) : null));
  const hasText = it.type === 'text' || it.type === 'shape' || it.type === 'table';
  const fontBox2 = combo({ values: () => fontList, value: S.font && !['heading', 'body'].includes(S.font) ? S.font : '', width: 150, itemStyle: (f) => ({ fontFamily: `"${f}"` }), onCommit: (v) => inlineStyle('font-family', `"${v}"`, 'font', v.trim() || undefined, 'Font') });
  const text = hasText ? section('Text',
    h('div.row', fontBox2, combo({ values: FONT_SIZES, value: String(S.size || 24), width: 64, numeric: true, min: 6, max: 400, onCommit: (v) => { const n = parseFloat(v); if (n > 0) inlineStyle('font-size', `${n}px`, 'size', n, 'Font size'); } })),
    h('div.row', { style: { gap: '2px' } }, tb('fmt.bold'), tb('fmt.italic'), tb('fmt.underline'), sep(),
      ...['left', 'center', 'right', 'justify'].map((a) => tb({ icon: { left: 'alignLeft', center: 'alignCenter', right: 'alignRight', justify: 'alignJustify' }[a], tip: `Align ${a}`, on: () => (S.align || 'left') === a, run: () => upd({ align: a }, 'Align') }))),
    h('div.row', { style: { gap: '2px' } }, ...['top', 'middle', 'bottom'].map((a) => tb({ icon: { top: 'alignObjTop', middle: 'alignObjMiddle', bottom: 'alignObjBottom' }[a], tip: `Text at the ${a}`, on: () => (S.valign || 'top') === a, run: () => upd({ valign: a }, 'Align') })), sep(),
      tb({ icon: 'listBullets', tip: 'Bullets', on: () => !!S.bullets, run: () => upd({ bullets: !S.bullets || undefined, numbered: undefined }, 'Bullets') }), tb({ icon: 'listNumbers', tip: 'Numbers', on: () => !!S.numbered, run: () => upd({ numbered: !S.numbered || undefined, bullets: undefined }, 'Numbers') }),
      tb({ icon: 'columns', tip: 'Two columns', on: () => S.columns === 2, run: () => upd({ columns: S.columns === 2 ? undefined : 2 }, 'Columns') })),
    colorField('Colour', S.color || null, (c) => inlineStyle('color', themeColor(THEMES[pres.theme], c), 'color', c === 'none' ? undefined : c, 'Text colour')),
    numberField('Line spacing', S.lineHeight || 1.3, (v) => upd({ lineHeight: clamp(v, 0.8, 3) }, 'Line spacing'), { step: 0.05, min: 0.8, max: 3 }),
    numberField('Padding', S.padding ?? (it.type === 'shape' ? 16 : 8), (v) => upd({ padding: clamp(v, 0, 200) }, 'Padding'), { min: 0, max: 200 }),
    h('label.check', h('input', { type: 'checkbox', checked: S.autofit !== false, onchange: (e) => upd({ autofit: e.target.checked ? undefined : false }, 'Fit text') }), 'Shrink text to fit the box'),
    h('label.check', h('input', { type: 'checkbox', checked: !!S.textShadow, onchange: (e) => upd({ textShadow: e.target.checked || undefined }, 'Shadow') }), 'Text shadow')) : null;
  const fill = it.type === 'shape' || it.type === 'text' ? section('Fill and line',
    colorField('Fill', S.fill || (it.type === 'shape' ? 'accent0' : null), (c) => upd({ fill: c }, 'Fill')),
    colorField('Fade to', S.gradient || null, (c) => upd({ gradient: c === 'none' ? undefined : c }, 'Gradient')),
    colorField('Line', S.stroke || null, (c) => upd({ stroke: c }, 'Line')),
    numberField('Line width', S.strokeWidth || 2, (v) => upd({ strokeWidth: clamp(v, 0, 60) }, 'Line'), { min: 0, max: 60 }),
    it.type === 'text' || it.shape === 'roundRect' ? numberField('Corners', S.radius || 0, (v) => upd({ radius: clamp(v, 0, 400) || undefined }, 'Corners'), { min: 0, max: 400 }) : null,
    h('label.check', h('input', { type: 'checkbox', checked: !!S.shadow, onchange: (e) => upd({ shadow: e.target.checked || undefined }, 'Shadow') }), 'Drop shadow'),
    it.type === 'shape' ? h('label.fp-field', h('span', 'Shape'), select({ options: SHAPES.map(([v, l]) => ({ value: v, label: l })), value: it.shape, onChange: (v) => { for (const x of items) if (x.type === 'shape') x.shape = v; commit('Shape'); ed.render(); } })) : null) : null;
  const line = it.type === 'line' ? section('Line', colorField('Colour', S.stroke || 'text', (c) => upd({ stroke: c }, 'Line')), numberField('Width', S.strokeWidth || 4, (v) => upd({ strokeWidth: clamp(v, 1, 60) }, 'Line'), { min: 1, max: 60 }),
    h('label.fp-field', h('span', 'Style'), select({ options: [{ value: '', label: 'Solid' }, { value: 'dash', label: 'Dashed' }, { value: 'dot', label: 'Dotted' }], value: S.dash || '', onChange: (v) => upd({ dash: v || undefined }, 'Line') })),
    h('label.check', h('input', { type: 'checkbox', checked: !!S.arrow, onchange: (e) => upd({ arrow: e.target.checked || undefined }, 'Arrow') }), 'Arrow head')) : null;
  const image = it.type === 'image' ? section('Picture',
    h('label.fp-field', h('span', 'Fit'), select({ options: [{ value: 'cover', label: 'Fill the box' }, { value: 'contain', label: 'Show it all' }, { value: 'fill', label: 'Stretch' }], value: S.fit || 'cover', onChange: (v) => upd({ fit: v }, 'Fit') })),
    numberField('Corners', S.radius || 0, (v) => upd({ radius: clamp(v, 0, 1000) || undefined }, 'Corners'), { min: 0, max: 1000 }),
    colorField('Border', S.border || null, (c) => upd({ border: c === 'none' ? undefined : c }, 'Border')),
    h('label.fp-field', h('span', 'Look'), select({ options: [['', 'Normal'], ['grayscale(1)', 'Black and white'], ['sepia(.8)', 'Sepia'], ['saturate(1.6)', 'Vivid'], ['contrast(1.25)', 'More contrast'], ['brightness(1.2)', 'Brighter'], ['blur(4px)', 'Blurred']].map(([v, l]) => ({ value: v, label: l })), value: S.filter || '', onChange: (v) => upd({ filter: v || undefined }, 'Picture look') })),
    h('label.check', h('input', { type: 'checkbox', checked: !!S.shadow, onchange: (e) => upd({ shadow: e.target.checked || undefined }, 'Shadow') }), 'Drop shadow'),
    h('div.row', h('button.btn.small', { onclick: () => insertPicture(it) }, 'Replace…'), h('button.btn.small', { onclick: () => altText(it) }, 'Alt text…'))) : null;
  const chart = it.type === 'chart' ? section('Chart', h('label.fp-field', h('span', 'Type'), select({ options: CHART_TYPES.map(([v, l]) => ({ value: v, label: l })), value: it.chart.type, onChange: (v) => { it.chart.type = v; commit('Chart'); ed.render(); } })),
    h('button.btn.small', { onclick: () => chartDialog(it) }, 'Edit data…')) : null;
  const table = it.type === 'table' ? section('Table', h('button.btn.small', { onclick: () => tableDialog(it) }, 'Edit table…'),
    colorField('Header', S.header || 'accent0', (c) => upd({ header: c }, 'Table')), h('label.check', h('input', { type: 'checkbox', checked: !!S.striped, onchange: (e) => upd({ striped: e.target.checked || undefined }, 'Table') }), 'Striped rows')) : null;
  const anim = it.anim || {};
  const animSel = select({ options: [['none', 'None'], ['fade', 'Fade in'], ['fly', 'Fly in from below'], ['flyLeft', 'Fly in from the left'], ['zoom', 'Zoom in'], ['pop', 'Pop'], ['wipe', 'Wipe']].map(([v, l]) => ({ value: v, label: l })), value: anim.type || 'none',
    onChange: (v) => {
      const order = Math.max(0, ...ed.slide.items.filter((x) => x.anim && x.anim.type !== 'none').map((x) => x.anim.order || 0)) + 1;
      for (const x of items) x.anim = v === 'none' ? undefined : { type: v, duration: (x.anim && x.anim.duration) || 0.5, order: (x.anim && x.anim.order) || order };
      commit('Animation');
      buildFormat();
    } });
  const animation = section('Animation', animSel, anim.type && anim.type !== 'none' ? numberField('Seconds', anim.duration || 0.5, (v) => { for (const x of items) if (x.anim) x.anim.duration = clamp(v, 0.1, 5); commit('Animation'); }, { step: 0.1, min: 0.1, max: 5 }) : null,
    anim.type && anim.type !== 'none' ? numberField('Order', anim.order || 1, (v) => { for (const x of items) if (x.anim) x.anim.order = clamp(Math.round(v), 1, 99); commit('Animation'); }, { min: 1, max: 99 }) : null,
    h('div.muted', { style: { fontSize: '12px' } }, 'In the show, animated items appear one click at a time, in order.'));
  const link = !many ? section('Link', h('div.row', h('input.input', { value: it.link || '', placeholder: 'https://… opens when clicked in the show', spellcheck: false, style: { flex: 1 }, onchange: (e) => { const v = e.target.value.trim(); it.link = v ? (/^(https?:|mailto:)/i.test(v) ? v : `https://${v}`) : undefined; commit('Link'); } }))) : null;
  fpBody.append(...[text, fill, line, image, chart, table, pos, arrange, animation, link].filter(Boolean));
}

let fontList = knownFonts();
allFonts().then((l) => { fontList = l; });

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------
async function chartDialog(it) {
  const c = it.chart;
  const table = h('table.data-grid');
  const rows = [['', ...c.series.map((s) => s.name)], ...c.categories.map((cat, i) => [cat, ...c.series.map((s) => (s.values[i] ?? ''))])];
  const render = () => {
    table.replaceChildren(...rows.map((row, r) => h('tr', ...row.map((v, ci) => {
      const td = h('td', { contentEditable: 'true', spellcheck: false, class: r === 0 || ci === 0 ? 'head' : '' }, String(v));
      td.addEventListener('input', () => { rows[r][ci] = td.textContent; });
      return td;
    }))));
  };
  render();
  const addRow = h('button.btn.small', '+ Row');
  addRow.addEventListener('click', () => { rows.push([`Item ${rows.length}`, ...rows[0].slice(1).map(() => '')]); render(); });
  const addCol = h('button.btn.small', '+ Series');
  addCol.addEventListener('click', () => { rows.forEach((r, i) => r.push(i ? '' : `Series ${r.length}`)); render(); });
  const delRow = h('button.btn.small', '− Row');
  delRow.addEventListener('click', () => { if (rows.length > 2) rows.pop(); render(); });
  const delCol = h('button.btn.small', '− Series');
  delCol.addEventListener('click', () => { if (rows[0].length > 2) rows.forEach((r) => r.pop()); render(); });
  const title = h('input.input', { value: c.title || '', placeholder: 'Chart title' });
  const type = select({ options: CHART_TYPES.map(([v, l]) => ({ value: v, label: l })), value: c.type, onChange: () => {} });
  const labels = h('input', { type: 'checkbox', checked: !!c.dataLabels });
  const pasteHint = h('div.muted', { style: { fontSize: '12px' } }, 'Tip: paste a block of cells from Snake’s Spreadsheets or Excel into the first cell.');
  table.addEventListener('paste', (e) => {
    const text = e.clipboardData.getData('text/plain');
    if (!text.includes('\t') && !text.includes('\n')) return;
    e.preventDefault();
    const pasted = text.replace(/\r/g, '').trim().split('\n').map((l) => l.split('\t'));
    rows.length = 0;
    rows.push(...pasted);
    render();
  });
  const ok = await modal({ title: 'Chart data', body: h('div.col', { style: { minWidth: '560px' } }, h('div.row', title, type, h('label.check', labels, 'Values on bars')), h('div', { style: { maxHeight: '320px', overflow: 'auto' } }, table), h('div.row', addRow, delRow, addCol, delCol), pasteHint),
    buttons: [{ label: 'Cancel', value: false }, { label: 'Apply', value: true, primary: true }] });
  if (!ok) return;
  it.chart = { ...c, type: type.value, title: title.value, dataLabels: labels.checked, categories: rows.slice(1).map((r) => r[0]), series: rows[0].slice(1).map((name, si) => ({ name, values: rows.slice(1).map((r) => { const n = Number(String(r[si + 1]).replace(/[,$%]/g, '')); return Number.isFinite(n) && r[si + 1] !== '' ? n : null; }) })) };
  commit('Chart data');
  ed.render();
}

async function tableDialog(it) {
  const rows = it.rows.map((r) => r.map((c) => textOf(c.html)));
  const table = h('table.data-grid');
  const render = () => {
    table.replaceChildren(...rows.map((row, r) => h('tr', ...row.map((v, c) => {
      const td = h('td', { contentEditable: 'true', class: r === 0 ? 'head' : '' }, v);
      td.addEventListener('input', () => { rows[r][c] = td.textContent; });
      return td;
    }))));
  };
  render();
  const btn = (label, fn) => { const b = h('button.btn.small', label); b.addEventListener('click', () => { fn(); render(); }); return b; };
  const ok = await modal({ title: 'Table', body: h('div.col', { style: { minWidth: '520px' } }, h('div', { style: { maxHeight: '340px', overflow: 'auto' } }, table),
    h('div.row', btn('+ Row', () => rows.push(rows[0].map(() => ''))), btn('− Row', () => rows.length > 1 && rows.pop()), btn('+ Column', () => rows.forEach((r) => r.push(''))), btn('− Column', () => rows[0].length > 1 && rows.forEach((r) => r.pop())))),
  buttons: [{ label: 'Cancel', value: false }, { label: 'Apply', value: true, primary: true }] });
  if (!ok) return;
  it.rows = rows.map((r) => r.map((t) => ({ html: escapeHtml(t) })));
  it.h = Math.max(it.h, rows.length * ((it.style.size || 20) * 2.2));
  commit('Table');
  ed.render();
}

async function altText(it) {
  const v = await promptBox('Alternative text', { label: 'Describe the picture for people who cannot see it.', value: it.alt || '', multiline: true });
  if (v !== null) { it.alt = v; commit('Alt text'); }
}

function themeGallery() {
  const grid = h('div.theme-grid');
  for (const [id, t] of Object.entries(THEMES)) {
    const card = h(`button.theme-card${pres.theme === id ? '.on' : ''}`, { style: { background: t.bg } },
      h('div', { style: { color: t.title, fontFamily: t.heading, fontWeight: t.titleWeight, fontSize: '15px', textTransform: t.upper ? 'uppercase' : '' } }, t.name),
      h('div', { style: { color: t.text, fontFamily: t.body, fontSize: '10px' } }, 'Body text'),
      h('div.row', { style: { gap: '3px', marginTop: '4px' } }, ...t.accents.slice(0, 5).map((c) => h('span', { style: { width: '10px', height: '10px', borderRadius: '2px', background: c } }))));
    card.addEventListener('click', () => { closeMenus(); setTheme(id); });
    grid.append(card);
  }
  return grid;
}

// ---------------------------------------------------------------------------
// Slide show and presenter view
// ---------------------------------------------------------------------------
let show = null;
function startShow(from = 0) {
  saveNotes();
  ed.stopEditing();
  if (show) return;
  const overlay = h('div.show-overlay');
  document.body.append(overlay);
  const visible = pres.slides.filter((s) => !s.hidden);
  const idx = Math.max(0, visible.indexOf(pres.slides[from]));
  show = new Show({ pres, root: overlay, index: idx });
  show.onLink = (url) => host.openExternal(url);
  show.onEnd = () => { overlay.remove(); show = null; host.win.setFullScreen(false); window.removeEventListener('keydown', onKey, true); };
  const onKey = (e) => { if (show && show.key(e)) { e.preventDefault(); e.stopPropagation(); } };
  window.addEventListener('keydown', onKey, true);
  if (inElectron) host.win.setFullScreen(true);
  else overlay.requestFullscreen().catch(() => {});
}

async function presenterView() {
  saveNotes();
  ed.stopEditing();
  const channel = new BroadcastChannel(`snake-slides-${file.id}`);
  const visible = pres.slides.filter((s) => !s.hidden);
  const start = Math.max(0, visible.indexOf(ed.slide));
  const box = h('div.presenter');
  const stage = h('div.pv-current');
  const nextBox = h('div.pv-next');
  const notesBox = h('div.pv-notes');
  const timer = h('div.pv-timer', '0:00');
  const clock = h('div.pv-clock');
  const counter = h('div.pv-counter');
  const strip = h('div.pv-strip');
  const btn = (label, fn, tip) => { const b = h('button.btn', { 'data-tip': tip || '' }, label); b.addEventListener('click', fn); return b; };
  const bar = h('div.pv-bar', btn('‹ Previous', () => sh.prev()), btn('Next ›', () => sh.next()), btn('Black screen', () => sh.setMode(sh.mode === 'black' ? null : 'black'), 'B'),
    btn('Laser', () => sh.setTool(sh.tool === 'laser' ? null : 'laser'), 'L'), btn('Pen', () => sh.setTool(sh.tool === 'pen' ? null : 'pen'), 'P'), btn('Restart timer', () => { t0 = Date.now(); }), btn('End show', () => sh.end(), 'Esc'));
  box.append(h('div.pv-main', stage, h('div.pv-side', h('div.pv-label', 'Next'), nextBox, h('div.pv-label', 'Notes'), notesBox)), h('div.pv-foot', timer, counter, clock, bar), strip);
  document.body.append(box);
  let t0 = Date.now();
  const tick = setInterval(() => { timer.textContent = fmtTime((Date.now() - t0) / 1000); clock.textContent = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }, 500);
  const sh = new Show({ pres, root: stage, index: start, controls: false,
    onState: (s) => {
      channel.postMessage({ type: 'state', state: s });
      const cur = sh.slides[s.index];
      notesBox.textContent = cur ? cur.notes || '(no notes)' : '';
      counter.textContent = `Slide ${s.index + 1} of ${sh.slides.length}${s.step < sh.steps(cur).length ? ` · ${sh.steps(cur).length - s.step} to reveal` : ''}`;
      const nxt = sh.slides[s.index + 1];
      nextBox.replaceChildren();
      if (nxt) {
        const el = renderSlide(nxt, pres, {});
        const scale = (nextBox.clientWidth || 300) / pres.size.w;
        el.style.transform = `scale(${scale})`;
        el.style.transformOrigin = '0 0';
        nextBox.style.height = `${pres.size.h * scale}px`;
        nextBox.append(el);
        requestAnimationFrame(() => settle(el, scale));
      } else nextBox.append(h('div.muted', 'End of the show'));
      for (const [i, th] of [...strip.children].entries()) th.classList.toggle('on', i === s.index);
    } });
  sh.slides.forEach((s, i) => {
    const el = renderSlide(s, pres, {});
    const scale = 120 / pres.size.w;
    el.style.transform = `scale(${scale})`;
    el.style.transformOrigin = '0 0';
    const th = h('div.pv-thumb', { style: { height: `${pres.size.h * scale}px` } }, el, h('span', String(i + 1)));
    th.addEventListener('click', () => sh.goto(i));
    strip.append(th);
  });
  notesBox.addEventListener('wheel', (e) => { if (!e.ctrlKey) return; e.preventDefault(); const z = clamp(settings.get('pvNotes', 20) + (e.deltaY < 0 ? 2 : -2), 10, 64); settings.set('pvNotes', z); notesBox.style.fontSize = `${z}px`; }, { passive: false });
  notesBox.style.fontSize = `${settings.get('pvNotes', 20)}px`;
  let n0 = 20;
  pinch(notesBox, {
    begin: () => { n0 = settings.get('pvNotes', 20); },
    change: (scale) => { const z = clamp(Math.round(n0 * scale), 10, 64); settings.set('pvNotes', z); notesBox.style.fontSize = `${z}px`; },
  });
  const onKey = (e) => { if (sh.key(e)) { e.preventDefault(); e.stopPropagation(); } };
  window.addEventListener('keydown', onKey, true);
  channel.onmessage = (m) => {
    if (m.data.type === 'hello') channel.postMessage({ type: 'deck', pres, state: sh.state() });
    if (m.data.type === 'key') sh.key({ key: m.data.key });
  };
  sh.onEnd = () => {
    clearInterval(tick);
    channel.postMessage({ type: 'end' });
    channel.close();
    box.remove();
    window.removeEventListener('keydown', onKey, true);
  };
  // The audience window, on the other screen when there is one.
  try { await host.win.openPage(`show.html?ch=${encodeURIComponent(file.id)}`, { display: 'other', fullscreen: true }); } catch (err) { errorToast(err); }
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
const C = (id, label, keys, run, extra = {}) => ({ id, label, keys, run, ...extra });
const hasSel = () => ed.sel.size > 0;
const notEditing = () => !ed.editing;
commands.register(
  C('file.new', 'New Presentation', 'Ctrl+N', () => newDeck(), { icon: 'new', category: 'File' }),
  C('file.open', 'Open…', 'Ctrl+O', () => openDialog(), { icon: 'open', category: 'File' }),
  C('file.save', 'Save', 'Ctrl+S', () => save(), { icon: 'save', category: 'File' }),
  C('file.saveAs', 'Save As…', 'Ctrl+Shift+S', () => saveAs(), { icon: 'saveAs', category: 'File' }),
  C('file.pptx', 'Export as PowerPoint (.pptx)…', null, () => saveAs('pptx'), { icon: 'export', category: 'File' }),
  C('file.pdf', 'Export as PDF…', 'Ctrl+Shift+E', () => exportPdf(), { icon: 'pdf', category: 'File' }),
  C('file.png', 'Export This Slide as a Picture…', null, () => exportPng(), { icon: 'image', category: 'File' }),
  C('file.print', 'Print…', 'Ctrl+P', () => exportPdf(true), { icon: 'print', category: 'File' }),
  C('file.home', 'Start Screen', null, () => start.show(), { icon: 'home', category: 'File' }),
  C('edit.undo', 'Undo', 'Ctrl+Z', () => { if (ed.editing) { document.execCommand('undo'); return; } history.undo(); }, { icon: 'undo', category: 'Edit', inputs: true, when: () => history.canUndo || !!ed.editing }),
  C('edit.redo', 'Redo', ['Ctrl+Y', 'Ctrl+Shift+Z'], () => { if (ed.editing) { document.execCommand('redo'); return; } history.redo(); }, { icon: 'redo', category: 'Edit', inputs: true }),
  C('edit.cut', 'Cut', 'Ctrl+X', () => { copyItems(); ed.remove(); }, { icon: 'cut', category: 'Edit', when: () => hasSel() && notEditing() }),
  C('edit.copy', 'Copy', 'Ctrl+C', () => copyItems(), { icon: 'copy', category: 'Edit', when: () => hasSel() && notEditing() }),
  C('edit.paste', 'Paste', null, () => pasteFromMenu(), { icon: 'paste', category: 'Edit' }),
  C('edit.duplicate', 'Duplicate', 'Ctrl+D', () => (ed.sel.size ? ed.duplicate() : duplicateSlides()), { icon: 'duplicate', category: 'Edit', when: notEditing }),
  C('edit.delete', 'Delete', ['Delete', 'Backspace'], () => ed.remove(), { icon: 'trash', category: 'Edit', when: () => hasSel() && notEditing() }),
  C('edit.selectAll', 'Select Everything on the Slide', 'Ctrl+A', () => ed.select(ed.slide.items.map((it) => it.id)), { category: 'Edit', when: notEditing }),
  C('edit.deselect', 'Deselect', 'Escape', () => { ed.select([]); }, { category: 'Edit', when: () => hasSel() && notEditing() }),
  C('edit.left', 'Nudge Left', 'ArrowLeft', () => ed.nudge(-1, 0), { category: 'Arrange', hidden: true, when: () => hasSel() && notEditing() }),
  C('edit.right', 'Nudge Right', 'ArrowRight', () => ed.nudge(1, 0), { category: 'Arrange', hidden: true, when: () => hasSel() && notEditing() }),
  C('edit.up', 'Nudge Up', 'ArrowUp', () => ed.nudge(0, -1), { category: 'Arrange', hidden: true, when: () => hasSel() && notEditing() }),
  C('edit.down', 'Nudge Down', 'ArrowDown', () => ed.nudge(0, 1), { category: 'Arrange', hidden: true, when: () => hasSel() && notEditing() }),
  C('edit.left10', 'Nudge Left More', 'Shift+ArrowLeft', () => ed.nudge(-10, 0), { category: 'Arrange', hidden: true, when: () => hasSel() && notEditing() }),
  C('edit.right10', 'Nudge Right More', 'Shift+ArrowRight', () => ed.nudge(10, 0), { category: 'Arrange', hidden: true, when: () => hasSel() && notEditing() }),
  C('edit.up10', 'Nudge Up More', 'Shift+ArrowUp', () => ed.nudge(0, -10), { category: 'Arrange', hidden: true, when: () => hasSel() && notEditing() }),
  C('edit.down10', 'Nudge Down More', 'Shift+ArrowDown', () => ed.nudge(0, 10), { category: 'Arrange', hidden: true, when: () => hasSel() && notEditing() }),
  C('edit.editText', 'Edit Text', ['F2', 'Enter'], () => { const it = ed.selected[0]; if (it && (it.type === 'text' || it.type === 'shape')) ed.startEditing(it); }, { category: 'Edit', when: () => ed.sel.size === 1 && notEditing() }),
  C('fmt.bold', 'Bold', 'Ctrl+B', () => textCmd('bold', 'bold', 'Bold'), { icon: 'bold', category: 'Text', inputs: true, checked: () => (ed.editing ? document.queryCommandState('bold') : !!st().bold) }),
  C('fmt.italic', 'Italic', 'Ctrl+I', () => textCmd('italic', 'italic', 'Italic'), { icon: 'italic', category: 'Text', inputs: true, checked: () => (ed.editing ? document.queryCommandState('italic') : !!st().italic) }),
  C('fmt.underline', 'Underline', 'Ctrl+U', () => textCmd('underline', 'underline', 'Underline'), { icon: 'underline', category: 'Text', inputs: true, checked: () => (ed.editing ? document.queryCommandState('underline') : !!st().underline) }),
  C('fmt.grow', 'Bigger Text', 'Ctrl+]', () => { const s = st().size || 24; inlineStyle('font-size', `${FONT_SIZES.find((x) => x > s) || s + 12}px`, 'size', FONT_SIZES.find((x) => x > s) || s + 12, 'Font size'); }, { icon: 'plus', category: 'Text', inputs: true }),
  C('fmt.shrink', 'Smaller Text', 'Ctrl+[', () => { const s = st().size || 24; const n = [...FONT_SIZES].reverse().find((x) => x < s) || Math.max(6, s - 2); inlineStyle('font-size', `${n}px`, 'size', n, 'Font size'); }, { icon: 'minus', category: 'Text', inputs: true }),
  C('fmt.center', 'Centre Text', 'Ctrl+E', () => (ed.editing ? document.execCommand('justifyCenter') : ed.setStyle({ align: 'center' }, 'Align')), { icon: 'alignCenter', category: 'Text', inputs: true }),
  C('fmt.left', 'Align Text Left', 'Ctrl+L', () => (ed.editing ? document.execCommand('justifyLeft') : ed.setStyle({ align: 'left' }, 'Align')), { icon: 'alignLeft', category: 'Text', inputs: true }),
  C('fmt.right', 'Align Text Right', 'Ctrl+R', () => (ed.editing ? document.execCommand('justifyRight') : ed.setStyle({ align: 'right' }, 'Align')), { icon: 'alignRight', category: 'Text', inputs: true }),
  C('fmt.bullets', 'Bullets', 'Ctrl+Shift+8', () => (ed.editing ? document.execCommand('insertUnorderedList') : ed.setStyle({ bullets: !st().bullets || undefined }, 'Bullets')), { icon: 'listBullets', category: 'Text', inputs: true }),
  C('arr.front', 'Bring to Front', 'Ctrl+Shift+]', () => ed.order('front'), { icon: 'bringFront', category: 'Arrange', when: hasSel }),
  C('arr.back', 'Send to Back', 'Ctrl+Shift+[', () => ed.order('back'), { icon: 'sendBack', category: 'Arrange', when: hasSel }),
  C('arr.forward', 'Bring Forward', null, () => ed.order('forward'), { category: 'Arrange', when: hasSel }),
  C('arr.backward', 'Send Backward', null, () => ed.order('backward'), { category: 'Arrange', when: hasSel }),
  C('arr.group', 'Group', 'Ctrl+G', () => ed.group(), { icon: 'group', category: 'Arrange', when: () => ed.sel.size > 1 }),
  C('arr.ungroup', 'Ungroup', 'Ctrl+Shift+G', () => ed.ungroup(), { icon: 'ungroup', category: 'Arrange', when: hasSel }),
  C('ins.text', 'Text Box', null, () => addText(), { icon: 'textBox', category: 'Insert' }),
  C('ins.picture', 'Picture…', null, () => insertPicture(), { icon: 'image', category: 'Insert' }),
  C('ins.table', 'Table', null, () => addTable(), { icon: 'table', category: 'Insert' }),
  C('ins.chart', 'Chart', null, () => addChart(), { icon: 'chart', category: 'Insert' }),
  C('ins.line', 'Line', null, () => addLine(false), { icon: 'line', category: 'Insert' }),
  C('ins.arrow', 'Arrow', null, () => addLine(true), { icon: 'arrow', category: 'Insert' }),
  C('slide.new', 'New Slide', 'Ctrl+M', () => newSlide(), { icon: 'plus', category: 'Slide' }),
  C('slide.duplicate', 'Duplicate Slide', null, () => duplicateSlides(), { icon: 'duplicate', category: 'Slide' }),
  C('slide.delete', 'Delete Slide', null, () => deleteSlides(), { icon: 'trash', category: 'Slide' }),
  C('slide.hide', 'Hide Slide in the Show', null, () => { ed.slide.hidden = !ed.slide.hidden; commit('Hide slide'); drawSorter(); }, { icon: 'eyeOff', category: 'Slide', checked: () => !!(ed.slide && ed.slide.hidden) }),
  C('slide.next', 'Next Slide', 'PageDown', () => goto(ed.index + 1), { category: 'Slide', when: notEditing }),
  C('slide.prev', 'Previous Slide', 'PageUp', () => goto(ed.index - 1), { category: 'Slide', when: notEditing }),
  C('slide.numbers', 'Slide Numbers', null, () => { pres.showNumbers = !pres.showNumbers; commit('Slide numbers'); ed.render(); }, { icon: 'pageNumber', category: 'Slide', checked: () => !!pres.showNumbers }),
  C('show.start', 'Start the Slide Show', 'F5', () => startShow(0), { icon: 'present', category: 'Show' }),
  C('show.current', 'Show From This Slide', 'Shift+F5', () => startShow(ed.index), { icon: 'play', category: 'Show' }),
  C('show.presenter', 'Presenter View (notes, timer, next slide)', 'Alt+F5', () => presenterView(), { icon: 'notes', category: 'Show' }),
  C('view.zoomIn', 'Zoom In', 'Ctrl+=', () => ed.setZoom(stepZoom(ed.zoom, 1, 0.1, 6)), { icon: 'zoomIn', category: 'View' }),
  C('view.zoomOut', 'Zoom Out', 'Ctrl+-', () => ed.setZoom(stepZoom(ed.zoom, -1, 0.1, 6)), { icon: 'zoomOut', category: 'View' }),
  C('view.fit', 'Fit the Slide', 'Ctrl+0', () => ed.fit(), { icon: 'fit', category: 'View' }),
  C('view.notes', 'Speaker Notes', null, () => togglePanel(notesPanel, notesSplit, 'notes'), { icon: 'notes', category: 'View', checked: () => !notesPanel.classList.contains('hidden') }),
  C('view.format', 'Format Panel', 'Ctrl+Shift+1', () => togglePanel(format, formatSplit, 'format'), { icon: 'sliders', category: 'View', checked: () => !format.classList.contains('hidden') }),
  C('view.sorter', 'Slide List', null, () => togglePanel(sorter, sorterSplit, 'sorter'), { icon: 'list', category: 'View', checked: () => !sorter.classList.contains('hidden') }),
  C('view.snap', 'Snap to Guides', null, () => { settings.set('snap', !settings.get('snap', true)); refresh(); }, { icon: 'magnet', category: 'View', checked: () => settings.get('snap', true) }),
);

function togglePanel(panel, split, key) {
  if (toggleDrawer(panel)) { if (panel === format) buildFormat(); return; } // a phone: the panel slides in
  const hide = !panel.classList.contains('hidden');
  panel.classList.toggle('hidden', hide);
  split.classList.toggle('hidden', hide);
  settings.set(key, !hide);
  if (!hide && panel === format) buildFormat();
  ed.fitMode && setTimeout(() => ed.fit(), 0);
  refresh();
}

// ---- clipboard for items ----
let itemClip = null;
function copyItems() {
  if (!ed.sel.size) return;
  const items = JSON.parse(JSON.stringify(ed.selected));
  const assets = {};
  for (const it of items) if (it.asset) assets[it.asset] = pres.assets[it.asset];
  itemClip = { items, assets };
  const text = items.map((it) => textOf(it.html)).filter(Boolean).join('\n');
  navigator.clipboard.writeText(`${text}⁣snake-items`).catch(() => {});
}
function pasteItems() {
  if (!itemClip) return false;
  Object.assign(pres.assets, itemClip.assets);
  const copies = itemClip.items.map((it) => ({ ...JSON.parse(JSON.stringify(it)), id: uid('it'), x: it.x + 20, y: it.y + 20 }));
  itemClip.items = copies.map((c) => JSON.parse(JSON.stringify(c)));
  ed.slide.items.push(...copies);
  ed.sel = new Set(copies.map((c) => c.id));
  commit('Paste');
  ed.render();
  ed.onSelect();
  return true;
}
document.addEventListener('paste', async (e) => {
  if (ed.editing || e.target.closest('input, textarea, [contenteditable="true"]')) return;
  if (start.visible) return;
  e.preventDefault();
  const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'));
  if (files.length) { for (const f of files) await addImageUrl(await blobToDataUrl(f)); return; }
  const text = e.clipboardData.getData('text/plain');
  if (itemClip && text.endsWith('⁣snake-items')) { pasteItems(); return; }
  if (text.trim()) {
    const it = ed.add({ type: 'text', ...center0(640, Math.min(500, 60 + text.split('\n').length * 36)), html: text.split('\n').map((l) => `<p>${escapeHtml(l) || '<br>'}</p>`).join(''), style: { size: 28 } });
    void it;
  }
});
async function pasteFromMenu() {
  try {
    const items = await navigator.clipboard.read();
    for (const it of items) {
      const type = it.types.find((t) => t.startsWith('image/'));
      if (type) { await addImageUrl(await blobToDataUrl(await it.getType(type))); return; }
    }
    const text = await navigator.clipboard.readText();
    if (itemClip && text.endsWith('⁣snake-items')) { pasteItems(); return; }
    if (text.trim()) ed.add({ type: 'text', ...center0(640, 120), html: text.split('\n').map((l) => `<p>${escapeHtml(l) || '<br>'}</p>`).join(''), style: { size: 28 } });
  } catch { if (!pasteItems()) toast('Press Ctrl+V to paste.', { type: 'warn' }); }
}

// ---------------------------------------------------------------------------
// Ribbon and menus
// ---------------------------------------------------------------------------
const shapeGallery = () => {
  const grid = h('div.shape-grid');
  for (const [kind, label] of SHAPES) {
    const b = h('button', { 'data-tip': label, html: `<svg viewBox="0 0 40 30" width="34" height="26"><path d="${shapePath(kind, 40, 30)}" fill="currentColor" fill-opacity=".25" stroke="currentColor" stroke-width="1.5" vector-effect="non-scaling-stroke" ${kind === 'ring' ? 'fill-rule="evenodd"' : ''}/></svg>` });
    b.addEventListener('click', () => { closeMenus(); addShape(kind); });
    grid.append(b);
  }
  return grid;
};
const layoutMenu = (apply) => LAYOUTS.map(([v, l]) => ({ label: l, run: () => (apply ? applyLayout(v) : newSlide(v)) }));
const EMOJI = '😀 😎 🤔 🎉 🚀 💡 ⭐ ✅ ❌ ⚠️ ❤️ 👍 👏 🙌 🔥 📈 📉 📊 💰 🏆 🎯 🧠 ⏰ 📌 🌍 🐍 🎵 📷 💬 🔒'.split(' ');
const emojiGrid = () => { const g = h('div.emoji-grid'); for (const e of EMOJI) { const b = h('button', e); b.addEventListener('click', () => { closeMenus(); addEmoji(e); }); g.append(b); } return g; };
const tableGrid = () => {
  const cells = [];
  const label = h('div.muted', { style: { textAlign: 'center', padding: '4px' } }, 'Table');
  const grid = h('div.tgrid');
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) { const cell = h('span', { dataset: { r, c } }); cells.push(cell); grid.append(cell); }
  grid.addEventListener('mousemove', (e) => { const t = e.target.dataset; if (t.r === undefined) return; for (const cell of cells) cell.classList.toggle('on', +cell.dataset.r <= +t.r && +cell.dataset.c <= +t.c); label.textContent = `${+t.c + 1} × ${+t.r + 1}`; });
  grid.addEventListener('click', (e) => { const t = e.target.dataset; if (t.r === undefined) return; closeMenus(); addTable(+t.r + 1, +t.c + 1); });
  return h('div', label, grid);
};

shell.setRibbon([
  {
    id: 'home', label: 'Home', groups: [
      { label: 'Slides', items: [tb('slide.new', { big: true, label: 'New slide', split: true, menu: () => layoutMenu(false) }), h('div.rstack', tb({ icon: 'layout', label: 'Layout', showLabel: true, menu: () => layoutMenu(true) }), tb('slide.duplicate', { showLabel: true, label: 'Duplicate' }), tb('slide.delete', { showLabel: true, label: 'Delete' }))] },
      { label: 'Clipboard', items: [tb('edit.paste', { big: true }), h('div.rstack', tb('edit.cut'), tb('edit.copy'), tb('edit.duplicate'))] },
      { label: 'Text', items: [h('div.rstack', h('div.row', { style: { gap: '2px' } }, tb('fmt.bold'), tb('fmt.italic'), tb('fmt.underline'), tb('fmt.grow'), tb('fmt.shrink')),
        h('div.row', { style: { gap: '2px' } }, tb('fmt.left'), tb('fmt.center'), tb('fmt.right'), tb('fmt.bullets')))] },
      { label: 'Draw', items: [tb('ins.text', { big: true, label: 'Text box' }), tb({ icon: 'shapes', label: 'Shapes', big: true, menu: () => [{ custom: shapeGallery() }] }), h('div.rstack', tb('ins.line'), tb('ins.arrow'))] },
      { label: 'Arrange', items: [h('div.rstack', h('div.row', { style: { gap: '2px' } }, tb('arr.front'), tb('arr.back'), tb('arr.group'), tb('arr.ungroup')),
        h('div.row', { style: { gap: '2px' } }, tb({ icon: 'alignObjCenter', tip: 'Centre on the slide', run: () => ed.align('center') }), tb({ icon: 'alignObjMiddle', tip: 'Middle of the slide', run: () => ed.align('middle') }), tb({ icon: 'distributeH', tip: 'Space evenly', run: () => ed.distribute('h') }), tb('view.snap')))] },
      { label: 'Show', items: [tb('show.start', { big: true, label: 'From start' }), tb('show.current', { big: true, label: 'From here' })] },
    ],
  },
  {
    id: 'insert', label: 'Insert', groups: [
      { label: 'Content', items: [tb('ins.text', { big: true, label: 'Text box' }), tb('ins.picture', { big: true, label: 'Picture' }), tb({ icon: 'table', label: 'Table', big: true, menu: () => [{ custom: tableGrid() }] }),
        tb({ icon: 'chart', label: 'Chart', big: true, menu: () => CHART_TYPES.map(([t, n]) => ({ label: n, run: () => addChart(t) })) })] },
      { label: 'Shapes', items: [tb({ icon: 'shapes', label: 'Shapes', big: true, menu: () => [{ custom: shapeGallery() }] }), tb('ins.line', { big: true, label: 'Line' }), tb('ins.arrow', { big: true, label: 'Arrow' })] },
      { label: 'Fun', items: [tb({ icon: 'smile', label: 'Emoji', big: true, menu: () => [{ custom: emojiGrid() }] })] },
      { label: 'Slide', items: [tb('slide.numbers', { big: true, label: 'Numbers' })] },
    ],
  },
  {
    id: 'design', label: 'Design', groups: [
      { label: 'Themes', items: [h('div.theme-strip', ...Object.entries(THEMES).map(([id, t]) => {
        const b = h('button.theme-chip', { 'data-tip': t.name, style: { background: t.bg } }, h('span', { style: { color: t.title, fontFamily: t.heading } }, 'Aa'));
        b.addEventListener('click', () => setTheme(id));
        return b;
      }))] },
      { label: 'Size', items: [tb({ icon: 'aspect', label: 'Slide size', big: true, menu: () => Object.entries(SIZES).map(([id, s]) => ({ label: s.name, checked: () => pres.sizeId === id, run: () => setSize(id) })) })] },
      { label: 'Background', items: [tb({ icon: 'palette', label: 'Background', big: true, run: () => { ed.select([]); if (format.classList.contains('hidden')) commands.run('view.format'); } })] },
    ],
  },
  {
    id: 'transitions', label: 'Transitions', groups: [
      { label: 'Transition to this slide', items: [['none', 'None', 'x'], ['fade', 'Fade', 'blur'], ['slide', 'Slide', 'arrow'], ['push', 'Push', 'chevronUp'], ['zoom', 'Zoom', 'zoomIn'], ['cover', 'Cover', 'layers'], ['flip', 'Flip', 'flipH']].map(([t, n, ic]) => tb({ icon: ic, label: n, big: true, on: () => ((ed.slide && ed.slide.transition && ed.slide.transition.type) || 'fade') === t, run: () => setTransition(t) })) },
      { label: 'All slides', items: [tb({ icon: 'duplicate', label: 'Use everywhere', big: true, run: () => setTransition((ed.slide.transition && ed.slide.transition.type) || 'fade', true) })] },
    ],
  },
  {
    id: 'show', label: 'Slide Show', groups: [
      { label: 'Start', items: [tb('show.start', { big: true, label: 'From start' }), tb('show.current', { big: true, label: 'From here' }), tb('show.presenter', { big: true, label: 'Presenter view' })] },
      { label: 'Set up', items: [tb('slide.hide', { big: true, label: 'Hide slide' }), tb('view.notes', { big: true, label: 'Notes' })] },
    ],
  },
  {
    id: 'view', label: 'View', groups: [
      { label: 'Show', items: [tb('view.sorter', { big: true, label: 'Slides' }), tb('view.notes', { big: true, label: 'Notes' }), tb('view.format', { big: true, label: 'Format' }), tb('view.snap', { big: true, label: 'Snap' })] },
      { label: 'Zoom', items: [tb('view.zoomOut', { big: true, label: 'Out' }), tb('view.fit', { big: true, label: 'Fit' }), tb('view.zoomIn', { big: true, label: 'In' })] },
    ],
  },
]);

let recentCache = [];
const refreshRecent = () => host.recent().then((r) => { recentCache = r; }).catch(() => {});
refreshRecent();
function fileMenu() {
  return [I('file.new'), I('app.newWindow'), I('file.open'), { label: 'Open Recent', icon: 'clock', submenu: () => (recentCache.length ? recentCache.slice(0, 15).map((r) => ({ label: r.name, disabled: !r.exists, run: () => openRecent(r) })) : [{ label: 'Nothing yet', disabled: true }]) },
    { type: 'separator' }, I('file.save'), I('file.saveAs'), { label: 'Export', icon: 'export', submenu: [I('file.pptx'), I('file.pdf'), I('file.png')] }, I('file.print'), { type: 'separator' }, I('file.home'), I('app.close')];
}
function editMenu() { return [I('edit.undo', { label: history.undoLabel ? `Undo ${history.undoLabel}` : 'Undo' }), I('edit.redo'), { type: 'separator' }, I('edit.cut'), I('edit.copy'), I('edit.paste'), I('edit.duplicate'), I('edit.delete'), { type: 'separator' }, I('edit.selectAll'), I('edit.editText')]; }
function viewMenu() { return [I('view.sorter'), I('view.notes'), I('view.format'), I('view.snap'), I('view.ribbon'), { type: 'separator' }, I('view.zoomIn'), I('view.zoomOut'), I('view.fit'), { type: 'separator' }, I('view.themeDark'), I('view.themeLight'), I('view.themeSystem'), I('view.fullscreen')]; }
function insertMenu() { return [I('slide.new'), I('ins.text'), I('ins.picture'), I('ins.table'), I('ins.chart'), { label: 'Shape', icon: 'shapes', submenu: SHAPES.map(([k, l]) => ({ label: l, run: () => addShape(k) })) }, I('ins.line'), I('ins.arrow'), I('slide.numbers')]; }
function formatMenu() { return [I('fmt.bold'), I('fmt.italic'), I('fmt.underline'), I('fmt.bullets'), { type: 'separator' }, I('arr.front'), I('arr.back'), I('arr.forward'), I('arr.backward'), I('arr.group'), I('arr.ungroup'), { type: 'separator' }, { label: 'Theme', icon: 'theme', submenu: Object.entries(THEMES).map(([id, t]) => ({ label: t.name, checked: () => pres.theme === id, run: () => setTheme(id) })) }]; }
function slideMenu() {
  return [I('slide.new'), I('slide.duplicate'), I('slide.delete'), I('slide.hide'), { type: 'separator' }, { label: 'Layout', icon: 'layout', submenu: () => layoutMenu(true) },
    { label: 'Transition', icon: 'transition', submenu: [['none', 'None'], ['fade', 'Fade'], ['slide', 'Slide'], ['push', 'Push'], ['zoom', 'Zoom'], ['cover', 'Cover'], ['flip', 'Flip']].map(([t, n]) => ({ label: n, checked: () => ((ed.slide.transition && ed.slide.transition.type) || 'fade') === t, run: () => setTransition(t) })) },
    { type: 'separator' }, I('show.current'), I('show.presenter')];
}

function canvasMenu(e, it) {
  if (!it) {
    showMenu([I('edit.paste'), { type: 'separator' }, I('ins.text', { run: () => addText(ed.local(e)) }), I('ins.picture'), { label: 'Shape', icon: 'shapes', submenu: SHAPES.map(([k, l]) => ({ label: l, run: () => addShape(k) })) },
      { type: 'separator' }, { label: 'Layout', icon: 'layout', submenu: () => layoutMenu(true) }, { label: 'Background…', icon: 'palette', run: () => { if (format.classList.contains('hidden')) commands.run('view.format'); buildFormat(); } },
      I('slide.new'), I('slide.hide'), { type: 'separator' }, I('show.current')], { x: e.clientX, y: e.clientY });
    return;
  }
  showMenu([I('edit.cut'), I('edit.copy'), I('edit.paste'), I('edit.duplicate'), I('edit.delete'), { type: 'separator' },
    it.type === 'text' || it.type === 'shape' ? I('edit.editText') : null,
    it.type === 'image' ? { label: 'Replace picture…', icon: 'image', run: () => insertPicture(it) } : null,
    it.type === 'chart' ? { label: 'Edit chart data…', icon: 'chart', run: () => chartDialog(it) } : null,
    it.type === 'table' ? { label: 'Edit table…', icon: 'table', run: () => tableDialog(it) } : null,
    { label: 'Order', icon: 'layers', submenu: [I('arr.front'), I('arr.forward'), I('arr.backward'), I('arr.back')] },
    { label: 'Align', icon: 'alignObjCenter', submenu: ['left', 'center', 'right', 'top', 'middle', 'bottom'].map((a) => ({ label: a[0].toUpperCase() + a.slice(1), run: () => ed.align(a) })) },
    { label: 'Rotate', icon: 'rotateCw', submenu: [{ label: 'Turn right 90°', run: () => { for (const x of ed.selected) x.rot = ((x.rot || 0) + 90) % 360; commit('Rotate'); ed.render(); } }, { label: 'Turn left 90°', run: () => { for (const x of ed.selected) x.rot = ((x.rot || 0) + 270) % 360; commit('Rotate'); ed.render(); } }, { label: 'Flip horizontally', run: () => { for (const x of ed.selected) x.flipH = !x.flipH; commit('Flip'); ed.render(); } }, { label: 'Flip vertically', run: () => { for (const x of ed.selected) x.flipV = !x.flipV; commit('Flip'); ed.render(); } }, { label: 'Straighten', run: () => { for (const x of ed.selected) x.rot = 0; commit('Rotate'); ed.render(); } }] },
    ed.sel.size > 1 ? I('arr.group') : null, it.group ? I('arr.ungroup') : null,
    { label: it.locked ? 'Unlock' : 'Lock in place', icon: it.locked ? 'unlock' : 'lock', run: () => { for (const x of ed.selected) x.locked = !it.locked; commit('Lock'); ed.drawSelection(); } },
    { label: 'Animation', icon: 'animation', submenu: [['none', 'None'], ['fade', 'Fade in'], ['fly', 'Fly in'], ['zoom', 'Zoom in'], ['pop', 'Pop'], ['wipe', 'Wipe']].map(([t, n]) => ({ label: n, checked: () => ((it.anim && it.anim.type) || 'none') === t, run: () => { for (const x of ed.selected) x.anim = t === 'none' ? undefined : { type: t, duration: 0.5, order: (x.anim && x.anim.order) || ed.slide.items.filter((y) => y.anim).length + 1 }; commit('Animation'); buildFormat(); } })) },
    { label: 'Format…', icon: 'sliders', run: () => { if (format.classList.contains('hidden')) commands.run('view.format'); } },
  ], { x: e.clientX, y: e.clientY });
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------
const slideItem = h('button.item', { 'data-tip': 'Slide number' });
slideItem.addEventListener('click', async () => { const v = await promptBox('Go to slide', { value: String(ed.index + 1) }); if (v) goto(Number(v) - 1); });
const themeItem = h('button.item', { 'data-tip': 'Theme' });
themeItem.addEventListener('click', () => popover(themeGallery(), { anchor: themeItem }));
const saveItem = h('span.item.muted');
const zoomBox = shell.zoomBox({ get: () => ed.zoom, set: (z) => ed.setZoom(z), min: 0.1, max: 6, fit: [{ label: 'Fit the slide', run: () => ed.fit() }] });
const showBtn = tb('show.start', { cls: 'status-tb' });
shell.statusLeft.append(slideItem, themeItem, saveItem);
shell.statusRight.append(tb('view.notes', { cls: 'status-tb' }), showBtn, zoomBox);
function updateStatus() {
  slideItem.textContent = `Slide ${ed.index + 1} of ${pres.slides.length}`;
  themeItem.textContent = (THEMES[pres.theme] || THEMES.snake).name;
}
function updateTitle() {
  shell.setTitle(file.name, history.dirty);
  saveItem.textContent = history.dirty ? 'Not saved' : file.handle ? 'Saved' : '';
  updateStatus();
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------
function usePres(p, { name = 'Untitled', handle = null, format = 'snakeslides' } = {}) {
  pres = p;
  if (!pres.assets) pres.assets = {};
  file.handle = handle;
  file.name = name;
  file.format = format;
  file.id = uid('deck');
  file.opened = true;
  history.clear();
  snapshot = snap();
  ed.setPres(pres);
  thumbCache.clear();
  selectedSlides = new Set([pres.slides[0].id]);
  start.hide();
  goto(0);
  ed.fit();
  buildFormat();
  updateTitle();
  ed.el.focus();
}

function pristine() { return !file.handle && !history.dirty && pres.slides.length === 1 && pres.slides[0].items.every((it) => !it.html && !it.asset); }

async function parseFile(f, bytes) {
  const ext = extOf(f.name);
  if (ext === 'pptx') return { pres: await readPptx(bytes), format: 'pptx' };
  const j = JSON.parse(decodeText(bytes));
  if (j.format !== 'snakeslides') throw new Error("This is not a Snake's Slides file.");
  // Text in our own files is still checked: only known tags and styles get in.
  const { sanitizeToString } = await import('../../kit/sanitize.js');
  for (const s of j.slides) for (const it of s.items) {
    if (it.html) it.html = sanitizeToString(it.html);
    if (it.rows) for (const row of it.rows) for (const c of row) c.html = sanitizeToString(c.html || '');
  }
  for (const [k, v] of Object.entries(j.assets || {})) if (!/^data:image\/(png|jpeg|gif|webp|bmp|avif);base64,/.test(v)) delete j.assets[k];
  return { pres: j, format: 'snakeslides' };
}

async function openFile(f, { here = false } = {}) {
  if (!here && !pristine() && host.openInNewWindow && f.id) { host.openInNewWindow(f); return; }
  if (!here && !pristine() && !(await confirmLeave())) return;
  const b = busy(`Opening ${f.name}…`);
  try {
    const res = await parseFile(f, await host.read(f));
    usePres(res.pres, { name: f.name, handle: f, format: res.format });
    refreshRecent();
  } catch (err) { errorToast(err); } finally { b.close(); }
}

async function confirmLeave() {
  if (!history.dirty) return true;
  const { saveChangesBox } = await import('../../kit/dialogs.js');
  const r = await saveChangesBox(file.name);
  if (r === 'save') return save();
  return r === 'discard';
}

async function openDialog() { for (const f of await host.openFiles({ filters: FILTERS, multiple: true })) await openFile(f); }
async function openRecent(r) { try { await openFile(await host.openRecent(r.key)); } catch (err) { errorToast(err); refreshRecent(); } }

async function newDeck(t = TEMPLATES[0]) {
  if (!pristine() && file.opened) {
    if (inElectron) { host.win.newWindow(`new=${t.id}`); return; }
    if (!(await confirmLeave())) return;
  }
  usePres(t.build(), { name: t.id === 'blank' ? 'Untitled' : t.name });
}

function serialize(format) {
  ed.stopEditing();
  saveNotes();
  if (format === 'pptx') return writePptx(pres);
  // Keep only pictures still in use.
  const used = new Set();
  for (const s of pres.slides) { for (const it of s.items) if (it.asset) used.add(it.asset); if (s.bg && s.bg.image) used.add(s.bg.image); }
  const assets = Object.fromEntries(Object.entries(pres.assets).filter(([k]) => used.has(k)));
  return JSON.stringify({ ...pres, format: 'snakeslides', version: 1, assets });
}

async function save() {
  if (!file.handle || !file.handle.writable) return saveAs();
  try {
    file.handle = await host.write(file.handle, await serialize(file.format));
    history.markSaved();
    host.recovery.delete(file.id).catch(() => {});
    updateTitle();
    toast(`Saved ${file.name}`, { timeout: 1500 });
    return true;
  } catch (err) { errorToast(err); return false; }
}

async function saveAs(format = null) {
  const fmt = format || file.format || 'snakeslides';
  const filters = { snakeslides: { name: "Snake's Slides", exts: ['snakeslides'] }, pptx: { name: 'PowerPoint', exts: ['pptx'] } };
  try {
    const data = await serialize(fmt);
    const f = await host.saveAs({ name: `${baseName(file.name === 'Untitled' ? textOf(pres.slides[0].items.find((it) => it.ph === 'title')?.html || '') || 'Presentation' : file.name)}.${filters[fmt].exts[0]}`, filters: [filters[fmt], filters[fmt === 'pptx' ? 'snakeslides' : 'pptx']], near: file.handle && file.handle.id }, data);
    if (!f) return false;
    const real = extOf(f.name) === 'pptx' ? 'pptx' : 'snakeslides';
    if (real !== fmt) await host.write(f, await serialize(real));
    file.handle = f;
    file.name = f.name;
    file.format = real;
    history.markSaved();
    host.recovery.delete(file.id).catch(() => {});
    updateTitle();
    refreshRecent();
    toast(`Saved ${f.name}`, { timeout: 1800 });
    return true;
  } catch (err) { errorToast(err); return false; }
}

async function exportPdf(printOnly = false) {
  ed.stopEditing();
  const view = h('div.print-deck');
  const style = h('style', `@page { size: ${pres.size.w}px ${pres.size.h}px; margin: 0; background: #fff; }`);
  for (const s of pres.slides) {
    if (s.hidden) continue;
    const el = renderSlide(s, pres, {});
    view.append(h('div.print-page', el));
  }
  document.head.append(style);
  document.body.append(view);
  document.body.classList.add('printing-deck');
  await new Promise((r) => requestAnimationFrame(r));
  settle(view, 1);
  try {
    if (printOnly) await host.print();
    else if (inElectron) {
      const f = await host.printPDF({ name: baseName(file.name === 'Untitled' ? 'Presentation' : file.name) });
      if (f) toast(`Exported ${f.name}`, { action: { label: 'Show', run: () => host.reveal(f) } });
    } else await host.printPDF();
  } catch (err) { errorToast(err); } finally {
    document.body.classList.remove('printing-deck');
    view.remove();
    style.remove();
  }
}

async function exportPng() {
  // Draw the slide through an SVG picture of its HTML.
  const el = renderSlide(ed.slide, pres, {});
  const holder = h('div', { style: { position: 'fixed', left: '-10000px', top: '0' } }, el);
  document.body.append(holder);
  settle(el, 2);
  const css = [...document.styleSheets].map((s) => { try { return [...s.cssRules].map((r) => r.cssText).filter((t) => /\.slide|\.item|\.text-inner|\.shape-svg|\.item-/.test(t)).join('\n'); } catch { return ''; } }).join('\n');
  for (const c of el.querySelectorAll('canvas')) { const img = h('img', { src: c.toDataURL('image/png'), style: { width: '100%', height: '100%' } }); c.replaceWith(img); }
  const xml = new XMLSerializer().serializeToString(el);
  holder.remove();
  const svgText = `<svg xmlns="http://www.w3.org/2000/svg" width="${pres.size.w * 2}" height="${pres.size.h * 2}"><foreignObject x="0" y="0" width="${pres.size.w}" height="${pres.size.h}" transform="scale(2)"><div xmlns="http://www.w3.org/1999/xhtml"><style>${css}</style>${xml}</div></foreignObject></svg>`;
  const img = new Image();
  img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgText)}`;
  try {
    await img.decode();
    const c = document.createElement('canvas');
    c.width = pres.size.w * 2;
    c.height = pres.size.h * 2;
    c.getContext('2d').drawImage(img, 0, 0);
    const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
    const f = await host.saveAs({ name: `${baseName(file.name)} - slide ${ed.index + 1}.png`, filters: [{ name: 'PNG picture', exts: ['png'] }] }, new Uint8Array(await blob.arrayBuffer()));
    if (f) toast(`Saved ${f.name}`);
  } catch (err) { errorToast(new Error('This slide could not be turned into a picture. Export a PDF instead.')); void err; }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const start = startScreen({
  shell, title: 'Start a new presentation', thumbRatio: 1.78,
  templates: TEMPLATES.map((t) => ({ ...t, thumb: () => templateThumb(t) })),
  onTemplate: (t) => newDeck(t), onOpen: () => openDialog(), onRecent: (r) => openRecent(r),
  extra: h('div.col', { style: { marginTop: '18px' } }, h('div.muted', { style: { fontSize: '12px', padding: '0 6px' } }, 'Blank, in a theme:'), h('div.theme-strip', { style: { flexWrap: 'wrap', padding: '0 4px' } }, ...Object.entries(THEMES).map(([id, t]) => {
    const b = h('button.theme-chip', { 'data-tip': t.name, style: { background: t.bg } }, h('span', { style: { color: t.title, fontFamily: t.heading } }, 'Aa'));
    b.addEventListener('click', () => usePres(newPresentation(id), { name: 'Untitled' }));
    return b;
  }))),
});
shell.titlebar.querySelector('.menubar button').addEventListener('pointerdown', refreshRecent, true);

guardClose({ dirty: () => file.opened && history.dirty, save: () => save(), name: () => file.name });
onDropFiles((files) => {
  const decks = files.filter((f) => ['snakeslides', 'pptx'].includes(extOf(f.name)));
  decks.forEach((f, i) => openFile(f, { here: i === 0 && pristine() }));
  const pics = files.filter((f) => IMAGE_EXTS.includes(extOf(f.name)));
  if (pics.length && file.opened) pics.forEach(async (f) => addImageUrl(await readImage(f)));
}, 'Drop presentations to open them, or pictures to add them');
host.onOpen((files) => files.forEach((f) => openFile(f)));

let lastBackup = -1;
setInterval(() => {
  if (!file.opened || !history.dirty || history.version === lastBackup) return;
  lastBackup = history.version;
  host.recovery.put(file.id, { name: file.name, data: serialize('snakeslides'), time: Date.now() }).catch(() => {});
}, 20000);

window.addEventListener('keydown', (e) => {
  // Typing on a selected text box starts editing it.
  if (!ed.editing && ed.sel.size === 1 && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && document.activeElement === ed.el) {
    const it = ed.selected[0];
    if (it.type === 'text' || it.type === 'shape') { ed.startEditing(it); }
  }
});

snapshot = snap();
(async () => {
  const params = new URLSearchParams(location.search);
  const recovered = await host.recovery.list().catch(() => []);
  if (recovered.length) {
    const box = h('div.recover', h('h2', 'Recovered presentations'));
    for (const r of recovered.sort((a, b) => b.time - a.time).slice(0, 6)) {
      const rec = await host.recovery.get(r.key).catch(() => null);
      if (!rec || !rec.value) continue;
      const row = h('div.list-item', h('span', { html: icon('history', 18) }), h('div.grow', h('div', rec.value.name || 'Untitled'), h('div.dir', `Unsaved changes from ${new Date(rec.time).toLocaleString()}`)));
      const keep = h('button.btn.small.primary', 'Open');
      const drop = h('button.btn.small', 'Discard');
      keep.addEventListener('click', () => { usePres(JSON.parse(rec.value.data), { name: rec.value.name || 'Recovered' }); history.savedAt = -1; updateTitle(); host.recovery.delete(r.key); });
      drop.addEventListener('click', () => { host.recovery.delete(r.key); row.remove(); });
      row.append(keep, drop);
      box.append(row);
    }
    if (box.children.length > 1) start.el.querySelector('.start-main').prepend(box);
  }
  if (shell.info.files && shell.info.files.length) await openFile(shell.info.files[0], { here: true });
  else if (params.get('new')) newDeck(TEMPLATES.find((x) => x.id === params.get('new')) || TEMPLATES[0]);
  else { ed.render(); drawSorter(); }
})();

window.snakeApp = { get pres() { return pres; }, ed, commands, readPptx, writePptx, usePres, startShow };
