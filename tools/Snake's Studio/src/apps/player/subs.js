// Subtitles for Snake's Player: SubRip (.srt), WebVTT (.vtt) and SubStation
// (.ass/.ssa) read into cues, and cue text turned into safe page elements
// (only italic, bold and underline survive; everything else is plain text).

/** "01:02:03,456", "02:03.456" or "1:02:03.45" in seconds. */
export function parseTime(s) {
  const m = /(?:(\d+):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,3}))?/.exec(s.trim());
  if (!m) return NaN;
  const frac = m[4] ? Number(m[4].padEnd(3, '0')) / 1000 : 0;
  return Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]) + frac;
}

/** Cues: [{ start, end, text }], sorted by start. */
export function parseSubtitles(text, ext = '') {
  const t = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (ext === 'ass' || ext === 'ssa' || /^\[Script Info\]/m.test(t.slice(0, 200))) return parseAss(t);
  const cues = [];
  for (const block of t.split(/\n{2,}/)) {
    const lines = block.split('\n');
    const i = lines.findIndex((l) => l.includes('-->'));
    if (i < 0) continue;
    const [a, b] = lines[i].split('-->');
    const start = parseTime(a);
    const end = parseTime(b.trim().split(/\s+/)[0]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    const body = lines.slice(i + 1).join('\n').trim();
    if (body) cues.push({ start, end: Math.max(end, start + 0.1), text: body });
  }
  return cues.sort((x, y) => x.start - y.start);
}

function parseAss(t) {
  const cues = [];
  let format = null;
  let inEvents = false;
  for (const line of t.split('\n')) {
    const l = line.trim();
    if (/^\[.*\]$/.test(l)) { inEvents = /^\[Events\]$/i.test(l); continue; }
    if (!inEvents) continue;
    if (/^Format:/i.test(l)) { format = l.slice(7).split(',').map((x) => x.trim().toLowerCase()); continue; }
    if (!/^Dialogue:/i.test(l) || !format) continue;
    const parts = l.slice(9).split(',');
    const fields = parts.slice(0, format.length - 1);
    fields.push(parts.slice(format.length - 1).join(','));
    const get = (k) => (fields[format.indexOf(k)] || '').trim();
    const start = parseTime(get('start'));
    const end = parseTime(get('end'));
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    // Drop styling codes, keep italics and bold as tags our renderer understands.
    let text = get('text')
      .replace(/\{\\i1\}/g, '<i>').replace(/\{\\i0\}/g, '</i>')
      .replace(/\{\\b1\}/g, '<b>').replace(/\{\\b0\}/g, '</b>')
      .replace(/\{[^}]*\}/g, '')
      .replace(/\\N/gi, '\n').replace(/\\h/g, ' ');
    text = text.trim();
    if (text) cues.push({ start, end, text });
  }
  return cues.sort((x, y) => x.start - y.start);
}

/** The cues showing at time t. */
export function cuesAt(cues, t) {
  const out = [];
  // Binary search for the last cue starting before t, then look back a little for overlaps.
  let lo = 0;
  let hi = cues.length - 1;
  let k = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= t) { k = mid; lo = mid + 1; } else hi = mid - 1;
  }
  for (let i = k; i >= 0 && i > k - 20; i--) if (cues[i].end > t) out.unshift(cues[i]);
  return out;
}

/** Cue text as page nodes: <i>, <b> and <u> kept, other tags dropped, never HTML. */
export function cueNodes(text) {
  const frag = document.createDocumentFragment();
  const stack = [frag];
  const re = /<\s*(\/?)\s*([a-z]+)[^>]*>|([^<]+)|(<)/gi;
  let m;
  while ((m = re.exec(text))) {
    if (m[3] !== undefined || m[4] !== undefined) {
      const s = m[3] !== undefined ? m[3] : '<';
      const lines = s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').split('\n');
      lines.forEach((part, i) => {
        if (i) stack[stack.length - 1].append(document.createElement('br'));
        if (part) stack[stack.length - 1].append(document.createTextNode(part));
      });
      continue;
    }
    const tag = m[2].toLowerCase();
    if (!['i', 'b', 'u', 'em', 'strong'].includes(tag)) continue;
    const name = tag === 'em' ? 'i' : tag === 'strong' ? 'b' : tag;
    if (m[1]) {
      if (stack.length > 1 && stack[stack.length - 1].localName === name) stack.pop();
    } else {
      const el = document.createElement(name);
      stack[stack.length - 1].append(el);
      stack.push(el);
    }
  }
  return frag;
}

/** Text of a subtitle file in whatever encoding it came in. */
export function decodeSubtitleBytes(bytes) {
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes);
  if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { return new TextDecoder('windows-1252').decode(bytes); }
}
