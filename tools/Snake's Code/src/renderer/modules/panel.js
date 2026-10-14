// Bottom panel: Problems, Output, Terminal (xterm.js + node-pty).
import * as monaco from 'monaco-editor';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import '@xterm/xterm/css/xterm.css';
import { el, icon, bus, basename, dirname, relative, makeSash, debounce } from './util.js';
import * as settings from './settings.js';
import { workspace, env } from './workspace.js';
import { currentTheme } from './themes.js';
import { contextMenu, notify, pick, inputBox } from './ui.js';
import { openFile, layoutEditors } from './editors.js';
import { fileIcon } from './icons.js';
import { keyLabelFor } from './commands.js';

const tabs = new Map(); // id -> { id, title, tab, body, onShow, actions }
let activeTab = null;
let panelVisible = false;
let maximized = false;
let panelHeight = 280;

export function initPanel() {
  const panel = document.getElementById('panel');
  const header = el('div.panel-header');
  const tabStrip = el('div.panel-tabs');
  const actions = el('div.panel-actions');
  const bodies = el('div.panel-bodies');
  header.append(tabStrip, actions);
  panel.append(header, bodies);

  const add = (id, title, build, command) => {
    const badge = el('span.panel-badge');
    const tab = el('div.panel-tab', { dataset: { tab: id } }, el('span', {}, title), badge);
    tab.addEventListener('click', () => showPanel(id));
    tab.addEventListener('mouseenter', () => (tab.title = `${title}${command && keyLabelFor(command) ? ` (${keyLabelFor(command)})` : ''}`));
    const body = el('div.panel-body', { dataset: { tab: id } });
    body.style.display = 'none';
    tabStrip.append(tab);
    bodies.append(body);
    const inst = build(body) || {};
    tabs.set(id, { id, title, tab, body, badge, ...inst });
  };
  add('problems', 'PROBLEMS', buildProblems, 'workbench.actions.view.problems');
  add('output', 'OUTPUT', buildOutput, 'workbench.action.output.show');
  add('terminal', 'TERMINAL', buildTerminal, 'workbench.action.terminal.toggleTerminal');

  const renderActions = () => {
    actions.replaceChildren();
    const t = tabs.get(activeTab);
    for (const a of t?.actions?.() || []) {
      if (a.el) { actions.append(a.el); continue; }
      actions.append(el('span.action-btn', { title: a.title, onclick: (e) => a.run(e) }, icon(a.icon)));
    }
    actions.append(el('span.action-sep'));
    actions.append(el('span.action-btn', { title: maximized ? 'Restore Panel Size' : 'Maximize Panel Size', onclick: () => toggleMaximized() }, icon(maximized ? 'chevron-down' : 'chevron-up')));
    actions.append(el('span.action-btn', { title: 'Hide Panel (Ctrl+J)', onclick: () => setPanelVisible(false) }, icon('close')));
  };
  bus.on('panel:actionsChanged', renderActions);
  bus.on('panel:shown', renderActions);

  const sash = document.getElementById('panel-sash');
  makeSash(sash, {
    cursor: 'ns-resize',
    onStart: () => ({ h: panel.offsetHeight }),
    onDrag: (_dx, dy, c) => {
      const max = document.getElementById('center').offsetHeight - 80;
      panelHeight = Math.max(80, Math.min(max, c.h - dy));
      maximized = false;
      panel.style.height = panelHeight + 'px';
      layoutAll();
    },
    onEnd: () => bus.emit('layout:persist'),
  });
  sash.addEventListener('dblclick', () => toggleMaximized());
  panel.style.height = panelHeight + 'px';
  setPanelVisible(false);
}

function layoutAll() {
  layoutEditors();
  tabs.get(activeTab)?.layout?.();
}
const layoutSoon = debounce(layoutAll, 16);

export function showPanel(id, { focus = true } = {}) {
  const t = tabs.get(id);
  if (!t) return;
  for (const x of tabs.values()) {
    x.tab.classList.toggle('active', x.id === id);
    x.body.style.display = x.id === id ? '' : 'none';
  }
  activeTab = id;
  setPanelVisible(true);
  t.onShow?.();
  if (focus) setTimeout(() => t.focus?.(), 0);
  bus.emit('panel:shown', id);
}

export function setPanelVisible(v) {
  panelVisible = v;
  document.getElementById('workbench').classList.toggle('panel-hidden', !v);
  if (v && !activeTab) { showPanel('terminal'); return; }
  if (v) tabs.get(activeTab)?.onShow?.();
  requestAnimationFrame(layoutAll);
  bus.emit('layout:changed');
  bus.emit('layout:persist');
}

