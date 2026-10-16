// Brush strokes for Snake's Photo. A stroke collects soft round dabs into a
// mask; what the mask reveals depends on the tool (a colour, a cloned copy, a
// blurred or lightened copy...). Drawing the mask once with the stroke's
// opacity means overlapping dabs never go past that opacity, as in Photoshop.
import { makeCanvas } from '../../kit/raster.js';
import { blurCanvas, FILTERS, inpaint } from './filters.js';

export const BRUSH_TOOLS = ['brush', 'eraser', 'clone', 'heal', 'spot', 'smudge', 'blur', 'sharpen', 'dodge', 'burn', 'sponge'];

/** A soft round dab, white with alpha, `size` pixels across. */
function stamp(size, hardness) {
  const s = Math.max(2, Math.ceil(size));
  const c = makeCanvas(s, s);
  const ctx = c.getContext('2d');
  const r = s / 2;
  const g = ctx.createRadialGradient(r, r, 0, r, r, r);
  const h = Math.min(0.99, Math.max(0, hardness));
  g.addColorStop(0, 'rgba(255,255,255,1)');
  g.addColorStop(h, 'rgba(255,255,255,1)');
  // A smooth fall-off rather than a straight ramp.
  for (let k = 1; k <= 4; k++) {
    const t = h + ((1 - h) * k) / 5;
    g.addColorStop(t, `rgba(255,255,255,${(1 - k / 5) ** 2})`);
  }
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  return c;
}

function region(c, r) {
  const t = makeCanvas(r.w, r.h);
  t.getContext('2d').drawImage(c, r.x, r.y, r.w, r.h, 0, 0, r.w, r.h);
  return t;
}

export class Stroke {
  /**
   * target: the canvas being changed (a layer's pixels or its mask), at (ox, oy) in the picture.
   * opts: { tool, size, hardness, opacity, flow, spacing, color, maskValue, lockAlpha,
   *         selection (canvas | null), source: { canvas, dx, dy } for clone/heal, pressure: { size, opacity }, smoothing }
   */
  constructor(target, ox, oy, opts) {
    this.base = target; // untouched until commit
    this.ox = ox;
    this.oy = oy;
    this.o = opts;
    this.w = target.width;
    this.h = target.height;
    this.work = makeCanvas(this.w, this.h);
    this.wctx = this.work.getContext('2d');
    this.wctx.drawImage(target, 0, 0);
    this.mask = makeCanvas(this.w, this.h);
    this.mctx = this.mask.getContext('2d');
    this.stamp = stamp(Math.min(opts.size, 2000), opts.hardness);
    this.dirty = null;
    this.drawn = null;
    this.leftover = 0;
    this.last = null;
    this.smooth = null;
    const t = opts.tool;
    // What the stroke reveals.
    if (t === 'blur') this.reveal = blurCanvas(target, Math.max(1, opts.size / 8));
    else if (t === 'sharpen') this.reveal = FILTERS.unsharp.run(target, { amount: 140, radius: Math.max(0.8, opts.size / 30), threshold: 0 });
    else if (t === 'dodge' || t === 'burn' || t === 'sponge') this.reveal = toned(target, t, opts.mode);
    else if (t === 'clone' || t === 'heal') this.reveal = opts.source ? opts.source.canvas : null;
    else this.reveal = null;
  }

  /** Picture coordinates to the target canvas's. */
  local(p) { return { x: p.x - this.ox, y: p.y - this.oy, pressure: p.pressure }; }

  grow(x, y, r) {
    const box = { x: Math.floor(x - r - 2), y: Math.floor(y - r - 2), w: Math.ceil(r * 2 + 4), h: Math.ceil(r * 2 + 4) };
    const b = this.dirty;
    if (!b) this.dirty = box;
    else {
      const x0 = Math.min(b.x, box.x); const y0 = Math.min(b.y, box.y);
      this.dirty = { x: x0, y: y0, w: Math.max(b.x + b.w, box.x + box.w) - x0, h: Math.max(b.y + b.h, box.y + box.h) - y0 };
    }
  }

  clipped(r) {
    const x = Math.max(0, r.x); const y = Math.max(0, r.y);
    const x1 = Math.min(this.w, r.x + r.w); const y1 = Math.min(this.h, r.y + r.h);
    return x1 > x && y1 > y ? { x, y, w: x1 - x, h: y1 - y } : null;
  }

  dab(x, y, pressure) {
    const o = this.o;
    const pr = pressure ?? 1;
    const size = Math.max(1, o.size * (o.pressure && o.pressure.size ? 0.15 + 0.85 * pr : 1));
    const flow = (o.flow ?? 1) * (o.pressure && o.pressure.opacity ? pr : 1);
    this.grow(x, y, size / 2);
    if (o.tool === 'smudge') { this.smudgeDab(x, y, size); return; }
    this.mctx.globalAlpha = Math.min(1, flow);
    this.mctx.drawImage(this.stamp, x - size / 2, y - size / 2, size, size);
  }

