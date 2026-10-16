// Snake's Movie Maker: put clips, pictures, music and titles on a timeline,
// trim and arrange them, add transitions, looks and motion, record a
// voice-over, and export a finished film (MP4, WebM, GIF or sound only).
import { h, clamp, extOf, baseName, fmtTime, uid } from '../../kit/dom.js';
import { icon } from '../../kit/icons.js';
import { host, inElectron } from '../../kit/host.js';
import * as commands from '../../kit/commands.js';
import { createShell, tb, select, combo, onDropFiles, guardClose, refresh, splitter } from '../../kit/shell.js';
import { showMenu, popover, closeMenus } from '../../kit/menu.js';
import { modal, toast, errorToast, busy, saveChangesBox, promptBox } from '../../kit/dialogs.js';
import { colorPicker, toHex, parseColor } from '../../kit/color.js';
import { knownFonts, allFonts } from '../../kit/fonts.js';
import { History } from '../../kit/history.js';
import { canvasBytes } from '../../kit/raster.js';
import {
  RESOLUTIONS, LOOKS, TRANSITIONS, TITLE_PRESETS, TITLE_ANIMS, newProject, newClip, end, projectDuration, mediaOf, trackOf, findClip,
  split, ripple, removeClip, trackEnd, serialise, parseProject, cssFilter, clipFilters,
} from './model.js';
import { placement, titleLayout } from './render.js';
import { Engine } from './engine.js';
import { Timeline } from './timeline.js';
import { buildJob, recordPreview } from './export.js';

