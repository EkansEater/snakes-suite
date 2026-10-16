// Pop-up menus, right-click menus and the menu bar.
//
// An item: { label, icon, keys, run, checked, disabled, submenu: items | () => items,
//            type: 'separator' | 'header', custom: Node, danger }
import { h, svg, clamp } from './dom.js';
import { icon } from './icons.js';
import { formatKeys } from './keys.js';
import { isPhone, lastWasTouch } from './phone.js';

const open = []; // stack of open menus (submenus on top)
const isField = (t) => t instanceof Element && !!t.closest('input, textarea, select, [contenteditable="true"]');
let onAllClosed = null;

export function closeMenus() {
  while (open.length) open.pop().close(true);
  if (onAllClosed) {
    const f = onAllClosed;
    onAllClosed = null;
    f();
  }
}

function resolve(items) {
  const list = typeof items === 'function' ? items() : items;
  // Drop leading, trailing and doubled separators left by conditional items.
  const out = [];
  for (const it of (list || []).filter(Boolean)) {
    if (it.type === 'separator' && (!out.length || out[out.length - 1].type === 'separator')) continue;
    out.push(it);
  }
  while (out.length && out[out.length - 1].type === 'separator') out.pop();
  return out;
}

class Menu {
  constructor(items, parent) {
    this.items = resolve(items);
    this.parent = parent;
    this.active = -1;
    this.sub = null;
    this.rows = [];
    this.el = h('div.menu', { tabindex: -1, role: 'menu' });
    this.el.addEventListener('contextmenu', (e) => e.preventDefault());
    // Keep focus (and the document's selection) where it was, except for fields inside the menu.
    this.el.addEventListener('mousedown', (e) => { if (!isField(e.target)) e.preventDefault(); });
    this.items.forEach((it, i) => this.el.append(this.row(it, i)));
    if (!this.items.length) this.el.append(h('div.menu-head', 'Nothing here'));
    this.el.addEventListener('keydown', (e) => this.key(e));
  }

  row(it, i) {
    if (it.type === 'separator') { this.rows.push(null); return h('div.menu-sep'); }
    if (it.type === 'header') { this.rows.push(null); return h('div.menu-head', it.label); }
    if (it.custom) { this.rows.push(null); return h('div.menu-custom', it.custom); }
    const disabled = typeof it.disabled === 'function' ? it.disabled() : it.disabled;
    const checked = typeof it.checked === 'function' ? it.checked() : it.checked;
    const ic = h('span.mi-icon');
    if (checked) ic.innerHTML = icon('check', 15);
    else if (it.icon) ic.innerHTML = icon(it.icon, 15);
    else if (it.swatch) ic.append(h('span', { style: { width: '13px', height: '13px', borderRadius: '3px', background: it.swatch, border: '1px solid rgba(128,128,128,.4)' } }));
    const row = h(`div.menu-item${disabled ? '.disabled' : ''}`, { role: 'menuitem', title: it.tip || '' },
      ic,
      h('span.mi-label', { style: it.labelStyle || null }, it.label),
      it.keys ? h('span.mi-keys', formatKeys(it.keys)) : null,
      it.submenu ? svg(icon('chevronRight', 12, 'class="mi-sub"')) : null);
    if (it.danger) row.style.color = 'var(--error-soft)';
    row.addEventListener('mouseenter', () => {
      if (lastWasTouch()) return; // a tap, not a hover: the click decides
      this.setActive(i);
      clearTimeout(this.subTimer);
      if (it.submenu) this.subTimer = setTimeout(() => this.openSub(i), 140);
      else this.subTimer = setTimeout(() => this.closeSub(), 200);
    });
    row.addEventListener('click', (e) => {
      e.stopPropagation();
      if (it.submenu) { this.openSub(i); return; }
      this.choose(it);
    });
    this.rows.push(row);
    return row;
  }

  choose(it) {
    closeMenus();
    if (it.run) setTimeout(() => it.run(), 0);
  }

  setActive(i) {
    if (this.active >= 0 && this.rows[this.active]) this.rows[this.active].classList.remove('active');
    this.active = i;
    if (i >= 0 && this.rows[i]) {
      this.rows[i].classList.add('active');
      this.rows[i].scrollIntoView({ block: 'nearest' });
    }
  }

