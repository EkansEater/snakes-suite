// Snake's Photo: a layered photo editor. Layers with masks, blend modes and
// effects; adjustment layers; selections; retouching brushes (clone, healing,
// spot healing, dodge and burn); filters; free transform; crop; text and
// shapes. Reads and writes Photoshop (.psd) and OpenRaster (.ora) files.
import { h, clamp, extOf, baseName } from '../../kit/dom.js';
import { icon } from '../../kit/icons.js';
import { host } from '../../kit/host.js';
import * as commands from '../../kit/commands.js';
import { createShell, tb, combo, select, onDropFiles, guardClose, refresh, splitter, startScreen } from '../../kit/shell.js';
import { showMenu, popover, closeMenus } from '../../kit/menu.js';
import { modal, toast, errorToast, busy, saveChangesBox } from '../../kit/dialogs.js';
import { colorPicker, toHex, parseColor } from '../../kit/color.js';
import { knownFonts, allFonts, FONT_SIZES } from '../../kit/fonts.js';
import { History } from '../../kit/history.js';
import { Viewport } from '../../kit/viewport.js';
import { shapePath } from '../../kit/shapes.js';
import { makeCanvas, cloneCanvas, rgba, floodMask, rotated, flipped, resized, cropped, canvasBytes, decodeImage, IMAGE_TYPES } from '../../kit/raster.js';
import { PhotoDoc, newLayer, ensureCovers, contentBounds, renderText, Compositor, LAYER_PROPS, TEXT_DEFAULTS, textFont, thumbnail as layerThumb } from './doc.js';
import { Selection } from './selection.js';
import { Stroke, BRUSH_TOOLS } from './brush.js';
import { ADJUSTMENTS, applyAdjustment, autoFix, defaultParams } from './adjust.js';
import { FILTERS, backgroundMask } from './filters.js';
import { readPsd, writePsd } from './psd.js';
import { readOra, writeOra } from './ora.js';
import { buildPanels } from './panels.js';
import * as D from './dialogs.js';

