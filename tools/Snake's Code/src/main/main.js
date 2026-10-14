// Snake's Code — Electron main process.
const { app, BrowserWindow, ipcMain, dialog, shell, Menu, clipboard } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const { execFile, spawn } = require('child_process');

let pty = null;
try {
  pty = require('node-pty');
} catch (err) {
  console.error('node-pty unavailable, terminal disabled:', err.message);
}

const ROOT = path.join(__dirname, '..', '..');
const DIST = path.join(ROOT, 'dist');
const isDev = process.argv.includes('--dev');

app.setName("Snake's Code");
// Windows groups taskbar buttons and picks their icon by this id.
if (process.platform === 'win32') app.setAppUserModelId('Snake.Suite.Code');
if (process.env.SNAKE_USER_DATA) app.setPath('userData', process.env.SNAKE_USER_DATA);
Menu.setApplicationMenu(null);

// ---------------------------------------------------------------------------
// Persistent JSON stores (settings.json, keybindings.json, state.json)
// ---------------------------------------------------------------------------
const userDir = app.getPath('userData');
const storePaths = {
  settings: path.join(userDir, 'settings.json'),
  keybindings: path.join(userDir, 'keybindings.json'),
  state: path.join(userDir, 'state.json'),
};

function readJson(file, fallback) {
  try {
    const text = fs.readFileSync(file, 'utf8');
    // tolerate // comments and trailing commas in user-edited files
    const cleaned = text
      .replace(/("(?:\\.|[^"\\])*")|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m, str) => str || '')
      .replace(/,(\s*[}\]])/g, '$1');
    return JSON.parse(cleaned);
  } catch {
    return fallback;
  }
}

function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
}

for (const [key, file] of Object.entries(storePaths)) {
  if (!fs.existsSync(file)) writeJson(file, key === 'keybindings' ? [] : {});
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------
const windows = new Set();

function createWindow(openPath) {
  const state = readJson(storePaths.state, {});
  const bounds = state.windowBounds || { width: 1400, height: 900 };
  const win = new BrowserWindow({
    ...bounds,
    minWidth: 600,
    minHeight: 400,
    frame: false,
    backgroundColor: '#181818',
    title: "Snake's Code",
    icon: path.join(ROOT, 'assets', 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });
  win.snakeOpenPath = openPath || null;
  win.snakeIsFirst = windows.size === 0;
  win.snakeForceClose = false;
  win.snakePtys = new Map();
  win.snakeWatchers = new Map();
  windows.add(win);

  if (state.windowMaximized && win.snakeIsFirst) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(DIST, 'index.html'));
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });

  const sendMax = () => win.webContents.send('win:maximized', win.isMaximized());
  win.on('maximize', sendMax);
  win.on('unmaximize', sendMax);
  win.on('enter-full-screen', () => win.webContents.send('win:fullscreen', true));
  win.on('leave-full-screen', () => win.webContents.send('win:fullscreen', false));

  win.on('close', (e) => {
    if (win.snakeForceClose) return;
    e.preventDefault();
    win.webContents.send('app:beforeClose');
  });

  win.on('closed', () => {
    for (const p of win.snakePtys.values()) {
      try { p.kill(); } catch {}
    }
    for (const w of win.snakeWatchers.values()) w.close();
    windows.delete(win);
  });

  // Open links in the external browser instead of inside the app
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://')) {
      e.preventDefault();
      shell.openExternal(url);
    }
  });
  return win;
}

function winOf(event) {
  return BrowserWindow.fromWebContents(event.sender);
}

function argPath(argv) {
  const args = argv.slice(app.isPackaged ? 1 : 2).filter((a) => !a.startsWith('-') && a !== '.');
  if (!args.length) return null;
  const p = path.resolve(args[args.length - 1]);
  return fs.existsSync(p) ? p : null;
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv, cwd) => {
    const args = argv.filter((a) => !a.startsWith('-')).slice(-1)[0];
    const p = args ? path.resolve(cwd, args) : null;
    if (p && fs.existsSync(p) && p !== path.resolve(cwd, argv[0])) createWindow(p);
    else {
      const w = [...windows][0];
      if (w) { if (w.isMinimized()) w.restore(); w.focus(); }
    }
  });
  app.whenReady().then(() => createWindow(argPath(process.argv)));
}

