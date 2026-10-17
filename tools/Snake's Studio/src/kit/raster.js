// Pixel work shared by Paint and Photo: flood fill, magic wand masks, image
// transforms, and file encoders (PNG/JPEG/WebP through the browser, BMP our own).

import { isTiff, readTiff } from './tiff.js';

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

export function ctx2d(c, opts = {}) {
  return c.getContext('2d', { willReadFrequently: !!opts.read });
}

export function cloneCanvas(src) {
  const c = makeCanvas(src.width, src.height);
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}

/** RGBA of a CSS colour, as numbers 0-255. */
export function rgba(css) {
  const c = document.createElement('canvas').getContext('2d');
  c.fillStyle = '#000';
  c.fillStyle = css;
  const s = c.fillStyle;
  if (s.startsWith('#')) return [parseInt(s.slice(1, 3), 16), parseInt(s.slice(3, 5), 16), parseInt(s.slice(5, 7), 16), 255];
  const m = /rgba?\(([^)]+)\)/.exec(s);
  if (!m) return [0, 0, 0, 255];
  const p = m[1].split(',').map((x) => parseFloat(x));
  return [p[0], p[1], p[2], p[3] === undefined ? 255 : Math.round(p[3] * 255)];
}

/**
 * Which pixels a flood fill (or magic wand) reaches from (x, y): a mask of
 * 0/1 bytes. Scanline fill, so large areas are quick.
 */
export function floodMask(data, w, h, x, y, tolerance = 32, contiguous = true) {
  x = Math.floor(x);
  y = Math.floor(y);
  const mask = new Uint8Array(w * h);
  if (x < 0 || y < 0 || x >= w || y >= h) return mask;
  const i0 = (y * w + x) * 4;
  const r0 = data[i0]; const g0 = data[i0 + 1]; const b0 = data[i0 + 2]; const a0 = data[i0 + 3];
  const tol = tolerance * tolerance * 4;
  const same = (p) => {
    const i = p * 4;
    const dr = data[i] - r0; const dg = data[i + 1] - g0; const db = data[i + 2] - b0; const da = data[i + 3] - a0;
    return dr * dr + dg * dg + db * db + da * da <= tol;
  };
  if (!contiguous) {
    for (let p = 0; p < w * h; p++) if (same(p)) mask[p] = 1;
    return mask;
  }
  const stack = [x, y];
  while (stack.length) {
    const sy = stack.pop();
    let sx = stack.pop();
    let p = sy * w + sx;
    while (sx >= 0 && !mask[p] && same(p)) { sx--; p--; }
    sx++; p++;
    let up = false;
    let down = false;
    while (sx < w && !mask[p] && same(p)) {
      mask[p] = 1;
      if (sy > 0) {
        const q = p - w;
        if (!mask[q] && same(q)) { if (!up) { stack.push(sx, sy - 1); up = true; } } else up = false;
      }
      if (sy < h - 1) {
        const q = p + w;
        if (!mask[q] && same(q)) { if (!down) { stack.push(sx, sy + 1); down = true; } } else down = false;
      }
      sx++; p++;
    }
  }
  return mask;
}

/** Paint a colour into the pixels of a mask (with soft edges into neighbours). */
export function fillMask(imageData, mask, color, opacity = 1) {
  const d = imageData.data;
  const [r, g, b, a] = color;
  const alpha = (a / 255) * opacity;
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue;
    const i = p * 4;
    d[i] = d[i] + (r - d[i]) * alpha;
    d[i + 1] = d[i + 1] + (g - d[i + 1]) * alpha;
    d[i + 2] = d[i + 2] + (b - d[i + 2]) * alpha;
    d[i + 3] = Math.min(255, d[i + 3] + (255 - d[i + 3]) * alpha);
  }
  return imageData;
}

