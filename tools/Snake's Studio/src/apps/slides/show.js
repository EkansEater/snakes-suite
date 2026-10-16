// The slide show: full screen, transitions, builds, laser pointer, pen, black
// and white screens. Used in the editor window and in the audience window of
// the presenter view (kept in step over a BroadcastChannel).
import { h } from '../../kit/dom.js';
import { renderSlide, settle } from './model.js';

export class Show {
  constructor({ pres, root, index = 0, onState = () => {}, controls = true, audience = false }) {
    this.pres = pres;
    this.root = root;
    this.onState = onState;
    this.audience = audience;
    this.slides = pres.slides.filter((s) => !s.hidden || audience === 'all');
    this.index = Math.max(0, Math.min(index, this.slides.length - 1));
    this.step = 0;
    this.mode = null; // 'black' | 'white'
    this.tool = null; // 'laser' | 'pen'
    this.ink = new Map(); // slide id -> strokes
    this.stage = h('div.show-stage');
    this.frame = h('div.show-frame');
    this.inkCanvas = h('canvas.show-ink');
    this.laser = h('div.show-laser.hidden');
    this.blank = h('div.show-blank.hidden');
    this.bar = h('div.show-bar');
    this.counter = h('span');
    this.stage.append(this.frame, this.inkCanvas, this.laser, this.blank);
    if (controls) {
      const btn = (label, tip, fn) => { const b = h('button', { 'data-tip': tip }, label); b.addEventListener('click', (e) => { e.stopPropagation(); fn(); }); return b; };
      this.bar.append(btn('‹', 'Previous (←)', () => this.prev()), this.counter, btn('›', 'Next (→ or Space)', () => this.next()),
        btn('✎', 'Pen (P)', () => this.setTool(this.tool === 'pen' ? null : 'pen')), btn('●', 'Laser pointer (L)', () => this.setTool(this.tool === 'laser' ? null : 'laser')),
        btn('■', 'Black screen (B)', () => this.setMode(this.mode === 'black' ? null : 'black')), btn('✕', 'End the show (Esc)', () => this.end()));
      this.stage.append(this.bar);
    }
    this.root.append(this.stage);
    this.resize = () => this.layout();
    window.addEventListener('resize', this.resize);
    this.bindPointer();
    this.render(null);
  }

  get slide() { return this.slides[this.index]; }

  /** Build steps of a slide: items with animations appear in order. */
  steps(slide) {
    const anims = slide.items.filter((it) => it.anim && it.anim.type && it.anim.type !== 'none').sort((a, b) => (a.anim.order || 0) - (b.anim.order || 0));
    return anims;
  }

  layout() {
    const W = this.stage.clientWidth;
    const H = this.stage.clientHeight;
    const s = Math.min(W / this.pres.size.w, H / this.pres.size.h);
    this.scale = s;
    for (const el of this.frame.children) {
      el.style.transform = `scale(${s})`;
      el.style.left = `${(W - this.pres.size.w * s) / 2}px`;
      el.style.top = `${(H - this.pres.size.h * s) / 2}px`;
    }
    this.inkCanvas.width = W * devicePixelRatio;
    this.inkCanvas.height = H * devicePixelRatio;
    this.drawInk();
  }

  render(direction) {
    const slide = this.slide;
    if (!slide) return;
    const builds = this.steps(slide);
    const hidden = new Set(builds.slice(this.step).map((it) => it.id));
    const el = renderSlide(slide, this.pres, { hideItems: null, number: this.index + 1 });
    for (const item of builds) {
      const node = el.querySelector(`[data-id="${item.id}"]`);
      if (node && hidden.has(item.id)) node.classList.add('build-hidden');
    }
    el.classList.add('show-slide');
    const old = [...this.frame.children];
    this.frame.append(el);
    this.layout();
    settle(el, this.scale);
    if (direction !== null && old.length) {
      const t = (slide.transition && slide.transition.type) || 'fade';
      const dur = (slide.transition && slide.transition.duration) || 0.5;
      el.style.setProperty('--dur', `${dur}s`);
      for (const o of old) o.style.setProperty('--dur', `${dur}s`);
      if (t !== 'none') {
        el.classList.add(`tin-${t}`, direction < 0 ? 'back' : 'fwd');
        for (const o of old) o.classList.add(`tout-${t}`, direction < 0 ? 'back' : 'fwd');
        setTimeout(() => old.forEach((o) => o.remove()), dur * 1000 + 30);
      } else old.forEach((o) => o.remove());
    } else old.forEach((o) => o.remove());
    this.counter.textContent = `${this.index + 1} / ${this.slides.length}`;
    this.drawInk();
    this.emit();
  }

