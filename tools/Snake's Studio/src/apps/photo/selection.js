// The selection: a soft mask over the picture (0 = out, 255 = in), kept as a
// canvas whose alpha is the mask so it can clip drawing directly. Treated as
// immutable: every change makes a new canvas, so undo can keep old ones.
import { makeCanvas } from '../../kit/raster.js';

export class Selection {
  constructor(w, h, canvas = null) {
    this.w = w;
    this.h = h;
    this.canvas = canvas; // null = nothing selected
    this.cache = null;
  }

  get empty() { return !this.canvas; }

  /** Alpha values, one byte per pixel. */
  get alpha() {
    if (!this.canvas) return null;
    if (!this.cache) {
      const d = this.canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, this.w, this.h).data;
      const a = new Uint8ClampedArray(this.w * this.h);
      for (let p = 0, i = 3; p < a.length; p++, i += 4) a[p] = d[i];
      this.cache = { a, bounds: boundsOf(a, this.w, this.h), outline: null };
      if (!this.cache.bounds) this.canvas = null;
    }
    return this.cache ? this.cache.a : null;
  }

  get bounds() { return this.alpha ? this.cache.bounds : null; }

  /** The outline as a path in picture coordinates (for the marching ants). */
  get outline() {
    if (!this.alpha) return null;
    if (!this.cache.outline) this.cache.outline = outlinePath(this.cache.a, this.w, this.h);
    return this.cache.outline;
  }

  contains(x, y) {
    const a = this.alpha;
    if (!a) return false;
    x = Math.floor(x); y = Math.floor(y);
    return x >= 0 && y >= 0 && x < this.w && y < this.h && a[y * this.w + x] > 127;
  }

  /** A new selection: draw(ctx) paints the shape in white, combined by mode. */
  with(draw, mode = 'replace') {
    const shape = makeCanvas(this.w, this.h);
    const s = shape.getContext('2d');
    s.fillStyle = '#fff';
    s.strokeStyle = '#fff';
    draw(s);
    return this.combine(shape, mode);
  }

  /** Combine with another mask canvas (white with alpha). */
  combine(shape, mode = 'replace') {
    if (mode === 'replace' || (this.empty && mode === 'add')) return new Selection(this.w, this.h, shape).normalised();
    if (this.empty) return mode === 'subtract' || mode === 'intersect' ? new Selection(this.w, this.h) : new Selection(this.w, this.h, shape).normalised();
    const c = makeCanvas(this.w, this.h);
    const ctx = c.getContext('2d');
    ctx.drawImage(this.canvas, 0, 0);
    ctx.globalCompositeOperation = mode === 'add' ? 'source-over' : mode === 'subtract' ? 'destination-out' : 'destination-in';
    ctx.drawImage(shape, 0, 0);
    return new Selection(this.w, this.h, c).normalised();
  }

  /** Drop a selection that ended up empty. */
  normalised() {
    void this.alpha;
    return this;
  }

  fromAlpha(a, mode = 'replace') {
    const c = makeCanvas(this.w, this.h);
    const ctx = c.getContext('2d');
    const id = ctx.createImageData(this.w, this.h);
    for (let p = 0; p < a.length; p++) { const i = p * 4; id.data[i] = id.data[i + 1] = id.data[i + 2] = 255; id.data[i + 3] = a[p]; }
    ctx.putImageData(id, 0, 0);
    return this.combine(c, mode);
  }

  all() { return this.with((ctx) => ctx.fillRect(0, 0, this.w, this.h)); }
  none() { return new Selection(this.w, this.h); }

  invert() {
    if (this.empty) return this.all();
    const c = makeCanvas(this.w, this.h);
    const ctx = c.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, this.w, this.h);
    ctx.globalCompositeOperation = 'destination-out';
    ctx.drawImage(this.canvas, 0, 0);
    return new Selection(this.w, this.h, c).normalised();
  }

  feather(r) {
    if (this.empty || r <= 0) return this;
    const c = makeCanvas(this.w, this.h);
    const ctx = c.getContext('2d');
    ctx.filter = `blur(${r / 2}px)`;
    ctx.drawImage(this.canvas, 0, 0);
    return new Selection(this.w, this.h, c).normalised();
  }

  /** Grow (r > 0) or shrink (r < 0) by a distance in pixels. */
  grow(r) {
    if (this.empty || !r) return this;
    const a = this.alpha;
    const inside = r > 0 ? 0 : 1;
    // Distance from each pixel to the nearest pixel on the other side.
    const dist = distanceTo(a, this.w, this.h, inside === 0);
    const out = new Uint8ClampedArray(a.length);
    const R = Math.abs(r);
    for (let p = 0; p < a.length; p++) {
      if (r > 0) out[p] = a[p] > 127 || dist[p] <= R ? 255 : 0;
      else out[p] = a[p] > 127 && dist[p] > R ? 255 : 0;
    }
    return this.none().fromAlpha(out);
  }

  /** A band along the edge of the selection. */
  border(width) {
    if (this.empty) return this;
    const outer = this.grow(Math.ceil(width / 2));
    const inner = this.grow(-Math.floor(width / 2));
    return inner.empty ? outer : outer.combine(inner.canvas, 'subtract');
  }

  /** Same selection on a canvas of another size, moved by (dx, dy). */
  resized(w, h, dx = 0, dy = 0) {
    if (this.empty) return new Selection(w, h);
    const c = makeCanvas(w, h);
    c.getContext('2d').drawImage(this.canvas, dx, dy);
    return new Selection(w, h, c).normalised();
  }

  moved(dx, dy) { return this.resized(this.w, this.h, dx, dy); }

  /** Transformed (for flips and rotations of the whole picture). */
  transformed(w, h, apply) {
    if (this.empty) return new Selection(w, h);
    const c = makeCanvas(w, h);
    const ctx = c.getContext('2d');
    apply(ctx);
    ctx.drawImage(this.canvas, 0, 0);
    return new Selection(w, h, c).normalised();
  }
}