/** Bounding box of a mask: { x, y, w, h } or null. */
export function maskBounds(mask, w, h) {
  let x0 = w; let y0 = h; let x1 = -1; let y1 = -1;
  for (let y = 0; y < h; y++) {
    const row = y * w;
    for (let x = 0; x < w; x++) {
      if (!mask[row + x]) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  return x1 < 0 ? null : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** A canvas showing a mask as white-on-transparent (for drawing outlines and clipping). */
export function maskCanvas(mask, w, h) {
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  const id = ctx.createImageData(w, h);
  for (let p = 0; p < mask.length; p++) if (mask[p]) { id.data[p * 4 + 3] = 255; id.data[p * 4] = id.data[p * 4 + 1] = id.data[p * 4 + 2] = 255; }
  ctx.putImageData(id, 0, 0);
  return c;
}

/** Outline of a mask as a list of edge segments (for marching ants). */
export function maskEdges(mask, w, h, step = 1) {
  const segs = [];
  for (let y = 0; y < h; y += step) {
    for (let x = 0; x < w; x += step) {
      if (!mask[y * w + x]) continue;
      if (y === 0 || !mask[(y - step) * w + x]) segs.push(x, y, x + step, y);
      if (y + step >= h || !mask[(y + step) * w + x]) segs.push(x, y + step, x + step, y + step);
      if (x === 0 || !mask[y * w + x - step]) segs.push(x, y, x, y + step);
      if (x + step >= w || !mask[y * w + x + step]) segs.push(x + step, y, x + step, y + step);
    }
  }
  return segs;
}

// ---------------------------------------------------------------------------
// Transforms
// ---------------------------------------------------------------------------
export function rotated(src, deg) {
  const swap = Math.abs(deg) % 180 === 90;
  const c = makeCanvas(swap ? src.height : src.width, swap ? src.width : src.height);
  const ctx = c.getContext('2d');
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((deg * Math.PI) / 180);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

export function rotatedAny(src, deg, background = null) {
  const rad = (deg * Math.PI) / 180;
  const w = Math.abs(src.width * Math.cos(rad)) + Math.abs(src.height * Math.sin(rad));
  const hh = Math.abs(src.width * Math.sin(rad)) + Math.abs(src.height * Math.cos(rad));
  const c = makeCanvas(w, hh);
  const ctx = c.getContext('2d');
  if (background) { ctx.fillStyle = background; ctx.fillRect(0, 0, c.width, c.height); }
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate(rad);
  ctx.drawImage(src, -src.width / 2, -src.height / 2);
  return c;
}

export function flipped(src, horizontal) {
  const c = makeCanvas(src.width, src.height);
  const ctx = c.getContext('2d');
  if (horizontal) { ctx.translate(c.width, 0); ctx.scale(-1, 1); } else { ctx.translate(0, c.height); ctx.scale(1, -1); }
  ctx.drawImage(src, 0, 0);
  return c;
}

export function resized(src, w, h, smooth = true) {
  // Halve in steps for sharp downscales.
  let cur = src;
  let cw = src.width;
  let ch = src.height;
  if (smooth) {
    while (cw / 2 > w && ch / 2 > h) {
      cw = Math.round(cw / 2);
      ch = Math.round(ch / 2);
      const step = makeCanvas(cw, ch);
      const sctx = step.getContext('2d');
      sctx.imageSmoothingQuality = 'high';
      sctx.drawImage(cur, 0, 0, cw, ch);
      cur = step;
    }
  }
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d');
  ctx.imageSmoothingEnabled = smooth;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(cur, 0, 0, w, h);
  return c;
}

export function cropped(src, x, y, w, h) {
  const c = makeCanvas(w, h);
  c.getContext('2d').drawImage(src, -x, -y);
  return c;
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------
export async function canvasBytes(canvas, type = 'image/png', quality = 0.92) {
  if (type === 'image/bmp') return encodeBMP(canvas);
  const blob = await new Promise((res) => canvas.toBlob(res, type, quality));
  if (!blob) throw new Error('This picture could not be saved in that format.');
  return new Uint8Array(await blob.arrayBuffer());
}

/** 32-bit BMP with alpha (BITMAPV4HEADER), which Windows and every viewer reads. */
export function encodeBMP(canvas) {
  const w = canvas.width;
  const h = canvas.height;
  const px = canvas.getContext('2d').getImageData(0, 0, w, h).data;
  const header = 14 + 108;
  const size = header + w * h * 4;
  const buf = new ArrayBuffer(size);
  const dv = new DataView(buf);
  dv.setUint8(0, 0x42); dv.setUint8(1, 0x4d);
  dv.setUint32(2, size, true);
  dv.setUint32(10, header, true);
  dv.setUint32(14, 108, true);
  dv.setInt32(18, w, true);
  dv.setInt32(22, -h, true); // top-down
  dv.setUint16(26, 1, true);
  dv.setUint16(28, 32, true);
  dv.setUint32(30, 3, true); // BI_BITFIELDS
  dv.setUint32(34, w * h * 4, true);
  dv.setUint32(38, 2835, true);
  dv.setUint32(42, 2835, true);
  dv.setUint32(54, 0x00ff0000, true);
  dv.setUint32(58, 0x0000ff00, true);
  dv.setUint32(62, 0x000000ff, true);
  dv.setUint32(66, 0xff000000, true);
  dv.setUint32(70, 0x57696e20, true); // 'Win '
  const out = new Uint8Array(buf);
  let o = header;
  for (let i = 0; i < px.length; i += 4) {
    out[o++] = px[i + 2];
    out[o++] = px[i + 1];
    out[o++] = px[i];
    out[o++] = px[i + 3];
  }
  return out;
}

/** Decode any picture file the browser understands (and TIFF, read here) into a canvas. */
export async function decodeImage(bytes, type = '') {
  if (isTiff(bytes)) {
    const t = await readTiff(bytes);
    const c = makeCanvas(t.width, t.height);
    c.getContext('2d').putImageData(new ImageData(t.data, t.width, t.height), 0, 0);
    return c;
  }
  const heif = bytes.length > 12 && /^ftyp(heic|heix|hevc|hevx|heim|heis|mif1|msf1)/.test(String.fromCharCode(...bytes.slice(4, 12)));
  if (heif) {
    // HEIC (iPhone photos): the system decodes it where it can (iPhone, iPad, Mac Safari).
    try { return await decodeWithBrowser(new Blob([bytes], { type: 'image/heic' })); } catch {
      throw new Error('This HEIC photo cannot be decoded here. On an iPhone or Mac it opens directly; elsewhere, export it from Photos as JPEG (or set the iPhone camera to "Most Compatible").');
    }
  }
  const blob = new Blob([bytes], { type });
  if (type === 'image/svg+xml' || (!type && new TextDecoder().decode(bytes.slice(0, 200)).includes('<svg'))) {
    // SVG is drawn as a picture (no scripts run in <img>), at its own size.
    const url = URL.createObjectURL(new Blob([bytes], { type: 'image/svg+xml' }));
    try {
      const img = new Image();
      img.src = url;
      await img.decode();
      const c = makeCanvas(img.naturalWidth || 1024, img.naturalHeight || 768);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      return c;
    } finally { URL.revokeObjectURL(url); }
  }
  return decodeWithBrowser(blob);
}

async function decodeWithBrowser(blob) {
  const bmp = await createImageBitmap(blob);
  const c = makeCanvas(bmp.width, bmp.height);
  c.getContext('2d').drawImage(bmp, 0, 0);
  bmp.close();
  return c;
}

export const IMAGE_TYPES = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', bmp: 'image/bmp', gif: 'image/gif', avif: 'image/avif', svg: 'image/svg+xml', ico: 'image/x-icon',
  tif: 'image/tiff', tiff: 'image/tiff', heic: 'image/heic', heif: 'image/heif',
};

/** A checkerboard pattern for transparent areas. */
export function checkerPattern(ctx, size = 8, dark = false) {
  const c = makeCanvas(size * 2, size * 2);
  const g = c.getContext('2d');
  g.fillStyle = dark ? '#2b2f2c' : '#ffffff';
  g.fillRect(0, 0, size * 2, size * 2);
  g.fillStyle = dark ? '#353a36' : '#d9ded9';
  g.fillRect(0, 0, size, size);
  g.fillRect(size, size, size, size);
  return ctx.createPattern(c, 'repeat');
}
