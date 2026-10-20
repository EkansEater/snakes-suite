// Menus, dialogs and short messages, drawn in the suite's style.
import { el, icon } from './util.js';

let openMenu = null; // the outermost open menu; its submenus hang off it as .child

export function closeMenu() {
  for (let m = openMenu; m; m = m.child) m.remove();
  openMenu = null;
}

export const menuIsOpen = () => !!openMenu;

/**
 * items: [{label, icon, key, detail, run, disabled, checked, danger, color, submenu}, {separator: true}, {header: 'text'}]
 *   submenu: items (or a function returning them), opened to the side on hover, Right or Enter.
 * at: {x, y} or an element to open under.
 * opts.onClose: called when the menu goes away without a choice or after one.
 * opts.onEdge(dir): Left/Right pressed in the outermost menu with nothing to open (the menu bar moves on).
 */
export function showMenu(items, at, opts = {}) {
  closeMenu();
  openMenu = buildMenu(items, at, opts, null);
  openMenu.focus();
  setTimeout(() => {
    const mine = openMenu;
    const away = (e) => {
      if (openMenu !== mine) { document.removeEventListener('mousedown', away, true); return; }
      for (let m = openMenu; m; m = m.child) if (m.contains(e.target)) return;
      if (opts.keepOpenOn?.contains(e.target)) return;
      closeMenu(); opts.onClose?.(); document.removeEventListener('mousedown', away, true);
    };
    document.addEventListener('mousedown', away, true);
  });
  return openMenu;
}

function buildMenu(items, at, opts, parent) {
  const menu = el('div.menu', { role: 'menu', tabindex: '-1' });
  const rows = [];
  let current = -1;
  let hoverTimer = null;
  const done = (fn) => { closeMenu(); opts.onClose?.(); fn?.(); };
  const closeChild = () => { for (let m = menu.child; m; m = m.child) m.remove(); menu.child = null; menu.childRow?.classList.remove('open'); menu.childRow = null; };
  const openChild = (row, it, focus) => {
    if (menu.childRow === row) { if (focus) { menu.child.focus(); menu.child.selectFirst(); } return; }
    closeChild();
    const sub = typeof it.submenu === 'function' ? it.submenu() : it.submenu;
    const child = buildMenu(sub, row, opts, menu);
    menu.child = child;
    menu.childRow = row;
    row.classList.add('open');
    if (focus) { child.focus(); child.selectFirst(); }
  };
  const select = (i) => {
    rows.forEach((r, j) => r.classList.toggle('active', j === i));
    current = i;
    rows[i]?.scrollIntoView({ block: 'nearest' });
  };
  menu.selectFirst = () => select(0);

  for (const it of items) {
    if (!it) continue;
    if (it.separator) { menu.append(el('div.menu-sep')); continue; }
    if (it.header) { menu.append(el('div.menu-header', { text: it.header })); continue; }
    const row = el(`div.menu-item${it.disabled ? '.disabled' : ''}${it.danger ? '.danger' : ''}${it.submenu ? '.has-sub' : ''}`, { role: 'menuitem' },
      el('span.menu-icon', {}, it.checked ? icon('check') : it.radio ? el('span.radio') : it.icon ? icon(it.icon) : ''),
      el('span.menu-label', { text: it.label }),
      it.detail ? el('span.menu-detail', { text: it.detail }) : '',
      it.key ? el('span.menu-key', { text: it.key }) : '',
      it.submenu ? el('span.menu-arrow', {}, icon('right')) : '');
    if (it.color) row.querySelector('.menu-icon').append(el('span.dot', { style: { background: it.color } }));
    if (!it.disabled) {
      const i = rows.length;
      rows.push(row);
      row.addEventListener('mouseenter', () => {
        select(i);
        menu.focus({ preventScroll: true });
        clearTimeout(hoverTimer);
        hoverTimer = setTimeout(() => (it.submenu ? openChild(row, it, false) : closeChild()), it.submenu ? 120 : 250);
      });
      row.addEventListener('click', () => (it.submenu ? openChild(row, it, true) : done(it.run)));
      row.activate = (focus) => (it.submenu ? openChild(row, it, focus) : done(it.run));
      row.hasSub = !!it.submenu;
    }
    menu.append(row);
  }

  menu.addEventListener('keydown', (e) => {
    e.stopPropagation();
    const row = rows[current];
    if (e.key === 'ArrowDown') select((current + 1) % rows.length);
    else if (e.key === 'ArrowUp') select((current - 1 + rows.length) % rows.length);
    else if (e.key === 'Home') select(0);
    else if (e.key === 'End') select(rows.length - 1);
    else if ((e.key === 'Enter' || e.key === ' ') && row) row.activate(true);
    else if (e.key === 'ArrowRight') { if (row?.hasSub) row.activate(true); else if (!parent) opts.onEdge?.(1); }
    else if (e.key === 'ArrowLeft') { if (parent) { parent.focus(); parent.closeChildMenu(); } else opts.onEdge?.(-1); }
    else if (e.key === 'Escape') { if (parent) { parent.focus(); parent.closeChildMenu(); } else done(); }
    else if (e.key === 'Tab') done();
    else if (/^\w$/.test(e.key)) {
      // A letter jumps to the next item starting with it.
      const from = current;
      for (let k = 1; k <= rows.length; k++) {
        const j = (from + k) % rows.length;
        if (rows[j].querySelector('.menu-label').textContent.trim().toLowerCase().startsWith(e.key.toLowerCase())) { select(j); break; }
      }
    } else return;
    e.preventDefault();
  });
  menu.closeChildMenu = closeChild;

  document.body.append(menu);
  const r = at instanceof Element ? at.getBoundingClientRect() : null;
  const w = menu.offsetWidth;
  const h = menu.offsetHeight;
  let x;
  let y;
  if (parent) {
    // Beside the row it opens from, on whichever side has room.
    x = r.right + 2;
    y = r.top - 5;
    if (x + w > innerWidth - 6) x = Math.max(6, r.left - w - 2);
    if (y + h > innerHeight - 6) y = Math.max(6, innerHeight - 6 - h);
  } else {
    x = r ? r.left : at.x;
    y = r ? r.bottom + 4 : at.y;
    if (x + w > innerWidth - 6) x = Math.max(6, (r ? r.right : innerWidth) - w);
    if (y + h > innerHeight - 6) y = Math.max(6, (r ? r.top - 4 : innerHeight) - h);
  }
  Object.assign(menu.style, { left: `${x}px`, top: `${y}px` });
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
