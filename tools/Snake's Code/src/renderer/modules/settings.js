// User settings: schema, defaults, persistence and change notifications.
import { bus } from './util.js';

const MONO = "'JetBrains Mono', 'Fira Code', 'Cascadia Code', 'Source Code Pro', 'DejaVu Sans Mono', 'Ubuntu Mono', monospace";

/** Each entry: [key, default, description, extra] */
const SCHEMA = [
  // ---- Editor ----
  ['editor.fontSize', 14, 'Controls the font size in pixels.', { type: 'number', min: 6, max: 72 }],
  ['editor.fontFamily', MONO, 'Controls the font family.', { type: 'string' }],
  ['editor.fontLigatures', true, 'Enables font ligatures (e.g. => and !=).', { type: 'boolean' }],
  ['editor.lineHeight', 0, 'Line height in pixels. 0 computes it from the font size.', { type: 'number', min: 0, max: 100 }],
  ['editor.tabSize', 4, 'The number of spaces a tab is equal to (overridden by indentation detection).', { type: 'number', min: 1, max: 16 }],
  ['editor.insertSpaces', true, 'Insert spaces when pressing Tab.', { type: 'boolean' }],
  ['editor.detectIndentation', true, 'Detect tab size and spaces/tabs from file contents.', { type: 'boolean' }],
  ['editor.wordWrap', 'off', 'Controls how lines should wrap.', { enum: ['off', 'on', 'wordWrapColumn', 'bounded'] }],
  ['editor.wordWrapColumn', 80, 'Column at which the editor wraps when word wrap is wordWrapColumn or bounded.', { type: 'number' }],
  ['editor.lineNumbers', 'on', 'Controls the display of line numbers.', { enum: ['on', 'off', 'relative', 'interval'] }],
  ['editor.minimap.enabled', true, 'Show the minimap.', { type: 'boolean' }],
  ['editor.minimap.renderCharacters', true, 'Render actual characters on the minimap rather than color blocks.', { type: 'boolean' }],
  ['editor.minimap.side', 'right', 'Where to render the minimap.', { enum: ['right', 'left'] }],
  ['editor.renderWhitespace', 'selection', 'How whitespace characters are rendered.', { enum: ['none', 'boundary', 'selection', 'trailing', 'all'] }],
  ['editor.renderControlCharacters', true, 'Render control characters.', { type: 'boolean' }],
  ['editor.rulers', '', 'Comma separated list of columns to render vertical rulers at (e.g. "80, 120").', { type: 'string' }],
  ['editor.cursorStyle', 'line', 'Cursor style.', { enum: ['line', 'block', 'underline', 'line-thin', 'block-outline', 'underline-thin'] }],
  ['editor.cursorBlinking', 'smooth', 'Cursor animation style.', { enum: ['blink', 'smooth', 'phase', 'expand', 'solid'] }],
  ['editor.cursorSmoothCaretAnimation', 'on', 'Smooth caret animation.', { enum: ['off', 'explicit', 'on'] }],
  ['editor.smoothScrolling', true, 'Animate scrolling.', { type: 'boolean' }],
  ['editor.mouseWheelZoom', true, 'Zoom the editor font with Ctrl + mouse wheel.', { type: 'boolean' }],
  ['editor.bracketPairColorization.enabled', true, 'Colorize matching bracket pairs.', { type: 'boolean' }],
  ['editor.guides.bracketPairs', 'active', 'Bracket pair guides.', { enum: ['true', 'active', 'false'] }],
  ['editor.guides.indentation', true, 'Render indent guides.', { type: 'boolean' }],
  ['editor.stickyScroll.enabled', true, 'Show nested scopes at the top of the editor while scrolling.', { type: 'boolean' }],
  ['editor.folding', true, 'Enable code folding.', { type: 'boolean' }],
  ['editor.renderLineHighlight', 'all', 'How the current line is highlighted.', { enum: ['none', 'gutter', 'line', 'all'] }],
  ['editor.scrollBeyondLastLine', true, 'Allow scrolling past the last line.', { type: 'boolean' }],
  ['editor.autoClosingBrackets', 'languageDefined', 'Auto-close brackets.', { enum: ['always', 'languageDefined', 'beforeWhitespace', 'never'] }],
  ['editor.autoClosingQuotes', 'languageDefined', 'Auto-close quotes.', { enum: ['always', 'languageDefined', 'beforeWhitespace', 'never'] }],
  ['editor.linkedEditing', true, 'Rename matching HTML tags together.', { type: 'boolean' }],
  ['editor.formatOnSave', false, 'Format the file when saving (if a formatter is available).', { type: 'boolean' }],
  ['editor.formatOnPaste', false, 'Format pasted content.', { type: 'boolean' }],
  ['editor.formatOnType', false, 'Format the line after typing.', { type: 'boolean' }],
  ['editor.quickSuggestions', true, 'Show suggestions while typing.', { type: 'boolean' }],
  ['editor.suggestOnTriggerCharacters', true, 'Show suggestions on trigger characters such as "."', { type: 'boolean' }],
  ['editor.acceptSuggestionOnEnter', 'on', 'Accept suggestions with Enter.', { enum: ['on', 'smart', 'off'] }],
  ['editor.parameterHints.enabled', true, 'Show parameter hints while typing.', { type: 'boolean' }],
  ['editor.hover.enabled', true, 'Show hovers.', { type: 'boolean' }],
  ['editor.codeLens', true, 'Show CodeLens.', { type: 'boolean' }],
  ['editor.colorDecorators', true, 'Render inline color swatches for CSS colors.', { type: 'boolean' }],
  ['editor.multiCursorModifier', 'alt', 'Modifier used to add cursors with the mouse.', { enum: ['alt', 'ctrlCmd'] }],
  ['editor.dragAndDrop', true, 'Allow moving selections via drag and drop.', { type: 'boolean' }],
  ['editor.emptySelectionClipboard', true, 'Copy the current line when nothing is selected.', { type: 'boolean' }],
  ['editor.inlayHints.enabled', 'on', 'Show inlay hints.', { enum: ['on', 'off', 'onUnlessPressed', 'offUnlessPressed'] }],
  ['editor.padding.top', 6, 'Space above the first line in pixels.', { type: 'number' }],
  ['editor.gitDecorations', true, 'Show git change markers in the gutter.', { type: 'boolean' }],
  ['editor.unicodeHighlight.ambiguousCharacters', true, 'Highlight ambiguous unicode characters.', { type: 'boolean' }],

  // ---- Files ----
  ['files.autoSave', 'off', 'Controls auto save of dirty files.', { enum: ['off', 'afterDelay', 'onFocusChange', 'onWindowChange'] }],
  ['files.autoSaveDelay', 1000, 'Delay in ms before an auto save when autoSave is afterDelay.', { type: 'number', min: 100 }],
  ['files.trimTrailingWhitespace', false, 'Trim trailing whitespace on save.', { type: 'boolean' }],
  ['files.insertFinalNewline', false, 'Ensure the file ends with a newline on save.', { type: 'boolean' }],
  ['files.trimFinalNewlines', false, 'Trim extra newlines at the end of the file on save.', { type: 'boolean' }],
  ['files.eol', 'auto', 'Default end of line for new files.', { enum: ['auto', '\n', '\r\n'] }],
  ['files.exclude', '.git, .DS_Store, Thumbs.db', 'Comma separated names hidden from the explorer.', { type: 'string' }],
  ['files.hotExit', true, 'Remember unsaved changes between sessions.', { type: 'boolean' }],
  ['files.defaultLanguage', 'plaintext', 'Language mode of new untitled files.', { type: 'string' }],

  // ---- Workbench ----
  ['workbench.colorTheme', 'snake-dark', 'Color theme.', { type: 'theme' }],
  ['workbench.sideBar.location', 'left', 'Location of the side bar.', { enum: ['left', 'right'] }],
  ['workbench.activityBar.visible', true, 'Show the activity bar.', { type: 'boolean' }],
  ['workbench.statusBar.visible', true, 'Show the status bar.', { type: 'boolean' }],
  ['workbench.editor.enablePreview', true, 'Single-clicked files open in a reusable preview tab.', { type: 'boolean' }],
  ['workbench.editor.showTabs', true, 'Show editor tabs.', { type: 'boolean' }],
  ['workbench.editor.wrapTabs', false, 'Wrap tabs onto multiple rows instead of scrolling.', { type: 'boolean' }],
  ['workbench.breadcrumbs.enabled', true, 'Show breadcrumbs above the editor.', { type: 'boolean' }],
  ['workbench.startupEditor', 'welcomePage', 'What to show on startup when nothing is restored.', { enum: ['welcomePage', 'newUntitledFile', 'none'] }],
  ['workbench.tree.indent', 10, 'Tree indentation in pixels.', { type: 'number', min: 4, max: 40 }],
  ['workbench.restoreSession', true, 'Restore the last folder and open editors on startup.', { type: 'boolean' }],
  ['window.zoomLevel', 0, 'Window zoom level (0 = 100%, each step is 20%).', { type: 'number', min: -5, max: 8 }],
  ['window.commandCenter', true, 'Show the command center search box in the title bar.', { type: 'boolean' }],

  // ---- Explorer ----
  ['explorer.confirmDelete', true, 'Ask before moving files to the trash.', { type: 'boolean' }],
  ['explorer.confirmDragAndDrop', true, 'Ask before moving files via drag and drop.', { type: 'boolean' }],
  ['explorer.autoReveal', true, 'Reveal the active file in the explorer.', { type: 'boolean' }],
  ['explorer.sortOrder', 'default', 'Sort order of files and folders.', { enum: ['default', 'mixed', 'filesFirst', 'type', 'modified'] }],
  ['explorer.decorations.git', true, 'Color files by their git status.', { type: 'boolean' }],

  // ---- Search ----
  ['search.exclude', 'node_modules, dist, build, *.min.js', 'Comma separated globs excluded from search and quick open.', { type: 'string' }],
  ['search.useIgnoreFiles', true, 'Respect .gitignore when searching.', { type: 'boolean' }],
  ['search.maxResults', 20000, 'Maximum number of search results.', { type: 'number' }],

  // ---- Terminal ----
  ['terminal.integrated.shell', '', 'Path of the shell (empty uses $SHELL).', { type: 'string' }],
  ['terminal.integrated.fontSize', 13, 'Terminal font size.', { type: 'number', min: 6, max: 64 }],
  ['terminal.integrated.fontFamily', '', 'Terminal font family (empty uses the editor font).', { type: 'string' }],
  ['terminal.integrated.cursorStyle', 'block', 'Terminal cursor style.', { enum: ['block', 'underline', 'bar'] }],
  ['terminal.integrated.cursorBlinking', true, 'Blink the terminal cursor.', { type: 'boolean' }],
  ['terminal.integrated.scrollback', 5000, 'Lines of scrollback.', { type: 'number' }],
  ['terminal.integrated.copyOnSelection', false, 'Copy selected terminal text automatically.', { type: 'boolean' }],

  // ---- Git ----
  ['git.enabled', true, 'Enable git integration.', { type: 'boolean' }],
  ['git.autoRefresh', true, 'Refresh git status when files change.', { type: 'boolean' }],
  ['git.confirmSync', true, 'Confirm before pushing/pulling.', { type: 'boolean' }],
  ['git.enableSmartCommit', true, 'Commit all changes when nothing is staged.', { type: 'boolean' }],
  ['git.autofetch', false, 'Periodically fetch from remotes.', { type: 'boolean' }],
];