const OPEN_FILTERS = [{ name: 'Pictures and projects', exts: ['ora', 'psd', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp', 'avif', 'svg', 'ico'] }];
const FORMATS = {
  ora: { name: "Snake's Photo project (OpenRaster)", exts: ['ora'], layered: true },
  psd: { name: 'Photoshop document', exts: ['psd'], layered: true },
  png: { name: 'PNG picture', exts: ['png'], mime: 'image/png' },
  jpg: { name: 'JPEG picture', exts: ['jpg', 'jpeg'], mime: 'image/jpeg' },
  webp: { name: 'WebP picture', exts: ['webp'], mime: 'image/webp' },
  bmp: { name: 'Bitmap', exts: ['bmp'], mime: 'image/bmp' },
};
const formatOf = (name) => { const e = extOf(name) === 'jpeg' ? 'jpg' : extOf(name); return FORMATS[e] ? e : null; };

const PRESETS = [
  { name: 'Full HD 1920 × 1080', w: 1920, h: 1080 }, { name: 'Square post 1080 × 1080', w: 1080, h: 1080 }, { name: 'Phone story 1080 × 1920', w: 1080, h: 1920 },
  { name: 'Video thumbnail 1280 × 720', w: 1280, h: 720 }, { name: '4K 3840 × 2160', w: 3840, h: 2160 }, { name: 'Photo print 6 × 4 in', w: 1800, h: 1200 },
  { name: 'A4 page (300 dpi)', w: 2480, h: 3508 }, { name: 'Icon 512 × 512', w: 512, h: 512 },
];

const TOOL_INFO = {
  move: ['Move', 'move', 'V'], marquee: ['Rectangle select', 'select', 'M'], ellipse: ['Ellipse select', 'selectEllipse', 'Shift+M'],
  lasso: ['Lasso', 'lasso', 'L'], wand: ['Magic wand', 'wand', 'W'], crop: ['Crop', 'crop', 'C'], eyedropper: ['Eyedropper', 'pipette', 'I'],
  spot: ['Spot healing brush', 'bandage', 'J'], heal: ['Healing brush', 'bandage', 'Shift+J'], brush: ['Brush', 'brush', 'B'],
  clone: ['Clone stamp', 'stamp', 'S'], eraser: ['Eraser', 'eraser', 'E'], gradient: ['Gradient', 'gradient', 'G'], fill: ['Paint bucket', 'bucket', 'Shift+G'],
  blur: ['Blur brush', 'blur', 'R'], sharpen: ['Sharpen brush', 'sharpen', null], smudge: ['Smudge', 'smudge', 'Shift+R'],
  dodge: ['Dodge (lighten)', 'dodge', 'O'], burn: ['Burn (darken)', 'contrast', 'Shift+O'], sponge: ['Sponge (colour)', 'droplet', null],
  text: ['Text', 'text', 'T'], shape: ['Shapes', 'shapes', 'U'], hand: ['Hand', 'hand', 'H'], zoom: ['Zoom', 'zoomIn', 'Z'],
};
const GROUPS = [['move'], ['marquee', 'ellipse'], ['lasso'], ['wand'], ['crop'], ['eyedropper'], ['spot', 'heal'], ['brush'], ['clone'], ['eraser'],
  ['gradient', 'fill'], ['blur', 'sharpen', 'smudge'], ['dodge', 'burn', 'sponge'], ['text'], ['shape'], ['hand'], ['zoom']];
const SELECT_TOOLS = ['marquee', 'ellipse', 'lasso', 'wand'];

const DEFAULT_OPTS = {
  brush: { size: 30, hardness: 0.8, opacity: 1, flow: 1, smoothing: 0 },
  eraser: { size: 40, hardness: 0.8, opacity: 1, flow: 1, smoothing: 0 },
  clone: { size: 50, hardness: 0.5, opacity: 1, flow: 1, aligned: true, sampleAll: false },
  heal: { size: 50, hardness: 0.5, opacity: 1, flow: 1, aligned: true, sampleAll: false },
  spot: { size: 30, hardness: 0.6, opacity: 1, flow: 1 },
  smudge: { size: 30, hardness: 0.5, opacity: 0.6, flow: 1 },
  blur: { size: 50, hardness: 0.3, opacity: 0.7, flow: 1 },
  sharpen: { size: 50, hardness: 0.3, opacity: 0.5, flow: 1 },
  dodge: { size: 60, hardness: 0.2, opacity: 0.4, flow: 1, mode: 'midtones' },
  burn: { size: 60, hardness: 0.2, opacity: 0.4, flow: 1, mode: 'midtones' },
  sponge: { size: 60, hardness: 0.2, opacity: 0.5, flow: 1, mode: 'saturate' },
  gradient: { kind: 'linear', toTransparent: false, reverse: false, opacity: 1 },
  fill: { tolerance: 32, contiguous: true, sampleAll: false, opacity: 1 },
  wand: { tolerance: 32, contiguous: true, sampleAll: true },
  marquee: { feather: 0, mode: 'replace' }, ellipse: { feather: 0, mode: 'replace' }, lasso: { feather: 0, mode: 'replace', polygon: false },
  crop: { ratio: 'free', deleteCropped: true },
  text: { ...TEXT_DEFAULTS, size: 72 },
  shape: { kind: 'rect', fill: true, stroke: false, strokeWidth: 6 },
  eyedropper: { sample: 'all', size: 1 },
  move: { autoSelect: false },
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let doc = null;
let sel = null;
let lastSel = null;
const file = { handle: null, name: 'Untitled', format: 'ora', original: null };
let historyBytes = 0;
let panels = null;
const history = new History({ limit: 5000, onChange: () => { updateTitle(); refresh(); if (panels) panels.history(); } });

const shell = await createShell({
  id: 'photo', name: "Snake's Photo",
  quick: ['file.save', 'edit.undo', 'edit.redo'],
  menus: [
    { label: '&File', items: () => fileMenu() },
    { label: '&Edit', items: () => editMenu() },
    { label: '&Image', items: () => imageMenu() },
    { label: '&Layer', items: () => layerMenu() },
    { label: '&Select', items: () => selectMenu() },
    { label: 'Fil&ter', items: () => filterMenu() },
    { label: '&View', items: () => viewMenu() },
    { label: '&Help', items: () => [I('app.palette'), I('app.shortcuts'), { type: 'separator' }, I('app.about')] },
  ],
  about: 'A layered photo editor: layers, masks, blend modes, effects and adjustment layers; selections; healing, clone, dodge and burn brushes; filters; crop and free transform; text and shapes. Opens and saves Photoshop (.psd) and OpenRaster (.ora) files, and PNG, JPEG, WebP and BMP pictures.',
});
const settings = host.settings;
const I = (id, extra) => commands.item(id, extra);

const st = {
  tool: settings.get('tool', 'brush'),
  prevTool: 'brush',
  fg: settings.get('fg', '#000000'),
  bg: settings.get('bg', '#ffffff'),
  opts: (() => {
    const saved = settings.get('opts', {});
    const o = {};
    for (const [k, v] of Object.entries(DEFAULT_OPTS)) o[k] = { ...v, ...(saved[k] || {}) };
    return o;
  })(),
  groupTool: settings.get('groupTool', {}),
};
let saveOptsTimer = 0;
const saveOpts = () => { clearTimeout(saveOptsTimer); saveOptsTimer = setTimeout(() => settings.set('opts', st.opts), 400); };
const O = () => st.opts[st.tool] || {};

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------
const toolbox = h('div.ph-tools');
const colorsBox = h('div.ph-colors');
const optionsBar = h('div.toolbar.ph-options');
optionsBar.addEventListener('wheel', (e) => {
  if (e.defaultPrevented || optionsBar.scrollWidth <= optionsBar.clientWidth) return;
  optionsBar.scrollLeft += e.deltaY || e.deltaX;
}, { passive: true });
const compositor = new Compositor(() => doc);
let override = null; // a layer being worked on: { id, canvas | mask | x, y | transform }
let compositeDirty = true;
let composite = null;
let compare = null; // before/after: { split: 0..1 }

const vp = new Viewport({
  size: () => (doc ? { w: doc.width, h: doc.height } : { w: 800, h: 600 }),
  draw: (ctx) => drawPicture(ctx),
  overlay: (ctx, v) => drawOverlay(ctx, v),
  settings,
  onZoom: () => { zoomBox.update(); placeTextEditor(); if (panels) panels.navigator(); },
  onPointer: (kind, e) => pointer(kind, e),
  wheelZooms: true,
});
const centre = h('div.ph-centre', optionsBar, vp.el);
const side = h('div.ph-side');
shell.main.append(h('div.ph-left', toolbox, colorsBox), centre, splitter(side, { side: 'right', key: 'sideWidth', initial: 290, min: 220, max: 520 }), side);

function currentComposite() {
  if (!doc) return null;
  if (compositeDirty || !composite) {
    composite = compositor.render({ override });
    compositeDirty = false;
  }
  return composite;
}

function drawPicture(ctx) {
  const c = currentComposite();
  if (!c) return;
  if (compare && file.original) {
    // Before on the left of the divider, after on the right.
    const x = doc.width * compare.split;
    ctx.drawImage(c, 0, 0);
    ctx.save();
    ctx.beginPath();
    ctx.rect(0, 0, x, doc.height);
    ctx.clip();
    ctx.clearRect(0, 0, x, doc.height);
    ctx.drawImage(file.original, 0, 0, doc.width, doc.height);
    ctx.restore();
    return;
  }
  ctx.drawImage(c, 0, 0);
}

/** Something about the picture changed: combine the layers again and redraw. */
function render() {
  compositeDirty = true;
  vp.renderSoon();
  if (panels) panels.soon();
}

/** A change to the document itself (not a preview). */
function changed(layer = null) {
  if (!doc) return;
  doc.touch(layer);
  render();
  if (panels) panels.layers();
  updateStatus();
}

// ---------------------------------------------------------------------------
// Undo
// ---------------------------------------------------------------------------
function trimHistory() {
  while (historyBytes > 1.2e9 && history.done.length > 4) {
    const old = history.done.shift();
    history.savedAt--;
    historyBytes -= old.size || 0;
  }
}

function push(step) {
  historyBytes += step.size || 0;
  history.push(step);
  trimHistory();
}

/** Everything structural about the document (layer list, settings, canvases by reference, selection). */
function snap() {
  return {
    w: doc.width, h: doc.height, active: doc.activeId, sel,
    layers: doc.layers.map((L) => ({ L, canvas: L.canvas, mask: L.mask, props: JSON.stringify(Object.fromEntries(LAYER_PROPS.map((k) => [k, L[k]]))) })),
  };
}

function restore(s) {
  const sizeChanged = doc.width !== s.w || doc.height !== s.h;
  doc.width = s.w;
  doc.height = s.h;
  doc.layers = s.layers.map(({ L, canvas, mask, props }) => {
    Object.assign(L, JSON.parse(props));
    L.canvas = canvas;
    L.mask = mask;
    L.rev++;
    return L;
  });
  doc.activeId = s.active;
  sel = s.sel;
  if (sizeChanged) { vp.layout(); vp.fit(); }
  changed();
}

/**
 * A structural change, undone by putting the old layer list, settings and
 * canvases back. `fn` must make new canvases rather than paint on old ones.
 */
function structural(label, fn, { key = null } = {}) {
  const before = snap();
  const result = fn();
  const after = snap();
  const old = new Set(before.layers.flatMap((x) => [x.canvas, x.mask]));
  let size = 0;
  for (const x of after.layers) for (const c of [x.canvas, x.mask]) if (c && !old.has(c)) size += c.width * c.height * 4;
  push({ label, key, size, undo: () => restore(before), redo: () => restore(after) });
  changed();
  return result;
}

let edit = null;
/** Before painting on a layer's pixels (or its mask): keep a copy for undo. */
function beginPixelEdit(L, which = 'pixels') {
  const target = which === 'mask' ? L.mask : L.canvas;
  edit = { L, which, target, copy: cloneCanvas(target), x: L.x, y: L.y };
}

function endPixelEdit(label, rect = null, extra = null) {
  if (!edit) return;
  const { L, which, target, copy } = edit;
  edit = null;
  const W = target.width;
  const H = target.height;
  const r0 = rect || { x: 0, y: 0, w: W, h: H };
  const x = Math.max(0, Math.floor(r0.x)); const y = Math.max(0, Math.floor(r0.y));
  const x1 = Math.min(W, Math.ceil(r0.x + r0.w)); const y1 = Math.min(H, Math.ceil(r0.y + r0.h));
  if (x1 <= x || y1 <= y) return;
  const r = { x, y, w: x1 - x, h: y1 - y };
  const before = copy.getContext('2d', { willReadFrequently: true }).getImageData(r.x, r.y, r.w, r.h);
  const after = target.getContext('2d', { willReadFrequently: true }).getImageData(r.x, r.y, r.w, r.h);
  const put = (id) => {
    const t = which === 'mask' ? L.mask : L.canvas;
    t.getContext('2d').putImageData(id, r.x, r.y);
    changed(L);
  };
  push({
    label, size: r.w * r.h * 8,
    undo: () => { put(before); if (extra) extra.undo(); },
    redo: () => { put(after); if (extra) extra.redo(); },
  });
  changed(L);
}

function setSelection(next, label = 'Select') {
  const prev = sel;
  if (prev && !prev.empty) lastSel = prev;
  sel = next && !next.empty ? next : null;
  if (label) push({ label, size: 0, undo: () => { sel = prev; selChanged(); }, redo: () => { sel = next && !next.empty ? next : null; selChanged(); } });
  selChanged();
}

function selChanged() {
  vp.renderOverlay();
  updateStatus();
  refresh();
}

const isDirty = () => !!doc && history.dirty;
const emptySel = () => new Selection(doc.width, doc.height);

// ---------------------------------------------------------------------------
// Layers
// ---------------------------------------------------------------------------
const active = () => (doc ? doc.active : null);

function canPaint(L, { allowMask = true } = {}) {
  if (!L) { toast('There is no layer to work on.', { type: 'warn' }); return false; }
  if (L.locked) { toast(`“${L.name}” is locked.`, { type: 'warn' }); return false; }
  if (allowMask && L.editMask && L.mask) return true;
  if (L.kind === 'text') {
    toast('Text layers stay editable text. Rasterise it to paint on it.', { action: { label: 'Rasterise', run: () => rasterize(L) } });
    return false;
  }
  if (L.kind === 'adjust') {
    if (L.mask) return true;
    toast('Add a mask to the adjustment layer to paint where it applies.', { action: { label: 'Add mask', run: () => addMask('all') } });
    return false;
  }
  return true;
}

function rasterize(L = active()) {
  if (!L || L.kind === 'pixel') return;
  structural('Rasterise layer', () => {
    if (L.kind === 'adjust') {
      // An adjustment becomes the picture it makes.
      const below = compositor.render({ upTo: doc.layers.indexOf(L) + 1, into: makeCanvas(doc.width, doc.height) });
      L.canvas = below;
      L.x = 0; L.y = 0;
      L.adjust = null;
    } else {
      L.canvas = cloneCanvas(L.canvas);
      L.text = null;
    }
    L.kind = 'pixel';
  });
}

/** Paint target for brushes: the layer's mask when editing it, else its pixels. */
function paintTarget(L) { return (L.editMask || L.kind === 'adjust') && L.mask ? 'mask' : 'pixels'; }

/** Make sure a pixel layer covers the picture before painting (keeps undo straight). */
function coverPicture(L) {
  if (L.kind !== 'pixel') return;
  const needs = L.x > 0 || L.y > 0 || L.x + L.canvas.width < doc.width || L.y + L.canvas.height < doc.height;
  if (needs) structural('Expand layer', () => { ensureCovers(L, 0, 0, doc.width, doc.height); });
}

function addLayer(name = null, opts = {}) {
  let n = doc.layers.length;
  while (doc.layers.some((l) => l.name === `Layer ${n}`)) n++;
  return structural('New layer', () => doc.addPixelLayer(name || `Layer ${n}`, opts));
}

function selectLayer(id) {
  if (!doc || doc.activeId === id) return;
  finishTransient();
  doc.activeId = id;
  if (panels) panels.layers();
  buildOptions();
  refresh();
}

// ---------------------------------------------------------------------------
// Overlay: selection edges, tool guides
// ---------------------------------------------------------------------------
let ants = 0;
setInterval(() => { if (sel && !hideExtras) { ants = (ants + 1) % 16; vp.renderOverlay(); } }, 120);
let hideExtras = false;
let cursor = null;
let guide = null; // what the current drag draws: function(ctx, z)

function drawOverlay(ctx, { z, o }) {
  if (!doc) return;
  ctx.save();
  ctx.translate(o.x, o.y);
  ctx.scale(z, z);
  if (sel && !hideExtras && !(transform && transform.float)) {
    const p = sel.outline;
    if (p) {
      ctx.lineWidth = 1 / z;
      ctx.setLineDash([4 / z, 4 / z]);
      ctx.strokeStyle = '#000';
      ctx.lineDashOffset = -ants / z;
      ctx.stroke(p);
      ctx.strokeStyle = '#fff';
      ctx.lineDashOffset = (-ants + 4) / z;
      ctx.stroke(p);
      ctx.setLineDash([]);
    }
  }
  if (guide) guide(ctx, z);
  if (crop) drawCrop(ctx, z);
  if (transform) drawTransform(ctx, z);
  if (compare) {
    const x = doc.width * compare.split;
    ctx.fillStyle = '#fff';
    ctx.fillRect(x - 1 / z, 0, 2 / z, doc.height);
    ctx.font = `${12 / z}px Inter, sans-serif`;
    ctx.fillStyle = 'rgba(0,0,0,.6)';
    ctx.fillRect(x - 64 / z, 8 / z, 56 / z, 18 / z);
    ctx.fillRect(x + 8 / z, 8 / z, 50 / z, 18 / z);
    ctx.fillStyle = '#fff';
    ctx.fillText('Before', x - 58 / z, 21 / z);
    ctx.fillText('After', x + 14 / z, 21 / z);
  }
  // Clone source.
  if ((st.tool === 'clone' || st.tool === 'heal') && cloneSrc && cursor) {
    const off = cloneOffset || { x: 0, y: 0 };
    const sx = cloneOffset ? cursor.x - off.x : cloneSrc.x;
    const sy = cloneOffset ? cursor.y - off.y : cloneSrc.y;
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1.5 / z;
    const r = 8 / z;
    ctx.beginPath(); ctx.moveTo(sx - r, sy); ctx.lineTo(sx + r, sy); ctx.moveTo(sx, sy - r); ctx.lineTo(sx, sy + r); ctx.stroke();
    ctx.beginPath(); ctx.arc(sx, sy, (O().size || 20) / 2, 0, Math.PI * 2); ctx.setLineDash([3 / z, 3 / z]); ctx.stroke(); ctx.setLineDash([]);
  }
  ctx.restore();
  // The brush outline under the pointer.
  if (cursor && BRUSH_TOOLS.includes(st.tool) && !vp.space) {
    const r = Math.max(1, (O().size || 10) / 2) * z;
    const X = o.x + cursor.x * z;
    const Y = o.y + cursor.y * z;
    ctx.save();
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(0,0,0,.7)';
    ctx.beginPath(); ctx.arc(X, Y, r, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,.85)';
    ctx.beginPath(); ctx.arc(X, Y, r + 1, 0, Math.PI * 2); ctx.stroke();
    if ((O().hardness ?? 1) < 0.95) { ctx.setLineDash([2, 3]); ctx.beginPath(); ctx.arc(X, Y, Math.max(1, r * (O().hardness || 0)), 0, Math.PI * 2); ctx.stroke(); }
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Pointer
// ---------------------------------------------------------------------------
let drag = null;
let previewing = false; // a dialog is showing a live preview: the picture only pans and zooms
let pickCallback = null;

function pointer(kind, e) {
  if (!doc) return;
  const p = vp.toImage(e);
  p.pressure = e.pointerType === 'pen' ? (e.pressure || 0.5) : 1;
  if (kind === 'leave') { cursor = null; vp.renderOverlay(); posItem.textContent = ''; colorItem.style.display = 'none'; return; }
  cursor = p;
  if (kind === 'move') {
    showPosition(p);
    if (!drag) { vp.scroller.style.cursor = cursorFor(e, p); vp.renderOverlay(); return; }
  }
  if (previewing) {
    // A dialog is open: only its "pick from the picture" clicks get through.
    if (kind === 'down' && e.button === 0 && pickCallback) { const cb = pickCallback; cb(p, e); }
    return;
  }
  if (kind === 'down') {
    if (e.button === 2) return;
    if (compare) { compareDrag(e); return; }
    vp.scroller.setPointerCapture(e.pointerId);
    drag = { p0: p, e0: e, moved: false, last: p };
    down(p, e);
    return;
  }
  if (kind === 'move' && drag) {
    drag.moved = drag.moved || Math.hypot(p.x - drag.p0.x, p.y - drag.p0.y) * vp.zoom > 2;
    move(p, e);
    drag && (drag.last = p);
    return;
  }
  if (kind === 'up' && drag) {
    const d = drag;
    up(p, e, d);
    drag = null;
    guide = null;
    vp.renderOverlay();
  }
  if (kind === 'dblclick') dblclick(p, e);
}

function cursorFor(e, p) {
  if (vp.space) return 'grab';
  const t = st.tool;
  if (transform) return transformCursor(e) || 'default';
  if (crop) return cropCursor(e) || 'crosshair';
  if (compare) return 'ew-resize';
  if (BRUSH_TOOLS.includes(t)) return e.altKey && (t === 'clone' || t === 'heal') ? 'crosshair' : 'none';
  if (SELECT_TOOLS.includes(t) && sel && sel.contains(p.x, p.y) && !e.shiftKey && !e.altKey && t !== 'wand') return 'move';
  return { move: 'move', marquee: 'crosshair', ellipse: 'crosshair', lasso: 'crosshair', wand: 'crosshair', eyedropper: 'crosshair', gradient: 'crosshair', fill: 'cell', text: 'text', shape: 'crosshair', hand: 'grab', zoom: e.altKey ? 'zoom-out' : 'zoom-in' }[t] || 'default';
}

function showPosition(p) {
  posItem.textContent = `${Math.floor(p.x)}, ${Math.floor(p.y)}`;
  const c = composite;
  const x = Math.floor(p.x);
  const y = Math.floor(p.y);
  if (c && x >= 0 && y >= 0 && x < c.width && y < c.height) {
    const d = c.getContext('2d', { willReadFrequently: true }).getImageData(x, y, 1, 1).data;
    const hex = toHex({ r: d[0], g: d[1], b: d[2] });
    colorItem.style.display = '';
    colorItem.firstChild.style.background = hex;
    colorItem.lastChild.textContent = d[3] < 255 ? `${hex} ${Math.round((d[3] / 255) * 100)}%` : hex;
  } else colorItem.style.display = 'none';
}

const selMode = (e, fallback) => (e.shiftKey && e.altKey ? 'intersect' : e.shiftKey ? 'add' : e.altKey ? 'subtract' : fallback);

function down(p, e) {
  const t = st.tool;
  if (textEdit && t !== 'text') commitText();
  if (transform) { transformDown(p, e); return; }
  if (crop) { cropDown(p, e); return; }
  if (BRUSH_TOOLS.includes(t)) { brushDown(p, e); return; }
  switch (t) {
    case 'move': moveDown(p, e); break;
    case 'marquee': case 'ellipse': case 'lasso': {
      const mode = selMode(e, O().mode || 'replace');
      if (mode === 'replace' && sel && sel.contains(p.x, p.y)) { drag.moveSel = true; break; }
      drag.mode = mode;
      if (t === 'lasso') drag.points = [[p.x, p.y]];
      break;
    }
    case 'wand': wandAt(p, selMode(e, O().mode || 'replace')); break;
    case 'eyedropper': sampleAt(p, e.altKey ? 'bg' : 'fg'); break;
    case 'fill': bucketAt(p); break;
    case 'gradient': break;
    case 'text': textDown(p); break;
    case 'shape': break;
    case 'hand': vp.handTool = true; break;
    case 'zoom': vp.zoomStep(e.altKey ? -1 : 1, { x: e.clientX, y: e.clientY }); break;
    default: break;
  }
}

function move(p, e) {
  const t = st.tool;
  const d = drag;
  if (transform) { transformMove(p, e); return; }
  if (crop) { cropMove(p, e); return; }
  if (d.stroke) { brushMove(p, e); return; }
  if (t === 'move') { moveMove(p, e); return; }
  if (t === 'eyedropper') { sampleAt(p, e.altKey ? 'bg' : 'fg'); return; }
  if (SELECT_TOOLS.includes(t) && d.moveSel) {
    const dx = Math.round(p.x - d.p0.x);
    const dy = Math.round(p.y - d.p0.y);
    guide = (ctx, z) => { ctx.save(); ctx.translate(dx, dy); ctx.lineWidth = 1 / z; ctx.strokeStyle = '#1f883d'; ctx.setLineDash([4 / z, 3 / z]); ctx.stroke(sel.outline); ctx.restore(); };
    vp.renderOverlay();
    return;
  }
  if (t === 'marquee' || t === 'ellipse') {
    const r = dragRect(d.p0, p, e.shiftKey && d.mode !== 'add', e.altKey && d.mode !== 'subtract');
    d.rect = r;
    guide = (ctx, z) => {
      ctx.lineWidth = 1 / z;
      ctx.strokeStyle = '#fff';
      ctx.setLineDash([4 / z, 4 / z]);
      ctx.beginPath();
      if (t === 'ellipse') ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2); else ctx.rect(r.x, r.y, r.w, r.h);
      ctx.stroke();
      ctx.strokeStyle = '#000';
      ctx.lineDashOffset = 4 / z;
      ctx.stroke();
      ctx.setLineDash([]);
    };
    rectStatus(r);
    vp.renderOverlay();
    return;
  }
  if (t === 'lasso' && d.points) {
    d.points.push([p.x, p.y]);
    guide = (ctx, z) => { ctx.lineWidth = 1.5 / z; ctx.strokeStyle = '#1f883d'; ctx.beginPath(); d.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.stroke(); };
    vp.renderOverlay();
    return;
  }
  if (t === 'gradient') {
    let q = p;
    if (e.shiftKey) q = snapAngle(d.p0, p);
    d.q = q;
    guide = (ctx, z) => {
      ctx.lineWidth = 2 / z; ctx.strokeStyle = '#fff'; ctx.beginPath(); ctx.moveTo(d.p0.x, d.p0.y); ctx.lineTo(q.x, q.y); ctx.stroke();
      ctx.lineWidth = 1 / z; ctx.strokeStyle = '#000'; ctx.stroke();
      for (const pt of [d.p0, q]) { ctx.beginPath(); ctx.arc(pt.x, pt.y, 4 / z, 0, Math.PI * 2); ctx.fillStyle = '#fff'; ctx.fill(); ctx.stroke(); }
    };
    vp.renderOverlay();
    return;
  }
  if (t === 'shape') {
    const r = dragRect(d.p0, p, e.shiftKey, e.altKey);
    d.rect = r;
    const o = O();
    guide = (ctx, z) => { ctx.save(); ctx.translate(r.x, r.y); drawShapeInto(ctx, o, r.w, r.h); ctx.restore(); ctx.lineWidth = 1 / z; ctx.strokeStyle = '#1f883d'; ctx.setLineDash([3 / z, 3 / z]); ctx.strokeRect(r.x, r.y, r.w, r.h); ctx.setLineDash([]); };
    rectStatus(r);
    vp.renderOverlay();
  }
}

function up(p, e, d) {
  const t = st.tool;
  vp.handTool = false;
  if (transform) { transformUp(); return; }
  if (crop) { cropUp(); return; }
  if (d.stroke) { brushUp(); return; }
  if (t === 'move') { moveUp(p, e); return; }
  if (SELECT_TOOLS.includes(t) && d.moveSel) {
    const dx = Math.round(p.x - d.p0.x);
    const dy = Math.round(p.y - d.p0.y);
    if (dx || dy) setSelection(sel.moved(dx, dy), 'Move selection');
    return;
  }
  if (t === 'marquee' || t === 'ellipse') {
    if (!d.moved || !d.rect || d.rect.w < 1 || d.rect.h < 1) { if (d.mode === 'replace' && sel) setSelection(null, 'Deselect'); return; }
    const r = d.rect;
    const shape = emptySel().with((ctx) => {
      ctx.beginPath();
      if (t === 'ellipse') ctx.ellipse(r.x + r.w / 2, r.y + r.h / 2, r.w / 2, r.h / 2, 0, 0, Math.PI * 2); else ctx.rect(Math.round(r.x), Math.round(r.y), Math.round(r.w), Math.round(r.h));
      ctx.fill();
    });
    setSelection(combineShape(shape, d.mode), t === 'ellipse' ? 'Ellipse select' : 'Rectangle select');
    return;
  }
  if (t === 'lasso' && d.points) {
    if (d.points.length < 3 || !d.moved) { if (d.mode === 'replace' && sel) setSelection(null, 'Deselect'); return; }
    const shape = emptySel().with((ctx) => { ctx.beginPath(); d.points.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y))); ctx.closePath(); ctx.fill(); });
    setSelection(combineShape(shape, d.mode), 'Lasso');
    return;
  }
  if (t === 'gradient' && d.q && d.moved) { gradientFill(d.p0, d.q); return; }
  if (t === 'shape' && d.rect && d.moved) { addShape(d.rect); }
}

/** A drawn shape (feathered if asked: just the shape, not what was selected before) joined to the selection. */
function combineShape(shape, mode) {
  if (shape.empty) return mode === 'replace' || mode === 'intersect' ? null : sel;
  const s = O().feather ? shape.feather(O().feather) : shape;
  return (sel || emptySel()).combine(s.canvas, mode);
}

function dblclick() {
  if (crop) applyCrop();
  else if (transform) commitTransform();
}

function dragRect(a, b, square, fromCentre) {
  let dx = b.x - a.x;
  let dy = b.y - a.y;
  if (square) { const s = Math.max(Math.abs(dx), Math.abs(dy)); dx = Math.sign(dx || 1) * s; dy = Math.sign(dy || 1) * s; }
  if (fromCentre) return { x: a.x - Math.abs(dx), y: a.y - Math.abs(dy), w: Math.abs(dx) * 2, h: Math.abs(dy) * 2 };
  return { x: Math.min(a.x, a.x + dx), y: Math.min(a.y, a.y + dy), w: Math.abs(dx), h: Math.abs(dy) };
}

function snapAngle(a, b) {
  const ang = Math.round(Math.atan2(b.y - a.y, b.x - a.x) / (Math.PI / 4)) * (Math.PI / 4);
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  return { x: a.x + Math.cos(ang) * d, y: a.y + Math.sin(ang) * d };
}

function rectStatus(r) { selItem.textContent = `${Math.round(r.w)} × ${Math.round(r.h)}`; }

// ---------------------------------------------------------------------------
// Brushes
// ---------------------------------------------------------------------------
let cloneSrc = null; // { x, y } in the picture
let cloneOffset = null; // aligned clone: target minus source

function brushDown(p, e) {
  const t = st.tool;
  if ((t === 'clone' || t === 'heal') && e.altKey) {
    cloneSrc = { x: p.x, y: p.y };
    cloneOffset = null;
    toast('Source set. Now paint where the copy should go.', { timeout: 1600 });
    drag = null;
    return;
  }
  const L = active();
  if (!canPaint(L)) { drag = null; return; }
  if ((t === 'clone' || t === 'heal') && !cloneSrc) { toast('Alt+click where to copy from first.', { type: 'warn' }); drag = null; return; }
  const which = paintTarget(L);
  if (which === 'pixels') coverPicture(L);
  const o = O();
  let source = null;
  if (t === 'clone' || t === 'heal') {
    if (!cloneOffset || !o.aligned) cloneOffset = { x: p.x - cloneSrc.x, y: p.y - cloneSrc.y };
    const all = o.sampleAll;
    const snapCanvas = all ? cloneCanvas(currentComposite()) : cloneCanvas(L.canvas);
    source = { canvas: snapCanvas, dx: Math.round(cloneOffset.x - (all ? L.x : 0)), dy: Math.round(cloneOffset.y - (all ? L.y : 0)) };
  }
  const target = which === 'mask' ? L.mask : L.canvas;
  beginPixelEdit(L, which);
  const [r, g, b] = rgba(st.fg);
  drag.stroke = new Stroke(target, L.x, L.y, {
    tool: t, size: o.size, hardness: o.hardness ?? 0.8, opacity: o.opacity ?? 1, flow: o.flow ?? 1, spacing: 0.1,
    color: st.fg, maskValue: (0.299 * r + 0.587 * g + 0.114 * b) / 255, target: which, lockAlpha: L.lockAlpha,
    selection: sel ? sel.canvas : null, source, mode: o.mode, smoothing: o.smoothing || 0,
    pressure: { size: settings.get('pressureSize', true), opacity: settings.get('pressureOpacity', false) },
  });
  drag.which = which;
  drag.stroke.to(p);
  showStroke();
}

function brushMove(p, e) {
  const s = drag.stroke;
  const pts = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
  if (pts.length) for (const ce of pts) { const q = vp.toImage(ce); q.pressure = ce.pointerType === 'pen' ? (ce.pressure || 0.5) : 1; s.to(q); } else s.to(p);
  showStroke();
}

let strokeFrame = 0;
function showStroke() {
  if (strokeFrame) return;
  strokeFrame = requestAnimationFrame(() => {
    strokeFrame = 0;
    if (!drag || !drag.stroke) return;
    drag.stroke.update();
    const L = active();
    override = drag.which === 'mask' ? { id: L.id, mask: drag.stroke.work } : { id: L.id, canvas: drag.stroke.work };
    render();
  });
}

function brushUp() {
  const s = drag.stroke;
  cancelAnimationFrame(strokeFrame);
  strokeFrame = 0;
  const rect = s.commit();
  override = null;
  const names = { brush: 'Brush', eraser: 'Erase', clone: 'Clone', heal: 'Heal', spot: 'Spot heal', smudge: 'Smudge', blur: 'Blur', sharpen: 'Sharpen', dodge: 'Dodge', burn: 'Burn', sponge: 'Sponge' };
  if (rect) endPixelEdit(names[st.tool] || 'Paint', rect); else { edit = null; render(); }
}

// ---------------------------------------------------------------------------
// Move tool
// ---------------------------------------------------------------------------
let floating = null; // selected pixels lifted by the move tool

function topLayerAt(p) {
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const L = doc.layers[i];
    if (!L.visible || L.kind === 'adjust' || !L.canvas) continue;
    const x = Math.floor(p.x - L.x);
    const y = Math.floor(p.y - L.y);
    if (x < 0 || y < 0 || x >= L.canvas.width || y >= L.canvas.height) continue;
    if (L.canvas.getContext('2d', { willReadFrequently: true }).getImageData(x, y, 1, 1).data[3] > 20) return L;
  }
  return null;
}

function moveDown(p, e) {
  if (O().autoSelect || e.ctrlKey) { const hit = topLayerAt(p); if (hit) selectLayer(hit.id); }
  const L = active();
  if (!L) { drag = null; return; }
  if (L.locked) { toast(`“${L.name}” is locked.`, { type: 'warn' }); drag = null; return; }
  if (sel && L.kind === 'pixel') {
    // Lift the selected pixels (Alt: leave a copy behind).
    coverPicture(L);
    const b = sel.bounds;
    const piece = makeCanvas(b.w, b.h);
    const pc = piece.getContext('2d');
    pc.drawImage(L.canvas, L.x - b.x, L.y - b.y);
    pc.globalCompositeOperation = 'destination-in';
    pc.drawImage(sel.canvas, -b.x, -b.y);
    beginPixelEdit(L);
    if (!e.altKey) {
      const ctx = L.canvas.getContext('2d');
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      ctx.drawImage(sel.canvas, -L.x, -L.y);
      ctx.restore();
    }
    floating = { L, piece, b, dx: 0, dy: 0, work: makeCanvas(L.canvas.width, L.canvas.height) };
    drag.float = true;
    moveMove(p, e);
    return;
  }
  drag.layer = { L, x: L.x, y: L.y };
}

function moveMove(p, e) {
  let dx = Math.round(p.x - drag.p0.x);
  let dy = Math.round(p.y - drag.p0.y);
  if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
  if (drag.float && floating) {
    floating.dx = dx; floating.dy = dy;
    const { L, piece, b, work } = floating;
    const w = work.getContext('2d');
    w.clearRect(0, 0, work.width, work.height);
    w.drawImage(L.canvas, 0, 0);
    w.drawImage(piece, b.x + dx - L.x, b.y + dy - L.y);
    override = { id: L.id, canvas: work };
    guide = (ctx, z) => { ctx.save(); ctx.translate(dx, dy); ctx.lineWidth = 1 / z; ctx.strokeStyle = '#fff'; ctx.setLineDash([4 / z, 4 / z]); ctx.stroke(sel.outline); ctx.restore(); };
    render();
    vp.renderOverlay();
    return;
  }
  if (drag.layer) {
    override = { id: drag.layer.L.id, x: drag.layer.x + dx, y: drag.layer.y + dy };
    render();
  }
}

function moveUp() {
  if (drag.float && floating) {
    const { L, piece, b, dx, dy } = floating;
    floating = null;
    override = null;
    // Grow the layer if the pieces went past its edges.
    const grew = ensureCovers(L, b.x + dx, b.y + dy, b.x + dx + b.w, b.y + dy + b.h);
    if (grew) {
      // The layer was replaced by a bigger one: record it as a structural change.
      const copy = edit.copy;
      const ox = edit.x; const oy = edit.y;
      edit = null;
      L.canvas.getContext('2d').drawImage(piece, b.x + dx - L.x, b.y + dy - L.y);
      const after = { canvas: L.canvas, x: L.x, y: L.y };
      const prevSel = sel;
      const nextSel = sel.moved(dx, dy);
      push({ label: 'Move', size: after.canvas.width * after.canvas.height * 4,
        undo: () => { Object.assign(L, { canvas: copy, x: ox, y: oy }); sel = prevSel; changed(L); },
        redo: () => { Object.assign(L, after); sel = nextSel; changed(L); } });
      sel = nextSel;
      changed(L);
      return;
    }
    L.canvas.getContext('2d').drawImage(piece, b.x + dx - L.x, b.y + dy - L.y);
    const prevSel = sel;
    const nextSel = dx || dy ? sel.moved(dx, dy) : sel;
    sel = nextSel;
    endPixelEdit('Move', null, { undo: () => { sel = prevSel; selChanged(); }, redo: () => { sel = nextSel; selChanged(); } });
    selChanged();
    return;
  }
  if (drag.layer && override) {
    const { L } = drag.layer;
    const { x, y } = override;
    override = null;
    if (x !== L.x || y !== L.y) structural('Move layer', () => { L.x = x; L.y = y; });
    else render();
  }
}

function nudge(dx, dy) {
  const L = active();
  if (!L || L.locked) return;
  if (sel && L.kind === 'pixel') {
    // Nudge the selected pixels.
    coverPicture(L);
    const b = sel.bounds;
    beginPixelEdit(L);
    const piece = makeCanvas(b.w, b.h);
    const pc = piece.getContext('2d');
    pc.drawImage(L.canvas, L.x - b.x, L.y - b.y);
    pc.globalCompositeOperation = 'destination-in';
    pc.drawImage(sel.canvas, -b.x, -b.y);
    const ctx = L.canvas.getContext('2d');
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(sel.canvas, -L.x, -L.y);
    ctx.restore();
    ctx.drawImage(piece, b.x + dx - L.x, b.y + dy - L.y);
    const prevSel = sel;
    const nextSel = sel.moved(dx, dy);
    sel = nextSel;
    endPixelEdit('Nudge', null, { undo: () => { sel = prevSel; selChanged(); }, redo: () => { sel = nextSel; selChanged(); } });
    selChanged();
    return;
  }
  structural('Nudge', () => { L.x += dx; L.y += dy; }, { key: `nudge:${L.id}` });
}

// ---------------------------------------------------------------------------
// Wand, eyedropper, bucket, gradient, shapes
// ---------------------------------------------------------------------------
/** Pixels to sample: the whole picture, or the active layer placed in the picture. */
function samplePixels(all) {
  if (all) return currentComposite();
  const L = active();
  const c = makeCanvas(doc.width, doc.height);
  if (L && L.canvas) c.getContext('2d').drawImage(L.canvas, L.x, L.y);
  return c;
}

function wandAt(p, mode) {
  const o = O();
  const src = samplePixels(o.sampleAll);
  const id = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, doc.width, doc.height);
  const mask = floodMask(id.data, doc.width, doc.height, p.x, p.y, o.tolerance, o.contiguous);
  for (let i = 0; i < mask.length; i++) mask[i] *= 255;
  setSelection((sel || emptySel()).fromAlpha(mask, mode), 'Magic wand');
}

