// The frame every Studio app shares: title bar with menus and window buttons,
// ribbon, status bar with a zoom control, splitters, drag and drop, theme,
// the start screen, and the "save your changes?" guard on close.
import { h, svg, rafOnce, isMac, drag, clamp, fmtTime } from './dom.js';
import { icon } from './icons.js';
import { menubar, showMenu, contextMenu, closeMenus } from './menu.js';
import * as commands from './commands.js';
import { formatKeys } from './keys.js';
import { host, inElectron } from './host.js';
import { modal, saveChangesBox, toast } from './dialogs.js';
import { ZOOM_STEPS } from './zoom.js';

const refreshers = new Set();
const runRefresh = rafOnce(() => { for (const f of refreshers) f(); });
/** Re-read every button's on/off and enabled state (after a selection change). */
export const refresh = () => runRefresh();

// ---------------------------------------------------------------------------
// Buttons and fields for ribbons and toolbars
// ---------------------------------------------------------------------------
/**
 * tb('cmd.id') or tb({ icon, label, showLabel, tip, keys, run, on, disabled, big, menu, split })
 * `menu` (items or a function) gives the button a drop-down; with `split` the
 * main part runs and only the arrow opens the menu.
 */
export function tb(spec, extra = {}) {
  if (typeof spec === 'string') {
    const cmd = commands.get(spec);
    if (!cmd) throw new Error(`No command ${spec}`);
    spec = {
      icon: cmd.icon, label: cmd.label, tip: cmd.tip || cmd.label, keys: cmd.keys[0],
      run: () => commands.run(spec), on: cmd.checked, disabled: cmd.when ? () => !cmd.when() : null, ...extra,
    };
  } else spec = { ...spec, ...extra };
  const showLabel = spec.big || spec.showLabel;
  const content = [];
  if (spec.icon) content.push(svg(icon(spec.icon, spec.big ? 22 : 16)));
  if (spec.swatch) content.push(h('span', { style: { width: '14px', height: '14px', borderRadius: '3px', background: spec.swatch, border: '1px solid rgba(128,128,128,.4)' } }));
  if (showLabel && spec.label) content.push(h('span', spec.label));
  if (spec.menu && !spec.split) content.push(svg(icon('chevronDown', 10, 'class="caret"')));
  const btn = h(`button.tb${spec.big ? '.big' : ''}${spec.cls ? `.${spec.cls}` : ''}`, {
    'data-tip': spec.tip || spec.label || '', 'data-keys': spec.keys || '', 'data-detail': spec.detail || '',
    'aria-label': spec.label || spec.tip || '',
  }, ...content);
  if (spec.width) btn.style.minWidth = `${spec.width}px`;
  const openMenu = (anchor) => showMenu(spec.menu, { anchor });
  btn.addEventListener('mousedown', (e) => e.preventDefault()); // keep the document's selection
  btn.addEventListener('click', () => {
    if (spec.menu && !spec.split) openMenu(btn);
    else if (spec.run) spec.run(btn);
  });
  let out = btn;
  if (spec.split && spec.menu) {
    const arrow = h('button.tb', { 'data-tip': `${spec.tip || spec.label} options` }, svg(icon('chevronDown', 10, 'class="caret"')));
    arrow.addEventListener('mousedown', (e) => e.preventDefault());
    arrow.addEventListener('click', () => openMenu(out));
    out = h('span.tb-split', btn, arrow);
  }
  if (spec.on || spec.disabled || spec.update) {
    const upd = () => {
      if (!btn.isConnected) return;
      if (spec.on) btn.classList.toggle('on', !!spec.on());
      if (spec.disabled) btn.disabled = !!spec.disabled();
      if (spec.update) spec.update(btn);
    };
    refreshers.add(upd);
    queueMicrotask(upd);
  }
  out.button = btn;
  return out;
}

export const sep = () => h('div.tb-sep');
export const label = (text) => h('span.tb-label', text);

/** A <select>. options: [value | { value, label }]. */
export function select({ options, value, onChange, width = null, tip = '', update = null }) {
  const el = h('select.select', { 'data-tip': tip, style: width ? { width: `${width}px` } : null });
  const fill = (opts) => {
    el.replaceChildren(...opts.map((o) => (typeof o === 'object'
      ? h('option', { value: o.value, disabled: o.disabled }, o.label)
      : h('option', { value: o }, String(o)))));
  };
  fill(typeof options === 'function' ? options() : options);
  if (value !== undefined) el.value = value;
  el.addEventListener('change', () => onChange(el.value));
  el.setOptions = fill;
  if (update) {
    const upd = () => { if (el.isConnected && document.activeElement !== el) update(el); };
    refreshers.add(upd);
  }
  return el;
}

