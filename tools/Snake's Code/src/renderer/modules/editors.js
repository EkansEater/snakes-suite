// Documents, editor groups, tabs, breadcrumbs and the built-in editor kinds (text, diff, image, markdown).
import * as monaco from 'monaco-editor';
import { marked } from 'marked';
import { el, icon, bus, basename, dirname, extname, relative, join, debounce, makeSash, formatBytes, lineDiff, isInside } from './util.js';
import * as settings from './settings.js';
import { executeCommand, getBindings, getCommand } from './commands.js';
import { notify, confirm, contextMenu, pick } from './ui.js';
import { fileIcon, specialIcon, folderIcon } from './icons.js';
import { workspace, env, addRecent } from './workspace.js';

// ===========================================================================
// Language detection
// ===========================================================================
let langByExt = null;
let langByName = null;
const EXTRA_EXT = {
  '.jsonc': 'json', '.json5': 'json', '.fish': 'shell', '.zsh': 'shell', '.bash': 'shell', '.toml': 'ini', '.env': 'ini',
  '.conf': 'ini', '.cfg': 'ini', '.vue': 'html', '.svelte': 'html', '.astro': 'html', '.mdx': 'markdown', '.cjs': 'javascript',
  '.mjs': 'javascript', '.mts': 'typescript', '.cts': 'typescript', '.h': 'cpp', '.hh': 'cpp', '.ino': 'cpp', '.gradle': 'java',
  '.svg': 'xml', '.plist': 'xml', '.csproj': 'xml', '.service': 'ini', '.desktop': 'ini', '.properties': 'ini', '.lock': 'plaintext',
  '.zig': 'rust', '.nim': 'python', '.log': 'plaintext', '.gitignore': 'plaintext', '.tf': 'hcl', '.prisma': 'graphql',
};
const EXTRA_NAMES = {
  makefile: 'shell', gnumakefile: 'shell', dockerfile: 'dockerfile', '.bashrc': 'shell', '.zshrc': 'shell', '.profile': 'shell',
  '.gitconfig': 'ini', '.editorconfig': 'ini', '.npmrc': 'ini', 'cmakelists.txt': 'plaintext', '.prettierrc': 'json', '.eslintrc': 'json',
  '.babelrc': 'json', 'pkgbuild': 'shell', 'jenkinsfile': 'java', 'vagrantfile': 'ruby', 'gemfile': 'ruby', 'rakefile': 'ruby',
};

export function languageFor(path) {
  if (!langByExt) {
    langByExt = {};
    langByName = {};
    for (const l of monaco.languages.getLanguages()) {
      for (const e of l.extensions || []) langByExt[e.toLowerCase()] ||= l.id;
      for (const f of l.filenames || []) langByName[f.toLowerCase()] ||= l.id;
    }
    Object.assign(langByExt, EXTRA_EXT);
    Object.assign(langByName, EXTRA_NAMES);
  }
  if (!path) return settings.get('files.defaultLanguage') || 'plaintext';
  const name = basename(path).toLowerCase();
  if (langByName[name]) return langByName[name];
  if (name.startsWith('dockerfile')) return 'dockerfile';
  if (name.startsWith('.env')) return 'ini';
  return langByExt[extname(name)] || 'plaintext';
}

/** Resolve a fenced-code language tag ("js", "py", "C++") to a Monaco language id. */
export function resolveLanguage(tag) {
  const t = tag.toLowerCase();
  const l = monaco.languages.getLanguages().find((x) => x.id === t || x.aliases?.some((a) => a.toLowerCase() === t) || x.extensions?.includes('.' + t));
  return l?.id || EXTRA_EXT['.' + t] || null;
}

export function languageName(id) {
  const l = monaco.languages.getLanguages().find((x) => x.id === id);
  return l?.aliases?.[0] || id;
}

