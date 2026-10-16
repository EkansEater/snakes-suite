// Dialogs of Snake's Photo. The adjustment and filter dialogs float beside the
// picture with a live preview; the picture can still be zoomed and panned.
import { h, clamp, fmtBytes } from '../../kit/dom.js';
import { icon } from '../../kit/icons.js';
import { select } from '../../kit/shell.js';
import { popover, closeMenus } from '../../kit/menu.js';
import { modal, toast, busy } from '../../kit/dialogs.js';
import { colorPicker, toHex, parseColor } from '../../kit/color.js';
import { makeCanvas, resized, canvasBytes, cloneCanvas } from '../../kit/raster.js';
import { ADJUSTMENTS, defaultParams, histogram, curveLut, autoParams } from './adjust.js';
import { FILTERS } from './filters.js';
import { newLayer } from './doc.js';

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------
function colorField(value, onChange, { allowNone = false } = {}) {
  const b = h('button.ph-colorfield', { 'data-tip': 'Choose a colour' });
  const paint = (v) => { b.style.background = v || 'repeating-linear-gradient(45deg,#888 0 4px,#bbb 4px 8px)'; b.textContent = v ? '' : 'None'; };
  paint(value);
  b.addEventListener('click', () => {
    const picker = colorPicker({ value: value || '#808080', allowNone, onChange: (c) => { value = toHex(parseColor(c)); paint(value); onChange(value); },
      onPick: (c) => { closeMenus(); value = c === 'none' ? '' : toHex(parseColor(c)); paint(value); onChange(value); } });
    popover(picker, { anchor: b });
  });
  return b;
}

/** Controls for parameter definitions: sliders, checkboxes, lists and colours. */
function controls(defs, values, onChange) {
  return defs.map((p) => {
    if (p.type === 'check') {
      const c = h('input', { type: 'checkbox', checked: !!values[p.key] });
      c.addEventListener('change', () => { values[p.key] = c.checked; onChange(); });
      return h('label.check', c, p.label);
    }
    if (p.type === 'select') {
      return h('label.field', h('span', p.label), select({ options: p.options.map(([v, l]) => ({ value: v, label: l })), value: values[p.key], onChange: (v) => { values[p.key] = v; onChange(); } }));
    }
    if (p.type === 'color') return h('label.field', h('span', p.label), colorField(values[p.key], (v) => { values[p.key] = v; onChange(); }, { allowNone: true }));
    return paramSlider(p.label, values[p.key], p.min, p.max, p.step || 1, (v) => { values[p.key] = v; onChange(); });
  });
}

function paramSlider(label, value, min, max, step, onInput) {
  const range = h('input', { type: 'range', min, max, step, value });
  const num = h('input.input.num', { value: String(value) });
  range.addEventListener('input', () => { num.value = range.value; onInput(Number(range.value)); });
  num.addEventListener('change', () => { const v = clamp(Number(num.value) || 0, min, max); num.value = String(v); range.value = String(v); onInput(v); });
  const el = h('div.ph-param', h('span', label), range, num);
  el.set = (v) => { range.value = String(v); num.value = String(v); };
  return el;
}

/** A dialog that floats beside the picture, so the preview stays in view. */
function floating(opts) {
  return modal({
    ...opts, closeOnBackdrop: false,
    onOpen: (dlg, close) => {
      dlg.parentElement.classList.add('see-through');
      // Drag it by its title bar if it covers what you want to see.
      const head = dlg.querySelector('.dialog-head');
      const pos = floating.pos || { x: 0, y: 0 };
      dlg.style.transform = `translate(${pos.x}px, ${pos.y}px)`;
      head.style.cursor = 'move';
      head.addEventListener('pointerdown', (e) => {
        if (e.target.closest('button')) return;
        const x0 = e.clientX - pos.x;
        const y0 = e.clientY - pos.y;
        head.setPointerCapture(e.pointerId);
        const mv = (ev) => { pos.x = ev.clientX - x0; pos.y = ev.clientY - y0; dlg.style.transform = `translate(${pos.x}px, ${pos.y}px)`; };
        const up = () => { head.removeEventListener('pointermove', mv); head.removeEventListener('pointerup', up); floating.pos = pos; };
        head.addEventListener('pointermove', mv);
        head.addEventListener('pointerup', up);
      });
      if (opts.onOpen) opts.onOpen(dlg, close);
    },
  });
}

/** Mix a processed copy into the layer only where the selection is. */
function mixSelection(A, L, src, result) {
  if (!A.sel) return result;
  const out = cloneCanvas(src);
  const o = out.getContext('2d');
  const t = makeCanvas(src.width, src.height);
  const tctx = t.getContext('2d');
  tctx.drawImage(result, 0, 0);
  tctx.globalCompositeOperation = 'destination-in';
  tctx.drawImage(A.sel.canvas, -L.x, -L.y);
  o.globalCompositeOperation = 'destination-out';
  o.drawImage(A.sel.canvas, -L.x, -L.y);
  o.globalCompositeOperation = 'source-over';
  o.drawImage(t, 0, 0);
  return out;
}

/**
 * Live preview of a change to a layer. Big layers preview on a smaller copy
 * while settings move, then at full size once they settle.
 */
