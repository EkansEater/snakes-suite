// OpenRaster (.ora): the open layered format GIMP, Krita and MyPaint share.
// A zip of PNG layers plus stack.xml. It is also Snake's Photo's own project
// format: our extras (text, effects, masks, adjustment layers) ride along as
// attributes in our own namespace, which other programs simply ignore.
import { readZip, writeZip } from '../../kit/zip.js';
import { parseXml, esc, all, attr } from '../../kit/xml.js';
import { canvasBytes, decodeImage, makeCanvas } from '../../kit/raster.js';

const NS = 'https://snakes-master-suite.local/ora';
const OPS = {
  normal: 'svg:src-over', multiply: 'svg:multiply', screen: 'svg:screen', overlay: 'svg:overlay', darken: 'svg:darken', lighten: 'svg:lighten',
  'color-dodge': 'svg:color-dodge', 'color-burn': 'svg:color-burn', 'hard-light': 'svg:hard-light', 'soft-light': 'svg:soft-light',
  difference: 'svg:difference', exclusion: 'svg:exclusion', hue: 'svg:hue', saturation: 'svg:saturation', color: 'svg:color', luminosity: 'svg:luminosity', add: 'svg:plus',
};
const BLEND_OF = Object.fromEntries(Object.entries(OPS).map(([k, v]) => [v, k]));

const MAX_PARTS = 2000;

export async function readOra(bytes) {
  const zip = readZip(bytes);
  if (zip.size > MAX_PARTS) throw new Error('This file has too many parts.');
  const stack = zip.get('stack.xml');
  if (!stack) throw new Error('This is not an OpenRaster file (no stack.xml).');
  const xml = parseXml(await stack.text());
  const image = all(xml, 'image')[0];
  const width = Number(attr(image, 'w'));
  const height = Number(attr(image, 'h'));
  if (!(width > 0 && height > 0 && width * height <= 16384 * 16384)) throw new Error('The picture size in this file is not valid.');
  const loadPng = async (src) => {
    const part = src && zip.get(src);
    if (!part) return null;
    return decodeImage(await part.read(), 'image/png');
  };
  const layers = [];
  // Nested stacks (groups) are flattened; hidden groups hide their layers.
  const walk = async (el, hidden, opacity) => {
    for (const child of [...el.children]) {
      const vis = attr(child, 'visibility') !== 'hidden';
      const op = Number(attr(child, 'opacity') ?? 1);
      if (child.localName === 'stack') { await walk(child, hidden || !vis, opacity * op); continue; }
      if (child.localName !== 'layer') continue;
      const ext = (k) => child.getAttributeNS(NS, k);
      const json = (k) => { try { const v = ext(k); return v ? JSON.parse(v) : null; } catch { return null; } };
      const kind = ext('kind') || 'pixel';
      const L = {
        name: attr(child, 'name') || 'Layer', x: Number(attr(child, 'x') || 0), y: Number(attr(child, 'y') || 0),
        opacity: op * opacity, visible: vis && !hidden, blend: BLEND_OF[attr(child, 'composite-op')] || 'normal',
        kind, text: json('text'), effects: json('effects'), adjust: json('adjust'), locked: ext('locked') === 'true', lockAlpha: ext('lockAlpha') === 'true',
        canvas: kind === 'adjust' ? null : await loadPng(attr(child, 'src')), mask: await loadPng(ext('mask')), maskOn: ext('maskOn') !== 'false',
      };
      if (!L.canvas && kind !== 'adjust') L.canvas = makeCanvas(width, height);
      layers.push(L);
    }
  };
  const top = all(xml, 'stack')[0];
  if (top) await walk(top, false, 1);
  layers.reverse(); // stack.xml lists the top layer first
  if (!layers.length) {
    const merged = await loadPng('mergedimage.png');
    if (merged) layers.push({ name: 'Background', x: 0, y: 0, opacity: 1, visible: true, blend: 'normal', canvas: merged });
  }
  return { width, height, layers };
}

/** layers bottom first, as in the document; composite is the flattened picture. */
export async function writeOra({ width, height, layers, composite }) {
  const files = [{ name: 'mimetype', data: 'image/openraster', store: true }];
  const entries = [];
  let n = 0;
  for (const L of [...layers].reverse()) {
    n++;
    const a = [`name="${esc(L.name)}"`, `x="${Math.round(L.x || 0)}"`, `y="${Math.round(L.y || 0)}"`, `opacity="${(L.opacity ?? 1).toFixed(3)}"`,
      `visibility="${L.visible === false ? 'hidden' : 'visible'}"`, `composite-op="${OPS[L.blend] || 'svg:src-over'}"`];
    if (L.kind === 'adjust') {
      // Other programs see an empty layer; we see the adjustment.
      const blank = `data/layer${n}.png`;
      files.push({ name: blank, data: await canvasBytes(makeCanvas(1, 1), 'image/png'), store: true });
      a.push(`src="${blank}"`);
    } else {
      const src = `data/layer${n}.png`;
      files.push({ name: src, data: await canvasBytes(L.canvas, 'image/png'), store: true });
      a.push(`src="${src}"`);
    }
    if (L.kind && L.kind !== 'pixel') a.push(`snake:kind="${esc(L.kind)}"`);
    if (L.text) a.push(`snake:text="${esc(JSON.stringify(L.text))}"`);
    if (L.effects) a.push(`snake:effects="${esc(JSON.stringify(L.effects))}"`);
    if (L.adjust) a.push(`snake:adjust="${esc(JSON.stringify(L.adjust))}"`);
    if (L.locked) a.push('snake:locked="true"');
    if (L.lockAlpha) a.push('snake:lockAlpha="true"');
    if (L.mask) {
      const src = `data/mask${n}.png`;
      files.push({ name: src, data: await canvasBytes(L.mask, 'image/png'), store: true });
      a.push(`snake:mask="${src}"`, `snake:maskOn="${L.maskOn !== false}"`);
    }
    entries.push(`  <layer ${a.join(' ')}/>`);
  }
  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<image version="0.0.5" w="${width}" h="${height}" xmlns:snake="${NS}">\n <stack>\n${entries.join('\n')}\n </stack>\n</image>\n`;
  files.splice(1, 0, { name: 'stack.xml', data: xml });
  files.push({ name: 'mergedimage.png', data: await canvasBytes(composite, 'image/png'), store: true });
  const s = Math.min(1, 256 / Math.max(width, height));
  const th = makeCanvas(Math.max(1, Math.round(width * s)), Math.max(1, Math.round(height * s)));
  const tctx = th.getContext('2d');
  tctx.imageSmoothingQuality = 'high';
  tctx.drawImage(composite, 0, 0, th.width, th.height);
  files.push({ name: 'Thumbnails/thumbnail.png', data: await canvasBytes(th, 'image/png'), store: true });
  return writeZip(files);
}
