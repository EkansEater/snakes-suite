// Reading and writing .zip files (the container of .docx, .xlsx, .pptx and our
// own project files), using the browser's built-in deflate.

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(bytes) {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

async function pipe(bytes, stream) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(stream));
  return new Uint8Array(await out.arrayBuffer());
}
export const deflateRaw = (bytes) => pipe(bytes, new CompressionStream('deflate-raw'));
export const inflateRaw = (bytes) => pipe(bytes, new DecompressionStream('deflate-raw'));

const enc = new TextEncoder();
const dec = new TextDecoder();

/**
 * Read a zip. Returns a Map of name -> { size, read(): Promise<Uint8Array>, text(): Promise<string> }.
 */
export function readZip(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
    if (view.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('This is not a zip-based file (or it is damaged).');
  const count = view.getUint16(eocd + 10, true);
  let p = view.getUint32(eocd + 16, true);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    if (view.getUint32(p, true) !== 0x02014b50) throw new Error('The file is damaged (bad central directory).');
    const flags = view.getUint16(p + 8, true);
    const method = view.getUint16(p + 10, true);
    const dosTime = view.getUint16(p + 12, true);
    const dosDate = view.getUint16(p + 14, true);
    const crcStored = view.getUint32(p + 16, true);
    const unixMode = view.getUint8(p + 5) === 3 ? view.getUint32(p + 38, true) >>> 16 : 0; // made on Unix: mode in the high half
    const csize = view.getUint32(p + 20, true);
    const size = view.getUint32(p + 24, true);
    const nameLen = view.getUint16(p + 28, true);
    const extraLen = view.getUint16(p + 30, true);
    const commentLen = view.getUint16(p + 32, true);
    const local = view.getUint32(p + 42, true);
    const name = dec.decode(bytes.subarray(p + 46, p + 46 + nameLen));
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/')) continue;
    // DOS date and time (as written: no time zone) as Unix seconds.
    const mtime = Date.UTC(((dosDate >> 9) & 127) + 1980, ((dosDate >> 5) & 15) - 1, dosDate & 31, dosTime >> 11, (dosTime >> 5) & 63, (dosTime & 31) * 2) / 1000;
    const entry = {
      name, size, method, crc: crcStored, mtime: Number.isFinite(mtime) ? mtime : 0, encrypted: (flags & 1) === 1, unixMode,
      async read() {
        if (view.getUint32(local, true) !== 0x04034b50) throw new Error(`The file is damaged (${name}).`);
        const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
        const raw = bytes.subarray(start, start + csize);
        if (method === 0) return raw.slice();
        if (method === 8) return inflateRaw(raw);
        throw new Error(`Unsupported compression in ${name}.`);
      },
      async text() { return dec.decode(await this.read()); },
    };
    entries.set(name, entry);
  }
  return entries;
}

function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

/**
 * Write a zip from [{ name, data: Uint8Array | string, store: bool }].
 * `store` keeps an entry uncompressed (ODF's "mimetype" and already-compressed images).
 */
export async function writeZip(files) {
  const { time, date } = dosTime(new Date());
  const parts = [];
  const central = [];
  let offset = 0;
  for (const f of files) {
    const data = typeof f.data === 'string' ? enc.encode(f.data) : f.data;
    const name = enc.encode(f.name);
    const crc = crc32(data);
    let body = data;
    let method = 0;
    if (!f.store && data.length > 64) {
      const z = await deflateRaw(data);
      if (z.length < data.length) { body = z; method = 8; }
    }
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, 0x0800, true); // names are UTF-8
    lh.setUint16(8, method, true);
    lh.setUint16(10, time, true);
    lh.setUint16(12, date, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, body.length, true);
    lh.setUint32(22, data.length, true);
    lh.setUint16(26, name.length, true);
    lh.setUint16(28, 0, true);
    parts.push(new Uint8Array(lh.buffer), name, body);

    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, 0x0800, true);
    ch.setUint16(10, method, true);
    ch.setUint16(12, time, true);
    ch.setUint16(14, date, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, body.length, true);
    ch.setUint32(24, data.length, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, offset, true);
    central.push(new Uint8Array(ch.buffer), name);
    offset += 30 + name.length + body.length;
  }
  const cdSize = central.reduce((n, a) => n + a.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, files.length, true);
  end.setUint16(10, files.length, true);
  end.setUint32(12, cdSize, true);
  end.setUint32(16, offset, true);
  const all = [...parts, ...central, new Uint8Array(end.buffer)];
  const out = new Uint8Array(all.reduce((n, a) => n + a.length, 0));
  let p = 0;
  for (const a of all) { out.set(a, p); p += a.length; }
  return out;
}
