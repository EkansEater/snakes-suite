// Snake's Player: plays video and music, with a playlist, subtitles, an
// equaliser, speed control, A-B loops, snapshots and on-the-fly conversion of
// formats the built-in player cannot handle (through ffmpeg, when installed).
import { h, clamp, extOf, baseName, fmtTime, fmtBytes, uid } from '../../kit/dom.js';
import { icon } from '../../kit/icons.js';
import { host, inElectron } from '../../kit/host.js';
import * as commands from '../../kit/commands.js';
import { createShell, onDropFiles, refresh, splitter, select } from '../../kit/shell.js';
import { showMenu, contextMenu } from '../../kit/menu.js';
import { modal, toast, errorToast } from '../../kit/dialogs.js';
import { canvasBytes } from '../../kit/raster.js';
import { parseSubtitles, cuesAt, cueNodes, decodeSubtitleBytes } from './subs.js';
import { AudioChain, BANDS, EQ_PRESETS } from './audio.js';

const VIDEO = ['mp4', 'm4v', 'mkv', 'webm', 'mov', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', 'm2ts', '3gp', 'ogv'];
const AUDIO = ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'oga', 'opus', 'wma', 'aiff', 'aif', 'mka'];
const PLAYLISTS = ['m3u', 'm3u8', 'pls'];
const SUBS = ['srt', 'vtt', 'ass', 'ssa'];
const OPEN_FILTERS = [{ name: 'Media and playlists', exts: [...VIDEO, ...AUDIO, ...PLAYLISTS] }, { name: 'Video', exts: VIDEO }, { name: 'Music', exts: AUDIO }, { name: 'Playlists', exts: PLAYLISTS }];
// What Chromium plays by itself; anything else goes through ffmpeg.
const DIRECT_CONTAINERS = ['mp4', 'm4v', 'mov', 'webm', 'ogv', 'ogg', 'oga', 'opus', 'mp3', 'm4a', 'aac', 'flac', 'wav'];
const DIRECT_VIDEO = ['h264', 'vp8', 'vp9', 'av1', 'theora'];
const DIRECT_AUDIO = ['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_s32le', 'pcm_f32le', 'pcm_u8'];
const TEXT_SUBS = ['subrip', 'ass', 'ssa', 'webvtt', 'mov_text', 'text'];
const ASPECTS = { auto: null, '16:9': 16 / 9, '4:3': 4 / 3, '21:9': 21 / 9, '1:1': 1, '9:16': 9 / 16, '2.35:1': 2.35 };
const SPEEDS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 3, 4];

const shell = await createShell({
  id: 'player', name: "Snake's Player",
  quick: [],
  menus: [
    { label: '&Media', items: () => mediaMenu() },
    { label: '&Playback', items: () => playbackMenu() },
    { label: '&Audio', items: () => audioMenu() },
    { label: '&Video', items: () => videoMenu() },
    { label: 'S&ubtitles', items: () => subtitleMenu() },
    { label: 'Vie&w', items: () => viewMenu() },
    { label: '&Help', items: () => [I('app.palette'), I('app.shortcuts'), { type: 'separator' }, I('app.about')] },
  ],
  about: 'Plays video and music: playlists (M3U, PLS), subtitles (SRT, VTT, ASS and ones inside the video), a 10-band equaliser, speed control, A-B loops, snapshots, resume where you left off, and conversion. With ffmpeg installed it plays almost any format (MKV, AVI, WMV, FLAC, WMA, AC3, HEVC…) by converting on the fly.',
});
shell.showStatus(false);
const settings = host.settings;
const I = (id, extra) => commands.item(id, extra);
const hasFfmpeg = !!(shell.info && shell.info.ffmpeg) && !!host.media;

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------
const video = h('video.pl-video', { playsinline: true, preload: 'auto', disablePictureInPicture: false });
if (inElectron) video.crossOrigin = 'anonymous';
const art = h('div.pl-art');
const viz = h('canvas.pl-viz');
const subBox = h('div.pl-subs');
const osd = h('div.pl-osd');
const empty = h('div.pl-empty',
  h('div.pl-empty-icon', { html: icon('play', 54) }),
  h('div', 'Drop videos or music here'),
  h('div.row', { style: { gap: '8px', justifyContent: 'center' } },
    h('button.btn.primary', { onclick: () => commands.run('media.open') }, 'Open files…'),
    h('button.btn', { onclick: () => commands.run('media.openFolder') }, 'Open a folder…')),
  h('div.muted.pl-hint', hasFfmpeg ? 'Plays almost any format.' : inElectron ? 'Tip: install ffmpeg to play MKV, AVI, WMV, FLAC, AC3 and more.' : ''));
const errBox = h('div.pl-error.hidden');
const stage = h('div.pl-stage', { tabindex: 0 }, art, viz, video, subBox, osd, empty, errBox);

// The seek bar.
const barBuffered = h('div.pl-buffered');
const barPlayed = h('div.pl-played');
const barKnob = h('div.pl-knob');
const barMarks = h('div.pl-marks');
const barAB = h('div.pl-ab');
const tipTime = h('div.pl-tip-time');
const tipImg = h('img.pl-tip-img', { alt: '' });
const tipVideo = h('video.pl-tip-video', { muted: true, preload: 'metadata' });
if (inElectron) tipVideo.crossOrigin = 'anonymous';
const tip = h('div.pl-tip.hidden', tipVideo, tipImg, tipTime);
const bar = h('div.pl-bar', { 'data-tip': '' }, h('div.pl-track', barBuffered, barAB, barPlayed, barMarks), barKnob, tip);
const timeNow = h('span.pl-time', '0:00');
const timeEnd = h('button.pl-time.end', { 'data-tip': 'Click: remaining time or length' }, '0:00');

const btn = (ic, tipText, run, keys = '') => {
  const b = h('button.pl-btn', { 'data-tip': tipText, 'data-keys': keys, html: icon(ic, 20) });
  b.addEventListener('click', run);
  return b;
};
const playBtn = btn('play', 'Play', () => togglePlay(), 'Space');
playBtn.classList.add('big');
const volBtn = btn('volume', 'Mute', () => toggleMute(), 'M');
const volRange = h('input.pl-vol', { type: 'range', min: 0, max: 200, step: 1, value: settings.get('volume', 100), 'data-tip': 'Volume (wheel over the picture, or Up and Down); past 100% boosts' });
const volText = h('span.pl-voltext', `${settings.get('volume', 100)}%`);
const speedBtn = h('button.pl-chip', { 'data-tip': 'Speed ([ and ])' }, '1×');
const repeatBtn = btn('repeat', 'Repeat', () => cycleRepeat());
const shuffleBtn = btn('shuffle', 'Shuffle', () => toggleShuffle());
const abBtn = h('button.pl-chip', { 'data-tip': 'A-B loop: press once to mark A, again for B, again to clear' }, 'A-B');
const subBtn = btn('subtitles', 'Subtitles (V cycles)', (e) => showMenu(subtitleTrackItems(), { anchor: e.currentTarget }));
const audioBtn = btn('music', 'Audio track (B cycles)', (e) => showMenu(audioTrackItems(), { anchor: e.currentTarget }));
const eqBtn = btn('equalizer', 'Equaliser and sound', () => commands.run('audio.eq'), 'Ctrl+E');
const listBtn = btn('playlist', 'Playlist', () => commands.run('view.playlist'), 'Ctrl+L');
const fsBtn = btn('fullscreen', 'Full screen', () => commands.run('video.fullscreen'), 'F');
const controls = h('div.pl-controls',
  h('div.pl-seekrow', timeNow, bar, timeEnd),
  h('div.pl-btnrow',
    btn('skipBack', 'Previous', () => prev(), 'P'), playBtn, btn('stop', 'Stop', () => stop(), 'S'), btn('skipForward', 'Next', () => next(), 'N'),
    h('span.pl-sep'), repeatBtn, shuffleBtn, abBtn, speedBtn,
    h('span.grow'),
    subBtn, audioBtn, eqBtn, btn('camera', 'Snapshot', () => commands.run('video.snapshot'), 'Shift+S'), listBtn, btn('pip', 'Picture in picture', () => commands.run('video.pip')), fsBtn,
    h('span.pl-sep'), volBtn, volRange, volText));

// The playlist.
const listFilter = h('input.input.pl-filter', { placeholder: 'Find in the playlist', spellcheck: false });
const listEl = h('div.pl-list', { tabindex: 0 });
const listInfo = h('div.pl-listinfo.muted');
const listPanel = h('div.pl-panel',
  h('div.pl-panel-head', h('b', 'Playlist'), h('span.grow'),
    btn('plus', 'Add files', () => commands.run('media.add')), btn('folder', 'Add a folder', () => commands.run('media.addFolder')),
    btn('save', 'Save the playlist', () => commands.run('media.savePlaylist')), btn('trash', 'Clear the playlist', () => commands.run('list.clear'))),
  h('div.pl-panel-filter', listFilter), listEl, listInfo);
const centre = h('div.pl-centre', stage, controls);
shell.main.append(centre, splitter(listPanel, { side: 'right', key: 'listWidth', initial: 300, min: 200, max: 600 }), listPanel);
if (!settings.get('playlistOpen', true)) { listPanel.classList.add('hidden'); listPanel.previousSibling.classList.add('hidden'); }

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const list = []; // { id, file, name, title, duration, info, mode }
let index = -1;
let order = []; // play order when shuffling
let cur = null; // { item, live, offset, duration, audioTrack, cues, subIndex, subDelay }
let repeat = settings.get('repeat', 'off'); // off | all | one
let shuffle = settings.get('shuffle', false);
let ab = null; // { a, b }
let selected = new Set();
const chain = new AudioChain(video);
const view = { aspect: 'auto', fill: false, zoom: 1, panX: 0, panY: 0, rotate: 0, flipH: false, flipV: false, filters: { brightness: 100, contrast: 100, saturate: 100, hue: 0, sharpen: 0 } };
const subStyle = { size: settings.get('subSize', 100), box: settings.get('subBox', false), position: settings.get('subPos', 0) };
let sleepTimer = null;
let wantPlay = false;

// ---------------------------------------------------------------------------
// Time
// ---------------------------------------------------------------------------
const now = () => (cur ? (cur.live ? cur.offset + (video.currentTime || 0) : video.currentTime || 0) : 0);
const total = () => (cur ? cur.duration || (Number.isFinite(video.duration) ? video.duration : 0) : 0);