  move(dir) {
    const n = this.rows.length;
    for (let step = 1; step <= n; step++) {
      const i = (this.active + dir * step + n * 4) % n;
      if (this.rows[i] && !this.rows[i].classList.contains('disabled')) { this.setActive(i); return; }
    }
  }

  openSub(i) {
    const it = this.items[i];
    if (!it || !it.submenu) return;
    if (this.sub && this.sub.index === i) return;
    this.closeSub();
    const r = this.rows[i].getBoundingClientRect();
    this.sub = new Menu(it.submenu, this);
    this.sub.index = i;
    if (isPhone()) {
      // No room beside it: the submenu takes the menu's place, with a way back.
      const box = this.el.getBoundingClientRect();
      const back = h('div.menu-item.menu-back', { role: 'menuitem' }, h('span.mi-icon', { html: icon('chevronLeft', 15) }), h('span.mi-label', it.label));
      back.addEventListener('click', (e) => { e.stopPropagation(); this.closeSub(); this.el.focus(); });
      this.sub.el.prepend(back);
      this.sub.el.style.minWidth = `${box.width}px`;
      this.sub.show(box.left, box.top);
      return;
    }
    this.sub.show(r.right - 2, r.top - 5, { flipX: r.left + 2 });
  }

  closeSub() {
    if (this.sub) {
      this.sub.close();
      this.sub = null;
    }
  }

  key(e) {
    e.stopPropagation();
    if (isField(e.target) && e.key !== 'Escape') return; // typing in a field of a custom menu
    const it = this.items[this.active];
    switch (e.key) {
      case 'ArrowDown': this.move(1); break;
      case 'ArrowUp': this.move(-1); break;
      case 'Home': this.setActive(-1); this.move(1); break;
      case 'End': this.setActive(this.rows.length); this.move(-1); break;
      case 'ArrowRight':
        if (it && it.submenu) { this.openSub(this.active); this.sub.move(1); this.sub.el.focus(); }
        else if (this.bar) this.bar.step(1);
        break;
      case 'ArrowLeft':
        if (this.parent) { this.parent.closeSub(); this.parent.el.focus(); }
        else if (this.bar) this.bar.step(-1);
        break;
      case 'Enter': case ' ':
        if (it && it.submenu) { this.openSub(this.active); this.sub.move(1); this.sub.el.focus(); }
        else if (it && this.rows[this.active]) this.choose(it);
        break;
      case 'Escape':
        if (this.parent) { this.parent.closeSub(); this.parent.el.focus(); } else closeMenus();
        break;
      case 'Tab': closeMenus(); break;
      default:
        if (e.key.length === 1) {
          const ch = e.key.toLowerCase();
          const start = this.active;
          for (let s = 1; s <= this.items.length; s++) {
            const j = (start + s) % this.items.length;
            const lab = this.items[j] && this.items[j].label;
            if (this.rows[j] && typeof lab === 'string' && lab.toLowerCase().startsWith(ch)) { this.setActive(j); break; }
          }
        }
    }
    e.preventDefault();
  }

  show(x, y, opts = {}) {
    document.body.append(this.el);
    open.push(this);
    const w = this.el.offsetWidth;
    const hgt = this.el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = x;
    let top = y;
    if (left + w > vw - 4) left = opts.flipX !== undefined ? opts.flipX - w : vw - w - 4;
    if (top + hgt > vh - 4) top = opts.above !== undefined && opts.above - hgt > 4 ? opts.above - hgt : vh - hgt - 4;
    this.el.style.left = `${clamp(left, 4, Math.max(4, vw - w - 4))}px`;
    this.el.style.top = `${clamp(top, 4, Math.max(4, vh - hgt - 4))}px`;
    if (!this.parent) this.el.focus({ preventScroll: true });
    return this;
  }

  close(silent) {
    this.closeSub();
    this.el.remove();
    const i = open.indexOf(this);
    if (i >= 0) open.splice(i, 1);
    if (!silent && this.onClose) this.onClose();
  }
}

/** Show a menu at a point (or under an element). Returns the menu. */
export function showMenu(items, { x = 0, y = 0, anchor = null, onClose = null, focusFirst = false } = {}) {
  closeMenus();
  const m = new Menu(items);
  let opts = {};
  if (anchor) {
    const r = anchor.getBoundingClientRect();
    x = r.left;
    y = r.bottom + 2;
    opts = { above: r.top - 2 };
  }
  m.show(x, y, opts);
  if (focusFirst) m.move(1);
  onAllClosed = onClose;
  return m;
}

