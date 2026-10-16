// Photoshop .psd files: layers (pixels, names, opacity, blend mode, visibility,
// masks) in and out. Groups are flattened into plain layers on reading, keeping
// a hidden group's layers hidden. 8-bit RGB, greyscale and CMYK are read; we
// always write 8-bit RGB with RLE compression, like Photoshop itself.
import { makeCanvas } from '../../kit/raster.js';

const BLEND_KEYS = {
  norm: 'normal', mul: 'multiply', scrn: 'screen', over: 'overlay', sLit: 'soft-light', hLit: 'hard-light', dark: 'darken', lite: 'lighten',
  div: 'color-dodge', idiv: 'color-burn', lddg: 'add', diff: 'difference', smud: 'exclusion', hue: 'hue', sat: 'saturation', colr: 'color', lum: 'luminosity',
};
const KEY_OF = Object.fromEntries(Object.entries(BLEND_KEYS).map(([k, v]) => [v, k.padEnd(4, ' ')]));

class Reader {
  constructor(bytes) { this.b = bytes; this.v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength); this.p = 0; }
  u8() { return this.b[this.p++]; }
  u16() { const v = this.v.getUint16(this.p); this.p += 2; return v; }
  i16() { const v = this.v.getInt16(this.p); this.p += 2; return v; }
  u32() { const v = this.v.getUint32(this.p); this.p += 4; return v; }
  i32() { const v = this.v.getInt32(this.p); this.p += 4; return v; }
  str(n) { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(this.b[this.p + i]); this.p += n; return s; }
  bytes(n) { const s = this.b.subarray(this.p, this.p + n); this.p += n; return s; }
}

/** PackBits, the run-length code PSD uses for each row. */
function unpackRow(src, out, outOff, count) {
  let i = 0;
  let o = outOff;
  const end = outOff + count;
  while (i < src.length && o < end) {
    const n = src[i] > 127 ? src[i] - 256 : src[i];
    i++;
    if (n >= 0) { for (let k = 0; k <= n && o < end; k++) out[o++] = src[i++]; } else if (n !== -128) {
      const v = src[i++];
      for (let k = 0; k < 1 - n && o < end; k++) out[o++] = v;
    }
  }
}

async function inflateZlib(bytes) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate')));
  return new Uint8Array(await out.arrayBuffer());
}

/** One channel's pixels, whatever its compression. */
async function readChannel(r, comp, w, h, size, depth) {
  const bpc = depth / 8;
  const rowBytes = w * bpc;
  const out = new Uint8Array(w * h * bpc);
  if (comp === 0) {
    out.set(r.bytes(Math.min(size, out.length)));
  } else if (comp === 1) {
    const counts = [];
    for (let y = 0; y < h; y++) counts.push(r.u16());
    for (let y = 0; y < h; y++) unpackRow(r.bytes(counts[y]), out, y * rowBytes, rowBytes);
  } else if (comp === 2 || comp === 3) {
    const raw = await inflateZlib(r.bytes(size));
    out.set(raw.subarray(0, out.length));
    if (comp === 3) {
      // Each byte (or 16-bit value) was stored as the difference from its left neighbour.
      for (let y = 0; y < h; y++) {
        const row = y * rowBytes;
        if (bpc === 1) for (let x = 1; x < w; x++) out[row + x] = (out[row + x] + out[row + x - 1]) & 255;
        else for (let x = 1; x < w; x++) {
          const prev = (out[row + (x - 1) * 2] << 8) | out[row + (x - 1) * 2 + 1];
          const cur = ((out[row + x * 2] << 8) | out[row + x * 2 + 1]) + prev & 0xffff;
          out[row + x * 2] = cur >> 8; out[row + x * 2 + 1] = cur & 255;
        }
      }
    }
  } else throw new Error('This PSD uses a compression we cannot read.');
  if (bpc === 1) return out;
  // 16-bit: keep the high byte.
  const o8 = new Uint8Array(w * h);
  for (let i = 0; i < o8.length; i++) o8[i] = out[i * 2];
  return o8;
}

function toCanvas(w, h, chans, mode) {
  const c = makeCanvas(w, h);
  if (!w || !h) return c;
  const ctx = c.getContext('2d');
  const id = ctx.createImageData(w, h);
  const d = id.data;
  const a = chans[-1];
  for (let p = 0, i = 0; p < w * h; p++, i += 4) {
    if (mode === 1) { d[i] = d[i + 1] = d[i + 2] = chans[0] ? chans[0][p] : 0; } else if (mode === 4) {
      // CMYK is stored inverted (255 = no ink).
      const k = chans[3] ? chans[3][p] : 255;
      d[i] = ((chans[0] ? chans[0][p] : 255) * k) / 255;
      d[i + 1] = ((chans[1] ? chans[1][p] : 255) * k) / 255;
      d[i + 2] = ((chans[2] ? chans[2][p] : 255) * k) / 255;
    } else { d[i] = chans[0] ? chans[0][p] : 0; d[i + 1] = chans[1] ? chans[1][p] : 0; d[i + 2] = chans[2] ? chans[2][p] : 0; }
    d[i + 3] = a ? a[p] : 255;
  }
  ctx.putImageData(id, 0, 0);
  return c;
}

