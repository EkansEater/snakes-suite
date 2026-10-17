// Snake's Terminal: the page. Builds the window, wires keys, menus and the panels.
import '@xterm/xterm/css/xterm.css';
import './styles.css';
import { el, icon, bus, setPlatform, platform } from './modules/util.js';
import { env } from './modules/env.js';
import { settings, loadSettings, profileById } from './modules/settings.js';
import { commandFor, rebuild as rebuildKeys, keyLabel } from './modules/keys.js';
import { handlers, run } from './modules/commands.js';
import {
  initLayout, newTab, split, closeSession, closeTab, activeSession, activeTab, allSessions, tabs, cycleTab, gotoTab, moveTab,
  toggleMaximize, focusPane, cyclePane, toggleBroadcast, renameTab, snapshot, restore, updateTitles,
} from './modules/layout.js';
import { fontZoom, setFontZoom } from './modules/session.js';
import { initDevices, onOpen as devicesOpened, onClose as devicesClosed, editHost } from './modules/devices.js';
import { openPrefs } from './modules/prefs.js';
import { openPalette } from './modules/palette.js';
import { openFind, closeFind } from './modules/find.js';
import { showMenu, toast, openDialogs } from './modules/ui.js';
import { parseItermColors } from './modules/themes.js';

let devicesPanel;
let closing = false;

async function boot() {
  const info = await window.snake.init();
  setPlatform(info.platform);
  Object.assign(env, info);
  loadSettings(info.settings);
  document.body.classList.add(`os-${platform.os}`);

  // The window: tab bar on top, the devices panel and the terminals below.
  const tabsEl = el('div.tabs', { role: 'tablist' });
  const newBtn = el('button.icon-btn.new-tab', { title: `New tab (${keyLabel('tab.new')})`, on: { click: () => run('tab.new') } }, icon('plus'));
  const newMenu = el('button.icon-btn.new-menu', { title: 'New tab with…', on: { click: (e) => newTabMenu(e.currentTarget) } }, icon('chevron'));
  const devBtn = el('button.icon-btn.devices-btn', { title: `Devices (${keyLabel('devices.toggle')})`, on: { click: () => run('devices.toggle') } }, icon('devices'), el('span', { text: 'Devices' }));
  const winCtl = platform.mac ? '' : el('div.win-controls', {},
    el('button.win-btn', { title: 'Minimize', on: { click: () => window.snake.win.minimize() } }, icon('min')),
    el('button.win-btn.max', { title: 'Maximize', on: { click: () => window.snake.win.toggleMaximize() } }, icon('max')),
    el('button.win-btn.close', { title: 'Close', on: { click: () => window.snake.win.close() } }, icon('close')));
  const bar = el('header.tabbar', {},
    platform.mac ? el('div.traffic-space') : '',
    tabsEl, newBtn, newMenu,
    el('div.drag-space', { on: { dblclick: () => platform.mac || window.snake.win.toggleMaximize() } }),
    devBtn,
    el('button.icon-btn', { title: `Settings (${keyLabel('prefs.open')})`, on: { click: () => run('prefs.open') } }, icon('gear')),
    winCtl);
  devicesPanel = el('aside.devices', { hidden: true });
  const bodies = el('div.bodies');
  document.getElementById('app').append(bar, el('div.main', {}, devicesPanel, bodies));
  window.snake.win.onMaximized((m) => {
    document.body.classList.toggle('maximized', m);
    const b = document.querySelector('.win-btn.max');
    if (b) b.replaceChildren(icon(m ? 'restore' : 'max'));
  });
  window.snake.win.onFocus((f) => document.body.classList.toggle('blurred', !f));

  initLayout({ tabsContainer: tabsEl, body: bodies });
  initDevices(devicesPanel);
  registerCommands();
  installKeys();

  // The font has to be ready before a terminal measures its cells.
  try { await Promise.race([document.fonts.load('14px "JetBrains Mono"'), new Promise((r) => setTimeout(r, 1500))]); } catch {}

  if (!env.ptyAvailable) toast('The terminal engine did not load. Reinstalling Snake\'s Terminal should fix it.', { type: 'error', timeout: 0 });
  const first = info.first || {};
  let restored = false;
  if (first.command?.length) await newTab({ command: first.command, cwd: first.cwd, keepOpen: true });
  else if (first.cwd) await newTab({ cwd: first.cwd });
  else if (first.restore && settings.startup === 'restore') restored = restore(info.state?.session);
  if (!tabs.length && !restored) await newTab({ profileId: settings.defaultProfile, cwd: env.home });

  bus.on('tabs:empty', () => closeWindow(true));
  bus.on('devices:close', () => toggleDevices(false));
  bus.on('pane:contextmenu', paneMenu);
  bus.on('settings:changed', () => { rebuildKeys(); updateTitles(); });
  window.snake.onSettingsChanged((s) => { loadSettings(s); bus.emit('settings:changed', settings); });
  window.snake.onBeforeClose(() => closeWindow(false));
  window.snake.onFocusTerminal(() => activeSession()?.focus());
  window.snake.onMenuCommand((id) => run(id));
  window.addEventListener('beforeunload', () => saveSession());
  setInterval(saveSession, 30000);
}

