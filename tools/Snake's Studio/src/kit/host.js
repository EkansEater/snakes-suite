// Where the app runs: inside Snake's Studio (Electron, window.snakeHost), inside
// the phone apps (window.SnakeAndroid, android/apps/studio; window.SnakeIOS, ios/)
// or in a plain browser (the online mirror). Apps only ever talk to `host`, so the
// same code works in all.
//
// A file is { id, name, ext, size, mtime, writable, dir?, url? }.
import { h, extOf, download } from './dom.js';
import { toast } from './dialogs.js';

const E = window.snakeHost || null;
// The phone apps' bridge. Android answers writes at once, iOS with a promise: both are awaited.
const A = E ? null : window.SnakeAndroid || window.SnakeIOS || null;
const IOS = !!(A && A === window.SnakeIOS);

// On the website, refuse to run inside another site's frame (so no page can dress the
// apps up and trick clicks or typing into them). A <meta> policy cannot say this.
if (!E && window.top !== window.self) {
  const a = document.createElement('a');
  a.href = location.href;
  a.target = '_top';
  a.rel = 'noopener';
  a.textContent = "Open Snake's Studio in its own tab";
  document.body.replaceChildren(a);
  throw new Error("Snake's Studio does not run inside other pages");
}
// On the website, keep a copy of the apps for offline use (dist/sw.js, see build.mjs).
// Not in the desktop or Android apps (their files are on the device already), and on
// a developer's localhost only when asked for (localStorage "snake-sw" = "1").
if (!E && !A && 'serviceWorker' in navigator &&
    (location.protocol === 'https:' || (location.hostname === 'localhost' && localStorage.getItem('snake-sw') === '1'))) {
  navigator.serviceWorker.register('../sw.js', { scope: '../' }).catch(() => {});
}
const appId = (document.documentElement.dataset.app || location.pathname.split('/').filter(Boolean).slice(-2)[0] || 'studio');