const IMAGE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif', '.svg']);
const MEDIA_EXT = new Set(['.mp4', '.webm', '.mov', '.mp3', '.wav', '.ogg', '.flac', '.m4a']);
export const isImage = (p) => IMAGE_EXT.has(extname(p)) && extname(p) !== '.svg';
const isMedia = (p) => MEDIA_EXT.has(extname(p));
const fileUrl = (p) => 'file://' + encodeURI(p.replace(/\\/g, '/')).replace(/#/g, '%23').replace(/\?/g, '%3F');

// ===========================================================================
// Documents
// ===========================================================================
const docs = new Map(); // key -> TextDocument
let untitledCounter = 0;

export class TextDocument {
  constructor({ path, content, language, untitled, bom = false, mtime = 0 }) {
    this.path = path || null;
    this.untitled = !!untitled;
    this.untitledName = untitled ? `Untitled-${++untitledCounter}` : null;
    this.key = this.path || `untitled:${this.untitledName}`;
    this.bom = bom;
    this.mtime = mtime;
    const uri = this.path ? monaco.Uri.file(this.path) : monaco.Uri.from({ scheme: 'untitled', path: '/' + this.untitledName });
    const existing = monaco.editor.getModel(uri);
    if (existing) existing.dispose();
    this.model = monaco.editor.createModel(content || '', language || languageFor(this.path), uri);
    const eolSetting = settings.get('files.eol');
    if (!content && eolSetting !== 'auto') this.model.setEOL(eolSetting === '\r\n' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
    this.applyIndentSettings();
    this.savedVersion = this.model.getAlternativeVersionId();
    this.wasDirty = false;
    this.model.onDidChangeContent(() => this.onChange());
    docs.set(this.key, this);
  }

  applyIndentSettings() {
    this.model.updateOptions({ tabSize: settings.get('editor.tabSize'), insertSpaces: settings.get('editor.insertSpaces') });
    if (settings.get('editor.detectIndentation')) this.model.detectIndentation(settings.get('editor.insertSpaces'), settings.get('editor.tabSize'));
  }

  get name() {
    return this.path ? basename(this.path) : this.untitledName;
  }

  get dirty() {
    if (this.untitled) return this.model.getValueLength() > 0 || this.model.getAlternativeVersionId() !== this.savedVersion;
    return this.model.getAlternativeVersionId() !== this.savedVersion;
  }

  onChange() {
    const d = this.dirty;
    if (d !== this.wasDirty) {
      this.wasDirty = d;
      bus.emit('doc:dirty', this);
    }
    bus.emit('doc:changed', this);
    scheduleAutoSave(this);
  }

  markSaved() {
    this.savedVersion = this.model.getAlternativeVersionId();
    this.wasDirty = false;
    bus.emit('doc:dirty', this);
  }

  /** Replace the content while keeping undo history (used when the file changes on disk). */
  setContentPreservingUndo(text) {
    if (this.model.getValue() === text) return;
    this.model.pushEditOperations([], [{ range: this.model.getFullModelRange(), text }], () => null);
    this.model.pushStackElement();
  }

  rekey(newPath) {
    docs.delete(this.key);
    const old = this.model;
    const value = old.getValue();
    const uri = monaco.Uri.file(newPath);
    monaco.editor.getModel(uri)?.dispose();
    this.model = monaco.editor.createModel(value, languageFor(newPath), uri);
    this.model.setEOL(old.getEOL() === '\r\n' ? monaco.editor.EndOfLineSequence.CRLF : monaco.editor.EndOfLineSequence.LF);
    this.model.updateOptions({ tabSize: old.getOptions().tabSize, insertSpaces: old.getOptions().insertSpaces });
    this.model.onDidChangeContent(() => this.onChange());
    this.path = newPath;
    this.untitled = false;
    this.key = newPath;
    docs.set(this.key, this);
    for (const g of groups) {
      for (const t of g.tabs) if (t.doc === this) { t.key = this.key; }
      if (g.active?.doc === this && g.textEditor) g.textEditor.setModel(this.model);
    }
    old.dispose();
    this.markSaved();
    bus.emit('editors:changed');
  }

  dispose() {
    docs.delete(this.key);
    this.model.dispose();
    bus.emit('doc:closed', this);
  }
}

export function getDocument(key) {
  return docs.get(key);
}

export function allDocuments() {
  return [...docs.values()];
}

export function dirtyDocuments() {
  return allDocuments().filter((d) => d.dirty);
}

// Opens of the same file that overlap (a click and a double-click, a restored session and
// a file to open) share one load: a second TextDocument would dispose the first one's model.
const loading = new Map();

export async function loadDocument(path, opts = {}) {
  const existing = docs.get(path);
  if (existing) return existing;
  if (loading.has(path)) return loading.get(path);
  const load = (async () => {
    const res = await window.snake.fs.readFile(path, { force: opts.force });
    if (res.binary || res.tooLarge) return res;
    return docs.get(path) || new TextDocument({ path, content: res.content, bom: res.bom, mtime: res.mtime });
  })();
  loading.set(path, load);
  try {
    return await load;
  } finally {
    loading.delete(path);
  }
}

export function newUntitled(content = '', language) {
  const doc = new TextDocument({ untitled: true, content, language });
  return doc;
}

// ---- saving ----
async function applySaveParticipants(doc) {
  const model = doc.model;
  const edits = [];
  if (settings.get('editor.formatOnSave')) {
    const ed = editorShowing(doc);
    if (ed) {
      try { await ed.getAction('editor.action.formatDocument')?.run(); } catch {}
    }
  }
  if (settings.get('files.trimTrailingWhitespace') && !['markdown'].includes(model.getLanguageId())) {
    const n = model.getLineCount();
    for (let i = 1; i <= n; i++) {
      const line = model.getLineContent(i);
      const m = /\s+$/.exec(line);
      if (m) edits.push({ range: new monaco.Range(i, m.index + 1, i, line.length + 1), text: '' });
    }
  }
  if (settings.get('files.trimFinalNewlines')) {
    const n = model.getLineCount();
    let last = n;
    while (last > 1 && model.getLineContent(last) === '' && model.getLineContent(last - 1) === '') last--;
    if (last < n) edits.push({ range: new monaco.Range(last, model.getLineMaxColumn(last), n, model.getLineMaxColumn(n)), text: '' });
  }
  if (edits.length) model.pushEditOperations([], edits, () => null);
  if (settings.get('files.insertFinalNewline')) {
    const n = model.getLineCount();
    if (model.getValueLength() > 0 && model.getLineContent(n) !== '') {
      model.pushEditOperations([], [{ range: new monaco.Range(n, model.getLineMaxColumn(n), n, model.getLineMaxColumn(n)), text: model.getEOL() }], () => null);
    }
  }
}

export async function saveDocument(doc, { saveAs = false, skipParticipants = false } = {}) {
  if (!doc) return false;
  if (doc.untitled || saveAs) {
    const suggested = doc.path || join(workspace.root || env.homeDir, doc.untitled ? doc.untitledName + (doc.model.getLanguageId() !== 'plaintext' ? suggestedExt(doc.model.getLanguageId()) : '.txt') : doc.name);
    const target = await window.snake.dialog.saveAs(suggested);
    if (!target) return false;
    if (!skipParticipants) await applySaveParticipants(doc);
    try {
      const r = await window.snake.fs.writeFile(target, doc.model.getValue(), { bom: doc.bom });
      doc.mtime = r.mtime;
    } catch (err) {
      notify({ type: 'error', message: `Failed to save '${basename(target)}': ${err.message}` });
      return false;
    }
    const other = docs.get(target);
    if (other && other !== doc) closeDocumentEverywhere(other, true);
    doc.rekey(target);
    addRecent(target, 'file');
    bus.emit('doc:saved', doc);
    return true;
  }
  if (!skipParticipants) await applySaveParticipants(doc);
  try {
    const r = await window.snake.fs.writeFile(doc.path, doc.model.getValue(), { bom: doc.bom });
    doc.mtime = r.mtime;
    doc.markSaved();
    bus.emit('doc:saved', doc);
    if (doc.path === env.storePaths.settings || doc.path === env.storePaths.keybindings) bus.emit('userfile:saved', doc.path);
    return true;
  } catch (err) {
    notify({ type: 'error', message: `Failed to save '${doc.name}': ${err.message}`, actions: [{ label: 'Save As...', run: () => saveDocument(doc, { saveAs: true }) }] });
    return false;
  }
}

function suggestedExt(lang) {
  const l = monaco.languages.getLanguages().find((x) => x.id === lang);
  return l?.extensions?.[0] || '';
}

export async function saveAll() {
  for (const d of dirtyDocuments()) {
    if (!d.untitled) await saveDocument(d);
  }
}

export async function revertDocument(doc) {
  if (!doc || doc.untitled) return;
  const res = await window.snake.fs.readFile(doc.path);
  if (res.content == null) return;
  doc.setContentPreservingUndo(res.content);
  doc.mtime = res.mtime;
  doc.markSaved();
}

let autoSaveTimers = new Map();
function scheduleAutoSave(doc) {
  if (settings.get('files.autoSave') !== 'afterDelay' || doc.untitled) return;
  clearTimeout(autoSaveTimers.get(doc));
  autoSaveTimers.set(doc, setTimeout(() => { if (doc.dirty && docs.get(doc.key) === doc) saveDocument(doc); }, settings.get('files.autoSaveDelay')));
}

function autoSaveOnFocusChange() {
  const mode = settings.get('files.autoSave');
  if (mode === 'onFocusChange' || mode === 'onWindowChange') saveAll();
}
window.addEventListener('blur', () => { if (['onFocusChange', 'onWindowChange'].includes(settings.get('files.autoSave'))) saveAll(); });

// ---- disk change handling ----
bus.on('fs:changed', async (paths) => {
  for (const p of paths) {
    const doc = docs.get(p);
    if (!doc) continue;
    const st = await window.snake.fs.stat(p);
    if (!st.exists) {
      bus.emit('doc:deletedOnDisk', doc);
      continue;
    }
    if (Math.abs(st.mtime - doc.mtime) < 1) continue;
    const res = await window.snake.fs.readFile(p);
    if (res.content == null) continue;
    if (!doc.dirty) {
      doc.setContentPreservingUndo(res.content);
      doc.mtime = res.mtime;
      doc.markSaved();
    } else if (res.content !== doc.model.getValue()) {
      doc.mtime = res.mtime;
      notify({
        type: 'warning',
        message: `'${doc.name}' was changed on disk while you have unsaved changes.`,
        actions: [
          { label: 'Compare', run: () => openDiff({ originalText: res.content, doc, title: `${doc.name} (on disk) ↔ (yours)` }) },
          { label: 'Overwrite Disk', run: () => saveDocument(doc) },
          { label: 'Revert', secondary: true, run: () => revertDocument(doc) },
        ],
      });
    }
  }
});

// ===========================================================================
// Editor options from settings
// ===========================================================================
export function editorOptions() {
  const rulers = String(settings.get('editor.rulers') || '')
    .split(',')
    .map((x) => parseInt(x, 10))
    .filter((x) => x > 0);
  const bp = settings.get('editor.guides.bracketPairs');
  return {
    fontSize: settings.get('editor.fontSize'),
    fontFamily: settings.get('editor.fontFamily'),
    fontLigatures: settings.get('editor.fontLigatures'),
    lineHeight: settings.get('editor.lineHeight') || 0,
    wordWrap: settings.get('editor.wordWrap'),
    wordWrapColumn: settings.get('editor.wordWrapColumn'),
    lineNumbers: settings.get('editor.lineNumbers'),
    minimap: { enabled: settings.get('editor.minimap.enabled'), renderCharacters: settings.get('editor.minimap.renderCharacters'), side: settings.get('editor.minimap.side'), scale: 1 },
    renderWhitespace: settings.get('editor.renderWhitespace'),
    renderControlCharacters: settings.get('editor.renderControlCharacters'),
    rulers,
    cursorStyle: settings.get('editor.cursorStyle'),
    cursorBlinking: settings.get('editor.cursorBlinking'),
    cursorSmoothCaretAnimation: settings.get('editor.cursorSmoothCaretAnimation'),
    smoothScrolling: settings.get('editor.smoothScrolling'),
    mouseWheelZoom: settings.get('editor.mouseWheelZoom'),
    bracketPairColorization: { enabled: settings.get('editor.bracketPairColorization.enabled') },
    guides: { bracketPairs: bp === 'true' ? true : bp === 'false' ? false : 'active', indentation: settings.get('editor.guides.indentation'), highlightActiveIndentation: true },
    stickyScroll: { enabled: settings.get('editor.stickyScroll.enabled') },
    folding: settings.get('editor.folding'),
    showFoldingControls: 'mouseover',
    renderLineHighlight: settings.get('editor.renderLineHighlight'),
    scrollBeyondLastLine: settings.get('editor.scrollBeyondLastLine'),
    autoClosingBrackets: settings.get('editor.autoClosingBrackets'),
    autoClosingQuotes: settings.get('editor.autoClosingQuotes'),
    linkedEditing: settings.get('editor.linkedEditing'),
    formatOnPaste: settings.get('editor.formatOnPaste'),
    formatOnType: settings.get('editor.formatOnType'),
    quickSuggestions: settings.get('editor.quickSuggestions'),
    suggestOnTriggerCharacters: settings.get('editor.suggestOnTriggerCharacters'),
    acceptSuggestionOnEnter: settings.get('editor.acceptSuggestionOnEnter'),
    parameterHints: { enabled: settings.get('editor.parameterHints.enabled') },
    hover: { enabled: settings.get('editor.hover.enabled') },
    codeLens: settings.get('editor.codeLens'),
    colorDecorators: settings.get('editor.colorDecorators'),
    multiCursorModifier: settings.get('editor.multiCursorModifier'),
    dragAndDrop: settings.get('editor.dragAndDrop'),
    emptySelectionClipboard: settings.get('editor.emptySelectionClipboard'),
    inlayHints: { enabled: settings.get('editor.inlayHints.enabled') },
    padding: { top: settings.get('editor.padding.top') },
    unicodeHighlight: { ambiguousCharacters: settings.get('editor.unicodeHighlight.ambiguousCharacters') },
    automaticLayout: false,
    fixedOverflowWidgets: true,
    contextmenu: true,
    glyphMargin: false,
    lineDecorationsWidth: 12,
    scrollbar: { verticalScrollbarSize: 12, horizontalScrollbarSize: 12, useShadows: false },
    renderValidationDecorations: 'on',
    'semanticHighlighting.enabled': true,
    occurrencesHighlight: 'singleFile',
    find: { addExtraSpaceOnTop: false, seedSearchStringFromSelection: 'selection', autoFindInSelection: 'multiline' },
    overviewRulerBorder: false,
  };
}

settings.onChange(['editor.'], () => {
  const opts = editorOptions();
  for (const g of groups) {
    g.textEditor?.updateOptions(opts);
    g.diffEditor?.updateOptions(opts);
  }
});
settings.onChange(['editor.tabSize', 'editor.insertSpaces', 'editor.detectIndentation'], () => {
  for (const d of docs.values()) d.applyIndentSettings();
  bus.emit('editor:cursor');
});
settings.onChange(['workbench.editor.showTabs', 'workbench.editor.wrapTabs', 'workbench.breadcrumbs.enabled'], () => {
  const area = document.getElementById('editor-area');
  area.classList.toggle('hide-tabs', !settings.get('workbench.editor.showTabs'));
  area.classList.toggle('wrap-tabs', !!settings.get('workbench.editor.wrapTabs'));
  area.classList.toggle('hide-breadcrumbs', !settings.get('workbench.breadcrumbs.enabled'));
  layoutEditors();
});

// ===========================================================================
// Keybindings inside Monaco
// ===========================================================================
const MONACO_KEYS = {
  '`': 'Backquote', '\\': 'Backslash', ',': 'Comma', '=': 'Equal', '-': 'Minus', '.': 'Period', '/': 'Slash', '[': 'BracketLeft',
  ']': 'BracketRight', ';': 'Semicolon', "'": 'Quote', space: 'Space', enter: 'Enter', escape: 'Escape', tab: 'Tab',
  backspace: 'Backspace', delete: 'Delete', left: 'LeftArrow', right: 'RightArrow', up: 'UpArrow', down: 'DownArrow',
  pageup: 'PageUp', pagedown: 'PageDown', home: 'Home', end: 'End', insert: 'Insert',
};

function toMonacoChord(chord) {
  const parts = chord.split('+');
  const key = parts.pop();
  let code;
  if (/^[a-z]$/.test(key)) code = monaco.KeyCode['Key' + key.toUpperCase()];
  else if (/^\d$/.test(key)) code = monaco.KeyCode['Digit' + key];
  else if (/^f\d+$/.test(key)) code = monaco.KeyCode[key.toUpperCase()];
  else code = monaco.KeyCode[MONACO_KEYS[key]];
  if (code == null) return null;
  let k = code;
  if (parts.includes('ctrl')) k |= env.platform === 'darwin' ? monaco.KeyMod.WinCtrl : monaco.KeyMod.CtrlCmd;
  if (parts.includes('meta')) k |= env.platform === 'darwin' ? monaco.KeyMod.CtrlCmd : monaco.KeyMod.WinCtrl;
  if (parts.includes('shift')) k |= monaco.KeyMod.Shift;
  if (parts.includes('alt')) k |= monaco.KeyMod.Alt;
  return k;
}

export function toMonacoKeybinding(key) {
  const chords = key.split(' ').map(toMonacoChord);
  if (chords.some((c) => c == null)) return null;
  return chords.length === 2 ? monaco.KeyMod.chord(chords[0], chords[1]) : chords[0];
}

const editorKeyDisposables = new WeakMap();
const EDITOR_SKIP = new Set(['editor.action.gotoLine', 'workbench.action.gotoSymbol']);

function bindKeysToEditor(editor) {
  editorKeyDisposables.get(editor)?.forEach((d) => d.dispose());
  const list = [];
  const byCommand = new Map();
  for (const b of getBindings()) {
    if (EDITOR_SKIP.has(b.command) || getCommand(b.command)?.notInEditor) continue;
    const kb = toMonacoKeybinding(b.key);
    if (kb == null) continue;
    if (!byCommand.has(b.command)) byCommand.set(b.command, []);
    byCommand.get(b.command).push({ kb, when: b.when, args: b.args });
  }
  for (const [command, binds] of byCommand) {
    for (const [i, b] of binds.entries()) {
      list.push(
        editor.addAction({
          id: `snake.${command}.${i}`,
          label: '',
          keybindings: [b.kb],
          run: () => {
            if (b.when && !b.when()) return;
            executeCommand(command, ...(b.args !== undefined ? [b.args] : []));
          },
        }),
      );
    }
  }
  editorKeyDisposables.set(editor, list);
}

bus.on('keybindings:changed', () => {
  for (const g of groups) {
    if (g.textEditor) bindKeysToEditor(g.textEditor);
    if (g.diffEditor) bindKeysToEditor(g.diffEditor.getModifiedEditor());
  }
});

// ===========================================================================
// Editor kinds registry (custom editors such as Settings / Welcome)
// ===========================================================================
const kinds = new Map();
/**
 * kind: { title(input), icon(input), render(input, container, group) => { dispose(), focus?(), layout?() }, serialize?(input) }
 */
export function registerEditorKind(name, kind) {
  kinds.set(name, kind);
}

// ===========================================================================
// Editor groups
// ===========================================================================
let groups = [];
let activeGroup = null;
let groupCounter = 0;
const closedStack = [];
const area = () => document.getElementById('editor-area');

export function getGroups() {
  return groups;
}
export function getActiveGroup() {
  return activeGroup;
}

class EditorGroup {
  constructor() {
    this.id = ++groupCounter;
    this.tabs = [];
    this.active = null;
    this.size = 1;
    this.viewStates = new Map();
    this.mru = [];
    this.tabsEl = el('div.tabs-scroll');
    this.actionsEl = el('div.tabs-actions');
    this.tabBar = el('div.tab-bar', {}, this.tabsEl, this.actionsEl);
    this.breadcrumbs = el('div.breadcrumbs');
    this.textHost = el('div.editor-host.text-host');
    this.diffHost = el('div.editor-host.diff-host');
    this.customHost = el('div.editor-host.custom-host');
    this.emptyHost = el('div.editor-host.empty-host', {}, buildWatermark());
    this.body = el('div.group-body', {}, this.textHost, this.diffHost, this.customHost, this.emptyHost);
    this.dropOverlay = el('div.drop-overlay');
    this.el = el('div.editor-group', { dataset: { group: this.id } }, this.tabBar, this.breadcrumbs, this.body, this.dropOverlay);
    this.el.addEventListener('mousedown', () => setActiveGroup(this), true);
    this.el.addEventListener('focusin', () => setActiveGroup(this));
    this.buildActions();
    this.setupDnD();
    this.tabsEl.addEventListener('wheel', (e) => {
      if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { this.tabsEl.scrollLeft += e.deltaY; e.preventDefault(); }
    }, { passive: false });
    this.tabBar.addEventListener('dblclick', (e) => {
      if (e.target === this.tabsEl || e.target === this.tabBar) { setActiveGroup(this); executeCommand('workbench.action.files.newUntitledFile'); }
    });
    this.showHost(null);
  }

  buildActions() {
    const btn = (name, title, run) => el('span.action-btn', { title, onclick: (e) => { e.stopPropagation(); run(e); } }, icon(name));
    this.mdBtn = btn('open-preview', 'Open Preview to the Side (Ctrl+K V)', () => { setActiveGroup(this); executeCommand('markdown.showPreviewToSide'); });
    this.runBtn = btn('play', 'Run File in Terminal (F5)', () => { setActiveGroup(this); executeCommand('workbench.action.runActiveFile'); });
    this.actionsEl.append(
      this.runBtn,
      this.mdBtn,
      btn('split-horizontal', 'Split Editor Right (Ctrl+\\)', () => { setActiveGroup(this); executeCommand('workbench.action.splitEditor'); }),
      btn('ellipsis', 'More Actions...', (e) => {
        const r = e.currentTarget.getBoundingClientRect();
        import('./ui.js').then(({ showMenu }) =>
          showMenu(
            [
              { label: 'Close All', run: () => this.closeAll() },
              { label: 'Close Saved', run: () => this.closeSaved() },
              { separator: true },
              { label: 'Toggle Word Wrap', key: 'alt+z', run: () => executeCommand('editor.toggleWordWrap') },
              { label: 'Toggle Minimap', run: () => executeCommand('editor.toggleMinimap') },
              { label: 'Toggle Sticky Scroll', run: () => executeCommand('editor.toggleStickyScroll') },
              { separator: true },
              { label: 'Show Opened Editors', run: () => executeCommand('workbench.action.showEditorsInActiveGroup') },
            ],
            { x: r.left, y: r.bottom + 2 },
          ),
        );
      }),
    );
  }

  updateActions() {
    const lang = this.active?.doc?.model.getLanguageId();
    this.mdBtn.style.display = this.active?.kind === 'text' && lang === 'markdown' ? '' : 'none';
    this.runBtn.style.display = this.active?.kind === 'text' && this.active.doc.path && runCommandFor(this.active.doc.path) ? '' : 'none';
  }

  setupDnD() {
    const accepts = (e) => [...e.dataTransfer.types].some((t) => t === 'application/x-snake-tab' || t === 'application/x-snake-path' || t === 'Files');
    this.el.addEventListener('dragover', (e) => {
      if (!accepts(e)) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = [...e.dataTransfer.types].includes('application/x-snake-tab') ? 'move' : 'copy';
      const r = this.body.getBoundingClientRect();
      const split = e.clientX > r.left + r.width * 0.75 && e.clientY > r.top && [...e.dataTransfer.types].includes('application/x-snake-tab');
      this.dropOverlay.className = 'drop-overlay visible' + (split ? ' split-right' : '');
      this.dropSplit = split;
    });
    this.el.addEventListener('dragleave', (e) => {
      if (!this.el.contains(e.relatedTarget)) this.dropOverlay.className = 'drop-overlay';
    });
    this.el.addEventListener('drop', async (e) => {
      this.dropOverlay.className = 'drop-overlay';
      if (!accepts(e)) return;
      e.preventDefault();
      const tabData = e.dataTransfer.getData('application/x-snake-tab');
      if (tabData) {
        const { groupId, key } = JSON.parse(tabData);
        const from = groups.find((g) => g.id === groupId);
        const input = from?.tabs.find((t) => t.key === key);
        if (!input) return;
        const target = this.dropSplit ? splitGroup(this, false) : this;
        const tabEl = e.target.closest?.('.tab');
        const beforeKey = tabEl?.dataset.key;
        moveTab(from, input, target, beforeKey);
        return;
      }
      const p = e.dataTransfer.getData('application/x-snake-path');
      if (p) { setActiveGroup(this); openFile(p, { pinned: true }); return; }
      for (const f of e.dataTransfer.files) {
        const path = window.snake.fs.pathForFile(f);
        if (!path) continue;
        const st = await window.snake.fs.stat(path);
        if (st.isDir) bus.emit('workspace:openFolderRequest', path);
        else { setActiveGroup(this); openFile(path, { pinned: true }); }
      }
    });
  }

  showHost(which) {
    this.textHost.style.display = which === 'text' ? '' : 'none';
    this.diffHost.style.display = which === 'diff' ? '' : 'none';
    this.customHost.style.display = which === 'custom' ? '' : 'none';
    this.emptyHost.style.display = which ? 'none' : '';
    this.breadcrumbs.style.display = which ? '' : 'none';
    this.tabBar.classList.toggle('empty', !which);
  }

  ensureTextEditor() {
    if (this.textEditor) return this.textEditor;
    this.textEditor = monaco.editor.create(this.textHost, { ...editorOptions(), model: null });
    bindKeysToEditor(this.textEditor);
    this.textEditor.onDidChangeCursorPosition((e) => {
      bus.emit('editor:cursor', this.textEditor);
      if (e.reason === 3 /* Explicit */ || e.source === 'api') navHistory.recordJump(this, e.position);
    });
    this.textEditor.onDidChangeCursorSelection(() => bus.emit('editor:cursor', this.textEditor));
    this.textEditor.onDidFocusEditorText(() => { setActiveGroup(this); bus.emit('editor:focus', this.textEditor); });
    this.textEditor.onDidBlurEditorText(() => autoSaveOnFocusChange());
    this.textEditor.onDidChangeModelContent(() => {
      if (this.active?.preview) this.pin(this.active);
      scheduleGitDecorations(this);
    });
    this.textEditor.onDidChangeModelLanguage(() => { bus.emit('editor:cursor', this.textEditor); this.updateActions(); });
    this.textEditor.onDidChangeModelOptions(() => bus.emit('editor:cursor', this.textEditor));
    this.textEditor.onDidChangeConfiguration((e) => {
      if (e.hasChanged(monaco.editor.EditorOption.fontInfo)) {
        // Ctrl+wheel zoom: keep other editors in sync
        const size = this.textEditor.getOption(monaco.editor.EditorOption.fontInfo).fontSize;
        for (const g of groups) if (g !== this && g.textEditor && g.textEditor.getOption(monaco.editor.EditorOption.fontInfo).fontSize !== size) g.textEditor.updateOptions({ fontSize: size });
      }
    });
    this.textEditor.onDidScrollChange(() => this.syncPreview?.());
    return this.textEditor;
  }

  ensureDiffEditor() {
    if (this.diffEditor) return this.diffEditor;
    this.diffEditor = monaco.editor.createDiffEditor(this.diffHost, {
      ...editorOptions(),
      renderSideBySide: true,
      originalEditable: false,
      enableSplitViewResizing: true,
      ignoreTrimWhitespace: false,
      renderOverviewRuler: true,
      useInlineViewWhenSpaceIsLimited: true,
      hideUnchangedRegions: { enabled: false },
    });
    bindKeysToEditor(this.diffEditor.getModifiedEditor());
    this.diffEditor.getModifiedEditor().onDidFocusEditorText(() => setActiveGroup(this));
    this.diffEditor.getModifiedEditor().onDidChangeCursorPosition(() => bus.emit('editor:cursor', this.diffEditor.getModifiedEditor()));
    return this.diffEditor;
  }

  saveViewState() {
    const a = this.active;
    if (!a) return;
    if (a.kind === 'text' && this.textEditor?.getModel() === a.doc.model) this.viewStates.set(a.key, this.textEditor.saveViewState());
    if (a.kind === 'diff' && this.diffEditor) this.viewStates.set(a.key, this.diffEditor.saveViewState());
  }

  /** Add (or focus) an input in this group. */
  open(input, { preview = false, focus = true, index } = {}) {
    let existing = this.tabs.find((t) => t.key === input.key);
    if (existing) {
      if (!preview && existing.preview) existing.preview = false;
      this.activate(existing, focus);
      return existing;
    }
    input.preview = preview && settings.get('workbench.editor.enablePreview');
    if (input.preview) {
      const old = this.tabs.find((t) => t.preview);
      if (old && !(old.doc?.dirty)) {
        const i = this.tabs.indexOf(old);
        this.tabs.splice(i, 1, input);
        this.releaseInput(old);
        this.activate(input, focus);
        return input;
      }
    }
    const activeIdx = this.active ? this.tabs.indexOf(this.active) : this.tabs.length - 1;
    this.tabs.splice(index != null ? index : activeIdx + 1, 0, input);
    this.activate(input, focus);
    return input;
  }

  pin(input) {
    if (!input.preview) return;
    input.preview = false;
    this.renderTabs();
    bus.emit('editors:changed');
  }

  activate(input, focus = true) {
    if (this.active !== input) this.saveViewState();
    const prev = this.active;
    this.active = input;
    this.mru = [input, ...this.mru.filter((x) => x !== input)];
    if (prev !== input && this.custom) { this.custom.dispose?.(); this.custom = null; this.customHost.replaceChildren(); }
    this.syncPreview = null;

    if (input.kind === 'text') {
      const ed = this.ensureTextEditor();
      this.showHost('text');
      if (ed.getModel() !== input.doc.model) {
        ed.setModel(input.doc.model);
        const vs = this.viewStates.get(input.key);
        if (vs) ed.restoreViewState(vs);
      }
      ed.layout();
      if (focus) ed.focus();
      scheduleGitDecorations(this, 0);
    } else if (input.kind === 'diff') {
      const ed = this.ensureDiffEditor();
      this.showHost('diff');
      ed.setModel({ original: input.original, modified: input.modified });
      const vs = this.viewStates.get(input.key);
      if (vs) ed.restoreViewState(vs);
      this.layoutDiff();
      if (focus) ed.getModifiedEditor().focus();
    } else {
      this.showHost('custom');
      if (!this.custom || prev !== input) {
        const kind = kinds.get(input.kind);
        this.customHost.replaceChildren();
        this.custom = kind ? kind.render(input, this.customHost, this) : null;
      }
      if (focus) this.custom?.focus?.();
    }
    this.renderTabs();
    this.renderBreadcrumbs();
    this.updateActions();
    if (activeGroup === this) {
      bus.emit('editor:activeChanged', input, this);
      updateTitle();
    }
    bus.emit('editors:changed');
  }

  /** Release resources for an input that is no longer shown in this group. */
  releaseInput(input) {
    this.viewStates.delete(input.key);
    this.mru = this.mru.filter((x) => x !== input);
    if (input.kind === 'text' || input.kind === 'markdown') {
      const stillUsed = groups.some((g) => g.tabs.some((t) => t.doc === input.doc));
      if (!stillUsed && !input.doc.dirty && docs.get(input.doc.key) === input.doc) input.doc.dispose();
    }
    input.dispose?.();
  }

  async close(input, { force = false } = {}) {
    if (!force && input.kind === 'text' && input.doc.dirty) {
      const otherRefs = groups.some((g) => g.tabs.some((t) => t !== input && t.doc === input.doc && t.kind === 'text'));
      if (!otherRefs) {
        const r = await confirm(`Do you want to save the changes you made to ${input.doc.name}?`, {
          detail: "Your changes will be lost if you don't save them.",
          buttons: ['Save', "Don't Save", 'Cancel'],
          type: 'warning',
          cancelId: 2,
        });
        if (r === 2) return false;
        if (r === 0 && !(await saveDocument(input.doc))) return false;
        if (r === 1) input.doc.markSaved();
      }
    }
    const idx = this.tabs.indexOf(input);
    if (idx < 0) return true;
    if (input.kind === 'text' && input.doc.path) closedStack.push(input.doc.path);
    if (this.active === input) this.saveViewState();
    this.tabs.splice(idx, 1);
    const wasActive = this.active === input;
    if (wasActive) this.active = null;
    // when the doc is shown in the text editor, detach before disposing
    if (input.kind === 'text' && this.textEditor?.getModel() === input.doc.model && !this.tabs.some((t) => t.doc === input.doc)) {
      this.textEditor.setModel(null);
    }
    if (input.kind === 'diff' && this.diffEditor) this.diffEditor.setModel(null);
    if (wasActive && this.custom) { this.custom.dispose?.(); this.custom = null; this.customHost.replaceChildren(); }
    this.releaseInput(input);
    if (wasActive) {
      const next = this.mru.find((t) => this.tabs.includes(t)) || this.tabs[Math.min(idx, this.tabs.length - 1)];
      if (next) this.activate(next, true);
      else this.becameEmpty();
    } else {
      this.renderTabs();
    }
    bus.emit('editors:changed');
    return true;
  }

  becameEmpty() {
    this.showHost(null);
    this.renderTabs();
    this.renderBreadcrumbs();
    if (groups.length > 1) removeGroup(this);
    else {
      bus.emit('editor:activeChanged', null, this);
      updateTitle();
    }
  }

  async closeAll({ except, toRight, savedOnly } = {}) {
    const list = [...this.tabs];
    const startIdx = toRight ? this.tabs.indexOf(toRight) + 1 : 0;
    for (const t of list) {
      if (t === except) continue;
      if (toRight && this.tabs.indexOf(t) < startIdx) continue;
      if (savedOnly && t.doc?.dirty) continue;
      if (!(await this.close(t))) return false;
    }
    return true;
  }

  closeSaved() {
    return this.closeAll({ savedOnly: true });
  }

  renderTabs() {
    const frag = document.createDocumentFragment();
    for (const input of this.tabs) frag.append(this.renderTab(input));
    this.tabsEl.replaceChildren(frag);
    const activeEl = this.tabsEl.querySelector('.tab.active');
    if (activeEl) activeEl.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  renderTab(input) {
    const title = inputTitle(input);
    const dirty = input.doc?.dirty && input.kind === 'text';
    const tab = el('div.tab', { draggable: 'true', title: inputTooltip(input), dataset: { key: input.key } });
    if (input === this.active) tab.classList.add('active');
    if (input.preview) tab.classList.add('preview');
    if (dirty) tab.classList.add('dirty');
    if (input.deleted) tab.classList.add('deleted');
    const gitStatus = input.doc?.path ? gitStatusFor?.(input.doc.path) : null;
    if (gitStatus) tab.dataset.git = gitStatus;
    tab.append(inputIcon(input), el('span.tab-label', {}, title));
    const desc = tabDescription(input, this);
    if (desc) tab.append(el('span.tab-desc', {}, desc));
    const closeBtn = el('span.tab-close', { title: 'Close (Ctrl+W)' }, icon('close', 'close-icon'), el('span.dirty-dot'));
    closeBtn.addEventListener('click', (e) => { e.stopPropagation(); this.close(input); });
    tab.append(closeBtn);
    tab.addEventListener('mousedown', (e) => {
      if (e.button === 1) { e.preventDefault(); this.close(input); return; }
      if (e.button === 0 && !e.target.closest('.tab-close')) { setActiveGroup(this); this.activate(input, true); }
    });
    tab.addEventListener('dblclick', () => this.pin(input));
    tab.addEventListener('contextmenu', (e) => contextMenu(e, tabMenu(this, input)));
    tab.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-snake-tab', JSON.stringify({ groupId: this.id, key: input.key }));
      if (input.doc?.path) e.dataTransfer.setData('text/plain', input.doc.path);
      e.dataTransfer.effectAllowed = 'copyMove';
      tab.classList.add('dragging');
    });
    tab.addEventListener('dragend', () => tab.classList.remove('dragging'));
    tab.addEventListener('dragover', (e) => {
      if (![...e.dataTransfer.types].includes('application/x-snake-tab')) return;
      tab.classList.add('drop-before');
    });
    tab.addEventListener('dragleave', () => tab.classList.remove('drop-before'));
    tab.addEventListener('drop', () => tab.classList.remove('drop-before'));
    return tab;
  }

  renderBreadcrumbs() {
    const input = this.active;
    this.breadcrumbs.replaceChildren();
    if (!input) return;
    const path = input.doc?.path || input.path;
    if (!path) {
      this.breadcrumbs.append(el('span.crumb', {}, inputIcon(input), inputTitle(input)));
      return;
    }
    const root = workspace.root && isInside(workspace.root, path) ? workspace.root : null;
    const rel = root ? relative(root, path) : path;
    const parts = rel.split(/[\\/]/).filter(Boolean);
    let acc = root || (path.startsWith('/') ? '' : '');
    parts.forEach((part, i) => {
      acc = acc ? join(acc, part) : (path.startsWith('/') ? '/' + part : part);
      const full = acc;
      const isLast = i === parts.length - 1;
      const crumb = el('span.crumb', {}, isLast ? inputIcon(input) : null, part);
      crumb.addEventListener('click', () => breadcrumbPick(isLast ? dirname(full) : full, isLast ? full : null));
      if (i > 0) this.breadcrumbs.append(icon('chevron-right', 'crumb-sep'));
      this.breadcrumbs.append(crumb);
    });
  }

  layout() {
    if (this.active?.kind === 'text') this.textEditor?.layout();
    else if (this.active?.kind === 'diff') this.layoutDiff();
    else this.custom?.layout?.();
  }

  layoutDiff() {
    // the diff editor does not pick up its container size reliably; pass it explicitly
    this.diffEditor?.layout({ width: this.diffHost.clientWidth, height: this.diffHost.clientHeight });
  }

  focus() {
    if (this.active?.kind === 'text') this.textEditor?.focus();
    else if (this.active?.kind === 'diff') this.diffEditor?.getModifiedEditor().focus();
    else this.custom?.focus?.();
  }

  dispose() {
    this.custom?.dispose?.();
    this.textEditor?.dispose();
    this.diffEditor?.dispose();
    this.el.remove();
  }
}

function buildWatermark() {
  const rows = [
    ['Show All Commands', 'workbench.action.showCommands'],
    ['Go to File', 'workbench.action.quickOpen'],
    ['Find in Files', 'workbench.action.findInFiles'],
    ['Toggle Terminal', 'workbench.action.terminal.toggleTerminal'],
    ['Open Folder', 'workbench.action.files.openFolder'],
  ];
  const wm = el('div.watermark', {}, el('img.watermark-logo', { src: 'icon.svg', alt: '' }));
  const list = el('dl.watermark-keys');
  for (const [label, id] of rows) {
    const kb = el('dd');
    list.append(el('dt', {}, label), kb);
    kb.dataset.command = id;
  }
  wm.append(list);
  const refresh = () => {
    import('./commands.js').then(({ keyLabelFor }) => {
      for (const dd of list.querySelectorAll('dd')) dd.replaceChildren(...keyLabelFor(dd.dataset.command).split(' ').filter(Boolean).map((k) => el('kbd', {}, k)));
    });
  };
  setTimeout(refresh, 0);
  bus.on('keybindings:changed', refresh);
  return wm;
}

async function breadcrumbPick(dir, current) {
  let entries;
  try { entries = await window.snake.fs.readDir(dir); } catch { return; }
  entries.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
  const items = entries.map((e) => ({ label: e.name, path: e.path, isDir: e.isDir, iconEl: e.isDir ? folderIcon(e.name, false) : fileIcon(e.name), description: e.path === current ? 'current' : '' }));
  const chosen = await pick(items, { placeholder: relative(workspace.root, dir) || dir });
  if (!chosen) return;
  if (chosen.isDir) breadcrumbPick(chosen.path);
  else openFile(chosen.path, { pinned: true });
}

function inputTitle(input) {
  if (input.kind === 'text') return input.doc.name;
  if (kinds.has(input.kind)) return kinds.get(input.kind).title(input);
  return input.title || '';
}

function inputTooltip(input) {
  if (input.doc?.path) return input.doc.path + (input.doc.dirty ? ' • Modified' : '');
  return input.tooltip || inputTitle(input);
}

function inputIcon(input) {
  if (input.kind === 'text') return fileIcon(input.doc.name);
  if (input.kind === 'diff') return input.path ? fileIcon(basename(input.path)) : specialIcon('diff');
  const k = kinds.get(input.kind);
  if (k?.icon) return k.icon(input);
  return specialIcon('file');
}

/** Disambiguate tabs with identical names by showing the parent folder. */
function tabDescription(input, group) {
  if (input.description) return input.description;
  if (!input.doc?.path) return '';
  const name = input.doc.name;
  const dupes = group.tabs.filter((t) => t !== input && t.kind === 'text' && t.doc?.path && t.doc.name === name && t.doc !== input.doc);
  if (!dupes.length) return '';
  return basename(dirname(input.doc.path));
}

function tabMenu(group, input) {
  const path = input.doc?.path || input.path;
  return [
    { label: 'Close', key: 'ctrl+w', run: () => group.close(input) },
    { label: 'Close Others', run: () => group.closeAll({ except: input }) },
    { label: 'Close to the Right', run: () => group.closeAll({ toRight: input }) },
    { label: 'Close Saved', run: () => group.closeSaved() },
    { label: 'Close All', run: () => group.closeAll() },
    { separator: true },
    { label: 'Copy Path', disabled: !path, run: () => window.snake.clipboard.write(path) },
    { label: 'Copy Relative Path', disabled: !path || !workspace.root, run: () => window.snake.clipboard.write(relative(workspace.root, path)) },
    { label: 'Reveal in Explorer View', disabled: !path, run: () => bus.emit('explorer:reveal', path, true) },
    { label: 'Reveal in File Manager', disabled: !path, run: () => window.snake.shell.showItemInFolder(path) },
    { separator: true },
    { label: input.preview ? 'Keep Open' : 'Kept Open', disabled: !input.preview, run: () => group.pin(input) },
    { label: 'Split Right', run: () => { setActiveGroup(group); group.activate(input); executeCommand('workbench.action.splitEditor'); } },
    { separator: true },
    { label: 'Compare with Saved', disabled: !(input.kind === 'text' && input.doc.path), run: () => compareWithSaved(input.doc) },
    { label: 'Open Changes', disabled: !(input.kind === 'text' && input.doc.path), run: () => executeCommand('git.openChange', input.doc.path) },
  ];
}

function setActiveGroup(g) {
  if (activeGroup === g || !groups.includes(g)) return;
  activeGroup = g;
  for (const x of groups) x.el.classList.toggle('active-group', x === g);
  bus.emit('editor:activeChanged', g.active, g);
  updateTitle();
}
export { setActiveGroup };

function addGroup(afterGroup) {
  const g = new EditorGroup();
  const idx = afterGroup ? groups.indexOf(afterGroup) + 1 : groups.length;
  groups.splice(idx, 0, g);
  // equalize sizes
  for (const x of groups) x.size = 1;
  renderGroupsLayout();
  return g;
}

function removeGroup(g) {
  const idx = groups.indexOf(g);
  if (idx < 0 || groups.length === 1) return;
  groups.splice(idx, 1);
  g.dispose();
  renderGroupsLayout();
  if (activeGroup === g) {
    activeGroup = null;
    setActiveGroup(groups[Math.max(0, idx - 1)]);
    activeGroup.focus();
  }
  bus.emit('editors:changed');
}

function renderGroupsLayout() {
  const a = area();
  a.replaceChildren();
  const total = groups.reduce((s, g) => s + g.size, 0);
  groups.forEach((g, i) => {
    g.el.style.flex = `${g.size / total} 1 0`;
    a.append(g.el);
    if (i < groups.length - 1) {
      const sash = el('div.sash.vertical.group-sash');
      makeSash(sash, {
        cursor: 'ew-resize',
        onStart: () => {
          const left = groups[i];
          const right = groups[i + 1];
          return { left, right, lw: left.el.offsetWidth, rw: right.el.offsetWidth };
        },
        onDrag: (dx, _dy, c) => {
          const lw = Math.max(160, Math.min(c.lw + c.rw - 160, c.lw + dx));
          const sum = c.left.size + c.right.size;
          c.left.size = (lw / (c.lw + c.rw)) * sum;
          c.right.size = sum - c.left.size;
          const total2 = groups.reduce((s, g2) => s + g2.size, 0);
          for (const g2 of groups) g2.el.style.flex = `${g2.size / total2} 1 0`;
          layoutEditors();
        },
      });
      sash.addEventListener('dblclick', () => { for (const x of groups) x.size = 1; renderGroupsLayout(); });
      a.append(sash);
    }
  });
  for (const g of groups) g.el.classList.toggle('active-group', g === activeGroup);
  a.classList.toggle('multi-group', groups.length > 1);
  requestAnimationFrame(layoutEditors);
}

export function layoutEditors() {
  for (const g of groups) g.layout();
}

function splitGroup(group, copyActive = true) {
  const g = addGroup(group);
  if (copyActive && group.active) {
    const clone = cloneInput(group.active);
    if (clone) {
      g.open(clone, { focus: true });
      if (group.active.kind === 'text' && group.textEditor) {
        const vs = group.textEditor.saveViewState();
        g.textEditor?.restoreViewState(vs);
      }
    }
  }
  setActiveGroup(g);
  return g;
}

function cloneInput(input) {
  if (input.kind === 'text') return { kind: 'text', key: input.key, doc: input.doc };
  if (input.kind === 'diff') return null;
  if (input.clone) return input.clone();
  const { preview, ...rest } = input;
  return { ...rest };
}

function moveTab(from, input, to, beforeKey) {
  if (from === to) {
    const idx = from.tabs.indexOf(input);
    from.tabs.splice(idx, 1);
    let bi = beforeKey ? from.tabs.findIndex((t) => t.key === beforeKey) : -1;
    if (bi < 0) bi = from.tabs.length;
    from.tabs.splice(bi, 0, input);
    from.renderTabs();
    bus.emit('editors:changed');
    return;
  }
  const clone = input.kind === 'text' ? { kind: 'text', key: input.key, doc: input.doc } : input.kind === 'diff' ? { ...input } : cloneInput(input);
  const bi = beforeKey ? to.tabs.findIndex((t) => t.key === beforeKey) : -1;
  // remove from source without disposing the document
  const vs = from.active === input && input.kind === 'text' ? from.textEditor?.saveViewState() : null;
  if (input.kind === 'diff') input.dispose = null;
  from.tabs = from.tabs.filter((t) => t !== input);
  const existing = to.tabs.find((t) => t.key === input.key);
  if (existing) to.activate(existing);
  else to.open(clone, { index: bi >= 0 ? bi : undefined });
  if (vs && to.textEditor) to.textEditor.restoreViewState(vs);
  setActiveGroup(to);
  if (from.active === input) {
    from.active = null;
    if (input.kind === 'text' && from.textEditor?.getModel() === input.doc.model) from.textEditor.setModel(null);
    if (from.custom) { from.custom.dispose?.(); from.custom = null; }
    const next = from.mru.find((t) => from.tabs.includes(t)) || from.tabs[0];
    from.mru = from.mru.filter((t) => t !== input);
    if (next) from.activate(next, false);
    else from.becameEmpty();
  } else from.renderTabs();
  bus.emit('editors:changed');
}

// ===========================================================================
// Public API: open things
// ===========================================================================
export function initEditors() {
  groups = [];
  const g = addGroup();
  setActiveGroup(g);
  g.showHost(null);
  new ResizeObserver(debounce(layoutEditors, 10)).observe(area());
  bus.on('doc:dirty', (doc) => {
    for (const g2 of groups) if (g2.tabs.some((t) => t.doc === doc)) g2.renderTabs();
    updateTitle();
  });
  bus.on('git:statusChanged', () => {
    for (const g2 of groups) { g2.renderTabs(); scheduleGitDecorations(g2, 50); }
  });
  bus.on('workspace:changed', () => { for (const g2 of groups) g2.renderBreadcrumbs(); });
  bus.on('doc:deletedOnDisk', (doc) => {
    for (const g2 of groups) for (const t of g2.tabs) if (t.doc === doc) { t.deleted = true; g2.renderTabs(); }
  });
}

/**
 * Open a file in the active (or given) group.
 * opts: { preview, pinned, group, selection: {startLineNumber,startColumn,endLineNumber,endColumn} | {line, column}, focus, sideBySide, force }
 */
export async function openFile(path, opts = {}) {
  let group = opts.group || activeGroup;
  if (opts.sideBySide) {
    const idx = groups.indexOf(group);
    group = groups[idx + 1] || splitGroup(group, false);
  }
  setActiveGroup(group);
  const preview = opts.pinned ? false : opts.preview ?? false;

  if (isImage(path) || extname(path) === '.svg' && opts.asImage) {
    const input = { kind: 'image', key: 'image:' + path, path, title: basename(path) };
    group.open(input, { preview, focus: opts.focus !== false });
    return input;
  }
  if (isMedia(path)) {
    const input = { kind: 'media', key: 'media:' + path, path, title: basename(path) };
    group.open(input, { preview, focus: opts.focus !== false });
    return input;
  }
  let doc;
  try {
    doc = await loadDocument(path, { force: opts.force });
  } catch (err) {
    notify({ type: 'error', message: `Unable to open '${basename(path)}': ${err.message}` });
    return null;
  }
  if (doc.binary || doc.tooLarge) {
    const input = { kind: 'binary', key: 'binary:' + path, path, title: basename(path), size: doc.size, tooLarge: doc.tooLarge };
    group.open(input, { preview, focus: opts.focus !== false });
    return input;
  }
  const input = group.open({ kind: 'text', key: doc.key, doc }, { preview, focus: opts.focus !== false });
  if (opts.selection) revealSelection(group, opts.selection);
  if (!opts.noRecent) addRecent(path, 'file');
  if (!opts.noHistory) navHistory.record(group);
  return input;
}

function revealSelection(group, sel) {
  const ed = group.textEditor;
  if (!ed) return;
  const range = sel.startLineNumber
    ? sel
    : new monaco.Range(sel.line, sel.column || 1, sel.endLine || sel.line, sel.endColumn || sel.column || 1);
  ed.setSelection(range);
  ed.revealRangeInCenterIfOutsideViewport(range, monaco.editor.ScrollType.Immediate);
}

export function openUntitled(content = '', language) {
  const doc = newUntitled(content, language);
  activeGroup.open({ kind: 'text', key: doc.key, doc }, { focus: true });
  return doc;
}

export function openInput(input, opts = {}) {
  let group = opts.group || activeGroup;
  if (opts.sideBySide) {
    const idx = groups.indexOf(group);
    group = groups[idx + 1] || splitGroup(group, false);
  }
  setActiveGroup(group);
  return group.open(input, { preview: !!opts.preview, focus: opts.focus !== false });
}

/** Diff view. Accepts either explicit original text or a model, plus the modified doc/text. */
export function openDiff({ originalText, originalLanguage, doc, modifiedText, title, key, path, description }) {
  const lang = originalLanguage || doc?.model.getLanguageId() || languageFor(path);
  const original = monaco.editor.createModel(originalText ?? '', lang);
  let modified;
  let ownsModified = false;
  if (doc) modified = doc.model;
  else {
    modified = monaco.editor.createModel(modifiedText ?? '', lang);
    ownsModified = true;
  }
  const input = {
    kind: 'diff',
    key: key || `diff:${Math.random()}`,
    title,
    tooltip: title,
    description,
    path: path || doc?.path,
    doc,
    original,
    modified,
    dispose() {
      original.dispose();
      if (ownsModified) modified.dispose();
    },
  };
  // replace an existing diff with the same key so it refreshes
  const existing = activeGroup.tabs.find((t) => t.key === input.key);
  if (existing) {
    existing.original.setValue(originalText ?? '');
    if (ownsModified) existing.modified.setValue(modifiedText ?? '');
    original.dispose();
    if (ownsModified) modified.dispose();
    activeGroup.activate(existing);
    return existing;
  }
  return activeGroup.open(input, { focus: true });
}

export async function compareWithSaved(doc) {
  const res = await window.snake.fs.readFile(doc.path);
  openDiff({ originalText: res.content ?? '', doc, title: `${doc.name} (Saved) ↔ ${doc.name}`, key: 'saved-diff:' + doc.path });
}

export function activeInput() {
  return activeGroup?.active || null;
}

export function activeDoc() {
  const a = activeInput();
  if (a?.kind === 'text' || a?.kind === 'markdown') return a.doc;
  if (a?.kind === 'diff' && a.doc) return a.doc;
  return null;
}

/** The focused/active Monaco code editor (text editor or modified side of a diff). */
export function activeCodeEditor() {
  const a = activeInput();
  if (a?.kind === 'text') return activeGroup.textEditor;
  if (a?.kind === 'diff') return activeGroup.diffEditor?.getModifiedEditor();
  return null;
}

/** Whether a document has a tab in any group (it may be loaded without one). */
export function isDocumentOpen(doc) {
  return groups.some((g) => g.tabs.some((t) => t.doc === doc));
}

function editorShowing(doc) {
  if (activeGroup?.active?.doc === doc && activeGroup.textEditor?.getModel() === doc.model) return activeGroup.textEditor;
  for (const g of groups) if (g.textEditor?.getModel() === doc.model) return g.textEditor;
  return null;
}

export function runEditorAction(actionId) {
  const ed = activeCodeEditor();
  if (!ed) return false;
  ed.focus();
  const action = ed.getAction(actionId);
  if (action) { action.run(); return true; }
  ed.trigger('snake', actionId, null);
  return true;
}

export function closeDocumentEverywhere(doc, force = false) {
  for (const g of [...groups]) {
    for (const t of [...g.tabs]) if (t.doc === doc) g.close(t, { force });
  }
}

/** Called after a file/folder rename on disk so open editors follow it. */
export function handleRename(oldPath, newPath) {
  for (const doc of [...docs.values()]) {
    if (!doc.path) continue;
    if (doc.path === oldPath || isInside(oldPath, doc.path)) {
      const np = newPath + doc.path.slice(oldPath.length);
      const wasDirty = doc.dirty;
      doc.rekey(np);
      if (wasDirty) { doc.savedVersion = -1; doc.wasDirty = true; bus.emit('doc:dirty', doc); }
    }
  }
  for (const g of groups) { g.renderTabs(); g.renderBreadcrumbs(); }
  updateTitle();
}

export function handleDelete(path) {
  for (const doc of [...docs.values()]) {
    if (doc.path && (doc.path === path || isInside(path, doc.path))) {
      if (!doc.dirty) closeDocumentEverywhere(doc, true);
      else bus.emit('doc:deletedOnDisk', doc);
    }
  }
  for (const g of [...groups]) {
    for (const t of [...g.tabs]) if ((t.kind === 'image' || t.kind === 'binary' || t.kind === 'media') && (t.path === path || isInside(path, t.path))) g.close(t, { force: true });
  }
}

// ---- group commands ----
export function addGroupRight() {
  const g = addGroup(groups[groups.length - 1]);
  setActiveGroup(g);
  return g;
}

export function splitEditor() {
  return splitGroup(activeGroup, true);
}

export function focusGroup(n) {
  if (n < groups.length) { setActiveGroup(groups[n]); groups[n].focus(); }
  else if (n === groups.length && activeGroup.active) splitEditor();
}

export function focusNextGroup(dir = 1) {
  const i = groups.indexOf(activeGroup);
  const g = groups[(i + dir + groups.length) % groups.length];
  setActiveGroup(g);
  g.focus();
}

export function closeActiveEditor() {
  const g = activeGroup;
  if (g.active) return g.close(g.active);
  if (groups.length > 1) removeGroup(g);
}

export function closeGroup() {
  const g = activeGroup;
  g.closeAll().then((ok) => { if (ok && groups.length > 1 && groups.includes(g)) removeGroup(g); });
}

export async function closeAllEditors() {
  for (const g of [...groups]) {
    if (!(await g.closeAll())) return false;
  }
  return true;
}

export function cycleTab(dir) {
  const g = activeGroup;
  if (!g.tabs.length) return;
  const i = g.tabs.indexOf(g.active);
  g.activate(g.tabs[(i + dir + g.tabs.length) % g.tabs.length]);
}

export function openTabAt(n) {
  const g = activeGroup;
  const t = n < 0 ? g.tabs[g.tabs.length - 1] : g.tabs[n];
  if (t) g.activate(t);
}

export function moveActiveTab(dir) {
  const g = activeGroup;
  const i = g.tabs.indexOf(g.active);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= g.tabs.length) return;
  [g.tabs[i], g.tabs[j]] = [g.tabs[j], g.tabs[i]];
  g.renderTabs();
}