const VIDEO = ['mp4', 'm4v', 'mkv', 'webm', 'mov', 'avi', 'wmv', 'flv', 'mpg', 'mpeg', 'ts', 'm2ts', '3gp', 'ogv'];
const AUDIO = ['mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'oga', 'opus', 'wma', 'aiff', 'aif', 'mka'];
const IMAGES = ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'avif', 'svg'];
const MEDIA_FILTERS = [{ name: 'Video, music and pictures', exts: [...VIDEO, ...AUDIO, ...IMAGES] }];
const PROJECT_FILTER = { name: "Snake's Movie Maker project", exts: ['snakemovie'] };
const DIRECT_CONTAINERS = ['mp4', 'm4v', 'mov', 'webm', 'ogv', 'mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'oga', 'opus'];
const DIRECT_VIDEO = ['h264', 'vp8', 'vp9', 'av1', 'theora'];
const DIRECT_AUDIO = ['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_f32le'];

const shell = await createShell({
  id: 'movie', name: "Snake's Movie Maker",
  quick: ['file.save', 'edit.undo', 'edit.redo', 'file.export'],
  menus: [
    { label: '&File', items: () => fileMenu() },
    { label: '&Edit', items: () => editMenu() },
    { label: '&Clip', items: () => clipMenu(selectedClips()[0]) },
    { label: '&View', items: () => viewMenu() },
    { label: '&Help', items: () => [I('app.palette'), I('app.shortcuts'), { type: 'separator' }, I('app.about')] },
  ],
  about: 'A video editor: arrange clips, pictures, music and titles on a timeline; trim, split, change speed; cross-fades and slides; looks and colour; Ken Burns motion on photos; voice-over recording; export to MP4, WebM, GIF or sound only.',
});
shell.showStatus(false);
const settings = host.settings;
const I = (id, extra) => commands.item(id, extra);
const hasFfmpeg = !!(shell.info && shell.info.ffmpeg) && !!host.media;

// ---------------------------------------------------------------------------
// State and undo
// ---------------------------------------------------------------------------
let p = newProject({ w: settings.get('newW', 1920), h: settings.get('newH', 1080), fps: settings.get('newFps', 30) });
const file = { handle: null, name: 'Untitled', id: uid('mv') };
const history = new History({ limit: 300, onChange: () => { updateTitle(); refresh(); } });

const snapshot = () => JSON.stringify({ width: p.width, height: p.height, fps: p.fps, background: p.background, tracks: p.tracks });
function restore(s) {
  const j = JSON.parse(s);
  Object.assign(p, j);
  changed();
}

/** Make a change as one undo step. With a `key`, quick repeats (slider drags) merge. */
function edit(label, fn, { key = null } = {}) {
  const before = snapshot();
  const r = fn();
  const after = snapshot();
  if (before !== after) history.push({ label, key, undo: () => restore(before), redo: () => restore(after) });
  changed();
  return r;
}

function changed() {
  timeline.render();
  engine.redraw();
  engine.sync(true);
  renderInspector();
  updateTimes();
  refresh();
}

const isDirty = () => history.dirty;

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------
const libTabs = h('div.mv-tabs');
const libBody = h('div.mv-libbody');
const library = h('div.mv-library', libTabs, libBody);
const canvas = h('canvas.mv-canvas');
const stageHint = h('div.mv-hint', 'Add videos, music and pictures with the + button, or drop them here.');
const stage = h('div.mv-stage', canvas, stageHint);
const timeNow = h('span.mv-time', '0:00.00');
const timeAll = h('span.mv-time.muted', '/ 0:00');
const playBtn = h('button.mv-play', { 'data-tip': 'Play', 'data-keys': 'Space', html: icon('play', 20) });
playBtn.addEventListener('click', () => engine.toggle());
const pbtn = (ic, tip, cmd) => { const b = h('button.mv-btn', { 'data-tip': tip, 'data-keys': commands.keysOf(cmd) || '', html: icon(ic, 17) }); b.addEventListener('click', () => commands.run(cmd)); return b; };
const transport = h('div.mv-transport', pbtn('skipBack', 'Back to the start', 'play.start'), pbtn('frameBack', 'Previous frame', 'play.frameBack'), playBtn, pbtn('frameForward', 'Next frame', 'play.frameNext'),
  timeNow, timeAll, h('span.grow'), pbtn('mic', 'Record a voice-over', 'clip.voice'), pbtn('camera', 'Save this frame as a picture', 'view.frame'), pbtn('fullscreen', 'Full-screen preview', 'view.fullPreview'));
const preview = h('div.mv-preview', stage, transport);
const inspector = h('div.mv-inspector');
const exportBtn = h('button.btn.primary.mv-export', { html: `${icon('export', 16)} Export` });
exportBtn.addEventListener('click', () => commands.run('file.export'));
const tlTools = h('div.mv-tltools',
  tb({ icon: 'scissors', label: 'Split', showLabel: true, tip: 'Split at the playhead', keys: 'S', run: () => commands.run('clip.split') }),
  tb({ icon: 'trash', tip: 'Delete', keys: 'Delete', run: () => commands.run('clip.delete') }),
  tb({ icon: 'duplicate', tip: 'Duplicate', keys: 'Ctrl+D', run: () => commands.run('clip.duplicate') }),
  h('div.tb-sep'),
  tb({ icon: 'magnet', tip: 'Snap to clip edges and the playhead', on: () => settings.get('snap', true), run: () => { settings.set('snap', !settings.get('snap', true)); refresh(); } }),
  tb({ icon: 'plus', tip: 'Add a track', menu: () => [{ label: 'Video track', icon: 'film', run: () => addTrack('video') }, { label: 'Title track', icon: 'text', run: () => addTrack('text') }, { label: 'Audio track', icon: 'music', run: () => addTrack('audio') }] }),
  h('span.grow'),
  tb({ icon: 'zoomOut', tip: 'Zoom out the timeline', run: () => timeline.zoomAt(1 / 1.5) }),
  tb({ icon: 'fit', tip: 'Fit the whole film', keys: 'Shift+Z', run: () => timeline.fit() }),
  tb({ icon: 'zoomIn', tip: 'Zoom in the timeline', run: () => timeline.zoomAt(1.5) }),
  exportBtn);

const top = h('div.mv-top', library, splitter(library, { side: 'left', key: 'libWidth', initial: 270, min: 200, max: 480 }), preview, splitter(inspector, { side: 'right', key: 'inspWidth', initial: 300, min: 240, max: 520 }), inspector);
const bottom = h('div.mv-bottom', tlTools);
shell.main.append(h('div.mv-root', top, splitter(bottom, { vertical: true, side: 'bottom', key: 'tlHeight', initial: 300, min: 160, max: 700 }), bottom));

// ---------------------------------------------------------------------------
// Engine and timeline
// ---------------------------------------------------------------------------
const engine = new Engine({
  project: () => p, canvas, crossOrigin: inElectron,
  url: (m) => (m.proxy ? m.proxy.url : m.blob || host.mediaURL(m.file)),
  onTime: () => { updateTimes(); timeline.placePlayhead(); if (engine.playing) timeline.follow(); },
  onState: (playing) => { playBtn.innerHTML = icon(playing ? 'pause' : 'play', 20); playBtn.dataset.tip = playing ? 'Pause' : 'Play'; refresh(); },
});

const timeline = new Timeline({
  project: () => p, engine, edit, settings,
  onSelect: (ids, opts = {}) => { renderInspector(); if (opts.focus) { const first = inspector.querySelector('textarea, input'); if (first) first.focus(); } refresh(); },
  onMenu: (e, c, tr, t) => showMenu(c ? clipMenu(c) : trackMenu(tr, t), { x: e.clientX, y: e.clientY }),
  onDropMedia: (ref, trackId, t) => {
    if (ref.title) addTitle(ref.title, t, trackId);
    else { const m = p.media.find((x) => x.id === ref.media); if (m) addToTimeline(m, { trackId, at: t }); }
  },
  thumbs: (m) => m.frames || [],
  peaks: (m) => m.peaks || null,
});
bottom.append(timeline.el);

function sizeCanvas() {
  const r = stage.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  const s = Math.min((r.width - 16) / p.width, (r.height - 16) / p.height);
  if (!(s > 0)) return;
  const cw = Math.floor(p.width * s);
  const ch = Math.floor(p.height * s);
  canvas.style.width = `${cw}px`;
  canvas.style.height = `${ch}px`;
  // Draw at screen resolution, never more than the film's own.
  canvas.width = Math.max(2, Math.round(Math.min(p.width, cw * dpr)));
  canvas.height = Math.max(2, Math.round(canvas.width * (p.height / p.width)));
  engine.redraw();
}
new ResizeObserver(sizeCanvas).observe(stage);

function updateTimes() {
  timeNow.textContent = fmtTime(engine.t, true);
  timeAll.textContent = `/ ${fmtTime(projectDuration(p))}`;
  stageHint.classList.toggle('hidden', p.tracks.some((t) => t.clips.length));
}

// ---------------------------------------------------------------------------
// Media library
// ---------------------------------------------------------------------------
const kindOf = (name) => { const e = extOf(name); return IMAGES.includes(e) ? 'image' : AUDIO.includes(e) ? 'audio' : 'video'; };

async function importFiles(files, { place = false } = {}) {
  const added = [];
  for (const f of files) {
    const e = extOf(f.name);
    if (e === 'snakemovie') { openProjectFile(f); continue; }
    if (![...VIDEO, ...AUDIO, ...IMAGES].includes(e)) continue;
    // The same file twice is one library item.
    const existing = p.media.find((m) => m.path && f.path && m.path === f.path);
    if (existing) { added.push(existing); continue; }
    const m = { id: uid('m'), name: f.name, kind: kindOf(f.name), duration: 0, width: 0, height: 0, hasAudio: true, path: f.path || '', file: f, token: f.id };
    p.media.push(m);
    added.push(m);
    renderLibrary();
    await analyse(m);
  }
  renderLibrary();
  if (place) for (const m of added) addToTimeline(m);
  return added;
}

/** Length, size, sound, thumbnails, waveform; and a smooth editing copy when needed. */
async function analyse(m) {
  try {
    if (m.kind === 'image') {
      const url = m.blob || host.mediaURL(m.file);
      const img = new Image();
      img.src = url;
      await img.decode();
      m.width = img.naturalWidth;
      m.height = img.naturalHeight;
      m.thumb = url;
      m.duration = 0;
      renderLibrary();
      return;
    }
    if (hasFfmpeg) {
      const info = await host.media.probe(m.token).catch(() => null);
      if (info) {
        const v = info.streams.find((s) => s.type === 'video' && !s.attached);
        const a = info.streams.find((s) => s.type === 'audio');
        m.duration = info.duration;
        m.hasAudio = !!a;
        if (v) { m.width = v.rotation % 180 ? v.height : v.width; m.height = v.rotation % 180 ? v.width : v.height; } else m.kind = 'audio';
        const direct = DIRECT_CONTAINERS.includes(extOf(m.name)) && (!v || DIRECT_VIDEO.includes(v.codec)) && (!a || DIRECT_AUDIO.includes(a.codec));
        if (!direct) makeProxy(m);
      }
    } else {
      // Read the header with a throwaway element.
      await new Promise((res) => {
        const el = document.createElement(m.kind === 'audio' ? 'audio' : 'video');
        el.preload = 'metadata';
        el.onloadedmetadata = () => { m.duration = Number.isFinite(el.duration) ? el.duration : 0; m.width = el.videoWidth || 0; m.height = el.videoHeight || 0; res(); };
        el.onerror = () => { m.unplayable = true; res(); };
        el.src = m.blob || host.mediaURL(m.file);
        setTimeout(res, 5000);
      });
    }
    renderLibrary();
    if (m.kind === 'video') makeFrames(m);
    if (m.hasAudio !== false) makePeaks(m);
  } catch (err) { errorToast(err); }
}

async function makeProxy(m) {
  m.proxying = 0;
  renderLibrary();
  const id = uid('px');
  const off = host.media.onProgress((x) => { if (x.id === id) { m.proxying = x.progress; paintProgress(m); } });
  try {
    m.proxy = await host.media.proxy(m.token, id);
    engine.redraw();
    engine.sync(true);
  } catch (err) { toast(`“${m.name}” could not be prepared for editing: ${err.message || err}`, { type: 'error' }); m.unplayable = true; } finally { off(); delete m.proxying; renderLibrary(); }
}

async function makeFrames(m) {
  const n = 12;
  m.frames = [];
  const times = Array.from({ length: n }, (_, i) => (m.duration * (i + 0.5)) / n);
  if (hasFfmpeg) {
    for (const t of times) {
      const bytes = await host.media.frame(m.token, t, 160).catch(() => null);
      if (!bytes) continue;
      m.frames.push({ t, url: URL.createObjectURL(new Blob([bytes], { type: 'image/jpeg' })) });
      if (m.frames.length === 1) { m.thumb = m.frames[0].url; renderLibrary(); }
    }
  } else {
    const v = document.createElement('video');
    v.muted = true;
    v.preload = 'auto';
    v.src = m.blob || host.mediaURL(m.file);
    await new Promise((r) => { v.onloadeddata = r; v.onerror = r; setTimeout(r, 4000); });
    const c = document.createElement('canvas');
    c.height = 90;
    c.width = Math.round(90 * ((v.videoWidth || 16) / (v.videoHeight || 9)));
    for (const t of times) {
      await new Promise((r) => { v.onseeked = r; v.currentTime = t; setTimeout(r, 1500); });
      c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
      m.frames.push({ t, url: c.toDataURL('image/jpeg', 0.7) });
      if (m.frames.length === 1) { m.thumb = m.frames[0].url; renderLibrary(); }
    }
    v.removeAttribute('src');
  }
  timeline.render();
}

async function makePeaks(m) {
  try {
    if (hasFfmpeg) {
      const r = await host.media.waveform(m.token, Math.min(200000, Math.max(200, Math.round(m.duration * 40))));
      if (r) m.peaks = r.peaks;
    } else if (!m.file || (m.file.size || 0) < 300e6) {
      const buf = await (await fetch(m.blob || host.mediaURL(m.file))).arrayBuffer();
      const ac = new OfflineAudioContext(1, 1, 44100);
      const audio = await ac.decodeAudioData(buf);
      const d = audio.getChannelData(0);
      const n = Math.min(100000, Math.max(200, Math.round(audio.duration * 40)));
      const pk = new Float32Array(n);
      const per = d.length / n;
      for (let i = 0; i < n; i++) { let mx = 0; for (let j = Math.floor(i * per); j < Math.floor((i + 1) * per); j += 4) mx = Math.max(mx, Math.abs(d[j])); pk[i] = mx; }
      m.peaks = pk;
      if (!m.duration) m.duration = audio.duration;
    }
    timeline.render();
  } catch { /* no waveform: the clip just shows its name */ }
}

let libTab = settings.get('libTab', 'media');
function renderLibrary() {
  const tabs = [['media', 'Media', 'film'], ['titles', 'Titles', 'text'], ['transitions', 'Transitions', 'transition'], ['looks', 'Looks', 'palette']];
  libTabs.replaceChildren(...tabs.map(([k, l, ic]) => {
    const b = h(`button${libTab === k ? '.on' : ''}`, { html: `${icon(ic, 14)}<span>${l}</span>` });
    b.addEventListener('click', () => { libTab = k; settings.set('libTab', k); renderLibrary(); });
    return b;
  }));
  if (libTab === 'media') libBody.replaceChildren(mediaPane());
  else if (libTab === 'titles') libBody.replaceChildren(titlesPane());
  else if (libTab === 'transitions') libBody.replaceChildren(transitionsPane());
  else libBody.replaceChildren(looksPane());
}

function mediaPane() {
  const add = h('button.btn.primary', { html: `${icon('plus', 15)} Add media` });
  add.addEventListener('click', () => commands.run('file.import'));
  const missing = p.media.filter((m) => m.missing);
  const items = p.media.map((m) => {
    const thumb = h('div.mv-thumb', m.thumb ? h('img', { src: m.thumb, alt: '', draggable: false }) : h('span', { html: icon(m.kind === 'audio' ? 'music' : m.kind === 'image' ? 'image' : 'film', 26) }));
    if (m.proxying !== undefined) thumb.append(h('div.mv-prog', h('div', { style: { width: `${Math.round(m.proxying * 100)}%` } })));
    const card = h(`div.mv-card${m.missing ? '.missing' : ''}`, { draggable: !m.missing, dataset: { media: m.id }, 'data-tip': m.missing ? 'Missing: relink it' : `${m.name}${m.duration ? ` · ${fmtTime(m.duration)}` : ''}` },
      thumb, h('div.mv-cardname', m.name), m.duration ? h('span.mv-dur', fmtTime(m.duration)) : null);
    card.addEventListener('dragstart', (e) => { e.dataTransfer.setData('application/x-snake-media', JSON.stringify({ media: m.id })); e.dataTransfer.effectAllowed = 'copy'; });
    card.addEventListener('dblclick', () => { if (!m.missing) addToTimeline(m); });
    card.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      showMenu([{ label: 'Add to the timeline', icon: 'plus', run: () => addToTimeline(m), disabled: m.missing }, { label: 'Add at the playhead', run: () => addToTimeline(m, { at: engine.t }), disabled: m.missing },
        { type: 'separator' }, m.missing ? { label: 'Relink…', icon: 'link', run: () => relink() } : null,
        { label: 'Remove from the project', icon: 'trash', run: () => removeMedia(m) }], { x: e.clientX, y: e.clientY });
    });
    return card;
  });
  return h('div.col', h('div.row', add, h('span.grow'), missing.length ? h('button.btn.small', { onclick: () => relink() }, `Relink ${missing.length} missing`) : null),
    items.length ? h('div.mv-grid', ...items) : h('div.muted.mv-empty', 'Videos, music and pictures you add show up here. Drag them onto the timeline, or double-click.'));
}

