// Tests for the spreadsheet engine: node test/sheets.test.mjs
import { Book } from '../src/apps/sheets/engine.js';
import { formatValue, changeDecimals } from '../src/apps/sheets/numfmt.js';
import { shiftFormula, adjustForInsert, parse } from '../src/apps/sheets/formula.js';

let fails = 0;
let count = 0;
const show = (v) => (v && v.code ? v.code : JSON.stringify(v));
function eq(name, got, want) {
  count++;
  const ok = typeof want === 'number' && typeof got === 'number' ? Math.abs(got - want) < 1e-9 * Math.max(1, Math.abs(want)) : show(got) === show(want);
  if (!ok) { fails++; console.log(`FAIL ${name}: got ${show(got)}, want ${show(want)}`); }
}

const book = new Book();
const sh = book.addSheet('Sheet1');
const set = (a, t) => { const m = /^([A-Z]+)(\d+)$/.exec(a); let c = 0; for (const ch of m[1]) c = c * 26 + ch.charCodeAt(0) - 64; book.input(sh, Number(m[2]) - 1, c - 1, t); };
const get = (a) => { const m = /^([A-Z]+)(\d+)$/.exec(a); let c = 0; for (const ch of m[1]) c = c * 26 + ch.charCodeAt(0) - 64; return book.value(sh, Number(m[2]) - 1, c - 1); };
const f = (formula) => { set('Z100', formula); book.calc.recalc(); return get('Z100'); };

for (let i = 1; i <= 5; i++) set(`A${i}`, String(i * 10));
set('B1', 'apple'); set('B2', 'banana'); set('B3', 'cherry'); set('B4', 'apple'); set('B5', 'date');
set('C1', '=A1*2'); set('C2', '=C1+A2'); set('D1', '=SUM(A1:A5)');
book.calc.recalc();
eq('basic', get('C1'), 20);
eq('chain', get('C2'), 40);
eq('sum', get('D1'), 150);
set('A1', '100'); book.calc.recalc();
eq('recalc dependents', get('C2'), 220);
eq('recalc range', get('D1'), 240);

eq('precedence', f('=2+3*4^2'), 50);
eq('unary', f('=-2^2'), 4);
eq('percent', f('=50%*10'), 5);
eq('concat', f('="a"&1&TRUE'), 'a1TRUE');
eq('compare', f('="Apple"="apple"'), true);
eq('div0', f('=1/0'), { code: '#DIV/0!' });
eq('average', f('=AVERAGE(A1:A5)'), 48);
eq('countif', f('=COUNTIF(B1:B5,"apple")'), 2);
eq('countif wildcard', f('=COUNTIF(B1:B5,"*an*")'), 1);
eq('countif op', f('=COUNTIF(A1:A5,">=30")'), 4);
eq('sumif', f('=SUMIF(B1:B5,"apple",A1:A5)'), 140);
eq('sumifs', f('=SUMIFS(A1:A5,B1:B5,"apple",A1:A5,">50")'), 100);
eq('vlookup', f('=VLOOKUP(30,A1:B5,2,FALSE)'), 'cherry');
eq('xlookup', f('=XLOOKUP("cherry",B1:B5,A1:A5)'), 30);
eq('xlookup missing', f('=XLOOKUP("kiwi",B1:B5,A1:A5,"none")'), 'none');
eq('index match', f('=INDEX(B1:B5,MATCH(40,A1:A5,0))'), 'apple');
eq('if', f('=IF(A2>15,"big","small")'), 'big');
eq('iferror', f('=IFERROR(1/0,"oops")'), 'oops');
eq('text fns', f('=UPPER(LEFT("hello",3))&LEN("abc")'), 'HEL3');
eq('substitute', f('=SUBSTITUTE("a-b-c","-","+")'), 'a+b+c');
eq('textjoin', f('=TEXTJOIN(", ",TRUE,B1:B3)'), 'apple, banana, cherry');
eq('round', f('=ROUND(2.345,2)'), 2.35);
eq('round neg', f('=ROUND(-2.5,0)'), -3);
eq('mod', f('=MOD(-3,2)'), 1);
eq('date', f('=DATE(2026,10,16)'), 46311);
eq('year', f('=YEAR(DATE(2026,10,16))'), 2026);
eq('eomonth', f('=DAY(EOMONTH(DATE(2024,1,15),1))'), 29);
eq('datedif', f('=DATEDIF(DATE(2000,1,1),DATE(2026,10,16),"Y")'), 26);
eq('pmt', f('=ROUND(PMT(0.05/12,360,200000),2)'), -1073.64);
eq('npv', f('=ROUND(NPV(0.1,-1000,300,400,500),2)'), -19.12);
eq('irr', f('=ROUND(IRR({-1000,300,400,500}),4)'), 0.089);
eq('let', f('=LET(x,5,y,x*2,x+y)'), 15);
eq('and/or', f('=AND(TRUE,OR(FALSE,1))'), true);
eq('switch', f('=SWITCH(2,1,"one",2,"two","other")'), 'two');
eq('name error', f('=NOPE(1)'), { code: '#NAME?' });
eq('stdev', f('=ROUND(STDEV(2,4,4,4,5,5,7,9),4)'), 2.1381);
eq('median', f('=MEDIAN(1,3,2,4)'), 2.5);
eq('large', f('=LARGE(A1:A5,2)'), 50);
eq('sumproduct', f('=SUMPRODUCT(A1:A2,{2;3})'), 260);

