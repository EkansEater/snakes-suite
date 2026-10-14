// Generic UI widgets: quick input (palette), input box, context menus, notifications.
import { el, icon, bus, fuzzyMatch, highlightPositions, escapeHtml } from './util.js';
import { formatKey } from './commands.js';

const overlayRoot = () => document.getElementById('overlay-root');

// ---------------------------------------------------------------------------
// Quick input
// ---------------------------------------------------------------------------
class QuickInput {
  constructor() {
    this.visible = false;
    this.items = [];
    this.shown = [];
    this.index = 0;
    this.opts = null;
    this.build();
  }

  build() {
    this.input = el('input.qi-input', { type: 'text', spellcheck: 'false', autocomplete: 'off' });
    this.message = el('div.qi-message');
    this.list = el('div.qi-list', { role: 'listbox' });
    this.progress = el('div.qi-progress');
    this.box = el('div.quick-input', {}, el('div.qi-header', {}, this.input), this.progress, this.message, this.list);
    this.backdrop = el('div.qi-backdrop');
    this.backdrop.addEventListener('mousedown', () => this.cancel());
    this.input.addEventListener('input', () => this.onInput());
    this.input.addEventListener('keydown', (e) => this.onKey(e));
    this.input.addEventListener('blur', () => {
      setTimeout(() => {
        if (this.visible && !this.box.contains(document.activeElement) && !this.keepOpen) this.cancel();
      }, 120);
    });
  }

  /**
   * opts: { placeholder, value, items, filter(true), matchOnDescription, matchOnDetail, onChange(value, qi),
   *         onAccept(item, value, qi) -> true keeps open, onFocus(item), onCancel(), selectValue, message, sort(true), busy }
   */
  open(opts) {
    if (this.visible && this.opts?.onCancel) {
      const prev = this.opts.onCancel;
      this.opts = null;
      prev();
    }
    this.opts = { filter: true, sort: true, ...opts };
    this.items = opts.items || [];
    this.input.placeholder = opts.placeholder || '';
    this.input.value = opts.value || '';
    this.message.textContent = opts.message || '';
    this.message.style.display = opts.message ? '' : 'none';
    this.setBusy(!!opts.busy);
    if (!this.visible) {
      overlayRoot().append(this.backdrop, this.box);
      this.visible = true;
      this.previousFocus = document.activeElement;
    }
    this.input.focus();
    if (opts.selectValue) this.input.setSelectionRange(...opts.selectValue);
    else this.input.setSelectionRange(this.input.value.length, this.input.value.length);
    if (opts.onChange) opts.onChange(this.input.value, this);
    this.render();
  }

  setBusy(b) {
    this.progress.classList.toggle('busy', b);
  }

  setItems(items, activeIndex = 0) {
    this.items = items;
    this.index = activeIndex;
    this.render();
  }

  setMessage(msg) {
    this.message.textContent = msg || '';
    this.message.style.display = msg ? '' : 'none';
  }

  setPlaceholder(p) {
    this.input.placeholder = p;
  }

  onInput() {
    this.index = 0;
    if (this.opts?.onChange) this.opts.onChange(this.input.value, this);
    this.render();
  }

  filtered() {
    const q = this.opts.filterValue ? this.opts.filterValue(this.input.value) : this.input.value;
    if (!this.opts.filter || !q.trim()) return this.items.map((item) => ({ item, labelPos: [], descPos: [] }));
    const out = [];
    for (const item of this.items) {
      if (item.separator && !item.label) continue;
      if (item.alwaysShow) { out.push({ item, score: 1e9, labelPos: [], descPos: [] }); continue; }
      const m = fuzzyMatch(q, item.label);
      if (m) { out.push({ item, score: m.score + 20, labelPos: m.positions, descPos: [] }); continue; }
      if (this.opts.matchOnDescription && item.description) {
        const d = fuzzyMatch(q, item.description);
        if (d) out.push({ item, score: d.score, labelPos: [], descPos: d.positions });
      }
    }
    if (this.opts.sort) out.sort((a, b) => b.score - a.score);
    return out.map((x) => ({ ...x, item: x.item.separator ? { ...x.item, separator: undefined } : x.item }));
  }

