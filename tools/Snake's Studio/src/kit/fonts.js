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

// Free fonts with the same letter widths as common Office fonts, so a document keeps its
// line and page breaks on a computer without them (and the kind of font when none is there).
const SUBSTITUTES = {
  calibri: ['Carlito'], cambria: ['Caladea'], aptos: ['Carlito', 'Calibri'],
  'times new roman': ['Liberation Serif', 'Tinos', 'Times'], times: ['Times New Roman', 'Liberation Serif', 'Tinos'],
  arial: ['Liberation Sans', 'Arimo', 'Helvetica'], helvetica: ['Arial', 'Liberation Sans', 'Arimo'],
  'courier new': ['Liberation Mono', 'Cousine', 'Courier'], courier: ['Courier New', 'Liberation Mono'],
  georgia: ['Gelasio'], 'segoe ui': ['Selawik', 'Noto Sans'], consolas: ['Inconsolata', 'DejaVu Sans Mono'],
  verdana: ['DejaVu Sans'], tahoma: ['DejaVu Sans'], 'century gothic': ['URW Gothic', 'TeX Gyre Adventor'],
  garamond: ['EB Garamond'], 'book antiqua': ['TeX Gyre Pagella', 'Palatino'], 'palatino linotype': ['TeX Gyre Pagella', 'Palatino'],
};

/** The kind of font a name suggests: 'serif', 'monospace' or 'sans-serif'. */
export function genericOf(name) {
  const n = String(name || '').toLowerCase();
  if (/mono|consol|courier|menlo|code|typewriter/.test(n)) return 'monospace';
  if (/times|georgia|garamond|cambria|caladea|serif|book|palatino|minion|baskerville|didot|bodoni|century schoolbook|constantia/.test(n) && !/sans/.test(n)) return 'serif';
  return 'sans-serif';
}

/** A CSS font-family list for a font name: the font, its look-alikes, then its kind. */
export function fontStack(name, sansFallback = 'sans-serif') {
  const n = String(name || '').replace(/["']/g, '').trim();
  if (!n) return sansFallback;
  const subs = SUBSTITUTES[n.toLowerCase()] || [];
  const g = genericOf(n);
  return [n, ...subs].map((f) => `"${f}"`).concat(g === 'sans-serif' ? sansFallback : g).join(', ');
}