export function moveEditorToGroup(dir) {
  const g = activeGroup;
  if (!g.active) return;
  const i = groups.indexOf(g);
  let target = groups[i + dir];
  if (!target) {
    if (dir < 0) return;
    target = addGroup(g);
  }
  moveTab(g, g.active, target);
}

export function reopenClosed() {
  const p = closedStack.pop();
  if (p) openFile(p, { pinned: true });
}

export function pinActive() {
  if (activeGroup.active) activeGroup.pin(activeGroup.active);
}

export function joinAllGroups() {
  const first = groups[0];
  for (const g of groups.slice(1)) {
    for (const t of [...g.tabs]) if (!first.tabs.some((x) => x.key === t.key)) moveTab(g, t, first);
  }
  for (const g of groups.slice(1)) removeGroup(g);
}

// ===========================================================================
// Navigation history (Go Back / Go Forward)
// ===========================================================================
const navHistory = {
  stack: [],
  index: -1,
  navigating: false,
  record(group) {
    if (this.navigating) return;
    const a = group.active;
    if (!a || a.kind !== 'text') return;
    const pos = group.textEditor?.getPosition();
    this.push({ path: a.doc.path, key: a.key, line: pos?.lineNumber || 1, column: pos?.column || 1 });
  },
  recordJump(group, pos) {
    if (this.navigating) return;
    const a = group.active;
    if (!a || a.kind !== 'text') return;
    const top = this.stack[this.index];
    if (top && top.key === a.key && Math.abs(top.line - pos.lineNumber) < 10) {
      top.line = pos.lineNumber;
      top.column = pos.column;
      return;
    }
    this.push({ path: a.doc.path, key: a.key, line: pos.lineNumber, column: pos.column });
  },
  push(entry) {
    this.stack = this.stack.slice(0, this.index + 1);
    const top = this.stack[this.stack.length - 1];
    if (top && top.key === entry.key && top.line === entry.line) return;
    this.stack.push(entry);
    if (this.stack.length > 100) this.stack.shift();
    this.index = this.stack.length - 1;
  },
  async go(dir) {
    const i = this.index + dir;
    const e = this.stack[i];
    if (!e) return;
    this.index = i;
    this.navigating = true;
    try {
      if (e.path) await openFile(e.path, { pinned: true, selection: { line: e.line, column: e.column }, noHistory: true });
      else {
        const doc = docs.get(e.key);
        if (doc) { activeGroup.open({ kind: 'text', key: doc.key, doc }); revealSelection(activeGroup, { line: e.line, column: e.column }); }
      }
    } finally {
      setTimeout(() => (this.navigating = false), 50);
    }
  },
};
export const goBack = () => navHistory.go(-1);
export const goForward = () => navHistory.go(1);

