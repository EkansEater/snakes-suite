// Snake's Code in a browser (the website and the iPhone app): the window.snake API that
// src/main/preload.js gives the editor on the desktop, here on the browser's own storage.
//
//   /My files        a folder that lives in this browser (the Origin Private File System)
//   /<folder>        a real folder you opened (Chrome and Edge can open folders and files
//                    where they are; other browsers import a copy into My files)
//   /.config         settings.json, keybindings.json, state.json
//
// There is no terminal, git or running programs in a browser: those say so. Files go out
// with Download (the explorer's menu, File → Download) and come in with Upload.
(() => {
  const listeners = new Map();
  const on = (ch) => (cb) => {
    if (!listeners.has(ch)) listeners.set(ch, new Set());
    listeners.get(ch).add(cb);
    return () => listeners.get(ch).delete(cb);
  };
  const emit = (ch, ...args) => { for (const cb of listeners.get(ch) || []) { try { cb(...args); } catch (e) { console.error(e); } } };

  const MY = '/My files';
  const CONFIG = '/.config';
  const IGNORED_DIRS = new Set(['.trash', '.git', 'node_modules', '.hg', '.svn', '__pycache__', '.DS_Store', 'dist', 'build', 'target', '.next', '.cache', '.venv', 'venv']);
  const fail = (code, msg) => Object.assign(new Error(`${code}: ${msg}`), { code });

  // -------------------------------------------------------------------------
  // Remembering opened folders and files (their handles live in IndexedDB)
  // -------------------------------------------------------------------------
  const db = new Promise((resolve, reject) => {
    const r = indexedDB.open('snakes-code-web', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('mounts');
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  const idb = async (mode, fn) => {
    const d = await db;
    return new Promise((resolve, reject) => {
      const t = d.transaction('mounts', mode);
      const req = fn(t.objectStore('mounts'));
      t.oncomplete = () => resolve(req && req.result);
      t.onerror = () => reject(t.error);
    });
  };

  /** name -> FileSystemDirectoryHandle | FileSystemFileHandle */
  const mounts = new Map();
  let opfs = null;
  const ready = (async () => {
    opfs = await navigator.storage.getDirectory();
    mounts.set('My files', await opfs.getDirectoryHandle('files', { create: true }));
    mounts.set('.config', await opfs.getDirectoryHandle('config', { create: true }));
    try {
      const keys = await idb('readonly', (s) => s.getAllKeys());
      const vals = await idb('readonly', (s) => s.getAll());
      keys.forEach((k, i) => { if (!mounts.has(k)) mounts.set(k, vals[i]); });
    } catch { /* nothing remembered */ }
    if (navigator.storage.persist) navigator.storage.persist().catch(() => {});
  })();

  function mountName(wanted) {
    const clean = wanted.replace(/[/\\]/g, '_') || 'Folder';
    let name = clean;
    for (let n = 2; mounts.has(name) || name === 'My files' || name === '.config'; n++) name = `${clean} (${n})`;
    return name;
  }
  async function mount(handle) {
    for (const [k, h] of mounts) if (h.isSameEntry && (await h.isSameEntry(handle).catch(() => false))) return `/${k}`;
    const name = mountName(handle.name);
    mounts.set(name, handle);
    await idb('readwrite', (s) => s.put(handle, name)).catch(() => {});
    return `/${name}`;
  }

  // -------------------------------------------------------------------------
  // Paths
  // -------------------------------------------------------------------------
  const split = (p) => String(p || '').split('/').filter(Boolean);
  const join = (...parts) => `/${parts.flatMap(split).join('/')}`;
  const parent = (p) => join(...split(p).slice(0, -1));
  const base = (p) => split(p).pop() || '';

  /** Ask again for a folder the browser forgot it may use (after a restart). */
  async function allowed(handle) {
    if (!handle.queryPermission) return true;
    if ((await handle.queryPermission({ mode: 'readwrite' })) === 'granted') return true;
    askAgain(handle);
    throw fail('EACCES', `Snake's Code may no longer open “${handle.name}”. Press “Allow” at the top of the window.`);
  }

  /** { dir, name, handle?, kind } for a path: the handle of the entry, or of its parent. */
  async function resolve(path, { create = null } = {}) {
    await ready;
    const parts = split(path);
    if (!parts.length) return { root: true };
    const top = mounts.get(parts[0]);
    if (!top) throw fail('ENOENT', `no such file or directory, '${path}'`);
    if (top.kind === 'directory') await allowed(top);
    if (parts.length === 1) return { handle: top, parentHandle: null, name: parts[0] };
    if (top.kind !== 'directory') throw fail('ENOTDIR', `not a directory, '${path}'`);
    let dir = top;
    for (let i = 1; i < parts.length - 1; i++) {
      try { dir = await dir.getDirectoryHandle(parts[i], { create: create === 'parents' }); } catch (e) { throw notFound(e, path); }
    }
    const name = parts[parts.length - 1];
    let handle = null;
    try { handle = await dir.getFileHandle(name); } catch {
      try { handle = await dir.getDirectoryHandle(name); } catch { handle = null; }
    }
    return { handle, parentHandle: dir, name };
  }
  const notFound = (e, path) => (e && (e.name === 'NotFoundError' || e.name === 'TypeMismatchError') ? fail('ENOENT', `no such file or directory, '${path}'`) : e);

  async function entryOf(path) {
    const r = await resolve(path);
    if (r.root) return { root: true };
    if (!r.handle) throw fail('ENOENT', `no such file or directory, '${path}'`);
    return r;
  }

  // -------------------------------------------------------------------------
  // File system
  // -------------------------------------------------------------------------
  const isBinary = (u8) => { for (let i = 0; i < Math.min(u8.length, 8000); i++) if (u8[i] === 0) return true; return false; };

  async function readDir(path) {
    const r = await entryOf(path);
    if (r.root) return [...mounts.keys()].filter((k) => k !== '.config').map((k) => ({ name: k, path: `/${k}`, isDir: mounts.get(k).kind === 'directory', isSymlink: false }));
    if (r.handle.kind !== 'directory') throw fail('ENOTDIR', `not a directory, '${path}'`);
    const out = [];
    for await (const [name, h] of r.handle.entries()) out.push({ name, path: join(path, name), isDir: h.kind === 'directory', isSymlink: false });
    return out;
  }

  async function bytesOf(path) {
    const r = await entryOf(path);
    if (r.root || r.handle.kind !== 'file') throw fail('EISDIR', 'illegal operation on a directory');
    const f = await r.handle.getFile();
    return { file: f, bytes: new Uint8Array(await f.arrayBuffer()) };
  }

  async function readFile(path, opts = {}) {
    const r = await entryOf(path);
    if (r.root || r.handle.kind !== 'file') throw fail('EISDIR', 'illegal operation on a directory, read');
    const f = await r.handle.getFile();
    if (f.size > 64 * 1024 * 1024 && !opts.force) return { tooLarge: true, size: f.size };
    const bytes = new Uint8Array(await f.arrayBuffer());
    if (!opts.force && isBinary(bytes)) return { binary: true, size: f.size };
    let text = new TextDecoder('utf-8').decode(bytes);
    let bom = false;
    if (text.charCodeAt(0) === 0xfeff) { text = text.slice(1); bom = true; }
    return { content: text, size: f.size, mtime: f.lastModified, bom };
  }

  async function writeBytes(path, data) {
    const r = await resolve(path, { create: 'parents' });
    if (r.root) throw fail('EISDIR', 'illegal operation on a directory');
    let handle = r.handle;
    if (!handle) handle = await r.parentHandle.getFileHandle(r.name, { create: true });
    if (handle.kind !== 'file') throw fail('EISDIR', `illegal operation on a directory, open '${path}'`);
    if (handle.queryPermission && (await handle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
      if ((await handle.requestPermission({ mode: 'readwrite' }).catch(() => 'denied')) !== 'granted') throw fail('EACCES', `permission denied, open '${path}'`);
    }
    const w = await handle.createWritable();
    await w.write(data);
    await w.close();
    changed(path);
    return (await handle.getFile()).lastModified;
  }

  async function writeFile(path, content, opts = {}) {
    const mtime = await writeBytes(path, new TextEncoder().encode((opts.bom ? '\ufeff' : '') + content));
    return { mtime };
  }

  async function stat(path) {
    try {
      const r = await entryOf(path);
      if (r.root) return { exists: true, isDir: true, size: 0, mtime: 0, ctime: 0 };
      if (r.handle.kind === 'directory') return { exists: true, isDir: true, size: 0, mtime: 0, ctime: 0 };
      const f = await r.handle.getFile();
      return { exists: true, isDir: false, size: f.size, mtime: f.lastModified, ctime: f.lastModified };
    } catch (e) {
      if (e.code === 'EACCES') throw e;
      return { exists: false };
    }
  }

  async function mkdir(path) {
    const parts = split(path);
    let dir = mounts.get(parts[0]);
    if (!dir) throw fail('ENOENT', `no such file or directory, mkdir '${path}'`);
    await allowed(dir);
    for (const p of parts.slice(1)) dir = await dir.getDirectoryHandle(p, { create: true });
    changed(path);
  }

  async function createFile(path) {
    const r = await resolve(path, { create: 'parents' });
    if (r.handle) throw fail('EEXIST', `file already exists, open '${path}'`);
    await r.parentHandle.getFileHandle(r.name, { create: true });
    changed(path);
  }

  async function copyTo(from, to) {
    const src = await entryOf(from);
    if (src.handle.kind === 'file') {
      const f = await src.handle.getFile();
      await writeBytes(to, await f.arrayBuffer());
      return;
    }
    await mkdir(to);
    for await (const [name] of src.handle.entries()) await copyTo(join(from, name), join(to, name));
  }

  async function copy(from, to) {
    if ((await stat(to)).exists) throw fail('EEXIST', `file already exists, cp '${from}' -> '${to}'`);
    await copyTo(from, to);
    changed(to);
  }

  async function remove(path) {
    const parts = split(path);
    if (parts.length === 1) {
      // A top folder: forget it (its files stay where they are), except My files.
      if (parts[0] === 'My files' || parts[0] === '.config') throw fail('EPERM', 'operation not permitted');
      mounts.delete(parts[0]);
      await idb('readwrite', (s) => s.delete(parts[0])).catch(() => {});
      changed('/');
      return;
    }
    const r = await entryOf(path);
    await r.parentHandle.removeEntry(r.name, { recursive: true });
    changed(path);
  }

  async function rename(from, to) {
    const src = await entryOf(from);
    if (src.handle.move && parent(from) && split(from)[0] === split(to)[0]) {
      try {
        const dest = await resolve(to, { create: 'parents' });
        await src.handle.move(dest.parentHandle, dest.name);
        changed(from);
        changed(to);
        return;
      } catch { /* fall back to copy and delete */ }
    }
    await copyTo(from, to);
    await remove(from);
  }

  /** No recycle bin in a browser: deleted things go to My files/.trash, to be restored by hand. */
  async function trash(path) {
    const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    let target = join(MY, '.trash', `${base(path)} (${stamp})`);
    for (let n = 2; (await stat(target)).exists; n++) target = join(MY, '.trash', `${base(path)} (${stamp}-${n})`);
    if (split(path).length === 1) { await remove(path); return; }
    await copyTo(path, target);
    await remove(path);
  }

  // VS Code style globs: "*.js" or "dist" match a name anywhere; with a slash, from the root.
  function globMatcher(glob) {
    let g = String(glob).trim().replace(/^\.\//, '');
    if (!g) return () => false;
    const toRe = (s) => new RegExp(`^${s.split('**').map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]')).join('.*')}(/.*)?$`);
    if (!g.includes('/')) {
      const name = toRe(g);
      return (rel) => rel.split('/').some((part) => name.test(part));
    }
    g = g.replace(/^\//, '');
    const re = toRe(g);
    return (rel) => re.test(rel);
  }

  async function walk(root, visit, excludes = []) {
    const ex = excludes.map(globMatcher);
    const go = async (dir, rel) => {
      const entries = [];
      for await (const [name, h] of dir.entries()) entries.push([name, h]);
      entries.sort((a, b) => a[0].localeCompare(b[0]));
      for (const [name, h] of entries) {
        const r = rel ? `${rel}/${name}` : name;
        if (ex.some((m) => m(r))) continue;
        if (h.kind === 'directory') { if (!IGNORED_DIRS.has(name)) { if ((await go(h, r)) === false) return false; } }
        else if ((await visit(h, r)) === false) return false;
      }
      return true;
    };
    const r = await entryOf(root);
    if (r.root || r.handle.kind !== 'directory') return;
    await go(r.handle, '');
  }

  async function listFiles(root, excludes = []) {
    const out = [];
    await walk(root, (h, rel) => { out.push(rel); return out.length < 100000; }, excludes);
    return out;
  }

  let searchToken = 0;
  async function search(q) {
    const token = ++searchToken;
    const max = q.maxResults || 20000;
    let re;
    try {
      let src = q.isRegex ? q.query : q.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (q.wholeWord) src = `\\b(?:${src})\\b`;
      re = new RegExp(src, q.matchCase ? 'gu' : 'giu');
    } catch (e) {
      return { files: [], count: 0, error: e.message };
    }
    const includes = String(q.include || '').split(',').map((s) => s.trim()).filter(Boolean).map(globMatcher);
    const excludes = String(q.exclude || '').split(',').map((s) => s.trim()).filter(Boolean);
    const files = [];
    let count = 0;
    await walk(q.root, async (h, rel) => {
      if (token !== searchToken || count >= max) return false;
      if (includes.length && !includes.some((m) => m(rel))) return true;
      const f = await h.getFile();
      if (f.size > 4 * 1024 * 1024) return true;
      const bytes = new Uint8Array(await f.arrayBuffer());
      if (isBinary(bytes)) return true;
      const matches = [];
      new TextDecoder().decode(bytes).split(/\r?\n/).forEach((text, i) => {
        if (count >= max) return;
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text))) {
          matches.push({ line: i + 1, start: m.index, end: m.index + m[0].length, text });
          if (++count >= max) break;
          if (!m[0].length) re.lastIndex++;
          if (re.lastIndex > text.length) break;
        }
      });
      if (matches.length) files.push({ path: join(q.root, rel), rel, matches });
      return count < max;
    }, excludes);
    return { files, count, limitHit: count >= max };
  }

  // Our own changes, told to the explorer the way the desktop's file watcher would.
  let watched = new Set();
  const pending = new Map();
  let flushTimer = 0;
  function changed(path) {
    for (const dir of [parent(path), path]) {
      if (!watched.has(dir)) continue;
      if (!pending.has(dir)) pending.set(dir, new Set());
      pending.get(dir).add(path);
    }
    if (!flushTimer) flushTimer = setTimeout(() => {
      flushTimer = 0;
      for (const [dir, paths] of pending) emit('fs:changed', { dir, paths: [...paths] });
      pending.clear();
    }, 120);
  }

  // -------------------------------------------------------------------------
  // Settings files
  // -------------------------------------------------------------------------
  const STORE = { settings: `${CONFIG}/settings.json`, keybindings: `${CONFIG}/keybindings.json`, state: `${CONFIG}/state.json` };
  const PHONE = window.matchMedia('(max-width: 720px)').matches;
  // A phone opens straight into a blank file: no activity bar, status bar, breadcrumbs or
  // minimap. All of it comes back from the View button or Settings.
  const PHONE_DEFAULTS = { 'workbench.startupEditor': 'newUntitledFile', 'workbench.activityBar.visible': false, 'workbench.statusBar.visible': false,
    'workbench.breadcrumbs.enabled': false, 'editor.minimap.enabled': false, 'editor.wordWrap': 'on' };
  // Shortcuts for what the View button does that has none of its own (added when read, left out when saved).
  const VIEW_KEYS = [['ctrl+alt+shift+f1', 'workbench.action.toggleActivityBarVisibility'], ['ctrl+alt+shift+f2', 'workbench.action.toggleStatusbarVisibility'],
    ['ctrl+alt+shift+f3', 'breadcrumbs.toggle'], ['ctrl+alt+shift+f4', 'editor.toggleMinimap'], ['ctrl+alt+shift+f5', 'workbench.action.files.openFolder']].map(([key, command]) => ({ key, command }));
  const isViewKey = (b) => VIEW_KEYS.some((v) => v.key === b.key && v.command === b.command);
  async function storeGet(key) {
    if (key === 'keybindings') return [...(await storeRead(key)).filter((b) => !isViewKey(b)), ...VIEW_KEYS];
    if (key === 'settings' && PHONE && !(await stat(STORE.settings)).exists) await storeSet('settings', PHONE_DEFAULTS);
    return storeRead(key);
  }
  async function storeRead(key) {
    const fallback = key === 'keybindings' ? [] : {};
    try {
      const { content } = await readFile(STORE[key]);
      // Comments and trailing commas, like the desktop.
      const clean = content.replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, s) => s || '').replace(/,(\s*[}\]])/g, '$1');
      return JSON.parse(clean);
    } catch { return fallback; }
  }
  const storeSet = (key, value) => writeFile(STORE[key], `${JSON.stringify(key === 'keybindings' ? value.filter((v) => !isViewKey(v)) : value, null, 2)}\n`);

  // -------------------------------------------------------------------------
  // Dialogs (our own, so they look the same in every browser)
  // -------------------------------------------------------------------------
  function message({ message: text = '', detail = '', buttons = ['OK'], cancelId = buttons.length - 1, type = '' } = {}) {
    return new Promise((done) => {
      const veil = document.createElement('div');
      veil.className = 'web-dialog-veil';
      const box = document.createElement('div');
      box.className = `web-dialog ${type}`;
      const h = document.createElement('div');
      h.className = 'web-dialog-text';
      h.textContent = text;
      box.append(h);
      if (detail) { const d = document.createElement('div'); d.className = 'web-dialog-detail'; d.textContent = detail; box.append(d); }
      const row = document.createElement('div');
      row.className = 'web-dialog-buttons';
      const close = (i) => { veil.remove(); document.removeEventListener('keydown', key, true); done(i); };
      buttons.forEach((label, i) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.className = i === 0 ? 'primary' : '';
        b.onclick = () => close(i);
        row.append(b);
      });
      box.append(row);
      veil.append(box);
      const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(cancelId); } };
      document.addEventListener('keydown', key, true);
      veil.addEventListener('pointerdown', (e) => { if (e.target === veil) close(cancelId); });
      document.body.append(veil);
      row.firstChild && row.firstChild.focus();
    });
  }

  function ask(title, value) {
    return new Promise((done) => {
      const veil = document.createElement('div');
      veil.className = 'web-dialog-veil';
      const box = document.createElement('form');
      box.className = 'web-dialog';
      box.innerHTML = '<div class="web-dialog-text"></div><input class="web-dialog-input" spellcheck="false"><div class="web-dialog-buttons"><button class="primary" type="submit">OK</button><button type="button">Cancel</button></div>';
      box.querySelector('.web-dialog-text').textContent = title;
      const input = box.querySelector('input');
      input.value = value;
      const close = (v) => { veil.remove(); done(v); };
      box.onsubmit = (e) => { e.preventDefault(); close(input.value.trim() || null); };
      box.querySelector('button[type="button"]').onclick = () => close(null);
      input.onkeydown = (e) => { if (e.key === 'Escape') { e.stopPropagation(); close(null); } };
      veil.append(box);
      document.body.append(veil);
      input.focus();
      input.setSelectionRange(0, value.lastIndexOf('.') > 0 ? value.lastIndexOf('.') : value.length);
    });
  }

  function askAgain(handle) {
    if (document.querySelector('.web-allow')) return;
    const bar = document.createElement('div');
    bar.className = 'web-allow';
    bar.textContent = `Snake's Code needs your permission to open “${handle.name}” again. `;
    const b = document.createElement('button');
    b.textContent = 'Allow';
    b.onclick = async () => {
      if ((await handle.requestPermission({ mode: 'readwrite' }).catch(() => 'denied')) === 'granted') { bar.remove(); location.reload(); }
    };
    const x = document.createElement('button');
    x.textContent = 'Not now';
    x.onclick = () => bar.remove();
    bar.append(b, x);
    document.body.append(bar);
  }

  /** Files from this device, copied into `dir` (My files unless given). Returns their paths. */
  function pickUploads(dir = MY, folder = false) {
    return new Promise((done) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.multiple = true;
      if (folder) input.webkitdirectory = true;
      input.style.display = 'none';
      input.onchange = async () => {
        const paths = [];
        for (const f of input.files) {
          const rel = folder && f.webkitRelativePath ? f.webkitRelativePath : f.name;
          const p = join(dir, rel);
          await writeBytes(p, await f.arrayBuffer());
          paths.push(p);
        }
        input.remove();
        done(paths);
      };
      input.oncancel = () => { input.remove(); done([]); };
      document.body.append(input);
      input.click();
    });
  }

  async function openFolder() {
    await ready;
    const canPick = !!window.showDirectoryPicker;
    const choice = await message({
      message: 'Open which folder?',
      detail: canPick ? 'A folder on this computer is edited where it is. My files lives in this browser.'
        : 'This browser cannot edit folders where they are (Chrome and Edge can). My files lives in this browser; a folder from this device can be copied in.',
      buttons: canPick ? ['A folder on this computer…', 'My files (in this browser)', 'Cancel'] : ['My files (in this browser)', 'Copy a folder in…', 'Cancel'],
      cancelId: 2,
    });
    if (choice === 2) return null;
    if (canPick && choice === 0) {
      try { return await mount(await window.showDirectoryPicker({ mode: 'readwrite' })); } catch { return null; }
    }
    if (!canPick && choice === 1) {
      const paths = await pickUploads(MY, true);
      return paths.length ? join(MY, split(paths[0].slice(MY.length))[0]) : null;
    }
    return MY;
  }

  async function openFiles() {
    if (window.showOpenFilePicker) {
      try {
        const handles = await window.showOpenFilePicker({ multiple: true });
        return Promise.all(handles.map((h) => mount(h)));
      } catch { return []; }
    }
    return pickUploads(MY);
  }

  async function saveAs(defaultPath) {
    const name = base(defaultPath) || 'untitled.txt';
    const dir = defaultPath && split(defaultPath).length > 1 ? parent(defaultPath) : MY;
    if (window.showSaveFilePicker && !['My files', '.config'].includes(split(dir)[0])) {
      try { return await mount(await window.showSaveFilePicker({ suggestedName: name })); } catch { return null; }
    }
    const chosen = await ask(`Save as (in ${dir})`, name);
    return chosen ? join(dir, chosen) : null;
  }

  // -------------------------------------------------------------------------
  // Getting files out: Download
  // -------------------------------------------------------------------------
  function downloadBlob(name, blob) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 30000);
  }

  // A small ZIP writer (deflate through the browser's CompressionStream).
  const CRC = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; } return t; })();
  const crc32 = (b) => { let c = 0xffffffff; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  async function zip(files) {
    const parts = [];
    const central = [];
    let offset = 0;
    for (const f of files) {
      const name = new TextEncoder().encode(f.name);
      const data = new Uint8Array(await new Response(new Blob([f.data]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
      const crc = crc32(f.data);
      const local = new DataView(new ArrayBuffer(30));
      local.setUint32(0, 0x04034b50, true); local.setUint16(4, 20, true); local.setUint16(6, 0x0800, true); local.setUint16(8, 8, true);
      local.setUint32(14, crc, true); local.setUint32(18, data.length, true); local.setUint32(22, f.data.length, true); local.setUint16(26, name.length, true);
      const cen = new DataView(new ArrayBuffer(46));
      cen.setUint32(0, 0x02014b50, true); cen.setUint16(4, 20, true); cen.setUint16(6, 20, true); cen.setUint16(8, 0x0800, true); cen.setUint16(10, 8, true);
      cen.setUint32(16, crc, true); cen.setUint32(20, data.length, true); cen.setUint32(24, f.data.length, true); cen.setUint16(28, name.length, true); cen.setUint32(42, offset, true);
      parts.push(new Uint8Array(local.buffer), name, data);
      central.push(new Uint8Array(cen.buffer), name);
      offset += 30 + name.length + data.length;
    }
    const size = central.reduce((a, c) => a + c.length, 0);
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true); end.setUint32(12, size, true); end.setUint32(16, offset, true);
    return new Blob([...parts, ...central, new Uint8Array(end.buffer)], { type: 'application/zip' });
  }

  async function download(path) {
    const r = await entryOf(path);
    if (!r.root && r.handle.kind === 'file') { const f = await r.handle.getFile(); downloadBlob(base(path), f); return; }
    const files = [];
    await walk(path, async (h, rel) => { files.push({ name: rel, data: new Uint8Array(await (await h.getFile()).arrayBuffer()) }); return files.length < 20000; });
    downloadBlob(`${base(path) || 'Files'}.zip`, await zip(files));
  }

  // -------------------------------------------------------------------------
  // file:// pictures and media (viewers, Markdown preview) come from our files
  // -------------------------------------------------------------------------
  const urls = new Map();
  async function blobURL(path) {
    if (urls.has(path)) return urls.get(path);
    const { file } = await bytesOf(path);
    const u = URL.createObjectURL(file);
    urls.set(path, u);
    setTimeout(() => { URL.revokeObjectURL(u); urls.delete(path); }, 120000);
    return u;
  }
  const fileURL = (v) => typeof v === 'string' && v.startsWith('file://');
  const pathOfURL = (v) => decodeURIComponent(v.slice('file://'.length).split(/[?#]/)[0]);
  for (const proto of [HTMLImageElement.prototype, HTMLMediaElement.prototype, HTMLSourceElement.prototype]) {
    const desc = Object.getOwnPropertyDescriptor(proto, 'src');
    if (!desc) continue;
    Object.defineProperty(proto, 'src', { ...desc, set(v) { if (fileURL(v)) { blobURL(pathOfURL(v)).then((u) => desc.set.call(this, u), () => {}); return; } desc.set.call(this, v); } });
  }
  const setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    if ((name === 'src' || name === 'href') && fileURL(value) && this.tagName !== 'A') {
      blobURL(pathOfURL(value)).then((u) => setAttribute.call(this, name, u), () => {});
      return undefined;
    }
    return setAttribute.call(this, name, value);
  };

  // -------------------------------------------------------------------------
  // window.snake
  // -------------------------------------------------------------------------
  const nothing = () => {};
  const unavailable = (what) => () => Promise.reject(new Error(`${what} needs the desktop or Android Snake's Code.`));
  const openOnStart = new URLSearchParams(location.search).get('open');

  window.snake = {
    init: async () => {
      await ready;
      return {
        openPath: openOnStart || null, isFirstWindow: true, platform: 'linux', homeDir: MY, sep: '/', userDir: CONFIG,
        storePaths: STORE, ptyAvailable: false, shell: null,
        versions: { electron: 'none (a web page)', chrome: navigator.userAgent.match(/(Chrome|Firefox|Version)\/[\d.]+/)?.[0] || '?', node: 'none (the browser)', app: 'web' },
      };
    },
    quit: () => window.close(),
    onBeforeClose: on('app:beforeClose'),
    win: {
      minimize: nothing, toggleMaximize: nothing,
      close: () => emit('app:beforeClose'), forceClose: () => window.close(),
      newWindow: (p) => window.open(`${location.pathname}${p ? `?open=${encodeURIComponent(p)}` : ''}`, '_blank'),
      setTitle: (t) => { document.title = t; },
      toggleFullScreen: () => (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(nothing),
      setFullScreen: (on2) => (on2 ? document.documentElement.requestFullscreen() : document.fullscreenElement ? document.exitFullscreen() : Promise.resolve()).catch(nothing),
      toggleDevTools: nothing,
      reload: () => location.reload(),
      setZoom: (level) => { document.documentElement.style.zoom = String(1.2 ** (level || 0)); },
      isMaximized: async () => true,
      onMaximized: () => nothing,
      onFullScreen: (cb) => { const f = () => cb(!!document.fullscreenElement); document.addEventListener('fullscreenchange', f); return () => document.removeEventListener('fullscreenchange', f); },
    },
    store: { get: storeGet, set: storeSet },
    fs: {
      readDir, readFile, writeFile, stat, mkdir, createFile, rename, copy, trash, delete: remove, listFiles,
      watchDirs: (dirs) => { watched = new Set(dirs); },
      onChanged: on('fs:changed'),
      pathForFile: () => '',
    },
    search: { run: search, cancel: () => { searchToken++; } },
    pty: { create: unavailable('The terminal'), write: nothing, resize: nothing, kill: nothing, cwd: async () => null, onData: on('pty:data'), onExit: on('pty:exit') },
    git: { run: async () => ({ code: 127, stdout: '', stderr: 'git is not available in a browser' }) },
    exec: async (cmd) => ({ code: 127, stdout: '', stderr: `cannot run ${cmd} in a browser` }),
    dialog: { openFolder, openFiles, saveAs, message },
    shell: {
      openExternal: (url) => { if (/^(https?|mailto):/i.test(url)) window.open(url, '_blank', 'noopener'); },
      showItemInFolder: nothing,
      openPath: (p) => download(p).catch(nothing),
    },
    clipboard: { write: (t) => navigator.clipboard.writeText(t).catch(nothing), read: () => navigator.clipboard.readText().catch(() => '') },
    // Only in the browser: files in and out (the editor shows Upload and Download for these).
    web: { download, upload: (dir) => pickUploads(dir || MY) },
  };
  document.documentElement.classList.add('web');

  // -------------------------------------------------------------------------
  // The View button (narrow screens): any part of the workbench back, and the menu
  // bar's commands. Commands go through the editor's own shortcuts, so its state stays right.
  // -------------------------------------------------------------------------
  const press = (combo) => {
    const parts = combo.split('+');
    const k = parts.pop();
    const CODES = { '=': 'Equal', '-': 'Minus', '`': 'Backquote' };
    const code = CODES[k] || (/^f\d+$/.test(k) ? k.toUpperCase() : `Key${k.toUpperCase()}`);
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: k, code, bubbles: true, cancelable: true,
      ctrlKey: parts.includes('ctrl'), shiftKey: parts.includes('shift'), altKey: parts.includes('alt') }));
  };
  const shown = (sel) => { const e = document.querySelector(sel); return !!e && e.offsetWidth > 0 && e.offsetHeight > 0; };
  // Menu bar: hidden on phones until shown (remembered).
  let menubar = (() => { try { const v = localStorage.getItem('snake.web.menubar'); return v === null ? !PHONE : v === '1'; } catch { return !PHONE; } })();
  const applyMenubar = () => { document.documentElement.classList.toggle('hide-menubar', !menubar); requestAnimationFrame(() => window.dispatchEvent(new Event('resize'))); };
  applyMenubar();
  const toggles = [
    ['Menu bar', () => menubar, () => { menubar = !menubar; try { localStorage.setItem('snake.web.menubar', menubar ? '1' : '0'); } catch {} applyMenubar(); }],
    ['Explorer', () => shown('#sidebar'), () => press('ctrl+b')],
    ['Activity bar', () => shown('#activitybar'), () => press('ctrl+alt+shift+f1')],
    ['Breadcrumbs', () => shown('.breadcrumbs'), () => press('ctrl+alt+shift+f3')],
    ['Minimap', () => shown('.minimap'), () => press('ctrl+alt+shift+f4')],
    ['Status bar', () => shown('#statusbar'), () => press('ctrl+alt+shift+f2')],
  ];
  const actions = [['New file', 'ctrl+n'], ['Open file', 'ctrl+o'], ['Open folder', 'ctrl+alt+shift+f5'], ['Save', 'ctrl+s'],
    ['Go to file', 'ctrl+p'], ['Commands', 'ctrl+shift+p'], ['Word wrap', 'alt+z'], ['Find', 'ctrl+f']];
  const buildViewButton = () => {
    const btn = document.createElement('button');
    btn.id = 'web-view-button';
    btn.title = 'View';
    btn.textContent = '\u22EE';
    const sheet = document.createElement('div');
    sheet.id = 'web-view-sheet';
    const close = () => sheet.classList.remove('open');
    const render = () => {
      sheet.replaceChildren();
      const head = (t) => { const d = document.createElement('div'); d.className = 'wvs-head'; d.textContent = t; sheet.append(d); };
      head('View');
      for (const [label, isOn, run] of toggles) {
        const row = document.createElement('button');
        row.className = `wvs-toggle${isOn() ? ' on' : ''}`;
        row.innerHTML = '<span class="wvs-check"></span>';
        row.append(label);
        row.onclick = () => { run(); setTimeout(render, 150); };
        sheet.append(row);
      }
      head('Actions');
      const grid = document.createElement('div');
      grid.className = 'wvs-grid';
      for (const [label, combo] of actions) {
        const b = document.createElement('button');
        b.textContent = label;
        b.onclick = () => { close(); setTimeout(() => press(combo), 50); };
        grid.append(b);
      }
      sheet.append(grid);
    };
    btn.onclick = (e) => { e.stopPropagation(); if (sheet.classList.toggle('open')) render(); };
    document.addEventListener('pointerdown', (e) => { if (!sheet.contains(e.target) && e.target !== btn) close(); }, true);
    document.body.append(sheet, btn);
  };
  const start = () => {
    buildViewButton();
    // A phone's first start: just the editor (the explorer and panel come back from View).
    let first = false;
    try { first = PHONE && !localStorage.getItem('snake.web.started'); localStorage.setItem('snake.web.started', '1'); } catch {}
    if (first) setTimeout(() => { if (shown('#sidebar')) press('ctrl+b'); if (shown('#panel')) press('ctrl+j'); }, 800);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
