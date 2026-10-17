// Custom title bar: app icon, menu bar, command center, layout toggles and window controls.
import { el, icon, bus } from './util.js';
import { showMenu, closeMenus } from './ui.js';
import { executeCommand, keybindingFor, getCommand } from './commands.js';
import { workspace, getState } from './workspace.js';
import { isSidebarVisible } from './sidebar.js';
import { isPanelVisible } from './panel.js';
import * as settings from './settings.js';

const c = (id, label) => ({ label: label || getCommand(id)?.title || id, key: getCommand(id)?.displayKey || keybindingFor(id), run: () => executeCommand(id), id });
const sep = { separator: true };

function recentSubmenu() {
  const recent = getState().recent || [];
  const folders = recent.filter((r) => r.type === 'folder').slice(0, 10);
  const files = recent.filter((r) => r.type === 'file').slice(0, 10);
  return [
    c('workbench.action.reopenClosedEditor', 'Reopen Closed Editor'),
    sep,
    ...folders.map((r) => ({ label: r.path.replace(/^\/home\/[^/]+/, '~'), run: () => bus.emit('workspace:openFolderRequest', r.path) })),
    folders.length && files.length ? sep : null,
    ...files.map((r) => ({ label: r.path.replace(/^\/home\/[^/]+/, '~'), run: () => executeCommand('workbench.action.files.openPath', r.path) })),
    sep,
    c('workbench.action.openRecent', 'More...'),
    c('workbench.action.clearRecentFiles', 'Clear Recently Opened...'),
  ].filter(Boolean);
}