export async function readPsd(bytes) {
  const r = new Reader(bytes);
  if (r.str(4) !== '8BPS') throw new Error('This is not a Photoshop file.');
  const version = r.u16();
  if (version !== 1) throw new Error('Large Photoshop documents (.psb) are not supported yet.');
  r.p += 6;
  const channels = r.u16();
  const height = r.u32();
  const width = r.u32();
  const depth = r.u16();
  const mode = r.u16();
  if (![8, 16].includes(depth)) throw new Error(`${depth}-bit Photoshop files are not supported.`);
  if (![1, 3, 4].includes(mode)) throw new Error('Only RGB, greyscale and CMYK Photoshop files can be opened.');
  if (width * height > 16384 * 16384) throw new Error('This picture is too big.');
  r.p += 4 + r.v.getUint32(r.p); // colour mode data
  r.p += 4 + r.v.getUint32(r.p); // image resources
  const lmLen = r.u32();
  const lmEnd = r.p + lmLen;
  const layers = [];
  if (lmLen > 0) {
    const liLen = r.u32();
    const liEnd = r.p + liLen;
    if (liLen > 0) {
      const count = Math.abs(r.i16());
      const recs = [];
      for (let n = 0; n < count; n++) {
        const rec = { top: r.i32(), left: r.i32(), bottom: r.i32(), right: r.i32(), channels: [] };
        const nch = r.u16();
        for (let c = 0; c < nch; c++) rec.channels.push({ id: r.i16(), len: r.u32() });
        r.p += 4; // '8BIM'
        rec.blend = r.str(4).trim();
        rec.opacity = r.u8() / 255;
        rec.clipping = r.u8();
        rec.flags = r.u8();
        r.p += 1;
        const extraLen = r.u32();
        const extraEnd = r.p + extraLen;
        const maskLen = r.u32();
        const maskEnd = r.p + maskLen;
        if (maskLen >= 20) {
          rec.mask = { top: r.i32(), left: r.i32(), bottom: r.i32(), right: r.i32(), color: r.u8(), flags: r.u8() };
        }
        r.p = maskEnd;
        r.p += 4 + r.v.getUint32(r.p); // blending ranges
        const nameLen = r.u8();
        rec.name = new TextDecoder('latin1').decode(r.bytes(nameLen));
        r.p += (4 - ((nameLen + 1) % 4)) % 4;
        while (r.p + 12 <= extraEnd) {
          const sig = r.str(4);
          if (sig !== '8BIM' && sig !== '8B64') { r.p -= 3; continue; }
          const key = r.str(4);
          const len = r.u32();
          const start = r.p;
          if (key === 'luni') {
            const n = r.u32();
            let s = '';
            for (let i = 0; i < n; i++) s += String.fromCharCode(r.u16());
            rec.name = s.replace(/\0+$/, '');
          } else if (key === 'lsct' || key === 'lsdk') rec.section = r.u32();
          r.p = start + len;
        }
        r.p = extraEnd;
        recs.push(rec);
      }
      // Pixel data follows, in the same order.
      for (const rec of recs) {
        const w = rec.right - rec.left;
        const h = rec.bottom - rec.top;
        const chans = {};
        for (const ch of rec.channels) {
          const start = r.p;
          const comp = r.u16();
          const isMask = ch.id === -2 || ch.id === -3;
          const cw = isMask && rec.mask ? rec.mask.right - rec.mask.left : w;
          const chh = isMask && rec.mask ? rec.mask.bottom - rec.mask.top : h;
          if (cw > 0 && chh > 0 && ch.len > 2) chans[ch.id] = await readChannel(r, comp, cw, chh, ch.len - 2, depth);
          r.p = start + ch.len;
        }
        rec.chans = chans;
      }
      r.p = liEnd;
      // Bottom to top in the file; groups open with a marker and close with the group's own record.
      const groupStack = [];
      for (const rec of recs) {
        if (rec.section === 3) { groupStack.push([]); continue; }
        if (rec.section === 1 || rec.section === 2) {
          const kids = groupStack.pop() || [];
          const hidden = (rec.flags & 2) !== 0;
          for (const L of kids) {
            if (hidden) L.visible = false;
            L.opacity *= rec.opacity;
          }
          if (groupStack.length) groupStack[groupStack.length - 1].push(...kids);
          continue;
        }
        const w = rec.right - rec.left;
        const h = rec.bottom - rec.top;
        const L = {
          name: rec.name || 'Layer', x: rec.left, y: rec.top, opacity: rec.opacity, visible: (rec.flags & 2) === 0,
          blend: BLEND_KEYS[rec.blend] || 'normal', canvas: toCanvas(Math.max(1, w), Math.max(1, h), rec.chans, mode), mask: null,
        };
        const m = rec.chans[-2];
        if (m && rec.mask) {
          // Our masks share the layer's frame: paint the PSD mask into it.
          const mc = makeCanvas(L.canvas.width, L.canvas.height);
          const mctx = mc.getContext('2d');
          mctx.fillStyle = rec.mask.color ? '#fff' : 'rgba(255,255,255,0)';
          mctx.fillRect(0, 0, mc.width, mc.height);
          const mw = rec.mask.right - rec.mask.left;
          const mh = rec.mask.bottom - rec.mask.top;
          const tmp = makeCanvas(mw, mh);
          const tctx = tmp.getContext('2d');
          const id = tctx.createImageData(mw, mh);
          for (let p = 0; p < mw * mh; p++) { const i = p * 4; id.data[i] = id.data[i + 1] = id.data[i + 2] = 255; id.data[i + 3] = m[p]; }
          tctx.putImageData(id, 0, 0);
          mctx.clearRect(rec.mask.left - rec.left, rec.mask.top - rec.top, mw, mh);
          mctx.drawImage(tmp, rec.mask.left - rec.left, rec.mask.top - rec.top);
          L.mask = mc;
          L.maskOn = (rec.mask.flags & 2) === 0;
        }
        if (groupStack.length) groupStack[groupStack.length - 1].push(L);
        layers.push(L);
      }
    }
  }
  r.p = lmEnd;
  // The flattened picture, used when there are no layers.
  let composite = null;
  try {
    const comp = r.u16();
    const chans = {};
    const n = Math.min(channels, mode === 4 ? 5 : mode === 1 ? 2 : 4);
    if (comp === 1) {
      const counts = [];
      for (let i = 0; i < channels * height; i++) counts.push(r.u16());
      const rowBytes = width * (depth / 8);
      for (let c = 0; c < channels; c++) {
        const out = new Uint8Array(rowBytes * height);
        for (let y = 0; y < height; y++) unpackRow(r.bytes(counts[c * height + y]), out, y * rowBytes, rowBytes);
        if (c < n) chans[c] = depth === 16 ? out.filter((_, i) => i % 2 === 0) : out;
      }
    } else if (comp === 0) {
      for (let c = 0; c < channels; c++) {
        const out = r.bytes(width * height * (depth / 8));
        if (c < n) chans[c] = depth === 16 ? out.filter((_, i) => i % 2 === 0) : out;
      }
    }
    const alphaIndex = mode === 4 ? 4 : mode === 1 ? 1 : 3;
    if (chans[alphaIndex]) { chans[-1] = chans[alphaIndex]; }
    if (chans[0]) composite = toCanvas(width, height, chans, mode);
  } catch { composite = null; }
  if (!layers.length && composite) layers.push({ name: 'Background', x: 0, y: 0, opacity: 1, visible: true, blend: 'normal', canvas: composite, mask: null });
  if (!layers.length) throw new Error('This Photoshop file has no picture we can read.');
  return { width, height, layers };
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------
class Writer {
  constructor() { this.parts = []; this.len = 0; }
  push(a) { this.parts.push(a); this.len += a.length; }
  u8(v) { this.push(Uint8Array.of(v & 255)); }
  u16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v); this.push(b); }
  i16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setInt16(0, v); this.push(b); }
  u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v); this.push(b); }
  i32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setInt32(0, v); this.push(b); }
  str(s) { this.push(Uint8Array.from(s, (ch) => ch.charCodeAt(0) & 255)); }
  bytes() { const out = new Uint8Array(this.len); let p = 0; for (const a of this.parts) { out.set(a, p); p += a.length; } return out; }
}

