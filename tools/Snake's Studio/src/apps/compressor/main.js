// Snake's Compressor for the browser and the iPhone: lossless .snake archives, the same
// format as the desktop and Android apps (engine.js). Make one from files and folders,
// or open one: see what is in it, check every file, extract it. Nothing is uploaded.
import { h, uid, clamp } from '../../kit/dom.js';
import { icon } from '../../kit/icons.js';
import { host } from '../../kit/host.js';
import * as commands from '../../kit/commands.js';
import { createShell, tb, sep, select, refresh } from '../../kit/shell.js';
import { contextMenu, closeMenus } from '../../kit/menu.js';
import { toast, errorToast, modal, promptBox } from '../../kit/dialogs.js';
import { writeZip } from '../../kit/zip.js';
import { pack, readAny as read, LEVELS } from './engine.js';

const settings = host.settings;
const shell = await createShell({
  id: 'compressor', name: "Snake's Compressor",
  menus: [
    { label: '&File', items: () => [I('sc.addFiles'), I('sc.addFolder'), I('sc.openArchive'), { type: 'separator' }, I('sc.clear')] },
    { label: '&Archive', items: () => [I('sc.compress'), { type: 'separator' }, I('sc.test'), I('sc.extract'), I('sc.zip')] },
    { label: '&View', items: () => [I('view.themeDark'), I('view.themeLight'), I('view.themeSystem'), I('view.fullscreen')] },
    { label: '&Help', items: () => [I('app.palette'), I('app.shortcuts'), { type: 'separator' }, I('app.about')] },
  ],
  about: 'Lossless .snake archives: what you unpack is bit-for-bit what you packed, and every file is checksummed to prove it. '
    + 'The same format as the desktop and Android Compressors (zstd and BLAKE3, the same code). Nothing is uploaded.',
});
const I = (id, extra) => commands.item(id, extra);

/** What goes into a new archive: { path, kind, file?, mtime } with paths relative to the archive. */
let items = [];
/** The archive that is open: { file, entries: [...], checked: null | { ok, damaged } } */
let opened = null;
let busy = null; // { label, done, total, abort }

// ---------------------------------------------------------------------------
// Adding files and folders (with their structure)
// ---------------------------------------------------------------------------
const mtimeOf = (f) => Math.floor((f.lastModified || Date.now()) / 1000);
function addFiles(fileList, base = '') {
  for (const f of fileList) {
    const rel = (f.webkitRelativePath || f.relPath || f.name).replace(/^\/+/, '');
    const path = base ? `${base}/${rel}` : rel;
    const parts = path.split('/');
    for (let i = 1; i < parts.length; i++) {
      const dir = parts.slice(0, i).join('/');
      if (!items.some((it) => it.path === dir)) items.push({ path: dir, kind: 'dir', mtime: mtimeOf(f) });
    }
    if (!items.some((it) => it.path === path)) items.push({ path, kind: 'file', file: f, mtime: mtimeOf(f) });
  }
  items.sort((a, b) => a.path.localeCompare(b.path));
  if (opened && items.length) opened = null;
  paint();
}

function pick({ folder = false } = {}) {
  return new Promise((done) => {
    const input = h('input', { type: 'file', multiple: true, style: { display: 'none' } });
    if (folder) input.webkitdirectory = true;
    input.addEventListener('change', () => { done([...input.files]); input.remove(); });
    input.addEventListener('cancel', () => { done([]); input.remove(); });
    document.body.append(input);
    input.click();
  });
}

/** Files and folders dropped from the computer, folders walked. */
async function dropped(dt) {
  const out = [];
  const entries = [...dt.items].map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
  if (!entries.length) return [...dt.files];
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const f = await new Promise((r, j) => entry.file(r, j));
      f.relPath = prefix + f.name;
      out.push(f);
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      let batch;
      let any = false;
      do {
        batch = await new Promise((r, j) => reader.readEntries(r, j));
        for (const e of batch) { any = true; await walk(e, `${prefix}${entry.name}/`); }
      } while (batch.length);
      if (!any) out.push({ emptyDir: `${prefix}${entry.name}` });
    }
  };
  for (const e of entries) await walk(e, '');
  return out;
}

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
const fmt = (n) => (n >= 1 << 30 ? `${(n / 2 ** 30).toFixed(2)} GB` : n >= 1 << 20 ? `${(n / 2 ** 20).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} kB` : `${n} B`);
const levelSel = select({ options: [{ value: 'fast', label: 'Fast' }, { value: 'normal', label: 'Normal' }, { value: 'small', label: 'Smallest (slow)' }], value: settings.get('level', 'normal'), onChange: (v) => settings.set('level', v) });
const nameInput = h('input.input.sc-name', { spellcheck: false, placeholder: 'archive name' });
const filter = h('input.input.sc-filter', { type: 'search', placeholder: 'Find in the list', spellcheck: false });
filter.addEventListener('input', () => paintList());