/**
 * An editable box with a drop-down list (font names, sizes). onCommit(text)
 * runs on Enter, on blur and when a list item is chosen.
 */
export function combo({ values, value = '', onCommit, width = 120, tip = '', itemStyle = null, update = null, numeric = false, min, max }) {
  const input = h(`input.input${numeric ? '.num' : ''}`, {
    value, spellcheck: false, style: { width: `${width - 18}px`, borderTopRightRadius: '0', borderBottomRightRadius: '0' },
    'data-tip': tip, min, max,
  });
  const arrow = h('button.tb', { style: { height: '28px', minWidth: '18px', padding: '0 2px', border: '1px solid var(--border2)', borderLeft: '0', borderRadius: '0 5px 5px 0', background: 'var(--input)' } },
    svg(icon('chevronDown', 10)));
  const wrap = h('span.row', { style: { gap: '0' } }, input, arrow);
  let committed = value;
  const commit = () => {
    if (input.value !== committed) {
      committed = input.value;
      onCommit(input.value);
    }
  };
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); committed = null; commit(); input.blur(); }
    if (e.key === 'Escape') { input.value = committed || ''; input.blur(); }
  });
  input.addEventListener('change', commit);
  input.addEventListener('focus', () => input.select());
  arrow.addEventListener('mousedown', (e) => e.preventDefault());
  arrow.addEventListener('click', () => {
    const list = typeof values === 'function' ? values() : values;
    showMenu(list.map((v) => ({
      label: String(v), labelStyle: itemStyle ? itemStyle(v) : null, checked: String(v) === input.value,
      run: () => { input.value = String(v); committed = null; commit(); },
    })), { anchor: wrap });
  });
  wrap.set = (v) => { if (document.activeElement !== input) { input.value = v; committed = v; } };
  wrap.input = input;
  if (update) refreshers.add(() => { if (wrap.isConnected) update(wrap); });
  return wrap;
}

// ---------------------------------------------------------------------------
// Theme and UI scale
// ---------------------------------------------------------------------------
const mq = window.matchMedia('(prefers-color-scheme: light)');
export function applyTheme(choice) {
  const t = choice === 'system' || !choice ? (mq.matches ? 'light' : 'dark') : choice;
  document.documentElement.dataset.theme = t;
  window.dispatchEvent(new CustomEvent('snake-theme', { detail: t }));
  return t;
}
mq.addEventListener('change', () => applyTheme(host.settings.get('theme', 'dark')));