function paintProgress(m) {
  const bar = libBody.querySelector(`[data-media="${m.id}"] .mv-prog > div`);
  if (bar) bar.style.width = `${Math.round(m.proxying * 100)}%`;
}

function titlesPane() {
  return h('div.mv-grid.titles', ...Object.entries(TITLE_PRESETS).map(([k, t]) => {
    const card = h('div.mv-title-card', { draggable: true, 'data-tip': 'Click to add at the playhead, or drag onto the timeline' }, h('span', { style: titleCardStyle(t) }, t.text.split('\n')[0]), h('div.mv-cardname', t.label));
    card.addEventListener('click', () => addTitle(k, engine.t));
    card.addEventListener('dragstart', (e) => { e.dataTransfer.setData('application/x-snake-media', JSON.stringify({ title: k })); });
    return card;
  }));
}
function titleCardStyle(t) {
  const s = t.style;
  return { fontFamily: `"${s.font}", sans-serif`, fontWeight: String(s.weight || 600), fontStyle: s.italic ? 'italic' : 'normal', color: s.color, background: s.bg || 'transparent', padding: s.bg ? '2px 8px' : '0', borderRadius: '4px',
    textShadow: s.glow ? `0 0 8px ${s.glow}` : s.shadow ? '0 2px 6px rgba(0,0,0,.7)' : 'none' };
}

function transitionsPane() {
  const sel = selectedClips().filter((c) => trackOf(p, c).kind !== 'audio');
  return h('div.col', h('div.muted', { style: { fontSize: '12px' } }, sel.length ? 'Click to put a transition at the start of the selected clip.' : 'Select a clip on the timeline first.'),
    h('div.mv-grid.trans', ...Object.entries(TRANSITIONS).map(([k, label]) => {
      const card = h(`div.mv-trans-card${sel.length && sel.every((c) => (c.transition ? c.transition.kind : 'none') === k) ? '.on' : ''}`, h('div.mv-trans-icon', { html: icon(k === 'none' ? 'x' : k.startsWith('slide') ? 'arrow' : k === 'black' ? 'moon' : 'transition', 22) }), h('div.mv-cardname', label));
      card.addEventListener('click', () => { if (sel.length) setTransition(sel, k); else toast('Select a clip first.', { type: 'warn' }); });
      return card;
    })));
}

function looksPane() {
  const sel = selectedClips().filter((c) => trackOf(p, c).kind === 'video');
  // Each look shown on the current frame.
  const src = canvas;
  return h('div.col', h('div.muted', { style: { fontSize: '12px' } }, sel.length ? 'Click a look to use it on the selected clips.' : 'Select clips on the timeline first.'),
    h('div.mv-grid.looks', ...Object.entries(LOOKS).map(([k, l]) => {
      const c = document.createElement('canvas');
      c.width = 120;
      c.height = Math.round(120 * (p.height / p.width));
      const ctx = c.getContext('2d');
      ctx.filter = cssFilter({ brightness: 1, contrast: 1, saturation: 1, hue: 0, gray: 0, sepia: 0, blur: 0, ...l.f });
      try { ctx.drawImage(src, 0, 0, c.width, c.height); } catch {}
      const card = h(`div.mv-look${sel.length && sel.every((x) => (x.look || 'none') === k) ? '.on' : ''}`, c, h('div.mv-cardname', l.label));
      card.addEventListener('click', () => { if (sel.length) edit(`Look: ${l.label}`, () => { for (const x of sel) x.look = k; }); else toast('Select clips first.', { type: 'warn' }); renderLibrary(); });
      return card;
    })));
}

function removeMedia(m) {
  const used = p.tracks.some((t) => t.clips.some((c) => c.mediaId === m.id));
  edit('Remove media', () => { for (const t of p.tracks) t.clips = t.clips.filter((c) => c.mediaId !== m.id); });
  p.media = p.media.filter((x) => x !== m);
  engine.forget(m.id);
  renderLibrary();
  if (used) toast(`Removed “${m.name}” and its clips.`);
}

// ---------------------------------------------------------------------------
// Putting things on the timeline
// ---------------------------------------------------------------------------
const mainTrack = () => p.tracks.find((t) => t.kind === 'video' && t.main) || p.tracks.find((t) => t.kind === 'video');

function addTrack(kind) {
  const n = p.tracks.filter((t) => t.kind === kind).length + 1;
  const name = { video: 'Video', text: 'Titles', audio: 'Audio' }[kind];
  edit('Add track', () => {
    const tr = { id: uid('t'), kind, name: `${name} ${n}`, clips: [] };
    // New video and title tracks go on top of their kind; audio below.
    if (kind === 'audio') p.tracks.push(tr);
    else p.tracks.splice(p.tracks.findIndex((t) => t.kind === kind), 0, tr);
  });
}

function addToTimeline(m, { trackId = null, at = null } = {}) {
  if (m.missing) return;
  let tr = trackId ? p.tracks.find((t) => t.id === trackId) : null;
  if (tr && tr.kind === 'text') tr = null;
  if (tr && tr.kind === 'video' && m.kind === 'audio') tr = null;
  if (!tr) tr = m.kind === 'audio' ? p.tracks.find((t) => t.kind === 'audio') : mainTrack();
  if (!tr) return;
  const dur = m.kind === 'image' ? settings.get('photoDur', 5) : m.duration || 5;
  const start = at !== null ? at : trackEnd(tr);
  const clip = newClip({ mediaId: m.id, start, dur, in: 0, fit: m.kind === 'image' ? 'contain' : 'contain' });
  // Photos get gentle motion by default (can be turned off).
  if (m.kind === 'image' && settings.get('autoMotion', true)) clip.motion = { from: { s: 1, x: 0.5, y: 0.5 }, to: { s: 1.12, x: 0.5, y: 0.5 } };
  edit(`Add ${m.kind === 'audio' ? 'sound' : m.kind === 'image' ? 'picture' : 'video'}`, () => tr.clips.push(clip));
  timeline.select([clip.id]);
  if (at === null) engine.seek(start);
}

function addTitle(key, at = engine.t, trackId = null) {
  const preset = TITLE_PRESETS[key] || TITLE_PRESETS.big;
  let tr = trackId ? p.tracks.find((t) => t.id === trackId && t.kind === 'text') : null;
  if (!tr) tr = p.tracks.find((t) => t.kind === 'text');
  if (!tr) { addTrack('text'); tr = p.tracks.find((t) => t.kind === 'text'); }
  const clip = newClip({ kind: 'text', text: preset.text, style: { ...preset.style }, anim: preset.anim, start: at, dur: 4 });
  edit('Add title', () => tr.clips.push(clip));
  timeline.select([clip.id]);
  engine.seek(at + 0.6);
  setTimeout(() => { const ta = inspector.querySelector('textarea'); if (ta) { ta.focus(); ta.select(); } }, 30);
}

function setTransition(clips, kind, dur = settings.get('transDur', 1)) {
  edit(kind === 'none' ? 'Remove transition' : `Transition: ${TRANSITIONS[kind]}`, () => {
    for (const c of clips) {
      const tr = trackOf(p, c);
      const before = c.transition ? c.transition.kind : 'none';
      const prev = tr.clips.filter((x) => x !== c && end(x) <= c.start + 1e-3 + (c.transition && before === 'crossfade' ? c.transition.dur : 0)).sort((a, b) => end(b) - end(a))[0];
      // Undo an earlier cross-fade overlap first.
      if (before === 'crossfade' && c.transition) ripple(tr, c.start, c.transition.dur);
      if (kind === 'none') { c.transition = null; continue; }
      const d = Math.min(dur, c.dur / 2, prev ? prev.dur / 2 : dur);
      c.transition = { kind, dur: Math.round(d * 100) / 100 };
      // A cross-fade needs the two clips to overlap: pull this one (and what follows) back.
      if (kind === 'crossfade' && prev && Math.abs(end(prev) - c.start) < 0.05) ripple(tr, c.start, -c.transition.dur);
    }
  });
  renderLibrary();
}

