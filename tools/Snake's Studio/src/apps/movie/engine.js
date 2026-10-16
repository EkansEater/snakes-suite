// Playing the timeline: one media element per nearby clip, kept in step with
// the timeline clock; sound mixed through Web Audio (volume, fades, mute);
// each frame drawn with the same renderer the export uses.
import { end, sourceTime, mediaOf, projectDuration } from './model.js';
import { drawFrame } from './render.js';

const AHEAD = 1.2; // start loading a clip this many seconds before it is needed
const FAR = 25; // and let go of it when the playhead is this far away

export class Engine {
  constructor({ project, canvas, url, onTime = () => {}, onState = () => {}, crossOrigin = false }) {
    this.project = project; // () => the project
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.url = url; // (media, clip) => playable address (a proxy when there is one)
    this.onTime = onTime;
    this.onState = onState;
    this.crossOrigin = crossOrigin;
    this.t = 0;
    this.playing = false;
    this.els = new Map(); // clip id -> { el, gain, src }
    this.images = new Map(); // media id -> { el, w, h } | 'loading'
    this.audio = null;
    this.dirty = true;
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }

  // ---- sound ----
  ensureAudio() {
    if (this.audio) return this.audio;
    const ctx = new AudioContext({ latencyHint: 'playback' });
    const master = ctx.createGain();
    master.connect(ctx.destination);
    const record = ctx.createMediaStreamDestination();
    master.connect(record);
    this.audio = { ctx, master, record };
    return this.audio;
  }

  // ---- media elements ----
  elementFor(c, m) {
    let e = this.els.get(c.id);
    const want = this.url(m, c);
    if (!e) {
      const el = document.createElement(m.kind === 'audio' ? 'audio' : 'video');
      el.preload = 'auto';
      el.playsInline = true;
      if (this.crossOrigin) el.crossOrigin = 'anonymous';
      el.addEventListener('seeked', () => { this.dirty = true; });
      el.addEventListener('loadeddata', () => { this.dirty = true; });
      e = { el, gain: null, src: '' };
      try {
        const a = this.ensureAudio();
        const node = a.ctx.createMediaElementSource(el);
        e.gain = a.ctx.createGain();
        node.connect(e.gain);
        e.gain.connect(a.master);
      } catch { /* without Web Audio the element plays its own sound */ }
      this.els.set(c.id, e);
    }
    if (e.src !== want) { e.src = want; e.el.src = want; }
    return e;
  }

  release(id) {
    const e = this.els.get(id);
    if (!e || !e.src) return;
    e.el.pause();
    e.el.removeAttribute('src');
    e.el.load();
    e.src = '';
  }

  imageFor(m) {
    const got = this.images.get(m.id);
    if (got && got !== 'loading') return got;
    if (!got) {
      this.images.set(m.id, 'loading');
      const img = new Image();
      if (this.crossOrigin) img.crossOrigin = 'anonymous';
      img.decoding = 'async';
      img.onload = () => { this.images.set(m.id, { el: img, w: img.naturalWidth, h: img.naturalHeight }); this.dirty = true; };
      img.onerror = () => this.images.delete(m.id);
      img.src = this.url(m, null);
    }
    return null;
  }

  forget(mediaId) { this.images.delete(mediaId); }

  /** A drawable for a clip at the current time. */
  source(c) {
    const p = this.project();
    const m = mediaOf(p, c);
    if (!m) return null;
    if (m.kind === 'image') return this.imageFor(m);
    const e = this.els.get(c.id);
    if (!e || e.el.readyState < 2 || !e.el.videoWidth) return null;
    return { el: e.el, w: e.el.videoWidth, h: e.el.videoHeight };
  }

  // ---- the clock ----
  get duration() { return projectDuration(this.project()); }

  play() {
    if (this.playing) return;
    if (this.t >= this.duration - 0.02) this.t = 0;
    const a = this.ensureAudio();
    if (a.ctx.state === 'suspended') a.ctx.resume().catch(() => {});
    this.playing = true;
    this.p0 = performance.now();
    this.t0 = this.t;
    this.onState(true);
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    for (const e of this.els.values()) if (!e.el.paused) e.el.pause();
    this.dirty = true;
    this.onState(false);
  }