  render() {
    if (!this.opts) return;
    const rows = this.filtered().filter((r) => !(r.item.separator && !r.item.label));
    this.shown = rows.slice(0, 500);
    if (this.index >= this.shown.length) this.index = Math.max(0, this.shown.length - 1);
    this.list.replaceChildren();
    const q = this.input.value.trim();
    this.shown.forEach((r, i) => {
      const { item } = r;
      const row = el('div.qi-item', { role: 'option' });
      if (item.separator && !q) row.classList.add('has-separator');
      if (i === this.index) row.classList.add('active');
      if (item.iconEl) row.append(item.iconEl.cloneNode(true));
      else if (item.icon) row.append(icon(item.icon, 'qi-icon'));
      else if (this.opts.reserveIcon) row.append(el('span.qi-icon-space'));
      const label = el('span.qi-label');
      if (item.labelHtml) label.innerHTML = item.labelHtml;
      else label.append(highlightPositions(item.label, r.labelPos));
      row.append(label);
      if (item.description) {
        const d = el('span.qi-desc');
        d.append(highlightPositions(item.description, r.descPos));
        row.append(d);
      }
      if (item.detail) row.append(el('div.qi-detail', {}, item.detail));
      const right = el('span.qi-right');
      if (item.separator && !q) right.append(el('span.qi-sep-label', {}, item.separator));
      if (item.keybinding) right.append(el('span.qi-kb', {}, ...formatKey(item.keybinding).split(' ').map((k) => el('kbd', {}, k))));
      for (const b of item.buttons || []) {
        const btn = el('span.qi-btn', { title: b.title }, icon(b.icon));
        btn.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation(); b.run(item, this); });
        right.append(btn);
      }
      row.append(right);
      row.addEventListener('mousedown', (e) => { e.preventDefault(); this.index = i; this.accept(); });
      row.addEventListener('mousemove', () => {
        if (this.index !== i) { this.index = i; this.updateActive(); }
      });
      this.list.append(row);
    });
    if (!this.shown.length && this.opts.emptyMessage !== null) {
      this.list.append(el('div.qi-empty', {}, this.opts.emptyMessage || 'No matching results'));
    }
    this.updateActive();
  }

  updateActive() {
    [...this.list.children].forEach((c, i) => c.classList.toggle('active', i === this.index));
    const active = this.list.children[this.index];
    if (active) active.scrollIntoView({ block: 'nearest' });
    const item = this.shown[this.index]?.item;
    if (item && this.opts?.onFocus) this.opts.onFocus(item, this);
  }

  onKey(e) {
    const n = this.shown.length;
    if (e.key === 'ArrowDown' || (e.ctrlKey && e.key === 'n')) { e.preventDefault(); if (n) { this.index = (this.index + 1) % n; this.updateActive(); } }
    else if (e.key === 'ArrowUp' || (e.ctrlKey && e.key === 'p' && !e.shiftKey && this.opts.ctrlPCycles !== false)) {
      e.preventDefault(); if (n) { this.index = (this.index - 1 + n) % n; this.updateActive(); }
    }
    else if (e.key === 'PageDown') { e.preventDefault(); this.index = Math.min(n - 1, this.index + 10); this.updateActive(); }
    else if (e.key === 'PageUp') { e.preventDefault(); this.index = Math.max(0, this.index - 10); this.updateActive(); }
    else if (e.key === 'Enter') { e.preventDefault(); this.accept(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.cancel(); }
    else if (e.key === 'Tab' && this.opts.onTab) { e.preventDefault(); this.opts.onTab(this.shown[this.index]?.item, this); }
  }

  async accept() {
    const opts = this.opts;
    if (!opts) return;
    const item = this.shown[this.index]?.item;
    const value = this.input.value;
    if (!item && !opts.acceptEmpty) return;
    const keep = await opts.onAccept?.(item, value, this);
    if (!keep && this.opts === opts) this.close(false);
  }

  cancel() {
    const opts = this.opts;
    this.close(true);
    opts?.onCancel?.();
  }

  close(restoreFocus = true) {
    if (!this.visible) return;
    this.visible = false;
    this.opts = null;
    this.backdrop.remove();
    this.box.remove();
    if (restoreFocus && this.previousFocus?.focus && document.contains(this.previousFocus)) this.previousFocus.focus();
    bus.emit('quickinput:closed');
  }
}

export const quickInput = new QuickInput();

/** Promise-based quick pick. Resolves with the chosen item, or undefined. */
export function pick(items, opts = {}) {
  return new Promise((resolve) => {
    let done = false;
    quickInput.open({
      ...opts,
      items,
      onAccept: (item) => { done = true; resolve(item); },
      onCancel: () => { if (!done) resolve(undefined); },
    });
  });
}

