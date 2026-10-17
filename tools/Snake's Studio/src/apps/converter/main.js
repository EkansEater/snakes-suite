// Snake's Converter for the browser and the iPhone: drop files in, pick a format, press
// Convert. Pictures, sound, video, documents and spreadsheets, converted on this device
// with the browser's own codecs and the Studio apps' readers and writers. Nothing is
// uploaded. The desktop and Android Converters (ffmpeg, LibreOffice) do more formats.
import { h, uid, extOf, baseName } from '../../kit/dom.js';
import { icon } from '../../kit/icons.js';
import { host, decodeText } from '../../kit/host.js';
import * as commands from '../../kit/commands.js';
import { createShell, tb, sep, select, onDropFiles, refresh } from '../../kit/shell.js';
import { contextMenu, closeMenus } from '../../kit/menu.js';
import { toast, errorToast } from '../../kit/dialogs.js';
import { decodeImage, canvasBytes, resized, IMAGE_TYPES } from '../../kit/raster.js';
import { GifEncoder } from '../../kit/gif.js';
import { writeZip } from '../../kit/zip.js';
import { htmlToPdf, imagesToPdf } from '../../kit/pdf.js';
import { sanitizeToString } from '../../kit/sanitize.js';
import { readDocx, writeDocx, readOdt } from '../word/docx.js';
import { markdownToHtml, htmlToMarkdown, htmlToText, textToHtml, rtfToHtml } from '../word/markdown.js';
import { defaultMeta } from '../word/editor.js';
import { readXlsx, writeXlsx, bookFromCSV, toCSV } from '../sheets/io.js';
import { readPsd } from '../photo/psd.js';
import { readOra } from '../photo/ora.js';
import { PhotoDoc, newLayer, renderText, Compositor } from '../photo/doc.js';
import { decodeAudio, encodeWav, encodeFlac, encodeOpus, canOpus } from './audio.js';
import { transcode, videoToGif, videoTypes } from './video.js';

const settings = host.settings;
const OPUS = await canOpus();
const VIDEO = videoTypes();
const canWrite = (mime) => { const c = document.createElement('canvas'); c.width = c.height = 1; return c.toDataURL(mime).startsWith(`data:${mime}`); };
const AVIF = canWrite('image/avif');

// What each kind of file reads and can become.
const KINDS = {
  image: {
    label: 'Pictures', icon: 'image',
    exts: ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif', 'ico', 'avif', 'svg', 'psd', 'ora', 'heic', 'heif'],
    outs: ['png', 'jpg', 'webp', ...(AVIF ? ['avif'] : []), 'bmp', 'gif', 'ico', 'pdf'],
  },
  audio: {
    label: 'Sound', icon: 'music',
    exts: ['mp3', 'wav', 'flac', 'ogg', 'oga', 'opus', 'm4a', 'aac', 'aiff', 'aif', 'caf', 'wma', 'amr'],
    outs: ['wav', 'flac', ...(OPUS ? ['opus'] : [])],
  },
  video: {
    label: 'Videos', icon: 'video',
    exts: ['mp4', 'm4v', 'webm', 'mov', 'mkv', 'ogv', '3gp', 'avi'],
    outs: [...VIDEO.map(([e]) => e), 'gif', 'wav', 'flac', ...(OPUS ? ['opus'] : [])],
  },
  doc: {
    label: 'Documents', icon: 'fileText',
    exts: ['docx', 'odt', 'md', 'markdown', 'html', 'htm', 'txt', 'rtf'],
    outs: ['pdf', 'docx', 'html', 'md', 'txt'],
  },
  sheet: {
    label: 'Spreadsheets', icon: 'table',
    exts: ['xlsx', 'csv', 'tsv', 'json'],
    outs: ['xlsx', 'csv', 'tsv', 'json', 'pdf', 'html'],
  },
};
const NOT_HERE = { pdf: 'PDF files', pptx: 'presentations', ppt: 'presentations', odp: 'presentations', doc: 'old Word files', xls: 'old Excel files', ods: 'OpenDocument spreadsheets', tif: 'TIFF pictures', tiff: 'TIFF pictures' };
const kindOf = (ext) => Object.keys(KINDS).find((k) => KINDS[k].exts.includes(ext)) || null;
const LABEL = { jpg: 'JPEG', md: 'Markdown', txt: 'Plain text', opus: 'Opus', docx: 'Word (DOCX)', xlsx: 'Excel (XLSX)', json: 'JSON', html: 'Web page (HTML)', pdf: 'PDF', ico: 'Icon (ICO)' };
const label = (e) => LABEL[e] || e.toUpperCase();
const MIME = { pdf: 'application/pdf', wav: 'audio/wav', flac: 'audio/flac', opus: 'audio/ogg', mp4: 'video/mp4', webm: 'video/webm', gif: 'image/gif',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  html: 'text/html', md: 'text/markdown', txt: 'text/plain', csv: 'text/csv', tsv: 'text/tab-separated-values', json: 'application/json', ico: 'image/x-icon', ...IMAGE_TYPES };

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------
const shell = await createShell({
  id: 'converter', name: "Snake's Converter",
  menus: [
    { label: '&File', items: () => [I('conv.add'), I('conv.clear'), { type: 'separator' }, I('conv.go'), I('conv.saveAll')] },
    { label: '&View', items: () => [I('view.themeDark'), I('view.themeLight'), I('view.themeSystem'), I('view.fullscreen')] },
    { label: '&Help', items: () => [I('app.palette'), I('app.shortcuts'), { type: 'separator' }, I('app.about')] },
  ],
  about: 'Converts pictures, sound, video, documents and spreadsheets on this device: nothing is uploaded. '
    + 'The desktop and Android Converters (with ffmpeg) also make MP3, AAC, MKV and more, convert video much faster, and read PDFs and presentations.',
});
const I = (id, extra) => commands.item(id, extra);

