// Command palette & quick open with prefix modes: files, >commands, :line, @symbols, ?help.
import { bus, basename, dirname, relative, join, fuzzyMatch, isInside } from './util.js';
import { quickInput } from './ui.js';
import { allCommands, executeCommand, keybindingFor } from './commands.js';
import { workspace, listWorkspaceFiles, getState } from './workspace.js';
import { openFile, activeCodeEditor, getGroups, runEditorAction, setActiveGroup } from './editors.js';
import { fileIcon } from './icons.js';
import * as settings from './settings.js';
import { workspaceSymbols, hasWorkspaceSymbols } from './lsp.js';

const recentCommands = [];
bus.on('command:executed', (id) => {
  if (['workbench.action.showCommands', 'workbench.action.quickOpen'].includes(id)) return;
  const i = recentCommands.indexOf(id);
  if (i >= 0) recentCommands.splice(i, 1);
  recentCommands.unshift(id);
  if (recentCommands.length > 30) recentCommands.pop();
});

const PREFIXES = [
  { prefix: '>', label: 'Show and Run Commands', key: 'workbench.action.showCommands' },
  { prefix: ':', label: 'Go to Line/Column', key: 'workbench.action.gotoLine' },
  { prefix: '@', label: 'Go to Symbol in Editor', key: 'workbench.action.gotoSymbol' },
  { prefix: '#', label: 'Go to Symbol in Workspace (or search for text in files)', key: 'workbench.action.showAllSymbols' },
  { prefix: 'term ', label: 'Show All Opened Terminals', key: null },
  { prefix: 'edt ', label: 'Show All Opened Editors', key: 'workbench.action.showAllEditors' },
  { prefix: '?', label: 'Help', key: null },
];

export function openQuickOpen(initial = '') {
  let mode = null;
  let fileItemsToken = 0;
  quickInput.open({
    placeholder: "Search files by name (append : to go to line or @ to go to symbol)",
    value: initial,
    items: [],
    filter: false,
    sort: false,
    reserveIcon: true,
    onChange: (value, qi) => {
      const m = detectMode(value);
      if (m !== mode) { mode = m; qi.box.dataset.mode = m; }
      if (m === 'commands') commandsMode(value.slice(1), qi);
      else if (m === 'line') lineMode(value.slice(1), qi);
      else if (m === 'symbol') {
        qi.close(false);
        runEditorAction('editor.action.quickOutline');
      } else if (m === 'help') helpMode(qi);
      else if (m === 'search') symbolsMode(value.slice(1), qi, ++fileItemsToken, () => fileItemsToken);
      else if (m === 'editors') editorsMode(value.slice(4), qi);
      else if (m === 'term') {
        qi.setItems([{ label: 'Create New Terminal', icon: 'add', run: () => executeCommand('workbench.action.terminal.new') }, { label: 'Toggle Terminal', icon: 'terminal', run: () => executeCommand('workbench.action.terminal.toggleTerminal') }]);
      } else filesMode(value, qi, ++fileItemsToken, () => fileItemsToken);
    },
    onAccept: (item, value, qi) => {
      if (!item) return;
      if (item.prefix) { qi.input.value = item.prefix; qi.onInput(); return true; }
      if (item.run) { setTimeout(() => item.run(value), 0); return; }
    },
  });
}

function detectMode(v) {
  if (v.startsWith('>')) return 'commands';
  if (v.startsWith(':')) return 'line';
  if (v.startsWith('@')) return 'symbol';
  if (v.startsWith('?')) return 'help';
  if (v.startsWith('#')) return 'search';
  if (v.startsWith('edt ')) return 'editors';
  if (v.startsWith('term ')) return 'term';
  return 'files';
}

function helpMode(qi) {
  qi.setItems(PREFIXES.map((p) => ({ label: p.prefix, description: p.label, prefix: p.prefix, icon: 'question' })));
}

// ---- commands ----
function commandItems() {
  const items = [];
  const seen = new Set();
  for (const c of allCommands()) {
    if (c.when && !c.when()) continue;
    items.push({ id: c.id, label: c.category ? `${c.category}: ${c.title}` : c.title, keybinding: keybindingFor(c.id), run: () => executeCommand(c.id), detailId: c.id });
    seen.add(c.id);
  }
  const ed = activeCodeEditor();
  if (ed) {
    for (const a of ed.getSupportedActions()) {
      if (!a.label || a.id.startsWith('snake.') || seen.has(a.id)) continue;
      items.push({ id: a.id, label: a.label.includes(':') ? a.label : `Editor: ${a.label}`, run: () => { ed.focus(); a.run(); } });
    }
  }
  return items;
}

