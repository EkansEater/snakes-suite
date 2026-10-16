// Number formats in Excel's language: "#,##0.00", "0%", "$#,##0;[Red]-$#,##0",
// "yyyy-mm-dd", "h:mm AM/PM", "@"... formatValue(value, code) -> { text, color }.

const cache = new Map();
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const COLORS = { red: '#d1242f', blue: '#1f6feb', green: '#1a7f37', yellow: '#b08800', magenta: '#bf3989', cyan: '#0e8a9a', white: '#ffffff', black: '#000000' };

export const FORMATS = [
  { name: 'General', code: 'General' },
  { name: 'Number', code: '#,##0.00' },
  { name: 'Whole number', code: '#,##0' },
  { name: 'Currency', code: '$#,##0.00' },
  { name: 'Accounting', code: '_($* #,##0.00_);_($* (#,##0.00);_($* "-"??_);_(@_)' },
  { name: 'Negative in red', code: '#,##0.00;[Red]-#,##0.00' },
  { name: 'Percent', code: '0%' },
  { name: 'Percent with decimals', code: '0.00%' },
  { name: 'Scientific', code: '0.00E+00' },
  { name: 'Fraction', code: '# ?/?' },
  { name: 'Date', code: 'yyyy-mm-dd' },
  { name: 'Date (US)', code: 'm/d/yyyy' },
  { name: 'Long date', code: 'dddd, mmmm d, yyyy' },
  { name: 'Month and year', code: 'mmm yyyy' },
  { name: 'Time', code: 'h:mm AM/PM' },
  { name: 'Time (24 hour)', code: 'h:mm:ss' },
  { name: 'Date and time', code: 'yyyy-mm-dd h:mm' },
  { name: 'Duration', code: '[h]:mm:ss' },
  { name: 'Text', code: '@' },
];

