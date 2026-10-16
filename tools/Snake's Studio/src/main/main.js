// Snake's Studio: the Electron main process shared by Word, Spreadsheets, Slides,
// Paint, Photo, Player and Movie Maker.
//
// Every app runs in its own process (its own settings folder and single-instance
// lock), so each has its own window class, taskbar icon and menu entry:
//
//     snakes-studio --app=word [files...]
//
// Security model (see MASTER_PLAN.md): pages are sandboxed with no Node, served
// from the snake:// protocol with a strict Content-Security-Policy, and can only
// touch files the user picked, dropped or opened with the app (grants).
'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, protocol, session, screen, clipboard, ClipboardItem, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { Readable } = require('stream');
const { APPS, HOME, VIDEO_EXTS, AUDIO_EXTS } = require('./apps');
const media = require('./media');

const ROOT = path.join(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist');
const isDev = process.argv.includes('--dev');

// ---------------------------------------------------------------------------
// Which app is this process?
// ---------------------------------------------------------------------------
function parseArgs(argv) {
  // argv[0] is the executable; when run as `electron .` argv[1] is the app folder.
  const rest = argv.slice(app.isPackaged ? 1 : 2);
  let appId = null;
  const files = [];
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a.startsWith('--app=')) appId = a.slice(6);
    else if (a === '--app') appId = rest[++i];
    else if (a.startsWith('-')) continue; // Chromium/Electron switches
    else files.push(a);
  }
  return { appId: APPS[appId] ? appId : null, files };
}

const ARGS = parseArgs(process.argv);
const APP_ID = ARGS.appId || 'home';
const META = APPS[APP_ID] || HOME;
const CLASS = APP_ID === 'home' ? 'snakes-studio' : `snakes-${APP_ID}`;

app.setName(META.name);
// The window class names the taskbar group and its icon (X11 WM_CLASS, Wayland app id).
app.commandLine.appendSwitch('class', CLASS);
if (process.platform === 'win32') app.setAppUserModelId(`Snake.Suite.${APP_ID}`);
// Each app keeps its own settings, recent files and single-instance lock.
const userBase = process.env.SNAKE_USER_DATA || path.join(app.getPath('appData'), 'snakes-studio');
app.setPath('userData', path.join(userBase, APP_ID));
app.enableSandbox();

// snake:// serves the app itself; snake-media:// streams granted media files (with seeking).
protocol.registerSchemesAsPrivileged([
  { scheme: 'snake', privileges: { standard: true, secure: true, supportFetchAPI: true, codeCache: true } },
  // corsEnabled: our own pages (snake://studio only) may process the sound and pictures (equaliser, snapshots).
  { scheme: 'snake-media', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv, cwd) => {
    const { files } = parseArgs(argv);
    const paths = files.map((f) => path.resolve(cwd, f));
    const target = [...windows].find((w) => !w.isDestroyed() && w.snakeMain);
    if (APP_ID === 'player' && target && paths.length) {
      // A media player plays what was opened in the window it already has.
      sendOpen(target, paths);
      if (target.isMinimized()) target.restore();
      target.focus();
    } else {
      createWindow(paths);
    }
  });
}

// ---------------------------------------------------------------------------
// Small JSON stores in the app's own folder
// ---------------------------------------------------------------------------
const userDir = () => app.getPath('userData');
function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(userDir(), file), 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  const full = path.join(userDir(), file);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  const tmp = `${full}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1));
  fs.renameSync(tmp, full); // atomic: a crash never leaves half a settings file
}

// ---------------------------------------------------------------------------
// File grants: the only files a page may read or write
// ---------------------------------------------------------------------------
const grants = new Map(); // token -> { path, write }
const byPath = new Map(); // path -> token

function grant(file, write) {
  const full = path.resolve(file);
  let token = byPath.get(full);
  if (token) {
    if (write) grants.get(token).write = true;
  } else {
    token = crypto.randomBytes(16).toString('hex');
    grants.set(token, { path: full, write: !!write });
    byPath.set(full, token);
  }
  return token;
}

function describe(token) {
  const g = grants.get(token);
  let size = 0;
  let mtime = 0;
  try {
    const st = fs.statSync(g.path);
    size = st.size;
    mtime = st.mtimeMs;
  } catch {}
  return {
    id: token,
    name: path.basename(g.path),
    path: g.path,
    dir: path.dirname(g.path),
    ext: path.extname(g.path).slice(1).toLowerCase(),
    size,
    mtime,
    writable: g.write,
    url: `snake-media://file/${token}/${encodeURIComponent(path.basename(g.path))}`,
  };
}