// ===========================================================================
// Title
// ===========================================================================
export function updateTitle() {
  const a = activeGroup?.active;
  const parts = [];
  if (a) parts.push((a.doc?.dirty && a.kind === 'text' ? '● ' : '') + inputTitle(a));
  if (workspace.root) parts.push(workspace.name);
  parts.push("Snake's Code");
  const title = parts.join(' — ');
  document.title = title;
  window.snake.win.setTitle(title);
  bus.emit('title:changed', title);
}

// ===========================================================================
// Git gutter decorations (provided by the git module via setGitProviders)
// ===========================================================================
let originalContentProvider = null;
let gitStatusFor = null;
export function setGitProviders({ original, status }) {
  originalContentProvider = original;
  gitStatusFor = status;
}

const decoTimers = new WeakMap();
function scheduleGitDecorations(group, delay = 400) {
  clearTimeout(decoTimers.get(group));
  decoTimers.set(group, setTimeout(() => updateGitDecorations(group), delay));
}

async function updateGitDecorations(group) {
  const ed = group.textEditor;
  const input = group.active;
  if (!ed || input?.kind !== 'text') return;
  const doc = input.doc;
  const clear = () => { group.gitDecos?.clear(); group.gitHunks = []; };
  if (!settings.get('editor.gitDecorations') || !doc.path || !originalContentProvider) return clear();
  const original = await originalContentProvider(doc.path);
  if (original == null || ed.getModel() !== doc.model) return clear();
  const a = original.split(/\r?\n/);
  const b = doc.model.getLinesContent();
  if (a.length * b.length > 25_000_000 && a.length + b.length > 20000) return clear();
  const hunks = lineDiff(a, b);
  const decos = [];
  for (const h of hunks) {
    if (h.modLen === 0) {
      const line = Math.max(1, h.modStart);
      decos.push({ range: new monaco.Range(line, 1, line, 1), options: { linesDecorationsClassName: 'git-gutter-deleted', overviewRuler: { color: '#c74e39', position: monaco.editor.OverviewRulerLane.Left } } });
    } else {
      const cls = h.origLen === 0 ? 'git-gutter-added' : 'git-gutter-modified';
      const color = h.origLen === 0 ? '#2ea04399' : '#0c7d9d99';
      decos.push({
        range: new monaco.Range(h.modStart + 1, 1, h.modStart + h.modLen, 1),
        options: { isWholeLine: true, linesDecorationsClassName: cls, overviewRuler: { color, position: monaco.editor.OverviewRulerLane.Left }, minimap: { color, position: monaco.editor.MinimapPosition.Gutter } },
      });
    }
  }
  if (!group.gitDecos) group.gitDecos = ed.createDecorationsCollection(decos);
  else group.gitDecos.set(decos);
  group.gitHunks = hunks;
}