function seek(t, { exact = false } = {}) {
  if (!cur) return;
  const T = clamp(t, 0, Math.max(0, total() - 0.05));
  if (cur.live) {
    // A converted stream starts again from the new time.
    startSource(T, !video.paused || wantPlay);
  } else if (!exact && video.fastSeek && Math.abs(T - video.currentTime) > 30) video.fastSeek(T);
  else video.currentTime = T;
  updateTime();
}

const seekBy = (d) => { if (cur) { seek(now() + d); showOsd(`${d > 0 ? '+' : '−'}${fmtTime(Math.abs(d))}   ${fmtTime(now())} / ${fmtTime(total())}`); } };

// ---------------------------------------------------------------------------
// Loading and playing
// ---------------------------------------------------------------------------
function makeItem(file, title = '') {
  return { id: uid('m'), file, name: file.name, title: title || baseName(file.name), duration: 0, info: null, mode: null };
}

const isAudioItem = (item) => {
  if (item.info) return !item.info.streams.some((s) => s.type === 'video' && !s.attached);
  return AUDIO.includes(extOf(item.name));
};

/** Direct playback, or which kind of on-the-fly conversion. */
function decideMode(item) {
  const ext = extOf(item.name);
  const info = item.info;
  if (!info || !hasFfmpeg) return 'direct';
  const v = info.streams.find((s) => s.type === 'video' && !s.attached);
  const a = info.streams.filter((s) => s.type === 'audio');
  const audioOk = !a.length || DIRECT_AUDIO.includes(a[0].codec);
  if (!v) return DIRECT_CONTAINERS.includes(ext) && audioOk ? 'direct' : 'audio';
  const videoOk = DIRECT_VIDEO.includes(v.codec) && (!v.pixfmt || /yuv420p$|yuvj420p$|nv12/.test(v.pixfmt) || v.codec === 'vp9' || v.codec === 'av1');
  if (DIRECT_CONTAINERS.includes(ext) && videoOk && audioOk && a.length <= 1) return 'direct';
  return videoOk && ['h264'].includes(v.codec) ? 'remux' : 'transcode';
}

async function play(i, { start = null } = {}) {
  if (i < 0 || i >= list.length) return;
  index = i;
  const item = list[i];
  hideError();
  empty.classList.add('hidden');
  if (hasFfmpeg && !item.info) item.info = await host.media.probe(item.file.id).catch(() => null);
  if (item.info && item.info.duration) item.duration = item.info.duration;
  item.mode = item.mode || decideMode(item);
  cur = { item, live: item.mode !== 'direct', offset: 0, duration: item.duration || 0, audioTrack: 0, cues: null, subIndex: -1, subDelay: 0, subTracks: [] };
  ab = null;
  view.zoom = 1; view.panX = 0; view.panY = 0;
  // Pick up where we left off last time.
  let t = start;
  const resumeAt = settings.get('resumeOn', true) && start === null ? resumePoint(item) : 0;
  if (t === null) t = resumeAt;
  wantPlay = true;
  startSource(t || 0, true);
  if (resumeAt > 0 && start === null) showOsd(`Resumed at ${fmtTime(resumeAt)}  ·  Home starts over`, 3200);
  setupMediaSession(item);
  showArt(item);
  renderList();
  updateTitle();
  loadSubtitlesFor(item);
  refresh();
}

function startSource(t, autoplay) {
  const item = cur.item;
  const f = item.file;
  if (cur.live) {
    cur.offset = t;
    video.src = host.liveURL(f, { t: t.toFixed(3), mode: item.mode, a: cur.audioTrack });
  } else {
    const url = host.mediaURL(f);
    if (video.src !== url) video.src = url;
    const go = () => { if (t) video.currentTime = t; };
    if (video.readyState >= 1) go(); else video.addEventListener('loadedmetadata', go, { once: true });
  }
  video.playbackRate = Number(settings.get('speed', 1)) || 1;
  if (autoplay) { chain.resume(); video.play().catch(() => {}); }
}

function togglePlay() {
  if (!cur) { if (list.length) play(Math.max(0, index)); else commands.run('media.open'); return; }
  if (video.paused || video.ended) { wantPlay = true; chain.resume(); video.play().catch(() => {}); } else { wantPlay = false; video.pause(); }
}

function stop() {
  if (!cur) return;
  rememberPosition();
  wantPlay = false;
  video.pause();
  if (cur.live) { cur.offset = 0; video.removeAttribute('src'); video.load(); } else video.currentTime = 0;
  updateTime();
  showOsd('Stopped');
}

function playOrder() {
  if (!shuffle) return list.map((_, i) => i);
  if (order.length !== list.length) {
    order = list.map((_, i) => i);
    for (let i = order.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [order[i], order[j]] = [order[j], order[i]]; }
  }
  return order;
}

function next(auto = false) {
  if (!list.length) return;
  if (auto && repeat === 'one') { seek(0); video.play().catch(() => {}); return; }
  const o = playOrder();
  const k = o.indexOf(index);
  if (k + 1 < o.length) play(o[k + 1], { start: 0 });
  else if (repeat === 'all' || !auto) play(o[0], { start: 0 }); // the Next button wraps round; the end of the list stops
  else { wantPlay = false; showOsd('End of the playlist'); }
}

function prev() {
  if (!list.length) return;
  if (now() > 4) { seek(0); return; }
  const o = playOrder();
  const k = o.indexOf(index);
  play(o[(k - 1 + o.length) % o.length], { start: 0 });
}

function rememberPosition() {
  if (!cur || !settings.get('resumeOn', true)) return;
  const d = total();
  const t = now();
  const key = resumeKey(cur.item);
  const map = settings.get('resume', {});
  if (d > 120 && t > 30 && t < d - 20) map[key] = Math.round(t);
  else delete map[key];
  // Keep the list small.
  const keys = Object.keys(map);
  if (keys.length > 400) for (const k of keys.slice(0, keys.length - 400)) delete map[k];
  settings.set('resume', map);
}
const resumeKey = (item) => `${item.name}|${item.file.size || 0}`;
const resumePoint = (item) => settings.get('resume', {})[resumeKey(item)] || 0;

// ---------------------------------------------------------------------------
// Media element events
// ---------------------------------------------------------------------------
video.addEventListener('play', () => { playBtn.innerHTML = icon('pause', 22); playBtn.dataset.tip = 'Pause'; refresh(); });
video.addEventListener('pause', () => { playBtn.innerHTML = icon('play', 22); playBtn.dataset.tip = 'Play'; rememberPosition(); refresh(); });
video.addEventListener('timeupdate', () => { updateTime(); checkAB(); });
video.addEventListener('progress', () => drawBuffered());
video.addEventListener('loadedmetadata', () => {
  if (cur && !cur.live && Number.isFinite(video.duration)) { cur.duration = video.duration; cur.item.duration = video.duration; renderList(); }
  layout();
  updateTime();
  drawMarks();
});
video.addEventListener('resize', () => layout());
video.addEventListener('ended', () => { rememberPosition(); if (sleepTimer && sleepTimer.kind === 'track') { finishSleep(); return; } next(true); });
video.addEventListener('ratechange', () => { speedBtn.textContent = `${Math.round(video.playbackRate * 100) / 100}×`; });
video.addEventListener('error', () => mediaError());

async function mediaError() {
  if (!cur || !video.getAttribute('src')) return;
  const item = cur.item;
  // Try converting on the fly before giving up.
  if (!cur.live && hasFfmpeg) {
    if (!item.info) item.info = await host.media.probe(item.file.id).catch(() => null);
    const v = item.info && item.info.streams.find((s) => s.type === 'video' && !s.attached);
    item.mode = !v ? 'audio' : v.codec === 'h264' ? 'remux' : 'transcode';
    cur.live = true;
    const t = video.currentTime || 0;
    if (item.info) cur.duration = item.info.duration;
    showOsd('Converting this format as it plays…', 2500);
    startSource(t, true);
    return;
  }
  if (cur.live && item.mode === 'remux') { item.mode = 'transcode'; startSource(now(), true); return; }
  showError(hasFfmpeg ? `“${item.name}” could not be played. It may be damaged.`
    : inElectron ? `“${item.name}” uses a format this player cannot open without ffmpeg. Install ffmpeg (free) and reopen the player.`
      : `Your browser cannot play “${item.name}”. The desktop version of Snake's Player plays more formats.`);
}

function showError(text) { errBox.textContent = text; errBox.classList.remove('hidden'); }
function hideError() { errBox.classList.add('hidden'); }

// ---------------------------------------------------------------------------
// Seek bar and time
// ---------------------------------------------------------------------------
let showRemaining = settings.get('remaining', false);
timeEnd.addEventListener('click', () => { showRemaining = !showRemaining; settings.set('remaining', showRemaining); updateTime(); });
let dragging = null;

function updateTime() {
  const t = dragging ? dragging.t : now();
  const d = total();
  timeNow.textContent = fmtTime(t);
  timeEnd.textContent = d ? (showRemaining ? `−${fmtTime(Math.max(0, d - t))}` : fmtTime(d)) : '0:00';
  const f = d ? clamp(t / d, 0, 1) : 0;
  barPlayed.style.width = `${f * 100}%`;
  barKnob.style.left = `${f * 100}%`;
  if (cur && cur.cues) drawSubs();
  if ('mediaSession' in navigator && d && Number.isFinite(d)) {
    try { navigator.mediaSession.setPositionState({ duration: d, position: clamp(t, 0, d), playbackRate: video.playbackRate }); } catch {}
  }
}

function drawBuffered() {
  const d = total();
  if (!d || !video.buffered.length) { barBuffered.style.width = '0'; return; }
  const end = (cur && cur.live ? cur.offset : 0) + video.buffered.end(video.buffered.length - 1);
  barBuffered.style.width = `${clamp(end / d, 0, 1) * 100}%`;
}

function drawMarks() {
  barMarks.replaceChildren();
  const d = total();
  const ch = cur && cur.item.info ? cur.item.info.chapters : [];
  if (!d) return;
  for (const c of ch) if (c.start > 0) barMarks.append(h('span.pl-mark', { style: { left: `${(c.start / d) * 100}%` }, 'data-tip': c.title }));
}

function drawAB() {
  const d = total();
  if (!ab || !d) { barAB.style.display = 'none'; abBtn.classList.remove('on', 'half'); return; }
  abBtn.classList.toggle('half', ab.b === null);
  abBtn.classList.toggle('on', ab.b !== null);
  barAB.style.display = 'block';
  const b = ab.b === null ? ab.a + 0.2 : ab.b;
  barAB.style.left = `${(ab.a / d) * 100}%`;
  barAB.style.width = `${((b - ab.a) / d) * 100}%`;
}