// ---------------------------------------------------------------------------
// Clip operations
// ---------------------------------------------------------------------------
const selectedClips = () => [...timeline.selected].map((id) => findClip(p, id)).filter(Boolean);

function splitAtPlayhead() {
  const t = engine.t;
  let targets = selectedClips().filter((c) => c.start < t && end(c) > t);
  if (!targets.length) targets = p.tracks.filter((tr) => !tr.locked).flatMap((tr) => tr.clips.filter((c) => c.start < t - 0.05 && end(c) > t + 0.05));
  if (!targets.length) { toast('There is no clip under the playhead to split.', { type: 'warn' }); return; }
  const made = [];
  edit('Split', () => { for (const c of targets) { const r = split(p, c, t); if (r) made.push(r.id); } });
  timeline.select(made);
}

function deleteSelected(rippleIt = false) {
  const sel = selectedClips().filter((c) => !trackOf(p, c).locked);
  if (!sel.length) return;
  edit(rippleIt ? 'Delete and close the gap' : 'Delete', () => { for (const c of sel.sort((a, b) => b.start - a.start)) removeClip(p, c, { rippleTrack: rippleIt }); });
  timeline.select([]);
}

function duplicateSelected() {
  const sel = selectedClips();
  if (!sel.length) return;
  const made = [];
  edit('Duplicate', () => {
    for (const c of sel) {
      const tr = trackOf(p, c);
      const copy = { ...JSON.parse(JSON.stringify(c)), id: uid('c'), start: trackEnd(tr) };
      tr.clips.push(copy);
      made.push(copy.id);
    }
  });
  timeline.select(made);
}

let clipboard = null;
function copyClips() { const sel = selectedClips(); if (sel.length) { const t0 = Math.min(...sel.map((c) => c.start)); clipboard = sel.map((c) => ({ track: trackOf(p, c).id, clip: { ...JSON.parse(JSON.stringify(c)), start: c.start - t0 } })); } }
function pasteClips() {
  if (!clipboard) return;
  const made = [];
  edit('Paste', () => {
    for (const { track, clip } of clipboard) {
      const tr = p.tracks.find((t) => t.id === track) || p.tracks[0];
      const c = { ...JSON.parse(JSON.stringify(clip)), id: uid('c'), start: engine.t + clip.start };
      tr.clips.push(c);
      made.push(c.id);
    }
  });
  timeline.select(made);
}

/** Put a video clip's sound on an audio track of its own (and mute the video). */
function detachAudio(c) {
  const m = mediaOf(p, c);
  if (!m || m.kind !== 'video' || !m.hasAudio) return;
  let at = p.tracks.find((t) => t.kind === 'audio' && !t.clips.some((x) => x.start < end(c) && end(x) > c.start));
  edit('Detach the sound', () => {
    if (!at) { at = { id: uid('t'), kind: 'audio', name: 'Detached sound', clips: [] }; p.tracks.push(at); }
    at.clips.push(newClip({ ...JSON.parse(JSON.stringify(c)), id: uid('c'), transition: null, motion: null }));
    c.muted = true;
  });
}

function setSpeed(c, s) { edit('Speed', () => { const src = c.dur * c.speed; c.speed = s; c.dur = src / s; }); }

// ---------------------------------------------------------------------------
// Inspector
// ---------------------------------------------------------------------------
let fontList = knownFonts();
allFonts().then((l) => { fontList = l; });

const field = (label, control) => h('label.mv-field', h('span', label), control);
function slider(label, value, min, max, step, onInput, fmt = (v) => String(v)) {
  const r = h('input', { type: 'range', min, max, step, value });
  const out = h('span.mv-val', fmt(value));
  r.addEventListener('input', () => { out.textContent = fmt(Number(r.value)); onInput(Number(r.value)); });
  return h('label.mv-field', h('span', label), h('span.mv-slider', r, out));
}
function colorBtn(value, onPick, allowNone = false) {
  const b = h('button.mv-color', { style: { background: value || 'transparent' } }, value ? '' : 'None');
  b.addEventListener('click', () => {
    const pk = colorPicker({ value: value || '#ffffff', alpha: true, allowNone, onChange: (c) => { value = c; b.style.background = c; onPick(toHex(parseColor(c), true)); },
      onPick: (c) => { closeMenus(); value = c === 'none' ? '' : c; b.style.background = value || 'transparent'; b.textContent = value ? '' : 'None'; onPick(c === 'none' ? '' : toHex(parseColor(c), true)); } });
    popover(pk, { anchor: b });
  });
  return b;
}
const section = (title, ...rows) => h('div.mv-sec', h('div.mv-sechead', title), ...rows.filter(Boolean));

function renderInspector() {
  const sel = selectedClips();
  if (!sel.length) { inspector.replaceChildren(projectPanel()); return; }
  if (sel.length > 1) {
    inspector.replaceChildren(section(`${sel.length} clips selected`, h('div.muted', 'Looks and transitions apply to all of them.'),
      h('div.row', h('button.btn', { onclick: () => deleteSelected() }, 'Delete'), h('button.btn', { onclick: () => duplicateSelected() }, 'Duplicate'))));
    return;
  }
  const c = sel[0];
  const tr = trackOf(p, c);
  const m = mediaOf(p, c);
  const k = (prop) => `${c.id}:${prop}`;
  const set = (label, prop, fn) => edit(label, fn, { key: k(prop) });
  const parts = [];
  const title = tr.kind === 'text' ? 'Title' : m ? m.name : 'Clip';
  parts.push(h('div.mv-insphead', h('span', { html: icon(tr.kind === 'text' ? 'text' : m && m.kind === 'audio' ? 'music' : m && m.kind === 'image' ? 'image' : 'film', 16) }), h('b', title)));
  // Timing.
  const num = (value, onChange, step = 0.1, min = 0) => {
    const i = h('input.input.num', { type: 'number', value: (Math.round(value * 100) / 100).toString(), step, min });
    i.addEventListener('change', () => onChange(Number(i.value)));
    return i;
  };
  const timing = [field('Starts at (s)', num(c.start, (v) => edit('Move clip', () => { c.start = Math.max(0, v); }))),
    field('Length (s)', num(c.dur, (v) => edit('Clip length', () => { c.dur = Math.max(0.1, m && m.duration && m.kind !== 'image' ? Math.min(v, (m.duration - c.in) / c.speed) : v); })))];
  if (m && m.kind !== 'image') {
    timing.push(field('Speed', select({ options: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4, 8].map((s) => ({ value: String(s), label: `${s}×` })), value: String(c.speed), onChange: (v) => setSpeed(c, Number(v)) })));
  }
  parts.push(section('Timing', ...timing));
  if (tr.kind === 'text') parts.push(textSection(c, set));
  if (tr.kind === 'video' && m) parts.push(pictureSection(c, m, set));
  if (tr.kind !== 'text' && m && m.kind !== 'image') {
    parts.push(section('Sound',
      slider('Volume', Math.round((c.volume ?? 1) * 100), 0, 200, 1, (v) => set('Volume', 'vol', () => { c.volume = v / 100; }), (v) => `${v}%`),
      h('label.check', h('input', { type: 'checkbox', checked: !!c.muted, onchange: (e) => edit(e.target.checked ? 'Mute clip' : 'Unmute clip', () => { c.muted = e.target.checked; }) }), 'Mute this clip'),
      tr.kind === 'video' && m.hasAudio ? h('button.btn.small', { onclick: () => detachAudio(c) }, 'Put the sound on its own track') : null));
  }
  parts.push(section('Fades',
    slider('Fade in', c.fadeIn || 0, 0, Math.min(5, c.dur / 2), 0.1, (v) => set('Fade in', 'fi', () => { c.fadeIn = v; }), (v) => `${v.toFixed(1)}s`),
    slider('Fade out', c.fadeOut || 0, 0, Math.min(5, c.dur / 2), 0.1, (v) => set('Fade out', 'fo', () => { c.fadeOut = v; }), (v) => `${v.toFixed(1)}s`)));
  if (tr.kind === 'video') {
    const t = c.transition || { kind: 'none', dur: 1 };
    parts.push(section('Transition in',
      field('Kind', select({ options: Object.entries(TRANSITIONS).map(([v, l]) => ({ value: v, label: l })), value: t.kind, onChange: (v) => setTransition([c], v, t.dur || 1) })),
      t.kind !== 'none' ? slider('Length', t.dur, 0.2, 3, 0.1, (v) => set('Transition length', 'td', () => { c.transition = { ...c.transition, dur: v }; }), (v) => `${v.toFixed(1)}s`) : null));
  }
  inspector.replaceChildren(...parts);
}

