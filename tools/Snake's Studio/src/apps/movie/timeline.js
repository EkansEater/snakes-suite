// The timeline of Snake's Movie Maker: tracks of clips you move, trim, fade
// and split; a ruler to scrub; the wheel zooms where the pointer is.
import { h, clamp, fmtTime } from '../../kit/dom.js';
import { icon } from '../../kit/icons.js';
import { end, mediaOf, projectDuration, snapPoints, trackOf, findClip, TRANSITIONS } from './model.js';

const HEAD = 150;
const ROW_H = { video: 64, text: 38, audio: 52 };
const EDGE = 7;

export class Timeline {
  constructor({ project, engine, edit, onSelect, onMenu, onDropMedia, thumbs, peaks, settings }) {
    this.project = project;
    this.engine = engine;
    this.edit = edit; // edit(label, fn, opts) wraps a change for undo
    this.onSelect = onSelect;
    this.onMenu = onMenu;
    this.onDropMedia = onDropMedia;
    this.thumbs = thumbs; // (media) => [{ t, url }]
    this.peaks = peaks; // (media) => Float32Array | null
    this.settings = settings;
    this.pps = settings.get('pps', 60); // pixels per second
    this.selected = new Set();
    this.ruler = h('canvas.tl-ruler-canvas');
    this.rulerRow = h('div.tl-ruler', h('div.tl-corner', h('span.tl-timecode', '0:00.00')), this.ruler);
    this.rows = h('div.tl-rows');
    this.playhead = h('div.tl-playhead', h('div.tl-playhead-knob'));
    this.content = h('div.tl-content', this.rulerRow, this.rows, this.playhead);
    this.el = h('div.tl', { tabindex: 0 }, this.content);
    this.el.addEventListener('scroll', () => { this.drawRuler(); this.placePlayhead(); });
    new ResizeObserver(() => { this.layoutWidth(); this.drawRuler(); }).observe(this.el);
    this.bind();
  }

  get t() { return this.engine.t; }
  x(t) { return HEAD + t * this.pps; }
  timeAt(clientX) {
    const r = this.el.getBoundingClientRect();
    return Math.max(0, (clientX - r.left + this.el.scrollLeft - HEAD) / this.pps);
  }

  // ---- drawing ----
  layoutWidth() {
    const D = projectDuration(this.project());
    const visible = (this.el.clientWidth - HEAD) / this.pps;
    const w = HEAD + Math.max(D + 20, visible * 1.2) * this.pps;
    this.content.style.width = `${w}px`;
    for (const lane of this.rows.querySelectorAll('.tl-lane')) lane.style.width = `${w - HEAD}px`;
  }

  render() {
    const p = this.project();
    const rows = p.tracks.map((tr) => this.row(tr, p));
    this.rows.replaceChildren(...rows);
    this.layoutWidth();
    this.drawRuler();
    this.placePlayhead();
  }

  row(tr, p) {
    const toggle = (key, on, off, tip) => {
      const b = h(`button.tl-tbtn${tr[key] ? '.on' : ''}`, { 'data-tip': tip, html: icon(tr[key] ? on : off, 14) });
      b.addEventListener('click', (e) => { e.stopPropagation(); this.edit(tip, () => { tr[key] = !tr[key]; }); });
      return b;
    };
    const kindIcon = { video: 'film', text: 'text', audio: 'music' }[tr.kind];
    const head = h('div.tl-head', h('span.tl-kind', { html: icon(kindIcon, 14) }), h('span.tl-tname', tr.name),
      tr.kind !== 'audio' ? toggle('hidden', 'eyeOff', 'eye', tr.hidden ? 'Show track' : 'Hide track') : null,
      tr.kind !== 'text' ? toggle('muted', 'volumeX', 'volume', tr.muted ? 'Unmute track' : 'Mute track') : null,
      toggle('locked', 'lock', 'unlock', tr.locked ? 'Unlock track' : 'Lock track'));
    head.addEventListener('contextmenu', (e) => { e.preventDefault(); this.onMenu(e, null, tr); });
    const lane = h(`div.tl-lane.${tr.kind}`, { dataset: { track: tr.id } });
    for (const c of tr.clips) lane.append(this.clipEl(c, tr, p));
    return h(`div.tl-row${tr.locked ? '.locked' : ''}${tr.hidden ? '.hidden-track' : ''}`, { style: { height: `${ROW_H[tr.kind]}px` }, dataset: { track: tr.id } }, head, lane);
  }