// ===========================================================================
// Built-in editor kinds: image, media, binary, markdown preview
// ===========================================================================
registerEditorKind('image', {
  title: (i) => i.title,
  icon: (i) => fileIcon(i.title),
  render(input, host) {
    let zoom = 0; // 0 = fit
    const img = el('img', { src: fileUrl(input.path) + '?t=' + Date.now(), draggable: 'false' });
    const info = el('div.image-info');
    const stage = el('div.image-stage', {}, img);
    const wrap = el('div.image-viewer', { tabindex: '0' }, stage, info);
    const apply = () => {
      img.classList.toggle('fit', zoom === 0);
      img.style.width = zoom ? img.naturalWidth * zoom + 'px' : '';
      info.textContent = `${img.naturalWidth} × ${img.naturalHeight}  ·  ${zoom ? Math.round(zoom * 100) + '%' : 'Fit'}  ·  ${input.sizeText || ''}`;
    };
    img.addEventListener('load', apply);
    window.snake.fs.stat(input.path).then((s) => { input.sizeText = formatBytes(s.size || 0); apply(); });
    stage.addEventListener('click', (e) => {
      const levels = [0, 0.5, 1, 2, 4, 8];
      const i = levels.indexOf(zoom);
      zoom = e.altKey ? levels[Math.max(0, i - 1)] : levels[(i + 1) % levels.length];
      apply();
    });
    host.append(wrap);
    return { dispose: () => wrap.remove(), focus: () => wrap.focus() };
  },
});

