// Newer Excel functions against the results Excel documents: node test/functions.test.mjs
import { Book } from '../src/apps/sheets/engine.js';

const book = new Book();
const sh = book.addSheet('Data');
const data = [[1, 10], [2, 20], [3, 30], [4, 40], [5, 50]];
data.forEach((row, r) => row.forEach((v, c) => book.input(sh, r, c, String(v))));
// cash flows and dates for XIRR: -10000 on 2008-01-01 etc. (Excel's example: 0.373362535)
const flows = [['-10000', '2008-01-01'], ['2750', '2008-03-01'], ['4250', '2008-10-30'], ['3250', '2009-02-15'], ['2750', '2009-04-01']];
flows.forEach(([v, d], i) => { book.input(sh, i, 4, v); book.input(sh, i, 5, d); });
const tests = [
  ['=SUBTOTAL(9,A1:A5)', 15], ['=SUBTOTAL(109,A1:A5)', 13], ['=AGGREGATE(14,6,A1:A5,2)', 4],
  ['=XIRR(E1:E5,F1:F5)', 0.373362535], ['=XNPV(0.09,E1:E5,F1:F5)', 2086.647602],
  ['=NETWORKDAYS.INTL(DATE(2006,1,1),DATE(2006,1,31),7)', 23], ['=WORKDAY.INTL(DATE(2012,1,1),30,0)', '#NUM!'],
  ['=REGEXTEST("abc123","[0-9]+")', true], ['=REGEXEXTRACT("Order 4521 shipped","[0-9]+")', '4521'], ['=REGEXREPLACE("a-b-c","-","+")', 'a+b+c'],
  ['=ROMAN(1999)', 'MCMXCIX'], ['=ARABIC("MCMXCIX")', 1999], ['=DEC2BIN(9,8)', '00001001'], ['=HEX2DEC("FF")', 255], ['=DEC2HEX(-1)', 'FFFFFFFFFF'], ['=BASE(255,16)', 'FF'],
  ['=NORM.S.INV(0.908789)', 1.333335], ['=NORM.INV(0.908789,40,1.5)', 42.000002], ['=NORM.S.DIST(1.333333,TRUE)', 0.908788726],
  ['=T.DIST(60,1,TRUE)', 0.99469533], ['=T.DIST.2T(1.959999998,60)', 0.054645], ['=T.INV.2T(0.546449,60)', 0.606533],
  ['=CHISQ.DIST.RT(18.307,10)', 0.0500006], ['=BINOM.DIST(6,10,0.5,FALSE)', 0.205078125], ['=POISSON.DIST(2,5,TRUE)', 0.124652],
  ['=CONFIDENCE.NORM(0.05,2.5,50)', 0.692951912], ['=SKEW(3,4,5,2,3,4,5,6,4,7)', 0.359543], ['=KURT(3,4,5,2,3,4,5,6,4,7)', -0.151799637],
  ['=PERCENTRANK.INC(A1:A5,4)', 0.75], ['=CUMIPMT(0.09/12,30*12,125000,13,24,0)', -11135.23213], ['=CUMPRINC(0.09/12,30*12,125000,13,24,0)', -934.1071234],
  ['=DDB(2400,300,10*365,1)', 1.315068493], ['=DB(1000000,100000,6,1,7)', 186083.3333], ['=SYD(30000,7500,10,1)', 4090.909091],
  ['=SUM(CHOOSECOLS(A1:B5,2))', 150], ['=ROWS(TOCOL(A1:B5))', 10], ['=COLUMNS(WRAPROWS(A1:A5,2))', 2], ['=ROWS(EXPAND(A1:A2,3,,0))', 3],
  ['=SUM(FREQUENCY(B1:B5,{25,45}))', 5], ['=INDEX(FREQUENCY(B1:B5,{25,45}),2)', 2],
  ['=LET(sq,LAMBDA(x,x*x),sq(4))', 16], ['=SUM(MAP(A1:A5,LAMBDA(x,x*2)))', 30], ['=REDUCE(0,A1:A5,LAMBDA(a,b,a+b))', 15],
  ['=INDEX(SCAN(0,A1:A5,LAMBDA(a,b,a+b)),5)', 15], ['=SUM(BYROW(A1:B5,LAMBDA(r,SUM(r))))', 165], ['=SUM(MAKEARRAY(2,3,LAMBDA(r,c,r*c)))', 18],
  ['=LAMBDA(x,x)', '#CALC!'], ['=COUNTUNIQUE(1,2,2,"a","A")', 3], ['=JOIN("-",A1:A3)', '1-2-3'], ['=COLUMNS(SPLIT("a,b,,c",","))', 3],
  ['=MyDouble(21)', 42],
];
book.names.set('MYDOUBLE', { name: 'MyDouble', ref: '=LAMBDA(n, n*2)' });
sh.hiddenR.add(1); sh.filter = { r0: 0, c0: 0, r1: 4, c1: 1, crit: {}, hidden: [] };
let bad = 0;
tests.forEach(([f, want], i) => {
  book.input(sh, 20 + i, 0, f);
  let got = book.value(sh, 20 + i, 0);
  if (got && typeof got === 'object' && got.code) got = got.code;
  const ok = typeof want === 'number' ? typeof got === 'number' && Math.abs(got - want) <= Math.max(1e-6, Math.abs(want) * 2e-5) : got === want;
  if (!ok) bad++;
  if (!ok) console.log('FAIL', f, '=>', got, `(want ${want})`);
});
console.log(bad ? `${bad} of ${tests.length} failed` : `${tests.length}/${tests.length} passed`);
if (bad) process.exit(1);