function previewer(A, L, compute, status = null) {
  const src = L.canvas;
  const area = src.width * src.height;
  const big = area > 3e6;
  const scale = big ? Math.sqrt(1.5e6 / area) : 1;
  const small = big ? resized(src, Math.max(1, Math.round(src.width * scale)), Math.max(1, Math.round(src.height * scale))) : null;
  let gen = 0;
  let timer = 0;
  let frame = 0;
  const show = (result) => A.setPreview({ id: L.id, canvas: mixSelection(A, L, src, result) });
  return {
    run() {
      const g = ++gen;
      cancelAnimationFrame(frame);
      clearTimeout(timer);
      frame = requestAnimationFrame(() => {
        if (g !== gen) return;
        if (big) {
          const r = compute(small, scale);
          const up = makeCanvas(src.width, src.height);
          const uctx = up.getContext('2d');
          uctx.imageSmoothingQuality = 'high';
          uctx.drawImage(r, 0, 0, src.width, src.height);
          show(up);
        }
        timer = setTimeout(() => {
          if (g !== gen) return;
          if (status) status.textContent = 'Working…';
          setTimeout(() => {
            if (g !== gen) return;
            show(compute(src, 1));
            if (status) status.textContent = '';
          }, 16);
        }, big ? 380 : 0);
      });
    },
    stop() { gen++; cancelAnimationFrame(frame); clearTimeout(timer); A.setPreview(null); },
  };
}

function pixelTarget(A) {
  const L = A.active();
  if (!L) { toast('There is no layer to change.', { type: 'warn' }); return null; }
  if (L.locked) { toast(`“${L.name}” is locked.`, { type: 'warn' }); return null; }
  if (L.kind === 'text') { toast('Rasterise the text layer first (Layer > Rasterise).', { type: 'warn', action: { label: 'Rasterise', run: () => A.rasterize(L) } }); return null; }
  if (L.kind === 'adjust') { toast('Pick a picture layer.', { type: 'warn' }); return null; }
  if (L.editMask && L.mask) { L.editMask = false; A.buildOptions(); }
  return L;
}

// ---------------------------------------------------------------------------
// Histograms
// ---------------------------------------------------------------------------
export function histogramOf(canvas) {
  const s = Math.min(1, 512 / Math.max(canvas.width, canvas.height));
  const c = makeCanvas(Math.max(1, Math.round(canvas.width * s)), Math.max(1, Math.round(canvas.height * s)));
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(canvas, 0, 0, c.width, c.height);
  return histogram(ctx.getImageData(0, 0, c.width, c.height));
}

export function drawHistogram(ctx, W, H, hist, channel = 'all') {
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = 'rgba(128,128,128,.08)';
  ctx.fillRect(0, 0, W, H);
  const peak = (a) => { const s = [...a].sort((x, y) => y - x); return Math.max(1, s[2] || s[0] || 1); };
  const plot = (a, color, fill) => {
    const m = peak(a);
    ctx.beginPath();
    ctx.moveTo(0, H);
    for (let i = 0; i < 256; i++) ctx.lineTo((i / 255) * W, H - Math.min(1, Math.sqrt(a[i] / m)) * (H - 4));
    ctx.lineTo(W, H);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    if (color) { ctx.strokeStyle = color; ctx.lineWidth = 1; ctx.stroke(); }
  };
  if (channel === 'all' || channel === 'rgb') {
    plot(hist.l, null, 'rgba(160,170,165,.55)');
    if (channel === 'all') {
      ctx.globalCompositeOperation = 'screen';
      plot(hist.r, 'rgba(229,83,75,.9)', 'rgba(229,83,75,.18)');
      plot(hist.g, 'rgba(63,185,80,.9)', 'rgba(63,185,80,.18)');
      plot(hist.b, 'rgba(47,129,247,.9)', 'rgba(47,129,247,.18)');
      ctx.globalCompositeOperation = 'source-over';
    }
  } else plot(hist[channel], { r: '#e5534b', g: '#3fb950', b: '#2f81f7' }[channel], { r: 'rgba(229,83,75,.4)', g: 'rgba(63,185,80,.4)', b: 'rgba(47,129,247,.4)' }[channel]);
}

