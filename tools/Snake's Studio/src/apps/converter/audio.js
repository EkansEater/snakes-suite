// Sound for the browser Converter: decode with the browser, then write WAV, FLAC (our
// own encoder, lossless) or Opus in an Ogg file (the browser's Opus encoder, where it
// has one). MP3 and AAC need the desktop or Android Converter.

/**
 * The sample rate written in a WAV, FLAC, MP3 or Ogg file's header (null: unknown). The
 * browser decodes at whatever rate it is asked for, so "keep the rate" has to look.
 */
export function sniffRate(b) {
  const at = (s, o = 0) => [...s].every((ch, i) => b[o + i] === ch.charCodeAt(0));
  const u32le = (o) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24);
  if (at('RIFF') && at('WAVE', 8)) {
    for (let o = 12; o + 8 < b.length;) { const size = u32le(o + 4) >>> 0; if (at('fmt ', o)) return u32le(o + 12) >>> 0; o += 8 + size + (size & 1); }
  }
  if (at('fLaC')) return ((b[18] << 12) | (b[19] << 4) | (b[20] >> 4)) >>> 0;
  if (at('OggS')) {
    const seg = b[26];
    const p = 27 + seg;
    if (at('OpusHead', p)) return 48000;
    if (b[p] === 1 && at('vorbis', p + 1)) return u32le(p + 12) >>> 0;
    if (at('\x7fFLAC', p)) return ((b[p + 27] << 12) | (b[p + 28] << 4) | (b[p + 29] >> 4)) >>> 0;
  }
  // MP3: skip an ID3 tag, then read the first frame header (only in a file that starts like one).
  let o = 0;
  if (at('ID3')) o = 10 + ((b[6] & 127) << 21 | (b[7] & 127) << 14 | (b[8] & 127) << 7 | (b[9] & 127));
  else if (!(b[0] === 0xff && (b[1] & 0xe0) === 0xe0)) return null;
  for (const end = Math.min(b.length - 4, o + 4096); o < end; o++) {
    if (b[o] !== 0xff || (b[o + 1] & 0xe0) !== 0xe0) continue;
    const ver = (b[o + 1] >> 3) & 3;
    const idx = (b[o + 2] >> 2) & 3;
    if (ver === 1 || idx === 3 || ((b[o + 1] >> 1) & 3) === 0) continue;
    const base = [44100, 48000, 32000][idx];
    return ver === 3 ? base : ver === 2 ? base / 2 : base / 4;
  }
  return null;
}

/** Decode a sound (or a video's soundtrack) and bring it to `rate` and `channels` (0: keep). */
export async function decodeAudio(bytes, { rate = 0, channels = 0 } = {}) {
  const probe = new OfflineAudioContext(1, 1, rate || sniffRate(bytes) || 48000);
  let buf;
  try {
    buf = await probe.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  } catch {
    throw new Error('This browser cannot read the sound in this file.');
  }
  const r = rate || buf.sampleRate;
  const ch = channels || buf.numberOfChannels;
  if (r === buf.sampleRate && ch === buf.numberOfChannels) return buf;
  const ctx = new OfflineAudioContext(ch, Math.max(1, Math.ceil(buf.duration * r)), r);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.start();
  return ctx.startRendering();
}

const toInt16 = (x) => (x <= -1 ? -32768 : x >= 1 ? 32767 : Math.round(x * 32767));

// ---------------------------------------------------------------------------
// WAV
// ---------------------------------------------------------------------------
export function encodeWav(buf) {
  const ch = buf.numberOfChannels;
  const n = buf.length;
  const out = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const str = (o, s) => { for (let i = 0; i < s.length; i++) out.setUint8(o + i, s.charCodeAt(i)); };
  str(0, 'RIFF'); out.setUint32(4, 36 + n * ch * 2, true); str(8, 'WAVE');
  str(12, 'fmt '); out.setUint32(16, 16, true); out.setUint16(20, 1, true); out.setUint16(22, ch, true);
  out.setUint32(24, buf.sampleRate, true); out.setUint32(28, buf.sampleRate * ch * 2, true); out.setUint16(32, ch * 2, true); out.setUint16(34, 16, true);
  str(36, 'data'); out.setUint32(40, n * ch * 2, true);
  const data = [...Array(ch)].map((_, c) => buf.getChannelData(c));
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) { out.setInt16(o, toInt16(data[c][i]), true); o += 2; }
  return new Uint8Array(out.buffer);
}