function need(token, write) {
  const g = grants.get(token);
  if (!g) throw new Error('That file is not open in this app.');
  if (write && !g.write) throw new Error('That file was opened read-only.');
  return g;
}

// Recent files, newest first.
function addRecent(file) {
  const list = readJson('recent.json', []).filter((r) => r.path !== file);
  list.unshift({ path: file, time: Date.now() });
  writeJson('recent.json', list.slice(0, 25));
}
function recentList() {
  return readJson('recent.json', []).map((r) => ({
    key: crypto.createHash('sha1').update(r.path).digest('hex').slice(0, 16),
    name: path.basename(r.path),
    dir: path.dirname(r.path),
    time: r.time,
    exists: fs.existsSync(r.path),
  }));
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------
const windows = new Set();
const isMac = process.platform === 'darwin';

function iconPath() {
  return path.join(ROOT, 'assets', 'icons', `${APP_ID === 'home' ? 'studio' : APP_ID}.png`);
}

function createWindow(files = [], opts = {}) {
  const state = readJson('window.json', {});
  const display = screen.getPrimaryDisplay().workAreaSize;
  const defaults = APP_ID === 'home' ? { width: 980, height: 640 }
    : { width: Math.min(1480, display.width), height: Math.min(940, display.height) };
  const bounds = opts.bounds || (windows.size === 0 && state.bounds) || defaults;
  const win = new BrowserWindow({
    ...bounds,
    minWidth: 520,
    minHeight: 380,
    frame: isMac,
    titleBarStyle: isMac ? 'hiddenInset' : undefined,
    backgroundColor: '#1a1e1b',
    title: META.name,
    icon: iconPath(),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
      spellcheck: !!META.spellcheck,
      navigateOnDragDrop: false,
      safeDialogs: true,
      backgroundThrottling: APP_ID !== 'player' && APP_ID !== 'movie',
    },
  });
  win.snakeMain = !opts.page;
  win.snakeFiles = files.map((f) => grant(f, !META.media));
  for (const f of files) addRecent(path.resolve(f));
  windows.add(win);

  if (!opts.bounds && windows.size === 1 && state.maximized) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.loadURL(`snake://studio/${APP_ID}/${opts.page || 'index.html'}${opts.query ? `?${opts.query}` : ''}`);
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });

  const send = (ch, v) => !win.isDestroyed() && win.webContents.send(ch, v);
  win.on('maximize', () => send('win:maximized', true));
  win.on('unmaximize', () => send('win:maximized', false));
  win.on('enter-full-screen', () => send('win:fullscreen', true));
  win.on('leave-full-screen', () => send('win:fullscreen', false));
  win.on('focus', () => send('win:focus', true));
  win.on('blur', () => send('win:focus', false));

  win.on('close', (e) => {
    if (win.snakeMain && windows.size >= 1) {
      writeJson('window.json', { bounds: win.getNormalBounds(), maximized: win.isMaximized() });
    }
    if (win.snakeForceClose || win.webContents.isCrashed() || !win.snakeMain || !win.snakeGuarded) return;
    e.preventDefault();
    send('app:beforeClose');
    // A page that hangs must not keep its window open forever.
    clearTimeout(win.snakeCloseTimer);
    win.snakeCloseTimer = setTimeout(() => {
      if (!win.isDestroyed() && win.webContents.isCrashed()) { win.snakeForceClose = true; win.close(); }
    }, 4000);
  });
  win.on('closed', () => {
    windows.delete(win);
    media.stopFor(win.id);
  });

  // Spelling suggestions for the page's own context menu.
  win.webContents.on('context-menu', (_e, params) => {
    send('spell:context', {
      x: params.x, y: params.y,
      word: params.misspelledWord || '',
      suggestions: params.dictionarySuggestions || [],
      editable: params.isEditable,
    });
  });
  return win;
}

function sendOpen(win, paths) {
  const tokens = paths.map((p) => grant(p, !META.media));
  for (const p of paths) addRecent(path.resolve(p));
  win.webContents.send('file:opened', tokens.map(describe));
}

