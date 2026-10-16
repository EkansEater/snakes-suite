// Dialogs, toasts, tooltips and a busy veil.
import { h } from './dom.js';
import { icon } from './icons.js';
import { formatKeys } from './keys.js';

let depth = 0;
export const dialogOpen = () => depth > 0;

/**
 * modal({ title, body, buttons: [{ label, value, primary, danger, left }], width, cancelValue })
 * Resolves with the chosen button's value (or cancelValue on Esc / backdrop).
 * A button's `run(close)` may handle the click itself and return false to stay open.
 */
export function modal({ title = '', body = null, buttons = [{ label: 'OK', value: true, primary: true }], width = null,
  cancelValue = null, onOpen = null, closeOnBackdrop = true } = {}) {
  return new Promise((resolve) => {
    const prevFocus = document.activeElement;
    const content = typeof body === 'string' ? h('div', { style: { whiteSpace: 'pre-wrap' } }, body) : body;
    const foot = h('div.dialog-foot');
    const closeBtn = h('button.tb', { title: 'Close', html: icon('x', 16) });
    const dlg = h('div.dialog', { role: 'dialog', style: width ? { width: typeof width === 'number' ? `${width}px` : width } : null },
      h('div.dialog-head', h('span.grow', title), closeBtn),
      h('div.dialog-body', content),
      buttons.length ? foot : null);
    const overlay = h('div.overlay', dlg);
    depth++;
    const close = (value) => {
      overlay.remove();
      depth--;
      document.removeEventListener('keydown', onKey, true);
      if (prevFocus && prevFocus.focus) prevFocus.focus({ preventScroll: true });
      resolve(value);
    };
    for (const b of buttons) {
      const btn = h(`button.btn${b.primary ? '.primary' : ''}${b.danger ? '.danger' : ''}${b.left ? '.left' : ''}`, b.label);
      btn.addEventListener('click', async () => {
        if (b.run) {
          const r = await b.run(close);
          if (r === false) return;
        }
        close(b.value);
      });
      foot.append(btn);
      if (b.primary) dlg.dataset.primary = 'y', (dlg.primaryBtn = btn);
    }
    closeBtn.addEventListener('click', () => close(cancelValue));
    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay && closeOnBackdrop) close(cancelValue); });
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(cancelValue); }
      else if (e.key === 'Enter' && dlg.primaryBtn && !(e.target.tagName === 'TEXTAREA') && !e.shiftKey) {
        e.preventDefault(); e.stopPropagation(); dlg.primaryBtn.click();
      } else e.stopPropagation();
    };
    document.addEventListener('keydown', onKey, true);
    document.body.append(overlay);
    const first = dlg.querySelector('input, textarea, select') || dlg.primaryBtn || closeBtn;
    setTimeout(() => { first.focus(); if (first.select && first.tagName === 'INPUT') first.select(); }, 0);
    if (onOpen) onOpen(dlg, close);
  });
}

export function alertBox(message, title = '') {
  return modal({ title, body: message, buttons: [{ label: 'OK', value: true, primary: true }], cancelValue: true });
}

export function confirmBox(message, { title = '', ok = 'OK', cancel = 'Cancel', danger = false } = {}) {
  return modal({ title, body: message, buttons: [{ label: cancel, value: false }, { label: ok, value: true, primary: !danger, danger }], cancelValue: false });
}

/** Ask for a line of text. Resolves with the text, or null when cancelled. */
export function promptBox(title, { label = '', value = '', placeholder = '', validate = null, multiline = false, ok = 'OK' } = {}) {
  const input = multiline ? h('textarea.input', { rows: 6, placeholder }, value) : h('input.input', { value, placeholder, spellcheck: false });
  const err = h('div', { style: { color: 'var(--error-soft)', fontSize: '12px', minHeight: '16px' } });
  const body = h('div.col', label ? h('label.muted', label) : null, input, err);
  return modal({
    title, body, cancelValue: null,
    buttons: [{ label: 'Cancel', value: null }, {
      label: ok, primary: true,
      run: () => {
        const msg = validate ? validate(input.value) : '';
        if (msg) { err.textContent = msg; return false; }
        return true;
      },
      get value() { return input.value; },
    }],
  });
}