function pictureSection(c, m, set) {
  const f = clipFilters(c);
  const rows = [
    field('Fit', select({ options: [{ value: 'contain', label: 'Whole picture' }, { value: 'cover', label: 'Fill the frame (crop)' }, { value: 'stretch', label: 'Stretch' }], value: c.fit, onChange: (v) => edit('Fit', () => { c.fit = v; }) })),
    slider('Size', Math.round(c.scale * 100), 10, 300, 1, (v) => set('Size', 'scale', () => { c.scale = v / 100; }), (v) => `${v}%`),
    slider('Across', Math.round(c.x * 100), -50, 150, 1, (v) => set('Position', 'x', () => { c.x = v / 100; }), (v) => `${v}%`),
    slider('Down', Math.round(c.y * 100), -50, 150, 1, (v) => set('Position', 'y', () => { c.y = v / 100; }), (v) => `${v}%`),
    slider('Turn', c.rotate || 0, -180, 180, 1, (v) => set('Turn', 'rot', () => { c.rotate = v; }), (v) => `${v}°`),
    slider('Opacity', Math.round((c.opacity ?? 1) * 100), 0, 100, 1, (v) => set('Opacity', 'op', () => { c.opacity = v / 100; }), (v) => `${v}%`),
    h('div.row', h('button.btn.small', { onclick: () => edit('Picture in picture', () => { c.scale = 0.38; c.x = 0.76; c.y = 0.74; }) }, 'Picture in picture'), h('button.btn.small', { onclick: () => edit('Reset position', () => { c.scale = 1; c.x = 0.5; c.y = 0.5; c.rotate = 0; }) }, 'Reset')),
  ];
  const look = section('Look and colour',
    field('Look', select({ options: Object.entries(LOOKS).map(([v, l]) => ({ value: v, label: l.label })), value: c.look || 'none', onChange: (v) => edit('Look', () => { c.look = v; }) })),
    slider('Brightness', Math.round(f.brightness * 100), 30, 200, 1, (v) => set('Brightness', 'br', () => { c.filters = { ...c.filters, brightness: v / 100 }; }), (v) => `${v}%`),
    slider('Contrast', Math.round(f.contrast * 100), 30, 200, 1, (v) => set('Contrast', 'ct', () => { c.filters = { ...c.filters, contrast: v / 100 }; }), (v) => `${v}%`),
    slider('Colour', Math.round(f.saturation * 100), 0, 300, 1, (v) => set('Colour', 'sat', () => { c.filters = { ...c.filters, saturation: v / 100 }; }), (v) => `${v}%`),
    slider('Hue', f.hue, -180, 180, 1, (v) => set('Hue', 'hue', () => { c.filters = { ...c.filters, hue: v }; }), (v) => `${v}°`),
    slider('Blur', f.blur, 0, 20, 0.5, (v) => set('Blur', 'blur', () => { c.filters = { ...c.filters, blur: v }; }), (v) => `${v}px`),
    h('button.btn.small', { onclick: () => edit('Reset colour', () => { c.filters = {}; c.look = 'none'; }) }, 'Reset colour'));
  const parts = [section('Picture', ...rows), look];
  if (m.kind === 'image') {
    const presets = { none: 'No motion', zoomIn: 'Slow zoom in', zoomOut: 'Slow zoom out', panLeft: 'Pan to the left', panRight: 'Pan to the right', panUp: 'Pan up' };
    const cur = !c.motion ? 'none' : c.motion.to.s > c.motion.from.s ? 'zoomIn' : c.motion.to.s < c.motion.from.s ? 'zoomOut' : c.motion.to.x < c.motion.from.x ? 'panLeft' : c.motion.to.x > c.motion.from.x ? 'panRight' : 'panUp';
    parts.push(section('Motion (Ken Burns)', field('Move', select({ options: Object.entries(presets).map(([v, l]) => ({ value: v, label: l })), value: cur, onChange: (v) => edit('Motion', () => {
      const M = { none: null, zoomIn: { from: { s: 1, x: 0.5, y: 0.5 }, to: { s: 1.25, x: 0.5, y: 0.5 } }, zoomOut: { from: { s: 1.25, x: 0.5, y: 0.5 }, to: { s: 1, x: 0.5, y: 0.5 } },
        panLeft: { from: { s: 1.2, x: 0.62, y: 0.5 }, to: { s: 1.2, x: 0.38, y: 0.5 } }, panRight: { from: { s: 1.2, x: 0.38, y: 0.5 }, to: { s: 1.2, x: 0.62, y: 0.5 } }, panUp: { from: { s: 1.2, x: 0.5, y: 0.62 }, to: { s: 1.2, x: 0.5, y: 0.38 } } };
      c.motion = M[v];
    }) }))));
  }
  return h('div', ...parts);
}

function textSection(c, set) {
  const st = c.style;
  const ta = h('textarea.input.mv-textarea', { rows: 3, spellcheck: true });
  ta.value = c.text;
  ta.addEventListener('input', () => set('Title text', 'text', () => { c.text = ta.value; }));
  ta.addEventListener('keydown', (e) => e.stopPropagation());
  const sty = (prop, label) => (v) => set(label, `st.${prop}`, () => { c.style = { ...c.style, [prop]: v }; });
  const posPresets = { top: [0.5, 0.12], center: [0.5, 0.5], lower: [0.28, 0.8], bottom: [0.5, 0.88] };
  return section('Title',
    ta,
    field('Font', combo({ values: () => fontList, value: st.font, width: 170, itemStyle: (f) => ({ fontFamily: `"${f}"` }), onCommit: (v) => sty('font', 'Font')(v) })),
    slider('Size', Math.round(st.size * 1000) / 10, 2, 30, 0.5, (v) => sty('size', 'Text size')(v / 100), (v) => `${v}%`),
    h('div.row', field('Colour', colorBtn(st.color, sty('color', 'Text colour'))), field('Box', colorBtn(st.bg, sty('bg', 'Box colour'), true))),
    h('div.row',
      h('label.check', h('input', { type: 'checkbox', checked: (st.weight || 400) >= 700, onchange: (e) => sty('weight', 'Bold')(e.target.checked ? 800 : 500) }), 'Bold'),
      h('label.check', h('input', { type: 'checkbox', checked: !!st.italic, onchange: (e) => sty('italic', 'Italic')(e.target.checked) }), 'Italic')),
    field('Align', select({ options: [{ value: 'left', label: 'Left' }, { value: 'center', label: 'Centre' }, { value: 'right', label: 'Right' }], value: st.align || 'center', onChange: sty('align', 'Align') })),
    slider('Outline', Math.round((st.outline || 0) * 100), 0, 30, 1, (v) => sty('outline', 'Outline')(v / 100), (v) => `${v}`),
    slider('Shadow', Math.round((st.shadow || 0) * 100), 0, 100, 1, (v) => sty('shadow', 'Shadow')(v / 100), (v) => `${v}`),
    field('Place', h('div.row', ...Object.entries(posPresets).map(([k, [x, y]]) => h('button.btn.small', { onclick: () => edit('Title place', () => { c.style = { ...c.style, x, y, align: k === 'lower' ? 'left' : c.style.align === 'left' && k !== 'lower' ? 'center' : c.style.align }; }) }, k[0].toUpperCase() + k.slice(1))))),
    field('Animation', select({ options: Object.entries(TITLE_ANIMS).map(([v, l]) => ({ value: v, label: l })), value: c.anim || 'fade', onChange: (v) => edit('Title animation', () => { c.anim = v; }) })),
    h('div.muted', { style: { fontSize: '12px' } }, 'Tip: drag the title in the preview to move it; the wheel over it changes its size.'));
}

function projectPanel() {
  const res = select({ options: [...RESOLUTIONS.map((r) => ({ value: `${r.w}x${r.h}`, label: r.label })), { value: 'custom', label: 'Custom…' }], value: `${p.width}x${p.height}`, onChange: async (v) => {
    let [w, hh] = v.split('x').map(Number);
    if (v === 'custom') {
      const r = await sizePrompt();
      if (!r) { renderInspector(); return; }
      [w, hh] = r;
    }
    edit('Film size', () => { p.width = w; p.height = hh; });
    settings.set('newW', w); settings.set('newH', hh);
    sizeCanvas();
  } });
  if (![...res.options].some((o) => o.value === `${p.width}x${p.height}`)) res.prepend(h('option', { value: `${p.width}x${p.height}` }, `${p.width} × ${p.height}`)), res.value = `${p.width}x${p.height}`;
  const fps = select({ options: [24, 25, 30, 50, 60].map((v) => ({ value: String(v), label: `${v} frames a second` })), value: String(p.fps), onChange: (v) => { edit('Frame rate', () => { p.fps = Number(v); }); settings.set('newFps', Number(v)); } });
  return h('div',
    h('div.mv-insphead', h('span', { html: icon('film', 16) }), h('b', 'Film')),
    section('Settings', field('Size', res), field('Smoothness', fps), field('Background', colorBtn(p.background, (c) => edit('Background colour', () => { p.background = c.slice(0, 7); }, { key: 'bg' })))),
    section('Photos', slider('New photos last', settings.get('photoDur', 5), 1, 20, 0.5, (v) => settings.set('photoDur', v), (v) => `${v}s`),
      h('label.check', h('input', { type: 'checkbox', checked: settings.get('autoMotion', true), onchange: (e) => settings.set('autoMotion', e.target.checked) }), 'Gentle motion on new photos')),
    section('About this film', h('div.muted', `${p.tracks.reduce((n, t) => n + t.clips.length, 0)} clips · ${fmtTime(projectDuration(p))} long · ${p.media.length} media files`)),
    h('div.muted.mv-tips', 'Tips: double-click media to add it; drag clip edges to trim; S splits at the playhead; the wheel over the timeline zooms it.'));
}