// ---------------------------------------------------------------------------
// Adjustments
// ---------------------------------------------------------------------------
export async function adjustDialog(A, kind, { layer = null } = {}) {
  const def = ADJUSTMENTS[kind];
  const editing = layer && layer.kind === 'adjust';
  const L = editing ? layer : pixelTarget(A);
  if (!L) return;
  const params = editing ? JSON.parse(JSON.stringify(layer.adjust.params)) : defaultParams(kind);
  let asLayer = !editing && A.settings.get('adjAsLayer', false);
  let temp = null; // a stand-in adjustment layer while "as a layer" is on
  const status = h('span.muted');
  const pv = editing ? null : previewer(A, L, (c) => A.adjusted(c, kind, params), status);
  const doc = A.doc;
  const update = () => {
    if (editing) { A.setPreview({ id: layer.id, adjust: { kind, params } }); return; }
    if (asLayer) {
      if (pv) pv.stop();
      if (!temp) {
        temp = newLayer({ name: def.label, kind: 'adjust', adjust: { kind, params } });
        doc.layers.splice(doc.layers.indexOf(L) + 1, 0, temp);
      }
      temp.adjust = { kind, params: JSON.parse(JSON.stringify(params)) };
      doc.touch();
      A.render();
    } else {
      removeTemp();
      pv.run();
    }
  };
  const removeTemp = () => {
    if (!temp) return;
    doc.layers = doc.layers.filter((x) => x !== temp);
    temp = null;
    doc.touch();
    A.render();
  };
  let body;
  if (kind === 'levels') body = levelsBody(A, L, params, update);
  else if (kind === 'curves') body = curvesBody(A, L, params, update);
  else body = h('div.col', ...controls(def.params, params, update));
  const reset = h('button.btn.small', 'Reset');
  reset.addEventListener('click', () => { Object.assign(params, defaultParams(kind)); body.replaceWith(body = kind === 'levels' ? levelsBody(A, L, params, update) : kind === 'curves' ? curvesBody(A, L, params, update) : h('div.col', ...controls(def.params, params, update))); update(); });
  const layerBox = editing ? null : h('input', { type: 'checkbox', checked: asLayer });
  if (layerBox) layerBox.addEventListener('change', () => { asLayer = layerBox.checked; A.settings.set('adjAsLayer', asLayer); update(); });
  const wrap = h('div.col.ph-dlg', body, h('div.row', reset, h('span.grow'), status),
    layerBox ? h('label.check', { 'data-tip': 'Keeps the original pixels: change or remove the adjustment any time' }, layerBox, 'As an adjustment layer (editable later)') : null);
  A.previewing = true;
  update();
  const ok = await floating({ title: editing ? `${def.label} (adjustment layer)` : def.label, body: h('div', wrap), width: 380,
    buttons: [{ label: 'Cancel', value: false }, { label: 'OK', value: true, primary: true }] });
  A.previewing = false;
  if (pv) pv.stop();
  removeTemp();
  A.setPreview(null);
  if (!ok) return;
  if (editing) A.setLayerProps(layer, { adjust: { kind, params } }, `Edit ${def.label.toLowerCase()}`);
  else if (asLayer) A.addAdjustmentLayer(kind, params);
  else {
    const b = busy(`${def.label}…`);
    try { A.processLayer(def.label, (src) => A.adjusted(src, kind, params), L); } finally { b.close(); }
  }
}

function levelsBody(A, L, p, update) {
  const W = 300;
  const H = 110;
  const hist = histogramOf(L.kind === 'adjust' ? A.composite() : L.canvas);
  const cv = h('canvas', { width: W * 2, height: H * 2, style: { width: `${W}px`, height: `${H}px`, borderRadius: '6px' } });
  const draw = () => {
    const ctx = cv.getContext('2d');
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    drawHistogram(ctx, W, H, hist, p.channel === 'rgb' ? 'rgb' : p.channel);
    // Where black, middle grey and white now sit.
    const xb = (p.black / 255) * W;
    const xw = (p.white / 255) * W;
    const xm = xb + (xw - xb) * Math.pow(0.5, p.gamma);
    for (const [x, c] of [[xb, '#000'], [xm, '#888'], [xw, '#fff']]) {
      ctx.fillStyle = c;
      ctx.strokeStyle = '#3fb950';
      ctx.beginPath(); ctx.moveTo(x, H - 10); ctx.lineTo(x - 6, H); ctx.lineTo(x + 6, H); ctx.closePath(); ctx.fill(); ctx.stroke();
    }
  };
  const ch = select({ options: [{ value: 'rgb', label: 'All colours' }, { value: 'r', label: 'Red' }, { value: 'g', label: 'Green' }, { value: 'b', label: 'Blue' }], value: p.channel, onChange: (v) => { p.channel = v; draw(); update(); } });
  const sB = paramSlider('Shadows', p.black, 0, 253, 1, (v) => { p.black = Math.min(v, p.white - 2); draw(); update(); });
  const sG = paramSlider('Midtones', p.gamma, 0.1, 5, 0.01, (v) => { p.gamma = v; draw(); update(); });
  const sW = paramSlider('Highlights', p.white, 2, 255, 1, (v) => { p.white = Math.max(v, p.black + 2); draw(); update(); });
  const oB = paramSlider('Output dark', p.outBlack, 0, 255, 1, (v) => { p.outBlack = v; update(); });
  const oW = paramSlider('Output light', p.outWhite, 0, 255, 1, (v) => { p.outWhite = v; update(); });
  const auto = h('button.btn.small', 'Auto');
  auto.addEventListener('click', () => {
    const c = L.canvas;
    const id = c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);
    const a = autoParams(id, 'contrast').levels;
    Object.assign(p, a, { channel: 'rgb' });
    sB.set(p.black); sW.set(p.white); sG.set(p.gamma); ch.value = 'rgb';
    draw(); update();
  });
  draw();
  return h('div.col', h('div.row', ch, h('span.grow'), auto), cv, sB, sG, sW, oB, oW);
}

const CURVE_PRESETS = {
  contrast: [[0, 0], [64, 48], [192, 208], [255, 255]], strong: [[0, 0], [64, 36], [192, 220], [255, 255]], lighter: [[0, 0], [128, 160], [255, 255]],
  darker: [[0, 0], [128, 96], [255, 255]], fade: [[0, 32], [128, 132], [255, 236]], negative: [[0, 255], [255, 0]],
};