const C = (id, label, keys, run, extra = {}) => ({ id, label, keys, run, ...extra });
commands.register(
  C('sc.addFiles', 'Add Files…', 'Ctrl+O', async () => addFiles(await pick()), { icon: 'plus', category: 'File', when: () => !busy }),
  C('sc.addFolder', 'Add a Folder…', 'Ctrl+Shift+O', async () => addFiles(await pick({ folder: true })), { icon: 'folder', category: 'File', when: () => !busy && 'webkitdirectory' in HTMLInputElement.prototype }),
  C('sc.openArchive', 'Open an Archive…', 'Ctrl+Alt+O', async () => { const [f] = await pickArchive(); if (f) openArchive(f); }, { icon: 'open', category: 'File', when: () => !busy }),
  C('sc.clear', 'Start Over', null, () => { items = []; opened = null; paint(); }, { icon: 'trash', category: 'File', when: () => !busy && (items.length > 0 || !!opened) }),
  C('sc.compress', 'Compress', 'Ctrl+Enter', () => compress(), { icon: 'play', category: 'Archive', when: () => !busy && items.some((i) => i.kind === 'file' || i.kind === 'dir') }),
  C('sc.test', 'Check Every File', 'Ctrl+T', () => test(), { icon: 'check', category: 'Archive', when: () => !busy && !!opened }),
  C('sc.extract', 'Extract Everything…', 'Ctrl+E', () => extractAll(), { icon: 'export', category: 'Archive', when: () => !busy && !!opened }),
  C('sc.zip', 'Save Everything as a ZIP…', null, () => extractZip(), { icon: 'download', category: 'Archive', when: () => !busy && !!opened }),
  C('sc.cancel', 'Stop', 'Escape', () => busy && busy.abort.abort(), { icon: 'stop', category: 'Archive', when: () => !!busy }),
);
function pickArchive() {
  return new Promise((done) => {
    const input = h('input', { type: 'file', accept: '.snake,.zip', style: { display: 'none' } });
    input.addEventListener('change', () => { done([...input.files]); input.remove(); });
    input.addEventListener('cancel', () => { done([]); input.remove(); });
    document.body.append(input);
    input.click();
  });
}

const head = h('div.sc-head');
const list = h('div.sc-list');
const bar = h('div.sc-progress.hidden', h('div.progress', h('div')), h('span.muted'), tb('sc.cancel'));
const welcome = h('div.sc-welcome',
  h('div.sc-cards',
    h('button.sc-card', { onclick: () => commands.run('sc.addFiles') }, h('span', { html: icon('plus', 34) }), h('b', 'Make an archive'), h('span.muted', 'Add files or folders, then Compress')),
    h('button.sc-card', { onclick: () => commands.run('sc.openArchive') }, h('span', { html: icon('open', 34) }), h('b', 'Open an archive'), h('span.muted', 'See, check and extract a .snake or ZIP file'))),
  h('p.muted', 'Or drop files, folders or an archive (.snake or ZIP) here. .snake archives work both ways with the desktop and Android Compressors.'));
shell.main.append(h('div.sc-root', welcome, head, bar, list));
shell.showStatus(true);
const status = h('span.item');
shell.statusLeft.append(status);