  clipEl(c, tr, p) {
    const m = mediaOf(p, c);
    const w = Math.max(4, c.dur * this.pps);
    const name = tr.kind === 'text' ? String(c.text || '').split('\n')[0] || 'Title' : m ? m.name : 'Missing';
    const el = h(`div.tl-clip.${tr.kind}${this.selected.has(c.id) ? '.sel' : ''}${m && m.missing ? '.missing' : ''}${c.muted ? '.muted' : ''}`, {
      dataset: { clip: c.id }, style: { left: `${c.start * this.pps}px`, width: `${w}px` },
    });
    // What it shows: pictures for video, a wave for sound.
    if (tr.kind === 'video' && m) {
      if (m.kind === 'image' && m.thumb) el.style.backgroundImage = `url("${m.thumb}")`;
      else if (m.kind === 'video') this.filmstrip(el, c, m, w);
    } else if (tr.kind === 'audio' && m) this.wave(el, c, m, w);
    el.append(h('span.tl-cname', name), h('div.tl-edge.l'), h('div.tl-edge.r'));
    if (c.speed !== 1) el.append(h('span.tl-badge', `${Math.round(c.speed * 100) / 100}×`));
    if (c.transition && c.transition.kind !== 'none') {
      el.append(h('span.tl-trans', { 'data-tip': `${TRANSITIONS[c.transition.kind]} (${c.transition.dur}s)`, style: { width: `${Math.max(10, c.transition.dur * this.pps)}px` } }));
    }
    // Fades: little handles at the top corners, dragged to lengthen.
    const fi = h('div.tl-fade.in', { 'data-tip': 'Drag to fade in' });
    const fo = h('div.tl-fade.out', { 'data-tip': 'Drag to fade out' });
    if (c.fadeIn > 0) el.append(h('div.tl-fadeshape.in', { style: { width: `${c.fadeIn * this.pps}px` } }));
    if (c.fadeOut > 0) el.append(h('div.tl-fadeshape.out', { style: { width: `${c.fadeOut * this.pps}px` } }));
    fi.style.left = `${Math.min(w - 8, c.fadeIn * this.pps)}px`;
    fo.style.right = `${Math.min(w - 8, c.fadeOut * this.pps)}px`;
    el.append(fi, fo);
    return el;
  }

  filmstrip(el, c, m, w) {
    const frames = this.thumbs(m);
    if (!frames || !frames.length) return;
    const tileW = 64 * ((m.width || 16) / (m.height || 9)) * (54 / 64);
    const n = Math.min(60, Math.ceil(w / tileW));
    const strip = h('div.tl-strip');
    for (let i = 0; i < n; i++) {
      const t = c.in + (i * tileW / this.pps) * c.speed;
      let best = frames[0];
      for (const f of frames) if (Math.abs(f.t - t) < Math.abs(best.t - t)) best = f;
      strip.append(h('img', { src: best.url, alt: '', style: { width: `${tileW}px` }, draggable: false }));
    }
    el.append(strip);
  }

  wave(el, c, m, w) {
    const pk = this.peaks(m);
    if (!pk || !m.duration) return;
    const H = ROW_H.audio - 4;
    const cv = h('canvas.tl-wave', { width: Math.min(8000, Math.round(w)), height: H });
    const ctx = cv.getContext('2d');
    ctx.fillStyle = 'rgba(126,231,135,.75)';
    const W = cv.width;
    for (let x = 0; x < W; x++) {
      const t0 = c.in + (x / W) * c.dur * c.speed;
      const t1 = c.in + ((x + 1) / W) * c.dur * c.speed;
      const i0 = Math.floor((t0 / m.duration) * pk.length);
      const i1 = Math.max(i0 + 1, Math.floor((t1 / m.duration) * pk.length));
      let v = 0;
      for (let i = i0; i < i1 && i < pk.length; i++) v = Math.max(v, pk[i]);
      const hh = Math.max(1, v * (H - 6) * (c.volume ?? 1));
      ctx.fillRect(x, (H - hh) / 2, 1, hh);
    }
    el.append(cv);
  }

