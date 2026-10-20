// Snake's Terminal: Electron main process. Windows, terminals (node-pty), settings, the hotkey.
const { app, BrowserWindow, ipcMain, shell, Menu, clipboard, dialog, globalShortcut, Notification, nativeTheme } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const { execFile } = require('child_process');
const devices = require('./devices');

let pty = null;
try {
  pty = require('node-pty');
} catch (err) {
  console.error('node-pty unavailable:', err.message);
}

// On Linux, Node hands every descriptor Chromium keeps open (IPC sockets, shared memory,
// the GPU device) to the programs it starts. Shells start through a fixed bash line that
// closes everything but stdin, stdout and stderr and then becomes the program, its
// arguments untouched ("$@": nothing is parsed). macOS and Windows do not leak them.
const CLOSE_FDS = 'for f in /dev/fd/*; do n=${f##*/}; [ "$n" -gt 2 ] 2>/dev/null && eval "exec $n>&-"; done; exec "$@"';
const BASH = process.platform === 'linux'
  ? ['/bin/bash', '/usr/bin/bash'].find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } })
  : null;
function clean(exe, args) {
  return BASH ? [BASH, ['-c', CLOSE_FDS, 'snake-exec', exe, ...args]] : [exe, args];
}

const ROOT = path.join(__dirname, '..', '..');
// Its own version, also when it runs inside the Snake's Studio package (where Electron's own app version is Studio's).
const VERSION = require(path.join(ROOT, 'package.json')).version;
const DIST = path.join(ROOT, 'dist');
const isDev = process.argv.includes('--dev');
const IS_MAC = process.platform === 'darwin';

app.setName("Snake's Terminal");
app.enableSandbox();
if (process.platform === 'win32') app.setAppUserModelId('Snake.Suite.Terminal');
if (process.env.SNAKE_USER_DATA) app.setPath('userData', process.env.SNAKE_USER_DATA);
nativeTheme.themeSource = 'dark';

// ---------------------------------------------------------------------------
// Only the app's own page may start programs, read keys or touch the clipboard.
// ---------------------------------------------------------------------------
const windows = new Set();
function trusted(event) {
  const frame = event.senderFrame;
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!frame || !win || !windows.has(win) || frame !== event.sender.mainFrame) return false;
  try {
    return path.resolve(decodeURIComponent(new URL(frame.url).pathname)) === path.resolve(DIST, 'index.html')
      || decodeURIComponent(new URL(frame.url).pathname).endsWith('/dist/index.html');
  } catch { return false; }
}
const rawHandle = ipcMain.handle.bind(ipcMain);
const rawOn = ipcMain.on.bind(ipcMain);
ipcMain.handle = (channel, fn) => rawHandle(channel, (e, ...args) => {
  if (!trusted(e)) throw new Error('Refused');
  return fn(e, ...args);
});
ipcMain.on = (channel, fn) => rawOn(channel, (e, ...args) => {
  if (!trusted(e)) return undefined;
  return fn(e, ...args);
});

/** Web and mail links open in the browser; nothing else leaves the app this way. */
function openExternal(url) {
  try {
    const u = new URL(String(url));
    if (['http:', 'https:', 'mailto:'].includes(u.protocol)) shell.openExternal(u.href);
  } catch {}
}

// ---------------------------------------------------------------------------
// Settings and window state (JSON in the user data folder)
// ---------------------------------------------------------------------------
const userDir = app.getPath('userData');
const files = { settings: path.join(userDir, 'settings.json'), state: path.join(userDir, 'state.json') };

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
  fs.renameSync(tmp, file);
}
let settings = readJson(files.settings, {});

// ---------------------------------------------------------------------------
// Shells available on this computer, for new tabs and profiles
// ---------------------------------------------------------------------------
function defaultShell() {
  if (process.platform === 'win32') {
    const pwsh = devices.which('pwsh');
    return pwsh || path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  }
  if (process.env.SHELL && fs.existsSync(process.env.SHELL)) return process.env.SHELL;
  try {
    const line = fs.readFileSync('/etc/passwd', 'utf8').split('\n').find((l) => l.split(':')[2] === String(process.getuid()));
    const sh = line?.split(':')[6];
    if (sh && fs.existsSync(sh)) return sh;
  } catch {}
  return IS_MAC ? '/bin/zsh' : '/bin/bash';
}