function registerCommands() {
  const s = () => activeSession();
  Object.assign(handlers, {
    'tab.new': () => newTab({ profileId: settings.defaultProfile }),
    'window.new': async () => window.snake.win.newWindow({ cwd: s() && !s().host ? await s().currentCwd() : null }),
    'pane.splitRight': () => split('right'),
    'pane.splitDown': () => split('down'),
    'pane.close': () => s() && closeSession(s()),
    'pane.maximize': toggleMaximize,
    'pane.left': () => focusPane('left'),
    'pane.right': () => focusPane('right'),
    'pane.up': () => focusPane('up'),
    'pane.down': () => focusPane('down'),
    'pane.next': () => cyclePane(1),
    'pane.prev': () => cyclePane(-1),
    'pane.broadcast': () => {
      const on = toggleBroadcast();
      toast(on ? 'Typing now goes to every pane of this tab.' : 'Typing goes to one pane again.');
    },
    'tab.next': () => cycleTab(1),
    'tab.prev': () => cycleTab(-1),
    'tab.moveLeft': () => moveTab(-1),
    'tab.moveRight': () => moveTab(1),
    'tab.rename': () => renameTab(),
    'tab.close': () => activeTab && closeTab(activeTab),
    ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`tab.goto${n}`, () => gotoTab(n)])),
    'edit.copy': () => s()?.copy(),
    'edit.paste': () => s()?.paste(),
    'edit.selectAll': () => s()?.term.selectAll(),
    'find.open': openFind,
    'term.clear': () => { s()?.term.clear(); },
    'term.reset': () => { s()?.term.reset(); },
    'term.scrollTop': () => s()?.term.scrollToTop(),
    'term.scrollBottom': () => s()?.term.scrollToBottom(),
    'term.pageUp': () => s()?.term.scrollPages(-1),
    'term.pageDown': () => s()?.term.scrollPages(1),
    'font.bigger': () => setFontZoom(Math.round(fontZoom) + 1),
    'font.smaller': () => setFontZoom(Math.round(fontZoom) - 1),
    'font.reset': () => setFontZoom(0),
    'devices.toggle': () => toggleDevices(),
    'devices.add': () => editHost(),
    'palette.open': () => openPalette(),
    'prefs.open': () => openPrefs('general'),
    'prefs.profiles': () => openPrefs('profiles'),
    'prefs.colours': () => openPrefs('colours'),
    'prefs.keys': () => openPrefs('keys'),
    'window.fullscreen': () => window.snake.win.toggleFullScreen(),
    'window.close': () => window.snake.win.close(),
    focus: () => { if (!openDialogs.length) activeSession()?.focus(); },
  });
}