function checkAB() {
  if (ab && ab.b !== null && now() >= ab.b) seek(ab.a, { exact: true });
}

function barTime(e) {
  const r = bar.getBoundingClientRect();
  return clamp((e.clientX - r.left) / r.width, 0, 1) * total();
}

bar.addEventListener('pointerdown', (e) => {
  if (!cur || e.button !== 0) return;
  bar.setPointerCapture(e.pointerId);
  dragging = { t: barTime(e) };
  if (!cur.live) seek(dragging.t);
  updateTime();
  const mv = (ev) => { dragging.t = barTime(ev); if (!cur.live) seek(dragging.t); updateTime(); hoverTip(ev); };
  const up = () => {
    bar.removeEventListener('pointermove', mv);
    bar.removeEventListener('pointerup', up);
    const t = dragging.t;
    dragging = null;
    seek(t, { exact: true });
  };
  bar.addEventListener('pointermove', mv);
  bar.addEventListener('pointerup', up);
});
bar.addEventListener('pointermove', (e) => hoverTip(e));
bar.addEventListener('pointerleave', () => tip.classList.add('hidden'));
// The wheel over the bar steps through the video.
bar.addEventListener('wheel', (e) => { e.preventDefault(); seekBy(e.deltaY < 0 ? 5 : -5); }, { passive: false });

let tipTimer = 0;
const frameCache = new Map();
function hoverTip(e) {
  if (!cur || !total()) return;
  const t = barTime(e);
  const r = bar.getBoundingClientRect();
  tip.classList.remove('hidden');
  tip.style.left = `${clamp(e.clientX - r.left, 80, r.width - 80)}px`;
  const ch = cur.item.info ? [...cur.item.info.chapters].reverse().find((c) => c.start <= t) : null;
  tipTime.textContent = ch && ch.title ? `${fmtTime(t)} · ${ch.title}` : fmtTime(t);
  const isAudio = isAudioItem(cur.item);
  tip.classList.toggle('text-only', isAudio);
  if (isAudio) return;
  clearTimeout(tipTimer);
  tipTimer = setTimeout(async () => {
    if (!cur.live) {
      // A second, silent copy of the video jumps to the spot.
      const url = host.mediaURL(cur.item.file);
      tipImg.style.display = 'none';
      tipVideo.style.display = '';
      if (tipVideo.getAttribute('src') !== url) tipVideo.src = url;
      try { tipVideo.currentTime = t; } catch {}
    } else if (hasFfmpeg) {
      tipVideo.style.display = 'none';
      const key = `${cur.item.id}:${Math.round(t / 4)}`;
      let url = frameCache.get(key);
      if (!url) {
        const bytes = await host.media.frame(cur.item.file.id, t, 240).catch(() => null);
        if (!bytes) return;
        url = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
        frameCache.set(key, url);
        if (frameCache.size > 120) { const [k, u] = frameCache.entries().next().value; URL.revokeObjectURL(u); frameCache.delete(k); }
      }
      tipImg.src = url;
      tipImg.style.display = '';
    }
  }, 90);
}

// ---------------------------------------------------------------------------
// Picture: aspect, zoom, rotation, adjustments
// ---------------------------------------------------------------------------
function layout() {
  const W = stage.clientWidth;
  const H = stage.clientHeight;
  const vw = video.videoWidth || 16;
  const vh = video.videoHeight || 9;
  let ar = ASPECTS[view.aspect] || vw / vh;
  const turned = view.rotate % 180 !== 0;
  if (turned) ar = 1 / ar;
  // The size the picture shows at (after turning).
  let dw;
  let dh;
  if (view.fill ? W / H < ar : W / H > ar) { dh = H; dw = H * ar; } else { dw = W; dh = W / ar; }
  const elW = turned ? dh : dw;
  const elH = turned ? dw : dh;
  Object.assign(video.style, {
    width: `${elW}px`, height: `${elH}px`, left: `${(W - elW) / 2}px`, top: `${(H - elH) / 2}px`,
    transform: `translate(${view.panX}px, ${view.panY}px) rotate(${view.rotate}deg) scale(${view.zoom * (view.flipH ? -1 : 1)}, ${view.zoom * (view.flipV ? -1 : 1)})`,
  });
  // Subtitles sit at the bottom of the visible picture.
  const visH = Math.min(H, dh * view.zoom);
  const bottom = Math.max(8, (H - visH) / 2 + visH * 0.05);
  subBox.style.bottom = `${bottom + subStyle.position}px`;
  subBox.style.fontSize = `${clamp(visH / 18, 14, 64) * (subStyle.size / 100)}px`;
  subBox.classList.toggle('boxed', subStyle.box);
  const f = view.filters;
  video.style.filter = [f.brightness !== 100 ? `brightness(${f.brightness}%)` : '', f.contrast !== 100 ? `contrast(${f.contrast}%)` : '', f.saturate !== 100 ? `saturate(${f.saturate}%)` : '',
    f.hue ? `hue-rotate(${f.hue}deg)` : '', f.sharpen ? `url(#pl-sharpen-${Math.round(f.sharpen)})` : ''].filter(Boolean).join(' ') || 'none';
}
new ResizeObserver(() => layout()).observe(stage);

// Sharpening is an SVG filter (a small convolution), made for each strength used.
const svgDefs = h('div', { style: { position: 'absolute', width: '0', height: '0', overflow: 'hidden' }, html: '<svg width="0" height="0"><defs></defs></svg>' });
document.body.append(svgDefs);
function ensureSharpen(n) {
  const id = `pl-sharpen-${n}`;
  if (document.getElementById(id)) return;
  const k = n / 50;
  const m = [0, -k, 0, -k, 1 + 4 * k, -k, 0, -k, 0].map((v) => v.toFixed(3)).join(' ');
  const defs = svgDefs.querySelector('defs');
  const ns = 'http://www.w3.org/2000/svg';
  const filter = document.createElementNS(ns, 'filter');
  filter.setAttribute('id', id);
  const conv = document.createElementNS(ns, 'feConvolveMatrix');
  conv.setAttribute('order', '3');
  conv.setAttribute('kernelMatrix', m);
  conv.setAttribute('preserveAlpha', 'true');
  filter.append(conv);
  defs.append(filter);
}

function setView(changes, message = null) {
  Object.assign(view, changes);
  if (view.filters.sharpen) ensureSharpen(Math.round(view.filters.sharpen));
  layout();
  if (message) showOsd(message);
  refresh();
}

// Ctrl+wheel zooms the picture at the pointer; the plain wheel changes the volume.
stage.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (e.ctrlKey || e.metaKey || settings.get('wheelZooms', false)) {
    const r = stage.getBoundingClientRect();
    const cx = e.clientX - r.left - r.width / 2;
    const cy = e.clientY - r.top - r.height / 2;
    const z0 = view.zoom;
    const z = clamp(z0 * (e.deltaY < 0 ? 1.15 : 1 / 1.15), 1, 8);
    // Keep the point under the pointer still.
    const k = z / z0;
    const panX = z === 1 ? 0 : cx - (cx - view.panX) * k;
    const panY = z === 1 ? 0 : cy - (cy - view.panY) * k;
    setView({ zoom: z, panX, panY }, `Zoom ${Math.round(z * 100)}%`);
    return;
  }
  setVolume(volume() + (e.deltaY < 0 ? 5 : -5));
}, { passive: false });

// Click: play or pause. Double-click: full screen. Drag when zoomed: look around.
let clickTimer = 0;
stage.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || e.target.closest('.pl-empty, .pl-error')) return;
  stage.focus({ preventScroll: true });
  const x0 = e.clientX; const y0 = e.clientY;
  const p0 = { x: view.panX, y: view.panY };
  let moved = false;
  stage.setPointerCapture(e.pointerId);
  const mv = (ev) => {
    if (Math.hypot(ev.clientX - x0, ev.clientY - y0) > 4) moved = true;
    if (moved && view.zoom > 1) setView({ panX: p0.x + ev.clientX - x0, panY: p0.y + ev.clientY - y0 });
  };
  const up = () => {
    stage.removeEventListener('pointermove', mv);
    stage.removeEventListener('pointerup', up);
    if (!moved && cur) { clearTimeout(clickTimer); clickTimer = setTimeout(() => togglePlay(), 0); }
  };
  stage.addEventListener('pointermove', mv);
  stage.addEventListener('pointerup', up);
});
stage.addEventListener('dblclick', (e) => { if (!e.target.closest('.pl-empty')) commands.run('video.fullscreen'); });
stage.addEventListener('contextmenu', (e) => { e.preventDefault(); showMenu(stageMenu(), { x: e.clientX, y: e.clientY }); });

// In full screen the controls and pointer hide when idle.
let idleTimer = 0;
function wake() {
  document.body.classList.remove('pl-idle');
  clearTimeout(idleTimer);
  if (document.fullscreenElement || document.body.classList.contains('pl-full')) idleTimer = setTimeout(() => { if (!video.paused) document.body.classList.add('pl-idle'); }, 2600);
}
window.addEventListener('pointermove', wake);
window.addEventListener('keydown', wake, true);

// ---------------------------------------------------------------------------
// Sound
// ---------------------------------------------------------------------------
const volume = () => Number(volRange.value);
function setVolume(v, osd = true) {
  const x = clamp(Math.round(v), 0, 200);
  volRange.value = String(x);
  volText.textContent = `${x}%`;
  video.volume = Math.min(1, x / 100);
  video.muted = settings.get('muted', false);
  if (x > 100) chain.set({ boost: x / 100 }); else if (chain.ready) chain.set({ boost: 1 });
  settings.set('volume', x);
  volBtn.innerHTML = icon(video.muted || x === 0 ? 'volumeX' : x < 50 ? 'volumeLow' : 'volume', 20);
  if (osd) showOsd(video.muted ? 'Muted' : `Volume ${x}%`);
}
volRange.addEventListener('input', () => setVolume(Number(volRange.value), false));
function toggleMute() {
  settings.set('muted', !settings.get('muted', false));
  setVolume(volume());
}