registerEditorKind('media', {
  title: (i) => i.title,
  icon: (i) => fileIcon(i.title),
  render(input, host) {
    const isAudio = /\.(mp3|wav|ogg|flac|m4a)$/i.test(input.path);
    const media = el(isAudio ? 'audio' : 'video', { src: fileUrl(input.path), controls: true });
    const wrap = el('div.image-viewer', {}, el('div.image-stage', {}, media));
    host.append(wrap);
    return { dispose: () => { media.pause(); wrap.remove(); } };
  },
});

registerEditorKind('binary', {
  title: (i) => i.title,
  icon: (i) => fileIcon(i.title),
  render(input, host, group) {
    const msg = input.tooLarge ? `This file is too large to open (${formatBytes(input.size)}).` : `This file is not displayed in the text editor because it is either binary or uses an unsupported text encoding (${formatBytes(input.size)}).`;
    const wrap = el(
      'div.binary-viewer',
      {},
      icon('file-binary', 'big-icon'),
      el('p', {}, msg),
      el('button.btn', {
        onclick: async () => {
          await group.close(input, { force: true });
          openFile(input.path, { pinned: true, force: true });
        },
      }, 'Open Anyway'),
      el('button.btn.secondary', { onclick: () => window.snake.shell.openPath(input.path) }, 'Open with System Default'),
    );
    host.append(wrap);
    return { dispose: () => wrap.remove() };
  },
});