app.on('window-all-closed', () => app.quit());

// ---------------------------------------------------------------------------
// Window / app IPC
// ---------------------------------------------------------------------------
ipcMain.handle('app:init', (e) => {
  const win = winOf(e);
  const openPath = win.snakeOpenPath;
  win.snakeOpenPath = null; // only honoured once, not on window reloads
  return {
    openPath,
    isFirstWindow: win.snakeIsFirst,
    platform: process.platform,
    homeDir: os.homedir(),
    sep: path.sep,
    userDir,
    storePaths,
    versions: { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, app: app.getVersion() },
    ptyAvailable: !!pty,
    shell: process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/bash'),
  };
});

ipcMain.on('win:minimize', (e) => winOf(e).minimize());
ipcMain.on('win:toggleMaximize', (e) => {
  const w = winOf(e);
  w.isMaximized() ? w.unmaximize() : w.maximize();
});
ipcMain.on('win:close', (e) => winOf(e).close());
ipcMain.on('win:forceClose', (e) => {
  const w = winOf(e);
  if (windows.size === 1) {
    const state = readJson(storePaths.state, {});
    state.windowMaximized = w.isMaximized();
    if (!w.isMaximized() && !w.isFullScreen()) state.windowBounds = w.getBounds();
    writeJson(storePaths.state, state);
  }
  w.snakeForceClose = true;
  w.close();
});
ipcMain.on('win:new', (_e, p) => createWindow(p || null));
ipcMain.on('win:setTitle', (e, t) => winOf(e).setTitle(t));
ipcMain.on('win:toggleFullScreen', (e) => {
  const w = winOf(e);
  w.setFullScreen(!w.isFullScreen());
});
ipcMain.on('win:setFullScreen', (e, v) => winOf(e).setFullScreen(!!v));
ipcMain.on('win:toggleDevTools', (e) => winOf(e).webContents.toggleDevTools());
ipcMain.on('win:reload', (e) => winOf(e).webContents.reloadIgnoringCache());
ipcMain.on('win:setZoom', (e, level) => winOf(e).webContents.setZoomLevel(level));
ipcMain.handle('win:isMaximized', (e) => winOf(e).isMaximized());
ipcMain.on('app:quit', () => {
  for (const w of windows) w.close();
});

// ---------------------------------------------------------------------------
// Stores
// ---------------------------------------------------------------------------
ipcMain.handle('store:get', (_e, key) => readJson(storePaths[key], key === 'keybindings' ? [] : {}));
ipcMain.handle('store:set', (_e, key, value) => writeJson(storePaths[key], value));

// ---------------------------------------------------------------------------
// File system
// ---------------------------------------------------------------------------
const IGNORED_DIRS = new Set(['.git', 'node_modules', '.hg', '.svn', '__pycache__', '.DS_Store', 'dist', 'build', 'target', '.next', '.cache', '.venv', 'venv']);

ipcMain.handle('fs:readDir', async (_e, dir) => {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const out = await Promise.all(
    entries.map(async (d) => {
      const full = path.join(dir, d.name);
      let isDir = d.isDirectory();
      const isSymlink = d.isSymbolicLink();
      if (isSymlink) {
        try { isDir = (await fsp.stat(full)).isDirectory(); } catch {}
      }
      return { name: d.name, path: full, isDir, isSymlink };
    }),
  );
  return out;
});

function isBinary(buf) {
  const n = Math.min(buf.length, 8000);
  for (let i = 0; i < n; i++) if (buf[i] === 0) return true;
  return false;
}

ipcMain.handle('fs:readFile', async (_e, file, opts = {}) => {
  const stat = await fsp.stat(file);
  if (stat.isDirectory()) throw new Error('Is a directory');
  if (stat.size > 64 * 1024 * 1024 && !opts.force) return { tooLarge: true, size: stat.size };
  const buf = await fsp.readFile(file);
  if (!opts.force && isBinary(buf)) return { binary: true, size: stat.size };
  let text = buf.toString('utf8');
  let bom = false;
  if (text.charCodeAt(0) === 0xfeff) { text = text.slice(1); bom = true; }
  return { content: text, size: stat.size, mtime: stat.mtimeMs, bom };
});