function packRow(src, start, n) {
  const out = [];
  let i = 0;
  while (i < n) {
    let run = 1;
    while (i + run < n && run < 128 && src[start + i + run] === src[start + i]) run++;
    if (run >= 3) { out.push(257 - run & 255, src[start + i]); i += run; continue; }
    let lit = 0;
    while (i + lit < n && lit < 128) {
      if (i + lit + 2 < n && src[start + i + lit] === src[start + i + lit + 1] && src[start + i + lit] === src[start + i + lit + 2]) break;
      lit++;
    }
    out.push(lit - 1);
    for (let k = 0; k < lit; k++) out.push(src[start + i + k]);
    i += lit;
  }
  return out;
}

/** RLE-compressed channel: [compression=1][row counts][rows]. */
function rleChannel(plane, w, h, withCompression = true) {
  const rows = [];
  for (let y = 0; y < h; y++) rows.push(packRow(plane, y * w, w));
  const size = (withCompression ? 2 : 0) + h * 2 + rows.reduce((n, r) => n + r.length, 0);
  const out = new Uint8Array(size);
  const dv = new DataView(out.buffer);
  let p = 0;
  if (withCompression) { dv.setUint16(0, 1); p = 2; }
  for (const r of rows) { dv.setUint16(p, r.length); p += 2; }
  for (const r of rows) { out.set(r, p); p += r.length; }
  return { out, rows };
}

