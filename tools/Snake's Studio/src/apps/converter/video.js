// Video for the browser Converter. The browser plays the video and records what it plays
// (so converting takes as long as the video lasts); GIFs are made frame by frame. The
// desktop and Android Converters use ffmpeg: much faster and every format.
import { GifEncoder } from '../../kit/gif.js';
import { withDuration } from '../../kit/webm.js';

/** Load a video file into a <video> (muted for the page; its sound is taken separately). */
async function load(url) {
  const v = document.createElement('video');
  v.src = url;
  v.playsInline = true;
  v.preload = 'auto';
  v.crossOrigin = 'anonymous';
  // Some browsers only play a video that is part of the page: off-screen, then.
  Object.assign(v.style, { position: 'fixed', left: '-10000px', top: '0', width: '2px', height: '2px' });
  document.body.append(v);
  await new Promise((resolve, reject) => {
    v.addEventListener('loadedmetadata', resolve, { once: true });
    v.addEventListener('error', () => reject(new Error('This browser cannot play this video.')), { once: true });
  });
  return v;
}

const fit = (w, h, maxW) => (maxW && w > maxW ? [maxW, Math.round((h * maxW) / w / 2) * 2] : [w & ~1, h & ~1]);

export function videoTypes() {
  const ok = (m) => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(m);
  const out = [];
  if (ok('video/mp4')) out.push(['mp4', 'video/mp4']);
  if (ok('video/webm;codecs=vp9,opus')) out.push(['webm', 'video/webm;codecs=vp9,opus']);
  else if (ok('video/webm')) out.push(['webm', 'video/webm']);
  return out;
}

/** Re-record a video as `mime`, at most `maxW` pixels wide. progress(0..1). */
export async function transcode(url, { mime, maxW = 0, fps = 30, bitrate = 5_000_000 }, progress = () => {}, signal = null) {
  const v = await load(url);
  const [w, h] = fit(v.videoWidth, v.videoHeight, maxW);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  const tracks = [canvas.captureStream(fps).getVideoTracks()[0]];
  let audio = null;
  try {
    audio = new AudioContext();
    const src = audio.createMediaElementSource(v);
    const dest = audio.createMediaStreamDestination();
    src.connect(dest); // into the recording only, not the speakers
    if (dest.stream.getAudioTracks()[0]) tracks.push(dest.stream.getAudioTracks()[0]);
  } catch { audio = null; }
  const rec = new MediaRecorder(new MediaStream(tracks), { mimeType: mime, videoBitsPerSecond: bitrate, audioBitsPerSecond: 160_000 });
  const chunks = [];
  rec.addEventListener('dataavailable', (e) => { if (e.data.size) chunks.push(e.data); });
  let frame = 0;
  const draw = () => {
    ctx.drawImage(v, 0, 0, w, h);
    progress(v.duration ? v.currentTime / v.duration : 0);
    if (!v.ended && !v.paused) frame = (v.requestVideoFrameCallback ? v.requestVideoFrameCallback(draw) : requestAnimationFrame(draw));
  };
  const stopped = new Promise((r) => rec.addEventListener('stop', r, { once: true }));
  rec.start(1000);
  await v.play();
  draw();
  await new Promise((resolve, reject) => {
    v.addEventListener('ended', resolve, { once: true });
    v.addEventListener('error', () => reject(new Error('The video stopped playing.')), { once: true });
    if (signal) signal.addEventListener('abort', () => { v.pause(); reject(new DOMException('Cancelled', 'AbortError')); }, { once: true });
  }).finally(() => {
    cancelAnimationFrame(frame);
    rec.stop();
  });
  await stopped;
  const length = v.duration * 1000;
  tracks.forEach((t) => t.stop());
  if (audio) audio.close().catch(() => {});
  v.removeAttribute('src');
  v.load();
  v.remove();
  const bytes = new Uint8Array(await new Blob(chunks).arrayBuffer());
  return mime.startsWith('video/webm') ? withDuration(bytes, length) : bytes;
}

/** A GIF of a video: `fps` frames a second, at most `maxW` wide, at most `maxSeconds`. */
export async function videoToGif(url, { fps = 10, maxW = 480, maxSeconds = 30 }, progress = () => {}, signal = null) {
  const v = await load(url);
  v.muted = true;
  const [w, h] = fit(v.videoWidth, v.videoHeight, maxW);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const gif = new GifEncoder(w, h);
  const end = Math.min(v.duration || 0, maxSeconds);
  for (let t = 0; t < end; t += 1 / fps) {
    if (signal && signal.aborted) throw new DOMException('Cancelled', 'AbortError');
    await new Promise((r) => { v.addEventListener('seeked', r, { once: true }); v.currentTime = t; });
    ctx.drawImage(v, 0, 0, w, h);
    gif.addFrame(ctx.getImageData(0, 0, w, h).data, 100 / fps);
    progress(t / end);
  }
  v.removeAttribute('src');
  v.load();
  v.remove();
  return gif.finish();
}

/** A still from the middle of a video (its thumbnail), as a canvas. */
export async function videoFrame(url, at = 0.5) {
  const v = await load(url);
  v.muted = true;
  await new Promise((r) => { v.addEventListener('seeked', r, { once: true }); v.currentTime = (v.duration || 0) * at; });
  const c = document.createElement('canvas');
  c.width = v.videoWidth;
  c.height = v.videoHeight;
  c.getContext('2d').drawImage(v, 0, 0);
  v.removeAttribute('src');
  v.load();
  v.remove();
  return c;
}