function paint() {
  welcome.classList.toggle('hidden', !!(items.length || opened));
  head.replaceChildren();
  if (opened) {
    const c = opened.checked;
    const entries = opened.entries;
    const files = entries.filter((e) => e.kind === 'file');
    head.append(
      h('div.sc-title', h('span', { html: icon('file', 22) }), h('div.grow', h('b', opened.file.name),
        h('div.muted', `${files.length} file${files.length === 1 ? '' : 's'} · ${fmt(files.reduce((a, e) => a + (e.size || 0), 0))} unpacked · ${fmt(opened.file.size)} archive`))),
      c ? h(`div.sc-verdict${c.ok ? '.ok' : '.bad'}`, h('span', { html: icon(c.ok ? 'check' : 'warning', 16) }), c.ok ? 'Every file checks out: identical to what was packed.' : `${c.damaged.length} damaged file${c.damaged.length === 1 ? '' : 's'}: copy the archive again.`) : null,
      h('div.sc-actions', tb('sc.test', { showLabel: true }), tb('sc.extract', { showLabel: true }), tb('sc.zip', { showLabel: true }), h('div.grow'), filter));
  } else if (items.length) {
    const files = items.filter((i) => i.kind === 'file');
    if (!nameInput.value) nameInput.value = `${(items[0].path.split('/')[0] || 'Archive').replace(/\.[^.]+$/, '')}`;
    head.append(
      h('div.sc-title', h('span', { html: icon('plus', 22) }), h('div.grow', h('b', 'New archive'), h('div.muted', `${files.length} file${files.length === 1 ? '' : 's'} · ${fmt(files.reduce((a, i) => a + i.file.size, 0))}`))),
      h('div.sc-actions', h('label.muted', 'Name'), nameInput, h('span.muted', '.snake'), h('label.muted', 'Compression'), levelSel,
        tb('sc.compress', { showLabel: true }), sep(), tb('sc.addFiles'), tb('sc.addFolder'), h('div.grow'), filter));
  }
  paintList();
  refresh();
}

function paintList() {
  const q = filter.value.trim().toLowerCase();
  const rows = opened ? opened.entries : items;
  const shown = rows.filter((r) => !q || r.path.toLowerCase().includes(q)).slice(0, 5000);
  list.replaceChildren(...shown.map((r) => {
    const depth = r.path.split('/').length - 1;
    const row = h(`div.sc-row${r.damaged ? '.bad' : ''}`, { style: { paddingLeft: `${10 + depth * 16}px` } },
      h('span.sc-ic', { html: icon(r.kind === 'dir' ? 'folder' : r.kind === 'symlink' ? 'link' : 'file', 15) }),
      h('span.grow.sc-path', r.path.split('/').pop()),
      r.kind === 'symlink' ? h('span.muted', `→ ${r.target}`) : null,
      r.kind === 'file' ? h('span.muted.sc-size', fmt(opened ? r.size || 0 : r.file.size)) : null,
      r.damaged ? h('span.sc-bad', 'damaged') : r.verified ? h('span.sc-good', { html: icon('check', 13) }) : null);
    if (opened && r.kind === 'file') row.addEventListener('dblclick', () => saveOne(r));
    contextMenu(row, () => (opened
      ? [{ label: 'Save this file…', icon: 'save', disabled: r.kind !== 'file' || !!busy, run: () => saveOne(r) }]
      : [{ label: 'Take out of the archive', icon: 'x', run: () => { items = items.filter((x) => x !== r && !x.path.startsWith(`${r.path}/`)); paint(); } }]));
    return row;
  }), ...(rows.length > shown.length && !q ? [h('div.muted.sc-more', `…and ${rows.length - shown.length} more (use Find)`)] : []));
  const parts = [];
  if (opened) parts.push(`${opened.entries.length} entries`);
  else if (items.length) parts.push(`${items.length} entries`);
  status.textContent = busy ? busy.label : parts.join(' · ') || 'Make or open an archive';
}

function startBusy(label) {
  const abort = new AbortController();
  busy = { label, abort };
  bar.classList.remove('hidden');
  bar.querySelector('.progress > div').style.width = '0';
  paint();
  return abort.signal;
}
let lastPaint = 0;
function showProgress(done, total, started) {
  const now = performance.now();
  if (now - lastPaint < 100 && done < total) return;
  lastPaint = now;
  const p = total ? done / total : 0;
  bar.querySelector('.progress > div').style.width = `${clamp(p * 100, 0, 100)}%`;
  const secs = (now - started) / 1000;
  const speed = secs > 0.5 ? ` · ${fmt(done / secs)}/s` : '';
  bar.querySelector('span').textContent = `${busy.label} ${Math.round(p * 100)}%${speed}`;
}
function endBusy() {
  busy = null;
  bar.classList.add('hidden');
  paint();
}

