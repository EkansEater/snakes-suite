// Starting decks for the start screen.
import { h, uid } from '../../kit/dom.js';
import { newPresentation, makeSlide, renderSlide, settle, THEMES } from './model.js';

const P = (t) => t.split('\n').map((l) => `<p>${l}</p>`).join('');
const L = (items) => `<ul>${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;

function fill(slide, values) {
  for (const it of slide.items) if (it.ph && values[it.ph] !== undefined) it.html = values[it.ph];
  return slide;
}

function deck(theme, slides) {
  const pres = newPresentation(theme);
  pres.slides = slides.map(([layout, values, extra]) => {
    const s = fill(makeSlide(layout, pres.size), values || {});
    if (extra) extra(s, pres);
    return s;
  });
  return pres;
}

export const TEMPLATES = [
  { id: 'blank', name: 'Blank', build: (theme = 'snake') => newPresentation(theme) },
  {
    id: 'pitch', name: 'Pitch deck',
    build: () => deck('snake', [
      ['title', { title: 'Your Big Idea', subtitle: 'A one-line promise of what you do' }],
      ['content', { title: 'The problem', body: L(['Who has it, and how often', 'What it costs them today', 'Why the old ways fail']) }],
      ['content', { title: 'Our solution', body: L(['What we built', 'Why it is ten times better', 'A quick demo or picture']) }],
      ['big', { number: '$4.2B', subtitle: 'Market we can reach in five years' }],
      ['two', { title: 'How we make money', body: L(['Subscription: $12 a month', 'Teams: $9 a seat']), body2: L(['Year 1: 2,000 customers', 'Year 2: 15,000 customers']) }],
      ['titleOnly', { title: 'Roadmap' }, (s, pres) => {
        const labels = ['Launch', 'Grow', 'Expand', 'Scale'];
        labels.forEach((t, i) => s.items.push({ id: uid('it'), type: 'shape', shape: 'chevron', x: 90 + i * 280, y: 300, w: 290, h: 120, rot: 0, html: `<p><b>${t}</b></p>`, style: { fill: `accent${i}`, align: 'center', valign: 'middle', size: 26 } }));
        void pres;
      }],
      ['quote', { quote: '“This changed how our whole team works.”', author: '— An early customer' }],
      ['section', { title: 'Thank you', subtitle: 'you@example.com · example.com' }],
    ]),
  },
  {
    id: 'update', name: 'Project update',
    build: () => deck('clean', [
      ['title', { title: 'Project Update', subtitle: new Date().toLocaleDateString(undefined, { month: 'long', year: 'numeric' }) }],
      ['content', { title: 'Agenda', body: L(['Where we are', 'Numbers', 'Risks', 'Next steps']) }],
      ['titleOnly', { title: 'Progress' }, (s, pres) => s.items.push({ id: uid('it'), type: 'chart', x: 90, y: 170, w: pres.size.w - 180, h: 480, rot: 0, chart: { type: 'column', title: 'Tasks finished per month', categories: ['Jul', 'Aug', 'Sep', 'Oct'], series: [{ name: 'Planned', values: [20, 24, 26, 30] }, { name: 'Done', values: [18, 25, 22, 31] }] } })],
      ['titleOnly', { title: 'Risks' }, (s, pres) => s.items.push({ id: uid('it'), type: 'table', x: 90, y: 180, w: pres.size.w - 180, h: 300, rot: 0, rows: [['Risk', 'Impact', 'Plan'], ['Supplier late', 'High', 'Second supplier lined up'], ['Budget', 'Medium', 'Weekly review'], ['New rules', 'Low', 'Watch and adapt']].map((r) => r.map((c) => ({ html: c }))), style: { size: 22, striped: true } })],
      ['content', { title: 'Next steps', body: L(['Finish testing by the 15th', 'Launch to the first customers', 'Report back next month']) }],
    ]),
  },
  {
    id: 'lesson', name: 'Lesson',
    build: () => deck('paper', [
      ['title', { title: 'Lesson Title', subtitle: 'Subject · Class' }],
      ['content', { title: 'Today you will learn', body: L(['The first idea', 'How it connects to what you know', 'How to use it']) }],
      ['two', { title: 'Key ideas', body: P('<b>Idea one</b>\nA short explanation.'), body2: P('<b>Idea two</b>\nA short explanation.') }],
      ['quote', { quote: '“Tell me and I forget. Teach me and I remember. Involve me and I learn.”', author: '— Proverb' }],
      ['content', { title: 'Check your understanding', body: '<ol><li>Question one?</li><li>Question two?</li><li>Question three?</li></ol>' }],
    ]),
  },
  {
    id: 'portfolio', name: 'Portfolio',
    build: () => deck('mono', [
      ['title', { title: 'Your Name', subtitle: 'Designer · Developer · Maker' }],
      ['picture', { caption: 'Project one: what it is and what you did' }],
      ['picture', { caption: 'Project two: what it is and what you did' }],
      ['big', { number: '12', subtitle: 'Projects shipped this year' }],
      ['section', { title: 'Let’s work together', subtitle: 'you@example.com' }],
    ]),
  },
  {
    id: 'ocean', name: 'Ocean talk',
    build: () => deck('ocean', [
      ['title', { title: 'A Talk Worth Giving', subtitle: 'Your name · Event' }],
      ['section', { title: 'Part one', subtitle: 'Why it matters' }],
      ['content', { title: 'Three things to remember', body: L(['One', 'Two', 'Three']) }],
      ['big', { number: '3×', subtitle: 'Faster than last year' }],
    ]),
  },
];

/** The first slide of a template, small, for the start screen. */
export function templateThumb(t) {
  const box = h('div.deck-thumb');
  try {
    const pres = t.build();
    const el = renderSlide(pres.slides[0], pres, {});
    el.style.transformOrigin = '0 0';
    box.append(el);
    new ResizeObserver(() => {
      const s = box.clientWidth / pres.size.w;
      el.style.transform = `scale(${s})`;
      settle(el, s);
    }).observe(box);
  } catch {}
  return box;
}

export { THEMES };