// ---------------------------------------------------------------------------
// The snake:// protocol: the app's own files, with security headers
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.wasm': 'application/wasm', '.txt': 'text/plain',
};

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: snake-media:",
  "media-src 'self' data: blob: snake-media:",
  "font-src 'self' data:",
  "connect-src 'self' data: blob: snake-media:",
  "worker-src 'self' blob:",
  "frame-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

async function serveApp(request) {
  const url = new URL(request.url);
  if (url.hostname !== 'studio') return new Response('Not found', { status: 404 });
  const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.normalize(path.join(DIST, rel));
  if (!file.startsWith(DIST + path.sep)) return new Response('Forbidden', { status: 403 });
  try {
    const data = await fsp.readFile(file);
    return new Response(data, {
      headers: {
        'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Content-Security-Policy': CSP,
        'X-Content-Type-Options': 'nosniff',
        'Cross-Origin-Opener-Policy': 'same-origin',
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-cache',
      },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

// ---------------------------------------------------------------------------
// IPC: every handler checks that the call comes from one of our own pages
// ---------------------------------------------------------------------------
function trusted(event) {
  const url = event.senderFrame && event.senderFrame.url;
  return typeof url === 'string' && url.startsWith('snake://studio/');
}
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!trusted(event)) throw new Error('Refused');
    return fn(event, BrowserWindow.fromWebContents(event.sender), ...args);
  });
}
function listen(channel, fn) {
  ipcMain.on(channel, (event, ...args) => {
    if (!trusted(event)) return;
    const win = BrowserWindow.fromWebContents(event.sender);
    if (win) fn(win, ...args);
  });
}

const str = (v, max = 4096) => (typeof v === 'string' ? v.slice(0, max) : '');
const MAX_READ = 1024 * 1024 * 1024; // 1 GB: big media is streamed, never read whole
const MAX_STORE = 2 * 1024 * 1024;
const MAX_RECOVERY = 200 * 1024 * 1024;

function filtersFrom(list) {
  const out = [];
  for (const f of Array.isArray(list) ? list : []) {
    const exts = (Array.isArray(f.exts) ? f.exts : []).map((e) => str(e, 16).replace(/[^a-z0-9]/gi, '')).filter(Boolean);
    if (exts.length) out.push({ name: str(f.name, 80) || 'Files', extensions: exts });
  }
  out.push({ name: 'All files', extensions: ['*'] });
  return out;
}

