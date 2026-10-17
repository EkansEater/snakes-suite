// Snake's DAW for the browser and the iPhone: record and practise. The sound is the desktop
// DAW's own engine (daw.wasm: its mixer, amp and effects, loop station, tuner and metronome)
// running in the browser's audio thread (worklet.js). Projects are the desktop's own format
// (project.json plus WAV files), kept in this browser and exchanged as a ZIP.
import { h, clamp, baseName } from '../../kit/dom.js';
import { icon } from '../../kit/icons.js';
import { host } from '../../kit/host.js';
import * as commands from '../../kit/commands.js';
import { createShell, tb, sep, select, splitter, onDropFiles, refresh } from '../../kit/shell.js';
import { showMenu, contextMenu, closeMenus } from '../../kit/menu.js';
import { modal, toast, errorToast, promptBox, confirmBox } from '../../kit/dialogs.js';
import { pinch } from '../../kit/zoom.js';
import { readZip, writeZip } from '../../kit/zip.js';
import wasmPath from './daw.wasm';

const SR = 48000;
// The track headers' width (narrower on a phone).
let HEAD = 230;
const sizeHead = () => {
  HEAD = window.matchMedia('(max-width: 720px)').matches ? 150 : 230;
  document.documentElement.style.setProperty('--dw-head', `${HEAD}px`);
};
sizeHead();
const COLORS = ['#3fb950', '#2f81f7', '#d29922', '#db61a2', '#a371f7', '#f0883e', '#56d4dd', '#f85149'];
const LOOP_STATE = ['Empty', 'Recording', 'Playing', 'Overdubbing', 'Muted', 'Get ready…'];
const settings = host.settings;

// ---------------------------------------------------------------------------
// Storage: projects and their audio in this browser
// ---------------------------------------------------------------------------
const dbp = new Promise((resolve, reject) => {
  const r = indexedDB.open('snake-daw', 1);
  r.onupgradeneeded = () => { r.result.createObjectStore('projects', { keyPath: 'id' }); r.result.createObjectStore('files'); };
  r.onsuccess = () => resolve(r.result);
  r.onerror = () => reject(r.error);
});
async function tx(store, mode, fn) {
  const db = await dbp;
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const req = fn(t.objectStore(store));
    t.oncomplete = () => resolve(req && req.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('The browser is out of space for this project.'));
  });
}

// ---------------------------------------------------------------------------
// WAV (32-bit float, like the desktop's recordings)
// ---------------------------------------------------------------------------
function wav(channels, sr = SR, bits = 32) {
  const ch = channels.length;
  const n = channels[0].length;
  const bytes = bits / 8;
  const out = new DataView(new ArrayBuffer(44 + n * ch * bytes));
  const s = (o, t) => { for (let i = 0; i < t.length; i++) out.setUint8(o + i, t.charCodeAt(i)); };
  s(0, 'RIFF'); out.setUint32(4, 36 + n * ch * bytes, true); s(8, 'WAVE'); s(12, 'fmt ');
  out.setUint32(16, 16, true); out.setUint16(20, bits === 32 ? 3 : 1, true); out.setUint16(22, ch, true);
  out.setUint32(24, sr, true); out.setUint32(28, sr * ch * bytes, true); out.setUint16(32, ch * bytes, true); out.setUint16(34, bits, true);
  s(36, 'data'); out.setUint32(40, n * ch * bytes, true);
  let o = 44;
  for (let i = 0; i < n; i++) for (let c = 0; c < ch; c++) {
    const v = channels[c][i];
    if (bits === 32) out.setFloat32(o, v, true);
    else out.setInt16(o, clamp(Math.round(v * 32767), -32768, 32767), true);
    o += bytes;
  }
  return new Uint8Array(out.buffer);
}

async function decode(bytes) {
  const ctx = new OfflineAudioContext(1, 1, SR);
  const buf = await ctx.decodeAudioData(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  return [...Array(Math.min(2, buf.numberOfChannels))].map((_, c) => buf.getChannelData(c).slice());
}

// ---------------------------------------------------------------------------
// The engine, in the audio thread
// ---------------------------------------------------------------------------
let ctx = null;
let node = null;
let module = null;
let kinds = [];
let mic = null;
const waiting = new Map();
let seq = 0;
let status = { pos: 0, playing: false, recording: false, master: [0, 0], tracks: {}, loops: [0, 0, 0, 0], loop_len: 0, loop_pos: 0, tuner: null };
const send = (msg) => node && node.port.postMessage({ type: 'op', msg });
const ask = (msg) => startAudio().then(() => new Promise((resolve) => { const id = ++seq; waiting.set(id, resolve); node.port.postMessage({ type: 'op', msg, id }); }));

// The engine is fetched and compiled at once: its list of effects is needed before any sound starts.
let engineBytes = null;
const engineReady = (async () => {
  engineBytes = await (await fetch(new URL(wasmPath, import.meta.url))).arrayBuffer();
  module = await WebAssembly.compile(engineBytes);
  const e = localEngine();
  kinds = e.op({ op: 'fx_kinds' });
  e.free();
})();

/** An engine on this page (not in the audio thread): for the effects list and exporting. */
function localEngine() {
  const x = new WebAssembly.Instance(module, {}).exports;
  const d = x.daw_new(SR);
  const te = new TextEncoder();
  const td = new TextDecoder();
  return {
    x, d,
    op(o) {
      const b = te.encode(JSON.stringify(o));
      const p = x.buf_alloc(b.length);
      new Uint8Array(x.memory.buffer, p, b.length).set(b);
      const n = x.daw_op(d, p, b.length);
      x.buf_free(p, b.length);
      return n ? JSON.parse(td.decode(new Uint8Array(x.memory.buffer, x.daw_reply(d), n))) : null;
    },
    free() { x.daw_free(d); },
  };
}

let audioPromise = null;
/** Sound starts with the first click or key (browsers require one). Safe to call any number of times. */
function startAudio() {
  if (!audioPromise) audioPromise = openAudio().catch((err) => { audioPromise = null; if (ctx) ctx.close().catch(() => {}); ctx = null; node = null; throw err; });
  return audioPromise.then(() => (ctx.state !== 'running' ? ctx.resume().catch(() => {}) : null));
}
async function openAudio() {
  await engineReady;
  ctx = new AudioContext({ sampleRate: SR, latencyHint: 'interactive' });
  await ctx.audioWorklet.addModule('worklet.js');
  node = new AudioWorkletNode(ctx, 'snake-daw', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [2], channelCount: 2, channelCountMode: 'explicit' });
  node.connect(ctx.destination);
  await new Promise((resolve) => {
    node.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === 'ready') resolve();
      else if (m.type === 'status') { status = m.s; onStatus(); } else if (m.type === 'reply') { const r = waiting.get(m.id); waiting.delete(m.id); if (r) r(m.r); }
    };
    node.port.postMessage({ type: 'init', bytes: engineBytes });
  });
  for (const a of audio.values()) upload(a);
  rebuild();
  if (status.pos) send({ op: 'seek', pos: Math.round(status.pos) });
}

/** The microphone (or audio interface), when a track or the tuner wants it. */
async function useInput() {
  if (mic || !ctx) return !!mic;
  try {
    const id = settings.get('inputDevice', '');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: id ? { exact: id } : undefined, channelCount: 2, echoCancellation: false, noiseSuppression: false, autoGainControl: false } });
    const src = ctx.createMediaStreamSource(stream);
    src.connect(node);
    mic = { stream, src };
    return true;
  } catch (err) {
    errorToast(`The microphone could not be opened: ${err.message || err}`);
    return false;
  }
}
const inputLatency = () => (mic && mic.stream.getAudioTracks()[0].getSettings().latency) || 0;

// ---------------------------------------------------------------------------
// The project (the desktop's project.json)
// ---------------------------------------------------------------------------
let project = null;
let projectId = null;
/** file -> { id, channels: [Float32Array], frames, peaks: Float32Array (min,max per 256 frames) } */
const audio = new Map();
let audioSeq = 1;
let sel = { track: null, clip: null };
const undoStack = [];
const redoStack = [];

