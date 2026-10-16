// Filters: each takes a canvas and settings and returns a new canvas of the same
// size. The GPU does the blurs (canvas filters); the rest are plain loops.
import { makeCanvas } from '../../kit/raster.js';

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);
const read = (c) => c.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, c.width, c.height);
function fromData(id) {
  const c = makeCanvas(id.width, id.height);
  c.getContext('2d').putImageData(id, 0, 0);
  return c;
}

/** Gaussian blur with the edge pixels repeated outwards, so borders keep their colour. */
export function blurCanvas(src, radius) {
  if (radius <= 0) { const c = makeCanvas(src.width, src.height); c.getContext('2d').drawImage(src, 0, 0); return c; }
  const pad = Math.ceil(radius * 3);
  const w = src.width;
  const h = src.height;
  const big = makeCanvas(w + pad * 2, h + pad * 2);
  const b = big.getContext('2d');
  b.drawImage(src, pad, pad);
  // Stretch the outer rows and columns into the margin.
  b.drawImage(src, 0, 0, w, 1, pad, 0, w, pad);
  b.drawImage(src, 0, h - 1, w, 1, pad, h + pad, w, pad);
  b.drawImage(big, pad, 0, 1, h + pad * 2, 0, 0, pad, h + pad * 2);
  b.drawImage(big, w + pad - 1, 0, 1, h + pad * 2, w + pad, 0, pad, h + pad * 2);
  const out = makeCanvas(w, h);
  const o = out.getContext('2d');
  o.filter = `blur(${radius}px)`;
  o.drawImage(big, -pad, -pad);
  o.filter = 'none';
  return out;
}

/** The average of many shifted, scaled or turned copies (motion, zoom and spin blur). */
function smear(src, n, place) {
  const out = makeCanvas(src.width, src.height);
  const o = out.getContext('2d');
  o.imageSmoothingQuality = 'high';
  for (let i = 0; i < n; i++) {
    o.save();
    o.globalAlpha = 1 / (i + 1); // a running average
    place(o, i / Math.max(1, n - 1) - 0.5);
    o.drawImage(src, 0, 0);
    o.restore();
  }
  return out;
}