marked.setOptions({ gfm: true, breaks: false });

// Markdown can carry any HTML. Only what a document needs survives: known
// tags, a few attributes, and links to the web, mail, anchors or files.
const SAFE_TAGS = new Set(['a', 'abbr', 'b', 'blockquote', 'br', 'code', 'dd', 'del', 'details', 'div', 'dl', 'dt', 'em', 'figcaption', 'figure',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'input', 'ins', 'kbd', 'li', 'mark', 'ol', 'p', 'pre', 'q', 's', 'samp', 'small', 'span',
  'strong', 'sub', 'summary', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr', 'u', 'ul']);
const DROP_TAGS = new Set(['script', 'style', 'iframe', 'frame', 'object', 'embed', 'form', 'button', 'textarea', 'select', 'svg', 'math', 'link',
  'meta', 'base', 'template', 'noscript', 'audio', 'video', 'source', 'track', 'canvas', 'applet', 'portal']);
const SAFE_ATTRS = { '*': ['title', 'id', 'align', 'lang', 'dir'], a: ['href'], img: ['src', 'alt', 'width', 'height'], code: ['class'], pre: ['class'],
  td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'], ol: ['start'], details: ['open'], input: ['type', 'checked', 'disabled'] };
const safeUrl = (v, img) => {
  const t = String(v).trim();
  if (/^(https?:|mailto:|#)/i.test(t)) return true;
  if (img && /^data:image\/(png|jpe?g|gif|webp);/i.test(t)) return true;
  if (img && /^file:/i.test(t)) return true;
  return !/^[a-z][a-z0-9+.-]*:/i.test(t); // relative paths (opened as files)
};

function sanitize(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const clean = (node) => {
    for (const child of [...node.children]) {
      const tag = child.localName;
      if (DROP_TAGS.has(tag) || (tag === 'input' && child.getAttribute('type') !== 'checkbox')) { child.remove(); continue; }
      clean(child);
      if (!SAFE_TAGS.has(tag)) { child.replaceWith(...child.childNodes); continue; }
      const ok = new Set([...SAFE_ATTRS['*'], ...(SAFE_ATTRS[tag] || [])]);
      for (const a of [...child.attributes]) {
        const keep = ok.has(a.name) && (!['href', 'src'].includes(a.name) || safeUrl(a.value, tag === 'img')) && (a.name !== 'class' || /^(language-[\w+#-]+\s*)+$/.test(a.value));
        if (!keep) child.removeAttribute(a.name);
      }
    }
  };
  clean(doc.body);
  return doc.body.innerHTML;
}

registerEditorKind('markdown', {
  title: (i) => `Preview ${i.doc.name}`,
  icon: () => specialIcon('open-preview'),
  render(input, host) {
    const body = el('div.markdown-body');
    const wrap = el('div.markdown-preview', { tabindex: '0' }, body);
    const base = input.doc.path ? dirname(input.doc.path) : workspace.root || env.homeDir;
    const render = () => {
      try {
        body.innerHTML = sanitize(marked.parse(input.doc.model.getValue()));
      } catch (err) {
        body.textContent = String(err);
      }
      for (const img of body.querySelectorAll('img')) {
        const src = img.getAttribute('src') || '';
        if (src && !/^(https?:|data:|file:)/.test(src)) img.src = fileUrl(src.startsWith('/') ? src : join(base, decodeURI(src)));
      }
      for (const pre of body.querySelectorAll('pre code')) {
        const m = /language-(\S+)/.exec(pre.className);
        const text = pre.textContent;
        const lang = m && resolveLanguage(m[1]);
        if (lang) monaco.editor.colorize(text, lang, {}).then((html) => (pre.innerHTML = html)).catch(() => {});
      }
      for (const box of body.querySelectorAll('input[type=checkbox]')) box.disabled = true;
    };
    render();
    const debounced = debounce(render, 150);
    const sub = input.doc.model.onDidChangeContent(debounced);
    const themeSub = bus.on('theme:changed', render);
    body.addEventListener('click', (e) => {
      const a = e.target.closest('a');
      if (!a) return;
      e.preventDefault();
      const href = a.getAttribute('href') || '';
      if (/^https?:/.test(href)) window.snake.shell.openExternal(href);
      else if (href.startsWith('#')) {
        const id = decodeURIComponent(href.slice(1));
        const target = [...body.querySelectorAll('h1,h2,h3,h4,h5,h6')].find((h) => h.textContent.trim().toLowerCase().replace(/[^\w\- ]+/g, '').replace(/\s+/g, '-') === id.toLowerCase());
        target?.scrollIntoView({ behavior: 'smooth' });
      } else if (href) openFile(href.startsWith('/') ? href : join(base, decodeURI(href.split('#')[0])), { pinned: true });
    });
    host.append(wrap);
    return {
      dispose: () => { sub.dispose(); themeSub(); debounced.cancel(); wrap.remove(); },
      focus: () => wrap.focus(),
    };
  },
});

export function openMarkdownPreview(sideBySide = true) {
  const doc = activeDoc();
  if (!doc) return;
  const input = { kind: 'markdown', key: 'md:' + doc.key, doc, clone() { return { ...this, preview: false }; } };
  openInput(input, { sideBySide, focus: false });
  // keep the document alive while the preview is open
}

// ===========================================================================
// Run active file
// ===========================================================================
const q = (p) => `'${p.replace(/'/g, `'\\''`)}'`;
export function runCommandFor(path) {
  const ext = extname(path);
  const dir = dirname(path);
  const name = basename(path);
  const noExt = name.replace(/\.[^.]+$/, '');
  const out = q(join('/tmp', `snake-run-${noExt}`));
  switch (ext) {
    case '.js': case '.mjs': case '.cjs': return `node ${q(path)}`;
    case '.ts': case '.mts': return `npx --yes tsx ${q(path)}`;
    case '.py': return `python3 ${q(path)}`;
    case '.sh': case '.bash': return `bash ${q(path)}`;
    case '.zsh': return `zsh ${q(path)}`;
    case '.fish': return `fish ${q(path)}`;
    case '.rb': return `ruby ${q(path)}`;
    case '.php': return `php ${q(path)}`;
    case '.pl': return `perl ${q(path)}`;
    case '.lua': return `lua ${q(path)}`;
    case '.go': return `go run ${q(path)}`;
    case '.rs': return `rustc ${q(path)} -o ${out} && ${out}`;
    case '.c': return `gcc ${q(path)} -o ${out} -lm && ${out}`;
    case '.cpp': case '.cc': case '.cxx': return `g++ -std=c++20 ${q(path)} -o ${out} && ${out}`;
    case '.java': return `java ${q(path)}`;
    case '.kt': return `kotlinc ${q(path)} -include-runtime -d ${out}.jar && java -jar ${out}.jar`;
    case '.swift': return `swift ${q(path)}`;
    case '.dart': return `dart run ${q(path)}`;
    case '.r': return `Rscript ${q(path)}`;
    case '.html': case '.htm': return `xdg-open ${q(path)}`;
    case '.cs': return `dotnet run --project ${q(dir)}`;
    case '.zig': return `zig run ${q(path)}`;
    default: return null;
  }
}
