// Snake's Code — renderer entry point: bootstraps the workbench and registers all commands.
import * as monaco from 'monaco-editor';
import './styles.css';
import { el, bus, setSep, basename, dirname, join, relative, makeSash, isInside, debounce } from './modules/util.js';
import { registerCommands, executeCommand, installKeyDispatcher, setUserKeybindings, getCommand } from './modules/commands.js';
import * as settings from './modules/settings.js';
import { themes, applyTheme, currentTheme } from './modules/themes.js';
import { env, workspace, loadState, getState, saveState, setRoot, clearRecent, removeRecent, invalidateFileList } from './modules/workspace.js';
import { quickInput, pick, inputBox, notify, confirm, showMenu } from './modules/ui.js';
import * as editors from './modules/editors.js';
import { initSidebar, showView, toggleSidebar, isSidebarVisible, setSidebarVisible, getActiveView } from './modules/sidebar.js';
import * as explorer from './modules/explorer.js';
import { focusSearch } from './modules/search.js';
import * as gitMod from './modules/git.js';
import * as panel from './modules/panel.js';
import { initStatusbar, setStatusbarVisible } from './modules/statusbar.js';
import { openQuickOpen, showEditorsMRU } from './modules/palette.js';
import { openSettings, openKeybindings, openWelcome, showAbout } from './modules/pages.js';
import { initTitlebar } from './modules/titlebar.js';
import { fileIcon } from './modules/icons.js';

// ---------------------------------------------------------------------------
// Monaco environment (web workers bundled by esbuild into dist/workers)
// ---------------------------------------------------------------------------
self.MonacoEnvironment = {
  getWorker(_id, label) {
    const map = { json: 'json', css: 'css', scss: 'css', less: 'css', html: 'html', handlebars: 'html', razor: 'html', typescript: 'ts', javascript: 'ts' };
    return new Worker(`workers/${map[label] || 'editor'}.worker.js`, { name: label });
  },
};

function configureLanguages() {
  // Monaco injects its theme + codicon stylesheet when the first editor is created;
  // create a throwaway one so workbench icons render before any file is opened.
  const probe = el('div', { style: { position: 'absolute', width: '1px', height: '1px', left: '-10px', top: '-10px' } });
  document.body.append(probe);
  monaco.editor.create(probe, { model: null }).dispose();
  probe.remove();
  const ts = monaco.typescript || monaco.languages.typescript;
  if (ts?.typescriptDefaults) {
    const compilerOptions = {
      target: ts.ScriptTarget?.ESNext ?? 99,
      module: ts.ModuleKind?.ESNext ?? 99,
      moduleResolution: ts.ModuleResolutionKind?.NodeJs ?? 2,
      allowJs: true,
      checkJs: false,
      jsx: ts.JsxEmit?.React ?? 2,
      allowNonTsExtensions: true,
      esModuleInterop: true,
      allowSyntheticDefaultImports: true,
      strict: false,
    };
    for (const d of [ts.typescriptDefaults, ts.javascriptDefaults]) {
      d.setCompilerOptions(compilerOptions);
      // Without a full project, semantic errors (unresolved imports) are mostly noise.
      d.setDiagnosticsOptions({ noSemanticValidation: true, noSyntaxValidation: false });
      d.setEagerModelSync(true);
    }
  }
  const json = monaco.json || monaco.languages.json;
  json?.jsonDefaults?.setDiagnosticsOptions({ validate: true, allowComments: true, trailingCommas: 'ignore', schemas: [], enableSchemaRequest: false });
}

// ---------------------------------------------------------------------------
// Layout: side bar width, zen mode, visibility toggles
// ---------------------------------------------------------------------------
let sidebarWidth = 280;
let zen = false;
let zenRestore = null;

function setSidebarWidth(w) {
  sidebarWidth = Math.max(170, Math.min(window.innerWidth * 0.6, w));
  document.documentElement.style.setProperty('--sidebar-width', sidebarWidth + 'px');
  editors.layoutEditors();
}

function initLayout() {
  const sash = document.getElementById('sidebar-sash');
  makeSash(sash, {
    cursor: 'ew-resize',
    onStart: () => ({ w: sidebarWidth }),
    onDrag: (dx, _dy, c) => {
      const right = settings.get('workbench.sideBar.location') === 'right';
      const w = c.w + (right ? -dx : dx);
      if (w < 120) setSidebarVisible(false);
      else { if (!isSidebarVisible()) setSidebarVisible(true); setSidebarWidth(w); }
    },
    onEnd: () => persistSession(),
  });
  sash.addEventListener('dblclick', () => setSidebarWidth(280));
  const applyLayoutSettings = () => {
    const wb = document.getElementById('workbench');
    wb.classList.toggle('sidebar-right', settings.get('workbench.sideBar.location') === 'right');
    wb.classList.toggle('activitybar-hidden', !settings.get('workbench.activityBar.visible'));
    setStatusbarVisible(settings.get('workbench.statusBar.visible'));
    requestAnimationFrame(() => editors.layoutEditors());
  };
  settings.onChange(['workbench.sideBar.location', 'workbench.activityBar.visible', 'workbench.statusBar.visible'], applyLayoutSettings);
  applyLayoutSettings();
  bus.on('layout:changed', () => requestAnimationFrame(() => editors.layoutEditors()));
  bus.on('layout:persist', () => persistSession());
}

function toggleZen() {
  const wb = document.getElementById('workbench');
  zen = !zen;
  if (zen) {
    zenRestore = { sidebar: isSidebarVisible(), panel: panel.isPanelVisible() };
    setSidebarVisible(false);
    panel.setPanelVisible(false);
    window.snake.win.setFullScreen(true);
    notify({ message: 'Zen Mode: press Ctrl+K Z or Escape (outside the editor) to exit.', timeout: 3000, transient: true });
  } else {
    setSidebarVisible(zenRestore?.sidebar ?? true);
    if (zenRestore?.panel) panel.setPanelVisible(true);
    window.snake.win.setFullScreen(false);
  }
  wb.classList.toggle('zen', zen);
  requestAnimationFrame(() => editors.layoutEditors());
}

let zoom = 0;
function setZoom(level) {
  zoom = Math.max(-5, Math.min(8, level));
  window.snake.win.setZoom(zoom);
}

// Ctrl+wheel makes whatever is under the pointer bigger or smaller: the terminal
// its text, a Markdown preview its page, anything else the whole window. (The
// code editor zooms its own text: editor.mouseWheelZoom.)
window.addEventListener('wheel', (e) => {
  if (!(e.ctrlKey || e.metaKey) || !(e.target instanceof Element)) return;
  if (e.target.closest('.monaco-editor')) return;
  e.preventDefault();
  const dir = e.deltaY < 0 ? 1 : -1;
  if (e.target.closest('.xterm')) {
    const size = Math.max(6, Math.min(64, settings.get('terminal.integrated.fontSize') + dir));
    settings.set('terminal.integrated.fontSize', size);
    return;
  }
  const md = e.target.closest('.markdown-preview');
  if (md) {
    md.style.zoom = String(Math.max(0.5, Math.min(3, (parseFloat(md.style.zoom) || 1) + dir * 0.1)));
    return;
  }
  setZoom(zoom + dir * 0.5);
}, { passive: false, capture: true });

