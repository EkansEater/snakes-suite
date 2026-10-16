// A zoomable, scrollable view of a picture, shared by Paint and Photo.
// The wheel zooms around the pointer (or scrolls, if set so); Space or the
// middle button drags the view; real scroll bars show where you are.
import { h, clamp, rafOnce } from './dom.js';
import { stepZoom } from './zoom.js';
import { checkerPattern } from './raster.js';

export class Viewport {
  constructor({ size, draw, overlay = null, settings, onZoom = () => {}, onPointer = null, wheelZooms = true }) {
    this.size = size; // () => { w, h }
    this.drawFn = draw;
    this.overlayFn = overlay;
    this.settings = settings;
    this.onZoom = onZoom;
    this.zoom = 1;
    this.canvas = h('canvas.vp-canvas');
    this.over = h('canvas.vp-over');
    this.spacer = h('div.vp-spacer');
    this.scroller = h('div.vp-scroll', { tabindex: 0 }, this.spacer);
    this.el = h('div.vp', this.canvas, this.over, this.scroller);
    this.ctx = this.canvas.getContext('2d');
    this.octx = this.over.getContext('2d');
    this.renderSoon = rafOnce(() => this.render());
    this.space = false;
    this.wheelZooms = settings.get('wheelZooms', wheelZooms);
    this.bind(onPointer);
    new ResizeObserver(() => this.resize()).observe(this.el);
    window.addEventListener('snake-theme', () => { this.pattern = null; this.render(); });
  }

  // ---- geometry ----
  get margin() {
    const s = this.size();
    const W = this.el.clientWidth;
    const H = this.el.clientHeight;
    return { x: Math.max(80, (W - s.w * this.zoom) / 2), y: Math.max(80, (H - s.h * this.zoom) / 2) };
  }

  /** Where the picture's top-left corner is on screen. */
  get origin() {
    const m = this.margin;
    return { x: m.x - this.scroller.scrollLeft, y: m.y - this.scroller.scrollTop };
  }

  /** A pointer event as picture coordinates (floats). */
  toImage(e) {
    const r = this.el.getBoundingClientRect();
    const o = this.origin;
    return { x: (e.clientX - r.left - o.x) / this.zoom, y: (e.clientY - r.top - o.y) / this.zoom };
  }

  toScreen(x, y) {
    const o = this.origin;
    return { x: o.x + x * this.zoom, y: o.y + y * this.zoom };
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    const W = this.el.clientWidth;
    const H = this.el.clientHeight;
    for (const c of [this.canvas, this.over]) {
      c.width = Math.round(W * dpr);
      c.height = Math.round(H * dpr);
      c.style.width = `${W}px`;
      c.style.height = `${H}px`;
    }
    this.dpr = dpr;
    this.layout();
    if (!this.fitted) { this.fit(); this.fitted = true; }
    this.render();
  }

  layout() {
    const s = this.size();
    const m = this.margin;
    this.spacer.style.width = `${s.w * this.zoom + m.x * 2}px`;
    this.spacer.style.height = `${s.h * this.zoom + m.y * 2}px`;
  }

  fit() {
    const s = this.size();
    const W = this.el.clientWidth - 60;
    const H = this.el.clientHeight - 60;
    if (W <= 0 || H <= 0) return;
    // Big pictures shrink to fit; small ones (icons, pixel art) grow by whole steps so pixels stay crisp.
    let z = Math.min(W / s.w, H / s.h);
    if (z > 1) z = Math.min(Math.floor(z), 32);
    this.zoom = clamp(z, 0.02, 64);
    this.layout();
    this.center();
    this.onZoom(this.zoom);
    this.render();
  }

  center() {
    this.scroller.scrollLeft = (this.scroller.scrollWidth - this.scroller.clientWidth) / 2;
    this.scroller.scrollTop = (this.scroller.scrollHeight - this.scroller.clientHeight) / 2;
  }

  setZoom(z, anchor = null) {
    const old = this.zoom;
    const next = clamp(z, 0.02, 64);
    if (Math.abs(next - old) < 1e-6) return;
    // Keep the picture point under the anchor where it is.
    const r = this.el.getBoundingClientRect();
    const ax = anchor ? anchor.x - r.left : this.el.clientWidth / 2;
    const ay = anchor ? anchor.y - r.top : this.el.clientHeight / 2;
    const o = this.origin;
    const px = (ax - o.x) / old;
    const py = (ay - o.y) / old;
    this.zoom = next;
    this.layout();
    const m = this.margin;
    this.scroller.scrollLeft = m.x + px * next - ax;
    this.scroller.scrollTop = m.y + py * next - ay;
    this.onZoom(this.zoom);
    this.render();
  }

  zoomStep(dir, anchor) { this.setZoom(stepZoom(this.zoom, dir, 0.02, 64), anchor); }