function installKeys() {
  // Shortcuts are caught before the terminal sees them; everything else goes to the shell.
  document.addEventListener('keydown', (e) => {
    if (openDialogs.length || document.querySelector('.palette-back')) return;
    const id = commandFor(e);
    if (!id) {
      if (e.key === 'Escape' && document.querySelector('.find-bar')) { closeFind(); e.preventDefault(); }
      return;
    }
    // In a text box of the window itself, editing keys stay with the box.
    const inField = e.target.matches?.('input, textarea, select') && !e.target.classList.contains('xterm-helper-textarea');
    const native = { 'edit.copy': 'copy', 'edit.paste': 'paste', 'edit.selectAll': 'selectAll' }[id];
    if (inField && native) {
      if (platform.mac) { e.preventDefault(); window.snake.editNative(native); }
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    run(id);
  }, true);
}

function toggleDevices(force) {
  const open = force ?? devicesPanel.hidden;
  if (open === !devicesPanel.hidden) return;
  devicesPanel.hidden = !open;
  document.body.classList.toggle('devices-open', open);
  if (open) devicesOpened(); else { devicesClosed(); activeSession()?.focus(); }
}

function newTabMenu(anchor) {
  const items = [
    { header: 'Profiles' },
    ...settings.profiles.map((p) => ({ label: p.name, detail: p.id === settings.defaultProfile ? keyLabel('tab.new') : '', icon: 'terminal', run: () => newTab({ profileId: p.id }) })),
  ];
  if (env.shells.length > 1) {
    items.push({ header: 'Shells' }, ...env.shells.map((sh) => ({ label: sh.name, detail: sh.file, run: () => newTab({ command: [sh.file, ...sh.args], title: sh.name }) })));
  }
  if (settings.hosts.length) {
    items.push({ header: 'Devices' }, ...settings.hosts.slice(0, 12).map((h) => ({ label: h.name || h.host, color: h.color || '#3fb950', run: () => newTab({ host: h }) })));
  }
  items.push({ separator: true }, { label: 'Connect to a device…', icon: 'devices', key: keyLabel('devices.toggle'), run: () => toggleDevices(true) }, { label: 'Edit profiles…', icon: 'gear', run: () => openPrefs('profiles') });
  showMenu(items, anchor);
}

function paneMenu(session, e) {
  const has = session.term.hasSelection();
  showMenu([
    { label: 'Copy', icon: 'copy', key: keyLabel('edit.copy'), disabled: !has, run: () => session.copy() },
    { label: 'Paste', key: keyLabel('edit.paste'), run: () => session.paste() },
    { label: 'Select all', key: keyLabel('edit.selectAll'), run: () => session.term.selectAll() },
    { separator: true },
    { label: 'Split right', icon: 'splitRight', key: keyLabel('pane.splitRight'), run: () => split('right') },
    { label: 'Split down', icon: 'splitDown', key: keyLabel('pane.splitDown'), run: () => split('down') },
    { label: 'Maximize pane', icon: 'maximize', key: keyLabel('pane.maximize'), disabled: (activeTab?.sessions().length || 0) < 2, run: toggleMaximize },
    { label: 'Broadcast typing to all panes', icon: 'broadcast', checked: !!activeTab?.broadcast, disabled: (activeTab?.sessions().length || 0) < 2, run: () => run('pane.broadcast') },
    { separator: true },
    { label: 'Find…', icon: 'search', key: keyLabel('find.open'), run: openFind },
    { label: 'Clear', key: keyLabel('term.clear'), run: () => session.term.clear() },
    { separator: true },
    { label: 'Close pane', icon: 'close', key: keyLabel('pane.close'), run: () => closeSession(session) },
  ], { x: e.clientX, y: e.clientY }, { onClose: () => session.focus() });
}

function saveSession() {
  if (closing) return;
  try { window.snake.setState({ session: tabs.length ? snapshot() : null }); } catch {}
}

/** Closing the window: ask if something still runs, remember the tabs, then go. */
async function closeWindow(empty) {
  if (closing) return;
  if (!empty && settings.confirmClose) {
    const busy = [];
    for (const s of allSessions()) if (await s.busy()) busy.push(s.host ? `the connection to ${s.title()}` : s.procName);
    if (busy.length) {
      const r = await window.snake.confirm({ message: 'Close Snake\'s Terminal?', detail: `Still running: ${[...new Set(busy)].join(', ')}.`, buttons: ['Close', 'Cancel'] });
      if (r.response !== 0) return;
    }
  }
  await window.snake.setState({ session: empty ? null : snapshot() });
  closing = true;
  for (const s of allSessions()) s.kill();
  window.snake.win.forceClose();
}

// For automated tests (and curious people in the developer tools).
window.snakeTerminal = { tabs, activeSession, allSessions, run, settings, env, parseItermColors };

boot().catch((err) => {
  console.error(err);
  document.body.append(el('pre.boot-error', { text: `Snake's Terminal could not start:\n${err.stack || err}` }));
});

export { profileById };