// ---------------------------------------------------------------------------
// The shell
// ---------------------------------------------------------------------------
export async function createShell({ id, name, menus = [], quick = [], about = '' }) {
  const info = await host.init().catch(() => ({ app: id, files: [], recent: [] }));
  applyTheme(host.settings.get('theme', 'dark'));
  document.title = name;

  const root = h('div.app');
  const mac = inElectron && info.platform === 'darwin';
  const titleEl = h('div.title', h('b', name));
  const winCtl = h('div.win-controls');
  if (inElectron && !mac) {
    const mk = (ic, fn, cls = '') => {
      const b = h(`button${cls}`, { html: icon(ic, 14), tabindex: -1 });
      b.addEventListener('click', fn);
      return b;
    };
    const maxBtn = mk('square', () => host.win.toggleMaximize());
    winCtl.append(mk('minus', () => host.win.minimize()), maxBtn, mk('x', () => host.win.close(), '.close'));
    host.win.onMaximized((m) => { maxBtn.innerHTML = icon(m ? 'duplicate' : 'square', 14); });
  }
  // The app registers its commands after the shell exists, so the quick buttons come a moment later.
  const quickBar = h('div.quick');
  setTimeout(() => quickBar.append(...quick.filter((q) => commands.get(q)).map((q) => tb(q))), 0);
  const bar = menubar(menus);
  const titlebar = h(`div.titlebar${mac ? '.mac' : ''}`,
    h('img.app-icon', { src: `../icons/${id}.svg`, alt: '' }), bar, quickBar, h('div.spacer'), titleEl, winCtl);
  titlebar.addEventListener('dblclick', (e) => {
    if (e.target === titlebar || e.target.classList.contains('spacer')) host.win.toggleMaximize();
  });
  // The title sits in the middle of the window, unless that would cover the menus:
  // then it starts after them and shortens with an ellipsis.
  const placeTitle = () => {
    Object.assign(titleEl.style, { left: '', transform: '', maxWidth: '' });
    const box = titlebar.getBoundingClientRect();
    const menusEnd = Math.max(bar.getBoundingClientRect().right, quickBar.getBoundingClientRect().right) - box.left;
    const ctlStart = (winCtl.childElementCount ? winCtl.getBoundingClientRect().left : box.right) - box.left;
    if (box.width / 2 - titleEl.scrollWidth / 2 < menusEnd + 12) {
      Object.assign(titleEl.style, { left: `${menusEnd + 12}px`, transform: 'none', maxWidth: `${Math.max(0, ctlStart - menusEnd - 24)}px` });
    }
  };
  new ResizeObserver(placeTitle).observe(titlebar);
  new ResizeObserver(placeTitle).observe(quickBar);
  const ribbonHost = h('div.ribbon.hidden');
  const main = h('div.grow', { style: { display: 'flex', position: 'relative', minHeight: '0' } });
  const statusLeft = h('div.row', { style: { gap: '0', height: '100%' } });
  const statusRight = h('div.row', { style: { gap: '0', height: '100%' } });
  const status = h('div.statusbar', statusLeft, h('div.spacer'), statusRight);
  root.append(titlebar, ribbonHost, main, status);
  document.body.append(root);
  commands.installKeys();

  const shell = {
    id, name, info, root, titlebar, main, status, statusLeft, statusRight, ribbonHost, refresh,
    settings: host.settings,
    setTitle(doc, dirty = false) {
      titleEl.replaceChildren(dirty ? '● ' : '', h('b', doc || 'Untitled'), ` — ${name}`);
      placeTitle();
      host.win.setTitle(`${dirty ? '• ' : ''}${doc || 'Untitled'} — ${name}`);
    },
    setRibbon: (tabs) => buildRibbon(shell, tabs),
    zoomBox: (o) => zoomBox(o),
    showStatus: (on) => status.classList.toggle('hidden', !on),
  };

  // ---- commands every app has ----
  commands.register(
    { id: 'app.palette', label: 'Show All Commands', category: 'Help', keys: ['Ctrl+Shift+P', 'F1'], icon: 'search', run: () => commands.openPalette() },
    { id: 'app.shortcuts', label: 'Keyboard Shortcuts', category: 'Help', keys: 'Ctrl+/', icon: 'info', run: () => showShortcuts() },
    { id: 'app.about', label: `About ${name}`, category: 'Help', icon: 'info', run: () => showAbout(name, info, about) },
    { id: 'view.fullscreen', label: 'Full Screen', category: 'View', keys: 'F11', icon: 'fullscreen', run: () => host.win.toggleFullScreen() },
    { id: 'view.themeDark', label: 'Dark Theme', category: 'View', icon: 'moon', checked: () => host.settings.get('theme', 'dark') === 'dark', run: () => setTheme('dark') },
    { id: 'view.themeLight', label: 'Light Theme', category: 'View', icon: 'sun', checked: () => host.settings.get('theme', 'dark') === 'light', run: () => setTheme('light') },
    { id: 'view.themeSystem', label: 'Theme Follows the System', category: 'View', checked: () => host.settings.get('theme', 'dark') === 'system', run: () => setTheme('system') },
    { id: 'view.uiBigger', label: 'Make the Interface Bigger', category: 'View', keys: 'Ctrl+Alt+Shift+=', run: () => uiScale(0.1) },
    { id: 'view.uiSmaller', label: 'Make the Interface Smaller', category: 'View', keys: 'Ctrl+Alt+Shift+-', run: () => uiScale(-0.1) },
    { id: 'view.uiReset', label: 'Reset the Interface Size', category: 'View', run: () => uiScale(0) },
    { id: 'view.ribbon', label: 'Collapse the Ribbon', category: 'View', keys: 'Ctrl+F1', checked: () => ribbonHost.classList.contains('collapsed'),
      run: () => { ribbonHost.classList.toggle('collapsed'); host.settings.set('ribbonCollapsed', ribbonHost.classList.contains('collapsed')); } },
    { id: 'app.newWindow', label: 'New Window', category: 'File', keys: 'Ctrl+Shift+N', icon: 'new', run: () => host.win.newWindow() },
    { id: 'app.devtools', label: 'Developer Tools', category: 'Help', keys: 'Ctrl+Shift+I', run: () => host.win.toggleDevTools() },
    { id: 'app.close', label: 'Close Window', category: 'File', keys: 'Ctrl+W', run: () => host.win.close() },
  );
  if (host.settings.get('ribbonCollapsed', false)) ribbonHost.classList.add('collapsed');
  const scale = host.settings.get('uiScale', 1);
  if (scale !== 1 && window.snakeHost && window.snakeHost.win.setZoom) window.snakeHost.win.setZoom(scale);

  function setTheme(t) {
    host.settings.set('theme', t);
    applyTheme(t);
    refresh();
  }
  function uiScale(delta) {
    const cur = host.settings.get('uiScale', 1);
    const next = delta === 0 ? 1 : clamp(Math.round((cur + delta) * 10) / 10, 0.7, 2);
    host.settings.set('uiScale', next);
    if (window.snakeHost && window.snakeHost.win.setZoom) window.snakeHost.win.setZoom(next);
    else document.body.style.zoom = String(next);
    toast(`Interface size ${Math.round(next * 100)}%`, { timeout: 1500 });
  }
  return shell;
}