// ---------------------------------------------------------------------------
// Workspace lifecycle
// ---------------------------------------------------------------------------
async function confirmDirty(message = 'Do you want to save the changes you made?') {
  const dirty = editors.dirtyDocuments();
  if (!dirty.length) return true;
  const names = dirty.map((d) => d.name).slice(0, 10).join('\n');
  const r = await confirm(dirty.length === 1 ? `Do you want to save the changes you made to ${dirty[0].name}?` : `${message}\n\n${dirty.length} files have unsaved changes.`, {
    detail: (dirty.length > 1 ? names + '\n\n' : '') + "Your changes will be lost if you don't save them.",
    buttons: [dirty.length > 1 ? 'Save All' : 'Save', "Don't Save", 'Cancel'],
    type: 'warning',
    cancelId: 2,
  });
  if (r === 2) return false;
  if (r === 0) {
    for (const d of dirty) if (!(await editors.saveDocument(d))) return false;
  } else for (const d of dirty) d.markSaved();
  return true;
}

async function openFolder(path) {
  if (!path) path = await window.snake.dialog.openFolder();
  if (!path) return;
  if (workspace.root === path) return;
  const st = await window.snake.fs.stat(path);
  if (!st.exists || !st.isDir) { notify({ type: 'error', message: `Folder '${path}' does not exist.` }); removeRecent(path); return; }
  await persistSession(true);
  if (!(await confirmDirty('Opening a folder will close all editors.'))) return;
  await editors.closeAllEditors();
  setRoot(path);
  await restoreSession(path);
}

async function closeFolder() {
  if (!workspace.root) return;
  await persistSession(true);
  if (!(await confirmDirty())) return;
  await editors.closeAllEditors();
  setRoot(null);
  if (settings.get('workbench.startupEditor') === 'welcomePage') openWelcome();
}

async function openPath(path) {
  const st = await window.snake.fs.stat(path);
  if (!st.exists) { notify({ type: 'error', message: `'${path}' does not exist.` }); removeRecent(path); return; }
  if (st.isDir) return openFolder(path);
  return editors.openFile(path, { pinned: true });
}

// ---------------------------------------------------------------------------
// Session persistence (per folder) incl. hot exit of unsaved content
// ---------------------------------------------------------------------------
function serializeSession() {
  const groups = editors.getGroups().map((g) => ({
    size: g.size,
    active: g.tabs.indexOf(g.active),
    tabs: g.tabs
      .map((t) => {
        if (t.kind === 'text') return t.doc.path ? { kind: 'text', path: t.doc.path, preview: !!t.preview } : { kind: 'untitled', key: t.doc.key };
        if (['image', 'media', 'binary'].includes(t.kind)) return { kind: 'file', path: t.path };
        if (['settings', 'keybindings', 'welcome'].includes(t.kind)) return { kind: t.kind };
        if (t.kind === 'markdown' && t.doc.path) return { kind: 'markdown', path: t.doc.path };
        return null;
      })
      .filter(Boolean),
  }));
  const hot = settings.get('files.hotExit')
    ? editors.dirtyDocuments().map((d) => ({ key: d.key, path: d.path, content: d.model.getValue(), language: d.model.getLanguageId() }))
    : [];
  return {
    groups,
    activeGroup: editors.getGroups().indexOf(editors.getActiveGroup()),
    sidebar: { visible: isSidebarVisible(), view: getActiveView(), width: sidebarWidth },
    panel: panel.getPanelLayout(),
    hot,
    time: Date.now(),
  };
}

async function persistSession(immediate = false) {
  if (!booted) return;
  const st = getState();
  st.sessions[workspace.root || '__empty__'] = serializeSession();
  st.zoom = zoom;
  await saveState(immediate);
}
const persistSessionSoon = debounce(() => persistSession(), 1500);

async function restoreSession(root) {
  const s = getState().sessions[root || '__empty__'];
  const restoreOn = settings.get('workbench.restoreSession');
  if (s?.sidebar) {
    if (s.sidebar.width) setSidebarWidth(s.sidebar.width);
    if (s.sidebar.view) showView(s.sidebar.view, { focus: false });
    setSidebarVisible(s.sidebar.visible !== false);
  }
  if (s?.panel && !booted) panel.restorePanelLayout(s.panel);
  if (!s || !restoreOn) {
    if (settings.get('workbench.startupEditor') === 'welcomePage' && !root) openWelcome();
    else if (settings.get('workbench.startupEditor') === 'newUntitledFile' && !root) editors.openUntitled();
    else if (!root && settings.get('workbench.startupEditor') === 'welcomePage') openWelcome();
    return;
  }
  const hot = new Map((s.hot || []).map((h) => [h.path || h.key, h]));
  const usedHot = new Set();
  for (let gi = 0; gi < s.groups.length; gi++) {
    const gs = s.groups[gi];
    if (!gs.tabs.length) continue;
    const group = gi === 0 ? editors.getGroups()[0] : editors.addGroupRight();
    group.size = gs.size || 1;
    editors.setActiveGroup(group);
    for (const t of gs.tabs) {
      try {
        if (t.kind === 'text' || t.kind === 'file') {
          const st = await window.snake.fs.stat(t.path);
          if (!st.exists && !hot.has(t.path)) continue;
          if (!st.exists) {
            // deleted on disk but had unsaved content: restore as untitled
            const h = hot.get(t.path);
            editors.openUntitled(h.content, h.language);
            usedHot.add(t.path);
            continue;
          }
          await editors.openFile(t.path, { pinned: !t.preview, preview: t.preview, focus: false, noRecent: true, noHistory: true });
          const h = hot.get(t.path);
          if (h && !usedHot.has(t.path)) {
            const doc = editors.getDocument(t.path);
            if (doc && doc.model.getValue() !== h.content) doc.model.pushEditOperations([], [{ range: doc.model.getFullModelRange(), text: h.content }], () => null);
            usedHot.add(t.path);
          }
        } else if (t.kind === 'untitled') {
          const h = hot.get(t.key);
          if (h) { editors.openUntitled(h.content, h.language); usedHot.add(t.key); }
        } else if (t.kind === 'settings') openSettings();
        else if (t.kind === 'keybindings') openKeybindings();
        else if (t.kind === 'welcome') openWelcome();
        else if (t.kind === 'markdown') {
          await editors.openFile(t.path, { pinned: true, focus: false, noRecent: true });
          editors.openMarkdownPreview(false);
        }
      } catch (err) {
        console.warn('restore failed for', t, err);
      }
    }
    if (gs.active >= 0 && group.tabs[gs.active]) group.activate(group.tabs[gs.active], false);
  }
  // unsaved buffers whose tabs were not restored
  for (const [k, h] of hot) if (!usedHot.has(k)) editors.openUntitled(h.content, h.language);
  const groups = editors.getGroups();
  const ag = groups[s.activeGroup] || groups[0];
  editors.setActiveGroup(ag);
  ag.focus();
  if (!editors.getGroups().some((g) => g.tabs.length) && settings.get('workbench.startupEditor') === 'welcomePage' && !root) openWelcome();
}

// ---------------------------------------------------------------------------
// Pickers
// ---------------------------------------------------------------------------
function selectTheme() {
  const original = settings.get('workbench.colorTheme');
  const items = themes.map((t) => ({ label: t.label, description: t.type === 'light' ? 'light' : t.type === 'hc' ? 'high contrast' : 'dark', id: t.id, iconEl: undefined }));
  const activeIdx = items.findIndex((i) => i.id === original);
  let accepted = false;
  quickInput.open({
    placeholder: 'Select Color Theme (Up/Down Keys to Preview)',
    items,
    onFocus: (item) => applyTheme(item.id),
    onAccept: (item) => { accepted = true; settings.set('workbench.colorTheme', item.id); },
    onCancel: () => { if (!accepted) applyTheme(original); },
  });
  quickInput.index = Math.max(0, activeIdx);
  quickInput.updateActive();
}