export const FILTERS = {
  gaussian: {
    label: 'Gaussian Blur', group: 'Blur', params: [{ key: 'radius', label: 'Radius', min: 0.5, max: 100, step: 0.5, value: 4, px: true }],
    run: (c, p) => blurCanvas(c, p.radius),
  },
  motion: {
    label: 'Motion Blur', group: 'Blur', params: [{ key: 'angle', label: 'Angle', min: -180, max: 180, value: 0 }, { key: 'distance', label: 'Distance', min: 1, max: 300, value: 30, px: true }],
    run: (c, p) => {
      const a = (p.angle * Math.PI) / 180;
      const n = Math.min(64, Math.max(4, Math.ceil(p.distance / 2)));
      return smear(c, n, (o, t) => o.translate(Math.cos(a) * p.distance * t, -Math.sin(a) * p.distance * t));
    },
  },
  zoom: {
    label: 'Zoom Blur', group: 'Blur', params: [{ key: 'amount', label: 'Amount', min: 1, max: 60, value: 15 }, { key: 'cx', label: 'Centre across (%)', min: 0, max: 100, value: 50 }, { key: 'cy', label: 'Centre down (%)', min: 0, max: 100, value: 50 }],
    run: (c, p) => {
      const cx = (c.width * p.cx) / 100;
      const cy = (c.height * p.cy) / 100;
      return smear(c, 32, (o, t) => { const s = 1 + (t + 0.5) * (p.amount / 100); o.translate(cx, cy); o.scale(s, s); o.translate(-cx, -cy); });
    },
  },
  spin: {
    label: 'Spin Blur', group: 'Blur', params: [{ key: 'angle', label: 'Angle', min: 1, max: 45, value: 6 }],
    run: (c, p) => smear(c, 36, (o, t) => { o.translate(c.width / 2, c.height / 2); o.rotate((t * p.angle * Math.PI) / 180); o.translate(-c.width / 2, -c.height / 2); }),
  },
  tiltShift: {
    label: 'Tilt-Shift (miniature)', group: 'Blur',
    params: [{ key: 'focus', label: 'Sharp band at (%)', min: 0, max: 100, value: 55 }, { key: 'band', label: 'Band size (%)', min: 2, max: 80, value: 18 }, { key: 'blur', label: 'Blur', min: 1, max: 40, value: 10, px: true }, { key: 'pop', label: 'Colour pop', min: 0, max: 100, value: 30 }],
    run: (c, p) => {
      const blurred = blurCanvas(c, p.blur);
      const out = makeCanvas(c.width, c.height);
      const o = out.getContext('2d');
      o.drawImage(c, 0, 0);
      // Blur fades in above and below the sharp band.
      const m = makeCanvas(c.width, c.height);
      const mc = m.getContext('2d');
      const y = (c.height * p.focus) / 100;
      const half = (c.height * p.band) / 200;
      const fade = c.height * 0.18;
      const g = mc.createLinearGradient(0, 0, 0, c.height);
      const at = (v) => Math.min(1, Math.max(0, v / c.height));
      g.addColorStop(0, '#000');
      g.addColorStop(at(y - half - fade), '#000');
      g.addColorStop(at(y - half), 'rgba(0,0,0,0)');
      g.addColorStop(at(y + half), 'rgba(0,0,0,0)');
      g.addColorStop(at(y + half + fade), '#000');
      g.addColorStop(1, '#000');
      mc.fillStyle = g;
      mc.fillRect(0, 0, c.width, c.height);
      mc.globalCompositeOperation = 'source-in';
      mc.drawImage(blurred, 0, 0);
      o.drawImage(m, 0, 0);
      if (p.pop) { const s = 1 + p.pop / 100; const x = makeCanvas(c.width, c.height); const xc = x.getContext('2d'); xc.filter = `saturate(${s}) contrast(${1 + p.pop / 400})`; xc.drawImage(out, 0, 0); return x; }
      return out;
    },
  },
  unsharp: {
    label: 'Sharpen (Unsharp Mask)', group: 'Sharpen',
    params: [{ key: 'amount', label: 'Amount (%)', min: 1, max: 400, value: 80 }, { key: 'radius', label: 'Radius', min: 0.3, max: 30, step: 0.1, value: 1.5, px: true }, { key: 'threshold', label: 'Threshold', min: 0, max: 64, value: 2 }],
    run: (c, p) => {
      const o = read(c);
      const b = read(blurCanvas(c, p.radius)).data;
      const d = o.data;
      const k = p.amount / 100;
      for (let i = 0; i < d.length; i += 4) {
        for (let j = 0; j < 3; j++) {
          const diff = d[i + j] - b[i + j];
          if (Math.abs(diff) >= p.threshold) d[i + j] = clamp255(d[i + j] + diff * k);
        }
      }
      return fromData(o);
    },
  },
  clarity: {
    label: 'Clarity (local contrast)', group: 'Sharpen', params: [{ key: 'amount', label: 'Amount', min: -100, max: 100, value: 40 }],
    run: (c, p) => {
      const o = read(c);
      const b = read(blurCanvas(c, Math.max(8, Math.min(c.width, c.height) / 60))).data;
      const d = o.data;
      const k = p.amount / 100;
      for (let i = 0; i < d.length; i += 4) {
        // Strongest in the mid tones, like a darkroom's.
        const l = (d[i] + d[i + 1] + d[i + 2]) / 765;
        const w = k * (1 - Math.abs(l - 0.5) * 1.6);
        for (let j = 0; j < 3; j++) d[i + j] = clamp255(d[i + j] + (d[i + j] - b[i + j]) * w);
      }
      return fromData(o);
    },
  },
  noise: {
    label: 'Add Noise', group: 'Noise', params: [{ key: 'amount', label: 'Amount', min: 1, max: 100, value: 12 }, { key: 'mono', label: 'Monochrome', type: 'check', value: true }],
    run: (c, p) => {
      const o = read(c);
      const d = o.data;
      const a = p.amount * 1.6;
      for (let i = 0; i < d.length; i += 4) {
        // Two random numbers make a bell curve, which looks like film grain.
        const n = (Math.random() + Math.random() - 1) * a;
        if (p.mono) { d[i] = clamp255(d[i] + n); d[i + 1] = clamp255(d[i + 1] + n); d[i + 2] = clamp255(d[i + 2] + n); } else {
          d[i] = clamp255(d[i] + n);
          d[i + 1] = clamp255(d[i + 1] + (Math.random() + Math.random() - 1) * a);
          d[i + 2] = clamp255(d[i + 2] + (Math.random() + Math.random() - 1) * a);
        }
      }
      return fromData(o);
    },
  },
  denoise: {
    label: 'Reduce Noise', group: 'Noise', params: [{ key: 'strength', label: 'Strength', min: 1, max: 100, value: 40 }],
    run: (c, p) => {
      // Edge-aware smoothing: average with neighbours that look alike.
      const o = read(c);
      const src = new Uint8ClampedArray(o.data);
      const d = o.data;
      const w = c.width;
      const h = c.height;
      const sig = 6 + p.strength * 0.6;
      const inv = 1 / (2 * sig * sig);
      const R = 2;
      const wt = new Float32Array(766);
      for (let i = 0; i < wt.length; i++) wt[i] = Math.exp(-(i * i) / 3 * inv);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          let sr = 0; let sg = 0; let sb = 0; let sw = 0;
          for (let dy = -R; dy <= R; dy++) {
            const yy = y + dy;
            if (yy < 0 || yy >= h) continue;
            for (let dx = -R; dx <= R; dx++) {
              const xx = x + dx;
              if (xx < 0 || xx >= w) continue;
              const j = (yy * w + xx) * 4;
              const diff = Math.abs(src[j] - src[i]) + Math.abs(src[j + 1] - src[i + 1]) + Math.abs(src[j + 2] - src[i + 2]);
              const k = wt[diff];
              sr += src[j] * k; sg += src[j + 1] * k; sb += src[j + 2] * k; sw += k;
            }
          }
          d[i] = sr / sw; d[i + 1] = sg / sw; d[i + 2] = sb / sw;
        }
      }
      return fromData(o);
    },
  },
  pixelate: {
    label: 'Pixelate', group: 'Stylise', params: [{ key: 'size', label: 'Cell size', min: 2, max: 200, value: 12, px: true }],
    run: (c, p) => {
      const sw = Math.max(1, Math.round(c.width / p.size));
      const sh = Math.max(1, Math.round(c.height / p.size));
      const small = makeCanvas(sw, sh);
      const s = small.getContext('2d');
      s.imageSmoothingQuality = 'high';
      s.drawImage(c, 0, 0, sw, sh);
      const out = makeCanvas(c.width, c.height);
      const o = out.getContext('2d');
      o.imageSmoothingEnabled = false;
      o.drawImage(small, 0, 0, c.width, c.height);
      return out;
    },
  },
  oil: {
    label: 'Oil Painting', group: 'Artistic', params: [{ key: 'radius', label: 'Brush size', min: 1, max: 12, value: 4, px: true }],
    run: (c, p) => kuwahara(c, Math.max(1, Math.round(p.radius))),
  },
  sketch: {
    label: 'Pencil Sketch', group: 'Artistic', params: [{ key: 'radius', label: 'Line softness', min: 1, max: 30, value: 6, px: true }, { key: 'strength', label: 'Darkness', min: 0, max: 100, value: 40 }],
    run: (c, p) => {
      // Grey copy, dodged by its own blurred negative: what a pencil would trace.
      const gray = makeCanvas(c.width, c.height);
      const g = gray.getContext('2d');
      g.filter = 'grayscale(1)';
      g.drawImage(c, 0, 0);
      const inv = makeCanvas(c.width, c.height);
      const ic = inv.getContext('2d');
      ic.filter = 'invert(1)';
      ic.drawImage(gray, 0, 0);
      const blurred = blurCanvas(inv, p.radius);
      const out = makeCanvas(c.width, c.height);
      const o = out.getContext('2d');
      o.drawImage(gray, 0, 0);
      o.globalCompositeOperation = 'color-dodge';
      o.drawImage(blurred, 0, 0);
      if (p.strength) { o.globalCompositeOperation = 'multiply'; o.globalAlpha = p.strength / 100; o.drawImage(out, 0, 0); }
      return out;
    },
  },
  cartoon: {
    label: 'Cartoon', group: 'Artistic', params: [{ key: 'levels', label: 'Colours', min: 3, max: 12, value: 6 }, { key: 'lines', label: 'Ink lines', min: 0, max: 100, value: 60 }],
    run: (c, p) => {
      const smooth = FILTERS.denoise.run(c, { strength: 70 });
      const o = read(smooth);
      const d = o.data;
      const n = p.levels;
      for (let i = 0; i < d.length; i += 4) for (let j = 0; j < 3; j++) d[i + j] = Math.round(Math.round((d[i + j] / 255) * (n - 1)) * (255 / (n - 1)));
      const edges = read(sobel(c, true)).data;
      const k = p.lines / 100;
      for (let i = 0; i < d.length; i += 4) {
        const e = edges[i] / 255;
        const f = 1 - Math.min(1, e * 2.2) * k;
        d[i] *= f; d[i + 1] *= f; d[i + 2] *= f;
      }
      return fromData(o);
    },
  },
  emboss: {
    label: 'Emboss', group: 'Stylise', params: [{ key: 'strength', label: 'Strength', min: 1, max: 10, value: 2 }],
    run: (c, p) => convolve(c, [-2, -1, 0, -1, 1, 1, 0, 1, 2].map((v, i) => (i === 4 ? 1 : v * p.strength / 2)), 0, 0),
  },
  edges: {
    label: 'Find Edges', group: 'Stylise', params: [],
    run: (c) => sobel(c, false),
  },
  vignette: {
    label: 'Vignette', group: 'Light', params: [{ key: 'amount', label: 'Darkness', min: -100, max: 100, value: 45 }, { key: 'size', label: 'Clear centre', min: 0, max: 100, value: 45 }, { key: 'softness', label: 'Softness', min: 1, max: 100, value: 60 }],
    run: (c, p) => {
      const out = makeCanvas(c.width, c.height);
      const o = out.getContext('2d');
      o.drawImage(c, 0, 0);
      const r = Math.hypot(c.width, c.height) / 2;
      const inner = r * (p.size / 100) * 0.9;
      const outer = inner + r * (p.softness / 100) + 1;
      const g = o.createRadialGradient(c.width / 2, c.height / 2, inner, c.width / 2, c.height / 2, outer);
      const dark = p.amount >= 0;
      g.addColorStop(0, dark ? 'rgba(0,0,0,0)' : 'rgba(255,255,255,0)');
      g.addColorStop(1, dark ? `rgba(0,0,0,${p.amount / 100})` : `rgba(255,255,255,${-p.amount / 100})`);
      o.globalCompositeOperation = 'source-atop';
      o.fillStyle = g;
      o.fillRect(0, 0, c.width, c.height);
      return out;
    },
  },
  glow: {
    label: 'Soft Glow (dreamy)', group: 'Light', params: [{ key: 'radius', label: 'Glow size', min: 2, max: 80, value: 18, px: true }, { key: 'amount', label: 'Strength', min: 0, max: 100, value: 45 }],
    run: (c, p) => {
      const b = blurCanvas(c, p.radius);
      const out = makeCanvas(c.width, c.height);
      const o = out.getContext('2d');
      o.drawImage(c, 0, 0);
      o.globalAlpha = p.amount / 100;
      o.globalCompositeOperation = 'screen';
      o.drawImage(b, 0, 0);
      return out;
    },
  },
  grain: {
    label: 'Film Look', group: 'Light', params: [{ key: 'grain', label: 'Grain', min: 0, max: 60, value: 14 }, { key: 'fade', label: 'Faded blacks', min: 0, max: 60, value: 18 }, { key: 'warmth', label: 'Warmth', min: -40, max: 40, value: 10 }],
    run: (c, p) => {
      const o = read(c);
      const d = o.data;
      const lift = p.fade;
      const wr = 1 + p.warmth / 200;
      const wb = 1 - p.warmth / 200;
      for (let i = 0; i < d.length; i += 4) {
        const n = (Math.random() + Math.random() - 1) * p.grain;
        d[i] = clamp255(lift + (d[i] * wr) * (255 - lift) / 255 + n);
        d[i + 1] = clamp255(lift + d[i + 1] * (255 - lift) / 255 + n);
        d[i + 2] = clamp255(lift + (d[i + 2] * wb) * (255 - lift) / 255 + n);
      }
      return fromData(o);
    },
  },
};