function menus() {
  const autoSave = settings.get('files.autoSave') !== 'off';
  return {
    File: [
      c('workbench.action.files.newUntitledFile', 'New Text File'),
      c('workbench.action.newWindow', 'New Window'),
      sep,
      c('workbench.action.files.openFile', 'Open File...'),
      c('workbench.action.files.openFolder', 'Open Folder...'),
      { label: 'Open Recent', submenu: recentSubmenu },
      sep,
      ...(window.snake.web ? [c('workbench.action.files.upload', 'Upload Files...'), c('workbench.action.files.download', 'Download'), sep] : []),
      c('workbench.action.files.save', 'Save'),
      c('workbench.action.files.saveAs', 'Save As...'),
      c('workbench.action.files.saveAll', 'Save All'),
      sep,
      { label: 'Auto Save', checked: autoSave, run: () => executeCommand('workbench.action.toggleAutoSave') },
      { label: 'Preferences', submenu: () => [
        c('workbench.action.openSettings', 'Settings'),
        c('workbench.action.openSettingsJson', 'Settings (JSON)'),
        c('workbench.action.openGlobalKeybindings', 'Keyboard Shortcuts'),
        sep,
        c('workbench.action.selectTheme', 'Color Theme'),
      ] },
      sep,
      c('workbench.action.files.revert', 'Revert File'),
      c('workbench.action.closeActiveEditor', 'Close Editor'),
      c('workbench.action.closeFolder', 'Close Folder'),
      c('workbench.action.closeWindow', 'Close Window'),
      sep,
      c('workbench.action.quit', 'Exit'),
    ],
    Edit: [
      c('undo', 'Undo'),
      c('redo', 'Redo'),
      sep,
      c('editor.action.clipboardCutAction', 'Cut'),
      c('editor.action.clipboardCopyAction', 'Copy'),
      c('editor.action.clipboardPasteAction', 'Paste'),
      sep,
      c('actions.find', 'Find'),
      c('editor.action.startFindReplaceAction', 'Replace'),
      sep,
      c('workbench.action.findInFiles', 'Find in Files'),
      c('workbench.action.replaceInFiles', 'Replace in Files'),
      sep,
      c('editor.action.commentLine', 'Toggle Line Comment'),
      c('editor.action.blockComment', 'Toggle Block Comment'),
      c('editor.action.formatDocument', 'Format Document'),
    ],
    Selection: [
      c('editor.action.selectAll', 'Select All'),
      c('editor.action.smartSelect.expand', 'Expand Selection'),
      c('editor.action.smartSelect.shrink', 'Shrink Selection'),
      sep,
      c('editor.action.copyLinesUpAction', 'Copy Line Up'),
      c('editor.action.copyLinesDownAction', 'Copy Line Down'),
      c('editor.action.moveLinesUpAction', 'Move Line Up'),
      c('editor.action.moveLinesDownAction', 'Move Line Down'),
      c('editor.action.duplicateSelection', 'Duplicate Selection'),
      sep,
      c('editor.action.insertCursorAbove', 'Add Cursor Above'),
      c('editor.action.insertCursorBelow', 'Add Cursor Below'),
      c('editor.action.insertCursorAtEndOfEachLineSelected', 'Add Cursors to Line Ends'),
      c('editor.action.addSelectionToNextFindMatch', 'Add Next Occurrence'),
      c('editor.action.selectHighlights', 'Select All Occurrences'),
      sep,
      c('editor.action.toggleColumnSelection', 'Column Selection Mode'),
    ],
    View: [
      c('workbench.action.showCommands', 'Command Palette...'),
      c('workbench.action.quickOpen', 'Go to File...'),
      sep,
      { label: 'Appearance', submenu: () => [
        { label: 'Full Screen', key: keybindingFor('workbench.action.toggleFullScreen'), run: () => executeCommand('workbench.action.toggleFullScreen') },
        { label: 'Zen Mode', key: keybindingFor('workbench.action.toggleZenMode'), run: () => executeCommand('workbench.action.toggleZenMode') },
        sep,
        { label: 'Primary Side Bar', checked: isSidebarVisible(), key: keybindingFor('workbench.action.toggleSidebarVisibility'), run: () => executeCommand('workbench.action.toggleSidebarVisibility') },
        { label: 'Activity Bar', checked: settings.get('workbench.activityBar.visible'), run: () => executeCommand('workbench.action.toggleActivityBarVisibility') },
        { label: 'Status Bar', checked: settings.get('workbench.statusBar.visible'), run: () => executeCommand('workbench.action.toggleStatusbarVisibility') },
        { label: 'Panel', checked: isPanelVisible(), key: keybindingFor('workbench.action.togglePanel'), run: () => executeCommand('workbench.action.togglePanel') },
        sep,
        { label: 'Move Primary Side Bar Right', checked: settings.get('workbench.sideBar.location') === 'right', run: () => executeCommand('workbench.action.toggleSidebarPosition') },
        { label: 'Minimap', checked: settings.get('editor.minimap.enabled'), run: () => executeCommand('editor.toggleMinimap') },
        { label: 'Breadcrumbs', checked: settings.get('workbench.breadcrumbs.enabled'), run: () => executeCommand('breadcrumbs.toggle') },
        { label: 'Sticky Scroll', checked: settings.get('editor.stickyScroll.enabled'), run: () => executeCommand('editor.toggleStickyScroll') },
        { label: 'Render Whitespace', checked: settings.get('editor.renderWhitespace') === 'all', run: () => executeCommand('editor.toggleRenderWhitespace') },
        sep,
        c('workbench.action.zoomIn', 'Zoom In'),
        c('workbench.action.zoomOut', 'Zoom Out'),
        c('workbench.action.zoomReset', 'Reset Zoom'),
      ] },
      { label: 'Editor Layout', submenu: () => [
        c('workbench.action.splitEditor', 'Split Right'),
        c('workbench.action.joinAllGroups', 'Single'),
        c('workbench.action.closeEditorsInGroup', 'Close Group'),
      ] },
      sep,
      c('workbench.view.explorer', 'Explorer'),
      c('workbench.view.search', 'Search'),
      c('workbench.view.scm', 'Source Control'),
      sep,
      c('workbench.actions.view.problems', 'Problems'),
      c('workbench.action.output.show', 'Output'),
      c('workbench.action.terminal.toggleTerminal', 'Terminal'),
      sep,
      { label: 'Word Wrap', checked: settings.get('editor.wordWrap') !== 'off', key: keybindingFor('editor.toggleWordWrap'), run: () => executeCommand('editor.toggleWordWrap') },
    ],
    Go: [
      c('workbench.action.navigateBack', 'Back'),
      c('workbench.action.navigateForward', 'Forward'),
      sep,
      c('workbench.action.nextEditor', 'Next Editor'),
      c('workbench.action.previousEditor', 'Previous Editor'),
      c('workbench.action.showAllEditors', 'Switch Editor...'),
      sep,
      c('workbench.action.quickOpen', 'Go to File...'),
      c('workbench.action.gotoSymbol', 'Go to Symbol in Editor...'),
      c('workbench.action.gotoLine', 'Go to Line/Column...'),
      c('editor.action.jumpToBracket', 'Go to Bracket'),
      sep,
      c('editor.action.revealDefinition', 'Go to Definition'),
      c('editor.action.goToReferences', 'Go to References'),
      c('editor.action.rename', 'Rename Symbol'),
      sep,
      c('editor.action.marker.nextInFiles', 'Next Problem'),
      c('editor.action.marker.prevInFiles', 'Previous Problem'),
      c('editor.action.dirtydiff.next', 'Next Change'),
    ],
    Run: [
      c('workbench.action.runActiveFile', 'Run File in Terminal'),
      c('workbench.action.tasks.runTask', 'Run Task...'),
      c('workbench.action.terminal.runSelectedText', 'Run Selected Text in Terminal'),
    ],
    Terminal: [
      c('workbench.action.terminal.new', 'New Terminal'),
      c('workbench.action.terminal.split', 'Split Terminal'),
      sep,
      c('workbench.action.tasks.runTask', 'Run Task...'),
      c('workbench.action.runActiveFile', 'Run Active File'),
      c('workbench.action.terminal.runSelectedText', 'Run Selected Text'),
      sep,
      c('workbench.action.terminal.clear', 'Clear Terminal'),
      c('workbench.action.terminal.kill', 'Kill Terminal'),
    ],
    Help: [
      c('workbench.action.openWelcome', 'Welcome'),
      c('workbench.action.showCommands', 'Show All Commands'),
      c('workbench.action.openGlobalKeybindings', 'Keyboard Shortcuts Reference'),
      sep,
      c('workbench.action.toggleDevTools', 'Toggle Developer Tools'),
      c('workbench.action.reloadWindow', 'Reload Window'),
      sep,
      c('workbench.action.showAboutDialog', 'About'),
    ],
  };
}

