// TIFF pictures (scanners, cameras, print work), read into RGBA pixels. From the TIFF 6.0
// specification: strips or tiles; no compression, LZW, Deflate (zip) or PackBits; the
// horizontal predictor; 1, 8 or 16 bits; greyscale, RGB, palette and CMYK, with or without
// alpha; chunky or planar. The first page of a multi-page file.

export const isTiff = (b) => b.length > 8 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 42 && b[3] === 0) || (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0 && b[3] === 42));

const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8, 16: 8 };

/** { width, height, data: Uint8ClampedArray (RGBA) } */
export async function readTiff(bytes) {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const le = bytes[0] === 0x49;
  const u16 = (o) => dv.getUint16(o, le);
  const u32 = (o) => dv.getUint32(o, le);
  const ifd = u32(4);
  if (ifd + 2 > bytes.length) throw new Error('This TIFF file is damaged.');
  const tags = {};
  const n = u16(ifd);
  for (let i = 0; i < n; i++) {
    const e = ifd + 2 + i * 12;
    const tag = u16(e);
    const type = u16(e + 2);
    const count = u32(e + 4);
    const size = (TYPE_SIZE[type] || 1) * count;
    const at = size <= 4 ? e + 8 : u32(e + 8);
    const vals = [];
    for (let k = 0; k < Math.min(count, 1 << 20); k++) {
      if (type === 3 || type === 8) vals.push(u16(at + k * 2));
      else if (type === 4 || type === 9 || type === 13) vals.push(u32(at + k * 4));
      else if (type === 5) vals.push(u32(at + k * 8) / (u32(at + k * 8 + 4) || 1));
      else if (type === 16) vals.push(Number(dv.getBigUint64(at + k * 8, le)));
      else vals.push(bytes[at + k]);
    }
    tags[tag] = vals;
  }
  const one = (t, d) => (tags[t] ? tags[t][0] : d);
  const width = one(256);
  const height = one(257);
  if (!width || !height) throw new Error('This TIFF file has no picture size.');
  if (width * height > 200e6) throw new Error('This TIFF picture is too big to open (over 200 megapixels).');
  const bits = tags[258] || [1];
  const bps = bits[0];
  const compression = one(259, 1);
  const photometric = one(262, 2);
  const spp = one(277, 1);
  const planar = one(284, 1);
  const predictor = one(317, 1);
  const extra = tags[338] || [];
  const sampleFormat = one(339, 1);
  if (![1, 8, 16, 32].includes(bps) || (bps === 32 && sampleFormat !== 3)) throw new Error(`TIFF pictures with ${bps}-bit samples are not supported.`);
  if (![1, 5, 8, 32946, 32773].includes(compression)) throw new Error(compression === 7 ? 'This TIFF holds a JPEG-compressed picture, which is not supported yet: save it as a plain or LZW TIFF.' : `This TIFF uses a kind of compression (${compression}) that is not supported.`);
  const tiled = !!tags[322];
  const tw = tiled ? one(322) : width;
  const th = tiled ? one(323) : one(278, height);
  const offsets = tiled ? tags[324] : tags[273];
  const counts = tiled ? tags[325] : tags[279];
  if (!offsets) throw new Error('This TIFF file has no picture data.');
  const planes = planar === 2 ? spp : 1;
  const sppChunk = planar === 2 ? 1 : spp;
  const bytesPerSample = bps === 1 ? 1 / 8 : bps / 8;
  const rowBytes = (w) => Math.ceil(w * sppChunk * bps / 8);
  const across = Math.ceil(width / tw);
  const down = Math.ceil(height / th);
  // Each plane as a full picture of samples (bytes, 16-bit as two, floats as four).
  const planeBuf = [];
  for (let p = 0; p < planes; p++) planeBuf.push(new Uint8Array(rowBytes(width) * height));
  const perPlane = tiled ? across * down : down;
  for (let p = 0; p < planes; p++) {
    for (let k = 0; k < perPlane; k++) {
      const idx = p * perPlane + k;
      if (idx >= offsets.length) break;
      const raw = bytes.subarray(offsets[idx], offsets[idx] + (counts ? counts[idx] : bytes.length - offsets[idx]));
      const cw = tw;
      const ch = tiled ? th : Math.min(th, height - k * th);
      const want = rowBytes(cw) * ch;
      let data = await decompress(raw, compression, want);
      if (predictor === 2) unpredict(data, rowBytes(cw), sppChunk, bps, le);
      if (predictor === 3) data = unpredictFloat(data, cw, ch, sppChunk, bps);
      // Place the block in the plane.
      const x0 = tiled ? (k % across) * tw : 0;
      const y0 = tiled ? Math.floor(k / across) * th : k * th;
      const rb = rowBytes(cw);
      const dest = planeBuf[p];
      const destRow = rowBytes(width);
      const copyW = Math.min(rowBytes(Math.min(cw, width - x0)), rb);
      const xb = Math.floor(x0 * sppChunk * bytesPerSample);
      for (let y = 0; y < ch && y0 + y < height; y++) dest.set(data.subarray(y * rb, y * rb + copyW), (y0 + y) * destRow + xb);
    }
  }
  // Samples to 0..255.
  const sampleAt = (plane, x, y, s) => {
    const buf = planeBuf[plane];
    const row = rowBytes(width) * y;
    if (bps === 8) return buf[row + x * sppChunk + s];
    if (bps === 16) { const o = row + (x * sppChunk + s) * 2; return (le ? buf[o + 1] : buf[o]) ; }
    if (bps === 32) { const o = row + (x * sppChunk + s) * 4; const f = new DataView(buf.buffer, buf.byteOffset + o, 4).getFloat32(0, le); return Math.max(0, Math.min(255, Math.round(f * 255))); }
    const bit = x * sppChunk + s;
    return (buf[row + (bit >> 3)] >> (7 - (bit & 7))) & 1 ? 255 : 0;
  };
  const get = (x, y, s) => (planar === 2 ? sampleAt(s, x, y, 0) : sampleAt(0, x, y, s));
  const out = new Uint8ClampedArray(width * height * 4);
  // The usual case, quickly: 8-bit RGB or RGBA, samples side by side.
  if (bps === 8 && planar === 1 && photometric === 2 && (spp === 3 || (spp === 4 && extra[0] !== 1))) {
    const src = planeBuf[0];
    for (let i = 0, j = 0, end = width * height; i < end; i++, j += spp) {
      const o = i * 4;
      out[o] = src[j]; out[o + 1] = src[j + 1]; out[o + 2] = src[j + 2]; out[o + 3] = spp === 4 ? src[j + 3] : 255;
    }
    return { width, height, data: out };
  }
  const colorMap = tags[320];
  const hasAlpha = extra.length > 0 || (photometric === 2 && spp >= 4) || ((photometric === 0 || photometric === 1) && spp >= 2);
  const alphaIdx = photometric === 2 ? 3 : photometric === 5 ? 4 : 1;
  const premultiplied = extra[0] === 1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      let r; let g; let b;
      if (photometric === 0 || photometric === 1) { let v = get(x, y, 0); if (photometric === 0) v = 255 - v; r = g = b = v; }
      else if (photometric === 3 && colorMap) { const i = bps === 16 ? get(x, y, 0) : planeBuf[0][rowBytes(width) * y + x]; const nc = colorMap.length / 3; r = colorMap[i] >> 8; g = colorMap[nc + i] >> 8; b = colorMap[2 * nc + i] >> 8; }
      else if (photometric === 5) { const c = get(x, y, 0); const m = get(x, y, 1); const yy = get(x, y, 2); const k = get(x, y, 3); r = ((255 - c) * (255 - k)) / 255; g = ((255 - m) * (255 - k)) / 255; b = ((255 - yy) * (255 - k)) / 255; }
      else { r = get(x, y, 0); g = get(x, y, 1); b = get(x, y, 2); }
      let a = hasAlpha && spp > alphaIdx ? get(x, y, alphaIdx) : 255;
      if (hasAlpha && premultiplied && a > 0 && a < 255) { r = (r * 255) / a; g = (g * 255) / a; b = (b * 255) / a; }
      if (!hasAlpha) a = 255;
      out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = a;
    }
  }
  return { width, height, data: out };
}

