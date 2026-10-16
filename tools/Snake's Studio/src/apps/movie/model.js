// The movie project: media, tracks and clips, and the edits made to them.
//
// Times are seconds. A clip sits at `start` on the timeline for `dur` seconds
// and shows its media from `in`, at `speed` (so it uses in … in + dur × speed).
// Video tracks are drawn bottom first; text tracks on top; audio tracks mix.
import { uid } from '../../kit/dom.js';

export const RESOLUTIONS = [
  { label: '1080p landscape (1920 × 1080)', w: 1920, h: 1080 },
  { label: '720p landscape (1280 × 720)', w: 1280, h: 720 },
  { label: '4K landscape (3840 × 2160)', w: 3840, h: 2160 },
  { label: 'Vertical for phones (1080 × 1920)', w: 1080, h: 1920 },
  { label: 'Square (1080 × 1080)', w: 1080, h: 1080 },
  { label: 'Portrait post (1080 × 1350)', w: 1080, h: 1350 },
];

export const LOOKS = {
  none: { label: 'Original', f: {} },
  bw: { label: 'Black and white', f: { gray: 1, contrast: 1.1 } },
  sepia: { label: 'Sepia', f: { sepia: 0.85, contrast: 1.05 } },
  vivid: { label: 'Vivid', f: { saturation: 1.45, contrast: 1.12 } },
  warm: { label: 'Warm', f: { sepia: 0.25, saturation: 1.15, hue: -8 } },
  cool: { label: 'Cool', f: { hue: 12, saturation: 0.9, brightness: 1.03 } },
  vintage: { label: 'Vintage', f: { sepia: 0.45, contrast: 0.9, saturation: 0.8, brightness: 1.05 } },
  dramatic: { label: 'Dramatic', f: { contrast: 1.35, saturation: 0.75, brightness: 0.95 } },
  faded: { label: 'Faded', f: { contrast: 0.8, brightness: 1.08, saturation: 0.85 } },
  dream: { label: 'Dreamy blur', f: { blur: 3, brightness: 1.08, saturation: 1.1 } },
};

export const TITLE_ANIMS = { none: 'None', fade: 'Fade', slide: 'Slide in', rise: 'Rise up' };

export const TRANSITIONS = {
  none: 'None',
  crossfade: 'Cross-fade',
  black: 'Fade through black',
  slideLeft: 'Slide from the right',
  slideRight: 'Slide from the left',
  slideUp: 'Slide up',
};

export const TITLE_PRESETS = {
  big: { label: 'Big title', text: 'Your Title', style: { font: 'Inter', size: 0.12, color: '#ffffff', weight: 800, outline: 0, shadow: 0.35, bg: '', align: 'center', x: 0.5, y: 0.5 }, anim: 'fade' },
  subtitle: { label: 'Subtitle', text: 'A line of text', style: { font: 'Inter', size: 0.055, color: '#ffffff', weight: 600, outline: 0.12, shadow: 0, bg: '', align: 'center', x: 0.5, y: 0.86 }, anim: 'fade' },
  lower: { label: 'Lower third', text: 'Name Surname\nWhat they do', style: { font: 'Inter', size: 0.05, color: '#ffffff', weight: 700, outline: 0, shadow: 0, bg: '#1f883dcc', align: 'left', x: 0.28, y: 0.8 }, anim: 'slide' },
  box: { label: 'Caption box', text: 'Caption', style: { font: 'Inter', size: 0.06, color: '#111111', weight: 700, outline: 0, shadow: 0, bg: '#ffffffe6', align: 'center', x: 0.5, y: 0.5 }, anim: 'rise' },
  neon: { label: 'Neon', text: 'NEON', style: { font: 'Inter', size: 0.14, color: '#7ee787', weight: 900, outline: 0, shadow: 0.9, glow: '#3fb950', bg: '', align: 'center', x: 0.5, y: 0.5 }, anim: 'rise' },
  credits: { label: 'The end', text: 'The End', style: { font: 'Georgia', size: 0.1, color: '#ffffff', weight: 400, italic: true, outline: 0, shadow: 0.3, bg: '', align: 'center', x: 0.5, y: 0.5 }, anim: 'fade' },
};

export function newProject({ w = 1920, h = 1080, fps = 30 } = {}) {
  return {
    version: 1, width: w, height: h, fps, background: '#000000',
    media: [],
    tracks: [
      { id: uid('t'), kind: 'text', name: 'Titles', clips: [] },
      { id: uid('t'), kind: 'video', name: 'Overlay', clips: [] },
      { id: uid('t'), kind: 'video', name: 'Video', clips: [], main: true },
      { id: uid('t'), kind: 'audio', name: 'Music', clips: [] },
      { id: uid('t'), kind: 'audio', name: 'Voice', clips: [] },
    ],
  };
}