function sampleAt(p, which) {
  const o = st.opts.eyedropper;
  const src = samplePixels(o.sample !== 'layer');
  const n = o.size || 1;
  const x = Math.floor(p.x - (n - 1) / 2);
  const y = Math.floor(p.y - (n - 1) / 2);
  if (p.x < 0 || p.y < 0 || p.x >= doc.width || p.y >= doc.height) return;
  const d = src.getContext('2d', { willReadFrequently: true }).getImageData(clamp(x, 0, doc.width - n), clamp(y, 0, doc.height - n), n, n).data;
  let r = 0; let g = 0; let b = 0; let k = 0;
  for (let i = 0; i < d.length; i += 4) { if (!d[i + 3]) continue; r += d[i]; g += d[i + 1]; b += d[i + 2]; k++; }
  if (!k) return;
  setColor(which, toHex({ r: r / k, g: g / k, b: b / k }));
}

function bucketAt(p) {
  const L = active();
  if (!canPaint(L)) return;
  const which = paintTarget(L);
  if (which === 'pixels') coverPicture(L);
  const o = O();
  const src = samplePixels(o.sampleAll);
  const id = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, doc.width, doc.height);
  const mask = floodMask(id.data, doc.width, doc.height, p.x, p.y, o.tolerance, o.contiguous);
  // The fill as a picture-sized canvas, cut to the selection.
  const fillC = makeCanvas(doc.width, doc.height);
  const fctx = fillC.getContext('2d');
  const fid = fctx.createImageData(doc.width, doc.height);
  const [r, g, b] = rgba(st.fg);
  for (let i = 0; i < mask.length; i++) if (mask[i]) { const k = i * 4; fid.data[k] = r; fid.data[k + 1] = g; fid.data[k + 2] = b; fid.data[k + 3] = 255; }
  fctx.putImageData(fid, 0, 0);
  if (sel) { fctx.globalCompositeOperation = 'destination-in'; fctx.drawImage(sel.canvas, 0, 0); }
  paintOnto(L, which, 'Fill', (ctx) => {
    ctx.globalAlpha = o.opacity ?? 1;
    if (L.lockAlpha && which === 'pixels') ctx.globalCompositeOperation = 'source-atop';
    ctx.drawImage(fillC, -L.x, -L.y);
  });
}

/** Paint something onto a layer (or its mask) as one undo step. */
function paintOnto(L, which, label, draw) {
  const target = which === 'mask' ? L.mask : L.canvas;
  beginPixelEdit(L, which);
  const ctx = target.getContext('2d');
  ctx.save();
  draw(ctx);
  ctx.restore();
  endPixelEdit(label);
}

function gradientFill(p0, p1) {
  const L = active();
  if (!canPaint(L)) return;
  const which = paintTarget(L);
  if (which === 'pixels') coverPicture(L);
  const o = O();
  const c = makeCanvas(doc.width, doc.height);
  const ctx = c.getContext('2d');
  let a = st.fg;
  let b = o.toTransparent ? 'rgba(0,0,0,0)' : st.bg;
  if (o.toTransparent) { const [r, g, bb] = rgba(st.fg); b = `rgba(${r},${g},${bb},0)`; }
  if (o.reverse) [a, b] = [b, a];
  const len = Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1;
  let grad;
  if (o.kind === 'radial') grad = ctx.createRadialGradient(p0.x, p0.y, 0, p0.x, p0.y, len);
  else if (o.kind === 'angle') grad = ctx.createConicGradient(Math.atan2(p1.y - p0.y, p1.x - p0.x), p0.x, p0.y);
  else if (o.kind === 'reflected') {
    grad = ctx.createLinearGradient(p0.x - (p1.x - p0.x), p0.y - (p1.y - p0.y), p1.x, p1.y);
    grad.addColorStop(0, b); grad.addColorStop(0.5, a); grad.addColorStop(1, b);
  } else grad = ctx.createLinearGradient(p0.x, p0.y, p1.x, p1.y);
  if (o.kind !== 'reflected') { grad.addColorStop(0, a); grad.addColorStop(1, b); }
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, doc.width, doc.height);
  if (sel) { ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(sel.canvas, 0, 0); }
  paintOnto(L, which, 'Gradient', (lctx) => {
    lctx.globalAlpha = o.opacity ?? 1;
    if (L.lockAlpha && which === 'pixels') lctx.globalCompositeOperation = 'source-atop';
    lctx.drawImage(c, -L.x, -L.y);
  });
}

const SHAPES = [['rect', 'Rectangle'], ['roundRect', 'Rounded rectangle'], ['ellipse', 'Ellipse'], ['triangle', 'Triangle'], ['diamond', 'Diamond'], ['pentagon', 'Pentagon'],
  ['hexagon', 'Hexagon'], ['star', 'Star'], ['heart', 'Heart'], ['arrowRight', 'Arrow'], ['callout', 'Speech bubble'], ['cloud', 'Cloud'], ['lightning', 'Lightning'], ['line', 'Line']];

function drawShapeInto(ctx, o, w, hh) {
  if (w < 1 || hh < 1) return;
  if (o.kind === 'line') {
    ctx.strokeStyle = st.fg;
    ctx.lineWidth = o.strokeWidth || 4;
    ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(w, hh); ctx.stroke();
    return;
  }
  const path = new Path2D(shapePath(o.kind, w, hh, 0.15));
  if (o.fill) { ctx.fillStyle = st.fg; ctx.fill(path); }
  if (o.stroke || !o.fill) { ctx.strokeStyle = o.fill ? st.bg : st.fg; ctx.lineWidth = o.strokeWidth || 4; ctx.lineJoin = 'round'; ctx.stroke(path); }
}

function addShape(r) {
  const o = O();
  const pad = Math.ceil((o.strokeWidth || 4) / 2) + 2;
  const c = makeCanvas(Math.ceil(r.w) + pad * 2, Math.ceil(r.h) + pad * 2);
  const ctx = c.getContext('2d');
  ctx.translate(pad, pad);
  drawShapeInto(ctx, o, r.w, r.h);
  const name = SHAPES.find((s) => s[0] === o.kind)[1];
  structural(`New ${name.toLowerCase()}`, () => doc.addPixelLayer(doc.uniqueName(name), { canvas: c, x: Math.round(r.x) - pad, y: Math.round(r.y) - pad }));
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------
let textEdit = null; // { L, el, before }

function textDown(p) {
  if (textEdit) { commitText(); return; }
  // Click on a text layer to edit it, anywhere else to start a new one.
  for (let i = doc.layers.length - 1; i >= 0; i--) {
    const L = doc.layers[i];
    if (L.kind !== 'text' || !L.visible) continue;
    if (p.x >= L.x && p.y >= L.y && p.x <= L.x + L.canvas.width && p.y <= L.y + L.canvas.height) { selectLayer(L.id); editText(L); return; }
  }
  const t = { ...TEXT_DEFAULTS, ...st.opts.text, color: st.fg, value: '' };
  const L = structural('New text', () => {
    const lay = newLayer({ name: 'Text', kind: 'text', text: t, x: Math.round(p.x - t.size * 0.3), y: Math.round(p.y - t.size * 0.9) });
    renderText(lay);
    const i = doc.activeIndex;
    doc.layers.splice(i + 1, 0, lay);
    doc.activeId = lay.id;
    return lay;
  });
  editText(L, true);
}

function editText(L, fresh = false) {
  const el = h('textarea.ph-text', { spellcheck: true, wrap: L.text.width ? 'soft' : 'off', placeholder: 'Type here' });
  el.value = L.text.value;
  vp.el.append(el);
  textEdit = { L, el, before: JSON.stringify(L.text), fresh };
  override = { id: L.id, canvas: makeCanvas(1, 1) }; // the editor shows the text meanwhile
  render();
  placeTextEditor();
  el.addEventListener('input', () => { L.text.value = el.value; placeTextEditor(); });
  el.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape' || (e.key === 'Enter' && (e.ctrlKey || e.metaKey))) { e.preventDefault(); commitText(); }
  });
  setTimeout(() => el.focus(), 0);
  buildOptions();
}

function placeTextEditor() {
  if (!textEdit) return;
  const { L, el } = textEdit;
  const t = { ...TEXT_DEFAULTS, ...L.text };
  const z = vp.zoom;
  const pad = L.pad ?? Math.ceil(t.size * 0.3);
  const s = vp.toScreen(L.x + pad, L.y + pad);
  const probe = makeCanvas(1, 1).getContext('2d');
  probe.font = textFont(t);
  const w = t.width || Math.max(40, ...String(t.value || ' ').split('\n').map((l) => probe.measureText(l).width + t.size * 0.5));
  Object.assign(el.style, {
    left: `${s.x}px`, top: `${s.y}px`, width: `${w * z + 8}px`, height: `${Math.max(1, String(t.value).split('\n').length) * t.size * t.lineHeight * z + 8}px`,
    font: `${t.italic ? 'italic ' : ''}${t.bold ? '700 ' : '400 '}${t.size * z}px "${t.font}", sans-serif`, lineHeight: String(t.lineHeight),
    color: t.color, textAlign: t.align, letterSpacing: `${(t.letterSpacing || 0) * z}px`,
  });
}

function commitText() {
  if (!textEdit) return;
  const { L, el, before, fresh } = textEdit;
  textEdit = null;
  el.remove();
  override = null;
  if (!L.text.value.trim()) {
    // An empty text layer goes away again.
    if (fresh && history.undoLabel === 'New text') { history.undo(); history.undone.pop(); refresh(); } else render();
    return;
  }
  const after = JSON.stringify(L.text);
  L.text = JSON.parse(before);
  if (after !== before) structural('Edit text', () => { L.text = JSON.parse(after); renderText(L); });
  else render();
  buildOptions();
}

/** Change the active text layer's settings (from the options bar). */
function setTextProp(key, value) {
  st.opts.text[key] = value;
  saveOpts();
  const L = active();
  if (!L || L.kind !== 'text') return;
  if (textEdit && textEdit.L === L) { L.text[key] = value; placeTextEditor(); return; }
  structural('Text settings', () => { L.text = { ...L.text, [key]: value }; renderText(L); }, { key: `text:${L.id}:${key}` });
}

// ---------------------------------------------------------------------------
// Crop
// ---------------------------------------------------------------------------
let crop = null; // { x, y, w, h }

function startCrop() {
  if (!doc) return;
  finishTransient();
  crop = sel ? { ...sel.bounds } : { x: 0, y: 0, w: doc.width, h: doc.height };
  buildOptions();
  vp.renderOverlay();
}

const RATIOS = { free: null, original: 'doc', '1:1': 1, '4:3': 4 / 3, '3:2': 3 / 2, '16:9': 16 / 9, '5:4': 5 / 4, '4:5': 4 / 5, '2:3': 2 / 3, '9:16': 9 / 16 };
const cropRatio = () => { const r = RATIOS[st.opts.crop.ratio]; return r === 'doc' ? doc.width / doc.height : r; };

function cropHandles() {
  const { x, y, w, h: hh } = crop;
  return { nw: [x, y], n: [x + w / 2, y], ne: [x + w, y], e: [x + w, y + hh / 2], se: [x + w, y + hh], s: [x + w / 2, y + hh], sw: [x, y + hh], w: [x, y + hh / 2] };
}

function hitHandle(handles, e, radius = 8) {
  const r = vp.el.getBoundingClientRect();
  for (const [k, [hx, hy]] of Object.entries(handles)) {
    const s = vp.toScreen(hx, hy);
    if (Math.abs(e.clientX - r.left - s.x) <= radius && Math.abs(e.clientY - r.top - s.y) <= radius) return k;
  }
  return null;
}

const HANDLE_CURSOR = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' };
function cropCursor(e) {
  const hd = hitHandle(cropHandles(), e);
  if (hd) return HANDLE_CURSOR[hd];
  const p = vp.toImage(e);
  return p.x > crop.x && p.y > crop.y && p.x < crop.x + crop.w && p.y < crop.y + crop.h ? 'move' : 'crosshair';
}

function cropDown(p, e) {
  const hd = hitHandle(cropHandles(), e);
  drag.crop0 = { ...crop };
  if (hd) drag.handle = hd;
  else if (p.x > crop.x && p.y > crop.y && p.x < crop.x + crop.w && p.y < crop.y + crop.h) drag.moveCrop = true;
  else drag.newCrop = true;
}

function cropMove(p, e) {
  const d = drag;
  const ratio = e.shiftKey && !cropRatio() ? d.crop0.w / d.crop0.h : cropRatio();
  if (d.moveCrop) { crop = { ...d.crop0, x: Math.round(d.crop0.x + p.x - d.p0.x), y: Math.round(d.crop0.y + p.y - d.p0.y) }; }
  else if (d.newCrop) {
    let r = dragRect(d.p0, p, false, false);
    if (ratio) { const hh = r.w / ratio; r = { x: r.x, y: p.y < d.p0.y ? d.p0.y - hh : d.p0.y, w: r.w, h: hh }; }
    crop = r;
  } else if (d.handle) {
    const b = d.crop0;
    let x0 = b.x; let y0 = b.y; let x1 = b.x + b.w; let y1 = b.y + b.h;
    if (d.handle.includes('w')) x0 = p.x;
    if (d.handle.includes('e')) x1 = p.x;
    if (d.handle.includes('n')) y0 = p.y;
    if (d.handle.includes('s')) y1 = p.y;
    if (ratio) {
      const w = Math.abs(x1 - x0);
      const hh = Math.abs(y1 - y0);
      if (d.handle.length === 1 && (d.handle === 'n' || d.handle === 's')) { const nw = hh * ratio; x0 = b.x + b.w / 2 - nw / 2; x1 = x0 + nw; } else {
        const nh = w / ratio;
        if (d.handle.includes('n')) y0 = y1 - nh; else y1 = y0 + nh;
      }
    }
    crop = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
  }
  rectStatus(crop);
  vp.renderOverlay();
}

function cropUp() { crop = { x: Math.round(crop.x), y: Math.round(crop.y), w: Math.max(1, Math.round(crop.w)), h: Math.max(1, Math.round(crop.h)) }; vp.renderOverlay(); }

function drawCrop(ctx, z) {
  const { x, y, w, h: hh } = crop;
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,.55)';
  ctx.beginPath();
  ctx.rect(-1e5, -1e5, 2e5, 2e5);
  ctx.rect(x, y, w, hh);
  ctx.fill('evenodd');
  ctx.strokeStyle = '#fff';
  ctx.lineWidth = 1 / z;
  ctx.strokeRect(x, y, w, hh);
  // Rule of thirds.
  ctx.strokeStyle = 'rgba(255,255,255,.45)';
  ctx.beginPath();
  for (const f of [1 / 3, 2 / 3]) { ctx.moveTo(x + w * f, y); ctx.lineTo(x + w * f, y + hh); ctx.moveTo(x, y + hh * f); ctx.lineTo(x + w, y + hh * f); }
  ctx.stroke();
  ctx.fillStyle = '#fff';
  for (const [hx, hy] of Object.values(cropHandles())) ctx.fillRect(hx - 4 / z, hy - 4 / z, 8 / z, 8 / z);
  ctx.restore();
}

function applyCrop() {
  if (!crop) return;
  const r = crop;
  crop = null;
  const del = st.opts.crop.deleteCropped;
  structural('Crop', () => {
    doc.width = r.w;
    doc.height = r.h;
    for (const L of doc.layers) {
      L.x -= r.x;
      L.y -= r.y;
      if (L.kind === 'adjust' && L.mask) { L.mask = cropped(L.mask, r.x, r.y, r.w, r.h); L.x = 0; L.y = 0; continue; }
      if (del && L.kind === 'pixel' && L.canvas) {
        // Keep only what is inside the new frame.
        const x0 = Math.max(0, -L.x); const y0 = Math.max(0, -L.y);
        const x1 = Math.min(L.canvas.width, r.w - L.x); const y1 = Math.min(L.canvas.height, r.h - L.y);
        if (x1 > x0 && y1 > y0) {
          L.canvas = cropped(L.canvas, x0, y0, x1 - x0, y1 - y0);
          if (L.mask) L.mask = cropped(L.mask, x0, y0, x1 - x0, y1 - y0);
          L.x += x0; L.y += y0;
        } else { L.canvas = makeCanvas(1, 1); L.mask = null; }
      }
    }
    sel = null;
  });
  vp.layout();
  vp.fit();
  buildOptions();
}