  // ---- drawing ----
  render() {
    const ctx = this.ctx;
    const W = this.el.clientWidth;
    const H = this.el.clientHeight;
    if (!W || !H) return;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    const cs = getComputedStyle(document.documentElement);
    ctx.fillStyle = cs.getPropertyValue('--canvas').trim() || '#0f1210';
    ctx.fillRect(0, 0, W, H);
    const s = this.size();
    const o = this.origin;
    const z = this.zoom;
    if (!this.pattern) this.pattern = checkerPattern(ctx, 8, false);
    ctx.save();
    ctx.shadowColor = 'rgba(0,0,0,.45)';
    ctx.shadowBlur = 18;
    ctx.fillStyle = this.pattern;
    ctx.translate(Math.round(o.x), Math.round(o.y));
    ctx.fillRect(0, 0, Math.round(s.w * z), Math.round(s.h * z));
    ctx.restore();
    ctx.save();
    ctx.translate(o.x, o.y);
    ctx.scale(z, z);
    ctx.imageSmoothingEnabled = z < 2;
    ctx.imageSmoothingQuality = 'high';
    this.drawFn(ctx, { z, o, w: s.w, h: s.h });
    ctx.restore();
    // A pixel grid when zoomed far in.
    if (z >= 8 && this.settings.get('pixelGrid', true)) {
      ctx.save();
      ctx.strokeStyle = 'rgba(128,128,128,.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      const x0 = Math.max(0, Math.floor(-o.x / z));
      const x1 = Math.min(s.w, Math.ceil((W - o.x) / z));
      const y0 = Math.max(0, Math.floor(-o.y / z));
      const y1 = Math.min(s.h, Math.ceil((H - o.y) / z));
      for (let x = x0; x <= x1; x++) { const sx = Math.round(o.x + x * z) + 0.5; ctx.moveTo(sx, Math.max(0, o.y)); ctx.lineTo(sx, Math.min(H, o.y + s.h * z)); }
      for (let y = y0; y <= y1; y++) { const sy = Math.round(o.y + y * z) + 0.5; ctx.moveTo(Math.max(0, o.x), sy); ctx.lineTo(Math.min(W, o.x + s.w * z), sy); }
      ctx.stroke();
      ctx.restore();
    }
    this.renderOverlay();
  }

  renderOverlay() {
    const ctx = this.octx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.el.clientWidth, this.el.clientHeight);
    if (this.overlayFn) this.overlayFn(ctx, { z: this.zoom, o: this.origin });
  }

  // ---- input ----
  bind(onPointer) {
    const sc = this.scroller;
    sc.addEventListener('scroll', () => this.render());
    sc.addEventListener('wheel', (e) => {
      if (e.shiftKey && !e.ctrlKey) return; // sideways scroll
      const zoomIt = e.ctrlKey || e.metaKey || (this.wheelZooms && !e.altKey);
      if (!zoomIt) return;
      e.preventDefault();
      const dy = e.deltaMode === 1 ? e.deltaY * 33 : e.deltaY;
      if (Math.abs(dy) >= 40 && Number.isInteger(dy)) {
        // A mouse wheel: one preset per notch (a fast spin may arrive as one big step).
        const notches = clamp(Math.round(Math.abs(dy) / 100), 1, 4);
        for (let i = 0; i < notches; i++) this.zoomStep(dy < 0 ? 1 : -1, { x: e.clientX, y: e.clientY });
      }
      else this.setZoom(this.zoom * Math.exp(-dy * 0.01), { x: e.clientX, y: e.clientY });
    }, { passive: false });
    window.addEventListener('keydown', (e) => {
      if (e.code === 'Space' && !e.repeat && !(e.target.closest && e.target.closest('input, textarea, [contenteditable="true"]'))) {
        this.space = true;
        sc.classList.add('panning');
        e.preventDefault();
      }
    });
    window.addEventListener('keyup', (e) => { if (e.code === 'Space') { this.space = false; sc.classList.remove('panning'); } });
    sc.addEventListener('pointerdown', (e) => {
      if (e.button === 1 || (e.button === 0 && (this.space || this.handTool))) {
        e.preventDefault();
        const sx = sc.scrollLeft;
        const sy = sc.scrollTop;
        const x0 = e.clientX;
        const y0 = e.clientY;
        sc.setPointerCapture(e.pointerId);
        sc.classList.add('grabbing');
        const mv = (ev) => { sc.scrollLeft = sx - (ev.clientX - x0); sc.scrollTop = sy - (ev.clientY - y0); };
        const up = () => { sc.removeEventListener('pointermove', mv); sc.removeEventListener('pointerup', up); sc.classList.remove('grabbing'); };
        sc.addEventListener('pointermove', mv);
        sc.addEventListener('pointerup', up);
        return;
      }
      if (onPointer) onPointer('down', e);
    });
    sc.addEventListener('pointermove', (e) => onPointer && onPointer('move', e));
    sc.addEventListener('pointerup', (e) => onPointer && onPointer('up', e));
    sc.addEventListener('pointerleave', (e) => onPointer && onPointer('leave', e));
    sc.addEventListener('dblclick', (e) => onPointer && onPointer('dblclick', e));
  }
}
