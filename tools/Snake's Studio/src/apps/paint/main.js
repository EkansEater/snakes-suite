// Snake's Paint: quick drawings, screenshots touch-ups and pixel art.
import { h, uid, clamp, extOf, baseName } from '../../kit/dom.js';
import { icon } from '../../kit/icons.js';
import { host } from '../../kit/host.js';
import * as commands from '../../kit/commands.js';
import { createShell, tb, combo, select, onDropFiles, guardClose, refresh } from '../../kit/shell.js';
import { showMenu, popover, closeMenus } from '../../kit/menu.js';
import { modal, toast, errorToast, busy, saveChangesBox } from '../../kit/dialogs.js';
import { colorPicker, toHex, parseColor } from '../../kit/color.js';
import { knownFonts, allFonts, FONT_SIZES } from '../../kit/fonts.js';
import { History } from '../../kit/history.js';
import { Viewport } from '../../kit/viewport.js';
import { shapePath } from '../../kit/shapes.js';
import {
  makeCanvas, cloneCanvas, rgba, floodMask, fillMask, rotated, flipped, resized, cropped, canvasBytes, decodeImage, IMAGE_TYPES,
} from '../../kit/raster.js';

const OPEN_FILTERS = [{ name: 'Pictures', exts: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'avif', 'svg', 'ico'] }];
const SAVE_TYPES = {
  png: { name: 'PNG picture', exts: ['png'], mime: 'image/png' },
  jpg: { name: 'JPEG picture', exts: ['jpg'], mime: 'image/jpeg' },
  webp: { name: 'WebP picture', exts: ['webp'], mime: 'image/webp' },
  bmp: { name: 'Bitmap', exts: ['bmp'], mime: 'image/bmp' },
};
const PALETTE = ['#000000', '#7f7f7f', '#880015', '#ed1c24', '#ff7f27', '#fff200', '#22b14c', '#00a2e8', '#3f48cc', '#a349a4', '#ffffff', '#c3c3c3', '#b97a57', '#ffaec9', '#ffc90e', '#efe4b0', '#b5e61d', '#99d9ea', '#7092be', '#c8bfe7'];
const SHAPES = [['line', 'Line'], ['curve', 'Curve'], ['rect', 'Rectangle'], ['roundRect', 'Rounded rectangle'], ['ellipse', 'Oval'], ['triangle', 'Triangle'], ['rightTriangle', 'Right triangle'],
  ['diamond', 'Diamond'], ['pentagon', 'Pentagon'], ['hexagon', 'Hexagon'], ['star', 'Star'], ['arrowRight', 'Arrow right'], ['arrowLeft', 'Arrow left'], ['arrowUp', 'Arrow up'], ['arrowDown', 'Arrow down'],
  ['heart', 'Heart'], ['callout', 'Speech bubble'], ['cloud', 'Cloud'], ['lightning', 'Lightning']];

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let doc = makeCanvas(1200, 800);
let dctx = doc.getContext('2d', { willReadFrequently: true });
dctx.fillStyle = '#ffffff';
dctx.fillRect(0, 0, doc.width, doc.height);
const file = { handle: null, name: 'Untitled', format: 'png', id: uid('pic'), opened: true };
const history = new History({ limit: 2000, onChange: () => { updateTitle(); refresh(); } });
let historyBytes = 0;

const shell = await createShell({
  id: 'paint', name: "Snake's Paint",
  quick: ['file.save', 'edit.undo', 'edit.redo'],
  menus: [
    { label: '&File', items: () => fileMenu() },
    { label: '&Edit', items: () => editMenu() },
    { label: '&View', items: () => viewMenu() },
    { label: '&Image', items: () => imageMenu() },
    { label: '&Tools', items: () => TOOLS.map(([id]) => I(`tool.${id}`)) },
    { label: '&Help', items: () => [I('app.palette'), I('app.shortcuts'), { type: 'separator' }, I('app.about')] },
  ],
  about: 'A quick drawing program: brushes, shapes, text, fill, selections, symmetry painting and a pixel-art mode. Opens and saves PNG, JPEG, WebP and BMP.',
});
const settings = host.settings;
const I = (id, extra) => commands.item(id, extra);

const st = {
  tool: settings.get('tool', 'brush'),
  prevTool: 'brush',
  c1: settings.get('c1', '#000000'),
  c2: settings.get('c2', '#ffffff'),
  size: settings.get('size', 6),
  opacity: settings.get('opacity', 1),
  brush: settings.get('brush', 'round'),
  shape: settings.get('shape', 'rect'),
  outline: settings.get('outline', true),
  fill: settings.get('fill', false),
  tolerance: settings.get('tolerance', 24),
  fillAll: false,
  symmetry: settings.get('symmetry', 'none'),
  pixel: settings.get('pixel', false),
  font: settings.get('font', 'Inter'),
  fontSize: settings.get('fontSize', 32),
  bold: false, italic: false, underline: false,
  textBg: false,
  transparentSel: settings.get('transparentSel', false),
  eraseTransparent: settings.get('eraseTransparent', false),
  stamp: settings.get('stamp', '⭐'),
  gradient: settings.get('gradient', 'linear'),
};
const save = (k) => settings.set(k, st[k]);

// The selection: a rectangle or lasso outline, maybe holding lifted pixels.
let sel = null; // { x, y, w, h, path: [[x,y]...] | null, float: canvas | null }
let stroke = null; // the stroke being drawn: { canvas, pts, button, ... }
let preview = null; // shape being dragged: function(ctx)
let cursor = null; // pointer position in the picture
let curve = null; // curve tool state
let textBox = null;

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------
const toolbox = h('div.toolbox');
const optionsBar = h('div.toolbar.options-bar');
const colorsBox = h('div.colors-box');
const vp = new Viewport({
  size: () => ({ w: doc.width, h: doc.height }),
  draw: (ctx) => drawDoc(ctx),
  overlay: (ctx, v) => drawOverlay(ctx, v),
  settings,
  onZoom: () => { zoomBox.update(); placeTextBox(); },
  onPointer: (kind, e) => pointer(kind, e),
  wheelZooms: true,
});
const work = h('div.paint-work', optionsBar, vp.el);
shell.main.append(h('div.paint-side', toolbox, colorsBox), work);

function drawDoc(ctx) {
  ctx.drawImage(doc, 0, 0);
  if (stroke && stroke.canvas) {
    ctx.save();
    ctx.globalAlpha = stroke.alpha;
    if (stroke.erase && st.eraseTransparent) ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(stroke.canvas, 0, 0);
    ctx.restore();
  }
  if (sel && sel.float) {
    ctx.save();
    if (sel.path) clipPath(ctx, sel);
    ctx.drawImage(sel.float, sel.x, sel.y, sel.w, sel.h);
    ctx.restore();
  }
}

function clipPath(ctx, s) {
  // The lasso outline moves with the floating pixels.
  const p = new Path2D();
  const sx = s.w / s.ow;
  const sy = s.h / s.oh;
  s.path.forEach(([x, y], i) => { const X = s.x + (x - s.ox) * sx; const Y = s.y + (y - s.oy) * sy; if (i) p.lineTo(X, Y); else p.moveTo(X, Y); });
  p.closePath();
  ctx.clip(p);
}

let antsOffset = 0;
setInterval(() => { if (sel) { antsOffset = (antsOffset + 1) % 16; vp.renderOverlay(); } }, 90);