  toggle() { if (this.playing) this.pause(); else this.play(); }

  seek(t) {
    this.t = Math.max(0, Math.min(t, Math.max(0, this.duration)));
    if (this.playing) { this.p0 = performance.now(); this.t0 = this.t; }
    this.dirty = true;
    this.sync(true);
    this.onTime(this.t);
  }

  /** Put every element where it should be for the current time. */
  sync(hard = false) {
    const p = this.project();
    const T = this.t;
    const live = new Set();
    const a = this.audio;
    for (const tr of p.tracks) {
      if (tr.kind === 'text') continue;
      for (const c of tr.clips) {
        const m = mediaOf(p, c);
        if (!m || m.kind === 'image' || m.missing) continue;
        const active = T >= c.start - 1e-4 && T < end(c);
        const soon = !active && c.start > T && c.start - T < AHEAD;
        if (!active && !soon) {
          if (Math.abs(T - c.start) > FAR && Math.abs(T - end(c)) > FAR) this.release(c.id);
          else { const e = this.els.get(c.id); if (e && !e.el.paused) e.el.pause(); }
          continue;
        }
        live.add(c.id);
        const e = this.elementFor(c, m);
        const el = e.el;
        if (soon) {
          if (!el.paused) el.pause();
          if (el.readyState >= 1 && Math.abs(el.currentTime - c.in) > 0.3) el.currentTime = c.in;
          continue;
        }
        // Sound: volume, fades in and out, muted clips and tracks, hidden video tracks stay audible.
        if (e.gain && a) {
          const local = T - c.start;
          const left = end(c) - T;
          let g = c.muted || tr.muted ? 0 : c.volume ?? 1;
          if (c.fadeIn > 0 && local < c.fadeIn) g *= local / c.fadeIn;
          if (c.fadeOut > 0 && left < c.fadeOut) g *= left / c.fadeOut;
          e.gain.gain.setTargetAtTime(Math.max(0, g), a.ctx.currentTime, 0.015);
        } else el.muted = !!(c.muted || tr.muted);
        const target = sourceTime(c, T);
        if (Math.abs(el.playbackRate - c.speed) > 1e-3) el.playbackRate = c.speed;
        if (this.playing) {
          if (el.readyState < 1) continue;
          const drift = Math.abs(el.currentTime - target);
          if (el.paused) { if (drift > 0.05) el.currentTime = target; el.play().catch(() => {}); } else if (drift > 0.25) el.currentTime = target;
        } else {
          if (!el.paused) el.pause();
          if (el.readyState >= 1 && (hard || Math.abs(el.currentTime - target) > 0.5 / (p.fps || 30))) el.currentTime = target;
        }
      }
    }
    // Clips that left the project.
    for (const id of this.els.keys()) if (!live.has(id) && !p.tracks.some((tr) => tr.clips.some((c) => c.id === id))) { this.release(id); this.els.delete(id); }
  }

  loop() {
    requestAnimationFrame(this.loop);
    if (this.playing) {
      this.t = this.t0 + (performance.now() - this.p0) / 1000;
      const d = this.duration;
      if (this.t >= d) { this.t = d; this.pause(); }
      this.sync();
      this.dirty = true;
      this.onTime(this.t);
    }
    if (!this.dirty) return;
    this.dirty = false;
    this.draw();
  }

  /** Draw the current frame (scaled to the preview canvas). */
  draw() {
    const p = this.project();
    const c = this.canvas;
    const ctx = this.ctx;
    const k = c.width / p.width;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    drawFrame(ctx, p, this.t, (clip) => this.source(clip));
  }

  redraw() { this.dirty = true; }

  /** Recording the preview as it plays (export without ffmpeg). */
  recordStream(fps) {
    const a = this.ensureAudio();
    const v = this.canvas.captureStream(fps);
    return new MediaStream([...v.getVideoTracks(), ...a.record.stream.getAudioTracks()]);
  }
}