// ---------------------------------------------------------------------------
// FLAC: 16-bit, fixed predictors (orders 0-4), Rice-coded residuals, partitioned
// ---------------------------------------------------------------------------
class Bits {
  constructor() { this.buf = new Uint8Array(1 << 16); this.len = 0; this.acc = 0; this.n = 0; }
  grow() { const b = new Uint8Array(this.buf.length * 2); b.set(this.buf); this.buf = b; }
  put(v, bits) {
    // Up to 32 bits at a time, most significant first.
    for (let i = bits - 1; i >= 0; i--) {
      this.acc = (this.acc << 1) | ((v / 2 ** i) & 1);
      if (++this.n === 8) { if (this.len === this.buf.length) this.grow(); this.buf[this.len++] = this.acc; this.acc = 0; this.n = 0; }
    }
  }
  unary(q) { for (let i = 0; i < q; i++) this.put(0, 1); this.put(1, 1); }
  align() { while (this.n) this.put(0, 1); }
  bytes() { return this.buf.subarray(0, this.len); }
}

function crc8(b, from, to) {
  let c = 0;
  for (let i = from; i < to; i++) { c ^= b[i]; for (let k = 0; k < 8; k++) c = c & 0x80 ? ((c << 1) ^ 0x07) & 255 : (c << 1) & 255; }
  return c;
}
function crc16(b, from, to) {
  let c = 0;
  for (let i = from; i < to; i++) { c ^= b[i] << 8; for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x8005) & 0xffff : (c << 1) & 0xffff; }
  return c;
}

/** Residual of fixed predictor `order` (samples before the warm-up are not used). */
function residual(x, order) {
  const n = x.length;
  const r = new Int32Array(n - order);
  for (let i = order; i < n; i++) {
    let p = 0;
    if (order === 1) p = x[i - 1];
    else if (order === 2) p = 2 * x[i - 1] - x[i - 2];
    else if (order === 3) p = 3 * x[i - 1] - 3 * x[i - 2] + x[i - 3];
    else if (order === 4) p = 4 * x[i - 1] - 6 * x[i - 2] + 4 * x[i - 3] - x[i - 4];
    r[i - order] = x[i] - p;
  }
  return r;
}
const zig = (v) => (v >= 0 ? v * 2 : -v * 2 - 1);

/** The cheapest Rice parameter for a run of residuals, and its cost in bits. */
function riceOf(r, from, to) {
  let sum = 0;
  for (let i = from; i < to; i++) sum += zig(r[i]);
  const n = to - from;
  let k = 0;
  while (k < 14 && (n << (k + 1)) < sum) k++;
  let bits = 0;
  for (let i = from; i < to; i++) bits += (zig(r[i]) >>> k) + 1 + k;
  return { k, bits };
}

function subframe(out, x, sampleBits) {
  const n = x.length;
  // Silence: one constant.
  if (x.every((v) => v === x[0])) { out.put(0, 1); out.put(0, 6); out.put(0, 1); out.put(x[0] & 0xffff, sampleBits); return; }
  let best = null;
  for (let order = 0; order <= Math.min(4, n - 1); order++) {
    const r = residual(x, order);
    for (let po = 0; po <= 4; po++) {
      const parts = 1 << po;
      if (n % parts || n / parts <= order) break;
      let bits = 0;
      const ks = [];
      for (let p = 0; p < parts; p++) {
        const from = p === 0 ? 0 : p * (n / parts) - order;
        const to = (p + 1) * (n / parts) - order;
        const { k, bits: b } = riceOf(r, from, to);
        ks.push(k);
        bits += b + 4;
      }
      if (!best || bits < best.bits) best = { order, po, ks, r, bits };
    }
  }
  if (best.bits >= n * sampleBits) { // verbatim is smaller
    out.put(0, 1); out.put(1, 6); out.put(0, 1);
    for (const v of x) out.put(v & 0xffff, sampleBits);
    return;
  }
  out.put(0, 1); out.put(8 | best.order, 6); out.put(0, 1);
  for (let i = 0; i < best.order; i++) out.put(x[i] & 0xffff, sampleBits);
  out.put(0, 2); // Rice, 4-bit parameters
  out.put(best.po, 4);
  const parts = 1 << best.po;
  for (let p = 0; p < parts; p++) {
    const from = p === 0 ? 0 : p * (n / parts) - best.order;
    const to = (p + 1) * (n / parts) - best.order;
    const k = best.ks[p];
    out.put(k, 4);
    for (let i = from; i < to; i++) {
      const z = zig(best.r[i]);
      out.unary(z >>> k);
      if (k) out.put(z & ((1 << k) - 1), k);
    }
  }
}