ipcMain.handle('fs:writeFile', async (_e, file, content, opts = {}) => {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  await fsp.writeFile(file, (opts.bom ? '\ufeff' : '') + content, 'utf8');
  const stat = await fsp.stat(file);
  return { mtime: stat.mtimeMs };
});

ipcMain.handle('fs:stat', async (_e, p) => {
  try {
    const s = await fsp.stat(p);
    return { exists: true, isDir: s.isDirectory(), size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs };
  } catch {
    return { exists: false };
  }
});

ipcMain.handle('fs:mkdir', (_e, p) => fsp.mkdir(p, { recursive: true }));
ipcMain.handle('fs:createFile', async (_e, p) => {
  await fsp.mkdir(path.dirname(p), { recursive: true });
  await fsp.writeFile(p, '', { flag: 'wx' });
});
ipcMain.handle('fs:rename', (_e, from, to) => fsp.rename(from, to));
ipcMain.handle('fs:copy', async (_e, from, to) => {
  await fsp.cp(from, to, { recursive: true, errorOnExist: true, force: false });
});
ipcMain.handle('fs:trash', async (_e, p) => {
  try {
    await shell.trashItem(p);
  } catch (err) {
    throw new Error('Could not move to trash: ' + err.message);
  }
});
ipcMain.handle('fs:delete', (_e, p) => fsp.rm(p, { recursive: true, force: true }));

// List all files for quick open (uses ripgrep when available, respects .gitignore)
let rgPath = null;
try {
  rgPath = require('child_process').execFileSync('which', ['rg']).toString().trim() || null;
} catch {}

ipcMain.handle('fs:listFiles', async (_e, root, excludes = []) => {
  if (rgPath) {
    return new Promise((resolve) => {
      const args = ['--files', '--hidden', '--glob', '!.git'];
      for (const g of excludes) args.push('--glob', '!' + g);
      execFile(rgPath, args, { cwd: root, maxBuffer: 256 * 1024 * 1024 }, (err, stdout) => {
        resolve(stdout ? stdout.split('\n').filter(Boolean).slice(0, 200000) : []);
      });
    });
  }
  const out = [];
  async function walk(dir, rel) {
    if (out.length > 100000) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const d of entries) {
      if (IGNORED_DIRS.has(d.name)) continue;
      const r = rel ? rel + '/' + d.name : d.name;
      if (d.isDirectory()) await walk(path.join(dir, d.name), r);
      else out.push(r);
    }
  }
  await walk(root, '');
  return out;
});

// Directory watchers: the renderer sends the full set of dirs it cares about.
ipcMain.on('fs:watchDirs', (e, dirs) => {
  const win = winOf(e);
  if (!win) return;
  const want = new Set(dirs);
  for (const [dir, w] of win.snakeWatchers) {
    if (!want.has(dir)) { w.close(); win.snakeWatchers.delete(dir); }
  }
  for (const dir of want) {
    if (win.snakeWatchers.has(dir)) continue;
    try {
      let timer = null;
      const pending = new Set();
      const w = fs.watch(dir, { persistent: false }, (_type, filename) => {
        pending.add(filename ? path.join(dir, filename.toString()) : dir);
        clearTimeout(timer);
        timer = setTimeout(() => {
          if (!win.isDestroyed()) win.webContents.send('fs:changed', { dir, paths: [...pending] });
          pending.clear();
        }, 120);
      });
      w.on('error', () => { w.close(); win.snakeWatchers.delete(dir); });
      win.snakeWatchers.set(dir, w);
    } catch {}
  }
});