/** Promise-based single line input. Resolves with the string or null when cancelled. */
export function inputBox({ prompt, value = '', placeholder = '', validate, selectValue } = {}) {
  return new Promise((resolve) => {
    let done = false;
    quickInput.open({
      placeholder: placeholder || prompt,
      value,
      items: [],
      filter: false,
      emptyMessage: null,
      acceptEmpty: true,
      message: prompt ? `${prompt} (Press 'Enter' to confirm or 'Escape' to cancel)` : '',
      selectValue,
      onChange: (v, qi) => {
        if (!validate) return;
        const err = validate(v);
        qi.setMessage(err ? `⚠ ${err}` : prompt ? `${prompt} (Press 'Enter' to confirm or 'Escape' to cancel)` : '');
        qi.box.classList.toggle('invalid', !!err);
      },
      onAccept: (_item, v, qi) => {
        if (validate && validate(v)) return true;
        qi.box.classList.remove('invalid');
        done = true;
        resolve(v);
      },
      onCancel: () => { quickInput.box.classList.remove('invalid'); if (!done) resolve(null); },
    });
  });
}

// ---------------------------------------------------------------------------
// Context menus (also used by the title bar menus)
// ---------------------------------------------------------------------------
let activeMenus = [];

export function closeMenus() {
  for (const m of activeMenus) m.remove();
  activeMenus = [];
  document.removeEventListener('mousedown', outsideHandler, true);
  window.removeEventListener('keydown', menuKeyHandler, true);
  window.removeEventListener('blur', closeMenus);
  bus.emit('menu:closed');
}

function outsideHandler(e) {
  if (!activeMenus.some((m) => m.contains(e.target)) && !e.target.closest?.('.menubar-item')) closeMenus();
}

function menuKeyHandler(e) {
  const menu = activeMenus[activeMenus.length - 1];
  if (!menu) return;
  const items = [...menu.querySelectorAll('.menu-item:not(.disabled)')];
  let idx = items.indexOf(menu.querySelector('.menu-item.focused'));
  const focus = (i) => {
    items.forEach((x) => x.classList.remove('focused'));
    if (items[i]) { items[i].classList.add('focused'); items[i].scrollIntoView({ block: 'nearest' }); }
  };
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (activeMenus.length > 1) { activeMenus.pop().remove(); } else closeMenus(); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); focus((idx + 1) % items.length); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); focus((idx - 1 + items.length) % items.length); }
  else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); items[idx]?.dispatchEvent(new MouseEvent('mouseup', { bubbles: true })); }
  else if (e.key === 'ArrowRight') {
    if (items[idx]?.classList.contains('has-submenu')) { e.preventDefault(); e.stopPropagation(); items[idx].dispatchEvent(new MouseEvent('mouseenter')); }
    else bus.emit('menu:navigate', 1, e);
  } else if (e.key === 'ArrowLeft') {
    if (activeMenus.length > 1) { e.preventDefault(); e.stopPropagation(); activeMenus.pop().remove(); }
    else bus.emit('menu:navigate', -1, e);
  }
}

/**
 * items: [{ label, key, run, disabled, checked, submenu: items, separator: true }]
 * anchor: {x, y} or {rect, below: true}
 */