export function showShortcuts() {
  const filter = h('input.input', { placeholder: 'Search shortcuts', spellcheck: false });
  const box = h('div', { style: { maxHeight: '60vh', overflow: 'auto', minWidth: '460px' } }, commands.shortcutTable());
  filter.addEventListener('input', () => box.replaceChildren(commands.shortcutTable(filter.value)));
  modal({ title: 'Keyboard shortcuts', body: h('div.col', filter, box), buttons: [] });
}

function showAbout(name, info, extra) {
  modal({
    title: name,
    body: h('div.col', { style: { maxWidth: '440px' } },
      h('div.row', { style: { gap: '14px' } }, h('img', { src: `../icons/${info.app || 'studio'}.svg`, width: 56, height: 56 }),
        h('div', h('div', { style: { fontSize: '16px', fontWeight: 600 } }, name), h('div.muted', `Version ${info.version || 'web'} · part of Snake's Master Suite`))),
      extra ? h('div', extra) : null,
      h('div.muted', { style: { fontSize: '12px' } }, inElectron
        ? 'Runs sandboxed: pages have no access to your computer except the files you open, drop or save.'
        : 'Running in your browser: files stay on this device and are only read when you open them.')),
    buttons: [{ label: 'Close', value: true, primary: true }],
  });
}

// ---------------------------------------------------------------------------
// Ribbon
// ---------------------------------------------------------------------------
function buildRibbon(shell, tabs) {
  const host_ = shell.ribbonHost;
  host_.classList.remove('hidden');
  const tabBar = h('div.ribbon-tabs');
  const body = h('div.ribbon-body');
  host_.replaceChildren(tabBar, body);
  const key = 'ribbonTab';
  let current = host.settings.get(key, tabs[0].id);
  const buttons = new Map();
  const bodies = new Map();

  const show = (id) => {
    const tab = tabs.find((t) => t.id === id) || tabs[0];
    current = tab.id;
    host.settings.set(key, current);
    for (const [tid, b] of buttons) b.classList.toggle('active', tid === current);
    if (!bodies.has(tab.id)) {
      const groups = (typeof tab.groups === 'function' ? tab.groups() : tab.groups).map((g) => h('div.rgroup',
        h('div.rgroup-body', ...g.items.filter(Boolean)), g.label ? h('div.rgroup-label', g.label) : null));
      bodies.set(tab.id, groups);
    }
    body.replaceChildren(...bodies.get(tab.id));
    if (host_.classList.contains('collapsed') && !host_.peek) host_.classList.add('collapsed');
    refresh();
  };
  for (const t of tabs) {
    const b = h('button', { style: t.contextual ? { color: 'var(--highlight)' } : null }, t.label);
    b.addEventListener('click', () => {
      if (host_.classList.contains('collapsed')) {
        host_.classList.remove('collapsed');
        host_.peek = true;
      }
      show(t.id);
    });
    b.addEventListener('dblclick', () => commands.run('view.ribbon'));
    buttons.set(t.id, b);
    tabBar.append(b);
    if (t.visible) {
      refreshers.add(() => {
        const vis = !!t.visible();
        b.classList.toggle('hidden', !vis);
        if (!vis && current === t.id) show(tabs[0].id);
      });
    }
  }
  // Wheel over the tab row flips through tabs, like Office.
  tabBar.addEventListener('wheel', (e) => {
    const visible = tabs.filter((t) => !buttons.get(t.id).classList.contains('hidden'));
    const i = visible.findIndex((t) => t.id === current);
    const j = clamp(i + (e.deltaY > 0 ? 1 : -1), 0, visible.length - 1);
    if (j !== i) show(visible[j].id);
    e.preventDefault();
  }, { passive: false });
  // A peeked (temporarily opened) collapsed ribbon folds away after a click elsewhere.
  document.addEventListener('pointerdown', (e) => {
    if (host_.peek && !host_.contains(e.target) && !(e.target.closest && e.target.closest('.menu'))) {
      host_.peek = false;
      host_.classList.add('collapsed');
    }
  }, true);
  const style = h('style', '.ribbon.collapsed .ribbon-body { display: none; }');
  document.head.append(style);
  show(tabs.some((t) => t.id === current) ? current : tabs[0].id);
  return { show, get current() { return current; }, rebuild(id) { bodies.delete(id); if (current === id) show(id); } };
}