// ---------------------------------------------------------------------------
// Building blocks
// ---------------------------------------------------------------------------
/** A 3×3 convolution. */
export function convolve(c, k, bias = 0, keepAlpha = 1) {
  const o = read(c);
  const src = new Uint8ClampedArray(o.data);
  const d = o.data;
  const w = c.width;
  const h = c.height;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      for (let ch = 0; ch < 3; ch++) {
        let s = bias;
        for (let ky = -1; ky <= 1; ky++) {
          const yy = Math.min(h - 1, Math.max(0, y + ky));
          for (let kx = -1; kx <= 1; kx++) {
            const xx = Math.min(w - 1, Math.max(0, x + kx));
            s += src[(yy * w + xx) * 4 + ch] * k[(ky + 1) * 3 + kx + 1];
          }
        }
        d[i + ch] = clamp255(s);
      }
      if (!keepAlpha) d[i + 3] = 255;
    }
  }
  return fromData(o);
}

/** Edge strength (white on black, or dark lines on white). */
export function sobel(c, raw = false) {
  const o = read(c);
  const w = c.width;
  const h = c.height;
  const src = o.data;
  const L = new Float32Array(w * h);
  for (let p = 0, i = 0; p < L.length; p++, i += 4) L[p] = 0.299 * src[i] + 0.587 * src[i + 1] + 0.114 * src[i + 2];
  const out = new ImageData(w, h);
  const d = out.data;
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - 1) * w; const y1 = y * w; const y2 = Math.min(h - 1, y + 1) * w;
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - 1); const x2 = Math.min(w - 1, x + 1);
      const gx = -L[y0 + x0] - 2 * L[y1 + x0] - L[y2 + x0] + L[y0 + x2] + 2 * L[y1 + x2] + L[y2 + x2];
      const gy = -L[y0 + x0] - 2 * L[y0 + x] - L[y0 + x2] + L[y2 + x0] + 2 * L[y2 + x] + L[y2 + x2];
      const m = Math.min(255, Math.hypot(gx, gy) / 2);
      const i = (y1 + x) * 4;
      const v = raw ? m : 255 - m;
      d[i] = d[i + 1] = d[i + 2] = v;
      d[i + 3] = src[i + 3];
    }
  }
  return fromData(out);
}

