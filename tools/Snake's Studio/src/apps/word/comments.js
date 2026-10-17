// Comments: notes on a stretch of text, with replies, that can be resolved. The text a
// comment is about is wrapped in <span class="cmt" data-cmt="id"> (several spans when it
// crosses formatting or paragraphs); the comments themselves live in the document's meta
// (meta.comments), so undo, saving and Word's .docx (comments.xml) all carry them.
import { h, uid } from '../../kit/dom.js';
import { icon } from '../../kit/icons.js';
import { tb } from '../../kit/shell.js';
import { promptBox, confirmBox } from '../../kit/dialogs.js';
import { wrapRange } from './anchors.js';
import { isPhone } from '../../kit/phone.js';

const COLORS = ['#2f81f7', '#db61a2', '#d29922', '#3fb950', '#a371f7', '#f0883e', '#56d4dd'];
const colorOf = (name) => COLORS[[...String(name || '?')].reduce((a, c) => a + c.charCodeAt(0), 0) % COLORS.length];
const initialsOf = (name) => String(name || '?').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('') || '?';

function when(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const mins = (Date.now() - d.getTime()) / 60000;
  if (mins < 1) return 'just now';
  if (mins < 60) return `${Math.floor(mins)} min ago`;
  if (mins < 60 * 24 && d.getDate() === new Date().getDate()) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return d.toLocaleDateString([], { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

export class Comments {
  /**
   * ed: the WordEditor. settings: for the person's name. onShow(on): the pane was shown or hidden.
   */
  constructor(ed, settings, { onShow = () => {} } = {}) {
    this.ed = ed;
    this.settings = settings;
    this.onShow = onShow;
    this.active = null;
    this.editing = null;
    this.list = h('div.cmt-list');
    this.empty = h('div.empty.cmt-empty', h('div', { html: icon('comment', 28) }), h('div', 'No comments yet.'),
      h('div.muted', 'Select some text, then New Comment (Ctrl+Alt+M).'));
    this.showDone = settings.get('showResolved', false);
    const doneToggle = h('label.check.cmt-donebox', h('input', { type: 'checkbox', checked: this.showDone, onchange: (e) => { this.showDone = e.target.checked; settings.set('showResolved', this.showDone); this.paint(); } }), 'Resolved');
    this.pane = h('div.panel.cmt-pane',
      h('div.panel-head', 'Comments', h('span.grow'), doneToggle, tb({ icon: 'x', tip: 'Close', run: () => this.show(false) })),
      h('div.panel-body', this.empty, this.list));
    // Typing in a comment: its box keeps its own undo, select-all and the like; saving and
    // printing still reach the document.
    this.pane.addEventListener('keydown', (e) => {
      if (!e.target.matches('textarea, input')) return;
      if ((e.ctrlKey || e.metaKey) && !/^[sp]$/i.test(e.key)) e.stopPropagation();
    });
    this.list.addEventListener('pointerdown', (e) => {
      const card = e.target.closest('.cmt-card');
      if (card && !e.target.closest('button, textarea, input')) this.focus(card.dataset.id, { select: true });
    });
  }

  get all() { return this.ed.meta.comments || []; }
  byId(id) { return this.all.find((c) => c.id === id); }
  spans(id) { return [...this.ed.doc.querySelectorAll(`span.cmt[data-cmt="${CSS.escape(id)}"]`)]; }
  /** Comments whose text is still in the document, in document order. */
  ordered() {
    const seen = [];
    for (const s of this.ed.doc.querySelectorAll('span.cmt[data-cmt]')) if (!seen.includes(s.dataset.cmt)) seen.push(s.dataset.cmt);
    return seen.map((id) => this.byId(id)).filter(Boolean);
  }
  get visible() { return !this.pane.classList.contains('hidden'); }

  async author() {
    let name = this.settings.get('userName', '');
    if (!name) {
      name = (await promptBox('Your name, shown on your comments', { value: '', placeholder: 'Your name', ok: 'OK' }) || '').trim();
      if (!name) return null;
      this.settings.set('userName', name);
    }
    return name;
  }

  setMeta(label, fn) {
    this.ed.change(label, () => {
      const list = JSON.parse(JSON.stringify(this.all));
      fn(list);
      this.ed.meta = { ...this.ed.meta, comments: list };
    });
    this.paint();
  }

  /** A new comment on the selection (or the word at the caret). */
  async add() {
    const ed = this.ed;
    let r = ed.range();
    if (!r) { ed.focus(); r = ed.range(); }
    if (r && r.collapsed) { ed.selectWordAtCaret(); r = ed.range(); }
    if (!r || r.collapsed || !r.toString().trim()) return false;
    const saved = r.cloneRange();
    const name = await this.author();
    if (!name) return false;
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(saved);
    const id = uid('c');
    ed.change('New comment', () => {
      wrapRange(saved, ed.doc, id);
      const list = JSON.parse(JSON.stringify(this.all));
      list.push({ id, author: name, initials: initialsOf(name), date: new Date().toISOString(), text: '', done: false, replies: [] });
      ed.meta = { ...ed.meta, comments: list };
    });
    this.show(true);
    this.editing = id;
    this.paint();
    this.focus(id);
    return true;
  }

  remove(id) {
    this.ed.change('Delete comment', () => {
      for (const s of this.spans(id)) s.replaceWith(...s.childNodes);
      this.ed.meta = { ...this.ed.meta, comments: this.all.filter((c) => c.id !== id) };
    });
    if (this.active === id) this.active = null;
    this.paint();
  }

  async removeAll() {
    const n = this.ordered().length;
    if (!n || !(await confirmBox(`Delete all ${n} comment${n === 1 ? '' : 's'} in this document?`, { ok: 'Delete all', danger: true }))) return;
    this.ed.change('Delete all comments', () => {
      for (const s of this.ed.doc.querySelectorAll('span.cmt')) s.replaceWith(...s.childNodes);
      this.ed.meta = { ...this.ed.meta, comments: [] };
    });
    this.paint();
  }

  resolve(id, done = true) { this.setMeta(done ? 'Resolve comment' : 'Reopen comment', (list) => { const c = list.find((x) => x.id === id); if (c) c.done = done; }); }

  async reply(id, text) {
    const name = await this.author();
    if (!name || !text.trim()) return;
    this.setMeta('Reply', (list) => {
      const c = list.find((x) => x.id === id);
      if (c) (c.replies || (c.replies = [])).push({ author: name, initials: initialsOf(name), date: new Date().toISOString(), text: text.trim() });
    });
  }

  /** Next or previous comment from the caret. */
  step(dir) {
    const list = this.ordered().filter((c) => this.showDone || !c.done);
    if (!list.length) return;
    let i = list.findIndex((c) => c.id === this.active);
    if (i < 0) {
      const r = this.ed.range();
      const at = r ? r.startContainer : null;
      i = dir > 0 ? -1 : list.length;
      if (at) {
        list.forEach((c, k) => {
          const s = this.spans(c.id)[0];
          const before = s && (s.compareDocumentPosition(at) & Node.DOCUMENT_POSITION_FOLLOWING);
          if (before) i = dir > 0 ? k : k + 1;
        });
      }
    }
    const next = list[(i + dir + list.length) % list.length];
    this.show(true);
    this.focus(next.id, { select: true });
  }

  show(on = !this.visible) {
    // On a phone the pane is a drawer over the page.
    if (isPhone() && this.pane.snakeDrawer) {
      if (on) { this.pane.classList.remove('hidden'); this.paint(); this.pane.snakeDrawer.open(); } else this.pane.snakeDrawer.close();
      return;
    }
    this.pane.classList.toggle('hidden', !on);
    this.onShow(on);
    if (on) this.paint();
  }

  /** Make a comment the active one: its text marked in the document, its card in view. */
  focus(id, { select = false } = {}) {
    this.active = id;
    for (const s of this.ed.doc.querySelectorAll('span.cmt.cmt-on')) s.classList.remove('cmt-on');
    const spans = this.spans(id);
    for (const s of spans) s.classList.add('cmt-on');
    for (const c of this.list.children) c.classList.toggle('on', c.dataset.id === id);
    const card = [...this.list.children].find((c) => c.dataset.id === id);
    if (card) card.scrollIntoView({ block: 'nearest' });
    if (select && spans.length) {
      const r = document.createRange();
      r.setStartBefore(spans[0]);
      r.setEndAfter(spans[spans.length - 1]);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      spans[0].scrollIntoView({ block: 'center' });
    }
    const box = card && card.querySelector('textarea.cmt-edit');
    if (box && this.editing === id) box.focus();
  }

  /** The caret moved: the comment it is in becomes the active one. */
  caretMoved() {
    if (!this.visible) return;
    const r = this.ed.range();
    const span = r && (r.startContainer.nodeType === 1 ? r.startContainer : r.startContainer.parentElement).closest('span.cmt');
    if (span && span.dataset.cmt !== this.active) this.focus(span.dataset.cmt);
  }

  paint() {
    const ed = this.ed;
    const items = this.ordered();
    for (const s of ed.doc.querySelectorAll('span.cmt')) {
      const c = this.byId(s.dataset.cmt);
      s.classList.toggle('cmt-done', !!(c && c.done));
    }
    // (Drawn even while hidden: on a phone the pane is a drawer that may slide in at any time.)
    const shown = items.filter((c) => this.showDone || !c.done || c.id === this.active);
    this.empty.classList.toggle('hidden', shown.length > 0);
    this.list.replaceChildren(...shown.map((c) => this.card(c)));
    if (this.active) {
      const card = [...this.list.children].find((x) => x.dataset.id === this.active);
      if (card) card.classList.add('on');
    }
  }

  card(c) {
    const quote = this.spans(c.id).map((s) => s.textContent).join(' ').replace(/\s+/g, ' ').trim();
    const head = (who, date) => h('div.cmt-head', h('span.cmt-avatar', { style: { background: colorOf(who) } }, initialsOf(who)),
      h('div.cmt-who', h('b', who || 'Someone'), h('span.muted', when(date))));
    const body = (text) => h('div.cmt-text', text);
    const card = h(`div.cmt-card${c.done ? '.done' : ''}`, { dataset: { id: c.id } });
    const editing = this.editing === c.id;
    let main;
    if (editing) {
      const box = h('textarea.input.cmt-edit', { rows: 3, placeholder: 'Write a comment…', value: c.text || '' });
      const finish = (keep) => {
        this.editing = null;
        const text = box.value.trim();
        if (!text && !c.text) { this.remove(c.id); return; }
        if (keep && text !== c.text) this.setMeta('Comment', (list) => { const x = list.find((y) => y.id === c.id); if (x) x.text = text; });
        else this.paint();
        this.ed.focus();
      };
      box.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); finish(true); }
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); }
      });
      main = h('div.col', box, h('div.row.cmt-actions', h('span.grow'),
        h('button.btn.small', { onclick: () => finish(false) }, 'Cancel'),
        h('button.btn.small.primary', { onclick: () => finish(true) }, 'Comment')));
    } else main = body(c.text);
    const replies = (c.replies || []).map((r) => h('div.cmt-reply', head(r.author, r.date), body(r.text)));
    const replyBox = h('textarea.input.cmt-replybox', { rows: 1, placeholder: 'Reply…' });
    replyBox.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); const t = replyBox.value; replyBox.value = ''; this.reply(c.id, t); }
      if (e.key === 'Escape') { e.stopPropagation(); replyBox.value = ''; replyBox.blur(); }
    });
    const tools = h('div.cmt-tools',
      tb({ icon: c.done ? 'repeat' : 'check', tip: c.done ? 'Reopen' : 'Resolve', run: () => this.resolve(c.id, !c.done) }),
      tb({ icon: 'pencil', tip: 'Edit', run: () => { this.editing = c.id; this.paint(); this.focus(c.id); } }),
      tb({ icon: 'trash', tip: 'Delete the comment', run: () => this.remove(c.id) }));
    card.append(h('div.cmt-top', head(c.author, c.date), tools),
      quote ? h('div.cmt-quote', quote.length > 90 ? `${quote.slice(0, 90)}…` : quote) : null,
      main, ...replies, editing || c.done ? null : replyBox);
    return card;
  }
}
