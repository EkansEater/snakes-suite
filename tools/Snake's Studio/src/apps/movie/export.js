// Getting the film out. With ffmpeg (the desktop app) the timeline becomes a
// job description the main process turns into one ffmpeg command, using the
// same placement maths as the preview. Without it (the website), the preview
// is recorded as it plays.
import { mediaOf, end, projectDuration, clipFilters } from './model.js';
import { placement, drawTitle } from './render.js';
import { makeCanvas, canvasBytes } from '../../kit/raster.js';

/** A title drawn still, full frame, for the export to lay over the video. */
async function titlePng(p, c) {
  const cv = makeCanvas(p.width, p.height);
  drawTitle(cv.getContext('2d'), p, { ...c, opacity: 1 }, null);
  return canvasBytes(cv, 'image/png');
}

/** The job the main process turns into an ffmpeg command. */
export async function buildJob(p, { format = 'mp4', quality = 'good', range = null } = {}) {
  const D = projectDuration(p);
  const t0 = range ? range[0] : 0;
  const t1 = range ? range[1] : D;
  const layers = [];
  const overlays = [];
  const audio = [];
  const blacks = [];
  const inRange = (c) => end(c) > t0 && c.start < t1;
  // Pictures, bottom track first, then titles on top (as the preview draws them).
  const vids = p.tracks.filter((t) => t.kind === 'video').reverse();
  for (const tr of vids) {
    for (const c of [...tr.clips].sort((a, b) => a.start - b.start)) {
      if (!inRange(c)) continue;
      const m = mediaOf(p, c);
      if (!m || !m.token) continue;
      // Fade through black lives on its own layer, above everything.
      if (c.transition && c.transition.kind === 'black') blacks.push({ kind: 'black', start: c.start - c.transition.dur / 2 - t0, dur: c.transition.dur });
      if (tr.hidden) continue;
      const pl = placement(p, c, m.width || p.width, m.height || p.height);
      const cross = c.transition && c.transition.kind === 'crossfade' ? c.transition.dur : 0;
      const slide = c.transition && ['slideLeft', 'slideRight', 'slideUp'].includes(c.transition.kind) ? { kind: c.transition.kind, dur: c.transition.dur, } : null;
      // Clips cut by the range start partway in.
      const cut = Math.max(0, t0 - c.start);
      layers.push({
        kind: 'clip', token: m.token, media: m.kind === 'image' ? 'image' : 'video',
        start: c.start - t0 + cut, dur: Math.min(c.dur - cut, t1 - c.start - cut), in: c.in + cut * c.speed, speed: c.speed,
        w: pl.w, h: pl.h, cx: pl.cx, cy: pl.cy, rot: pl.rot, filters: clipFilters(c), opacity: c.opacity ?? 1,
        fadeIn: cut ? 0 : Math.max(c.fadeIn || 0, cross), fadeOut: c.fadeOut || 0,
        slide: cut ? null : slide && { ...slide, kind: slide.kind },
        motion: m.kind === 'image' && c.motion ? c.motion : null,
      });
      if (slide && !cut) layers[layers.length - 1].slide.start = c.start - t0;
    }
  }
  for (const tr of p.tracks.filter((t) => t.kind === 'text').reverse()) {
    if (tr.hidden) continue;
    for (const c of tr.clips) {
      if (!inRange(c) || !String(c.text || '').trim()) continue;
      overlays.push({ png: await titlePng(p, c) });
      layers.push({ kind: 'title', index: overlays.length - 1, start: c.start - t0, dur: c.dur, anim: c.anim || 'fade', opacity: c.opacity ?? 1 });
    }
  }
  layers.push(...blacks);
  // Sound: audio tracks, and the sound of video clips (unless muted).
  for (const tr of p.tracks) {
    if (tr.kind === 'text' || tr.muted) continue;
    for (const c of tr.clips) {
      const m = mediaOf(p, c);
      if (!m || !m.token || c.muted || !inRange(c)) continue;
      if (m.kind === 'image' || (tr.kind === 'video' && m.hasAudio === false)) continue;
      const cut = Math.max(0, t0 - c.start);
      audio.push({ token: m.token, start: c.start - t0 + cut, dur: Math.min(c.dur - cut, t1 - c.start - cut), in: c.in + cut * c.speed, speed: c.speed, volume: c.volume ?? 1, fadeIn: cut ? 0 : c.fadeIn || 0, fadeOut: c.fadeOut || 0 });
    }
  }
  return { width: p.width, height: p.height, fps: p.fps, duration: Math.max(0.1, t1 - t0), background: p.background, format, quality, layers, overlays, audio };
}

/**
 * Without ffmpeg: play the film from the start and record what the preview
 * shows (WebM). Takes as long as the film.
 */
export function recordPreview(engine, { fps = 30, onProgress = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    const stream = engine.recordStream(fps);
    const types = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    const mimeType = types.find((t) => window.MediaRecorder && MediaRecorder.isTypeSupported(t));
    if (!mimeType) { reject(new Error('This browser cannot record video.')); return; }
    const rec = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8e6, audioBitsPerSecond: 192000 });
    const chunks = [];
    const D = engine.duration;
    rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
    rec.onstop = async () => {
      clearInterval(timer);
      engine.onState = prevState;
      stream.getTracks().forEach((t) => t.stop());
      resolve(new Uint8Array(await new Blob(chunks, { type: 'video/webm' }).arrayBuffer()));
    };
    rec.onerror = (e) => reject(e.error || new Error('Recording failed'));
    const prevState = engine.onState;
    engine.onState = (playing) => { prevState(playing); if (!playing && rec.state === 'recording') rec.stop(); };
    engine.pause();
    engine.seek(0);
    rec.start(1000);
    engine.play();
    const timer = setInterval(() => onProgress(Math.min(1, engine.t / Math.max(0.1, D))), 250);
    recordPreview.cancel = () => { engine.pause(); };
  });
}