function boundsOf(a, w, h) {
  let x0 = w; let y0 = h; let x1 = -1; let y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    let any = false;
    for (let x = 0; x < w; x++) {
      if (a[row + x] < 1) continue;
      any = true;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
    }
    if (any) { if (y < y0) y0 = y; y1 = y; }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/**
 * The edge between selected and unselected pixels, as long straight runs (one
 * per row or column stretch) so even big wand selections draw quickly.
 */
function outlinePath(a, w, h) {
  const path = new Path2D();
  const on = (x, y) => x >= 0 && y >= 0 && x < w && y < h && a[y * w + x] > 127;
  // Horizontal edges: between row y-1 and row y.
  for (let y = 0; y <= h; y++) {
    let start = -1;
    for (let x = 0; x <= w; x++) {
      const edge = x < w && on(x, y) !== on(x, y - 1);
      if (edge && start < 0) start = x;
      if (!edge && start >= 0) { path.moveTo(start, y); path.lineTo(x, y); start = -1; }
    }
  }
  for (let x = 0; x <= w; x++) {
    let start = -1;
    for (let y = 0; y <= h; y++) {
      const edge = y < h && on(x, y) !== on(x - 1, y);
      if (edge && start < 0) start = y;
      if (!edge && start >= 0) { path.moveTo(x, start); path.lineTo(x, y); start = -1; }
    }
  }
  return path;
}

/**
 * Distance (chamfer, close to straight-line) from each pixel to the nearest
 * pixel that is selected (toSelected) or not selected.
 */
export function distanceTo(a, w, h, toSelected) {
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let p = 0; p < d.length; p++) d[p] = (a[p] > 127) === toSelected ? 0 : INF;
  const D1 = 1;
  const D2 = Math.SQRT2;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x;
      let v = d[p];
      if (v === 0) continue;
      if (x > 0) v = Math.min(v, d[p - 1] + D1);
      if (y > 0) {
        v = Math.min(v, d[p - w] + D1);
        if (x > 0) v = Math.min(v, d[p - w - 1] + D2);
        if (x < w - 1) v = Math.min(v, d[p - w + 1] + D2);
      }
      d[p] = v;
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const p = y * w + x;
      let v = d[p];
      if (v === 0) continue;
      if (x < w - 1) v = Math.min(v, d[p + 1] + D1);
      if (y < h - 1) {
        v = Math.min(v, d[p + w] + D1);
        if (x < w - 1) v = Math.min(v, d[p + w + 1] + D2);
        if (x > 0) v = Math.min(v, d[p + w - 1] + D2);
      }
      d[p] = v;
    }
  }
  return d;
}