  /** Reveal the next build on the current slide. */
  revealStep() {
    const builds = this.steps(this.slide);
    const item = builds[this.step];
    const node = this.frame.lastElementChild && this.frame.lastElementChild.querySelector(`[data-id="${item.id}"]`);
    if (node) {
      node.classList.remove('build-hidden');
      node.style.setProperty('--dur', `${item.anim.duration || 0.5}s`);
      node.classList.add(`anim-${item.anim.type}`);
    }
    this.step++;
    this.emit();
  }

  next() {
    if (this.mode) { this.setMode(null); return; }
    if (this.step < this.steps(this.slide).length) { this.revealStep(); return; }
    if (this.index >= this.slides.length - 1) { this.endScreen(); return; }
    this.index++;
    this.step = 0;
    this.render(1);
  }

  prev() {
    if (this.mode) { this.setMode(null); return; }
    if (this.atEnd) { this.atEnd = false; this.render(null); return; }
    if (this.index === 0) return;
    this.index--;
    this.step = this.steps(this.slide).length;
    this.render(-1);
  }

  goto(i, step = 0) {
    this.atEnd = false;
    const dir = i > this.index ? 1 : -1;
    this.index = Math.max(0, Math.min(this.slides.length - 1, i));
    this.step = Math.min(step, this.steps(this.slide).length);
    this.render(dir);
  }

  endScreen() {
    this.atEnd = true;
    this.frame.replaceChildren(h('div.show-end', 'End of the slide show. Click or press Esc to leave.'));
    this.emit();
  }

  setMode(m) {
    this.mode = m;
    this.blank.classList.toggle('hidden', !m);
    this.blank.style.background = m === 'white' ? '#fff' : '#000';
    this.emit();
  }

  setTool(t) {
    this.tool = t;
    this.stage.classList.toggle('pen', t === 'pen');
    this.stage.classList.toggle('laser', t === 'laser');
    if (t !== 'laser') this.laser.classList.add('hidden');
    this.emit();
  }