function drawOverlay(ctx, { z, o }) {
  const S = (x, y) => [o.x + x * z, o.y + y * z];
  if (preview) {
    ctx.save();
    ctx.translate(o.x, o.y);
    ctx.scale(z, z);
    preview(ctx);
    ctx.restore();
  }
  if (sel) {
    ctx.save();
    ctx.lineWidth = 1;
    const path = () => {
      ctx.beginPath();
      if (sel.path && !sel.float) sel.path.forEach(([x, y], i) => { const [X, Y] = S(x, y); if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y); });
      else if (sel.path) sel.path.forEach(([x, y], i) => { const [X, Y] = S(sel.x + (x - sel.ox) * (sel.w / sel.ow), sel.y + (y - sel.oy) * (sel.h / sel.oh)); if (i) ctx.lineTo(X, Y); else ctx.moveTo(X, Y); });
      else { const [X, Y] = S(sel.x, sel.y); ctx.rect(Math.round(X) + 0.5, Math.round(Y) + 0.5, Math.round(sel.w * z), Math.round(sel.h * z)); }
      ctx.closePath();
    };
    path();
    ctx.strokeStyle = '#000';
    ctx.setLineDash([4, 4]);
    ctx.lineDashOffset = -antsOffset;
    ctx.stroke();
    ctx.strokeStyle = '#fff';
    ctx.lineDashOffset = -antsOffset + 4;
    ctx.stroke();
    ctx.setLineDash([]);
    // Handles to resize what is selected.
    if (!stroke && (st.tool === 'select' || st.tool === 'lasso')) {
      for (const [hx, hy] of handlePoints()) {
        const [X, Y] = S(hx, hy);
        ctx.fillStyle = '#fff';
        ctx.strokeStyle = '#1f883d';
        ctx.fillRect(X - 4, Y - 4, 8, 8);
        ctx.strokeRect(X - 4 + 0.5, Y - 4 + 0.5, 7, 7);
      }
    }
    ctx.restore();
  }
  if (curve && curve.p3) {
    ctx.save();
    ctx.fillStyle = '#1f883d';
    for (const p of [curve.p0, curve.p1, curve.p2, curve.p3]) { const [X, Y] = S(p.x, p.y); ctx.beginPath(); ctx.arc(X, Y, 3, 0, Math.PI * 2); ctx.fill(); }
    ctx.restore();
  }
  // Brush outline under the pointer.
  if (cursor && ['brush', 'pencil', 'eraser', 'airbrush'].includes(st.tool) && !vp.space) {
    const r = Math.max(0.5, (st.tool === 'pencil' && st.pixel ? 1 : st.size) / 2) * z;
    const [X, Y] = S(st.tool === 'pencil' || st.pixel ? Math.floor(cursor.x) + 0.5 : cursor.x, st.tool === 'pencil' || st.pixel ? Math.floor(cursor.y) + 0.5 : cursor.y);
    ctx.save();
    ctx.strokeStyle = 'rgba(0,0,0,.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (st.tool === 'pencil' || st.brush === 'square') ctx.rect(X - r, Y - r, r * 2, r * 2); else ctx.arc(X, Y, r, 0, Math.PI * 2);
    ctx.stroke();
    ctx.strokeStyle = 'rgba(255,255,255,.8)';
    ctx.beginPath();
    if (st.tool === 'pencil' || st.brush === 'square') ctx.rect(X - r - 1, Y - r - 1, r * 2 + 2, r * 2 + 2); else ctx.arc(X, Y, r + 1, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
  // Symmetry guides.
  if (st.symmetry !== 'none' && ['brush', 'pencil', 'eraser', 'airbrush'].includes(st.tool)) {
    ctx.save();
    ctx.strokeStyle = 'rgba(63,185,80,.6)';
    ctx.setLineDash([6, 6]);
    const [cx, cy] = S(doc.width / 2, doc.height / 2);
    const [x0, y0] = S(0, 0);
    const [x1, y1] = S(doc.width, doc.height);
    ctx.beginPath();
    if (st.symmetry === 'vertical' || st.symmetry === 'both' || st.symmetry.startsWith('radial')) { ctx.moveTo(cx, y0); ctx.lineTo(cx, y1); }
    if (st.symmetry === 'horizontal' || st.symmetry === 'both' || st.symmetry.startsWith('radial')) { ctx.moveTo(x0, cy); ctx.lineTo(x1, cy); }
    ctx.stroke();
    ctx.restore();
  }
}

// ---------------------------------------------------------------------------
// Undo: before/after pixels of the changed area only
// ---------------------------------------------------------------------------
let backup = null;
function beginEdit() {
  if (!backup || backup.width !== doc.width || backup.height !== doc.height) backup = makeCanvas(doc.width, doc.height);
  const b = backup.getContext('2d');
  b.clearRect(0, 0, backup.width, backup.height);
  b.drawImage(doc, 0, 0);
}

function endEdit(label, rect = null) {
  const r = rect ? clipRect(rect) : { x: 0, y: 0, w: doc.width, h: doc.height };
  if (!r || r.w <= 0 || r.h <= 0) return;
  const before = backup.getContext('2d', { willReadFrequently: true }).getImageData(r.x, r.y, r.w, r.h);
  const after = dctx.getImageData(r.x, r.y, r.w, r.h);
  const size = before.data.length * 2;
  historyBytes += size;
  history.push({
    label, size,
    undo: () => { dctx.putImageData(before, r.x, r.y); vp.render(); },
    redo: () => { dctx.putImageData(after, r.x, r.y); vp.render(); },
  });
  trimHistory();
  markDirty();
}

/** Changes that replace the whole picture (resize, crop, rotate). */
function replaceDoc(label, next) {
  const prev = doc;
  const apply = (c) => { doc = c; dctx = doc.getContext('2d', { willReadFrequently: true }); vp.layout(); vp.render(); updateStatus(); };
  history.push({ label, size: prev.width * prev.height * 8, undo: () => apply(prev), redo: () => apply(next) });
  historyBytes += prev.width * prev.height * 8;
  trimHistory();
  apply(next);
  markDirty();
}

function trimHistory() {
  // Keep the undo history under about 600 MB.
  while (historyBytes > 600e6 && history.done.length > 5) {
    const old = history.done.shift();
    history.savedAt--;
    historyBytes -= old.size || 0;
  }
}

function clipRect(r) {
  const x = Math.max(0, Math.floor(r.x));
  const y = Math.max(0, Math.floor(r.y));
  const x1 = Math.min(doc.width, Math.ceil(r.x + r.w));
  const y1 = Math.min(doc.height, Math.ceil(r.y + r.h));
  return x1 > x && y1 > y ? { x, y, w: x1 - x, h: y1 - y } : null;
}

/** Unsaved changes: anything undoable since the last save, or pixels still floating. */
const isDirty = () => history.dirty || !!(sel && sel.float);
function markDirty() { updateTitle(); }

// ---------------------------------------------------------------------------
// Painting
// ---------------------------------------------------------------------------
/** Mirror copies of a point for symmetry painting. */
function mirrors(x, y) {
  const W = doc.width;
  const H = doc.height;
  const out = [[x, y]];
  const s = st.symmetry;
  if (s === 'vertical' || s === 'both') out.push([W - x, y]);
  if (s === 'horizontal' || s === 'both') out.push([x, H - y]);
  if (s === 'both') out.push([W - x, H - y]);
  if (s.startsWith('radial')) {
    const n = Number(s.slice(6)) || 6;
    const cx = W / 2;
    const cy = H / 2;
    for (let k = 1; k < n; k++) {
      const a = (k * 2 * Math.PI) / n;
      out.push([cx + (x - cx) * Math.cos(a) - (y - cy) * Math.sin(a), cy + (x - cx) * Math.sin(a) + (y - cy) * Math.cos(a)]);
    }
  }
  return out;
}

function paintColor(button) { return button === 2 ? st.c2 : st.c1; }

function startStroke(e, p) {
  const erase = st.tool === 'eraser';
  const canvas = makeCanvas(doc.width, doc.height);
  const ctx = canvas.getContext('2d');
  const color = erase ? (st.eraseTransparent ? '#000000' : st.c2) : paintColor(e.button);
  stroke = { canvas, ctx, last: p, color, erase, button: e.button, alpha: st.tool === 'brush' && st.brush === 'marker' ? Math.min(st.opacity, 0.45) : st.opacity, bounds: null, pts: [p] };
  if (st.selClip !== false && sel && !sel.float) clipToSelection(ctx);
  beginEdit();
  dab(p, p);
  if (st.tool === 'airbrush') stroke.timer = setInterval(() => { if (stroke && cursor) { spray(cursor); vp.render(); } }, 30);
}

function clipToSelection(ctx) {
  ctx.save();
  const path = new Path2D();
  if (sel.path) sel.path.forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y)));
  else path.rect(sel.x, sel.y, sel.w, sel.h);
  path.closePath();
  ctx.clip(path);
}

function grow(x, y, r) {
  const b = stroke.bounds;
  const box = { x: x - r - 2, y: y - r - 2, w: r * 2 + 4, h: r * 2 + 4 };
  if (!b) stroke.bounds = box;
  else {
    const x0 = Math.min(b.x, box.x); const y0 = Math.min(b.y, box.y);
    stroke.bounds = { x: x0, y: y0, w: Math.max(b.x + b.w, box.x + box.w) - x0, h: Math.max(b.y + b.h, box.y + box.h) - y0 };
  }
}

/** One piece of a stroke, from a to b, with every mirror copy. */
function dab(a, b) {
  const ctx = stroke.ctx;
  const size = st.tool === 'pencil' ? (st.pixel ? 1 : Math.max(1, Math.round(st.size / 3))) : st.size;
  const pairs = mirrors(a.x, a.y).map((m, i) => [m, mirrors(b.x, b.y)[i]]);
  for (const [[ax, ay], [bx, by]] of pairs) {
    grow(ax, ay, size + 2);
    grow(bx, by, size + 2);
    if (st.tool === 'pencil' || (st.pixel && st.tool !== 'airbrush')) {
      // Hard pixels along the line (Bresenham), for crisp pixel art.
      ctx.fillStyle = stroke.color;
      let x0 = Math.floor(ax); let y0 = Math.floor(ay);
      const x1 = Math.floor(bx); const y1 = Math.floor(by);
      const dx = Math.abs(x1 - x0); const dy = -Math.abs(y1 - y0);
      const sx = x0 < x1 ? 1 : -1; const sy = y0 < y1 ? 1 : -1;
      let err = dx + dy;
      const s0 = Math.floor(size / 2);
      for (;;) {
        ctx.fillRect(x0 - s0, y0 - s0, size, size);
        if (x0 === x1 && y0 === y1) break;
        const e2 = 2 * err;
        if (e2 >= dy) { err += dy; x0 += sx; }
        if (e2 <= dx) { err += dx; y0 += sy; }
      }
      continue;
    }
    if (st.tool === 'airbrush') continue;
    const kind = st.tool === 'eraser' ? 'square' : st.brush;
    ctx.strokeStyle = stroke.color;
    ctx.fillStyle = stroke.color;
    if (kind === 'calligraphy') {
      const dxp = size * 0.5 * Math.cos(-Math.PI / 4);
      const dyp = size * 0.5 * Math.sin(-Math.PI / 4);
      ctx.beginPath();
      ctx.moveTo(ax - dxp, ay - dyp); ctx.lineTo(ax + dxp, ay + dyp); ctx.lineTo(bx + dxp, by + dyp); ctx.lineTo(bx - dxp, by - dyp);
      ctx.closePath();
      ctx.fill();
      ctx.lineWidth = 1;
      ctx.stroke();
    } else if (kind === 'crayon') {
      const d = Math.hypot(bx - ax, by - ay);
      const n = Math.max(1, Math.ceil(d / 2));
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        for (let k = 0; k < size * 1.5; k++) {
          const ang = Math.random() * Math.PI * 2;
          const rr = Math.random() * size / 2;
          ctx.globalAlpha = 0.25 + Math.random() * 0.5;
          ctx.fillRect(ax + (bx - ax) * t + Math.cos(ang) * rr, ay + (by - ay) * t + Math.sin(ang) * rr, 1, 1);
        }
      }
      ctx.globalAlpha = 1;
    } else {
      ctx.lineWidth = size;
      ctx.lineCap = kind === 'square' ? 'square' : 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx + (ax === bx && ay === by ? 0.01 : 0), by);
      ctx.stroke();
    }
  }
}

function spray(p) {
  const ctx = stroke.ctx;
  ctx.fillStyle = stroke.color;
  const r = st.size;
  for (const [x, y] of mirrors(p.x, p.y)) {
    grow(x, y, r);
    for (let i = 0; i < r * 1.2; i++) {
      const a = Math.random() * Math.PI * 2;
      const d = Math.random() * r;
      ctx.fillRect(x + Math.cos(a) * d, y + Math.sin(a) * d, 1, 1);
    }
  }
}

function finishStroke() {
  if (!stroke) return;
  clearInterval(stroke.timer);
  dctx.save();
  dctx.globalAlpha = stroke.alpha;
  if (stroke.erase && st.eraseTransparent) dctx.globalCompositeOperation = 'destination-out';
  dctx.drawImage(stroke.canvas, 0, 0);
  dctx.restore();
  const b = stroke.bounds;
  stroke = null;
  endEdit(st.tool === 'eraser' ? 'Erase' : 'Paint', b);
  vp.render();
}

// ---------------------------------------------------------------------------
// Shapes, lines and curves
// ---------------------------------------------------------------------------
function drawShape(ctx, kind, x0, y0, x1, y1, button = 0) {
  const outlineColor = paintColor(button);
  const fillColor = button === 2 ? st.c1 : st.c2;
  const x = Math.min(x0, x1);
  const y = Math.min(y0, y1);
  const w = Math.abs(x1 - x0);
  const hh = Math.abs(y1 - y0);
  ctx.save();
  ctx.globalAlpha = st.opacity;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  if (kind === 'line') {
    ctx.strokeStyle = outlineColor;
    ctx.lineWidth = st.size;
    ctx.beginPath();
    ctx.moveTo(x0, y0);
    ctx.lineTo(x1, y1);
    ctx.stroke();
    ctx.restore();
    return;
  }
  if (w < 1 || hh < 1) { ctx.restore(); return; }
  const path = new Path2D(shapePath(kind, w, hh, 0.18));
  ctx.translate(x, y);
  if (st.fill) { ctx.fillStyle = st.outline ? fillColor : outlineColor; ctx.fill(path, kind === 'ring' ? 'evenodd' : 'nonzero'); }
  if (st.outline || !st.fill) { ctx.strokeStyle = outlineColor; ctx.lineWidth = st.size; ctx.stroke(path); }
  ctx.restore();
}