function setSpeed(r) {
  const x = clamp(Math.round(r * 100) / 100, 0.1, 8);
  video.playbackRate = x;
  settings.set('speed', x);
  showOsd(`Speed ${x}×`);
}
function speedStep(dir) {
  const r = video.playbackRate;
  const nextR = dir > 0 ? SPEEDS.find((s) => s > r + 0.001) || 4 : [...SPEEDS].reverse().find((s) => s < r - 0.001) || 0.25;
  setSpeed(nextR);
}
speedBtn.addEventListener('click', () => showMenu(SPEEDS.map((s) => ({ label: `${s}×${s === 1 ? ' (normal)' : ''}`, checked: Math.abs(video.playbackRate - s) < 0.01, run: () => setSpeed(s) })), { anchor: speedBtn }));
speedBtn.addEventListener('wheel', (e) => { e.preventDefault(); speedStep(e.deltaY < 0 ? 1 : -1); }, { passive: false });
volRange.addEventListener('wheel', (e) => { e.preventDefault(); e.stopPropagation(); setVolume(volume() + (e.deltaY < 0 ? 5 : -5)); }, { passive: false, capture: true });

// Restore the sound settings.
const eqSaved = settings.get('eq', null);
if (eqSaved) chain.set({ gains: eqSaved.gains || chain.gains, preamp: eqSaved.preamp || 0, eqOn: !!eqSaved.on });
if (settings.get('night', false)) chain.set({ night: true });
if (settings.get('balance', 0)) chain.set({ balance: settings.get('balance', 0) });
setVolume(settings.get('volume', 100), false);

function audioTracks() { return cur && cur.item.info ? cur.item.info.streams.filter((s) => s.type === 'audio') : []; }

function setAudioTrack(k) {
  if (!cur) return;
  const tracks = audioTracks();
  if (k === cur.audioTrack || k >= tracks.length) return;
  cur.audioTrack = k;
  if (!cur.live) {
    // The built-in player cannot switch tracks: convert on the fly from here.
    cur.item.mode = cur.item.mode === 'direct' ? (tracks.length && !isAudioItem(cur.item) ? 'remux' : 'audio') : cur.item.mode;
    const v = cur.item.info.streams.find((s) => s.type === 'video' && !s.attached);
    if (v && v.codec !== 'h264') cur.item.mode = 'transcode';
    cur.live = true;
  }
  startSource(now(), !video.paused);
  showOsd(`Audio: ${trackLabel(tracks[k], k)}`);
}

const trackLabel = (s, k) => [s.title, s.language && s.language !== 'und' ? s.language.toUpperCase() : '', s.codec && s.codec.toUpperCase(), s.channels ? `${s.channels === 6 ? '5.1' : s.channels === 8 ? '7.1' : s.channels === 2 ? 'stereo' : `${s.channels} ch`}` : ''].filter(Boolean).join(' · ') || `Track ${k + 1}`;

// ---------------------------------------------------------------------------
// Subtitles
// ---------------------------------------------------------------------------
function drawSubs() {
  if (!cur || !cur.cues) { subBox.replaceChildren(); return; }
  const active = cuesAt(cur.cues, now() - cur.subDelay);
  const key = active.map((c) => c.start).join(',');
  if (subBox.dataset.key === key) return;
  subBox.dataset.key = key;
  subBox.replaceChildren(...active.map((c) => h('div.pl-cue', cueNodes(c.text))));
}

// Subtitles follow the picture smoothly, not just four times a second.
(function tick() {
  if (cur && cur.cues && !video.paused) drawSubs();
  requestAnimationFrame(tick);
}());

function setCues(cues, label, idx) {
  cur.cues = cues;
  cur.subIndex = idx;
  subBox.dataset.key = '';
  drawSubs();
  if (label) showOsd(cues ? `Subtitles: ${label}` : 'Subtitles off');
  refresh();
}

async function loadSubtitleFile(f, select = true) {
  try {
    const text = decodeSubtitleBytes(await host.read(f));
    const cues = parseSubtitles(text, extOf(f.name));
    if (!cues.length) { toast(`No subtitles found in ${f.name}.`, { type: 'warn' }); return; }
    const track = { label: f.name, cues };
    cur.subTracks.push(track);
    if (select) setCues(cues, f.name, cur.subTracks.length - 1);
  } catch (err) { errorToast(err); }
}

async function loadSubtitlesFor(item) {
  // Subtitle files next to the video with the same name come along automatically.
  if (!host.siblings || isAudioItem(item)) return;
  try {
    const base = baseName(item.name).toLowerCase();
    const sibs = await host.siblings(item.file, SUBS);
    const match = sibs.filter((s) => baseName(s.name).toLowerCase().startsWith(base));
    for (const [i, s] of match.entries()) if (cur && cur.item === item) await loadSubtitleFile(s, i === 0 && settings.get('autoSubs', true));
  } catch {}
}

function embeddedSubs() { return cur && cur.item.info ? cur.item.info.streams.filter((s) => s.type === 'subtitle') : []; }

async function useEmbedded(k) {
  const s = embeddedSubs()[k];
  if (!s) return;
  if (!TEXT_SUBS.includes(s.codec)) { toast('These subtitles are pictures (DVD/Blu-ray style), which cannot be shown yet.', { type: 'warn' }); return; }
  showOsd('Reading subtitles…');
  try {
    const vtt = await host.media.subtitle(cur.item.file.id, k);
    const cues = parseSubtitles(vtt || '', 'vtt');
    setCues(cues.length ? cues : null, trackLabel(s, k), `e${k}`);
  } catch (err) { errorToast(err); }
}

function subtitleTrackItems() {
  if (!cur) return [{ label: 'Nothing is playing', disabled: true }];
  const items = [{ label: 'Off', checked: !cur.cues, run: () => setCues(null, 'Off', -1) }];
  cur.subTracks.forEach((t, i) => items.push({ label: t.label, checked: cur.subIndex === i, run: () => setCues(t.cues, t.label, i) }));
  embeddedSubs().forEach((s, k) => items.push({ label: `${trackLabel(s, k)} (in the video)`, checked: cur.subIndex === `e${k}`, run: () => useEmbedded(k) }));
  items.push({ type: 'separator' }, I('subs.add'), I('subs.later'), I('subs.earlier'), I('subs.bigger'), I('subs.smaller'));
  return items;
}

function cycleSubs() {
  if (!cur) return;
  const opts = [-1, ...cur.subTracks.map((_, i) => i), ...embeddedSubs().map((_, k) => `e${k}`)];
  const i = opts.indexOf(cur.subIndex);
  const n = opts[(i + 1) % opts.length];
  if (n === -1) setCues(null, 'Off', -1);
  else if (typeof n === 'number') setCues(cur.subTracks[n].cues, cur.subTracks[n].label, n);
  else useEmbedded(Number(n.slice(1)));
}

function audioTrackItems() {
  const tracks = audioTracks();
  if (!cur || !tracks.length) return [{ label: cur ? 'Only one audio track' : 'Nothing is playing', disabled: true }];
  return tracks.map((s, k) => ({ label: trackLabel(s, k), checked: cur.audioTrack === k, run: () => setAudioTrack(k) }));
}

function subDelay(d) {
  if (!cur) return;
  cur.subDelay = Math.round((cur.subDelay + d) * 1000) / 1000;
  subBox.dataset.key = '';
  drawSubs();
  showOsd(`Subtitle delay ${cur.subDelay > 0 ? '+' : ''}${Math.round(cur.subDelay * 1000)} ms`);
}

// ---------------------------------------------------------------------------
// Music: cover art, titles and the visualiser
// ---------------------------------------------------------------------------
let artUrl = null;
async function showArt(item) {
  const audioOnly = isAudioItem(item);
  stage.classList.toggle('audio', audioOnly);
  art.replaceChildren();
  if (artUrl) { URL.revokeObjectURL(artUrl); artUrl = null; }
  if (!audioOnly) return;
  const tags = (item.info && item.info.tags) || {};
  const tag = (k) => tags[k] || tags[k.toUpperCase()] || '';
  const title = tag('title') || item.title;
  const meta = [tag('artist') || tag('album_artist'), tag('album'), tag('date') ? String(tag('date')).slice(0, 4) : ''].filter(Boolean).join(' · ');
  const cover = h('div.pl-cover', { html: icon('music', 72) });
  art.append(...[cover, h('div.pl-art-title', title), meta ? h('div.pl-art-meta', meta) : null].filter(Boolean));
  if (item.info && item.info.streams.some((s) => s.attached) && hasFfmpeg) {
    const bytes = await host.media.frame(item.file.id, 0, 600).catch(() => null);
    if (bytes && cur && cur.item === item) {
      artUrl = URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' }));
      cover.replaceChildren(h('img', { src: artUrl, alt: '' }));
      art.style.setProperty('--cover', `url("${artUrl}")`);
      setupMediaSession(item, artUrl);
    }
  } else art.style.removeProperty('--cover');
}

(function drawViz() {
  requestAnimationFrame(drawViz);
  if (!stage.classList.contains('audio') || video.paused || !settings.get('visualiser', true)) return;
  if (!chain.ready && !chain.ensure()) return;
  const W = viz.clientWidth;
  const H = viz.clientHeight;
  if (!W || !H) return;
  const dpr = window.devicePixelRatio || 1;
  if (viz.width !== Math.round(W * dpr)) { viz.width = Math.round(W * dpr); viz.height = Math.round(H * dpr); }
  const ctx = viz.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const a = chain.analyser;
  const data = new Uint8Array(a.frequencyBinCount);
  a.getByteFrequencyData(data);
  // Bars on a log scale, like an equaliser display.
  const n = 64;
  const bw = W / n;
  const g = ctx.createLinearGradient(0, H, 0, H * 0.3);
  g.addColorStop(0, 'rgba(63,185,80,.85)');
  g.addColorStop(1, 'rgba(126,231,135,.25)');
  ctx.fillStyle = g;
  for (let i = 0; i < n; i++) {
    const f0 = Math.floor(2 * Math.pow(data.length / 2, i / n));
    const f1 = Math.max(f0 + 1, Math.floor(2 * Math.pow(data.length / 2, (i + 1) / n)));
    let m = 0;
    for (let k = f0; k < f1 && k < data.length; k++) m = Math.max(m, data[k]);
    const bh = (m / 255) * H * 0.55;
    ctx.fillRect(i * bw + 1, H - bh, bw - 2, bh);
  }
}());