// ---------------------------------------------------------------------------
// Making an archive
// ---------------------------------------------------------------------------
async function compress() {
  const name = `${(nameInput.value.trim() || 'Archive').replace(/[/\\:]/g, '_')}.snake`;
  // Where the browser can write a file as it goes, the archive never has to fit in memory.
  let writable = null;
  if (window.showSaveFilePicker && host.kind === 'browser') {
    try {
      const hd = await window.showSaveFilePicker({ suggestedName: name, types: [{ description: 'Snake archive', accept: { 'application/octet-stream': ['.snake'] } }] });
      writable = await hd.createWritable();
    } catch (err) { if (err.name === 'AbortError') return; }
  }
  const signal = startBusy('Compressing…');
  const parts = [];
  let outSize = 0;
  const started = performance.now();
  try {
    const sink = async (bytes) => { outSize += bytes.length; if (writable) await writable.write(bytes); else parts.push(bytes); };
    const r = await pack(items, { level: LEVELS[settings.get('level', 'normal')], sink, signal, progress: (d, t) => showProgress(d, t, started) });
    if (writable) await writable.close();
    else {
      const f = await host.saveAs({ name, filters: [{ name: 'Snake archive', exts: ['snake'] }] }, new Blob(parts));
      if (!f) { toast('Not saved.', { type: 'warn' }); return; }
    }
    const secs = (performance.now() - started) / 1000;
    toast(`${name}: ${r.files} file${r.files === 1 ? '' : 's'}, ${fmt(r.bytes)} → ${fmt(outSize)} (${r.bytes ? Math.round((outSize / r.bytes) * 100) : 100}%) in ${secs.toFixed(1)} s`, { timeout: 6000 });
  } catch (err) {
    if (writable) await writable.abort().catch(() => {});
    if (err.name !== 'AbortError') errorToast(err.message || String(err));
  } finally {
    endBusy();
  }
}

// ---------------------------------------------------------------------------
// An archive
// ---------------------------------------------------------------------------
async function openArchive(file) {
  items = [];
  opened = { file, entries: [], checked: null };
  const signal = startBusy('Reading the archive…');
  const started = performance.now();
  try {
    const byPath = new Map();
    const r = await read(file, {
      signal,
      progress: (d, t) => showProgress(d, t, started),
      entry: (e) => { opened.entries.push(e); byPath.set(e.path, e); return null; },
      finished: (e, { size, ok }) => { e.size = size; e.verified = ok; e.damaged = !ok; },
    });
    opened.checked = { ok: !r.damaged.length, damaged: r.damaged };
    const unsafe = opened.entries.filter((e) => !e.safe);
    if (unsafe.length) toast(`${unsafe.length} entr${unsafe.length === 1 ? 'y has' : 'ies have'} a name that could write outside the folder: they are left out when extracting.`, { type: 'warn', timeout: 8000 });
  } catch (err) {
    if (err.name !== 'AbortError') errorToast(err.message || String(err));
    if (!opened.entries.length) opened = null;
  } finally {
    endBusy();
  }
}

async function test() {
  if (!opened) return;
  const signal = startBusy('Checking every file…');
  const started = performance.now();
  try {
    const byPath = new Map(opened.entries.map((e) => [e.path, e]));
    const r = await read(opened.file, { signal, progress: (d, t) => showProgress(d, t, started), finished: (e, { ok }) => { const m = byPath.get(e.path); if (m) { m.verified = ok; m.damaged = !ok; } } });
    opened.checked = { ok: !r.damaged.length, damaged: r.damaged };
    if (r.damaged.length) errorToast(`${r.damaged.length} file${r.damaged.length === 1 ? ' is' : 's are'} damaged.`);
    else toast(`All ${r.files} files check out.`, { timeout: 3000 });
  } catch (err) {
    if (err.name !== 'AbortError') { opened.checked = { ok: false, damaged: [] }; errorToast(err.message || String(err)); }
  } finally {
    endBusy();
  }
}

