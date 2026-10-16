// Keyboard shortcuts: one notation everywhere ("Ctrl+Shift+S"), shown with the
// right names on each system (Ctrl becomes Cmd on macOS).
import { isMac } from './dom.js';

const NAMES = {
  ' ': 'Space', arrowup: 'Up', arrowdown: 'Down', arrowleft: 'Left', arrowright: 'Right', escape: 'Esc',
  delete: 'Delete', backspace: 'Backspace', enter: 'Enter', tab: 'Tab', pageup: 'PageUp', pagedown: 'PageDown',
  home: 'Home', end: 'End', insert: 'Insert', '+': '=', add: '=', subtract: '-',
};

/** The shortcut an event stands for, in our notation, or '' for a bare modifier. */
export function eventKeys(e) {
  let k = e.key;
  if (!k || ['Control', 'Shift', 'Alt', 'Meta', 'AltGraph'].includes(k)) return '';
  // Use the physical key for letters and digits, so Shift and layouts don't change the name.
  if (/^Key[A-Z]$/.test(e.code)) k = e.code.slice(3);
  else if (/^Digit\d$/.test(e.code)) k = e.code.slice(5);
  else if (e.code === 'Equal') k = '=';
  else if (e.code === 'Minus') k = '-';
  else if (e.code === 'BracketLeft') k = '[';
  else if (e.code === 'BracketRight') k = ']';
  else if (e.code === 'Slash') k = '/';
  else if (e.code === 'Backslash') k = '\\';
  else if (e.code === 'Comma') k = ',';
  else if (e.code === 'Period') k = '.';
  else if (e.code === 'Semicolon') k = ';';
  else if (e.code === 'Quote') k = "'";
  else if (e.code === 'Backquote') k = '`';
  else if (e.code === 'NumpadAdd') k = '=';
  else if (e.code === 'NumpadSubtract') k = '-';
  else k = NAMES[k.toLowerCase()] || (k.length === 1 ? k.toUpperCase() : k);
  const parts = [];
  if (isMac ? e.metaKey : e.ctrlKey) parts.push('Ctrl');
  if (isMac && e.ctrlKey) parts.push('Meta');
  if (!isMac && e.metaKey) parts.push('Meta');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');
  parts.push(k);
  return parts.join('+');
}

/** Normalise a written shortcut ("ctrl+shift+p") to the notation eventKeys produces. */
export function normKeys(keys) {
  if (!keys) return '';
  const parts = keys.split('+').map((p) => p.trim()).filter(Boolean);
  const key = parts.pop();
  const mods = new Set(parts.map((p) => p.toLowerCase()));
  const out = [];
  if (mods.has('ctrl') || mods.has('cmd') || mods.has('mod')) out.push('Ctrl');
  if (mods.has('meta')) out.push('Meta');
  if (mods.has('alt') || mods.has('option')) out.push('Alt');
  if (mods.has('shift')) out.push('Shift');
  const low = key.toLowerCase();
  out.push(NAMES[low] || (key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1)));
  return out.join('+');
}

/** How a shortcut is shown to people on this system. */
export function formatKeys(keys) {
  if (!keys) return '';
  const k = normKeys(keys);
  if (!isMac) return k;
  return k.replace('Ctrl+', '⌘').replace('Meta+', '⌃').replace('Alt+', '⌥').replace('Shift+', '⇧');
}