function constrain(p0, p, kind) {
  // Shift keeps squares, circles and 45° lines.
  const dx = p.x - p0.x;
  const dy = p.y - p0.y;
  if (kind === 'line') {
    const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) * (Math.PI / 4);
    const d = Math.hypot(dx, dy);
    return { x: p0.x + Math.cos(a) * d, y: p0.y + Math.sin(a) * d };
  }
  const s = Math.max(Math.abs(dx), Math.abs(dy));
  return { x: p0.x + Math.sign(dx || 1) * s, y: p0.y + Math.sign(dy || 1) * s };
}

function drawCurve(ctx, c, color) {
  ctx.save();
  ctx.globalAlpha = st.opacity;
  ctx.strokeStyle = color;
  ctx.lineWidth = st.size;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(c.p0.x, c.p0.y);
  ctx.bezierCurveTo(c.p1.x, c.p1.y, c.p2.x, c.p2.y, c.p3.x, c.p3.y);
  ctx.stroke();
  ctx.restore();
}

function commitCurve() {
  if (!curve || !curve.p3) { curve = null; return; }
  beginEdit();
  drawCurve(dctx, curve, curve.color);
  const xs = [curve.p0.x, curve.p1.x, curve.p2.x, curve.p3.x];
  const ys = [curve.p0.y, curve.p1.y, curve.p2.y, curve.p3.y];
  const pad = st.size + 2;
  endEdit('Curve', { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, w: Math.max(...xs) - Math.min(...xs) + pad * 2, h: Math.max(...ys) - Math.min(...ys) + pad * 2 });
  curve = null;
  preview = null;
  vp.render();
}

// ---------------------------------------------------------------------------
// Selections
// ---------------------------------------------------------------------------
function handlePoints() {
  if (!sel) return [];
  const { x, y, w, h: hh } = sel;
  return [[x, y], [x + w / 2, y], [x + w, y], [x + w, y + hh / 2], [x + w, y + hh], [x + w / 2, y + hh], [x, y + hh], [x, y + hh / 2]];
}
const HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

function hitHandle(e) {
  if (!sel) return null;
  const pts = handlePoints();
  const r = vp.el.getBoundingClientRect();
  for (let i = 0; i < pts.length; i++) {
    const s = vp.toScreen(pts[i][0], pts[i][1]);
    if (Math.abs(e.clientX - r.left - s.x) <= 6 && Math.abs(e.clientY - r.top - s.y) <= 6) return HANDLES[i];
  }
  return null;
}

function inSelection(p) {
  if (!sel) return false;
  if (p.x < sel.x || p.y < sel.y || p.x > sel.x + sel.w || p.y > sel.y + sel.h) return false;
  if (!sel.path) return true;
  const c = makeCanvas(1, 1).getContext('2d');
  const path = new Path2D();
  const pts = sel.float ? sel.path.map(([x, y]) => [sel.x + (x - sel.ox) * (sel.w / sel.ow), sel.y + (y - sel.oy) * (sel.h / sel.oh)]) : sel.path;
  pts.forEach(([x, y], i) => (i ? path.lineTo(x, y) : path.moveTo(x, y)));
  path.closePath();
  return c.isPointInPath(path, p.x, p.y);
}

/** Lift the selected pixels so they can move (the hole is painted with colour 2). */
function lift() {
  if (!sel || sel.float) return;
  const r = clipRect(sel);
  if (!r) { sel = null; return; }
  sel.x = r.x; sel.y = r.y; sel.w = r.w; sel.h = r.h;
  const f = makeCanvas(r.w, r.h);
  const fctx = f.getContext('2d');
  if (sel.path) {
    const path = new Path2D();
    sel.path.forEach(([x, y], i) => (i ? path.lineTo(x - r.x, y - r.y) : path.moveTo(x - r.x, y - r.y)));
    path.closePath();
    fctx.save();
    fctx.clip(path);
  }
  fctx.drawImage(doc, -r.x, -r.y);
  if (sel.path) fctx.restore();
  if (st.transparentSel) makeColorTransparent(f, st.c2, 20);
  beginEdit();
  dctx.save();
  if (sel.path) clipToSelection(dctx);
  dctx.fillStyle = st.c2;
  dctx.fillRect(r.x, r.y, r.w, r.h);
  dctx.restore();
  sel.liftEdit = { x: r.x, y: r.y, w: r.w, h: r.h };
  sel.float = f;
  sel.ox = r.x; sel.oy = r.y; sel.ow = r.w; sel.oh = r.h;
}

/** Put floating pixels down onto the picture. */
function drop() {
  if (!sel) return;
  if (sel.float) {
    if (!sel.liftEdit) beginEdit();
    dctx.save();
    if (sel.path) clipPath(dctx, sel);
    dctx.drawImage(sel.float, sel.x, sel.y, sel.w, sel.h);
    dctx.restore();
    const a = sel.liftEdit || { x: sel.x, y: sel.y, w: 0, h: 0 };
    const x0 = Math.min(a.x, sel.x); const y0 = Math.min(a.y, sel.y);
    endEdit('Move selection', { x: x0, y: y0, w: Math.max(a.x + a.w, sel.x + sel.w) - x0, h: Math.max(a.y + a.h, sel.y + sel.h) - y0 });
  }
  sel = null;
  vp.render();
  updateStatus();
}

function makeColorTransparent(canvas, color, tol) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const id = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const [r, g, b] = rgba(color);
  const d = id.data;
  for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - r) + Math.abs(d[i + 1] - g) + Math.abs(d[i + 2] - b) <= tol * 3) d[i + 3] = 0;
  ctx.putImageData(id, 0, 0);
}

function selectAll() { drop(); sel = { x: 0, y: 0, w: doc.width, h: doc.height, path: null, float: null }; setTool('select'); vp.render(); updateStatus(); }
function deselect() { drop(); }

function deleteSelection() {
  if (!sel) return;
  if (sel.float) {
    // Lifted pixels: the hole stays, the pixels go.
    const a = sel.liftEdit;
    sel = null;
    if (a && a.w) endEdit('Delete', a);
    vp.render();
    return;
  }
  beginEdit();
  dctx.save();
  clipToSelection(dctx);
  if (st.eraseTransparent) dctx.clearRect(sel.x, sel.y, sel.w, sel.h); else { dctx.fillStyle = st.c2; dctx.fillRect(sel.x, sel.y, sel.w, sel.h); }
  dctx.restore();
  endEdit('Delete', sel);
  sel = null;
  vp.render();
}

/** The selected pixels (or the whole picture) as a canvas. */
function selectionCanvas() {
  if (!sel) return cloneCanvas(doc);
  if (sel.float) {
    const c = makeCanvas(sel.w, sel.h);
    const ctx = c.getContext('2d');
    if (sel.path) { ctx.translate(-sel.x, -sel.y); clipPath(ctx, sel); ctx.drawImage(sel.float, sel.x, sel.y, sel.w, sel.h); }
    else ctx.drawImage(sel.float, 0, 0, sel.w, sel.h);
    return c;
  }
  const r = clipRect(sel);
  const c = makeCanvas(r.w, r.h);
  const ctx = c.getContext('2d');
  if (sel.path) {
    const path = new Path2D();
    sel.path.forEach(([x, y], i) => (i ? path.lineTo(x - r.x, y - r.y) : path.moveTo(x - r.x, y - r.y)));
    path.closePath();
    ctx.clip(path);
  }
  ctx.drawImage(doc, -r.x, -r.y);
  return c;
}

let clip = null;
async function copy(cut = false) {
  const c = selectionCanvas();
  clip = c;
  const png = await canvasBytes(c, 'image/png');
  const ok = await host.clipboard.writeImage(png);
  if (!ok) toast('Copied inside Paint (the system clipboard refused the picture).', { type: 'warn' });
  if (cut) deleteSelection();
}

async function paste(canvas = null) {
  let c = canvas;
  if (!c) {
    const png = await host.clipboard.readImage();
    if (png) c = await decodeImage(png, 'image/png');
    else if (clip) c = cloneCanvas(clip);
  }
  if (!c) { toast('There is no picture on the clipboard.', { type: 'warn' }); return; }
  drop();
  if (c.width > doc.width || c.height > doc.height) {
    // A bigger picture grows the canvas, as in Paint.
    const n = makeCanvas(Math.max(doc.width, c.width), Math.max(doc.height, c.height));
    const nctx = n.getContext('2d');
    nctx.fillStyle = st.c2;
    nctx.fillRect(0, 0, n.width, n.height);
    nctx.drawImage(doc, 0, 0);
    replaceDoc('Enlarge canvas', n);
  }
  // Paste where the user is looking.
  const tl = vp.toImage({ clientX: vp.el.getBoundingClientRect().left + 40, clientY: vp.el.getBoundingClientRect().top + 40 });
  const x = clamp(Math.round(tl.x), 0, Math.max(0, doc.width - c.width));
  const y = clamp(Math.round(tl.y), 0, Math.max(0, doc.height - c.height));
  if (st.transparentSel) makeColorTransparent(c, st.c2, 20);
  beginEdit();
  sel = { x, y, w: c.width, h: c.height, path: null, float: c, ox: x, oy: y, ow: c.width, oh: c.height, liftEdit: { x, y, w: 0, h: 0 } };
  setTool('select');
  vp.render();
  updateStatus();
}

function cropToSelection() {
  if (!sel) return;
  const c = selectionCanvas();
  if (sel.float && sel.liftEdit) dctx.drawImage(backup, 0, 0); // the crop replaces the picture; put the hole back first
  sel = null;
  replaceDoc('Crop', c);
  vp.fit();
}

function transformSelection(fn, label) {
  if (!sel) { replaceDoc(label, fn(doc)); vp.fit(); return; }
  lift();
  const next = fn(sel.float);
  const cx = sel.x + sel.w / 2;
  const cy = sel.y + sel.h / 2;
  sel.float = next;
  sel.w = next.width; sel.h = next.height;
  sel.x = Math.round(cx - sel.w / 2); sel.y = Math.round(cy - sel.h / 2);
  sel.path = null;
  vp.render();
  markDirty();
}