async function sizePrompt() {
  const w = h('input.input.num', { type: 'number', value: String(p.width), min: 16, max: 7680 });
  const hh = h('input.input.num', { type: 'number', value: String(p.height), min: 16, max: 7680 });
  const ok = await modal({ title: 'Film size', width: 320, body: h('div.col', field('Width', w), field('Height', hh)), buttons: [{ label: 'Cancel', value: false }, { label: 'OK', value: true, primary: true }] });
  if (!ok) return null;
  return [clamp(Math.round(Number(w.value) / 2) * 2, 16, 7680), clamp(Math.round(Number(hh.value) / 2) * 2, 16, 7680)];
}

// ---------------------------------------------------------------------------
// Moving things in the preview
// ---------------------------------------------------------------------------
function canvasPoint(e) {
  const r = canvas.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * p.width, y: ((e.clientY - r.top) / r.height) * p.height };
}

/** The selected clip under a point in the preview, if it is showing. */
function hitSelected(pt) {
  const c = selectedClips()[0];
  if (!c || c.start > engine.t || end(c) <= engine.t) return null;
  const tr = trackOf(p, c);
  if (tr.kind === 'text') {
    const L = titleLayout(canvas.getContext('2d'), p, c);
    return pt.x >= L.box.x && pt.x <= L.box.x + L.box.w && pt.y >= L.box.y && pt.y <= L.box.y + L.box.h ? c : null;
  }
  if (tr.kind !== 'video') return null;
  const m = mediaOf(p, c);
  if (!m) return null;
  const pl = placement(p, c, m.width || p.width, m.height || p.height);
  return Math.abs(pt.x - pl.cx) <= pl.w / 2 && Math.abs(pt.y - pl.cy) <= pl.h / 2 ? c : null;
}

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const pt = canvasPoint(e);
  const c = hitSelected(pt);
  if (!c) { engine.toggle(); return; }
  const isText = trackOf(p, c).kind === 'text';
  const x0 = isText ? c.style.x : c.x;
  const y0 = isText ? c.style.y : c.y;
  canvas.setPointerCapture(e.pointerId);
  let moved = false;
  const before = snapshot();
  const mv = (ev) => {
    const q = canvasPoint(ev);
    let nx = x0 + (q.x - pt.x) / p.width;
    let ny = y0 + (q.y - pt.y) / p.height;
    // Snap to the centre lines.
    if (Math.abs(nx - 0.5) < 0.012) nx = 0.5;
    if (Math.abs(ny - 0.5) < 0.012) ny = 0.5;
    moved = true;
    if (isText) c.style = { ...c.style, x: nx, y: ny }; else { c.x = nx; c.y = ny; }
    engine.redraw();
  };
  const up = () => {
    canvas.removeEventListener('pointermove', mv);
    canvas.removeEventListener('pointerup', up);
    if (!moved) { engine.toggle(); return; }
    const after = snapshot();
    restore(before);
    edit('Move in the picture', () => Object.assign(p, JSON.parse(after)));
  };
  canvas.addEventListener('pointermove', mv);
  canvas.addEventListener('pointerup', up);
});
// The wheel over the selected title or picture changes its size; elsewhere it steps through frames.
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  const c = hitSelected(canvasPoint(e));
  if (c) {
    const k = e.deltaY < 0 ? 1.06 : 1 / 1.06;
    if (trackOf(p, c).kind === 'text') edit('Text size', () => { c.style = { ...c.style, size: clamp(c.style.size * k, 0.01, 0.4) }; }, { key: `${c.id}:wheel` });
    else edit('Size', () => { c.scale = clamp(c.scale * k, 0.05, 6); }, { key: `${c.id}:wheel` });
    return;
  }
  engine.pause();
  engine.seek(engine.t + (e.deltaY < 0 ? -1 : 1) / p.fps * (e.shiftKey ? 10 : 1));
}, { passive: false });

// ---------------------------------------------------------------------------
// Voice-over
// ---------------------------------------------------------------------------
let rec = null;
async function toggleVoice() {
  if (rec) { rec.stop(); return; }
  let stream;
  try { stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }); } catch { toast('The microphone is not available (or permission was not given).', { type: 'warn' }); return; }
  const type = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported(t));
  const chunks = [];
  const r = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
  const startAt = engine.t;
  r.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  r.onstop = async () => {
    stream.getTracks().forEach((t) => t.stop());
    rec = null;
    document.body.classList.remove('mv-recording');
    engine.pause();
    const blob = new Blob(chunks, { type: r.mimeType || 'audio/webm' });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let m;
    if (inElectron) {
      // The recording is kept as a file you choose, so the project can find it again.
      const f = await host.saveAs({ name: `Voice-over ${new Date().toLocaleTimeString().replace(/:/g, '-')}.webm`, filters: [{ name: 'Recording', exts: ['webm'] }] }, bytes);
      if (!f) return;
      [m] = await importFiles([f]);
    } else {
      m = { id: uid('m'), name: 'Voice-over.webm', kind: 'audio', duration: 0, width: 0, height: 0, hasAudio: true, path: '', blob: URL.createObjectURL(blob) };
      p.media.push(m);
      await analyse(m);
    }
    if (!m) return;
    const tr = p.tracks.filter((t) => t.kind === 'audio').reverse().find((t) => !t.clips.some((c) => c.start < startAt + (m.duration || 1) && end(c) > startAt)) || p.tracks.find((t) => t.kind === 'audio');
    addToTimeline(m, { trackId: tr && tr.id, at: startAt });
  };
  rec = r;
  r.start(500);
  document.body.classList.add('mv-recording');
  engine.play();
  toast('Recording… press the microphone button (or R) again to stop.', { timeout: 3000 });
}

// ---------------------------------------------------------------------------
// Files: projects, relinking, exporting
// ---------------------------------------------------------------------------
async function saveProject(as = false) {
  if (!as && file.handle && file.handle.writable) {
    try {
      file.handle = await host.write(file.handle, serialise(p));
      history.markSaved();
      updateTitle();
      toast(`Saved ${file.name}`, { timeout: 1500 });
      return true;
    } catch (err) { errorToast(err); return false; }
  }
  try {
    const f = await host.saveAs({ name: `${baseName(file.name === 'Untitled' ? 'My film' : file.name)}.snakemovie`, filters: [PROJECT_FILTER] }, serialise(p));
    if (!f) return false;
    file.handle = f.id ? f : null;
    file.name = f.name;
    history.markSaved();
    updateTitle();
    if (!inElectron && p.media.length) toast('In the browser, the project remembers file names only: you will be asked to find the media when you open it.', { timeout: 6000 });
    return true;
  } catch (err) { errorToast(err); return false; }
}

async function openProjectFile(f) {
  if (!(await confirmLeave())) return;
  try {
    let text;
    let links = {};
    if (host.media && host.media.project) ({ text, links } = await host.media.project(f.id));
    else text = new TextDecoder().decode(await host.read(f));
    const np = parseProject(text);
    for (const m of np.media) {
      const d = links[m.id];
      if (d) Object.assign(m, { file: d, token: d.id, path: d.path, missing: false });
    }
    engine.pause();
    p = np;
    file.handle = f.writable !== false ? f : null;
    file.name = f.name;
    history.clear();
    timeline.select([]);
    sizeCanvas();
    changed();
    renderLibrary();
    engine.seek(0);
    timeline.fit();
    for (const m of p.media) if (!m.missing) analyse(m);
    const missing = p.media.filter((m) => m.missing).length;
    if (missing) toast(`${missing} media file${missing === 1 ? ' is' : 's are'} missing.`, { type: 'warn', action: { label: 'Relink…', run: () => relink() }, timeout: 8000 });
  } catch (err) { errorToast(err); }
}

async function relink() {
  const missing = p.media.filter((m) => m.missing);
  if (!missing.length) return;
  const files = await host.openFiles({ filters: MEDIA_FILTERS, multiple: true, readOnly: true });
  let found = 0;
  for (const f of files) {
    const m = missing.find((x) => x.missing && x.name.toLowerCase() === f.name.toLowerCase()) || (files.length === 1 && missing.length === 1 ? missing[0] : null);
    if (!m) continue;
    Object.assign(m, { file: f, token: f.id, path: f.path || m.path, missing: false });
    found++;
    analyse(m);
  }
  renderLibrary();
  changed();
  toast(found ? `Found ${found} of ${missing.length}.` : 'None of those files matched the missing names.', { type: found ? 'info' : 'warn' });
}

async function confirmLeave() {
  if (!isDirty()) return true;
  const r = await saveChangesBox(file.name);
  if (r === 'save') return saveProject();
  return r === 'discard';
}