export function isPanelVisible() {
  return panelVisible;
}
export function activePanel() {
  return panelVisible ? activeTab : null;
}

export function togglePanel() {
  setPanelVisible(!panelVisible);
  if (panelVisible) tabs.get(activeTab)?.focus?.();
}

export function toggleMaximized() {
  const panel = document.getElementById('panel');
  maximized = !maximized;
  if (!panelVisible) setPanelVisible(true);
  panel.style.height = maximized ? document.getElementById('center').offsetHeight - 40 + 'px' : panelHeight + 'px';
  bus.emit('panel:actionsChanged');
  requestAnimationFrame(layoutAll);
}

export function getPanelLayout() {
  return { height: panelHeight, visible: panelVisible, tab: activeTab };
}
export function restorePanelLayout(l) {
  if (!l) return;
  panelHeight = l.height || panelHeight;
  document.getElementById('panel').style.height = panelHeight + 'px';
  if (l.tab) activeTab = l.tab;
  if (l.visible) showPanel(l.tab || 'terminal', { focus: false });
}

new ResizeObserver(layoutSoon).observe(document.body);

// ===========================================================================
// Problems
// ===========================================================================
let problemCounts = { errors: 0, warnings: 0, infos: 0 };
export function getProblemCounts() {
  return problemCounts;
}

function buildProblems(body) {
  const filter = el('input.panel-filter', { placeholder: 'Filter (e.g. text, **/*.ts, !**/node_modules/**)', spellcheck: 'false' });
  const list = el('div.problems-list', { tabindex: '0' });
  body.append(list);
  body.classList.add('problems');
  const collapsed = new Set();
  const render = () => {
    const markers = monaco.editor.getModelMarkers({}).filter((m) => m.severity >= monaco.MarkerSeverity.Info || m.severity === monaco.MarkerSeverity.Hint && false);
    const q = filter.value.trim().toLowerCase();
    const byRes = new Map();
    let errors = 0, warnings = 0, infos = 0;
    for (const m of markers) {
      if (m.severity === monaco.MarkerSeverity.Error) errors++;
      else if (m.severity === monaco.MarkerSeverity.Warning) warnings++;
      else infos++;
      const key = m.resource.toString();
      if (q && !m.message.toLowerCase().includes(q) && !key.toLowerCase().includes(q)) continue;
      if (!byRes.has(key)) byRes.set(key, []);
      byRes.get(key).push(m);
    }
    problemCounts = { errors, warnings, infos };
    bus.emit('problems:changed', problemCounts);
    const total = errors + warnings + infos;
    const t = tabs.get('problems');
    if (t) { t.badge.textContent = total ? String(total) : ''; t.badge.style.display = total ? '' : 'none'; }
    const frag = document.createDocumentFragment();
    for (const [key, ms] of byRes) {
      const uri = monaco.Uri.parse(key);
      const path = uri.scheme === 'file' ? uri.fsPath : uri.path.slice(1);
      const name = basename(path);
      const isCol = collapsed.has(key);
      const head = el('div.problem-file.list-row', {}, icon(isCol ? 'chevron-right' : 'chevron-down', 'twistie'), fileIcon(name), el('span.problem-name', {}, name), el('span.problem-dir', {}, workspace.root ? relative(workspace.root, dirname(path)) : dirname(path)), el('span.badge', {}, String(ms.length)));
      head.addEventListener('click', () => { isCol ? collapsed.delete(key) : collapsed.add(key); render(); });
      frag.append(head);
      if (isCol) continue;
      ms.sort((a, b) => b.severity - a.severity || a.startLineNumber - b.startLineNumber);
      for (const m of ms) {
        const sev = m.severity === monaco.MarkerSeverity.Error ? 'error' : m.severity === monaco.MarkerSeverity.Warning ? 'warning' : 'info';
        const row = el('div.problem.list-row', { title: m.message }, icon(sev, `sev-${sev}`), el('span.problem-msg', {}, m.message), el('span.problem-src', {}, `${m.source || m.owner || ''}${m.code ? `(${typeof m.code === 'object' ? m.code.value : m.code})` : ''}`), el('span.problem-pos', {}, `[Ln ${m.startLineNumber}, Col ${m.startColumn}]`));
        row.addEventListener('click', () => {
          if (uri.scheme === 'file') openFile(path, { pinned: true, selection: { startLineNumber: m.startLineNumber, startColumn: m.startColumn, endLineNumber: m.endLineNumber, endColumn: m.endColumn } });
        });
        row.addEventListener('contextmenu', (e) => contextMenu(e, [{ label: 'Copy', run: () => window.snake.clipboard.write(`${path}:${m.startLineNumber}:${m.startColumn}: ${m.message}`) }, { label: 'Copy Message', run: () => window.snake.clipboard.write(m.message) }]));
        frag.append(row);
      }
    }
    list.replaceChildren(frag);
    if (!byRes.size) list.append(el('div.panel-empty', {}, q ? 'No results found with provided filter criteria.' : 'No problems have been detected in the workspace.'));
  };
  const renderSoon = debounce(render, 250);
  monaco.editor.onDidChangeMarkers(renderSoon);
  filter.addEventListener('input', renderSoon);
  render();
  return {
    actions: () => [
      { el: filter },
      { icon: 'collapse-all', title: 'Collapse All', run: () => { for (const m of monaco.editor.getModelMarkers({})) collapsed.add(m.resource.toString()); render(); } },
    ],
    focus: () => list.focus(),
  };
}

