// Animated GIF writer: each frame gets its own 255-colour palette (median cut), and what
// did not change since the frame before becomes transparent, so screen recordings stay
// small. Used by the Screen Recorder and the Converter (in the browser).
//
//   const gif = new GifEncoder(w, h);
//   gif.addFrame(rgba, delayInHundredths);   // rgba: Uint8ClampedArray of w*h*4
//   const bytes = gif.finish();

const TRANSPARENT = 255;

export class GifEncoder {
  constructor(width, height, { loop = 0 } = {}) {
    this.w = width;
    this.h = height;
    this.out = new ByteWriter();
    this.prev = null; // the previous frame's 15-bit colours
    const o = this.out;
    o.str('GIF89a');
    o.u16(width);
    o.u16(height);
    o.byte(0x70); // no global colour table, 8 bits of colour resolution
    o.byte(0);
    o.byte(0);
    // Loop forever (or `loop` times).
    o.bytes([0x21, 0xff, 0x0b]);
    o.str('NETSCAPE2.0');
    o.bytes([0x03, 0x01]);
    o.u16(loop);
    o.byte(0);
  }

  addFrame(rgba, delay = 10) {
    const n = this.w * this.h;
    const c15 = new Uint16Array(n);
    for (let i = 0, p = 0; i < n; i++, p += 4) c15[i] = ((rgba[p] >> 3) << 10) | ((rgba[p + 1] >> 3) << 5) | (rgba[p + 2] >> 3);
    const palette = medianCut(c15, 255);
    const map = nearestMap(c15, palette);
    const idx = new Uint8Array(n);
    const prev = this.prev;
    for (let i = 0; i < n; i++) idx[i] = prev && prev[i] === c15[i] ? TRANSPARENT : map[c15[i]];
    this.prev = c15;

    const o = this.out;
    // Graphic control: delay, keep the frame below, index 255 transparent (after the first frame).
    o.bytes([0x21, 0xf9, 0x04, (1 << 2) | (prev ? 1 : 0)]);
    o.u16(Math.max(2, Math.round(delay)));
    o.byte(TRANSPARENT);
    o.byte(0);
    // Image with a local 256-entry colour table.
    o.byte(0x2c);
    o.u16(0);
    o.u16(0);
    o.u16(this.w);
    o.u16(this.h);
    o.byte(0x87);
    for (let i = 0; i < 256; i++) {
      const c = palette[i] ?? 0;
      o.bytes([((c >> 10) & 31) * 255 / 31 | 0, ((c >> 5) & 31) * 255 / 31 | 0, (c & 31) * 255 / 31 | 0]);
    }
    lzw(idx, 8, o);
  }

  finish() {
    this.out.byte(0x3b);
    return this.out.result();
  }
}

class ByteWriter {
  constructor() { this.buf = new Uint8Array(1 << 16); this.len = 0; }
  grow(k) {
    if (this.len + k <= this.buf.length) return;
    let size = this.buf.length * 2;
    while (size < this.len + k) size *= 2;
    const b = new Uint8Array(size);
    b.set(this.buf.subarray(0, this.len));
    this.buf = b;
  }
  byte(v) { this.grow(1); this.buf[this.len++] = v & 255; }
  bytes(a) { this.grow(a.length); for (const v of a) this.buf[this.len++] = v & 255; }
  u16(v) { this.byte(v); this.byte(v >> 8); }
  str(s) { for (const ch of s) this.byte(ch.charCodeAt(0)); }
  result() { return this.buf.slice(0, this.len); }
}

