// Colour and tone adjustments. Each works on ImageData in place, so the same
// code serves the Image > Adjustments dialogs and adjustment layers.
import { makeCanvas } from '../../kit/raster.js';

const clamp255 = (v) => (v < 0 ? 0 : v > 255 ? 255 : v);

/**
 * The adjustments, with the sliders their dialogs show. `params` keys match
 * the slider keys; `custom` ones (curves, levels) bring their own controls.
 */
export const ADJUSTMENTS = {
  brightness: {
    label: 'Brightness and Contrast',
    params: [{ key: 'brightness', label: 'Brightness', min: -150, max: 150, value: 0 }, { key: 'contrast', label: 'Contrast', min: -100, max: 100, value: 0 }],
  },
  levels: { label: 'Levels', custom: true, defaults: { black: 0, gamma: 1, white: 255, outBlack: 0, outWhite: 255, channel: 'rgb' } },
  curves: { label: 'Curves', custom: true, defaults: { rgb: [[0, 0], [255, 255]], r: [[0, 0], [255, 255]], g: [[0, 0], [255, 255]], b: [[0, 0], [255, 255]] } },
  exposure: {
    label: 'Exposure',
    params: [{ key: 'exposure', label: 'Exposure (stops)', min: -4, max: 4, step: 0.05, value: 0 }, { key: 'offset', label: 'Offset', min: -0.5, max: 0.5, step: 0.01, value: 0 }, { key: 'gamma', label: 'Gamma', min: 0.2, max: 3, step: 0.01, value: 1 }],
  },
  hsl: {
    label: 'Hue and Saturation',
    params: [{ key: 'hue', label: 'Hue', min: -180, max: 180, value: 0 }, { key: 'saturation', label: 'Saturation', min: -100, max: 100, value: 0 }, { key: 'lightness', label: 'Lightness', min: -100, max: 100, value: 0 }, { key: 'colorize', label: 'Colourise', type: 'check', value: false }],
  },
  vibrance: {
    label: 'Vibrance',
    params: [{ key: 'vibrance', label: 'Vibrance', min: -100, max: 100, value: 0 }, { key: 'saturation', label: 'Saturation', min: -100, max: 100, value: 0 }],
  },
  whiteBalance: {
    label: 'White Balance',
    params: [{ key: 'temperature', label: 'Temperature (cool ↔ warm)', min: -100, max: 100, value: 0 }, { key: 'tint', label: 'Tint (green ↔ magenta)', min: -100, max: 100, value: 0 }],
  },
  colorBalance: {
    label: 'Colour Balance',
    params: [{ key: 'range', label: 'Tones', type: 'select', options: [['shadows', 'Shadows'], ['midtones', 'Midtones'], ['highlights', 'Highlights']], value: 'midtones' },
      { key: 'cr', label: 'Cyan ↔ Red', min: -100, max: 100, value: 0 }, { key: 'mg', label: 'Magenta ↔ Green', min: -100, max: 100, value: 0 }, { key: 'yb', label: 'Yellow ↔ Blue', min: -100, max: 100, value: 0 }],
  },
  shadowsHighlights: {
    label: 'Shadows and Highlights',
    params: [{ key: 'shadows', label: 'Lift shadows', min: 0, max: 100, value: 35 }, { key: 'highlights', label: 'Recover highlights', min: 0, max: 100, value: 0 }, { key: 'radius', label: 'Radius', min: 2, max: 200, value: 30 }],
  },
  blackWhite: {
    label: 'Black and White',
    params: [{ key: 'reds', label: 'Reds', min: -100, max: 200, value: 40 }, { key: 'greens', label: 'Greens', min: -100, max: 200, value: 40 }, { key: 'blues', label: 'Blues', min: -100, max: 200, value: 20 },
      { key: 'tint', label: 'Tint colour', type: 'color', value: '' }],
  },
  photoFilter: {
    label: 'Photo Filter',
    params: [{ key: 'color', label: 'Colour', type: 'color', value: '#ec8a00' }, { key: 'density', label: 'Density', min: 0, max: 100, value: 25 }, { key: 'keepLight', label: 'Keep brightness', type: 'check', value: true }],
  },
  posterize: { label: 'Posterise', params: [{ key: 'levels', label: 'Levels', min: 2, max: 32, value: 6 }] },
  threshold: { label: 'Threshold', params: [{ key: 'level', label: 'Level', min: 1, max: 255, value: 128 }] },
  invert: { label: 'Invert', params: [] },
  desaturate: { label: 'Desaturate', params: [] },
};