  smudgeDab(x, y, size) {
    const q = this.prevDab;
    this.prevDab = { x, y };
    if (!q) return;
    const s = Math.ceil(size);
    if (!this.smudgeTmp || this.smudgeTmp.width !== s) this.smudgeTmp = makeCanvas(s, s);
    const t = this.smudgeTmp;
    const tctx = t.getContext('2d');
    tctx.globalCompositeOperation = 'source-over';
    tctx.clearRect(0, 0, s, s);
    tctx.drawImage(this.work, q.x - s / 2, q.y - s / 2, s, s, 0, 0, s, s);
    tctx.globalCompositeOperation = 'destination-in';
    tctx.drawImage(this.stamp, 0, 0, s, s);
    if (this.o.selection) tctx.drawImage(this.o.selection, -(x - s / 2) - this.ox, -(y - s / 2) - this.oy);
    this.wctx.save();
    this.wctx.globalAlpha = this.o.opacity * 0.9;
    if (this.o.lockAlpha) this.wctx.globalCompositeOperation = 'source-atop';
    this.wctx.drawImage(t, x - s / 2, y - s / 2);
    this.wctx.restore();
  }

  /** Add a pointer position (picture coordinates). */
  to(pp) {
    this.lastRaw = pp;
    let p = this.local(pp);
    // Smoothing: the brush trails the pointer on an elastic band.
    const k = this.o.smoothing ? Math.min(0.92, this.o.smoothing / 100) : 0;
    if (k && this.smooth) p = { x: this.smooth.x + (p.x - this.smooth.x) * (1 - k), y: this.smooth.y + (p.y - this.smooth.y) * (1 - k), pressure: p.pressure };
    this.smooth = p;
    if (!this.last) { this.last = p; this.dab(p.x, p.y, p.pressure); return; }
    const a = this.last;
    const dist = Math.hypot(p.x - a.x, p.y - a.y);
    const step = Math.max(0.5, this.o.size * (this.o.spacing ?? 0.12));
    let t = step - this.leftover;
    while (t <= dist) {
      const f = t / dist;
      this.dab(a.x + (p.x - a.x) * f, a.y + (p.y - a.y) * f, a.pressure + ((p.pressure ?? 1) - (a.pressure ?? 1)) * f);
      t += step;
    }
    this.leftover = dist - (t - step);
    this.last = p;
  }

  /** Catch the smoothed brush up with where the pointer stopped. */
  finish() {
    if (this.o.smoothing && this.smooth && this.lastRaw) for (let i = 0; i < 6; i++) this.to(this.lastRaw);
  }

