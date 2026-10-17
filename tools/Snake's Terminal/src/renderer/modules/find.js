// The find bar: search the active pane's screen and scrollback.
import { el, icon } from './util.js';
import { activeSession } from './layout.js';

let bar = null;
let input;
let count;
let opts = { caseSensitive: false, regex: false, wholeWord: false };
let session = null;
let unsub = null;

const DECOR = {
  matchBackground: '#3fb95040', matchBorder: '#3fb95080', matchOverviewRuler: '#3fb950',
  activeMatchBackground: '#d2992299', activeMatchBorder: '#e3b341', activeMatchColorOverviewRuler: '#e3b341',
};

export function openFind() {
  const s = activeSession();
  if (!s) return;
  if (bar && session !== s) closeFind();
  session = s;
  if (!bar) build();
  s.paneEl.append(bar);
  const sel = s.term.getSelection();
  if (sel && !sel.includes('\n')) input.value = sel;
  input.select();
  input.focus();
  if (input.value) find(1);
}

function build() {
  input = el('input.input.find-input', { placeholder: 'Find', spellcheck: 'false', on: {
    input: () => find(1, true),
    keydown: (e) => {
      if (e.key === 'Enter') { find(e.shiftKey ? -1 : 1); e.preventDefault(); }
      else if (e.key === 'Escape') { closeFind(); e.preventDefault(); }
      e.stopPropagation();
    },
  } });
  count = el('span.find-count');
  const toggle = (key, label, title) => el(`button.find-opt${opts[key] ? '.on' : ''}`, { title, on: { click: (e) => { opts[key] = !opts[key]; e.currentTarget.classList.toggle('on', opts[key]); find(1, true); input.focus(); } } }, label);
  bar = el('div.find-bar', {},
    input, count,
    toggle('caseSensitive', 'Aa', 'Match case'),
    toggle('wholeWord', 'ab', 'Whole words'),
    toggle('regex', '.*', 'Regular expression'),
    el('button.icon-btn.small', { title: 'Previous (Shift+Enter)', on: { click: () => find(-1) } }, icon('up')),
    el('button.icon-btn.small', { title: 'Next (Enter)', on: { click: () => find(1) } }, icon('down')),
    el('button.icon-btn.small', { title: 'Close (Esc)', on: { click: closeFind } }, icon('close')));
}

function find(dir, incremental = false) {
  if (!session) return;
  unsub ||= session.search.onDidChangeResults(({ resultIndex, resultCount }) => {
    count.textContent = resultCount ? `${resultIndex + 1} of ${resultCount}` : input.value ? 'No results' : '';
  });
  const o = { ...opts, incremental, decorations: DECOR };
  if (!input.value) { session.search.clearDecorations(); count.textContent = ''; return; }
  try {
    if (dir > 0) session.search.findNext(input.value, o);
    else session.search.findPrevious(input.value, o);
    input.classList.remove('bad');
  } catch {
    input.classList.add('bad');
  }
}

export function closeFind() {
  if (!bar) return;
  session?.search.clearDecorations();
  unsub?.dispose();
  unsub = null;
  bar.remove();
  session?.focus();
  session = null;
}