function curvesBody(A, L, p, update) {
  const S = 256;
  const cv = h('canvas.ph-curve', { width: S * 2, height: S * 2, style: { width: `${S}px`, height: `${S}px` } });
  let ch = 'rgb';
  const hist = histogramOf(L.kind === 'adjust' ? A.composite() : L.canvas);
  const readout = h('span.muted', '');
  const draw = () => {
    const ctx = cv.getContext('2d');
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    drawHistogram(ctx, S, S, hist, ch);
    ctx.strokeStyle = 'rgba(128,128,128,.35)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let i = 1; i < 4; i++) { ctx.moveTo((i * S) / 4, 0); ctx.lineTo((i * S) / 4, S); ctx.moveTo(0, (i * S) / 4); ctx.lineTo(S, (i * S) / 4); }
    ctx.moveTo(0, S); ctx.lineTo(S, 0);
    ctx.stroke();
    const t = curveLut(p[ch]);
    ctx.strokeStyle = { rgb: '#e7ebe8', r: '#e5534b', g: '#3fb950', b: '#2f81f7' }[ch];
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let x = 0; x < 256; x++) { const y = S - (t[x] / 255) * S; if (x) ctx.lineTo((x / 255) * S, y); else ctx.moveTo(0, y); }
    ctx.stroke();
    for (const [x, y] of p[ch]) {
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = '#000';
      ctx.beginPath(); ctx.arc((x / 255) * S, S - (y / 255) * S, 4.5, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
    }
  };
  const at = (e) => {
    const r = cv.getBoundingClientRect();
    return [clamp(Math.round(((e.clientX - r.left) / r.width) * 255), 0, 255), clamp(Math.round((1 - (e.clientY - r.top) / r.height) * 255), 0, 255), e.clientY - r.top, r.height];
  };
  cv.addEventListener('pointerdown', (e) => {
    const [x, y] = at(e);
    const pts = p[ch];
    let i = pts.findIndex(([px, py]) => Math.abs(px - x) < 8 && Math.abs(py - y) < 12);
    if (i < 0) { pts.push([x, y]); pts.sort((a, b) => a[0] - b[0]); i = pts.findIndex((q) => q[0] === x && q[1] === y); }
    const pt = pts[i];
    cv.setPointerCapture(e.pointerId);
    const mv = (ev) => {
      const [nx, ny, rawY, hgt] = at(ev);
      // Dragging a middle point far off the box removes it.
      const out = rawY < -30 || rawY > hgt + 30;
      const idx = pts.indexOf(pt);
      if (out && idx > 0 && idx < pts.length - 1) { pts.splice(idx, 1); draw(); update(); return; }
      if (idx < 0) return;
      const lo = idx > 0 ? pts[idx - 1][0] + 1 : 0;
      const hi = idx < pts.length - 1 ? pts[idx + 1][0] - 1 : 255;
      pt[0] = clamp(nx, lo, hi);
      pt[1] = ny;
      readout.textContent = `In ${pt[0]} → Out ${pt[1]}`;
      draw();
      update();
    };
    const up = () => { cv.removeEventListener('pointermove', mv); cv.removeEventListener('pointerup', up); };
    cv.addEventListener('pointermove', mv);
    cv.addEventListener('pointerup', up);
    draw();
    update();
  });
  cv.addEventListener('dblclick', (e) => {
    const [x, y] = at(e);
    const pts = p[ch];
    const i = pts.findIndex(([px, py]) => Math.abs(px - x) < 8 && Math.abs(py - y) < 12);
    if (i > 0 && i < pts.length - 1) { pts.splice(i, 1); draw(); update(); }
  });
  cv.addEventListener('pointermove', (e) => { const [x] = at(e); readout.textContent = `In ${x} → Out ${curveLut(p[ch])[x]}`; });
  const chSel = select({ options: [{ value: 'rgb', label: 'All colours' }, { value: 'r', label: 'Red' }, { value: 'g', label: 'Green' }, { value: 'b', label: 'Blue' }], value: ch, onChange: (v) => { ch = v; draw(); } });
  const preset = select({ options: [{ value: '', label: 'Presets…' }, { value: 'contrast', label: 'More contrast' }, { value: 'strong', label: 'Strong contrast' }, { value: 'lighter', label: 'Lighter' }, { value: 'darker', label: 'Darker' }, { value: 'fade', label: 'Faded film' }, { value: 'negative', label: 'Negative' }],
    value: '', onChange: (v) => { if (!v) return; p[ch] = CURVE_PRESETS[v].map((q) => q.slice()); preset.value = ''; draw(); update(); } });
  draw();
  return h('div.col', h('div.row', chSel, preset, h('span.grow'), readout), cv, h('div.muted', { style: { fontSize: '12px' } }, 'Click to add a point, drag to bend; drag a point off the box or double-click it to remove it.'));
}

// ---------------------------------------------------------------------------
// Filters
// ---------------------------------------------------------------------------
let last = null;
export const lastFilter = () => last;

const scaled = (key, params, s) => {
  if (s === 1) return params;
  const out = { ...params };
  for (const d of FILTERS[key].params) if (d.px) out[d.key] = Math.max(d.key === 'radius' && key === 'oil' ? 1 : 0.3, params[d.key] * s);
  return out;
};

export async function filterDialog(A, key) {
  const f = FILTERS[key];
  const L = pixelTarget(A);
  if (!L) return;
  const params = last && last.key === key ? { ...last.params } : Object.fromEntries(f.params.map((p) => [p.key, p.value]));
  if (!f.params.length) { apply(A, L, key, params); return; }
  const status = h('span.muted');
  const pv = previewer(A, L, (c, s) => f.run(c, scaled(key, params, s)), status);
  let on = true;
  const update = () => { if (on) pv.run(); };
  const pvBox = h('input', { type: 'checkbox', checked: true });
  pvBox.addEventListener('change', () => { on = pvBox.checked; if (on) pv.run(); else pv.stop(); });
  A.previewing = true;
  update();
  const ok = await floating({ title: f.label, width: 380, body: h('div.col.ph-dlg', ...controls(f.params, params, update), h('div.row', h('label.check', pvBox, 'Preview'), h('span.grow'), status)),
    buttons: [{ label: 'Cancel', value: false }, { label: 'OK', value: true, primary: true }] });
  A.previewing = false;
  pv.stop();
  if (ok) apply(A, L, key, params);
}