function registerIpc() {
  handle('app:init', (_e, win) => ({
    app: APP_ID,
    name: META.name,
    version: app.getVersion(),
    platform: process.platform,
    files: (win.snakeFiles || []).map(describe),
    recent: recentList(),
    ffmpeg: !!media.ffmpegPath(),
    apps: Object.fromEntries(Object.entries(APPS).map(([id, a]) => [id, { name: a.name, short: a.short, tagline: a.tagline }])),
    maximized: win.isMaximized(),
  }));

  // ---- window ----
  listen('win:minimize', (win) => win.minimize());
  listen('win:toggleMaximize', (win) => (win.isMaximized() ? win.unmaximize() : win.maximize()));
  listen('win:guardClose', (win) => { win.snakeGuarded = true; });
  listen('win:close', (win) => win.close());
  listen('win:forceClose', (win) => { win.snakeForceClose = true; win.close(); });
  listen('win:setTitle', (win, t) => win.setTitle(str(t, 300) || META.name));
  listen('win:setFullScreen', (win, on) => win.setFullScreen(!!on));
  listen('win:toggleFullScreen', (win) => win.setFullScreen(!win.isFullScreen()));
  listen('win:setAlwaysOnTop', (win, on) => win.setAlwaysOnTop(!!on));
  listen('win:setSize', (win, w, h) => {
    if (Number.isFinite(w) && Number.isFinite(h)) win.setSize(Math.max(320, Math.round(w)), Math.max(200, Math.round(h)));
  });
  listen('win:new', (_win, query) => createWindow([], { query: /^[a-z0-9=&_-]{0,80}$/i.test(String(query || '')) ? String(query || '') : '' }));
  listen('win:toggleDevTools', (win) => win.webContents.toggleDevTools());
  listen('win:setProgress', (win, p) => win.setProgressBar(Number.isFinite(p) ? p : -1));
  listen('win:setZoom', (win, f) => {
    if (Number.isFinite(f)) win.webContents.setZoomFactor(Math.min(2, Math.max(0.7, f)));
  });
  handle('win:isMaximized', (_e, win) => win.isMaximized());
  handle('win:openPage', (_e, win, page, options = {}) => {
    // Extra windows of the same app, e.g. the audience view of a slide show.
    const name = str(page, 64);
    if (!/^[a-z0-9-]+\.html$/.test(name)) throw new Error('Bad page');
    const displays = screen.getAllDisplays();
    const here = screen.getDisplayMatching(win.getBounds());
    const other = displays.find((d) => d.id !== here.id);
    const target = options.display === 'other' && other ? other : here;
    const child = createWindow([], { page: name, bounds: target.bounds });
    if (options.fullscreen) child.once('ready-to-show', () => child.setFullScreen(true));
    return child.id;
  });
  handle('app:launch', (_e, _win, id) => {
    if (!APPS[id]) throw new Error('Unknown app');
    const args = app.isPackaged ? [`--app=${id}`] : [ROOT, `--app=${id}`];
    spawn(...media.clean(process.execPath, args), { detached: true, stdio: 'ignore' }).unref();
    return true;
  });

  // ---- files ----
  handle('file:open', async (_e, win, opts = {}) => {
    const props = ['openFile'];
    if (opts.multiple) props.push('multiSelections');
    if (opts.folder) props.splice(0, 1, 'openDirectory');
    const res = await dialog.showOpenDialog(win, {
      title: str(opts.title, 120) || undefined,
      properties: props,
      filters: opts.folder ? undefined : filtersFrom(opts.filters || META.open),
    });
    if (res.canceled) return [];
    if (opts.folder) return res.filePaths.flatMap((dir) => listFolder(dir, opts.exts));
    for (const f of res.filePaths) addRecent(f);
    return res.filePaths.map((f) => describe(grant(f, !opts.readOnly && !META.media)));
  });
  handle('file:read', async (_e, _win, token) => {
    const g = need(str(token));
    const st = await fsp.stat(g.path);
    if (st.size > MAX_READ) throw new Error('That file is too large to open here.');
    return new Uint8Array(await fsp.readFile(g.path));
  });
  handle('file:write', async (_e, _win, token, data) => {
    const g = need(str(token), true);
    await writeAtomic(g.path, data);
    addRecent(g.path);
    return describe(str(token));
  });
  handle('file:saveAs', async (_e, win, opts = {}, data) => {
    // Automated tests only: save straight into a folder named by whoever started the app.
    const testDir = process.env.SNAKE_TEST_SAVEAS;
    const res = testDir ? { canceled: false, filePath: path.join(testDir, path.basename(str(opts.name, 255) || 'Untitled')) } : await dialog.showSaveDialog(win, {
      title: str(opts.title, 120) || undefined,
      defaultPath: path.join(opts.near && grants.get(opts.near) ? path.dirname(grants.get(opts.near).path)
        : app.getPath('documents'), path.basename(str(opts.name, 255) || 'Untitled')),
      filters: filtersFrom(opts.filters),
    });
    if (res.canceled || !res.filePath) return null;
    if (data !== undefined) await writeAtomic(res.filePath, data);
    addRecent(res.filePath);
    return describe(grant(res.filePath, true));
  });
  handle('file:recent', () => recentList());
  handle('file:openRecent', (_e, _win, key) => {
    const hit = readJson('recent.json', []).find(
      (r) => crypto.createHash('sha1').update(r.path).digest('hex').slice(0, 16) === str(key, 64));
    if (!hit || !fs.existsSync(hit.path)) throw new Error('That file is no longer there.');
    addRecent(hit.path);
    return describe(grant(hit.path, !META.media));
  });
  handle('file:forgetRecent', (_e, _win, key) => {
    const list = readJson('recent.json', []).filter(
      (r) => key && crypto.createHash('sha1').update(r.path).digest('hex').slice(0, 16) !== str(key, 64));
    writeJson('recent.json', list);
    return recentList();
  });
  handle('file:dropped', (_e, _win, paths) => {
    // Paths come from the preload (webUtils.getPathForFile on real dropped File objects).
    const out = [];
    for (const p of Array.isArray(paths) ? paths.slice(0, 500) : []) {
      if (typeof p !== 'string' || !p) continue;
      try {
        const st = fs.statSync(p);
        if (st.isDirectory()) out.push(...listFolder(p));
        else { out.push(describe(grant(p, !META.media))); addRecent(path.resolve(p)); }
      } catch {}
    }
    return out;
  });
  handle('file:siblings', (_e, _win, token, exts) => {
    // Files next to one the user opened: the rest of an album, or a video's subtitles.
    const g = need(str(token));
    return listFolder(path.dirname(g.path), exts);
  });
  listen('file:openInNewWindow', (_win, token) => {
    const g = grants.get(str(token));
    if (g) createWindow([g.path]);
  });
  listen('file:reveal', (_win, token) => {
    const g = grants.get(str(token));
    if (g) shell.showItemInFolder(g.path);
  });

  // ---- settings and crash recovery (this app's own folder only) ----
  handle('store:get', () => readJson('settings.json', {}));
  handle('store:set', (_e, _win, key, value) => {
    const all = readJson('settings.json', {});
    if (value === undefined) delete all[str(key, 200)];
    else all[str(key, 200)] = value;
    if (JSON.stringify(all).length > MAX_STORE) throw new Error('Settings are too large');
    writeJson('settings.json', all);
    return true;
  });
  const recoveryFile = (key) => path.join('recovery', `${str(key, 80).replace(/[^a-z0-9_-]/gi, '_')}.json`);
  handle('recovery:put', (_e, _win, key, value) => {
    const text = JSON.stringify(value);
    if (text.length > MAX_RECOVERY) return false;
    writeJson(recoveryFile(key), { time: Date.now(), value });
    return true;
  });
  handle('recovery:get', (_e, _win, key) => readJson(recoveryFile(key), null));
  handle('recovery:list', () => {
    const dir = path.join(userDir(), 'recovery');
    try {
      return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => {
        const st = fs.statSync(path.join(dir, f));
        return { key: f.slice(0, -5), time: st.mtimeMs, size: st.size };
      });
    } catch { return []; }
  });
  handle('recovery:delete', (_e, _win, key) => {
    fs.rmSync(path.join(userDir(), recoveryFile(key)), { force: true });
    return true;
  });

  // ---- printing ----
  handle('print:pdf', async (_e, win, opts = {}) => {
    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      landscape: !!opts.landscape,
      margins: { marginType: 'none' },
      generateDocumentOutline: true,
      generateTaggedPDF: true,
    });
    if (process.env.SNAKE_TEST_PDF) { // automated tests: no dialog
      await writeAtomic(process.env.SNAKE_TEST_PDF, pdf);
      return describe(grant(process.env.SNAKE_TEST_PDF, true));
    }
    const res = await dialog.showSaveDialog(win, {
      defaultPath: path.join(app.getPath('documents'), path.basename(str(opts.name, 200) || 'Document') + '.pdf'),
      filters: [{ name: 'PDF', extensions: ['pdf'] }],
    });
    if (res.canceled || !res.filePath) return null;
    await writeAtomic(res.filePath, pdf);
    return describe(grant(res.filePath, true));
  });
  handle('print:print', (_e, win) => new Promise((resolve) => {
    win.webContents.print({ printBackground: true }, (ok, reason) => resolve({ ok, reason }));
  }));

  // ---- spelling ----
  listen('spell:replace', (win, word) => win.webContents.replaceMisspelling(str(word, 100)));
  listen('spell:learn', (win, word) => win.webContents.session.addWordToSpellCheckerDictionary(str(word, 100)));

  // ---- clipboard (images; text goes through the page's own clipboard) ----
  // Electron's clipboard works like the web one: lists of ClipboardItem.
  handle('clipboard:readImage', async () => {
    for (const item of await clipboard.read()) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (!type) continue;
      const blob = await item.getType(type);
      if (blob.size > 512 * 1024 * 1024) return null;
      const bytes = new Uint8Array(await blob.arrayBuffer());
      if (type === 'image/png') return bytes;
      // Other picture types come back as PNG so pages only deal with one.
      const img = nativeImage.createFromBuffer(Buffer.from(bytes));
      return img.isEmpty() ? null : new Uint8Array(img.toPNG());
    }
    return null;
  });
  handle('clipboard:writeImage', async (_e, _win, png) => {
    if (!(png instanceof Uint8Array) || png.length > 512 * 1024 * 1024) return false;
    if (nativeImage.createFromBuffer(Buffer.from(png)).isEmpty()) return false; // only real pictures
    await clipboard.write([new ClipboardItem({ 'image/png': new Blob([png], { type: 'image/png' }) })]);
    return true;
  });

  // ---- links ----
  listen('shell:openExternal', (_win, url) => openExternal(url));
  listen('file:openWithSystem', (_win, token) => {
    const g = grants.get(str(token));
    if (g) shell.openPath(g.path);
  });

  media.register(handle, listen, { need, grant, describe, str, dataDir: () => app.getPath('userData') });
}