async function decompress(raw, kind, want) {
  if (kind === 1) return raw.slice(0, want);
  if (kind === 32773) return packBits(raw, want);
  if (kind === 5) return lzw(raw, want);
  // Deflate: zlib wrapped.
  const ds = new DecompressionStream('deflate');
  const out = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(ds)).arrayBuffer());
  return out;
}

function packBits(src, want) {
  const out = new Uint8Array(want);
  let i = 0;
  let o = 0;
  while (i < src.length && o < want) {
    const n = (src[i++] << 24) >> 24;
    if (n >= 0) { for (let k = 0; k <= n && o < want; k++) out[o++] = src[i++]; } else if (n !== -128) { const v = src[i++]; for (let k = 0; k <= -n && o < want; k++) out[o++] = v; }
  }
  return out;
}

// TIFF's LZW: codes of 9 to 12 bits, most significant bit first, "early change".
// The table keeps each code as (prefix code, last byte, length): no arrays per code.
function lzw(src, want) {
  const out = new Uint8Array(want);
  const prefix = new Uint16Array(4096);
  const suffix = new Uint8Array(4096);
  const len = new Uint16Array(4096);
  for (let i = 0; i < 256; i++) { suffix[i] = i; len[i] = 1; }
  let next = 258;
  let width = 9;
  let o = 0;
  let bitPos = 0;
  const total = src.length * 8;
  let prev = -1;
  const first = (code) => { while (len[code] > 1) code = prefix[code]; return suffix[code]; };
  const emit = (code) => {
    const n = len[code];
    let at = o + n - 1;
    let c = code;
    while (c >= 0) { if (at < want) out[at] = suffix[c]; at--; if (len[c] === 1) break; c = prefix[c]; }
    o += n;
  };
  while (bitPos + width <= total && o < want) {
    let code = 0;
    for (let k = 0; k < width; k++, bitPos++) code = (code << 1) | ((src[bitPos >> 3] >> (7 - (bitPos & 7))) & 1);
    if (code === 257) break;
    if (code === 256) { next = 258; width = 9; prev = -1; continue; }
    if (prev < 0) { if (code > 255) break; emit(code); prev = code; continue; }
    if (code < next) {
      emit(code);
      if (next < 4096) { prefix[next] = prev; suffix[next] = first(code); len[next] = len[prev] + 1; next++; }
    } else {
      // The code being defined right now: the previous string plus its own first byte.
      if (next >= 4096) break;
      prefix[next] = prev; suffix[next] = first(prev); len[next] = len[prev] + 1; next++;
      emit(code);
    }
    prev = code;
    if (next + 1 >= 1 << width && width < 12) width++;
  }
  return out;
}