// ---------------------------------------------------------------------------
// Fill, gradient, picker, text, stamp
// ---------------------------------------------------------------------------
function fillAt(p, button) {
  const x = Math.floor(p.x);
  const y = Math.floor(p.y);
  if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return;
  const id = dctx.getImageData(0, 0, doc.width, doc.height);
  const mask = floodMask(id.data, doc.width, doc.height, x, y, st.tolerance, !st.fillAll);
  if (sel && !sel.float) {
    // Stay inside the selection.
    const c = makeCanvas(doc.width, doc.height);
    const ctx = c.getContext('2d', { willReadFrequently: true });
    clipToSelection(ctx);
    ctx.fillRect(0, 0, doc.width, doc.height);
    const m = ctx.getImageData(0, 0, doc.width, doc.height).data;
    for (let i = 0; i < mask.length; i++) if (!m[i * 4 + 3]) mask[i] = 0;
  }
  beginEdit();
  fillMask(id, mask, rgba(paintColor(button)), st.opacity);
  dctx.putImageData(id, 0, 0);
  endEdit('Fill');
  vp.render();
}

function gradientFill(p0, p1, button) {
  beginEdit();
  dctx.save();
  if (sel && !sel.float) clipToSelection(dctx);
  const a = paintColor(button);
  const b = button === 2 ? st.c1 : st.c2;
  const g = st.gradient === 'radial'
    ? dctx.createRadialGradient(p0.x, p0.y, 0, p0.x, p0.y, Math.hypot(p1.x - p0.x, p1.y - p0.y) || 1)
    : dctx.createLinearGradient(p0.x, p0.y, p1.x, p1.y);
  g.addColorStop(0, a);
  g.addColorStop(1, b);
  dctx.globalAlpha = st.opacity;
  dctx.fillStyle = g;
  dctx.fillRect(0, 0, doc.width, doc.height);
  dctx.restore();
  endEdit('Gradient', sel && !sel.float ? sel : null);
  vp.render();
}

function pickAt(p, button) {
  const x = Math.floor(p.x);
  const y = Math.floor(p.y);
  if (x < 0 || y < 0 || x >= doc.width || y >= doc.height) return;
  const d = dctx.getImageData(x, y, 1, 1).data;
  const hex = toHex({ r: d[0], g: d[1], b: d[2] });
  if (button === 2) setColor(2, hex); else setColor(1, hex);
}