let openMenuName = null;
let menuButtons = [];

function openMenu(name, btn) {
  const items = menus()[name];
  openMenuName = name;
  menuButtons.forEach((b) => b.classList.toggle('open', b === btn));
  const r = btn.getBoundingClientRect();
  showMenu(items, { x: r.left, y: r.bottom });
}

export function initTitlebar() {
  const bar = document.getElementById('titlebar');
  const appIcon = el('img.titlebar-icon', { src: 'icon.svg', alt: '' });
  const menubar = el('div.menubar');
  for (const name of Object.keys(menus())) {
    const btn = el('div.menubar-item', { tabindex: '-1' }, name);
    btn.addEventListener('mousedown', (e) => {
      e.preventDefault();
      if (openMenuName === name) { closeMenus(); return; }
      openMenu(name, btn);
    });
    btn.addEventListener('mouseenter', () => { if (openMenuName && openMenuName !== name) openMenu(name, btn); });
    menuButtons.push(btn);
    menubar.append(btn);
  }
  bus.on('menu:closed', () => { openMenuName = null; menuButtons.forEach((b) => b.classList.remove('open')); });
  bus.on('menu:navigate', (dir) => {
    if (!openMenuName) return;
    const names = Object.keys(menus());
    const i = (names.indexOf(openMenuName) + dir + names.length) % names.length;
    openMenu(names[i], menuButtons[i]);
  });
  // Alt toggles the menu (like VS Code / Windows menus)
  let altDown = false;
  window.addEventListener('keydown', (e) => { altDown = e.key === 'Alt' && !e.ctrlKey && !e.shiftKey; }, true);
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Alt' && altDown && !document.activeElement?.closest?.('.xterm')) {
      e.preventDefault();
      if (openMenuName) closeMenus();
      else openMenu('File', menuButtons[0]);
    }
    altDown = false;
  }, true);
  window.addEventListener('mousedown', () => (altDown = false), true);

  const center = el('div.command-center', { title: 'Search files, run commands (Ctrl+P / Ctrl+Shift+P)' }, icon('search'), el('span.cc-label', {}, "Snake's Code"));
  center.addEventListener('click', () => executeCommand('workbench.action.quickOpen'));
  const centerWrap = el('div.titlebar-center', {}, el('span.action-btn.nav', { title: 'Go Back', onclick: () => executeCommand('workbench.action.navigateBack') }, icon('arrow-left')), el('span.action-btn.nav', { title: 'Go Forward', onclick: () => executeCommand('workbench.action.navigateForward') }, icon('arrow-right')), center);
  const title = el('div.titlebar-title');

  const sidebarBtn = el('span.action-btn', { title: 'Toggle Primary Side Bar (Ctrl+B)', onclick: () => executeCommand('workbench.action.toggleSidebarVisibility') });
  const panelBtn = el('span.action-btn', { title: 'Toggle Panel (Ctrl+J)', onclick: () => executeCommand('workbench.action.togglePanel') });
  const layout = el('div.titlebar-layout', {}, sidebarBtn, panelBtn, el('span.action-btn', { title: 'Customize Layout...', onclick: (e) => { const r = e.currentTarget.getBoundingClientRect(); showMenu(menus().View.find((m) => m.label === 'Appearance').submenu(), { x: r.left - 200, y: r.bottom }); } }, icon('layout')));
  const updateLayoutIcons = () => {
    sidebarBtn.replaceChildren(icon(isSidebarVisible() ? 'layout-sidebar-left' : 'layout-sidebar-left-off'));
    panelBtn.replaceChildren(icon(isPanelVisible() ? 'layout-panel' : 'layout-panel-off'));
  };
  bus.on('layout:changed', updateLayoutIcons);
  updateLayoutIcons();

  const maxBtn = el('div.wc-btn', { title: 'Maximize', onclick: () => window.snake.win.toggleMaximize() }, icon('chrome-maximize'));
  const controls = el(
    'div.window-controls',
    {},
    el('div.wc-btn', { title: 'Minimize', onclick: () => window.snake.win.minimize() }, icon('chrome-minimize')),
    maxBtn,
    el('div.wc-btn.close', { title: 'Close', onclick: () => window.snake.win.close() }, icon('chrome-close')),
  );
  window.snake.win.onMaximized((m) => {
    maxBtn.replaceChildren(icon(m ? 'chrome-restore' : 'chrome-maximize'));
    maxBtn.title = m ? 'Restore' : 'Maximize';
    document.body.classList.toggle('maximized', m);
  });
  window.snake.win.isMaximized().then((m) => { maxBtn.replaceChildren(icon(m ? 'chrome-restore' : 'chrome-maximize')); document.body.classList.toggle('maximized', m); });
  bar.addEventListener('dblclick', (e) => { if (e.target === bar || e.target === title || e.target.classList.contains('titlebar-drag')) window.snake.win.toggleMaximize(); });

  bar.append(appIcon, menubar, el('div.titlebar-drag'), centerWrap, title, el('div.titlebar-drag'), layout, controls);

  const updateTitle = (t) => {
    const showCC = settings.get('window.commandCenter');
    centerWrap.style.display = showCC ? '' : 'none';
    title.style.display = showCC ? 'none' : '';
    title.textContent = t;
    center.querySelector('.cc-label').textContent = workspace.root ? workspace.name : "Snake's Code";
  };
  bus.on('title:changed', updateTitle);
  settings.onChange(['window.commandCenter'], () => updateTitle(document.title));
  updateTitle(document.title);
}

export function openMenuByName(name) {
  const i = Object.keys(menus()).indexOf(name);
  if (i >= 0) openMenu(name, menuButtons[i]);
}