// ---------------------------------------------------------------------------
// Tiny IndexedDB wrapper (browser: recent file handles and crash recovery)
// ---------------------------------------------------------------------------
function idb() {
  if (idb.p) return idb.p;
  idb.p = new Promise((resolve, reject) => {
    const req = indexedDB.open(`snake-studio-${appId}`, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore('kv');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return idb.p;
}
async function kv(mode, fn) {
  const db = await idb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', mode);
    const req = fn(tx.objectStore('kv'));
    tx.oncomplete = () => resolve(req && req.result);
    tx.onerror = () => reject(tx.error);
  });
}
const kvGet = (k) => kv('readonly', (s) => s.get(k)).catch(() => undefined);
const kvSet = (k, v) => kv('readwrite', (s) => s.put(v, k)).catch(() => undefined);
const kvDel = (k) => kv('readwrite', (s) => s.delete(k)).catch(() => undefined);
const kvKeys = () => kv('readonly', (s) => s.getAllKeys()).catch(() => []);

// ---------------------------------------------------------------------------
// Browser implementation
// ---------------------------------------------------------------------------
const browserFiles = new Map(); // id -> { file, handle }
let browserSeq = 0;

function wrapBrowser(file, handle) {
  const id = `b${++browserSeq}`;
  browserFiles.set(id, { file, handle });
  return {
    id, name: file.name, ext: extOf(file.name), size: file.size, mtime: file.lastModified,
    writable: !!(handle && handle.createWritable), url: null,
  };
}

function acceptFrom(filters) {
  return (filters || []).flatMap((f) => f.exts.map((e) => `.${e}`)).join(',');
}

function pickWithInput({ filters, multiple, folder }) {
  return new Promise((resolve) => {
    const input = h('input', { type: 'file', accept: folder ? undefined : acceptFrom(filters), multiple: !!multiple, style: { display: 'none' } });
    if (folder) input.webkitdirectory = true;
    input.addEventListener('change', () => {
      resolve([...input.files].map((f) => wrapBrowser(f, null)));
      input.remove();
    });
    input.addEventListener('cancel', () => { resolve([]); input.remove(); });
    document.body.append(input);
    input.click();
  });
}

async function rememberHandle(handle) {
  if (!handle) return;
  const list = (await kvGet('recent')) || [];
  const out = [{ handle, name: handle.name, time: Date.now() }];
  for (const r of list) {
    try {
      if (!(await r.handle.isSameEntry(handle))) out.push(r);
    } catch {}
  }
  await kvSet('recent', out.slice(0, 20));
}

const settingsKey = `snake-studio:${appId}:settings`;
let settingsCache = {};
try { settingsCache = JSON.parse(localStorage.getItem(settingsKey) || '{}'); } catch { settingsCache = {}; }

const browser = {
  kind: 'browser',
  async init() {
    return { app: appId, name: document.title, platform: navigator.platform, files: [], recent: await this.recent(), ffmpeg: false };
  },
  async openFiles({ filters, multiple } = {}) {
    if (window.showOpenFilePicker) {
      try {
        const types = (filters || []).map((f) => ({ description: f.name, accept: { 'application/octet-stream': f.exts.map((e) => `.${e}`) } }));
        const handles = await window.showOpenFilePicker({ multiple: !!multiple, types: types.length ? types : undefined, excludeAcceptAllOption: false });
        const out = [];
        for (const hd of handles) {
          out.push(wrapBrowser(await hd.getFile(), hd));
          rememberHandle(hd);
        }
        return out;
      } catch (err) {
        if (err && err.name === 'AbortError') return [];
      }
    }
    return pickWithInput({ filters, multiple });
  },
  openFolder() { return pickWithInput({ folder: true }); },
  async read(f) {
    const rec = browserFiles.get(f.id);
    if (!rec) throw new Error('That file is not open.');
    return new Uint8Array(await rec.file.arrayBuffer());
  },
  async write(f, data) {
    const rec = browserFiles.get(f.id);
    if (rec && rec.handle && rec.handle.createWritable) {
      const w = await rec.handle.createWritable();
      await w.write(data);
      await w.close();
      rec.file = await rec.handle.getFile();
      return { ...f, size: rec.file.size, mtime: rec.file.lastModified };
    }
    download(f.name, data);
    return f;
  },
  async saveAs({ name = 'Untitled', filters = [] } = {}, data) {
    if (window.showSaveFilePicker) {
      try {
        const types = filters.map((f) => ({ description: f.name, accept: { 'application/octet-stream': f.exts.map((e) => `.${e}`) } }));
        const hd = await window.showSaveFilePicker({ suggestedName: name, types: types.length ? types : undefined });
        const w = await hd.createWritable();
        if (data !== undefined) await w.write(data);
        await w.close();
        rememberHandle(hd);
        return wrapBrowser(await hd.getFile(), hd);
      } catch (err) {
        if (err && err.name === 'AbortError') return null;
      }
    }
    if (data !== undefined) download(name, data);
    return { id: null, name, ext: extOf(name), size: 0, writable: false };
  },
  async recent() {
    const list = (await kvGet('recent')) || [];
    return list.map((r, i) => ({ key: String(i), name: r.name, dir: '', time: r.time, exists: true }));
  },
  async openRecent(key) {
    const list = (await kvGet('recent')) || [];
    const r = list[Number(key)];
    if (!r) throw new Error('That file is no longer listed.');
    if ((await r.handle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
      if ((await r.handle.requestPermission({ mode: 'readwrite' })) !== 'granted') throw new Error('Permission to open the file was not given.');
    }
    rememberHandle(r.handle);
    return wrapBrowser(await r.handle.getFile(), r.handle);
  },
  async forgetRecent(key) {
    const list = (await kvGet('recent')) || [];
    if (key === undefined) await kvSet('recent', []);
    else { list.splice(Number(key), 1); await kvSet('recent', list); }
    return this.recent();
  },
  async dropped(fileList, items) {
    const out = [];
    const handles = [];
    for (const it of items || []) {
      if (it.kind === 'file' && it.getAsFileSystemHandle) handles.push(it.getAsFileSystemHandle());
    }
    const resolved = await Promise.all(handles).catch(() => []);
    const files = [...(fileList || [])];
    files.forEach((f, i) => {
      const hd = resolved[i] && resolved[i].kind === 'file' ? resolved[i] : null;
      out.push(wrapBrowser(f, hd));
    });
    return out;
  },
  async siblings() { return []; },
  openInNewWindow: null,
  reveal() {},
  mediaURL(f) {
    const rec = browserFiles.get(f.id);
    if (!rec) return '';
    if (!rec.url) rec.url = URL.createObjectURL(rec.file);
    return rec.url;
  },
  settings: {
    get: (k, d) => (k in settingsCache ? settingsCache[k] : d),
    set: (k, v) => {
      if (v === undefined) delete settingsCache[k];
      else settingsCache[k] = v;
      try { localStorage.setItem(settingsKey, JSON.stringify(settingsCache)); } catch {}
    },
  },
  recovery: {
    put: (k, v) => kvSet(`rec:${k}`, { time: Date.now(), value: v }),
    get: (k) => kvGet(`rec:${k}`),
    list: async () => (await kvKeys()).filter((k) => String(k).startsWith('rec:')).map((k) => ({ key: String(k).slice(4), time: 0 })),
    delete: (k) => kvDel(`rec:${k}`),
  },
  async printPDF() {
    toast('Choose “Save as PDF” as the printer.');
    window.print();
    return null;
  },
  async print() { window.print(); },
  media: null,
  spell: null,
  clipboard: {
    async readImage() {
      try {
        const items = await navigator.clipboard.read();
        for (const it of items) {
          const type = it.types.find((t) => t.startsWith('image/'));
          if (type) return new Uint8Array(await (await it.getType(type)).arrayBuffer());
        }
      } catch {}
      return null;
    },
    async writeImage(png) {
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
        return true;
      } catch { return false; }
    },
  },
  win: {
    minimize() {}, toggleMaximize() {}, close() { window.close(); }, forceClose() { window.close(); },
    setTitle(t) { document.title = t; },
    setFullScreen(on) {
      if (on && !document.fullscreenElement) document.documentElement.requestFullscreen().catch(() => {});
      else if (!on && document.fullscreenElement) document.exitFullscreen().catch(() => {});
    },
    toggleFullScreen() { this.setFullScreen(!document.fullscreenElement); },
    setAlwaysOnTop() {}, setSize() {}, setProgress() {}, newWindow() { window.open(location.href, '_blank'); },
    toggleDevTools() {}, async openPage(page) { window.open(page, '_blank'); return 0; },
    async isMaximized() { return false; },
    onMaximized() { return () => {}; }, onFullScreen(cb) { const f = () => cb(!!document.fullscreenElement); document.addEventListener('fullscreenchange', f); return () => document.removeEventListener('fullscreenchange', f); },
    onFocus(cb) { const a = () => cb(true); const b = () => cb(false); window.addEventListener('focus', a); window.addEventListener('blur', b); return () => {}; },
  },
  onOpen() { return () => {}; },
  onBeforeClose(cb) {
    window.addEventListener('beforeunload', (e) => {
      if (cb.dirty && cb.dirty()) { e.preventDefault(); e.returnValue = ''; }
    });
  },
  openExternal(url) { window.open(url, '_blank', 'noopener'); },
  launch(id) { location.href = `../${id}/index.html`; },
};

// ---------------------------------------------------------------------------
// Phone implementation: the website's code, with the phone's own file pickers,
// printing and app switching (android/apps/studio in Kotlin, ios/ in Swift).
// Files the person picked are served at /file/<id>/<name> (with seeking, for
// video); saving sends the bytes over in pieces.
// ---------------------------------------------------------------------------
function android() {
  const pending = new Map();
  const listeners = new Map();
  let seq = 0;
  let closeGuard = null;
  window.__snakeReply = (id, ok, json) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    const value = json == null ? undefined : JSON.parse(json);
    if (ok) p.resolve(value);
    else p.reject(new Error(value));
  };
  window.__snakeEmit = (channel, json) => {
    for (const cb of listeners.get(channel) || []) {
      try { cb(...JSON.parse(json)); } catch (err) { console.error(err); }
    }
  };
  const call = (channel, ...args) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    A.invoke(id, channel, JSON.stringify(args));
  });
  const on = (channel, cb) => {
    if (!listeners.has(channel)) listeners.set(channel, new Set());
    listeners.get(channel).add(cb);
    return () => listeners.get(channel).delete(cb);
  };
  const fileURL = (f) => `${location.origin}/file/${encodeURIComponent(f.id)}/${encodeURIComponent(f.name)}`;
  const CHUNK = 768 * 1024;
  const base64 = (bytes) => {
    let bin = '';
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(bin);
  };
  async function write(f, data) {
    const blob = data instanceof Blob ? data : new Blob([typeof data === 'string' ? new TextEncoder().encode(data) : data]);
    const token = await A.writeBegin(f.id);
    if (!token) throw new Error(`“${f.name}” cannot be written.`);
    try {
      for (let i = 0; i < blob.size; i += CHUNK) {
        const part = new Uint8Array(await blob.slice(i, i + CHUNK).arrayBuffer());
        if (!(await A.writeChunk(token, base64(part)))) throw new Error(`Writing “${f.name}” failed.`);
      }
    } catch (err) {
      await A.writeEnd(token, false);
      throw err;
    }
    const done = JSON.parse(await A.writeEnd(token, true));
    if (done.error) throw new Error(done.error);
    return { ...f, size: done.size, mtime: done.mtime };
  }
  // Android's back button: first close what is open on top, then leave (asking about unsaved work).
  window.__snakeBack = () => {
    const top = document.querySelector('.menu, .palette, .overlay, .drawer-scrim');
    if (top) {
      (document.activeElement || document.body).dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      if (document.body.contains(top) && top.classList.contains('drawer-scrim')) top.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true }));
      return 'handled';
    }
    (async () => {
      const ok = closeGuard ? await closeGuard.ask() : true;
      if (ok) call('win:close');
    })();
    return 'asking';
  };
  return {
    ...browser,
    kind: IOS ? 'ios' : 'android',
    async init() {
      const info = await call('app:init', appId);
      return { name: document.title, ffmpeg: false, ...info };
    },
    openFiles: ({ filters, multiple } = {}) => call('file:open', { filters: filters || [], multiple: !!multiple }),
    openFolder: ({ filters } = {}) => call('file:openFolder', { filters: filters || [] }),
    async read(f) {
      const r = await fetch(fileURL(f));
      if (!r.ok) throw new Error(`“${f.name}” could not be read.`);
      return new Uint8Array(await r.arrayBuffer());
    },
    write,
    async saveAs({ name = 'Untitled', filters = [] } = {}, data) {
      const f = await call('file:saveAs', { name, filters });
      if (!f) return null;
      return data === undefined ? f : write(f, data);
    },
    recent: () => call('file:recent'),
    openRecent: (key) => call('file:openRecent', key),
    forgetRecent: (key) => call('file:forgetRecent', key === undefined ? null : key),
    async dropped() { return []; },
    mediaURL: fileURL,
    async printPDF() { await call('print', document.title); return null; },
    async print() { await call('print', document.title); },
    win: {
      ...browser.win,
      close() { call('win:close'); },
      forceClose() { call('win:close'); },
      setTitle(t) { document.title = t; call('win:title', t); },
      setFullScreen(on) { call('win:fullScreen', !!on); },
      toggleFullScreen() { call('win:fullScreen', null); },
      onFullScreen: (cb) => on('win:fullScreen', cb),
      newWindow() {},
      async openPage() { return 0; },
    },
    onOpen: (cb) => on('file:opened', cb),
    onBeforeClose(cb) { closeGuard = cb; },
    openExternal: (url) => call('openExternal', String(url)),
    launch: (id) => call('launch', id),
  };
}