export async function encodeFlac(buf, progress = () => {}) {
  const ch = Math.min(8, buf.numberOfChannels);
  const rate = buf.sampleRate;
  const total = buf.length;
  const block = 4096;
  const data = [...Array(ch)].map((_, c) => buf.getChannelData(c));
  const frames = [];
  for (let start = 0, f = 0; start < total; start += block, f++) {
    const n = Math.min(block, total - start);
    const out = new Bits();
    out.put(0x3ffe, 14); out.put(0, 1); out.put(0, 1); // sync, reserved, fixed block size
    out.put(7, 4); // block size: 16-bit value at the end of the header
    out.put(0, 4); // sample rate: from STREAMINFO
    out.put(ch - 1, 4); // independent channels
    out.put(4, 3); // 16 bits per sample
    out.put(0, 1);
    // Frame number, UTF-8 style.
    if (f < 0x80) out.put(f, 8);
    else if (f < 0x800) { out.put(0xc0 | (f >> 6), 8); out.put(0x80 | (f & 63), 8); }
    else if (f < 0x10000) { out.put(0xe0 | (f >> 12), 8); out.put(0x80 | ((f >> 6) & 63), 8); out.put(0x80 | (f & 63), 8); }
    else { out.put(0xf0 | (f >> 18), 8); out.put(0x80 | ((f >> 12) & 63), 8); out.put(0x80 | ((f >> 6) & 63), 8); out.put(0x80 | (f & 63), 8); }
    out.put(n - 1, 16);
    out.put(crc8(out.buf, 0, out.len), 8);
    for (let c = 0; c < ch; c++) {
      const x = new Int32Array(n);
      for (let i = 0; i < n; i++) x[i] = toInt16(data[c][start + i]);
      subframe(out, x, 16);
    }
    out.align();
    const crc = crc16(out.buf, 0, out.len);
    out.put(crc, 16);
    frames.push(out.bytes().slice());
    if (f % 32 === 0) { progress(start / total); await new Promise((r) => setTimeout(r, 0)); }
  }
  // STREAMINFO (the MD5 left zero: allowed, means "not computed").
  const head = new Bits();
  head.put(0x664c6143, 32); // "fLaC"
  head.put(1, 1); head.put(0, 7); head.put(34, 24);
  head.put(block, 16); head.put(block, 16);
  head.put(0, 24); head.put(0, 24);
  head.put(rate, 20); head.put(ch - 1, 3); head.put(15, 5);
  head.put(Math.floor(total / 2 ** 32), 4); head.put(total % 2 ** 32, 32);
  for (let i = 0; i < 16; i++) head.put(0, 8);
  const parts = [head.bytes(), ...frames];
  const size = parts.reduce((a, p) => a + p.length, 0);
  const file = new Uint8Array(size);
  let o = 0;
  for (const p of parts) { file.set(p, o); o += p.length; }
  return file;
}

// ---------------------------------------------------------------------------
// Opus in Ogg, with the browser's encoder (WebCodecs)
// ---------------------------------------------------------------------------
export async function canOpus() {
  if (typeof AudioEncoder === 'undefined') return false;
  try {
    const r = await AudioEncoder.isConfigSupported({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate: 128000 });
    return !!r.supported;
  } catch { return false; }
}

