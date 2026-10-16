// The picture in Snake's Photo: a stack of layers and how they combine.
// Pixel layers hold a canvas at an offset (they may reach past the edges);
// text layers draw themselves from their settings; adjustment layers change
// everything below them. Masks and effects are applied while combining.
import { makeCanvas } from '../../kit/raster.js';
import { applyAdjustment, cssFilterFor } from './adjust.js';

export const BLENDS = [
  ['normal', 'Normal', 'source-over'], ['multiply', 'Multiply', 'multiply'], ['screen', 'Screen', 'screen'],
  ['overlay', 'Overlay', 'overlay'], ['soft-light', 'Soft light', 'soft-light'], ['hard-light', 'Hard light', 'hard-light'],
  ['darken', 'Darken', 'darken'], ['lighten', 'Lighten', 'lighten'], ['color-dodge', 'Colour dodge', 'color-dodge'],
  ['color-burn', 'Colour burn', 'color-burn'], ['add', 'Add (linear dodge)', 'lighter'], ['difference', 'Difference', 'difference'],
  ['exclusion', 'Exclusion', 'exclusion'], ['hue', 'Hue', 'hue'], ['saturation', 'Saturation', 'saturation'],
  ['color', 'Colour', 'color'], ['luminosity', 'Luminosity', 'luminosity'],
];
export const BLEND_OP = Object.fromEntries(BLENDS.map((b) => [b[0], b[2]]));

/** Layer settings that undo snapshots copy (canvases are kept by reference). */
export const LAYER_PROPS = ['name', 'x', 'y', 'visible', 'opacity', 'blend', 'locked', 'lockAlpha', 'maskOn', 'effects', 'text', 'adjust', 'kind'];

let seq = 0;
export function newLayer(props = {}) {
  return {
    id: `L${Date.now().toString(36)}${(++seq).toString(36)}`, name: 'Layer', kind: 'pixel', canvas: null, x: 0, y: 0,
    visible: true, opacity: 1, blend: 'normal', locked: false, lockAlpha: false, mask: null, maskOn: true,
    effects: null, text: null, adjust: null, rev: 0, ...props,
  };
}

export class PhotoDoc {
  constructor(width, height) {
    this.width = width;
    this.height = height;
    this.layers = []; // bottom first
    this.activeId = null;
    this.version = 0;
  }

  get active() { return this.layers.find((l) => l.id === this.activeId) || this.layers[this.layers.length - 1] || null; }
  get activeIndex() { return this.layers.findIndex((l) => l.id === this.activeId); }
  layer(id) { return this.layers.find((l) => l.id === id) || null; }

  /** Something changed: caches built from older versions are stale. */
  touch(layer = null) {
    this.version++;
    if (layer) layer.rev++;
  }

  /** A new pixel layer the size of the picture. */
  addPixelLayer(name, { above = true, canvas = null, x = 0, y = 0 } = {}) {
    const L = newLayer({ name, canvas: canvas || makeCanvas(this.width, this.height), x, y });
    const i = this.activeIndex;
    if (above && i >= 0) this.layers.splice(i + 1, 0, L);
    else this.layers.push(L);
    this.activeId = L.id;
    this.touch();
    return L;
  }

  uniqueName(base) {
    const names = new Set(this.layers.map((l) => l.name));
    if (!names.has(base)) return base;
    for (let n = 2; ; n++) if (!names.has(`${base} ${n}`)) return `${base} ${n}`;
  }
}

/** Make a layer's canvas (and mask) cover a rectangle in picture coordinates. */
export function ensureCovers(L, x0, y0, x1, y1) {
  if (L.kind !== 'pixel') return false;
  const lx0 = Math.min(L.x, Math.floor(x0));
  const ly0 = Math.min(L.y, Math.floor(y0));
  const lx1 = Math.max(L.x + L.canvas.width, Math.ceil(x1));
  const ly1 = Math.max(L.y + L.canvas.height, Math.ceil(y1));
  if (lx0 === L.x && ly0 === L.y && lx1 === L.x + L.canvas.width && ly1 === L.y + L.canvas.height) return false;
  const grow = (src, fillWhite) => {
    const c = makeCanvas(lx1 - lx0, ly1 - ly0);
    const ctx = c.getContext('2d');
    if (fillWhite) { ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height); ctx.clearRect(L.x - lx0, L.y - ly0, src.width, src.height); }
    ctx.drawImage(src, L.x - lx0, L.y - ly0);
    return c;
  };
  L.canvas = grow(L.canvas, false);
  if (L.mask) L.mask = grow(L.mask, true);
  L.x = lx0;
  L.y = ly0;
  return true;
}

