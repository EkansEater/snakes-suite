// Keyboard shortcuts. On a Mac they are iTerm's (Cmd+…); elsewhere Ctrl+Shift+…, so plain
// Ctrl+letter keys keep reaching the shell (Ctrl+C, Ctrl+D, Ctrl+R…). All can be changed.
import { platform } from './util.js';
import { settings } from './settings.js';

// command id -> [mac keys, other keys]
export const DEFAULT_KEYS = {
  'tab.new': [['Cmd+T'], ['Ctrl+Shift+T']],
  'window.new': [['Cmd+N'], ['Ctrl+Shift+N']],
  'pane.close': [['Cmd+W'], ['Ctrl+Shift+W']],
  'pane.splitRight': [['Cmd+D'], ['Ctrl+Shift+D']],
  'pane.splitDown': [['Cmd+Shift+D'], ['Ctrl+Shift+E']],
  'pane.maximize': [['Cmd+Shift+Enter'], ['Ctrl+Shift+Enter']],
  'pane.left': [['Cmd+Alt+Left'], ['Ctrl+Alt+Left']],
  'pane.right': [['Cmd+Alt+Right'], ['Ctrl+Alt+Right']],
  'pane.up': [['Cmd+Alt+Up'], ['Ctrl+Alt+Up']],
  'pane.down': [['Cmd+Alt+Down'], ['Ctrl+Alt+Down']],
  'pane.next': [['Cmd+]'], ['Ctrl+Alt+]']],
  'pane.prev': [['Cmd+['], ['Ctrl+Alt+[']],
  'pane.broadcast': [['Cmd+Alt+I'], ['Ctrl+Shift+I']],
  'tab.next': [['Cmd+Shift+]', 'Ctrl+Tab'], ['Ctrl+PageDown', 'Ctrl+Tab']],
  'tab.prev': [['Cmd+Shift+[', 'Ctrl+Shift+Tab'], ['Ctrl+PageUp', 'Ctrl+Shift+Tab']],
  'tab.moveLeft': [['Cmd+Shift+Left'], ['Ctrl+Shift+PageUp']],
  'tab.moveRight': [['Cmd+Shift+Right'], ['Ctrl+Shift+PageDown']],
  'tab.rename': [['Cmd+Shift+I'], ['Ctrl+Shift+R']],
  ...Object.fromEntries([1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => [`tab.goto${n}`, [[`Cmd+${n}`], [`Alt+${n}`]]])),
  'edit.copy': [['Cmd+C'], ['Ctrl+Shift+C']],
  'edit.paste': [['Cmd+V'], ['Ctrl+Shift+V', 'Shift+Insert']],
  'edit.selectAll': [['Cmd+A'], ['Ctrl+Shift+A']],
  'edit.copyOneLine': [['Cmd+Alt+C'], ['Ctrl+Alt+C']],
  'edit.pasteSelection': [['Cmd+Shift+V'], []],
  'term.export': [['Cmd+S'], ['Ctrl+Shift+S']],
  'menu.open': [['Cmd+Shift+M'], ['Ctrl+Shift+M']],
  'find.open': [['Cmd+F'], ['Ctrl+Shift+F']],
  'term.clear': [['Cmd+K'], ['Ctrl+Shift+K']],
  'term.scrollTop': [['Cmd+Home'], ['Ctrl+Shift+Home']],
  'term.scrollBottom': [['Cmd+End'], ['Ctrl+Shift+End']],
  'term.pageUp': [['Shift+PageUp'], ['Shift+PageUp']],
  'term.pageDown': [['Shift+PageDown'], ['Shift+PageDown']],
  'font.bigger': [['Cmd+=', 'Cmd+Shift+='], ['Ctrl+=', 'Ctrl+Shift+=']],
  'font.smaller': [['Cmd+-'], ['Ctrl+-']],
  'font.reset': [['Cmd+0'], ['Ctrl+0']],
  'devices.toggle': [['Cmd+Shift+O'], ['Ctrl+Shift+O']],
  'palette.open': [['Cmd+Shift+P'], ['Ctrl+Shift+P']],
  'prefs.open': [['Cmd+,'], ['Ctrl+,']],
  'window.fullscreen': [['Ctrl+Cmd+F'], ['F11']],
};

export function keysFor(id) {
  if (settings.keys[id] != null) return settings.keys[id] ? [settings.keys[id]] : [];
  const d = DEFAULT_KEYS[id];
  return d ? d[platform.mac ? 0 : 1] : [];
}

export function keyLabel(id) {
  const k = keysFor(id)[0];
  if (!k) return '';
  if (!platform.mac) return k;
  return k.replace('Cmd+', '⌘').replace('Ctrl+', '⌃').replace('Alt+', '⌥').replace('Shift+', '⇧');
}

const CODES = {
  BracketLeft: '[', BracketRight: ']', Equal: '=', Minus: '-', Comma: ',', Period: '.', Slash: '/', Backslash: '\\',
  Backquote: '`', Semicolon: ';', Quote: "'", ArrowLeft: 'Left', ArrowRight: 'Right', ArrowUp: 'Up', ArrowDown: 'Down',
  NumpadAdd: '=', NumpadSubtract: '-', NumpadEnter: 'Enter',
};

/** 'Ctrl+Shift+T' for a key event (by physical key, so it works on every keyboard layout). */
export function eventKey(e) {
  let key;
  if (e.code.startsWith('Key')) key = e.code.slice(3);
  else if (e.code.startsWith('Digit')) key = e.code.slice(5);
  else if (/^Numpad\d$/.test(e.code)) key = e.code.slice(6);
  else key = CODES[e.code] || e.key;
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(key)) return '';
  if (key === ' ') key = 'Space';
  const parts = [];
  if (e.ctrlKey) parts.push('Ctrl');
  if (e.metaKey) parts.push('Cmd');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(key.length === 1 ? key.toUpperCase() : key);
  return normalize(parts.join('+'));
}

/** One spelling per shortcut: modifiers in a fixed order. */
export function normalize(k) {
  const parts = k.split('+');
  const key = parts.pop();
  const order = ['Ctrl', 'Cmd', 'Alt', 'Shift'];
  return [...order.filter((m) => parts.includes(m)), key.length === 1 ? key.toUpperCase() : key].join('+');
}

let table = null;
export function rebuild() {
  table = new Map();
  for (const id of Object.keys({ ...DEFAULT_KEYS, ...settings.keys })) {
    for (const k of keysFor(id)) table.set(normalize(k), id);
  }
}

/** The command a key event is bound to, if any. */
export function commandFor(e) {
  if (!table) rebuild();
  const k = eventKey(e);
  return k ? table.get(k) || null : null;
}
