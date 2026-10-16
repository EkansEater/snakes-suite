// Drawing one frame of the movie. The preview and the export both use this,
// so what you see while editing is what the finished film looks like.
import { activeAt, mediaOf, clipAlpha, blackAt, transitionMotion, clipFilters, cssFilter, end } from './model.js';

export const TITLE_FADE = 0.5;

/** Where a picture clip sits in the frame: centre, size, turn (pixels, degrees). */
export function placement(p, c, mw, mh) {
  const W = p.width;
  const H = p.height;
  let w;
  let h;
  if (c.fit === 'stretch') { w = W; h = H; } else {
    const s0 = c.fit === 'cover' ? Math.max(W / mw, H / mh) : Math.min(W / mw, H / mh);
    w = mw * s0;
    h = mh * s0;
  }
  return { cx: c.x * W, cy: c.y * H, w: w * c.scale, h: h * c.scale, rot: c.rotate || 0 };
}

/** Ken Burns: the part of a picture in view at time t (source pixels). */
export function motionRect(c, t, mw, mh) {
  const m = c.motion;
  const k = Math.min(1, Math.max(0, (t - c.start) / Math.max(0.001, c.dur)));
  const e = k * k * (3 - 2 * k); // smooth start and stop
  const s = m.from.s + (m.to.s - m.from.s) * e;
  const x = m.from.x + (m.to.x - m.from.x) * e;
  const y = m.from.y + (m.to.y - m.from.y) * e;
  const sw = mw / s;
  const sh = mh / s;
  return { sx: Math.min(mw - sw, Math.max(0, x * mw - sw / 2)), sy: Math.min(mh - sh, Math.max(0, y * mh - sh / 2)), sw, sh };
}

/**
 * Draw the frame at time t. `source(c)` gives a drawable for a clip (a video
 * element at the right moment, or a decoded picture) and its size.
 */
export function drawFrame(ctx, p, t, source, { titles = true } = {}) {
  const W = p.width;
  const H = p.height;
  ctx.save();
  ctx.fillStyle = p.background || '#000';
  ctx.fillRect(0, 0, W, H);
  for (const { c, tr } of activeAt(p, t)) {
    if (tr.kind === 'text') { if (titles) drawTitle(ctx, p, c, t); continue; }
    const s = source(c);
    if (!s || !s.w || !s.h) continue;
    const a = clipAlpha(c, t);
    if (a <= 0.001) continue;
    const pl = placement(p, c, s.w, s.h);
    const mo = transitionMotion(c, t);
    ctx.save();
    ctx.globalAlpha = Math.min(1, a);
    ctx.filter = cssFilter(clipFilters(c));
    ctx.translate(pl.cx + (mo ? mo.dx * W : 0), pl.cy + (mo ? mo.dy * H : 0));
    if (pl.rot) ctx.rotate((pl.rot * Math.PI) / 180);
    if (mo && mo.s !== 1) ctx.scale(mo.s, mo.s);
    ctx.imageSmoothingQuality = 'high';
    const m = mediaOf(p, c);
    if (c.motion && m && m.kind === 'image') {
      const r = motionRect(c, t, s.w, s.h);
      ctx.drawImage(s.el, r.sx, r.sy, r.sw, r.sh, -pl.w / 2, -pl.h / 2, pl.w, pl.h);
    } else ctx.drawImage(s.el, -pl.w / 2, -pl.h / 2, pl.w, pl.h);
    ctx.restore();
  }
  const k = blackAt(p, t);
  if (k > 0) { ctx.fillStyle = `rgba(0,0,0,${k})`; ctx.fillRect(0, 0, W, H); }
  ctx.restore();
}

// ---------------------------------------------------------------------------
// Titles
// ---------------------------------------------------------------------------
const fontOf = (st, px) => `${st.italic ? 'italic ' : ''}${st.weight || 600} ${px}px "${st.font || 'Inter'}", "Inter", sans-serif`;

