// Phones: a row of the keys a touch keyboard lacks (Esc, Tab, Ctrl, Alt, arrows…), and
// pinching to change the text size.
import { el, bus } from './util.js';
import { activeSession } from './layout.js';
import { fontZoom, setFontZoom } from './session.js';

/** Sticky modifiers: tap Ctrl, then a letter on the keyboard, for Ctrl+letter. */
export const mods = { ctrl: false, alt: false };

const KEYS = [
  ['Esc', '\x1b'], ['Tab', '\t'], ['Ctrl', 'ctrl'], ['Alt', 'alt'],
  ['←', 'D'], ['↓', 'B'], ['↑', 'A'], ['→', 'C'],
  ['Home', '\x1b[H'], ['End', '\x1b[F'], ['PgUp', '\x1b[5~'], ['PgDn', '\x1b[6~'],
  ['|', '|'], ['-', '-'], ['/', '/'], ['~', '~'], ['Paste', 'paste'],
];

export function initTouchKeys(parent) {
  const bar = el('div.touchkeys');
  for (const [label, what] of KEYS) {
    const b = el('button.touchkey', { text: label, dataset: { key: what } });
    // Pressing a key must not take the focus (and the keyboard) away from the terminal.
    b.addEventListener('pointerdown', (e) => e.preventDefault());
    b.addEventListener('click', () => press(what));
    bar.append(b);
  }
  parent.append(bar);
  bus.on('mods', () => {
    bar.querySelector('[data-key=ctrl]').classList.toggle('on', mods.ctrl);
    bar.querySelector('[data-key=alt]').classList.toggle('on', mods.alt);
  });
  pinch(parent);
}

function press(what) {
  const s = activeSession();
  if (!s) return;
  if (what === 'ctrl' || what === 'alt') { mods[what] = !mods[what]; bus.emit('mods'); s.focus(); return; }
  if (what === 'paste') { s.paste(); s.focus(); return; }
  let seq = what;
  if (what.length === 1 && 'ABCD'.includes(what)) seq = (s.term.modes.applicationCursorKeysMode ? '\x1bO' : '\x1b[') + what;
  s.term.input(applyMods(seq), true);
  s.focus();
}

/** Ctrl and Alt for the next key typed on the touch keyboard. */
export function applyMods(data) {
  if (!mods.ctrl && !mods.alt) return data;
  let out = data;
  if (mods.ctrl && data.length === 1) {
    const c = data.toUpperCase().charCodeAt(0);
    if (c >= 64 && c <= 95) out = String.fromCharCode(c - 64);
    else if (data === ' ') out = '\x00';
    else if (data === '?') out = '\x7f';
  }
  if (mods.alt) out = '\x1b' + out;
  mods.ctrl = mods.alt = false;
  bus.emit('mods');
  return out;
}

function pinch(root) {
  let start = 0;
  let base = 0;
  const dist = (t) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  root.addEventListener('touchstart', (e) => {
    if (e.touches.length === 2) { start = dist(e.touches); base = fontZoom; }
  }, { passive: true });
  root.addEventListener('touchmove', (e) => {
    if (e.touches.length !== 2 || !start) return;
    e.preventDefault();
    setFontZoom(base + Math.round(Math.log2(dist(e.touches) / start) * 6));
  }, { passive: false });
  root.addEventListener('touchend', (e) => { if (e.touches.length < 2) start = 0; });
}