/** Bounding box of a layer's visible pixels (layer coordinates), or null. */
export function contentBounds(canvas) {
  const { width: w, height: h } = canvas;
  const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  let x0 = w; let y0 = h; let x1 = -1; let y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x++) {
      if (d[row + x * 4 + 3] === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

// ---------------------------------------------------------------------------
// Text layers
// ---------------------------------------------------------------------------
export const TEXT_DEFAULTS = { value: '', font: 'Inter', size: 64, color: '#ffffff', bold: false, italic: false, align: 'left', lineHeight: 1.2, width: 0, letterSpacing: 0 };

export function textFont(t) { return `${t.italic ? 'italic ' : ''}${t.bold ? '700 ' : '400 '}${t.size}px "${t.font}", sans-serif`; }

/** Lines of a text layer, wrapped to its box width when it has one. */
export function textLines(t, ctx) {
  ctx.font = textFont(t);
  const lines = [];
  for (const para of String(t.value).split('\n')) {
    if (!t.width) { lines.push(para); continue; }
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      if (line.trim() && ctx.measureText(line + word).width > t.width) { lines.push(line.trimEnd()); line = word.trimStart(); } else line += word;
    }
    lines.push(line);
  }
  return lines;
}

/** Draw a text layer's canvas from its settings (x, y stay the top-left of the box). */
export function renderText(L) {
  const t = { ...TEXT_DEFAULTS, ...L.text };
  const probe = makeCanvas(1, 1).getContext('2d');
  if ('letterSpacing' in probe) probe.letterSpacing = `${t.letterSpacing || 0}px`;
  const lines = textLines(t, probe);
  const lh = t.size * t.lineHeight;
  const widths = lines.map((l) => probe.measureText(l).width);
  const boxW = Math.max(4, Math.ceil(t.width || Math.max(...widths, 4)));
  const pad = Math.ceil(t.size * 0.3);
  const c = makeCanvas(boxW + pad * 2, Math.ceil(lines.length * lh + pad * 2));
  const ctx = c.getContext('2d');
  ctx.font = textFont(t);
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${t.letterSpacing || 0}px`;
  ctx.fillStyle = t.color;
  ctx.textBaseline = 'alphabetic';
  lines.forEach((line, i) => {
    const x = t.align === 'center' ? (boxW - widths[i]) / 2 : t.align === 'right' ? boxW - widths[i] : 0;
    ctx.fillText(line, pad + x, pad + i * lh + t.size * 0.95);
  });
  L.canvas = c;
  L.pad = pad;
  L.rev++;
  return c;
}

// ---------------------------------------------------------------------------
// Combining the layers
// ---------------------------------------------------------------------------
export class Compositor {
  constructor(getDoc) {
    this.getDoc = getDoc;
    this.out = null;
    this.below = null;
    this.belowKey = '';
    this.scratch = [];
    this.fxCache = new WeakMap();
  }

  canvas(i, w, h) {
    let c = this.scratch[i];
    if (!c || c.width !== w || c.height !== h) { c = makeCanvas(w, h); this.scratch[i] = c; }
    const ctx = c.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    ctx.filter = 'none';
    ctx.clearRect(0, 0, w, h);
    return c;
  }

  /**
   * The combined picture. `override` swaps one layer's canvas (or position, or
   * a transform) while a tool is working on it, reusing the layers below.
   */
  render({ override = null, upTo = null, into = null } = {}) {
    const doc = this.getDoc();
    const W = doc.width;
    const H = doc.height;
    let out = into;
    if (!out) {
      if (!this.out || this.out.width !== W || this.out.height !== H) this.out = makeCanvas(W, H);
      out = this.out;
    }
    const ctx = out.getContext('2d');
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    let start = 0;
    const end = upTo === null ? doc.layers.length : upTo;
    if (override && !into) {
      const idx = doc.layers.findIndex((l) => l.id === override.id);
      if (idx > 0) {
        const key = `${doc.version}:${idx}:${W}x${H}`;
        if (this.belowKey !== key) {
          if (!this.below || this.below.width !== W || this.below.height !== H) this.below = makeCanvas(W, H);
          this.render({ upTo: idx, into: this.below });
          this.belowKey = key;
        }
        ctx.drawImage(this.below, 0, 0);
        start = idx;
      }
    }
    for (let i = start; i < end; i++) {
      const L = doc.layers[i];
      if (!L.visible) continue;
      this.drawLayer(ctx, L, override && override.id === L.id ? override : null, W, H);
    }
    return out;
  }

  /** One layer onto the picture below it. */
  drawLayer(ctx, L, ov, W, H) {
    if (L.kind === 'adjust') { this.drawAdjust(ctx, L, W, H, ov); return; }
    let src = (ov && ov.canvas) || L.canvas;
    if (!src) return;
    const x = ov && ov.x !== undefined ? ov.x : L.x;
    const y = ov && ov.y !== undefined ? ov.y : L.y;
    const mask = ov && ov.mask ? ov.mask : L.mask;
    if (mask && L.maskOn) {
      const t = this.canvas(0, src.width, src.height);
      const tctx = t.getContext('2d');
      tctx.drawImage(src, 0, 0);
      tctx.globalCompositeOperation = 'destination-in';
      tctx.drawImage(mask, 0, 0);
      src = t;
    }
    if (L.effects && L.effects.overlay && L.effects.overlay.on) {
      const o = L.effects.overlay;
      const t = this.canvas(1, src.width, src.height);
      const tctx = t.getContext('2d');
      tctx.drawImage(src, 0, 0);
      tctx.globalCompositeOperation = 'source-atop';
      tctx.globalAlpha = o.opacity ?? 1;
      tctx.fillStyle = o.color || '#ff0000';
      tctx.fillRect(0, 0, t.width, t.height);
      src = t;
    }
    if (L.effects) this.drawEffects(ctx, L, src, x, y, !!ov);
    ctx.save();
    ctx.globalAlpha = L.opacity;
    ctx.globalCompositeOperation = BLEND_OP[L.blend] || 'source-over';
    if (ov && ov.transform) {
      const m = ov.transform; // maps layer pixels to picture coordinates
      ctx.setTransform(m.a, m.b, m.c, m.d, m.e, m.f);
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(src, 0, 0);
    } else ctx.drawImage(src, x, y);
    ctx.restore();
  }

  /** Shadow, glow and outline, drawn under the layer. */
  drawEffects(ctx, L, src, x, y, live) {
    const fx = L.effects;
    const key = `${L.rev}|${src.width}x${src.height}|${JSON.stringify(fx)}|${L.mask ? 'm' : ''}${L.maskOn}`;
    let cached = this.fxCache.get(L);
    if (!cached || (cached.key !== key && !live)) {
      cached = { key, ...renderEffects(fx, src) };
      if (!live) this.fxCache.set(L, cached);
    }
    if (!cached.canvas) return;
    ctx.save();
    ctx.globalAlpha = L.opacity;
    ctx.drawImage(cached.canvas, x + cached.dx, y + cached.dy);
    ctx.restore();
  }

  drawAdjust(ctx, L, W, H, ov = null) {
    const a = (ov && ov.adjust) || L.adjust;
    if (!a) return;
    const out = ctx.canvas;
    const t = this.canvas(2, W, H);
    const tctx = t.getContext('2d');
    const css = cssFilterFor(a.kind, a.params);
    if (css) {
      tctx.filter = css;
      tctx.drawImage(out, 0, 0);
      tctx.filter = 'none';
    } else {
      const id = ctx.getImageData(0, 0, W, H);
      applyAdjustment(id, a.kind, a.params);
      tctx.putImageData(id, 0, 0);
    }
    const mask = (ov && ov.mask) || L.mask;
    if (mask && L.maskOn) {
      tctx.globalCompositeOperation = 'destination-in';
      tctx.drawImage(mask, L.x, L.y);
    }
    // The adjusted copy goes over the original: opacity and mask fade it.
    ctx.save();
    ctx.globalAlpha = L.opacity;
    ctx.globalCompositeOperation = 'source-atop';
    ctx.drawImage(t, 0, 0);
    ctx.restore();
  }
}

/** The effects of a layer as one canvas, offset from the layer's corner. */
export function renderEffects(fx, src) {
  const shadow = fx.shadow && fx.shadow.on ? fx.shadow : null;
  const glow = fx.glow && fx.glow.on ? fx.glow : null;
  const stroke = fx.stroke && fx.stroke.on ? fx.stroke : null;
  if (!shadow && !glow && !stroke) return { canvas: null, dx: 0, dy: 0 };
  const sd = shadow ? (shadow.distance || 0) + (shadow.blur || 0) * 2 : 0;
  const gd = glow ? (glow.size || 0) * 2 : 0;
  const pad = Math.ceil(Math.max(sd, gd, stroke ? stroke.size || 0 : 0)) + 4;
  const c = makeCanvas(src.width + pad * 2, src.height + pad * 2);
  const ctx = c.getContext('2d');
  // A silhouette in one colour, used for the outline.
  const silhouette = (color) => {
    const s = makeCanvas(src.width, src.height);
    const sctx = s.getContext('2d');
    sctx.drawImage(src, 0, 0);
    sctx.globalCompositeOperation = 'source-in';
    sctx.fillStyle = color;
    sctx.fillRect(0, 0, s.width, s.height);
    return s;
  };
  const far = 20000; // draw the layer far away so only its shadow lands here
  if (shadow) {
    const ang = ((shadow.angle ?? 135) * Math.PI) / 180;
    ctx.save();
    ctx.globalAlpha = shadow.opacity ?? 0.6;
    ctx.shadowColor = shadow.color || '#000';
    ctx.shadowBlur = shadow.blur ?? 12;
    ctx.shadowOffsetX = far - Math.cos(ang) * (shadow.distance ?? 10);
    ctx.shadowOffsetY = Math.sin(ang) * (shadow.distance ?? 10);
    ctx.drawImage(src, pad - far, pad);
    ctx.restore();
  }
  if (glow) {
    ctx.save();
    ctx.globalAlpha = glow.opacity ?? 0.8;
    ctx.shadowColor = glow.color || '#ffd75e';
    ctx.shadowBlur = glow.size ?? 16;
    ctx.shadowOffsetX = far;
    for (let i = 0; i < 2; i++) ctx.drawImage(src, pad - far, pad);
    ctx.restore();
  }
  if (stroke) {
    const s = silhouette(stroke.color || '#000');
    const r = Math.max(1, stroke.size || 3);
    ctx.save();
    ctx.globalAlpha = stroke.opacity ?? 1;
    const t = makeCanvas(c.width, c.height);
    const tctx = t.getContext('2d');
    // Rings of copies make a smooth outline of any width.
    for (let rr = r; rr > 0; rr -= Math.max(1, r / 3)) {
      const n = Math.max(12, Math.ceil(rr * 2));
      for (let k = 0; k < n; k++) {
        const a = (k / n) * Math.PI * 2;
        tctx.drawImage(s, pad + Math.cos(a) * rr, pad + Math.sin(a) * rr);
      }
    }
    ctx.drawImage(t, 0, 0);
    ctx.restore();
  }
  return { canvas: c, dx: -pad, dy: -pad };
}

/** A small picture of a layer for the layers panel. */
export function thumbnail(L, doc, size = 40, which = 'layer') {
  const c = makeCanvas(size, size);
  const ctx = c.getContext('2d');
  if (L.kind === 'adjust') return c;
  const src = which === 'mask' ? L.mask : L.canvas;
  if (!src) return c;
  // Show the layer within the picture's frame.
  const s = Math.min(size / doc.width, size / doc.height);
  const ox = (size - doc.width * s) / 2;
  const oy = (size - doc.height * s) / 2;
  if (which === 'mask') {
    ctx.fillStyle = '#000';
    ctx.fillRect(ox, oy, doc.width * s, doc.height * s);
  }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, ox + L.x * s, oy + L.y * s, src.width * s, src.height * s);
  return c;
}