export function newClip(props) {
  return {
    id: uid('c'), start: 0, dur: 5, in: 0, speed: 1, volume: 1, muted: false, fadeIn: 0, fadeOut: 0,
    fit: 'contain', x: 0.5, y: 0.5, scale: 1, rotate: 0, opacity: 1, look: 'none', filters: {}, transition: null, motion: null,
    ...props,
  };
}

export const end = (c) => c.start + c.dur;
export const projectDuration = (p) => Math.max(0, ...p.tracks.flatMap((t) => t.clips.map(end)));
export const mediaOf = (p, c) => p.media.find((m) => m.id === c.mediaId) || null;
export const trackOf = (p, c) => p.tracks.find((t) => t.clips.includes(c)) || null;
export const findClip = (p, id) => { for (const t of p.tracks) { const c = t.clips.find((x) => x.id === id); if (c) return c; } return null; };

/** Video and image tracks bottom first, then titles: the drawing order. */
export function drawOrder(p) {
  const vids = p.tracks.filter((t) => t.kind === 'video').reverse();
  const texts = p.tracks.filter((t) => t.kind === 'text').reverse();
  return [...vids, ...texts];
}

/** Clips showing at time t, in drawing order (with the track each sits on). */
export function activeAt(p, t) {
  const out = [];
  for (const tr of drawOrder(p)) {
    if (tr.hidden) continue;
    const list = tr.clips.filter((c) => c.start <= t + 1e-6 && t < end(c) - 1e-6).sort((a, b) => a.start - b.start);
    for (const c of list) out.push({ c, tr });
  }
  return out;
}

/** Where a clip's media time is at timeline time t. */
export const sourceTime = (c, t) => c.in + (t - c.start) * c.speed;

/** How far into a fade or transition: 0..1 alpha for time t. */
export function clipAlpha(c, t) {
  let a = c.opacity ?? 1;
  const local = t - c.start;
  const left = end(c) - t;
  const tr = c.transition && c.transition.kind !== 'none' ? c.transition : null;
  if (tr && tr.kind === 'crossfade' && local < tr.dur) a *= Math.max(0, local / tr.dur);
  else if (c.fadeIn > 0 && local < c.fadeIn) a *= Math.max(0, local / c.fadeIn);
  if (c.fadeOut > 0 && left < c.fadeOut) a *= Math.max(0, left / c.fadeOut);
  return a;
}

/** Fade-to-black amount (0 = none, 1 = black) for "fade through black" transitions. */
export function blackAt(p, t) {
  let k = 0;
  for (const tr of p.tracks) {
    if (tr.kind !== 'video' || tr.hidden) continue;
    for (const c of tr.clips) {
      const x = c.transition;
      if (!x || x.kind !== 'black') continue;
      // Half the time going to black (before the clip), half coming back.
      const d = x.dur / 2;
      if (t >= c.start - d && t < c.start) k = Math.max(k, 1 - (c.start - t) / d);
      else if (t >= c.start && t < c.start + d) k = Math.max(k, 1 - (t - c.start) / d);
    }
  }
  return Math.min(1, k);
}

/** Position offset for slide and zoom transitions: { dx, dy, s } as fractions of the frame. */
export function transitionMotion(c, t) {
  const tr = c.transition;
  if (!tr || !['slideLeft', 'slideRight', 'slideUp'].includes(tr.kind)) return null;
  const k = Math.min(1, Math.max(0, (t - c.start) / tr.dur));
  if (k >= 1) return null;
  const e = 1 - (1 - k) ** 3; // ease out
  if (tr.kind === 'slideLeft') return { dx: 1 - e, dy: 0, s: 1 };
  if (tr.kind === 'slideRight') return { dx: -(1 - e), dy: 0, s: 1 };
  return { dx: 0, dy: 1 - e, s: 1 };
}

/** The filters of a clip (its look plus its own settings). */
export function clipFilters(c) {
  return { brightness: 1, contrast: 1, saturation: 1, hue: 0, gray: 0, sepia: 0, blur: 0, ...((LOOKS[c.look] || LOOKS.none).f), ...(c.filters || {}) };
}

/** The same filters as a canvas filter string. */
export function cssFilter(f) {
  const parts = [];
  if (f.brightness !== 1) parts.push(`brightness(${f.brightness})`);
  if (f.contrast !== 1) parts.push(`contrast(${f.contrast})`);
  if (f.saturation !== 1) parts.push(`saturate(${f.saturation})`);
  if (f.hue) parts.push(`hue-rotate(${f.hue}deg)`);
  if (f.gray) parts.push(`grayscale(${f.gray})`);
  if (f.sepia) parts.push(`sepia(${f.sepia})`);
  if (f.blur) parts.push(`blur(${f.blur}px)`);
  return parts.join(' ') || 'none';
}