/** { id, file, name, ext, kind, size, status, progress, outputs: [{ name, data }] } */
let items = [];
let busy = false;
let abort = null;

const C = (id, lbl, keys, run, extra = {}) => ({ id, label: lbl, keys, run, ...extra });
commands.register(
  C('conv.add', 'Add Files…', 'Ctrl+O', async () => add(await host.openFiles({ multiple: true, filters: [{ name: 'Files to convert', exts: Object.values(KINDS).flatMap((k) => k.exts) }] })), { icon: 'plus', category: 'File' }),
  C('conv.clear', 'Clear the List', null, () => { if (!busy) { items = []; paint(); } }, { icon: 'trash', category: 'File', when: () => !busy && items.length > 0 }),
  C('conv.go', 'Convert', 'Ctrl+Enter', () => convertAll(), { icon: 'play', category: 'File', when: () => !busy && items.some((i) => i.kind) }),
  C('conv.cancel', 'Stop Converting', 'Escape', () => abort && abort.abort(), { icon: 'stop', category: 'File', when: () => busy }),
  C('conv.saveAll', 'Save Everything as a ZIP…', 'Ctrl+S', () => saveAll(), { icon: 'save', category: 'File', when: () => items.some((i) => i.outputs.length) }),
);

const list = h('div.cv-list');
const targets = h('div.cv-targets');
const drop = h('div.cv-drop',
  h('div', { html: icon('import', 40) }),
  h('h2', 'Drop files here'),
  h('p.muted', 'Pictures, sound, video, documents and spreadsheets. They are converted on this device.'),
  h('button.btn.primary', { onclick: () => commands.run('conv.add') }, 'Add files…'));
shell.main.append(h('div.cv-root',
  h('div.toolbar', tb('conv.add', { showLabel: true }), tb('conv.clear'), sep(), tb('conv.go', { showLabel: true }), tb('conv.cancel'), h('div.grow'), tb('conv.saveAll', { showLabel: true })),
  h('div.cv-body', h('div.cv-left', drop, list), h('div.cv-right', h('h2', 'Convert to'), targets))));
shell.showStatus(true);
const status = h('span.item', 'Add files to convert');
shell.statusLeft.append(status);