/** Kuwahara filter (oil paint): each pixel takes the calmest of its four corners' averages. */
function kuwahara(c, r) {
  const o = read(c);
  const w = c.width;
  const h = c.height;
  const d = o.data;
  // Summed-area tables make every box sum one lookup.
  const W = w + 1;
  const S = [new Float64Array(W * (h + 1)), new Float64Array(W * (h + 1)), new Float64Array(W * (h + 1))];
  const Q = new Float64Array(W * (h + 1));
  for (let y = 0; y < h; y++) {
    let r0 = 0; let r1 = 0; let r2 = 0; let q = 0;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4;
      r0 += d[i]; r1 += d[i + 1]; r2 += d[i + 2];
      const l = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      q += l * l;
      const k = (y + 1) * W + x + 1;
      S[0][k] = S[0][k - W] + r0; S[1][k] = S[1][k - W] + r1; S[2][k] = S[2][k - W] + r2; Q[k] = Q[k - W] + q;
    }
  }
  const box = (T, x0, y0, x1, y1) => T[y1 * W + x1] - T[y0 * W + x1] - T[y1 * W + x0] + T[y0 * W + x0];
  const out = new ImageData(w, h);
  const od = out.data;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let best = Infinity; let br = 0; let bg = 0; let bb = 0;
      for (const [ax, ay] of [[-r, -r], [0, -r], [-r, 0], [0, 0]]) {
        const x0 = Math.max(0, x + ax); const y0 = Math.max(0, y + ay);
        const x1 = Math.min(w, x + ax + r + 1); const y1 = Math.min(h, y + ay + r + 1);
        const n = (x1 - x0) * (y1 - y0);
        if (n <= 0) continue;
        const sr = box(S[0], x0, y0, x1, y1); const sg = box(S[1], x0, y0, x1, y1); const sb = box(S[2], x0, y0, x1, y1);
        const ml = (0.299 * sr + 0.587 * sg + 0.114 * sb) / n;
        const v = box(Q, x0, y0, x1, y1) / n - ml * ml;
        if (v < best) { best = v; br = sr / n; bg = sg / n; bb = sb / n; }
      }
      const i = (y * w + x) * 4;
      od[i] = br; od[i + 1] = bg; od[i + 2] = bb; od[i + 3] = d[i + 3];
    }
  }
  return fromData(out);
}