async function changeLanguageMode() {
  const ed = editors.activeCodeEditor();
  if (!ed) return;
  const model = ed.getModel();
  const cur = model.getLanguageId();
  const items = [
    { label: 'Auto Detect', description: 'based on file name', id: '__auto', alwaysShow: false },
    ...monaco.languages
      .getLanguages()
      .map((l) => ({ label: l.aliases?.[0] || l.id, description: `(${l.id})${l.id === cur ? ' - Configured Language' : ''}`, id: l.id, iconEl: fileIcon('x' + (l.extensions?.[0] || '.txt')) }))
      .sort((a, b) => a.label.localeCompare(b.label)),
  ];
  const c = await pick(items, { placeholder: 'Select Language Mode', matchOnDescription: true });
  if (!c) return;
  const doc = editors.activeDoc();
  monaco.editor.setModelLanguage(model, c.id === '__auto' ? editors.languageFor(doc?.path) : c.id);
  bus.emit('editor:cursor');
}

async function changeEOL() {
  const ed = editors.activeCodeEditor();
  if (!ed) return;
  const c = await pick([{ label: 'LF', description: '\\n', v: 0 }, { label: 'CRLF', description: '\\r\\n', v: 1 }], { placeholder: 'Select End of Line Sequence' });
  if (!c) return;
  ed.getModel().pushEOL(c.v);
  bus.emit('editor:cursor');
}

async function changeIndentation() {
  const ed = editors.activeCodeEditor();
  if (!ed) return;
  const c = await pick(
    [
      { label: 'Indent Using Spaces', a: 'spaces' },
      { label: 'Indent Using Tabs', a: 'tabs' },
      { label: 'Change Tab Display Size', a: 'size' },
      { label: 'Detect Indentation from Content', a: 'editor.action.detectIndentation' },
      { label: 'Convert Indentation to Spaces', a: 'editor.action.indentationToSpaces' },
      { label: 'Convert Indentation to Tabs', a: 'editor.action.indentationToTabs' },
      { label: 'Reindent Lines', a: 'editor.action.reindentlines' },
    ],
    { placeholder: 'Select Action' },
  );
  if (!c) return;
  const model = ed.getModel();
  if (['spaces', 'tabs', 'size'].includes(c.a)) {
    const cur = model.getOptions().tabSize;
    const size = await pick([1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ label: String(n), description: n === cur ? 'Configured Tab Size' : '' })), { placeholder: 'Select Tab Size for the Current File' });
    if (!size) return;
    const opts = { tabSize: +size.label };
    if (c.a !== 'size') opts.insertSpaces = c.a === 'spaces';
    model.updateOptions(opts);
  } else editors.runEditorAction(c.a);
  bus.emit('editor:cursor');
}

async function changeEncoding() {
  const doc = editors.activeDoc();
  if (!doc) return;
  const c = await pick([{ label: 'UTF-8', bom: false }, { label: 'UTF-8 with BOM', bom: true }], { placeholder: 'Save with Encoding' });
  if (!c) return;
  doc.bom = c.bom;
  if (!doc.untitled) await editors.saveDocument(doc);
  bus.emit('editor:cursor');
}

async function openRecent() {
  const recent = getState().recent || [];
  const items = recent.map((r) => ({
    label: basename(r.path),
    description: r.path.replace(env.homeDir, '~'),
    path: r.path,
    iconEl: r.type === 'folder' ? el('span.codicon.codicon-folder') : fileIcon(basename(r.path)),
    separator: undefined,
    buttons: [
      { icon: 'empty-window', title: 'Open in New Window', run: (it, qi) => { qi.close(false); window.snake.win.newWindow(it.path); } },
      { icon: 'close', title: 'Remove from Recently Opened', run: (it, qi) => { removeRecent(it.path); qi.setItems(qi.items.filter((x) => x !== it)); } },
    ],
  }));
  const f = items.findIndex((i) => recent.find((r) => r.path === i.path)?.type === 'folder');
  const fl = items.findIndex((i) => recent.find((r) => r.path === i.path)?.type === 'file');
  if (f >= 0) items[f].separator = 'folders';
  if (fl >= 0) items[fl].separator = 'files';
  const c = await pick(items, { placeholder: 'Select to open (hold Ctrl-key to open in new window)', matchOnDescription: true });
  if (c) openPath(c.path);
}

async function runTask() {
  const root = workspace.root;
  if (!root) { notify({ type: 'warning', message: 'Open a folder to run tasks.' }); return; }
  const tasks = [];
  const read = async (f) => (await window.snake.fs.readFile(join(root, f)).catch(() => null))?.content;
  const pkg = await read('package.json');
  if (pkg) {
    try {
      const scripts = JSON.parse(pkg).scripts || {};
      const pm = (await window.snake.fs.stat(join(root, 'pnpm-lock.yaml'))).exists ? 'pnpm' : (await window.snake.fs.stat(join(root, 'yarn.lock'))).exists ? 'yarn' : (await window.snake.fs.stat(join(root, 'bun.lockb'))).exists ? 'bun' : 'npm';
      for (const [name, cmd] of Object.entries(scripts)) tasks.push({ label: `${pm}: ${name}`, description: cmd, cmd: `${pm} run ${name}`, icon: 'package' });
      tasks.push({ label: `${pm}: install`, description: 'install dependencies', cmd: `${pm} install`, icon: 'package' });
    } catch {}
  }
  const make = await read('Makefile') || await read('makefile');
  if (make) {
    for (const m of make.matchAll(/^([A-Za-z0-9_][\w.\-/]*)\s*:(?!=)/gm)) if (!m[1].startsWith('.')) tasks.push({ label: `make: ${m[1]}`, cmd: `make ${m[1]}`, icon: 'tools' });
  }
  if (await read('Cargo.toml')) for (const t of ['build', 'run', 'test', 'check', 'clippy']) tasks.push({ label: `cargo: ${t}`, cmd: `cargo ${t}`, icon: 'tools' });
  if (await read('go.mod')) for (const t of ['build ./...', 'run .', 'test ./...', 'vet ./...']) tasks.push({ label: `go: ${t}`, cmd: `go ${t}`, icon: 'tools' });
  if (await read('CMakeLists.txt')) tasks.push({ label: 'cmake: configure & build', cmd: 'cmake -B build && cmake --build build', icon: 'tools' });
  if (await read('pyproject.toml') || await read('requirements.txt')) {
    tasks.push({ label: 'python: run tests (pytest)', cmd: 'python3 -m pytest', icon: 'beaker' });
    if (await read('requirements.txt')) tasks.push({ label: 'pip: install requirements', cmd: 'pip install -r requirements.txt', icon: 'package' });
  }
  const just = await read('justfile') || await read('Justfile');
  if (just) for (const m of just.matchAll(/^([A-Za-z0-9_-]+)\s*(?:[^:=\n]*):(?!=)/gm)) tasks.push({ label: `just: ${m[1]}`, cmd: `just ${m[1]}`, icon: 'tools' });
  tasks.push({ label: 'Run custom command...', cmd: null, icon: 'terminal', alwaysShow: true });
  const c = await pick(tasks, { placeholder: 'Select the task to run', matchOnDescription: true });
  if (!c) return;
  let cmd = c.cmd;
  if (!cmd) {
    cmd = await inputBox({ prompt: 'Command to run in the workspace folder', value: getState().lastCustomTask || '' });
    if (!cmd) return;
    getState().lastCustomTask = cmd;
    saveState();
  }
  panel.runInTerminal(cmd, { newTerminal: true, cwd: root, title: c.label.split(':').pop().trim() });
}

async function runActiveFile() {
  const doc = editors.activeDoc();
  if (!doc) return;
  if (doc.untitled || doc.dirty) {
    if (!(await editors.saveDocument(doc))) return;
  }
  const cmd = editors.runCommandFor(doc.path);
  if (!cmd) { notify({ type: 'warning', message: `Don't know how to run '${basename(doc.path)}'. Use Run Task → Run custom command.` }); return; }
  panel.runInTerminal(cmd, { cwd: dirname(doc.path) });
}