function cancelCrop() { crop = null; buildOptions(); vp.renderOverlay(); }

// ---------------------------------------------------------------------------
// Free transform
// ---------------------------------------------------------------------------
let transform = null;

function startTransform() {
  const L = active();
  if (!doc || !L) return;
  if (L.locked) { toast(`“${L.name}” is locked.`, { type: 'warn' }); return; }
  if (L.kind === 'adjust') { toast('Adjustment layers cover the whole picture; there is nothing to transform.', { type: 'warn' }); return; }
  finishTransient();
  let piece = null;
  let box;
  if (sel && L.kind === 'pixel') {
    // Transform only the selected pixels.
    coverPicture(L);
    const b = sel.bounds;
    piece = makeCanvas(b.w, b.h);
    const pc = piece.getContext('2d');
    pc.drawImage(L.canvas, L.x - b.x, L.y - b.y);
    pc.globalCompositeOperation = 'destination-in';
    pc.drawImage(sel.canvas, -b.x, -b.y);
    beginPixelEdit(L);
    const ctx = L.canvas.getContext('2d');
    ctx.save();
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(sel.canvas, -L.x, -L.y);
    ctx.restore();
    box = { x: 0, y: 0, w: b.w, h: b.h };
    transform = { L, float: { piece, b }, src: piece, box, cx: b.x + b.w / 2, cy: b.y + b.h / 2, sx: 1, sy: 1, angle: 0, work: makeCanvas(L.canvas.width, L.canvas.height) };
  } else {
    const cb = contentBounds(L.canvas);
    if (!cb) { toast('This layer is empty.', { type: 'warn' }); return; }
    box = cb;
    transform = { L, src: L.canvas, box, cx: L.x + cb.x + cb.w / 2, cy: L.y + cb.y + cb.h / 2, sx: 1, sy: 1, angle: 0 };
  }
  buildOptions();
  showTransform();
}

/** Matrix from the source canvas's pixels to the picture. */
function tfMatrix(t = transform) {
  const { box } = t;
  const m = new DOMMatrix();
  m.translateSelf(t.cx, t.cy);
  m.rotateSelf((t.angle * 180) / Math.PI);
  m.scaleSelf(t.sx, t.sy);
  m.translateSelf(-(box.x + box.w / 2), -(box.y + box.h / 2));
  return m;
}

function tfCorners() {
  const m = tfMatrix();
  const { box } = transform;
  const pts = { nw: [box.x, box.y], n: [box.x + box.w / 2, box.y], ne: [box.x + box.w, box.y], e: [box.x + box.w, box.y + box.h / 2],
    se: [box.x + box.w, box.y + box.h], s: [box.x + box.w / 2, box.y + box.h], sw: [box.x, box.y + box.h], w: [box.x, box.y + box.h / 2] };
  const out = {};
  for (const [k, [x, y]] of Object.entries(pts)) { const q = m.transformPoint(new DOMPoint(x, y)); out[k] = [q.x, q.y]; }
  return out;
}

function showTransform() {
  const t = transform;
  if (t.float) {
    const { L } = t;
    const w = t.work.getContext('2d');
    w.setTransform(1, 0, 0, 1, 0, 0);
    w.clearRect(0, 0, t.work.width, t.work.height);
    w.drawImage(L.canvas, 0, 0);
    const m = tfMatrix();
    w.setTransform(m.a, m.b, m.c, m.d, m.e - L.x, m.f - L.y);
    w.imageSmoothingQuality = 'high';
    w.drawImage(t.piece || t.float.piece, 0, 0);
    w.setTransform(1, 0, 0, 1, 0, 0);
    override = { id: L.id, canvas: t.work };
  } else {
    const m = tfMatrix();
    // The layer's own offset is part of the box: map layer pixels straight to the picture.
    override = { id: t.L.id, transform: m };
  }
  render();
  vp.renderOverlay();
  tfStatus();
}

function tfStatus() {
  const t = transform;
  selItem.textContent = `W ${Math.round(t.sx * 100)}%  H ${Math.round(t.sy * 100)}%  ${Math.round((t.angle * 180) / Math.PI)}°`;
}

function drawTransform(ctx, z) {
  const c = tfCorners();
  ctx.save();
  ctx.lineWidth = 1 / z;
  ctx.strokeStyle = '#1f883d';
  ctx.beginPath();
  ctx.moveTo(...c.nw); ctx.lineTo(...c.ne); ctx.lineTo(...c.se); ctx.lineTo(...c.sw); ctx.closePath();
  ctx.stroke();
  for (const [hx, hy] of Object.values(c)) {
    ctx.fillStyle = '#fff';
    ctx.fillRect(hx - 4 / z, hy - 4 / z, 8 / z, 8 / z);
    ctx.strokeRect(hx - 4 / z, hy - 4 / z, 8 / z, 8 / z);
  }
  ctx.beginPath();
  ctx.arc(transform.cx, transform.cy, 4 / z, 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function insideTransform(p) {
  const inv = tfMatrix().inverse();
  const q = inv.transformPoint(new DOMPoint(p.x, p.y));
  const { box } = transform;
  return q.x >= box.x && q.y >= box.y && q.x <= box.x + box.w && q.y <= box.y + box.h;
}

function transformCursor(e) {
  const hd = hitHandle(tfCorners(), e);
  if (hd) return HANDLE_CURSOR[hd];
  const p = vp.toImage(e);
  return insideTransform(p) ? 'move' : 'alias';
}

function transformDown(p, e) {
  const t = transform;
  drag.t0 = { cx: t.cx, cy: t.cy, sx: t.sx, sy: t.sy, angle: t.angle };
  const hd = hitHandle(tfCorners(), e);
  if (hd) { drag.handle = hd; drag.corners = tfCorners(); return; }
  if (insideTransform(p)) { drag.moveT = true; return; }
  drag.rotate = Math.atan2(p.y - t.cy, p.x - t.cx);
}

const OPP = { nw: 'se', n: 's', ne: 'sw', e: 'w', se: 'nw', s: 'n', sw: 'ne', w: 'e' };
function transformMove(p, e) {
  const t = transform;
  const d = drag;
  if (d.moveT) { t.cx = d.t0.cx + p.x - d.p0.x; t.cy = d.t0.cy + p.y - d.p0.y; }
  else if (d.rotate !== undefined) {
    let a = d.t0.angle + Math.atan2(p.y - t.cy, p.x - t.cx) - d.rotate;
    if (e.shiftKey) a = Math.round(a / (Math.PI / 12)) * (Math.PI / 12);
    t.angle = a;
  } else if (d.handle) {
    // Scale from the opposite handle, which stays put.
    const A = d.corners[OPP[d.handle]];
    const cos = Math.cos(t.angle); const sin = Math.sin(t.angle);
    const vx = (p.x - A[0]) * cos + (p.y - A[1]) * sin;
    const vy = -(p.x - A[0]) * sin + (p.y - A[1]) * cos;
    const bw = t.box.w; const bh = t.box.h;
    let sx = d.t0.sx; let sy = d.t0.sy;
    const hdl = d.handle;
    const horiz = hdl.includes('e') || hdl.includes('w');
    const vert = hdl.includes('n') || hdl.includes('s');
    // Signs: dragging toward the anchor past it flips.
    const dirX = hdl.includes('w') ? -1 : 1;
    const dirY = hdl.includes('n') ? -1 : 1;
    if (horiz) sx = (vx * dirX) / bw;
    if (vert) sy = (vy * dirY) / bh;
    if (horiz && vert && !e.shiftKey) {
      // Corners keep the proportions unless Shift is held.
      const k = Math.max(Math.abs(sx / d.t0.sx), Math.abs(sy / d.t0.sy));
      sx = d.t0.sx * k * Math.sign(sx || 1);
      sy = d.t0.sy * k * Math.sign(sy || 1);
    }
    if (Math.abs(sx) < 0.01) sx = 0.01 * Math.sign(sx || 1);
    if (Math.abs(sy) < 0.01) sy = 0.01 * Math.sign(sy || 1);
    t.sx = sx;
    t.sy = sy;
    // The centre sits half the new size away from the anchor, along the box's own axes.
    const ox = horiz ? (bw * sx * dirX) / 2 : 0;
    const oy = vert ? (bh * sy * dirY) / 2 : 0;
    t.cx = A[0] + ox * cos - oy * sin;
    t.cy = A[1] + ox * sin + oy * cos;
  }
  showTransform();
}

function transformUp() { tfStatus(); }

function commitTransform() {
  const t = transform;
  if (!t) return;
  transform = null;
  override = null;
  const m = tfMatrix(t);
  const { L } = t;
  if (t.float) {
    // Put the transformed pixels back on their layer.
    const ctx = L.canvas.getContext('2d');
    ctx.save();
    ctx.setTransform(m.a, m.b, m.c, m.d, m.e - L.x, m.f - L.y);
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(t.float.piece, 0, 0);
    ctx.restore();
    const prevSel = sel;
    const nextSel = sel.transformed(doc.width, doc.height, (sctx) => {
      // The selection follows the pixels.
      const mm = m.multiply(new DOMMatrix().translateSelf(-t.float.b.x, -t.float.b.y));
      sctx.setTransform(mm.a, mm.b, mm.c, mm.d, mm.e, mm.f);
    });
    sel = nextSel;
    endPixelEdit('Transform', null, { undo: () => { sel = prevSel; selChanged(); }, redo: () => { sel = nextSel; selChanged(); } });
    buildOptions();
    return;
  }
  const isText = L.kind === 'text';
  if (isText && Math.abs(t.angle) < 1e-6 && Math.abs(t.sx - t.sy) < 1e-6 && t.sx > 0) {
    // Text stays text: scale its size instead.
    structural('Transform text', () => {
      L.text = { ...L.text, size: Math.max(1, Math.round(L.text.size * t.sx * 10) / 10), width: L.text.width ? L.text.width * t.sx : 0 };
      renderText(L);
      const q = m.transformPoint(new DOMPoint(0, 0));
      L.x = Math.round(q.x); L.y = Math.round(q.y);
    });
    buildOptions();
    return;
  }
  structural('Transform', () => {
    const src = L.canvas;
    // The bounding box of the transformed layer.
    const pts = [[0, 0], [src.width, 0], [src.width, src.height], [0, src.height]].map(([x, y]) => m.transformPoint(new DOMPoint(x, y)));
    const x0 = Math.floor(Math.min(...pts.map((q) => q.x))); const y0 = Math.floor(Math.min(...pts.map((q) => q.y)));
    const x1 = Math.ceil(Math.max(...pts.map((q) => q.x))); const y1 = Math.ceil(Math.max(...pts.map((q) => q.y)));
    const draw = (from) => {
      const c = makeCanvas(Math.min(16384, x1 - x0), Math.min(16384, y1 - y0));
      const ctx = c.getContext('2d');
      ctx.setTransform(m.a, m.b, m.c, m.d, m.e - x0, m.f - y0);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(from, 0, 0);
      return c;
    };
    L.canvas = draw(src);
    if (L.mask) L.mask = draw(L.mask);
    L.x = x0; L.y = y0;
    if (isText) { L.kind = 'pixel'; L.text = null; }
  });
  if (isText) toast('The text was turned into pixels so it could be turned or stretched. Undo to get the editable text back.', { timeout: 6000 });
  buildOptions();
}

function cancelTransform() {
  const t = transform;
  if (!t) return;
  transform = null;
  override = null;
  if (t.float) {
    // Put the lifted pixels back where they were.
    const ctx = t.L.canvas.getContext('2d');
    ctx.drawImage(t.float.piece, t.float.b.x - t.L.x, t.float.b.y - t.L.y);
    edit = null;
  }
  render();
  vp.renderOverlay();
  buildOptions();
}

/** Finish whatever tool state is open before doing something else. */
function finishTransient() {
  if (textEdit) commitText();
  if (transform) commitTransform();
  if (crop) cancelCrop();
}

// ---------------------------------------------------------------------------
// Before / after
// ---------------------------------------------------------------------------
function toggleCompare() {
  if (!doc || !file.original) return;
  compare = compare ? null : { split: 0.5 };
  vp.render();
  refresh();
}

function compareDrag(e) {
  const move = (ev) => { const p = vp.toImage(ev); compare.split = clamp(p.x / doc.width, 0, 1); vp.render(); };
  move(e);
  const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

// ---------------------------------------------------------------------------
// Edit operations
// ---------------------------------------------------------------------------
/** The active layer's pixels inside the selection, as a picture-sized canvas. */
function selectedPixels(merged = false) {
  const c = makeCanvas(doc.width, doc.height);
  const ctx = c.getContext('2d');
  if (merged) ctx.drawImage(currentComposite(), 0, 0);
  else { const L = active(); if (L && L.canvas) ctx.drawImage(L.canvas, L.x, L.y); }
  if (sel) { ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(sel.canvas, 0, 0); }
  const b = sel ? sel.bounds : { x: 0, y: 0, w: doc.width, h: doc.height };
  return { canvas: cropped(c, b.x, b.y, b.w, b.h), x: b.x, y: b.y };
}

let clip = null;
async function copy({ merged = false, cut = false } = {}) {
  if (!doc) return;
  const L = active();
  if (!merged && (!L || L.kind === 'adjust')) { toast('Pick a picture layer to copy from.', { type: 'warn' }); return; }
  const piece = selectedPixels(merged);
  clip = { ...piece, w: doc.width, h: doc.height };
  const ok = await host.clipboard.writeImage(await canvasBytes(piece.canvas, 'image/png'));
  if (!ok) toast('Copied inside Photo (the system clipboard refused the picture).', { type: 'warn' });
  if (cut) clearSelected('Cut');
}

async function paste({ inPlace = false, canvas = null, at = null } = {}) {
  if (!doc) { await newFromClipboard(); return; }
  let c = canvas;
  let pos = null;
  if (!c) {
    const png = await host.clipboard.readImage();
    if (png) c = await decodeImage(png, 'image/png');
    // Our own copy remembers where it came from.
    if (clip && (!c || (c.width === clip.canvas.width && c.height === clip.canvas.height))) {
      if (!c) c = cloneCanvas(clip.canvas);
      if (inPlace || (clip.w === doc.width && clip.h === doc.height)) pos = { x: clip.x, y: clip.y };
    }
  }
  if (!c) { toast('There is no picture on the clipboard.', { type: 'warn' }); return; }
  finishTransient();
  if (!pos) {
    const ctr = at || viewCentre();
    pos = { x: Math.round(ctr.x - c.width / 2), y: Math.round(ctr.y - c.height / 2) };
  }
  structural('Paste', () => doc.addPixelLayer(doc.uniqueName('Pasted'), { canvas: c, x: pos.x, y: pos.y }));
}

function viewCentre() {
  const r = vp.el.getBoundingClientRect();
  const p = vp.toImage({ clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 });
  return { x: clamp(p.x, 0, doc.width), y: clamp(p.y, 0, doc.height) };
}

function clearSelected(label = 'Clear') {
  const L = active();
  if (!canPaint(L)) return;
  const which = paintTarget(L);
  paintOnto(L, which, label, (ctx) => {
    if (which === 'mask') {
      // Clearing a mask hides (black).
      ctx.globalCompositeOperation = 'destination-out';
      if (sel) ctx.drawImage(sel.canvas, -L.x, -L.y); else ctx.fillRect(0, 0, L.mask.width, L.mask.height);
      return;
    }
    ctx.globalCompositeOperation = 'destination-out';
    if (sel) ctx.drawImage(sel.canvas, -L.x, -L.y); else ctx.fillRect(0, 0, L.canvas.width, L.canvas.height);
  });
}

function fillSelected(color, label = 'Fill', opacity = 1) {
  const L = active();
  if (!canPaint(L)) return;
  const which = paintTarget(L);
  if (which === 'pixels') coverPicture(L);
  const t = which === 'mask' ? L.mask : L.canvas;
  const c = makeCanvas(t.width, t.height);
  const cctx = c.getContext('2d');
  cctx.fillStyle = which === 'mask' ? '#fff' : color;
  cctx.fillRect(0, 0, c.width, c.height);
  if (sel) { cctx.globalCompositeOperation = 'destination-in'; cctx.drawImage(sel.canvas, -L.x, -L.y); }
  paintOnto(L, which, label, (ctx) => {
    ctx.globalAlpha = opacity;
    if (which === 'mask') {
      const [r, g, b] = rgba(color);
      const v = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
      ctx.globalCompositeOperation = 'destination-out';
      ctx.drawImage(c, 0, 0);
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = opacity * v;
      ctx.drawImage(c, 0, 0);
      return;
    }
    if (L.lockAlpha) ctx.globalCompositeOperation = 'source-atop';
    ctx.drawImage(c, 0, 0);
  });
}

function strokeSelection({ width, color, position }) {
  const L = active();
  if (!sel) { toast('Select something to outline first.', { type: 'warn' }); return; }
  if (!canPaint(L, { allowMask: false })) return;
  coverPicture(L);
  const band = position === 'inside' ? sel.combine(sel.grow(-width).canvas || makeCanvas(1, 1), 'subtract')
    : position === 'outside' ? sel.grow(width).combine(sel.canvas, 'subtract') : sel.border(width);
  if (!band || band.empty) return;
  const c = makeCanvas(doc.width, doc.height);
  const cctx = c.getContext('2d');
  cctx.fillStyle = color;
  cctx.fillRect(0, 0, c.width, c.height);
  cctx.globalCompositeOperation = 'destination-in';
  cctx.drawImage(band.canvas, 0, 0);
  paintOnto(L, 'pixels', 'Stroke', (ctx) => ctx.drawImage(c, -L.x, -L.y));
}

/** Run fn over the active layer's pixels (cut to the selection) as one undo step. */
function processLayer(label, fn, L = active()) {
  if (!canPaint(L)) return false;
  const which = paintTarget(L);
  const target = which === 'mask' ? L.mask : L.canvas;
  const result = fn(target, L);
  if (!result) return false;
  paintOnto(L, which, label, (ctx) => {
    if (sel) {
      // Only inside the selection: mix the result in through it.
      const t = makeCanvas(target.width, target.height);
      const tctx = t.getContext('2d');
      tctx.drawImage(result, 0, 0);
      tctx.globalCompositeOperation = 'destination-in';
      tctx.drawImage(sel.canvas, -L.x, -L.y);
      ctx.globalCompositeOperation = 'destination-out';
      ctx.drawImage(sel.canvas, -L.x, -L.y);
      ctx.globalCompositeOperation = 'source-over';
      ctx.drawImage(t, 0, 0);
    } else {
      ctx.clearRect(0, 0, target.width, target.height);
      ctx.drawImage(result, 0, 0);
    }
  });
  return true;
}

/** A layer's pixels with an adjustment applied (a new canvas). */
function adjusted(src, kind, params) {
  const c = cloneCanvas(src);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const id = ctx.getImageData(0, 0, c.width, c.height);
  applyAdjustment(id, kind, params);
  ctx.putImageData(id, 0, 0);
  return c;
}

function quickAdjust(kind, params = {}) {
  processLayer(ADJUSTMENTS[kind].label, (src) => adjusted(src, kind, { ...defaultParams(kind), ...params }));
}

function autoAdjust(kind) {
  const labels = { tone: 'Auto tone', contrast: 'Auto contrast', color: 'Auto colour', enhance: 'Auto enhance' };
  processLayer(labels[kind], (src) => {
    const c = cloneCanvas(src);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    const id = ctx.getImageData(0, 0, c.width, c.height);
    autoFix(id, kind === 'color' ? 'tone' : kind);
    ctx.putImageData(id, 0, 0);
    return c;
  });
}

// ---------------------------------------------------------------------------
// Layer operations
// ---------------------------------------------------------------------------
function duplicateLayer() {
  const L = active();
  if (!L) return;
  if (sel && L.kind === 'pixel') { layerVia(false); return; }
  structural('Duplicate layer', () => {
    const copyL = newLayer({ ...JSON.parse(JSON.stringify(Object.fromEntries(LAYER_PROPS.map((k) => [k, L[k]])))), name: doc.uniqueName(`${L.name} copy`),
      canvas: L.canvas ? cloneCanvas(L.canvas) : null, mask: L.mask ? cloneCanvas(L.mask) : null });
    doc.layers.splice(doc.layers.indexOf(L) + 1, 0, copyL);
    doc.activeId = copyL.id;
  });
}

/** Layer via copy (or cut): the selected pixels become a new layer. */
function layerVia(cut) {
  const L = active();
  if (!sel || !L || L.kind !== 'pixel') return;
  const piece = selectedPixels(false);
  if (cut) {
    coverPicture(L);
    structural('Layer via cut', () => {
      const c = cloneCanvas(L.canvas);
      const ctx = c.getContext('2d');
      ctx.globalCompositeOperation = 'destination-out';
      ctx.drawImage(sel.canvas, -L.x, -L.y);
      L.canvas = c;
      doc.addPixelLayer(doc.uniqueName(`${L.name} cut`), { canvas: piece.canvas, x: piece.x, y: piece.y });
      sel = null;
    });
  } else structural('Layer via copy', () => { doc.addPixelLayer(doc.uniqueName(`${L.name} copy`), { canvas: piece.canvas, x: piece.x, y: piece.y }); sel = null; });
}

function deleteLayer(L = active()) {
  if (!L) return;
  if (doc.layers.length === 1) { toast('A picture needs at least one layer.', { type: 'warn' }); return; }
  structural('Delete layer', () => {
    const i = doc.layers.indexOf(L);
    doc.layers.splice(i, 1);
    doc.activeId = doc.layers[Math.max(0, i - 1)].id;
  });
}

/** Merge a layer into the one below it (everything about it gets baked in). */
function mergeDown(L = active()) {
  const i = doc.layers.indexOf(L);
  if (i <= 0) return;
  const below = doc.layers[i - 1];
  if (below.kind === 'adjust') { toast('The layer below is an adjustment; rasterise it first or move the layer.', { type: 'warn' }); return; }
  structural('Merge down', () => {
    const tmp = new PhotoDoc(doc.width, doc.height);
    // Combine just the two, over their joint area.
    const area = [below, L].filter((x) => x.canvas).map((x) => ({ x0: x.x, y0: x.y, x1: x.x + x.canvas.width, y1: x.y + x.canvas.height }));
    const x0 = Math.min(0, ...area.map((a) => a.x0)); const y0 = Math.min(0, ...area.map((a) => a.y0));
    const x1 = Math.max(doc.width, ...area.map((a) => a.x1)); const y1 = Math.max(doc.height, ...area.map((a) => a.y1));
    tmp.width = x1 - x0; tmp.height = y1 - y0;
    const shift = (x) => ({ ...x, x: x.x - x0, y: x.y - y0, rev: x.rev });
    tmp.layers = [shift({ ...below, opacity: 1, blend: 'normal', visible: true }), shift({ ...L, visible: L.visible })];
    const out = new Compositor(() => tmp).render({ into: makeCanvas(tmp.width, tmp.height) });
    const merged = newLayer({ name: below.name, canvas: out, x: x0, y: y0, opacity: below.opacity, blend: below.blend, visible: below.visible });
    doc.layers.splice(i - 1, 2, merged);
    doc.activeId = merged.id;
  });
}

function mergeVisible() {
  structural('Merge visible', () => {
    const out = compositor.render({ into: makeCanvas(doc.width, doc.height) });
    const merged = newLayer({ name: 'Merged', canvas: out });
    const firstVisible = doc.layers.findIndex((x) => x.visible);
    doc.layers = doc.layers.filter((x) => !x.visible);
    doc.layers.splice(Math.max(0, Math.min(firstVisible, doc.layers.length)), 0, merged);
    doc.activeId = merged.id;
  });
}

function flatten() {
  structural('Flatten', () => {
    const out = makeCanvas(doc.width, doc.height);
    const ctx = out.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, out.width, out.height);
    ctx.drawImage(compositor.render({ into: makeCanvas(doc.width, doc.height) }), 0, 0);
    const L = newLayer({ name: 'Background', canvas: out });
    doc.layers = [L];
    doc.activeId = L.id;
  });
}

function arrange(dir) {
  const L = active();
  if (!L) return;
  const i = doc.layers.indexOf(L);
  const j = dir === 'top' ? doc.layers.length - 1 : dir === 'bottom' ? 0 : clamp(i + dir, 0, doc.layers.length - 1);
  if (i === j) return;
  structural('Arrange layers', () => { doc.layers.splice(i, 1); doc.layers.splice(j, 0, L); });
}

function moveLayerTo(L, j) {
  const i = doc.layers.indexOf(L);
  if (i < 0 || i === j) return;
  structural('Arrange layers', () => { doc.layers.splice(i, 1); doc.layers.splice(clamp(j, 0, doc.layers.length), 0, L); });
}

function setLayerProps(L, changes, label = 'Layer settings', key = null) {
  structural(label, () => Object.assign(L, changes), { key });
}

function addMask(from = 'all') {
  const L = active();
  if (!L) return;
  if (L.mask) { toast('This layer already has a mask.'); return; }
  const w = L.kind === 'adjust' ? doc.width : L.canvas.width;
  const hh = L.kind === 'adjust' ? doc.height : L.canvas.height;
  structural('Add mask', () => {
    const m = makeCanvas(w, hh);
    const ctx = m.getContext('2d');
    ctx.fillStyle = '#fff';
    if (from === 'selection' && sel) ctx.drawImage(sel.canvas, -L.x, -L.y);
    else if (from === 'hideSelection' && sel) { ctx.fillRect(0, 0, w, hh); ctx.globalCompositeOperation = 'destination-out'; ctx.drawImage(sel.canvas, -L.x, -L.y); } else if (from !== 'none') ctx.fillRect(0, 0, w, hh);
    L.mask = m;
    L.maskOn = true;
    L.editMask = true;
    if (from === 'selection' || from === 'hideSelection') sel = null;
  });
  buildOptions();
}

function deleteMask(apply = false) {
  const L = active();
  if (!L || !L.mask) return;
  structural(apply ? 'Apply mask' : 'Delete mask', () => {
    if (apply && L.kind === 'pixel') {
      const c = cloneCanvas(L.canvas);
      const ctx = c.getContext('2d');
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(L.mask, 0, 0);
      L.canvas = c;
    }
    L.mask = null;
    L.editMask = false;
  });
}

function invertMask() {
  const L = active();
  if (!L || !L.mask) return;
  structural('Invert mask', () => {
    const c = makeCanvas(L.mask.width, L.mask.height);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, c.width, c.height);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(L.mask, 0, 0);
    L.mask = c;
  });
}

function selectionFromLayer(L = active(), mode = 'replace') {
  if (!L || !L.canvas || L.kind === 'adjust') return;
  const c = makeCanvas(doc.width, doc.height);
  const ctx = c.getContext('2d');
  ctx.drawImage(L.canvas, L.x, L.y);
  if (L.mask && L.maskOn) { ctx.globalCompositeOperation = 'destination-in'; ctx.drawImage(L.mask, L.x, L.y); }
  ctx.globalCompositeOperation = 'source-in';
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  setSelection((sel || emptySel()).combine(c, mode), 'Select layer pixels');
}

function addAdjustmentLayer(kind, params = null) {
  structural(`New ${ADJUSTMENTS[kind].label.toLowerCase()} layer`, () => {
    const L = newLayer({ name: ADJUSTMENTS[kind].label, kind: 'adjust', adjust: { kind, params: params || defaultParams(kind) } });
    if (sel) {
      L.mask = makeCanvas(doc.width, doc.height);
      L.mask.getContext('2d').drawImage(sel.canvas, 0, 0);
      sel = null;
    }
    doc.layers.splice(doc.activeIndex + 1, 0, L);
    doc.activeId = L.id;
  });
}

function removeBackground() {
  const L = active();
  if (!L || L.kind !== 'pixel') { toast('Pick a picture layer.', { type: 'warn' }); return; }
  const b = busy('Finding the background…');
  setTimeout(() => {
    try {
      const m = backgroundMask(L.canvas, settings.get('bgTolerance', 40));
      structural('Remove background', () => {
        if (L.mask) {
          const c = cloneCanvas(L.mask);
          const ctx = c.getContext('2d');
          ctx.globalCompositeOperation = 'destination-in';
          ctx.drawImage(m, 0, 0);
          L.mask = c;
        } else L.mask = m;
        L.maskOn = true;
      });
      toast('The background is hidden by a mask: paint on the mask to fix edges (white shows, black hides).', { timeout: 6000 });
    } catch (err) { errorToast(err); } finally { b.close(); }
  }, 30);
}

function selectSubject() {
  const src = currentComposite();
  const m = backgroundMask(src, settings.get('bgTolerance', 40));
  setSelection(emptySel().combine(m), 'Select subject');
}

// ---------------------------------------------------------------------------
// Image operations
// ---------------------------------------------------------------------------
function resizeImage(nw, nh, smooth = true) {
  const sx = nw / doc.width;
  const sy = nh / doc.height;
  structural('Image size', () => {
    for (const L of doc.layers) {
      if (L.kind === 'text') {
        L.text = { ...L.text, size: L.text.size * Math.min(sx, sy), width: L.text.width ? L.text.width * sx : 0 };
        renderText(L);
        L.x = Math.round(L.x * sx); L.y = Math.round(L.y * sy);
        continue;
      }
      if (L.canvas && L.kind === 'pixel') {
        L.canvas = resized(L.canvas, Math.max(1, Math.round(L.canvas.width * sx)), Math.max(1, Math.round(L.canvas.height * sy)), smooth);
        L.x = Math.round(L.x * sx); L.y = Math.round(L.y * sy);
      }
      if (L.mask) L.mask = resized(L.mask, Math.max(1, Math.round(L.mask.width * sx)), Math.max(1, Math.round(L.mask.height * sy)), true);
      if (L.effects) L.effects = scaleEffects(L.effects, Math.min(sx, sy));
    }
    doc.width = nw;
    doc.height = nh;
    sel = null;
  });
  vp.layout();
  vp.fit();
}

function scaleEffects(fx, k) {
  const out = JSON.parse(JSON.stringify(fx));
  if (out.shadow) { out.shadow.distance *= k; out.shadow.blur *= k; }
  if (out.glow) out.glow.size *= k;
  if (out.stroke) out.stroke.size *= k;
  return out;
}

function canvasSize(nw, nh, anchor, fill = null) {
  const dx = anchor.includes('w') ? 0 : anchor.includes('e') ? nw - doc.width : Math.round((nw - doc.width) / 2);
  const dy = anchor.includes('n') ? 0 : anchor.includes('s') ? nh - doc.height : Math.round((nh - doc.height) / 2);
  structural('Canvas size', () => {
    for (const L of doc.layers) {
      if (L.kind === 'adjust') { if (L.mask) { const m = makeCanvas(nw, nh); const ctx = m.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, nw, nh); ctx.clearRect(dx, dy, L.mask.width, L.mask.height); ctx.drawImage(L.mask, dx, dy); L.mask = m; } continue; }
      L.x += dx; L.y += dy;
    }
    if (fill) {
      // New space in a colour: a layer at the bottom.
      const bgL = newLayer({ name: 'Canvas', canvas: makeCanvas(nw, nh) });
      const ctx = bgL.canvas.getContext('2d');
      ctx.fillStyle = fill;
      ctx.fillRect(0, 0, nw, nh);
      doc.layers.unshift(bgL);
    }
    doc.width = nw;
    doc.height = nh;
    sel = sel ? sel.resized(nw, nh, dx, dy) : null;
  });
  vp.layout();
  vp.fit();
}