function planes(canvas) {
  const w = canvas.width;
  const h = canvas.height;
  const d = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, w, h).data;
  const P = [new Uint8Array(w * h), new Uint8Array(w * h), new Uint8Array(w * h), new Uint8Array(w * h)];
  for (let p = 0, i = 0; p < w * h; p++, i += 4) { P[0][p] = d[i]; P[1][p] = d[i + 1]; P[2][p] = d[i + 2]; P[3][p] = d[i + 3]; }
  return P;
}

/**
 * layers: [{ name, canvas, x, y, opacity, visible, blend, mask (canvas, same frame) | null, maskOn }], bottom first.
 * composite: the flattened picture.
 */
export function writePsd({ width, height, layers, composite }) {
  const w = new Writer();
  w.str('8BPS'); w.u16(1); w.push(new Uint8Array(6));
  w.u16(4); w.u32(height); w.u32(width); w.u16(8); w.u16(3);
  w.u32(0); // colour mode data
  w.u32(0); // image resources
  // Layer records and their pixels.
  const li = new Writer();
  li.i16(-layers.length);
  const data = new Writer();
  for (const L of layers) {
    const cw = L.canvas.width;
    const chh = L.canvas.height;
    const P = planes(L.canvas);
    const chans = [[-1, P[3]], [0, P[0]], [1, P[1]], [2, P[2]]];
    if (L.mask) chans.push([-2, planes(L.mask)[3]]);
    const packed = chans.map(([id, plane]) => [id, rleChannel(plane, cw, chh).out]);
    li.i32(L.y); li.i32(L.x); li.i32(L.y + chh); li.i32(L.x + cw);
    li.u16(packed.length);
    for (const [id, out] of packed) { li.i16(id); li.u32(out.length); }
    li.str('8BIM'); li.str(KEY_OF[L.blend] || 'norm');
    li.u8(Math.round((L.opacity ?? 1) * 255)); li.u8(0); li.u8(L.visible === false ? 2 : 0); li.u8(0);
    const extra = new Writer();
    if (L.mask) {
      extra.u32(20);
      extra.i32(L.y); extra.i32(L.x); extra.i32(L.y + chh); extra.i32(L.x + cw);
      extra.u8(0); extra.u8(L.maskOn === false ? 2 : 0); extra.u16(0);
    } else extra.u32(0);
    extra.u32(0); // blending ranges
    const name = String(L.name || 'Layer');
    const latin = Array.from(name.slice(0, 255), (ch) => (ch.charCodeAt(0) < 256 ? ch : '?')).join('');
    extra.u8(latin.length); extra.str(latin);
    const pad = (4 - ((latin.length + 1) % 4)) % 4;
    extra.push(new Uint8Array(pad));
    // The real (Unicode) name.
    extra.str('8BIM'); extra.str('luni');
    const ulen = 4 + name.length * 2;
    const upad = (4 - (ulen % 4)) % 4;
    extra.u32(ulen + upad); extra.u32(name.length);
    for (let i = 0; i < name.length; i++) extra.u16(name.charCodeAt(i));
    extra.push(new Uint8Array(upad));
    const eb = extra.bytes();
    li.u32(eb.length); li.push(eb);
    for (const [, out] of packed) data.push(out);
  }
  li.push(data.bytes());
  let liBytes = li.bytes();
  if (liBytes.length % 4) { const pad = new Uint8Array(liBytes.length + (4 - (liBytes.length % 4))); pad.set(liBytes); liBytes = pad; }
  w.u32(4 + liBytes.length + 4);
  w.u32(liBytes.length); w.push(liBytes);
  w.u32(0); // global layer mask info
  // The flattened picture.
  const P = planes(composite);
  const rle = P.map((plane) => rleChannel(plane, width, height, false));
  w.u16(1);
  for (const { out } of rle) w.push(out.subarray(0, height * 2));
  for (const { out } of rle) w.push(out.subarray(height * 2));
  return w.bytes();
}