// ---------------------------------------------------------------------------
// Healing: fill a hole from its surroundings
// ---------------------------------------------------------------------------
/**
 * Fill the pixels where mask > 127 from the pixels around them. Works coarse
 * to fine (a pyramid), so big holes fill as fast as small ones, then adds a
 * little grain so the patch does not look plastic.
 */
export function inpaint(id, mask) {
  const w = id.width;
  const h = id.height;
  const levels = [];
  let cw = w; let ch = h;
  let cur = { w, h, rgb: new Float32Array(w * h * 3), known: new Uint8Array(w * h) };
  for (let p = 0, i = 0; p < w * h; p++, i += 4) {
    cur.rgb[p * 3] = id.data[i]; cur.rgb[p * 3 + 1] = id.data[i + 1]; cur.rgb[p * 3 + 2] = id.data[i + 2];
    cur.known[p] = mask[p] > 127 ? 0 : 1;
  }
  levels.push(cur);
  while (cw > 8 && ch > 8) {
    const nw = Math.ceil(cw / 2); const nh = Math.ceil(ch / 2);
    const nx = { w: nw, h: nh, rgb: new Float32Array(nw * nh * 3), known: new Uint8Array(nw * nh) };
    for (let y = 0; y < nh; y++) {
      for (let x = 0; x < nw; x++) {
        let n = 0; let r = 0; let g = 0; let b = 0;
        for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
          const xx = x * 2 + dx; const yy = y * 2 + dy;
          if (xx >= cw || yy >= ch) continue;
          const q = yy * cw + xx;
          if (!cur.known[q]) continue;
          r += cur.rgb[q * 3]; g += cur.rgb[q * 3 + 1]; b += cur.rgb[q * 3 + 2]; n++;
        }
        const q = y * nw + x;
        if (n) { nx.rgb[q * 3] = r / n; nx.rgb[q * 3 + 1] = g / n; nx.rgb[q * 3 + 2] = b / n; nx.known[q] = 1; }
      }
    }
    levels.push(nx);
    cur = nx; cw = nw; ch = nh;
  }
  // Fill the coarsest level by spreading known colours inwards.
  const relax = (L, iters, fixedKnown) => {
    const { w: lw, h: lh, rgb, known } = L;
    for (let it = 0; it < iters; it++) {
      for (let y = 0; y < lh; y++) {
        for (let x = 0; x < lw; x++) {
          const q = y * lw + x;
          if (fixedKnown[q]) continue;
          let n = 0; let r = 0; let g = 0; let b = 0;
          const add = (xx, yy) => { if (xx < 0 || yy < 0 || xx >= lw || yy >= lh) return; const k = yy * lw + xx; if (!known[k] && !fixedKnown[k]) return; r += rgb[k * 3]; g += rgb[k * 3 + 1]; b += rgb[k * 3 + 2]; n++; };
          add(x - 1, y); add(x + 1, y); add(x, y - 1); add(x, y + 1);
          if (n) { rgb[q * 3] = r / n; rgb[q * 3 + 1] = g / n; rgb[q * 3 + 2] = b / n; known[q] = 1; }
        }
      }
    }
  };
  const top = levels[levels.length - 1];
  const topFixed = top.known.slice();
  relax(top, top.w + top.h, topFixed);
  for (let l = levels.length - 2; l >= 0; l--) {
    const L = levels[l];
    const up = levels[l + 1];
    const fixed = L.known.slice();
    for (let y = 0; y < L.h; y++) {
      for (let x = 0; x < L.w; x++) {
        const q = y * L.w + x;
        if (fixed[q]) continue;
        const u = Math.min(up.h - 1, y >> 1) * up.w + Math.min(up.w - 1, x >> 1);
        L.rgb[q * 3] = up.rgb[u * 3]; L.rgb[q * 3 + 1] = up.rgb[u * 3 + 1]; L.rgb[q * 3 + 2] = up.rgb[u * 3 + 2];
        L.known[q] = 1;
      }
    }
    relax(L, 6, fixed);
  }
  // Local grain: match the noise of the ring around the hole.
  let sum = 0; let sum2 = 0; let n = 0;
  const base = levels[0];
  for (let p = 0, i = 0; p < w * h; p++, i += 4) {
    if (mask[p] > 127) continue;
    const near = (p % w > 0 && mask[p - 1] > 127) || (p % w < w - 1 && mask[p + 1] > 127) || (p >= w && mask[p - w] > 127) || (p < w * (h - 1) && mask[p + w] > 127);
    if (!near) continue;
    const v = 0.299 * id.data[i] + 0.587 * id.data[i + 1] + 0.114 * id.data[i + 2];
    sum += v; sum2 += v * v; n++;
  }
  const sd = n > 4 ? Math.min(18, Math.sqrt(Math.max(0, sum2 / n - (sum / n) ** 2)) * 0.35) : 0;
  for (let p = 0, i = 0; p < w * h; p++, i += 4) {
    const m = mask[p] / 255;
    if (m <= 0) continue;
    const g = (Math.random() + Math.random() - 1) * sd;
    id.data[i] = id.data[i] * (1 - m) + clamp255(base.rgb[p * 3] + g) * m;
    id.data[i + 1] = id.data[i + 1] * (1 - m) + clamp255(base.rgb[p * 3 + 1] + g) * m;
    id.data[i + 2] = id.data[i + 2] * (1 - m) + clamp255(base.rgb[p * 3 + 2] + g) * m;
    if (id.data[i + 3] < 255) id.data[i + 3] = id.data[i + 3] * (1 - m) + 255 * m;
  }
  return id;
}