function splitSections(code) {
  const out = [];
  let cur = '';
  let q = false;
  let b = false;
  for (let i = 0; i < code.length; i++) {
    const ch = code[i];
    if (ch === '"' && !b) q = !q;
    else if (ch === '[' && !q) b = true;
    else if (ch === ']' && !q) b = false;
    if (ch === '\\' && !q) { cur += ch + (code[i + 1] || ''); i++; continue; }
    if (ch === ';' && !q && !b) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  out.push(cur);
  return out;
}

function compileSection(src) {
  let color = null;
  let cond = null;
  let elapsed = false;
  let s = src.replace(/\[([^\]]*)\]/g, (m, inner) => {
    const low = inner.toLowerCase();
    if (COLORS[low]) { color = COLORS[low]; return ''; }
    const c = /^(<=|>=|<>|<|>|=)\s*(-?[\d.]+)$/.exec(inner);
    if (c) { cond = { op: c[1], v: Number(c[2]) }; return ''; }
    if (/^(h+|m+|s+)$/i.test(inner)) { elapsed = true; return `\u0001${inner.toLowerCase()}\u0001`; }
    if (/^\$/.test(inner)) return inner.slice(1).split('-')[0];
    return '';
  });
  // Literal pieces, with quotes and escapes resolved; placeholders kept.
  const tokens = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') {
      const j = s.indexOf('"', i + 1);
      tokens.push({ lit: s.slice(i + 1, j < 0 ? undefined : j) });
      i = j < 0 ? s.length : j;
    } else if (ch === '\\') { tokens.push({ lit: s[i + 1] || '' }); i++; }
    else if (ch === '_') { tokens.push({ lit: ' ' }); i++; }
    else if (ch === '*') { i++; }
    else if (ch === '\u0001') {
      const j = s.indexOf('\u0001', i + 1);
      tokens.push({ el: s.slice(i + 1, j) });
      i = j;
    } else tokens.push({ ch });
  }
  const pattern = tokens.map((t) => (t.ch !== undefined ? t.ch : '')).join('');
  const isDate = elapsed || /[ydhs]/i.test(pattern) || (/m/i.test(pattern) && !/[0#?]/.test(pattern));
  const isText = /@/.test(pattern) && !/[0#?]/.test(pattern);
  return { tokens, color, cond, isDate, isText, pct: (pattern.match(/%/g) || []).length };
}

function compile(code) {
  let c = cache.get(code);
  if (c) return c;
  const sections = splitSections(code || 'General').map(compileSection);
  c = { sections, general: !code || /^general$/i.test(code.trim()) };
  cache.set(code, c);
  if (cache.size > 2000) cache.delete(cache.keys().next().value);
  return c;
}

export function fmtGeneral(n) {
  if (!Number.isFinite(n)) return '#NUM!';
  if (Number.isInteger(n) && Math.abs(n) < 1e11) return String(n);
  const a = Math.abs(n);
  if (a !== 0 && (a < 1e-9 || a >= 1e11)) {
    const e = n.toExponential(5).replace(/\.?0+e/, 'e');
    return e.replace('e+', 'E+').replace('e-', 'E-');
  }
  // Ten significant digits, like a default-width Excel column.
  return String(Number(n.toPrecision(10)));
}

const pad = (n, w) => String(n).padStart(w, '0');

function formatDate(serial, sec) {
  const ms = Math.round(serial * 86400000);
  const d = new Date(Date.UTC(1899, 11, 30) + ms);
  const parts = { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), wd: d.getUTCDay(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds(), ms: d.getUTCMilliseconds() };
  const ampm = sec.tokens.some((t) => t.ch && /[aA]/.test(t.ch)) && /AM\/PM|A\/P/i.test(sec.tokens.map((t) => t.ch || '').join(''));
  let out = '';
  const toks = sec.tokens;
  // Group runs of the same letter.
  const runs = [];
  for (const t of toks) {
    if (t.lit !== undefined) { runs.push({ lit: t.lit }); continue; }
    if (t.el) { runs.push({ el: t.el }); continue; }
    const ch = t.ch;
    const low = ch.toLowerCase();
    const last = runs[runs.length - 1];
    if (last && last.ch && last.ch.toLowerCase()[0] === low && 'ymdhs'.includes(low)) last.ch += ch;
    else runs.push({ ch });
  }
  // "m" next to h or s means minutes.
  runs.forEach((r, i) => {
    if (!r.ch || r.ch.toLowerCase()[0] !== 'm' || r.ch.length > 2) return;
    const prev = runs.slice(0, i).reverse().find((x) => x.ch && /[a-z]/i.test(x.ch) && !/^[.:/ ,-]$/.test(x.ch));
    const next = runs.slice(i + 1).find((x) => x.ch && /[a-z]/i.test(x.ch) && !/^[.:/ ,-]$/.test(x.ch));
    if ((prev && /^h/i.test(prev.ch)) || (next && /^s/i.test(next.ch)) || (prev && prev.el && /^h/.test(prev.el))) r.minute = true;
  });
  const total = serial;
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    if (r.lit !== undefined) { out += r.lit; continue; }
    if (r.el) {
      const hours = Math.floor(total * 24 + 1e-9);
      if (r.el[0] === 'h') out += pad(hours, r.el.length);
      else if (r.el[0] === 'm') out += pad(Math.floor(total * 1440 + 1e-9), r.el.length);
      else out += pad(Math.floor(total * 86400 + 0.5), r.el.length);
      continue;
    }
    const t = r.ch;
    const low = t.toLowerCase();
    if (low.startsWith('yyy')) out += parts.y;
    else if (low.startsWith('y')) out += pad(parts.y % 100, 2);
    else if (low[0] === 'm' && r.minute) out += low.length > 1 ? pad(parts.mi, 2) : parts.mi;
    else if (low === 'mmmmm') out += MONTHS[parts.mo][0];
    else if (low === 'mmmm') out += MONTHS[parts.mo];
    else if (low === 'mmm') out += MONTHS[parts.mo].slice(0, 3);
    else if (low === 'mm') out += pad(parts.mo + 1, 2);
    else if (low === 'm') out += parts.mo + 1;
    else if (low === 'dddd') out += DAYS[parts.wd];
    else if (low === 'ddd') out += DAYS[parts.wd].slice(0, 3);
    else if (low === 'dd') out += pad(parts.d, 2);
    else if (low === 'd') out += parts.d;
    else if (low[0] === 'h') {
      let hh = parts.h;
      if (ampm) hh = hh % 12 || 12;
      out += low.length > 1 ? pad(hh, 2) : hh;
    } else if (low[0] === 's') {
      out += low.length > 1 ? pad(parts.s, 2) : parts.s;
      const nx = runs[i + 1];
      if (nx && nx.ch === '.' && runs[i + 2] && runs[i + 2].ch === '0') {
        let z = 0;
        let j = i + 2;
        while (runs[j] && runs[j].ch === '0') { z++; j++; }
        out += `.${pad(Math.floor(parts.ms / 10 ** (3 - Math.min(3, z))), Math.min(3, z))}`;
        i = j - 1;
      }
    } else if (/^a$/i.test(t) && /^(M\/PM|\/P)/i.test(runs.slice(i + 1, i + 5).map((x) => x.ch || '').join(''))) {
      const long = /^M\/PM/i.test(runs.slice(i + 1, i + 5).map((x) => x.ch || '').join(''));
      out += parts.h < 12 ? (long ? 'AM' : 'A') : (long ? 'PM' : 'P');
      i += long ? 4 : 2;
    } else out += t;
  }
  return out;
}

function groupThousands(s) {
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatNumber(v, sec) {
  const toks = sec.tokens;
  const pat = toks.map((t) => (t.ch !== undefined ? t.ch : '\u0002')).join('');
  // Locate the numeric pattern: from the first 0/#/? to the last.
  const first = pat.search(/[0#?]/);
  if (first < 0) {
    // Only literals (e.g. "-"): show them.
    return toks.map((t) => (t.lit !== undefined ? t.lit : t.ch === '%' ? '%' : t.ch)).join('');
  }
  let last = first;
  for (let i = first; i < pat.length; i++) if (/[0#?.,eE+\-/ ]/.test(pat[i]) && (/[0#?]/.test(pat[i]) || /[0#?]/.test(pat.slice(i + 1).split(/[^0#?.,eE+\-/ ]/)[0] || ''))) last = i;
  let numPat = pat.slice(first, last + 1);
  // Fractions: "# ?/?"
  const frac = /^([#0?,]*)\s*([?#0]+)\/([?#0]+|\d+)$/.exec(numPat);
  let body;
  let x = Math.abs(v) * 100 ** sec.pct;
  // Trailing commas divide by thousands.
  const scale = /,+$/.exec(numPat.replace(/[eE].*$/, ''));
  if (scale && !/[0#?]$/.test(numPat)) { x /= 1000 ** scale[0].length; numPat = numPat.replace(/,+$/, ''); }
  if (frac) {
    const whole = frac[1] ? Math.floor(x) : 0;
    let f = x - whole;
    const den = /^\d+$/.test(frac[3]) ? Number(frac[3]) : null;
    let bn = 0;
    let bd = 1;
    if (den) { bn = Math.round(f * den); bd = den; } else {
      const maxD = 10 ** frac[3].length - 1;
      let best = Infinity;
      for (let d = 1; d <= maxD; d++) { const n = Math.round(f * d); const e = Math.abs(f - n / d); if (e < best - 1e-12) { best = e; bn = n; bd = d; } }
    }
    let w = whole;
    if (bn === bd) { w += 1; bn = 0; }
    body = bn ? `${frac[1] ? `${w || ''} ` : ''}${bn}/${bd}`.trim() : String(w);
  } else if (/[eE][+-]/.test(numPat)) {
    const [mant, ex] = numPat.split(/[eE][+-]/);
    const dec = (mant.split('.')[1] || '').replace(/[^0#?]/g, '').length;
    const [m, e] = x.toExponential(dec).split('e');
    const en = Number(e);
    body = `${m}E${en < 0 ? '-' : '+'}${pad(Math.abs(en), ex.replace(/[^0]/g, '').length || 1)}`;
  } else {
    const [ip, dp = ''] = numPat.split('.');
    const decMin = (dp.match(/0/g) || []).length;
    const decMax = (dp.match(/[0#?]/g) || []).length;
    let s = x.toFixed(decMax);
    let [i, d = ''] = s.split('.');
    while (d.length > decMin && d.endsWith('0')) d = d.slice(0, -1);
    const intMin = (ip.replace(/,/g, '').match(/0/g) || []).length;
    if (i === '0' && intMin === 0) i = '';
    i = i.padStart(intMin, '0');
    if (/,/.test(ip)) i = groupThousands(i);
    body = d.length || (dp.includes('.') || numPat.includes('.')) && decMax ? `${i}${decMax ? `.${d}` : ''}` : i;
    if (numPat.includes('.') && !decMax) body = `${i}.`;
  }
  // Put literals before and after back around the number.
  let pre = '';
  let post = '';
  let seen = 0;
  for (let k = 0, p = 0; k < toks.length; k++, p++) {
    const t = toks[k];
    const inNum = p >= first && p <= last;
    if (inNum) { seen = 1; continue; }
    const s = t.lit !== undefined ? t.lit : t.ch === '%' ? '%' : t.ch;
    if (seen) post += s; else pre += s;
  }
  return pre + body + post;
}

/** Format a value with a number format code. */
export function formatValue(v, code) {
  if (v === null || v === undefined) return { text: '' };
  if (typeof v === 'boolean') return { text: v ? 'TRUE' : 'FALSE' };
  if (typeof v === 'object' && v.code) return { text: v.code };
  if (typeof v === 'object' && v.link !== undefined) return { text: String(v.text ?? v.link), link: v.link };
  if (typeof v === 'object') return { text: String(v) };
  const c = compile(code);
  if (typeof v === 'string') {
    const sec = c.sections[3] || c.sections.find((s) => s.isText);
    if (!sec) return { text: v };
    return { text: sec.tokens.map((t) => (t.ch === '@' ? v : t.lit !== undefined ? t.lit : t.ch)).join(''), color: sec.color };
  }
  if (c.general) return { text: fmtGeneral(v) };
  let sec;
  let neg = v < 0;
  const conds = c.sections.filter((s) => s.cond);
  if (conds.length) {
    sec = c.sections.find((s) => s.cond && { '<': v < s.cond.v, '>': v > s.cond.v, '<=': v <= s.cond.v, '>=': v >= s.cond.v, '=': v === s.cond.v, '<>': v !== s.cond.v }[s.cond.op])
      || c.sections.find((s) => !s.cond) || c.sections[0];
    neg = false;
  } else if (v < 0 && c.sections[1]) { sec = c.sections[1]; neg = false; }
  else if (v === 0 && c.sections[2]) sec = c.sections[2];
  else sec = c.sections[0];
  if (sec.isText) return { text: sec.tokens.map((t) => (t.ch === '@' ? fmtGeneral(v) : t.lit ?? t.ch)).join(''), color: sec.color };
  let text;
  if (sec.isDate) {
    if (v < 0 && !sec.tokens.some((t) => t.el)) return { text: '#'.repeat(8) };
    text = formatDate(Math.abs(v), sec);
  } else text = formatNumber(v, sec);
  if (neg && !sec.isDate && /[1-9]/.test(text)) text = `-${text}`;
  return { text, color: sec.color };
}

/** Is a format a date or time one (for the editor and the date picker)? */
export function isDateFormat(code) {
  if (!code) return false;
  const c = compile(code);
  return c.sections[0].isDate;
}

/** More or fewer decimals for a number format. */
export function changeDecimals(code, delta) {
  let c = !code || /^general$/i.test(code) ? '0' : code;
  if (delta > 0) {
    if (/\.\d*[0#]/.test(c) || /\.0/.test(c)) return c.replace(/(\.[0#]*)(?=[^0#]|$)/g, '$10');
    return c.replace(/([0#])(?![0#,])/g, '$1.0').replace(/\.0(\.0)+/, '.0');
  }
  return c.replace(/\.([0#]*)[0#](?=[^0#]|$)/g, (m, rest) => (rest ? `.${rest}` : ''));
}