  bindPointer() {
    let stroke = null;
    this.stage.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.show-bar')) return;
      if (this.tool === 'pen') {
        const p = this.local(e);
        stroke = { color: '#e5534b', width: 4, pts: [p] };
        this.strokes().push(stroke);
        this.stage.setPointerCapture(e.pointerId);
        return;
      }
      if (this.tool === 'laser') return;
      if (e.button === 0) {
        const link = e.target.closest('[data-link]');
        if (link && this.onLink) { this.onLink(link.dataset.link); return; }
        if (this.atEnd) { this.end(); return; }
        this.next();
      }
    });
    this.stage.addEventListener('pointermove', (e) => {
      const p = this.local(e);
      if (stroke) { stroke.pts.push(p); this.drawInk(); this.emit(); return; }
      if (this.tool === 'laser') {
        this.laser.classList.remove('hidden');
        this.laser.style.left = `${e.clientX - this.stage.getBoundingClientRect().left}px`;
        this.laser.style.top = `${e.clientY - this.stage.getBoundingClientRect().top}px`;
        this.laserAt = p;
        this.emit();
      }
      this.stage.classList.add('moving');
      clearTimeout(this.hideTimer);
      this.hideTimer = setTimeout(() => this.stage.classList.remove('moving'), 1800);
    });
    this.stage.addEventListener('pointerup', () => { stroke = null; });
    this.stage.addEventListener('contextmenu', (e) => { e.preventDefault(); this.prev(); });
    this.stage.addEventListener('wheel', (e) => { if (Math.abs(e.deltaY) > 20) { if (e.deltaY > 0) this.next(); else this.prev(); } }, { passive: true });
  }

  /** A point in slide coordinates. */
  local(e) {
    const el = this.frame.lastElementChild;
    const r = (el || this.stage).getBoundingClientRect();
    return { x: (e.clientX - r.left) / (this.scale || 1), y: (e.clientY - r.top) / (this.scale || 1) };
  }

  strokes() {
    const id = this.slide ? this.slide.id : 'x';
    if (!this.ink.has(id)) this.ink.set(id, []);
    return this.ink.get(id);
  }

  drawInk() {
    const ctx = this.inkCanvas.getContext('2d');
    const W = this.stage.clientWidth;
    const H = this.stage.clientHeight;
    ctx.setTransform(devicePixelRatio, 0, 0, devicePixelRatio, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (!this.slide) return;
    const s = this.scale || 1;
    const ox = (W - this.pres.size.w * s) / 2;
    const oy = (H - this.pres.size.h * s) / 2;
    for (const st of this.ink.get(this.slide.id) || []) {
      ctx.strokeStyle = st.color;
      ctx.lineWidth = st.width * s;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      st.pts.forEach((p, i) => (i ? ctx.lineTo(ox + p.x * s, oy + p.y * s) : ctx.moveTo(ox + p.x * s, oy + p.y * s)));
      ctx.stroke();
    }
  }

  clearInk() { this.ink.delete(this.slide.id); this.drawInk(); this.emit(); }

  key(e) {
    const k = e.key;
    if (this.typed === undefined) this.typed = '';
    if (/^\d$/.test(k)) { this.typed += k; return true; }
    if (k === 'Enter' && this.typed) { this.goto(Number(this.typed) - 1); this.typed = ''; return true; }
    this.typed = '';
    if (['ArrowRight', 'ArrowDown', 'PageDown', ' ', 'Enter', 'n', 'N'].includes(k)) { this.next(); return true; }
    if (['ArrowLeft', 'ArrowUp', 'PageUp', 'Backspace'].includes(k)) { this.prev(); return true; }
    if (k === 'Home') { this.goto(0); return true; }
    if (k === 'End') { this.goto(this.slides.length - 1, 99); return true; }
    if (k === 'b' || k === 'B' || k === '.') { this.setMode(this.mode === 'black' ? null : 'black'); return true; }
    if (k === 'w' || k === 'W' || k === ',') { this.setMode(this.mode === 'white' ? null : 'white'); return true; }
    if (k === 'l' || k === 'L') { this.setTool(this.tool === 'laser' ? null : 'laser'); return true; }
    if (k === 'p' || k === 'P') { this.setTool(this.tool === 'pen' ? null : 'pen'); return true; }
    if (k === 'e' || k === 'E') { this.clearInk(); return true; }
    if (k === 'Escape') { if (this.tool) { this.setTool(null); return true; } this.end(); return true; }
    return false;
  }

  state() {
    return { index: this.index, step: this.step, mode: this.mode, atEnd: !!this.atEnd, laser: this.tool === 'laser' ? this.laserAt : null, ink: this.slide ? this.ink.get(this.slide.id) || [] : [] };
  }

  /** Mirror another show (the audience window follows the presenter). */
  apply(st) {
    if (st.index !== this.index) { this.goto(st.index, st.step); } else {
      while (this.step < st.step) this.revealStep();
      if (this.step > st.step) { this.step = st.step; this.render(null); }
    }
    if (st.atEnd && !this.atEnd) this.endScreen();
    if (st.mode !== this.mode) this.setMode(st.mode);
    if (this.slide) this.ink.set(this.slide.id, st.ink || []);
    this.drawInk();
    if (st.laser) {
      const W = this.stage.clientWidth;
      const H = this.stage.clientHeight;
      const s = this.scale || 1;
      this.laser.classList.remove('hidden');
      this.laser.style.left = `${(W - this.pres.size.w * s) / 2 + st.laser.x * s}px`;
      this.laser.style.top = `${(H - this.pres.size.h * s) / 2 + st.laser.y * s}px`;
    } else this.laser.classList.add('hidden');
  }

  emit() { this.onState(this.state()); }

  end() {
    window.removeEventListener('resize', this.resize);
    this.stage.remove();
    if (this.onEnd) this.onEnd();
  }
}