function apply(A, L, key, params) {
  const f = FILTERS[key];
  last = { key, params: { ...params } };
  const b = busy(`${f.label}…`);
  setTimeout(() => {
    try { A.processLayer(f.label, (src) => f.run(src, params), L); } catch (err) { toast(String(err.message || err), { type: 'error' }); } finally { b.close(); }
  }, 20);
}

export function repeatFilter(A) {
  if (!last) return;
  const L = pixelTarget(A);
  if (L) apply(A, L, last.key, last.params);
}

// ---------------------------------------------------------------------------
// Layer effects
// ---------------------------------------------------------------------------
const FX_DEFAULTS = {
  shadow: { on: false, color: '#000000', opacity: 0.6, angle: 135, distance: 12, blur: 16 },
  glow: { on: false, color: '#ffd75e', opacity: 0.8, size: 20 },
  stroke: { on: false, color: '#000000', size: 4, opacity: 1 },
  overlay: { on: false, color: '#e5534b', opacity: 0.5 },
};

export async function effectsDialog(A, L) {
  if (!L || L.kind === 'adjust') return;
  const original = L.effects;
  const fx = {};
  for (const [k, v] of Object.entries(FX_DEFAULTS)) fx[k] = { ...v, ...((original && original[k]) || {}) };
  const live = () => { L.effects = JSON.parse(JSON.stringify(fx)); A.doc.touch(L); A.render(); };
  const section = (key, title, rows) => {
    const on = h('input', { type: 'checkbox', checked: fx[key].on });
    const box = h('div.col.ph-fxbody', ...rows);
    box.classList.toggle('off', !fx[key].on);
    on.addEventListener('change', () => { fx[key].on = on.checked; box.classList.toggle('off', !on.checked); live(); });
    return h('div.ph-fx', h('label.check.ph-fxhead', on, h('b', title)), box);
  };
  const num = (key, k, label, min, max, step = 1, mul = 1) => paramSlider(label, Math.round(fx[key][k] * mul * 100) / 100, min, max, step, (v) => { fx[key][k] = v / mul; fx[key].on = true; live(); });
  const col = (key) => h('label.field', h('span', 'Colour'), colorField(fx[key].color, (v) => { fx[key].color = v; fx[key].on = true; live(); }));
  const body = h('div.col.ph-dlg',
    section('shadow', 'Drop shadow', [col('shadow'), num('shadow', 'opacity', 'Opacity %', 0, 100, 1, 100), num('shadow', 'angle', 'Angle °', -180, 180), num('shadow', 'distance', 'Distance', 0, 300), num('shadow', 'blur', 'Softness', 0, 150)]),
    section('glow', 'Outer glow', [col('glow'), num('glow', 'opacity', 'Opacity %', 0, 100, 1, 100), num('glow', 'size', 'Size', 1, 200)]),
    section('stroke', 'Outline', [col('stroke'), num('stroke', 'size', 'Width', 1, 100), num('stroke', 'opacity', 'Opacity %', 0, 100, 1, 100)]),
    section('overlay', 'Colour overlay', [col('overlay'), num('overlay', 'opacity', 'Opacity %', 0, 100, 1, 100)]));
  A.previewing = true;
  live();
  const ok = await floating({ title: `Effects: ${L.name}`, width: 380, body, buttons: [{ label: 'Cancel', value: false }, { label: 'OK', value: true, primary: true }] });
  A.previewing = false;
  L.effects = original;
  A.doc.touch(L);
  if (ok) {
    const any = Object.values(fx).some((x) => x.on);
    A.setLayerProps(L, { effects: any ? JSON.parse(JSON.stringify(fx)) : null }, 'Layer effects');
  } else A.render();
}

// ---------------------------------------------------------------------------
// Sizes and new pictures
// ---------------------------------------------------------------------------
const numInput = (value, min = 1, max = 16384) => h('input.input.num', { type: 'number', value: String(value), min, max, style: { width: '90px' } });