/** Turn or flip the whole picture (every layer). */
function transformImage(label, kind) {
  const W = doc.width;
  const H = doc.height;
  const swap = kind === 'cw' || kind === 'ccw';
  const nw = swap ? H : W;
  const nh = swap ? W : H;
  const mapPoint = (x, y) => {
    if (kind === 'cw') return [H - y, x];
    if (kind === 'ccw') return [y, W - x];
    if (kind === '180') return [W - x, H - y];
    if (kind === 'h') return [W - x, y];
    return [x, H - y];
  };
  const turn = (c) => (kind === 'cw' ? rotated(c, 90) : kind === 'ccw' ? rotated(c, -90) : kind === '180' ? rotated(c, 180) : flipped(c, kind === 'h'));
  structural(label, () => {
    for (const L of doc.layers) {
      if (L.kind === 'text' && (kind === 'h' || kind === 'v' || swap || kind === '180')) {
        // Text cannot be mirrored or turned as text: rasterise it.
        L.kind = 'pixel'; L.text = null; L.canvas = cloneCanvas(L.canvas);
      }
      if (L.kind === 'adjust') { if (L.mask) L.mask = turn(L.mask); continue; }
      const [ax, ay] = mapPoint(L.x, L.y);
      const [bx, by] = mapPoint(L.x + L.canvas.width, L.y + L.canvas.height);
      L.canvas = turn(L.canvas);
      if (L.mask) L.mask = turn(L.mask);
      L.x = Math.min(ax, bx); L.y = Math.min(ay, by);
    }
    doc.width = nw;
    doc.height = nh;
    if (sel) {
      const s = sel;
      sel = new Selection(nw, nh, turn(s.canvas));
    }
  });
  vp.layout();
  vp.fit();
}

function flipLayer(horizontal) {
  const L = active();
  if (!L || L.kind === 'adjust') return;
  if (sel && L.kind === 'pixel') { processLayer(horizontal ? 'Flip selection' : 'Flip selection', (src) => flipSelected(src, L, horizontal)); return; }
  structural(horizontal ? 'Flip layer horizontally' : 'Flip layer vertically', () => {
    if (L.kind === 'text') { L.kind = 'pixel'; L.text = null; }
    L.canvas = flipped(L.canvas, horizontal);
    if (L.mask) L.mask = flipped(L.mask, horizontal);
    // Mirror the layer's place in the picture too.
    if (horizontal) L.x = doc.width - L.x - L.canvas.width; else L.y = doc.height - L.y - L.canvas.height;
  });
}

function flipSelected(src, L, horizontal) {
  const b = sel.bounds;
  const out = cloneCanvas(src);
  const ctx = out.getContext('2d');
  ctx.save();
  if (horizontal) { ctx.translate(2 * (b.x - L.x) + b.w, 0); ctx.scale(-1, 1); } else { ctx.translate(0, 2 * (b.y - L.y) + b.h); ctx.scale(1, -1); }
  ctx.globalCompositeOperation = 'copy';
  ctx.drawImage(src, 0, 0);
  ctx.restore();
  return out;
}

function rotateLayer(deg) {
  const L = active();
  if (!L || L.kind === 'adjust') return;
  startTransform();
  if (!transform) return;
  transform.angle += (deg * Math.PI) / 180;
  showTransform();
  commitTransform();
}

function cropToSelection() {
  if (!sel) return;
  crop = { ...sel.bounds };
  applyCrop();
}

function trim(mode = 'transparent') {
  const c = currentComposite();
  const b = contentBounds(c);
  if (mode === 'transparent') {
    if (!b) { toast('The picture is empty.'); return; }
    if (b.w === doc.width && b.h === doc.height) { toast('There is no see-through border to trim.'); return; }
    crop = b;
    applyCrop();
  }
}

function revealAll() {
  let x0 = 0; let y0 = 0; let x1 = doc.width; let y1 = doc.height;
  for (const L of doc.layers) {
    if (!L.canvas || L.kind === 'adjust') continue;
    const cb = contentBounds(L.canvas);
    if (!cb) continue;
    x0 = Math.min(x0, L.x + cb.x); y0 = Math.min(y0, L.y + cb.y);
    x1 = Math.max(x1, L.x + cb.x + cb.w); y1 = Math.max(y1, L.y + cb.y + cb.h);
  }
  if (x0 === 0 && y0 === 0 && x1 === doc.width && y1 === doc.height) { toast('Everything is already in view.'); return; }
  crop = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  const keep = st.opts.crop.deleteCropped;
  st.opts.crop.deleteCropped = false;
  applyCrop();
  st.opts.crop.deleteCropped = keep;
}

// ---------------------------------------------------------------------------
// Colours
// ---------------------------------------------------------------------------
function setColor(which, c) {
  st[which] = c;
  settings.set(which, c);
  drawColors();
  if (st.tool === 'text' && which === 'fg') setTextProp('color', c);
}

function drawColors() {
  const fg = h('button.ph-swatch.fg', { style: { background: st.fg }, 'data-tip': 'Foreground colour (paints). Click to change.' });
  const bgB = h('button.ph-swatch.bg', { style: { background: st.bg }, 'data-tip': 'Background colour. Click to change.' });
  const swap = h('button.ph-mini', { 'data-tip': 'Swap colours', 'data-keys': 'X', html: icon('repeat', 12) });
  const reset = h('button.ph-mini.reset', { 'data-tip': 'Black and white', 'data-keys': 'D' }, h('span'), h('span'));
  const edit = (which, anchor) => {
    const picker = colorPicker({ value: st[which], onChange: (c) => setColor(which, toHex(parseColor(c))), onPick: (c) => { closeMenus(); setColor(which, toHex(parseColor(c))); } });
    popover(picker, { anchor });
  };
  fg.addEventListener('click', () => edit('fg', fg));
  bgB.addEventListener('click', () => edit('bg', bgB));
  swap.addEventListener('click', () => commands.run('color.swap'));
  reset.addEventListener('click', () => commands.run('color.reset'));
  colorsBox.replaceChildren(h('div.ph-pair', bgB, fg, swap, reset));
}

// ---------------------------------------------------------------------------
// Tool box and options bar
// ---------------------------------------------------------------------------
function setTool(t) {
  if (!TOOL_INFO[t]) return;
  if (t === st.tool && t !== 'crop') return;
  if (textEdit) commitText();
  if (transform) commitTransform();
  if (crop && t !== 'crop') cancelCrop();
  if (t === 'eyedropper') st.prevTool = st.tool;
  st.tool = t;
  settings.set('tool', t);
  const g = GROUPS.find((x) => x.includes(t));
  if (g && g.length > 1) { st.groupTool[g[0]] = t; settings.set('groupTool', st.groupTool); }
  if (t === 'crop') startCrop();
  guide = null;
  buildToolbox();
  buildOptions();
  refresh();
  vp.renderOverlay();
}

