// The .snake archive format in the browser, byte for byte what the desktop and Android
// Compressors write and read (tools/Snake's Compressor/src/format.rs):
//
//   "SNAKE\0" version:u8, then one zstd frame (with checksum) holding entries:
//     kind:u8 path_len:u32 path mode:u32 mtime:i64
//     file:    { chunk_len:u32 chunk }* 0:u32 size:u64 blake3:[32]
//     symlink: target_len:u32 target
//     dir:     (nothing)
//   kind 0 ends the archive. Little-endian; paths UTF-8, relative, "/"-separated.
//
// zstd and BLAKE3 are the desktop's own code compiled to WebAssembly (snake.wasm, made by
// tools/Snake's Compressor/wasm/build.sh). Everything streams: files of any size.
import wasmPath from './snake.wasm';

const MAGIC = [0x53, 0x4e, 0x41, 0x4b, 0x45, 0x00];
const VERSION = 1;
const CHUNK = 1 << 20;
const KIND = { END: 0, FILE: 1, DIR: 2, SYMLINK: 3 };
export const LEVELS = { fast: 3, normal: 9, small: 19 };

let enginePromise = null;
function engine() {
  if (!enginePromise) {
    enginePromise = (async () => {
      const url = new URL(wasmPath, import.meta.url);
      const res = await fetch(url);
      const { instance } = WebAssembly.instantiateStreaming && res.headers.get('content-type') === 'application/wasm'
        ? await WebAssembly.instantiateStreaming(res)
        : await WebAssembly.instantiate(await res.arrayBuffer());
      return instance.exports;
    })();
  }
  return enginePromise;
}

/** A compression or decompression stream in the engine. write() returns its output so far. */
class Stream {
  constructor(x, handle) {
    this.x = x;
    this.h = handle;
    this.cap = 0;
    this.ptr = 0;
  }
  input(bytes) {
    const x = this.x;
    if (bytes.length > this.cap) {
      if (this.ptr) x.buf_free(this.ptr, this.cap);
      this.cap = Math.max(bytes.length, CHUNK + 64);
      this.ptr = x.buf_alloc(this.cap);
    }
    new Uint8Array(x.memory.buffer, this.ptr, bytes.length).set(bytes);
    return this.ptr;
  }
  take() {
    const x = this.x;
    const n = x.out_len(this.h);
    if (!n) return null;
    const out = new Uint8Array(x.memory.buffer, x.out_ptr(this.h), n).slice();
    x.out_clear(this.h);
    return out;
  }
  /** Feed bytes; returns [used, output]. */
  write(bytes) {
    const used = this.x.stream_write(this.h, this.input(bytes), bytes.length);
    if (used < 0) throw new Error('The archive is damaged (its compressed data does not decode).');
    return [used, this.take()];
  }
  finish() {
    if (this.x.enc_finish(this.h) < 0) throw new Error('Compressing failed.');
    return this.take();
  }
  get done() { return this.x.dec_done(this.h) === 1; }
  free() {
    if (this.ptr) this.x.buf_free(this.ptr, this.cap);
    this.x.stream_free(this.h);
  }
}

class Hasher {
  constructor(x) { this.x = x; this.h = x.hash_new(); this.cap = 0; this.ptr = 0; }
  update(bytes) {
    const x = this.x;
    if (bytes.length > this.cap) {
      if (this.ptr) x.buf_free(this.ptr, this.cap);
      this.cap = Math.max(bytes.length, CHUNK);
      this.ptr = x.buf_alloc(this.cap);
    }
    new Uint8Array(x.memory.buffer, this.ptr, bytes.length).set(bytes);
    x.hash_update(this.h, this.ptr, bytes.length);
  }
  digest() {
    const x = this.x;
    const out = x.buf_alloc(32);
    x.hash_finish(this.h, out);
    const d = new Uint8Array(x.memory.buffer, out, 32).slice();
    x.buf_free(out, 32);
    if (this.ptr) x.buf_free(this.ptr, this.cap);
    return d;
  }
}

const utf8 = new TextEncoder();
const u32 = (v) => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v, true); return b; };
const u64 = (v) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigUint64(0, BigInt(v), true); return b; };
const i64 = (v) => { const b = new Uint8Array(8); new DataView(b.buffer).setBigInt64(0, BigInt(Math.trunc(v)), true); return b; };

/** A browser that does not have much memory to spare gets a smaller match window. */
export function windowLog() {
  const mem = navigator.deviceMemory || 8;
  const phone = window.matchMedia && window.matchMedia('(max-width: 720px)').matches;
  return phone || mem < 4 ? 23 : 27;
}

/**
 * Pack `items` ({ path, kind: 'file' | 'dir', file?: Blob, mtime?: seconds }) into a .snake
 * archive. `sink(bytes)` receives the archive piece by piece (it may be async);
 * `progress(done, total)` reports the input bytes read.
 */