export async function imageSizeDialog(A) {
  const doc = A.doc;
  const w = numInput(doc.width);
  const hh = numInput(doc.height);
  const pct = h('input.input.num', { type: 'number', value: '100', min: 1, max: 1000, style: { width: '70px' } });
  const keep = h('input', { type: 'checkbox', checked: true });
  const smooth = select({ options: [{ value: 'smooth', label: 'Smooth (photos)' }, { value: 'pixel', label: 'Hard pixels (pixel art)' }], value: 'smooth', onChange: () => {} });
  const info = h('div.muted');
  const show = () => { info.textContent = `${Number(w.value) * Number(hh.value) / 1e6 >= 1 ? `${(Number(w.value) * Number(hh.value) / 1e6).toFixed(1)} megapixels` : `${Number(w.value) * Number(hh.value)} pixels`}`; };
  w.addEventListener('input', () => { if (keep.checked) hh.value = String(Math.max(1, Math.round((Number(w.value) * doc.height) / doc.width))); pct.value = String(Math.round((Number(w.value) / doc.width) * 100)); show(); });
  hh.addEventListener('input', () => { if (keep.checked) w.value = String(Math.max(1, Math.round((Number(hh.value) * doc.width) / doc.height))); pct.value = String(Math.round((Number(hh.value) / doc.height) * 100)); show(); });
  pct.addEventListener('input', () => { const k = Number(pct.value) / 100; w.value = String(Math.max(1, Math.round(doc.width * k))); hh.value = String(Math.max(1, Math.round(doc.height * k))); show(); });
  show();
  const ok = await modal({ title: 'Image size', width: 380, body: h('div.col', h('label.field', h('span', 'Width'), h('span.row', w, h('span.muted', 'px'))), h('label.field', h('span', 'Height'), h('span.row', hh, h('span.muted', 'px'))),
    h('label.field', h('span', 'Scale'), h('span.row', pct, h('span.muted', '%'))), h('label.check', keep, 'Keep the proportions'), h('label.field', h('span', 'Resampling'), smooth), info),
  buttons: [{ label: 'Cancel', value: false }, { label: 'Resize', value: true, primary: true }] });
  if (!ok) return;
  const nw = clamp(Math.round(Number(w.value)) || doc.width, 1, 16384);
  const nh = clamp(Math.round(Number(hh.value)) || doc.height, 1, 16384);
  if (nw === doc.width && nh === doc.height) return;
  const b = busy('Resizing…');
  setTimeout(() => { try { A.resizeImage(nw, nh, smooth.value === 'smooth'); } finally { b.close(); } }, 20);
}

export async function canvasSizeDialog(A) {
  const doc = A.doc;
  const w = numInput(doc.width);
  const hh = numInput(doc.height);
  let anchor = 'c';
  const grid = h('div.anchor-grid', ...['nw', 'n', 'ne', 'w', 'c', 'e', 'sw', 's', 'se'].map((a) => {
    const b = h(`button${a === anchor ? '.on' : ''}`, { 'data-tip': 'Keep the picture here' });
    b.addEventListener('click', () => { anchor = a; for (const x of grid.children) x.classList.toggle('on', x === b); });
    return b;
  }));
  const fill = select({ options: [{ value: '', label: 'See-through' }, { value: 'white', label: 'White' }, { value: 'black', label: 'Black' }, { value: 'bg', label: 'Background colour' }], value: '', onChange: () => {} });
  const ok = await modal({ title: 'Canvas size', width: 360, body: h('div.col', h('label.field', h('span', 'Width'), w), h('label.field', h('span', 'Height'), hh), h('div.field', h('span', 'Anchor'), grid), h('label.field', h('span', 'New space'), fill)),
    buttons: [{ label: 'Cancel', value: false }, { label: 'Apply', value: true, primary: true }] });
  if (!ok) return;
  const nw = clamp(Math.round(Number(w.value)) || doc.width, 1, 16384);
  const nh = clamp(Math.round(Number(hh.value)) || doc.height, 1, 16384);
  const color = fill.value === 'white' ? '#ffffff' : fill.value === 'black' ? '#000000' : fill.value === 'bg' ? A.st.bg : null;
  A.canvasSize(nw, nh, anchor, color);
}