// ---------------------------------------------------------------------------
// Search in files
// ---------------------------------------------------------------------------
let activeSearch = null;
ipcMain.handle('search:run', async (e, q) => {
  if (activeSearch) { try { activeSearch.kill(); } catch {} activeSearch = null; }
  const maxResults = q.maxResults || 20000;
  if (rgPath) {
    const args = ['--json', '--hidden', '--glob', '!.git', '--max-columns', '1000', '--max-filesize', '8M'];
    if (!q.matchCase) args.push('--ignore-case');
    if (q.wholeWord) args.push('--word-regexp');
    if (!q.isRegex) args.push('--fixed-strings');
    if (q.isRegex) args.push('--pcre2');
    const splitGlobs = (s) => (s || '').split(',').map((x) => x.trim()).filter(Boolean);
    for (const g of splitGlobs(q.include)) args.push('--glob', g);
    for (const g of splitGlobs(q.exclude)) args.push('--glob', '!' + g);
    if (q.noIgnore) args.push('--no-ignore');
    args.push('--', q.query, '.');
    return new Promise((resolve) => {
      const proc = spawn(rgPath, args, { cwd: q.root });
      activeSearch = proc;
      const files = new Map();
      let count = 0;
      let buf = '';
      let limitHit = false;
      let errText = '';
      proc.stdout.on('data', (chunk) => {
        buf += chunk;
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx);
          buf = buf.slice(idx + 1);
          if (!line) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }
          if (msg.type !== 'match') continue;
          const rel = (msg.data.path.text || '').replace(/^\.\//, '');
          const text = msg.data.lines.text != null ? msg.data.lines.text.replace(/\r?\n$/, '') : '';
          const bytes = Buffer.from(text, 'utf8');
          let entry = files.get(rel);
          if (!entry) { entry = { path: path.join(q.root, rel), rel, matches: [] }; files.set(rel, entry); }
          for (const sm of msg.data.submatches) {
            // convert byte offsets to UTF-16 columns
            const start = bytes.subarray(0, sm.start).toString('utf8').length;
            const end = bytes.subarray(0, sm.end).toString('utf8').length;
            entry.matches.push({ line: msg.data.line_number, start, end, text });
            if (++count >= maxResults) { limitHit = true; proc.kill(); break; }
          }
        }
      });
      proc.stderr.on('data', (d) => (errText += d));
      proc.on('close', () => {
        if (activeSearch === proc) activeSearch = null;
        resolve({ files: [...files.values()], count, limitHit, error: count === 0 && errText && !/No files were searched/.test(errText) ? errText.trim() : null });
      });
    });
  }
  // Fallback: pure JS search
  const results = [];
  let count = 0;
  let re;
  try {
    let src = q.isRegex ? q.query : q.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (q.wholeWord) src = `\\b${src}\\b`;
    re = new RegExp(src, q.matchCase ? 'g' : 'gi');
  } catch (err) {
    return { files: [], count: 0, error: err.message };
  }
  async function walk(dir) {
    if (count >= maxResults) return;
    let entries;
    try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const d of entries) {
      const full = path.join(dir, d.name);
      if (d.isDirectory()) { if (!IGNORED_DIRS.has(d.name)) await walk(full); continue; }
      let buf;
      try { const s = await fsp.stat(full); if (s.size > 4 * 1024 * 1024) continue; buf = await fsp.readFile(full); } catch { continue; }
      if (isBinary(buf)) continue;
      const lines = buf.toString('utf8').split(/\r?\n/);
      const matches = [];
      lines.forEach((text, i) => {
        re.lastIndex = 0;
        let m;
        while ((m = re.exec(text))) {
          matches.push({ line: i + 1, start: m.index, end: m.index + m[0].length, text });
          if (m[0].length === 0) re.lastIndex++;
          if (++count >= maxResults) break;
        }
      });
      if (matches.length) results.push({ path: full, rel: path.relative(q.root, full), matches });
      if (count >= maxResults) return;
    }
  }
  await walk(q.root);
  return { files: results, count, limitHit: count >= maxResults };
});
ipcMain.on('search:cancel', () => {
  if (activeSearch) { try { activeSearch.kill(); } catch {} activeSearch = null; }
});