async function newFileWithName() {
  if (!workspace.root) return editors.openUntitled();
  const name = await inputBox({ prompt: 'File name (relative to the workspace folder)', placeholder: 'src/new-file.js' });
  if (!name) return;
  const p = join(workspace.root, name);
  try {
    await window.snake.fs.createFile(p);
  } catch (err) {
    if (!/EEXIST/.test(err.message)) return notify({ type: 'error', message: err.message });
  }
  invalidateFileList();
  editors.openFile(p, { pinned: true });
}

function editorText() {
  const ed = editors.activeCodeEditor();
  if (!ed) return '';
  const sel = ed.getSelection();
  return sel && !sel.isEmpty() ? ed.getModel().getValueInRange(sel) : ed.getModel().getLineContent(ed.getPosition().lineNumber);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
function registerAllCommands() {
  const E = (id, title, displayKey, category = 'Edit') => ({ id, title, category, displayKey, run: () => {
    const editorFocused = document.activeElement?.closest?.('.monaco-editor');
    const ed = editors.activeCodeEditor();
    if (!editorFocused && ['undo', 'redo', 'editor.action.clipboardCutAction', 'editor.action.clipboardCopyAction', 'editor.action.clipboardPasteAction', 'editor.action.selectAll'].includes(id) && document.activeElement && document.activeElement !== document.body) {
      const map = { undo: 'undo', redo: 'redo', 'editor.action.clipboardCutAction': 'cut', 'editor.action.clipboardCopyAction': 'copy', 'editor.action.clipboardPasteAction': 'paste', 'editor.action.selectAll': 'selectAll' };
      document.execCommand(map[id]);
      return;
    }
    if (!ed) return;
    editors.runEditorAction(id);
  } });
  const termCmds = panel.terminalCommands();
  const zenWhen = () => zen;

  registerCommands([
    // ---- palette & navigation ----
    { id: 'workbench.action.showCommands', title: 'Show All Commands', category: 'View', key: ['ctrl+shift+p', 'f1'], inTerminal: true, run: () => openQuickOpen('>') },
    { id: 'workbench.action.quickOpen', title: 'Go to File...', category: 'File', key: ['ctrl+p', 'ctrl+e'], inTerminal: true, run: () => openQuickOpen('') },
    { id: 'workbench.action.gotoLine', title: 'Go to Line/Column...', category: 'Go', displayKey: 'ctrl+g', run: () => (editors.activeCodeEditor() ? openQuickOpen(':') : null) },
    { id: 'workbench.action.gotoSymbol', title: 'Go to Symbol in Editor...', category: 'Go', displayKey: 'ctrl+shift+o', run: () => editors.runEditorAction('editor.action.quickOutline') },
    { id: 'workbench.action.showAllEditors', title: 'Show All Editors By Appearance', category: 'View', key: 'ctrl+k ctrl+p', run: () => openQuickOpen('edt ') },
    { id: 'workbench.action.quickOpenPreviousRecentlyUsedEditorInGroup', title: 'Quick Open Previous Recently Used Editor in Group', category: 'View', key: 'ctrl+tab', inTerminal: true, run: () => showEditorsMRU(true) },
    { id: 'workbench.action.navigateBack', title: 'Go Back', category: 'Go', key: ['alt+left', 'ctrl+alt+-'], run: () => editors.goBack() },
    { id: 'workbench.action.navigateForward', title: 'Go Forward', category: 'Go', key: ['alt+right', 'ctrl+shift+-'], run: () => editors.goForward() },
    { id: 'workbench.action.nextEditor', title: 'Open Next Editor', category: 'View', key: ['ctrl+pagedown', 'ctrl+alt+right'], inTerminal: true, run: () => editors.cycleTab(1) },
    { id: 'workbench.action.previousEditor', title: 'Open Previous Editor', category: 'View', key: ['ctrl+pageup', 'ctrl+alt+left'], inTerminal: true, run: () => editors.cycleTab(-1) },
    ...[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ id: `workbench.action.openEditorAtIndex${n}`, title: `Open Editor at Index ${n}`, category: 'View', key: `alt+${n}`, run: () => editors.openTabAt(n - 1) })),
    { id: 'workbench.action.lastEditorInGroup', title: 'Open Last Editor in Group', category: 'View', key: 'alt+9', run: () => editors.openTabAt(-1) },
    ...[1, 2, 3, 4].map((n) => ({ id: `workbench.action.focus${['', 'First', 'Second', 'Third', 'Fourth'][n]}EditorGroup`, title: `Focus ${['', 'First', 'Second', 'Third', 'Fourth'][n]} Editor Group`, category: 'View', key: `ctrl+${n}`, inTerminal: true, run: () => editors.focusGroup(n - 1) })),
    { id: 'workbench.action.focusNextGroup', title: 'Focus Next Editor Group', category: 'View', key: 'ctrl+k ctrl+right', run: () => editors.focusNextGroup(1) },
    { id: 'workbench.action.focusPreviousGroup', title: 'Focus Previous Editor Group', category: 'View', key: 'ctrl+k ctrl+left', run: () => editors.focusNextGroup(-1) },
    { id: 'workbench.action.moveEditorLeftInGroup', title: 'Move Editor Left', category: 'View', key: 'ctrl+shift+pageup', run: () => editors.moveActiveTab(-1) },
    { id: 'workbench.action.moveEditorRightInGroup', title: 'Move Editor Right', category: 'View', key: 'ctrl+shift+pagedown', run: () => editors.moveActiveTab(1) },
    { id: 'workbench.action.moveEditorToNextGroup', title: 'Move Editor into Next Group', category: 'View', key: 'ctrl+alt+shift+right', run: () => editors.moveEditorToGroup(1) },
    { id: 'workbench.action.moveEditorToPreviousGroup', title: 'Move Editor into Previous Group', category: 'View', key: 'ctrl+alt+shift+left', run: () => editors.moveEditorToGroup(-1) },

    // ---- files ----
    { id: 'workbench.action.files.newUntitledFile', title: 'New Untitled Text File', category: 'File', key: 'ctrl+n', run: () => editors.openUntitled() },
    { id: 'workbench.action.files.newFile', title: 'New File...', category: 'File', key: 'ctrl+alt+n', run: () => newFileWithName() },
    { id: 'explorer.newFile', title: 'New File in Explorer', category: 'File', run: () => explorer.newFile() },
    { id: 'explorer.newFolder', title: 'New Folder in Explorer', category: 'File', run: () => explorer.newFolder() },
    { id: 'workbench.action.files.openFile', title: 'Open File...', category: 'File', key: 'ctrl+o', run: async () => { for (const p of await window.snake.dialog.openFiles()) await editors.openFile(p, { pinned: true }); } },
    { id: 'workbench.action.files.openFolder', title: 'Open Folder...', category: 'File', key: 'ctrl+k ctrl+o', run: () => openFolder() },
    { id: 'workbench.action.files.openPath', title: 'Open Path', category: 'File', hidden: true, run: (p) => p && openPath(p) },
    { id: 'workbench.action.openRecent', title: 'Open Recent...', category: 'File', key: 'ctrl+r', inTerminal: false, run: () => openRecent() },
    { id: 'workbench.action.clearRecentFiles', title: 'Clear Recently Opened...', category: 'File', run: async () => { if ((await confirm('Do you want to clear all recently opened files and folders?', { buttons: ['Clear', 'Cancel'], cancelId: 1 })) === 0) clearRecent(); } },
    { id: 'workbench.action.closeFolder', title: 'Close Folder', category: 'Workspaces', key: 'ctrl+k f', run: () => closeFolder() },
    { id: 'workbench.action.files.save', title: 'Save', category: 'File', key: 'ctrl+s', run: () => editors.saveDocument(editors.activeDoc()) },
    { id: 'workbench.action.files.saveAs', title: 'Save As...', category: 'File', key: 'ctrl+shift+s', run: () => editors.saveDocument(editors.activeDoc(), { saveAs: true }) },
    { id: 'workbench.action.files.saveAll', title: 'Save All Files', category: 'File', key: 'ctrl+k s', run: async () => { for (const d of editors.dirtyDocuments()) await editors.saveDocument(d); } },
    { id: 'workbench.action.files.saveWithoutFormatting', title: 'Save without Formatting', category: 'File', key: 'ctrl+k ctrl+shift+s', run: () => editors.saveDocument(editors.activeDoc(), { skipParticipants: true }) },
    { id: 'workbench.action.files.revert', title: 'Revert File', category: 'File', run: () => editors.revertDocument(editors.activeDoc()) },
    { id: 'workbench.files.action.compareWithSaved', title: 'Compare Active File with Saved', category: 'File', key: 'ctrl+k d', run: () => { const d = editors.activeDoc(); if (d?.path) editors.compareWithSaved(d); } },
    { id: 'workbench.files.action.compareWithClipboard', title: 'Compare Active File with Clipboard', category: 'File', key: 'ctrl+k c', run: async () => { const d = editors.activeDoc(); if (d) editors.openDiff({ originalText: await window.snake.clipboard.read(), doc: d, title: `Clipboard ↔ ${d.name}`, key: 'clip:' + d.key }); } },
    { id: 'workbench.action.toggleAutoSave', title: 'Toggle Auto Save', category: 'File', run: () => settings.set('files.autoSave', settings.get('files.autoSave') === 'off' ? 'afterDelay' : 'off') },
    { id: 'workbench.action.files.copyPathOfActiveFile', title: 'Copy Path of Active File', category: 'File', key: 'ctrl+k p', run: () => { const p = editors.activeDoc()?.path; if (p) window.snake.clipboard.write(p); } },
    { id: 'copyRelativeFilePath', title: 'Copy Relative Path of Active File', category: 'File', key: 'ctrl+k ctrl+shift+c', run: () => { const p = editors.activeDoc()?.path; if (p) window.snake.clipboard.write(relative(workspace.root, p)); } },
    { id: 'workbench.action.files.revealActiveFileInWindows', title: 'Reveal Active File in File Manager', category: 'File', key: 'ctrl+k r', run: () => { const p = editors.activeDoc()?.path; if (p) window.snake.shell.showItemInFolder(p); } },
    { id: 'workbench.files.action.showActiveFileInExplorer', title: 'Reveal Active File in Explorer View', category: 'File', run: () => { const p = editors.activeDoc()?.path; if (p) explorer.reveal(p, true); } },
    { id: 'explorer.refresh', title: 'Refresh Explorer', category: 'File', run: () => explorer.refreshTree() },
    { id: 'workbench.files.action.collapseExplorerFolders', title: 'Collapse Folders in Explorer', category: 'File', run: () => explorer.collapseAll() },

    // ---- editor management ----
    { id: 'workbench.action.closeActiveEditor', title: 'Close Editor', category: 'View', key: ['ctrl+w', 'ctrl+f4'], run: () => editors.closeActiveEditor() },
    { id: 'workbench.action.closeAllEditors', title: 'Close All Editors', category: 'View', key: 'ctrl+k ctrl+w', run: () => editors.closeAllEditors() },
    { id: 'workbench.action.closeOtherEditors', title: 'Close Other Editors in Group', category: 'View', run: () => { const g = editors.getActiveGroup(); g.closeAll({ except: g.active }); } },
    { id: 'workbench.action.closeEditorsInGroup', title: 'Close All Editors in Group', category: 'View', key: 'ctrl+k w', run: () => editors.closeGroup() },
    { id: 'workbench.action.closeUnmodifiedEditors', title: 'Close Saved Editors in Group', category: 'View', key: 'ctrl+k u', run: () => editors.getActiveGroup().closeSaved() },
    { id: 'workbench.action.reopenClosedEditor', title: 'Reopen Closed Editor', category: 'View', key: 'ctrl+shift+t', run: () => editors.reopenClosed() },
    { id: 'workbench.action.keepEditor', title: 'Keep Editor', category: 'View', key: 'ctrl+k enter', run: () => editors.pinActive() },
    { id: 'workbench.action.splitEditor', title: 'Split Editor', category: 'View', key: 'ctrl+\\', run: () => editors.splitEditor() },
    { id: 'workbench.action.joinAllGroups', title: 'Join All Editor Groups', category: 'View', run: () => editors.joinAllGroups() },
    { id: 'markdown.showPreviewToSide', title: 'Open Preview to the Side', category: 'Markdown', key: 'ctrl+k v', run: () => editors.openMarkdownPreview(true) },
    { id: 'markdown.showPreview', title: 'Open Preview', category: 'Markdown', key: 'ctrl+shift+v', run: () => editors.openMarkdownPreview(false) },

    // ---- edit (delegated to Monaco; keys handled natively by the editor) ----
    E('undo', 'Undo', 'ctrl+z'),
    E('redo', 'Redo', 'ctrl+y'),
    E('editor.action.clipboardCutAction', 'Cut', 'ctrl+x'),
    E('editor.action.clipboardCopyAction', 'Copy', 'ctrl+c'),
    E('editor.action.clipboardPasteAction', 'Paste', 'ctrl+v'),
    E('actions.find', 'Find', 'ctrl+f'),
    E('editor.action.startFindReplaceAction', 'Replace', 'ctrl+h'),
    E('editor.action.commentLine', 'Toggle Line Comment', 'ctrl+/'),
    E('editor.action.blockComment', 'Toggle Block Comment', 'ctrl+shift+a'),
    E('editor.action.formatDocument', 'Format Document', 'ctrl+shift+i'),
    E('editor.action.formatSelection', 'Format Selection', 'ctrl+k ctrl+f'),
    E('editor.action.selectAll', 'Select All', 'ctrl+a', 'Selection'),
    E('editor.action.smartSelect.expand', 'Expand Selection', 'shift+alt+right', 'Selection'),
    E('editor.action.smartSelect.shrink', 'Shrink Selection', 'shift+alt+left', 'Selection'),
    E('editor.action.copyLinesUpAction', 'Copy Line Up', 'shift+alt+up', 'Selection'),
    E('editor.action.copyLinesDownAction', 'Copy Line Down', 'shift+alt+down', 'Selection'),
    E('editor.action.moveLinesUpAction', 'Move Line Up', 'alt+up', 'Selection'),
    E('editor.action.moveLinesDownAction', 'Move Line Down', 'alt+down', 'Selection'),
    E('editor.action.duplicateSelection', 'Duplicate Selection', null, 'Selection'),
    E('editor.action.insertCursorAbove', 'Add Cursor Above', 'ctrl+alt+up', 'Selection'),
    E('editor.action.insertCursorBelow', 'Add Cursor Below', 'ctrl+alt+down', 'Selection'),
    E('editor.action.insertCursorAtEndOfEachLineSelected', 'Add Cursors to Line Ends', 'shift+alt+i', 'Selection'),
    E('editor.action.addSelectionToNextFindMatch', 'Add Selection to Next Find Match', 'ctrl+d', 'Selection'),
    E('editor.action.selectHighlights', 'Select All Occurrences of Find Match', 'ctrl+shift+l', 'Selection'),
    E('editor.action.toggleColumnSelection', 'Toggle Column Selection Mode', null, 'Selection'),
    E('editor.action.jumpToBracket', 'Go to Bracket', 'ctrl+shift+\\', 'Go'),
    E('editor.action.revealDefinition', 'Go to Definition', 'f12', 'Go'),
    E('editor.action.goToReferences', 'Go to References', 'shift+f12', 'Go'),
    E('editor.action.rename', 'Rename Symbol', 'f2', 'Edit'),
    E('editor.action.marker.nextInFiles', 'Go to Next Problem', 'f8', 'Go'),
    E('editor.action.marker.prevInFiles', 'Go to Previous Problem', 'shift+f8', 'Go'),
    { id: 'editor.action.dirtydiff.next', title: 'Go to Next Change', category: 'Go', key: 'alt+f5', run: () => gotoChange(1) },
    { id: 'editor.action.dirtydiff.previous', title: 'Go to Previous Change', category: 'Go', key: 'shift+alt+f5', run: () => gotoChange(-1) },
    { id: 'editor.action.changeIndentation', title: 'Change Indentation...', category: 'Editor', run: () => changeIndentation() },
    { id: 'editor.action.trimTrailingWhitespace', title: 'Trim Trailing Whitespace', category: 'Editor', key: 'ctrl+k ctrl+x', run: () => editors.runEditorAction('editor.action.trimTrailingWhitespace') },
    { id: 'editor.action.transformToUppercase', title: 'Transform to Uppercase', category: 'Editor', run: () => editors.runEditorAction('editor.action.transformToUppercase') },
    { id: 'editor.action.transformToLowercase', title: 'Transform to Lowercase', category: 'Editor', run: () => editors.runEditorAction('editor.action.transformToLowercase') },
    { id: 'editor.action.sortLinesAscending', title: 'Sort Lines Ascending', category: 'Editor', run: () => editors.runEditorAction('editor.action.sortLinesAscending') },
    { id: 'workbench.action.editor.changeLanguageMode', title: 'Change Language Mode', category: 'View', key: 'ctrl+k m', run: () => changeLanguageMode() },
    { id: 'workbench.action.editor.changeEOL', title: 'Change End of Line Sequence', category: 'View', run: () => changeEOL() },
    { id: 'workbench.action.editor.changeEncoding', title: 'Change File Encoding', category: 'View', run: () => changeEncoding() },
    { id: 'editor.toggleWordWrap', title: 'Toggle Word Wrap', category: 'View', key: 'alt+z', run: () => settings.set('editor.wordWrap', settings.get('editor.wordWrap') === 'off' ? 'on' : 'off') },
    { id: 'editor.toggleMinimap', title: 'Toggle Minimap', category: 'View', run: () => settings.set('editor.minimap.enabled', !settings.get('editor.minimap.enabled')) },
    { id: 'editor.toggleStickyScroll', title: 'Toggle Sticky Scroll', category: 'View', run: () => settings.set('editor.stickyScroll.enabled', !settings.get('editor.stickyScroll.enabled')) },
    { id: 'editor.toggleRenderWhitespace', title: 'Toggle Render Whitespace', category: 'View', run: () => settings.set('editor.renderWhitespace', settings.get('editor.renderWhitespace') === 'all' ? 'selection' : 'all') },
    { id: 'breadcrumbs.toggle', title: 'Toggle Breadcrumbs', category: 'View', run: () => settings.set('workbench.breadcrumbs.enabled', !settings.get('workbench.breadcrumbs.enabled')) },
    { id: 'editor.action.fontZoomIn', title: 'Editor Font Zoom In', category: 'Editor', run: () => settings.set('editor.fontSize', settings.get('editor.fontSize') + 1) },
    { id: 'editor.action.fontZoomOut', title: 'Editor Font Zoom Out', category: 'Editor', run: () => settings.set('editor.fontSize', Math.max(6, settings.get('editor.fontSize') - 1)) },
    { id: 'editor.action.fontZoomReset', title: 'Editor Font Zoom Reset', category: 'Editor', run: () => settings.reset('editor.fontSize') },

    // ---- search ----
    { id: 'workbench.action.findInFiles', title: 'Find in Files', category: 'Search', key: 'ctrl+shift+f', inTerminal: true, run: (opts) => focusSearch({ query: opts?.query ?? (editorText().includes('\n') ? undefined : editorText().trim() || undefined), ...(opts || {}) }) },
    { id: 'workbench.action.replaceInFiles', title: 'Replace in Files', category: 'Search', key: 'ctrl+shift+h', run: () => focusSearch({ replace: true }) },
    { id: 'workbench.view.search', title: 'Show Search', category: 'View', run: () => showView('search') },

    // ---- views & layout ----
    { id: 'workbench.view.explorer', title: 'Show Explorer', category: 'View', key: 'ctrl+shift+e', inTerminal: true, run: () => showView('explorer') },
    { id: 'workbench.view.scm', title: 'Show Source Control', category: 'View', key: 'ctrl+shift+g', inTerminal: true, run: () => showView('scm') },
    { id: 'workbench.action.toggleSidebarVisibility', title: 'Toggle Primary Side Bar Visibility', category: 'View', key: 'ctrl+b', inTerminal: true, run: () => toggleSidebar() },
    { id: 'workbench.action.toggleSidebarPosition', title: 'Toggle Primary Side Bar Position', category: 'View', run: () => settings.set('workbench.sideBar.location', settings.get('workbench.sideBar.location') === 'left' ? 'right' : 'left') },
    { id: 'workbench.action.toggleActivityBarVisibility', title: 'Toggle Activity Bar Visibility', category: 'View', run: () => settings.set('workbench.activityBar.visible', !settings.get('workbench.activityBar.visible')) },
    { id: 'workbench.action.toggleStatusbarVisibility', title: 'Toggle Status Bar Visibility', category: 'View', run: () => settings.set('workbench.statusBar.visible', !settings.get('workbench.statusBar.visible')) },
    { id: 'workbench.action.togglePanel', title: 'Toggle Panel Visibility', category: 'View', key: 'ctrl+j', inTerminal: true, run: () => panel.togglePanel() },
    { id: 'workbench.action.toggleMaximizedPanel', title: 'Toggle Maximized Panel', category: 'View', run: () => panel.toggleMaximized() },
    { id: 'workbench.actions.view.problems', title: 'Focus on Problems View', category: 'View', key: 'ctrl+shift+m', inTerminal: true, run: () => panel.showPanel('problems') },
    { id: 'workbench.action.output.show', title: 'Show Output', category: 'View', key: 'ctrl+shift+u', inTerminal: true, run: () => panel.showOutput() },
    { id: 'workbench.action.toggleZenMode', title: 'Toggle Zen Mode', category: 'View', key: 'ctrl+k z', inTerminal: true, run: () => toggleZen() },
    { id: 'workbench.action.exitZenMode', title: 'Exit Zen Mode', category: 'View', key: 'escape', when: zenWhen, notInEditor: true, hidden: true, run: () => zen && toggleZen() },
    { id: 'workbench.action.toggleFullScreen', title: 'Toggle Full Screen', category: 'View', key: 'f11', inTerminal: true, run: () => window.snake.win.toggleFullScreen() },
    { id: 'workbench.action.zoomIn', title: 'Zoom In', category: 'View', key: ['ctrl+=', 'ctrl+shift+='], inTerminal: true, run: () => setZoom(zoom + 1) },
    { id: 'workbench.action.zoomOut', title: 'Zoom Out', category: 'View', key: 'ctrl+-', inTerminal: true, run: () => setZoom(zoom - 1) },
    { id: 'workbench.action.zoomReset', title: 'Reset Zoom', category: 'View', key: 'ctrl+0', inTerminal: true, run: () => setZoom(settings.get('window.zoomLevel') || 0) },
    { id: 'workbench.action.focusActiveEditorGroup', title: 'Focus Active Editor Group', category: 'View', run: () => editors.getActiveGroup()?.focus() },
    { id: 'workbench.action.focusSideBar', title: 'Focus into Primary Side Bar', category: 'View', run: () => showView(getActiveView() || 'explorer') },

    // ---- terminal ----
    { id: 'workbench.action.terminal.toggleTerminal', title: 'Toggle Terminal', category: 'Terminal', key: 'ctrl+`', inTerminal: true, run: () => panel.toggleTerminal() },
    { id: 'workbench.action.terminal.new', title: 'Create New Terminal', category: 'Terminal', key: 'ctrl+shift+`', inTerminal: true, run: () => panel.createTerminal() },
    { id: 'workbench.action.terminal.newInDir', title: 'Create New Terminal in Folder', category: 'Terminal', hidden: true, run: (dir) => panel.createTerminal({ cwd: dir }) },
    { id: 'workbench.action.terminal.split', title: 'Split Terminal', category: 'Terminal', key: 'ctrl+shift+5', inTerminal: true, run: () => panel.createTerminal() },
    { id: 'workbench.action.terminal.focusNext', title: 'Focus Next Terminal', category: 'Terminal', key: 'ctrl+shift+]', inTerminal: true, run: termCmds.next },
    { id: 'workbench.action.terminal.focusPrevious', title: 'Focus Previous Terminal', category: 'Terminal', key: 'ctrl+shift+[', inTerminal: true, run: termCmds.prev },
    { id: 'workbench.action.terminal.clear', title: 'Clear', category: 'Terminal', key: 'ctrl+shift+k', inTerminal: true, when: () => document.activeElement?.closest?.('.xterm'), run: termCmds.clear },
    { id: 'workbench.action.terminal.kill', title: 'Kill the Active Terminal Instance', category: 'Terminal', run: termCmds.kill },
    { id: 'workbench.action.terminal.killAll', title: 'Kill All Terminals', category: 'Terminal', run: termCmds.killAll },
    { id: 'workbench.action.terminal.rename', title: 'Rename', category: 'Terminal', run: termCmds.rename },
    { id: 'workbench.action.terminal.selectAll', title: 'Select All', category: 'Terminal', run: termCmds.selectAll },
    { id: 'workbench.action.terminal.runSelectedText', title: 'Run Selected Text In Active Terminal', category: 'Terminal', run: () => termCmds.runSelected(editorText()) },
    { id: 'workbench.action.terminal.openNativeConsole', title: 'Open in Integrated Terminal at Active File', category: 'Terminal', run: () => panel.createTerminal({ cwd: editors.activeDoc()?.path ? dirname(editors.activeDoc().path) : workspace.root }) },
    { id: 'workbench.action.runActiveFile', title: 'Run Active File in Terminal', category: 'Run', key: ['f5', 'ctrl+f5'], run: () => runActiveFile() },
    { id: 'workbench.action.tasks.runTask', title: 'Run Task', category: 'Tasks', key: 'ctrl+shift+b', inTerminal: true, run: () => runTask() },

    // ---- git ----
    { id: 'git.commit', title: 'Commit', category: 'Git', run: () => gitMod.commit() },
    { id: 'git.commitAll', title: 'Commit All', category: 'Git', run: () => gitMod.commit({ all: true }) },
    { id: 'git.commitAmend', title: 'Commit (Amend)', category: 'Git', run: () => gitMod.commit({ amend: true }) },
    { id: 'git.undoCommit', title: 'Undo Last Commit', category: 'Git', run: () => gitMod.undoLastCommit() },
    { id: 'git.stageAll', title: 'Stage All Changes', category: 'Git', run: () => gitMod.stage(gitMod.git.files) },
    { id: 'git.stage', title: 'Stage Changes (Active File)', category: 'Git', run: () => { const p = editors.activeDoc()?.path; const f = gitMod.git.files.find((x) => x.path === p); if (f) gitMod.stage([f]); } },
    { id: 'git.unstageAll', title: 'Unstage All Changes', category: 'Git', run: () => gitMod.unstage(gitMod.git.files) },
    { id: 'git.cleanAll', title: 'Discard All Changes', category: 'Git', run: () => gitMod.discard(gitMod.git.files) },
    { id: 'git.pull', title: 'Pull', category: 'Git', run: () => gitMod.pull() },
    { id: 'git.push', title: 'Push', category: 'Git', run: () => gitMod.push() },
    { id: 'git.fetch', title: 'Fetch', category: 'Git', run: () => gitMod.fetch() },
    { id: 'git.sync', title: 'Sync', category: 'Git', run: () => gitMod.sync() },
    { id: 'git.checkout', title: 'Checkout to...', category: 'Git', run: () => gitMod.checkout() },
    { id: 'git.branch', title: 'Create Branch...', category: 'Git', run: () => gitMod.createBranch() },
    { id: 'git.deleteBranch', title: 'Delete Branch...', category: 'Git', run: () => gitMod.deleteBranch() },
    { id: 'git.merge', title: 'Merge Branch...', category: 'Git', run: () => gitMod.mergeBranch() },
    { id: 'git.stash', title: 'Stash', category: 'Git', run: () => gitMod.stash(false) },
    { id: 'git.stashPop', title: 'Pop Latest Stash', category: 'Git', run: () => gitMod.stash(true) },
    { id: 'git.init', title: 'Initialize Repository', category: 'Git', run: () => gitMod.init() },
    { id: 'git.clone', title: 'Clone', category: 'Git', run: () => gitMod.clone() },
    { id: 'git.refresh', title: 'Refresh', category: 'Git', run: () => { gitMod.refresh(); gitMod.refreshLog(); } },
    { id: 'git.openChange', title: 'Open Changes', category: 'Git', run: (p) => gitMod.openChange(p || editors.activeDoc()?.path) },
    { id: 'git.showOutput', title: 'Show Git Output', category: 'Git', run: () => panel.showOutput('Git') },

    // ---- preferences ----
    { id: 'workbench.action.openSettings', title: 'Open Settings (UI)', category: 'Preferences', key: 'ctrl+,', inTerminal: true, run: () => openSettings() },
    { id: 'workbench.action.openSettingsJson', title: 'Open User Settings (JSON)', category: 'Preferences', run: () => editors.openFile(env.storePaths.settings, { pinned: true, noRecent: true }) },
    { id: 'workbench.action.openGlobalKeybindings', title: 'Open Keyboard Shortcuts', category: 'Preferences', key: 'ctrl+k ctrl+s', inTerminal: true, run: () => openKeybindings() },
    { id: 'workbench.action.openGlobalKeybindingsFile', title: 'Open Keyboard Shortcuts (JSON)', category: 'Preferences', run: () => editors.openFile(env.storePaths.keybindings, { pinned: true, noRecent: true }) },
    { id: 'workbench.action.selectTheme', title: 'Color Theme', category: 'Preferences', key: 'ctrl+k ctrl+t', inTerminal: true, run: () => selectTheme() },
    { id: 'workbench.action.toggleLightDarkThemes', title: 'Toggle between Light/Dark Themes', category: 'Preferences', run: () => settings.set('workbench.colorTheme', currentTheme().type === 'light' ? 'snake-dark' : 'snake-light') },

    // ---- window / help ----
    { id: 'workbench.action.newWindow', title: 'New Window', category: 'Window', key: 'ctrl+shift+n', inTerminal: true, run: () => window.snake.win.newWindow() },
    { id: 'workbench.action.closeWindow', title: 'Close Window', category: 'Window', key: 'alt+f4', inTerminal: true, run: () => window.snake.win.close() },
    { id: 'workbench.action.quit', title: 'Quit', category: 'Window', key: 'ctrl+q', inTerminal: true, run: () => window.snake.quit() },
    { id: 'workbench.action.reloadWindow', title: 'Reload Window', category: 'Developer', key: 'ctrl+shift+f5', run: async () => { await persistSession(true); window.snake.win.reload(); } },
    { id: 'workbench.action.toggleDevTools', title: 'Toggle Developer Tools', category: 'Developer', key: 'ctrl+shift+alt+i', inTerminal: true, run: () => window.snake.win.toggleDevTools() },
    { id: 'workbench.action.openWelcome', title: 'Welcome', category: 'Help', run: () => openWelcome() },
    { id: 'workbench.action.showAboutDialog', title: 'About', category: 'Help', run: () => showAbout() },
  ]);
}

