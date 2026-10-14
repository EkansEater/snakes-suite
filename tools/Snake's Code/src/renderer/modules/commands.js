// Command registry and keybinding dispatcher.
import { bus, isMac } from './util.js';

const commands = new Map();
let defaultBindings = []; // { key, command, args?, when? }
let userBindings = [];
let effective = [];

/**
 * Register a command.
 * @param {{id:string,title:string,category?:string,run:Function,key?:string|string[],when?:Function,
 *          inTerminal?:boolean, inEditor?:boolean, hidden?:boolean, icon?:string}} cmd
 *  - inTerminal: keybinding also fires while the integrated terminal has focus
 */
export function registerCommand(cmd) {
  commands.set(cmd.id, cmd);
  const keys = cmd.key ? (Array.isArray(cmd.key) ? cmd.key : [cmd.key]) : [];
  for (const key of keys) defaultBindings.push({ key: normalizeKey(key), command: cmd.id, when: cmd.when });
  scheduleRecompute();
  return cmd;
}

export function registerCommands(list) {
  list.forEach(registerCommand);
}

export function getCommand(id) {
  return commands.get(id);
}

export function allCommands() {
  return [...commands.values()].filter((c) => !c.hidden);
}

export async function executeCommand(id, ...args) {
  const cmd = commands.get(id);
  if (!cmd) {
    bus.emit('command:missing', id);
    return;
  }
  try {
    bus.emit('command:executed', id);
    return await cmd.run(...args);
  } catch (err) {
    console.error(err);
    bus.emit('notify', { type: 'error', message: `Command "${cmd.title}" failed: ${err.message || err}` });
  }
}

let recomputeQueued = false;
function scheduleRecompute() {
  if (recomputeQueued) return;
  recomputeQueued = true;
  queueMicrotask(() => {
    recomputeQueued = false;
    recompute();
  });
}

function recompute() {
  // user bindings override defaults: "-command" removes a default binding
  const removed = new Set(userBindings.filter((b) => b.command?.startsWith('-')).map((b) => b.command.slice(1) + '|' + normalizeKey(b.key || '')));
  const removedAll = new Set(userBindings.filter((b) => b.command?.startsWith('-') && !b.key).map((b) => b.command.slice(1)));
  effective = [
    ...defaultBindings.filter((b) => !removed.has(b.command + '|' + b.key) && !removedAll.has(b.command)),
    ...userBindings.filter((b) => b.key && b.command && !b.command.startsWith('-')).map((b) => ({ ...b, key: normalizeKey(b.key), user: true })),
  ];
  bus.emit('keybindings:changed');
}

export function setUserKeybindings(list) {
  userBindings = Array.isArray(list) ? list : [];
  recompute();
}

export function getBindings() {
  return effective;
}

export function keybindingFor(id) {
  // the most recent user binding wins, otherwise the primary (first) default binding
  for (let i = effective.length - 1; i >= 0; i--) if (effective[i].command === id && effective[i].user) return effective[i].key;
  return effective.find((b) => b.command === id)?.key || null;
}

const KEY_LABELS = {
  ctrl: isMac ? '⌃' : 'Ctrl', shift: isMac ? '⇧' : 'Shift', alt: isMac ? '⌥' : 'Alt', meta: isMac ? '⌘' : 'Super',
  left: '←', right: '→', up: '↑', down: '↓', escape: 'Esc', pageup: 'PageUp', pagedown: 'PageDown',
  enter: 'Enter', tab: 'Tab', space: 'Space', backspace: 'Backspace', delete: 'Delete', '`': '`',
};

export function formatKey(key) {
  if (!key) return '';
  return key
    .split(' ')
    .map((part) =>
      part
        .split('+')
        .map((k) => KEY_LABELS[k] || (k.length === 1 ? k.toUpperCase() : k.toUpperCase()))
        .join(isMac ? '' : '+'),
    )
    .join(' ');
}

export function keyLabelFor(id) {
  return formatKey(keybindingFor(id));
}