export async function newDialog(A, presets) {
  const name = h('input.input', { value: 'Untitled', style: { width: '100%' } });
  const w = numInput(A.settings.get('newW', 1920));
  const hh = numInput(A.settings.get('newH', 1080));
  const preset = select({ options: [{ value: '', label: 'Size presets…' }, ...presets.map((p, i) => ({ value: String(i), label: p.name }))], value: '',
    onChange: (v) => { if (v === '') return; w.value = String(presets[Number(v)].w); hh.value = String(presets[Number(v)].h); } });
  const swap = h('button.tb', { 'data-tip': 'Swap width and height', html: icon('repeat', 14) });
  swap.addEventListener('click', () => { const t = w.value; w.value = hh.value; hh.value = t; });
  const bg = select({ options: [{ value: '#ffffff', label: 'White' }, { value: '#000000', label: 'Black' }, { value: 'transparent', label: 'See-through' }, { value: 'bg', label: 'Background colour' }, { value: 'fg', label: 'Foreground colour' }],
    value: A.settings.get('newBg', '#ffffff'), onChange: (v) => A.settings.set('newBg', v) });
  const ok = await modal({ title: 'New picture', width: 380, body: h('div.col', h('label.field', h('span', 'Name'), name), preset,
    h('label.field', h('span', 'Width'), h('span.row', w, h('span.muted', 'px'), swap)), h('label.field', h('span', 'Height'), h('span.row', hh, h('span.muted', 'px'))), h('label.field', h('span', 'Background'), bg)),
  buttons: [{ label: 'Cancel', value: false }, { label: 'Create', value: true, primary: true }] });
  if (!ok) return null;
  const W = clamp(Math.round(Number(w.value)) || 1920, 1, 16384);
  const H = clamp(Math.round(Number(hh.value)) || 1080, 1, 16384);
  A.settings.set('newW', W);
  A.settings.set('newH', H);
  const background = bg.value === 'bg' ? A.st.bg : bg.value === 'fg' ? A.st.fg : bg.value;
  return { w: W, h: H, background, name: name.value.trim() || 'Untitled' };
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------
const MIME = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp', bmp: 'image/bmp' };

export async function exportDialog(A, { flat, name }) {
  const doc = A.doc;
  const fmt = select({ options: [{ value: 'png', label: 'PNG (sharp, see-through)' }, { value: 'jpg', label: 'JPEG (photos, smallest)' }, { value: 'webp', label: 'WebP (web, see-through)' }, { value: 'bmp', label: 'BMP (uncompressed)' }],
    value: A.settings.get('exportFormat', 'jpg'), onChange: () => { A.settings.set('exportFormat', fmt.value); qRow.classList.toggle('hidden', !['jpg', 'webp'].includes(fmt.value)); estimate(); } });
  let quality = A.settings.get('exportQuality', 85);
  const qRow = paramSlider('Quality', quality, 10, 100, 1, (v) => { quality = v; A.settings.set('exportQuality', v); estimate(); });
  qRow.classList.toggle('hidden', !['jpg', 'webp'].includes(fmt.value));
  let scale = 100;
  const sRow = paramSlider('Size %', scale, 5, 200, 1, (v) => { scale = v; estimate(); });
  const preview = h('img.ph-export-img', { alt: '' });
  const info = h('div.muted');
  const nameIn = h('input.input', { value: name, style: { width: '100%' } });
  let bytes = null;
  let gen = 0;
  let timer = 0;
  let prevUrl = null;
  const build = async () => {
    const f = fmt.value;
    const base = flat(f);
    const w = Math.max(1, Math.round((doc.width * scale) / 100));
    const hh = Math.max(1, Math.round((doc.height * scale) / 100));
    const c = w === doc.width && hh === doc.height ? base : resized(base, w, hh, true);
    return { data: await canvasBytes(c, MIME[f], quality / 100), w, h: hh };
  };
  const estimate = () => {
    clearTimeout(timer);
    info.textContent = 'Working out the size…';
    const g = ++gen;
    timer = setTimeout(async () => {
      const r = await build();
      if (g !== gen) return;
      bytes = r.data;
      info.textContent = `${r.w} × ${r.h} px · ${fmtBytes(bytes.length)}`;
      if (prevUrl) URL.revokeObjectURL(prevUrl);
      prevUrl = URL.createObjectURL(new Blob([bytes], { type: MIME[fmt.value] }));
      preview.src = prevUrl;
    }, 250);
  };
  estimate();
  const ok = await modal({ title: 'Export', width: 460, body: h('div.col', h('div.ph-export-box', preview), info, h('label.field', h('span', 'Format'), fmt), qRow, sRow, h('label.field', h('span', 'Name'), nameIn)),
    buttons: [{ label: 'Cancel', value: false }, { label: 'Export…', value: true, primary: true }] });
  clearTimeout(timer);
  gen++;
  if (prevUrl) URL.revokeObjectURL(prevUrl);
  if (!ok) return null;
  const r = await build();
  const ext = fmt.value;
  const base = (nameIn.value.trim() || name).replace(/\.[a-z0-9]+$/i, '');
  return { format: ext, bytes: r.data, name: `${base}.${ext}` };
}

// ---------------------------------------------------------------------------
// Small prompts
// ---------------------------------------------------------------------------
export async function numberPrompt(title, label, value, min, max) {
  const input = h('input.input.num', { type: 'number', value: String(value), min, max, style: { width: '100px' } });
  const ok = await modal({ title, width: 320, body: h('label.field', h('span', label), input), buttons: [{ label: 'Cancel', value: false }, { label: 'OK', value: true, primary: true }] });
  if (!ok) return null;
  const v = Number(input.value);
  return Number.isFinite(v) ? clamp(v, min, max) : null;
}

export async function fillDialog(A) {
  let custom = A.st.fg;
  const what = select({ options: [{ value: 'fg', label: 'Foreground colour' }, { value: 'bg', label: 'Background colour' }, { value: 'black', label: 'Black' }, { value: 'white', label: 'White' }, { value: 'gray', label: '50% grey' }, { value: 'custom', label: 'Another colour' }],
    value: 'fg', onChange: (v) => customRow.classList.toggle('hidden', v !== 'custom') });
  const customRow = h('label.field.hidden', h('span', 'Colour'), colorField(custom, (v) => { custom = v; }));
  let opacity = 100;
  const op = paramSlider('Opacity %', 100, 1, 100, 1, (v) => { opacity = v; });
  const ok = await modal({ title: A.sel ? 'Fill the selection' : 'Fill the layer', width: 360, body: h('div.col', h('label.field', h('span', 'With'), what), customRow, op),
    buttons: [{ label: 'Cancel', value: false }, { label: 'Fill', value: true, primary: true }] });
  if (!ok) return null;
  const color = { fg: A.st.fg, bg: A.st.bg, black: '#000000', white: '#ffffff', gray: '#808080', custom }[what.value];
  return { color, opacity: opacity / 100 };
}

export async function strokeDialog(A) {
  let color = A.st.fg;
  let width = 4;
  const pos = select({ options: [{ value: 'inside', label: 'Inside the edge' }, { value: 'center', label: 'On the edge' }, { value: 'outside', label: 'Outside the edge' }], value: 'center', onChange: () => {} });
  const ok = await modal({ title: 'Outline the selection', width: 360, body: h('div.col', paramSlider('Width', 4, 1, 200, 1, (v) => { width = v; }),
    h('label.field', h('span', 'Colour'), colorField(color, (v) => { color = v; })), h('label.field', h('span', 'Position'), pos)),
  buttons: [{ label: 'Cancel', value: false }, { label: 'Outline', value: true, primary: true }] });
  return ok ? { width, color, position: pos.value } : null;
}

export async function refineSelection(A) {
  const orig = A.sel;
  if (!orig) return null;
  const r = { grow: 0, feather: 0, invert: false };
  let timer = 0;
  const show = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      let s = orig;
      if (r.grow) s = s.grow(r.grow);
      if (r.feather) s = s.feather(r.feather);
      if (r.invert) s = s.invert();
      A.previewSelection(s);
    }, 120);
  };
  const inv = h('input', { type: 'checkbox' });
  inv.addEventListener('change', () => { r.invert = inv.checked; show(); });
  A.previewing = true;
  const ok = await floating({ title: 'Refine edge', width: 360, body: h('div.col.ph-dlg',
    paramSlider('Expand / contract', 0, -100, 100, 1, (v) => { r.grow = v; show(); }),
    paramSlider('Feather', 0, 0, 150, 1, (v) => { r.feather = v; show(); }),
    h('label.check', inv, 'Invert'), h('div.muted', { style: { fontSize: '12px' } }, 'Tip: feathering softens the edges of whatever you change next.')),
  buttons: [{ label: 'Cancel', value: false }, { label: 'OK', value: true, primary: true }] });
  clearTimeout(timer);
  A.previewing = false;
  A.previewSelection(orig);
  return ok ? r : null;
}

