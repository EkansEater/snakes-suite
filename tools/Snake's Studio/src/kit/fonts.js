// Which fonts this computer has, for the font boxes.
import { inElectron } from './host.js';

const CANDIDATES = [
  'Aptos', 'Arial', 'Arial Black', 'Avenir', 'Baskerville', 'Bookman Old Style', 'Calibri', 'Cambria', 'Candara', 'Cantarell',
  'Caladea', 'Carlito', 'Century Gothic', 'Comic Sans MS', 'Consolas', 'Constantia', 'Corbel', 'Courier New', 'DejaVu Sans',
  'DejaVu Sans Mono', 'DejaVu Serif', 'Didot', 'Fira Code', 'Fira Sans', 'Franklin Gothic Medium', 'Futura', 'Garamond',
  'Georgia', 'Gill Sans', 'Helvetica', 'Helvetica Neue', 'Hoefler Text', 'Impact', 'Inter', 'JetBrains Mono',
  'Liberation Mono', 'Liberation Sans', 'Liberation Serif', 'Lucida Console', 'Lucida Sans Unicode', 'Menlo', 'Monaco',
  'Noto Sans', 'Noto Serif', 'Noto Sans Mono', 'Open Sans', 'Optima', 'Palatino', 'Palatino Linotype', 'Roboto',
  'Roboto Mono', 'Roboto Slab', 'Segoe Print', 'Segoe Script', 'Segoe UI', 'SF Pro Text', 'Source Code Pro',
  'Source Sans Pro', 'Source Serif Pro', 'Tahoma', 'Times New Roman', 'Trebuchet MS', 'Ubuntu', 'Ubuntu Mono', 'Verdana',
];

let cached = null;
let full = null;

function has(font, ctx) {
  const text = 'mmmmmmmmmmlli1WQ@#';
  for (const base of ['monospace', 'serif', 'sans-serif']) {
    ctx.font = `72px ${base}`;
    const w0 = ctx.measureText(text).width;
    ctx.font = `72px "${font}", ${base}`;
    if (ctx.measureText(text).width !== w0) return true;
  }
  return false;
}

/** Installed fonts from a list of well-known ones (quick, needs no permission). */
export function knownFonts() {
  if (cached) return cached;
  const ctx = document.createElement('canvas').getContext('2d');
  cached = CANDIDATES.filter((f) => has(f, ctx));
  return cached;
}

/** Every installed font family (asks the system, where the browser allows it). */
export async function allFonts() {
  if (full) return full;
  const set = new Set(knownFonts());
  if (window.queryLocalFonts && inElectron) {
    try {
      for (const f of await window.queryLocalFonts()) set.add(f.family);
    } catch {}
  }
  full = [...set].sort((a, b) => a.localeCompare(b));
  return full;
}

export const FONT_SIZES = [8, 9, 10, 10.5, 11, 12, 14, 16, 18, 20, 22, 24, 26, 28, 32, 36, 40, 48, 56, 64, 72, 96];