// ---------------------------------------------------------------------------
// Terminal (node-pty)
// ---------------------------------------------------------------------------
let ptyCounter = 0;
ipcMain.handle('pty:create', (e, opts = {}) => {
  if (!pty) throw new Error('Terminal backend (node-pty) is not available. Run "npm run rebuild".');
  const win = winOf(e);
  const shellPath = opts.shell || process.env.SHELL || (process.platform === 'win32' ? 'powershell.exe' : '/bin/bash');
  const id = ++ptyCounter;
  const proc = pty.spawn(shellPath, opts.args || [], {
    name: 'xterm-256color',
    cols: opts.cols || 80,
    rows: opts.rows || 24,
    cwd: opts.cwd && fs.existsSync(opts.cwd) ? opts.cwd : os.homedir(),
    env: { ...process.env, TERM_PROGRAM: 'snakes-code', COLORTERM: 'truecolor', ...(opts.env || {}) },
  });
  win.snakePtys.set(id, proc);
  proc.onData((data) => { if (!win.isDestroyed()) win.webContents.send('pty:data', id, data); });
  proc.onExit(({ exitCode }) => {
    win.snakePtys.delete(id);
    if (!win.isDestroyed()) win.webContents.send('pty:exit', id, exitCode);
  });
  return { id, pid: proc.pid, shell: path.basename(shellPath) };
});
ipcMain.on('pty:write', (e, id, data) => winOf(e)?.snakePtys.get(id)?.write(data));
ipcMain.on('pty:resize', (e, id, cols, rows) => {
  try { winOf(e)?.snakePtys.get(id)?.resize(Math.max(cols, 1), Math.max(rows, 1)); } catch {}
});
ipcMain.on('pty:kill', (e, id) => {
  const p = winOf(e)?.snakePtys.get(id);
  if (p) { try { p.kill(); } catch {} }
});
ipcMain.handle('pty:cwd', async (e, id) => {
  const p = winOf(e)?.snakePtys.get(id);
  if (!p || process.platform !== 'linux') return null;
  try { return await fsp.readlink(`/proc/${p.pid}/cwd`); } catch { return null; }
});

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------
ipcMain.handle('git:run', (_e, cwd, args, opts = {}) =>
  new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', ...(opts.env || {}) } }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: stdout || '', stderr: stderr || (err && !stderr ? err.message : '') });
    });
  }),
);

// ---------------------------------------------------------------------------
// Dialogs & shell
// ---------------------------------------------------------------------------
ipcMain.handle('dialog:openFolder', async (e, title) => {
  const r = await dialog.showOpenDialog(winOf(e), { title: title || 'Open Folder', properties: ['openDirectory', 'createDirectory'] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('dialog:openFiles', async (e) => {
  const r = await dialog.showOpenDialog(winOf(e), { title: 'Open File', properties: ['openFile', 'multiSelections'] });
  return r.canceled ? [] : r.filePaths;
});
ipcMain.handle('dialog:saveAs', async (e, defaultPath) => {
  const r = await dialog.showSaveDialog(winOf(e), { title: 'Save As', defaultPath: defaultPath || os.homedir() });
  return r.canceled ? null : r.filePath;
});
ipcMain.handle('dialog:message', async (e, opts) => {
  const r = await dialog.showMessageBox(winOf(e), {
    type: opts.type || 'question',
    message: opts.message,
    detail: opts.detail,
    buttons: opts.buttons || ['OK'],
    defaultId: opts.defaultId || 0,
    cancelId: opts.cancelId != null ? opts.cancelId : (opts.buttons || ['OK']).length - 1,
    noLink: true,
    title: "Snake's Code",
  });
  return r.response;
});

ipcMain.on('shell:openExternal', (_e, url) => shell.openExternal(url));
ipcMain.on('shell:showItemInFolder', (_e, p) => shell.showItemInFolder(p));
ipcMain.on('shell:openPath', (_e, p) => shell.openPath(p));
ipcMain.on('clipboard:write', (_e, text) => clipboard.writeText(text));
ipcMain.handle('clipboard:read', () => clipboard.readText());

// Run a one-off command and capture its output (used by tasks discovery etc.)
ipcMain.handle('proc:exec', (_e, cmd, args, cwd) =>
  new Promise((resolve) => {
    execFile(cmd, args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? err.code || 1 : 0, stdout: stdout || '', stderr: stderr || '' });
    });
  }),
);
