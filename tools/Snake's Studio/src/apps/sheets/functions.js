// The function library: Excel-compatible functions, plus a few of our own.
// Values: number, string, boolean, null (empty), FormulaError, Rng (a reference)
// and Arr (an array result that spills into the cells around it).
import { err, isErr, FormulaError, colName, addr, parseAddr, MAX_ROWS, MAX_COLS } from './formula.js';

export class Rng {
  constructor(sheet, r0, c0, r1, c1) {
    this.sheet = sheet;
    this.r0 = r0; this.c0 = c0; this.r1 = r1; this.c1 = c1;
  }
  get rows() { return this.r1 - this.r0 + 1; }
  get cols() { return this.c1 - this.c0 + 1; }
  get single() { return this.r0 === this.r1 && this.c0 === this.c1; }
}

export class Arr {
  constructor(data) { this.data = data; }
  get rows() { return this.data.length; }
  get cols() { return this.data[0] ? this.data[0].length : 0; }
  static of(rows, cols, fill = null) {
    return new Arr(Array.from({ length: rows }, () => Array.from({ length: cols }, () => fill)));
  }
}

export class Spark {
  constructor(data, opts) { this.data = data; this.opts = opts; }
  toString() { return ''; }
}

// ---------------------------------------------------------------------------
// Dates: the 1900 date system (day 1 = 1 Jan 1900), as in Excel
// ---------------------------------------------------------------------------
const EPOCH = Date.UTC(1899, 11, 30);
export const toSerial = (d) => (d - EPOCH) / 86400000;
export const fromSerial = (n) => new Date(EPOCH + Math.round(n * 86400000));
export const dateSerial = (y, m, d) => toSerial(Date.UTC(y, m - 1, d));
const parts = (n) => {
  const d = fromSerial(n);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate(), wd: d.getUTCDay(), h: d.getUTCHours(), mi: d.getUTCMinutes(), s: d.getUTCSeconds() };
};

// ---------------------------------------------------------------------------
// Coercion
// ---------------------------------------------------------------------------
export function parseNumber(s) {
  const t = String(s).trim();
  if (t === '') return null;
  let m = /^([+-]?)\(?\$?\s*([\d,]*\.?\d+(?:[eE][+-]?\d+)?)\s*\)?(%?)$/.exec(t.replace(/^\((.*)\)$/, '-$1'));
  if (m && (!m[2].includes(',') || /^\d{1,3}(,\d{3})*(\.\d*)?$/.test(m[2].split(/[eE]/)[0]))) {
    let v = Number(m[2].replace(/,/g, ''));
    if (m[1] === '-') v = -v;
    if (m[3]) v /= 100;
    return Number.isFinite(v) ? v : null;
  }
  m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/.exec(t);
  if (m) return dateSerial(+m[1], +m[2], +m[3]) + ((+(m[4] || 0)) * 3600 + (+(m[5] || 0)) * 60 + (+(m[6] || 0))) / 86400;
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(t);
  if (m) {
    let y = +m[3];
    if (y < 100) y += y < 30 ? 2000 : 1900;
    return dateSerial(y, +m[1], +m[2]);
  }
  m = /^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([ap]m)?$/i.exec(t);
  if (m) {
    let hh = +m[1];
    if (m[4]) hh = (hh % 12) + (/p/i.test(m[4]) ? 12 : 0);
    return (hh * 3600 + (+m[2]) * 60 + (+(m[3] || 0))) / 86400;
  }
  return null;
}

export function num(v) {
  if (typeof v === 'number') return v;
  if (v === null || v === undefined) return 0;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (isErr(v)) return v;
  if (typeof v === 'string') {
    const n = parseNumber(v);
    return n === null ? err('#VALUE!') : n;
  }
  return err('#VALUE!');
}

export function fmtGeneral(n) {
  if (!Number.isFinite(n)) return '#NUM!';
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  const a = Math.abs(n);
  if (a !== 0 && (a < 1e-9 || a >= 1e15)) return n.toExponential(5).replace(/\.?0+e/, 'e').replace('e+', 'E+').replace('e-', 'E-');
  return String(Number(n.toPrecision(15)));
}

export function str(v) {
  if (typeof v === 'string') return v;
  if (v === null || v === undefined) return '';
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (typeof v === 'number') return fmtGeneral(v);
  if (isErr(v)) return v;
  return String(v);
}

export function bool(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'number') return v !== 0;
  if (v === null || v === undefined) return false;
  if (isErr(v)) return v;
  if (typeof v === 'string') {
    if (/^true$/i.test(v)) return true;
    if (/^false$/i.test(v)) return false;
    return err('#VALUE!');
  }
  return err('#VALUE!');
}

// ---------------------------------------------------------------------------
// Ranges and arrays
// ---------------------------------------------------------------------------
/** A value as a 2D array (ranges are read; scalars become 1x1). */
export function grid(v, ctx) {
  if (v instanceof Arr) return v.data;
  if (v instanceof Rng) {
    const { r1, c1 } = ctx.clamp(v);
    const out = [];
    for (let r = v.r0; r <= r1; r++) {
      const row = [];
      for (let c = v.c0; c <= c1; c++) row.push(ctx.value(v.sheet, r, c));
      out.push(row);
    }
    return out.length ? out : [[null]];
  }
  return [[v]];
}

/** A single value from a cell, a 1x1 range, or the first item of an array. */
export function scalar(v, ctx) {
  if (v instanceof Rng) {
    if (v.single) return ctx.value(v.sheet, v.r0, v.c0);
    // Implicit intersection with the formula's row or column.
    if (v.c0 === v.c1 && ctx.row >= v.r0 && ctx.row <= v.r1 && v.sheet === ctx.sheet) return ctx.value(v.sheet, ctx.row, v.c0);
    if (v.r0 === v.r1 && ctx.col >= v.c0 && ctx.col <= v.c1 && v.sheet === ctx.sheet) return ctx.value(v.sheet, v.r0, ctx.col);
    return ctx.value(v.sheet, v.r0, v.c0);
  }
  if (v instanceof Arr) return v.data[0] ? v.data[0][0] : null;
  return v;
}

/** Every value inside the arguments (ranges and arrays flattened). */
function* each(args, ctx) {
  for (const a of args) {
    if (a instanceof Rng) {
      const { r1, c1 } = ctx.clamp(a);
      for (let r = a.r0; r <= r1; r++) {
        for (let c = a.c0; c <= c1; c++) {
          if (ctx.hiddenSkip && ctx.hiddenSkip(a.sheet, r, c)) continue;
          yield [ctx.value(a.sheet, r, c), true];
        }
      }
    } else if (a instanceof Arr) {
      for (const row of a.data) for (const v of row) yield [v, true];
    } else yield [a, false];
  }
}

/** Numbers for SUM-like functions: text and booleans in ranges are skipped. */
function nums(args, ctx, { all = false } = {}) {
  const out = [];
  for (const [v, inRange] of each(args, ctx)) {
    if (isErr(v)) return v;
    if (typeof v === 'number') out.push(v);
    else if (v === null || v === undefined) { if (!inRange) out.push(0); }
    else if (typeof v === 'boolean') { if (!inRange || all) out.push(v ? 1 : 0); }
    else if (typeof v === 'string') {
      if (!inRange) {
        const n = num(v);
        if (isErr(n)) return n;
        out.push(n);
      } else if (all) out.push(0);
    }
  }
  return out;
}

const flat = (v, ctx) => grid(v, ctx).flat();

// Criteria for COUNTIF, SUMIF and friends: ">=5", "<>apple", "a*", 7, TRUE.
export function criteria(c) {
  if (typeof c === 'number') return (v) => typeof v === 'number' ? v === c : (typeof v === 'string' && parseNumber(v) === c);
  if (typeof c === 'boolean') return (v) => v === c;
  if (c === null || c === undefined) return (v) => v === null || v === '';
  const s = String(c);
  const m = /^(<=|>=|<>|=|<|>)?(.*)$/s.exec(s);
  const op = m[1] || '=';
  const rhs = m[2];
  const n = parseNumber(rhs);
  if (n !== null && rhs.trim() !== '') {
    return (v) => {
      const x = typeof v === 'number' ? v : (typeof v === 'string' ? parseNumber(v) : null);
      if (x === null) return op === '<>';
      return { '=': x === n, '<>': x !== n, '<': x < n, '>': x > n, '<=': x <= n, '>=': x >= n }[op];
    };
  }
  if (rhs === '' && (op === '=' || op === '<>')) return (v) => (op === '=' ? (v === null || v === '') : !(v === null || v === ''));
  const low = rhs.toLowerCase();
  if ((op === '=' || op === '<>') && /[*?~]/.test(rhs)) {
    const re = new RegExp(`^${low.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/~\*/g, '\u0001').replace(/~\?/g, '\u0002').replace(/\*/g, '.*').replace(/\?/g, '.').replace(/\u0001/g, '\\*').replace(/\u0002/g, '\\?')}$`, 's');
    return (v) => (op === '=') === re.test(str(v).toLowerCase());
  }
  return (v) => {
    const x = str(v).toLowerCase();
    return { '=': x === low, '<>': x !== low, '<': x < low, '>': x > low, '<=': x <= low, '>=': x >= low }[op];
  };
}

function ifsPairs(args, ctx, start) {
  // [range, criteria, range, criteria, ...] -> a mask over the first range
  const pairs = [];
  for (let i = start; i + 1 < args.length; i += 2) pairs.push([flat(args[i], ctx), criteria(scalar(args[i + 1], ctx))]);
  if (!pairs.length) return null;
  const len = pairs[0][0].length;
  if (pairs.some((p) => p[0].length !== len)) return err('#VALUE!');
  const mask = [];
  for (let i = 0; i < len; i++) mask.push(pairs.every(([vals, test]) => test(vals[i])));
  return mask;
}

// ---------------------------------------------------------------------------
// Helpers for writing functions
// ---------------------------------------------------------------------------
/** Make a function of scalars work over arrays and ranges too (results spill). */
function lift(fn, scalarArgs = null) {
  return (args, ctx) => {
    const idx = scalarArgs || args.map((_, i) => i);
    let rows = 1;
    let cols = 1;
    const grids = args.map((a, i) => {
      if (!idx.includes(i) || !(a instanceof Rng || a instanceof Arr)) return null;
      if (a instanceof Rng && a.single) return null;
      const g = grid(a, ctx);
      rows = Math.max(rows, g.length);
      cols = Math.max(cols, g[0].length);
      return g;
    });
    if (rows === 1 && cols === 1 && grids.every((g) => !g)) return fn(args.map((a, i) => (idx.includes(i) ? scalar(a, ctx) : a)), ctx);
    const out = Arr.of(rows, cols);
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const at = args.map((a, i) => {
          const g = grids[i];
          if (!g) return idx.includes(i) ? scalar(a, ctx) : a;
          const rr = g.length === 1 ? 0 : r;
          const cc = g[0].length === 1 ? 0 : c;
          return g[rr] && g[rr][cc] !== undefined ? g[rr][cc] : err('#N/A');
        });
        out.data[r][c] = fn(at, ctx);
      }
    }
    return out;
  };
}

const firstErr = (...vals) => vals.find(isErr);
const N = (f) => lift((a) => {
  const xs = a.map(num);
  return firstErr(...xs) || f(...xs);
});
const finite = (v) => (Number.isFinite(v) ? v : err('#NUM!'));
const roundTo = (x, d, fn = Math.round) => {
  const f = 10 ** d;
  const v = fn(Math.abs(x) * f * (1 + Number.EPSILON)) / f;
  return x < 0 ? -v : v;
};
const sum = (a) => a.reduce((s, x) => s + x, 0);
const mean = (a) => (a.length ? sum(a) / a.length : err('#DIV/0!'));
function variance(a, sample) {
  if (a.length < (sample ? 2 : 1)) return err('#DIV/0!');
  const m = sum(a) / a.length;
  return sum(a.map((x) => (x - m) ** 2)) / (a.length - (sample ? 1 : 0));
}
const sorted = (a) => [...a].sort((x, y) => x - y);
function percentile(a, k, exclusive = false) {
  const s = sorted(a);
  const n = s.length;
  if (!n) return err('#NUM!');
  let rank = exclusive ? k * (n + 1) - 1 : k * (n - 1);
  if (rank < 0 || rank > n - 1) return err('#NUM!');
  const lo = Math.floor(rank);
  return s[lo] + (rank - lo) * ((s[lo + 1] ?? s[lo]) - s[lo]);
}
function cmpValues(a, b) {
  // Excel order: numbers < text < booleans; empty last.
  const rank = (v) => (v === null || v === '' ? 3 : typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : typeof v === 'boolean' ? 2 : 4);
  const ra = rank(a);
  const rb = rank(b);
  if (ra !== rb) return ra - rb;
  if (ra === 0) return a - b;
  if (ra === 1) return a.localeCompare(b, undefined, { sensitivity: 'base', numeric: false });
  if (ra === 2) return (a ? 1 : 0) - (b ? 1 : 0);
  return 0;
}
const eqLoose = (a, b) => (typeof a === 'string' && typeof b === 'string' ? a.toLowerCase() === b.toLowerCase() : a === b || ((a === null || a === '') && (b === null || b === '')));