const MOD_ORDER = ['ctrl', 'shift', 'alt', 'meta'];
export function normalizeKey(key) {
  return key
    .toLowerCase()
    .trim()
    .split(/\s+/)
    .map((chord) => {
      const parts = chord.split('+').map((p) => (p === 'cmd' || p === 'super' || p === 'win' ? 'meta' : p === 'control' ? 'ctrl' : p === 'option' ? 'alt' : p));
      const mods = MOD_ORDER.filter((m) => parts.includes(m));
      const rest = parts.filter((p) => !MOD_ORDER.includes(p));
      return [...mods, ...rest].join('+');
    })
    .join(' ');
}

const CODE_MAP = {
  Backquote: '`', Backslash: '\\', Comma: ',', Equal: '=', Minus: '-', Period: '.', Slash: '/',
  BracketLeft: '[', BracketRight: ']', Semicolon: ';', Quote: "'", Space: 'space', Enter: 'enter',
  NumpadEnter: 'enter', Escape: 'escape', Tab: 'tab', Backspace: 'backspace', Delete: 'delete',
  ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down', PageUp: 'pageup',
  PageDown: 'pagedown', Home: 'home', End: 'end', Insert: 'insert', NumpadAdd: '=', NumpadSubtract: '-',
};

export function eventToKey(e) {
  let k;
  if (/^Key[A-Z]$/.test(e.code)) k = e.code.slice(3).toLowerCase();
  else if (/^Digit\d$/.test(e.code)) k = e.code.slice(5);
  else if (/^F\d+$/.test(e.code)) k = e.code.toLowerCase();
  else if (CODE_MAP[e.code]) k = CODE_MAP[e.code];
  else k = (e.key || '').toLowerCase();
  if (['control', 'shift', 'alt', 'meta'].includes(k) || /^(Control|Shift|Alt|Meta)(Left|Right)$/.test(e.code)) return null;
  const mods = [];
  if (e.ctrlKey) mods.push('ctrl');
  if (e.shiftKey) mods.push('shift');
  if (e.altKey) mods.push('alt');
  if (e.metaKey) mods.push('meta');
  return [...mods, k].join('+');
}

// ---- dispatcher ----
let pendingChord = null;
let chordTimer = null;

function contextOf(target) {
  if (target?.closest?.('.monaco-editor, .monaco-diff-editor')) return 'editor';
  if (target?.closest?.('.xterm')) return 'terminal';
  if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return 'input';
  return 'workbench';
}

export function installKeyDispatcher() {
  window.addEventListener(
    'keydown',
    (e) => {
      const key = eventToKey(e);
      if (!key) return;
      const ctx = contextOf(e.target);
      // Monaco dispatches its own copies of our bindings (see editors.js)
      if (ctx === 'editor') return;
      const full = pendingChord ? `${pendingChord} ${key}` : key;
      const candidates = effective.filter((b) => b.key === full || b.key.startsWith(full + ' '));
      const exact = [...candidates].reverse().find((b) => b.key === full && isEnabled(b, ctx));
      const isChordPrefix = candidates.some((b) => b.key !== full && isEnabled(b, ctx));
      if (exact && !isChordPrefix) {
        e.preventDefault();
        e.stopPropagation();
        clearChord();
        executeCommand(exact.command, ...(exact.args !== undefined ? [exact.args] : []));
        return;
      }
      if (isChordPrefix && !pendingChord) {
        e.preventDefault();
        e.stopPropagation();
        pendingChord = key;
        bus.emit('chord', formatKey(key));
        chordTimer = setTimeout(clearChord, 3000);
        return;
      }
      if (pendingChord) {
        e.preventDefault();
        e.stopPropagation();
        bus.emit('notify', { type: 'info', message: `The key combination (${formatKey(full)}) is not a command.`, timeout: 2500 });
        clearChord();
      }
    },
    true,
  );
}

function clearChord() {
  pendingChord = null;
  clearTimeout(chordTimer);
  bus.emit('chord', null);
}

function isEnabled(binding, ctx) {
  const cmd = commands.get(binding.command);
  if (!cmd) return false;
  if (ctx === 'terminal' && !cmd.inTerminal) return false;
  if (ctx === 'input' && cmd.notInInput) return false;
  if (binding.when && !binding.when()) return false;
  return true;
}