/** Up to `count` 15-bit colours that stand for the frame's colours (median cut). */
function medianCut(c15, count) {
  const hist = new Uint32Array(32768);
  for (let i = 0; i < c15.length; i++) hist[c15[i]]++;
  const colours = [];
  for (let c = 0; c < 32768; c++) if (hist[c]) colours.push(c);
  if (colours.length <= count) return colours;
  const ch = (c, k) => (c >> (10 - 5 * k)) & 31; // k: 0 red, 1 green, 2 blue
  const box = (list) => {
    let lo = [31, 31, 31];
    let hi = [0, 0, 0];
    let weight = 0;
    for (const c of list) {
      for (let k = 0; k < 3; k++) { const v = ch(c, k); if (v < lo[k]) lo[k] = v; if (v > hi[k]) hi[k] = v; }
      weight += hist[c];
    }
    const span = [hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]];
    const axis = span.indexOf(Math.max(...span));
    return { list, axis, span: span[axis], weight };
  };
  const boxes = [box(colours)];
  while (boxes.length < count) {
    // Split the box with the most pixels that still has room to split.
    let best = -1;
    for (let i = 0; i < boxes.length; i++) if (boxes[i].span > 0 && (best < 0 || boxes[i].weight * boxes[i].span > boxes[best].weight * boxes[best].span)) best = i;
    if (best < 0) break;
    const b = boxes[best];
    b.list.sort((x, y) => ch(x, b.axis) - ch(y, b.axis));
    let acc = 0;
    let cut = 1;
    for (let i = 0; i < b.list.length - 1; i++) { acc += hist[b.list[i]]; if (acc >= b.weight / 2) { cut = i + 1; break; } }
    boxes.splice(best, 1, box(b.list.slice(0, cut)), box(b.list.slice(cut)));
  }
  return boxes.map((b) => {
    let r = 0; let g = 0; let bl = 0; let w = 0;
    for (const c of b.list) { const k = hist[c]; r += ch(c, 0) * k; g += ch(c, 1) * k; bl += ch(c, 2) * k; w += k; }
    return (Math.round(r / w) << 10) | (Math.round(g / w) << 5) | Math.round(bl / w);
  });
}

/** For every colour used, the nearest palette entry. */
function nearestMap(c15, palette) {
  const map = new Uint8Array(32768);
  const seen = new Uint8Array(32768);
  const pr = palette.map((c) => (c >> 10) & 31);
  const pg = palette.map((c) => (c >> 5) & 31);
  const pb = palette.map((c) => c & 31);
  for (let i = 0; i < c15.length; i++) {
    const c = c15[i];
    if (seen[c]) continue;
    seen[c] = 1;
    const r = (c >> 10) & 31; const g = (c >> 5) & 31; const b = c & 31;
    let best = 0;
    let bd = Infinity;
    for (let k = 0; k < palette.length; k++) {
      const d = (r - pr[k]) ** 2 * 3 + (g - pg[k]) ** 2 * 4 + (b - pb[k]) ** 2 * 2;
      if (d < bd) { bd = d; best = k; if (!d) break; }
    }
    map[c] = best;
  }
  return map;
}

/** GIF's LZW, in sub-blocks of at most 255 bytes. */
function lzw(indices, minSize, out) {
  out.byte(minSize);
  const clear = 1 << minSize;
  const eoi = clear + 1;
  let size = minSize + 1;
  let next = eoi + 1;
  let dict = new Map();
  let block = [];
  let acc = 0;
  let bits = 0;
  const flush = () => { if (block.length) { out.byte(block.length); out.bytes(block); block = []; } };
  const emit = (code) => {
    acc |= code << bits;
    bits += size;
    while (bits >= 8) {
      block.push(acc & 255);
      acc >>>= 8;
      bits -= 8;
      if (block.length === 255) flush();
    }
  };
  emit(clear);
  let prefix = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const k = indices[i];
    const key = prefix * 256 + k;
    const hit = dict.get(key);
    if (hit !== undefined) { prefix = hit; continue; }
    emit(prefix);
    if (next < 4096) {
      dict.set(key, next++);
      if (next > (1 << size) && size < 12) size++;
    } else {
      emit(clear);
      dict = new Map();
      next = eoi + 1;
      size = minSize + 1;
    }
    prefix = k;
  }
  emit(prefix);
  emit(eoi);
  if (bits > 0) block.push(acc & 255);
  flush();
  out.byte(0);
}