/** "Save changes to X?" Resolves 'save', 'discard' or 'cancel'. */
export function saveChangesBox(name) {
  return modal({
    title: 'Save your changes?',
    body: `“${name}” has changes that are not saved yet.`,
    cancelValue: 'cancel',
    buttons: [
      { label: "Don't save", value: 'discard', danger: true, left: true },
      { label: 'Cancel', value: 'cancel' },
      { label: 'Save', value: 'save', primary: true },
    ],
  });
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
let toastBox = null;
export function toast(message, { type = 'info', timeout = 3800, action = null } = {}) {
  if (!toastBox) {
    toastBox = h('div.toasts');
    document.body.append(toastBox);
  }
  const t = h(`div.toast${type === 'error' ? '.error' : type === 'warn' ? '.warn' : ''}`, h('span', message));
  if (action) {
    const b = h('button.btn.small', action.label);
    b.addEventListener('click', () => { t.remove(); action.run(); });
    t.append(b);
  }
  t.addEventListener('click', (e) => { if (e.target === t) t.remove(); });
  toastBox.append(t);
  if (timeout) setTimeout(() => t.remove(), timeout);
  return t;
}

export const errorToast = (err) => toast(String((err && err.message) || err), { type: 'error', timeout: 7000 });

// ---------------------------------------------------------------------------
// Tooltips: any element with data-tip (and optional data-keys, data-detail)
// ---------------------------------------------------------------------------
let tipEl = null;
let tipTimer = 0;
let tipTarget = null;
function hideTip() {
  clearTimeout(tipTimer);
  if (tipEl) tipEl.remove();
  tipEl = null;
  tipTarget = null;
}
document.addEventListener('pointerover', (e) => {
  const t = e.target instanceof Element ? e.target.closest('[data-tip]') : null;
  if (t === tipTarget) return;
  hideTip();
  if (!t || e.pointerType === 'touch') return;
  tipTarget = t;
  tipTimer = setTimeout(() => {
    if (!document.body.contains(t)) return;
    tipEl = h('div.tooltip', t.dataset.tip, t.dataset.keys ? h('span.kbd', formatKeys(t.dataset.keys)) : null,
      t.dataset.detail ? h('small', t.dataset.detail) : null);
    document.body.append(tipEl);
    const r = t.getBoundingClientRect();
    const w = tipEl.offsetWidth;
    let left = Math.min(window.innerWidth - w - 6, Math.max(6, r.left + r.width / 2 - w / 2));
    let top = r.bottom + 6;
    if (top + tipEl.offsetHeight > window.innerHeight - 6) top = r.top - tipEl.offsetHeight - 6;
    tipEl.style.left = `${left}px`;
    tipEl.style.top = `${top}px`;
  }, 550);
});
document.addEventListener('pointerdown', hideTip, true);
document.addEventListener('wheel', hideTip, { passive: true, capture: true });
document.addEventListener('keydown', hideTip, true);

// ---------------------------------------------------------------------------
// Busy veil with progress
// ---------------------------------------------------------------------------
export function busy(text, { cancel = null } = {}) {
  const label = h('div', text);
  const bar = h('div');
  const card = h('div.card', label, h('div.progress', bar));
  if (cancel) {
    const b = h('button.btn.small', { style: { alignSelf: 'flex-end' } }, 'Cancel');
    b.addEventListener('click', cancel);
    card.append(b);
  }
  const el = h('div.busy', card);
  document.body.append(el);
  return {
    progress(p) { bar.style.width = `${Math.round(Math.max(0, Math.min(1, p)) * 100)}%`; },
    text(t) { label.textContent = t; },
    close() { el.remove(); },
  };
}
