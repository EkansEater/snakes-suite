// Ready-made workbooks for the start screen. Each builds a Book with formulas
// that stay live, so they double as examples of what the app can do.
import { h } from '../../kit/dom.js';
import { Book } from './engine.js';
import { parseRange } from './formula.js';

function filler(book, sh) {
  const st = (s) => book.styles.id(s);
  const put = (ref, value, style) => {
    const g = parseRange(ref);
    const fmt = book.input(sh, g.r0, g.c0, value);
    const s = { ...(fmt && !(style && style.fmt) ? { fmt } : {}), ...(style || {}) };
    if (Object.keys(s).length) book.setStyle(sh, g.r0, g.c0, st(s));
  };
  const style = (ref, s) => {
    const g = parseRange(ref);
    for (let r = g.r0; r <= g.r1; r++) for (let c = g.c0; c <= g.c1; c++) {
      const cur = sh.get(r, c);
      book.setStyle(sh, r, c, book.styles.with(cur ? cur.s : 0, s));
    }
  };
  return { put, style, st };
}

const HEAD = { bold: true, fill: '#2ea043', color: '#ffffff' };
const TITLE = { bold: true, size: 18 };
const MONEY = '$#,##0.00';

export const TEMPLATES = [
  { id: 'blank', name: 'Blank workbook', build: () => { const b = new Book(); b.addSheet('Sheet1'); return b; } },
  {
    id: 'budget', name: 'Monthly budget',
    build: () => {
      const b = new Book();
      const sh = b.addSheet('Budget');
      const { put, style } = filler(b, sh);
      put('A1', 'Monthly Budget', TITLE);
      put('A2', 'Income');
      put('B2', '4200', { fmt: MONEY, bold: true });
      ['Category', 'Budget', 'Actual', 'Difference', 'Trend'].forEach((t, i) => put(`${'ABCDE'[i]}4`, t, HEAD));
      const rows = [['Rent', 1400, 1400], ['Groceries', 500, 563], ['Transport', 220, 180], ['Utilities', 190, 205], ['Phone & internet', 110, 110], ['Eating out', 200, 265], ['Savings', 800, 800], ['Fun', 150, 122]];
      rows.forEach(([cat, bud, act], i) => {
        const r = 5 + i;
        put(`A${r}`, cat);
        put(`B${r}`, String(bud), { fmt: MONEY });
        put(`C${r}`, String(act), { fmt: MONEY });
        put(`D${r}`, `=B${r}-C${r}`, { fmt: '$#,##0.00;[Red]-$#,##0.00' });
        put(`E${r}`, `=PROGRESS(C${r},B${r})`);
      });
      const end = 4 + rows.length;
      put(`A${end + 1}`, 'Total', { bold: true });
      put(`B${end + 1}`, `=SUM(B5:B${end})`, { fmt: MONEY, bold: true });
      put(`C${end + 1}`, `=SUM(C5:C${end})`, { fmt: MONEY, bold: true });
      put(`D${end + 1}`, `=B${end + 1}-C${end + 1}`, { fmt: '$#,##0.00;[Red]-$#,##0.00', bold: true });
      put(`A${end + 2}`, 'Left over');
      put(`B${end + 2}`, `=B2-C${end + 1}`, { fmt: '$#,##0.00;[Red]-$#,##0.00', bold: true });
      style(`A${end + 1}:E${end + 1}`, { border: { t: 'medium #2ea043' } });
      sh.colW.set(0, 150); sh.colW.set(4, 140);
      sh.cf.push({ range: { r0: 4, c0: 3, r1: end - 1, c1: 3 }, type: 'lt', a: 0, style: { fill: '#fde8e8', color: '#9c0006' } });
      sh.charts.push({ id: 'c1', type: 'column', range: `A4:C${end}`, title: 'Budget vs actual', x: 560, y: 30, w: 460, h: 300 });
      sh.freeze = { r: 4, c: 0 };
      b.calc.rebuild();
      return b;
    },
  },
  {
    id: 'invoice', name: 'Invoice',
    build: () => {
      const b = new Book();
      const sh = b.addSheet('Invoice');
      const { put, style } = filler(b, sh);
      put('A1', 'INVOICE', { bold: true, size: 24, color: '#1f883d' });
      put('A3', 'Your Company'); put('A4', '123 Main Street'); put('A5', 'City, ST 00000');
      put('D3', 'Invoice #', { bold: true }); put('E3', '1001');
      put('D4', 'Date', { bold: true }); put('E4', '=TODAY()', { fmt: 'mmm d, yyyy' });
      put('D5', 'Due', { bold: true }); put('E5', '=E4+30', { fmt: 'mmm d, yyyy' });
      put('A7', 'Bill to', { bold: true }); put('A8', 'Customer name'); put('A9', 'Customer address');
      ['Item', 'Description', 'Qty', 'Unit price', 'Amount'].forEach((t, i) => put(`${'ABCDE'[i]}11`, t, HEAD));
      [['Design', 'Logo and branding', 1, 750], ['Website', 'Five-page site', 1, 2400], ['Hosting', 'One year', 12, 15]].forEach(([it, d, q, p], i) => {
        const r = 12 + i;
        put(`A${r}`, it); put(`B${r}`, d); put(`C${r}`, String(q)); put(`D${r}`, String(p), { fmt: MONEY });
        put(`E${r}`, `=IF(C${r}="","",C${r}*D${r})`, { fmt: MONEY });
      });
      for (let r = 15; r <= 19; r++) put(`E${r}`, `=IF(C${r}="","",C${r}*D${r})`, { fmt: MONEY });
      put('D21', 'Subtotal'); put('E21', '=SUM(E12:E19)', { fmt: MONEY });
      put('D22', 'Tax rate'); put('E22', '8%');
      put('D23', 'Tax'); put('E23', '=E21*E22', { fmt: MONEY });
      put('D24', 'Total', { bold: true }); put('E24', '=E21+E23', { fmt: MONEY, bold: true, size: 13 });
      style('D24:E24', { border: { t: 'thin #1b1f1c', b: 'double #1b1f1c' } });
      put('A27', 'Thank you for your business!', { italic: true, color: '#5a6560' });
      sh.colW.set(1, 220); sh.colW.set(3, 110); sh.colW.set(4, 120);
      sh.showGrid = false;
      b.calc.rebuild();
      return b;
    },
  },
  {
    id: 'tracker', name: 'Task tracker',
    build: () => {
      const b = new Book();
      const sh = b.addSheet('Tasks');
      const { put } = filler(b, sh);
      ['Task', 'Owner', 'Due', 'Status', 'Priority', 'Days left'].forEach((t, i) => put(`${'ABCDEF'[i]}1`, t, HEAD));
      const tasks = [['Plan the launch', 'Sam', 3, 'In progress', 'High'], ['Write the docs', 'Ada', 7, 'Not started', 'Medium'], ['Fix the login bug', 'Lee', 1, 'Done', 'High'], ['Design the poster', 'Kim', 10, 'In progress', 'Low'], ['Order supplies', 'Sam', 5, 'Blocked', 'Medium']];
      tasks.forEach(([t, o, d, s, p], i) => {
        const r = i + 2;
        put(`A${r}`, t); put(`B${r}`, o); put(`C${r}`, `=TODAY()+${d}`, { fmt: 'mmm d' }); put(`D${r}`, s); put(`E${r}`, p);
        put(`F${r}`, `=IF(D${r}="Done","",C${r}-TODAY())`);
      });
      put('H1', 'Done', { bold: true }); put('I1', '=COUNTIF(D2:D100,"Done")/MAX(1,COUNTA(A2:A100))', { fmt: '0%' });
      put('H2', 'Progress', { bold: true }); put('I2', '=PROGRESS(I1)');
      sh.valid.push({ range: { r0: 1, c0: 3, r1: 99, c1: 3 }, type: 'list', list: ['Not started', 'In progress', 'Blocked', 'Done'] });
      sh.valid.push({ range: { r0: 1, c0: 4, r1: 99, c1: 4 }, type: 'list', list: ['High', 'Medium', 'Low'] });
      sh.cf.push({ range: { r0: 1, c0: 3, r1: 99, c1: 3 }, type: 'eq', a: 'Done', style: { fill: '#dcf5e1', color: '#1a7f37' } });
      sh.cf.push({ range: { r0: 1, c0: 3, r1: 99, c1: 3 }, type: 'eq', a: 'Blocked', style: { fill: '#fde8e8', color: '#9c0006' } });
      sh.cf.push({ range: { r0: 1, c0: 4, r1: 99, c1: 4 }, type: 'eq', a: 'High', style: { bold: true, color: '#cf222e' } });
      sh.colW.set(0, 200); sh.colW.set(3, 120);
      sh.freeze = { r: 1, c: 0 };
      sh.filter = { r0: 0, c0: 0, r1: 99, c1: 5, crit: {} };
      b.calc.rebuild();
      return b;
    },
  },
  {
    id: 'loan', name: 'Loan calculator',
    build: () => {
      const b = new Book();
      const sh = b.addSheet('Loan');
      const { put } = filler(b, sh);
      put('A1', 'Loan Calculator', TITLE);
      put('A3', 'Amount'); put('B3', '$250,000', { fmt: '$#,##0' });
      put('A4', 'Yearly interest'); put('B4', '6.5%', { fmt: '0.00%' });
      put('A5', 'Years'); put('B5', '30');
      put('A7', 'Monthly payment', { bold: true }); put('B7', '=-PMT(B4/12,B5*12,B3)', { fmt: MONEY, bold: true, color: '#1f883d', size: 13 });
      put('A8', 'Total paid'); put('B8', '=B7*B5*12', { fmt: MONEY });
      put('A9', 'Total interest'); put('B9', '=B8-B3', { fmt: MONEY });
      ['Month', 'Interest', 'Principal', 'Balance'].forEach((t, i) => put(`${'DEFG'[i]}2`, t, HEAD));
      put('D3', '=SEQUENCE(B5*12)');
      put('E3', '=-IPMT($B$4/12,D3:D362,$B$5*12,$B$3)', { fmt: MONEY });
      put('F3', '=-PPMT($B$4/12,D3:D362,$B$5*12,$B$3)', { fmt: MONEY });
      put('G3', '=-FV($B$4/12,D3:D362,-$B$7,$B$3)', { fmt: MONEY });
      sh.colW.set(0, 140); sh.colW.set(1, 120);
      for (const c of [4, 5, 6]) sh.colW.set(c, 110);
      sh.freeze = { r: 2, c: 0 };
      sh.charts.push({ id: 'c1', type: 'line', range: 'E2:F62', title: 'Interest and principal (first 5 years)', x: 30, y: 270, w: 420, h: 260 });
      b.calc.rebuild();
      return b;
    },
  },
  {
    id: 'grades', name: 'Grade book',
    build: () => {
      const b = new Book();
      const sh = b.addSheet('Grades');
      const { put } = filler(b, sh);
      ['Student', 'Test 1', 'Test 2', 'Project', 'Final', 'Average', 'Grade'].forEach((t, i) => put(`${'ABCDEFG'[i]}1`, t, HEAD));
      const students = [['Avery', 88, 92, 95, 90], ['Blake', 72, 65, 80, 70], ['Casey', 95, 98, 92, 97], ['Drew', 60, 75, 68, 72], ['Emery', 84, 80, 88, 85], ['Finley', 91, 87, 79, 93]];
      students.forEach(([n, ...s], i) => {
        const r = i + 2;
        put(`A${r}`, n);
        s.forEach((v, j) => put(`${'BCDE'[j]}${r}`, String(v)));
        put(`F${r}`, `=AVERAGE(B${r}:E${r})`, { fmt: '0.0' });
        put(`G${r}`, `=IFS(F${r}>=90,"A",F${r}>=80,"B",F${r}>=70,"C",F${r}>=60,"D",TRUE,"F")`, { align: 'center', bold: true });
      });
      put('A9', 'Class average', { bold: true });
      for (const c of 'BCDEF') put(`${c}9`, `=AVERAGE(${c}2:${c}7)`, { fmt: '0.0', bold: true });
      sh.cf.push({ range: { r0: 1, c0: 1, r1: 6, c1: 4 }, type: 'scale', colors: ['#f8696b', '#ffeb84', '#63be7b'] });
      sh.cf.push({ range: { r0: 1, c0: 5, r1: 6, c1: 5 }, type: 'bar', color: '#2f81f7' });
      sh.freeze = { r: 1, c: 1 };
      b.calc.rebuild();
      return b;
    },
  },
  {
    id: 'sales', name: 'Sales dashboard',
    build: () => {
      const b = new Book();
      const sh = b.addSheet('Sales');
      const { put } = filler(b, sh);
      put('A1', 'Sales Dashboard', TITLE);
      ['Month', 'North', 'South', 'East', 'West', 'Total', 'Trend'].forEach((t, i) => put(`${'ABCDEFG'[i]}3`, t, HEAD));
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      months.forEach((m, i) => {
        const r = i + 4;
        put(`A${r}`, m);
        [120, 90, 140, 70].forEach((base, j) => put(`${'BCDE'[j]}${r}`, String(Math.round(base * (1 + i * 0.05) + ((i * 37 + j * 11) % 23))), { fmt: '$#,##0' }));
        put(`F${r}`, `=SUM(B${r}:E${r})`, { fmt: '$#,##0', bold: true });
        put(`G${r}`, `=SPARKLINE(B${r}:E${r},"column")`);
      });
      put('A16', 'Year', { bold: true });
      for (const c of 'BCDEF') put(`${c}16`, `=SUM(${c}4:${c}15)`, { fmt: '$#,##0', bold: true });
      put('G16', '=SPARKLINE(F4:F15)');
      put('I3', 'Best region', HEAD); put('J3', '=INDEX(B3:E3,MATCH(MAX(B16:E16),B16:E16,0))', { bold: true });
      put('I4', 'Best month', HEAD); put('J4', '=XLOOKUP(MAX(F4:F15),F4:F15,A4:A15)', { bold: true });
      put('I5', 'Average month', HEAD); put('J5', '=AVERAGE(F4:F15)', { fmt: '$#,##0' });
      sh.colW.set(8, 130);
      sh.cf.push({ range: { r0: 3, c0: 5, r1: 14, c1: 5 }, type: 'bar', color: '#3fb950' });
      sh.charts.push({ id: 'c1', type: 'line', range: 'A3:E15', title: 'Sales by region', x: 1080, y: 30, w: 480, h: 290, smooth: true });
      sh.charts.push({ id: 'c2', type: 'doughnut', range: 'B3:E3', range2: 'B16:E16', title: 'Share of the year', x: 1080, y: 340, w: 480, h: 280 });
      sh.freeze = { r: 3, c: 1 };
      b.calc.rebuild();
      return b;
    },
  },
];

/** A small picture of a template's first rows, for the start screen. */
export function templateThumb(t) {
  const box = h('div.sheet-thumb');
  try {
    const book = t.build();
    const sh = book.sheets[0];
    const table = h('table');
    for (let r = 0; r < 14; r++) {
      const tr = h('tr');
      for (let c = 0; c < 6; c++) {
        const cell = sh.get(r, c);
        const st = book.styles.get(cell ? cell.s : 0);
        const v = book.value(sh, r, c);
        const td = h('td', { style: { background: st.fill || '', color: st.color || '', fontWeight: st.bold ? '700' : '' } }, v === null || typeof v === 'object' ? '' : String(typeof v === 'number' ? Math.round(v * 100) / 100 : v));
        tr.append(td);
      }
      table.append(tr);
    }
    box.append(table);
  } catch {}
  return box;
}