  drawRuler() {
    const cv = this.ruler;
    const W = Math.max(1, this.el.clientWidth - HEAD);
    const H = 26;
    const dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(W * dpr)) { cv.width = Math.round(W * dpr); cv.height = H * dpr; cv.style.width = `${W}px`; cv.style.height = `${H}px`; }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const cs = getComputedStyle(document.documentElement);
    ctx.fillStyle = cs.getPropertyValue('--fg2').trim() || '#888';
    ctx.strokeStyle = cs.getPropertyValue('--border2').trim() || '#444';
    ctx.font = '11px Inter, sans-serif';
    const t0 = this.el.scrollLeft / this.pps;
    const t1 = t0 + W / this.pps;
    // A tick spacing that leaves room for labels.
    const steps = [1 / 30, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600];
    const major = steps.find((s) => s * this.pps >= 70) || 600;
    const minor = steps.slice().reverse().find((s) => s < major && s * this.pps >= 8) || major / 2;
    ctx.beginPath();
    for (let t = Math.floor(t0 / minor) * minor; t <= t1; t += minor) {
      const x = Math.round((t - t0) * this.pps) + 0.5;
      const isMajor = Math.abs(t / major - Math.round(t / major)) < 1e-6;
      ctx.moveTo(x, isMajor ? 12 : 19);
      ctx.lineTo(x, H);
      if (isMajor) ctx.fillText(major < 1 ? fmtTime(t, true) : fmtTime(t), x + 3, 11);
    }
    ctx.stroke();
  }

  placePlayhead() {
    const t = this.engine.t;
    this.playhead.style.left = `${this.x(t)}px`;
    this.playhead.style.height = `${this.content.scrollHeight}px`;
    this.rulerRow.querySelector('.tl-timecode').textContent = fmtTime(t, true);
  }

  /** Keep the playhead in view while playing. */
  follow() {
    const x = this.x(this.engine.t) - this.el.scrollLeft;
    const W = this.el.clientWidth;
    if (x > W - 40 || x < HEAD) this.el.scrollLeft = Math.max(0, this.x(this.engine.t) - HEAD - 60);
  }

  // ---- zoom ----
  zoomAt(factor, clientX = null) {
    const r = this.el.getBoundingClientRect();
    const px = clientX === null ? HEAD + (r.width - HEAD) / 2 : clientX - r.left;
    const t = (px + this.el.scrollLeft - HEAD) / this.pps;
    this.pps = clamp(this.pps * factor, 2, 1200);
    this.settings.set('pps', this.pps);
    this.render();
    this.el.scrollLeft = Math.max(0, t * this.pps + HEAD - px);
    this.drawRuler();
  }

  fit() {
    const D = Math.max(5, projectDuration(this.project()));
    this.pps = clamp((this.el.clientWidth - HEAD - 40) / D, 2, 1200);
    this.settings.set('pps', this.pps);
    this.render();
    this.el.scrollLeft = 0;
  }

  // ---- selection ----
  select(ids, add = false) {
    if (!add) this.selected.clear();
    for (const id of ids) this.selected.add(id);
    for (const el of this.rows.querySelectorAll('.tl-clip')) el.classList.toggle('sel', this.selected.has(el.dataset.clip));
    this.onSelect([...this.selected]);
  }

  // ---- input ----
  bind() {
    this.el.addEventListener('wheel', (e) => {
      const overHead = e.target.closest && e.target.closest('.tl-head');
      if (overHead || (e.shiftKey && !e.ctrlKey)) return; // sideways (Shift) or up and down (over the names)
      const zooms = e.ctrlKey || e.metaKey || this.settings.get('tlWheelZooms', true);
      if (!zooms) return;
      e.preventDefault();
      this.zoomAt(e.deltaY < 0 ? 1.18 : 1 / 1.18, e.clientX);
    }, { passive: false });

    // Scrub on the ruler.
    this.rulerRow.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('.tl-corner')) return;
      this.rulerRow.setPointerCapture(e.pointerId);
      const go = (ev) => { this.engine.seek(this.timeAt(ev.clientX)); this.placePlayhead(); };
      go(e);
      const up = () => { this.rulerRow.removeEventListener('pointermove', go); this.rulerRow.removeEventListener('pointerup', up); };
      this.rulerRow.addEventListener('pointermove', go);
      this.rulerRow.addEventListener('pointerup', up);
    });

    this.rows.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      const clipEl = e.target.closest('.tl-clip');
      if (e.target.closest('.tl-head')) return;
      if (!clipEl) {
        // Empty space: move the playhead, drop the selection.
        if (e.target.closest('.tl-lane')) { this.engine.seek(this.timeAt(e.clientX)); this.placePlayhead(); this.select([]); }
        return;
      }
      this.clipDown(e, clipEl);
    });
    this.rows.addEventListener('dblclick', (e) => {
      const clipEl = e.target.closest('.tl-clip');
      if (clipEl) this.onSelect([clipEl.dataset.clip], { focus: true });
    });
    this.rows.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const clipEl = e.target.closest('.tl-clip');
      const lane = e.target.closest('.tl-row');
      const p = this.project();
      const c = clipEl ? findClip(p, clipEl.dataset.clip) : null;
      if (c && !this.selected.has(c.id)) this.select([c.id]);
      this.onMenu(e, c, lane ? p.tracks.find((t) => t.id === lane.dataset.track) : null, this.timeAt(e.clientX));
    });

    // Media dragged in from the library.
    this.rows.addEventListener('dragover', (e) => {
      if (![...e.dataTransfer.types].includes('application/x-snake-media')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      const lane = e.target.closest('.tl-row');
      for (const r of this.rows.children) r.classList.toggle('drop', r === lane);
    });
    this.rows.addEventListener('dragleave', (e) => { if (!this.rows.contains(e.relatedTarget)) for (const r of this.rows.children) r.classList.remove('drop'); });
    this.rows.addEventListener('drop', (e) => {
      const data = e.dataTransfer.getData('application/x-snake-media');
      for (const r of this.rows.children) r.classList.remove('drop');
      if (!data) return;
      e.preventDefault();
      const lane = e.target.closest('.tl-row');
      this.onDropMedia(JSON.parse(data), lane ? lane.dataset.track : null, this.snap(this.timeAt(e.clientX), new Set()));
    });
  }

  snap(t, except, extra = []) {
    if (!this.settings.get('snap', true)) return t;
    const pts = [...snapPoints(this.project(), except, this.engine.t), ...extra];
    const tol = 8 / this.pps;
    let best = t;
    let bd = tol;
    for (const q of pts) { const d = Math.abs(q - t); if (d < bd) { bd = d; best = q; } }
    return best;
  }

  clipDown(e, clipEl) {
    const p = this.project();
    const c = findClip(p, clipEl.dataset.clip);
    if (!c) return;
    const tr = trackOf(p, c);
    if (e.ctrlKey || e.metaKey) { if (this.selected.has(c.id)) { this.selected.delete(c.id); this.select([...this.selected]); } else this.select([c.id], true); return; }
    if (!this.selected.has(c.id) || e.shiftKey) this.select([c.id], e.shiftKey);
    if (tr.locked) return;
    const r = clipEl.getBoundingClientRect();
    const local = e.clientX - r.left;
    let mode = 'move';
    if (e.target.classList.contains('tl-fade')) mode = e.target.classList.contains('in') ? 'fadeIn' : 'fadeOut';
    else if (local < EDGE) mode = 'trimL';
    else if (local > r.width - EDGE) mode = 'trimR';
    const m = mediaOf(p, c);
    const maxSrc = m && (m.kind === 'video' || m.kind === 'audio') && m.duration ? m.duration : Infinity;
    const x0 = e.clientX;
    const y0 = e.clientY;
    const moving = mode === 'move' ? [...this.selected].map((id) => findClip(p, id)).filter(Boolean).filter((x) => trackOf(p, x) === tr) : [c];
    const orig = moving.map((x) => ({ x, start: x.start, dur: x.dur, in: x.in, fadeIn: x.fadeIn, fadeOut: x.fadeOut }));
    const except = new Set(moving.map((x) => x.id));
    let changed = false;
    let targetTrack = tr;
    this.el.setPointerCapture(e.pointerId);
    const mv = (ev) => {
      const dt = (ev.clientX - x0) / this.pps;
      if (!changed && Math.abs(ev.clientX - x0) < 3 && Math.abs(ev.clientY - y0) < 3) return;
      changed = true;
      const o = orig[0];
      if (mode === 'move') {
        // Snap whichever edge of the dragged clip is near something.
        let d = dt;
        const s1 = this.snap(o.start + dt, except);
        const s2 = this.snap(o.start + o.dur + dt, except);
        if (s1 !== o.start + dt) d = s1 - o.start; else if (s2 !== o.start + o.dur + dt) d = s2 - o.start - o.dur;
        const minStart = Math.min(...orig.map((q) => q.start));
        d = Math.max(-minStart, d);
        for (const q of orig) q.x.start = q.start + d;
        // Dragged onto another track of the same kind (one clip at a time).
        if (moving.length === 1) {
          const over = document.elementFromPoint(ev.clientX, ev.clientY);
          const row = over && over.closest('.tl-row');
          const t2 = row && p.tracks.find((t) => t.id === row.dataset.track);
          if (t2 && t2 !== targetTrack && t2.kind === tr.kind && !t2.locked) {
            targetTrack.clips.splice(targetTrack.clips.indexOf(c), 1);
            t2.clips.push(c);
            targetTrack = t2;
          }
        }
      } else if (mode === 'trimL') {
        const s = this.snap(o.start + dt, except);
        let d = s - o.start;
        d = Math.max(d, -o.start, -o.in / c.speed);
        d = Math.min(d, o.dur - 0.1);
        c.start = o.start + d;
        c.dur = o.dur - d;
        c.in = o.in + d * c.speed;
      } else if (mode === 'trimR') {
        const s = this.snap(o.start + o.dur + dt, except);
        let du = s - o.start;
        du = Math.max(0.1, du);
        if (maxSrc !== Infinity) du = Math.min(du, (maxSrc - c.in) / c.speed);
        c.dur = du;
      } else if (mode === 'fadeIn') c.fadeIn = clamp(o.fadeIn + dt, 0, c.dur / 2);
      else if (mode === 'fadeOut') c.fadeOut = clamp(o.fadeOut - dt, 0, c.dur / 2);
      this.render();
      this.engine.redraw();
      if (mode === 'trimL') this.engine.seek(c.start);
      if (mode === 'trimR') this.engine.seek(end(c) - 1 / 30);
    };
    const up = () => {
      this.el.removeEventListener('pointermove', mv);
      this.el.removeEventListener('pointerup', up);
      if (!changed) return;
      // Record the change for undo: put it back, then apply it as one step.
      const after = moving.map((x) => ({ x, start: x.start, dur: x.dur, in: x.in, fadeIn: x.fadeIn, fadeOut: x.fadeOut }));
      const moved = targetTrack !== tr;
      if (moved) { targetTrack.clips.splice(targetTrack.clips.indexOf(c), 1); tr.clips.push(c); }
      for (const q of orig) Object.assign(q.x, { start: q.start, dur: q.dur, in: q.in, fadeIn: q.fadeIn, fadeOut: q.fadeOut });
      const label = { move: 'Move clip', trimL: 'Trim clip', trimR: 'Trim clip', fadeIn: 'Fade in', fadeOut: 'Fade out' }[mode];
      this.edit(label, () => {
        for (const q of after) Object.assign(q.x, { start: q.start, dur: q.dur, in: q.in, fadeIn: q.fadeIn, fadeOut: q.fadeOut });
        if (moved) { tr.clips.splice(tr.clips.indexOf(c), 1); targetTrack.clips.push(c); }
      });
    };
    this.el.addEventListener('pointermove', mv);
    this.el.addEventListener('pointerup', up);
  }
}