function gotoChange(dir) {
  const g = editors.getActiveGroup();
  const ed = editors.activeCodeEditor();
  const hunks = g?.gitHunks || [];
  if (!ed || !hunks.length) return;
  const line = ed.getPosition().lineNumber;
  const starts = hunks.map((h) => Math.max(1, h.modStart + (h.modLen ? 1 : 0)));
  let target = dir > 0 ? starts.find((s) => s > line) ?? starts[0] : [...starts].reverse().find((s) => s < line) ?? starts[starts.length - 1];
  ed.setPosition({ lineNumber: target, column: 1 });
  ed.revealLineInCenter(target);
  ed.focus();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
let booted = false;

async function boot() {
  Object.assign(env, await window.snake.init());
  setSep(env.sep);
  document.body.classList.add(`platform-${env.platform}`);
  await Promise.all([settings.loadSettings(), loadState()]);
  setUserKeybindings(await window.snake.store.get('keybindings'));
  configureLanguages();
  applyTheme(settings.get('workbench.colorTheme'));
  zoom = getState().zoom ?? settings.get('window.zoomLevel') ?? 0;
  setZoom(zoom);

  initTitlebar();
  initSidebar();
  editors.initEditors();
  panel.initPanel();
  initStatusbar();
  initLayout();
  gitMod.initGit();
  registerAllCommands();
  installKeyDispatcher();
  showView('explorer', { focus: false });

  settings.onChange(['workbench.colorTheme'], () => applyTheme(settings.get('workbench.colorTheme')));
  settings.onChange(['window.zoomLevel'], () => setZoom(settings.get('window.zoomLevel')));

  // user settings.json / keybindings.json edited inside the app
  bus.on('userfile:saved', async (path) => {
    if (path === env.storePaths.settings) {
      settings.setUserSettings(await window.snake.store.get('settings'));
      notify({ message: 'Settings reloaded.', timeout: 1500, transient: true });
    } else if (path === env.storePaths.keybindings) {
      setUserKeybindings(await window.snake.store.get('keybindings'));
      notify({ message: 'Keybindings reloaded.', timeout: 1500, transient: true });
    }
  });

  // file system change notifications from the main process
  window.snake.fs.onChanged(({ dir, paths }) => {
    bus.emit('fs:dirChanged', { dir, paths });
    bus.emit('fs:changed', paths);
    invalidateFileList();
  });

  bus.on('workspace:openFolderRequest', (p) => openFolder(p));
  bus.on('activity:manage', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    showMenu([
      { label: 'Command Palette...', key: 'ctrl+shift+p', run: () => executeCommand('workbench.action.showCommands') },
      { separator: true },
      { label: 'Settings', key: 'ctrl+,', run: () => openSettings() },
      { label: 'Keyboard Shortcuts', key: 'ctrl+k ctrl+s', run: () => openKeybindings() },
      { label: 'Themes', submenu: () => themes.map((t) => ({ label: t.label, checked: t.id === currentTheme().id, run: () => settings.set('workbench.colorTheme', t.id) })) },
      { separator: true },
      { label: 'About', run: () => showAbout() },
    ], { x: r.right + 4, y: r.bottom - 190 });
  });
  bus.on('activity:accounts', (e) => {
    const r = e.currentTarget.getBoundingClientRect();
    showMenu([{ label: "Snake's Code runs fully locally — no account needed 🐍", disabled: true }, { label: 'Configure Git Identity...', run: configureGitIdentity }], { x: r.right + 4, y: r.bottom - 70 });
  });

  bus.on('editors:changed', persistSessionSoon);
  bus.on('editor:activeChanged', persistSessionSoon);
  bus.on('sidebar:viewChanged', persistSessionSoon);

  // closing the window: hot-exit or confirm unsaved changes
  window.snake.onBeforeClose(async () => {
    if (!settings.get('files.hotExit') && !(await confirmDirty())) return;
    await persistSession(true);
    window.snake.win.forceClose();
  });

  // drag files/folders from the OS anywhere onto the window
  document.addEventListener('dragover', (e) => { if ([...e.dataTransfer.types].includes('Files')) e.preventDefault(); });
  document.addEventListener('drop', async (e) => {
    if (e.defaultPrevented || !e.dataTransfer.files.length) return;
    e.preventDefault();
    for (const f of e.dataTransfer.files) {
      const p = window.snake.fs.pathForFile(f);
      if (p) await openPath(p);
    }
  });

  // initial content
  const initialPath = env.openPath;
  const st = getState();
  let root = null;
  let fileToOpen = null;
  if (initialPath) {
    const s = await window.snake.fs.stat(initialPath);
    if (s.isDir) root = initialPath;
    else { fileToOpen = initialPath; root = env.isFirstWindow && settings.get('workbench.restoreSession') ? st.lastRoot : null; }
  } else if (env.isFirstWindow && settings.get('workbench.restoreSession') && st.lastRoot) {
    const s = await window.snake.fs.stat(st.lastRoot);
    if (s.exists && s.isDir) root = st.lastRoot;
  }
  setRoot(root);
  booted = false;
  await restoreSession(root);
  booted = true;
  if (fileToOpen) await editors.openFile(fileToOpen, { pinned: true });
  editors.updateTitle();
  document.getElementById('workbench').classList.add('ready');
  setInterval(() => persistSession(), 30000);
}