// Spilling arrays.
set('F1', '=SEQUENCE(3,2)');
book.calc.recalc();
eq('spill anchor', get('F1'), 1);
eq('spill cell', get('G3'), 6);
set('H1', '=SUM(F1:G3)'); book.calc.recalc();
eq('sum over spill', get('H1'), 21);
set('F3', 'x'); book.calc.recalc();
eq('spill blocked', get('F1'), { code: '#SPILL!' });
set('F3', ''); book.calc.recalc();
eq('spill restored', get('G3'), 6);
eq('sum after restore', get('H1'), 21);
set('J1', '=SORT(A1:A5,1,-1)'); book.calc.recalc();
eq('sort spill', get('J2'), 50);
set('K1', '=UNIQUE(B1:B5)'); book.calc.recalc();
eq('unique count', get('K4'), 'date');
set('L1', '=FILTER(B1:B5,A1:A5>35)'); book.calc.recalc();
eq('filter', get('L1'), 'apple');
eq('filter 2', get('L2'), 'apple');
set('M1', '=A1:A3*2'); book.calc.recalc();
eq('array math', get('M3'), 60);

// Circular references and long chains.
set('N1', '=N2+1'); set('N2', '=N1+1'); book.calc.recalc();
eq('circular', get('N1'), { code: '#CIRC!' });
set('P1', '1');
for (let i = 2; i <= 5000; i++) set(`P${i}`, `=P${i - 1}+1`);
book.calc.recalc();
eq('long chain', get('P5000'), 5000);
set('P1', '10'); book.calc.recalc();
eq('long chain update', get('P5000'), 5009);

// Undo.
book.edit('Type', () => set('Q1', '42'));
eq('before undo', get('Q1'), 42);
book.undo();
eq('after undo', get('Q1'), null);
book.redo();
eq('after redo', get('Q1'), 42);

// Insert rows moves formulas.
book.edit('Insert', () => book.insert(sh, 'row', 0, 1));
eq('insert shifts value', get('A2'), 100);
eq('insert shifts formula', get('D2'), 240);
eq('formula text after insert', sh.get(1, 3).f, 'SUM(A2:A6)');
book.undo();
eq('undo insert', get('D1'), 240);

// Reference rewriting.
eq('shift', shiftFormula('A1+$B$2+C$3+$D4', 2, 1), 'B3+$B$2+D$3+$D6');
eq('shift off grid', shiftFormula('A1', -1, 0), '#REF!');
eq('adjust delete', adjustForInsert('SUM(A1:A10)', 'S', 'S', 'row', 2, -3), 'SUM(A1:A7)');
eq('adjust delete ref', adjustForInsert('B5', 'S', 'S', 'row', 3, -5), '#REF!');
eq('parse sheet ref', parse("'My Sheet'!A1:B2").sheet, 'My Sheet');

// Number formats.
eq('fmt number', formatValue(1234.5, '#,##0.00').text, '1,234.50');
eq('fmt currency neg', formatValue(-1234.5, '$#,##0.00').text, '-$1,234.50');
eq('fmt red section', formatValue(-5, '#,##0;[Red]-#,##0').color, '#d1242f');
eq('fmt pct', formatValue(0.256, '0.0%').text, '25.6%');
eq('fmt sci', formatValue(12345, '0.00E+00').text, '1.23E+04');
eq('fmt date', formatValue(46311, 'yyyy-mm-dd').text, '2026-10-16');
eq('fmt long date', formatValue(46311, 'dddd, mmmm d, yyyy').text, 'Friday, October 16, 2026');
eq('fmt time', formatValue(0.75, 'h:mm AM/PM').text, '6:00 PM');
eq('fmt minutes', formatValue(0.5 + 5 / 1440, 'h:mm').text, '12:05');
eq('fmt elapsed', formatValue(1.5, '[h]:mm:ss').text, '36:00:00');
eq('fmt fraction', formatValue(1.25, '# ?/?').text, '1 1/4');
eq('fmt text', formatValue('hi', '"Name: "@').text, 'Name: hi');
eq('fmt general', formatValue(0.1 + 0.2, 'General').text, '0.3');
eq('fmt literal', formatValue(3, '0" items"').text, '3 items');
eq('decimals up', changeDecimals('0.0', 1), '0.00');
eq('decimals general', changeDecimals('General', 1), '0.0');

console.log(`${count - fails}/${count} passed`);
process.exit(fails ? 1 : 0);
