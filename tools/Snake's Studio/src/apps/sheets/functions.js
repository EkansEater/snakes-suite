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
          if (ctx.hiddenSkip && ctx.hiddenSkip(a.sheet, r)) continue;
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

export const FN_NAMES = Object.keys(FN).sort();
export { cmpValues, eqLoose, colName };
