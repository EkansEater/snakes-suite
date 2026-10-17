// Snake's DAW's audio thread in the browser: runs the desktop DAW's own engine (daw.wasm)
// on every 128-frame block. The page sends it messages; it sends back the meters and the
// transport about 30 times a second, and recordings when asked.
/* global registerProcessor, AudioWorkletProcessor, sampleRate */

// The audio thread has no TextEncoder or TextDecoder: UTF-8 by hand.
const enc = {
  encode(str) {
    const out = [];
    for (const ch of str) {
      const c = ch.codePointAt(0);
      if (c < 0x80) out.push(c);
      else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 63));
      else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
      else out.push(0xf0 | (c >> 18), 0x80 | ((c >> 12) & 63), 0x80 | ((c >> 6) & 63), 0x80 | (c & 63));
    }
    return new Uint8Array(out);
  },
};
const dec = {
  decode(b) {
    let s = '';
    for (let i = 0; i < b.length;) {
      const c = b[i];
      let cp;
      if (c < 0x80) { cp = c; i += 1; } else if (c < 0xe0) { cp = ((c & 31) << 6) | (b[i + 1] & 63); i += 2; } else if (c < 0xf0) { cp = ((c & 15) << 12) | ((b[i + 1] & 63) << 6) | (b[i + 2] & 63); i += 3; } else { cp = ((c & 7) << 18) | ((b[i + 1] & 63) << 12) | ((b[i + 2] & 63) << 6) | (b[i + 3] & 63); i += 4; }
      s += String.fromCodePoint(cp);
    }
    return s;
  },
};

class SnakeDaw extends AudioWorkletProcessor {
  constructor() {
    super();
    this.x = null;
    this.d = 0;
    this.frames = 0;
    this.port.onmessage = (e) => this.message(e.data);
  }

  reply(n) { return JSON.parse(dec.decode(new Uint8Array(this.x.memory.buffer, this.x.daw_reply(this.d), n))); }

  op(msg) {
    const b = enc.encode(JSON.stringify(msg));
    const p = this.x.buf_alloc(b.length);
    new Uint8Array(this.x.memory.buffer, p, b.length).set(b);
    const n = this.x.daw_op(this.d, p, b.length);
    this.x.buf_free(p, b.length);
    return this.reply(n);
  }

  message(m) {
    if (m.type === 'init') {
      // The engine's bytes are compiled here (posting a compiled module to a worklet is not supported everywhere).
      this.x = new WebAssembly.Instance(m.module || new WebAssembly.Module(m.bytes), {}).exports;
      this.d = this.x.daw_new(sampleRate);
      this.port.postMessage({ type: 'ready', kinds: this.op({ op: 'fx_kinds' }), sampleRate });
      return;
    }
    if (!this.x) return;
    if (m.type === 'op') {
      const r = this.op(m.msg);
      if (m.id) this.port.postMessage({ type: 'reply', id: m.id, r });
    } else if (m.type === 'audio') {
      // Audio for clips: planar channels.
      m.channels.forEach((c, i) => {
        const p = this.x.daw_audio_buf(this.d, BigInt(m.id), i, c.length);
        new Float32Array(this.x.memory.buffer, p, c.length).set(c);
      });
      this.x.daw_audio_done(this.d, BigInt(m.id));
      if (m.reply) this.port.postMessage({ type: 'reply', id: m.reply, r: { ok: true } });
    } else if (m.type === 'take') {
      // A finished recording, per track: interleaved when stereo.
      const out = {};
      for (const id of m.tracks) {
        const n = this.x.daw_rec_len(this.d, BigInt(id));
        out[id] = n ? new Float32Array(this.x.memory.buffer, this.x.daw_rec_ptr(this.d, BigInt(id)), n).slice() : new Float32Array(0);
        this.x.daw_rec_clear(this.d, BigInt(id));
      }
      this.port.postMessage({ type: 'reply', id: m.id, r: out }, Object.values(out).map((a) => a.buffer));
    }
  }

  process(inputs, outputs) {
    if (!this.x) return true;
    const out = outputs[0];
    const n = out[0] ? out[0].length : 128;
    const input = inputs[0] || [];
    const mem = () => this.x.memory.buffer;
    const inL = new Float32Array(mem(), this.x.daw_buf(this.d, 0), n);
    const inR = new Float32Array(mem(), this.x.daw_buf(this.d, 1), n);
    if (input[0]) { inL.set(input[0]); inR.set(input[1] || input[0]); } else { inL.fill(0); inR.fill(0); }
    this.x.daw_process(this.d, n);
    const oL = new Float32Array(mem(), this.x.daw_buf(this.d, 2), n);
    const oR = new Float32Array(mem(), this.x.daw_buf(this.d, 3), n);
    if (out[0]) out[0].set(oL);
    if (out[1]) out[1].set(oR);
    this.frames += n;
    if (this.frames >= sampleRate / 30) {
      this.frames = 0;
      const k = this.x.daw_status(this.d);
      this.port.postMessage({ type: 'status', s: this.reply(k) });
    }
    return true;
  }
}

registerProcessor('snake-daw', SnakeDaw);
