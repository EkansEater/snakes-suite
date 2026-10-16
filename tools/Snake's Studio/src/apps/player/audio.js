// The sound path of Snake's Player: a 10-band equaliser, volume boost past
// 100%, left/right balance, a night mode that evens out loud and quiet parts,
// and an analyser for the visualiser. Built the first time it is needed.

export const BANDS = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const EQ_PRESETS = {
  flat: { label: 'Flat', gains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
  bass: { label: 'Bass boost', gains: [7, 6, 5, 3, 1, 0, 0, 0, 0, 0] },
  treble: { label: 'Treble boost', gains: [0, 0, 0, 0, 0, 1, 3, 5, 6, 7] },
  vocal: { label: 'Voices', gains: [-3, -2, -1, 1, 3, 4, 4, 2, 0, -1] },
  rock: { label: 'Rock', gains: [5, 4, 2, -1, -2, -1, 2, 4, 5, 5] },
  pop: { label: 'Pop', gains: [-1, 1, 3, 4, 3, 0, -1, -1, 1, 2] },
  jazz: { label: 'Jazz', gains: [3, 2, 1, 2, -1, -1, 0, 1, 2, 3] },
  classical: { label: 'Classical', gains: [4, 3, 2, 1, -1, -1, 0, 2, 3, 4] },
  dance: { label: 'Dance', gains: [6, 5, 2, 0, 0, -2, -1, 0, 4, 5] },
  laptop: { label: 'Small speakers', gains: [6, 5, 4, 2, 1, 0, 0, 1, 2, 2] },
  headphones: { label: 'Headphones', gains: [3, 4, 2, -1, -1, 0, 1, 3, 4, 5] },
};

export class AudioChain {
  constructor(el) {
    this.el = el;
    this.ctx = null;
    this.gains = new Array(BANDS.length).fill(0);
    this.preamp = 0;
    this.eqOn = false;
    this.boost = 1;
    this.balance = 0;
    this.night = false;
  }

  get ready() { return !!this.ctx; }

  /** Build the graph (the element's sound then always flows through it). */
  ensure() {
    if (this.ctx) return true;
    try {
      const ctx = new AudioContext({ latencyHint: 'playback' });
      const src = ctx.createMediaElementSource(this.el);
      this.pre = ctx.createGain();
      this.filters = BANDS.map((f, i) => {
        const b = ctx.createBiquadFilter();
        b.type = i === 0 ? 'lowshelf' : i === BANDS.length - 1 ? 'highshelf' : 'peaking';
        b.frequency.value = f;
        b.Q.value = 1.1;
        return b;
      });
      this.comp = ctx.createDynamicsCompressor();
      this.comp.threshold.value = -28;
      this.comp.knee.value = 24;
      this.comp.ratio.value = 6;
      this.comp.attack.value = 0.01;
      this.comp.release.value = 0.3;
      this.makeup = ctx.createGain();
      this.pan = ctx.createStereoPanner();
      this.out = ctx.createGain();
      this.analyser = ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.78;
      src.connect(this.pre);
      let node = this.pre;
      for (const f of this.filters) { node.connect(f); node = f; }
      this.eqEnd = node;
      this.ctx = ctx;
      this.wire();
      this.pan.connect(this.out);
      this.out.connect(this.analyser);
      this.analyser.connect(ctx.destination);
      this.apply();
      return true;
    } catch {
      return false;
    }
  }

  /** Night mode goes through the compressor; otherwise it is skipped. */
  wire() {
    try { this.eqEnd.disconnect(); } catch {}
    try { this.comp.disconnect(); } catch {}
    try { this.makeup.disconnect(); } catch {}
    if (this.night) {
      this.eqEnd.connect(this.comp);
      this.comp.connect(this.makeup);
      this.makeup.connect(this.pan);
    } else this.eqEnd.connect(this.pan);
  }

  apply() {
    if (!this.ctx) return;
    const t = this.ctx.currentTime;
    this.filters.forEach((f, i) => f.gain.setTargetAtTime(this.eqOn ? this.gains[i] : 0, t, 0.02));
    this.pre.gain.setTargetAtTime(this.eqOn ? 10 ** (this.preamp / 20) : 1, t, 0.02);
    this.makeup.gain.setTargetAtTime(this.night ? 1.9 : 1, t, 0.05);
    this.pan.pan.setTargetAtTime(this.balance, t, 0.02);
    this.out.gain.setTargetAtTime(this.boost, t, 0.02);
  }

  set(opts) {
    const nightChanged = 'night' in opts && opts.night !== this.night;
    Object.assign(this, opts);
    if ((this.eqOn || this.boost > 1 || this.balance || this.night) && !this.ctx) this.ensure();
    if (this.ctx && nightChanged) this.wire();
    this.apply();
  }

  resume() { if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume().catch(() => {}); }
}