/** Extract into a folder chosen on this computer (Chrome, Edge), or else as a ZIP. */
async function extractAll() {
  if (!opened) return;
  if (!(window.showDirectoryPicker && host.kind === 'browser')) { extractZip(); return; }
  let root;
  try { root = await window.showDirectoryPicker({ mode: 'readwrite' }); } catch { return; }
  const signal = startBusy('Extracting…');
  const started = performance.now();
  const dirOf = async (path, create = true) => {
    let d = root;
    for (const p of path.split('/').filter(Boolean)) d = await d.getDirectoryHandle(p, { create });
    return d;
  };
  let skipped = 0;
  let w = null;
  try {
    const r = await read(opened.file, {
      signal, progress: (d, t) => showProgress(d, t, started),
      entry: async (e) => {
        if (!e.safe || e.kind === 'symlink') { skipped++; return null; }
        if (e.kind === 'dir') { await dirOf(e.path); return null; }
        const parts = e.path.split('/');
        const dir = await dirOf(parts.slice(0, -1).join('/'));
        const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
        w = await fh.createWritable();
        return (data) => w.write(data);
      },
      finished: async () => { if (w) { await w.close(); w = null; } },
    });
    toast(`Extracted ${r.files} file${r.files === 1 ? '' : 's'}${skipped ? ` (${skipped} left out: links or unsafe names)` : ''}${r.damaged.length ? ` — ${r.damaged.length} damaged` : ''}.`, { timeout: 5000, type: r.damaged.length ? 'warn' : 'info' });
  } catch (err) {
    if (w) await w.abort().catch(() => {});
    if (err.name !== 'AbortError') errorToast(err.message || String(err));
  } finally {
    endBusy();
  }
}

async function extractZip() {
  if (!opened) return;
  const signal = startBusy('Extracting…');
  const started = performance.now();
  const files = [];
  try {
    await read(opened.file, {
      signal, progress: (d, t) => showProgress(d, t, started),
      entry: (e) => {
        if (!e.safe || e.kind !== 'file') return null;
        const parts = [];
        files.push({ name: e.path, parts });
        return (data) => { parts.push(data); };
      },
    });
    const zipped = await writeZip(files.map((f) => {
      const n = f.parts.reduce((a, p) => a + p.length, 0);
      const data = new Uint8Array(n);
      let o = 0;
      for (const p of f.parts) { data.set(p, o); o += p.length; }
      return { name: f.name, data };
    }));
    const f = await host.saveAs({ name: opened.file.name.replace(/\.(snake|zip)$/i, '') + '.zip', filters: [{ name: 'ZIP', exts: ['zip'] }] }, zipped);
    if (f) toast(`Saved ${f.name}`, { timeout: 2500 });
  } catch (err) {
    if (err.name !== 'AbortError') errorToast(err.message || String(err));
  } finally {
    endBusy();
  }
}

async function saveOne(target) {
  const signal = startBusy(`Extracting ${target.path.split('/').pop()}…`);
  const started = performance.now();
  const parts = [];
  try {
    await read(opened.file, { signal, progress: (d, t) => showProgress(d, t, started), entry: (e) => (e.path === target.path ? (data) => { parts.push(data); } : null) });
    const name = target.path.split('/').pop();
    const f = await host.saveAs({ name, filters: [] }, new Blob(parts));
    if (f) toast(`Saved ${f.name}`, { timeout: 2500 });
  } catch (err) {
    if (err.name !== 'AbortError') errorToast(err.message || String(err));
  } finally {
    endBusy();
  }
}

// Drop: an archive opens; anything else goes into a new archive.
window.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
window.addEventListener('drop', async (e) => {
  if (![...e.dataTransfer.types].includes('Files') || busy) return;
  e.preventDefault();
  const got = await dropped(e.dataTransfer);
  const real = got.filter((f) => !f.emptyDir);
  if (real.length === 1 && /\.(snake|zip)$/i.test(real[0].name) && !items.length) { openArchive(real[0]); return; }
  for (const d of got.filter((f) => f.emptyDir)) if (!items.some((i) => i.path === d.emptyDir)) items.push({ path: d.emptyDir, kind: 'dir', mtime: Math.floor(Date.now() / 1000) });
  addFiles(real);
});

// A .snake or ZIP file opened with the app (the iPhone's Files app, "Open in…").
async function openGiven(files) {
  const f = files.find((x) => /\.(snake|zip)$/i.test(x.name));
  if (!f || busy) return;
  try {
    openArchive(f instanceof Blob ? f : new File([await host.read(f)], f.name));
  } catch (err) {
    errorToast(err.message || String(err));
  }
}
host.onOpen(openGiven);

paint();
openGiven((shell.info && shell.info.files) || []);
window.snakeApp = { commands, addFiles, openArchive, get items() { return items; }, get opened() { return opened; }, pack, read };
closeMenus();