// ===========================================================================
// Output
// ===========================================================================
const channels = new Map([['Snake\'s Code', '']]);
let currentChannel = 'Snake\'s Code';
let outputEditor = null;
let outputModel = null;

export function appendOutput(channel, text) {
  const cur = channels.get(channel) || '';
  const next = (cur + text + (text.endsWith('\n') ? '' : '\n')).slice(-500000);
  channels.set(channel, next);
  if (channel === currentChannel && outputModel) {
    outputModel.setValue(next);
    outputEditor?.revealLine(outputModel.getLineCount());
  }
  bus.emit('panel:actionsChanged');
}
bus.on('output:append', appendOutput);

function buildOutput(body) {
  body.classList.add('output');
  const host = el('div.output-host');
  body.append(host);
  const select = el('select.panel-select');
  const fillSelect = () => {
    select.replaceChildren(...[...channels.keys()].map((c) => el('option', { value: c, selected: c === currentChannel }, c)));
  };
  select.addEventListener('change', () => {
    currentChannel = select.value;
    outputModel?.setValue(channels.get(currentChannel) || '');
  });
  const ensure = () => {
    if (outputEditor) return;
    outputModel = monaco.editor.createModel(channels.get(currentChannel) || '', 'log');
    outputEditor = monaco.editor.create(host, {
      model: outputModel, readOnly: true, minimap: { enabled: false }, lineNumbers: 'off', glyphMargin: false, folding: false, wordWrap: 'on',
      scrollBeyondLastLine: false, renderLineHighlight: 'none', fontSize: settings.get('terminal.integrated.fontSize'), fontFamily: settings.get('editor.fontFamily'),
      automaticLayout: false, contextmenu: true, padding: { top: 4 }, scrollbar: { verticalScrollbarSize: 10 },
    });
  };
  return {
    onShow: () => { ensure(); outputModel.setValue(channels.get(currentChannel) || ''); requestAnimationFrame(() => outputEditor.layout()); },
    layout: () => outputEditor?.layout(),
    actions: () => { fillSelect(); return [{ el: select }, { icon: 'clear-all', title: 'Clear Output', run: () => { channels.set(currentChannel, ''); outputModel?.setValue(''); } }]; },
    focus: () => outputEditor?.focus(),
  };
}

export function showOutput(channel) {
  if (channel && channels.has(channel)) currentChannel = channel;
  else if (!channel && channels.has('Git')) currentChannel = 'Git';
  showPanel('output');
}

// ===========================================================================
// Terminal
// ===========================================================================
const terminals = []; // { id, term, fit, host, title, cwd, exited }
let activeTerm = null;
let termListEl;
let termHostEl;
let termCounter = 0;

function terminalTheme() {
  return currentTheme().terminal;
}

function terminalOptions() {
  return {
    fontSize: settings.get('terminal.integrated.fontSize'),
    fontFamily: settings.get('terminal.integrated.fontFamily') || settings.get('editor.fontFamily'),
    cursorStyle: settings.get('terminal.integrated.cursorStyle'),
    cursorBlink: settings.get('terminal.integrated.cursorBlinking'),
    scrollback: settings.get('terminal.integrated.scrollback'),
    theme: terminalTheme(),
    allowProposedApi: true,
    macOptionIsMeta: true,
    rightClickSelectsWord: false,
    drawBoldTextInBrightColors: true,
    lineHeight: 1.15,
  };
}