// ---------------------------------------------------------------------------
// Electron implementation: a thin layer over the preload bridge
// ---------------------------------------------------------------------------
function electron() {
  let settings = {};
  return {
    kind: 'electron',
    async init() {
      const [info, s] = await Promise.all([E.init(), E.store.get()]);
      settings = s || {};
      return info;
    },
    openFiles: (opts = {}) => E.file.open(opts),
    openFolder: (opts = {}) => E.file.open({ ...opts, folder: true }),
    read: (f) => E.file.read(f.id),
    write: (f, data) => E.file.write(f.id, data),
    saveAs: (opts, data) => E.file.saveAs(opts, data),
    recent: () => E.file.recent(),
    openRecent: (key) => E.file.openRecent(key),
    forgetRecent: (key) => E.file.forgetRecent(key),
    dropped: (files) => E.file.dropped(files),
    siblings: (f, exts) => E.file.siblings(f.id, exts),
    reveal: (f) => E.file.reveal(f.id),
    openInNewWindow: (f) => E.file.openInNewWindow(f.id),
    openWithSystem: (f) => E.file.openWithSystem(f.id),
    mediaURL: (f) => f.url,
    liveURL: (f, params) => `snake-media://live/${f.id}/${encodeURIComponent(f.name)}?${new URLSearchParams(params)}`,
    settings: {
      get: (k, d) => (k in settings ? settings[k] : d),
      set: (k, v) => {
        if (v === undefined) delete settings[k];
        else settings[k] = v;
        E.store.set(k, v).catch(() => {});
      },
    },
    recovery: E.recovery,
    printPDF: (opts) => E.print.pdf(opts),
    print: () => E.print.print(),
    media: E.media,
    spell: E.spell,
    clipboard: E.clipboard,
    win: E.win,
    onOpen: (cb) => E.file.onOpened(cb),
    onBeforeClose(cb) {
      E.onBeforeClose(async () => {
        const ok = await cb.ask();
        if (ok) E.win.forceClose();
      });
    },
    openExternal: (url) => E.shell.openExternal(url),
    launch: (id) => E.launch(id),
  };
}

export const host = E ? electron() : A ? android() : browser;
export const inElectron = !!E;
/** Inside the Android or iOS app (not the website). */
export const inPhoneApp = !!A;
export const platform = E ? null : A ? (IOS ? 'ios' : 'android') : 'web';

/** Read a file as text, guessing UTF-8/UTF-16 from its byte order mark. */
export async function readText(f) {
  const bytes = await host.read(f);
  return decodeText(bytes);
}

export function decodeText(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}