export function defaultParams(kind) {
  const a = ADJUSTMENTS[kind];
  if (a.custom) return JSON.parse(JSON.stringify(a.defaults));
  return Object.fromEntries(a.params.map((p) => [p.key, p.value]));
}

/** A GPU canvas filter that does the same job, when there is one. */
export function cssFilterFor(kind, p) {
  if (kind === 'invert') return 'invert(1)';
  if (kind === 'desaturate') return 'grayscale(1)';
  if (kind === 'brightness' && !p.contrast) return null;
  return null;
}

// ---------------------------------------------------------------------------
// Tone curves as lookup tables
// ---------------------------------------------------------------------------
function lut(fn) {
  const t = new Uint8ClampedArray(256);
  for (let i = 0; i < 256; i++) t[i] = clamp255(Math.round(fn(i)));
  return t;
}

function levelsLut({ black = 0, gamma = 1, white = 255, outBlack = 0, outWhite = 255 }) {
  const span = Math.max(1, white - black);
  return lut((v) => {
    const x = Math.min(1, Math.max(0, (v - black) / span));
    return outBlack + Math.pow(x, 1 / gamma) * (outWhite - outBlack);
  });
}

/** A smooth curve through the points (monotone cubic, so it never overshoots). */
export function curveLut(points) {
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  if (pts.length < 2) return lut((v) => v);
  const n = pts.length;
  const xs = pts.map((p) => p[0]);
  const ys = pts.map((p) => p[1]);
  const d = [];
  const m = [];
  for (let i = 0; i < n - 1; i++) d.push((ys[i + 1] - ys[i]) / Math.max(1e-6, xs[i + 1] - xs[i]));
  m.push(d[0]);
  for (let i = 1; i < n - 1; i++) m.push(d[i - 1] * d[i] <= 0 ? 0 : (d[i - 1] + d[i]) / 2);
  m.push(d[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / d[i];
    const b = m[i + 1] / d[i];
    const s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
  }
  return lut((v) => {
    if (v <= xs[0]) return ys[0];
    if (v >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (v > xs[i + 1]) i++;
    const hgt = xs[i + 1] - xs[i];
    const t = (v - xs[i]) / hgt;
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * hgt * m[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * hgt * m[i + 1];
  });
}

function applyLuts(d, r, g, b) {
  for (let i = 0; i < d.length; i += 4) {
    d[i] = r[d[i]];
    d[i + 1] = g[d[i + 1]];
    d[i + 2] = b[d[i + 2]];
  }
}

// ---------------------------------------------------------------------------
// Colour space helpers
// ---------------------------------------------------------------------------
function rgbToHsl(r, g, b) {
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  const l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn;
  const s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  let hh;
  if (mx === r) hh = (g - b) / d + (g < b ? 6 : 0);
  else if (mx === g) hh = (b - r) / d + 2;
  else hh = (r - g) / d + 4;
  return [hh / 6, s, l];
}

function hue2rgb(p, q, t) {
  if (t < 0) t += 1;
  if (t > 1) t -= 1;
  if (t < 1 / 6) return p + (q - p) * 6 * t;
  if (t < 1 / 2) return q;
  if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
  return p;
}

function hslToRgb(hh, s, l) {
  if (s === 0) return [l, l, l];
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  return [hue2rgb(p, q, hh + 1 / 3), hue2rgb(p, q, hh), hue2rgb(p, q, hh - 1 / 3)];
}

const luma = (r, g, b) => 0.2126 * r + 0.7152 * g + 0.0722 * b;

function parseHex(c) {
  const m = /^#?([0-9a-f]{6})$/i.exec(c || '');
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** A blurred copy of the picture's brightness (for local tone work). */
function blurredLuma(id, radius) {
  const { width: w, height: h, data: d } = id;
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  const g = ctx.createImageData(w, h);
  for (let i = 0; i < d.length; i += 4) {
    const v = luma(d[i], d[i + 1], d[i + 2]);
    g.data[i] = g.data[i + 1] = g.data[i + 2] = v;
    g.data[i + 3] = 255;
  }
  ctx.putImageData(g, 0, 0);
  const b = makeCanvas(w, h);
  const bctx = b.getContext('2d', { willReadFrequently: true });
  // Outside the picture is transparent, so the edges average only real pixels.
  bctx.filter = `blur(${radius}px)`;
  bctx.drawImage(c, 0, 0);
  bctx.filter = 'none';
  const out = bctx.getImageData(0, 0, w, h).data;
  const res = new Uint8ClampedArray(w * h);
  for (let p = 0, i = 0; p < res.length; p++, i += 4) res[p] = out[i];
  return res;
}

// ---------------------------------------------------------------------------
// Applying one
// ---------------------------------------------------------------------------
export function applyAdjustment(id, kind, p = {}) {
  const d = id.data;
  switch (kind) {
    case 'brightness': {
      const b = p.brightness || 0;
      const c = (p.contrast || 0) / 100;
      const k = c >= 0 ? 1 / Math.max(0.01, 1 - c) : 1 + c;
      const t = lut((v) => (v + b * (b > 0 ? (255 - v) / 255 : v / 255) - 128) * k + 128);
      applyLuts(d, t, t, t);
      break;
    }
    case 'levels': {
      const t = levelsLut(p);
      const id1 = lut((v) => v);
      const ch = p.channel || 'rgb';
      applyLuts(d, ch === 'rgb' || ch === 'r' ? t : id1, ch === 'rgb' || ch === 'g' ? t : id1, ch === 'rgb' || ch === 'b' ? t : id1);
      break;
    }
    case 'curves': {
      const m = curveLut(p.rgb || [[0, 0], [255, 255]]);
      const r = curveLut(p.r || [[0, 0], [255, 255]]);
      const g = curveLut(p.g || [[0, 0], [255, 255]]);
      const b = curveLut(p.b || [[0, 0], [255, 255]]);
      applyLuts(d, lut((v) => m[r[v]]), lut((v) => m[g[v]]), lut((v) => m[b[v]]));
      break;
    }
    case 'exposure': {
      const mul = Math.pow(2, p.exposure || 0);
      const off = p.offset || 0;
      const gam = p.gamma || 1;
      // Work in linear light so exposure behaves like a camera's.
      const t = lut((v) => {
        let x = Math.pow(v / 255, 2.2) * mul + off;
        x = Math.max(0, x);
        return Math.pow(Math.min(1, x), 1 / (2.2 * gam)) * 255;
      });
      applyLuts(d, t, t, t);
      break;
    }
    case 'hsl': {
      const dh = (p.hue || 0) / 360;
      const ds = (p.saturation || 0) / 100;
      const dl = (p.lightness || 0) / 100;
      for (let i = 0; i < d.length; i += 4) {
        let [hh, s, l] = rgbToHsl(d[i] / 255, d[i + 1] / 255, d[i + 2] / 255);
        if (p.colorize) { hh = ((p.hue || 0) + 360) % 360 / 360; s = Math.max(0, 0.25 + ds * 0.75); } else {
          hh = (hh + dh + 1) % 1;
          s = ds >= 0 ? s + (1 - s) * ds * s : s * (1 + ds);
        }
        l = dl >= 0 ? l + (1 - l) * dl : l * (1 + dl);
        const [r, g, b] = hslToRgb(hh, Math.min(1, Math.max(0, s)), l);
        d[i] = r * 255; d[i + 1] = g * 255; d[i + 2] = b * 255;
      }
      break;
    }
    case 'vibrance': {
      const vib = (p.vibrance || 0) / 100;
      const sat = (p.saturation || 0) / 100;
      for (let i = 0; i < d.length; i += 4) {
        const r = d[i]; const g = d[i + 1]; const b = d[i + 2];
        const avg = (r + g + b) / 3;
        // Vibrance boosts dull colours more than strong ones (and spares skin a little).
        const amt = vib * (1 - (Math.max(r, g, b) - Math.min(r, g, b)) / 255) * (r > g && g > b ? 0.6 : 1) + sat;
        d[i] = clamp255(avg + (r - avg) * (1 + amt));
        d[i + 1] = clamp255(avg + (g - avg) * (1 + amt));
        d[i + 2] = clamp255(avg + (b - avg) * (1 + amt));
      }
      break;
    }
    case 'whiteBalance': {
      const t = (p.temperature || 0) / 100;
      const n = (p.tint || 0) / 100;
      const rm = 1 + t * 0.25 + n * 0.08;
      const gm = 1 - n * 0.18;
      const bm = 1 - t * 0.25 + n * 0.08;
      const R = lut((v) => v * rm); const G = lut((v) => v * gm); const B = lut((v) => v * bm);
      applyLuts(d, R, G, B);
      break;
    }
    case 'colorBalance': {
      const cr = (p.cr || 0) / 100 * 60;
      const mg = (p.mg || 0) / 100 * 60;
      const yb = (p.yb || 0) / 100 * 60;
      // How much each tone range is affected at a given brightness.
      const weight = (l) => {
        if (p.range === 'shadows') return Math.max(0, 1 - l / 128);
        if (p.range === 'highlights') return Math.max(0, (l - 128) / 127);
        return 1 - Math.abs(l - 128) / 128;
      };
      const W = new Float32Array(256);
      for (let i = 0; i < 256; i++) W[i] = weight(i);
      for (let i = 0; i < d.length; i += 4) {
        const w = W[Math.round(luma(d[i], d[i + 1], d[i + 2]))];
        d[i] = clamp255(d[i] + cr * w);
        d[i + 1] = clamp255(d[i + 1] + mg * w);
        d[i + 2] = clamp255(d[i + 2] + yb * w);
      }
      break;
    }
    case 'shadowsHighlights': {
      const sh = (p.shadows || 0) / 100;
      const hl = (p.highlights || 0) / 100;
      const base = blurredLuma(id, Math.max(1, p.radius || 30));
      for (let i = 0, q = 0; i < d.length; i += 4, q++) {
        const L = base[q] / 255;
        // Lift where the neighbourhood is dark, pull down where it is bright.
        const gain = 1 + sh * 1.6 * Math.pow(1 - L, 2) - hl * 0.6 * Math.pow(L, 2);
        d[i] = clamp255(d[i] * gain);
        d[i + 1] = clamp255(d[i + 1] * gain);
        d[i + 2] = clamp255(d[i + 2] * gain);
      }
      break;
    }
    case 'blackWhite': {
      const wr = (p.reds ?? 40) / 100; const wg = (p.greens ?? 40) / 100; const wb = (p.blues ?? 20) / 100;
      const sum = Math.max(0.05, wr + wg + wb);
      const tint = parseHex(p.tint);
      for (let i = 0; i < d.length; i += 4) {
        const v = clamp255((d[i] * wr + d[i + 1] * wg + d[i + 2] * wb) / sum);
        if (tint) {
          // Tinted like a print: the tint shows most in the mid tones.
          const k = (v / 255) * (1 - v / 255) * 1.2;
          d[i] = clamp255(v + (tint[0] - 128) * k);
          d[i + 1] = clamp255(v + (tint[1] - 128) * k);
          d[i + 2] = clamp255(v + (tint[2] - 128) * k);
        } else d[i] = d[i + 1] = d[i + 2] = v;
      }
      break;
    }
    case 'photoFilter': {
      const c = parseHex(p.color) || [236, 138, 0];
      const k = (p.density ?? 25) / 100;
      for (let i = 0; i < d.length; i += 4) {
        const l0 = luma(d[i], d[i + 1], d[i + 2]);
        let r = d[i] * (1 - k) + (d[i] * c[0] / 255) * k * 2;
        let g = d[i + 1] * (1 - k) + (d[i + 1] * c[1] / 255) * k * 2;
        let b = d[i + 2] * (1 - k) + (d[i + 2] * c[2] / 255) * k * 2;
        if (p.keepLight !== false) {
          const l1 = luma(r, g, b) || 1;
          const s = l0 / l1;
          r *= s; g *= s; b *= s;
        }
        d[i] = clamp255(r); d[i + 1] = clamp255(g); d[i + 2] = clamp255(b);
      }
      break;
    }
    case 'posterize': {
      const n = Math.max(2, p.levels || 6);
      const t = lut((v) => Math.round(Math.round((v / 255) * (n - 1)) * (255 / (n - 1))));
      applyLuts(d, t, t, t);
      break;
    }
    case 'threshold': {
      const lv = p.level ?? 128;
      for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = luma(d[i], d[i + 1], d[i + 2]) >= lv ? 255 : 0;
      break;
    }
    case 'invert': {
      const t = lut((v) => 255 - v);
      applyLuts(d, t, t, t);
      break;
    }
    case 'desaturate': {
      for (let i = 0; i < d.length; i += 4) d[i] = d[i + 1] = d[i + 2] = luma(d[i], d[i + 1], d[i + 2]);
      break;
    }
    default: break;
  }
  return id;
}

// ---------------------------------------------------------------------------
// Automatic fixes
// ---------------------------------------------------------------------------
export function histogram(id) {
  const d = id.data;
  const r = new Uint32Array(256); const g = new Uint32Array(256); const b = new Uint32Array(256); const l = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 8) continue;
    r[d[i]]++; g[d[i + 1]]++; b[d[i + 2]]++;
    l[Math.round(luma(d[i], d[i + 1], d[i + 2]))]++;
  }
  return { r, g, b, l };
}

function clipPoints(hist, clip = 0.001) {
  let total = 0;
  for (let i = 0; i < 256; i++) total += hist[i];
  const cut = total * clip;
  let lo = 0; let hi = 255; let acc = 0;
  for (; lo < 255; lo++) { acc += hist[lo]; if (acc > cut) break; }
  acc = 0;
  for (; hi > 0; hi--) { acc += hist[hi]; if (acc > cut) break; }
  return [lo, Math.max(lo + 1, hi)];
}

/** Settings for the automatic fixes, worked out from the picture. */
export function autoParams(id, kind) {
  const hst = histogram(id);
  if (kind === 'contrast') {
    const [lo, hi] = clipPoints(hst.l, 0.003);
    return { levels: { black: lo, white: hi, gamma: 1, outBlack: 0, outWhite: 255 } };
  }
  // Tone and colour: stretch each channel on its own (fixes colour casts too).
  const [rl, rh] = clipPoints(hst.r, 0.002);
  const [gl, gh] = clipPoints(hst.g, 0.002);
  const [bl, bh] = clipPoints(hst.b, 0.002);
  return { channels: [[rl, rh], [gl, gh], [bl, bh]] };
}

export function autoFix(id, kind) {
  const d = id.data;
  if (kind === 'contrast') {
    applyAdjustment(id, 'levels', autoParams(id, 'contrast').levels);
    return id;
  }
  const { channels } = autoParams(id, 'tone');
  const tabs = channels.map(([lo, hi]) => levelsLut({ black: lo, white: hi }));
  applyLuts(d, tabs[0], tabs[1], tabs[2]);
  if (kind === 'enhance') {
    // A touch of brightness balance and vibrance, like a phone's auto button.
    const hst = histogram(id);
    let n = 0; let sum = 0;
    for (let i = 0; i < 256; i++) { n += hst.l[i]; sum += hst.l[i] * i; }
    const mean = n ? sum / n : 128;
    const gamma = Math.min(1.6, Math.max(0.7, Math.log(0.5) / Math.log(Math.max(0.05, mean / 255))));
    applyAdjustment(id, 'levels', { black: 0, white: 255, gamma: 1 + (gamma - 1) * 0.6 });
    applyAdjustment(id, 'vibrance', { vibrance: 18, saturation: 0 });
  }
  return id;
}