bus.on('theme:changed', () => { for (const t of terminals) t.term.options.theme = terminalTheme(); });
settings.onChange(['terminal.integrated.', 'editor.fontFamily'], () => {
  const o = terminalOptions();
  for (const t of terminals) {
    for (const k of ['fontSize', 'fontFamily', 'cursorStyle', 'cursorBlink', 'scrollback']) t.term.options[k] = o[k];
    t.fit.fit();
  }
});

window.snake.pty.onData((id, data) => terminals.find((t) => t.id === id)?.term.write(data));
window.snake.pty.onExit((id, code) => {
  const t = terminals.find((x) => x.id === id);
  if (!t) return;
  t.exited = true;
  t.term.write(`\r\n\x1b[90m[Process exited with code ${code}. Press any key to close the terminal.]\x1b[0m\r\n`);
  renderTermList();
});

function buildTerminal(body) {
  body.classList.add('terminal-panel');
  termHostEl = el('div.term-hosts');
  termListEl = el('div.term-list');
  body.append(termHostEl, termListEl);
  return {
    onShow: () => {
      if (!terminals.length) createTerminal();
      else requestAnimationFrame(() => activeTerm?.fit.fit());
    },
    layout: () => { try { activeTerm?.fit.fit(); } catch {} },
    actions: () => [
      { icon: 'add', title: `New Terminal (${keyLabelFor('workbench.action.terminal.new')})`, run: () => createTerminal() },
      { icon: 'chevron-down', title: 'Launch Profile...', run: (e) => launchProfile(e) },
      { icon: 'split-horizontal', title: 'Split Terminal (new tab in same folder)', run: () => createTerminal({ cwdFrom: activeTerm }) },
      { icon: 'trash', title: 'Kill Terminal', run: () => activeTerm && killTerminal(activeTerm) },
    ],
    focus: () => activeTerm?.term.focus(),
  };
}

async function launchProfile() {
  const shells = ['bash', 'zsh', 'fish', 'sh', 'nu', 'pwsh', 'python3', 'node'];
  const found = [];
  for (const s of shells) {
    const r = await window.snake.exec('which', [s]);
    if (r.code === 0 && r.stdout.trim()) found.push({ label: s, description: r.stdout.trim(), icon: 'terminal' });
  }
  const c = await pick(found, { placeholder: 'Select the terminal profile to create' });
  if (c) createTerminal({ shell: c.description, title: c.label });
}

export async function createTerminal(opts = {}) {
  if (!env.ptyAvailable) {
    notify({ type: 'error', message: 'The terminal backend (node-pty) failed to load. Run `npm run rebuild` and restart.' });
    return null;
  }
  const host = el('div.term-host');
  termHostEl.append(host);
  const term = new Terminal(terminalOptions());
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon((e, uri) => window.snake.shell.openExternal(uri)));
  term.open(host);
  const t = { id: null, term, fit, host, title: opts.title || null, exited: false, num: ++termCounter };
  terminals.push(t);
  setActiveTerminal(t);
  showPanel('terminal', { focus: false });
  try { fit.fit(); } catch {}
  let cwd = opts.cwd || workspace.root || env.homeDir;
  if (opts.cwdFrom?.id) cwd = (await window.snake.pty.cwd(opts.cwdFrom.id)) || cwd;
  try {
    const res = await window.snake.pty.create({ cwd, cols: term.cols, rows: term.rows, shell: opts.shell || settings.get('terminal.integrated.shell') || undefined });
    t.id = res.id;
    t.shell = res.shell;
    t.title ||= res.shell;
  } catch (err) {
    term.write(`\x1b[31mFailed to start terminal: ${err.message}\x1b[0m\r\n`);
    return t;
  }
  term.onData((d) => {
    if (t.exited) { killTerminal(t); return; }
    window.snake.pty.write(t.id, d);
  });
  term.onResize(({ cols, rows }) => t.id && window.snake.pty.resize(t.id, cols, rows));
  term.onTitleChange((title) => { t.dynamicTitle = title; renderTermList(); });
  term.onSelectionChange(() => {
    if (settings.get('terminal.integrated.copyOnSelection') && term.hasSelection()) window.snake.clipboard.write(term.getSelection());
  });
  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown') return true;
    const k = e.key.toLowerCase();
    if (e.ctrlKey && e.shiftKey && k === 'c') { if (term.hasSelection()) window.snake.clipboard.write(term.getSelection()); return false; }
    if (e.ctrlKey && e.shiftKey && k === 'v') { window.snake.clipboard.read().then((txt) => window.snake.pty.write(t.id, txt)); return false; }
    if (e.ctrlKey && !e.shiftKey && k === 'c' && term.hasSelection()) { window.snake.clipboard.write(term.getSelection()); term.clearSelection(); return false; }
    if (e.ctrlKey && !e.shiftKey && k === 'v') { window.snake.clipboard.read().then((txt) => window.snake.pty.write(t.id, txt)); e.preventDefault(); return false; }
    return true;
  });
  host.addEventListener('contextmenu', (e) =>
    contextMenu(e, [
      { label: 'Copy', key: 'ctrl+shift+c', disabled: !term.hasSelection(), run: () => window.snake.clipboard.write(term.getSelection()) },
      { label: 'Paste', key: 'ctrl+shift+v', run: async () => window.snake.pty.write(t.id, await window.snake.clipboard.read()) },
      { label: 'Select All', run: () => term.selectAll() },
      { separator: true },
      { label: 'Clear', run: () => term.clear() },
      { label: 'Rename...', run: () => renameTerminal(t) },
      { label: 'Kill Terminal', run: () => killTerminal(t) },
    ]),
  );
  renderTermList();
  requestAnimationFrame(() => { try { fit.fit(); } catch {} term.focus(); });
  return t;
}