function commandsMode(q, qi) {
  qi.setPlaceholder('Type the name of a command to run.');
  const all = commandItems();
  const query = q.trim();
  let list;
  if (!query) {
    const recent = recentCommands.map((id) => all.find((x) => x.id === id)).filter(Boolean);
    const rest = all.filter((x) => !recentCommands.includes(x.id)).sort((a, b) => a.label.localeCompare(b.label));
    list = [
      ...recent.map((x, i) => ({ ...x, separator: i === 0 ? 'recently used' : undefined })),
      ...rest.map((x, i) => ({ ...x, separator: i === 0 && recent.length ? 'other commands' : undefined })),
    ];
    qi.setItems(list.map((x) => ({ ...x, labelHtml: undefined })));
    return;
  }
  const scored = [];
  for (const it of all) {
    const m = fuzzyMatch(query, it.label);
    if (m) scored.push({ it, score: m.score + (recentCommands.includes(it.id) ? 15 - recentCommands.indexOf(it.id) * 0.3 : 0), pos: m.positions });
    else {
      // also allow matching all words in any order
      const words = query.toLowerCase().split(/\s+/);
      if (words.every((w) => it.label.toLowerCase().includes(w))) scored.push({ it, score: 1, pos: [] });
    }
  }
  scored.sort((a, b) => b.score - a.score);
  qi.setItems(scored.slice(0, 300).map(({ it, pos }) => ({ ...it, labelHtml: highlightHtml(it.label, pos) })));
}

function highlightHtml(text, positions) {
  const set = new Set(positions);
  let out = '';
  let open = false;
  for (let i = 0; i < text.length; i++) {
    const m = set.has(i);
    if (m && !open) { out += '<span class="hl">'; open = true; }
    if (!m && open) { out += '</span>'; open = false; }
    out += text[i].replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]);
  }
  if (open) out += '</span>';
  return out;
}

// ---- symbols in the project (from the language servers) ----
const SYMBOL_ICONS = ['file', 'module', 'namespace', 'package', 'class', 'method', 'property', 'field', 'constructor', 'enum', 'interface', 'function', 'variable',
  'constant', 'string', 'number', 'boolean', 'array', 'object', 'key', 'null', 'enum-member', 'struct', 'event', 'operator', 'type-parameter'];

async function symbolsMode(q, qi, token, currentToken) {
  const query = q.trim();
  const search = { label: query ? `Search for '${query}' in files` : 'Search for text in files', icon: 'search', run: () => executeCommand('workbench.action.findInFiles', { query }) };
  qi.setItems([search]);
  if (!hasWorkspaceSymbols()) {
    qi.setPlaceholder('Open a file a language server understands to find symbols, or press Enter to search for text.');
    return;
  }
  qi.setPlaceholder('Type the name of a function, class or variable to go to it.');
  if (!query) return;
  await new Promise((r) => setTimeout(r, 150)); // wait for a pause in typing
  if (currentToken() !== token) return;
  const list = await workspaceSymbols(query);
  if (currentToken() !== token) return;
  const root = workspace.root;
  const lower = query.toLowerCase();
  const items = list.map((x) => {
    const m = fuzzyMatch(query, x.name);
    // The project's own symbols first, then names that start with what was typed.
    const own = root && isInside(root, x.path) ? 1000 : 0;
    const prefix = x.name.toLowerCase().startsWith(lower) ? 100 : 0;
    return {
      label: x.name,
      labelHtml: highlightHtml(x.name, m ? m.positions : []),
      description: [x.container, root && isInside(root, x.path) ? relative(root, x.path) : x.path].filter(Boolean).join(' · '),
      icon: `symbol-${SYMBOL_ICONS[x.kind] || 'misc'}`,
      score: own + prefix + (m ? m.score : 0),
      run: () => openFile(x.path, { pinned: true, selection: x.range || undefined }),
    };
  }).sort((a, b) => b.score - a.score).slice(0, 300);
  qi.setItems([...items, search]);
}

// ---- go to line ----
function lineMode(q, qi) {
  const ed = activeCodeEditor();
  if (!ed) { qi.setItems([{ label: 'Open a text editor first to go to a line.', icon: 'info' }]); return; }
  const model = ed.getModel();
  const lines = model.getLineCount();
  const [l, c] = q.split(/[:,]/).map((x) => parseInt(x, 10));
  const pos = ed.getPosition();
  if (!l) {
    qi.setItems([{ label: `Current Line: ${pos.lineNumber}, Character: ${pos.column}. Type a line number between 1 and ${lines} to navigate to.`, icon: 'go-to-file' }]);
    return;
  }
  let line = l < 0 ? lines + l + 1 : Math.min(l, lines);
  const col = c ? Math.min(c, model.getLineMaxColumn(line)) : 1;
  ed.revealLineInCenter(line);
  qi.setItems([{
    label: c ? `Go to line ${line}, character ${col}.` : `Go to line ${line}.`,
    icon: 'go-to-file',
    run: () => { ed.setPosition({ lineNumber: line, column: col }); ed.revealLineInCenter(line); ed.focus(); },
  }]);
}

