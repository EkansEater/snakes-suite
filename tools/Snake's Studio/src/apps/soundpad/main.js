// Snake's SoundPad for the browser and the iPhone: a grid of sounds, one tap each.
// The sounds live in this browser (IndexedDB), not on a server. Where the browser can
// choose an output device (Chrome, Edge), sounds can also go to a virtual cable (with
// your microphone mixed in), which voice chat then hears as a microphone; the desktop
// and Android SoundPads are the full versions.
import { h, uid, clamp, extOf, baseName } from '../../kit/dom.js';
import { icon } from '../../kit/icons.js';
import { host } from '../../kit/host.js';
import * as commands from '../../kit/commands.js';
import { createShell, tb, sep, onDropFiles, refresh } from '../../kit/shell.js';
import { contextMenu, popover, closeMenus } from '../../kit/menu.js';
import { toast, errorToast, promptBox, confirmBox } from '../../kit/dialogs.js';
import { hoverZoom } from '../../kit/zoom.js';

const AUDIO = ['mp3', 'wav', 'ogg', 'oga', 'opus', 'flac', 'm4a', 'aac', 'webm', 'mp4', 'aiff', 'aif', 'caf'];
const MIME = { mp3: 'audio/mpeg', wav: 'audio/wav', ogg: 'audio/ogg', oga: 'audio/ogg', opus: 'audio/ogg', flac: 'audio/flac',
  m4a: 'audio/mp4', aac: 'audio/aac', webm: 'audio/webm', mp4: 'audio/mp4', aiff: 'audio/aiff', aif: 'audio/aiff', caf: 'audio/x-caf' };
const COLORS = ['', '#3fb950', '#2f81f7', '#a371f7', '#db61a2', '#f85149', '#f0883e', '#d29922', '#8b949e'];