export async function pack(items, { level = LEVELS.normal, sink, progress = () => {}, signal = null }) {
  const x = await engine();
  const handle = x.enc_new(level, windowLog());
  if (!handle) throw new Error('This browser does not have enough memory for that compression level.');
  const enc = new Stream(x, handle);
  const total = items.reduce((a, it) => a + (it.file ? it.file.size : 0), 0);
  let done = 0;
  let files = 0;
  await sink(new Uint8Array([...MAGIC, VERSION]));
  const put = async (bytes) => { const [, out] = enc.write(bytes); if (out) await sink(out); };
  try {
    for (const it of items) {
      if (signal && signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      const name = utf8.encode(it.path);
      const kind = it.kind === 'dir' ? KIND.DIR : KIND.FILE;
      await put(new Uint8Array([kind]));
      await put(u32(name.length));
      await put(name);
      await put(u32(kind === KIND.DIR ? 0o40755 : 0o100644));
      await put(i64(it.mtime || 0));
      if (kind !== KIND.FILE) continue;
      const hasher = new Hasher(x);
      let size = 0;
      for (let at = 0; at < it.file.size; at += CHUNK) {
        if (signal && signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        const chunk = new Uint8Array(await it.file.slice(at, at + CHUNK).arrayBuffer());
        await put(u32(chunk.length));
        await put(chunk);
        hasher.update(chunk);
        size += chunk.length;
        done += chunk.length;
        progress(done, total);
      }
      await put(u32(0));
      await put(u64(size));
      await put(hasher.digest());
      files++;
    }
    await put(new Uint8Array([KIND.END]));
    const last = enc.finish();
    if (last) await sink(last);
  } finally {
    enc.free();
  }
  return { files, bytes: total };
}

/** Is this part of a path safe to unpack (the desktop's rules)? */
export function safePath(name) {
  return name.split('/').every((p) => p && p !== '.' && p !== '..' && !p.includes('\0') && !/[\\:]/.test(p));
}

/**
 * Read a .snake archive (a Blob or File). `entry(e)` is called for each entry
 * ({ path, kind, mode, mtime, target? }) and may return a function that receives each
 * piece of that file's data (async allowed); `finished(e, { size, ok })` after each file.
 * Returns { files, bytes, damaged: [paths] }. Throws on a broken archive.
 */
export async function read(blob, { entry = () => null, finished = () => {}, progress = () => {}, signal = null } = {}) {
  const head = new Uint8Array(await blob.slice(0, 7).arrayBuffer());
  if (!MAGIC.every((b, i) => head[i] === b)) throw new Error('This is not a .snake archive.');
  if (head[6] !== VERSION) throw new Error(`This archive is format version ${head[6]}, which this Compressor does not know. Update Snake's Master Suite.`);
  const x = await engine();
  const handle = x.dec_new();
  if (!handle) throw new Error('This browser does not have enough memory to open the archive.');
  const dec = new Stream(x, handle);
  let at = 7;
  let buf = new Uint8Array(0);
  let pos = 0;
  const READ = 4 * CHUNK;
  // Make sure n decompressed bytes are waiting.
  const ensure = async (n) => {
    while (buf.length - pos < n) {
      if (signal && signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      if (at >= blob.size || dec.done) throw new Error('The archive is cut short (it was not copied completely).');
      const raw = new Uint8Array(await blob.slice(at, at + READ).arrayBuffer());
      const [used, out] = dec.write(raw);
      at += used;
      progress(at, blob.size);
      if (out) {
        const rest = buf.subarray(pos);
        const merged = new Uint8Array(rest.length + out.length);
        merged.set(rest);
        merged.set(out, rest.length);
        buf = merged;
        pos = 0;
      }
    }
  };
  const take = async (n) => { await ensure(n); const b = buf.subarray(pos, pos + n); pos += n; return b; };
  const dv = (b) => new DataView(b.buffer, b.byteOffset, b.byteLength);
  const readU32 = async () => dv(await take(4)).getUint32(0, true);
  const readStr = async () => {
    const n = await readU32();
    if (n > 1 << 16) throw new Error('The archive is damaged (a name is far too long).');
    return new TextDecoder('utf-8', { fatal: true }).decode(await take(n));
  };
  let files = 0;
  let bytes = 0;
  const damaged = [];
  try {
    for (;;) {
      const kind = (await take(1))[0];
      if (kind === KIND.END) break;
      if (![KIND.FILE, KIND.DIR, KIND.SYMLINK].includes(kind)) throw new Error('The archive is damaged (an unknown entry).');
      const path = await readStr();
      const mode = await readU32();
      const mtime = Number(dv(await take(8)).getBigInt64(0, true));
      const e = { path, kind: kind === KIND.FILE ? 'file' : kind === KIND.DIR ? 'dir' : 'symlink', mode, mtime, safe: safePath(path) };
      if (kind === KIND.SYMLINK) e.target = await readStr();
      const sinkFor = await entry(e);
      if (kind !== KIND.FILE) continue;
      const hasher = new Hasher(x);
      let size = 0;
      for (;;) {
        const n = await readU32();
        if (!n) break;
        if (n > 16 * CHUNK) throw new Error('The archive is damaged (a piece is far too big).');
        const data = await take(n);
        hasher.update(data);
        if (sinkFor) await sinkFor(data.slice());
        size += n;
      }
      const stated = Number(dv(await take(8)).getBigUint64(0, true));
      const sum = await take(32);
      const mine = hasher.digest();
      const ok = stated === size && sum.every((b, i) => b === mine[i]);
      if (!ok) damaged.push(path);
      files++;
      bytes += size;
      await finished(e, { size, ok });
    }
    // The frame's own checksum is checked when its end is read.
    while (!dec.done && at < blob.size) {
      const [used] = dec.write(new Uint8Array(await blob.slice(at, at + READ).arrayBuffer()));
      at += used;
    }
    if (!dec.done) throw new Error('The archive is cut short (it was not copied completely).');
  } finally {
    dec.free();
  }
  progress(blob.size, blob.size);
  return { files, bytes, damaged };
}