const OGG_CRC = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) { let r = i << 24; for (let k = 0; k < 8; k++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1; t[i] = r >>> 0; }
  return t;
})();
function oggPage(packets, { serial, seq, granule, first = false, last = false }) {
  const segs = [];
  for (const p of packets) { let n = p.length; while (n >= 255) { segs.push(255); n -= 255; } segs.push(n); }
  const body = packets.reduce((a, p) => a + p.length, 0);
  const page = new Uint8Array(27 + segs.length + body);
  const dv = new DataView(page.buffer);
  page.set([0x4f, 0x67, 0x67, 0x53], 0); // OggS
  page[5] = (first ? 2 : 0) | (last ? 4 : 0);
  dv.setUint32(6, granule % 2 ** 32, true);
  dv.setUint32(10, Math.floor(granule / 2 ** 32), true);
  dv.setUint32(14, serial, true);
  dv.setUint32(18, seq, true);
  page[26] = segs.length;
  page.set(segs, 27);
  let o = 27 + segs.length;
  for (const p of packets) { page.set(p, o); o += p.length; }
  let crc = 0;
  for (let i = 0; i < page.length; i++) crc = ((crc << 8) ^ OGG_CRC[((crc >>> 24) ^ page[i]) & 255]) >>> 0;
  dv.setUint32(22, crc, true);
  return page;
}

export async function encodeOpus(buf, { bitrate = 128000 } = {}, progress = () => {}) {
  const ch = Math.min(2, buf.numberOfChannels);
  const pcm = buf.sampleRate === 48000 && buf.numberOfChannels === ch ? buf : await (async () => {
    const ctx = new OfflineAudioContext(ch, Math.ceil(buf.duration * 48000), 48000);
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.connect(ctx.destination);
    s.start();
    return ctx.startRendering();
  })();
  const packets = [];
  let failure = null;
  const encoder = new AudioEncoder({ output: (chunk) => { const b = new Uint8Array(chunk.byteLength); chunk.copyTo(b); packets.push({ b, d: chunk.duration }); }, error: (e) => { failure = e; } });
  encoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: ch, bitrate });
  const step = 48000;
  const chans = [...Array(ch)].map((_, c) => pcm.getChannelData(c));
  for (let start = 0; start < pcm.length; start += step) {
    const n = Math.min(step, pcm.length - start);
    const planar = new Float32Array(n * ch);
    for (let c = 0; c < ch; c++) planar.set(chans[c].subarray(start, start + n), c * n);
    encoder.encode(new AudioData({ format: 'f32-planar', sampleRate: 48000, numberOfFrames: n, numberOfChannels: ch, timestamp: Math.round(start / 48 * 1000), data: planar }));
    if ((start / step) % 20 === 0) { progress(start / pcm.length); await new Promise((r) => setTimeout(r, 0)); }
  }
  await encoder.flush();
  encoder.close();
  if (failure) throw failure;

  const preSkip = 312;
  const serial = (Math.random() * 2 ** 31) | 0;
  const head = new Uint8Array(19);
  const hv = new DataView(head.buffer);
  head.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64], 0); // OpusHead
  head[8] = 1; head[9] = ch; hv.setUint16(10, preSkip, true); hv.setUint32(12, pcm.sampleRate === 48000 ? buf.sampleRate : 48000, true); hv.setUint16(16, 0, true); head[18] = 0;
  const vendor = new TextEncoder().encode("Snake's Converter");
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  tags.set(new TextEncoder().encode('OpusTags'), 0);
  new DataView(tags.buffer).setUint32(8, vendor.length, true);
  tags.set(vendor, 12);
  const pages = [oggPage([head], { serial, seq: 0, granule: 0, first: true }), oggPage([tags], { serial, seq: 1, granule: 0 })];
  let seq = 2;
  let granule = preSkip;
  let batch = [];
  let segs = 0;
  for (let i = 0; i < packets.length; i++) {
    const p = packets[i];
    const need = Math.floor(p.b.length / 255) + 1;
    if (segs + need > 255 && batch.length) { pages.push(oggPage(batch, { serial, seq: seq++, granule })); batch = []; segs = 0; }
    batch.push(p.b);
    segs += need;
    granule += Math.round((p.d || 20000) * 48 / 1000);
  }
  // The last page says where the sound really ends.
  pages.push(oggPage(batch, { serial, seq: seq++, granule: Math.min(granule, pcm.length + preSkip), last: true }));
  const size = pages.reduce((a, p) => a + p.length, 0);
  const file = new Uint8Array(size);
  let o = 0;
  for (const p of pages) { file.set(p, o); o += p.length; }
  return file;
}