function stampAt(p) {
  beginEdit();
  const size = Math.max(16, st.size * 6);
  for (const [x, y] of mirrors(p.x, p.y)) {
    dctx.save();
    dctx.globalAlpha = st.opacity;
    dctx.font = `${size}px "Noto Color Emoji", "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;
    dctx.textAlign = 'center';
    dctx.textBaseline = 'middle';
    dctx.fillText(st.stamp, x, y);
    dctx.restore();
  }
  endEdit('Stamp');
  vp.render();
}

function openTextBox(p) {
  closeTextBox(true);
  const ta = h('textarea.paint-text', { spellcheck: true, placeholder: 'Type here' });
  textBox = { el: ta, x: Math.round(p.x), y: Math.round(p.y), w: 300, h: st.fontSize * 1.6 };
  vp.el.append(ta);
  styleTextBox();
  placeTextBox();
  setTimeout(() => ta.focus(), 0);
  ta.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') closeTextBox(false);
    if (e.key === 'Enter' && e.ctrlKey) closeTextBox(true);
  });
  ta.addEventListener('input', () => {
    ta.style.height = 'auto';
    ta.style.height = `${ta.scrollHeight}px`;
    textBox.h = ta.scrollHeight / vp.zoom;
  });
  const ro = new ResizeObserver(() => { if (textBox && textBox.el === ta) textBox.w = ta.offsetWidth / vp.zoom; });
  ro.observe(ta);
}

function styleTextBox() {
  if (!textBox) return;
  Object.assign(textBox.el.style, {
    font: `${st.italic ? 'italic ' : ''}${st.bold ? '700 ' : ''}${st.fontSize * vp.zoom}px "${st.font}", sans-serif`,
    color: st.c1, textDecoration: st.underline ? 'underline' : 'none', background: st.textBg ? st.c2 : 'transparent', lineHeight: '1.25',
  });
}

function placeTextBox() {
  if (!textBox) return;
  const s = vp.toScreen(textBox.x, textBox.y);
  Object.assign(textBox.el.style, { left: `${s.x}px`, top: `${s.y}px`, width: `${textBox.w * vp.zoom}px`, minHeight: `${st.fontSize * vp.zoom * 1.4}px` });
  styleTextBox();
}

function closeTextBox(commit) {
  if (!textBox) return;
  const tb0 = textBox;
  textBox = null;
  const text = tb0.el.value;
  tb0.el.remove();
  if (!commit || !text.trim()) return;
  beginEdit();
  dctx.save();
  const font = `${st.italic ? 'italic ' : ''}${st.bold ? '700 ' : ''}${st.fontSize}px "${st.font}", sans-serif`;
  dctx.font = font;
  dctx.textBaseline = 'top';
  const lh = st.fontSize * 1.25;
  // Wrap lines to the box width.
  const lines = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      if (dctx.measureText(line + word).width > tb0.w - 4 && line.trim()) { lines.push(line); line = word.trimStart(); } else line += word;
    }
    lines.push(line);
  }
  const width = Math.max(...lines.map((l) => dctx.measureText(l).width));
  if (st.textBg) { dctx.fillStyle = st.c2; dctx.fillRect(tb0.x, tb0.y, Math.max(width + 4, tb0.w), lines.length * lh + 4); }
  dctx.fillStyle = st.c1;
  dctx.globalAlpha = st.opacity;
  lines.forEach((l, i) => {
    dctx.fillText(l, tb0.x + 2, tb0.y + 2 + i * lh);
    if (st.underline) dctx.fillRect(tb0.x + 2, tb0.y + 2 + i * lh + st.fontSize * 1.05, dctx.measureText(l).width, Math.max(1, st.fontSize / 16));
  });
  dctx.restore();
  endEdit('Text', { x: tb0.x, y: tb0.y, w: Math.max(width + 8, tb0.w), h: lines.length * lh + 8 });
  vp.render();
}

// ---------------------------------------------------------------------------
// Pointer
// ---------------------------------------------------------------------------
let drag0 = null;
// One-tap tools wait for a finger to lift, so a pinch never fills or stamps by accident.
const TAP_TOOLS = ['fill', 'picker', 'stamp', 'text', 'zoom'];

/** A second finger arrived: this is a pinch, so drop whatever the first finger began. */
function cancelGesture() {
  if (stroke) { clearInterval(stroke.timer); stroke = null; }
  preview = null;
  if (curve && curve.stage === 0) curve = null;
  drag0 = null;
  vp.render();
}

function pointer(kind, e) {
  if (kind === 'cancel') { cancelGesture(); return; }
  const p = vp.toImage(e);
  if (kind === 'leave') { cursor = null; vp.renderOverlay(); posItem.textContent = ''; return; }
  cursor = p;
  if (kind === 'move') {
    posItem.textContent = `${Math.floor(p.x)}, ${Math.floor(p.y)} px`;
    if (!drag0) {
      vp.scroller.style.cursor = cursorFor(e, p);
      if (st.tool === 'curve' && curve && curve.stage === 1) { curve.p1 = p; curve.p2 = p; preview = (ctx) => drawCurve(ctx, curve, curve.color); }
      vp.renderOverlay();
      return;
    }
  }
  if (kind === 'down') {
    if (e.button === 2 && !settings.get('rightPaints', true) && !['select', 'lasso'].includes(st.tool)) return;
    if (e.button === 2 && ['select', 'lasso', 'text', 'zoom', 'picker'].includes(st.tool)) return; // the context menu
    vp.scroller.setPointerCapture(e.pointerId);
    drag0 = { p, e, button: e.button, moved: false };
    if (e.pointerType === 'touch' && TAP_TOOLS.includes(st.tool)) { drag0.tap = true; return; }
    down(p, e);
    return;
  }
  if (kind === 'move' && drag0) { if (drag0.tap) return; drag0.moved = true; move(p, e); vp.render(); return; }
  if (kind === 'up' && drag0) {
    if (drag0.tap) { const d = drag0; down(d.p, d.e); drag0 = d; }
    up(p, e);
    drag0 = null;
    vp.render();
  }
  if (kind === 'dblclick' && st.tool === 'curve') commitCurve();
}

function cursorFor(e, p) {
  const t = st.tool;
  if (vp.space) return 'grab';
  if ((t === 'select' || t === 'lasso') && sel) {
    const hd = hitHandle(e);
    if (hd) return { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize', nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize' }[hd];
    if (inSelection(p)) return 'move';
  }
  return { select: 'crosshair', lasso: 'crosshair', picker: 'copy', fill: 'cell', text: 'text', zoom: 'zoom-in', shape: 'crosshair', curve: 'crosshair', gradient: 'crosshair', stamp: 'copy', brush: 'none', pencil: 'none', eraser: 'none', airbrush: 'none' }[t] || 'default';
}

function down(p, e) {
  const t = st.tool;
  if (textBox && t !== 'text') closeTextBox(true);
  switch (t) {
    case 'brush': case 'pencil': case 'eraser': case 'airbrush':
      if (sel && sel.float) drop();
      startStroke(e, p);
      break;
    case 'fill': if (sel && sel.float) drop(); fillAt(p, e.button); break;
    case 'picker': pickAt(p, e.button); setTool(st.prevTool || 'brush'); break;
    case 'zoom': vp.zoomStep(e.button === 2 || e.altKey ? -1 : 1, { x: e.clientX, y: e.clientY }); break;
    case 'text': {
      if (textBox) { closeTextBox(true); break; }
      openTextBox(p);
      break;
    }
    case 'stamp': stampAt(p); break;
    case 'select': case 'lasso': {
      const hd = sel && hitHandle(e);
      if (hd) { lift(); drag0.handle = hd; drag0.box = { x: sel.x, y: sel.y, w: sel.w, h: sel.h }; break; }
      if (sel && inSelection(p)) {
        if (e.ctrlKey && sel.float) {
          // Ctrl+drag a moved piece: leave a copy where it is and keep dragging another.
          const keepFloat = cloneCanvas(sel.float);
          const keep = { ...sel };
          drop();
          sel = { ...keep, float: keepFloat, liftEdit: { x: keep.x, y: keep.y, w: 0, h: 0 } };
          beginEdit();
        } else if (e.ctrlKey) {
          // Ctrl+drag: copy instead of cut (lift without leaving a hole).
          lift();
          dctx.drawImage(backup, 0, 0);
          sel.liftEdit = { x: sel.x, y: sel.y, w: 0, h: 0 };
        } else lift();
        drag0.moveFrom = { x: sel.x, y: sel.y };
        break;
      }
      drop();
      if (t === 'select') drag0.rect = true;
      else drag0.lasso = [[p.x, p.y]];
      break;
    }
    case 'shape':
      if (sel && sel.float) drop();
      if (st.shape === 'curve') {
        if (!curve) { curve = { stage: 0, p0: p, p3: p, p1: p, p2: p, color: paintColor(e.button) }; }
        else if (curve.stage === 1) { curve.p1 = p; curve.p2 = p; }
        else if (curve.stage === 2) { curve.p2 = p; }
        break;
      }
      break;
    case 'gradient': break;
    default: break;
  }
}

function move(p, e) {
  const t = st.tool;
  const d = drag0;
  if (stroke) {
    const pts = e.getCoalescedEvents ? e.getCoalescedEvents().map((ce) => vp.toImage(ce)) : [p];
    for (const q of pts.length ? pts : [p]) {
      if (st.tool === 'airbrush') spray(q); else dab(stroke.last, q);
      stroke.last = q;
    }
    return;
  }
  if ((t === 'select' || t === 'lasso') && d.handle && sel) {
    const b = d.box;
    let { x, y, w, h: hh } = b;
    const dx = p.x - d.p.x;
    const dy = p.y - d.p.y;
    if (d.handle.includes('e')) w = b.w + dx;
    if (d.handle.includes('s')) hh = b.h + dy;
    if (d.handle.includes('w')) { w = b.w - dx; x = b.x + dx; }
    if (d.handle.includes('n')) { hh = b.h - dy; y = b.y + dy; }
    if (e.shiftKey && d.handle.length === 2) { const r = b.w / b.h; if (w / r > hh) hh = w / r; else w = hh * r; if (d.handle.includes('w')) x = b.x + b.w - w; if (d.handle.includes('n')) y = b.y + b.h - hh; }
    sel.x = Math.round(Math.min(x, x + w)); sel.y = Math.round(Math.min(y, y + hh));
    sel.w = Math.max(1, Math.round(Math.abs(w))); sel.h = Math.max(1, Math.round(Math.abs(hh)));
    updateStatus();
    return;
  }
  if ((t === 'select' || t === 'lasso') && d.moveFrom && sel) {
    sel.x = Math.round(d.moveFrom.x + p.x - d.p.x);
    sel.y = Math.round(d.moveFrom.y + p.y - d.p.y);
    return;
  }
  if (t === 'select' && d.rect) {
    let q = p;
    if (e.shiftKey) q = constrain(d.p, p, 'rect');
    const x0 = clamp(Math.floor(Math.min(d.p.x, q.x)), 0, doc.width);
    const y0 = clamp(Math.floor(Math.min(d.p.y, q.y)), 0, doc.height);
    const x1 = clamp(Math.ceil(Math.max(d.p.x, q.x)), 0, doc.width);
    const y1 = clamp(Math.ceil(Math.max(d.p.y, q.y)), 0, doc.height);
    sel = { x: x0, y: y0, w: x1 - x0, h: y1 - y0, path: null, float: null };
    updateStatus();
    return;
  }
  if (t === 'lasso' && d.lasso) {
    d.lasso.push([clamp(p.x, 0, doc.width), clamp(p.y, 0, doc.height)]);
    const xs = d.lasso.map((q) => q[0]);
    const ys = d.lasso.map((q) => q[1]);
    sel = { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys), path: d.lasso.slice(), float: null };
    return;
  }
  if (t === 'shape') {
    if (st.shape === 'curve' && curve) {
      if (curve.stage === 0) curve.p3 = e.shiftKey ? constrain(curve.p0, p, 'line') : p;
      else if (curve.stage === 1) { curve.p1 = p; curve.p2 = p; }
      else curve.p2 = p;
      preview = (ctx) => drawCurve(ctx, curve, curve.color);
      return;
    }
    const q = e.shiftKey ? constrain(d.p, p, st.shape) : p;
    const from = e.altKey && st.shape !== 'line' ? { x: d.p.x - (q.x - d.p.x), y: d.p.y - (q.y - d.p.y) } : d.p;
    preview = (ctx) => drawShape(ctx, st.shape, from.x, from.y, q.x, q.y, d.button);
    d.last = { from, q };
    return;
  }
  if (t === 'gradient') {
    d.last = p;
    preview = (ctx) => { ctx.save(); ctx.strokeStyle = '#1f883d'; ctx.lineWidth = 2 / vp.zoom; ctx.setLineDash([6 / vp.zoom, 4 / vp.zoom]); ctx.beginPath(); ctx.moveTo(d.p.x, d.p.y); ctx.lineTo(p.x, p.y); ctx.stroke(); ctx.restore(); };
  }
}

function up() {
  const t = st.tool;
  const d = drag0;
  if (stroke) { finishStroke(); return; }
  if ((t === 'select' || t === 'lasso') && (d.handle || d.moveFrom)) { markDirty(); updateStatus(); return; }
  if (t === 'select' && d.rect && sel && (sel.w < 2 || sel.h < 2)) sel = null;
  if (t === 'lasso' && d.lasso && (!sel || d.lasso.length < 3 || sel.w < 2 || sel.h < 2)) sel = null;
  if (t === 'shape') {
    if (st.shape === 'curve' && curve) {
      curve.stage++;
      if (curve.stage >= 3) commitCurve();
      return;
    }
    preview = null;
    if (d.last && d.moved) {
      beginEdit();
      drawShape(dctx, st.shape, d.last.from.x, d.last.from.y, d.last.q.x, d.last.q.y, d.button);
      const pad = st.size + 2;
      endEdit('Shape', { x: Math.min(d.last.from.x, d.last.q.x) - pad, y: Math.min(d.last.from.y, d.last.q.y) - pad, w: Math.abs(d.last.q.x - d.last.from.x) + pad * 2, h: Math.abs(d.last.q.y - d.last.from.y) + pad * 2 });
    }
  }
  if (t === 'gradient') {
    preview = null;
    if (d.moved && d.last) gradientFill(d.p, d.last, d.button);
  }
  updateStatus();
}

// Right-click: a menu where right-click is not painting.
vp.scroller.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const p = vp.toImage(e);
  const outside = p.x < 0 || p.y < 0 || p.x > doc.width || p.y > doc.height;
  if (!outside && !['select', 'lasso', 'text', 'zoom', 'picker'].includes(st.tool) && settings.get('rightPaints', true)) return;
  if (st.tool === 'zoom') return;
  canvasMenu(e);
});

// ---------------------------------------------------------------------------
// Tools, colours and options
// ---------------------------------------------------------------------------
const TOOLS = [
  ['select', 'Select', 'select', 'M'], ['lasso', 'Free-form select', 'lasso', 'Q'], ['brush', 'Brush', 'brush', 'B'], ['pencil', 'Pencil', 'pencil', 'P'],
  ['airbrush', 'Airbrush', 'spray', 'A'], ['eraser', 'Eraser', 'eraser', 'E'], ['fill', 'Fill', 'bucket', 'G'], ['gradient', 'Gradient', 'gradient', 'Shift+G'],
  ['picker', 'Colour picker', 'pipette', 'I'], ['text', 'Text', 'text', 'T'], ['shape', 'Shapes and lines', 'shapes', 'U'], ['stamp', 'Sticker stamp', 'sticker', 'S'], ['zoom', 'Magnifier', 'zoomIn', 'Z'],
];

function setTool(t) {
  if (t === st.tool) return;
  if (textBox) closeTextBox(true);
  if (curve) commitCurve();
  if (sel && !['select', 'lasso'].includes(t) && sel.float) drop();
  if (t === 'picker') st.prevTool = st.tool;
  st.tool = t;
  save('tool');
  preview = null;
  buildOptions();
  refresh();
  vp.renderOverlay();
}

function setColor(which, c) {
  if (which === 1) { st.c1 = c; save('c1'); } else { st.c2 = c; save('c2'); }
  drawColors();
  styleTextBox();
}

function drawColors() {
  const b1 = h('button.cbig.c1', { style: { background: st.c1 }, 'data-tip': 'Colour 1 (left button). Click to change.' });
  const b2 = h('button.cbig.c2', { style: { background: st.c2 }, 'data-tip': 'Colour 2 (right button). Click to change.' });
  const swap = h('button.cswap', { 'data-tip': 'Swap colours', 'data-keys': 'X', html: icon('repeat', 12) });
  const edit = (which, anchor) => {
    const picker = colorPicker({ value: which === 1 ? st.c1 : st.c2, alpha: false, onChange: (c) => setColor(which, toHex(parseColor(c))), onPick: (c) => { closeMenus(); setColor(which, toHex(parseColor(c))); } });
    popover(picker, { anchor });
  };
  b1.addEventListener('click', () => edit(1, b1));
  b2.addEventListener('click', () => edit(2, b2));
  swap.addEventListener('click', () => commands.run('color.swap'));
  const pal = h('div.palette-grid', ...PALETTE.map((c) => {
    const s = h('button.pswatch', { style: { background: c }, 'data-tip': `${c} (left: colour 1, right: colour 2)` });
    s.addEventListener('click', () => setColor(1, c));
    s.addEventListener('contextmenu', (e) => { e.preventDefault(); setColor(2, c); });
    return s;
  }));
  const recent = settings.get('recent', []);
  const rec = h('div.palette-grid', ...recent.map((c) => {
    const s = h('button.pswatch', { style: { background: c }, 'data-tip': c });
    s.addEventListener('click', () => setColor(1, c));
    s.addEventListener('contextmenu', (e) => { e.preventDefault(); setColor(2, c); });
    return s;
  }));
  colorsBox.replaceChildren(...[h('div.cpair', b2, b1, swap), pal, recent.length ? h('div.muted', { style: { fontSize: '11px' } }, 'Recent') : null, rec].filter(Boolean));
  // Remember colours that get used.
  for (const c of [st.c1, st.c2]) if (!PALETTE.includes(c) && !recent.includes(c)) settings.set('recent', [c, ...recent].slice(0, 10));
}

function slider(label, value, min, max, step, onInput, tip = '') {
  const input = h('input', { type: 'range', min, max, step, value, 'data-tip': tip || label, style: { width: '90px' } });
  const out = h('span.opt-val', String(value));
  input.addEventListener('input', () => { out.textContent = input.value; onInput(Number(input.value)); });
  return h('label.opt', h('span.muted', label), input, out);
}

function checkbox(label, value, onChange) {
  const c = h('input', { type: 'checkbox', checked: !!value });
  c.addEventListener('change', () => onChange(c.checked));
  return h('label.check.opt', c, label);
}

let fontList = knownFonts();
allFonts().then((l) => { fontList = l; });

function buildOptions() {
  const t = st.tool;
  const items = [h('span.opt-title', TOOLS.find((x) => x[0] === t)[1])];
  const size = () => slider('Size', st.size, 1, 200, 1, (v) => { st.size = v; save('size'); vp.renderOverlay(); }, 'Size ([ and ] or Alt+wheel)');
  const opacity = () => slider('Opacity', Math.round(st.opacity * 100), 5, 100, 5, (v) => { st.opacity = v / 100; save('opacity'); }, 'Opacity');
  const symmetry = () => h('label.opt', h('span.muted', 'Mirror'), select({ options: [{ value: 'none', label: 'Off' }, { value: 'vertical', label: 'Left ↔ right' }, { value: 'horizontal', label: 'Top ↕ bottom' }, { value: 'both', label: 'Four ways' }, { value: 'radial6', label: 'Kaleidoscope 6' }, { value: 'radial8', label: 'Kaleidoscope 8' }, { value: 'radial12', label: 'Kaleidoscope 12' }], value: st.symmetry, onChange: (v) => { st.symmetry = v; save('symmetry'); vp.renderOverlay(); } }));
  if (['brush', 'pencil', 'eraser', 'airbrush'].includes(t)) {
    if (t === 'brush') {
      items.push(select({ options: [{ value: 'round', label: 'Round brush' }, { value: 'square', label: 'Square brush' }, { value: 'calligraphy', label: 'Calligraphy pen' }, { value: 'marker', label: 'Marker' }, { value: 'crayon', label: 'Crayon' }],
        value: st.brush, tip: 'Brush type', onChange: (v) => { st.brush = v; save('brush'); vp.renderOverlay(); } }));
    }
    if (t !== 'pencil' || !st.pixel) items.push(size());
    if (t !== 'eraser') items.push(opacity());
    if (t === 'pencil' || t === 'brush') items.push(checkbox('Pixel art', st.pixel, (v) => { st.pixel = v; save('pixel'); settings.set('pixelGrid', v || settings.get('pixelGrid', true)); }));
    if (t === 'eraser') items.push(checkbox('Erase to transparent', st.eraseTransparent, (v) => { st.eraseTransparent = v; save('eraseTransparent'); }));
    items.push(symmetry());
  } else if (t === 'fill') {
    items.push(slider('Tolerance', st.tolerance, 0, 128, 1, (v) => { st.tolerance = v; save('tolerance'); }), opacity(), checkbox('Fill every matching colour', st.fillAll, (v) => { st.fillAll = v; }));
  } else if (t === 'gradient') {
    items.push(h('div.seg', ...[['linear', 'Straight'], ['radial', 'Round']].map(([v, l]) => { const b = h(`button${st.gradient === v ? '.on' : ''}`, l); b.addEventListener('click', () => { st.gradient = v; save('gradient'); buildOptions(); }); return b; })), opacity(),
      h('span.muted', 'Drag across the picture: colour 1 fades into colour 2.'));
  } else if (t === 'shape') {
    items.push(galleryButton('Shape', shapeIcon(st.shape, 20), SHAPES.map(([k, l]) => ({ html: shapeIcon(k, 22), tip: l, on: st.shape === k, pick: () => { st.shape = k; save('shape'); buildOptions(); } })), 'shape-grid'), size(), opacity());
    if (!['line', 'curve'].includes(st.shape)) {
      items.push(checkbox('Outline', st.outline, (v) => { st.outline = v; save('outline'); }), checkbox('Fill (colour 2)', st.fill, (v) => { st.fill = v; save('fill'); }));
    }
    if (st.shape === 'curve') items.push(h('span.muted', 'Drag a line, then click twice to bend it (Enter finishes).'));
  } else if (t === 'text') {
    const fbox = combo({ values: () => fontList, value: st.font, width: 160, itemStyle: (f) => ({ fontFamily: `"${f}"` }), onCommit: (v) => { st.font = v; save('font'); styleTextBox(); } });
    const sbox = combo({ values: FONT_SIZES, value: String(st.fontSize), width: 64, numeric: true, min: 4, max: 400, onCommit: (v) => { st.fontSize = Number(v) || 32; save('fontSize'); placeTextBox(); } });
    const tog = (key, ic) => tb({ icon: ic, tip: key, on: () => st[key], run: () => { st[key] = !st[key]; styleTextBox(); refresh(); } });
    items.push(fbox, sbox, tog('bold', 'bold'), tog('italic', 'italic'), tog('underline', 'underline'), checkbox('Background (colour 2)', st.textBg, (v) => { st.textBg = v; styleTextBox(); }), opacity());
  } else if (t === 'select' || t === 'lasso') {
    items.push(checkbox('Transparent (ignore colour 2)', st.transparentSel, (v) => { st.transparentSel = v; save('transparentSel'); }),
      tb('sel.crop', { showLabel: true }), tb('sel.all', { showLabel: true }), tb({ icon: 'rotateCw', label: 'Rotate', showLabel: true, menu: () => rotateMenu() }), tb('sel.delete', { showLabel: true }));
  } else if (t === 'stamp') {
    items.push(galleryButton('Sticker', h('span.stamp-now', st.stamp), STAMPS.map((x) => ({ text: x, tip: x, on: st.stamp === x, pick: () => { st.stamp = x; save('stamp'); buildOptions(); } })), 'stamp-grid'), size(), opacity(), symmetry());
  } else if (t === 'zoom') {
    items.push(h('span.muted', 'Click to zoom in, right-click to zoom out. The wheel zooms anywhere.'));
  } else if (t === 'picker') {
    items.push(h('span.muted', 'Click: colour 1. Right-click: colour 2. Then you go back to the last tool.'));
  }
  optionsBar.replaceChildren(...items);
}

const STAMPS = '⭐ ❤️ 😀 😎 🐍 🌸 🌈 🔥 ✅ ❌ ⚡ 🎉 🍕 🐱 🐶 🌟 💎 🎈 🍀 ☀️ 🌙 👍 💡 🎵 🏠 🚗 ✏️ 📌 ➡️ ❓'.split(' ');

function shapeIcon(k, size = 20) {
  if (k === 'line' || k === 'curve') return icon(k, size);
  return `<svg viewBox="0 0 24 18" width="${size}" height="${Math.round(size * 0.75)}"><path d="${shapePath(k, 24, 18, 0.18)}" fill="none" stroke="currentColor" stroke-width="1.6" vector-effect="non-scaling-stroke"/></svg>`;
}

/** A button showing the current choice that opens a grid of choices. */
function galleryButton(label, current, choices, cls) {
  const b = h('button.tb.gallery-btn', { 'data-tip': `${label}: choose` }, typeof current === 'string' ? h('span', { html: current }) : current, h('span', { html: icon('chevronDown', 10) }));
  b.addEventListener('click', () => {
    const grid = h(`div.choice-grid.${cls}`, ...choices.map((c) => {
      const x = h(`button${c.on ? '.on' : ''}`, { 'data-tip': c.tip, html: c.html || null }, c.text || null);
      x.addEventListener('click', () => { closeMenus(); c.pick(); });
      return x;
    }));
    popover(grid, { anchor: b });
  });
  return b;
}

function buildToolbox() {
  toolbox.replaceChildren(...TOOLS.map(([id]) => tb(`tool.${id}`)));
}

// ---------------------------------------------------------------------------
// Image operations
// ---------------------------------------------------------------------------
function rotateMenu() {
  return [{ label: 'Rotate right 90°', icon: 'rotateCw', run: () => transformSelection((c) => rotated(c, 90), 'Rotate') },
    { label: 'Rotate left 90°', icon: 'rotateCcw', run: () => transformSelection((c) => rotated(c, -90), 'Rotate') },
    { label: 'Rotate 180°', run: () => transformSelection((c) => rotated(c, 180), 'Rotate') },
    { label: 'Flip horizontally', icon: 'flipH', run: () => transformSelection((c) => flipped(c, true), 'Flip') },
    { label: 'Flip vertically', icon: 'flipV', run: () => transformSelection((c) => flipped(c, false), 'Flip') }];
}

async function resizeDialog() {
  const target = sel ? 'selection' : 'picture';
  const w0 = sel ? sel.w : doc.width;
  const h0 = sel ? sel.h : doc.height;
  const mode = select({ options: [{ value: 'pct', label: 'Percent' }, { value: 'px', label: 'Pixels' }], value: 'pct', onChange: (v) => { w.value = v === 'pct' ? 100 : w0; hh.value = v === 'pct' ? 100 : h0; } });
  const w = h('input.input.num', { type: 'number', value: 100, min: 1 });
  const hh = h('input.input.num', { type: 'number', value: 100, min: 1 });
  const keep = h('input', { type: 'checkbox', checked: true });
  const skewX = h('input.input.num', { type: 'number', value: 0, min: -89, max: 89 });
  const skewY = h('input.input.num', { type: 'number', value: 0, min: -89, max: 89 });
  w.addEventListener('input', () => { if (keep.checked) hh.value = mode.value === 'pct' ? w.value : Math.round((w.value * h0) / w0); });
  hh.addEventListener('input', () => { if (keep.checked) w.value = mode.value === 'pct' ? hh.value : Math.round((hh.value * w0) / h0); });
  const ok = await modal({ title: `Resize and skew the ${target}`, body: h('div.col', { style: { minWidth: '360px' } }, h('label.field', h('span', 'By'), mode), h('label.field', h('span', 'Width'), w), h('label.field', h('span', 'Height'), hh), h('label.check', keep, 'Keep the shape'), h('b', 'Skew (degrees)'), h('label.field', h('span', 'Sideways'), skewX), h('label.field', h('span', 'Up and down'), skewY)),
    buttons: [{ label: 'Cancel', value: false }, { label: 'Apply', value: true, primary: true }] });
  if (!ok) return;
  const nw = Math.max(1, Math.round(mode.value === 'pct' ? (w0 * w.value) / 100 : Number(w.value)));
  const nh = Math.max(1, Math.round(mode.value === 'pct' ? (h0 * hh.value) / 100 : Number(hh.value)));
  if (nw * nh > 16384 * 16384 / 4) { toast('That is too big.', { type: 'warn' }); return; }
  const sx = Math.tan((Number(skewX.value) * Math.PI) / 180);
  const sy = Math.tan((Number(skewY.value) * Math.PI) / 180);
  const apply = (src) => {
    let c = resized(src, nw, nh, !st.pixel);
    if (sx || sy) {
      const W = Math.round(c.width + Math.abs(sx) * c.height);
      const H = Math.round(c.height + Math.abs(sy) * c.width);
      const k = makeCanvas(W, H);
      const kctx = k.getContext('2d');
      if (!sel) { kctx.fillStyle = st.c2; kctx.fillRect(0, 0, W, H); }
      kctx.setTransform(1, sy, sx, 1, sx < 0 ? -sx * c.height : 0, sy < 0 ? -sy * c.width : 0);
      kctx.drawImage(c, 0, 0);
      c = k;
    }
    return c;
  };
  transformSelection(apply, 'Resize');
}

async function canvasSizeDialog() {
  const w = h('input.input.num', { type: 'number', value: doc.width, min: 1, max: 16384 });
  const hh = h('input.input.num', { type: 'number', value: doc.height, min: 1, max: 16384 });
  let anchor = 'nw';
  const grid = h('div.anchor-grid', ...['nw', 'n', 'ne', 'w', 'c', 'e', 'sw', 's', 'se'].map((a) => {
    const b = h(`button${a === anchor ? '.on' : ''}`, { 'data-tip': 'Keep the picture here' });
    b.addEventListener('click', () => { anchor = a; for (const x of grid.children) x.classList.toggle('on', x === b); });
    return b;
  }));
  const ok = await modal({ title: 'Canvas size', body: h('div.col', { style: { minWidth: '320px' } }, h('label.field', h('span', 'Width'), w), h('label.field', h('span', 'Height'), hh), h('div.field', h('span', 'Anchor'), grid), h('div.muted', 'New space is painted with colour 2.')),
    buttons: [{ label: 'Cancel', value: false }, { label: 'Apply', value: true, primary: true }] });
  if (!ok) return;
  const nw = clamp(Number(w.value) || doc.width, 1, 16384);
  const nh = clamp(Number(hh.value) || doc.height, 1, 16384);
  const dx = anchor.includes('w') ? 0 : anchor.includes('e') ? nw - doc.width : Math.round((nw - doc.width) / 2);
  const dy = anchor.includes('n') ? 0 : anchor.includes('s') ? nh - doc.height : Math.round((nh - doc.height) / 2);
  drop();
  const c = makeCanvas(nw, nh);
  const ctx = c.getContext('2d');
  ctx.fillStyle = st.c2;
  ctx.fillRect(0, 0, nw, nh);
  ctx.drawImage(doc, dx, dy);
  replaceDoc('Canvas size', c);
  vp.fit();
}

function adjust(label, fn) {
  // Colour changes for the selection, or the whole picture.
  drop();
  const r = sel ? clipRect(sel) : { x: 0, y: 0, w: doc.width, h: doc.height };
  beginEdit();
  const id = dctx.getImageData(r.x, r.y, r.w, r.h);
  fn(id.data);
  dctx.putImageData(id, r.x, r.y);
  endEdit(label, r);
  vp.render();
}

function autoCrop() {
  // Trim borders that are all one colour.
  const id = dctx.getImageData(0, 0, doc.width, doc.height);
  const d = id.data;
  const W = doc.width;
  const H = doc.height;
  const ref = [d[0], d[1], d[2], d[3]];
  const same = (x, y) => { const i = (y * W + x) * 4; return Math.abs(d[i] - ref[0]) + Math.abs(d[i + 1] - ref[1]) + Math.abs(d[i + 2] - ref[2]) + Math.abs(d[i + 3] - ref[3]) < 24; };
  let top = 0; let bottom = H - 1; let left = 0; let right = W - 1;
  const rowSame = (y) => { for (let x = 0; x < W; x++) if (!same(x, y)) return false; return true; };
  const colSame = (x) => { for (let y = top; y <= bottom; y++) if (!same(x, y)) return false; return true; };
  while (top < bottom && rowSame(top)) top++;
  while (bottom > top && rowSame(bottom)) bottom--;
  while (left < right && colSame(left)) left++;
  while (right > left && colSame(right)) right--;
  if (top === 0 && left === 0 && bottom === H - 1 && right === W - 1) { toast('There is no plain border to trim.'); return; }
  replaceDoc('Trim borders', cropped(doc, left, top, right - left + 1, bottom - top + 1));
  vp.fit();
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------
async function newPicture() {
  if (!(await confirmLeave())) return;
  const w = h('input.input.num', { type: 'number', value: settings.get('newW', 1200), min: 1, max: 16384 });
  const hh = h('input.input.num', { type: 'number', value: settings.get('newH', 800), min: 1, max: 16384 });
  const bg = select({ options: [{ value: '#ffffff', label: 'White' }, { value: 'transparent', label: 'Transparent' }, { value: '#000000', label: 'Black' }, { value: 'c2', label: 'Colour 2' }], value: settings.get('newBg', '#ffffff'), onChange: (v) => settings.set('newBg', v) });
  const presets = select({ options: [{ value: '', label: 'Size presets…' }, { value: '1200x800', label: '1200 × 800' }, { value: '1920x1080', label: 'Full HD 1920 × 1080' }, { value: '1080x1080', label: 'Square post 1080 × 1080' }, { value: '1080x1920', label: 'Phone story 1080 × 1920' }, { value: '64x64', label: 'Icon 64 × 64' }, { value: '32x32', label: 'Pixel art 32 × 32' }, { value: '16x16', label: 'Pixel art 16 × 16' }, { value: '2480x3508', label: 'A4 at 300 dpi' }],
    value: '', onChange: (v) => { if (!v) return; const [a, b] = v.split('x'); w.value = a; hh.value = b; } });
  const ok = await modal({ title: 'New picture', body: h('div.col', { style: { minWidth: '320px' } }, presets, h('label.field', h('span', 'Width'), w), h('label.field', h('span', 'Height'), hh), h('label.field', h('span', 'Background'), bg)),
    buttons: [{ label: 'Cancel', value: false }, { label: 'Create', value: true, primary: true }] });
  if (!ok) return;
  const nw = clamp(Number(w.value) || 1200, 1, 16384);
  const nh = clamp(Number(hh.value) || 800, 1, 16384);
  settings.set('newW', nw);
  settings.set('newH', nh);
  const c = makeCanvas(nw, nh);
  if (bg.value !== 'transparent') { const ctx = c.getContext('2d'); ctx.fillStyle = bg.value === 'c2' ? st.c2 : bg.value; ctx.fillRect(0, 0, nw, nh); }
  usePicture(c, { name: 'Untitled' });
  if (nw <= 64 && nh <= 64) { st.pixel = true; save('pixel'); setTool('pencil'); buildOptions(); }
}

function usePicture(c, { name = 'Untitled', handle = null, format = 'png' } = {}) {
  closeTextBox(false);
  sel = null;
  stroke = null;
  doc = c;
  dctx = doc.getContext('2d', { willReadFrequently: true });
  file.handle = handle;
  file.name = name;
  file.format = format;
  history.clear();
  historyBytes = 0;
  vp.fitted = false;
  vp.layout();
  vp.fit();
  updateTitle();
  updateStatus();
}

async function openFile(f) {
  if (!(await confirmLeave())) return;
  const b = busy(`Opening ${f.name}…`);
  try {
    const bytes = await host.read(f);
    const c = await decodeImage(bytes, IMAGE_TYPES[extOf(f.name)] || '');
    const fmt = formatOf(f.name);
    usePicture(c, { name: f.name, handle: fmt ? f : null, format: fmt || 'png' });
    refreshRecent();
  } catch (err) { errorToast(err); } finally { b.close(); }
}

/** The save format a file name implies (null for ones Paint only reads). */
function formatOf(name) {
  const e = extOf(name) === 'jpeg' ? 'jpg' : extOf(name);
  return SAVE_TYPES[e] ? e : null;
}

async function openDialog() { const files = await host.openFiles({ filters: OPEN_FILTERS }); if (files[0]) await openFile(files[0]); }

async function confirmLeave() {
  if (!isDirty()) return true;
  const r = await saveChangesBox(file.name);
  if (r === 'save') return saveFile();
  return r === 'discard';
}

function flattened(format) {
  drop();
  if (format !== 'jpg') return doc;
  // JPEG has no transparency: lay it on white.
  const c = makeCanvas(doc.width, doc.height);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.drawImage(doc, 0, 0);
  return c;
}

async function saveFile() {
  if (!file.handle || !file.handle.writable) return saveAs();
  try {
    const fmt = SAVE_TYPES[file.format] || SAVE_TYPES.png;
    file.handle = await host.write(file.handle, await canvasBytes(flattened(file.format), fmt.mime, settings.get('quality', 0.92)));
    history.markSaved();
    updateTitle();
    toast(`Saved ${file.name}`, { timeout: 1500 });
    return true;
  } catch (err) { errorToast(err); return false; }
}

async function saveAs(format = null) {
  const fmt = format || file.format || 'png';
  try {
    const name = `${baseName(file.name === 'Untitled' ? 'Picture' : file.name)}.${SAVE_TYPES[fmt].exts[0]}`;
    const others = Object.entries(SAVE_TYPES).filter(([k]) => k !== fmt).map(([, v]) => v);
    const bytes = (k) => canvasBytes(flattened(k), SAVE_TYPES[k].mime, settings.get('quality', 0.92));
    const f = await host.saveAs({ name, filters: [SAVE_TYPES[fmt], ...others], near: file.handle && file.handle.id }, await bytes(fmt));
    if (!f) return false;
    const real = formatOf(f.name) || fmt;
    // The person typed another extension: write that format instead.
    if (real !== fmt && f.id) await host.write(f, await bytes(real));
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

async function printPicture() {
  drop();
  const url = doc.toDataURL('image/png');
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
const C = (id, label, keys, run, extra = {}) => ({ id, label, keys, run, ...extra });
commands.register(
  C('file.new', 'New Picture…', 'Ctrl+N', () => newPicture(), { icon: 'new', category: 'File' }),
  C('file.open', 'Open…', 'Ctrl+O', () => openDialog(), { icon: 'open', category: 'File' }),
  C('file.save', 'Save', 'Ctrl+S', () => saveFile(), { icon: 'save', category: 'File' }),
  C('file.saveAs', 'Save As…', 'Ctrl+Shift+S', () => saveAs(), { icon: 'saveAs', category: 'File' }),
  C('file.print', 'Print…', 'Ctrl+P', () => printPicture(), { icon: 'print', category: 'File' }),
  C('file.pasteFrom', 'Paste From a File…', null, async () => { const fs = await host.openFiles({ filters: OPEN_FILTERS, readOnly: true }); if (fs[0]) paste(await decodeImage(await host.read(fs[0]), IMAGE_TYPES[extOf(fs[0].name)] || '')); }, { icon: 'import', category: 'File' }),
  C('edit.undo', 'Undo', 'Ctrl+Z', () => { if (textBox) { closeTextBox(false); return; } if (curve) { curve = null; preview = null; vp.render(); return; } drop(); history.undo(); updateStatus(); }, { icon: 'undo', category: 'Edit', when: () => history.canUndo || !!sel }),
  C('edit.redo', 'Redo', ['Ctrl+Y', 'Ctrl+Shift+Z'], () => { drop(); history.redo(); updateStatus(); }, { icon: 'redo', category: 'Edit', when: () => history.canRedo }),
  C('edit.cut', 'Cut', 'Ctrl+X', () => copy(true), { icon: 'cut', category: 'Edit', when: () => !!sel }),
  C('edit.copy', 'Copy', 'Ctrl+C', () => copy(false), { icon: 'copy', category: 'Edit' }),
  C('edit.paste', 'Paste', 'Ctrl+V', () => paste(), { icon: 'paste', category: 'Edit' }),
  C('sel.all', 'Select All', 'Ctrl+A', () => selectAll(), { icon: 'select', category: 'Select' }),
  C('sel.none', 'Deselect', ['Escape', 'Ctrl+Shift+A'], () => { if (curve) { curve = null; preview = null; vp.render(); return; } deselect(); }, { category: 'Select', when: () => !!sel || !!curve }),
  C('sel.delete', 'Delete Selection', 'Delete', () => deleteSelection(), { icon: 'trash', category: 'Select', when: () => !!sel }),
  C('sel.crop', 'Crop to Selection', 'Ctrl+Shift+X', () => cropToSelection(), { icon: 'crop', category: 'Image', when: () => !!sel }),
  C('img.resize', 'Resize and Skew…', 'Ctrl+Alt+I', () => resizeDialog(), { icon: 'resize', category: 'Image' }),
  C('img.canvas', 'Canvas Size…', 'Ctrl+Alt+C', () => canvasSizeDialog(), { icon: 'margins', category: 'Image' }),
  C('img.rotR', 'Rotate Right 90°', null, () => transformSelection((c) => rotated(c, 90), 'Rotate'), { icon: 'rotateCw', category: 'Image' }),
  C('img.rotL', 'Rotate Left 90°', null, () => transformSelection((c) => rotated(c, -90), 'Rotate'), { icon: 'rotateCcw', category: 'Image' }),
  C('img.flipH', 'Flip Horizontally', null, () => transformSelection((c) => flipped(c, true), 'Flip'), { icon: 'flipH', category: 'Image' }),
  C('img.flipV', 'Flip Vertically', null, () => transformSelection((c) => flipped(c, false), 'Flip'), { icon: 'flipV', category: 'Image' }),
  C('img.invert', 'Invert Colours', 'Ctrl+I', () => adjust('Invert', (d) => { for (let i = 0; i < d.length; i += 4) { d[i] = 255 - d[i]; d[i + 1] = 255 - d[i + 1]; d[i + 2] = 255 - d[i + 2]; } }), { icon: 'invert', category: 'Image' }),
  C('img.gray', 'Black and White', null, () => adjust('Black and white', (d) => { for (let i = 0; i < d.length; i += 4) { const v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; d[i] = d[i + 1] = d[i + 2] = v; } }), { icon: 'contrast', category: 'Image' }),
  C('img.transparent', 'Make Colour 2 Transparent', null, () => { const [r, g, b] = rgba(st.c2); adjust('Make transparent', (d) => { for (let i = 0; i < d.length; i += 4) if (Math.abs(d[i] - r) + Math.abs(d[i + 1] - g) + Math.abs(d[i + 2] - b) <= 30) d[i + 3] = 0; }); }, { icon: 'eyeOff', category: 'Image' }),
  C('img.trim', 'Trim Plain Borders', null, () => autoCrop(), { icon: 'crop', category: 'Image' }),
  C('img.clear', 'Clear the Picture', null, () => { drop(); beginEdit(); dctx.fillStyle = st.c2; dctx.fillRect(0, 0, doc.width, doc.height); endEdit('Clear'); vp.render(); }, { category: 'Image' }),
  C('color.swap', 'Swap Colours', 'X', () => { const a = st.c1; setColor(1, st.c2); setColor(2, a); }, { icon: 'repeat', category: 'Colours' }),
  C('color.reset', 'Black and White Colours', 'D', () => { setColor(1, '#000000'); setColor(2, '#ffffff'); }, { category: 'Colours' }),
  C('size.up', 'Bigger Brush', ']', () => { st.size = Math.min(200, Math.ceil(st.size * 1.2 + 0.5)); save('size'); buildOptions(); vp.renderOverlay(); }, { category: 'Brush' }),
  C('size.down', 'Smaller Brush', '[', () => { st.size = Math.max(1, Math.floor(st.size / 1.2)); save('size'); buildOptions(); vp.renderOverlay(); }, { category: 'Brush' }),
  C('view.zoomIn', 'Zoom In', ['Ctrl+=', 'Ctrl+Shift+='], () => vp.zoomStep(1), { icon: 'zoomIn', category: 'View' }),
  C('view.zoomOut', 'Zoom Out', 'Ctrl+-', () => vp.zoomStep(-1), { icon: 'zoomOut', category: 'View' }),
  C('view.zoom100', 'Actual Size', 'Ctrl+1', () => vp.setZoom(1), { category: 'View' }),
  C('view.fit', 'Fit in the Window', 'Ctrl+0', () => vp.fit(), { icon: 'fit', category: 'View' }),
  C('view.grid', 'Pixel Grid (when zoomed in)', 'Ctrl+G', () => { settings.set('pixelGrid', !settings.get('pixelGrid', true)); vp.render(); refresh(); }, { icon: 'grid', category: 'View', checked: () => settings.get('pixelGrid', true) }),
  C('view.wheel', 'The Wheel Zooms (otherwise it scrolls)', null, () => { vp.wheelZooms = !vp.wheelZooms; settings.set('wheelZooms', vp.wheelZooms); refresh(); }, { icon: 'search', category: 'View', checked: () => vp.wheelZooms }),
  C('view.rightPaints', 'Right Button Paints With Colour 2', null, () => { settings.set('rightPaints', !settings.get('rightPaints', true)); refresh(); }, { category: 'View', checked: () => settings.get('rightPaints', true) }),
  ...TOOLS.map(([id, label, ic, keys]) => C(`tool.${id}`, label, keys, () => setTool(id), { icon: ic, category: 'Tools', checked: () => st.tool === id })),
);

// Alt+wheel changes the brush size where the pointer is.
vp.scroller.addEventListener('wheel', (e) => {
  if (!e.altKey || e.ctrlKey) return;
  e.preventDefault();
  e.stopImmediatePropagation();
  st.size = clamp(Math.round(st.size * (e.deltaY < 0 ? 1.15 : 1 / 1.15) + (e.deltaY < 0 ? 1 : -1) * 0.5), 1, 200);
  save('size');
  buildOptions();
  vp.renderOverlay();
}, { passive: false, capture: true });
window.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && curve && st.tool === 'shape') { e.preventDefault(); commitCurve(); }
});

// ---------------------------------------------------------------------------
// Menus and status
// ---------------------------------------------------------------------------
function fileMenu() {
  return [I('file.new'), I('app.newWindow'), I('file.open'), { label: 'Open Recent', icon: 'clock', submenu: () => (recentCache.length ? recentCache.slice(0, 12).map((r) => ({ label: r.name, disabled: !r.exists, run: async () => { try { await openFile(await host.openRecent(r.key)); } catch (err) { errorToast(err); } } })) : [{ label: 'Nothing yet', disabled: true }]) },
    { type: 'separator' }, I('file.save'), I('file.saveAs'), { label: 'Save as', icon: 'export', submenu: Object.entries(SAVE_TYPES).map(([k, v]) => ({ label: v.name, run: () => saveAs(k) })) }, I('file.pasteFrom'), { type: 'separator' }, I('file.print'), I('app.close')];
}
function editMenu() { return [I('edit.undo', { label: history.undoLabel ? `Undo ${history.undoLabel}` : 'Undo' }), I('edit.redo'), { type: 'separator' }, I('edit.cut'), I('edit.copy'), I('edit.paste'), { type: 'separator' }, I('sel.all'), I('sel.none'), I('sel.delete'), I('sel.crop')]; }
function viewMenu() { return [I('view.zoomIn'), I('view.zoomOut'), I('view.zoom100'), I('view.fit'), { type: 'separator' }, I('view.grid'), I('view.wheel'), I('view.rightPaints'), { type: 'separator' }, I('view.themeDark'), I('view.themeLight'), I('view.fullscreen')]; }
function imageMenu() { return [I('img.resize'), I('img.canvas'), I('sel.crop'), I('img.trim'), { type: 'separator' }, ...rotateMenu(), { type: 'separator' }, I('img.invert'), I('img.gray'), I('img.transparent'), I('img.clear')]; }
function canvasMenu(e) {
  showMenu([I('edit.cut'), I('edit.copy'), I('edit.paste'), I('file.pasteFrom'), { type: 'separator' }, I('sel.all'), I('sel.none'), I('sel.crop'), I('sel.delete'),
    { label: 'Rotate and flip', icon: 'rotateCw', submenu: rotateMenu }, I('img.resize'), I('img.invert'), { type: 'separator' },
    { label: 'Tool', icon: 'brush', submenu: TOOLS.map(([id]) => I(`tool.${id}`)) }], { x: e.clientX, y: e.clientY });
}

const posItem = h('span.item');
const selItem = h('span.item');
const sizeItem = h('button.item', { 'data-tip': 'Canvas size' });
sizeItem.addEventListener('click', () => canvasSizeDialog());
const zoomBox = shell.zoomBox({ get: () => vp.zoom, set: (z) => vp.setZoom(z), min: 0.02, max: 64, fit: [{ label: 'Fit in the window', run: () => vp.fit() }, { label: 'Actual size', run: () => vp.setZoom(1) }] });
shell.statusLeft.append(posItem, selItem, sizeItem);
shell.statusRight.append(zoomBox);
function updateStatus() {
  sizeItem.textContent = `${doc.width} × ${doc.height} px`;
  selItem.textContent = sel ? `Selected ${sel.w} × ${sel.h}` : '';
}
function updateTitle() { shell.setTitle(file.name, isDirty()); }

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
guardClose({ dirty: () => isDirty(), save: () => saveFile(), name: () => file.name });
onDropFiles((files) => {
  const f = files.find((x) => OPEN_FILTERS[0].exts.includes(extOf(x.name)));
  if (!f) return;
  // Drop onto a picture with something drawn: paste it in. Onto an empty one: open it.
  if (!isDirty() && !file.handle && !history.canUndo) openFile(f);
  else host.read(f).then((b) => decodeImage(b, IMAGE_TYPES[extOf(f.name)] || '')).then((c) => paste(c)).catch(errorToast);
}, 'Drop a picture to open it (or to paste it into this one)');
host.onOpen((files) => files[0] && openFile(files[0]));
document.addEventListener('paste', async (e) => {
  if (e.target.closest && e.target.closest('input, textarea')) return;
  const f = [...e.clipboardData.files].find((x) => x.type.startsWith('image/'));
  if (!f) return;
  e.preventDefault();
  paste(await decodeImage(new Uint8Array(await f.arrayBuffer()), f.type));
});

buildToolbox();
buildOptions();
drawColors();
updateStatus();
updateTitle();
if (shell.info.files && shell.info.files.length) openFile(shell.info.files[0]);

window.snakeApp = { get doc() { return doc; }, get sel() { return sel; }, history, vp, st, commands, setTool, usePicture };