// ---------------------------------------------------------------------------
// Edits (plain functions on the project; the app wraps them in undo steps)
// ---------------------------------------------------------------------------
/** Cut a clip in two at timeline time t. Returns the new right-hand clip. */
export function split(p, c, t) {
  if (t <= c.start + 0.05 || t >= end(c) - 0.05) return null;
  const tr = trackOf(p, c);
  const right = { ...JSON.parse(JSON.stringify(c)), id: uid('c') };
  const leftDur = t - c.start;
  right.start = t;
  right.dur = c.dur - leftDur;
  right.in = c.in + leftDur * c.speed;
  right.fadeIn = 0;
  right.transition = null;
  c.dur = leftDur;
  c.fadeOut = 0;
  if (right.motion) {
    // Ken Burns continues from where it had got to.
    const k = leftDur / (leftDur + right.dur);
    const mid = { s: lerp(c.motion.from.s, c.motion.to.s, k), x: lerp(c.motion.from.x, c.motion.to.x, k), y: lerp(c.motion.from.y, c.motion.to.y, k) };
    c.motion = { ...c.motion, to: mid };
    right.motion = { ...right.motion, from: mid };
  }
  tr.clips.splice(tr.clips.indexOf(c) + 1, 0, right);
  return right;
}
const lerp = (a, b, k) => a + (b - a) * k;

/** Shift everything on a track that starts at or after `from` by `delta` seconds. */
export function ripple(tr, from, delta, except = null) {
  for (const c of tr.clips) if (c !== except && c.start >= from - 1e-6) c.start = Math.max(0, c.start + delta);
}

export function removeClip(p, c, { rippleTrack = false } = {}) {
  const tr = trackOf(p, c);
  if (!tr) return;
  tr.clips.splice(tr.clips.indexOf(c), 1);
  if (rippleTrack) ripple(tr, end(c), -c.dur);
}

/** The end of the last clip on a track (where new clips go). */
export const trackEnd = (tr) => Math.max(0, ...tr.clips.map(end));

/** Edges clips can snap to: clip starts and ends, the playhead, zero. */
export function snapPoints(p, except = new Set(), playhead = 0) {
  const pts = [0, playhead];
  for (const t of p.tracks) for (const c of t.clips) if (!except.has(c.id)) pts.push(c.start, end(c));
  return pts;
}

/** Media a project file needs, for saving: paths, never page tokens. */
export function serialise(p) {
  return JSON.stringify({
    ...p,
    media: p.media.map((m) => ({ id: m.id, name: m.name, kind: m.kind, duration: m.duration, width: m.width, height: m.height, hasAudio: m.hasAudio, path: m.path || '' })),
  }, null, 1);
}

/** A project read from a file, checked and with defaults filled in. */
export function parseProject(text) {
  const j = JSON.parse(text);
  if (!j || !Array.isArray(j.tracks) || !Array.isArray(j.media)) throw new Error('This is not a Snake\'s Movie Maker project.');
  const num = (v, d, lo, hi) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Number(v))) : d);
  const p = {
    version: 1, width: num(j.width, 1920, 16, 7680), height: num(j.height, 1080, 16, 7680), fps: num(j.fps, 30, 1, 120),
    background: /^#[0-9a-f]{6}$/i.test(j.background) ? j.background : '#000000',
    media: j.media.slice(0, 2000).map((m) => ({ id: String(m.id), name: String(m.name || ''), kind: ['video', 'audio', 'image'].includes(m.kind) ? m.kind : 'video', duration: num(m.duration, 0, 0, 1e6), width: num(m.width, 0, 0, 16384), height: num(m.height, 0, 0, 16384), hasAudio: !!m.hasAudio, path: String(m.path || ''), missing: true })),
    tracks: j.tracks.slice(0, 50).map((t) => ({
      id: String(t.id || uid('t')), kind: ['video', 'audio', 'text'].includes(t.kind) ? t.kind : 'video', name: String(t.name || 'Track').slice(0, 60), main: !!t.main,
      muted: !!t.muted, hidden: !!t.hidden, locked: !!t.locked,
      clips: (t.clips || []).slice(0, 5000).map((c) => newClip({ ...c, id: String(c.id || uid('c')), start: num(c.start, 0, 0, 1e6), dur: num(c.dur, 1, 0.04, 1e6), in: num(c.in, 0, 0, 1e6), speed: num(c.speed, 1, 0.1, 16) })),
    })),
  };
  return p;
}