// ---------------------------------------------------------------------------
// Playlist
// ---------------------------------------------------------------------------
function addFiles(files, { playNow = false } = {}) {
  const before = list.length;
  const pls = files.filter((f) => PLAYLISTS.includes(extOf(f.name)));
  const media = files.filter((f) => [...VIDEO, ...AUDIO].includes(extOf(f.name)));
  for (const f of media) list.push(makeItem(f));
  order = [];
  renderList();
  probeDurations();
  (async () => {
    for (const p of pls) {
      if (!host.media || !host.media.playlist) { toast('Playlists open in the desktop version.', { type: 'warn' }); break; }
      try {
        const entries = await host.media.playlist(p.id);
        if (!entries.length) toast(`Nothing playable was found in ${p.name}.`, { type: 'warn' });
        for (const e of entries) list.push(makeItem(e, e.title));
      } catch (err) { errorToast(err); }
    }
    order = [];
    renderList();
    probeDurations();
    if (playNow && list.length > before) play(before);
    else if (!cur && list.length) play(0);
  })();
  if (playNow && media.length && !pls.length) play(before);
}

let probing = false;
async function probeDurations() {
  if (probing) return;
  probing = true;
  try {
    for (const it of list) {
      if (it.duration || it.probed) continue;
      it.probed = true;
      if (hasFfmpeg) {
        it.info = await host.media.probe(it.file.id).catch(() => null);
        if (it.info) { it.duration = it.info.duration; const t = it.info.tags || {}; if (t.title || t.TITLE) it.title = [t.artist || t.ARTIST, t.title || t.TITLE].filter(Boolean).join(' – '); }
      } else {
        // Read just the header with a throwaway element.
        it.duration = await new Promise((res) => {
          const a = document.createElement(isAudioItem(it) ? 'audio' : 'video');
          a.preload = 'metadata';
          a.onloadedmetadata = () => res(Number.isFinite(a.duration) ? a.duration : 0);
          a.onerror = () => res(0);
          a.src = host.mediaURL(it.file);
          setTimeout(() => res(0), 4000);
        });
      }
      renderListSoon();
    }
  } finally { probing = false; }
}

let listTimer = 0;
const renderListSoon = () => { clearTimeout(listTimer); listTimer = setTimeout(renderList, 120); };

function renderList() {
  const q = listFilter.value.trim().toLowerCase();
  const rows = [];
  let totalLen = 0;
  list.forEach((it, i) => {
    totalLen += it.duration || 0;
    if (q && !`${it.title} ${it.name}`.toLowerCase().includes(q)) return;
    const row = h(`div.pl-row${i === index ? '.on' : ''}${selected.has(it.id) ? '.sel' : ''}`, { dataset: { i: String(i) } },
      h('span.pl-num', i === index && cur ? h('span', { html: icon(video.paused ? 'pause' : 'play', 12) }) : String(i + 1)),
      h('span.pl-title', { 'data-tip': it.name }, it.title),
      h('span.pl-dur', it.duration ? fmtTime(it.duration) : ''));
    row.addEventListener('click', (e) => {
      if (e.ctrlKey || e.metaKey) { if (selected.has(it.id)) selected.delete(it.id); else selected.add(it.id); } else if (e.shiftKey && selected.size) {
        const last = list.findIndex((x) => selected.has(x.id));
        const [a, b] = last < i ? [last, i] : [i, last];
        for (let k = a; k <= b; k++) selected.add(list[k].id);
      } else selected = new Set([it.id]);
      renderList();
    });
    row.addEventListener('dblclick', () => play(i, { start: null }));
    contextMenu(row, () => { if (!selected.has(it.id)) { selected = new Set([it.id]); renderList(); } return rowMenu(i); });
    row.addEventListener('pointerdown', (e) => dragRow(e, row, i));
    rows.push(row);
  });
  listEl.replaceChildren(...rows);
  if (!list.length) listEl.append(h('div.pl-listempty.muted', 'Drop files here, or use + above.'));
  listInfo.textContent = list.length ? `${list.length} item${list.length === 1 ? '' : 's'} · ${fmtTime(totalLen)}` : '';
  const on = listEl.querySelector('.on');
  if (on && !listEl.matches(':hover')) on.scrollIntoView({ block: 'nearest' });
}
listFilter.addEventListener('input', renderList);
listFilter.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') { const first = listEl.querySelector('.pl-row'); if (first) play(Number(first.dataset.i)); } });

function dragRow(e, row, i) {
  if (e.button !== 0) return;
  const y0 = e.clientY;
  let moved = false;
  let target = null;
  const mv = (ev) => {
    if (!moved && Math.abs(ev.clientY - y0) < 5) return;
    moved = true;
    row.classList.add('dragging');
    for (const r of listEl.children) r.classList.remove('drop-before', 'drop-after');
    const over = document.elementFromPoint(ev.clientX, ev.clientY);
    const r = over && over.closest('.pl-row');
    if (!r || r === row) { target = null; return; }
    const rect = r.getBoundingClientRect();
    const before = ev.clientY < rect.top + rect.height / 2;
    r.classList.add(before ? 'drop-before' : 'drop-after');
    target = Number(r.dataset.i) + (before ? 0 : 1);
  };
  const up = () => {
    window.removeEventListener('pointermove', mv);
    window.removeEventListener('pointerup', up);
    row.classList.remove('dragging');
    if (!moved || target === null) { renderList(); return; }
    const playing = list[index];
    const [it] = list.splice(i, 1);
    list.splice(target > i ? target - 1 : target, 0, it);
    index = playing ? list.indexOf(playing) : -1;
    order = [];
    renderList();
  };
  window.addEventListener('pointermove', mv);
  window.addEventListener('pointerup', up);
}

function removeSelected() {
  if (!selected.size) return;
  const playing = list[index];
  for (let i = list.length - 1; i >= 0; i--) if (selected.has(list[i].id)) list.splice(i, 1);
  selected.clear();
  index = playing ? list.indexOf(playing) : -1;
  if (playing && index < 0) { stop(); cur = null; video.removeAttribute('src'); video.load(); empty.classList.toggle('hidden', !!list.length); updateTitle(); }
  order = [];
  renderList();
}

function clearList() {
  stop();
  list.length = 0;
  index = -1;
  cur = null;
  video.removeAttribute('src');
  video.load();
  stage.classList.remove('audio');
  empty.classList.remove('hidden');
  hideError();
  subBox.replaceChildren();
  renderList();
  updateTitle();
}

function rowMenu(i) {
  const it = list[i];
  return [{ label: 'Play', icon: 'play', run: () => play(i, { start: null }) }, { label: 'Play from the start', run: () => play(i, { start: 0 }) },
    { type: 'separator' }, { label: 'Move to the top', run: () => { const playing = list[index]; list.splice(i, 1); list.unshift(it); index = playing ? list.indexOf(playing) : -1; renderList(); } },
    { label: 'Remove from the playlist', icon: 'trash', keys: 'Delete', run: () => removeSelected() },
    { type: 'separator' }, { label: 'Media information', icon: 'info', run: () => infoDialog(it) },
    host.reveal && inElectron ? { label: 'Show in its folder', icon: 'folder', run: () => host.reveal(it.file) } : null,
    hasFfmpeg ? { label: 'Convert…', icon: 'export', run: () => convertDialog(it) } : null];
}