// ---------------------------------------------------------------------------
// Status bar zoom: - [slider] + 100%
// ---------------------------------------------------------------------------
function zoomBox({ get, set, min = 0.1, max = 5, fit = null }) {
  const lo = Math.log(min);
  const hi = Math.log(max);
  const slider = h('input', { type: 'range', min: 0, max: 1000, 'data-tip': 'Zoom (Ctrl+wheel over the page)' });
  const pct = h('button.pct', { style: { border: 0, background: 'transparent', color: 'inherit' }, 'data-tip': 'Zoom presets' });
  const minus = h('button', { html: icon('minus', 13), 'data-tip': 'Zoom out', 'data-keys': 'Ctrl+-' });
  const plus = h('button', { html: icon('plus', 13), 'data-tip': 'Zoom in', 'data-keys': 'Ctrl+=' });
  const el = h('div.zoombox', minus, slider, plus, pct);
  const show = () => {
    const z = get();
    slider.value = String(Math.round(((Math.log(z) - lo) / (hi - lo)) * 1000));
    pct.textContent = `${Math.round(z * 100)}%`;
  };
  slider.addEventListener('input', () => {
    let z = Math.exp(lo + (Number(slider.value) / 1000) * (hi - lo));
    if (Math.abs(z - 1) < 0.04) z = 1;
    set(Math.round(z * 100) / 100);
  });
  minus.addEventListener('click', () => set(Math.max(min, [...ZOOM_STEPS].reverse().find((s) => s < get() - 1e-6) || min)));
  plus.addEventListener('click', () => set(Math.min(max, ZOOM_STEPS.find((s) => s > get() + 1e-6) || max)));
  pct.addEventListener('click', () => showMenu([
    ...(fit ? fit.map((f) => ({ label: f.label, run: f.run })) : []),
    fit ? { type: 'separator' } : null,
    ...ZOOM_STEPS.filter((s) => s >= min && s <= max).map((s) => ({ label: `${Math.round(s * 100)}%`, checked: Math.abs(get() - s) < 0.005, run: () => set(s) })),
  ], { anchor: pct }));
  el.update = show;
  show();
  return el;
}

// ---------------------------------------------------------------------------
// Splitters: drag to resize a side panel, double-click to hide or restore it
// ---------------------------------------------------------------------------
export function splitter(panel, { side = 'left', min = 140, max = 640, key = null, initial = 260, vertical = false } = {}) {
  const el = h(`div.splitter.${vertical ? 'h' : 'v'}`);
  const prop = vertical ? 'height' : 'width';
  let size = key ? host.settings.get(key, initial) : initial;
  const apply = () => { panel.style[prop] = `${size}px`; panel.style.flex = 'none'; };
  apply();
  el.addEventListener('pointerdown', (e) => {
    const start = size;
    el.classList.add('drag');
    drag(e, (dx, dy) => {
      const d = vertical ? dy : dx;
      size = clamp(start + (side === 'left' || side === 'top' ? d : -d), min, max);
      apply();
      window.dispatchEvent(new Event('resize'));
    }, () => {
      el.classList.remove('drag');
      if (key) host.settings.set(key, size);
    });
  });
  el.addEventListener('dblclick', () => {
    panel.classList.toggle('hidden');
    window.dispatchEvent(new Event('resize'));
  });
  return el;
}

