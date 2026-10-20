// The menus: one tree of Shell, Edit, View, Session, Window and Help, shown three ways:
// the ☰ button in the tab bar, the menu bar under it (View → Show the menu bar), and,
// on a Mac, the system menu bar too (built by the main process from the same command ids).
import { el, icon, platform, bus } from './util.js';
import { settings, saveSettings, allSchemes, hostLabel } from './settings.js';
import { run } from './commands.js';
import { keyLabel } from './keys.js';
import { env } from './env.js';
import { lastSelection } from './session.js';
import { tabs, activeTab, activeSession, activateTab, newTab, updateTitles, TAB_COLORS } from './layout.js';
import { showMenu, closeMenu, menuIsOpen } from './ui.js';

/** A menu row that runs a command, with its shortcut. */
const c = (id, label, extra = {}) => ({ label, key: keyLabel(id), run: () => run(id), ...extra });
const sep = { separator: true };

function toggle(key) {
  settings[key] = !settings[key];
  saveSettings();
  return settings[key];
}

function setProfile(key, value) {
  const p = activeSession()?.profile;
  if (!p) return;
  p[key] = value;
  saveSettings();
}

function shellMenu() {
  const s = activeSession();
  const multi = (activeTab?.sessions().length || 0) > 1;
  return [
    c('tab.new', 'New tab', { icon: 'plus' }),
    { label: 'New tab with', submenu: newTabItems },
    c('window.new', 'New window'),
    sep,
    c('pane.splitRight', 'Split right', { icon: 'splitRight' }),
    c('pane.splitDown', 'Split down', { icon: 'splitDown' }),
    sep,
    c('devices.toggle', 'Connect to a device…', { icon: 'devices' }),
    settings.hosts.length ? { label: 'Saved devices', submenu: () => settings.hosts.map((h) => ({ label: hostLabel(h), detail: h.host, color: h.color || '#3fb950', run: () => newTab({ host: h }) })) } : null,
    c('devices.add', 'Save a device…'),
    sep,
    c('term.export', 'Save the output as text…', { disabled: !s }),
    sep,
    c('pane.close', multi ? 'Close pane' : 'Close tab', { icon: 'close', disabled: !s }),
    multi ? c('tab.close', 'Close tab') : null,
    c('window.close', 'Close window'),
  ];
}

function newTabItems() {
  const items = [{ header: 'Profiles' }, ...settings.profiles.map((p) => ({
    label: p.name, icon: 'terminal', detail: p.id === settings.defaultProfile ? 'default' : '', run: () => newTab({ profileId: p.id }),
  }))];
  if (env.shells.length > 1) {
    items.push({ header: 'Shells' }, ...env.shells.map((sh) => ({ label: sh.name, detail: sh.file, run: () => newTab({ command: [sh.file, ...sh.args], title: sh.name }) })));
  }
  items.push(sep, c('prefs.profiles', 'Edit profiles…', { icon: 'gear' }));
  return items;
}

function editMenu() {
  const s = activeSession();
  const has = !!s?.term.hasSelection();
  return [
    c('edit.copy', 'Copy', { icon: 'copy', disabled: !has }),
    c('edit.copyOneLine', 'Copy as one line', { disabled: !has }),
    c('term.copyAll', 'Copy all the output', { disabled: !s }),
    sep,
    c('edit.paste', 'Paste'),
    c('edit.pasteSelection', 'Paste the last selection', { disabled: !lastSelection && platform.os !== 'linux' }),
    sep,
    c('edit.selectAll', 'Select all', { disabled: !s }),
    c('edit.clearSelection', 'Clear the selection', { disabled: !has }),
    sep,
    { label: 'Selecting and copying', icon: 'copy', submenu: selectionItems },
    { label: 'Ask before pasting several lines', checked: settings.pasteWarning, run: () => toggle('pasteWarning') },
    sep,
    c('find.open', 'Find…', { icon: 'search', disabled: !s }),
  ];
}