function listFolder(dir, exts) {
  const allow = Array.isArray(exts) && exts.length ? new Set(exts.map((e) => String(e).toLowerCase()))
    : new Set([...VIDEO_EXTS, ...AUDIO_EXTS, ...(META.open || []).flatMap((f) => f.exts)]);
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return []; }
  return names
    .filter((n) => allow.has(path.extname(n).slice(1).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
    .slice(0, 5000)
    .map((n) => describe(grant(path.join(dir, n), false)));
}

async function writeAtomic(file, data) {
  let buf;
  if (typeof data === 'string') buf = Buffer.from(data, 'utf8');
  else if (data instanceof Uint8Array) buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
  else if (data instanceof ArrayBuffer) buf = Buffer.from(data);
  else throw new Error('Nothing to save');
  const tmp = `${file}.snake-${process.pid}.tmp`;
  await fsp.writeFile(tmp, buf);
  await fsp.rename(tmp, file);
}

function openExternal(url) {
  try {
    const u = new URL(String(url));
    if (['https:', 'http:', 'mailto:'].includes(u.protocol)) shell.openExternal(u.toString());
  } catch {}
}

// ---------------------------------------------------------------------------
// Lock down every web page this app ever creates
// ---------------------------------------------------------------------------
app.on('web-contents-created', (_e, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault());
  contents.on('will-navigate', (e, url) => {
    if (url !== contents.getURL()) {
      e.preventDefault();
      openExternal(url);
    }
  });
  contents.on('will-redirect', (e) => e.preventDefault());
  contents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
});