function unpredict(data, rowBytes, spp, bps, le) {
  if (bps === 8) {
    for (let y = 0; y + rowBytes <= data.length; y += rowBytes) for (let i = spp; i < rowBytes; i++) data[y + i] = (data[y + i] + data[y + i - spp]) & 255;
  } else if (bps === 16) {
    const dv = new DataView(data.buffer, data.byteOffset, data.byteLength);
    for (let y = 0; y + rowBytes <= data.length; y += rowBytes) for (let i = spp * 2; i < rowBytes; i += 2) dv.setUint16(y + i, (dv.getUint16(y + i, le) + dv.getUint16(y + i - spp * 2, le)) & 0xffff, le);
  }
}

function unpredictFloat(data, w, h, spp, bps) {
  // Floating-point predictor: byte planes differenced, then reordered (big-endian floats).
  const bytes = bps / 8;
  const rowLen = w * spp * bytes;
  const out = new Uint8Array(data.length);
  for (let y = 0; y < h; y++) {
    const row = data.subarray(y * rowLen, (y + 1) * rowLen);
    for (let i = 1; i < rowLen; i++) row[i] = (row[i] + row[i - 1]) & 255;
    const n = w * spp;
    for (let i = 0; i < n; i++) for (let b = 0; b < bytes; b++) out[y * rowLen + i * bytes + (bytes - 1 - b)] = row[b * n + i];
  }
  return out;
}