export const schema = SCHEMA.map(([key, def, description, extra]) => ({
  key,
  default: def,
  description,
  category: key.split('.')[0],
  type: extra.enum ? 'enum' : extra.type,
  ...extra,
}));

const defaults = Object.fromEntries(schema.map((s) => [s.key, s.default]));
let user = {};

export async function loadSettings() {
  user = (await window.snake.store.get('settings')) || {};
  bus.emit('settings:changed', null);
}

export function setUserSettings(obj) {
  const old = user;
  user = obj || {};
  const changed = new Set([...Object.keys(old), ...Object.keys(user)].filter((k) => JSON.stringify(old[k]) !== JSON.stringify(user[k])));
  if (changed.size) bus.emit('settings:changed', changed);
}

export function get(key) {
  return key in user ? user[key] : defaults[key];
}

export function isModified(key) {
  return key in user && JSON.stringify(user[key]) !== JSON.stringify(defaults[key]);
}

export function getDefault(key) {
  return defaults[key];
}

export async function set(key, value) {
  if (JSON.stringify(value) === JSON.stringify(defaults[key])) delete user[key];
  else user[key] = value;
  await window.snake.store.set('settings', user);
  bus.emit('settings:changed', new Set([key]));
}

export async function reset(key) {
  delete user[key];
  await window.snake.store.set('settings', user);
  bus.emit('settings:changed', new Set([key]));
}

/** Subscribe to changes of any of the given keys (or prefix ending in '.'). Fires on full reload too. */
export function onChange(keys, fn) {
  const list = Array.isArray(keys) ? keys : [keys];
  return bus.on('settings:changed', (changed) => {
    if (!changed || [...changed].some((k) => list.some((p) => k === p || (p.endsWith('.') && k.startsWith(p))))) fn(changed);
  });
}