function buildToolbox() {
  toolbox.replaceChildren(...GROUPS.map((g) => {
    const cur = g.includes(st.tool) ? st.tool : st.groupTool[g[0]] && g.includes(st.groupTool[g[0]]) ? st.groupTool[g[0]] : g[0];
    const [label, ic, keys] = TOOL_INFO[cur];
    const b = h(`button.ph-tool${g.includes(st.tool) ? '.on' : ''}`, { 'data-tip': label, 'data-keys': keys || '', html: icon(ic, 18) });
    if (g.length > 1) b.append(h('span.ph-more'));
    b.addEventListener('click', () => setTool(cur));
    const menu = (e) => {
      e.preventDefault();
      showMenu(g.map((t) => ({ label: TOOL_INFO[t][0], icon: TOOL_INFO[t][1], keys: TOOL_INFO[t][2], checked: st.tool === t, run: () => setTool(t) })), { anchor: b });
    };
    if (g.length > 1) b.addEventListener('contextmenu', menu);
    let hold = 0;
    b.addEventListener('pointerdown', (e) => { if (g.length > 1) hold = setTimeout(() => menu(e), 450); });
    b.addEventListener('pointerup', () => clearTimeout(hold));
    b.addEventListener('pointerleave', () => clearTimeout(hold));
    return b;
  }));
}

function slider(label, value, min, max, step, onInput, { suffix = '', width = 90, tip = '' } = {}) {
  const input = h('input', { type: 'range', min, max, step, value, 'data-tip': tip || label, style: { width: `${width}px` } });
  const out = h('input.input.num.opt-num', { value: String(value), 'data-tip': label });
  input.addEventListener('input', () => { out.value = input.value; onInput(Number(input.value)); });
  out.addEventListener('change', () => { const v = clamp(Number(out.value) || 0, Number(min), Number(max)); input.value = v; out.value = v; onInput(v); });
  return h('label.opt', h('span.muted', label), input, out, suffix ? h('span.muted', suffix) : null);
}

/** A number box with a pop-out slider: small enough for the options bar; the wheel adjusts it. */
function compact(label, value, min, max, step, onInput, { suffix = '', tip = '', wheel = null } = {}) {
  const num = h('input.input.num.opt-num', { value: String(value), min, max, step, 'data-tip': tip || label });
  const apply = (v) => { const x = clamp(Number(v) || 0, min, max); num.value = String(x); onInput(x); };
  num.addEventListener('change', () => apply(num.value));
  if (wheel) {
    // Big ranges (brush size) change in proportion, not one by one.
    num.dataset.noWheel = '';
    num.setAttribute('data-no-wheel', '');
    num.addEventListener('wheel', (e) => { e.preventDefault(); num.value = String(wheel(e.deltaY < 0 ? 1 : -1)); }, { passive: false });
  }
  const more = h('button.tb.opt-more', { 'data-tip': `${label} slider`, html: icon('chevronDown', 10) });
  more.addEventListener('click', () => {
    const r = h('input', { type: 'range', min, max, step, value: num.value, style: { width: '220px' } });
    r.addEventListener('input', () => apply(r.value));
    popover(h('div.ph-brushpop', h('span.muted', label), r), { anchor: num });
  });
  return h('label.opt', h('span.muted', label), h('span.opt-box', num, suffix ? h('span.muted', suffix) : null, more));
}

function check(label, value, onChange, tip = '') {
  const c = h('input', { type: 'checkbox', checked: !!value });
  c.addEventListener('change', () => onChange(c.checked));
  return h('label.check.opt', { 'data-tip': tip || label }, c, label);
}

function seg(options, value, onChange) {
  return h('div.seg', ...options.map(([v, l, tip]) => {
    const b = h(`button${value === v ? '.on' : ''}`, { 'data-tip': tip || l }, l);
    b.addEventListener('click', () => { onChange(v); buildOptions(); });
    return b;
  }));
}

let fontList = knownFonts();
allFonts().then((l) => { fontList = l; });

function setOpt(key, v, rerender = false) { st.opts[st.tool][key] = v; saveOpts(); if (rerender) buildOptions(); vp.renderOverlay(); }

function buildOptions() {
  const t = st.tool;
  const o = O();
  const items = [h('span.opt-title', TOOL_INFO[t][0])];
  const L = active();
  if (transform) {
    const num = (label, get, set, suffix) => {
      const i = h('input.input.num.opt-num', { value: String(get()) });
      i.addEventListener('change', () => { set(Number(i.value) || 0); showTransform(); });
      return h('label.opt', h('span.muted', label), i, h('span.muted', suffix));
    };
    items.splice(0, 1, h('span.opt-title', 'Transform'),
      num('W', () => Math.round(transform.sx * 100), (v) => { transform.sx = v / 100; }, '%'),
      num('H', () => Math.round(transform.sy * 100), (v) => { transform.sy = v / 100; }, '%'),
      num('Angle', () => Math.round((transform.angle * 180) / Math.PI), (v) => { transform.angle = (v * Math.PI) / 180; }, '°'),
      tb({ icon: 'flipH', tip: 'Flip horizontally', run: () => { transform.sx *= -1; showTransform(); } }),
      tb({ icon: 'flipV', tip: 'Flip vertically', run: () => { transform.sy *= -1; showTransform(); } }),
      h('span.muted', 'Drag inside to move, corners to resize (Shift: free), outside to turn.'),
      h('div.spacer'),
      h('button.btn', { onclick: () => cancelTransform() }, 'Cancel'), h('button.btn.primary', { onclick: () => commitTransform() }, 'Apply'));
    optionsBar.replaceChildren(...items);
    return;
  }
  const brushBasics = () => [
    compact('Size', o.size, 1, 1000, 1, (v) => setOpt('size', v), { suffix: 'px', tip: 'Brush size ([ and ], or Alt+wheel over the picture)', wheel: (dir) => { sizeStep(dir); return O().size; } }),
    compact('Hardness', Math.round((o.hardness ?? 0.8) * 100), 0, 100, 5, (v) => setOpt('hardness', v / 100), { suffix: '%', tip: 'Hardness (Shift+[ and Shift+])' }),
    compact('Opacity', Math.round((o.opacity ?? 1) * 100), 1, 100, 5, (v) => setOpt('opacity', v / 100), { suffix: '%', tip: 'Opacity (number keys: 1 = 10% … 0 = 100%)' }),
  ];
  if (['brush', 'eraser'].includes(t)) {
    items.push(...brushBasics(), compact('Flow', Math.round((o.flow ?? 1) * 100), 1, 100, 5, (v) => setOpt('flow', v / 100), { suffix: '%', tip: 'Flow: how much paint each dab adds' }),
      compact('Smoothing', o.smoothing || 0, 0, 90, 5, (v) => setOpt('smoothing', v), { suffix: '%', tip: 'Steadier lines: the brush follows the pointer on an elastic band' }));
  } else if (t === 'clone' || t === 'heal') {
    items.push(...brushBasics(), check('Aligned', o.aligned, (v) => { setOpt('aligned', v); cloneOffset = null; }, 'Keep the same distance between source and brush for every stroke'),
      check('All layers', o.sampleAll, (v) => setOpt('sampleAll', v), 'Copy from the whole picture, not just this layer'),
      h('span.muted', cloneSrc ? 'Alt+click to pick a new source.' : 'Alt+click to choose where to copy from.'));
  } else if (t === 'spot') {
    items.push(...brushBasics(), h('span.muted', 'Paint over spots, wires or blemishes: they are filled from around them.'));
  } else if (['smudge', 'blur', 'sharpen'].includes(t)) {
    items.push(...brushBasics());
  } else if (t === 'dodge' || t === 'burn') {
    items.push(...brushBasics(), seg([['shadows', 'Shadows'], ['midtones', 'Midtones'], ['highlights', 'Highlights']], o.mode, (v) => setOpt('mode', v)));
  } else if (t === 'sponge') {
    items.push(...brushBasics(), seg([['saturate', 'More colour'], ['desaturate', 'Less colour']], o.mode, (v) => setOpt('mode', v)));
  } else if (t === 'gradient') {
    items.push(seg([['linear', 'Straight'], ['radial', 'Round'], ['reflected', 'Mirrored'], ['angle', 'Sweep']], o.kind, (v) => setOpt('kind', v)),
      check('To transparent', o.toTransparent, (v) => setOpt('toTransparent', v), 'Fade the foreground colour out instead of into the background colour'),
      check('Reverse', o.reverse, (v) => setOpt('reverse', v)),
      compact('Opacity', Math.round((o.opacity ?? 1) * 100), 1, 100, 5, (v) => setOpt('opacity', v / 100), { suffix: '%' }));
  } else if (t === 'fill') {
    items.push(compact('Tolerance', o.tolerance, 0, 255, 2, (v) => setOpt('tolerance', v)), check('Touching only', o.contiguous, (v) => setOpt('contiguous', v)),
      check('All layers', o.sampleAll, (v) => setOpt('sampleAll', v)), compact('Opacity', Math.round((o.opacity ?? 1) * 100), 1, 100, 5, (v) => setOpt('opacity', v / 100), { suffix: '%' }));
  } else if (SELECT_TOOLS.includes(t)) {
    items.push(seg([['replace', 'New', 'New selection'], ['add', 'Add', 'Add (or hold Shift)'], ['subtract', 'Take away', 'Take away (or hold Alt)'], ['intersect', 'Overlap', 'Keep the overlap (or Shift+Alt)']], o.mode || 'replace', (v) => setOpt('mode', v)));
    if (t === 'wand') items.push(compact('Tolerance', o.tolerance, 0, 255, 2, (v) => setOpt('tolerance', v)), check('Touching only', o.contiguous, (v) => setOpt('contiguous', v)), check('All layers', o.sampleAll, (v) => setOpt('sampleAll', v)));
    else items.push(compact('Feather', o.feather || 0, 0, 200, 1, (v) => setOpt('feather', v), { suffix: 'px', tip: 'Soft edges' }));
    items.push(tb({ icon: 'wand', label: 'Select subject', showLabel: true, run: () => selectSubject(), tip: 'Select what stands out from a plain background' }),
      tb({ icon: 'droplet', label: 'Refine…', showLabel: true, run: () => refineDialog(), disabled: () => !sel }));
  } else if (t === 'crop') {
    items.push(select({ options: Object.keys(RATIOS).map((k) => ({ value: k, label: k === 'free' ? 'Any shape' : k === 'original' ? 'As the picture' : k })), value: o.ratio, tip: 'Shape of the crop', onChange: (v) => { setOpt('ratio', v); } }),
      check('Delete cropped pixels', o.deleteCropped, (v) => setOpt('deleteCropped', v), 'Off: layers keep what is outside, so you can move them back in later'),
      h('span.muted', 'Drag the frame, then Enter (or double-click) to crop.'), h('div.spacer'),
      h('button.btn', { onclick: () => { cancelCrop(); setTool(st.prevTool && st.prevTool !== 'crop' ? st.prevTool : 'move'); } }, 'Cancel'), h('button.btn.primary', { onclick: () => applyCrop() }, 'Crop'));
  } else if (t === 'text') {
    const tx = st.opts.text;
    const lt = L && L.kind === 'text' ? { ...TEXT_DEFAULTS, ...L.text } : tx;
    items.push(combo({ values: () => fontList, value: lt.font, width: 170, itemStyle: (f) => ({ fontFamily: `"${f}"` }), onCommit: (v) => setTextProp('font', v) }),
      combo({ values: FONT_SIZES.concat([120, 144, 200, 288]), value: String(lt.size), width: 70, numeric: true, min: 1, max: 2000, onCommit: (v) => setTextProp('size', clamp(Number(v) || 72, 1, 2000)) }),
      tb({ icon: 'bold', tip: 'Bold', on: () => { const a = active(); return a && a.kind === 'text' ? a.text.bold : tx.bold; }, run: () => { const a = active(); setTextProp('bold', !(a && a.kind === 'text' ? a.text.bold : tx.bold)); refresh(); } }),
      tb({ icon: 'italic', tip: 'Italic', on: () => { const a = active(); return a && a.kind === 'text' ? a.text.italic : tx.italic; }, run: () => { const a = active(); setTextProp('italic', !(a && a.kind === 'text' ? a.text.italic : tx.italic)); refresh(); } }),
      seg([['left', 'Left'], ['center', 'Centre'], ['right', 'Right']], lt.align, (v) => setTextProp('align', v)),
      compact('Spacing', lt.letterSpacing || 0, -20, 100, 1, (v) => setTextProp('letterSpacing', v), { tip: 'Letter spacing' }),
      compact('Lines', Math.round((lt.lineHeight || 1.2) * 100), 70, 300, 5, (v) => setTextProp('lineHeight', v / 100), { suffix: '%', tip: 'Line spacing' }),
      h('span.muted', 'Colour: the foreground colour.'));
  } else if (t === 'shape') {
    const cur = SHAPES.find((s) => s[0] === o.kind) || SHAPES[0];
    const b = h('button.tb.gallery-btn', { 'data-tip': `Shape: ${cur[1]}`, html: `${shapeIcon(o.kind)}${icon('chevronDown', 10)}` });
    b.addEventListener('click', () => {
      const grid = h('div.choice-grid', ...SHAPES.map(([k, l]) => {
        const x = h(`button${o.kind === k ? '.on' : ''}`, { 'data-tip': l, html: shapeIcon(k) });
        x.addEventListener('click', () => { closeMenus(); setOpt('kind', k, true); });
        return x;
      }));
      popover(grid, { anchor: b });
    });
    items.push(b, check('Fill (foreground)', o.fill, (v) => setOpt('fill', v)), check('Outline (background)', o.stroke, (v) => setOpt('stroke', v)),
      compact('Line', o.strokeWidth, 1, 100, 1, (v) => setOpt('strokeWidth', v), { suffix: 'px' }), h('span.muted', 'Each shape goes on its own layer. Shift: even sides, Alt: from the centre.'));
  } else if (t === 'eyedropper') {
    const eo = st.opts.eyedropper;
    items.push(select({ options: [{ value: 'all', label: 'All layers' }, { value: 'layer', label: 'This layer' }], value: eo.sample, onChange: (v) => { eo.sample = v; saveOpts(); } }),
      select({ options: [{ value: 1, label: 'Single pixel' }, { value: 3, label: '3 × 3 average' }, { value: 5, label: '5 × 5 average' }, { value: 11, label: '11 × 11 average' }], value: eo.size, onChange: (v) => { eo.size = Number(v); saveOpts(); } }),
      h('span.muted', 'Click: foreground. Alt+click: background.'));
  } else if (t === 'move') {
    items.push(check('Pick layer by clicking', o.autoSelect, (v) => setOpt('autoSelect', v), 'Click picks the top layer under the pointer (or hold Ctrl)'),
      tb({ icon: 'resize', label: 'Transform', showLabel: true, keys: 'Ctrl+T', run: () => startTransform() }),
      h('span.muted', 'Drag to move the layer (or the selected pixels; Alt keeps a copy). Arrow keys nudge.'));
  } else if (t === 'hand') items.push(h('span.muted', 'Drag to look around. Tip: hold Space with any tool.'));
  else if (t === 'zoom') items.push(h('span.muted', 'Click to zoom in, Alt+click to zoom out. The wheel zooms anywhere.'), tb('view.fit', { showLabel: true }), tb('view.zoom100', { showLabel: true }));
  if (L && L.editMask && L.mask && (BRUSH_TOOLS.includes(t) || t === 'gradient' || t === 'fill')) items.push(h('span.ph-badge', { 'data-tip': 'Painting on the mask: white shows, black hides' }, 'Mask'));
  optionsBar.replaceChildren(...items);
}

function shapeIcon(k) {
  if (k === 'line') return icon('line', 20);
  return `<svg viewBox="0 0 24 18" width="22" height="17"><path d="${shapePath(k, 24, 18, 0.15)}" fill="none" stroke="currentColor" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>`;
}

// ---------------------------------------------------------------------------
// Dialog helpers given to dialogs.js and panels.js
// ---------------------------------------------------------------------------
const A = {
  get doc() { return doc; },
  get sel() { return sel; },
  get st() { return st; },
  settings, vp, compositor, history,
  active, render, changed, structural, setSelection, selectLayer, setLayerProps, moveLayerTo, deleteLayer, duplicateLayer, mergeDown,
  addMask, deleteMask, invertMask, selectionFromLayer, addAdjustmentLayer, rasterize, processLayer, adjusted, emptySel, buildOptions,
  composite: () => currentComposite(),
  setPreview(ov) { override = ov; render(); },
  previewSelection(s) { sel = s && !s.empty ? s : null; selChanged(); },
  pickOnce(cb) { pickCallback = cb; },
  set previewing(v) { previewing = v; },
  get previewing() { return previewing; },
  resizeImage, canvasSize, newDocument: (w, hh, bg, name) => newDocument(w, hh, bg, name), strokeSelection, fillSelected,
  layerMenu: (L) => layerContextMenu(L), runCommand: (id) => commands.run(id),
  thumbOf: (L, which) => layerThumb(L, doc, 36, which),
  jumpHistory: (i) => { finishTransient(); history.jump(i); },
};


async function refineDialog() {
  if (!sel) return;
  const r = await D.refineSelection(A);
  if (!r) return;
  let next = sel;
  if (r.grow) next = next.grow(r.grow);
  if (r.feather) next = next.feather(r.feather);
  if (r.invert) next = next.invert();
  setSelection(next, 'Refine selection');
}

// ---------------------------------------------------------------------------
// Documents and files
// ---------------------------------------------------------------------------
function newDocument(w, hh, background = '#ffffff', name = 'Untitled') {
  const d = new PhotoDoc(w, hh);
  const c = makeCanvas(w, hh);
  if (background && background !== 'transparent') {
    const ctx = c.getContext('2d');
    ctx.fillStyle = background;
    ctx.fillRect(0, 0, w, hh);
  }
  d.layers.push(newLayer({ name: background === 'transparent' ? 'Layer 1' : 'Background', canvas: c }));
  d.activeId = d.layers[0].id;
  useDocument(d, { name, handle: null, format: 'ora' });
}

function useDocument(d, { name, handle, format }) {
  finishTransient();
  doc = d;
  sel = null;
  lastSel = null;
  file.handle = handle;
  file.name = name;
  file.format = format;
  history.clear();
  historyBytes = 0;
  override = null;
  compare = null;
  start.hide();
  centre.classList.remove('hidden');
  side.classList.remove('hidden');
  vp.fitted = false;
  vp.layout();
  vp.fit();
  changed();
  // Remember how it looked when opened (for before/after).
  file.original = cloneCanvas(currentComposite());
  updateTitle();
  buildOptions();
  refresh();
}

/** A document from layer records read from a file. */
function docFromLayers({ width, height, layers }) {
  const d = new PhotoDoc(width, height);
  for (const r of layers) {
    const L = newLayer({ ...r });
    if (L.kind === 'text' && L.text) renderText(L);
    if (L.kind === 'adjust' && !L.adjust) L.kind = 'pixel';
    d.layers.push(L);
  }
  d.activeId = d.layers[d.layers.length - 1].id;
  return d;
}

async function openFile(f) {
  if (doc && !(await confirmLeave())) return;
  const b = busy(`Opening ${f.name}…`);
  try {
    const bytes = await host.read(f);
    const ext = extOf(f.name);
    let d;
    if (ext === 'psd') d = docFromLayers(await readPsd(bytes));
    else if (ext === 'ora') d = docFromLayers(await readOra(bytes));
    else {
      const c = await decodeImage(bytes, IMAGE_TYPES[ext] || '');
      d = new PhotoDoc(c.width, c.height);
      d.layers.push(newLayer({ name: 'Background', canvas: c }));
      d.activeId = d.layers[0].id;
    }
    const fmt = formatOf(f.name);
    useDocument(d, { name: f.name, handle: fmt && f.writable !== false ? f : null, format: fmt || 'png' });
    refreshRecent();
  } catch (err) { errorToast(err); } finally { b.close(); }
}