function lockSession(ses) {
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    const fromUs = (details.requestingUrl || '').startsWith('snake://studio/');
    if (!fromUs) return callback(false);
    if (['clipboard-sanitized-write', 'clipboard-read', 'fullscreen', 'window-management', 'local-fonts'].includes(permission)) {
      return callback(true);
    }
    if (permission === 'media' && META.microphone) {
      const wantsVideo = (details.mediaTypes || []).includes('video');
      if (wantsVideo) return callback(false);
      const win = BrowserWindow.fromWebContents(wc);
      dialog.showMessageBox(win, {
        type: 'question', buttons: ['Allow', 'Deny'], defaultId: 0, cancelId: 1,
        message: `Let ${META.name} use your microphone?`,
        detail: 'It records only while you press Record, and keeps the recording in your project.',
      }).then((r) => callback(r.response === 0));
      return undefined;
    }
    return callback(false);
  });
  ses.setPermissionCheckHandler((_wc, permission, origin) => {
    if (!String(origin).startsWith('snake://studio')) return false;
    return ['clipboard-sanitized-write', 'clipboard-read', 'fullscreen', 'window-management', 'local-fonts'].includes(permission)
      || (permission === 'media' && !!META.microphone);
  });
  ses.setDevicePermissionHandler(() => false);
  ses.on('will-download', (e) => e.preventDefault()); // saving goes through our own dialogs
  if (META.spellcheck && process.platform !== 'darwin') {
    const lang = app.getLocale();
    const known = ses.availableSpellCheckerLanguages || [];
    ses.setSpellCheckerLanguages([known.includes(lang) ? lang : 'en-US']);
  }
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
app.whenReady().then(() => {
  protocol.handle('snake', serveApp);
  protocol.handle('snake-media', (req) => media.serve(req, grants));
  lockSession(session.defaultSession);
  registerIpc();
  createWindow(ARGS.files);
});

// macOS: files opened from Finder, and a window when the dock icon is clicked.
app.on('open-file', (e, file) => {
  e.preventDefault();
  const win = [...windows].find((w) => !w.isDestroyed() && w.snakeMain);
  if (win) sendOpen(win, [file]);
  else if (app.isReady()) createWindow([file]);
  else ARGS.files.push(file);
});
app.on('activate', () => { if (windows.size === 0 && app.isReady()) createWindow(); });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => media.stopAll());