// Lookups: exact (with wildcards), or approximate in a sorted list.
function lookupIndex(list, key, mode = 0, wildcard = true, search = 1) {
  const idx = search < 0 ? [...list.keys()].reverse() : [...list.keys()];
  if (mode === 0 || mode === 2) {
    const test = typeof key === 'string' && wildcard && mode === 2 ? criteria(key) : typeof key === 'string' && /[*?]/.test(key) && wildcard && mode === 0 ? criteria(key) : null;
    for (const i of idx) if (test ? test(list[i]) : eqLoose(list[i], key)) return i;
    return -1;
  }
  if (mode === -1 || mode === 1) {
    // next smaller (-1) or next larger (1), unsorted search
    let best = -1;
    for (const i of idx) {
      const c = cmpValues(list[i], key);
      if (c === 0) return i;
      if (mode === -1 && c < 0 && (best < 0 || cmpValues(list[i], list[best]) > 0)) best = i;
      if (mode === 1 && c > 0 && (best < 0 || cmpValues(list[i], list[best]) < 0)) best = i;
    }
    return best;
  }
  return -1;
}
function approxSorted(list, key, desc = false) {
  // Largest value <= key in an ascending list (binary search, like MATCH type 1).
  let lo = 0;
  let hi = list.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const c = cmpValues(list[mid], key);
    if (desc ? c >= 0 : c <= 0) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function textOf(v, ctx) {
  const s = scalar(v, ctx);
  return isErr(s) ? s : str(s);
}

// ---------------------------------------------------------------------------
// The library
// ---------------------------------------------------------------------------
export const FN = {};
const def = (names, spec) => { for (const n of names.split(' ')) FN[n] = spec; };

// ---- math ----
def('SUM', { args: 'number1, [number2], …', desc: 'Adds numbers', fn: (a, ctx) => { const x = nums(a, ctx); return isErr(x) ? x : sum(x); } });
def('PRODUCT', { args: 'number1, [number2], …', desc: 'Multiplies numbers', fn: (a, ctx) => { const x = nums(a, ctx); return isErr(x) ? x : x.reduce((p, v) => p * v, 1); } });
def('SUMSQ', { args: 'number1, [number2], …', desc: 'Sum of squares', fn: (a, ctx) => { const x = nums(a, ctx); return isErr(x) ? x : sum(x.map((v) => v * v)); } });
def('ABS', { args: 'number', desc: 'Absolute value', fn: N((x) => Math.abs(x)) });
def('SIGN', { args: 'number', desc: 'The sign of a number: 1, 0 or -1', fn: N((x) => Math.sign(x)) });
def('INT', { args: 'number', desc: 'Rounds down to a whole number', fn: N((x) => Math.floor(x)) });
def('TRUNC', { args: 'number, [digits]', desc: 'Cuts off decimals', fn: N((x, d = 0) => roundTo(x, Math.trunc(d), Math.floor)) });
def('ROUND', { args: 'number, digits', desc: 'Rounds to a number of digits', fn: N((x, d = 0) => roundTo(x, Math.trunc(d))) });
def('ROUNDUP', { args: 'number, digits', desc: 'Rounds away from zero', fn: N((x, d = 0) => roundTo(x, Math.trunc(d), Math.ceil)) });
def('ROUNDDOWN', { args: 'number, digits', desc: 'Rounds toward zero', fn: N((x, d = 0) => roundTo(x, Math.trunc(d), Math.floor)) });
def('MROUND', { args: 'number, multiple', desc: 'Rounds to the nearest multiple', fn: N((x, m) => (m === 0 ? 0 : x * m < 0 ? err('#NUM!') : Math.round(x / m) * m)) });
def('CEILING CEILING.MATH CEILING.PRECISE', { args: 'number, [significance]', desc: 'Rounds up to a multiple', fn: N((x, s = 1) => (s === 0 ? 0 : Math.ceil(x / Math.abs(s)) * Math.abs(s))) });
def('FLOOR FLOOR.MATH FLOOR.PRECISE', { args: 'number, [significance]', desc: 'Rounds down to a multiple', fn: N((x, s = 1) => (s === 0 ? 0 : Math.floor(x / Math.abs(s)) * Math.abs(s))) });
def('EVEN', { args: 'number', desc: 'Rounds up to an even number', fn: N((x) => { const v = Math.ceil(Math.abs(x) / 2) * 2; return x < 0 ? -v : v; }) });
def('ODD', { args: 'number', desc: 'Rounds up to an odd number', fn: N((x) => { let v = Math.ceil(Math.abs(x)); if (v % 2 === 0) v += 1; return x < 0 ? -v : v; }) });
def('MOD', { args: 'number, divisor', desc: 'Remainder after division', fn: N((x, d) => (d === 0 ? err('#DIV/0!') : x - d * Math.floor(x / d))) });
def('QUOTIENT', { args: 'numerator, denominator', desc: 'Whole part of a division', fn: N((x, d) => (d === 0 ? err('#DIV/0!') : Math.trunc(x / d))) });
def('POWER', { args: 'number, power', desc: 'A number raised to a power', fn: N((x, p) => finite(x ** p)) });
def('SQRT', { args: 'number', desc: 'Square root', fn: N((x) => (x < 0 ? err('#NUM!') : Math.sqrt(x))) });
def('SQRTPI', { args: 'number', desc: 'Square root of number × π', fn: N((x) => (x < 0 ? err('#NUM!') : Math.sqrt(x * Math.PI))) });
def('EXP', { args: 'number', desc: 'e raised to a power', fn: N((x) => finite(Math.exp(x))) });
def('LN', { args: 'number', desc: 'Natural logarithm', fn: N((x) => (x <= 0 ? err('#NUM!') : Math.log(x))) });
def('LOG', { args: 'number, [base]', desc: 'Logarithm', fn: N((x, b = 10) => (x <= 0 || b <= 0 || b === 1 ? err('#NUM!') : Math.log(x) / Math.log(b))) });
def('LOG10', { args: 'number', desc: 'Base-10 logarithm', fn: N((x) => (x <= 0 ? err('#NUM!') : Math.log10(x))) });
def('PI', { args: '', desc: 'π', fn: () => Math.PI });
for (const f of ['SIN', 'COS', 'TAN', 'ASIN', 'ACOS', 'ATAN', 'SINH', 'COSH', 'TANH', 'ASINH', 'ACOSH', 'ATANH']) {
  def(f, { args: 'number', desc: `${f.toLowerCase()} of an angle in radians`, fn: N((x) => finite(Math[f.toLowerCase()](x))) });
}
def('ATAN2', { args: 'x, y', desc: 'Angle of a point from the x axis', fn: N((x, y) => (x === 0 && y === 0 ? err('#DIV/0!') : Math.atan2(y, x))) });
def('DEGREES', { args: 'angle', desc: 'Radians to degrees', fn: N((x) => (x * 180) / Math.PI) });
def('RADIANS', { args: 'angle', desc: 'Degrees to radians', fn: N((x) => (x * Math.PI) / 180) });
def('FACT', { args: 'number', desc: 'Factorial', fn: N((x) => { if (x < 0) return err('#NUM!'); let r = 1; for (let i = 2; i <= Math.floor(x); i++) r *= i; return finite(r); }) });
def('COMBIN', { args: 'n, k', desc: 'Combinations', fn: N((n, k) => { n = Math.floor(n); k = Math.floor(k); if (k < 0 || n < k) return err('#NUM!'); let r = 1; for (let i = 1; i <= k; i++) r = (r * (n - k + i)) / i; return Math.round(r); }) });
def('PERMUT', { args: 'n, k', desc: 'Permutations', fn: N((n, k) => { n = Math.floor(n); k = Math.floor(k); if (k < 0 || n < k) return err('#NUM!'); let r = 1; for (let i = 0; i < k; i++) r *= n - i; return r; }) });
const gcd2 = (a, b) => { a = Math.abs(Math.floor(a)); b = Math.abs(Math.floor(b)); while (b) [a, b] = [b, a % b]; return a; };
def('GCD', { args: 'number1, [number2], …', desc: 'Greatest common divisor', fn: (a, ctx) => { const x = nums(a, ctx); return isErr(x) ? x : x.reduce(gcd2, 0); } });
def('LCM', { args: 'number1, [number2], …', desc: 'Least common multiple', fn: (a, ctx) => { const x = nums(a, ctx); return isErr(x) ? x : x.reduce((p, v) => (p && v ? Math.abs(p * Math.floor(v)) / gcd2(p, v) : 0), 1); } });
def('RAND', { args: '', desc: 'A random number from 0 to 1', volatile: true, fn: () => Math.random() });
def('RANDBETWEEN', { args: 'bottom, top', desc: 'A random whole number between two numbers', volatile: true, fn: N((lo, hi) => Math.floor(Math.random() * (Math.floor(hi) - Math.ceil(lo) + 1)) + Math.ceil(lo)) });
def('RANDARRAY', { args: '[rows], [columns], [min], [max], [whole]', desc: 'An array of random numbers', volatile: true, fn: (a, ctx) => {
  const [r = 1, c = 1, lo = 0, hi = 1, whole = false] = a.map((x) => scalar(x, ctx));
  const out = Arr.of(Math.max(1, num(r)), Math.max(1, num(c)));
  for (const row of out.data) for (let i = 0; i < row.length; i++) row[i] = bool(whole) === true ? Math.floor(Math.random() * (num(hi) - num(lo) + 1)) + num(lo) : num(lo) + Math.random() * (num(hi) - num(lo));
  return out;
} });
def('SEQUENCE', { args: 'rows, [columns], [start], [step]', desc: 'A list of sequential numbers', fn: (a, ctx) => {
  const [r, c = 1, start = 1, step = 1] = a.map((x) => num(scalar(x, ctx) ?? (x === undefined ? undefined : 0)));
  if ([r, c, start, step].some(isErr)) return err('#VALUE!');
  if (r < 1 || c < 1 || r * c > 1e6) return err('#NUM!');
  const out = Arr.of(Math.floor(r), Math.floor(c));
  let v = start;
  for (const row of out.data) for (let i = 0; i < row.length; i++) { row[i] = v; v += step; }
  return out;
} });
def('SUMPRODUCT', { args: 'array1, [array2], …', desc: 'Sum of the products of matching items', fn: (a, ctx) => {
  const gs = a.map((x) => flat(x, ctx));
  const len = gs[0].length;
  if (gs.some((g) => g.length !== len)) return err('#VALUE!');
  let s = 0;
  for (let i = 0; i < len; i++) {
    let p = 1;
    for (const g of gs) { const v = g[i]; if (isErr(v)) return v; p *= typeof v === 'number' ? v : typeof v === 'boolean' ? +v : 0; }
    s += p;
  }
  return s;
} });
def('SUMIF', { args: 'range, criteria, [sum_range]', desc: 'Adds the cells that meet a condition', fn: (a, ctx) => {
  const test = criteria(scalar(a[1], ctx));
  const r = flat(a[0], ctx);
  const s = a[2] ? flat(a[2] instanceof Rng && a[0] instanceof Rng ? new Rng(a[2].sheet, a[2].r0, a[2].c0, a[2].r0 + a[0].rows - 1, a[2].c0 + a[0].cols - 1) : a[2], ctx) : r;
  let t = 0;
  r.forEach((v, i) => { if (test(v) && typeof s[i] === 'number') t += s[i]; });
  return t;
} });
def('SUMIFS', { args: 'sum_range, range1, criteria1, …', desc: 'Adds the cells that meet several conditions', fn: (a, ctx) => {
  const mask = ifsPairs(a, ctx, 1);
  if (isErr(mask)) return mask;
  const s = flat(a[0], ctx);
  return s.reduce((t, v, i) => t + (mask[i] && typeof v === 'number' ? v : 0), 0);
} });

// ---- statistics ----
def('AVERAGE', { args: 'number1, [number2], …', desc: 'Average', fn: (a, ctx) => { const x = nums(a, ctx); return isErr(x) ? x : mean(x); } });
def('AVERAGEA', { args: 'value1, [value2], …', desc: 'Average, counting text as 0', fn: (a, ctx) => { const x = nums(a, ctx, { all: true }); return isErr(x) ? x : mean(x); } });
def('AVERAGEIF', { args: 'range, criteria, [average_range]', desc: 'Average of the cells that meet a condition', fn: (a, ctx) => {
  const test = criteria(scalar(a[1], ctx));
  const r = flat(a[0], ctx);
  const s = a[2] ? flat(a[2], ctx) : r;
  const x = [];
  r.forEach((v, i) => { if (test(v) && typeof s[i] === 'number') x.push(s[i]); });
  return mean(x);
} });
def('AVERAGEIFS', { args: 'average_range, range1, criteria1, …', desc: 'Average of the cells that meet several conditions', fn: (a, ctx) => {
  const mask = ifsPairs(a, ctx, 1);
  if (isErr(mask)) return mask;
  return mean(flat(a[0], ctx).filter((v, i) => mask[i] && typeof v === 'number'));
} });
def('COUNT', { args: 'value1, [value2], …', desc: 'Counts numbers', fn: (a, ctx) => { let n = 0; for (const [v, inR] of each(a, ctx)) if (typeof v === 'number' || (!inR && (typeof v === 'boolean' || (typeof v === 'string' && parseNumber(v) !== null)))) n++; return n; } });
def('COUNTA', { args: 'value1, [value2], …', desc: 'Counts cells that are not empty', fn: (a, ctx) => { let n = 0; for (const [v] of each(a, ctx)) if (v !== null && v !== undefined && v !== '') n++; return n; } });
def('COUNTBLANK', { args: 'range', desc: 'Counts empty cells', fn: (a, ctx) => {
  const r = a[0];
  if (!(r instanceof Rng)) return err('#VALUE!');
  let filled = 0;
  for (const [v] of each([r], ctx)) if (v !== null && v !== '') filled++;
  return r.rows * r.cols - filled;
} });
def('COUNTIF', { args: 'range, criteria', desc: 'Counts the cells that meet a condition', fn: (a, ctx) => { const test = criteria(scalar(a[1], ctx)); return flat(a[0], ctx).filter((v) => test(v)).length; } });
def('COUNTIFS', { args: 'range1, criteria1, …', desc: 'Counts the cells that meet several conditions', fn: (a, ctx) => { const m = ifsPairs(a, ctx, 0); return isErr(m) ? m : m.filter(Boolean).length; } });
def('MAX', { args: 'number1, [number2], …', desc: 'Largest number', fn: (a, ctx) => { const x = nums(a, ctx); return isErr(x) ? x : x.length ? Math.max(...x) : 0; } });
def('MIN', { args: 'number1, [number2], …', desc: 'Smallest number', fn: (a, ctx) => { const x = nums(a, ctx); return isErr(x) ? x : x.length ? Math.min(...x) : 0; } });
def('MAXA', { args: 'value1, …', desc: 'Largest value, text as 0', fn: (a, ctx) => { const x = nums(a, ctx, { all: true }); return isErr(x) ? x : x.length ? Math.max(...x) : 0; } });
def('MINA', { args: 'value1, …', desc: 'Smallest value, text as 0', fn: (a, ctx) => { const x = nums(a, ctx, { all: true }); return isErr(x) ? x : x.length ? Math.min(...x) : 0; } });
def('MAXIFS', { args: 'max_range, range1, criteria1, …', desc: 'Largest of the cells that meet conditions', fn: (a, ctx) => { const m = ifsPairs(a, ctx, 1); if (isErr(m)) return m; const x = flat(a[0], ctx).filter((v, i) => m[i] && typeof v === 'number'); return x.length ? Math.max(...x) : 0; } });
def('MINIFS', { args: 'min_range, range1, criteria1, …', desc: 'Smallest of the cells that meet conditions', fn: (a, ctx) => { const m = ifsPairs(a, ctx, 1); if (isErr(m)) return m; const x = flat(a[0], ctx).filter((v, i) => m[i] && typeof v === 'number'); return x.length ? Math.min(...x) : 0; } });
def('MEDIAN', { args: 'number1, [number2], …', desc: 'The middle value', fn: (a, ctx) => { const x = nums(a, ctx); return isErr(x) ? x : percentile(x, 0.5); } });
def('MODE MODE.SNGL', { args: 'number1, [number2], …', desc: 'The most common value', fn: (a, ctx) => {
  const x = nums(a, ctx);
  if (isErr(x)) return x;
  const counts = new Map();
  let best = null;
  let bestN = 1;
  for (const v of x) { const n = (counts.get(v) || 0) + 1; counts.set(v, n); if (n > bestN) { bestN = n; best = v; } }
  return best === null ? err('#N/A') : best;
} });
def('STDEV STDEV.S', { args: 'number1, [number2], …', desc: 'Standard deviation of a sample', fn: (a, ctx) => { const x = nums(a, ctx); if (isErr(x)) return x; const v = variance(x, true); return isErr(v) ? v : Math.sqrt(v); } });
def('STDEVP STDEV.P', { args: 'number1, [number2], …', desc: 'Standard deviation of a population', fn: (a, ctx) => { const x = nums(a, ctx); if (isErr(x)) return x; const v = variance(x, false); return isErr(v) ? v : Math.sqrt(v); } });
def('VAR VAR.S', { args: 'number1, [number2], …', desc: 'Variance of a sample', fn: (a, ctx) => { const x = nums(a, ctx); return isErr(x) ? x : variance(x, true); } });
def('VARP VAR.P', { args: 'number1, [number2], …', desc: 'Variance of a population', fn: (a, ctx) => { const x = nums(a, ctx); return isErr(x) ? x : variance(x, false); } });
def('LARGE', { args: 'array, k', desc: 'The k-th largest value', fn: (a, ctx) => { const x = nums([a[0]], ctx); const k = num(scalar(a[1], ctx)); if (isErr(x)) return x; if (isErr(k)) return k; const s = sorted(x).reverse(); return k >= 1 && k <= s.length ? s[Math.ceil(k) - 1] : err('#NUM!'); } });
def('SMALL', { args: 'array, k', desc: 'The k-th smallest value', fn: (a, ctx) => { const x = nums([a[0]], ctx); const k = num(scalar(a[1], ctx)); if (isErr(x)) return x; if (isErr(k)) return k; const s = sorted(x); return k >= 1 && k <= s.length ? s[Math.ceil(k) - 1] : err('#NUM!'); } });
def('RANK RANK.EQ RANK.AVG', { args: 'number, ref, [order]', desc: 'Rank of a number in a list', fn: (a, ctx) => {
  const v = num(scalar(a[0], ctx));
  const x = nums([a[1]], ctx);
  const asc = a[2] !== undefined && bool(scalar(a[2], ctx)) === true;
  if (isErr(v)) return v;
  if (isErr(x)) return x;
  if (!x.includes(v)) return err('#N/A');
  return 1 + x.filter((y) => (asc ? y < v : y > v)).length;
} });
def('PERCENTILE PERCENTILE.INC', { args: 'array, k', desc: 'The k-th percentile', fn: (a, ctx) => { const x = nums([a[0]], ctx); const k = num(scalar(a[1], ctx)); if (isErr(x)) return x; return isErr(k) ? k : k < 0 || k > 1 ? err('#NUM!') : percentile(x, k); } });
def('PERCENTILE.EXC', { args: 'array, k', desc: 'The k-th percentile, exclusive', fn: (a, ctx) => { const x = nums([a[0]], ctx); const k = num(scalar(a[1], ctx)); if (isErr(x)) return x; return isErr(k) ? k : percentile(x, k, true); } });
def('QUARTILE QUARTILE.INC', { args: 'array, quart', desc: 'A quartile', fn: (a, ctx) => { const x = nums([a[0]], ctx); const q = num(scalar(a[1], ctx)); if (isErr(x)) return x; return isErr(q) ? q : q < 0 || q > 4 ? err('#NUM!') : percentile(x, Math.floor(q) / 4); } });
def('GEOMEAN', { args: 'number1, …', desc: 'Geometric mean', fn: (a, ctx) => { const x = nums(a, ctx); if (isErr(x)) return x; if (!x.length || x.some((v) => v <= 0)) return err('#NUM!'); return Math.exp(sum(x.map(Math.log)) / x.length); } });
def('HARMEAN', { args: 'number1, …', desc: 'Harmonic mean', fn: (a, ctx) => { const x = nums(a, ctx); if (isErr(x)) return x; if (!x.length || x.some((v) => v <= 0)) return err('#NUM!'); return x.length / sum(x.map((v) => 1 / v)); } });
def('AVEDEV', { args: 'number1, …', desc: 'Average distance from the mean', fn: (a, ctx) => { const x = nums(a, ctx); if (isErr(x)) return x; const m = mean(x); return isErr(m) ? m : mean(x.map((v) => Math.abs(v - m))); } });
function pairsXY(a, ctx) {
  const ys = flat(a[0], ctx);
  const xs = flat(a[1], ctx);
  if (ys.length !== xs.length) return err('#N/A');
  const P = [];
  for (let i = 0; i < ys.length; i++) if (typeof ys[i] === 'number' && typeof xs[i] === 'number') P.push([xs[i], ys[i]]);
  return P;
}
function regress(P) {
  const n = P.length;
  if (n < 2) return err('#DIV/0!');
  const mx = sum(P.map((p) => p[0])) / n;
  const my = sum(P.map((p) => p[1])) / n;
  const sxy = sum(P.map(([x, y]) => (x - mx) * (y - my)));
  const sxx = sum(P.map(([x]) => (x - mx) ** 2));
  const syy = sum(P.map(([, y]) => (y - my) ** 2));
  if (!sxx) return err('#DIV/0!');
  return { slope: sxy / sxx, intercept: my - (sxy / sxx) * mx, r: sxy / Math.sqrt(sxx * syy), n, sxy };
}
def('SLOPE', { args: 'known_ys, known_xs', desc: 'Slope of the best-fit line', fn: (a, ctx) => { const P = pairsXY(a, ctx); if (isErr(P)) return P; const r = regress(P); return isErr(r) ? r : r.slope; } });
def('INTERCEPT', { args: 'known_ys, known_xs', desc: 'Where the best-fit line crosses the y axis', fn: (a, ctx) => { const P = pairsXY(a, ctx); if (isErr(P)) return P; const r = regress(P); return isErr(r) ? r : r.intercept; } });
def('CORREL PEARSON', { args: 'array1, array2', desc: 'Correlation coefficient', fn: (a, ctx) => { const P = pairsXY(a, ctx); if (isErr(P)) return P; const r = regress(P); return isErr(r) ? r : finite(r.r); } });
def('RSQ', { args: 'known_ys, known_xs', desc: 'R squared of the best-fit line', fn: (a, ctx) => { const P = pairsXY(a, ctx); if (isErr(P)) return P; const r = regress(P); return isErr(r) ? r : finite(r.r ** 2); } });
def('COVARIANCE.S COVAR COVARIANCE.P', { args: 'array1, array2', desc: 'Covariance', fn: (a, ctx) => { const P = pairsXY(a, ctx); if (isErr(P)) return P; const r = regress(P); return isErr(r) ? r : r.sxy / (r.n - 1); } });
def('FORECAST FORECAST.LINEAR', { args: 'x, known_ys, known_xs', desc: 'Predicts a value on the best-fit line', fn: (a, ctx) => { const x = num(scalar(a[0], ctx)); const P = pairsXY([a[1], a[2]], ctx); if (isErr(P)) return P; const r = regress(P); return isErr(r) ? r : r.intercept + r.slope * x; } });
def('TREND', { args: 'known_ys, [known_xs], [new_xs]', desc: 'Values along the best-fit line', fn: (a, ctx) => {
  const ys = flat(a[0], ctx);
  const xs = a[1] ? flat(a[1], ctx) : ys.map((_, i) => i + 1);
  const r = regress(ys.map((y, i) => [xs[i], y]).filter(([x, y]) => typeof x === 'number' && typeof y === 'number'));
  if (isErr(r)) return r;
  const nx = a[2] ? grid(a[2], ctx) : xs.map((x) => [x]);
  return new Arr(nx.map((row) => row.map((x) => (typeof x === 'number' ? r.intercept + r.slope * x : err('#VALUE!')))));
} });
const erf = (x) => {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
};
def('NORM.DIST NORMDIST', { args: 'x, mean, standard_dev, cumulative', desc: 'Normal distribution', fn: (a, ctx) => {
  const [x, m, sd, c] = a.map((v) => scalar(v, ctx));
  const X = num(x); const M = num(m); const S = num(sd);
  if ([X, M, S].some(isErr)) return err('#VALUE!');
  if (S <= 0) return err('#NUM!');
  return bool(c) === true ? 0.5 * (1 + erf((X - M) / (S * Math.SQRT2))) : Math.exp(-((X - M) ** 2) / (2 * S * S)) / (S * Math.sqrt(2 * Math.PI));
} });
def('STANDARDIZE', { args: 'x, mean, standard_dev', desc: 'A z-score', fn: N((x, m, s) => (s <= 0 ? err('#NUM!') : (x - m) / s)) });

// ---- logic ----
def('IF', { args: 'test, value_if_true, [value_if_false]', desc: 'Chooses a value by a test', lazy: true, fn: (asts, ctx, ev) => {
  const t = ev(asts[0]);
  if (t instanceof Arr || (t instanceof Rng && !t.single)) {
    const g = grid(t, ctx);
    const yes = asts[1] ? ev(asts[1]) : true;
    const no = asts[2] && asts[2].k !== 'missing' ? ev(asts[2]) : false;
    return new Arr(g.map((row, r) => row.map((v, c) => {
      const b = bool(v);
      if (isErr(b)) return b;
      const pick = b ? yes : no;
      if (pick instanceof Arr || pick instanceof Rng) { const pg = grid(pick, ctx); return (pg[r] || pg[0])[pg[0].length === 1 ? 0 : c]; }
      return pick;
    })));
  }
  const b = bool(scalar(t, ctx));
  if (isErr(b)) return b;
  if (b) return asts[1] && asts[1].k !== 'missing' ? ev(asts[1]) : (asts[1] ? 0 : true);
  return asts.length > 2 ? (asts[2].k === 'missing' ? 0 : ev(asts[2])) : false;
} });
def('IFS', { args: 'test1, value1, [test2, value2], …', desc: 'The value of the first test that is true', lazy: true, fn: (asts, ctx, ev) => {
  for (let i = 0; i + 1 < asts.length; i += 2) {
    const b = bool(scalar(ev(asts[i]), ctx));
    if (isErr(b)) return b;
    if (b) return ev(asts[i + 1]);
  }
  return err('#N/A');
} });
def('IFERROR', { args: 'value, value_if_error', desc: 'A replacement for errors', lazy: true, fn: (asts, ctx, ev) => {
  const v = ev(asts[0]);
  if (v instanceof Arr) return new Arr(v.data.map((row) => row.map((x) => (isErr(x) ? scalar(ev(asts[1]), ctx) : x))));
  const s = v instanceof Rng ? scalar(v, ctx) : v;
  return isErr(s) ? ev(asts[1]) : v;
} });
def('IFNA', { args: 'value, value_if_na', desc: 'A replacement for #N/A', lazy: true, fn: (asts, ctx, ev) => { const v = scalar(ev(asts[0]), ctx); return isErr(v) && v.code === '#N/A' ? ev(asts[1]) : v; } });
def('AND', { args: 'logical1, [logical2], …', desc: 'True when every test is true', fn: (a, ctx) => { let any = false; for (const [v] of each(a, ctx)) { if (isErr(v)) return v; if (v === null || typeof v === 'string') continue; any = true; if (!bool(v)) return false; } return any ? true : err('#VALUE!'); } });
def('OR', { args: 'logical1, [logical2], …', desc: 'True when any test is true', fn: (a, ctx) => { let any = false; for (const [v] of each(a, ctx)) { if (isErr(v)) return v; if (v === null || typeof v === 'string') continue; any = true; if (bool(v)) return true; } return any ? false : err('#VALUE!'); } });
def('XOR', { args: 'logical1, [logical2], …', desc: 'True when an odd number of tests are true', fn: (a, ctx) => { let n = 0; for (const [v] of each(a, ctx)) { if (isErr(v)) return v; if (v !== null && typeof v !== 'string' && bool(v)) n++; } return n % 2 === 1; } });
def('NOT', { args: 'logical', desc: 'Reverses true and false', fn: lift((a) => { const b = bool(a[0]); return isErr(b) ? b : !b; }) });
def('TRUE', { args: '', desc: 'TRUE', fn: () => true });
def('FALSE', { args: '', desc: 'FALSE', fn: () => false });
def('SWITCH', { args: 'expression, value1, result1, …, [default]', desc: 'Matches a value against a list', lazy: true, fn: (asts, ctx, ev) => {
  const v = scalar(ev(asts[0]), ctx);
  if (isErr(v)) return v;
  let i = 1;
  for (; i + 1 < asts.length; i += 2) if (eqLoose(scalar(ev(asts[i]), ctx), v)) return ev(asts[i + 1]);
  return i < asts.length ? ev(asts[i]) : err('#N/A');
} });
def('CHOOSE', { args: 'index, value1, [value2], …', desc: 'Picks a value by its position', lazy: true, fn: (asts, ctx, ev) => {
  const i = num(scalar(ev(asts[0]), ctx));
  if (isErr(i)) return i;
  const k = Math.floor(i);
  return k >= 1 && k < asts.length ? ev(asts[k]) : err('#VALUE!');
} });
def('LET', { args: 'name1, value1, [name2, value2], …, calculation', desc: 'Names values to reuse in a calculation', lazy: true, fn: (asts, ctx, ev) => {
  const saved = ctx.locals;
  ctx.locals = new Map(saved || []);
  try {
    for (let i = 0; i + 1 < asts.length; i += 2) {
      if (asts[i].k !== 'nm') return err('#VALUE!');
      ctx.locals.set(asts[i].v.toUpperCase(), ev(asts[i + 1]));
    }
    return ev(asts[asts.length - 1]);
  } finally { ctx.locals = saved; }
} });

// ---- information ----
const is = (name, test, desc) => def(name, { args: 'value', desc, acceptsErrors: true, fn: lift((a) => test(a[0])) });
is('ISBLANK', (v) => v === null || v === undefined, 'True when the cell is empty');
is('ISNUMBER', (v) => typeof v === 'number', 'True for numbers');
is('ISTEXT', (v) => typeof v === 'string', 'True for text');
is('ISNONTEXT', (v) => typeof v !== 'string', 'True for anything but text');
is('ISLOGICAL', (v) => typeof v === 'boolean', 'True for TRUE and FALSE');
is('ISERROR', (v) => isErr(v), 'True for any error');
is('ISERR', (v) => isErr(v) && v.code !== '#N/A', 'True for any error but #N/A');
is('ISNA', (v) => isErr(v) && v.code === '#N/A', 'True for #N/A');
is('ISEVEN', (v) => Math.floor(num(v)) % 2 === 0, 'True for even numbers');
is('ISODD', (v) => Math.abs(Math.floor(num(v)) % 2) === 1, 'True for odd numbers');
def('ISREF', { args: 'value', desc: 'True for a reference', fn: (a) => a[0] instanceof Rng });
def('ISFORMULA', { args: 'reference', desc: 'True when the cell holds a formula', fn: (a, ctx) => (a[0] instanceof Rng ? ctx.isFormula(a[0].sheet, a[0].r0, a[0].c0) : err('#VALUE!')) });
def('FORMULATEXT', { args: 'reference', desc: 'The formula in a cell, as text', fn: (a, ctx) => (a[0] instanceof Rng ? ctx.formulaText(a[0].sheet, a[0].r0, a[0].c0) || err('#N/A') : err('#VALUE!')) });
def('NA', { args: '', desc: 'The #N/A error', fn: () => err('#N/A') });
def('ERROR.TYPE', { args: 'error', desc: 'The number of an error', acceptsErrors: true, fn: (a, ctx) => { const v = scalar(a[0], ctx); const i = ['#NULL!', '#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A'].indexOf(isErr(v) ? v.code : ''); return i < 0 ? err('#N/A') : i + 1; } });
def('TYPE', { args: 'value', desc: 'The type of a value: 1 number, 2 text, 4 logical, 16 error, 64 array', acceptsErrors: true, fn: (a, ctx) => { const v = a[0]; if (v instanceof Arr || (v instanceof Rng && !v.single)) return 64; const s = scalar(v, ctx); return typeof s === 'number' || s === null ? 1 : typeof s === 'string' ? 2 : typeof s === 'boolean' ? 4 : isErr(s) ? 16 : 1; } });
def('N', { args: 'value', desc: 'A value as a number', fn: lift((a) => (typeof a[0] === 'number' ? a[0] : typeof a[0] === 'boolean' ? +a[0] : 0)) });
def('T', { args: 'value', desc: 'Text, or empty text', fn: lift((a) => (typeof a[0] === 'string' ? a[0] : '')) });

// ---- text ----
const T1 = (f) => lift((a) => { const e = firstErr(...a); if (e) return e; return f(...a); });
def('CONCAT', { args: 'text1, [text2], …', desc: 'Joins text', fn: (a, ctx) => { let s = ''; for (const [v] of each(a, ctx)) { if (isErr(v)) return v; s += str(v); } return s; } });
def('CONCATENATE', { args: 'text1, [text2], …', desc: 'Joins text', fn: lift((a) => { const e = firstErr(...a); return e || a.map(str).join(''); }) });
def('TEXTJOIN', { args: 'delimiter, ignore_empty, text1, …', desc: 'Joins text with a separator', fn: (a, ctx) => {
  const d = str(scalar(a[0], ctx));
  const skip = bool(scalar(a[1], ctx)) === true;
  const out = [];
  for (const [v] of each(a.slice(2), ctx)) { if (isErr(v)) return v; const s = str(v); if (!(skip && s === '')) out.push(s); }
  return out.join(d);
} });
def('LEN', { args: 'text', desc: 'Number of characters', fn: T1((s) => str(s).length) });
def('LOWER', { args: 'text', desc: 'Lowercase', fn: T1((s) => str(s).toLowerCase()) });
def('UPPER', { args: 'text', desc: 'Uppercase', fn: T1((s) => str(s).toUpperCase()) });
def('PROPER', { args: 'text', desc: 'Capitalises each word', fn: T1((s) => str(s).toLowerCase().replace(/(^|[^\p{L}'])(\p{L})/gu, (m, a, b) => a + b.toUpperCase())) });
def('TRIM', { args: 'text', desc: 'Removes extra spaces', fn: T1((s) => str(s).replace(/ +/g, ' ').trim()) });
def('CLEAN', { args: 'text', desc: 'Removes characters that cannot be printed', fn: T1((s) => str(s).replace(/[\u0000-\u001f]/g, '')) });
def('LEFT', { args: 'text, [count]', desc: 'Characters from the start', fn: T1((s, n = 1) => { const k = num(n); return isErr(k) ? k : k < 0 ? err('#VALUE!') : str(s).slice(0, k); }) });
def('RIGHT', { args: 'text, [count]', desc: 'Characters from the end', fn: T1((s, n = 1) => { const k = num(n); return isErr(k) ? k : k < 0 ? err('#VALUE!') : k === 0 ? '' : str(s).slice(-k); }) });
def('MID', { args: 'text, start, count', desc: 'Characters from the middle', fn: T1((s, st, n) => { const a = num(st); const k = num(n); return firstErr(a, k) || (a < 1 || k < 0 ? err('#VALUE!') : str(s).substr(a - 1, k)); }) });
def('REPT', { args: 'text, times', desc: 'Repeats text', fn: T1((s, n) => { const k = num(n); return isErr(k) ? k : k < 0 || k * str(s).length > 32767 ? err('#VALUE!') : str(s).repeat(Math.floor(k)); }) });
def('EXACT', { args: 'text1, text2', desc: 'True when two texts are exactly the same', fn: T1((a, b) => str(a) === str(b)) });
def('FIND', { args: 'find_text, within_text, [start]', desc: 'Position of text (case-sensitive)', fn: T1((f, s, st = 1) => { const i = str(s).indexOf(str(f), num(st) - 1); return i < 0 ? err('#VALUE!') : i + 1; }) });
def('SEARCH', { args: 'find_text, within_text, [start]', desc: 'Position of text (any case, wildcards)', fn: T1((f, s, st = 1) => {
  const hay = str(s).toLowerCase();
  const pat = str(f).toLowerCase();
  const re = new RegExp(pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/~\*/g, '\u0001').replace(/\*/g, '.*').replace(/\?/g, '.').replace(/\u0001/g, '\\*'));
  const m = re.exec(hay.slice(num(st) - 1));
  return m ? m.index + num(st) : err('#VALUE!');
}) });
def('SUBSTITUTE', { args: 'text, old_text, new_text, [instance]', desc: 'Replaces text', fn: T1((s, o, n, inst) => {
  const S = str(s); const O = str(o); const Nn = str(n);
  if (!O) return S;
  if (inst === undefined) return S.split(O).join(Nn);
  let k = num(inst);
  let i = -1;
  while (k-- > 0) { i = S.indexOf(O, i + 1); if (i < 0) return S; }
  return S.slice(0, i) + Nn + S.slice(i + O.length);
}) });
def('REPLACE', { args: 'old_text, start, count, new_text', desc: 'Replaces characters by position', fn: T1((s, st, n, t) => { const S = str(s); const a = num(st) - 1; return S.slice(0, a) + str(t) + S.slice(a + num(n)); }) });
def('CHAR', { args: 'number', desc: 'The character with a code', fn: N((n) => String.fromCharCode(n)) });
def('UNICHAR', { args: 'number', desc: 'The Unicode character with a number', fn: N((n) => (n < 1 || n > 0x10ffff ? err('#VALUE!') : String.fromCodePoint(n))) });
def('CODE', { args: 'text', desc: 'The code of the first character', fn: T1((s) => (str(s) ? str(s).charCodeAt(0) : err('#VALUE!'))) });
def('UNICODE', { args: 'text', desc: 'The Unicode number of the first character', fn: T1((s) => (str(s) ? str(s).codePointAt(0) : err('#VALUE!'))) });
def('VALUE NUMBERVALUE', { args: 'text', desc: 'Text to a number', fn: T1((s) => (typeof s === 'number' ? s : num(str(s)))) });
def('TEXT', { args: 'value, format_text', desc: 'A number as text in a format', fn: (a, ctx) => lift((x) => { const e = firstErr(...x); if (e) return e; return ctx.formatValue(x[0], str(x[1])); })(a, ctx) });
def('DOLLAR', { args: 'number, [decimals]', desc: 'A number as money text', fn: (a, ctx) => lift((x) => ctx.formatValue(num(x[0]), `$#,##0${x[1] > 0 || x[1] === undefined ? `.${'0'.repeat(x[1] === undefined ? 2 : x[1])}` : ''}`))(a, ctx) });
def('FIXED', { args: 'number, [decimals], [no_commas]', desc: 'A number as text with fixed decimals', fn: (a, ctx) => lift((x) => ctx.formatValue(num(x[0]), `${bool(x[2] ?? false) === true ? '0' : '#,##0'}${(x[1] ?? 2) > 0 ? `.${'0'.repeat(x[1] ?? 2)}` : ''}`))(a, ctx) });
def('TEXTBEFORE', { args: 'text, delimiter, [instance]', desc: 'Text before a delimiter', fn: T1((s, d, n = 1) => { const S = str(s); const parts = S.split(str(d)); const k = num(n); if (parts.length <= Math.abs(k)) return err('#N/A'); return k > 0 ? parts.slice(0, k).join(str(d)) : parts.slice(0, parts.length + k).join(str(d)); }) });
def('TEXTAFTER', { args: 'text, delimiter, [instance]', desc: 'Text after a delimiter', fn: T1((s, d, n = 1) => { const S = str(s); const parts = S.split(str(d)); const k = num(n); if (parts.length <= Math.abs(k)) return err('#N/A'); return k > 0 ? parts.slice(k).join(str(d)) : parts.slice(parts.length + k).join(str(d)); }) });
def('TEXTSPLIT', { args: 'text, col_delimiter, [row_delimiter]', desc: 'Splits text into cells', fn: (a, ctx) => {
  const s = str(scalar(a[0], ctx));
  const cd = str(scalar(a[1], ctx));
  const rd = a[2] ? str(scalar(a[2], ctx)) : null;
  const rows = (rd ? s.split(rd) : [s]).map((r) => (cd ? r.split(cd) : [r]));
  const w = Math.max(...rows.map((r) => r.length));
  return new Arr(rows.map((r) => [...r, ...Array(w - r.length).fill(err('#N/A'))]));
} });
def('HYPERLINK', { args: 'url, [friendly_name]', desc: 'A clickable link', fn: (a, ctx) => { const u = str(scalar(a[0], ctx)); const t = a[1] ? scalar(a[1], ctx) : u; return { link: u, text: t, toString() { return str(t); } }; } });

// ---- dates and times ----
def('TODAY', { args: '', desc: "Today's date", volatile: true, fn: () => { const d = new Date(); return dateSerial(d.getFullYear(), d.getMonth() + 1, d.getDate()); } });
def('NOW', { args: '', desc: 'The date and time now', volatile: true, fn: () => { const d = new Date(); return dateSerial(d.getFullYear(), d.getMonth() + 1, d.getDate()) + (d.getHours() * 3600 + d.getMinutes() * 60 + d.getSeconds()) / 86400; } });
def('DATE', { args: 'year, month, day', desc: 'A date from its parts', fn: N((y, m, d) => { if (y < 1900) y += 1900; return dateSerial(Math.floor(y), Math.floor(m), Math.floor(d)); }) });
def('TIME', { args: 'hour, minute, second', desc: 'A time from its parts', fn: N((h, m, s) => (((h * 3600 + m * 60 + s) / 86400) % 1 + 1) % 1) });
def('YEAR', { args: 'date', desc: 'The year of a date', fn: N((n) => parts(n).y) });
def('MONTH', { args: 'date', desc: 'The month of a date', fn: N((n) => parts(n).m) });
def('DAY', { args: 'date', desc: 'The day of the month', fn: N((n) => parts(n).d) });
def('HOUR', { args: 'time', desc: 'The hour', fn: N((n) => Math.floor(((n % 1) + 1e-9) * 24) % 24) });
def('MINUTE', { args: 'time', desc: 'The minute', fn: N((n) => Math.floor(((n % 1) * 1440 + 1e-7)) % 60) });
def('SECOND', { args: 'time', desc: 'The second', fn: N((n) => Math.round((n % 1) * 86400) % 60) });
def('WEEKDAY', { args: 'date, [type]', desc: 'Day of the week as a number', fn: N((n, t = 1) => { const wd = parts(n).wd; if (t === 2) return ((wd + 6) % 7) + 1; if (t === 3) return (wd + 6) % 7; return wd + 1; }) });
def('WEEKNUM', { args: 'date, [type]', desc: 'Week of the year', fn: N((n, t = 1) => { const p = parts(n); const jan1 = dateSerial(p.y, 1, 1); const wd1 = parts(jan1).wd; const shift = t === 2 ? (wd1 + 6) % 7 : wd1; return Math.floor((n - jan1 + shift) / 7) + 1; }) });
def('ISOWEEKNUM', { args: 'date', desc: 'ISO week of the year', fn: N((n) => { const d = fromSerial(Math.floor(n)); const day = (d.getUTCDay() + 6) % 7; d.setUTCDate(d.getUTCDate() - day + 3); const first = new Date(Date.UTC(d.getUTCFullYear(), 0, 4)); return 1 + Math.round(((d - first) / 86400000 - 3 + ((first.getUTCDay() + 6) % 7)) / 7); }) });
def('EDATE', { args: 'start_date, months', desc: 'The date some months away', fn: N((n, m) => { const p = parts(n); const last = new Date(Date.UTC(p.y, p.m - 1 + Math.trunc(m) + 1, 0)).getUTCDate(); return dateSerial(p.y, p.m + Math.trunc(m), Math.min(p.d, last)); }) });
def('EOMONTH', { args: 'start_date, months', desc: 'The last day of a month', fn: N((n, m) => { const p = parts(n); return toSerial(Date.UTC(p.y, p.m + Math.trunc(m), 0)); }) });
def('DAYS', { args: 'end_date, start_date', desc: 'Days between two dates', fn: N((e, s) => Math.floor(e) - Math.floor(s)) });
def('DAYS360', { args: 'start_date, end_date', desc: 'Days between dates on a 360-day year', fn: N((s, e) => { const a = parts(s); const b = parts(e); const d1 = Math.min(a.d, 30); const d2 = b.d === 31 && d1 >= 30 ? 30 : b.d; return (b.y - a.y) * 360 + (b.m - a.m) * 30 + (d2 - d1); }) });
def('DATEDIF', { args: 'start_date, end_date, unit', desc: 'The time between dates in years, months or days', fn: (a, ctx) => lift((x) => {
  const s = num(x[0]); const e = num(x[1]); const u = str(x[2]).toUpperCase();
  if (firstErr(s, e)) return firstErr(s, e);
  if (e < s) return err('#NUM!');
  const A = parts(s); const B = parts(e);
  let months = (B.y - A.y) * 12 + (B.m - A.m) - (B.d < A.d ? 1 : 0);
  if (u === 'Y') return Math.floor(months / 12);
  if (u === 'M') return months;
  if (u === 'D') return Math.floor(e) - Math.floor(s);
  if (u === 'YM') return months % 12;
  if (u === 'MD') return B.d >= A.d ? B.d - A.d : Math.floor(e - dateSerial(B.y, B.m - 1, A.d));
  if (u === 'YD') { let y = dateSerial(B.y, A.m, A.d); if (y > e) y = dateSerial(B.y - 1, A.m, A.d); return Math.floor(e - y); }
  return err('#NUM!');
})(a, ctx) });
def('DATEVALUE', { args: 'date_text', desc: 'A date written as text, as a date', fn: T1((s) => { const v = parseNumber(str(s)); return v === null ? err('#VALUE!') : Math.floor(v); }) });
def('TIMEVALUE', { args: 'time_text', desc: 'A time written as text, as a time', fn: T1((s) => { const v = parseNumber(str(s)); return v === null ? err('#VALUE!') : v % 1; }) });
def('YEARFRAC', { args: 'start_date, end_date, [basis]', desc: 'The fraction of a year between dates', fn: N((s, e, b = 0) => Math.abs(e - s) / (b === 3 ? 365 : b === 2 ? 360 : 365.25)) });
function workdays(s, e, hol) {
  const step = e >= s ? 1 : -1;
  let n = 0;
  for (let d = Math.floor(s); step > 0 ? d <= e : d >= e; d += step) {
    const wd = parts(d).wd;
    if (wd !== 0 && wd !== 6 && !hol.has(d)) n += step;
  }
  return n;
}
def('NETWORKDAYS', { args: 'start_date, end_date, [holidays]', desc: 'Working days between dates', fn: (a, ctx) => { const s = num(scalar(a[0], ctx)); const e = num(scalar(a[1], ctx)); if (firstErr(s, e)) return firstErr(s, e); const hol = new Set(a[2] ? flat(a[2], ctx).filter((v) => typeof v === 'number').map(Math.floor) : []); return workdays(s, e, hol); } });
def('WORKDAY', { args: 'start_date, days, [holidays]', desc: 'The date some working days away', fn: (a, ctx) => {
  let d = Math.floor(num(scalar(a[0], ctx)));
  let n = num(scalar(a[1], ctx));
  const hol = new Set(a[2] ? flat(a[2], ctx).filter((v) => typeof v === 'number').map(Math.floor) : []);
  const step = n >= 0 ? 1 : -1;
  while (n !== 0) { d += step; const wd = parts(d).wd; if (wd !== 0 && wd !== 6 && !hol.has(d)) n -= step; }
  return d;
} });

// ---- finance ----
const pmt = (r, n, pv, fv = 0, t = 0) => (r === 0 ? -(pv + fv) / n : (-(pv * (1 + r) ** n + fv) * r) / ((1 + r * t) * ((1 + r) ** n - 1)));
const fvf = (r, n, p, pv = 0, t = 0) => (r === 0 ? -(pv + p * n) : -(pv * (1 + r) ** n + (p * (1 + r * t) * ((1 + r) ** n - 1)) / r));
def('PMT', { args: 'rate, nper, pv, [fv], [type]', desc: 'Loan payment per period', fn: N((r, n, pv, fv = 0, t = 0) => finite(pmt(r, n, pv, fv, t))) });
def('FV', { args: 'rate, nper, pmt, [pv], [type]', desc: 'Future value of an investment', fn: N((r, n, p, pv = 0, t = 0) => finite(fvf(r, n, p, pv, t))) });
def('PV', { args: 'rate, nper, pmt, [fv], [type]', desc: 'Present value of an investment', fn: N((r, n, p, fv = 0, t = 0) => finite(r === 0 ? -(fv + p * n) : -(fv + (p * (1 + r * t) * ((1 + r) ** n - 1)) / r) / (1 + r) ** n)) });
def('NPER', { args: 'rate, pmt, pv, [fv], [type]', desc: 'Number of payment periods', fn: N((r, p, pv, fv = 0, t = 0) => finite(r === 0 ? -(pv + fv) / p : Math.log((p * (1 + r * t) - fv * r) / (p * (1 + r * t) + pv * r)) / Math.log(1 + r))) });
def('IPMT', { args: 'rate, per, nper, pv, [fv], [type]', desc: 'Interest part of a payment', fn: N((r, per, n, pv, fv = 0, t = 0) => { const p = pmt(r, n, pv, fv, t); const bal = fvf(r, per - 1, p, pv, t); return finite(t === 1 && per === 1 ? 0 : bal * r * (t === 1 ? 1 / (1 + r) : 1)); }) });
def('PPMT', { args: 'rate, per, nper, pv, [fv], [type]', desc: 'Principal part of a payment', fn: N((r, per, n, pv, fv = 0, t = 0) => { const p = pmt(r, n, pv, fv, t); const bal = fvf(r, per - 1, p, pv, t); const ip = t === 1 && per === 1 ? 0 : bal * r * (t === 1 ? 1 / (1 + r) : 1); return finite(p - ip); }) });
def('RATE', { args: 'nper, pmt, pv, [fv], [type], [guess]', desc: 'Interest rate per period', fn: N((n, p, pv, fv = 0, t = 0, g = 0.1) => {
  let r = g;
  for (let i = 0; i < 100; i++) {
    const f = pv * (1 + r) ** n + p * (1 + r * t) * (((1 + r) ** n - 1) / (r || 1e-12)) + fv;
    const d = (rr) => pv * (1 + rr) ** n + p * (1 + rr * t) * (((1 + rr) ** n - 1) / (rr || 1e-12)) + fv;
    const df = (d(r + 1e-7) - f) / 1e-7;
    const nr = r - f / df;
    if (!Number.isFinite(nr)) return err('#NUM!');
    if (Math.abs(nr - r) < 1e-10) return nr;
    r = nr;
  }
  return err('#NUM!');
}) });
def('NPV', { args: 'rate, value1, [value2], …', desc: 'Net present value', fn: (a, ctx) => { const r = num(scalar(a[0], ctx)); const x = nums(a.slice(1), ctx); if (isErr(r)) return r; if (isErr(x)) return x; return x.reduce((s, v, i) => s + v / (1 + r) ** (i + 1), 0); } });
def('IRR', { args: 'values, [guess]', desc: 'Internal rate of return', fn: (a, ctx) => {
  const x = nums([a[0]], ctx);
  if (isErr(x)) return x;
  let r = a[1] ? num(scalar(a[1], ctx)) : 0.1;
  for (let i = 0; i < 200; i++) {
    let f = 0; let df = 0;
    x.forEach((v, k) => { f += v / (1 + r) ** k; df -= (k * v) / (1 + r) ** (k + 1); });
    const nr = r - f / df;
    if (!Number.isFinite(nr)) return err('#NUM!');
    if (Math.abs(nr - r) < 1e-10) return nr;
    r = nr;
  }
  return err('#NUM!');
} });
def('SLN', { args: 'cost, salvage, life', desc: 'Straight-line depreciation', fn: N((c, s, l) => (l === 0 ? err('#DIV/0!') : (c - s) / l)) });
def('EFFECT', { args: 'nominal_rate, npery', desc: 'Effective annual interest rate', fn: N((r, n) => (1 + r / Math.floor(n)) ** Math.floor(n) - 1) });

// ---- lookup and arrays ----
def('ROW', { args: '[reference]', desc: 'Row number', fn: (a, ctx) => (a[0] instanceof Rng ? (a[0].single ? a[0].r0 + 1 : new Arr(Array.from({ length: a[0].rows }, (_, i) => [a[0].r0 + i + 1]))) : ctx.row + 1) });
def('COLUMN', { args: '[reference]', desc: 'Column number', fn: (a, ctx) => (a[0] instanceof Rng ? (a[0].single ? a[0].c0 + 1 : new Arr([Array.from({ length: a[0].cols }, (_, i) => a[0].c0 + i + 1)])) : ctx.col + 1) });
def('ROWS', { args: 'array', desc: 'Number of rows', fn: (a, ctx) => (a[0] instanceof Rng ? a[0].rows : grid(a[0], ctx).length) });
def('COLUMNS', { args: 'array', desc: 'Number of columns', fn: (a, ctx) => (a[0] instanceof Rng ? a[0].cols : grid(a[0], ctx)[0].length) });
def('ADDRESS', { args: 'row, column, [abs], [a1], [sheet]', desc: 'A cell address as text', fn: N((r, c, abs = 1) => addr(r - 1, c - 1, abs === 1 || abs === 2, abs === 1 || abs === 3)) });
def('INDEX', { args: 'array, row, [column]', desc: 'The value at a row and column', fn: (a, ctx) => {
  const r = a[1] === undefined ? 0 : num(scalar(a[1], ctx));
  const c = a[2] === undefined ? 0 : num(scalar(a[2], ctx));
  if (firstErr(r, c)) return firstErr(r, c);
  const src = a[0];
  if (src instanceof Rng) {
    const rows = src.rows;
    const cols = src.cols;
    let rr = r; let cc = c;
    if (rows === 1 && a[2] === undefined) { cc = r; rr = 1; }
    if (rr > rows || cc > cols || rr < 0 || cc < 0) return err('#REF!');
    if (rr === 0) return new Rng(src.sheet, src.r0, src.c0 + cc - 1, src.r1, src.c0 + cc - 1);
    if (cc === 0) return cols === 1 ? new Rng(src.sheet, src.r0 + rr - 1, src.c0, src.r0 + rr - 1, src.c0) : new Rng(src.sheet, src.r0 + rr - 1, src.c0, src.r0 + rr - 1, src.c1);
    return new Rng(src.sheet, src.r0 + rr - 1, src.c0 + cc - 1, src.r0 + rr - 1, src.c0 + cc - 1);
  }
  const g = grid(src, ctx);
  let rr = r; let cc = c;
  if (g.length === 1 && a[2] === undefined) { cc = r; rr = 1; }
  if (rr < 1 || cc < 0 || rr > g.length) return err('#REF!');
  if (cc === 0) return g[0].length === 1 ? g[rr - 1][0] : new Arr([g[rr - 1]]);
  return cc <= g[0].length ? g[rr - 1][cc - 1] : err('#REF!');
} });
def('MATCH', { args: 'lookup_value, lookup_array, [match_type]', desc: 'Position of a value in a list', fn: (a, ctx) => {
  const key = scalar(a[0], ctx);
  if (isErr(key)) return key;
  const list = flat(a[1], ctx);
  const t = a[2] === undefined ? 1 : num(scalar(a[2], ctx));
  let i;
  if (t === 0) i = lookupIndex(list, key, 0);
  else i = approxSorted(list, key, t < 0);
  return i < 0 ? err('#N/A') : i + 1;
} });
def('XMATCH', { args: 'lookup_value, lookup_array, [match_mode], [search_mode]', desc: 'Position of a value (modern MATCH)', fn: (a, ctx) => {
  const key = scalar(a[0], ctx);
  const list = flat(a[1], ctx);
  const mode = a[2] === undefined ? 0 : num(scalar(a[2], ctx));
  const search = a[3] === undefined ? 1 : num(scalar(a[3], ctx));
  const i = lookupIndex(list, key, mode, true, search);
  return i < 0 ? err('#N/A') : i + 1;
} });
def('VLOOKUP', { args: 'lookup_value, table, column, [approximate]', desc: 'Looks down the first column of a table', fn: (a, ctx) => {
  const key = scalar(a[0], ctx);
  if (isErr(key)) return key;
  const g = grid(a[1], ctx);
  const col = num(scalar(a[2], ctx));
  if (isErr(col)) return col;
  if (col < 1 || col > (g[0] || []).length) return err('#REF!');
  const approx = a[3] === undefined ? true : bool(scalar(a[3], ctx)) === true;
  const first = g.map((r) => r[0]);
  const i = approx ? approxSorted(first, key) : lookupIndex(first, key, 0);
  return i < 0 ? err('#N/A') : g[i][col - 1];
} });
def('HLOOKUP', { args: 'lookup_value, table, row, [approximate]', desc: 'Looks across the first row of a table', fn: (a, ctx) => {
  const key = scalar(a[0], ctx);
  const g = grid(a[1], ctx);
  const row = num(scalar(a[2], ctx));
  if (row < 1 || row > g.length) return err('#REF!');
  const approx = a[3] === undefined ? true : bool(scalar(a[3], ctx)) === true;
  const i = approx ? approxSorted(g[0], key) : lookupIndex(g[0], key, 0);
  return i < 0 ? err('#N/A') : g[row - 1][i];
} });
def('XLOOKUP', { args: 'lookup_value, lookup_array, return_array, [if_not_found], [match_mode], [search_mode]', desc: 'Finds a value and returns what is beside it', fn: (a, ctx) => {
  const key = scalar(a[0], ctx);
  if (isErr(key)) return key;
  const look = grid(a[1], ctx);
  const ret = grid(a[2], ctx);
  const vertical = look[0].length === 1;
  const list = vertical ? look.map((r) => r[0]) : look[0];
  const mode = a[4] === undefined ? 0 : num(scalar(a[4], ctx));
  const search = a[5] === undefined ? 1 : num(scalar(a[5], ctx));
  const i = lookupIndex(list, key, mode, true, search);
  if (i < 0) return a[3] !== undefined ? scalar(a[3], ctx) : err('#N/A');
  if (vertical) return ret[0].length === 1 ? ret[i][0] : new Arr([ret[i]]);
  return ret.length === 1 ? ret[0][i] : new Arr(ret.map((r) => [r[i]]));
} });
def('LOOKUP', { args: 'lookup_value, lookup_vector, [result_vector]', desc: 'Looks up a value in a sorted list', fn: (a, ctx) => {
  const key = scalar(a[0], ctx);
  const list = flat(a[1], ctx);
  const res = a[2] ? flat(a[2], ctx) : list;
  const i = approxSorted(list, key);
  return i < 0 ? err('#N/A') : res[i] ?? err('#N/A');
} });
def('OFFSET', { args: 'reference, rows, cols, [height], [width]', desc: 'A reference moved from a start', volatile: true, fn: (a, ctx) => {
  const base = a[0];
  if (!(base instanceof Rng)) return err('#VALUE!');
  const [dr, dc] = [num(scalar(a[1], ctx)), num(scalar(a[2], ctx))];
  const hgt = a[3] === undefined ? base.rows : num(scalar(a[3], ctx));
  const wid = a[4] === undefined ? base.cols : num(scalar(a[4], ctx));
  if (firstErr(dr, dc, hgt, wid)) return err('#VALUE!');
  const r0 = base.r0 + dr; const c0 = base.c0 + dc;
  if (r0 < 0 || c0 < 0 || hgt < 1 || wid < 1 || r0 + hgt > MAX_ROWS || c0 + wid > MAX_COLS) return err('#REF!');
  return new Rng(base.sheet, r0, c0, r0 + hgt - 1, c0 + wid - 1);
} });
def('INDIRECT', { args: 'ref_text', desc: 'A reference written as text', volatile: true, fn: (a, ctx) => {
  const s = str(scalar(a[0], ctx)).trim();
  const m = /^(?:(?:'((?:[^']|'')+)'|([^!]+))!)?(.+)$/.exec(s);
  if (!m) return err('#REF!');
  const sheet = m[1] ? m[1].replace(/''/g, "'") : m[2] || ctx.sheet;
  const [p, q] = m[3].split(':');
  const A = parseAddr(p);
  const B = q ? parseAddr(q) : A;
  if (!A || !B || !ctx.hasSheet(sheet)) return err('#REF!');
  return new Rng(sheet, Math.min(A.r, B.r), Math.min(A.c, B.c), Math.max(A.r, B.r), Math.max(A.c, B.c));
} });
def('TRANSPOSE', { args: 'array', desc: 'Turns rows into columns', fn: (a, ctx) => { const g = grid(a[0], ctx); return new Arr(g[0].map((_, c) => g.map((r) => r[c]))); } });
def('FILTER', { args: 'array, include, [if_empty]', desc: 'The rows that meet a condition', fn: (a, ctx) => {
  const g = grid(a[0], ctx);
  const inc = grid(a[1], ctx);
  const byRow = inc.length === g.length;
  let out;
  if (byRow) out = g.filter((_, i) => { const v = inc[i][0]; return !isErr(v) && bool(v) === true; });
  else {
    const keep = inc[0].map((v) => !isErr(v) && bool(v) === true);
    out = g.map((r) => r.filter((_, i) => keep[i]));
    if (!out[0].length) out = [];
  }
  if (!out.length) return a[2] !== undefined ? scalar(a[2], ctx) : err('#CALC!', 'Nothing matched');
  return new Arr(out);
} });
def('SORT', { args: 'array, [sort_index], [sort_order], [by_col]', desc: 'Sorts a range', fn: (a, ctx) => {
  const g = grid(a[0], ctx).map((r) => [...r]);
  const idx = (a[1] === undefined ? 1 : num(scalar(a[1], ctx))) - 1;
  const ord = a[2] === undefined ? 1 : num(scalar(a[2], ctx));
  g.sort((x, y) => cmpValues(x[idx], y[idx]) * (ord < 0 ? -1 : 1));
  return new Arr(g);
} });
def('SORTBY', { args: 'array, by_array1, [order1], …', desc: 'Sorts a range by other values', fn: (a, ctx) => {
  const g = grid(a[0], ctx);
  const keys = [];
  for (let i = 1; i < a.length; i += 2) keys.push([flat(a[i], ctx), a[i + 1] === undefined ? 1 : num(scalar(a[i + 1], ctx))]);
  const order = g.map((_, i) => i).sort((x, y) => { for (const [k, o] of keys) { const c = cmpValues(k[x], k[y]); if (c) return c * (o < 0 ? -1 : 1); } return 0; });
  return new Arr(order.map((i) => g[i]));
} });
def('UNIQUE', { args: 'array, [by_col], [exactly_once]', desc: 'The distinct rows of a range', fn: (a, ctx) => {
  const g = grid(a[0], ctx);
  const once = a[2] !== undefined && bool(scalar(a[2], ctx)) === true;
  const key = (r) => JSON.stringify(r.map((v) => (typeof v === 'string' ? v.toLowerCase() : isErr(v) ? v.code : v)));
  const counts = new Map();
  for (const r of g) counts.set(key(r), (counts.get(key(r)) || 0) + 1);
  const seen = new Set();
  const out = [];
  for (const r of g) { const k = key(r); if (seen.has(k)) continue; seen.add(k); if (!once || counts.get(k) === 1) out.push(r); }
  return out.length ? new Arr(out) : err('#CALC!');
} });
def('VSTACK', { args: 'array1, [array2], …', desc: 'Stacks arrays on top of each other', fn: (a, ctx) => { const gs = a.map((x) => grid(x, ctx)); const w = Math.max(...gs.map((g) => g[0].length)); return new Arr(gs.flatMap((g) => g.map((r) => [...r, ...Array(w - r.length).fill(err('#N/A'))]))); } });
def('HSTACK', { args: 'array1, [array2], …', desc: 'Puts arrays side by side', fn: (a, ctx) => { const gs = a.map((x) => grid(x, ctx)); const h = Math.max(...gs.map((g) => g.length)); return new Arr(Array.from({ length: h }, (_, i) => gs.flatMap((g) => g[i] || Array(g[0].length).fill(err('#N/A'))))); } });
def('TAKE', { args: 'array, rows, [columns]', desc: 'The first (or last) rows of an array', fn: (a, ctx) => { let g = grid(a[0], ctx); const r = num(scalar(a[1], ctx)); g = r >= 0 ? g.slice(0, r) : g.slice(r); if (a[2] !== undefined) { const c = num(scalar(a[2], ctx)); g = g.map((row) => (c >= 0 ? row.slice(0, c) : row.slice(c))); } return g.length ? new Arr(g) : err('#CALC!'); } });
def('DROP', { args: 'array, rows, [columns]', desc: 'An array without its first (or last) rows', fn: (a, ctx) => { let g = grid(a[0], ctx); const r = num(scalar(a[1], ctx)); g = r >= 0 ? g.slice(r) : g.slice(0, r); if (a[2] !== undefined) { const c = num(scalar(a[2], ctx)); g = g.map((row) => (c >= 0 ? row.slice(c) : row.slice(0, c))); } return g.length ? new Arr(g) : err('#CALC!'); } });

// ---- our own ----
def('SPARKLINE', { args: 'data, [type]', desc: 'A tiny chart inside the cell: "line", "column" or "bar"', fn: (a, ctx) => {
  const data = flat(a[0], ctx).map((v) => (typeof v === 'number' ? v : null));
  const type = a[1] !== undefined ? str(scalar(a[1], ctx)).toLowerCase() : 'line';
  return new Spark(data, { type: ['line', 'column', 'bar', 'winloss'].includes(type) ? type : 'line' });
} });
def('PROGRESS', { args: 'value, [max]', desc: 'A progress bar inside the cell', fn: (a, ctx) => {
  const v = num(scalar(a[0], ctx));
  const m = a[1] === undefined ? 1 : num(scalar(a[1], ctx));
  if (firstErr(v, m)) return firstErr(v, m);
  return new Spark([Math.max(0, Math.min(1, m ? v / m : 0))], { type: 'progress', value: v });
} });
def('SHEETNAME SHEET', { args: '', desc: 'The name of this sheet', fn: (a, ctx) => ctx.sheet });

// ---- subtotals that see hidden and filtered rows ----
const SUB = { 1: 'AVERAGE', 2: 'COUNT', 3: 'COUNTA', 4: 'MAX', 5: 'MIN', 6: 'PRODUCT', 7: 'STDEV.S', 8: 'STDEV.P', 9: 'SUM', 10: 'VAR.S', 11: 'VAR.P' };
const nested = (ctx, sheet, r, c) => /^=\s*(SUBTOTAL|AGGREGATE)\s*\(/i.test(ctx.formulaText(sheet, r, c) || '');
def('SUBTOTAL', { args: 'function_num, ref1, [ref2], …', desc: 'A total that leaves out filtered rows (101–111: hidden rows too) and other subtotals', volatile: true, fn: (a, ctx) => {
  const k = num(scalar(a[0], ctx));
  if (isErr(k)) return k;
  const name = SUB[Math.trunc(k) % 100];
  if (!name || (k > 11 && k < 101) || k > 111) return err('#VALUE!');
  const all = k >= 100;
  const saved = ctx.hiddenSkip;
  ctx.hiddenSkip = (sheet, r, c) => (ctx.rowHidden ? ctx.rowHidden(sheet, r, all) : false) || nested(ctx, sheet, r, c);
  try { return FN[name].fn(a.slice(1).filter((x) => x !== undefined), ctx); } finally { ctx.hiddenSkip = saved; }
} });
def('AGGREGATE', { args: 'function_num, options, ref1, [k]', desc: 'A total that can leave out hidden rows, errors and subtotals', volatile: true, acceptsErrors: true, fn: (a, ctx) => {
  const k = num(scalar(a[0], ctx));
  const opt = a[1] === undefined ? 0 : num(scalar(a[1], ctx));
  if (firstErr(k, opt)) return firstErr(k, opt);
  const hidden = [1, 3, 5, 7].includes(opt);
  const noErrors = [2, 3, 6, 7].includes(opt);
  const noNested = [0, 1, 2, 3].includes(opt);
  const saved = ctx.hiddenSkip;
  ctx.hiddenSkip = (sheet, r, c) => (hidden && ctx.rowHidden ? ctx.rowHidden(sheet, r, true) : false) || (noNested && nested(ctx, sheet, r, c));
  const vals = [];
  try { for (const [v] of each([a[2]], ctx)) vals.push(v); } finally { ctx.hiddenSkip = saved; }
  if (!noErrors) { const e = vals.find(isErr); if (e) return e; }
  const xs = vals.filter((v) => typeof v === 'number');
  const kk = a[3] !== undefined ? num(scalar(a[3], ctx)) : null;
  switch (Math.trunc(k)) {
    case 1: return mean(xs);
    case 2: return xs.length;
    case 3: return vals.filter((v) => v !== null && v !== '' && !(noErrors && isErr(v))).length;
    case 4: return xs.length ? Math.max(...xs) : 0;
    case 5: return xs.length ? Math.min(...xs) : 0;
    case 6: return xs.reduce((p, v) => p * v, 1);
    case 7: case 8: { const v = variance(xs, k === 7); return isErr(v) ? v : Math.sqrt(v); }
    case 9: return sum(xs);
    case 10: case 11: return variance(xs, k === 10);
    case 12: return xs.length ? percentile(xs, 0.5) : err('#NUM!');
    case 13: { const m = modeOf(xs); return m === null ? err('#N/A') : m; }
    case 14: case 15: { const s = sorted(xs); if (k === 14) s.reverse(); return kk >= 1 && kk <= s.length ? s[Math.ceil(kk) - 1] : err('#NUM!'); }
    case 16: case 17: case 18: case 19: {
      if (kk === null || isErr(kk)) return err('#VALUE!');
      const p = k === 16 || k === 18 ? kk : kk / 4;
      return p < 0 || p > 1 ? err('#NUM!') : percentile(xs, p, k >= 18);
    }
    default: return err('#VALUE!');
  }
} });
function modeOf(xs) {
  const counts = new Map();
  let best = null;
  let bestN = 1;
  for (const x of xs) { const n = (counts.get(x) || 0) + 1; counts.set(x, n); if (n > bestN) { bestN = n; best = x; } }
  return best;
}

// ---- finance ----
def('XNPV', { args: 'rate, values, dates', desc: 'Net present value of cash flows on given dates', fn: (a, ctx) => {
  const r = num(scalar(a[0], ctx));
  const v = flat(a[1], ctx).map(num);
  const d = flat(a[2], ctx).map(num);
  if (isErr(r)) return r;
  if (v.length !== d.length || !v.length) return err('#NUM!');
  const e = [...v, ...d].find(isErr);
  if (e) return e;
  return v.reduce((s, x, i) => s + x / (1 + r) ** ((d[i] - d[0]) / 365), 0);
} });
def('XIRR', { args: 'values, dates, [guess]', desc: 'Internal rate of return of cash flows on given dates', fn: (a, ctx) => {
  const v = flat(a[0], ctx).map(num);
  const d = flat(a[1], ctx).map(num);
  if (v.length !== d.length || v.length < 2) return err('#NUM!');
  const e = [...v, ...d].find(isErr);
  if (e) return e;
  if (!v.some((x) => x > 0) || !v.some((x) => x < 0)) return err('#NUM!');
  const f = (r) => v.reduce((s, x, i) => s + x / (1 + r) ** ((d[i] - d[0]) / 365), 0);
  const df = (r) => v.reduce((s, x, i) => { const t = (d[i] - d[0]) / 365; return s - (t * x) / (1 + r) ** (t + 1); }, 0);
  let r = a[2] !== undefined ? num(scalar(a[2], ctx)) : 0.1;
  for (let i = 0; i < 100; i++) {
    const nr = r - f(r) / df(r);
    if (!Number.isFinite(nr) || nr <= -1) break;
    if (Math.abs(nr - r) < 1e-10) return nr;
    r = nr;
  }
  // Newton did not settle: bisection between -99.99% and 1000%.
  let lo = -0.9999;
  let hi = 10;
  if (f(lo) * f(hi) > 0) return err('#NUM!');
  for (let i = 0; i < 300; i++) { const m = (lo + hi) / 2; if (f(lo) * f(m) <= 0) hi = m; else lo = m; }
  return (lo + hi) / 2;
} });
function pmtOf(rate, nper, pv, fv = 0, type = 0) {
  if (rate === 0) return -(pv + fv) / nper;
  const p = (1 + rate) ** nper;
  return (-rate * (pv * p + fv)) / ((1 + rate * type) * (p - 1));
}
function cumulative(a, ctx, principal) {
  const [rate, nper, pv, start, end, type] = a.map((x) => num(scalar(x, ctx)));
  const e = firstErr(rate, nper, pv, start, end, type);
  if (e) return e;
  if (rate <= 0 || nper <= 0 || pv <= 0 || start < 1 || end < start || end > nper || ![0, 1].includes(type)) return err('#NUM!');
  const pmt = pmtOf(rate, nper, pv, 0, type);
  let bal = pv;
  let interest = 0;
  let paid = 0;
  for (let k = 1; k <= end; k++) {
    const i = type === 1 && k === 1 ? 0 : -bal * rate;
    const pr = pmt - i;
    if (k >= start) { interest += i; paid += pr; }
    bal += pr;
  }
  return principal ? paid : interest;
}
def('CUMIPMT', { args: 'rate, nper, pv, start_period, end_period, type', desc: 'Interest paid between two periods', fn: (a, ctx) => cumulative(a, ctx, false) });
def('CUMPRINC', { args: 'rate, nper, pv, start_period, end_period, type', desc: 'Principal paid between two periods', fn: (a, ctx) => cumulative(a, ctx, true) });
def('SYD', { args: 'cost, salvage, life, period', desc: "Sum-of-years'-digits depreciation", fn: N((c, s, l, p) => (l <= 0 || p < 1 || p > l ? err('#NUM!') : ((c - s) * (l - p + 1) * 2) / (l * (l + 1)))) });
def('DDB', { args: 'cost, salvage, life, period, [factor]', desc: 'Double-declining balance depreciation', fn: (a, ctx) => {
  const [c, s, l, p] = a.slice(0, 4).map((x) => num(scalar(x, ctx)));
  const f = a[4] !== undefined ? num(scalar(a[4], ctx)) : 2;
  const e = firstErr(c, s, l, p, f);
  if (e) return e;
  if (l <= 0 || p <= 0 || p > l || f <= 0 || c < 0 || s < 0) return err('#NUM!');
  let book = c;
  let dep = 0;
  for (let k = 1; k <= Math.ceil(p); k++) { dep = Math.max(0, Math.min(book * (f / l), book - s)); book -= dep; }
  return dep;
} });
def('DB', { args: 'cost, salvage, life, period, [month]', desc: 'Fixed-declining balance depreciation', fn: (a, ctx) => {
  const [c, s, l, p] = a.slice(0, 4).map((x) => num(scalar(x, ctx)));
  const m = a[4] !== undefined ? num(scalar(a[4], ctx)) : 12;
  const e = firstErr(c, s, l, p, m);
  if (e) return e;
  if (c <= 0 || l <= 0 || p <= 0 || m < 1 || m > 12 || p > l + 1) return err('#NUM!');
  const rate = Math.round((1 - (s / c) ** (1 / l)) * 1000) / 1000;
  let total = 0;
  let dep = (c * rate * m) / 12;
  if (p === 1) return dep;
  total = dep;
  for (let k = 2; k <= p; k++) {
    dep = k === l + 1 ? ((c - total) * rate * (12 - m)) / 12 : (c - total) * rate;
    total += dep;
  }
  return dep;
} });

// ---- working days with any weekend ----
function weekendMask(w) {
  if (w === undefined || w === null) return [6, 0];
  if (typeof w === 'string' && /^[01]{7}$/.test(w)) return [...w].map((ch, i) => (ch === '1' ? (i + 1) % 7 : -1)).filter((x) => x >= 0);
  const n = Number(w);
  const pairs = { 1: [6, 0], 2: [0, 1], 3: [1, 2], 4: [2, 3], 5: [3, 4], 6: [4, 5], 7: [5, 6], 11: [0], 12: [1], 13: [2], 14: [3], 15: [4], 16: [5], 17: [6] };
  return pairs[n] || null;
}
def('NETWORKDAYS.INTL', { args: 'start_date, end_date, [weekend], [holidays]', desc: 'Working days between dates, with your own weekend', fn: (a, ctx) => {
  const s = num(scalar(a[0], ctx));
  const e = num(scalar(a[1], ctx));
  if (firstErr(s, e)) return firstErr(s, e);
  const wk = weekendMask(a[2] === undefined ? undefined : scalar(a[2], ctx));
  if (!wk) return err('#NUM!');
  const hol = new Set(a[3] ? flat(a[3], ctx).filter((v) => typeof v === 'number').map(Math.floor) : []);
  const step = e >= s ? 1 : -1;
  let n = 0;
  for (let d = Math.floor(s); step > 0 ? d <= e : d >= e; d += step) if (!wk.includes(parts(d).wd) && !hol.has(d)) n += step;
  return n;
} });
def('WORKDAY.INTL', { args: 'start_date, days, [weekend], [holidays]', desc: 'The date some working days away, with your own weekend', fn: (a, ctx) => {
  let d = Math.floor(num(scalar(a[0], ctx)));
  let n = Math.trunc(num(scalar(a[1], ctx)));
  if (firstErr(d, n)) return firstErr(d, n);
  const wk = weekendMask(a[2] === undefined ? undefined : scalar(a[2], ctx));
  if (!wk || wk.length >= 7) return err('#NUM!');
  const hol = new Set(a[3] ? flat(a[3], ctx).filter((v) => typeof v === 'number').map(Math.floor) : []);
  const step = n >= 0 ? 1 : -1;
  while (n !== 0) { d += step; if (!wk.includes(parts(d).wd) && !hol.has(d)) n -= step; }
  return d;
} });

// ---- regular expressions ----
function regex(p, flags, ctx) {
  try { return new RegExp(str(scalar(p, ctx)), flags); } catch { return err('#VALUE!', 'That pattern is not a valid regular expression'); }
}
def('REGEXTEST REGEXMATCH', { args: 'text, pattern, [case_sensitivity]', desc: 'Whether text matches a pattern', fn: lift(([t, p, cs]) => { const re = regex(p, cs === 1 ? 'i' : '', null); return isErr(re) ? re : re.test(str(t)); }) });
def('REGEXEXTRACT', { args: 'text, pattern, [return_mode], [case_sensitivity]', desc: 'The part of text that matches a pattern', fn: (a, ctx) => {
  const t = str(scalar(a[0], ctx));
  const mode = a[2] !== undefined ? num(scalar(a[2], ctx)) : 0;
  const ci = a[3] !== undefined && num(scalar(a[3], ctx)) === 1;
  const re = regex(a[1], ci ? 'gi' : 'g', ctx);
  if (isErr(re)) return re;
  const ms = [...t.matchAll(re)];
  if (!ms.length) return err('#N/A');
  if (mode === 1) return new Arr(ms.map((m) => [m[0]]));
  if (mode === 2) return ms[0].length > 1 ? new Arr([ms[0].slice(1).map((x) => x ?? '')]) : ms[0][0];
  return ms[0].length > 1 && a[2] === undefined ? ms[0][1] ?? '' : ms[0][0];
} });
def('REGEXREPLACE', { args: 'text, pattern, replacement, [occurrence], [case_sensitivity]', desc: 'Replaces the parts of text that match a pattern', fn: (a, ctx) => {
  const t = str(scalar(a[0], ctx));
  const rep = str(scalar(a[2], ctx)).replace(/\$(\d)/g, '$$$1');
  const occ = a[3] !== undefined ? num(scalar(a[3], ctx)) : 0;
  const ci = a[4] !== undefined && num(scalar(a[4], ctx)) === 1;
  const re = regex(a[1], ci ? 'gi' : 'g', ctx);
  if (isErr(re)) return re;
  if (!occ) return t.replace(re, rep);
  const ms = [...t.matchAll(re)];
  const m = occ > 0 ? ms[occ - 1] : ms[ms.length + occ];
  if (!m) return t;
  return t.slice(0, m.index) + m[0].replace(new RegExp(re.source, re.flags.replace('g', '')), rep) + t.slice(m.index + m[0].length);
} });

// ---- reshaping arrays ----
const pick = (list, idx) => idx.map((i) => (i > 0 ? list[i - 1] : list[list.length + i]));
def('CHOOSECOLS', { args: 'array, col_num1, [col_num2], …', desc: 'Some columns of an array', fn: (a, ctx) => {
  const g = grid(a[0], ctx);
  const idx = flat(new Arr([a.slice(1).flatMap((x) => flat(x, ctx))]), ctx).map((x) => Math.trunc(num(x)));
  if (idx.some((i) => !i || Math.abs(i) > g[0].length)) return err('#VALUE!');
  return new Arr(g.map((row) => pick(row, idx)));
} });
def('CHOOSEROWS', { args: 'array, row_num1, [row_num2], …', desc: 'Some rows of an array', fn: (a, ctx) => {
  const g = grid(a[0], ctx);
  const idx = a.slice(1).flatMap((x) => flat(x, ctx)).map((x) => Math.trunc(num(x)));
  if (idx.some((i) => !i || Math.abs(i) > g.length)) return err('#VALUE!');
  return new Arr(pick(g, idx).map((r) => r.slice()));
} });
function line(a, ctx) {
  const g = grid(a[0], ctx);
  const ignore = a[1] !== undefined ? num(scalar(a[1], ctx)) : 0;
  const byCol = a[2] !== undefined && bool(scalar(a[2], ctx)) === true;
  const out = [];
  const keep = (v) => !((ignore === 1 || ignore === 3) && (v === null || v === '')) && !((ignore === 2 || ignore === 3) && isErr(v));
  if (byCol) { for (let c = 0; c < g[0].length; c++) for (const row of g) if (keep(row[c])) out.push(row[c]); } else for (const row of g) for (const v of row) if (keep(v)) out.push(v);
  return out;
}
def('TOCOL', { args: 'array, [ignore], [scan_by_column]', desc: 'An array as one column', fn: (a, ctx) => { const v = line(a, ctx); return v.length ? new Arr(v.map((x) => [x])) : err('#CALC!'); } });
def('TOROW', { args: 'array, [ignore], [scan_by_column]', desc: 'An array as one row', fn: (a, ctx) => { const v = line(a, ctx); return v.length ? new Arr([v]) : err('#CALC!'); } });
function wrap(a, ctx, rows) {
  const v = flat(a[0], ctx);
  const n = Math.trunc(num(scalar(a[1], ctx)));
  const pad = a[2] !== undefined ? scalar(a[2], ctx) : err('#N/A');
  if (!(n >= 1)) return err('#NUM!');
  const lines = [];
  for (let i = 0; i < v.length; i += n) { const l = v.slice(i, i + n); while (l.length < n) l.push(pad); lines.push(l); }
  return new Arr(rows ? lines : lines[0].map((_, c) => lines.map((l) => l[c])));
}
def('WRAPROWS', { args: 'vector, wrap_count, [pad_with]', desc: 'A list wrapped into rows', fn: (a, ctx) => wrap(a, ctx, true) });
def('WRAPCOLS', { args: 'vector, wrap_count, [pad_with]', desc: 'A list wrapped into columns', fn: (a, ctx) => wrap(a, ctx, false) });
def('EXPAND', { args: 'array, rows, [columns], [pad_with]', desc: 'An array made bigger', fn: (a, ctx) => {
  const g = grid(a[0], ctx);
  const r = a[1] !== undefined && a[1] !== null ? Math.trunc(num(scalar(a[1], ctx))) : g.length;
  const c = a[2] !== undefined && a[2] !== null ? Math.trunc(num(scalar(a[2], ctx))) : g[0].length;
  const pad = a[3] !== undefined ? scalar(a[3], ctx) : err('#N/A');
  if (r < g.length || c < g[0].length) return err('#VALUE!');
  return new Arr(Array.from({ length: r }, (_, i) => Array.from({ length: c }, (__, j) => (g[i] && j < g[i].length ? g[i][j] : pad))));
} });
def('FREQUENCY', { args: 'data_array, bins_array', desc: 'How many values fall in each bin', fn: (a, ctx) => {
  const data = flat(a[0], ctx).filter((v) => typeof v === 'number');
  const bins = flat(a[1], ctx).filter((v) => typeof v === 'number');
  const order = bins.map((b, i) => [b, i]).sort((x, y) => x[0] - y[0]);
  const counts = Array(bins.length + 1).fill(0);
  for (const x of data) { const k = order.find(([b]) => x <= b); counts[k ? k[1] : bins.length]++; }
  return new Arr(counts.map((n) => [n]));
} });

// ---- statistics ----
function gammaln(x) {
  const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
  let y = x;
  let tmp = x + 5.5;
  tmp -= (x + 0.5) * Math.log(tmp);
  let ser = 1.000000000190015;
  for (const c of g) ser += c / ++y;
  return -tmp + Math.log((2.5066282746310005 * ser) / x);
}
function betacf(a, b, x) {
  let qab = a + b; let qap = a + 1; let qam = a - 1; let c = 1; let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < 1e-30) d = 1e-30;
  d = 1 / d;
  let hh = d;
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30; c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30; d = 1 / d; hh *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d; if (Math.abs(d) < 1e-30) d = 1e-30; c = 1 + aa / c; if (Math.abs(c) < 1e-30) c = 1e-30; d = 1 / d;
    const del = d * c;
    hh *= del;
    if (Math.abs(del - 1) < 3e-14) break;
  }
  void qab; void qap; void qam;
  return hh;
}
/** The regularised incomplete beta function I_x(a, b). */
function ibeta(x, a, b) {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const bt = Math.exp(gammaln(a + b) - gammaln(a) - gammaln(b) + a * Math.log(x) + b * Math.log(1 - x));
  return x < (a + 1) / (a + b + 2) ? (bt * betacf(a, b, x)) / a : 1 - (bt * betacf(b, a, 1 - x)) / b;
}
/** The regularised lower incomplete gamma function P(a, x). */
function igamma(a, x) {
  if (x <= 0) return 0;
  if (x < a + 1) {
    let sum0 = 1 / a; let del = sum0; let ap = a;
    for (let n = 0; n < 500; n++) { ap++; del *= x / ap; sum0 += del; if (Math.abs(del) < Math.abs(sum0) * 3e-15) break; }
    return sum0 * Math.exp(-x + a * Math.log(x) - gammaln(a));
  }
  let b = x + 1 - a; let c = 1e300; let d = 1 / b; let hh = d;
  for (let i = 1; i < 500; i++) {
    const an = -i * (i - a); b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300; c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300; d = 1 / d;
    const del = d * c; hh *= del; if (Math.abs(del - 1) < 3e-15) break;
  }
  return 1 - Math.exp(-x + a * Math.log(x) - gammaln(a)) * hh;
}
const tcdf = (t, df) => { const x = df / (df + t * t); const p = 0.5 * ibeta(x, df / 2, 0.5); return t >= 0 ? 1 - p : p; };
const tpdf = (t, df) => Math.exp(gammaln((df + 1) / 2) - gammaln(df / 2)) / Math.sqrt(df * Math.PI) * (1 + (t * t) / df) ** (-(df + 1) / 2);
/** Inverse of a rising function on [lo, hi] by bisection. */
function invert(f, p, lo, hi) {
  for (let i = 0; i < 200; i++) { const m = (lo + hi) / 2; if (f(m) < p) lo = m; else hi = m; }
  return (lo + hi) / 2;
}
// The standard normal's inverse (Acklam's approximation, then one Newton step).
function normsinv(p) {
  if (p <= 0 || p >= 1) return err('#NUM!');
  const A = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239];
  const B = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1];
  const C = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const D = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  let x;
  if (p < 0.02425) { const q = Math.sqrt(-2 * Math.log(p)); x = (((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1); } else if (p > 1 - 0.02425) { const q = Math.sqrt(-2 * Math.log(1 - p)); x = -(((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) / ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1); } else {
    const q = p - 0.5; const r = q * q;
    x = ((((((A[0] * r + A[1]) * r + A[2]) * r + A[3]) * r + A[4]) * r + A[5]) * q) / (((((B[0] * r + B[1]) * r + B[2]) * r + B[3]) * r + B[4]) * r + 1);
  }
  const e = 0.5 * (1 + erfFine(x / Math.SQRT2)) - p;
  const u = e * Math.sqrt(2 * Math.PI) * Math.exp((x * x) / 2);
  return x - u / (1 + (x * u) / 2);
}
// erf to near machine precision (for the inverse above and the standard normal).
function erfFine(x) {
  const t = Math.abs(x);
  if (t < 2.5) { let s = 0; let term = t; for (let n = 0; n < 60; n++) { s += term / (2 * n + 1); term *= (-t * t) / (n + 1); } const v = (2 / Math.sqrt(Math.PI)) * s; return x < 0 ? -v : v; }
  const v = 1 - Math.exp(-t * t) / (t * Math.sqrt(Math.PI)) * (1 - 1 / (2 * t * t) + 3 / (4 * t ** 4) - 15 / (8 * t ** 6));
  return x < 0 ? -v : v;
}
const phi = (z) => 0.5 * (1 + erfFine(z / Math.SQRT2));
def('NORM.S.DIST', { args: 'z, cumulative', desc: 'Standard normal distribution', fn: (a, ctx) => { const z = num(scalar(a[0], ctx)); if (isErr(z)) return z; return bool(scalar(a[1], ctx)) === true ? phi(z) : Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI); } });
def('NORMSDIST', { args: 'z', desc: 'Cumulative standard normal distribution', fn: N((z) => phi(z)) });
def('NORM.S.INV NORMSINV', { args: 'probability', desc: 'Inverse of the standard normal distribution', fn: N((p) => normsinv(p)) });
def('NORM.INV NORMINV', { args: 'probability, mean, standard_dev', desc: 'Inverse of the normal distribution', fn: N((p, m, s) => { if (s <= 0) return err('#NUM!'); const z = normsinv(p); return isErr(z) ? z : m + s * z; }) });
def('T.DIST', { args: 'x, deg_freedom, cumulative', desc: "Student's t distribution", fn: (a, ctx) => { const x = num(scalar(a[0], ctx)); const df = num(scalar(a[1], ctx)); if (firstErr(x, df)) return firstErr(x, df); if (df < 1) return err('#NUM!'); return bool(scalar(a[2], ctx)) === true ? tcdf(x, df) : tpdf(x, df); } });
def('T.DIST.2T', { args: 'x, deg_freedom', desc: "Two-tailed Student's t distribution", fn: N((x, df) => (x < 0 || df < 1 ? err('#NUM!') : 2 * (1 - tcdf(x, df)))) });
def('T.DIST.RT', { args: 'x, deg_freedom', desc: "Right-tailed Student's t distribution", fn: N((x, df) => (df < 1 ? err('#NUM!') : 1 - tcdf(x, df))) });
def('TDIST', { args: 'x, deg_freedom, tails', desc: "Student's t distribution (older)", fn: N((x, df, tails) => (x < 0 || df < 1 || ![1, 2].includes(tails) ? err('#NUM!') : tails * (1 - tcdf(x, df)))) });
def('T.INV', { args: 'probability, deg_freedom', desc: "Inverse of Student's t distribution", fn: N((p, df) => (p <= 0 || p >= 1 || df < 1 ? err('#NUM!') : invert((t) => tcdf(t, df), p, -1e4, 1e4))) });
def('T.INV.2T TINV', { args: 'probability, deg_freedom', desc: "Two-tailed inverse of Student's t distribution", fn: N((p, df) => (p <= 0 || p > 1 || df < 1 ? err('#NUM!') : invert((t) => tcdf(t, df), 1 - p / 2, -1e4, 1e4))) });
def('T.TEST TTEST', { args: 'array1, array2, tails, type', desc: "Student's t-test probability", fn: (a, ctx) => {
  const x = flat(a[0], ctx);
  const y = flat(a[1], ctx);
  const tails = num(scalar(a[2], ctx));
  const type = num(scalar(a[3], ctx));
  if (![1, 2].includes(tails) || ![1, 2, 3].includes(type)) return err('#NUM!');
  let t;
  let df;
  if (type === 1) {
    if (x.length !== y.length) return err('#N/A');
    const d = x.map((v, i) => [v, y[i]]).filter(([p, q]) => typeof p === 'number' && typeof q === 'number').map(([p, q]) => p - q);
    if (d.length < 2) return err('#DIV/0!');
    const m = mean(d); const sd = Math.sqrt(variance(d, true));
    t = m / (sd / Math.sqrt(d.length)); df = d.length - 1;
  } else {
    const xs = x.filter((v) => typeof v === 'number'); const ys = y.filter((v) => typeof v === 'number');
    if (xs.length < 2 || ys.length < 2) return err('#DIV/0!');
    const v1 = variance(xs, true); const v2 = variance(ys, true);
    if (type === 2) {
      df = xs.length + ys.length - 2;
      const sp = ((xs.length - 1) * v1 + (ys.length - 1) * v2) / df;
      t = (mean(xs) - mean(ys)) / Math.sqrt(sp * (1 / xs.length + 1 / ys.length));
    } else {
      const a1 = v1 / xs.length; const a2 = v2 / ys.length;
      t = (mean(xs) - mean(ys)) / Math.sqrt(a1 + a2);
      df = (a1 + a2) ** 2 / (a1 ** 2 / (xs.length - 1) + a2 ** 2 / (ys.length - 1));
    }
  }
  return tails * (1 - tcdf(Math.abs(t), df));
} });
def('CHISQ.DIST', { args: 'x, deg_freedom, cumulative', desc: 'Chi-squared distribution', fn: (a, ctx) => { const x = num(scalar(a[0], ctx)); const k = num(scalar(a[1], ctx)); if (firstErr(x, k)) return firstErr(x, k); if (x < 0 || k < 1) return err('#NUM!'); return bool(scalar(a[2], ctx)) === true ? igamma(k / 2, x / 2) : x === 0 ? (k === 2 ? 0.5 : 0) : Math.exp((k / 2 - 1) * Math.log(x) - x / 2 - (k / 2) * Math.LN2 - gammaln(k / 2)); } });
def('CHISQ.DIST.RT CHIDIST', { args: 'x, deg_freedom', desc: 'Right-tailed chi-squared distribution', fn: N((x, k) => (x < 0 || k < 1 ? err('#NUM!') : 1 - igamma(k / 2, x / 2))) });
def('CHISQ.INV.RT CHIINV', { args: 'probability, deg_freedom', desc: 'Inverse of the right-tailed chi-squared distribution', fn: N((p, k) => (p <= 0 || p > 1 || k < 1 ? err('#NUM!') : invert((x) => -(1 - igamma(k / 2, x / 2)), -p, 0, 1e5))) });
def('F.DIST.RT FDIST', { args: 'x, deg_freedom1, deg_freedom2', desc: 'Right-tailed F distribution', fn: N((x, d1, d2) => (x < 0 || d1 < 1 || d2 < 1 ? err('#NUM!') : 1 - ibeta((d1 * x) / (d1 * x + d2), d1 / 2, d2 / 2))) });
def('BINOM.DIST BINOMDIST', { args: 'number_s, trials, probability_s, cumulative', desc: 'Binomial distribution', fn: (a, ctx) => {
  const [k0, n0, p] = a.slice(0, 3).map((x) => num(scalar(x, ctx)));
  if (firstErr(k0, n0, p)) return firstErr(k0, n0, p);
  const k = Math.floor(k0); const n = Math.floor(n0);
  if (k < 0 || k > n || p < 0 || p > 1) return err('#NUM!');
  const pmf = (i) => Math.exp(gammaln(n + 1) - gammaln(i + 1) - gammaln(n - i + 1) + (i ? i * Math.log(p) : 0) + (n - i ? (n - i) * Math.log(1 - p) : 0));
  if (bool(scalar(a[3], ctx)) !== true) return pmf(k);
  let s = 0; for (let i = 0; i <= k; i++) s += pmf(i); return Math.min(1, s);
} });
def('POISSON.DIST POISSON', { args: 'x, mean, cumulative', desc: 'Poisson distribution', fn: (a, ctx) => {
  const k = Math.floor(num(scalar(a[0], ctx))); const m = num(scalar(a[1], ctx));
  if (firstErr(k, m)) return firstErr(k, m);
  if (k < 0 || m < 0) return err('#NUM!');
  const pmf = (i) => Math.exp(-m + i * Math.log(m || 1e-300) - gammaln(i + 1));
  if (bool(scalar(a[2], ctx)) !== true) return m === 0 ? (k === 0 ? 1 : 0) : pmf(k);
  return m === 0 ? 1 : 1 - igamma(k + 1, m);
} });
def('EXPON.DIST EXPONDIST', { args: 'x, lambda, cumulative', desc: 'Exponential distribution', fn: (a, ctx) => { const x = num(scalar(a[0], ctx)); const l = num(scalar(a[1], ctx)); if (firstErr(x, l)) return firstErr(x, l); if (x < 0 || l <= 0) return err('#NUM!'); return bool(scalar(a[2], ctx)) === true ? 1 - Math.exp(-l * x) : l * Math.exp(-l * x); } });
def('CONFIDENCE.NORM CONFIDENCE', { args: 'alpha, standard_dev, size', desc: 'Confidence interval of a mean (normal)', fn: N((al, s, n) => (al <= 0 || al >= 1 || s <= 0 || n < 1 ? err('#NUM!') : (normsinv(1 - al / 2) * s) / Math.sqrt(Math.floor(n)))) });
def('CONFIDENCE.T', { args: 'alpha, standard_dev, size', desc: "Confidence interval of a mean (Student's t)", fn: N((al, s, n) => (al <= 0 || al >= 1 || s <= 0 || n < 2 ? err('#NUM!') : (invert((t) => tcdf(t, n - 1), 1 - al / 2, -1e4, 1e4) * s) / Math.sqrt(Math.floor(n)))) });
def('GAMMALN GAMMALN.PRECISE', { args: 'x', desc: 'Natural log of the gamma function', fn: N((x) => (x <= 0 ? err('#NUM!') : gammaln(x))) });
def('GAMMA', { args: 'x', desc: 'The gamma function', fn: N((x) => (x <= 0 && Number.isInteger(x) ? err('#NUM!') : x > 0 ? Math.exp(gammaln(x)) : Math.PI / (Math.sin(Math.PI * x) * Math.exp(gammaln(1 - x))))) });
def('SKEW', { args: 'number1, [number2], …', desc: 'Skewness of a distribution', fn: (a, ctx) => { const x = nums(a, ctx); if (isErr(x)) return x; const n = x.length; if (n < 3) return err('#DIV/0!'); const m = mean(x); const s = Math.sqrt(variance(x, true)); if (!s) return err('#DIV/0!'); return (n / ((n - 1) * (n - 2))) * x.reduce((t, v) => t + ((v - m) / s) ** 3, 0); } });
def('KURT', { args: 'number1, [number2], …', desc: 'Kurtosis of a distribution', fn: (a, ctx) => { const x = nums(a, ctx); if (isErr(x)) return x; const n = x.length; if (n < 4) return err('#DIV/0!'); const m = mean(x); const s = Math.sqrt(variance(x, true)); if (!s) return err('#DIV/0!'); return ((n * (n + 1)) / ((n - 1) * (n - 2) * (n - 3))) * x.reduce((t, v) => t + ((v - m) / s) ** 4, 0) - (3 * (n - 1) ** 2) / ((n - 2) * (n - 3)); } });
def('MODE.MULT', { args: 'number1, [number2], …', desc: 'All the most common values', fn: (a, ctx) => {
  const x = nums(a, ctx); if (isErr(x)) return x;
  const counts = new Map(); for (const v of x) counts.set(v, (counts.get(v) || 0) + 1);
  const top = Math.max(0, ...counts.values()); if (top < 2) return err('#N/A');
  return new Arr([...counts].filter(([, n]) => n === top).map(([v]) => [v]));
} });
function prank(a, ctx, exclusive) {
  const xs = sorted(nums([a[0]], ctx));
  const x = num(scalar(a[1], ctx));
  const sig = a[2] !== undefined ? Math.trunc(num(scalar(a[2], ctx))) : 3;
  if (isErr(xs)) return xs;
  if (isErr(x)) return x;
  const n = xs.length;
  if (!n || x < xs[0] || x > xs[n - 1] || sig < 1) return err('#N/A');
  let i = xs.findIndex((v) => v >= x);
  let rank;
  if (xs[i] === x) rank = i;
  else rank = i - 1 + (x - xs[i - 1]) / (xs[i] - xs[i - 1]);
  const r = exclusive ? (rank + 1) / (n + 1) : n > 1 ? rank / (n - 1) : 1;
  const f = 10 ** sig;
  return Math.floor(r * f) / f;
}
def('PERCENTRANK PERCENTRANK.INC', { args: 'array, x, [significance]', desc: 'Rank of a value as a percentage of the list', fn: (a, ctx) => prank(a, ctx, false) });
def('PERCENTRANK.EXC', { args: 'array, x, [significance]', desc: 'Rank of a value as a percentage, exclusive', fn: (a, ctx) => prank(a, ctx, true) });

// ---- numbers in other bases, Roman numerals ----
const ROMAN = [[1000, 'M'], [900, 'CM'], [500, 'D'], [400, 'CD'], [100, 'C'], [90, 'XC'], [50, 'L'], [40, 'XL'], [10, 'X'], [9, 'IX'], [5, 'V'], [4, 'IV'], [1, 'I']];
def('ROMAN', { args: 'number', desc: 'A number in Roman numerals', fn: N((n) => { n = Math.trunc(n); if (n < 0 || n > 3999) return err('#VALUE!'); let s = ''; for (const [v, r] of ROMAN) while (n >= v) { s += r; n -= v; } return s; }) });
def('ARABIC', { args: 'text', desc: 'A Roman numeral as a number', fn: lift(([t]) => {
  const s = str(t).trim().toUpperCase(); const neg = s.startsWith('-'); const body = neg ? s.slice(1) : s;
  if (!/^[MDCLXVI]*$/.test(body)) return err('#VALUE!');
  const val = { M: 1000, D: 500, C: 100, L: 50, X: 10, V: 5, I: 1 };
  let n = 0; for (let i = 0; i < body.length; i++) { const v = val[body[i]]; n += i + 1 < body.length && val[body[i + 1]] > v ? -v : v; }
  return neg ? -n : n;
}) });
function toBase(n, base, places, bits = 40) {
  n = Math.trunc(n);
  const lim = 2 ** (bits - 1);
  if (n < -lim || n >= lim) return err('#NUM!');
  let s = (n < 0 ? 2 ** bits + n : n).toString(base).toUpperCase();
  if (places !== undefined && places !== null && n >= 0) { if (s.length > places) return err('#NUM!'); s = s.padStart(places, '0'); }
  return s;
}
function fromBase(t, base, bits = 40) {
  const s = str(t).trim();
  if (!s || s.length > 10 || !new RegExp(`^[${'0123456789ABCDEF'.slice(0, base)}]+$`, 'i').test(s)) return err('#NUM!');
  const n = parseInt(s, base);
  return s.length === 10 && n >= 2 ** (bits - 1) ? n - 2 ** bits : n;
}
for (const [name, base, bits] of [['BIN', 2, 10], ['OCT', 8, 30], ['HEX', 16, 40]]) {
  def(`DEC2${name}`, { args: 'number, [places]', desc: `A number in base ${base}`, fn: (a, ctx) => { const n = num(scalar(a[0], ctx)); if (isErr(n)) return n; return toBase(n, base, a[1] !== undefined ? num(scalar(a[1], ctx)) : undefined, bits); } });
  def(`${name}2DEC`, { args: 'number', desc: `A base-${base} number as a decimal`, fn: lift(([t]) => fromBase(t, base, bits)) });
}
def('BASE', { args: 'number, radix, [min_length]', desc: 'A number in any base (2–36)', fn: (a, ctx) => { const n = num(scalar(a[0], ctx)); const r = num(scalar(a[1], ctx)); if (firstErr(n, r)) return firstErr(n, r); if (n < 0 || r < 2 || r > 36) return err('#NUM!'); const s = Math.trunc(n).toString(r).toUpperCase(); return a[2] !== undefined ? s.padStart(num(scalar(a[2], ctx)), '0') : s; } });
def('DECIMAL', { args: 'text, radix', desc: 'A number in any base (2–36) as a decimal', fn: (a, ctx) => { const t = str(scalar(a[0], ctx)).trim(); const r = num(scalar(a[1], ctx)); if (isErr(r)) return r; if (r < 2 || r > 36) return err('#NUM!'); const n = parseInt(t, r); return Number.isNaN(n) || n.toString(r).toUpperCase() !== t.toUpperCase().replace(/^0+(?=.)/, '') ? err('#NUM!') : n; } });

// ---- Google Sheets' own (so its files and habits work here) ----
def('COUNTUNIQUE', { args: 'value1, [value2], …', desc: 'How many different values', fn: (a, ctx) => { const seen = new Set(); for (const [v] of each(a, ctx)) if (v !== null && v !== '') seen.add(typeof v === 'string' ? v.toLowerCase() : v); return seen.size; } });
def('SPLIT', { args: 'text, delimiter, [split_by_each], [remove_empty_text]', desc: 'Splits text into cells', fn: (a, ctx) => {
  const t = str(scalar(a[0], ctx)); const d = str(scalar(a[1], ctx));
  const each0 = a[2] === undefined ? true : bool(scalar(a[2], ctx)) === true;
  const drop = a[3] === undefined ? true : bool(scalar(a[3], ctx)) === true;
  let parts0 = each0 && d.length > 1 ? t.split(new RegExp(`[${d.replace(/[\]\\^-]/g, '\\$&')}]`)) : t.split(d);
  if (drop) parts0 = parts0.filter((x) => x !== '');
  return new Arr([parts0.map((x) => parseNumber(x) ?? x)]);
} });
def('JOIN', { args: 'delimiter, value_or_array1, [value_or_array2], …', desc: 'Joins values with a delimiter', fn: (a, ctx) => { const d = str(scalar(a[0], ctx)); const out = []; for (const [v] of each(a.slice(1), ctx)) out.push(str(v)); return out.join(d); } });
def('ARRAYFORMULA', { args: 'array_formula', desc: 'Calculates over whole ranges (every formula here already can)', fn: (a) => a[0] });

// ---- LAMBDA and the functions that use one ----
export class Lambda {
  constructor(params, body, locals) { this.params = params; this.body = body; this.locals = locals; }
  toString() { return ''; }
}
/** Run a LAMBDA with these argument values. */
export function callLambda(f, args, ctx, ev) {
  if (!(f instanceof Lambda)) return err('#VALUE!', 'That is not a LAMBDA');
  if (args.length > f.params.length) return err('#VALUE!', 'Too many values for this LAMBDA');
  const saved = ctx.locals;
  const savedOmitted = ctx.omitted;
  ctx.locals = new Map(f.locals || []);
  ctx.omitted = new Set();
  f.params.forEach((p, i) => { if (i < args.length && args[i] !== undefined) ctx.locals.set(p, args[i]); else { ctx.locals.set(p, null); ctx.omitted.add(p); } });
  try { return ev(f.body); } finally { ctx.locals = saved; ctx.omitted = savedOmitted; }
}
def('LAMBDA', { args: 'parameter1, [parameter2], …, calculation', desc: 'A function of your own, for LET, MAP, REDUCE and named functions', lazy: true, fn: (asts, ctx) => {
  if (!asts.length) return err('#VALUE!');
  const params = asts.slice(0, -1);
  if (params.some((p) => p.k !== 'nm')) return err('#VALUE!', 'LAMBDA parameters must be names');
  return new Lambda(params.map((p) => p.v.toUpperCase()), asts[asts.length - 1], new Map(ctx.locals || []));
} });
def('ISOMITTED', { args: 'argument', desc: 'Whether a LAMBDA argument was left out', lazy: true, fn: (asts, ctx) => !!(asts[0] && asts[0].k === 'nm' && ctx.omitted && ctx.omitted.has(asts[0].v.toUpperCase())) });
const one = (v, ctx) => (v instanceof Rng || v instanceof Arr ? scalar(v, ctx) : v);
def('MAP', { args: 'array1, [array2], …, lambda', desc: 'Applies a LAMBDA to each value', lazy: true, fn: (asts, ctx, ev) => {
  const vals = asts.map(ev);
  const f = vals.pop();
  const gs = vals.map((v) => grid(v, ctx));
  if (!gs.length) return err('#VALUE!');
  return new Arr(gs[0].map((row, i) => row.map((_, j) => one(callLambda(f, gs.map((g) => (g[i] ? g[i][j] : null)), ctx, ev), ctx))));
} });
def('REDUCE', { args: '[initial_value], array, lambda', desc: 'Folds an array into one value with a LAMBDA', lazy: true, fn: (asts, ctx, ev) => {
  const [init, arr, f] = asts.length === 2 ? [{ k: 'missing' }, asts[0], asts[1]].map((x) => (x.k === 'missing' ? null : ev(x))) : asts.map((x) => (x.k === 'missing' ? null : ev(x)));
  let acc = init;
  for (const v of grid(arr, ctx).flat()) acc = one(callLambda(f, [acc, v], ctx, ev), ctx);
  return acc;
} });
def('SCAN', { args: '[initial_value], array, lambda', desc: 'Each step of folding an array with a LAMBDA', lazy: true, fn: (asts, ctx, ev) => {
  const [init, arr, f] = asts.map((x) => (x.k === 'missing' ? null : ev(x)));
  let acc = init;
  return new Arr(grid(arr, ctx).map((row) => row.map((v) => (acc = one(callLambda(f, [acc, v], ctx, ev), ctx)))));
} });
def('BYROW', { args: 'array, lambda', desc: 'A LAMBDA over each row', lazy: true, fn: (asts, ctx, ev) => { const [arr, f] = asts.map(ev); return new Arr(grid(arr, ctx).map((row) => [one(callLambda(f, [new Arr([row])], ctx, ev), ctx)])); } });
def('BYCOL', { args: 'array, lambda', desc: 'A LAMBDA over each column', lazy: true, fn: (asts, ctx, ev) => { const [arr, f] = asts.map(ev); const g = grid(arr, ctx); return new Arr([g[0].map((_, c) => one(callLambda(f, [new Arr(g.map((row) => [row[c]]))], ctx, ev), ctx))]); } });
def('MAKEARRAY', { args: 'rows, columns, lambda', desc: 'An array made by a LAMBDA of row and column', lazy: true, fn: (asts, ctx, ev) => {
  const [r, c, f] = asts.map(ev);
  const R = Math.trunc(num(scalar(r, ctx))); const C = Math.trunc(num(scalar(c, ctx)));
  if (!(R >= 1 && C >= 1) || R * C > 1e6) return err('#VALUE!');
  return new Arr(Array.from({ length: R }, (_, i) => Array.from({ length: C }, (__, j) => one(callLambda(f, [i + 1, j + 1], ctx, ev), ctx))));
} });

export const FN_NAMES = Object.keys(FN).sort();
export { cmpValues, eqLoose, colName };