function detectShells() {
  const found = [];
  const add = (name, file, args = []) => {
    if (file && !found.some((s) => s.file === file && JSON.stringify(s.args) === JSON.stringify(args))) found.push({ name, file, args });
  };
  if (process.platform === 'win32') {
    const sys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32');
    add('PowerShell', devices.which('pwsh'));
    add('Windows PowerShell', path.join(sys, 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
    add('Command Prompt', path.join(sys, 'cmd.exe'));
    const gitBash = ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files (x86)\\Git\\bin\\bash.exe'].find((p) => fs.existsSync(p));
    if (gitBash) add('Git Bash', gitBash, ['--login', '-i']);
    const wsl = path.join(sys, 'wsl.exe');
    if (fs.existsSync(wsl)) add('WSL', wsl);
    return found;
  }
  add(path.basename(defaultShell()), defaultShell());
  let listed = [];
  try { listed = fs.readFileSync('/etc/shells', 'utf8').split('\n').map((l) => l.trim()).filter((l) => l.startsWith('/')); } catch {}
  for (const file of listed) {
    if (!fs.existsSync(file)) continue;
    const name = path.basename(file);
    if (['sh', 'rbash', 'git-shell', 'nologin', 'false'].includes(name)) continue;
    if (found.some((s) => fs.realpathSync(s.file) === fs.realpathSync(file))) continue;
    add(name, file);
  }
  return found;
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------
function createWindow(opts = {}) {
  const state = readJson(files.state, {});
  const bounds = state.bounds && windows.size === 0 ? state.bounds : { width: 1100, height: 720 };
  const win = new BrowserWindow({
    ...bounds,
    minWidth: 420,
    minHeight: 260,
    frame: IS_MAC,
    titleBarStyle: IS_MAC ? 'hiddenInset' : undefined,
    trafficLightPosition: IS_MAC ? { x: 12, y: 12 } : undefined,
    backgroundColor: '#151916',
    title: "Snake's Terminal",
    icon: path.join(ROOT, 'assets', 'icon.png'),
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webviewTag: false,
      spellcheck: false,
    },
  });
  win.snake = { ptys: new Map(), restore: windows.size === 0 && !opts.fresh, cwd: opts.cwd || null, command: opts.command || null, close: false };
  windows.add(win);
  if (state.maximized && windows.size === 1) win.maximize();
  win.once('ready-to-show', () => win.show());
  win.loadFile(path.join(DIST, 'index.html'));
  if (isDev) win.webContents.openDevTools({ mode: 'detach' });

  const sendMax = () => !win.isDestroyed() && win.webContents.send('win:maximized', win.isMaximized());
  win.on('maximize', sendMax);
  win.on('unmaximize', sendMax);
  win.on('enter-full-screen', () => win.webContents.send('win:fullscreen', true));
  win.on('leave-full-screen', () => win.webContents.send('win:fullscreen', false));
  win.on('focus', () => win.webContents.send('win:focus', true));
  win.on('blur', () => !win.isDestroyed() && win.webContents.send('win:focus', false));
  win.on('close', (e) => {
    saveBounds(win);
    if (win.snake.close) return;
    e.preventDefault();
    win.webContents.send('app:beforeClose');
  });
  win.on('closed', () => {
    for (const p of win.snake.ptys.values()) { try { p.kill(); } catch {} }
    windows.delete(win);
  });
  win.webContents.setWindowOpenHandler(({ url }) => { openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => {
    if (url !== win.webContents.getURL()) { e.preventDefault(); openExternal(url); }
  });
  win.webContents.on('will-attach-webview', (e) => e.preventDefault());
  return win;
}

function saveBounds(win) {
  if (win.isDestroyed() || win.isMinimized()) return;
  const state = readJson(files.state, {});
  state.maximized = win.isMaximized();
  if (!win.isMaximized() && !win.isFullScreen()) state.bounds = win.getBounds();
  writeJson(files.state, state);
}

const winOf = (e) => BrowserWindow.fromWebContents(e.sender);
const focusedWindow = () => BrowserWindow.getFocusedWindow() || [...windows].pop();

/** The hotkey (and `snakes-terminal --toggle`): bring the terminal forward, or put it away. */
function toggleWindow() {
  const win = [...windows].pop();
  if (!win) { createWindow(); return; }
  if (win.isFocused() && win.isVisible() && !win.isMinimized()) {
    if (IS_MAC) app.hide(); else win.minimize();
  } else {
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send('app:focusTerminal');
  }
}

function applyHotkey() {
  globalShortcut.unregisterAll();
  const key = settings.hotkey;
  if (!key) return { ok: true };
  try {
    return { ok: globalShortcut.register(key, toggleWindow) };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Arguments: --toggle, --new-window, --working-directory DIR, -e COMMAND… */
function parseArgs(argv, cwd) {
  const args = argv.slice(app.isPackaged ? 1 : 2);
  const out = { toggle: false, newWindow: false, cwd: null, command: null };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--toggle') out.toggle = true;
    else if (a === '--new-window') out.newWindow = true;
    else if ((a === '--working-directory' || a === '--cwd') && args[i + 1]) out.cwd = path.resolve(cwd || process.cwd(), args[++i]);
    else if (a === '-e' || a === '--') { out.command = args.slice(i + 1); break; }
    else if (!a.startsWith('-') && a !== '.' && fs.existsSync(path.resolve(cwd || process.cwd(), a)) && fs.statSync(path.resolve(cwd || process.cwd(), a)).isDirectory()) out.cwd = path.resolve(cwd || process.cwd(), a);
  }
  return out;
}

// ---------------------------------------------------------------------------
// The macOS menu bar: the usual Cmd shortcuts, sent to the page as commands
// ---------------------------------------------------------------------------
function buildMacMenu() {
  if (!IS_MAC) { Menu.setApplicationMenu(null); return; }
  // The accelerators are shown but not taken: the keys go to the page, which runs them (and
  // lets you change them). Copy and Paste then copy the terminal's selection, not the page's.
  const cmd = (label, id, accelerator) => ({ label, accelerator, registerAccelerator: false, click: () => focusedWindow()?.webContents.send('menu:command', id) });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: "Snake's Terminal", submenu: [
      { role: 'about' }, { type: 'separator' },
      cmd('Settings…', 'prefs.open', 'Cmd+,'), { type: 'separator' },
      { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' }, { type: 'separator' }, { role: 'quit' },
    ] },
    { label: 'Shell', submenu: [
      cmd('New Window', 'window.new', 'Cmd+N'), cmd('New Tab', 'tab.new', 'Cmd+T'),
      cmd('Split Right', 'pane.splitRight', 'Cmd+D'), cmd('Split Down', 'pane.splitDown', 'Cmd+Shift+D'),
      { type: 'separator' }, cmd('Save Output as Text…', 'term.export', 'Cmd+S'),
      { type: 'separator' }, cmd('Connect to a Device…', 'devices.toggle', 'Cmd+Shift+O'),
      { type: 'separator' }, cmd('Close', 'pane.close', 'Cmd+W'),
    ] },
    { label: 'Edit', submenu: [
      { role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' },
      cmd('Copy', 'edit.copy', 'Cmd+C'), cmd('Copy as One Line', 'edit.copyOneLine', 'Cmd+Alt+C'),
      cmd('Paste', 'edit.paste', 'Cmd+V'), cmd('Paste Selection', 'edit.pasteSelection', 'Cmd+Shift+V'),
      cmd('Select All', 'edit.selectAll', 'Cmd+A'), cmd('Copy on Select (toggle)', 'edit.copyOnSelect'),
      { type: 'separator' }, cmd('Find…', 'find.open', 'Cmd+F'), cmd('Clear Buffer', 'term.clear', 'Cmd+K'),
      { type: 'separator' }, cmd('Broadcast Input to All Panes', 'pane.broadcast', 'Cmd+Alt+I'),
    ] },
    { label: 'View', submenu: [
      cmd('Bigger', 'font.bigger', 'Cmd+='), cmd('Smaller', 'font.smaller', 'Cmd+-'), cmd('Actual Size', 'font.reset', 'Cmd+0'),
      { type: 'separator' }, cmd('Maximize Pane', 'pane.maximize', 'Cmd+Shift+Enter'),
      cmd('Command Palette…', 'palette.open', 'Cmd+Shift+P'), { role: 'togglefullscreen' },
    ] },
    { label: 'Window', submenu: [
      cmd('Next Tab', 'tab.next', 'Cmd+Shift+]'), cmd('Previous Tab', 'tab.prev', 'Cmd+Shift+['),
      { type: 'separator' }, { role: 'minimize' }, { role: 'zoom' },
    ] },
  ]));
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_e, argv, cwd) => {
    const a = parseArgs(argv, cwd);
    if (a.toggle) { toggleWindow(); return; }
    if (a.newWindow || a.cwd || a.command || !windows.size) { createWindow({ fresh: true, cwd: a.cwd, command: a.command }); return; }
    const w = [...windows].pop();
    if (w.isMinimized()) w.restore();
    w.show();
    w.focus();
  });
  app.on('web-contents-created', (_e, contents) => {
    contents.session.on('will-download', (ev, item) => { ev.preventDefault(); item.cancel(); });
  });
  app.whenReady().then(() => {
    const { session } = require('electron');
    const allowed = new Set(['clipboard-sanitized-write', 'fullscreen', 'notifications']);
    session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => cb(allowed.has(permission)));
    session.defaultSession.setPermissionCheckHandler((_wc, permission) => allowed.has(permission));
    buildMacMenu();
    applyHotkey();
    const a = parseArgs(process.argv);
    createWindow({ cwd: a.cwd, command: a.command, fresh: !!(a.cwd || a.command) });
    devices.advertise(settings.advertise !== false);
  });
  app.on('activate', () => { if (!windows.size) createWindow(); });
  app.on('will-quit', () => { globalShortcut.unregisterAll(); devices.stopAll(); });
}
app.on('window-all-closed', () => { if (!IS_MAC) app.quit(); });