async function openDialog() {
  const files = await host.openFiles({ filters: OPEN_FILTERS, multiple: true });
  if (!files.length) return;
  if (!doc) { await openFile(files[0]); files.slice(1).forEach((f) => host.openInNewWindow && host.openInNewWindow(f)); return; }
  // With a picture open, more pictures open in their own windows when they can.
  for (const f of files) {
    if (host.openInNewWindow && (isDirty() || history.canUndo)) host.openInNewWindow(f); else await openFile(f);
  }
}

/** Put pictures into the open document as new layers. */
async function placeFiles(files, at = null) {
  for (const f of files) {
    try {
      const c = await decodeImage(await host.read(f), IMAGE_TYPES[extOf(f.name)] || '');
      await paste({ canvas: c, at });
      const L = active();
      if (L) { L.name = doc.uniqueName(baseName(f.name)); if (panels) panels.layers(); }
    } catch (err) { errorToast(err); }
  }
}

async function newFromClipboard() {
  const png = await host.clipboard.readImage();
  if (!png) { toast('There is no picture on the clipboard.', { type: 'warn' }); return; }
  if (doc && !(await confirmLeave())) return;
  const c = await decodeImage(png, 'image/png');
  const d = new PhotoDoc(c.width, c.height);
  d.layers.push(newLayer({ name: 'Pasted', canvas: c }));
  d.activeId = d.layers[0].id;
  useDocument(d, { name: 'Untitled', handle: null, format: 'png' });
}

async function confirmLeave() {
  if (!isDirty()) return true;
  const r = await saveChangesBox(file.name);
  if (r === 'save') return save();
  return r === 'discard';
}

function flatComposite(format) {
  finishTransient();
  const c = compositor.render({ into: makeCanvas(doc.width, doc.height) });
  if (format !== 'jpg' && format !== 'bmp') return c;
  // No transparency in these formats: lay it on white.
  const out = makeCanvas(c.width, c.height);
  const ctx = out.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, out.width, out.height);
  ctx.drawImage(c, 0, 0);
  return out;
}

function layerRecords() {
  return doc.layers.map((L) => ({ name: L.name, kind: L.kind, canvas: L.canvas, x: L.x, y: L.y, opacity: L.opacity, visible: L.visible, blend: L.blend, mask: L.mask, maskOn: L.maskOn, text: L.text, effects: L.effects, adjust: L.adjust, locked: L.locked, lockAlpha: L.lockAlpha }));
}

async function encode(format, quality = settings.get('quality', 0.92)) {
  finishTransient();
  if (format === 'ora') return writeOra({ width: doc.width, height: doc.height, layers: layerRecords(), composite: flatComposite('png') });
  if (format === 'psd') {
    // Photoshop cannot read our text, effects and adjustment layers: bake them into pixels.
    const records = [];
    for (const L of doc.layers) {
      if (L.kind === 'adjust') continue;
      let canvas = L.canvas;
      let x = L.x; let y = L.y;
      if (L.effects) {
        const one = new PhotoDoc(doc.width, doc.height);
        const pad = 200;
        one.width = canvas.width + pad * 2; one.height = canvas.height + pad * 2;
        one.layers = [{ ...L, x: pad, y: pad, opacity: 1, blend: 'normal', visible: true, mask: null }];
        canvas = new Compositor(() => one).render({ into: makeCanvas(one.width, one.height) });
        x -= pad; y -= pad;
      }
      records.push({ name: L.name, canvas, x, y, opacity: L.opacity, visible: L.visible, blend: L.blend, mask: L.effects ? null : L.mask, maskOn: L.maskOn });
    }
    if (doc.layers.some((L) => L.kind === 'adjust')) toast('Adjustment layers are not saved in PSD files; the flattened picture includes them.', { type: 'warn', timeout: 6000 });
    return writePsd({ width: doc.width, height: doc.height, layers: records, composite: flatComposite('png') });
  }
  return canvasBytes(flatComposite(format), FORMATS[format].mime, quality);
}

async function save() {
  if (!doc) return false;
  if (!file.handle || !file.handle.writable || !FORMATS[file.format]) return saveAs();
  if (!FORMATS[file.format].layered && (doc.layers.length > 1 || doc.layers.some((L) => L.kind !== 'pixel' || L.mask || L.effects))) {
    // Saving layers into a flat picture loses them: ask once.
    const r = await modal({ title: 'Keep the layers?', body: `“${file.name}” is a flat picture, so its layers would be merged when saved.`, cancelValue: 'cancel',
      buttons: [{ label: 'Cancel', value: 'cancel', left: true }, { label: 'Save merged', value: 'flat' }, { label: 'Save as a project…', value: 'project', primary: true }] });
    if (r === 'cancel') return false;
    if (r === 'project') return saveAs('ora');
  }
  const b = busy(`Saving ${file.name}…`);
  try {
    file.handle = await host.write(file.handle, await encode(file.format));
    history.markSaved();
    updateTitle();
    toast(`Saved ${file.name}`, { timeout: 1500 });
    return true;
  } catch (err) { errorToast(err); return false; } finally { b.close(); }
}

async function saveAs(format = null) {
  if (!doc) return false;
  const layered = doc.layers.length > 1 || doc.layers.some((L) => L.kind !== 'pixel' || L.mask || L.effects);
  const fmt = format || (FORMATS[file.format] && (FORMATS[file.format].layered || !layered) ? file.format : 'ora');
  const base = baseName(file.name === 'Untitled' ? 'Picture' : file.name);
  const b = busy('Preparing…');
  let data;
  try { data = await encode(fmt); } catch (err) { b.close(); errorToast(err); return false; }
  b.close();
  try {
    const others = Object.entries(FORMATS).filter(([k]) => k !== fmt).map(([, v]) => v);
    const f = await host.saveAs({ name: `${base}.${FORMATS[fmt].exts[0]}`, filters: [FORMATS[fmt], ...others], near: file.handle && file.handle.id }, data);
    if (!f) return false;
    const real = formatOf(f.name) || fmt;
    if (real !== fmt && f.id) await host.write(f, await encode(real));
    file.handle = f.id ? f : null;
    file.name = f.name;
    file.format = real;
    history.markSaved();
    updateTitle();
    refreshRecent();
    toast(`Saved ${f.name}`, { timeout: 1800 });
    return true;
  } catch (err) { errorToast(err); return false; }
}

async function exportAs() {
  if (!doc) return;
  const r = await D.exportDialog(A, { flat: (fmt) => flatComposite(fmt), name: baseName(file.name === 'Untitled' ? 'Picture' : file.name) });
  if (!r) return;
  try {
    const f = await host.saveAs({ name: r.name, filters: [FORMATS[r.format]] }, r.bytes);
    if (f) toast(`Exported ${f.name}`, { timeout: 1800 });
  } catch (err) { errorToast(err); }
}

async function printPicture() {
  if (!doc) return;
  const url = flatComposite('png').toDataURL('image/png');
  const view = h('div.print-pic', h('img', { src: url }));
  document.body.append(view);
  document.body.classList.add('printing-pic');
  try { await host.print(); } finally { document.body.classList.remove('printing-pic'); view.remove(); }
}

let recentCache = [];
const refreshRecent = () => host.recent().then((r) => { recentCache = r; }).catch(() => {});
refreshRecent();

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
const hasDoc = () => !!doc;
const hasSel = () => !!doc && !!sel;
const hasLayer = () => !!doc && !!active();
const C = (id, label, keys, run, extra = {}) => ({ id, label, keys, run, when: hasDoc, ...extra });
const adjCmd = (kind, keys = null) => C(`adj.${kind}`, `${ADJUSTMENTS[kind].label}…`, keys, () => D.adjustDialog(A, kind), { category: 'Adjust', icon: 'sliders' });

commands.register(
  C('file.new', 'New…', 'Ctrl+N', async () => { if (doc && !(await confirmLeave())) return; const r = await D.newDialog(A, PRESETS); if (r) newDocument(r.w, r.h, r.background, r.name); }, { icon: 'new', category: 'File', when: null }),
  C('file.newClip', 'New From Clipboard', 'Ctrl+Alt+N', () => newFromClipboard(), { icon: 'paste', category: 'File', when: null }),
  C('file.open', 'Open…', 'Ctrl+O', () => openDialog(), { icon: 'open', category: 'File', when: null }),
  C('file.place', 'Place Picture as Layer…', null, async () => { const fs = await host.openFiles({ filters: OPEN_FILTERS, multiple: true }); if (fs.length) placeFiles(fs); }, { icon: 'image', category: 'File' }),
  C('file.save', 'Save', 'Ctrl+S', () => save(), { icon: 'save', category: 'File' }),
  C('file.saveAs', 'Save As…', 'Ctrl+Shift+S', () => saveAs(), { icon: 'saveAs', category: 'File' }),
  C('file.export', 'Export As…', 'Ctrl+Alt+Shift+W', () => exportAs(), { icon: 'export', category: 'File' }),
  C('file.print', 'Print…', 'Ctrl+P', () => printPicture(), { icon: 'print', category: 'File' }),

  C('edit.undo', 'Undo', 'Ctrl+Z', () => { if (textEdit) { commitText(); } if (transform) { cancelTransform(); return; } if (crop) { cancelCrop(); return; } history.undo(); }, { icon: 'undo', category: 'Edit', when: () => !!doc && (history.canUndo || !!transform || !!crop) }),
  C('edit.redo', 'Redo', ['Ctrl+Shift+Z', 'Ctrl+Y'], () => { finishTransient(); history.redo(); }, { icon: 'redo', category: 'Edit', when: () => !!doc && history.canRedo }),
  C('edit.cut', 'Cut', 'Ctrl+X', () => copy({ cut: true }), { icon: 'cut', category: 'Edit', when: hasLayer }),
  C('edit.copy', 'Copy', 'Ctrl+C', () => copy(), { icon: 'copy', category: 'Edit', when: hasLayer }),
  C('edit.copyMerged', 'Copy Merged', 'Ctrl+Shift+C', () => copy({ merged: true }), { icon: 'copy', category: 'Edit' }),
  C('edit.paste', 'Paste', 'Ctrl+V', () => paste(), { icon: 'paste', category: 'Edit', when: null }),
  C('edit.pasteInPlace', 'Paste in Place', 'Ctrl+Shift+V', () => paste({ inPlace: true }), { icon: 'paste', category: 'Edit' }),
  C('edit.clear', 'Clear', ['Delete', 'Backspace'], () => clearSelected(), { icon: 'trash', category: 'Edit', when: hasLayer }),
  C('edit.fill', 'Fill…', 'Shift+F5', async () => { const r = await D.fillDialog(A); if (r) fillSelected(r.color, 'Fill', r.opacity); }, { icon: 'bucket', category: 'Edit', when: hasLayer }),
  C('edit.fillFg', 'Fill With Foreground', 'Alt+Backspace', () => fillSelected(st.fg), { category: 'Edit', when: hasLayer }),
  C('edit.fillBg', 'Fill With Background', 'Ctrl+Backspace', () => fillSelected(st.bg), { category: 'Edit', when: hasLayer }),
  C('edit.stroke', 'Outline the Selection…', null, async () => { const r = await D.strokeDialog(A); if (r) strokeSelection(r); }, { icon: 'pen', category: 'Edit', when: hasSel }),
  C('edit.transform', 'Free Transform', 'Ctrl+T', () => startTransform(), { icon: 'resize', category: 'Edit', when: hasLayer }),
  C('edit.flipLayerH', 'Flip Layer Horizontally', null, () => flipLayer(true), { icon: 'flipH', category: 'Edit', when: hasLayer }),
  C('edit.flipLayerV', 'Flip Layer Vertically', null, () => flipLayer(false), { icon: 'flipV', category: 'Edit', when: hasLayer }),
  C('edit.rotLayerR', 'Rotate Layer 90° Right', null, () => rotateLayer(90), { icon: 'rotateCw', category: 'Edit', when: hasLayer }),
  C('edit.rotLayerL', 'Rotate Layer 90° Left', null, () => rotateLayer(-90), { icon: 'rotateCcw', category: 'Edit', when: hasLayer }),
  C('edit.prefs', 'Pen and Brush Settings…', null, () => D.prefsDialog(A), { icon: 'settings', category: 'Edit', when: null }),

  C('img.size', 'Image Size…', 'Ctrl+Alt+I', () => D.imageSizeDialog(A), { icon: 'resize', category: 'Image' }),
  C('img.canvas', 'Canvas Size…', 'Ctrl+Alt+C', () => D.canvasSizeDialog(A), { icon: 'margins', category: 'Image' }),
  C('img.rotR', 'Rotate Picture 90° Right', null, () => transformImage('Rotate picture', 'cw'), { icon: 'rotateCw', category: 'Image' }),
  C('img.rotL', 'Rotate Picture 90° Left', null, () => transformImage('Rotate picture', 'ccw'), { icon: 'rotateCcw', category: 'Image' }),
  C('img.rot180', 'Rotate Picture 180°', null, () => transformImage('Rotate picture', '180'), { category: 'Image' }),
  C('img.flipH', 'Flip Picture Horizontally', null, () => transformImage('Flip picture', 'h'), { icon: 'flipH', category: 'Image' }),
  C('img.flipV', 'Flip Picture Vertically', null, () => transformImage('Flip picture', 'v'), { icon: 'flipV', category: 'Image' }),
  C('img.crop', 'Crop to Selection', null, () => cropToSelection(), { icon: 'crop', category: 'Image', when: hasSel }),
  C('img.trim', 'Trim See-through Edges', null, () => trim('transparent'), { icon: 'crop', category: 'Image' }),
  C('img.reveal', 'Reveal All', null, () => revealAll(), { category: 'Image' }),
  C('auto.tone', 'Auto Tone', 'Ctrl+Shift+L', () => autoAdjust('tone'), { icon: 'sun', category: 'Adjust', when: hasLayer }),
  C('auto.contrast', 'Auto Contrast', 'Ctrl+Alt+Shift+L', () => autoAdjust('contrast'), { icon: 'contrast', category: 'Adjust', when: hasLayer }),
  C('auto.color', 'Auto Colour', 'Ctrl+Shift+B', () => autoAdjust('color'), { icon: 'palette', category: 'Adjust', when: hasLayer }),
  C('auto.enhance', 'Auto Enhance (one click)', 'Ctrl+Alt+E', () => autoAdjust('enhance'), { icon: 'wand', category: 'Adjust', when: hasLayer }),
  adjCmd('brightness'), adjCmd('levels', 'Ctrl+L'), adjCmd('curves', 'Ctrl+M'), adjCmd('exposure'), adjCmd('hsl', 'Ctrl+U'), adjCmd('vibrance'),
  adjCmd('whiteBalance'), adjCmd('colorBalance', 'Ctrl+B'), adjCmd('shadowsHighlights'), adjCmd('blackWhite', 'Ctrl+Alt+Shift+B'), adjCmd('photoFilter'),
  adjCmd('posterize'), adjCmd('threshold'),
  C('adj.invert', 'Invert', 'Ctrl+I', () => quickAdjust('invert'), { icon: 'invert', category: 'Adjust', when: hasLayer }),
  C('adj.desaturate', 'Desaturate', 'Ctrl+Shift+U', () => quickAdjust('desaturate'), { icon: 'contrast', category: 'Adjust', when: hasLayer }),

  C('layer.new', 'New Layer', 'Ctrl+Shift+N', () => addLayer(), { icon: 'plus', category: 'Layer' }),
  C('layer.duplicate', 'Duplicate Layer (or Layer via Copy)', 'Ctrl+J', () => duplicateLayer(), { icon: 'duplicate', category: 'Layer', when: hasLayer }),
  C('layer.viaCut', 'Layer via Cut', 'Ctrl+Shift+J', () => layerVia(true), { icon: 'cut', category: 'Layer', when: hasSel }),
  C('layer.delete', 'Delete Layer', null, () => deleteLayer(), { icon: 'trash', category: 'Layer', when: hasLayer }),
  C('layer.mergeDown', 'Merge Down', 'Ctrl+E', () => mergeDown(), { icon: 'mergeDown', category: 'Layer', when: () => !!doc && doc.activeIndex > 0 }),
  C('layer.mergeVisible', 'Merge Visible', 'Ctrl+Shift+E', () => mergeVisible(), { icon: 'layers', category: 'Layer' }),
  C('layer.flatten', 'Flatten Picture', null, () => flatten(), { icon: 'layers', category: 'Layer' }),
  C('layer.rasterize', 'Rasterise Layer', null, () => rasterize(), { category: 'Layer', when: () => !!doc && !!active() && active().kind !== 'pixel' }),
  C('layer.front', 'Bring to Front', 'Ctrl+Shift+]', () => arrange('top'), { icon: 'bringFront', category: 'Layer', when: hasLayer }),
  C('layer.forward', 'Bring Forward', 'Ctrl+]', () => arrange(1), { category: 'Layer', when: hasLayer }),
  C('layer.backward', 'Send Backward', 'Ctrl+[', () => arrange(-1), { category: 'Layer', when: hasLayer }),
  C('layer.back', 'Send to Back', 'Ctrl+Shift+[', () => arrange('bottom'), { icon: 'sendBack', category: 'Layer', when: hasLayer }),
  C('layer.maskAll', 'Add Mask (Show All)', null, () => addMask('all'), { icon: 'mask', category: 'Layer', when: () => hasLayer() && !active().mask }),
  C('layer.maskSel', 'Add Mask From Selection', null, () => addMask('selection'), { icon: 'mask', category: 'Layer', when: () => hasSel() && !!active() && !active().mask }),
  C('layer.maskHide', 'Add Mask Hiding the Selection', null, () => addMask('hideSelection'), { category: 'Layer', when: () => hasSel() && !!active() && !active().mask }),
  C('layer.maskEdit', 'Paint on the Mask', '\\', () => { const L = active(); L.editMask = !L.editMask; buildOptions(); if (panels) panels.layers(); refresh(); }, { category: 'Layer', when: () => hasLayer() && !!active().mask, checked: () => !!doc && !!active() && !!active().editMask }),
  C('layer.maskToggle', 'Turn the Mask Off', null, () => { const L = active(); setLayerProps(L, { maskOn: !L.maskOn }, L.maskOn ? 'Disable mask' : 'Enable mask'); }, { category: 'Layer', when: () => hasLayer() && !!active().mask, checked: () => !!doc && !!active() && !!active().mask && !active().maskOn }),
  C('layer.maskInvert', 'Invert Mask', null, () => invertMask(), { icon: 'invert', category: 'Layer', when: () => hasLayer() && !!active().mask }),
  C('layer.maskApply', 'Apply Mask', null, () => deleteMask(true), { category: 'Layer', when: () => hasLayer() && !!active().mask && active().kind === 'pixel' }),
  C('layer.maskDelete', 'Delete Mask', null, () => deleteMask(false), { icon: 'trash', category: 'Layer', when: () => hasLayer() && !!active().mask }),
  C('layer.effects', 'Layer Effects…', null, () => D.effectsDialog(A, active()), { icon: 'star', category: 'Layer', when: () => hasLayer() && active().kind !== 'adjust' }),
  C('layer.removeBg', 'Remove Background (adds a mask)', null, () => removeBackground(), { icon: 'wand', category: 'Layer', when: hasLayer }),
  C('layer.lock', 'Lock Layer', null, () => { const L = active(); setLayerProps(L, { locked: !L.locked }, L.locked ? 'Unlock layer' : 'Lock layer'); }, { icon: 'lock', category: 'Layer', when: hasLayer, checked: () => !!doc && !!active() && active().locked }),

  C('sel.all', 'Select All', 'Ctrl+A', () => setSelection(emptySel().all(), 'Select all'), { icon: 'select', category: 'Select' }),
  C('sel.none', 'Deselect', 'Ctrl+D', () => setSelection(null, 'Deselect'), { category: 'Select', when: hasSel }),
  C('sel.reselect', 'Reselect', 'Ctrl+Shift+D', () => setSelection(lastSel, 'Reselect'), { category: 'Select', when: () => !!doc && !!lastSel }),
  C('sel.inverse', 'Inverse', 'Ctrl+Shift+I', () => setSelection((sel || emptySel()).invert(), 'Inverse'), { icon: 'invert', category: 'Select' }),
  C('sel.layer', 'Select Layer Pixels', null, () => selectionFromLayer(), { category: 'Select', when: hasLayer }),
  C('sel.subject', 'Select Subject (plain backgrounds)', null, () => selectSubject(), { icon: 'wand', category: 'Select' }),
  C('sel.color', 'Colour Range…', null, () => D.colorRangeDialog(A), { icon: 'droplet', category: 'Select' }),
  C('sel.feather', 'Feather…', 'Shift+F6', async () => { const v = await D.numberPrompt('Feather the selection', 'Radius (pixels)', 5, 0, 500); if (v) setSelection(sel.feather(v), 'Feather'); }, { category: 'Select', when: hasSel }),
  C('sel.grow', 'Expand…', null, async () => { const v = await D.numberPrompt('Expand the selection', 'By (pixels)', 5, 1, 500); if (v) setSelection(sel.grow(v), 'Expand'); }, { category: 'Select', when: hasSel }),
  C('sel.shrink', 'Contract…', null, async () => { const v = await D.numberPrompt('Contract the selection', 'By (pixels)', 5, 1, 500); if (v) setSelection(sel.grow(-v), 'Contract'); }, { category: 'Select', when: hasSel }),
  C('sel.border', 'Border…', null, async () => { const v = await D.numberPrompt('Select a border', 'Width (pixels)', 10, 1, 500); if (v) setSelection(sel.border(v), 'Border'); }, { category: 'Select', when: hasSel }),
  C('sel.refine', 'Refine Edge…', 'Ctrl+Alt+R', () => refineDialog(), { category: 'Select', when: hasSel }),

  C('filter.again', 'Repeat Last Filter', 'Ctrl+F', () => D.repeatFilter(A), { category: 'Filter', when: () => hasLayer() && !!D.lastFilter() }),
  ...Object.entries(FILTERS).map(([k, f]) => C(`filter.${k}`, `${f.label}…`, null, () => D.filterDialog(A, k), { category: 'Filter', icon: 'filter', when: hasLayer })),

  C('view.zoomIn', 'Zoom In', ['Ctrl+=', 'Ctrl+Shift+='], () => vp.zoomStep(1), { icon: 'zoomIn', category: 'View' }),
  C('view.zoomOut', 'Zoom Out', 'Ctrl+-', () => vp.zoomStep(-1), { icon: 'zoomOut', category: 'View' }),
  C('view.fit', 'Fit on Screen', 'Ctrl+0', () => vp.fit(), { icon: 'fit', category: 'View' }),
  C('view.zoom100', 'Actual Pixels', 'Ctrl+1', () => vp.setZoom(1), { category: 'View' }),
  C('view.extras', 'Show Selection Edges', 'Ctrl+H', () => { hideExtras = !hideExtras; vp.renderOverlay(); refresh(); }, { category: 'View', checked: () => !hideExtras }),
  C('view.grid', 'Pixel Grid (when zoomed in)', null, () => { settings.set('pixelGrid', !settings.get('pixelGrid', true)); vp.render(); refresh(); }, { icon: 'grid', category: 'View', checked: () => settings.get('pixelGrid', true) }),
  C('view.compare', 'Before and After', 'Ctrl+Alt+Y', () => toggleCompare(), { icon: 'columns', category: 'View', checked: () => !!compare }),
  C('view.wheel', 'The Wheel Zooms (otherwise it scrolls)', null, () => { vp.wheelZooms = !vp.wheelZooms; settings.set('wheelZooms', vp.wheelZooms); refresh(); }, { icon: 'search', category: 'View', checked: () => vp.wheelZooms, when: null }),

  C('color.swap', 'Swap Colours', 'X', () => { const a = st.fg; setColor('fg', st.bg); setColor('bg', a); }, { icon: 'repeat', category: 'Colours', when: null }),
  C('color.reset', 'Black and White Colours', 'D', () => { setColor('fg', '#000000'); setColor('bg', '#ffffff'); }, { category: 'Colours', when: null }),
  C('brush.bigger', 'Bigger Brush', ']', () => sizeStep(1), { category: 'Brush' }),
  C('brush.smaller', 'Smaller Brush', '[', () => sizeStep(-1), { category: 'Brush' }),
  C('brush.harder', 'Harder Brush', 'Shift+]', () => hardStep(0.25), { category: 'Brush' }),
  C('brush.softer', 'Softer Brush', 'Shift+[', () => hardStep(-0.25), { category: 'Brush' }),
  C('commit', 'Apply', 'Enter', () => { if (crop) applyCrop(); else if (transform) commitTransform(); }, { category: 'Edit', when: () => !!crop || !!transform }),
  C('cancel', 'Cancel', 'Escape', () => { if (crop) cancelCrop(); else if (transform) cancelTransform(); else if (drag && drag.points) { drag = null; guide = null; vp.renderOverlay(); } }, { category: 'Edit', when: () => !!crop || !!transform }),
  ...['Left', 'Right', 'Up', 'Down'].flatMap((k) => [
    C(`nudge.${k}`, `Nudge ${k}`, k, () => nudge(k === 'Left' ? -1 : k === 'Right' ? 1 : 0, k === 'Up' ? -1 : k === 'Down' ? 1 : 0), { category: 'Move', when: () => hasLayer() && st.tool === 'move' }),
    C(`nudge10.${k}`, `Nudge ${k} by 10`, `Shift+${k}`, () => nudge(k === 'Left' ? -10 : k === 'Right' ? 10 : 0, k === 'Up' ? -10 : k === 'Down' ? 10 : 0), { category: 'Move', when: () => hasLayer() && st.tool === 'move' }),
  ]),
  ...[1, 2, 3, 4, 5, 6, 7, 8, 9, 0].map((n) => C(`opacity.${n}`, `Opacity ${n === 0 ? 100 : n * 10}%`, String(n), () => {
    if (st.opts[st.tool] && 'opacity' in st.opts[st.tool]) { st.opts[st.tool].opacity = n === 0 ? 1 : n / 10; saveOpts(); buildOptions(); }
    else { const L = active(); if (L) setLayerProps(L, { opacity: n === 0 ? 1 : n / 10 }, 'Layer opacity', `op:${L.id}`); }
  }, { category: 'Brush' })),
  ...Object.entries(TOOL_INFO).map(([id, [label, ic, keys]]) => C(`tool.${id}`, label, keys, () => setTool(id), { icon: ic, category: 'Tools', checked: () => st.tool === id, when: null })),
);