function setActiveTerminal(t) {
  activeTerm = t;
  for (const x of terminals) x.host.style.display = x === t ? '' : 'none';
  renderTermList();
  requestAnimationFrame(() => { try { t?.fit.fit(); } catch {} });
}

async function renameTerminal(t) {
  const name = await inputBox({ prompt: 'Terminal name', value: t.title || '' });
  if (name) { t.title = name; t.userTitle = true; renderTermList(); }
}

export function killTerminal(t) {
  const i = terminals.indexOf(t);
  if (i < 0) return;
  if (t.id && !t.exited) window.snake.pty.kill(t.id);
  t.term.dispose();
  t.host.remove();
  terminals.splice(i, 1);
  if (activeTerm === t) setActiveTerminal(terminals[Math.min(i, terminals.length - 1)] || null);
  renderTermList();
  if (!terminals.length) setPanelVisible(false);
}

function renderTermList() {
  if (!termListEl) return;
  termListEl.style.display = terminals.length > 1 ? '' : 'none';
  termListEl.replaceChildren(
    ...terminals.map((t) => {
      const label = t.userTitle ? t.title : t.title || 'terminal';
      const row = el('div.term-item' + (t === activeTerm ? '.active' : '') + (t.exited ? '.exited' : ''), { title: t.dynamicTitle || label }, icon('terminal'), el('span', {}, label));
      const kill = el('span.action-btn', { title: 'Kill Terminal', onclick: (e) => { e.stopPropagation(); killTerminal(t); } }, icon('trash'));
      row.append(kill);
      row.addEventListener('click', () => { setActiveTerminal(t); t.term.focus(); });
      row.addEventListener('dblclick', () => renameTerminal(t));
      return row;
    }),
  );
  bus.emit('panel:actionsChanged');
}

export async function toggleTerminal() {
  if (panelVisible && activeTab === 'terminal') {
    if (activeTerm && document.activeElement?.closest?.('.xterm')) setPanelVisible(false);
    else activeTerm?.term.focus();
    return;
  }
  showPanel('terminal');
}

/** Send text (a command) to the active terminal, creating one if needed. */
export async function runInTerminal(text, { newTerminal = false, cwd, title } = {}) {
  let t = !newTerminal ? activeTerm : null;
  if (t?.exited) t = null;
  if (!t) t = await createTerminal({ cwd, title });
  if (!t?.id) return;
  showPanel('terminal', { focus: false });
  setActiveTerminal(t);
  window.snake.pty.write(t.id, text + '\r');
  t.term.focus();
}

export function terminalCommands() {
  return {
    next: () => { const i = terminals.indexOf(activeTerm); const n = terminals[(i + 1) % terminals.length]; if (n) { setActiveTerminal(n); n.term.focus(); } },
    prev: () => { const i = terminals.indexOf(activeTerm); const n = terminals[(i - 1 + terminals.length) % terminals.length]; if (n) { setActiveTerminal(n); n.term.focus(); } },
    clear: () => activeTerm?.term.clear(),
    kill: () => activeTerm && killTerminal(activeTerm),
    killAll: () => [...terminals].forEach(killTerminal),
    rename: () => activeTerm && renameTerminal(activeTerm),
    scrollUp: () => activeTerm?.term.scrollLines(-1),
    scrollDown: () => activeTerm?.term.scrollLines(1),
    selectAll: () => activeTerm?.term.selectAll(),
    runSelected: (text) => text && runInTerminal(text),
  };
}