// ---------------------------------------------------------------------------
// Page ↔ main
// ---------------------------------------------------------------------------
ipcMain.handle('app:init', (e) => {
  const win = winOf(e);
  const first = { restore: win.snake.restore, cwd: win.snake.cwd, command: win.snake.command };
  win.snake.restore = false; // only once, not on reloads
  win.snake.cwd = win.snake.command = null;
  return {
    platform: process.platform,
    home: os.homedir(),
    user: os.userInfo().username,
    hostname: os.hostname(),
    defaultShell: defaultShell(),
    shells: detectShells(),
    ssh: devices.sshPath(),
    settings,
    state: readJson(files.state, {}),
    first,
    ptyAvailable: !!pty,
    versions: { app: VERSION, electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node },
  };
});

ipcMain.handle('settings:set', (e, next) => {
  settings = next && typeof next === 'object' ? next : {};
  writeJson(files.settings, settings);
  for (const w of windows) if (w.webContents !== e.sender) w.webContents.send('settings:changed', settings);
  devices.advertise(settings.advertise !== false);
  return applyHotkey();
});
ipcMain.handle('state:set', (_e, patch) => {
  const state = { ...readJson(files.state, {}), ...patch };
  writeJson(files.state, state);
});

ipcMain.on('win:minimize', (e) => winOf(e)?.minimize());
ipcMain.on('win:toggleMaximize', (e) => { const w = winOf(e); if (w) w.isMaximized() ? w.unmaximize() : w.maximize(); });
ipcMain.on('win:close', (e) => winOf(e)?.close());
ipcMain.on('win:forceClose', (e) => { const w = winOf(e); if (w) { w.snake.close = true; w.close(); } });
ipcMain.on('win:new', (_e, opts) => createWindow({ fresh: true, cwd: opts?.cwd || null }));
ipcMain.on('win:setTitle', (e, title) => winOf(e)?.setTitle(String(title).slice(0, 200)));
ipcMain.on('win:toggleFullScreen', (e) => { const w = winOf(e); if (w) w.setFullScreen(!w.isFullScreen()); });
ipcMain.on('win:flash', (e) => { const w = winOf(e); if (w && !w.isFocused()) w.flashFrame(true); });
ipcMain.handle('win:isMaximized', (e) => winOf(e)?.isMaximized());