async function configureGitIdentity() {
  const cwd = workspace.root || env.homeDir;
  const name = (await window.snake.git.run(cwd, ['config', '--global', 'user.name'])).stdout.trim();
  const email = (await window.snake.git.run(cwd, ['config', '--global', 'user.email'])).stdout.trim();
  const n = await inputBox({ prompt: 'Git user.name (global)', value: name });
  if (n == null) return;
  const m = await inputBox({ prompt: 'Git user.email (global)', value: email });
  if (m == null) return;
  await window.snake.git.run(cwd, ['config', '--global', 'user.name', n]);
  await window.snake.git.run(cwd, ['config', '--global', 'user.email', m]);
  notify({ type: 'success', message: 'Git identity updated.', timeout: 2000 });
}

// keep the most recent errors around for diagnostics (Developer Tools: snakeApp.errors)
const recentErrors = [];
const recordError = (what, err) => { recentErrors.push(`${what}: ${err?.stack || err}`); if (recentErrors.length > 50) recentErrors.shift(); };
window.addEventListener('error', (e) => { recordError('error', e.error || e.message); console.error('Unhandled error', e.error || e.message); });
window.addEventListener('unhandledrejection', (e) => { recordError('rejection', e.reason); console.error('Unhandled rejection', e.reason); });

boot().catch((err) => {
  console.error(err);
  document.body.append(el('pre.boot-error', {}, `Snake's Code failed to start:\n\n${err.stack || err}`));
});

// handy for debugging from DevTools
window.snakeApp = { editors, settings, monaco, executeCommand, getCommand, workspace, isInside, errors: recentErrors };
