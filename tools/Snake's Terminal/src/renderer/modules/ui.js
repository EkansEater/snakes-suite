// Menus, dialogs and short messages, drawn in the suite's style.
import { el, icon } from './util.js';

let openMenu = null;

export function closeMenu() {
  openMenu?.remove();
  openMenu = null;
}

/**
 * items: [{label, icon, key, run, disabled, checked, danger}, {separator: true}, {header: 'text'}]
 * at: {x, y} or an element to open under.
 */
export function showMenu(items, at, { onClose } = {}) {
  closeMenu();
  const menu = el('div.menu', { role: 'menu', tabindex: '-1' });
  const rows = [];
  for (const it of items) {
    if (!it) continue;
    if (it.separator) { menu.append(el('div.menu-sep')); continue; }
    if (it.header) { menu.append(el('div.menu-header', { text: it.header })); continue; }
    const row = el(`div.menu-item${it.disabled ? '.disabled' : ''}${it.danger ? '.danger' : ''}`, { role: 'menuitem' },
      el('span.menu-icon', {}, it.checked ? icon('check') : it.icon ? icon(it.icon) : ''),
      el('span.menu-label', { text: it.label }),
      it.detail ? el('span.menu-detail', { text: it.detail }) : '',
      it.key ? el('span.menu-key', { text: it.key }) : '');
    if (it.color) row.querySelector('.menu-icon').append(el('span.dot', { style: { background: it.color } }));
    if (!it.disabled) {
      row.addEventListener('click', () => { closeMenu(); onClose?.(); it.run?.(); });
      row.addEventListener('mousemove', () => select(rows.indexOf(row)));
      rows.push(row);
    }
    menu.append(row);
  }
  let current = -1;
  const select = (i) => {
    rows.forEach((r, j) => r.classList.toggle('active', j === i));
    current = i;
  };
  menu.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { select((current + 1) % rows.length); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { select((current - 1 + rows.length) % rows.length); e.preventDefault(); }
    else if (e.key === 'Enter' && current >= 0) { rows[current].click(); e.preventDefault(); }
    else if (e.key === 'Escape') { closeMenu(); onClose?.(); e.preventDefault(); }
    e.stopPropagation();
  });
  document.body.append(menu);
  const r = at instanceof Element ? at.getBoundingClientRect() : null;
  let x = r ? r.left : at.x;
  let y = r ? r.bottom + 4 : at.y;
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  if (x + w > innerWidth - 6) x = Math.max(6, (r ? r.right : innerWidth) - w);
  if (y + h > innerHeight - 6) y = Math.max(6, (r ? r.top - 4 : innerHeight) - h);
  Object.assign(menu.style, { left: `${x}px`, top: `${y}px` });
  openMenu = menu;
  menu.focus();
  setTimeout(() => {
    const away = (e) => {
      if (!menu.contains(e.target)) { closeMenu(); onClose?.(); document.removeEventListener('mousedown', away, true); }
    };
    document.addEventListener('mousedown', away, true);
  });
  return menu;
}

// ---------------------------------------------------------------------------
// Toasts
// ---------------------------------------------------------------------------
let toasts;
export function toast(message, { type = 'info', actions = [], timeout } = {}) {
  if (!toasts) { toasts = el('div.toasts'); document.body.append(toasts); }
  const t = el(`div.toast.${type}`, {}, el('div.toast-msg', { text: message }));
  const close = () => { t.classList.add('closing'); setTimeout(() => t.remove(), 160); };
  if (actions.length) {
    t.append(el('div.toast-actions', {}, actions.map((a) => el(`button.btn${a.primary ? '.primary' : ''}`, { on: { click: () => { close(); a.run?.(); } } }, a.label))));
  }
  t.append(el('button.toast-close', { title: 'Close', on: { click: close } }, icon('close')));
  toasts.append(t);
  const ms = timeout ?? (actions.length ? 0 : type === 'error' ? 9000 : 4500);
  if (ms) setTimeout(close, ms);
  return { close };
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------
export const openDialogs = [];

/** A modal dialog. buttons: [{label, primary, danger, run (return false to keep it open)}] */
export function modal({ title, body, buttons = [], wide = false, onClose }) {
  const back = el('div.modal-back');
  const box = el(`div.modal${wide ? '.wide' : ''}`, { role: 'dialog', 'aria-label': title });
  const close = () => { back.remove(); openDialogs.splice(openDialogs.indexOf(api), 1); onClose?.(); };
  const api = { close, box };
  box.append(el('div.modal-head', {}, el('div.modal-title', { text: title }), el('button.icon-btn', { title: 'Close (Esc)', on: { click: close } }, icon('close'))));
  box.append(el('div.modal-body', {}, body));
  if (buttons.length) {
    box.append(el('div.modal-foot', {}, buttons.map((b) => el(`button.btn${b.primary ? '.primary' : ''}${b.danger ? '.danger' : ''}`, {
      on: { click: async () => { if ((await b.run?.()) !== false) close(); } },
    }, b.label))));
  }
  back.append(box);
  back.addEventListener('mousedown', (e) => { if (e.target === back) close(); });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'Enter' && e.target.tagName === 'INPUT' && e.target.type !== 'checkbox') {
      const primary = buttons.find((b) => b.primary);
      if (primary) { e.preventDefault(); box.querySelector('.modal-foot .btn.primary')?.click(); }
    }
    e.stopPropagation();
  });
  document.body.append(back);
  openDialogs.push(api);
  setTimeout(() => (box.querySelector('input:not([type=checkbox]), select, textarea, .btn.primary') || box).focus());
  return api;
}

export function prompt({ title, message, value = '', placeholder = '', ok = 'OK' }) {
  return new Promise((resolve) => {
    const input = el('input.input', { value, placeholder, spellcheck: 'false' });
    let result = null;
    modal({
      title,
      body: el('div.stack', {}, message ? el('p.hint', { text: message }) : '', input),
      buttons: [{ label: 'Cancel' }, { label: ok, primary: true, run: () => { result = input.value.trim(); } }],
      onClose: () => resolve(result),
    });
    setTimeout(() => input.select());
  });
}

export function confirmDialog({ title, message, ok = 'OK', danger = false }) {
  return new Promise((resolve) => {
    let yes = false;
    modal({
      title,
      body: el('p', { text: message }),
      buttons: [{ label: 'Cancel' }, { label: ok, primary: !danger, danger, run: () => { yes = true; } }],
      onClose: () => resolve(yes),
    });
  });
}

/** A labelled form row. */
export function field(label, control, hint) {
  return el('label.field', {}, el('span.field-label', { text: label }), control, hint ? el('span.field-hint', { text: hint }) : '');
}