/** Everything about selecting and the clipboard, in one place. */
export function selectionItems() {
  const rc = settings.rightClick;
  return [
    { label: 'Copy text when you select it', checked: settings.copyOnSelect, run: () => run('edit.copyOnSelect') },
    { label: 'Show "Copied" when it does', checked: settings.copyNotice, disabled: !settings.copyOnSelect, run: () => run('edit.copyNotice') },
    { label: 'Drop spaces at the ends of lines', checked: settings.copyTrim, run: () => toggle('copyTrim') },
    { header: 'Right-click' },
    { label: 'Opens this menu', radio: true, checked: rc === 'menu', run: () => { settings.rightClick = 'menu'; saveSettings(); } },
    { label: 'Pastes', radio: true, checked: rc === 'paste', run: () => { settings.rightClick = 'paste'; saveSettings(); } },
    { label: 'Copies the selection, or pastes', radio: true, checked: rc === 'smart', run: () => { settings.rightClick = 'smart'; saveSettings(); } },
    sep,
    { label: 'Characters a double-click stops at…', run: () => run('prefs.open') },
  ];
}

function viewMenu() {
  const s = activeSession();
  const p = s?.profile;
  return [
    c('font.bigger', 'Bigger text'),
    c('font.smaller', 'Smaller text'),
    c('font.reset', 'Normal text size'),
    sep,
    { label: 'Colours', disabled: !p, submenu: () => [
      { header: `Profile "${p.name}"` },
      ...allSchemes().map((sc) => ({ label: sc.name, radio: true, checked: (s.host?.scheme || p.scheme) === sc.id, run: () => setProfile('scheme', sc.id) })),
      sep, c('prefs.colours', 'More colours and import…', { icon: 'gear' }),
    ] },
    { label: 'Cursor', disabled: !p, submenu: () => [
      ...[['block', 'Block'], ['bar', 'Bar'], ['underline', 'Underline']].map(([v, label]) => ({ label, radio: true, checked: p.cursorStyle === v, run: () => setProfile('cursorStyle', v) })),
      sep,
      { label: 'Blinking', checked: p.cursorBlink !== false, run: () => setProfile('cursorBlink', p.cursorBlink === false) },
    ] },
    sep,
    { label: 'Devices panel', checked: document.body.classList.contains('devices-open'), key: keyLabel('devices.toggle'), run: () => run('devices.toggle') },
    { label: 'Menu bar', checked: settings.menuBar, run: () => run('view.menuBar') },
    c('window.fullscreen', 'Full screen'),
    sep,
    c('palette.open', 'Command palette…'),
  ];
}

function sessionMenu() {
  const s = activeSession();
  const multi = (activeTab?.sessions().length || 0) > 1;
  return [
    c('tab.rename', 'Rename tab…', { icon: 'edit', disabled: !activeTab }),
    { label: 'Tab colour', disabled: !activeTab, submenu: () => TAB_COLORS.map((col) => ({
      label: col ? ({ '#3fb950': 'Green', '#58a6ff': 'Blue', '#d29922': 'Amber', '#ff7b72': 'Red', '#bc8cff': 'Purple', '#39c5cf': 'Teal', '#e3b341': 'Yellow', '#f778ba': 'Pink' })[col] || col : 'None',
      color: col, checked: activeTab.color === col, run: () => { activeTab.color = col; updateTitles(); },
    })) },
    sep,
    c('pane.broadcast', 'Broadcast typing to every pane', { icon: 'broadcast', checked: !!activeTab?.broadcast, disabled: !multi }),
    c('pane.maximize', 'Maximize pane', { icon: 'maximize', checked: !!activeTab?.maximized, disabled: !multi }),
    sep,
    c('term.scrollTop', 'Scroll to the top', { disabled: !s }),
    c('term.scrollBottom', 'Scroll to the bottom', { disabled: !s }),
    sep,
    c('term.clear', 'Clear the screen and scrollback', { disabled: !s }),
    c('term.reset', 'Reset the terminal', { disabled: !s }),
    sep,
    { label: 'Bell', submenu: () => [['visual', 'Flash the pane'], ['sound', 'Beep'], ['none', 'Nothing']].map(([v, label]) => ({
      label, radio: true, checked: settings.bell === v, run: () => { settings.bell = v; saveSettings(); },
    })) },
  ];
}