function sizeStep(dir) {
  const o = O();
  if (!('size' in o)) return;
  o.size = clamp(Math.round(dir > 0 ? o.size * 1.2 + 1 : o.size / 1.2), 1, 1000);
  saveOpts();
  buildOptions();
  vp.renderOverlay();
}

function hardStep(d) {
  const o = O();
  if (!('hardness' in o)) return;
  o.hardness = clamp(Math.round((o.hardness + d) * 4) / 4, 0, 1);
  saveOpts();
  buildOptions();
  vp.renderOverlay();
}

// Alt+wheel: brush size where the pointer is (Shift+Alt+wheel: hardness).
vp.scroller.addEventListener('wheel', (e) => {
  if (!e.altKey || e.ctrlKey) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  if (e.shiftKey) hardStep(e.deltaY < 0 ? 0.05 : -0.05); else sizeStep(e.deltaY < 0 ? 1 : -1);
}, { passive: false, capture: true });

// Right-click on the picture: what you can do here.
vp.scroller.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (!doc) return;
  if (BRUSH_TOOLS.includes(st.tool)) { brushPopover(e); return; }
  canvasMenu(e);
});

function brushPopover(e) {
  const o = O();
  const box = h('div.ph-brushpop',
    slider('Size', o.size, 1, 1000, 1, (v) => setOpt('size', v), { suffix: 'px', width: 160 }),
    slider('Hardness', Math.round((o.hardness ?? 0.8) * 100), 0, 100, 1, (v) => setOpt('hardness', v / 100), { suffix: '%', width: 160 }),
    slider('Opacity', Math.round((o.opacity ?? 1) * 100), 1, 100, 1, (v) => setOpt('opacity', v / 100), { suffix: '%', width: 160 }));
  popover(box, { x: e.clientX, y: e.clientY, onClose: () => buildOptions() });
}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------
function fileMenu() {
  return [I('file.new'), I('file.newClip'), I('app.newWindow'), I('file.open'),
    { label: 'Open Recent', icon: 'clock', submenu: () => (recentCache.length ? recentCache.slice(0, 12).map((r) => ({ label: r.name, disabled: !r.exists, run: async () => { try { await openFile(await host.openRecent(r.key)); } catch (err) { errorToast(err); } } })) : [{ label: 'Nothing yet', disabled: true }]) },
    I('file.place'), { type: 'separator' }, I('file.save'), I('file.saveAs'), I('file.export'), { type: 'separator' }, I('file.print'), I('app.close')];
}
function editMenu() {
  return [I('edit.undo', { label: history.undoLabel ? `Undo ${history.undoLabel}` : 'Undo' }), I('edit.redo', { label: history.redoLabel ? `Redo ${history.redoLabel}` : 'Redo' }), { type: 'separator' },
    I('edit.cut'), I('edit.copy'), I('edit.copyMerged'), I('edit.paste'), I('edit.pasteInPlace'), I('edit.clear'), { type: 'separator' },
    I('edit.fill'), I('edit.stroke'), { type: 'separator' }, I('edit.transform'),
    { label: 'Transform Layer', icon: 'rotateCw', submenu: [I('edit.rotLayerR'), I('edit.rotLayerL'), I('edit.flipLayerH'), I('edit.flipLayerV')] }, { type: 'separator' }, I('edit.prefs')];
}
function adjustItems() {
  return [I('auto.enhance'), I('auto.tone'), I('auto.contrast'), I('auto.color'), { type: 'separator' },
    ...['brightness', 'levels', 'curves', 'exposure', 'hsl', 'vibrance', 'whiteBalance', 'colorBalance', 'shadowsHighlights', 'blackWhite', 'photoFilter'].map((k) => I(`adj.${k}`)),
    { type: 'separator' }, I('adj.invert'), I('adj.desaturate'), I('adj.posterize'), I('adj.threshold')];
}
function imageMenu() {
  return [{ label: 'Adjustments', icon: 'sliders', submenu: adjustItems }, { type: 'separator' }, I('img.size'), I('img.canvas'),
    { label: 'Rotate and Flip Picture', icon: 'rotateCw', submenu: [I('img.rotR'), I('img.rotL'), I('img.rot180'), I('img.flipH'), I('img.flipV')] },
    { type: 'separator' }, I('img.crop'), I('img.trim'), I('img.reveal')];
}
function layerMenu() {
  return [I('layer.new'), { label: 'New Adjustment Layer', icon: 'sliders', submenu: () => Object.entries(ADJUSTMENTS).map(([k, a]) => ({ label: a.label, run: () => addAdjustmentLayer(k) })) },
    I('layer.duplicate'), I('layer.viaCut'), I('layer.delete'), { type: 'separator' },
    { label: 'Mask', icon: 'mask', submenu: [I('layer.maskAll'), I('layer.maskSel'), I('layer.maskHide'), { type: 'separator' }, I('layer.maskEdit'), I('layer.maskToggle'), I('layer.maskInvert'), I('layer.maskApply'), I('layer.maskDelete')] },
    I('layer.effects'), I('layer.removeBg'), { type: 'separator' },
    { label: 'Arrange', icon: 'layers', submenu: [I('layer.front'), I('layer.forward'), I('layer.backward'), I('layer.back')] },
    I('layer.lock'), I('layer.rasterize'), { type: 'separator' }, I('layer.mergeDown'), I('layer.mergeVisible'), I('layer.flatten')];
}
function selectMenu() {
  return [I('sel.all'), I('sel.none'), I('sel.reselect'), I('sel.inverse'), { type: 'separator' }, I('sel.subject'), I('sel.color'), I('sel.layer'), { type: 'separator' },
    I('sel.refine'), I('sel.feather'), I('sel.grow'), I('sel.shrink'), I('sel.border')];
}
function filterMenu() {
  const groups = {};
  for (const [k, f] of Object.entries(FILTERS)) (groups[f.group] = groups[f.group] || []).push(I(`filter.${k}`));
  const last = D.lastFilter();
  return [I('filter.again', { label: last ? `Repeat ${FILTERS[last.key].label}` : 'Repeat Last Filter' }), { type: 'separator' },
    ...Object.entries(groups).map(([g, items]) => ({ label: g, icon: 'filter', submenu: items }))];
}
function viewMenu() {
  return [I('view.zoomIn'), I('view.zoomOut'), I('view.fit'), I('view.zoom100'), { type: 'separator' }, I('view.compare'), I('view.extras'), I('view.grid'), I('view.wheel'), { type: 'separator' },
    I('view.themeDark'), I('view.themeLight'), I('view.fullscreen')];
}
function canvasMenu(e) {
  const items = sel ? [I('sel.none'), I('sel.inverse'), I('sel.refine'), I('sel.feather'), { type: 'separator' }, I('layer.duplicate', { label: 'Layer via Copy' }), I('layer.viaCut'),
    I('edit.fill'), I('edit.stroke'), I('edit.clear'), { type: 'separator' }, I('edit.transform'), I('img.crop'), I('layer.maskSel'), { type: 'separator' }, I('edit.copy'), I('edit.copyMerged'), I('edit.paste')]
    : [I('edit.paste'), I('sel.all'), I('sel.reselect'), I('sel.subject'), { type: 'separator' }, I('edit.transform'), { label: 'Transform Layer', icon: 'rotateCw', submenu: [I('edit.rotLayerR'), I('edit.rotLayerL'), I('edit.flipLayerH'), I('edit.flipLayerV')] },
      { type: 'separator' }, { label: 'Adjustments', icon: 'sliders', submenu: adjustItems }, I('layer.effects'), { type: 'separator' }, { label: 'Tool', icon: 'brush', submenu: Object.keys(TOOL_INFO).map((id) => I(`tool.${id}`)) }];
  showMenu(items, { x: e.clientX, y: e.clientY });
}
function layerContextMenu(L) {
  if (L) selectLayer(L.id);
  return [I('layer.duplicate'), I('layer.delete'), { type: 'separator' }, I('layer.effects'),
    { label: 'Mask', icon: 'mask', submenu: [I('layer.maskAll'), I('layer.maskSel'), I('layer.maskEdit'), I('layer.maskToggle'), I('layer.maskInvert'), I('layer.maskApply'), I('layer.maskDelete')] },
    I('sel.layer'), I('layer.removeBg'), { type: 'separator' }, I('layer.lock'), I('layer.rasterize'), I('layer.mergeDown'), I('layer.mergeVisible'), I('layer.flatten')];
}

// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------
const posItem = h('span.item');
const colorItem = h('span.item.ph-colorinfo', { style: { display: 'none' } }, h('span.ph-dot'), h('span'));
const selItem = h('span.item');
const sizeItem = h('button.item', { 'data-tip': 'Image size' });
sizeItem.addEventListener('click', () => doc && commands.run('img.size'));
const zoomBox = shell.zoomBox({ get: () => vp.zoom, set: (z) => vp.setZoom(z), min: 0.02, max: 64, fit: [{ label: 'Fit on screen', run: () => vp.fit() }, { label: 'Actual pixels', run: () => vp.setZoom(1) }] });
shell.statusLeft.append(posItem, colorItem, selItem, sizeItem);
shell.statusRight.append(zoomBox);

function updateStatus() {
  if (!doc) { sizeItem.textContent = ''; selItem.textContent = ''; return; }
  sizeItem.textContent = `${doc.width} × ${doc.height} px`;
  const b = sel && sel.bounds;
  selItem.textContent = b ? `Selected ${b.w} × ${b.h}` : '';
}
function updateTitle() { shell.setTitle(doc ? file.name : 'Start', isDirty()); }

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const start = startScreen({
  shell, title: 'Start a new picture', thumbRatio: 1,
  templates: PRESETS.map((p) => ({ ...p, thumb: () => { const box = h('div.ph-preset'); const s = Math.min(90 / p.w, 90 / p.h); box.append(h('div', { style: { width: `${p.w * s}px`, height: `${p.h * s}px` } })); return box; } })),
  onTemplate: (t) => newDocument(t.w, t.h, '#ffffff', 'Untitled'),
  onOpen: () => openDialog(),
  onRecent: async (r) => { try { await openFile(await host.openRecent(r.key)); } catch (err) { errorToast(err); } },
  extra: tb({ icon: 'paste', label: 'New from clipboard', showLabel: true, run: () => newFromClipboard() }),
});
centre.classList.add('hidden');
side.classList.add('hidden');

panels = buildPanels(A, side);
guardClose({ dirty: () => isDirty(), save: () => save(), name: () => file.name });
onDropFiles((files, e) => {
  const ok = files.filter((f) => OPEN_FILTERS[0].exts.includes(extOf(f.name)));
  if (!ok.length) return;
  if (!doc) { openFile(ok[0]); return; }
  // Onto an open picture: projects open, pictures become layers where they were dropped.
  const projects = ok.filter((f) => ['ora', 'psd'].includes(extOf(f.name)));
  const pics = ok.filter((f) => !projects.includes(f));
  if (pics.length) placeFiles(pics, vp.toImage(e));
  for (const f of projects) if (host.openInNewWindow) host.openInNewWindow(f); else openFile(f);
}, 'Drop pictures to open them, or onto a picture to add them as layers');
host.onOpen((files) => { if (files[0]) { if (!doc || (!isDirty() && !history.canUndo)) openFile(files[0]); else if (host.openInNewWindow) host.openInNewWindow(files[0]); } });
document.addEventListener('paste', async (e) => {
  if (e.target.closest && e.target.closest('input, textarea')) return;
  const f = [...e.clipboardData.files].find((x) => x.type.startsWith('image/'));
  if (!f) return;
  e.preventDefault();
  const c = await decodeImage(new Uint8Array(await f.arrayBuffer()), f.type);
  if (!doc) { const d = new PhotoDoc(c.width, c.height); d.layers.push(newLayer({ name: 'Pasted', canvas: c })); d.activeId = d.layers[0].id; useDocument(d, { name: 'Untitled', handle: null, format: 'png' }); } else paste({ canvas: c });
});
// Alt+click with a brush picks a colour (clone and heal use Alt+click for their source).
vp.scroller.addEventListener('pointerdown', (e) => {
  if (e.altKey && e.button === 0 && ['brush', 'gradient', 'fill', 'shape'].includes(st.tool) && doc) {
    e.stopImmediatePropagation();
    sampleAt(vp.toImage(e), 'fg');
  }
}, true);

buildToolbox();
buildOptions();
drawColors();
updateStatus();
updateTitle();
if (shell.info.files && shell.info.files.length) openFile(shell.info.files[0]);

window.snakeApp = { get doc() { return doc; }, get sel() { return sel; }, history, vp, st, commands, setTool, A, newDocument, encode, compositor, io: { readOra, readPsd, docFromLayers, useDocument } };