async function newFilm() {
  if (!(await confirmLeave())) return;
  engine.pause();
  p = newProject({ w: settings.get('newW', 1920), h: settings.get('newH', 1080), fps: settings.get('newFps', 30) });
  file.handle = null;
  file.name = 'Untitled';
  history.clear();
  timeline.select([]);
  sizeCanvas();
  changed();
  renderLibrary();
  engine.seek(0);
}

async function exportFilm() {
  const D = projectDuration(p);
  if (D <= 0) { toast('The timeline is empty.', { type: 'warn' }); return; }
  if (p.media.some((m) => m.missing && p.tracks.some((t) => t.clips.some((c) => c.mediaId === m.id)))) { toast('Some media is missing: relink it first.', { type: 'warn', action: { label: 'Relink…', run: () => relink() } }); return; }
  engine.pause();
  const formats = hasFfmpeg
    ? [['mp4', 'MP4 video (plays everywhere)'], ['webm', 'WebM video (web)'], ['gif', 'Animated GIF (no sound)'], ['mp3', 'MP3 (sound only)'], ['m4a', 'M4A (sound only)'], ['wav', 'WAV (sound only)']]
    : [['webm', 'WebM video (recorded as it plays)']];
  const fmt = select({ options: formats.map(([v, l]) => ({ value: v, label: l })), value: settings.get('exportFormat', formats[0][0]), onChange: (v) => settings.set('exportFormat', v) });
  const quality = select({ options: [{ value: 'high', label: 'Best (bigger file)' }, { value: 'good', label: 'Good' }, { value: 'small', label: 'Smaller file' }], value: settings.get('exportQuality', 'good'), onChange: (v) => settings.set('exportQuality', v) });
  const sel = selectedClips();
  const rangeSel = select({ options: [{ value: 'all', label: `The whole film (${fmtTime(D)})` }, ...(sel.length ? [{ value: 'sel', label: 'Just the selected clips’ time' }] : [])], value: 'all', onChange: () => {} });
  const ok = await modal({ title: 'Export the film', width: 440, body: h('div.col', field('Format', fmt), hasFfmpeg ? field('Quality', quality) : null, field('Part', rangeSel),
    h('div.muted', `${p.width} × ${p.height}, ${p.fps} frames a second.${hasFfmpeg ? '' : ' Recording takes as long as the film; keep this window open.'}`)),
  buttons: [{ label: 'Cancel', value: false }, { label: 'Export…', value: true, primary: true }] });
  if (!ok) return;
  const range = rangeSel.value === 'sel' && sel.length ? [Math.min(...sel.map((c) => c.start)), Math.max(...sel.map(end))] : null;
  const format = fmt.value;
  if (!hasFfmpeg) { exportByRecording(); return; }
  const out = await host.saveAs({ name: `${baseName(file.name === 'Untitled' ? 'My film' : file.name)}.${format}`, filters: [{ name: format.toUpperCase(), exts: [format] }] });
  if (!out) return;
  const b = busy('Getting the titles ready…');
  let job;
  try { job = await buildJob(p, { format, quality: quality.value, range }); } catch (err) { b.close(); errorToast(err); return; }
  b.close();
  const id = uid('exp');
  const bar = h('progress', { max: 1, value: 0, style: { width: '100%' } });
  const label = h('div.muted', 'Starting…');
  let close = null;
  const t0 = Date.now();
  const offP = host.media.onProgress((x) => {
    if (x.id !== id) return;
    bar.value = x.progress;
    const left = x.progress > 0.02 ? ((Date.now() - t0) / x.progress) * (1 - x.progress) / 1000 : 0;
    label.textContent = `${Math.round(x.progress * 100)}%${left ? ` · about ${fmtTime(left)} left` : ''}`;
    host.win.setProgress(x.progress);
  });
  const offD = host.media.onDone((d) => {
    if (d.id !== id) return;
    offP(); offD();
    host.win.setProgress(-1);
    if (close) close('done');
    if (d.ok) toast(`Exported ${out.name}`, { timeout: 6000, action: inElectron ? { label: 'Show', run: () => host.reveal(out) } : null });
    else toast(`The export failed: ${d.error}`, { type: 'error', timeout: 12000 });
  });
  try { await host.media.exportMovie(id, job, out.id); } catch (err) { offP(); offD(); errorToast(err); return; }
  const r = await modal({ title: `Exporting ${out.name}`, width: 400, body: h('div.col', bar, label), buttons: [{ label: 'Cancel', value: 'cancel' }], onOpen: (_d, c) => { close = c; }, closeOnBackdrop: false });
  if (r === 'cancel') { host.media.cancel(id); host.win.setProgress(-1); }
}

async function exportByRecording() {
  const bar = h('progress', { max: 1, value: 0, style: { width: '100%' } });
  let close = null;
  const done = recordPreview(engine, { fps: p.fps, onProgress: (k) => { bar.value = k; } });
  modal({ title: 'Recording the film…', width: 400, body: h('div.col', bar, h('div.muted', 'It plays through once; the sound is recorded too.')), buttons: [{ label: 'Stop', value: 'stop' }], onOpen: (_d, c) => { close = c; }, closeOnBackdrop: false })
    .then((r) => { if (r === 'stop' && recordPreview.cancel) recordPreview.cancel(); });
  try {
    const bytes = await done;
    if (close) close('done');
    await host.saveAs({ name: `${baseName(file.name === 'Untitled' ? 'My film' : file.name)}.webm`, filters: [{ name: 'WebM video', exts: ['webm'] }] }, bytes);
  } catch (err) { if (close) close('done'); errorToast(err); }
}

async function saveFrame() {
  try {
    const f = await host.saveAs({ name: `Frame ${fmtTime(engine.t).replace(/:/g, '-')}.png`, filters: [{ name: 'PNG picture', exts: ['png'] }] }, await canvasBytes(canvas, 'image/png'));
    if (f) toast(`Saved ${f.name}`, { timeout: 1500 });
  } catch (err) { errorToast(err); }
}

// ---------------------------------------------------------------------------
// Commands and menus
// ---------------------------------------------------------------------------
const C = (id, label, keys, run, extra = {}) => ({ id, label, keys, run, ...extra });
const hasSel = () => timeline.selected.size > 0;
const step = (s) => { engine.pause(); engine.seek(engine.t + s); };
commands.register(
  C('file.new', 'New Film', 'Ctrl+N', () => newFilm(), { icon: 'new', category: 'File' }),
  C('file.open', 'Open a Project…', 'Ctrl+O', async () => { const fs = await host.openFiles({ filters: [PROJECT_FILTER] }); if (fs[0]) openProjectFile(fs[0]); }, { icon: 'open', category: 'File' }),
  C('file.import', 'Add Media…', 'Ctrl+I', async () => { const fs = await host.openFiles({ filters: MEDIA_FILTERS, multiple: true, readOnly: true }); if (fs.length) importFiles(fs); }, { icon: 'plus', category: 'File' }),
  C('file.save', 'Save Project', 'Ctrl+S', () => saveProject(), { icon: 'save', category: 'File' }),
  C('file.saveAs', 'Save Project As…', 'Ctrl+Shift+S', () => saveProject(true), { icon: 'saveAs', category: 'File' }),
  C('file.export', 'Export the Film…', 'Ctrl+E', () => exportFilm(), { icon: 'export', category: 'File' }),
  C('file.relink', 'Relink Missing Media…', null, () => relink(), { icon: 'link', category: 'File', when: () => p.media.some((m) => m.missing) }),
  C('edit.undo', 'Undo', 'Ctrl+Z', () => history.undo(), { icon: 'undo', category: 'Edit', when: () => history.canUndo }),
  C('edit.redo', 'Redo', ['Ctrl+Shift+Z', 'Ctrl+Y'], () => history.redo(), { icon: 'redo', category: 'Edit', when: () => history.canRedo }),
  C('edit.copy', 'Copy Clips', 'Ctrl+C', () => copyClips(), { icon: 'copy', category: 'Edit', when: hasSel }),
  C('edit.cut', 'Cut Clips', 'Ctrl+X', () => { copyClips(); deleteSelected(); }, { icon: 'cut', category: 'Edit', when: hasSel }),
  C('edit.paste', 'Paste Clips at the Playhead', 'Ctrl+V', () => pasteClips(), { icon: 'paste', category: 'Edit', when: () => !!clipboard }),
  C('edit.selectAll', 'Select All Clips', 'Ctrl+A', () => timeline.select(p.tracks.flatMap((t) => t.clips.map((c) => c.id))), { category: 'Edit' }),
  C('clip.split', 'Split at the Playhead', ['S', 'Ctrl+K'], () => splitAtPlayhead(), { icon: 'scissors', category: 'Clip' }),
  C('clip.delete', 'Delete', ['Delete', 'Backspace'], () => deleteSelected(false), { icon: 'trash', category: 'Clip', when: hasSel }),
  C('clip.ripple', 'Delete and Close the Gap', ['Shift+Delete', 'Shift+Backspace'], () => deleteSelected(true), { category: 'Clip', when: hasSel }),
  C('clip.duplicate', 'Duplicate', 'Ctrl+D', () => duplicateSelected(), { icon: 'duplicate', category: 'Clip', when: hasSel }),
  C('clip.title', 'Add a Title', 'T', () => addTitle('big', engine.t), { icon: 'text', category: 'Clip' }),
  C('clip.voice', 'Record a Voice-over', 'R', () => toggleVoice(), { icon: 'mic', category: 'Clip', checked: () => !!rec }),
  C('play.toggle', 'Play / Pause', ['Space', 'K'], () => engine.toggle(), { icon: 'play', category: 'Playback' }),
  C('play.start', 'Back to the Start', 'Home', () => { engine.seek(0); timeline.follow(); }, { icon: 'skipBack', category: 'Playback' }),
  C('play.end', 'Go to the End', 'End', () => { engine.seek(projectDuration(p)); timeline.follow(); }, { category: 'Playback' }),
  C('play.frameBack', 'Previous Frame', 'Left', () => step(-1 / p.fps), { icon: 'frameBack', category: 'Playback' }),
  C('play.frameNext', 'Next Frame', 'Right', () => step(1 / p.fps), { icon: 'frameForward', category: 'Playback' }),
  C('play.back1', 'Back 1 Second', 'Shift+Left', () => step(-1), { category: 'Playback' }),
  C('play.fwd1', 'Forward 1 Second', 'Shift+Right', () => step(1), { category: 'Playback' }),
  C('play.prevEdit', 'Previous Cut', 'Up', () => jumpEdit(-1), { category: 'Playback' }),
  C('play.nextEdit', 'Next Cut', 'Down', () => jumpEdit(1), { category: 'Playback' }),
  C('view.fit', 'Fit the Timeline', 'Shift+Z', () => timeline.fit(), { icon: 'fit', category: 'View' }),
  C('view.zoomIn', 'Zoom In the Timeline', ['=', 'Ctrl+='], () => timeline.zoomAt(1.5), { icon: 'zoomIn', category: 'View' }),
  C('view.zoomOut', 'Zoom Out the Timeline', ['-', 'Ctrl+-'], () => timeline.zoomAt(1 / 1.5), { icon: 'zoomOut', category: 'View' }),
  C('view.snap', 'Snap to Edges', null, () => { settings.set('snap', !settings.get('snap', true)); refresh(); }, { icon: 'magnet', category: 'View', checked: () => settings.get('snap', true) }),
  C('view.wheel', 'The Wheel Zooms the Timeline (otherwise it scrolls)', null, () => { settings.set('tlWheelZooms', !settings.get('tlWheelZooms', true)); refresh(); }, { category: 'View', checked: () => settings.get('tlWheelZooms', true) }),
  C('view.frame', 'Save This Frame as a Picture…', null, () => saveFrame(), { icon: 'camera', category: 'View' }),
  C('view.fullPreview', 'Full-screen Preview', 'F', () => { if (document.fullscreenElement) document.exitFullscreen(); else stage.requestFullscreen().catch(() => {}); }, { icon: 'fullscreen', category: 'View' }),
);

