// Snake's Screen Recorder for the browser: the screen, a window, a tab or a region of
// it to MP4 (or WebM) or GIF, with the computer's sound and the microphone; or sound
// only. The browser asks what to share. Phones' browsers cannot record the screen, so
// there it records sound. Recordings stay in this browser until you save them.
import { h, uid, clamp } from '../../kit/dom.js';
import { icon } from '../../kit/icons.js';
import { host } from '../../kit/host.js';
import * as commands from '../../kit/commands.js';
import { createShell, tb, select, refresh } from '../../kit/shell.js';
import { contextMenu, closeMenus } from '../../kit/menu.js';
import { toast, errorToast, confirmBox, modal, promptBox } from '../../kit/dialogs.js';
import { GifEncoder } from '../../kit/gif.js';
import { withDuration } from '../../kit/webm.js';

const settings = host.settings;
const canScreen = !!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia);
const canRecord = typeof MediaRecorder !== 'undefined';

/** The first type this browser can record, with its file extension. */
function pickType(kind) {
  const video = [['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'mp4'], ['video/mp4', 'mp4'], ['video/webm;codecs=vp9,opus', 'webm'], ['video/webm;codecs=vp8,opus', 'webm'], ['video/webm', 'webm']];
  const audio = [['audio/mp4;codecs=mp4a.40.2', 'm4a'], ['audio/mp4', 'm4a'], ['audio/webm;codecs=opus', 'webm'], ['audio/webm', 'webm'], ['audio/ogg;codecs=opus', 'ogg']];
  const list = kind === 'audio' ? audio : video;
  const prefer = settings.get(kind === 'audio' ? 'audioFormat' : 'videoFormat', 'auto');
  const ok = list.filter(([m]) => canRecord && MediaRecorder.isTypeSupported(m));
  return ok.find(([, e]) => e === prefer) || ok[0] || null;
}

// ---------------------------------------------------------------------------
// Recordings: kept in this browser (IndexedDB) until saved or deleted
// ---------------------------------------------------------------------------
const dbp = new Promise((resolve, reject) => {
  const req = indexedDB.open('snake-screen', 1);
  req.onupgradeneeded = () => req.result.createObjectStore('recordings', { keyPath: 'id' });
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});
async function tx(mode, fn) {
  const db = await dbp;
  return new Promise((resolve, reject) => {
    const t = db.transaction('recordings', mode);
    const r = fn(t.objectStore('recordings'));
    t.oncomplete = () => resolve(r && r.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error || new Error('Not kept: the browser is out of space.'));
  });
}
let recordings = [];

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
const shell = await createShell({
  id: 'screen', name: "Snake's Screen Recorder",
  menus: [
    { label: '&Record', items: () => [I('rec.toggle'), I('rec.pause'), { type: 'separator' }, I('rec.region')] },
    { label: '&Recordings', items: () => [I('rec.save'), I('rec.delete'), { type: 'separator' }, I('rec.clear')] },
    { label: '&View', items: () => [I('view.themeDark'), I('view.themeLight'), I('view.themeSystem'), I('view.fullscreen')] },
    { label: '&Help', items: () => [I('app.palette'), I('app.shortcuts'), { type: 'separator' }, I('app.about')] },
  ],
  about: 'Records the screen, a window, a browser tab or a region of it to MP4 (or WebM) or GIF, with the computer’s sound and your microphone, or sound only. '
    + 'Nothing is uploaded: recordings stay in this browser until you save them. The desktop and Android Screen Recorders also make MP3s and record without a browser.',
});
const I = (id, extra) => commands.item(id, extra);

let mode = settings.get('mode', canScreen ? 'video' : 'audio');
if (!canScreen && mode !== 'audio') mode = 'audio';
let rec = null; // the recording going on
let selected = null;

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
const C = (id, label, keys, run, extra = {}) => ({ id, label, keys, run, ...extra });
commands.register(
  C('rec.toggle', 'Start or Stop Recording', 'Ctrl+Shift+R', () => (rec ? stop() : start()), { icon: 'record', category: 'Record' }),
  C('rec.pause', 'Pause', 'Ctrl+Shift+P', () => pause(), { icon: 'pause', category: 'Record', when: () => !!rec, checked: () => !!(rec && rec.pausedAt) }),
  C('rec.region', 'Choose the Region Again…', null, () => { settings.set('region', null); settings.set('area', 'region'); toast('You choose it when you next record.', { timeout: 2500 }); }, { icon: 'crop', category: 'Record' }),
  C('rec.save', 'Save the Recording…', 'Ctrl+S', () => selected && save(selected), { icon: 'save', category: 'Recordings', when: () => !!selected }),
  C('rec.delete', 'Delete the Recording', 'Delete', () => selected && remove(selected), { icon: 'trash', category: 'Recordings', when: () => !!selected }),
  C('rec.clear', 'Delete Every Recording…', null, async () => {
    if (!recordings.length || !(await confirmBox('Delete every recording kept here? (Copies you saved stay.)', { ok: 'Delete all', danger: true }))) return;
    await tx('readwrite', (st) => st.clear()).catch(() => {});
    recordings = [];
    selected = null;
    paintList();
  }, { icon: 'trash', category: 'Recordings' }),
);


const modeSeg = h('div.seg.sr-modes');
const MODES = [['video', 'Video', 'video'], ['gif', 'GIF', 'image'], ['audio', 'Sound only', 'mic']];
for (const [id, label, ic] of MODES) {
  const b = h('button', { dataset: { mode: id }, disabled: !canScreen && id !== 'audio' }, h('span', { html: icon(ic, 14) }), ` ${label}`);
  b.addEventListener('click', () => { if (!rec) { mode = id; settings.set('mode', id); paintSettings(); } });
  modeSeg.append(b);
}

const check = (key, label, def, tip = '') => {
  const input = h('input', { type: 'checkbox', checked: settings.get(key, def) });
  input.addEventListener('change', () => settings.set(key, input.checked));
  return h('label.check', { 'data-tip': tip }, input, label);
};
const field = (label, control) => h('div.field', h('span', label), control);

const micSelect = h('select.select');
async function fillMics() {
  const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
  const mics = devices.filter((d) => d.kind === 'audioinput' && d.deviceId !== 'default');
  micSelect.replaceChildren(h('option', { value: '' }, 'The usual microphone'),
    ...mics.map((d) => h('option', { value: d.deviceId, selected: d.deviceId === settings.get('micId', '') }, d.label || 'Microphone')));
}
micSelect.addEventListener('change', () => settings.set('micId', micSelect.value));

const areaSel = select({ options: [{ value: 'whole', label: 'All of what I share' }, { value: 'region', label: 'A region of it' }],
  value: settings.get('area', 'whole'), onChange: (v) => settings.set('area', v) });
const fpsSel = select({ options: [15, 24, 30, 60].map((v) => ({ value: String(v), label: `${v} frames a second` })), value: String(settings.get('fps', 30)), onChange: (v) => settings.set('fps', Number(v)) });
const qualSel = select({ options: [{ value: 'low', label: 'Small file' }, { value: 'medium', label: 'Good' }, { value: 'high', label: 'Best' }], value: settings.get('quality', 'medium'), onChange: (v) => settings.set('quality', v) });
const gifW = select({ options: [{ value: '0', label: 'Original size' }, ...[1280, 960, 640, 480, 320].map((w) => ({ value: String(w), label: `At most ${w} px wide` }))], value: String(settings.get('gifWidth', 640)), onChange: (v) => settings.set('gifWidth', Number(v)) });
const gifFps = select({ options: [5, 10, 15, 20].map((v) => ({ value: String(v), label: `${v} frames a second` })), value: String(settings.get('gifFps', 10)), onChange: (v) => settings.set('gifFps', Number(v)) });
const vFormats = [{ value: 'auto', label: 'Best this browser makes' }, ...['mp4', 'webm'].filter((e) => canRecord && MediaRecorder.isTypeSupported(`video/${e}`)).map((e) => ({ value: e, label: e.toUpperCase() }))];
const vFmt = select({ options: vFormats, value: settings.get('videoFormat', 'auto'), onChange: (v) => settings.set('videoFormat', v) });

const settingsBox = h('div.sr-settings');
function paintSettings() {
  for (const b of modeSeg.children) b.classList.toggle('on', b.dataset.mode === mode);
  const rows = [];
  if (!canScreen) rows.push(h('div.sr-note', h('span', { html: icon('info', 16) }), h('span', 'This browser cannot record the screen (phones’ browsers cannot). Sound recording works. On Android, the Screen Recorder app records the screen; on iPhone, Control Center’s Screen Recording does.')));
  if (mode !== 'audio') {
    rows.push(field('Record', areaSel), h('div.sr-hint.muted', 'When you press Record, the browser asks which screen, window or tab to share.'));
    if (mode === 'video') rows.push(field('Smoothness', fpsSel), field('Quality', qualSel), field('Format', vFmt));
    else rows.push(field('Size', gifW), field('Smoothness', gifFps));
    rows.push(check('cursor', 'Show the mouse pointer', true));
  }
  if (mode !== 'gif') {
    if (mode === 'video') rows.push(check('sysAudio', 'The sound of what I share', true, 'Chrome and Edge can include a tab’s or the whole computer’s sound'));
    else if (canScreen) rows.push(check('sysAudio', 'The computer’s or a tab’s sound', false, 'The browser then asks what to share; its sound is recorded'));
    rows.push(check('mic', 'My microphone', mode === 'audio'), field('Microphone', micSelect));
  }
  rows.push(check('countdown', 'Count down 3 seconds first', true));
  settingsBox.replaceChildren(...rows);
}

function updateRecordButton() {
  recordBtn.classList.toggle('on', !!rec);
  recordBtn.querySelector('.label').textContent = rec ? 'Stop' : 'Record';
  modeSeg.classList.toggle('locked', !!rec);
  live.classList.toggle('playing', !!live.srcObject);
  const label = pauseBtn.button.querySelector('span');
  if (label) label.textContent = rec && rec.pausedAt ? 'Resume' : 'Pause';
  refresh();
}
const recordBtn = h('button.sr-record', { 'data-tip': 'Start or stop recording', 'data-keys': 'Ctrl+Shift+R' }, h('span.dot'), h('span.label', 'Record'));
recordBtn.addEventListener('click', () => commands.run('rec.toggle'));
const pauseBtn = tb('rec.pause', { showLabel: true });
const timer = h('div.sr-timer', '00:00');
const live = h('video.sr-live', { muted: true, playsInline: true, autoplay: true });

const list = h('div.sr-list');
const preview = h('div.sr-preview');
shell.main.append(h('div.sr-root',
  h('div.sr-left',
    h('h2', 'New recording'), modeSeg, settingsBox,
    h('div.sr-controls', recordBtn, pauseBtn, timer), live),
  h('div.sr-right', h('h2', 'Recordings'), list, preview)));
shell.showStatus(true);
const status = h('span.item', 'Ready');
shell.statusLeft.append(status);

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------
const BITRATE = { low: 2_000_000, medium: 5_000_000, high: 12_000_000 };

async function chooseRegion(video) {
  // A still of what is shared; drag a rectangle over it.
  const c = h('canvas.sr-still');
  c.width = video.videoWidth;
  c.height = video.videoHeight;
  c.getContext('2d').drawImage(video, 0, 0);
  const box = h('div.sr-region');
  const wrap = h('div.sr-regionwrap', c, box);
  let r = settings.get('region', null) || { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
  const show = () => Object.assign(box.style, { left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` });
  show();
  wrap.addEventListener('pointerdown', (e) => {
    const b = wrap.getBoundingClientRect();
    const x0 = (e.clientX - b.left) / b.width;
    const y0 = (e.clientY - b.top) / b.height;
    wrap.setPointerCapture(e.pointerId);
    const mv = (ev) => {
      const x1 = clamp((ev.clientX - b.left) / b.width, 0, 1);
      const y1 = clamp((ev.clientY - b.top) / b.height, 0, 1);
      r = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
      show();
    };
    const up = () => { wrap.removeEventListener('pointermove', mv); wrap.removeEventListener('pointerup', up); };
    wrap.addEventListener('pointermove', mv);
    wrap.addEventListener('pointerup', up);
  });
  const ok = await modal({
    title: 'Drag over the part to record', width: 'min(92vw, 900px)',
    body: h('div.col', wrap, h('div.muted', 'Drag a rectangle. It is remembered for next time.')),
    buttons: [{ label: 'Cancel', value: false }, { label: 'Record this part', value: true, primary: true }],
  });
  if (!ok || r.w < 0.02 || r.h < 0.02) return null;
  settings.set('region', r);
  return r;
}

async function countdown() {
  if (!settings.get('countdown', true)) return;
  const big = h('div.sr-count');
  document.body.append(big);
  for (let n = 3; n > 0; n--) { big.textContent = String(n); await new Promise((r) => setTimeout(r, 1000)); }
  big.remove();
}

async function start() {
  if (!canRecord) { errorToast('This browser cannot record.'); return; }
  const streams = [];
  try {
    const wantsScreen = mode !== 'audio' || (canScreen && settings.get('sysAudio', false));
    let display = null;
    if (wantsScreen) {
      display = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: mode === 'gif' ? settings.get('gifFps', 10) : settings.get('fps', 30), cursor: settings.get('cursor', true) ? 'always' : 'never' },
        audio: mode !== 'gif' && settings.get('sysAudio', mode === 'video'),
        systemAudio: 'include', selfBrowserSurface: 'exclude',
      });
      streams.push(display);
    }
    let mic = null;
    if (mode !== 'gif' && settings.get('mic', mode === 'audio')) {
      const id = settings.get('micId', '');
      mic = await navigator.mediaDevices.getUserMedia({ audio: id ? { deviceId: { exact: id } } : true });
      streams.push(mic);
      fillMics();
    }
    const audioTracks = streams.flatMap((s) => s.getAudioTracks());
    if (mode === 'audio' && !audioTracks.length) throw new Error('Nothing to record: turn on the microphone or the computer’s sound.');

    // Mix every sound into one track.
    let audioCtx = null;
    let audioTrack = audioTracks[0] || null;
    if (audioTracks.length > 1) {
      audioCtx = new AudioContext();
      const dest = audioCtx.createMediaStreamDestination();
      for (const t of audioTracks) audioCtx.createMediaStreamSource(new MediaStream([t])).connect(dest);
      audioTrack = dest.stream.getAudioTracks()[0];
    }

    // The picture: as shared, or a region of it drawn onto a canvas.
    let videoTrack = display && mode !== 'audio' ? display.getVideoTracks()[0] : null;
    let crop = null;
    if (videoTrack) {
      live.srcObject = new MediaStream([videoTrack]);
      live.classList.add('playing');
      await live.play().catch(() => {});
      await new Promise((r) => (live.videoWidth ? r() : live.addEventListener('loadedmetadata', r, { once: true })));
      if (settings.get('area', 'whole') === 'region') {
        crop = await chooseRegion(live);
        if (!crop) { stopStreams(streams); live.srcObject = null; return; }
      }
    }
    await countdown();

    rec = { streams, audioCtx, chunks: [], started: performance.now(), pausedFor: 0, pausedAt: 0, mode, crop, frames: 0 };
    const vw = live.videoWidth;
    const vh = live.videoHeight;
    const area = crop ? { x: Math.round(crop.x * vw), y: Math.round(crop.y * vh), w: Math.max(2, Math.round(crop.w * vw) & ~1), h: Math.max(2, Math.round(crop.h * vh) & ~1) } : { x: 0, y: 0, w: vw, h: vh };

    if (mode === 'gif') {
      const maxW = settings.get('gifWidth', 640);
      const scale = maxW && area.w > maxW ? maxW / area.w : 1;
      const cw = Math.max(2, Math.round(area.w * scale));
      const ch = Math.max(2, Math.round(area.h * scale));
      const canvas = h('canvas');
      canvas.width = cw;
      canvas.height = ch;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      rec.gif = new GifEncoder(cw, ch);
      const every = 1000 / settings.get('gifFps', 10);
      rec.timer = setInterval(() => {
        if (rec.pausedAt) return;
        ctx.drawImage(live, area.x, area.y, area.w, area.h, 0, 0, cw, ch);
        rec.gif.addFrame(ctx.getImageData(0, 0, cw, ch).data, every / 10);
        rec.frames++;
      }, every);
    } else {
      if (videoTrack && crop) {
        const canvas = h('canvas');
        canvas.width = area.w;
        canvas.height = area.h;
        const ctx = canvas.getContext('2d');
        const fps = settings.get('fps', 30);
        rec.timer = setInterval(() => ctx.drawImage(live, area.x, area.y, area.w, area.h, 0, 0, area.w, area.h), 1000 / fps);
        videoTrack = canvas.captureStream(fps).getVideoTracks()[0];
        rec.canvasTrack = videoTrack;
      }
      const type = pickType(videoTrack ? 'video' : 'audio');
      if (!type) throw new Error('This browser cannot record that.');
      rec.type = type;
      const tracks = [videoTrack, audioTrack].filter(Boolean);
      rec.recorder = new MediaRecorder(new MediaStream(tracks), {
        mimeType: type[0], videoBitsPerSecond: videoTrack ? BITRATE[settings.get('quality', 'medium')] : undefined, audioBitsPerSecond: 160_000,
      });
      // The last piece arrives after Stop (and MP4 sends everything then): keep it on this recording.
      const chunks = rec.chunks;
      rec.recorder.addEventListener('dataavailable', (e) => { if (e.data && e.data.size) chunks.push(e.data); });
      rec.recorder.start(1000);
    }
    // Sharing stopped from the browser's own bar: the recording ends too.
    for (const s of streams) for (const t of s.getVideoTracks()) t.addEventListener('ended', () => { if (rec) stop(); });
    tickTimer();
    updateRecordButton();
  } catch (err) {
    stopStreams(streams);
    live.srcObject = null;
    rec = null;
    if (err && err.name === 'NotAllowedError') toast('Recording was not allowed (nothing was shared).', { type: 'warn' });
    else errorToast(err.message || String(err));
    updateRecordButton();
  }
}

function stopStreams(streams) {
  for (const s of streams) for (const t of s.getTracks()) t.stop();
}

function elapsed() {
  if (!rec) return 0;
  const now = rec.pausedAt || performance.now();
  return (now - rec.started - rec.pausedFor) / 1000;
}

function tickTimer() {
  if (!rec) { timer.textContent = '00:00'; return; }
  const s = Math.floor(elapsed());
  timer.textContent = `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
  status.textContent = rec.pausedAt ? 'Paused' : `Recording ${rec.mode === 'gif' ? 'a GIF' : rec.mode === 'audio' ? 'sound' : 'video'}…`;
  requestAnimationFrame(() => setTimeout(tickTimer, 250));
}

function pause() {
  if (!rec) return;
  if (rec.pausedAt) {
    rec.pausedFor += performance.now() - rec.pausedAt;
    rec.pausedAt = 0;
    if (rec.recorder && rec.recorder.state === 'paused') rec.recorder.resume();
  } else {
    rec.pausedAt = performance.now();
    if (rec.recorder && rec.recorder.state === 'recording') rec.recorder.pause();
  }
  updateRecordButton();
}

async function stop() {
  const r = rec;
  if (!r) return;
  rec = null;
  clearInterval(r.timer);
  const duration = (performance.now() - r.started - r.pausedFor - (r.pausedAt ? performance.now() - r.pausedAt : 0)) / 1000;
  let blob;
  let ext;
  if (r.gif) {
    if (!r.frames) { stopStreams(r.streams); live.srcObject = null; updateRecordButton(); return; }
    status.textContent = 'Finishing the GIF…';
    blob = new Blob([r.gif.finish()], { type: 'image/gif' });
    ext = 'gif';
  } else {
    await new Promise((res) => { r.recorder.addEventListener('stop', res, { once: true }); r.recorder.stop(); });
    const type = r.type[0].split(';')[0];
    blob = new Blob(r.chunks, { type });
    // A browser's WebM does not say how long it is: write that in, so players can seek.
    if (type.endsWith('/webm')) blob = new Blob([withDuration(new Uint8Array(await blob.arrayBuffer()), duration * 1000)], { type });
    ext = r.type[1];
  }
  stopStreams(r.streams);
  if (r.canvasTrack) r.canvasTrack.stop();
  if (r.audioCtx) r.audioCtx.close().catch(() => {});
  live.srcObject = null;
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  const item = {
    id: uid('rec'), name: `SnakeScreen_${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}.${ext}`,
    type: blob.type, size: blob.size, duration, created: Date.now(), data: blob,
  };
  try {
    await tx('readwrite', (st) => st.put(item));
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  } catch (err) {
    errorToast(`${err.message} Save it now, or it is lost when you leave.`);
  }
  recordings.unshift(item);
  selected = item;
  paintList();
  status.textContent = 'Ready';
  toast(`Recorded ${item.name}`, { timeout: 3000, action: { label: 'Save…', run: () => save(item) } });
  updateRecordButton();
}

// ---------------------------------------------------------------------------
// The list of recordings
// ---------------------------------------------------------------------------
const fmtSize = (n) => (n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} kB`);
const fmtDur = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
let previewURL = null;

function paintList() {
  list.replaceChildren(...(recordings.length ? recordings.map((r) => {
    const row = h(`div.list-item.sr-item${r === selected ? '.on' : ''}`, { tabindex: 0 },
      h('span', { html: icon(r.type.startsWith('image') ? 'image' : r.type.startsWith('audio') ? 'music' : 'video', 16) }),
      h('div.grow', h('div.sr-name', r.name), h('div.muted.sr-meta', `${fmtDur(r.duration)} · ${fmtSize(r.size)} · ${new Date(r.created).toLocaleString()}`)),
      tb({ icon: 'save', tip: 'Save…', run: () => save(r) }));
    row.addEventListener('click', () => { selected = r; paintList(); });
    row.addEventListener('keydown', (e) => { if (e.key === 'Delete') remove(r); if (e.key === 'Enter') save(r); });
    contextMenu(row, () => [
      { label: 'Save…', icon: 'save', run: () => save(r) },
      { label: 'Rename…', icon: 'pencil', run: () => rename(r) },
      { type: 'separator' },
      { label: 'Delete', icon: 'trash', danger: true, run: () => remove(r) },
    ]);
    return row;
  }) : [h('div.empty', 'Your recordings appear here.')]));
  if (previewURL) URL.revokeObjectURL(previewURL);
  previewURL = null;
  if (!selected) { preview.replaceChildren(); return; }
  previewURL = URL.createObjectURL(selected.data);
  const media = selected.type.startsWith('image') ? h('img', { src: previewURL, alt: '' })
    : selected.type.startsWith('audio') ? h('audio', { src: previewURL, controls: true })
      : h('video', { src: previewURL, controls: true, playsInline: true });
  preview.replaceChildren(media);
  refresh();
}

async function save(r) {
  try {
    const ext = r.name.split('.').pop();
    const f = await host.saveAs({ name: r.name, filters: [{ name: ext.toUpperCase(), exts: [ext] }] }, r.data);
    if (f) toast(`Saved ${f.name}`, { timeout: 2500 });
  } catch (err) {
    errorToast(err.message || String(err));
  }
}

async function rename(r) {
  const ext = r.name.split('.').pop();
  const name = await promptBox('Rename', { value: r.name.replace(/\.[^.]+$/, ''), ok: 'Rename' });
  if (!name || !name.trim()) return;
  r.name = `${name.trim()}.${ext}`;
  await tx('readwrite', (st) => st.put(r)).catch(() => {});
  paintList();
}

async function remove(r) {
  if (!(await confirmBox(`Delete “${r.name}”? (Copies you saved stay.)`, { ok: 'Delete', danger: true }))) return;
  await tx('readwrite', (st) => st.delete(r.id)).catch(() => {});
  recordings = recordings.filter((x) => x !== r);
  if (selected === r) selected = recordings[0] || null;
  paintList();
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
paintSettings();
fillMics();
try {
  recordings = (await tx('readonly', (st) => st.getAll())).sort((a, b) => b.created - a.created);
  selected = recordings[0] || null;
} catch (err) {
  errorToast(`The recordings could not be read: ${err.message || err}`);
}
paintList();
window.addEventListener('beforeunload', (e) => { if (rec) { e.preventDefault(); e.returnValue = ''; } });
window.snakeApp = { commands, recordings: () => recordings, start, stop, pause, get rec() { return rec; } };
closeMenus();