function add(files) {
  for (const f of files) {
    const ext = (f.ext || extOf(f.name)).toLowerCase();
    const kind = kindOf(ext);
    items.push({ id: uid('f'), file: f, name: f.name, ext, kind, size: f.size, status: kind ? 'Ready' : NOT_HERE[ext] ? `The desktop or Android Converter converts ${NOT_HERE[ext]}` : 'Not a file this converter reads', progress: 0, outputs: [] });
  }
  paint();
}

const fmtSize = (n) => (!n || n < 0 ? '' : n > 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} kB`);

function paint() {
  drop.classList.toggle('compact', items.length > 0);
  list.replaceChildren(...items.map((it) => {
    const outs = it.outputs.map((o) => h('div.cv-out',
      h('span', { html: icon('file', 14) }), h('span.grow', o.name), h('span.muted', fmtSize(o.data.length)),
      tb({ icon: 'save', tip: `Save ${o.name}…`, run: () => saveOne(o) })));
    const row = h(`div.cv-item${it.kind ? '' : '.unsupported'}`,
      h('div.cv-head',
        h('span.cv-icon', { html: icon(it.kind ? KINDS[it.kind].icon : 'warning', 18) }),
        h('div.grow', h('div.cv-name', it.name), h('div.muted.cv-status', [fmtSize(it.size), it.status].filter(Boolean).join(' · '))),
        busy ? null : tb({ icon: 'x', tip: 'Take off the list', run: () => { items = items.filter((x) => x !== it); paint(); } })),
      it.progress > 0 && it.progress < 1 ? h('div.progress', h('div', { style: { width: `${Math.round(it.progress * 100)}%` } })) : null,
      ...outs);
    contextMenu(row, () => [
      ...it.outputs.map((o) => ({ label: `Save ${o.name}…`, icon: 'save', run: () => saveOne(o) })),
      { type: 'separator' },
      { label: 'Take off the list', icon: 'x', disabled: busy, run: () => { items = items.filter((x) => x !== it); paint(); } },
    ]);
    return row;
  }));
  paintTargets();
  const done = items.filter((i) => i.outputs.length).length;
  status.textContent = busy ? 'Converting…' : items.length ? `${items.length} file${items.length === 1 ? '' : 's'}${done ? ` · ${done} converted` : ''}` : 'Add files to convert';
  refresh();
}

// ---------------------------------------------------------------------------
// Where each kind goes, and how
// ---------------------------------------------------------------------------
const opt = (key, def) => settings.get(key, def);
const sel = (key, def, options) => select({ options: options.map(([v, l]) => ({ value: String(v), label: l })), value: String(opt(key, def)), onChange: (v) => { settings.set(key, Number.isNaN(Number(v)) ? v : Number(v)); paintTargets(); } });
const row = (lbl, control) => h('div.field', h('span', lbl), control);

function paintTargets() {
  const kinds = [...new Set(items.map((i) => i.kind).filter(Boolean))];
  if (!kinds.length) { targets.replaceChildren(h('div.muted.cv-hint', 'Add files, then choose here what they become.')); return; }
  targets.replaceChildren(...kinds.map((k) => {
    const K = KINDS[k];
    const to = K.outs.includes(opt(`to.${k}`, K.outs[0])) ? opt(`to.${k}`, K.outs[0]) : K.outs[0];
    const rows = [row(K.label, sel(`to.${k}`, to, K.outs.map((e) => [e, label(e)])))];
    if (k === 'image') {
      rows.push(row('Size', sel('img.max', 0, [[0, 'Keep'], [3840, 'At most 3840 px'], [1920, 'At most 1920 px'], [1280, 'At most 1280 px'], [800, 'At most 800 px'], [256, 'At most 256 px']])));
      if (['jpg', 'webp', 'avif'].includes(to)) rows.push(row('Quality', sel('img.q', 90, [[100, 'Best'], [90, 'High'], [80, 'Good'], [65, 'Small file']])));
      if (to === 'pdf') rows.push(row('Pages', sel('pdf.page', 'fit', [['fit', 'The picture’s size'], ['a4', 'A4'], ['letter', 'Letter']])), row('One PDF', sel('pdf.join', 1, [[1, 'All pictures in one PDF'], [0, 'One PDF per picture']])));
    }
    if ((k === 'audio' || k === 'video') && ['wav', 'flac', 'opus'].includes(to)) {
      rows.push(row('Channels', sel('aud.ch', 0, [[0, 'As it is'], [1, 'Mono'], [2, 'Stereo']])));
      if (to !== 'opus') rows.push(row('Sample rate', sel('aud.rate', 0, [[0, 'As it is'], [48000, '48 kHz'], [44100, '44.1 kHz'], [22050, '22 kHz']])));
      else rows.push(row('Quality', sel('aud.kbps', 128, [[64, 'Small (64 kbit/s)'], [96, 'Good (96 kbit/s)'], [128, 'High (128 kbit/s)'], [192, 'Best (192 kbit/s)']])));
    }
    if (k === 'video' && VIDEO.some(([e]) => e === to)) {
      rows.push(row('Size', sel('vid.max', 0, [[0, 'Keep'], [1920, '1080p'], [1280, '720p'], [854, '480p']])), row('Quality', sel('vid.q', 5, [[2, 'Small file'], [5, 'Good'], [10, 'Best']])),
        h('div.muted.cv-hint', 'The browser plays the video to convert it, so it takes as long as the video lasts. The desktop and Android Converters are much faster.'));
    }
    if (k === 'video' && to === 'gif') rows.push(row('Size', sel('gif.w', 480, [[320, '320 px wide'], [480, '480 px wide'], [640, '640 px wide'], [800, '800 px wide']])), row('Smoothness', sel('gif.fps', 10, [[5, '5 frames a second'], [10, '10 frames a second'], [15, '15 frames a second']])), row('Length', sel('gif.max', 15, [[5, 'First 5 seconds'], [15, 'First 15 seconds'], [30, 'First 30 seconds'], [60, 'First minute']])));
    if ((k === 'doc' || k === 'sheet') && to === 'pdf') rows.push(row('Pages', sel('pdf.paper', 'a4', [['a4', 'A4'], ['letter', 'Letter']])));
    return h('section.cv-target', ...rows);
  }), h('div.muted.cv-hint', 'MP3, AAC, MKV, PDF input and presentations: the desktop and Android Converters.'));
}

// ---------------------------------------------------------------------------
// Converting
// ---------------------------------------------------------------------------
const stem = (name) => baseName(name).replace(/\.[^.]+$/, '');
const out = (it, ext, data) => it.outputs.push({ name: `${stem(it.name)}.${ext}`, data: typeof data === 'string' ? new TextEncoder().encode(data) : data, ext });

async function bytesOf(it) { return host.read(it.file); }
async function urlOf(it) {
  const u = host.mediaURL && host.mediaURL(it.file);
  if (u) return u;
  return URL.createObjectURL(new Blob([await bytesOf(it)]));
}

async function pictureOf(it) {
  const bytes = await bytesOf(it);
  if (it.ext === 'psd' || it.ext === 'ora') {
    // Layers, blend modes, masks and effects flattened as Snake's Photo shows them.
    const { width, height, layers } = it.ext === 'psd' ? await readPsd(bytes) : await readOra(bytes);
    const d = new PhotoDoc(width, height);
    for (const r of layers) {
      const L = newLayer({ ...r });
      if (L.kind === 'text' && L.text) renderText(L);
      if (L.kind === 'adjust' && !L.adjust) L.kind = 'pixel';
      d.layers.push(L);
    }
    const c = document.createElement('canvas');
    c.width = width;
    c.height = height;
    new Compositor(() => d).render({ into: c });
    return c;
  }
  try {
    return await decodeImage(bytes, IMAGE_TYPES[it.ext] || '');
  } catch {
    throw new Error(it.ext === 'heic' || it.ext === 'heif' ? 'This browser cannot open HEIC pictures (Safari can).' : 'This picture could not be read.');
  }
}

async function convertImage(it, to, pdfPages) {
  let c = await pictureOf(it);
  const max = opt('img.max', 0);
  if (to === 'ico') {
    const s = Math.min(256, Math.max(c.width, c.height));
    const k = s / Math.max(c.width, c.height);
    c = resized(c, Math.max(1, Math.round(c.width * k)), Math.max(1, Math.round(c.height * k)));
  } else if (max && Math.max(c.width, c.height) > max) {
    const k = max / Math.max(c.width, c.height);
    c = resized(c, Math.round(c.width * k), Math.round(c.height * k));
  }
  if (to === 'pdf') {
    if (opt('pdf.join', 1)) { pdfPages.push(c); return; }
    out(it, 'pdf', await imagesToPdf([c], { page: opt('pdf.page', 'fit'), title: stem(it.name) }));
    return;
  }
  if (to === 'gif') {
    const g = new GifEncoder(c.width, c.height);
    g.addFrame(c.getContext('2d').getImageData(0, 0, c.width, c.height).data, 10);
    out(it, 'gif', g.finish());
    return;
  }
  if (to === 'ico') {
    // One PNG inside an ICO header (every Windows since Vista reads it).
    const png = await canvasBytes(c, 'image/png');
    const head = new Uint8Array(22);
    const dv = new DataView(head.buffer);
    dv.setUint16(2, 1, true); dv.setUint16(4, 1, true);
    head[6] = c.width >= 256 ? 0 : c.width; head[7] = c.height >= 256 ? 0 : c.height;
    dv.setUint16(10, 1, true); dv.setUint16(12, 32, true);
    dv.setUint32(14, png.length, true); dv.setUint32(18, 22, true);
    const ico = new Uint8Array(22 + png.length);
    ico.set(head);
    ico.set(png, 22);
    out(it, 'ico', ico);
    return;
  }
  if (to === 'jpg') {
    // JPEG has no transparency: white behind.
    const w = document.createElement('canvas');
    w.width = c.width;
    w.height = c.height;
    const x = w.getContext('2d');
    x.fillStyle = '#fff';
    x.fillRect(0, 0, w.width, w.height);
    x.drawImage(c, 0, 0);
    c = w;
  }
  out(it, to, await canvasBytes(c, MIME[to], opt('img.q', 90) / 100));
}

async function convertSound(it, to, progress) {
  const bytes = await bytesOf(it);
  const buf = await decodeAudio(bytes, { rate: to === 'opus' ? 0 : opt('aud.rate', 0), channels: opt('aud.ch', 0) });
  if (to === 'wav') out(it, 'wav', encodeWav(buf));
  else if (to === 'flac') out(it, 'flac', await encodeFlac(buf, progress));
  else out(it, 'opus', await encodeOpus(buf, { bitrate: opt('aud.kbps', 128) * 1000 }, progress));
}

async function convertVideo(it, to, progress, signal) {
  if (['wav', 'flac', 'opus'].includes(to)) { await convertSound(it, to, progress); return; }
  const url = await urlOf(it);
  if (to === 'gif') { out(it, 'gif', await videoToGif(url, { fps: opt('gif.fps', 10), maxW: opt('gif.w', 480), maxSeconds: opt('gif.max', 15) }, progress, signal)); return; }
  const [ext, mime] = VIDEO.find(([e]) => e === to);
  out(it, ext, await transcode(url, { mime, maxW: opt('vid.max', 0), bitrate: opt('vid.q', 5) * 1_000_000 }, progress, signal));
}

async function documentOf(it) {
  const bytes = await bytesOf(it);
  if (it.ext === 'docx') return readDocx(bytes);
  if (it.ext === 'odt') return readOdt(bytes);
  const text = decodeText(bytes);
  const meta = { ...defaultMeta(), title: stem(it.name) };
  if (it.ext === 'md' || it.ext === 'markdown') return { html: markdownToHtml(text), meta };
  if (it.ext === 'rtf') return { html: rtfToHtml(text), meta };
  if (it.ext === 'txt') return { html: textToHtml(text), meta };
  const d = new DOMParser().parseFromString(text, 'text/html');
  return { html: sanitizeToString(d.body ? d.body.innerHTML : text), meta: { ...meta, title: d.title || meta.title } };
}

async function convertDocument(it, to) {
  const { html, meta } = await documentOf(it);
  const m = { ...defaultMeta(), ...(meta || {}) };
  if (to === 'docx') out(it, 'docx', await writeDocx(html, m));
  else if (to === 'md') out(it, 'md', htmlToMarkdown(html));
  else if (to === 'txt') out(it, 'txt', htmlToText(html));
  else if (to === 'html') out(it, 'html', webPage(m.title || stem(it.name), html));
  else out(it, 'pdf', await htmlToPdf(html, { page: opt('pdf.paper', 'a4'), title: m.title || stem(it.name) }));
}

const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const webPage = (title, body) => `<!doctype html>\n<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>\n<style>body{font-family:system-ui,sans-serif;max-width:46em;margin:2em auto;padding:0 1em;line-height:1.5}table{border-collapse:collapse}td,th{border:1px solid #bbb;padding:3px 6px}</style></head>\n<body>\n${body}\n</body></html>\n`;

/** [{ name, rows }] of a spreadsheet file (rows of plain values). */
async function sheetsOf(it) {
  const bytes = await bytesOf(it);
  let book;
  if (it.ext === 'xlsx') book = await readXlsx(bytes);
  else if (it.ext === 'json') book = bookFromCSV(rowsToCSV(rowsFromJson(decodeText(bytes))), stem(it.name), ',');
  else book = bookFromCSV(decodeText(bytes), stem(it.name), it.ext === 'tsv' ? '\t' : null);
  return { book, sheets: book.sheets.map((sh) => {
    const u = sh.used();
    const rows = [];
    for (let r = 0; r <= u.r; r++) {
      const line = [];
      for (let c = 0; c <= u.c; c++) {
        const v = book.value(sh, r, c);
        line.push(v === null || v === undefined ? null : typeof v === 'object' ? String(v.code || v.text || v) : v);
      }
      rows.push(line);
    }
    return { name: sh.name, sh, rows };
  }) };
}

function rowsFromJson(text) {
  let data;
  try { data = JSON.parse(text); } catch (e) { throw new Error(`The JSON file is not valid: ${e.message}`); }
  if (data && !Array.isArray(data) && typeof data === 'object') {
    const lists = Object.values(data).filter(Array.isArray);
    data = lists.length === 1 ? lists[0] : [data];
  }
  if (!Array.isArray(data)) throw new Error('The JSON file must contain a list of records.');
  const cell = (v) => (v && typeof v === 'object' ? JSON.stringify(v) : v);
  if (data.every((x) => x && typeof x === 'object' && !Array.isArray(x))) {
    const header = [...new Set(data.flatMap((x) => Object.keys(x)))];
    return [header, ...data.map((x) => header.map((k) => cell(x[k])))];
  }
  return data.map((x) => (Array.isArray(x) ? x.map(cell) : [cell(x)]));
}
function rowsToCSV(rows) {
  return rows.map((r) => r.map((v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }).join(',')).join('\r\n');
}
const tableHtml = (rows) => `<table>${rows.map((r, i) => `<tr>${r.map((v) => `<${i ? 'td' : 'th'}>${escapeHtml(v ?? '')}</${i ? 'td' : 'th'}>`).join('')}</tr>`).join('')}</table>`;

async function convertSheet(it, to) {
  const { book, sheets } = await sheetsOf(it);
  if (to === 'xlsx') { out(it, 'xlsx', await writeXlsx(book)); return; }
  const many = sheets.length > 1;
  const name = (s) => (many ? `${stem(it.name)}_${s.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_') || 'Sheet'}` : stem(it.name));
  if (to === 'pdf' || to === 'html') {
    const body = sheets.map((s) => `${many ? `<h2>${escapeHtml(s.name)}</h2>` : ''}${tableHtml(s.rows)}`).join('');
    if (to === 'html') out(it, 'html', webPage(stem(it.name), body));
    else out(it, 'pdf', await htmlToPdf(body, { page: opt('pdf.paper', 'a4'), title: stem(it.name), size: 9 }));
    return;
  }
  for (const s of sheets) {
    let text;
    if (to === 'json') {
      const header = (s.rows[0] || []).map((v, i) => (v === null || v === '' ? `column_${i + 1}` : String(v)));
      text = `${JSON.stringify(s.rows.slice(1).map((r) => Object.fromEntries(header.map((k, i) => [k, r[i] ?? null]))), null, 2)}\n`;
    } else text = toCSV(book, s.sh, to === 'tsv' ? '\t' : ',');
    it.outputs.push({ name: `${name(s)}.${to}`, data: new TextEncoder().encode(text), ext: to });
  }
}

async function convertAll() {
  if (busy) return;
  const todo = items.filter((i) => i.kind);
  if (!todo.length) return;
  busy = true;
  abort = new AbortController();
  const pdfPages = [];
  let firstImage = null;
  paint();
  for (const it of todo) {
    if (abort.signal.aborted) break;
    const to = KINDS[it.kind].outs.includes(opt(`to.${it.kind}`, '')) ? opt(`to.${it.kind}`) : KINDS[it.kind].outs[0];
    it.outputs = [];
    it.status = 'Converting…';
    it.progress = 0.01;
    paint();
    const progress = (p) => { it.progress = Math.max(0.01, Math.min(0.99, p)); paintSoon(); };
    try {
      if (it.kind === 'image') { await convertImage(it, to, pdfPages); if (to === 'pdf' && opt('pdf.join', 1)) firstImage = firstImage || it; }
      else if (it.kind === 'audio') await convertSound(it, to, progress);
      else if (it.kind === 'video') await convertVideo(it, to, progress, abort.signal);
      else if (it.kind === 'doc') await convertDocument(it, to);
      else await convertSheet(it, to);
      it.status = to === 'pdf' && it.kind === 'image' && opt('pdf.join', 1) ? 'In the combined PDF' : `Done: ${label(to)}`;
    } catch (err) {
      it.status = err.name === 'AbortError' ? 'Stopped' : `Not converted: ${err.message || err}`;
    }
    it.progress = 0;
    paint();
  }
  if (pdfPages.length && firstImage) {
    try {
      const data = await imagesToPdf(pdfPages, { page: opt('pdf.page', 'fit'), title: pdfPages.length > 1 ? 'Pictures' : stem(firstImage.name) });
      firstImage.outputs.push({ name: `${pdfPages.length > 1 ? 'Pictures' : stem(firstImage.name)}.pdf`, data, ext: 'pdf' });
    } catch (err) { errorToast(err.message || String(err)); }
  }
  busy = false;
  abort = null;
  paint();
  const n = items.reduce((a, i) => a + i.outputs.length, 0);
  if (n) toast(`${n} file${n === 1 ? '' : 's'} ready to save`, { timeout: 3000 });
}

let paintTimer = 0;
const paintSoon = () => { if (!paintTimer) paintTimer = setTimeout(() => { paintTimer = 0; paint(); }, 150); };

async function saveOne(o) {
  try {
    const f = await host.saveAs({ name: o.name, filters: [{ name: label(o.ext), exts: [o.ext] }] }, o.data);
    if (f) toast(`Saved ${f.name}`, { timeout: 2000 });
  } catch (err) { errorToast(err.message || String(err)); }
}

async function saveAll() {
  const outs = items.flatMap((i) => i.outputs);
  if (!outs.length) return;
  if (outs.length === 1) { saveOne(outs[0]); return; }
  const seen = new Map();
  const files = outs.map((o) => {
    const k = seen.get(o.name) || 0;
    seen.set(o.name, k + 1);
    return { name: k ? o.name.replace(/(\.[^.]+)$/, ` (${k + 1})$1`) : o.name, data: o.data, store: /^(png|jpg|webp|avif|gif|mp4|webm|opus|flac|docx|xlsx|pdf)$/.test(o.ext) };
  });
  try {
    const f = await host.saveAs({ name: 'Converted.zip', filters: [{ name: 'ZIP', exts: ['zip'] }] }, await writeZip(files));
    if (f) toast(`Saved ${f.name}`, { timeout: 2000 });
  } catch (err) { errorToast(err.message || String(err)); }
}

onDropFiles((files) => add(files), 'Drop to convert');
host.onOpen((files) => add(files));
const startFiles = (shell.info && shell.info.files) || [];
if (startFiles.length) add(startFiles);
paint();
window.snakeApp = { commands, add, items: () => items, convertAll, KINDS };
closeMenus();