const newProject = (name = 'Untitled') => ({ name, bpm: 120, beats_per_bar: 4, master_db: 0, metronome: false, count_in: false, loop_on: false, loop_start: 0, loop_end: 0, next_id: 1, tracks: [], loop_sources: [[], [], [], []] });
const nextId = () => ++project.next_id;
const trackOf = (id) => project.tracks.find((t) => t.id === id);
const inputNum = (t) => (t.input && typeof t.input === 'object' && 'Hw' in t.input ? t.input.Hw : null);
const beatFrames = () => (SR * 60) / project.bpm;
const barFrames = () => beatFrames() * project.beats_per_bar;
const projectEnd = () => Math.max(0, ...project.tracks.flatMap((t) => t.clips.map((c) => c.start + c.len)));

function peaksOf(channels) {
  const n = channels[0].length;
  const out = new Float32Array(Math.ceil(n / 256) * 2);
  for (let k = 0, i = 0; i < n; i += 256, k += 2) {
    let lo = 0;
    let hi = 0;
    for (const c of channels) for (let j = i; j < Math.min(n, i + 256); j++) { const v = c[j]; if (v < lo) lo = v; if (v > hi) hi = v; }
    out[k] = lo;
    out[k + 1] = hi;
  }
  return out;
}

function upload(a) {
  if (node) node.port.postMessage({ type: 'audio', id: a.id, channels: a.channels });
}

async function addAudio(file, channels, store = true) {
  const a = { id: audioSeq++, channels, frames: channels[0].length, peaks: peaksOf(channels) };
  audio.set(file, a);
  upload(a);
  if (store) await tx('files', 'readwrite', (s) => s.put(new Blob([wav(channels)], { type: 'audio/wav' }), `${projectId}/${file}`));
  return a;
}

const clipsRt = (t) => t.clips.filter((c) => audio.has(c.file)).map((c) => ({ start: c.start, offset: c.offset, len: c.len, audio: audio.get(c.file).id }));
const trackCtl = (t) => ({ volume_db: t.volume_db, pan: t.pan, mute: t.mute, solo: t.solo, arm: t.arm, monitor: t.monitor, fx_on: t.fx_on, input: inputNum(t), loop_mask: loopMask(t.id) });
const loopMask = (id) => project.loop_sources.reduce((m, list, i) => (list.includes(id) ? m | (1 << i) : m), 0);
let engineTracks = [];

/** Send the whole project to the engine again (after opening, undo, track changes). */
function rebuild() {
  if (!node || !project) return;
  for (const id of engineTracks) send({ op: 'track_remove', id });
  for (const t of project.tracks) send({ op: 'track_add', id: t.id, ...trackCtl(t), clips: clipsRt(t), fx: t.fx });
  engineTracks = project.tracks.map((t) => t.id);
  syncTransport();
}
const syncTrack = (t) => send({ op: 'track', id: t.id, ...trackCtl(t) });
const syncClips = (t) => send({ op: 'clips', track: t.id, clips: clipsRt(t) });
function syncTransport() {
  send({ op: 'transport', bpm: project.bpm, beats_per_bar: project.beats_per_bar, master_db: project.master_db, metronome: project.metronome,
    loop_on: project.loop_on, loop_start: project.loop_start, loop_end: project.loop_end, loop_count_in: settings.get('loopCountIn', true), loop_click: settings.get('loopClick', false) });
}

let saveTimer = 0;
function changed({ save = true } = {}) {
  paintTracks();
  draw();
  refresh();
  updateTitle();
  if (save) { clearTimeout(saveTimer); saveTimer = setTimeout(saveProject, 600); }
}
async function saveProject() {
  if (!project) return;
  await tx('projects', 'readwrite', (s) => s.put({ id: projectId, name: project.name, updated: Date.now(), json: JSON.stringify(project) })).catch((e) => errorToast(e.message));
}
function updateTitle() {
  if (project) shell.setTitle(project.name);
  panel.classList.toggle('hidden', !project);
  panelSplit.classList.toggle('hidden', !project);
}

function snapshot() { undoStack.push(JSON.stringify(project.tracks)); if (undoStack.length > 100) undoStack.shift(); redoStack.length = 0; }
function undo(from, to) {
  if (!from.length) return;
  to.push(JSON.stringify(project.tracks));
  project.tracks = JSON.parse(from.pop());
  sel.clip = null;
  rebuild();
  changed();
}

async function openProject(id) {
  const rec = await tx('projects', 'readonly', (s) => s.get(id));
  if (!rec) return;
  stop();
  projectId = id;
  project = { ...newProject(), ...JSON.parse(rec.json) };
  audio.clear();
  undoStack.length = 0;
  redoStack.length = 0;
  const files = [...new Set(project.tracks.flatMap((t) => t.clips.map((c) => c.file)))];
  for (const f of files) {
    const blob = await tx('files', 'readonly', (s) => s.get(`${id}/${f}`));
    if (blob) { try { await addAudio(f, await decode(new Uint8Array(await blob.arrayBuffer())), false); } catch { /* left out */ } }
  }
  sel = { track: project.tracks[0] ? project.tracks[0].id : null, clip: null };
  settings.set('lastProject', id);
  rebuild();
  changed({ save: false });
  paintFx();
  paintLoops();
  scroller.scrollLeft = 0;
}

async function createProject(name = 'Untitled') {
  const id = `p${Date.now().toString(36)}`;
  await tx('projects', 'readwrite', (s) => s.put({ id, name, updated: Date.now(), json: JSON.stringify(newProject(name)) }));
  await openProject(id);
  addTrack('guitar');
}

// ---------------------------------------------------------------------------
// Tracks, clips, effects
// ---------------------------------------------------------------------------
const PRESETS = {
  guitar: ['Guitar', [['gate', false], ['drive', true], ['amp', false], ['cab', false], ['delay', true], ['reverb', false]]],
  mic: ['Mic', [['gate', true], ['comp', false], ['eq', false], ['reverb', false]]],
  empty: ['Audio', []],
};
function addTrack(preset = 'empty') {
  snapshot();
  const [name, chain] = PRESETS[preset];
  const live = preset !== 'empty';
  if (live) project.tracks.forEach((t) => { t.arm = false; });
  const used = new Set(project.tracks.map(inputNum));
  const t = {
    id: nextId(), name, input: { Hw: used.has(0) && !used.has(1) ? 1 : 0 }, volume_db: 0, pan: 0, mute: false, solo: false, arm: live,
    // A guitar is heard through its amp at once. A microphone starts unheard: next to a laptop's
    // speakers it would howl (headphones on, then switch on 🎧).
    monitor: preset === 'guitar', fx_on: true, color: project.tracks.length, height: 94, clips: [],
    fx: chain.map(([kind, bypass]) => ({ id: nextId(), kind, bypass, params: (kinds.find((k) => k.kind === kind) || { params: [] }).params.map((p) => p.default) })),
  };
  project.tracks.push(t);
  sel = { track: t.id, clip: null };
  if (node) { send({ op: 'track_add', id: t.id, ...trackCtl(t), clips: [], fx: t.fx }); engineTracks.push(t.id); }
  changed();
  paintFx();
}
async function removeTrack(t) {
  if (status.recording) return;
  if (t.clips.length && !(await confirmBox(`Remove the track “${t.name}” and its ${t.clips.length} clip${t.clips.length === 1 ? '' : 's'}?`, { ok: 'Remove', danger: true }))) return;
  snapshot();
  project.tracks = project.tracks.filter((x) => x !== t);
  project.loop_sources = project.loop_sources.map((l) => l.filter((id) => id !== t.id));
  send({ op: 'track_remove', id: t.id });
  engineTracks = engineTracks.filter((id) => id !== t.id);
  if (sel.track === t.id) sel = { track: project.tracks[0] ? project.tracks[0].id : null, clip: null };
  changed();
  paintFx();
}

const selectedClip = () => { const t = trackOf(sel.track); return t && t.clips.find((c) => c.id === sel.clip) ? [t, t.clips.find((c) => c.id === sel.clip)] : [null, null]; };
function split() {
  const [t, c] = selectedClip();
  const at = status.pos;
  if (!c || at <= c.start || at >= c.start + c.len) { toast('Put the playhead inside the selected clip to split it.', { timeout: 2500 }); return; }
  snapshot();
  const cut = at - c.start;
  const right = { id: nextId(), file: c.file, start: at, offset: c.offset + cut, len: c.len - cut };
  c.len = cut;
  t.clips.push(right);
  sel.clip = right.id;
  syncClips(t);
  changed();
}
function deleteClip() {
  const [t, c] = selectedClip();
  if (!c) return;
  snapshot();
  t.clips = t.clips.filter((x) => x !== c);
  sel.clip = null;
  syncClips(t);
  changed();
}
function duplicateClip() {
  const [t, c] = selectedClip();
  if (!c) return;
  snapshot();
  const d = { ...c, id: nextId(), start: c.start + c.len };
  t.clips.push(d);
  sel.clip = d.id;
  syncClips(t);
  changed();
}