/** A pop-up holding any content (a colour picker, a table grid), closed like a menu. */
export function popover(content, { anchor = null, x = 0, y = 0, onClose = null } = {}) {
  return showMenu([{ custom: content }], { anchor, x, y, onClose });
}

/**
 * Right-click menus for an element: build(ev) returns the items for where the
 * click landed (or null to let the event through). Also the Menu key and Shift+F10.
 */
export function contextMenu(el, build) {
  el.addEventListener('contextmenu', (e) => {
    const items = build(e);
    if (!items) return;
    e.preventDefault();
    e.stopPropagation();
    showMenu(items, { x: e.clientX, y: e.clientY });
  });
}

// Close menus when clicking elsewhere, scrolling the page, or losing the window.
window.addEventListener('pointerdown', (e) => {
  if (!open.length) return;
  if (open.some((m) => m.el.contains(e.target))) return;
  if (e.target.closest && e.target.closest('.menubar')) return;
  closeMenus();
}, true);
window.addEventListener('blur', () => closeMenus());
// (Only a change of width: on phones the height changes when the keyboard comes and goes.)
let lastWidth = window.innerWidth;
window.addEventListener('resize', () => {
  if (window.innerWidth !== lastWidth) closeMenus();
  lastWidth = window.innerWidth;
});
window.addEventListener('wheel', (e) => {
  if (open.length && !open.some((m) => m.el.contains(e.target))) closeMenus();
}, { passive: true, capture: true });

/**
 * The menu bar along the title bar. menus: [{ label: '&File', items }]. The
 * letter after & opens it with Alt.
 */
export function menubar(menus) {
  const bar = h('div.menubar', { role: 'menubar' });
  const buttons = [];
  let current = -1;
  let altArmed = false;

  const openAt = (i, focusFirst) => {
    const btn = buttons[i];
    if (!btn) return;
    buttons.forEach((b) => b.classList.remove('open'));
    btn.classList.add('open');
    current = i;
    const m = showMenu(menus[i].items, { anchor: btn, focusFirst, onClose: () => { btn.classList.remove('open'); current = -1; } });
    m.bar = { step: (d) => openAt((i + d + buttons.length) % buttons.length, true) };
  };

  // On phones (kit.css) the menus fold into this one button.
  const all = h('button.menu-all', { 'aria-label': 'Menu', html: icon('menu', 17) });
  all.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    if (all.classList.contains('open')) { closeMenus(); return; }
    all.classList.add('open');
    showMenu(menus.map((m) => ({ label: m.label.replace('&', ''), submenu: m.items })), { anchor: all, onClose: () => all.classList.remove('open') });
  });
  bar.append(all);

  menus.forEach((m, i) => {
    const amp = m.label.indexOf('&');
    const plain = m.label.replace('&', '');
    const key = amp >= 0 ? m.label[amp + 1].toLowerCase() : plain[0].toLowerCase();
    const label = amp >= 0 ? [plain.slice(0, amp), h('u', plain[amp]), plain.slice(amp + 1)] : [plain];
    const btn = h('button', { 'data-key': key }, ...label);
    btn.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      if (current === i) closeMenus();
      else openAt(i, false);
    });
    btn.addEventListener('mouseenter', () => { if (current >= 0 && current !== i) openAt(i, false); });
    buttons.push(btn);
    bar.append(btn);
  });

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Alt' && !e.ctrlKey && !e.shiftKey) { altArmed = true; bar.classList.add('alt'); return; }
    altArmed = false;
    if (e.altKey && !e.ctrlKey && !e.metaKey && e.key.length === 1) {
      const btn = buttons.find((b) => b.dataset.key === e.key.toLowerCase());
      if (btn) {
        e.preventDefault();
        openAt(buttons.indexOf(btn), true);
      }
    }
  }, true);
  window.addEventListener('keyup', (e) => {
    if (e.key === 'Alt') {
      bar.classList.remove('alt');
      if (altArmed && !open.length) openAt(0, true);
      altArmed = false;
    }
  });
  // Alt held for Alt+click or Alt+wheel is not a request for the menu.
  const disarm = () => { altArmed = false; bar.classList.remove('alt'); };
  window.addEventListener('pointerdown', disarm, true);
  window.addEventListener('wheel', disarm, { passive: true, capture: true });
  window.addEventListener('blur', disarm);
  return bar;
}