export async function colorRangeDialog(A) {
  const src = A.composite();
  // Work on a smaller copy for the preview.
  const s = Math.min(1, 220 / Math.max(src.width, src.height));
  const small = makeCanvas(Math.max(1, Math.round(src.width * s)), Math.max(1, Math.round(src.height * s)));
  small.getContext('2d').drawImage(src, 0, 0, small.width, small.height);
  let target = A.st.fg;
  let fuzz = 40;
  let mode = 'replace';
  const prev = h('canvas.ph-range', { width: small.width, height: small.height });
  const swatch = colorField(target, (v) => { target = v; draw(); });
  const alphaOf = (data) => {
    const [tr, tg, tb] = [parseInt(target.slice(1, 3), 16), parseInt(target.slice(3, 5), 16), parseInt(target.slice(5, 7), 16)];
    const a = new Uint8ClampedArray(data.length / 4);
    const f = Math.max(1, fuzz * 2.2);
    for (let p = 0, i = 0; p < a.length; p++, i += 4) {
      const d = Math.hypot(data[i] - tr, data[i + 1] - tg, data[i + 2] - tb);
      a[p] = data[i + 3] < 8 ? 0 : clamp(Math.round((1 - d / f) * 2 * 255), 0, 255);
    }
    return a;
  };
  const draw = () => {
    const ctx = prev.getContext('2d', { willReadFrequently: true });
    const d = small.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, small.width, small.height);
    const a = alphaOf(d.data);
    const out = ctx.createImageData(small.width, small.height);
    for (let p = 0; p < a.length; p++) { out.data[p * 4] = out.data[p * 4 + 1] = out.data[p * 4 + 2] = a[p]; out.data[p * 4 + 3] = 255; }
    ctx.putImageData(out, 0, 0);
  };
  const pick = h('button.btn.small', { html: `${icon('pipette', 14)} Pick from the picture` });
  pick.addEventListener('click', () => {
    pick.classList.add('on');
    A.pickOnce((p) => {
      const x = clamp(Math.floor(p.x), 0, src.width - 1);
      const y = clamp(Math.floor(p.y), 0, src.height - 1);
      const d = src.getContext('2d', { willReadFrequently: true }).getImageData(x, y, 1, 1).data;
      target = toHex({ r: d[0], g: d[1], b: d[2] });
      swatch.style.background = target;
      pick.classList.remove('on');
      A.pickOnce(null);
      draw();
    });
  });
  const modeSel = select({ options: [{ value: 'replace', label: 'New selection' }, { value: 'add', label: 'Add to the selection' }, { value: 'subtract', label: 'Take away from it' }], value: mode, onChange: (v) => { mode = v; } });
  draw();
  A.previewing = true;
  const ok = await floating({ title: 'Select a colour range', width: 380, body: h('div.col.ph-dlg', h('div.row', swatch, pick), paramSlider('Fuzziness', fuzz, 0, 200, 1, (v) => { fuzz = v; draw(); }),
    h('div.ph-range-box', prev), h('label.field', h('span', 'Selection'), modeSel)),
  buttons: [{ label: 'Cancel', value: false }, { label: 'OK', value: true, primary: true }] });
  A.previewing = false;
  A.pickOnce(null);
  if (!ok) return;
  const full = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, src.width, src.height).data;
  const a = alphaOf(full);
  A.setSelection((A.sel || A.emptySel()).fromAlpha(a, mode), 'Colour range');
}

export async function prefsDialog(A) {
  const s = A.settings;
  const box = (key, label, def, tip = '') => {
    const c = h('input', { type: 'checkbox', checked: s.get(key, def) });
    c.addEventListener('change', () => s.set(key, c.checked));
    return h('label.check', { 'data-tip': tip }, c, label);
  };
  await modal({ title: 'Pen and brush settings', width: 400, body: h('div.col',
    h('b', 'Pen tablets'),
    box('pressureSize', 'Pressure changes the brush size', true),
    box('pressureOpacity', 'Pressure changes the opacity', false),
    h('b', 'Saving'),
    paramSlider('JPEG / WebP quality', Math.round(s.get('quality', 0.92) * 100), 30, 100, 1, (v) => s.set('quality', v / 100)),
    h('b', 'Background removal'),
    paramSlider('How different the subject is', s.get('bgTolerance', 40), 5, 120, 1, (v) => s.set('bgTolerance', v))),
  buttons: [{ label: 'Done', value: true, primary: true }] });
}