function addFx(t, kind) {
  const info = kinds.find((k) => k.kind === kind);
  const f = { id: nextId(), kind, bypass: false, params: info.params.map((p) => p.default) };
  t.fx.push(f);
  send({ op: 'fx_add', track: t.id, index: t.fx.length - 1, ...f });
  changed();
  paintFx();
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------
function play() {
  if (status.recording) { stopRecording(); return; }
  startAudio().then(() => { send({ op: status.playing ? 'stop' : 'play' }); });
}
function stop() {
  if (status.recording) { stopRecording(); return; }
  send({ op: 'stop' });
}
function seek(pos) { if (!status.recording) { send({ op: 'seek', pos: Math.max(0, Math.round(pos)) }); status.pos = Math.max(0, pos); draw(); } }

let recAt = 0;
let recTracks = [];
async function record() {
  await startAudio();
  if (status.recording) { stopRecording(); return; }
  const armed = project.tracks.filter((t) => t.arm && inputNum(t) !== null);
  if (!armed.length) { toast('Nothing to record: arm a track with its red ● button.', { timeout: 3500 }); return; }
  if (!(await useInput())) return;
  const at = Math.max(0, status.pos);
  const count = project.count_in ? Math.round(barFrames()) : 0;
  recAt = at;
  recTracks = armed.map((t) => t.id);
  send({ op: 'record', from: at - count, at, tracks: recTracks.map((id) => ({ id, stereo: false })) });
}

async function stopRecording() {
  send({ op: 'stop' });
  const id = ++seq;
  const takes = await new Promise((resolve) => { waiting.set(id, resolve); node.port.postMessage({ type: 'take', tracks: recTracks, id }); });
  // Line the take up with what was heard: earlier by the round trip through the audio system.
  const shift = Math.round(((ctx.baseLatency || 0) + (ctx.outputLatency || 0) + inputLatency()) * SR) + Math.round((settings.get('recOffsetMs', 0) / 1000) * SR);
  let made = 0;
  snapshot();
  for (const [tid, samples] of Object.entries(takes)) {
    const t = trackOf(Number(tid));
    if (!t || !samples.length) continue;
    const start = recAt - shift;
    const offset = Math.max(0, -start);
    const len = samples.length - offset;
    if (len <= 0) continue;
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14).replace(/(\d{8})(\d{6})/, '$1-$2');
    const file = `audio/${t.name.replace(/[^\p{L}\p{N} _.-]/gu, '_')}-${stamp}-${t.id}.wav`;
    await addAudio(file, [samples]);
    const c = { id: nextId(), file, start: Math.max(0, start), offset, len };
    t.clips.push(c);
    sel = { track: t.id, clip: c.id };
    syncClips(t);
    made++;
  }
  recTracks = [];
  if (made) toast(`Recorded ${made} clip${made === 1 ? '' : 's'}.`, { timeout: 2000 });
  changed();
}

// ---------------------------------------------------------------------------
// Export: the desktop's own offline render, here on the page
// ---------------------------------------------------------------------------
async function exportMix() {
  if (!project || !projectEnd()) { toast('Nothing to export yet: record something first.', { timeout: 3000 }); return; }
  await engineReady;
  const eng = localEngine();
  const { x, d } = eng;
  const op = (o) => eng.op(o);
  for (const a of audio.values()) {
    a.channels.forEach((c, i) => {
      const p = x.daw_audio_buf(d, BigInt(a.id), i, c.length); // may grow the memory: take its buffer after
      new Float32Array(x.memory.buffer, p, c.length).set(c);
    });
    x.daw_audio_done(d, BigInt(a.id));
  }
  for (const t of project.tracks) op({ op: 'track_add', id: t.id, ...trackCtl(t), arm: false, monitor: false, loop_mask: 0, clips: clipsRt(t), fx: t.fx });
  op({ op: 'transport', bpm: project.bpm, master_db: project.master_db, metronome: false, loop_on: false });
  op({ op: 'play' });
  const total = projectEnd() + 3 * SR; // room for reverb and delay tails
  const L = new Float32Array(total);
  const R = new Float32Array(total);
  const bar = toast('Exporting… 0%', { timeout: 0 });
  for (let done = 0, k = 0; done < total; done += 1024, k++) {
    const n = Math.min(1024, total - done);
    x.daw_process(d, n);
    L.set(new Float32Array(x.memory.buffer, x.daw_buf(d, 2), n), done);
    R.set(new Float32Array(x.memory.buffer, x.daw_buf(d, 3), n), done);
    if (k % 200 === 0) { if (bar && bar.firstChild) bar.firstChild.textContent = `Exporting… ${Math.round((done / total) * 100)}%`; await new Promise((r) => setTimeout(r, 0)); }
  }
  eng.free();
  if (bar && bar.remove) bar.remove();
  const f = await host.saveAs({ name: `${project.name}.wav`, filters: [{ name: 'WAV', exts: ['wav'] }] }, wav([L, R], SR, 16));
  if (f) toast(`Exported ${f.name}`, { timeout: 2500 });
}

/** The project as the desktop has it: project.json and audio/, in a ZIP. */
async function exportZip() {
  const files = [{ name: 'project.json', data: JSON.stringify(project, null, 2) }];
  for (const file of new Set(project.tracks.flatMap((t) => t.clips.map((c) => c.file)))) {
    const blob = await tx('files', 'readonly', (s) => s.get(`${projectId}/${file}`));
    if (blob) files.push({ name: file, data: new Uint8Array(await blob.arrayBuffer()) });
  }
  const f = await host.saveAs({ name: `${project.name}.zip`, filters: [{ name: 'ZIP', exts: ['zip'] }] }, await writeZip(files));
  if (f) toast(`Saved ${f.name}: unzip it into the desktop DAW's projects folder to open it there.`, { timeout: 5000 });
}

async function importZip(bytes, name) {
  const zip = readZip(bytes);
  const json = [...zip.keys()].find((k) => k.endsWith('project.json'));
  if (!json) throw new Error('This ZIP has no project.json: it is not a Snake’s DAW project.');
  const base = json.slice(0, -'project.json'.length);
  const p = { ...newProject(), ...JSON.parse(await zip.get(json).text()) };
  const id = `p${Date.now().toString(36)}`;
  for (const f of new Set(p.tracks.flatMap((t) => t.clips.map((c) => c.file)))) {
    const e = zip.get(base + f);
    if (e) { const data = await e.read(); await tx('files', 'readwrite', (s) => s.put(new Blob([data], { type: 'audio/wav' }), `${id}/${f}`)); }
  }
  if (!p.name || p.name === 'Untitled') p.name = name.replace(/\.zip$/i, '');
  await tx('projects', 'readwrite', (s) => s.put({ id, name: p.name, updated: Date.now(), json: JSON.stringify(p) }));
  await openProject(id);
}