/** The block a title occupies: lines, box and text positions (frame pixels). */
export function titleLayout(ctx, p, c) {
  const st = c.style || {};
  const H = p.height;
  const W = p.width;
  const px = Math.max(6, (st.size || 0.08) * H);
  ctx.save();
  ctx.font = fontOf(st, px);
  const lines = String(c.text || '').split('\n');
  const widths = lines.map((l) => ctx.measureText(l).width);
  ctx.restore();
  const lh = px * 1.18;
  const bw = Math.max(...widths, 1);
  const bh = lines.length * lh;
  const pad = st.bg ? px * 0.35 : 0;
  const ax = (st.x ?? 0.5) * W;
  const ay = (st.y ?? 0.5) * H;
  const left = st.align === 'left' ? ax : st.align === 'right' ? ax - bw : ax - bw / 2;
  const top = ay - bh / 2;
  return { px, lh, lines, widths, bw, bh, pad, left, top, box: { x: left - pad, y: top - pad, w: bw + pad * 2, h: bh + pad * 2 } };
}

/** Fade, slide and rise animations of a title at time t: { a, dx, dy } (pixels). */
export function titleMotion(p, c, t) {
  const d = Math.min(TITLE_FADE, c.dur / 3);
  const local = t - c.start;
  const left = end(c) - t;
  const inK = d > 0 ? Math.min(1, Math.max(0, local / d)) : 1;
  const outK = d > 0 ? Math.min(1, Math.max(0, left / d)) : 1;
  const anim = c.anim || 'fade';
  if (anim === 'none') return { a: 1, dx: 0, dy: 0 };
  const a = Math.min(inK, outK);
  const e = 1 - (1 - inK) ** 3;
  if (anim === 'slide') return { a, dx: -(1 - e) * p.width * 0.08, dy: 0 };
  if (anim === 'rise') return { a, dx: 0, dy: (1 - e) * p.height * 0.06 };
  return { a, dx: 0, dy: 0 };
}

/** Draw a title, animated for time t (or still, when t is null). */
export function drawTitle(ctx, p, c, t) {
  const st = c.style || {};
  const L = titleLayout(ctx, p, c);
  const mo = t === null ? { a: 1, dx: 0, dy: 0 } : titleMotion(p, c, t);
  if (mo.a <= 0.001) return;
  ctx.save();
  ctx.globalAlpha = mo.a * (c.opacity ?? 1);
  ctx.translate(mo.dx, mo.dy);
  if (st.bg) {
    ctx.fillStyle = st.bg;
    const r = L.px * 0.18;
    ctx.beginPath();
    ctx.roundRect(L.box.x, L.box.y, L.box.w, L.box.h, r);
    ctx.fill();
  }
  ctx.font = fontOf(st, L.px);
  ctx.textBaseline = 'middle';
  ctx.lineJoin = 'round';
  L.lines.forEach((line, i) => {
    const x = st.align === 'left' ? L.left : st.align === 'right' ? L.left + L.bw - L.widths[i] : L.left + (L.bw - L.widths[i]) / 2;
    const y = L.top + L.lh * (i + 0.5);
    if (st.shadow || st.glow) {
      ctx.save();
      ctx.shadowColor = st.glow || 'rgba(0,0,0,.75)';
      ctx.shadowBlur = L.px * (st.shadow || 0.4) * (st.glow ? 0.6 : 0.3);
      ctx.shadowOffsetY = st.glow ? 0 : L.px * 0.04;
      ctx.fillStyle = st.color || '#fff';
      ctx.fillText(line, x, y);
      ctx.restore();
    }
    if (st.outline) {
      ctx.strokeStyle = st.outlineColor || '#000';
      ctx.lineWidth = L.px * st.outline;
      ctx.strokeText(line, x, y);
    }
    ctx.fillStyle = st.color || '#fff';
    ctx.fillText(line, x, y);
  });
  ctx.restore();
}