export function showMenu(items, anchor, { keepOthers = false, level = 0 } = {}) {
  if (!keepOthers) closeMenus();
  const menu = el('div.context-menu', { role: 'menu' });
  menu.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the editor
  for (const item of items) {
    if (!item || item.hidden) continue;
    if (item.separator) { menu.append(el('div.menu-sep')); continue; }
    const row = el('div.menu-item', { role: 'menuitem' });
    if (item.disabled) row.classList.add('disabled');
    row.append(el('span.menu-check', {}, item.checked ? icon('check') : ''));
    row.append(el('span.menu-label', {}, item.label));
    if (item.submenu) {
      row.classList.add('has-submenu');
      row.append(el('span.menu-key'), icon('chevron-right', 'menu-sub-arrow'));
    } else {
      row.append(el('span.menu-key', {}, item.key ? formatKey(item.key) : ''));
    }
    let subTimer;
    row.addEventListener('mouseenter', () => {
      menu.querySelectorAll('.menu-item').forEach((x) => x.classList.remove('focused'));
      row.classList.add('focused');
      // close deeper submenus
      while (activeMenus.length > level + 1) activeMenus.pop().remove();
      if (item.submenu && !item.disabled) {
        clearTimeout(subTimer);
        subTimer = setTimeout(() => {
          const r = row.getBoundingClientRect();
          showMenu(typeof item.submenu === 'function' ? item.submenu() : item.submenu, { x: r.right - 2, y: r.top - 4, flipX: r.left }, { keepOthers: true, level: level + 1 });
        }, 120);
      }
    });
    row.addEventListener('mouseleave', () => clearTimeout(subTimer));
    row.addEventListener('mouseup', (e) => {
      if (item.disabled || item.submenu) return;
      e.stopPropagation();
      closeMenus();
      setTimeout(() => item.run?.(), 0);
    });
    menu.append(row);
  }
  overlayRoot().append(menu);
  activeMenus.push(menu);
  // position
  const mw = menu.offsetWidth;
  const mh = menu.offsetHeight;
  let x = anchor.x;
  let y = anchor.y;
  if (x + mw > window.innerWidth - 4) x = anchor.flipX != null ? Math.max(4, anchor.flipX - mw + 2) : Math.max(4, window.innerWidth - mw - 4);
  if (y + mh > window.innerHeight - 4) y = Math.max(4, window.innerHeight - mh - 4);
  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  if (activeMenus.length === 1) {
    setTimeout(() => {
      document.addEventListener('mousedown', outsideHandler, true);
      window.addEventListener('keydown', menuKeyHandler, true);
      window.addEventListener('blur', closeMenus);
    }, 0);
  }
  return menu;
}

export function contextMenu(e, items) {
  e.preventDefault();
  e.stopPropagation();
  showMenu(items, { x: e.clientX, y: e.clientY });
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------
const history = [];
let toastContainer;
const TYPE_ICON = { info: 'info', warning: 'warning', error: 'error', success: 'pass' };

export function notify(opts) {
  if (typeof opts === 'string') opts = { message: opts };
  const n = { type: 'info', time: Date.now(), ...opts };
  // strip Electron's IPC wrapper from error messages
  n.message = String(n.message).replace(/Error invoking remote method '[^']+': (Error: )?/g, '');
  if (!toastContainer) {
    toastContainer = el('div.toasts');
    overlayRoot().append(toastContainer);
  }
  const msg = el('div.toast-msg');
  msg.innerHTML = escapeHtml(n.message).replace(/`([^`]+)`/g, '<code>$1</code>');
  const actions = el('div.toast-actions');
  const toast = el(
    `div.toast.${n.type}`,
    {},
    el('div.toast-main', {}, icon(TYPE_ICON[n.type] || 'info', 'toast-icon'), msg, el('span.toast-close', { title: 'Close', onclick: () => close() }, icon('close'))),
  );
  if (n.detail) toast.append(el('div.toast-detail', {}, n.detail));
  if (n.progress) toast.append(el('div.toast-progress'));
  for (const a of n.actions || []) {
    actions.append(el('button.btn' + (a.secondary ? '.secondary' : ''), { onclick: () => { close(); a.run(); } }, a.label));
  }
  if (n.actions?.length) toast.append(actions);
  toastContainer.append(toast);
  if (!n.transient) {
    history.unshift(n);
    if (history.length > 100) history.pop();
    bus.emit('notifications:changed', history);
  }
  let timer;
  const timeout = n.timeout ?? (n.actions?.length || n.progress ? 0 : n.type === 'error' ? 10000 : 5000);
  const close = () => {
    clearTimeout(timer);
    toast.classList.add('closing');
    setTimeout(() => toast.remove(), 150);
  };
  if (timeout) timer = setTimeout(close, timeout);
  toast.addEventListener('mouseenter', () => clearTimeout(timer));
  toast.addEventListener('mouseleave', () => { if (timeout) timer = setTimeout(close, 2500); });
  return {
    close,
    update(message) { msg.textContent = message; },
  };
}

export function notificationHistory() {
  return history;
}

export function clearNotificationHistory() {
  history.length = 0;
  toastContainer?.replaceChildren();
  bus.emit('notifications:changed', history);
}

bus.on('notify', (n) => notify(n));

/** Native confirm dialog. Returns the chosen button index. */
export function confirm(message, { detail, buttons = ['OK', 'Cancel'], type = 'question', defaultId = 0, cancelId } = {}) {
  return window.snake.dialog.message({ message, detail, buttons, type, defaultId, cancelId });
}