// ---- open editors ----
function editorsMode(q, qi) {
  const items = [];
  getGroups().forEach((g, gi) => {
    for (const t of g.tabs) {
      const label = t.doc?.name || t.title || t.kind;
      items.push({ label, description: `${getGroups().length > 1 ? `Group ${gi + 1} · ` : ''}${t.doc?.path ? relative(workspace.root, dirname(t.doc.path)) : ''}`, iconEl: fileIcon(label), run: () => { setActiveGroup(g); g.activate(t); } });
    }
  });
  const query = q.trim();
  qi.setItems(query ? items.map((i) => ({ i, m: fuzzyMatch(query, i.label) })).filter((x) => x.m).sort((a, b) => b.m.score - a.m.score).map((x) => ({ ...x.i, labelHtml: highlightHtml(x.i.label, x.m.positions) })) : items);
}

// ---- files ----
async function filesMode(value, qi, token, currentToken) {
  qi.setPlaceholder("Search files by name (append : to go to line or @ to go to symbol)");
  let query = value.trim();
  let line = null;
  let col = null;
  const lm = /^(.*?)(?::(\d+))?(?::(\d+))?$/.exec(query);
  if (lm && lm[2]) { query = lm[1]; line = +lm[2]; col = lm[3] ? +lm[3] : 1; }
  const symbolIdx = query.indexOf('@');
  if (symbolIdx > 0) query = query.slice(0, symbolIdx);
  const root = workspace.root;
  const mkItem = (abs, rel, pos, extra = {}) => {
    const name = basename(abs);
    const dir = dirname(rel) === '.' ? '' : dirname(rel);
    const nameStart = rel.length - name.length;
    return {
      label: name,
      labelHtml: highlightHtml(name, (pos || []).filter((p) => p >= nameStart).map((p) => p - nameStart)),
      description: root && isInside(root, abs) ? dir : dirname(abs),
      iconEl: fileIcon(name),
      path: abs,
      run: () => openFile(abs, { pinned: true, selection: line ? { line, column: col } : undefined }),
      buttons: [{ icon: 'split-horizontal', title: 'Open to the Side', run: (it, q2) => { q2.close(false); openFile(abs, { sideBySide: true, pinned: true }); } }],
      ...extra,
    };
  };

  // recently opened (and currently open) files
  const recent = [];
  const seen = new Set();
  for (const g of getGroups()) for (const t of g.tabs) if (t.doc?.path && !seen.has(t.doc.path)) { seen.add(t.doc.path); recent.push(t.doc.path); }
  for (const r of getState().recent || []) if (r.type === 'file' && !seen.has(r.path) && (!root || isInside(root, r.path))) { seen.add(r.path); recent.push(r.path); }

  if (!query) {
    qi.setItems(recent.slice(0, 40).map((p, i) => mkItem(p, root ? relative(root, p) : p, [], { separator: i === 0 ? 'recently opened' : undefined })));
    if (!root) return;
  }
  // matched recent first
  const results = [];
  if (query) {
    for (const p of recent) {
      const rel = root ? relative(root, p) : p;
      const m = fuzzyMatch(query, rel);
      if (m) results.push({ abs: p, rel, score: m.score + 30, pos: m.positions, recent: true });
    }
  }
  qi.setBusy(true);
  const ex = String(settings.get('search.exclude') || '').split(',').map((s) => s.trim()).filter(Boolean);
  const files = await listWorkspaceFiles(ex);
  if (token !== currentToken()) return;
  qi.setBusy(false);
  if (!query) return;
  const pathQuery = query.replace(/\\/g, '/');
  for (const rel of files) {
    const abs = join(root, rel);
    if (seen.has(abs)) continue;
    const m = fuzzyMatch(pathQuery, rel);
    if (m) results.push({ abs, rel, score: m.score, pos: m.positions });
  }
  results.sort((a, b) => b.score - a.score || a.rel.length - b.rel.length);
  const top = results.slice(0, 200);
  const items = top.map((r, i) => mkItem(r.abs, r.rel, r.pos, { separator: i === 0 ? (r.recent ? 'recently opened' : 'file results') : !r.recent && top[i - 1]?.recent ? 'file results' : undefined }));
  // absolute or ~ paths that exist on disk
  if (/^[/~]/.test(query) && !items.length) {
    const st = await window.snake.fs.stat(query);
    if (st.exists && !st.isDir) items.push(mkItem(query, query, []));
  }
  qi.setItems(items);
}

/** Quick pick to switch between recently used editors (Ctrl+Tab). */
export function showEditorsMRU(groupOnly = true) {
  const g = getGroups().find((x) => x.el.classList.contains('active-group')) || getGroups()[0];
  const list = (groupOnly ? g.mru.filter((t) => g.tabs.includes(t)) : getGroups().flatMap((x) => x.tabs));
  quickInput.open({
    placeholder: 'Select an editor to open',
    items: list.map((t) => ({ label: t.doc?.name || t.title || t.kind, description: t.doc?.path ? relative(workspace.root, dirname(t.doc.path)) : '', iconEl: fileIcon(t.doc?.name || ''), run: () => g.activate(t) })),
    matchOnDescription: true,
    onAccept: (item) => item?.run(),
  });
  if (list.length > 1) { quickInput.index = 1; quickInput.updateActive(); }
}