function windowMenu() {
  return [
    c('tab.next', 'Next tab', { disabled: tabs.length < 2 }),
    c('tab.prev', 'Previous tab', { disabled: tabs.length < 2 }),
    c('tab.moveLeft', 'Move tab left', { disabled: tabs.length < 2 }),
    c('tab.moveRight', 'Move tab right', { disabled: tabs.length < 2 }),
    sep,
    c('pane.next', 'Next pane', { disabled: (activeTab?.sessions().length || 0) < 2 }),
    c('pane.prev', 'Previous pane', { disabled: (activeTab?.sessions().length || 0) < 2 }),
    sep,
    { header: 'Tabs' },
    ...tabs.slice(0, 20).map((t, i) => ({
      label: t.title(), checked: t === activeTab, color: t.color || '', key: i < 8 ? keyLabel(`tab.goto${i + 1}`) : '',
      run: () => activateTab(t),
    })),
    sep,
    { label: 'Hotkey window…', detail: settings.hotkey || 'off', run: () => run('prefs.open') },
  ];
}

function helpMenu() {
  return [
    c('help.keys', 'Keyboard shortcuts'),
    c('palette.open', 'Search every command…'),
    c('prefs.open', 'Settings…', { icon: 'gear' }),
    sep,
    c('help.about', 'About Snake\'s Terminal'),
  ];
}

export const MENUS = [
  ['Shell', shellMenu],
  ['Edit', editMenu],
  ['View', viewMenu],
  ['Session', sessionMenu],
  ['Window', windowMenu],
  ['Help', helpMenu],
];

// ---------------------------------------------------------------------------
// The ☰ button and the menu bar
// ---------------------------------------------------------------------------
let barEl = null;
let burger = null;
let openIndex = -1;

/** The ☰ button: every menu as a submenu. */
export function menuButton() {
  burger = el('button.icon-btn.menu-btn', { title: `Menu (${keyLabel('menu.open')})`, 'aria-haspopup': 'menu', on: { mousedown: (e) => { e.preventDefault(); openBurger(); } } }, icon('menu'));
  return burger;
}

export function openBurger() {
  if (menuIsOpen() && burger.classList.contains('open')) { closeMenu(); burger.classList.remove('open'); activeSession()?.focus(); return; }
  if (settings.menuBar && barEl) { openBarMenu(0); return; }
  burger.classList.add('open');
  showMenu([
    ...MENUS.map(([label, fn]) => ({ label, submenu: fn })),
    sep,
    { label: 'Show the menu bar', checked: settings.menuBar, run: () => run('view.menuBar') },
  ], burger, { onClose: () => { burger.classList.remove('open'); activeSession()?.focus(); }, keepOpenOn: burger });
}

/** The row of menu names under the tab bar. */
export function menuBar() {
  barEl = el('nav.menubar', { role: 'menubar', hidden: !settings.menuBar },
    MENUS.map(([label], i) => el('button.menubar-item', {
      role: 'menuitem',
      on: {
        mousedown: (e) => { e.preventDefault(); if (openIndex === i) closeBar(); else openBarMenu(i); },
        mouseenter: () => { if (openIndex >= 0 && openIndex !== i) openBarMenu(i); },
      },
    }, label)));
  bus.on('settings:changed', () => { barEl.hidden = !settings.menuBar; });
  return barEl;
}

function closeBar() {
  closeMenu();
  barEl.querySelectorAll('.menubar-item').forEach((b) => b.classList.remove('open'));
  openIndex = -1;
  activeSession()?.focus();
}

function openBarMenu(i) {
  const n = MENUS.length;
  i = (i + n) % n;
  const buttons = [...barEl.querySelectorAll('.menubar-item')];
  buttons.forEach((b, j) => b.classList.toggle('open', j === i));
  openIndex = i;
  const menu = showMenu(MENUS[i][1](), buttons[i], {
    keepOpenOn: barEl,
    onEdge: (dir) => openBarMenu(openIndex + dir),
    onClose: () => {
      buttons.forEach((b) => b.classList.remove('open'));
      // A switch to the next menu opens it right after this one closes; only a real close ends it.
      const was = openIndex;
      setTimeout(() => { if (openIndex === was && !menuIsOpen()) { openIndex = -1; activeSession()?.focus(); } });
    },
  });
  menu.selectFirst();
}