// ---------------------------------------------------------------------------
// Dropping files anywhere on the window
// ---------------------------------------------------------------------------
export function onDropFiles(handler, text = 'Drop to open') {
  let veil = null;
  let depth = 0;
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    depth++;
    if (!veil) {
      veil = h('div.drop-veil', text);
      document.body.append(veil);
    }
  });
  window.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    depth--;
    if (depth <= 0 && veil) { veil.remove(); veil = null; depth = 0; }
  });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    if (veil) { veil.remove(); veil = null; }
    try {
      const files = await host.dropped(e.dataTransfer.files, [...e.dataTransfer.items]);
      if (files.length) handler(files, e);
    } catch (err) {
      toast(String(err.message || err), { type: 'error' });
    }
  });
}

// ---------------------------------------------------------------------------
// Unsaved changes: ask before the window closes
// ---------------------------------------------------------------------------
export function guardClose({ dirty, save, name }) {
  host.onBeforeClose({
    dirty,
    ask: async () => {
      closeMenus();
      if (!dirty()) return true;
      const r = await saveChangesBox(name());
      if (r === 'save') return !!(await save());
      return r === 'discard';
    },
  });
}

// ---------------------------------------------------------------------------
// The start screen of the document apps: new from a template, or a recent file
// ---------------------------------------------------------------------------
export function startScreen({ shell, title, templates, onTemplate, onOpen, onRecent, thumbRatio = 0.77, extra = null }) {
  const recentBox = h('div.recent-list');
  const el = h('div.start',
    h('div.start-side',
      h('h1', h('img', { src: `../icons/${shell.id}.svg`, alt: '' }), shell.name.replace("Snake's ", '')),
      tb({ icon: 'new', label: 'New blank', showLabel: true, run: () => onTemplate(templates[0]) }, { cls: 'start-btn' }),
      tb({ icon: 'open', label: 'Open…', showLabel: true, keys: 'Ctrl+O', run: () => onOpen() }),
      extra),
    h('div.start-main',
      h('h2', title || 'New'),
      h('div.templates', { style: { '--thumb-ratio': thumbRatio } }, ...templates.map((t) => {
        const card = h('div.template', h('div.thumb', t.thumb ? t.thumb() : null), h('span', t.name));
        card.addEventListener('click', () => onTemplate(t));
        return card;
      })),
      h('h2', 'Recent'),
      recentBox));
  for (const b of el.querySelectorAll('.start-side .tb')) Object.assign(b.style, { justifyContent: 'flex-start', height: '36px', padding: '0 12px' });

  const fillRecent = async () => {
    const list = await host.recent().catch(() => []);
    recentBox.replaceChildren();
    if (!list.length) recentBox.append(h('div.empty', { style: { textAlign: 'left', padding: '4px 0' } }, 'Files you open show up here.'));
    for (const r of list) {
      const row = h('div.list-item', { 'data-tip': r.dir || r.name },
        h('span', { html: icon('fileText', 18), style: { color: 'var(--fg2)', display: 'grid' } }),
        h('div.grow', h('div', r.name), r.dir ? h('div.dir', r.dir) : null),
        h('span.muted', { style: { fontSize: '12px' } }, r.time ? new Date(r.time).toLocaleDateString() : ''));
      if (!r.exists) row.style.opacity = '.45';
      row.addEventListener('click', () => onRecent(r));
      contextMenu(row, () => [
        { label: 'Open', icon: 'open', run: () => onRecent(r) },
        { label: 'Remove from list', icon: 'x', run: async () => { await host.forgetRecent(r.key); fillRecent(); } },
        { label: 'Clear the whole list', icon: 'trash', run: async () => { for (const x of list) await host.forgetRecent(x.key); fillRecent(); } },
      ]);
      recentBox.append(row);
    }
  };
  fillRecent();
  shell.main.append(el);
  return {
    el,
    show() { el.classList.remove('hidden'); fillRecent(); },
    hide() { el.classList.add('hidden'); },
    get visible() { return !el.classList.contains('hidden'); },
  };
}

export { commands, formatKeys, fmtTime };