async function savePlaylist() {
  if (!list.length) return;
  const lines = ['#EXTM3U'];
  for (const it of list) {
    lines.push(`#EXTINF:${Math.round(it.duration || -1)},${it.title.replace(/[\r\n]/g, ' ')}`);
    lines.push(it.file.path || it.name);
  }
  try {
    const f = await host.saveAs({ name: 'Playlist.m3u8', filters: [{ name: 'Playlist', exts: ['m3u8', 'm3u'] }] }, `${lines.join('\n')}\n`);
    if (f) toast(`Saved ${f.name}`, { timeout: 1800 });
  } catch (err) { errorToast(err); }
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------
async function infoDialog(item = cur && cur.item) {
  if (!item) return;
  if (hasFfmpeg && !item.info) item.info = await host.media.probe(item.file.id).catch(() => null);
  const info = item.info;
  const rows = [['File', item.name], ['Size', item.file.size ? fmtBytes(item.file.size) : '—']];
  if (info) {
    rows.push(['Length', fmtTime(info.duration)], ['Format', info.format], ['Bit rate', info.bitrate ? `${Math.round(info.bitrate / 1000)} kb/s` : '—']);
    for (const [k, v] of Object.entries(info.tags || {}).slice(0, 12)) rows.push([k.replace(/_/g, ' '), String(v).slice(0, 200)]);
    for (const s of info.streams) {
      const d = s.type === 'video' ? [s.codec, s.width && `${s.width}×${s.height}`, s.fps && s.fps !== '0/0' ? `${Math.round(eval_(s.fps) * 100) / 100} fps` : '', s.pixfmt, s.attached ? 'cover picture' : '']
        : s.type === 'audio' ? [s.codec, s.rate && `${s.rate} Hz`, s.channels && `${s.channels} channels`, s.language] : [s.codec, s.language, s.title];
      rows.push([`${s.type[0].toUpperCase()}${s.type.slice(1)} #${s.index}`, d.filter(Boolean).join(' · ')]);
    }
    if (cur && cur.item === item) rows.push(['Playing as', item.mode === 'direct' ? 'Directly' : item.mode === 'remux' ? 'Repackaged on the fly (no quality loss)' : item.mode === 'audio' ? 'Sound converted on the fly' : 'Converted on the fly']);
  } else if (cur && cur.item === item) rows.push(['Picture', video.videoWidth ? `${video.videoWidth}×${video.videoHeight}` : 'none'], ['Length', fmtTime(total())]);
  await modal({ title: 'Media information', width: 520, body: h('table.pl-info', ...rows.map(([k, v]) => h('tr', h('th', k), h('td', v)))), buttons: [{ label: 'Close', value: true, primary: true }] });
}
// "30000/1001" -> 29.97 (no eval of strings: just the division).
function eval_(fr) { const [a, b] = String(fr).split('/').map(Number); return b ? a / b : a || 0; }

async function convertDialog(item = cur && cur.item) {
  if (!item || !hasFfmpeg) return;
  const presets = [['mp4', 'MP4 video (plays everywhere)'], ['webm', 'WebM video (web)'], ['mp3', 'MP3 audio'], ['m4a', 'M4A audio (AAC)'], ['flac', 'FLAC audio (lossless)'], ['wav', 'WAV audio (uncompressed)'], ['gif', 'Animated GIF (short clips)']];
  const sel = select({ options: presets.map(([v, l]) => ({ value: v, label: l })), value: isAudioItem(item) ? 'mp3' : 'mp4', onChange: () => {} });
  const ok = await modal({ title: `Convert “${item.name}”`, width: 420, body: h('div.col', h('label.field', h('span', 'To'), sel), h('div.muted', 'You choose where the new file goes; the original is not changed.')),
    buttons: [{ label: 'Cancel', value: false }, { label: 'Choose where…', value: true, primary: true }] });
  if (!ok) return;
  const fmt = sel.value;
  const out = await host.saveAs({ name: `${baseName(item.name)}.${fmt}`, filters: [{ name: fmt.toUpperCase(), exts: [fmt] }], near: item.file.id });
  if (!out) return;
  const id = uid('job');
  const bar = h('progress', { max: 1, value: 0, style: { width: '100%' } });
  const label = h('div.muted', 'Starting…');
  let close = null;
  const offP = host.media.onProgress((p) => { if (p.id === id) { bar.value = p.progress; label.textContent = `${Math.round(p.progress * 100)}%`; } });
  const offD = host.media.onDone((d) => {
    if (d.id !== id) return;
    offP(); offD();
    if (close) close(true);
    if (d.ok) toast(`Converted to ${out.name}`, { timeout: 4000, action: host.reveal ? { label: 'Show', run: () => host.reveal(out) } : null });
    else toast(`The conversion failed: ${d.error}`, { type: 'error', timeout: 9000 });
  });
  try { await host.media.convert(id, item.file.id, out.id, fmt); } catch (err) { offP(); offD(); errorToast(err); return; }
  const r = await modal({ title: 'Converting…', width: 380, body: h('div.col', bar, label), buttons: [{ label: 'Cancel', value: 'cancel' }], onOpen: (_d, c) => { close = c; } });
  if (r === 'cancel') host.media.cancel(id);
}

async function eqDialog() {
  chain.ensure();
  const on = h('input', { type: 'checkbox', checked: chain.eqOn });
  const sliders = BANDS.map((f, i) => {
    const s = h('input.pl-eqslider', { type: 'range', min: -12, max: 12, step: 0.5, value: chain.gains[i], orient: 'vertical', 'data-tip': `${f < 1000 ? f : `${f / 1000}k`} Hz` });
    s.addEventListener('input', () => { chain.gains[i] = Number(s.value); chain.set({ eqOn: true }); on.checked = true; saveEq(); });
    return h('div.pl-eqband', s, h('span', f < 1000 ? String(f) : `${f / 1000}k`));
  });
  const pre = h('input.pl-eqslider', { type: 'range', min: -12, max: 12, step: 0.5, value: chain.preamp, orient: 'vertical', 'data-tip': 'Pre-amp' });
  pre.addEventListener('input', () => { chain.set({ preamp: Number(pre.value), eqOn: true }); on.checked = true; saveEq(); });
  on.addEventListener('change', () => { chain.set({ eqOn: on.checked }); saveEq(); });
  const presets = select({ options: [{ value: '', label: 'Presets…' }, ...Object.entries(EQ_PRESETS).map(([k, p]) => ({ value: k, label: p.label }))], value: '', onChange: (v) => {
    if (!v) return;
    chain.gains = [...EQ_PRESETS[v].gains];
    sliders.forEach((s, i) => { s.firstChild.value = String(chain.gains[i]); });
    chain.set({ eqOn: true });
    on.checked = true;
    presets.value = '';
    saveEq();
  } });
  const night = h('input', { type: 'checkbox', checked: chain.night });
  night.addEventListener('change', () => { chain.set({ night: night.checked }); settings.set('night', night.checked); });
  const bal = h('input', { type: 'range', min: -1, max: 1, step: 0.05, value: chain.balance, style: { width: '160px' } });
  bal.addEventListener('input', () => { chain.set({ balance: Number(bal.value) }); settings.set('balance', Number(bal.value)); });
  bal.addEventListener('dblclick', () => { bal.value = '0'; chain.set({ balance: 0 }); settings.set('balance', 0); });
  await modal({ title: 'Equaliser and sound', width: 560, body: h('div.col',
    h('div.row', h('label.check', on, 'Equaliser on'), h('span.grow'), presets),
    h('div.pl-eq', h('div.pl-eqband.pre', pre, h('span', 'Pre')), ...sliders),
    h('label.check', { 'data-tip': 'Evens out loud and quiet parts: good for films at night' }, night, 'Night mode (quieter explosions, clearer voices)'),
    h('div.row', h('span.muted', 'Balance  L'), bal, h('span.muted', 'R'))),
  buttons: [{ label: 'Done', value: true, primary: true }] });
}
function saveEq() { settings.set('eq', { gains: chain.gains, preamp: chain.preamp, on: chain.eqOn }); }

async function adjustDialog() {
  const f = view.filters;
  const row = (key, label, min, max, unit = '%') => {
    const r = h('input', { type: 'range', min, max, value: f[key], style: { flex: '1' } });
    const out = h('span.muted', { style: { width: '48px', textAlign: 'right' } }, `${f[key]}${unit}`);
    r.addEventListener('input', () => { f[key] = Number(r.value); out.textContent = `${f[key]}${unit}`; setView({}); });
    r.addEventListener('dblclick', () => { f[key] = key === 'hue' || key === 'sharpen' ? 0 : 100; r.value = String(f[key]); out.textContent = `${f[key]}${unit}`; setView({}); });
    return h('div.row', h('span', { style: { width: '90px' } }, label), r, out);
  };
  await modal({ title: 'Picture adjustments', width: 420, body: h('div.col', row('brightness', 'Brightness', 30, 200), row('contrast', 'Contrast', 30, 200), row('saturate', 'Colour', 0, 300), row('hue', 'Hue', -180, 180, '°'), row('sharpen', 'Sharpen', 0, 100, ''),
    h('div.muted', { style: { fontSize: '12px' } }, 'Double-click a slider to reset it. These change how it looks here, not the file.')),
  buttons: [{ label: 'Reset all', value: 'reset' }, { label: 'Done', value: true, primary: true }] }).then((r) => {
    if (r === 'reset') setView({ filters: { brightness: 100, contrast: 100, saturate: 100, hue: 0, sharpen: 0 } }, 'Picture reset');
  });
}

async function jumpDialog() {
  if (!cur) return;
  const input = h('input.input', { value: fmtTime(now()), style: { width: '120px', fontFamily: 'var(--mono)' } });
  const ok = await modal({ title: 'Go to a time', width: 300, body: h('label.field', h('span', 'Time (h:mm:ss)'), input), buttons: [{ label: 'Cancel', value: false }, { label: 'Go', value: true, primary: true }] });
  if (!ok) return;
  const parts = input.value.trim().split(':').map(Number);
  if (parts.some((x) => !Number.isFinite(x))) return;
  const t = parts.reduce((a, x) => a * 60 + x, 0);
  seek(t);
}

function sleepAfter(kind, minutes = 0) {
  if (sleepTimer) clearTimeout(sleepTimer.id);
  sleepTimer = null;
  if (kind === 'off') { showOsd('Sleep timer off'); refresh(); return; }
  if (kind === 'minutes') sleepTimer = { kind, id: setTimeout(finishSleep, minutes * 60000), at: Date.now() + minutes * 60000 };
  else sleepTimer = { kind };
  showOsd(kind === 'minutes' ? `Stopping in ${minutes} minutes` : 'Stopping after this one');
  refresh();
}
function finishSleep() {
  // Fade out gently, then stop.
  const v0 = video.volume;
  let k = 0;
  const fade = setInterval(() => {
    k++;
    video.volume = Math.max(0, v0 * (1 - k / 20));
    if (k >= 20) { clearInterval(fade); video.pause(); video.volume = v0; sleepTimer = null; showOsd('Sleep timer: stopped'); refresh(); }
  }, 150);
}

async function snapshot() {
  if (!cur || !video.videoWidth) return;
  let bytes;
  try {
    const c = document.createElement('canvas');
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    c.getContext('2d').drawImage(video, 0, 0);
    bytes = await canvasBytes(c, 'image/png');
  } catch {
    if (hasFfmpeg) bytes = await host.media.frame(cur.item.file.id, now(), video.videoWidth).catch(() => null);
  }
  if (!bytes) { toast('The picture could not be captured.', { type: 'warn' }); return; }
  const name = `${baseName(cur.item.name)} ${fmtTime(now()).replace(/:/g, '-')}.png`;
  try {
    const f = await host.saveAs({ name, filters: [{ name: 'PNG picture', exts: ['png'] }], near: cur.item.file.id }, bytes);
    if (f) toast(`Saved ${f.name}`, { timeout: 2000 });
  } catch (err) { errorToast(err); }
}

async function copyFrame() {
  if (!cur || !video.videoWidth) return;
  try {
    const c = document.createElement('canvas');
    c.width = video.videoWidth;
    c.height = video.videoHeight;
    c.getContext('2d').drawImage(video, 0, 0);
    const ok = await host.clipboard.writeImage(await canvasBytes(c, 'image/png'));
    showOsd(ok ? 'Picture copied' : 'Could not copy the picture');
  } catch { showOsd('Could not copy the picture'); }
}

// ---------------------------------------------------------------------------
// On-screen messages, title, media keys
// ---------------------------------------------------------------------------
let osdTimer = 0;
function showOsd(text, ms = 1300) {
  osd.textContent = text;
  osd.classList.add('show');
  clearTimeout(osdTimer);
  osdTimer = setTimeout(() => osd.classList.remove('show'), ms);
}

function updateTitle() { shell.setTitle(cur ? cur.item.title : 'Nothing playing', false); }

function setupMediaSession(item, artwork = null) {
  if (!('mediaSession' in navigator)) return;
  const t = (item.info && item.info.tags) || {};
  try {
    navigator.mediaSession.metadata = new MediaMetadata({ title: t.title || t.TITLE || item.title, artist: t.artist || t.ARTIST || '', album: t.album || t.ALBUM || '', artwork: artwork ? [{ src: artwork }] : [] });
  } catch {}
}
if ('mediaSession' in navigator) {
  const ms = navigator.mediaSession;
  const set = (a, f) => { try { ms.setActionHandler(a, f); } catch {} };
  set('play', () => togglePlay());
  set('pause', () => togglePlay());
  set('stop', () => stop());
  set('previoustrack', () => prev());
  set('nexttrack', () => next());
  set('seekbackward', (d) => seekBy(-(d.seekOffset || 10)));
  set('seekforward', (d) => seekBy(d.seekOffset || 10));
  set('seekto', (d) => seek(d.seekTime));
}

function cycleRepeat() {
  repeat = repeat === 'off' ? 'all' : repeat === 'all' ? 'one' : 'off';
  settings.set('repeat', repeat);
  showOsd({ off: 'Repeat off', all: 'Repeat the playlist', one: 'Repeat this one' }[repeat]);
  paintModes();
}
function toggleShuffle() {
  shuffle = !shuffle;
  order = [];
  settings.set('shuffle', shuffle);
  showOsd(shuffle ? 'Shuffle on' : 'Shuffle off');
  paintModes();
}
function paintModes() {
  repeatBtn.classList.toggle('on', repeat !== 'off');
  repeatBtn.innerHTML = icon(repeat === 'one' ? 'repeatOne' : 'repeat', 20);
  shuffleBtn.classList.toggle('on', shuffle);
  refresh();
}
abBtn.addEventListener('click', () => commands.run('play.ab'));

function setAB() {
  if (!cur) return;
  if (!ab) { ab = { a: now(), b: null }; showOsd(`Loop from ${fmtTime(ab.a)} … press again to set the end`); } else if (ab.b === null) {
    if (now() <= ab.a + 0.2) { ab = null; showOsd('Loop cleared'); } else { ab.b = now(); showOsd(`Looping ${fmtTime(ab.a)} – ${fmtTime(ab.b)}`); seek(ab.a, { exact: true }); }
  } else { ab = null; showOsd('Loop cleared'); }
  drawAB();
}

function frameStep(dir) {
  if (!cur || isAudioItem(cur.item)) return;
  video.pause();
  const v = cur.item.info && cur.item.info.streams.find((s) => s.type === 'video');
  const fps = v && v.fps ? eval_(v.fps) || 25 : 25;
  seek(now() + dir / fps, { exact: true });
}

let mini = false;
async function toggleMini() {
  mini = !mini;
  document.body.classList.toggle('pl-mini', mini);
  if (mini) {
    shell.root.dataset.prevPlaylist = listPanel.classList.contains('hidden') ? '' : 'y';
    listPanel.classList.add('hidden');
    listPanel.previousSibling.classList.add('hidden');
    host.win.setSize(480, 300);
    host.win.setAlwaysOnTop(true);
  } else {
    if (shell.root.dataset.prevPlaylist) { listPanel.classList.remove('hidden'); listPanel.previousSibling.classList.remove('hidden'); }
    host.win.setAlwaysOnTop(settings.get('onTop', false));
    host.win.setSize(1180, 720);
  }
  setTimeout(layout, 50);
  refresh();
}

// ---------------------------------------------------------------------------
// Opening files
// ---------------------------------------------------------------------------
async function openDialog(addOnly = false) {
  const files = await host.openFiles({ filters: OPEN_FILTERS, multiple: true });
  if (!files.length) return;
  if (!addOnly) { clearList(); }
  addFiles(files, { playNow: !addOnly });
}

async function openFolder(addOnly = false) {
  const files = await host.openFolder({ exts: [...VIDEO, ...AUDIO] });
  if (!files.length) { toast('No video or music was found there.', { type: 'warn' }); return; }
  if (!addOnly) clearList();
  addFiles(files, { playNow: !addOnly });
}

let recentCache = [];
const refreshRecent = () => host.recent().then((r) => { recentCache = r; }).catch(() => {});
refreshRecent();

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
const C = (id, label, keys, run, extra = {}) => ({ id, label, keys, run, ...extra });
const playing = () => !!cur;
commands.register(
  C('media.open', 'Open Files…', 'Ctrl+O', () => openDialog(false), { icon: 'open', category: 'Media' }),
  C('media.openFolder', 'Open a Folder…', 'Ctrl+Shift+O', () => openFolder(false), { icon: 'folder', category: 'Media' }),
  C('media.add', 'Add Files to the Playlist…', null, () => openDialog(true), { icon: 'plus', category: 'Media' }),
  C('media.addFolder', 'Add a Folder to the Playlist…', null, () => openFolder(true), { icon: 'folder', category: 'Media' }),
  C('media.savePlaylist', 'Save the Playlist…', 'Ctrl+Y', () => savePlaylist(), { icon: 'save', category: 'Media', when: () => list.length > 0 }),
  C('media.info', 'Media Information', 'Ctrl+I', () => infoDialog(), { icon: 'info', category: 'Media', when: playing }),
  C('media.convert', 'Convert…', 'Ctrl+R', () => convertDialog(), { icon: 'export', category: 'Media', when: () => playing() && hasFfmpeg }),
  C('play.toggle', 'Play / Pause', ['Space', 'K'], () => togglePlay(), { icon: 'play', category: 'Playback' }),
  C('play.stop', 'Stop', 'S', () => stop(), { icon: 'stop', category: 'Playback', when: playing }),
  C('play.next', 'Next', 'N', () => next(), { icon: 'skipForward', category: 'Playback', when: () => list.length > 0 }),
  C('play.prev', 'Previous', 'P', () => prev(), { icon: 'skipBack', category: 'Playback', when: () => list.length > 0 }),
  C('play.fwd', 'Forward 5 Seconds', 'Right', () => seekBy(5), { icon: 'fastForward', category: 'Playback', when: playing }),
  C('play.back', 'Back 5 Seconds', 'Left', () => seekBy(-5), { icon: 'rewind', category: 'Playback', when: playing }),
  C('play.fwdSmall', 'Forward 1 Second', 'Shift+Right', () => seekBy(1), { category: 'Playback', when: playing }),
  C('play.backSmall', 'Back 1 Second', 'Shift+Left', () => seekBy(-1), { category: 'Playback', when: playing }),
  C('play.fwdBig', 'Forward 1 Minute', 'Ctrl+Right', () => seekBy(60), { category: 'Playback', when: playing }),
  C('play.backBig', 'Back 1 Minute', 'Ctrl+Left', () => seekBy(-60), { category: 'Playback', when: playing }),
  C('play.frameNext', 'Next Frame', '.', () => frameStep(1), { icon: 'frameForward', category: 'Playback', when: playing }),
  C('play.framePrev', 'Previous Frame', ',', () => frameStep(-1), { icon: 'frameBack', category: 'Playback', when: playing }),
  C('play.start', 'Back to the Start', 'Home', () => seek(0), { category: 'Playback', when: playing }),
  C('play.jump', 'Go to a Time…', 'Ctrl+T', () => jumpDialog(), { icon: 'clock', category: 'Playback', when: playing }),
  C('play.faster', 'Faster', ']', () => speedStep(1), { category: 'Playback' }),
  C('play.slower', 'Slower', '[', () => speedStep(-1), { category: 'Playback' }),
  C('play.normal', 'Normal Speed', '=', () => setSpeed(1), { category: 'Playback' }),
  C('play.ab', 'A-B Loop', 'L', () => setAB(), { category: 'Playback', when: playing, checked: () => !!ab }),
  C('play.repeat', 'Repeat (off, all, this one)', 'R', () => cycleRepeat(), { icon: 'repeat', category: 'Playback', checked: () => repeat !== 'off' }),
  C('play.shuffle', 'Shuffle', 'Z', () => toggleShuffle(), { icon: 'shuffle', category: 'Playback', checked: () => shuffle }),
  C('play.resume', 'Resume Where I Left Off', null, () => { settings.set('resumeOn', !settings.get('resumeOn', true)); refresh(); }, { category: 'Playback', checked: () => settings.get('resumeOn', true) }),
  C('audio.up', 'Volume Up', ['Up', 'Ctrl+Up'], () => setVolume(volume() + 5), { icon: 'volume', category: 'Audio' }),
  C('audio.down', 'Volume Down', ['Down', 'Ctrl+Down'], () => setVolume(volume() - 5), { icon: 'volumeLow', category: 'Audio' }),
  C('audio.mute', 'Mute', 'M', () => toggleMute(), { icon: 'volumeX', category: 'Audio', checked: () => settings.get('muted', false) }),
  C('audio.track', 'Next Audio Track', 'B', () => { const n = audioTracks().length; if (n > 1) setAudioTrack((cur.audioTrack + 1) % n); else showOsd('Only one audio track'); }, { icon: 'music', category: 'Audio', when: playing }),
  C('audio.eq', 'Equaliser and Sound…', 'Ctrl+E', () => eqDialog(), { icon: 'equalizer', category: 'Audio' }),
  C('audio.night', 'Night Mode', null, () => { chain.set({ night: !chain.night }); settings.set('night', chain.night); showOsd(chain.night ? 'Night mode on' : 'Night mode off'); refresh(); }, { category: 'Audio', checked: () => chain.night }),
  C('audio.viz', 'Visualiser for Music', null, () => { settings.set('visualiser', !settings.get('visualiser', true)); refresh(); }, { category: 'Audio', checked: () => settings.get('visualiser', true) }),
  C('video.fullscreen', 'Full Screen', ['F', 'F11'], () => { host.win.toggleFullScreen(); setTimeout(wake, 300); }, { icon: 'fullscreen', category: 'Video' }),
  C('video.exitFull', 'Leave Full Screen', 'Escape', () => host.win.setFullScreen(false), { category: 'Video', when: () => !!document.fullscreenElement || document.body.classList.contains('pl-full') }),
  C('video.pip', 'Picture in Picture', 'Ctrl+Shift+U', async () => { try { if (document.pictureInPictureElement) await document.exitPictureInPicture(); else await video.requestPictureInPicture(); } catch { toast('Picture in picture is not available for this video.', { type: 'warn' }); } }, { icon: 'pip', category: 'Video', when: playing }),
  C('video.onTop', 'Always on Top', 'Ctrl+Shift+T', () => { settings.set('onTop', !settings.get('onTop', false)); host.win.setAlwaysOnTop(settings.get('onTop', false)); refresh(); }, { icon: 'pin', category: 'Video', checked: () => settings.get('onTop', false) }),
  C('video.mini', 'Mini Player', 'Ctrl+M', () => toggleMini(), { category: 'Video', checked: () => mini }),
  C('video.aspect', 'Next Aspect Ratio', 'A', () => { const k = Object.keys(ASPECTS); const n = k[(k.indexOf(view.aspect) + 1) % k.length]; setView({ aspect: n }, `Aspect ${n === 'auto' ? 'as recorded' : n}`); }, { icon: 'aspect', category: 'Video', when: playing }),
  C('video.fill', 'Fill the Window (crop)', 'C', () => setView({ fill: !view.fill }, view.fill ? 'Whole picture' : 'Filling the window'), { category: 'Video', checked: () => view.fill }),
  C('video.zoomReset', 'Reset Zoom', 'Ctrl+0', () => setView({ zoom: 1, panX: 0, panY: 0 }, 'Zoom 100%'), { category: 'Video' }),
  C('video.rotate', 'Turn Right 90°', 'Ctrl+Shift+R', () => setView({ rotate: (view.rotate + 90) % 360 }, `Turned ${(view.rotate + 90) % 360}°`), { icon: 'rotateCw', category: 'Video', when: playing }),
  C('video.flip', 'Mirror', null, () => setView({ flipH: !view.flipH }), { icon: 'flipH', category: 'Video', checked: () => view.flipH, when: playing }),
  C('video.adjust', 'Picture Adjustments…', 'Ctrl+Shift+A', () => adjustDialog(), { icon: 'sliders', category: 'Video' }),
  C('video.snapshot', 'Save a Snapshot…', 'Shift+S', () => snapshot(), { icon: 'camera', category: 'Video', when: playing }),
  C('video.copyFrame', 'Copy the Picture', 'Ctrl+Shift+C', () => copyFrame(), { icon: 'copy', category: 'Video', when: playing }),
  C('subs.add', 'Add a Subtitle File…', 'Ctrl+Shift+L', async () => { if (!cur) return; const fs = await host.openFiles({ filters: [{ name: 'Subtitles', exts: SUBS }], readOnly: true }); if (fs[0]) loadSubtitleFile(fs[0]); }, { icon: 'subtitles', category: 'Subtitles', when: playing }),
  C('subs.cycle', 'Next Subtitles', 'V', () => cycleSubs(), { icon: 'subtitles', category: 'Subtitles', when: playing }),
  C('subs.later', 'Subtitles Later (+50 ms)', 'H', () => subDelay(0.05), { category: 'Subtitles', when: playing }),
  C('subs.earlier', 'Subtitles Earlier (−50 ms)', 'G', () => subDelay(-0.05), { category: 'Subtitles', when: playing }),
  C('subs.bigger', 'Bigger Subtitles', 'Shift+=', () => { subStyle.size = clamp(subStyle.size + 10, 50, 250); settings.set('subSize', subStyle.size); layout(); showOsd(`Subtitles ${subStyle.size}%`); }, { category: 'Subtitles' }),
  C('subs.smaller', 'Smaller Subtitles', 'Shift+-', () => { subStyle.size = clamp(subStyle.size - 10, 50, 250); settings.set('subSize', subStyle.size); layout(); showOsd(`Subtitles ${subStyle.size}%`); }, { category: 'Subtitles' }),
  C('subs.box', 'Subtitles on a Dark Box', null, () => { subStyle.box = !subStyle.box; settings.set('subBox', subStyle.box); layout(); refresh(); }, { category: 'Subtitles', checked: () => subStyle.box }),
  C('subs.up', 'Move Subtitles Up', null, () => { subStyle.position += 20; settings.set('subPos', subStyle.position); layout(); }, { category: 'Subtitles' }),
  C('subs.down', 'Move Subtitles Down', null, () => { subStyle.position = Math.max(0, subStyle.position - 20); settings.set('subPos', subStyle.position); layout(); }, { category: 'Subtitles' }),
  C('subs.auto', 'Load Matching Subtitle Files', null, () => { settings.set('autoSubs', !settings.get('autoSubs', true)); refresh(); }, { category: 'Subtitles', checked: () => settings.get('autoSubs', true) }),
  C('view.playlist', 'Playlist', 'Ctrl+L', () => { const hide = !listPanel.classList.contains('hidden'); listPanel.classList.toggle('hidden', hide); listPanel.previousSibling.classList.toggle('hidden', hide); settings.set('playlistOpen', !hide); setTimeout(layout, 30); refresh(); }, { icon: 'playlist', category: 'View', checked: () => !listPanel.classList.contains('hidden') }),
  C('view.wheel', 'The Wheel Zooms the Picture (otherwise volume)', null, () => { settings.set('wheelZooms', !settings.get('wheelZooms', false)); refresh(); }, { category: 'View', checked: () => settings.get('wheelZooms', false) }),
  C('list.remove', 'Remove From the Playlist', 'Delete', () => removeSelected(), { category: 'Playlist', when: () => selected.size > 0 }),
  C('list.clear', 'Clear the Playlist', null, () => clearList(), { icon: 'trash', category: 'Playlist', when: () => list.length > 0 }),
);

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------
function mediaMenu() {
  return [I('media.open'), I('media.openFolder'), { label: 'Open Recent', icon: 'clock', submenu: () => (recentCache.length ? recentCache.slice(0, 15).map((r) => ({ label: r.name, disabled: !r.exists, run: async () => { try { clearList(); addFiles([await host.openRecent(r.key)], { playNow: true }); } catch (err) { errorToast(err); } } })) : [{ label: 'Nothing yet', disabled: true }]) },
    { type: 'separator' }, I('media.add'), I('media.addFolder'), I('media.savePlaylist'), { type: 'separator' }, I('media.info'), I('media.convert'), { type: 'separator' }, I('app.newWindow'), I('app.close')];
}
function playbackMenu() {
  const chapters = cur && cur.item.info ? cur.item.info.chapters : [];
  return [I('play.toggle'), I('play.stop'), I('play.prev'), I('play.next'), { type: 'separator' }, I('play.back'), I('play.fwd'), I('play.backBig'), I('play.fwdBig'), I('play.framePrev'), I('play.frameNext'), I('play.jump'),
    chapters.length ? { label: 'Chapters', icon: 'chapters', submenu: chapters.map((c, i) => ({ label: `${c.title || `Chapter ${i + 1}`}  ${fmtTime(c.start)}`, run: () => seek(c.start) })) } : null,
    { type: 'separator' }, { label: 'Speed', icon: 'gauge', submenu: () => [I('play.slower'), I('play.faster'), I('play.normal'), { type: 'separator' }, ...SPEEDS.map((s) => ({ label: `${s}×`, checked: Math.abs(video.playbackRate - s) < 0.01, run: () => setSpeed(s) }))] },
    I('play.ab'), I('play.repeat'), I('play.shuffle'),
    { label: 'Sleep Timer', icon: 'moon', submenu: () => [{ label: 'Off', checked: !sleepTimer, run: () => sleepAfter('off') }, { label: 'After this one', checked: !!sleepTimer && sleepTimer.kind === 'track', run: () => sleepAfter('track') },
      ...[15, 30, 45, 60, 90, 120].map((m) => ({ label: `In ${m} minutes`, run: () => sleepAfter('minutes', m) })),
      sleepTimer && sleepTimer.at ? { label: `Stops at ${new Date(sleepTimer.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`, disabled: true } : null] },
    I('play.resume')];
}
function audioMenu() {
  return [I('audio.up'), I('audio.down'), I('audio.mute'), { type: 'separator' }, { label: 'Audio Track', icon: 'music', submenu: audioTrackItems }, I('audio.track'), { type: 'separator' }, I('audio.eq'), I('audio.night'), I('audio.viz')];
}
function videoMenu() {
  return [I('video.fullscreen'), I('video.pip'), I('video.mini'), I('video.onTop'), { type: 'separator' },
    { label: 'Aspect Ratio', icon: 'aspect', submenu: () => Object.keys(ASPECTS).map((k) => ({ label: k === 'auto' ? 'As recorded' : k, checked: view.aspect === k, run: () => setView({ aspect: k }) })) },
    I('video.fill'), I('video.zoomReset'), I('video.rotate'), I('video.flip'), I('video.adjust'), { type: 'separator' }, I('video.snapshot'), I('video.copyFrame')];
}
function subtitleMenu() {
  return [{ label: 'Track', icon: 'subtitles', submenu: subtitleTrackItems }, I('subs.add'), I('subs.cycle'), { type: 'separator' }, I('subs.earlier'), I('subs.later'), I('subs.bigger'), I('subs.smaller'), I('subs.up'), I('subs.down'), I('subs.box'), I('subs.auto')];
}
function viewMenu() { return [I('view.playlist'), I('video.mini'), I('view.wheel'), { type: 'separator' }, I('view.themeDark'), I('view.themeLight'), I('view.fullscreen')]; }
function stageMenu() {
  if (!cur) return [I('media.open'), I('media.openFolder')];
  return [I('play.toggle'), I('play.stop'), I('play.next'), { type: 'separator' }, { label: 'Speed', icon: 'gauge', submenu: () => SPEEDS.map((s) => ({ label: `${s}×`, checked: Math.abs(video.playbackRate - s) < 0.01, run: () => setSpeed(s) })) },
    { label: 'Audio Track', icon: 'music', submenu: audioTrackItems }, { label: 'Subtitles', icon: 'subtitles', submenu: subtitleTrackItems },
    { type: 'separator' }, I('video.fullscreen'), I('video.pip'), I('video.mini'), { label: 'Aspect Ratio', icon: 'aspect', submenu: () => Object.keys(ASPECTS).map((k) => ({ label: k === 'auto' ? 'As recorded' : k, checked: view.aspect === k, run: () => setView({ aspect: k }) })) },
    I('video.rotate'), I('video.adjust'), I('audio.eq'), { type: 'separator' }, I('video.snapshot'), I('video.copyFrame'), I('media.info')];
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
onDropFiles((files) => {
  const ok = files.filter((f) => [...VIDEO, ...AUDIO, ...PLAYLISTS].includes(extOf(f.name)));
  const subs = files.filter((f) => SUBS.includes(extOf(f.name)));
  if (subs.length && cur) subs.forEach((f, i) => loadSubtitleFile(f, i === 0));
  if (ok.length) addFiles(ok, { playNow: true });
}, 'Drop to play (or subtitles onto a video)');
host.onOpen((files) => addFiles(files, { playNow: true }));
listEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && selected.size) { const i = list.findIndex((x) => selected.has(x.id)); if (i >= 0) play(i, { start: null }); } });
window.addEventListener('beforeunload', () => rememberPosition());
document.addEventListener('fullscreenchange', () => { document.body.classList.toggle('pl-full', !!document.fullscreenElement); wake(); setTimeout(layout, 50); });
if (host.win.onFullScreen) host.win.onFullScreen((on) => { document.body.classList.toggle('pl-full', !!on); wake(); setTimeout(layout, 50); });
if (settings.get('onTop', false)) host.win.setAlwaysOnTop(true);

paintModes();
renderList();
updateTitle();
layout();
if (shell.info.files && shell.info.files.length) addFiles(shell.info.files, { playNow: true });

window.snakeApp = { video, list, play, get cur() { return cur; }, commands, chain, seek, now, total };