ipcMain.handle('clipboard:read', (_e, which) => clipboard.readText(which === 'selection' && process.platform === 'linux' ? 'selection' : 'clipboard'));
ipcMain.on('clipboard:write', (_e, text, which) => {
  const t = String(text ?? '');
  if (which === 'selection') { if (process.platform === 'linux') clipboard.writeText(t, 'selection'); return; }
  clipboard.writeText(t);
});
ipcMain.on('shell:openExternal', (_e, url) => openExternal(url));
// In the window's own text boxes on a Mac, Cmd+C/V/A do what they always do.
ipcMain.on('edit:native', (e, action) => {
  if (['copy', 'paste', 'selectAll', 'cut'].includes(action)) e.sender[action]();
});
ipcMain.on('notify', (e, title, body) => {
  const w = winOf(e);
  if (w?.isFocused() || !Notification.isSupported()) return;
  const n = new Notification({ title: String(title).slice(0, 100), body: String(body).slice(0, 300), icon: path.join(ROOT, 'assets', 'icon.png') });
  n.on('click', () => { if (w && !w.isDestroyed()) { w.show(); w.focus(); } });
  n.show();
});

/** A colour scheme file (.itermcolors and the like), read for the page; it never gets a path. */
ipcMain.handle('dialog:openScheme', async (e) => {
  const r = await dialog.showOpenDialog(winOf(e), {
    title: 'Import a colour scheme',
    filters: [{ name: 'Colour schemes', extensions: ['itermcolors', 'json'] }],
    properties: ['openFile', 'multiSelections'],
  });
  if (r.canceled) return [];
  const out = [];
  for (const file of r.filePaths.slice(0, 50)) {
    const st = await fsp.stat(file);
    if (st.size < 1_000_000) out.push({ name: path.basename(file).replace(/\.[^.]+$/, ''), text: await fsp.readFile(file, 'utf8') });
  }
  return out;
});
// The page hands over text; only the file the user picks here is written.
ipcMain.handle('dialog:saveText', async (e, { text, name }) => {
  const r = await dialog.showSaveDialog(winOf(e), {
    title: 'Save the output as text',
    defaultPath: path.join(app.getPath('documents'), String(name || 'terminal.txt').replace(/[\\/:*?"<>|]+/g, '-').slice(0, 120)),
    filters: [{ name: 'Text', extensions: ['txt', 'log'] }, { name: 'All files', extensions: ['*'] }],
  });
  if (r.canceled || !r.filePath) return null;
  await fsp.writeFile(r.filePath, String(text ?? ''), 'utf8');
  return r.filePath;
});
ipcMain.handle('dialog:confirm', async (e, { message, detail, buttons = ['OK', 'Cancel'], defaultId = 0, cancelId = 1, checkbox }) => {
  const r = await dialog.showMessageBox(winOf(e), { type: 'question', message, detail, buttons, defaultId, cancelId, checkboxLabel: checkbox, noLink: true });
  return { response: r.response, checked: r.checkboxChecked };
});

// ---------------------------------------------------------------------------
// Terminals
// ---------------------------------------------------------------------------
let ptyCounter = 0;
ipcMain.handle('pty:create', (e, opts = {}) => {
  if (!pty) throw new Error('The terminal engine (node-pty) did not load. Reinstall Snake\'s Terminal.');
  const win = winOf(e);
  const file = opts.file || defaultShell();
  const args = Array.isArray(opts.args) ? opts.args.map(String) : [];
  const cwd = opts.cwd && fs.existsSync(opts.cwd) && fs.statSync(opts.cwd).isDirectory() ? opts.cwd : os.homedir();
  // CHROME_DESKTOP names this app's taskbar entry; programs started from the shell must not inherit it.
  const inherited = Object.fromEntries(Object.entries(process.env).filter(([k]) => k !== 'CHROME_DESKTOP'));
  const env = { ...inherited, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'SnakesTerminal', TERM_PROGRAM_VERSION: VERSION, LC_TERMINAL: 'SnakesTerminal' };
  for (const k of ['ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE', 'CHROME_DESKTOP', 'GDK_BACKEND', 'NO_AT_BRIDGE']) delete env[k];
  for (const [k, v] of Object.entries(opts.env || {})) if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) env[k] = String(v);
  if (!env.LANG && process.platform !== 'win32') env.LANG = 'en_US.UTF-8';
  const id = ++ptyCounter;
  const proc = pty.spawn(...clean(file, args), {
    name: 'xterm-256color',
    cols: Math.max(2, opts.cols | 0 || 80),
    rows: Math.max(1, opts.rows | 0 || 24),
    cwd,
    env,
    useConpty: true,
  });
  win.snake.ptys.set(id, proc);
  // Batch output a little: one message per few milliseconds instead of one per read.
  let buf = '';
  let timer = null;
  const flush = () => { timer = null; if (buf && !win.isDestroyed()) win.webContents.send('pty:data', id, buf); buf = ''; };
  proc.onData((data) => {
    buf += data;
    if (buf.length > 65536) flush();
    else if (!timer) timer = setTimeout(flush, 4);
  });
  proc.onExit(({ exitCode, signal }) => {
    flush();
    win.snake.ptys.delete(id);
    if (!win.isDestroyed()) win.webContents.send('pty:exit', id, exitCode, signal);
  });
  return { id, pid: proc.pid, file: path.basename(file) };
});
ipcMain.on('pty:write', (e, id, data) => winOf(e)?.snake.ptys.get(id)?.write(String(data)));
ipcMain.on('pty:resize', (e, id, cols, rows) => {
  try { winOf(e)?.snake.ptys.get(id)?.resize(Math.max(cols | 0, 2), Math.max(rows | 0, 1)); } catch {}
});
ipcMain.on('pty:kill', (e, id) => { const p = winOf(e)?.snake.ptys.get(id); if (p) { try { p.kill(); } catch {} } });

/** The folder the shell is in (Linux: /proc; macOS: lsof), so new tabs and splits open there. */
ipcMain.handle('pty:cwd', async (e, id) => {
  const p = winOf(e)?.snake.ptys.get(id);
  if (!p) return null;
  if (process.platform === 'linux') {
    try { return await fsp.readlink(`/proc/${p.pid}/cwd`); } catch { return null; }
  }
  if (IS_MAC) {
    return new Promise((resolve) => execFile('/usr/sbin/lsof', ['-a', '-p', String(p.pid), '-d', 'cwd', '-Fn'], { timeout: 1500 }, (err, out) => {
      const line = !err && String(out).split('\n').find((l) => l.startsWith('n'));
      resolve(line ? line.slice(1) : null);
    }));
  }
  return null;
});

/** The program in the foreground (to name tabs and to ask before closing one that is busy). */
ipcMain.handle('pty:process', (e, id) => {
  const p = winOf(e)?.snake.ptys.get(id);
  try { return p ? path.basename(String(p.process || '')) : null; } catch { return null; }
});

// ---------------------------------------------------------------------------
// Devices (SSH): see devices.js
// ---------------------------------------------------------------------------
ipcMain.handle('devices:local', () => devices.local());
ipcMain.handle('devices:sshConfig', () => devices.sshConfig());
ipcMain.handle('devices:keys', () => devices.keys());
ipcMain.handle('devices:makeKey', () => devices.makeKey());
ipcMain.handle('devices:tailscale', () => devices.tailscale());
ipcMain.handle('devices:scan', (e) => devices.scan((found) => { if (!e.sender.isDestroyed()) e.sender.send('devices:scanFound', found); }));
ipcMain.on('devices:browse', (e, on) => devices.browse(on ? (list) => { if (!e.sender.isDestroyed()) e.sender.send('devices:nearby', list); } : null));
ipcMain.handle('devices:installKeyCommand', (_e, host) => devices.installKeyCommand(host));
ipcMain.handle('devices:enableSshCommand', () => devices.enableSshCommand());
ipcMain.on('devices:openSharingSettings', () => {
  if (IS_MAC) shell.openExternal('x-apple.systempreferences:com.apple.Sharing-Settings.extension');
});