// ---------------------------------------------------------------------------
// Background removal
// ---------------------------------------------------------------------------
/**
 * A mask (0-255 per pixel) that keeps the subject and drops the background,
 * for pictures with a fairly plain background: the background is whatever is
 * reachable from the edges without crossing a strong colour change.
 */
export function backgroundMask(c, tolerance = 40) {
  const w = c.width;
  const h = c.height;
  const d = read(c).data;
  // Background colours: sample the border.
  const samples = [];
  const step = Math.max(1, Math.floor((w + h) / 200));
  for (let x = 0; x < w; x += step) { samples.push((x) * 4, ((h - 1) * w + x) * 4); }
  for (let y = 0; y < h; y += step) { samples.push((y * w) * 4, (y * w + w - 1) * 4); }
  const cols = [];
  for (const i of samples) {
    const col = [d[i], d[i + 1], d[i + 2]];
    if (!cols.some((k) => Math.abs(k[0] - col[0]) + Math.abs(k[1] - col[1]) + Math.abs(k[2] - col[2]) < 24)) cols.push(col);
    if (cols.length > 24) break;
  }
  const tol = tolerance * 3;
  const nearBg = (p) => {
    const i = p * 4;
    if (d[i + 3] < 16) return true;
    for (const k of cols) if (Math.abs(d[i] - k[0]) + Math.abs(d[i + 1] - k[1]) + Math.abs(d[i + 2] - k[2]) <= tol) return true;
    return false;
  };
  const bg = new Uint8Array(w * h);
  const stack = [];
  const push = (p) => { if (!bg[p] && nearBg(p)) { bg[p] = 1; stack.push(p); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const p = stack.pop();
    const x = p % w;
    if (x > 0) push(p - 1);
    if (x < w - 1) push(p + 1);
    if (p >= w) push(p - w);
    if (p < w * (h - 1)) push(p + w);
  }
  // Soften the cut by a pixel or two.
  const m = makeCanvas(w, h);
  const mc = m.getContext('2d', { willReadFrequently: true });
  const id = mc.createImageData(w, h);
  for (let p = 0; p < w * h; p++) { id.data[p * 4] = id.data[p * 4 + 1] = id.data[p * 4 + 2] = 255; id.data[p * 4 + 3] = bg[p] ? 0 : 255; }
  mc.putImageData(id, 0, 0);
  const soft = makeCanvas(w, h);
  const sc = soft.getContext('2d', { willReadFrequently: true });
  sc.filter = `blur(${Math.max(0.6, Math.min(w, h) / 900)}px)`;
  sc.drawImage(m, 0, 0);
  return soft;
}
