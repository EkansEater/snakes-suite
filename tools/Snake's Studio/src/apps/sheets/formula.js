// The formula language of Snake's Spreadsheets: tokenizer, parser and the
// helpers that rewrite references (copying, filling, inserting rows).
// No DOM here, so it runs (and is tested) in Node as well.

export const MAX_ROWS = 1048576;
export const MAX_COLS = 16384;

// ---------------------------------------------------------------------------
// Errors and cell addresses
// ---------------------------------------------------------------------------
export class FormulaError {
  constructor(code, msg = '') { this.code = code; this.msg = msg; }
  toString() { return this.code; }
}
export const ERRS = ['#DIV/0!', '#N/A', '#NAME?', '#NULL!', '#NUM!', '#REF!', '#VALUE!', '#SPILL!', '#CALC!', '#CIRC!', '#GETTING_DATA'];
const errCache = {};
export const err = (code, msg) => (msg ? new FormulaError(code, msg) : (errCache[code] ||= new FormulaError(code)));
export const isErr = (v) => v instanceof FormulaError;

export function colName(c) {
  let s = '';
  c += 1;
  while (c > 0) {
    const m = (c - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    c = Math.floor((c - 1) / 26);
  }
  return s;
}
export function colIndex(name) {
  let c = 0;
  for (const ch of name.toUpperCase()) c = c * 26 + (ch.charCodeAt(0) - 64);
  return c - 1;
}
export const addr = (r, c, ar = false, ac = false) => `${ac ? '$' : ''}${colName(c)}${ar ? '$' : ''}${r + 1}`;
export function parseAddr(s) {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(s);
  if (!m) return null;
  const r = Number(m[2]) - 1;
  const c = colIndex(m[1]);
  if (r < 0 || r >= MAX_ROWS || c < 0 || c >= MAX_COLS) return null;
  return { r, c };
}
/** "A1:B3" or "A1" -> { r0, c0, r1, c1 } (normalised), or null. */
export function parseRange(s) {
  const [a, b] = String(s).split(':');
  const p = parseAddr(a.trim());
  if (!p) return null;
  const q = b ? parseAddr(b.trim()) : p;
  if (!q) return null;
  return { r0: Math.min(p.r, q.r), c0: Math.min(p.c, q.c), r1: Math.max(p.r, q.r), c1: Math.max(p.c, q.c) };
}
export const rangeStr = (g) => (g.r0 === g.r1 && g.c0 === g.c1 ? addr(g.r0, g.c0) : `${addr(g.r0, g.c0)}:${addr(g.r1, g.c1)}`);
export const quoteSheet = (name) => (/^[A-Za-z_][A-Za-z0-9_.]*$/.test(name) && !/^[A-Za-z]{1,3}\d+$/.test(name) ? name : `'${name.replace(/'/g, "''")}'`);

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------
const SHEET = String.raw`(?:'(?:[^']|'')+'|[A-Za-z_À-￿][\w.À-￿]*)!`;
const CELL = String.raw`\$?[A-Za-z]{1,3}\$?\d{1,7}`;
const RE_RANGE = new RegExp(`^(${SHEET})?(${CELL})(?::(${CELL}))?(?![\\w(])`);
const RE_COLS = new RegExp(`^(${SHEET})?(\\$?[A-Za-z]{1,3}):(\\$?[A-Za-z]{1,3})(?![\\w(])`);
const RE_ROWS = new RegExp(`^(${SHEET})?(\\$?\\d{1,7}):(\\$?\\d{1,7})(?![\\w(.])`);
const RE_NUM = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;
const RE_ERR = /^#(?:DIV\/0!|N\/A|NAME\?|NULL!|NUM!|REF!|VALUE!|SPILL!|CALC!|CIRC!)/i;
const RE_IDENT = /^[A-Za-z_\\À-￿][\w.À-￿]*/;

function sheetOf(raw) {
  if (!raw) return null;
  const s = raw.slice(0, -1);
  return s.startsWith("'") ? s.slice(1, -1).replace(/''/g, "'") : s;
}

/** Tokens with their source positions (so references can be rewritten in place). */
export function tokenize(src) {
  const out = [];
  let i = 0;
  const s = src;
  while (i < s.length) {
    const ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    const rest = s.slice(i);
    let m;
    if (ch === '"') {
      let j = i + 1;
      let v = '';
      while (j < s.length) {
        if (s[j] === '"') {
          if (s[j + 1] === '"') { v += '"'; j += 2; continue; }
          break;
        }
        v += s[j++];
      }
      if (j >= s.length) throw new SyntaxError('A text value is missing its closing quote');
      out.push({ t: 'str', v, s: i, e: j + 1 });
      i = j + 1;
      continue;
    }
    if ((m = RE_ERR.exec(rest))) { out.push({ t: 'err', v: m[0].toUpperCase(), s: i, e: i + m[0].length }); i += m[0].length; continue; }
    if ((m = RE_ROWS.exec(rest)) && !(m[1] === undefined && out.length && ['num', 'ref'].includes(out[out.length - 1].t))) {
      const a = m[2].replace('$', '');
      const b = m[3].replace('$', '');
      out.push({ t: 'ref', s: i, e: i + m[0].length, sheet: sheetOf(m[1]), sheetRaw: m[1] || '', kind: 'rows',
        r0: Number(a) - 1, r1: Number(b) - 1, c0: 0, c1: MAX_COLS - 1, ar0: m[2][0] === '$', ar1: m[3][0] === '$', ac0: true, ac1: true });
      i += m[0].length;
      continue;
    }
    if ((m = RE_NUM.exec(rest))) {
      out.push({ t: 'num', v: Number(m[0]), s: i, e: i + m[0].length });
      i += m[0].length;
      continue;
    }
    if ((m = RE_RANGE.exec(rest))) {
      const a = /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/.exec(m[2]);
      const b = m[3] ? /^(\$?)([A-Za-z]{1,3})(\$?)(\d+)$/.exec(m[3]) : a;
      out.push({ t: 'ref', s: i, e: i + m[0].length, sheet: sheetOf(m[1]), sheetRaw: m[1] || '', kind: m[3] ? 'range' : 'cell',
        c0: colIndex(a[2]), r0: Number(a[4]) - 1, ac0: !!a[1], ar0: !!a[3],
        c1: colIndex(b[2]), r1: Number(b[4]) - 1, ac1: !!b[1], ar1: !!b[3] });
      i += m[0].length;
      continue;
    }
    if ((m = RE_COLS.exec(rest)) && !/^[A-Za-z_]+\(/.test(rest)) {
      out.push({ t: 'ref', s: i, e: i + m[0].length, sheet: sheetOf(m[1]), sheetRaw: m[1] || '', kind: 'cols',
        c0: colIndex(m[2].replace('$', '')), c1: colIndex(m[3].replace('$', '')), r0: 0, r1: MAX_ROWS - 1,
        ac0: m[2][0] === '$', ac1: m[3][0] === '$', ar0: true, ar1: true });
      i += m[0].length;
      continue;
    }
    if (ch === "'" || (m = RE_IDENT.exec(rest))) {
      // A quoted sheet name without a valid reference after it is an error.
      if (ch === "'") throw new SyntaxError('Check the sheet name and the reference after it');
      const word = m[0];
      const after = s.slice(i + word.length).trimStart();
      if (after[0] === '(') out.push({ t: 'fn', v: word.toUpperCase(), s: i, e: i + word.length });
      else if (/^(TRUE|FALSE)$/i.test(word)) out.push({ t: 'bool', v: word.toUpperCase() === 'TRUE', s: i, e: i + word.length });
      else out.push({ t: 'name', v: word, s: i, e: i + word.length });
      i += word.length;
      continue;
    }
    const two = s.slice(i, i + 2);
    if (['<>', '<=', '>='].includes(two)) { out.push({ t: 'op', v: two, s: i, e: i + 2 }); i += 2; continue; }
    if ('+-*/^&=<>'.includes(ch)) { out.push({ t: 'op', v: ch, s: i, e: i + 1 }); i++; continue; }
    if (ch === '%') { out.push({ t: '%', s: i, e: i + 1 }); i++; continue; }
    if ('(),{};'.includes(ch)) { out.push({ t: ch, s: i, e: i + 1 }); i++; continue; }
    if (ch === ':') { out.push({ t: 'op', v: ':', s: i, e: i + 1 }); i++; continue; }
    throw new SyntaxError(`Unexpected “${ch}”`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Parser (precedence climbing). Excel's order: unary minus binds tighter than ^.
// ---------------------------------------------------------------------------
const PREC = { '=': 1, '<>': 1, '<': 1, '>': 1, '<=': 1, '>=': 1, '&': 2, '+': 3, '-': 3, '*': 4, '/': 4, '^': 5, ':': 8 };

export function parse(src) {
  const toks = tokenize(src);
  let p = 0;
  const peek = () => toks[p];
  const next = () => toks[p++];
  const expect = (t) => {
    const k = next();
    if (!k || k.t !== t) throw new SyntaxError(t === ')' ? 'A bracket is missing' : `Expected ${t}`);
    return k;
  };

  function primary() {
    const k = next();
    if (!k) throw new SyntaxError('The formula ends too soon');
    switch (k.t) {
      case 'num': return { k: 'n', v: k.v };
      case 'str': return { k: 's', v: k.v };
      case 'bool': return { k: 'b', v: k.v };
      case 'err': return { k: 'e', v: k.v };
      case 'ref': return { k: 'r', sheet: k.sheet, kind: k.kind, r0: k.r0, c0: k.c0, r1: k.r1, c1: k.c1, ar0: k.ar0, ac0: k.ac0, ar1: k.ar1, ac1: k.ac1 };
      case 'name': return { k: 'nm', v: k.v };
      case 'fn': {
        expect('(');
        const args = [];
        if (peek() && peek().t === ')') { next(); return { k: 'f', name: k.v, args }; }
        for (;;) {
          if (peek() && (peek().t === ',' || peek().t === ')')) args.push({ k: 'missing' });
          else args.push(expr(0));
          const sep = next();
          if (!sep) throw new SyntaxError('A bracket is missing');
          if (sep.t === ')') break;
          if (sep.t !== ',' && sep.t !== ';') throw new SyntaxError('Expected a comma between arguments');
        }
        return { k: 'f', name: k.v, args };
      }
      case '(': {
        const e = expr(0);
        expect(')');
        return { k: 'g', a: e };
      }
      case '{': {
        const rows = [[]];
        for (;;) {
          const neg = peek() && peek().t === 'op' && peek().v === '-' ? (next(), -1) : 1;
          const v = next();
          if (!v) throw new SyntaxError('An array constant is missing its }');
          if (v.t === 'num') rows[rows.length - 1].push(v.v * neg);
          else if (v.t === 'str' || v.t === 'bool' || v.t === 'err') rows[rows.length - 1].push(v.t === 'err' ? err(v.v) : v.v);
          else throw new SyntaxError('Array constants can only hold values');
          const sep = next();
          if (!sep) throw new SyntaxError('An array constant is missing its }');
          if (sep.t === '}') break;
          if (sep.t === ';') rows.push([]);
          else if (sep.t !== ',') throw new SyntaxError('Use , between values and ; between rows');
        }
        return { k: 'a', rows };
      }
      case 'op':
        if (k.v === '-' || k.v === '+') return { k: 'u', op: k.v, a: expr(6) };
        throw new SyntaxError(`Unexpected ${k.v}`);
      default:
        throw new SyntaxError(k.t === ')' ? 'Too many closing brackets' : `Unexpected ${k.t}`);
    }
  }

  function postfix(node) {
    while (peek() && peek().t === '%') { next(); node = { k: 'p', a: node }; }
    return node;
  }

  function expr(minPrec) {
    let left = postfix(primary());
    for (;;) {
      const k = peek();
      if (!k || k.t !== 'op') break;
      const prec = PREC[k.v];
      if (prec === undefined || prec < minPrec) break;
      next();
      // Every operator is left-associative, ^ included, as in Excel (2^3^2 = 64).
      const right = postfix(expr(prec + 1));
      if (k.v === ':') {
        if (left.k !== 'r' || right.k !== 'r') throw new SyntaxError('A range needs a reference on both sides of :');
        left = { k: 'r', sheet: left.sheet, kind: 'range', r0: Math.min(left.r0, right.r0), c0: Math.min(left.c0, right.c0), r1: Math.max(left.r1, right.r1), c1: Math.max(left.c1, right.c1), ar0: left.ar0, ac0: left.ac0, ar1: right.ar1, ac1: right.ac1 };
      } else left = { k: 'o', op: k.v, a: left, b: right };
    }
    return left;
  }

  if (!toks.length) throw new SyntaxError('The formula is empty');
  const ast = expr(0);
  if (p < toks.length) throw new SyntaxError(toks[p].t === ')' ? 'Too many closing brackets' : `Unexpected ${toks[p].v || toks[p].t}`);
  return ast;
}

/** Every reference in an AST (for dependencies and highlighting). */
export function refsOf(ast, out = []) {
  if (!ast || typeof ast !== 'object') return out;
  if (ast.k === 'r') out.push(ast);
  if (ast.a) refsOf(ast.a, out);
  if (ast.b) refsOf(ast.b, out);
  if (ast.args) for (const x of ast.args) refsOf(x, out);
  return out;
}

export function namesOf(ast, out = new Set()) {
  if (!ast || typeof ast !== 'object') return out;
  if (ast.k === 'nm') out.add(ast.v.toUpperCase());
  if (ast.a) namesOf(ast.a, out);
  if (ast.b) namesOf(ast.b, out);
  if (ast.args) for (const x of ast.args) namesOf(x, out);
  return out;
}

export const isVolatile = (ast) => {
  if (!ast || typeof ast !== 'object') return false;
  if (ast.k === 'f' && ['NOW', 'TODAY', 'RAND', 'RANDBETWEEN', 'RANDARRAY', 'OFFSET', 'INDIRECT'].includes(ast.name)) return true;
  return isVolatile(ast.a) || isVolatile(ast.b) || (ast.args || []).some(isVolatile);
};

// ---------------------------------------------------------------------------
// Rewriting references in formula text
// ---------------------------------------------------------------------------
function refText(t) {
  const sheet = t.sheetRaw || '';
  if (t.kind === 'cols') return `${sheet}${t.ac0 ? '$' : ''}${colName(t.c0)}:${t.ac1 ? '$' : ''}${colName(t.c1)}`;
  if (t.kind === 'rows') return `${sheet}${t.ar0 ? '$' : ''}${t.r0 + 1}:${t.ar1 ? '$' : ''}${t.r1 + 1}`;
  const a = addr(t.r0, t.c0, t.ar0, t.ac0);
  if (t.kind === 'cell') return sheet + a;
  return `${sheet}${a}:${addr(t.r1, t.c1, t.ar1, t.ac1)}`;
}

function rewrite(src, fn) {
  let toks;
  try { toks = tokenize(src); } catch { return src; }
  let out = '';
  let last = 0;
  for (const t of toks) {
    if (t.t !== 'ref') continue;
    const repl = fn({ ...t });
    if (repl === null) continue;
    out += src.slice(last, t.s) + repl;
    last = t.e;
  }
  return out + src.slice(last);
}

/** Move relative references by (dr, dc), as when a formula is copied. Off-grid -> #REF!. */
export function shiftFormula(src, dr, dc) {
  if (!dr && !dc) return src;
  return rewrite(src, (t) => {
    if (t.kind !== 'cols') { if (!t.ar0) t.r0 += dr; if (!t.ar1) t.r1 += dr; }
    if (t.kind !== 'rows') { if (!t.ac0) t.c0 += dc; if (!t.ac1) t.c1 += dc; }
    if (t.r0 < 0 || t.c0 < 0 || t.r1 < 0 || t.c1 < 0 || t.r1 >= MAX_ROWS || t.c1 >= MAX_COLS) return `${t.sheetRaw || ''}#REF!`;
    return refText(t);
  });
}

/**
 * Rows or columns were inserted (count > 0) or deleted (count < 0) at `at` on
 * sheet `sheetName`: move every reference into that sheet that lies past them.
 * `here` is the sheet the formula lives on (references without a sheet name point there).
 */
export function adjustForInsert(src, here, sheetName, axis, at, count) {
  return rewrite(src, (t) => {
    const target = t.sheet || here;
    if (target !== sheetName) return null;
    const isRow = axis === 'row';
    if ((isRow && t.kind === 'cols') || (!isRow && t.kind === 'rows')) return null;
    let a = isRow ? t.r0 : t.c0;
    let b = isRow ? t.r1 : t.c1;
    if (count > 0) {
      if (a >= at) a += count;
      if (b >= at) b += count;
    } else {
      const del0 = at;
      const del1 = at - count - 1;
      if (a >= del0 && b <= del1) return `${t.sheetRaw || ''}#REF!`; // the whole reference was deleted
      const shiftDel = (v) => (v > del1 ? v + count : v >= del0 ? del0 : v);
      a = shiftDel(a);
      b = b >= del0 && b <= del1 ? del0 - 1 : shiftDel(b);
      if (b < a) return `${t.sheetRaw || ''}#REF!`;
    }
    if (isRow) { t.r0 = a; t.r1 = b; } else { t.c0 = a; t.c1 = b; }
    return refText(t);
  });
}

/** A sheet was renamed: update references that name it. */
export function renameSheetRefs(src, oldName, newName) {
  return rewrite(src, (t) => {
    if (t.sheet !== oldName) return null;
    t.sheetRaw = `${quoteSheet(newName)}!`;
    return refText(t);
  });
}

/** F4 in the editor: cycle the reference at text position `pos` through $A$1, A$1, $A1, A1. */
export function cycleAbsolute(src, pos) {
  let toks;
  try { toks = tokenize(src); } catch { return null; }
  const t = toks.find((k) => k.t === 'ref' && pos >= k.s && pos <= k.e);
  if (!t) return null;
  const state = (t.ar0 ? 1 : 0) + (t.ac0 ? 2 : 0);
  const nextState = { 0: 3, 3: 1, 1: 2, 2: 0 }[state];
  const r = !!(nextState & 1);
  const c = !!(nextState & 2);
  t.ar0 = t.ar1 = r;
  t.ac0 = t.ac1 = c;
  const text = refText(t);
  return { text: src.slice(0, t.s) + text + src.slice(t.e), caret: t.s + text.length };
}

/** References in a formula with their text spans, for colouring them while editing. */
export function refSpans(src) {
  try {
    return tokenize(src).filter((t) => t.t === 'ref').map((t) => ({ s: t.s, e: t.e, sheet: t.sheet, r0: Math.min(t.r0, t.r1), c0: Math.min(t.c0, t.c1), r1: Math.max(t.r0, t.r1), c1: Math.max(t.c0, t.c1) }));
  } catch { return []; }
}

/** The function call the caret is inside and which argument it is on (for hints). */
export function callAt(src, pos) {
  let depth = 0;
  let argIndex = 0;
  const stack = [];
  let inStr = false;
  for (let i = 0; i < pos && i < src.length; i++) {
    const ch = src[i];
    if (ch === '"') inStr = !inStr;
    if (inStr) continue;
    if (ch === '(') {
      const m = /([A-Za-z_][\w.]*)\s*$/.exec(src.slice(0, i));
      stack.push({ name: m ? m[1].toUpperCase() : '', arg: argIndex });
      argIndex = 0;
      depth++;
    } else if (ch === ')') {
      const top = stack.pop();
      argIndex = top ? top.arg : 0;
      depth--;
    } else if ((ch === ',' || ch === ';') && depth > 0) argIndex++;
  }
  const top = stack[stack.length - 1];
  return top && top.name ? { name: top.name, arg: argIndex } : null;
}