function jumpEdit(dir) {
  const t = engine.t;
  const pts = [...new Set(p.tracks.flatMap((tr) => tr.clips.flatMap((c) => [c.start, end(c)])))].sort((a, b) => a - b);
  const next = dir > 0 ? pts.find((x) => x > t + 1e-3) : [...pts].reverse().find((x) => x < t - 1e-3);
  if (next !== undefined) { engine.pause(); engine.seek(next); timeline.follow(); }
}

function fileMenu() {
  return [I('file.new'), I('app.newWindow'), I('file.open'), { type: 'separator' }, I('file.import'), I('file.relink'), { type: 'separator' }, I('file.save'), I('file.saveAs'), { type: 'separator' }, I('file.export'), I('view.frame'), { type: 'separator' }, I('app.close')];
}
function editMenu() {
  return [I('edit.undo', { label: history.undoLabel ? `Undo ${history.undoLabel}` : 'Undo' }), I('edit.redo', { label: history.redoLabel ? `Redo ${history.redoLabel}` : 'Redo' }), { type: 'separator' },
    I('edit.cut'), I('edit.copy'), I('edit.paste'), I('clip.duplicate'), I('clip.delete'), I('clip.ripple'), { type: 'separator' }, I('edit.selectAll')];
}
function clipMenu(c) {
  if (!c) return [I('clip.split'), I('clip.title'), I('clip.voice'), I('file.import')];
  const tr = trackOf(p, c);
  const m = mediaOf(p, c);
  return [I('clip.split'), I('clip.duplicate'), I('edit.copy'), I('clip.delete'), I('clip.ripple'), { type: 'separator' },
    m && m.kind !== 'image' && tr.kind !== 'text' ? { label: 'Speed', icon: 'gauge', submenu: [0.25, 0.5, 0.75, 1, 1.5, 2, 4].map((s) => ({ label: `${s}×`, checked: c.speed === s, run: () => setSpeed(c, s) })) } : null,
    tr.kind === 'video' ? { label: 'Transition in', icon: 'transition', submenu: Object.entries(TRANSITIONS).map(([k, l]) => ({ label: l, checked: (c.transition ? c.transition.kind : 'none') === k, run: () => setTransition(selectedClips().length ? selectedClips() : [c], k) })) } : null,
    tr.kind === 'video' ? { label: 'Look', icon: 'palette', submenu: Object.entries(LOOKS).map(([k, l]) => ({ label: l.label, checked: (c.look || 'none') === k, run: () => edit('Look', () => { for (const x of selectedClips()) x.look = k; }) })) } : null,
    { label: 'Fade', submenu: [{ label: 'Fade in and out (1 s)', run: () => edit('Fade', () => { c.fadeIn = Math.min(1, c.dur / 2); c.fadeOut = Math.min(1, c.dur / 2); }) }, { label: 'No fades', run: () => edit('No fades', () => { c.fadeIn = 0; c.fadeOut = 0; }) }] },
    tr.kind !== 'text' && m && m.kind !== 'image' ? { label: c.muted ? 'Unmute' : 'Mute', icon: c.muted ? 'volume' : 'volumeX', run: () => edit(c.muted ? 'Unmute' : 'Mute', () => { c.muted = !c.muted; }) } : null,
    tr.kind === 'video' && m && m.kind === 'video' && m.hasAudio ? { label: 'Put the Sound on Its Own Track', icon: 'music', run: () => detachAudio(c) } : null,
    tr.kind === 'video' ? { label: 'Picture in Picture', run: () => edit('Picture in picture', () => { c.scale = 0.38; c.x = 0.76; c.y = 0.74; }) } : null];
}
function trackMenu(tr, t = engine.t) {
  if (!tr) return [I('file.import'), I('clip.title')];
  const i = p.tracks.indexOf(tr);
  return [tr.kind === 'text' ? { label: 'Add a title here', icon: 'text', run: () => addTitle('big', t, tr.id) } : { label: 'Add media…', icon: 'plus', run: () => commands.run('file.import') },
    { type: 'separator' }, { label: 'Rename track…', run: async () => { const n = await promptBox('Track name', { value: tr.name }); if (n) edit('Rename track', () => { tr.name = n.slice(0, 60); }); } },
    { label: 'Move up', disabled: i === 0, run: () => edit('Move track', () => { p.tracks.splice(i, 1); p.tracks.splice(i - 1, 0, tr); }) },
    { label: 'Move down', disabled: i === p.tracks.length - 1, run: () => edit('Move track', () => { p.tracks.splice(i, 1); p.tracks.splice(i + 1, 0, tr); }) },
    { label: 'Delete track', icon: 'trash', disabled: p.tracks.filter((x) => x.kind === tr.kind).length <= 1, run: () => edit('Delete track', () => { p.tracks.splice(i, 1); }) }];
}
function viewMenu() { return [I('view.zoomIn'), I('view.zoomOut'), I('view.fit'), I('view.snap'), I('view.wheel'), { type: 'separator' }, I('view.fullPreview'), I('view.themeDark'), I('view.themeLight'), I('view.fullscreen')]; }

function updateTitle() { shell.setTitle(file.name, isDirty()); }

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
guardClose({ dirty: () => isDirty(), save: () => saveProject(), name: () => file.name });
onDropFiles((files) => {
  const proj = files.find((f) => extOf(f.name) === 'snakemovie');
  if (proj) { openProjectFile(proj); return; }
  importFiles(files, { place: !p.tracks.some((t) => t.clips.length) });
}, 'Drop videos, music or pictures to add them');
host.onOpen((files) => importFiles(files));
// Recovery copy of unsaved work.
setInterval(() => { if (isDirty()) host.recovery.put(file.id, { name: file.name, project: serialise(p), time: Date.now() }).catch(() => {}); }, 20000);

renderLibrary();
timeline.render();
renderInspector();
updateTitle();
updateTimes();
sizeCanvas();
if (shell.info.files && shell.info.files.length) {
  const proj = shell.info.files.find((f) => extOf(f.name) === 'snakemovie');
  if (proj) openProjectFile(proj); else importFiles(shell.info.files, { place: true });
}

window.snakeApp = { get project() { return p; }, engine, timeline, commands, importFiles, addToTimeline, addTitle, buildJob: (o) => buildJob(p, o), edit, history };