  /** Bring the preview up to date (only the area the stroke touched). */
  update() {
    const r = this.dirty && this.clipped(this.dirty);
    if (!r) return null;
    const o = this.o;
    if (o.tool === 'smudge') return r;
    // Start again from the original pixels in this area.
    const w = this.wctx;
    w.clearRect(r.x, r.y, r.w, r.h);
    w.drawImage(this.base, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
    if (o.tool === 'spot') {
      // Show where healing will happen; the work is done on release.
      const t = region(this.mask, r);
      const tctx = t.getContext('2d');
      tctx.globalCompositeOperation = 'source-in';
      tctx.fillStyle = 'rgba(229,83,75,0.55)';
      tctx.fillRect(0, 0, r.w, r.h);
      w.drawImage(t, r.x, r.y);
      return r;
    }
    const t = this.revealed(r);
    if (!t) return r;
    w.save();
    w.globalAlpha = o.opacity;
    if (o.target === 'mask') {
      // Masks move toward the paint's value: fade out by the stroke, then add value × stroke.
      w.globalCompositeOperation = 'destination-out';
      w.drawImage(t, r.x, r.y);
      w.globalCompositeOperation = 'lighter';
      w.globalAlpha = o.opacity * (o.maskValue ?? 1);
      w.drawImage(t, r.x, r.y);
    } else if (o.tool === 'eraser') {
      w.globalCompositeOperation = 'destination-out';
      w.drawImage(t, r.x, r.y);
    } else {
      w.globalCompositeOperation = o.lockAlpha || ['blur', 'sharpen', 'dodge', 'burn', 'sponge'].includes(o.tool) ? 'source-atop' : 'source-over';
      w.drawImage(t, r.x, r.y);
    }
    w.restore();
    return r;
  }

  /** What shows through the stroke in rectangle r: the stroke's mask filled with its source. */
  revealed(r) {
    const o = this.o;
    const t = region(this.mask, r);
    const tctx = t.getContext('2d');
    if (o.selection) {
      tctx.globalCompositeOperation = 'destination-in';
      tctx.drawImage(o.selection, -r.x - this.ox, -r.y - this.oy);
    }
    tctx.globalCompositeOperation = 'source-in';
    if (o.target === 'mask' || o.tool === 'eraser') {
      tctx.fillStyle = '#fff';
      tctx.fillRect(0, 0, r.w, r.h);
    } else if (this.reveal) {
      const dx = o.source && (o.tool === 'clone' || o.tool === 'heal') ? o.source.dx : 0;
      const dy = o.source && (o.tool === 'clone' || o.tool === 'heal') ? o.source.dy : 0;
      tctx.drawImage(this.reveal, -r.x + dx, -r.y + dy);
    } else if (o.tool === 'clone' || o.tool === 'heal') {
      return null;
    } else {
      tctx.fillStyle = o.color;
      tctx.fillRect(0, 0, r.w, r.h);
    }
    return t;
  }

  /** Finish: the changed area of the target, after the tool's last step. Returns the rectangle. */
  commit() {
    this.finish();
    const r = this.update();
    if (!r) return null;
    const o = this.o;
    if (o.tool === 'spot' || o.tool === 'heal') this.healArea(r);
    const ctx = this.base.getContext('2d');
    ctx.clearRect(r.x, r.y, r.w, r.h);
    ctx.drawImage(this.work, r.x, r.y, r.w, r.h, r.x, r.y, r.w, r.h);
    return r;
  }

  healArea(r) {
    const o = this.o;
    const pad = Math.ceil(o.size);
    const R = this.clipped({ x: r.x - pad, y: r.y - pad, w: r.w + pad * 2, h: r.h + pad * 2 });
    const mctx = this.mask.getContext('2d', { willReadFrequently: true });
    const md = mctx.getImageData(R.x, R.y, R.w, R.h).data;
    const sel = o.selection ? o.selection.getContext('2d', { willReadFrequently: true }).getImageData(R.x + this.ox, R.y + this.oy, R.w, R.h).data : null;
    const m = new Uint8ClampedArray(R.w * R.h);
    for (let p = 0; p < m.length; p++) m[p] = md[p * 4 + 3] * (sel ? sel[p * 4 + 3] / 255 : 1) * o.opacity;
    const wctx = this.wctx;
    const base = this.base.getContext('2d', { willReadFrequently: true }).getImageData(R.x, R.y, R.w, R.h);
    if (o.tool === 'spot') {
      const filled = inpaint(new ImageData(new Uint8ClampedArray(base.data), R.w, R.h), m.map((v) => (v > 20 ? 255 : 0)));
      // Blend by the soft edge of the stroke.
      const out = base.data;
      for (let p = 0, i = 0; p < m.length; p++, i += 4) {
        const k = m[p] / 255;
        if (!k) continue;
        for (let j = 0; j < 4; j++) out[i + j] = out[i + j] * (1 - k) + filled.data[i + j] * k;
      }
      wctx.putImageData(base, R.x, R.y);
      return;
    }
    // Healing brush: the cloned texture with the target's own colour and light
    // (the source's fine detail on the target's blurred tones).
    if (!this.reveal) return;
    const src = makeCanvas(R.w, R.h);
    src.getContext('2d').drawImage(this.reveal, -R.x + o.source.dx, -R.y + o.source.dy);
    const radius = Math.max(2, o.size / 3);
    const bs = blurCanvas(src, radius).getContext('2d', { willReadFrequently: true }).getImageData(0, 0, R.w, R.h).data;
    const bt = blurCanvas(region(this.base, R), radius).getContext('2d', { willReadFrequently: true }).getImageData(0, 0, R.w, R.h).data;
    const sd = src.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, R.w, R.h).data;
    const out = base.data;
    for (let p = 0, i = 0; p < m.length; p++, i += 4) {
      const k = m[p] / 255;
      if (!k) continue;
      for (let j = 0; j < 3; j++) {
        const v = bt[i + j] + (sd[i + j] - bs[i + j]);
        out[i + j] = out[i + j] * (1 - k) + Math.min(255, Math.max(0, v)) * k;
      }
    }
    wctx.putImageData(base, R.x, R.y);
  }
}

/** Lighter, darker or more colourful copies, for dodge, burn and sponge. */
function toned(src, tool, mode) {
  const c = makeCanvas(src.width, src.height);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (tool === 'sponge') {
    ctx.filter = mode === 'desaturate' ? 'saturate(0.2)' : 'saturate(1.8)';
    ctx.drawImage(src, 0, 0);
    return c;
  }
  ctx.drawImage(src, 0, 0);
  const id = ctx.getImageData(0, 0, c.width, c.height);
  const d = id.data;
  const t = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) {
    const x = v / 255;
    // Strongest in the tone range chosen (shadows, midtones or highlights).
    const w = mode === 'shadows' ? (1 - x) ** 2 : mode === 'highlights' ? x * x : 4 * x * (1 - x);
    t[v] = tool === 'dodge' ? v + (255 - v) * 0.6 * w + 18 * w : v * (1 - 0.55 * w);
  }
  for (let i = 0; i < d.length; i += 4) { d[i] = t[d[i]]; d[i + 1] = t[d[i + 1]]; d[i + 2] = t[d[i + 2]]; }
  ctx.putImageData(id, 0, 0);
  return c;
}