// ---------------------------------------------------------------------------
// The library: sounds and their bytes in IndexedDB
// ---------------------------------------------------------------------------
const dbp = new Promise((resolve, reject) => {
  const req = indexedDB.open('snake-soundpad', 1);
  req.onupgradeneeded = () => req.result.createObjectStore('sounds', { keyPath: 'id' });
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
async function tx(mode, fn) {
  const db = await dbp;
  return new Promise((resolve, reject) => {
    const t = db.transaction('sounds', mode);
    const r = fn(t.objectStore('sounds'));
    t.oncomplete = () => resolve(r && r.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Not saved: the browser is out of space.'));
  });
}
const putSound = (s) => tx('readwrite', (st) => st.put(s));
const deleteSound = (id) => tx('readwrite', (st) => st.delete(id));
const allSounds = () => tx('readonly', (st) => st.getAll());

/** id, name, volume (0-200 %), key, color, order, type, data (Blob), duration (s). */
let sounds = [];
const buffers = new Map();

// ---------------------------------------------------------------------------
// Sound out: the speakers, and optionally a second device (a virtual cable)
// ---------------------------------------------------------------------------
const settings = host.settings;
const canPickOutput = typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
const speakers = { ctx: new AudioContext(), gain: null };
speakers.gain = speakers.ctx.createGain();
speakers.gain.connect(speakers.ctx.destination);
let cable = null; // { ctx, gain, mic: { stream, node, gain } | null }
const playing = new Map(); // sound id -> [{ src, start }]

function applyVolumes() {
  speakers.gain.gain.value = settings.get('monitor', true) ? settings.get('volume', 80) / 100 : 0;
  if (cable) cable.gain.gain.value = settings.get('cableVolume', 100) / 100;
  if (cable && cable.mic) cable.mic.gain.gain.value = settings.get('micVolume', 100) / 100;
}

async function useCable(deviceId) {
  if (cable) { cable.mic && cable.mic.stream.getTracks().forEach((t) => t.stop()); await cable.ctx.close().catch(() => {}); cable = null; }
  settings.set('cable', deviceId || null);
  if (!deviceId || !canPickOutput) { refresh(); return; }
  try {
    const ctx = new AudioContext();
    await ctx.setSinkId(deviceId);
    const gain = ctx.createGain();
    gain.connect(ctx.destination);
    cable = { ctx, gain, mic: null };
    if (settings.get('micToCable', true)) await useMic(true);
    applyVolumes();
  } catch (err) {
    cable = null;
    settings.set('cable', null);
    errorToast(`That device could not be used: ${err.message || err}`);
  }
  refresh();
}

async function useMic(on) {
  settings.set('micToCable', on);
  if (!cable) return;
  if (cable.mic) { cable.mic.stream.getTracks().forEach((t) => t.stop()); cable.mic.node.disconnect(); cable.mic = null; }
  if (!on) return;
  try {
    const mic = settings.get('mic', '');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: mic ? { exact: mic } : undefined, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const node = cable.ctx.createMediaStreamSource(stream);
    const gain = cable.ctx.createGain();
    node.connect(gain).connect(cable.ctx.destination);
    cable.mic = { stream, node, gain };
    applyVolumes();
  } catch (err) {
    errorToast(`The microphone could not be opened: ${err.message || err}`);
  }
}

async function bufferOf(s) {
  if (buffers.has(s.id)) return buffers.get(s.id);
  const buf = await speakers.ctx.decodeAudioData(await s.data.arrayBuffer());
  buffers.set(s.id, buf);
  if (!s.duration) { s.duration = buf.duration; putSound(s).catch(() => {}); }
  return buf;
}

async function play(s) {
  try {
    await speakers.ctx.resume();
    if (cable) await cable.ctx.resume();
    const buf = await bufferOf(s);
    if (!settings.get('overlap', false)) stopAll();
    const runs = [];
    for (const out of [speakers, cable].filter(Boolean)) {
      const src = out.ctx.createBufferSource();
      src.buffer = buf;
      const g = out.ctx.createGain();
      g.gain.value = (s.volume ?? 100) / 100;
      src.connect(g).connect(out.gain);
      src.start();
      runs.push({ src, ctx: out.ctx, start: out.ctx.currentTime });
    }
    runs[0].src.addEventListener('ended', () => {
      const list = (playing.get(s.id) || []).filter((r) => r !== runs);
      if (list.length) playing.set(s.id, list); else playing.delete(s.id);
      paint();
    });
    playing.set(s.id, [...(playing.get(s.id) || []), runs]);
    paint();
    tick();
  } catch (err) {
    errorToast(`“${s.name}” could not be played: ${err.message || err}`);
  }
}

function stopAll() {
  for (const list of playing.values()) for (const runs of list) for (const r of runs) { try { r.src.stop(); } catch {} }
  playing.clear();
  paint();
}

let ticking = false;
function tick() {
  if (ticking) return;
  ticking = true;
  const step = () => {
    for (const s of sounds) {
      const bar = grid.querySelector(`[data-id="${s.id}"] .pad-progress > div`);
      if (!bar) continue;
      const list = playing.get(s.id);
      const runs = list && list[list.length - 1];
      bar.style.width = runs && s.duration ? `${clamp((runs[0].ctx.currentTime - runs[0].start) / s.duration, 0, 1) * 100}%` : '0';
    }
    if (playing.size) requestAnimationFrame(step); else ticking = false;
  };
  requestAnimationFrame(step);
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
const shell = await createShell({
  id: 'soundpad', name: "Snake's SoundPad",
  menus: [
    { label: '&Sounds', items: () => [I('pad.add'), { type: 'separator' }, I('pad.stop'), I('pad.random'), { type: 'separator' }, I('pad.find')] },
    { label: '&Options', items: () => [I('pad.overlap'), I('pad.monitor'), I('pad.output')] },
    { label: '&View', items: () => [I('pad.bigger'), I('pad.smaller'), { type: 'separator' }, I('view.themeDark'), I('view.themeLight'), I('view.themeSystem'), I('view.fullscreen')] },
    { label: '&Help', items: () => [I('app.palette'), I('app.shortcuts'), { type: 'separator' }, I('app.about')] },
  ],
  about: 'A soundboard: add sounds, then one tap (or one key) plays each. Your sounds stay in this browser. '
    + 'To play into voice chat, the desktop and Android SoundPads make a microphone of their own; here, pick a virtual cable under “Send to”.',
});
const I = (id, extra) => commands.item(id, extra);

// ---------------------------------------------------------------------------
// Commands and keys
// ---------------------------------------------------------------------------
const C = (id, label, keys, run, extra = {}) => ({ id, label, keys, run, ...extra });
commands.register(
  C('pad.add', 'Add Sounds…', 'Ctrl+O', async () => addFiles(await host.openFiles({ filters: [{ name: 'Sounds', exts: AUDIO }], multiple: true })), { icon: 'plus', category: 'Sounds' }),
  C('pad.stop', 'Stop All Sounds', 'Escape', () => stopAll(), { icon: 'stop', category: 'Sounds' }),
  C('pad.random', 'Play a Random Sound', 'Ctrl+R', () => { if (sounds.length) play(sounds[Math.floor(Math.random() * sounds.length)]); }, { icon: 'shuffle', category: 'Sounds' }),
  C('pad.find', 'Find a Sound', 'Ctrl+F', () => search.focus(), { icon: 'search', category: 'Sounds' }),
  C('pad.overlap', 'Let Sounds Overlap', null, () => { settings.set('overlap', !settings.get('overlap', false)); refresh(); }, { icon: 'duplicate', category: 'Options', checked: () => settings.get('overlap', false) }),
  C('pad.monitor', 'Hear the Sounds Myself', null, () => { settings.set('monitor', !settings.get('monitor', true)); applyVolumes(); refresh(); }, { icon: 'speaker', category: 'Options', checked: () => settings.get('monitor', true) }),
  C('pad.output', 'Send to…', null, () => {
    const btn = document.querySelector('.pad-bar [aria-label="Send to…"]');
    popover(outputPanel(), btn ? { anchor: btn } : { x: 200, y: 80 });
  }, { icon: 'mic', category: 'Options', tip: 'Send sounds to a virtual cable, for voice chat' }),
  C('pad.bigger', 'Bigger Pads', 'Ctrl+=', () => setPad(padSize() * 1.15), { icon: 'zoomIn', category: 'View' }),
  C('pad.smaller', 'Smaller Pads', 'Ctrl+-', () => setPad(padSize() / 1.15), { icon: 'zoomOut', category: 'View' }),
);

const search = h('input.input.pad-search', { type: 'search', placeholder: 'Find a sound', spellcheck: false });
const grid = h('div.pad-grid', { tabindex: -1 });
const empty = h('div.pad-empty',
  h('div', { html: icon('music', 48) }),
  h('h2', 'Your soundboard is empty'),
  h('p.muted', 'Add sound files (MP3, WAV, OGG, M4A…) or drop them here. Each becomes a pad: tap it to play.'),
  h('button.btn.primary', { onclick: () => commands.run('pad.add') }, 'Add sounds…'));
const volume = h('input', { type: 'range', min: 0, max: 100, value: settings.get('volume', 80), 'data-tip': 'Volume in your speakers' });
volume.addEventListener('input', () => { settings.set('volume', Number(volume.value)); applyVolumes(); });

shell.main.append(h('div.pad-root',
  h('div.toolbar.pad-bar',
    tb('pad.add', { showLabel: true }), sep(), tb('pad.stop'), tb('pad.random'), sep(), search,
    h('div.grow'), tb('pad.overlap'), tb('pad.output', { showLabel: true }),
    h('span.pad-vol', { html: icon('volume', 16) }), volume),
  grid, empty));
shell.showStatus(true);
const status = h('span.item');
shell.statusLeft.append(status);

// Pad size: Ctrl+wheel or two fingers over the grid.
const padSize = () => settings.get('pad', 132);
const setPad = (px) => { settings.set('pad', Math.round(clamp(px, 84, 280))); grid.style.setProperty('--pad', `${padSize()}px`); };
setPad(padSize());
hoverZoom(grid, { get: () => padSize() / 132, set: (z) => setPad(z * 132), min: 84 / 132, max: 280 / 132 });

function keyOf(s, i) {
  if (s.key) return s.key;
  return i < 10 ? String((i + 1) % 10) : '';
}

function paint() {
  const q = search.value.trim().toLowerCase();
  const list = sounds.filter((s) => !q || s.name.toLowerCase().includes(q));
  grid.replaceChildren(...list.map((s) => {
    const i = sounds.indexOf(s);
    const key = keyOf(s, i);
    const pad = h(`button.pad${playing.has(s.id) ? '.on' : ''}`, { dataset: { id: s.id }, 'data-tip': `${s.name}${key ? ` — key ${key.toUpperCase()}` : ''}` },
      h('span.pad-name', s.name),
      key ? h('span.pad-key', key.toUpperCase()) : null,
      s.volume !== 100 ? h('span.pad-volnote', `${s.volume}%`) : null,
      h('div.pad-progress', h('div')));
    if (s.color) pad.style.setProperty('--padc', s.color);
    pad.addEventListener('click', () => play(s));
    contextMenu(pad, () => padMenu(s));
    return pad;
  }));
  empty.classList.toggle('hidden', sounds.length > 0);
  grid.classList.toggle('hidden', sounds.length === 0);
  status.textContent = `${sounds.length} sound${sounds.length === 1 ? '' : 's'}${playing.size ? ` · ${playing.size} playing` : ''}`;
  if (playing.size) tick();
}

function padMenu(s) {
  const i = sounds.indexOf(s);
  return [
    { label: 'Play', icon: 'play', run: () => play(s) },
    { type: 'separator' },
    { label: 'Rename…', icon: 'pencil', keys: 'F2', run: () => rename(s) },
    { label: 'Volume', icon: 'volume', submenu: () => [50, 75, 100, 125, 150, 200].map((v) => ({ label: `${v}%`, checked: (s.volume ?? 100) === v, run: () => update(s, { volume: v }) })) },
    { label: 'Colour', icon: 'palette', submenu: () => COLORS.map((c) => ({ label: c ? c : 'None', swatch: c || undefined, checked: (s.color || '') === c, run: () => update(s, { color: c }) })) },
    { label: s.key ? `Key: ${s.key.toUpperCase()}…` : 'Set a key…', icon: 'grid', run: () => setKey(s) },
    { type: 'separator' },
    { label: 'Move earlier', icon: 'chevronLeft', disabled: i === 0, run: () => move(s, -1) },
    { label: 'Move later', icon: 'chevronRight', disabled: i === sounds.length - 1, run: () => move(s, 1) },
    { type: 'separator' },
    { label: 'Remove', icon: 'trash', danger: true, run: () => remove(s) },
  ];
}

async function update(s, patch) {
  Object.assign(s, patch);
  await putSound(s).catch((err) => errorToast(err.message));
  paint();
}

async function rename(s) {
  const name = await promptBox('Rename', { value: s.name, ok: 'Rename' });
  if (name && name.trim()) update(s, { name: name.trim() });
}

async function setKey(s) {
  const t = toast('Press the key for this sound (Esc: none)', { timeout: 8000 });
  const onKey = (e) => {
    e.preventDefault();
    e.stopPropagation();
    window.removeEventListener('keydown', onKey, true);
    if (t && t.remove) t.remove();
    const k = e.key === 'Escape' ? '' : e.key.length === 1 ? e.key.toLowerCase() : '';
    for (const o of sounds) if (o !== s && o.key && o.key === k) { o.key = ''; putSound(o); }
    update(s, { key: k });
  };
  window.addEventListener('keydown', onKey, true);
}

async function move(s, d) {
  const i = sounds.indexOf(s);
  const j = clamp(i + d, 0, sounds.length - 1);
  sounds.splice(i, 1);
  sounds.splice(j, 0, s);
  sounds.forEach((o, k) => { o.order = k; });
  await Promise.all(sounds.map(putSound));
  paint();
}

async function remove(s) {
  if (!(await confirmBox(`Remove “${s.name}” from the soundboard? (The file you added it from stays.)`, { ok: 'Remove', danger: true }))) return;
  sounds = sounds.filter((o) => o !== s);
  buffers.delete(s.id);
  await deleteSound(s.id);
  paint();
}

async function addFiles(files) {
  let added = 0;
  for (const f of files) {
    const ext = (f.ext || extOf(f.name)).toLowerCase();
    if (!AUDIO.includes(ext)) continue;
    try {
      const bytes = await host.read(f);
      const s = { id: uid('snd'), name: baseName(f.name).replace(/\.[^.]+$/, ''), volume: 100, key: '', color: '', order: sounds.length, type: MIME[ext] || 'audio/*', data: new Blob([bytes], { type: MIME[ext] || '' }), duration: 0 };
      await putSound(s);
      sounds.push(s);
      added++;
    } catch (err) {
      errorToast(`“${f.name}” could not be added: ${err.message || err}`);
    }
  }
  if (added) {
    toast(`Added ${added} sound${added === 1 ? '' : 's'}`, { timeout: 2000 });
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  } else if (files.length) toast('Those are not sound files.', { type: 'warn' });
  paint();
}

function outputPanel() {
  const box = h('div.col.pad-output', { style: { gap: '10px', width: '300px', padding: '6px' } });
  const fill = async () => {
    if (!canPickOutput) {
      box.replaceChildren(h('b', 'Send sounds to a virtual cable'),
        h('div.muted', 'This browser cannot choose where sound goes. Chrome or Edge on a computer can; or use the desktop or Android SoundPad, which make a microphone of their own.'));
      return;
    }
    let devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
    if (devices.length && devices.every((d) => !d.label)) {
      // Names only show once the page may use the microphone.
      const s = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
      if (s) { s.getTracks().forEach((t) => t.stop()); devices = await navigator.mediaDevices.enumerateDevices(); }
    }
    const outs = devices.filter((d) => d.kind === 'audiooutput' && d.deviceId !== 'default');
    const mics = devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default');
    const out = h('select.select', h('option', { value: '' }, 'Nowhere else (only my speakers)'),
      ...outs.map((d) => h('option', { value: d.deviceId, selected: d.deviceId === settings.get('cable') }, d.label || 'Output device')));
    out.addEventListener('change', () => useCable(out.value));
    const mic = h('select.select', h('option', { value: '' }, 'The usual microphone'),
      ...mics.map((d) => h('option', { value: d.deviceId, selected: d.deviceId === settings.get('mic', '') }, d.label || 'Microphone')));
    mic.addEventListener('change', () => { settings.set('mic', mic.value); useMic(settings.get('micToCable', true)); });
    const withMic = h('input', { type: 'checkbox', checked: settings.get('micToCable', true) });
    withMic.addEventListener('change', () => useMic(withMic.checked));
    box.replaceChildren(
      h('b', 'Send sounds to a virtual cable'),
      h('div.muted', 'Voice chat hears a virtual cable as a microphone. Install a free one (VB-CABLE on Windows, BlackHole on a Mac), pick it here, then pick its other end (“CABLE Output”, “BlackHole”) as the microphone in your chat app.'),
      out,
      h('label.check', withMic, 'Mix my microphone in, so they hear me too'),
      mic);
  };
  fill();
  return box;
}

applyVolumes();

window.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  const t = e.target;
  if (t instanceof Element && t.closest('input, textarea, select, [contenteditable="true"], .menu, .dialog')) return;
  const k = e.key.toLowerCase();
  const i = sounds.findIndex((s, n) => keyOf(s, n) === k);
  if (i >= 0) { e.preventDefault(); play(sounds[i]); }
});
search.addEventListener('input', paint);
search.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { const first = grid.querySelector('.pad'); if (first) first.click(); }
  if (e.key === 'Escape') { search.value = ''; paint(); search.blur(); }
});
onDropFiles((files) => addFiles(files), 'Drop to add sounds');
host.onOpen((files) => addFiles(files));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
try {
  sounds = (await allSounds()).sort((a, b) => a.order - b.order);
} catch (err) {
  errorToast(`The soundboard could not be read: ${err.message || err}`);
}
paint();
const startFiles = (shell.info && shell.info.files) || [];
if (startFiles.length) addFiles(startFiles);
if (settings.get('cable')) useCable(settings.get('cable'));
window.snakeApp = { sounds: () => sounds, play: (i) => play(sounds[i]), stopAll, playing, commands, addFiles };
closeMenus();