async function importAudioFiles(files) {
  if (!project) await createProject();
  let t = trackOf(sel.track);
  if (!t) { addTrack('empty'); t = trackOf(sel.track); }
  snapshot();
  let at = status.pos;
  for (const f of files) {
    try {
      const channels = await decode(await host.read(f));
      const file = `audio/${baseName(f.name).replace(/\.[^.]+$/, '').replace(/[^\p{L}\p{N} _.-]/gu, '_')}-${Date.now().toString(36)}.wav`;
      await addAudio(file, channels);
      t.clips.push({ id: nextId(), file, start: Math.round(at), offset: 0, len: channels[0].length });
      at += channels[0].length;
    } catch {
      errorToast(`“${f.name}” could not be read as sound.`);
    }
  }
  syncClips(t);
  changed();
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
const shell = await createShell({
  id: 'daw', name: "Snake's DAW",
  quick: ['daw.play', 'daw.record'],
  menus: [
    { label: '&File', items: () => [I('daw.newProject'), I('daw.openProject'), I('daw.rename'), { type: 'separator' }, I('daw.importAudio'), I('daw.importZip'), { type: 'separator' }, I('daw.export'), I('daw.exportZip')] },
    { label: '&Edit', items: () => [I('daw.undo'), I('daw.redo'), { type: 'separator' }, I('daw.split'), I('daw.delete'), I('daw.duplicate')] },
    { label: '&Track', items: () => [I('daw.addGuitar'), I('daw.addMic'), I('daw.addEmpty'), { type: 'separator' }, I('daw.removeTrack')] },
    { label: '&Transport', items: () => [I('daw.play'), I('daw.record'), I('daw.home'), { type: 'separator' }, I('daw.metronome'), I('daw.countIn'), I('daw.loop'), I('daw.snap')] },
    { label: '&View', items: () => [I('daw.tuner'), I('daw.zoomIn'), I('daw.zoomOut'), I('daw.fit'), { type: 'separator' }, I('daw.input'), { type: 'separator' }, I('view.themeDark'), I('view.themeLight'), I('view.fullscreen')] },
    { label: '&Help', items: () => [I('app.palette'), I('app.shortcuts'), { type: 'separator' }, I('app.about')] },
  ],
  about: 'Record and practise: an amp with effects, a loop station, a tuner and multitrack recording. The sound is the desktop DAW’s own engine. '
    + 'Projects stay in this browser; File → Download project gives the desktop’s own project folder as a ZIP. Use headphones while monitoring.',
});
const I = (id, extra) => commands.item(id, extra);

const C = (id, label, keys, run, extra = {}) => ({ id, label, keys, run, ...extra });
const has = () => !!project;
commands.register(
  C('daw.newProject', 'New Project…', 'Ctrl+N', async () => { const n = await promptBox('New project', { value: 'Untitled', ok: 'Create' }); if (n) createProject(n.trim() || 'Untitled'); }, { icon: 'new', category: 'File' }),
  C('daw.openProject', 'Open Project…', 'Ctrl+O', () => projectsDialog(), { icon: 'open', category: 'File' }),
  C('daw.rename', 'Rename Project…', null, async () => { const n = await promptBox('Project name', { value: project.name, ok: 'Rename' }); if (n && n.trim()) { project.name = n.trim(); changed(); } }, { icon: 'pencil', category: 'File', when: has }),
  C('daw.importAudio', 'Import Audio…', 'Ctrl+I', async () => importAudioFiles(await host.openFiles({ multiple: true, filters: [{ name: 'Sound', exts: ['wav', 'mp3', 'flac', 'ogg', 'opus', 'm4a', 'aac', 'aiff', 'webm'] }] })), { icon: 'import', category: 'File' }),
  C('daw.importZip', 'Open a Project ZIP…', null, async () => { const [f] = await host.openFiles({ filters: [{ name: 'Snake’s DAW project', exts: ['zip'] }] }); if (f) importZip(await host.read(f), f.name).catch((e) => errorToast(e.message)); }, { icon: 'folder', category: 'File' }),
  C('daw.export', 'Export Mixdown (WAV)…', 'Ctrl+E', () => exportMix().catch((e) => errorToast(e.message)), { icon: 'export', category: 'File', when: has }),
  C('daw.exportZip', 'Download Project (ZIP)…', null, () => exportZip().catch((e) => errorToast(e.message)), { icon: 'download', category: 'File', when: has }),
  C('daw.undo', 'Undo', 'Ctrl+Z', () => undo(undoStack, redoStack), { icon: 'undo', category: 'Edit', when: () => undoStack.length > 0 && !status.recording }),
  C('daw.redo', 'Redo', ['Ctrl+Y', 'Ctrl+Shift+Z'], () => undo(redoStack, undoStack), { icon: 'redo', category: 'Edit', when: () => redoStack.length > 0 && !status.recording }),
  C('daw.split', 'Split at the Playhead', 'S', () => split(), { icon: 'scissors', category: 'Edit', when: () => !!sel.clip }),
  C('daw.delete', 'Delete the Clip', 'Delete', () => deleteClip(), { icon: 'trash', category: 'Edit', when: () => !!sel.clip }),
  C('daw.duplicate', 'Duplicate the Clip', 'Ctrl+D', () => duplicateClip(), { icon: 'duplicate', category: 'Edit', when: () => !!sel.clip }),
  C('daw.addGuitar', 'Add a Guitar Track (Amp)', null, () => addTrack('guitar'), { icon: 'plus', category: 'Track', when: has }),
  C('daw.addMic', 'Add a Microphone Track', null, () => addTrack('mic'), { icon: 'mic', category: 'Track', when: has }),
  C('daw.addEmpty', 'Add an Empty Track', null, () => addTrack('empty'), { icon: 'plus', category: 'Track', when: has }),
  C('daw.removeTrack', 'Remove the Track', null, () => { const t = trackOf(sel.track); if (t) removeTrack(t); }, { icon: 'trash', category: 'Track', when: () => !!trackOf(sel.track) }),
  C('daw.play', 'Play / Pause', 'Space', () => play(), { icon: 'play', category: 'Transport', when: has, checked: () => status.playing && !status.recording }),
  C('daw.record', 'Record', 'R', () => record(), { icon: 'record', category: 'Transport', when: has, checked: () => status.recording }),
  C('daw.home', 'Back to the Start', 'Home', () => seek(0), { icon: 'skipBack', category: 'Transport', when: has }),
  C('daw.metronome', 'Metronome', 'M', () => { project.metronome = !project.metronome; syncTransport(); changed(); }, { icon: 'clock', category: 'Transport', when: has, checked: () => !!(project && project.metronome) }),
  C('daw.countIn', 'Count In One Bar', null, () => { project.count_in = !project.count_in; changed(); }, { category: 'Transport', when: has, checked: () => !!(project && project.count_in) }),
  C('daw.loop', 'Loop the Region', 'L', () => { if (project.loop_end <= project.loop_start) { toast('Drag along the top strip of the ruler to set a loop region.', { timeout: 3000 }); return; } project.loop_on = !project.loop_on; syncTransport(); changed(); }, { icon: 'repeat', category: 'Transport', when: has, checked: () => !!(project && project.loop_on) }),
  C('daw.snap', 'Snap to Beats', null, () => { settings.set('snap', !settings.get('snap', true)); refresh(); }, { icon: 'magnet', category: 'Transport', checked: () => settings.get('snap', true) }),
  C('daw.tuner', 'Tuner', 'T', () => tuner(), { icon: 'gauge', category: 'View' }),
  C('daw.zoomIn', 'Zoom In', 'Ctrl+=', () => zoomAt(1.25), { icon: 'zoomIn', category: 'View' }),
  C('daw.zoomOut', 'Zoom Out', 'Ctrl+-', () => zoomAt(1 / 1.25), { icon: 'zoomOut', category: 'View' }),
  C('daw.fit', 'Fit the Project', 'Ctrl+0', () => fit(), { icon: 'fit', category: 'View' }),
  C('daw.input', 'Audio Input…', null, () => inputDialog(), { icon: 'mic', category: 'View' }),
);

// Transport bar.
const timeEl = h('div.dw-time', '1.1.000');
const clockEl = h('div.dw-clock', '0:00.0');
const bpmIn = h('input.input.dw-num', { type: 'number', min: 20, max: 300, step: 1, value: 120, 'data-tip': 'Tempo (beats a minute)' });
bpmIn.addEventListener('change', () => { project.bpm = clamp(Number(bpmIn.value) || 120, 20, 300); syncTransport(); changed(); });
const sigSel = select({ options: [2, 3, 4, 5, 6, 7].map((n) => ({ value: String(n), label: `${n}/4` })), value: '4', onChange: (v) => { project.beats_per_bar = Number(v); syncTransport(); changed(); } });
const masterIn = h('input', { type: 'range', min: -60, max: 6, step: 0.5, value: 0, 'data-tip': 'Master volume' });
masterIn.addEventListener('input', () => { project.master_db = Number(masterIn.value); syncTransport(); changed(); });
const masterMeter = h('div.dw-meter.master', h('div'), h('div'));
const transport = h('div.toolbar.dw-transport',
  tb('daw.home'), tb('daw.play'), tb({ icon: 'stop', tip: 'Stop', run: () => stop() }), tb('daw.record', { cls: 'rec' }),
  h('div.dw-clockbox', timeEl, clockEl), sep(),
  h('label.dw-lab', 'Tempo'), bpmIn, sigSel, tb('daw.metronome'), tb('daw.countIn', { icon: null, label: 'Count-in', showLabel: true, tip: 'Count in one bar before recording' }), tb('daw.loop'), tb('daw.snap'), sep(),
  tb('daw.tuner', { showLabel: true }), h('div.grow'), h('span', { html: icon('volume', 16), class: 'dw-volic' }), masterIn, masterMeter);

// Tracks and timeline: one scroller, track headers sticky on the left, the ruler on top.
const ruler = h('canvas.dw-ruler');
const rulerRow = h('div.dw-rulerrow', h('div.dw-corner', tb({ icon: 'plus', label: 'Add track', showLabel: true, tip: 'Add a track', menu: () => [I('daw.addGuitar'), I('daw.addMic'), I('daw.addEmpty')] })), h('div.dw-rulerlane', ruler));
const rows = h('div.dw-rows');
const spacer = h('div.dw-spacer');
const scroller = h('div.dw-scroller', rulerRow, rows, spacer);
const emptyNote = h('div.dw-empty', h('div', { html: icon('mic', 40) }), h('h2', 'Record and practise'),
  h('p.muted', 'An amp and effects for your guitar, a loop station, a tuner and multitrack recording. Plug in, put headphones on, and press Record.'),
  h('div.row', h('button.btn.primary', { onclick: () => commands.run('daw.newProject') }, 'New project'), h('button.btn', { onclick: () => projectsDialog() }, 'Open a project')));

// Bottom: effects of the selected track, and the loop station.
const panelTabs = h('div.tabs');
const panelBody = h('div.dw-panelbody');
const panel = h('div.panel.dw-panel', panelTabs, panelBody);
let panelTab = settings.get('panelTab', 'fx');
for (const [id, label] of [['fx', 'Effects'], ['loops', 'Loop station']]) {
  const b = h('button', { dataset: { tab: id } }, label);
  b.addEventListener('click', () => { panelTab = id; settings.set('panelTab', id); paintPanel(); });
  panelTabs.append(b);
}
const panelSplit = splitter(panel, { vertical: true, side: 'bottom', key: 'panelH', initial: 250, min: 120, max: 600 });
shell.main.append(h('div.dw-root', transport, h('div.dw-mid', scroller, emptyNote), panelSplit, panel));
shell.showStatus(true);
const statusLeft = h('span.item');
shell.statusLeft.append(statusLeft);

// ---------------------------------------------------------------------------
// Drawing the timeline
// ---------------------------------------------------------------------------
let pps = settings.get('pps', 60); // pixels per second
const toX = (frames) => (frames / SR) * pps;
const toFrames = (x) => (x / pps) * SR;
const laneCanvases = new Map();

function paintTracks() {
  emptyNote.classList.toggle('hidden', !!(project && project.tracks.length));
  rows.replaceChildren();
  laneCanvases.clear();
  if (!project) return;
  bpmIn.value = project.bpm;
  sigSel.value = String(project.beats_per_bar);
  masterIn.value = project.master_db;
  for (const t of project.tracks) {
    const color = COLORS[t.color % COLORS.length];
    const name = h('div.dw-tname', { 'data-tip': 'Double-click to rename' }, t.name);
    name.addEventListener('dblclick', async () => { const n = await promptBox('Track name', { value: t.name, ok: 'Rename' }); if (n && n.trim()) { t.name = n.trim(); changed(); } });
    const toggle = (key, label, tip, cls = '') => {
      const b = h(`button.dw-tog${cls}${t[key] ? '.on' : ''}`, { 'data-tip': tip }, label);
      b.addEventListener('click', async (e) => {
        e.stopPropagation();
        if (key === 'arm' && !t.arm) await startAudio();
        t[key] = !t[key];
        if ((key === 'arm' || key === 'monitor') && t[key]) { await startAudio(); await useInput(); }
        syncTrack(t);
        changed();
      });
      return b;
    };
    const inputSel = select({ options: [{ value: '0', label: 'Input 1 (left)' }, { value: '1', label: 'Input 2 (right)' }, { value: 'none', label: 'No input' }],
      value: inputNum(t) === null ? 'none' : String(inputNum(t)), onChange: (v) => { t.input = v === 'none' ? 'None' : { Hw: Number(v) }; syncTrack(t); changed(); } });
    const vol = h('input', { type: 'range', min: -60, max: 6, step: 0.5, value: t.volume_db, 'data-tip': 'Volume (double-click: 0 dB)' });
    vol.addEventListener('input', () => { t.volume_db = Number(vol.value); syncTrack(t); changed({ save: true }); });
    vol.addEventListener('dblclick', () => { t.volume_db = 0; vol.value = 0; syncTrack(t); changed(); });
    const pan = h('input.dw-pan', { type: 'range', min: -1, max: 1, step: 0.05, value: t.pan, 'data-tip': 'Pan (double-click: centre)' });
    pan.addEventListener('input', () => { t.pan = Number(pan.value); syncTrack(t); changed(); });
    pan.addEventListener('dblclick', () => { t.pan = 0; pan.value = 0; syncTrack(t); changed(); });
    const meter = h('div.dw-meter', { dataset: { track: t.id } }, h('div'), h('div'));
    const head = h(`div.dw-head${sel.track === t.id ? '.on' : ''}`, { style: { '--tc': color } },
      h('div.dw-hrow', name, toggle('arm', '●', 'Arm for recording', '.arm'), toggle('mute', 'M', 'Mute'), toggle('solo', 'S', 'Solo'), toggle('monitor', '🎧', 'Hear the input live (use headphones)')),
      h('div.dw-hrow', inputSel, toggle('fx_on', 'FX', 'Effects on/off')),
      h('div.dw-hrow', vol, pan, meter));
    head.addEventListener('pointerdown', () => { if (sel.track !== t.id) { sel = { track: t.id, clip: null }; paintSelection(); draw(); paintFx(); refresh(); } });
    contextMenu(head, () => [
      { label: 'Rename…', icon: 'pencil', run: () => name.dispatchEvent(new MouseEvent('dblclick')) },
      { label: 'Colour', icon: 'palette', submenu: () => COLORS.map((c, i) => ({ label: c, swatch: c, checked: t.color % COLORS.length === i, run: () => { t.color = i; changed(); } })) },
      { label: 'Move up', icon: 'chevronUp', disabled: project.tracks[0] === t, run: () => { const i = project.tracks.indexOf(t); project.tracks.splice(i, 1); project.tracks.splice(i - 1, 0, t); changed(); } },
      { label: 'Move down', icon: 'chevronDown', disabled: project.tracks[project.tracks.length - 1] === t, run: () => { const i = project.tracks.indexOf(t); project.tracks.splice(i, 1); project.tracks.splice(i + 1, 0, t); changed(); } },
      { type: 'separator' },
      { label: 'Remove the track', icon: 'trash', danger: true, run: () => removeTrack(t) },
    ]);
    const canvas = h('canvas.dw-lanecanvas');
    const lane = h('div.dw-lane', canvas);
    laneCanvases.set(t.id, canvas);
    lane.addEventListener('pointerdown', (e) => laneDown(e, t, lane));
    lane.addEventListener('dblclick', () => { const [, c] = selectedClip(); if (c) seek(c.start); });
    contextMenu(lane, () => [I('daw.split'), I('daw.duplicate'), I('daw.delete'), { type: 'separator' }, I('daw.importAudio')]);
    rows.append(h('div.dw-row', { style: { height: `${t.height || 94}px` }, dataset: { track: t.id } }, head, lane));
  }
  sizeTimeline();
}

function paintSelection() {
  for (const row of rows.children) row.querySelector('.dw-head').classList.toggle('on', Number(row.dataset.track) === sel.track);
}

function sizeTimeline() {
  if (!project) return;
  const end = Math.max(projectEnd(), status.pos, project.loop_end) + 30 * SR;
  spacer.style.width = `${HEAD + toX(end)}px`;
  for (const lane of rows.querySelectorAll('.dw-lane')) lane.style.width = `${toX(end)}px`;
  rulerRow.querySelector('.dw-rulerlane').style.width = `${toX(end)}px`;
}

function fitCanvas(c, w, hgt) {
  const dpr = window.devicePixelRatio || 1;
  if (c.width !== Math.round(w * dpr) || c.height !== Math.round(hgt * dpr)) { c.width = Math.round(w * dpr); c.height = Math.round(hgt * dpr); c.style.width = `${w}px`; c.style.height = `${hgt}px`; }
  const g = c.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return g;
}
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

let drawQueued = false;
function draw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; drawNow(); });
}
function drawNow() {
  if (!project) return;
  const w = Math.max(10, scroller.clientWidth - HEAD);
  const x0 = scroller.scrollLeft;
  const f0 = toFrames(x0);
  const f1 = toFrames(x0 + w);
  const beat = beatFrames();
  const bar = barFrames();
  const fg2 = css('--fg2');
  const border = css('--border');
  const accent = css('--accent');
  // Ruler: bars and beats, the loop region, the playhead.
  const g = fitCanvas(ruler, w, 30);
  g.clearRect(0, 0, w, 30);
  if (project.loop_end > project.loop_start) {
    g.fillStyle = project.loop_on ? 'rgba(63,185,80,.35)' : 'rgba(128,128,128,.25)';
    g.fillRect(toX(project.loop_start) - x0, 0, toX(project.loop_end - project.loop_start), 10);
  }
  g.font = '11px system-ui, sans-serif';
  g.textBaseline = 'top';
  const step = toX(beat) < 6 ? bar : beat;
  for (let f = Math.floor(f0 / step) * step; f <= f1; f += step) {
    const x = Math.round(toX(f) - x0) + 0.5;
    const isBar = Math.abs(f / bar - Math.round(f / bar)) < 1e-6;
    g.strokeStyle = isBar ? fg2 : border;
    g.beginPath(); g.moveTo(x, isBar ? 10 : 20); g.lineTo(x, 30); g.stroke();
    if (isBar && toX(bar) > 28) { g.fillStyle = fg2; g.fillText(String(Math.round(f / bar) + 1), x + 3, 12); }
  }
  const px = toX(status.pos) - x0;
  g.fillStyle = '#f85149';
  g.beginPath(); g.moveTo(px - 5, 20); g.lineTo(px + 5, 20); g.lineTo(px, 30); g.fill();
  // Lanes.
  for (const t of project.tracks) {
    const c = laneCanvases.get(t.id);
    if (!c) continue;
    const hh = (t.height || 94) - 1;
    const lg = fitCanvas(c, w, hh);
    lg.clearRect(0, 0, w, hh);
    lg.strokeStyle = border;
    for (let f = Math.floor(f0 / bar) * bar; f <= f1; f += bar) { const x = Math.round(toX(f) - x0) + 0.5; lg.beginPath(); lg.moveTo(x, 0); lg.lineTo(x, hh); lg.stroke(); }
    if (project.loop_end > project.loop_start && project.loop_on) { lg.fillStyle = 'rgba(63,185,80,.06)'; lg.fillRect(toX(project.loop_start) - x0, 0, toX(project.loop_end - project.loop_start), hh); }
    const color = COLORS[t.color % COLORS.length];
    for (const cl of t.clips) {
      const cx = toX(cl.start) - x0;
      const cw = toX(cl.len);
      if (cx > w || cx + cw < 0) continue;
      const on = sel.clip === cl.id;
      lg.fillStyle = `${color}33`;
      lg.fillRect(cx, 3, cw, hh - 6);
      lg.strokeStyle = on ? '#ffffff' : color;
      lg.lineWidth = on ? 2 : 1;
      lg.strokeRect(cx + 0.5, 3.5, cw - 1, hh - 7);
      lg.lineWidth = 1;
      const a = audio.get(cl.file);
      if (a) {
        lg.fillStyle = color;
        const mid = hh / 2;
        const amp = (hh - 14) / 2;
        const start = Math.max(0, -cx);
        const end = Math.min(cw, w - cx);
        for (let x = start; x < end; x++) {
          const fr = cl.offset + toFrames(x);
          const k = Math.floor(fr / 256) * 2;
          const k2 = Math.floor((fr + toFrames(1)) / 256) * 2;
          let lo = 0;
          let hi = 0;
          for (let j = k; j <= Math.max(k, k2) && j < a.peaks.length; j += 2) { lo = Math.min(lo, a.peaks[j]); hi = Math.max(hi, a.peaks[j + 1]); }
          lg.fillRect(cx + x, mid - hi * amp, 1, Math.max(1, (hi - lo) * amp));
        }
      } else {
        lg.fillStyle = fg2;
        lg.fillText('missing audio', cx + 6, 8);
      }
      lg.fillStyle = css('--fg');
      lg.font = '11px system-ui, sans-serif';
      lg.textBaseline = 'top';
      if (cw > 40) lg.fillText(cl.file.split('/').pop().replace(/\.wav$/i, '').slice(0, Math.floor(cw / 7)), cx + 5, 6);
    }
    lg.fillStyle = '#f85149';
    lg.fillRect(px, 0, 1, hh);
  }
  // Clock.
  const s = status.pos / SR;
  timeEl.textContent = `${Math.floor(status.pos / bar) + 1}.${Math.floor((status.pos % bar) / beat) + 1}.${String(Math.floor(((status.pos % beat) / beat) * 1000)).padStart(3, '0')}`;
  clockEl.textContent = `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;
  void accent;
}

function zoomAt(k, clientX = null) {
  const r = scroller.getBoundingClientRect();
  const anchorX = clientX === null ? r.left + HEAD + (r.width - HEAD) / 2 : clientX;
  const f = toFrames(anchorX - r.left - HEAD + scroller.scrollLeft);
  pps = clamp(pps * k, 2, 2000);
  settings.set('pps', pps);
  sizeTimeline();
  scroller.scrollLeft = Math.max(0, toX(f) - (anchorX - r.left - HEAD));
  draw();
}
function fit() {
  const end = projectEnd() || 30 * SR;
  pps = clamp(((scroller.clientWidth - HEAD - 40) / end) * SR, 2, 2000);
  sizeTimeline();
  scroller.scrollLeft = 0;
  draw();
}
scroller.addEventListener('scroll', draw);
scroller.addEventListener('wheel', (e) => {
  if (e.ctrlKey || e.metaKey) { e.preventDefault(); zoomAt(e.deltaY < 0 ? 1.18 : 1 / 1.18, e.clientX); }
}, { passive: false });
let pps0 = pps;
pinch(scroller, { begin: () => { pps0 = pps; }, change: (scale, c) => zoomAt(clamp(pps0 * scale, 2, 2000) / pps, c.x) });
scroller.style.touchAction = 'pan-x pan-y';
new ResizeObserver(() => { sizeHead(); draw(); }).observe(scroller);

const snapTo = (f) => {
  if (!settings.get('snap', true)) return f;
  const b = beatFrames();
  const s = Math.round(f / b) * b;
  return Math.abs(toX(s) - toX(f)) < 8 ? s : f;
};

// Ruler: the top strip draws the loop region, the rest moves the playhead.
ruler.addEventListener('pointerdown', (e) => {
  if (!project) return;
  const r = ruler.getBoundingClientRect();
  const at = (ev) => Math.max(0, toFrames(ev.clientX - r.left + scroller.scrollLeft));
  ruler.setPointerCapture(e.pointerId);
  if (e.clientY - r.top < 11) {
    const a = snapTo(at(e));
    const mv = (ev) => { const b = snapTo(at(ev)); project.loop_start = Math.round(Math.min(a, b)); project.loop_end = Math.round(Math.max(a, b)); syncTransport(); draw(); };
    const up = () => { ruler.removeEventListener('pointermove', mv); ruler.removeEventListener('pointerup', up); if (project.loop_end - project.loop_start > SR / 20) { project.loop_on = true; syncTransport(); } changed(); };
    ruler.addEventListener('pointermove', mv);
    ruler.addEventListener('pointerup', up);
    return;
  }
  seek(at(e));
  const mv = (ev) => seek(at(ev));
  const up = () => { ruler.removeEventListener('pointermove', mv); ruler.removeEventListener('pointerup', up); };
  ruler.addEventListener('pointermove', mv);
  ruler.addEventListener('pointerup', up);
});

function laneDown(e, t, lane) {
  if (e.button !== 0 || status.recording) return;
  const r = lane.getBoundingClientRect();
  const f = toFrames(e.clientX - r.left);
  const hit = [...t.clips].reverse().find((c) => f >= c.start && f <= c.start + c.len);
  const wasSelected = hit && sel.clip === hit.id;
  sel = { track: t.id, clip: hit ? hit.id : null };
  const target = lane.closest('.dw-row');
  // A finger moves a clip only once it is selected; otherwise it scrolls the timeline sideways.
  if (e.pointerType === 'touch' && !wasSelected) {
    const sx = e.clientX;
    const sl = scroller.scrollLeft;
    target.setPointerCapture(e.pointerId);
    const mv = (ev) => { scroller.scrollLeft = sl - (ev.clientX - sx); };
    const up = () => { target.removeEventListener('pointermove', mv); target.removeEventListener('pointerup', up); target.removeEventListener('pointercancel', up); };
    target.addEventListener('pointermove', mv);
    target.addEventListener('pointerup', up);
    target.addEventListener('pointercancel', up);
  }
  paintSelection();
  paintFx();
  draw();
  refresh();
  if (!hit || (e.pointerType === 'touch' && !wasSelected)) return;
  const edge = 8;
  const xIn = toX(f - hit.start);
  const mode = xIn < edge ? 'left' : toX(hit.len) - xIn < edge ? 'right' : 'move';
  const orig = { ...hit };
  const x0 = e.clientX;
  let moved = false;
  target.setPointerCapture(e.pointerId);
  const mv = (ev) => {
    const d = toFrames(ev.clientX - x0);
    if (!moved && Math.abs(ev.clientX - x0) < 3) return;
    if (!moved) { snapshot(); moved = true; }
    if (mode === 'move') hit.start = Math.max(0, Math.round(snapTo(orig.start + d)));
    else if (mode === 'left') {
      const s = clamp(Math.round(snapTo(orig.start + d)), orig.start - orig.offset, orig.start + orig.len - SR / 50);
      hit.offset = orig.offset + (s - orig.start);
      hit.len = orig.len - (s - orig.start);
      hit.start = s;
    } else {
      const a = audio.get(hit.file);
      const max = a ? a.frames - hit.offset : orig.len;
      hit.len = clamp(Math.round(snapTo(orig.start + orig.len + d) - orig.start), SR / 50, max);
    }
    syncClips(t);
    sizeTimeline();
    draw();
  };
  const up = () => { target.removeEventListener('pointermove', mv); target.removeEventListener('pointerup', up); if (moved) changed(); };
  target.addEventListener('pointermove', mv);
  target.addEventListener('pointerup', up);
}

// ---------------------------------------------------------------------------
// The bottom panel: effects and the loop station
// ---------------------------------------------------------------------------
function paintPanel() {
  for (const b of panelTabs.children) b.classList.toggle('on', b.dataset.tab === panelTab);
  if (panelTab === 'fx') paintFx(); else paintLoops();
}

function fmtParam(p, v) {
  const n = Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 10 ? v.toFixed(1) : v.toFixed(2);
  return `${n}${p.unit ? ` ${p.unit}` : ''}`;
}
function paintFx() {
  if (panelTab !== 'fx') return;
  const t = project && trackOf(sel.track);
  if (!t) { panelBody.replaceChildren(h('div.empty', project ? 'Select a track to see its effects.' : '')); return; }
  const cards = t.fx.map((f, i) => {
    const info = kinds.find((k) => k.kind === f.kind) || { name: f.kind, params: [] };
    const sliders = info.params.map((p, idx) => {
      const val = f.params[idx] ?? p.default;
      const toPos = (v) => (p.log ? Math.log(v / p.min) / Math.log(p.max / p.min) : (v - p.min) / (p.max - p.min));
      const fromPos = (x) => (p.log ? p.min * (p.max / p.min) ** x : p.min + x * (p.max - p.min));
      const out = h('span.dw-pval', fmtParam(p, val));
      const r = h('input', { type: 'range', min: 0, max: 1000, step: 1, value: Math.round(toPos(val) * 1000), 'data-tip': 'Double-click: default' });
      r.addEventListener('input', () => {
        let v = fromPos(Number(r.value) / 1000);
        if (p.step) v = Math.round(v / p.step) * p.step;
        f.params[idx] = v;
        out.textContent = fmtParam(p, v);
        send({ op: 'fx_param', id: f.id, index: idx, value: v });
        changed();
      });
      r.addEventListener('dblclick', () => { f.params[idx] = p.default; r.value = Math.round(toPos(p.default) * 1000); out.textContent = fmtParam(p, p.default); send({ op: 'fx_param', id: f.id, index: idx, value: p.default }); changed(); });
      return h('label.dw-param', h('span.dw-pname', p.name), r, out);
    });
    const onBtn = h(`button.dw-tog${f.bypass ? '' : '.on'}`, { 'data-tip': 'Switch this effect on/off' }, f.bypass ? 'Off' : 'On');
    onBtn.addEventListener('click', () => { f.bypass = !f.bypass; send({ op: 'fx_bypass', id: f.id, on: f.bypass }); changed(); paintFx(); });
    const moveBy = (by) => { const j = i + by; if (j < 0 || j >= t.fx.length) return; t.fx.splice(i, 1); t.fx.splice(j, 0, f); send({ op: 'fx_move', track: t.id, id: f.id, index: j }); changed(); paintFx(); };
    return h(`div.dw-fx${f.bypass ? '.off' : ''}`,
      h('div.dw-fxhead', h('b.grow', info.name), onBtn,
        tb({ icon: 'chevronLeft', tip: 'Move earlier', run: () => moveBy(-1) }), tb({ icon: 'chevronRight', tip: 'Move later', run: () => moveBy(1) }),
        tb({ icon: 'x', tip: 'Remove', run: () => { t.fx.splice(i, 1); send({ op: 'fx_remove', track: t.id, id: f.id }); changed(); paintFx(); } })),
      ...sliders);
  });
  const add = h('button.dw-fxadd', h('span', { html: icon('plus', 18) }), 'Add an effect');
  add.addEventListener('click', () => showMenu(kinds.map((k) => ({ label: k.name, run: () => addFx(t, k.kind) })), { anchor: add }));
  panelBody.replaceChildren(h('div.dw-fxrow', h('div.dw-fxtitle', h('b', t.name), h('span.muted', t.fx_on ? 'Effects, in order' : 'Effects are off for this track')), ...cards, add));
}

const LOOP_COLORS = ['', '#f85149', '#3fb950', '#d29922', '#8b949e', '#2f81f7'];
const loopCards = [];
function paintLoops() {
  if (panelTab !== 'loops' || !project) { if (!project && panelTab === 'loops') panelBody.replaceChildren(); return; }
  loopCards.length = 0;
  const cards = [0, 1, 2, 3].map((slot) => {
    const main = h('button.dw-loopbtn', { 'data-tip': 'Empty → record → play → overdub → play…' });
    main.addEventListener('click', async () => {
      await startAudio();
      if (!project.loop_sources[slot].length && sel.track) { project.loop_sources[slot] = [sel.track]; changed(); }
      // A loop hears its tracks as they sound in the mix, so their input must be heard.
      const quiet = project.tracks.filter((t) => project.loop_sources[slot].includes(t.id) && !t.monitor && inputNum(t) !== null);
      if (status.loops[slot] === 0 && quiet.length) {
        quiet.forEach((t) => { t.monitor = true; });
        toast(`Hearing ${quiet.map((t) => t.name).join(' and ')} live now, so the loop can record it. Use headphones.`, { timeout: 4500 });
        changed();
      }
      for (const t of project.tracks) syncTrack(t);
      await useInput();
      send({ op: 'loop', slot, action: 'press' });
    });
    const sources = h('div.dw-loopsrc', ...project.tracks.map((t) => {
      const c = h('input', { type: 'checkbox', checked: project.loop_sources[slot].includes(t.id) });
      c.addEventListener('change', () => {
        const l = project.loop_sources[slot];
        project.loop_sources[slot] = c.checked ? [...l, t.id] : l.filter((id) => id !== t.id);
        for (const x of project.tracks) syncTrack(x);
        changed();
      });
      return h('label.check', c, t.name);
    }));
    const gain = h('input', { type: 'range', min: 0, max: 1.5, step: 0.01, value: 1, 'data-tip': 'Loop volume' });
    gain.addEventListener('input', () => send({ op: 'loop_gain', slot, gain: Number(gain.value) }));
    const card = h('div.dw-loop', h('div.dw-loophead', h('b', `Loop ${slot + 1}`), h('div.grow'),
      tb({ icon: 'volumeX', tip: 'Mute / unmute this loop', run: () => send({ op: 'loop', slot, action: 'stop' }) }),
      tb({ icon: 'trash', tip: 'Erase this loop', run: () => send({ op: 'loop', slot, action: 'clear' }) })),
    main, h('div.dw-looprow', h('span.muted', 'Volume'), gain), h('div.muted', 'Hears:'), sources);
    loopCards.push({ main, card });
    return card;
  });
  const opt = (key, label, def) => { const c = h('input', { type: 'checkbox', checked: settings.get(key, def) }); c.addEventListener('change', () => { settings.set(key, c.checked); syncTransport(); }); return h('label.check', c, label); };
  const progress = h('div.progress.dw-loopprog', h('div'));
  panelBody.replaceChildren(h('div.dw-loops',
    h('div.dw-loopbar', opt('loopCountIn', 'One bar of clicks before the first loop', true), opt('loopClick', 'Click while looping', false), h('div.grow'), progress,
      h('button.btn.small', { onclick: () => { for (let s = 0; s < 4; s++) send({ op: 'loop', slot: s, action: 'clear' }); } }, 'Erase all loops')),
    h('div.dw-loopcards', ...cards)));
  onStatus();
}

// ---------------------------------------------------------------------------
// Live status from the audio thread
// ---------------------------------------------------------------------------
const meter = (el, [l, r]) => {
  if (!el) return;
  const db = (v) => clamp((20 * Math.log10(Math.max(v, 1e-6)) + 60) / 66, 0, 1);
  el.children[0].style.width = `${db(l) * 100}%`;
  el.children[1].style.width = `${db(r) * 100}%`;
  el.classList.toggle('clip', l >= 0.99 || r >= 0.99);
};
let wasRecording = false;
function onStatus() {
  if (!project) return;
  meter(masterMeter, status.master);
  for (const el of rows.querySelectorAll('.dw-meter')) meter(el, status.tracks[el.dataset.track] || [0, 0]);
  loopCards.forEach(({ main, card }, i) => {
    const s = status.loops[i] || 0;
    main.textContent = s === 0 ? 'Record' : s === 5 ? 'Get ready…' : s === 1 ? 'Recording — press to play' : s === 2 ? 'Playing — press to overdub' : s === 3 ? 'Overdubbing — press to play' : 'Muted';
    main.style.setProperty('--lc', LOOP_COLORS[s] || 'var(--button2)');
    card.classList.toggle('active', s !== 0);
  });
  const prog = panelBody.querySelector('.dw-loopprog > div');
  if (prog) prog.style.width = status.loop_len ? `${(status.loop_pos / status.loop_len) * 100}%` : '0';
  if (tunerBox) paintTuner();
  if (status.recording !== wasRecording) { wasRecording = status.recording; refresh(); document.body.classList.toggle('dw-recording', status.recording); }
  statusLeft.textContent = status.recording ? (status.pos < recAt ? 'Count-in…' : 'Recording…') : status.playing ? 'Playing' : `${project.tracks.length} track${project.tracks.length === 1 ? '' : 's'}`;
  // Keep the playhead in view while playing.
  if (status.playing) {
    const x = toX(status.pos);
    const w = scroller.clientWidth - HEAD;
    if (x > scroller.scrollLeft + w - 40 || x < scroller.scrollLeft) scroller.scrollLeft = Math.max(0, x - 60);
  }
  draw();
}

// ---------------------------------------------------------------------------
// Tuner, projects, audio input
// ---------------------------------------------------------------------------
let tunerBox = null;
function paintTuner() {
  const r = status.tuner;
  tunerBox.querySelector('.dw-note').textContent = r ? r.note : '—';
  tunerBox.querySelector('.dw-freq').textContent = r ? `${r.freq.toFixed(1)} Hz` : 'Play a single string';
  const c = r ? clamp(r.cents, -50, 50) : 0;
  tunerBox.querySelector('.dw-needle').style.left = `${50 + c}%`;
  tunerBox.classList.toggle('intune', !!r && Math.abs(c) < 4);
  tunerBox.querySelector('.dw-cents').textContent = r ? `${c > 0 ? '+' : ''}${c.toFixed(0)} cents` : '';
}
async function tuner() {
  await startAudio();
  if (!(await useInput())) return;
  const inp = select({ options: [{ value: '0', label: 'Input 1 (left)' }, { value: '1', label: 'Input 2 (right)' }], value: String(settings.get('tunerInput', 0)), onChange: (v) => { settings.set('tunerInput', Number(v)); send({ op: 'transport', tuner_input: Number(v) }); } });
  tunerBox = h('div.dw-tuner', h('div.dw-note', '—'), h('div.dw-scale', h('div.dw-needle'), h('div.dw-zero')), h('div.dw-cents'), h('div.dw-freq.muted', 'Play a single string'), h('div.row', h('span.muted', 'Input'), inp));
  send({ op: 'transport', tuner: true, tuner_input: settings.get('tunerInput', 0) });
  await modal({ title: 'Tuner', body: tunerBox, buttons: [{ label: 'Close', value: true, primary: true }] });
  send({ op: 'transport', tuner: false });
  tunerBox = null;
}

async function projectsDialog() {
  const list = (await tx('projects', 'readonly', (s) => s.getAll())).sort((a, b) => b.updated - a.updated);
  let close = null;
  const body = h('div.col', { style: { minWidth: 'min(460px, 80vw)', gap: '4px' } },
    ...(list.length ? list.map((p) => {
      const row = h(`div.list-item${p.id === projectId ? '.on' : ''}`, h('span', { html: icon('music', 16) }), h('div.grow', h('b', p.name), h('div.muted', new Date(p.updated).toLocaleString())),
        tb({ icon: 'trash', tip: 'Delete this project', run: async (btn) => {
          if (!(await confirmBox(`Delete the project “${p.name}” and its recordings from this browser?`, { ok: 'Delete', danger: true }))) return;
          await tx('projects', 'readwrite', (s) => s.delete(p.id));
          const keys = await tx('files', 'readonly', (s) => s.getAllKeys());
          await tx('files', 'readwrite', (s) => { for (const k of keys) if (String(k).startsWith(`${p.id}/`)) s.delete(k); });
          btn.closest('.list-item').remove();
        } }));
      row.addEventListener('click', (e) => { if (e.target.closest('button')) return; if (close) close(true); openProject(p.id); });
      return row;
    }) : [h('div.empty', 'No saved projects yet.')]));
  await modal({ title: 'Open project', body, onOpen: (_d, c) => { close = c; }, buttons: [{ label: 'New project…', value: 'new', run: () => commands.run('daw.newProject') }, { label: 'Close', value: null, primary: true }] });
}

async function inputDialog() {
  const s = await navigator.mediaDevices.getUserMedia({ audio: true }).catch(() => null);
  if (s) s.getTracks().forEach((t) => t.stop());
  const devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput');
  const sel2 = select({ options: [{ value: '', label: 'The usual input' }, ...devices.filter((d) => d.deviceId !== 'default').map((d) => ({ value: d.deviceId, label: d.label || 'Input' }))], value: settings.get('inputDevice', ''), onChange: (v) => settings.set('inputDevice', v) });
  const off = h('input.input.num', { type: 'number', step: 1, value: settings.get('recOffsetMs', 0) });
  off.addEventListener('change', () => settings.set('recOffsetMs', Number(off.value) || 0));
  await modal({ title: 'Audio input', body: h('div.col', { style: { gap: '10px', minWidth: 'min(420px, 80vw)' } },
    h('div.field', h('span', 'Input'), sel2),
    h('div.field', h('span', 'Recording offset'), h('div.row', off, h('span.muted', 'ms (if takes land late, a positive number moves them earlier)'))),
    h('div.muted', 'An audio interface with a guitar input gives the best sound and the least delay. Use headphones while monitoring.')),
  buttons: [{ label: 'Done', value: true, primary: true }] });
  if (mic) { mic.stream.getTracks().forEach((t) => t.stop()); mic.src.disconnect(); mic = null; await useInput(); }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
onDropFiles((files) => { const z = files.find((f) => /\.zip$/i.test(f.name)); if (z) host.read(z).then((b) => importZip(b, z.name)).catch((e) => errorToast(e.message)); else importAudioFiles(files); }, 'Drop sound files to import');
await engineReady.catch((e) => errorToast(`The sound engine could not start: ${e.message}`));
paintPanel();
const last = settings.get('lastProject', null);
const known = await tx('projects', 'readonly', (s) => s.getAllKeys()).catch(() => []);
if (last && known.includes(last)) await openProject(last);
else { paintTracks(); updateTitle(); }
// Sound starts with the first click (browsers require it).
window.addEventListener('pointerdown', () => { startAudio().catch((e) => errorToast(e.message)); }, { once: true, capture: true });
window.snakeApp = { commands, get project() { return project; }, get status() { return status; }, startAudio, createProject, addTrack, importAudioFiles, importZip, exportMix, rebuild, ask };
closeMenus();
