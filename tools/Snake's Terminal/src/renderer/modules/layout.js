// Tabs and split panes. A tab holds a tree: a pane (one session) or a split of panes, side by
// side ('row') or stacked ('col'), with draggable dividers.
import { el, icon, bus, uid, platform } from './util.js';
import { Session } from './session.js';
import { settings, profileById } from './settings.js';
import { showMenu, prompt } from './ui.js';
import { keyLabel } from './keys.js';

export const tabs = [];
export let activeTab = null;
let tabsEl;
let bodyEl;
let draggedTab = null;

export const TAB_COLORS = ['', '#3fb950', '#58a6ff', '#d29922', '#ff7b72', '#bc8cff', '#39c5cf', '#e3b341', '#f778ba'];

export function initLayout({ tabsContainer, body }) {
  tabsEl = tabsContainer;
  bodyEl = body;
  bus.on('session:input', (s, data) => {
    const tab = tabOf(s);
    if (tab?.broadcast) for (const o of tab.sessions()) if (o !== s) o.write(data);
  });
  // Name the tabs after what runs in them; asking the system is cheap, every few seconds.
  setInterval(() => activeTab?.active?.refreshProcess(), 2000);
}

class Tab {
  constructor() {
    this.id = uid();
    this.root = null;
    this.active = null;
    this.maximized = null;
    this.userTitle = '';
    this.color = '';
    this.broadcast = false;
    this.body = el('div.tab-body');
    this.label = el('span.tab-title');
    this.badge = el('span.tab-badge');
    this.el = el('div.tab', { draggable: 'true', role: 'tab' },
      el('span.tab-color'), this.label, this.badge,
      el('button.tab-close', { title: `Close (${keyLabel('pane.close')})`, on: { click: (e) => { e.stopPropagation(); closeTab(this); } } }, icon('close')));
    this.el.addEventListener('mousedown', (e) => { if (e.button === 0) activateTab(this); });
    this.el.addEventListener('auxclick', (e) => { if (e.button === 1) closeTab(this); });
    this.el.addEventListener('dblclick', () => renameTab(this));
    this.el.addEventListener('contextmenu', (e) => { e.preventDefault(); tabMenu(this, e); });
    this.el.addEventListener('dragstart', (e) => { draggedTab = this; e.dataTransfer.effectAllowed = 'move'; this.el.classList.add('dragging'); });
    this.el.addEventListener('dragend', () => { draggedTab = null; this.el.classList.remove('dragging'); });
    this.el.addEventListener('dragover', (e) => {
      if (!draggedTab || draggedTab === this) return;
      e.preventDefault();
      const r = this.el.getBoundingClientRect();
      const after = e.clientX > r.left + r.width / 2;
      moveTabTo(draggedTab, tabs.indexOf(this) + (after ? 1 : 0));
    });
  }

  sessions() {
    const out = [];
    const walk = (n) => { if (!n) return; if (n.type === 'pane') out.push(n.session); else n.children.forEach(walk); };
    walk(this.root);
    return out;
  }

  title() {
    return this.userTitle || this.active?.title() || 'Terminal';
  }
}

export const tabOf = (session) => tabs.find((t) => t.sessions().includes(session));
export const activeSession = () => activeTab?.active || null;
export const allSessions = () => tabs.flatMap((t) => t.sessions());

function wire(session) {
  session.on('title', () => updateTitles());
  session.on('focus', (s) => {
    const tab = tabOf(s);
    if (tab) { tab.active = s; markActivePane(tab); updateTitles(); }
  });
  session.on('activity', (s) => {
    const tab = tabOf(s);
    if (tab && tab !== activeTab && !tab.activity) { tab.activity = true; tab.el.classList.add('activity'); }
  });
  session.on('bell', (s) => {
    if (settings.bell === 'none') return;
    const tab = tabOf(s);
    s.el.parentElement?.classList.remove('bell');
    void s.el.parentElement?.offsetWidth;
    s.el.parentElement?.classList.add('bell');
    if (tab && tab !== activeTab) tab.el.classList.add('belled');
    if (settings.bell === 'sound') beep();
    window.snake.win.flash();
  });
  session.on('exit', (s, kind) => { if (kind === 'close') closeSession(s, { ask: false }); });
  return session;
}

let audio;
function beep() {
  try {
    audio ||= new AudioContext();
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.frequency.value = 880;
    g.gain.setValueAtTime(0.08, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.0001, audio.currentTime + 0.15);
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + 0.16);
  } catch {}
}

/** Where a new session should start: the folder of the pane it comes from, if the profile says so. */
async function inheritCwd(opts) {
  if (opts.cwd || opts.host || opts.command) return opts;
  const profile = profileById(opts.profileId);
  if (profile.cwd === 'inherit' && activeSession() && !activeSession().host) {
    return { ...opts, cwd: await activeSession().currentCwd() };
  }
  return opts;
}

export async function newTab(opts = {}, { activate = true, index } = {}) {
  opts = await inheritCwd(opts);
  const tab = new Tab();
  if (opts.tabColor) tab.color = opts.tabColor;
  if (opts.host?.color) tab.color = opts.host.color;
  const session = wire(new Session(opts));
  tab.root = { type: 'pane', session };
  tab.active = session;
  if (index == null) tabs.push(tab); else tabs.splice(index, 0, tab);
  renderTabBar();
  bodyEl.append(tab.body);
  render(tab);
  if (activate) activateTab(tab);
  return tab;
}

/** Split the active pane: 'right' (side by side) or 'down' (stacked). */
export async function split(direction, opts = {}) {
  const tab = activeTab;
  if (!tab?.active) return newTab(opts);
  if (!opts.host && !opts.profileId) {
    // A split of an SSH pane connects to the same host again, like iTerm.
    if (tab.active.host) opts = { ...opts, host: tab.active.host };
    opts.profileId ??= tab.active.profile.id;
  }
  opts = await inheritCwd(opts);
  const session = wire(new Session(opts));
  const dir = direction === 'right' ? 'row' : 'col';
  const leaf = { type: 'pane', session };
  const target = tab.active;
  const { node, parent } = findNode(tab.root, target);
  if (parent && parent.dir === dir) {
    const i = parent.children.indexOf(node);
    const half = parent.sizes[i] / 2;
    parent.sizes.splice(i, 1, half, half);
    parent.children.splice(i + 1, 0, leaf);
  } else {
    const replacement = { type: 'split', dir, children: [node, leaf], sizes: [1, 1] };
    if (parent) parent.children[parent.children.indexOf(node)] = replacement;
    else tab.root = replacement;
  }
  tab.maximized = null;
  tab.active = session;
  render(tab);
  session.focus();
  return session;
}

function findNode(node, session, parent = null) {
  if (!node) return {};
  if (node.type === 'pane') return node.session === session ? { node, parent } : {};
  for (const c of node.children) {
    const r = findNode(c, session, node);
    if (r.node) return r;
  }
  return {};
}

export async function closeSession(session, { ask = true } = {}) {
  const tab = tabOf(session);
  if (!tab) return;
  if (ask && settings.confirmClose && await session.busy()) {
    const what = session.host ? `the connection to ${session.title()}` : session.procName;
    const r = await window.snake.confirm({ message: `Close this pane?`, detail: `${what} is still running and will be stopped.`, buttons: ['Close', 'Cancel'] });
    if (r.response !== 0) return;
  }
  const { node, parent } = findNode(tab.root, session);
  session.dispose();
  if (!parent) {
    removeTab(tab);
    return;
  }
  const i = parent.children.indexOf(node);
  parent.children.splice(i, 1);
  const freed = parent.sizes.splice(i, 1)[0];
  parent.sizes[Math.max(0, i - 1)] += freed;
  if (parent.children.length === 1) {
    // A split of one is just that pane.
    const only = parent.children[0];
    const grand = findParent(tab.root, parent);
    if (grand) grand.children[grand.children.indexOf(parent)] = only;
    else tab.root = only;
  }
  if (tab.maximized === session) tab.maximized = null;
  if (tab.active === session) tab.active = tab.sessions()[Math.max(0, i - 1)] || tab.sessions()[0];
  render(tab);
  if (tab === activeTab) tab.active?.focus();
}

function findParent(node, child) {
  if (!node || node.type !== 'split') return null;
  if (node.children.includes(child)) return node;
  for (const c of node.children) { const r = findParent(c, child); if (r) return r; }
  return null;
}

export async function closeTab(tab, { ask = true } = {}) {
  if (ask && settings.confirmClose) {
    const busy = [];
    for (const s of tab.sessions()) if (await s.busy()) busy.push(s.host ? `the connection to ${s.title()}` : s.procName);
    if (busy.length) {
      const r = await window.snake.confirm({ message: 'Close this tab?', detail: `Still running: ${busy.join(', ')}.`, buttons: ['Close', 'Cancel'] });
      if (r.response !== 0) return;
    }
  }
  for (const s of tab.sessions()) s.dispose();
  removeTab(tab);
}

function removeTab(tab) {
  const i = tabs.indexOf(tab);
  if (i < 0) return;
  tabs.splice(i, 1);
  tab.body.remove();
  tab.el.remove();
  if (!tabs.length) { bus.emit('tabs:empty'); return; }
  if (activeTab === tab) activateTab(tabs[Math.min(i, tabs.length - 1)]);
  renderTabBar();
}

export function activateTab(tab) {
  if (!tab) return;
  activeTab = tab;
  for (const t of tabs) {
    t.el.classList.toggle('active', t === tab);
    t.body.classList.toggle('active', t === tab);
  }
  tab.activity = false;
  tab.el.classList.remove('activity', 'belled');
  requestAnimationFrame(() => {
    for (const s of tab.sessions()) s.doFit();
    tab.active?.focus();
  });
  tab.el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  updateTitles();
  bus.emit('tab:activated', tab);
}

export function cycleTab(delta) {
  if (tabs.length < 2) return;
  activateTab(tabs[(tabs.indexOf(activeTab) + delta + tabs.length) % tabs.length]);
}

export function gotoTab(n) {
  activateTab(n === 9 ? tabs[tabs.length - 1] : tabs[n - 1]);
}

export function moveTab(delta) {
  moveTabTo(activeTab, tabs.indexOf(activeTab) + (delta > 0 ? 2 : -1));
}

function moveTabTo(tab, index) {
  const from = tabs.indexOf(tab);
  if (from < 0) return;
  tabs.splice(from, 1);
  tabs.splice(Math.max(0, Math.min(tabs.length, index > from ? index - 1 : index)), 0, tab);
  renderTabBar();
}

export function renderTabBar() {
  tabsEl.replaceChildren(...tabs.map((t) => t.el));
  updateTitles();
}

export function updateTitles() {
  for (const t of tabs) {
    const title = t.title();
    if (t.label.textContent !== title) t.label.textContent = title;
    t.el.title = title;
    t.el.style.setProperty('--tab-color', t.color || 'transparent');
    t.el.classList.toggle('has-color', !!t.color);
    t.badge.replaceChildren(t.broadcast ? icon('broadcast') : '', t.maximized ? icon('maximize') : '');
    for (const s of t.sessions()) s.paneTitle && (s.paneTitle.textContent = s.title());
  }
  if (activeTab) window.snake.win.setTitle(`${activeTab.title()} — Snake's Terminal`);
  bus.emit('titles');
}

// ---------------------------------------------------------------------------
// Drawing a tab's panes
// ---------------------------------------------------------------------------
function render(tab) {
  const many = tab.sessions().length > 1;
  const build = (node) => {
    if (node.type === 'pane') {
      const s = node.session;
      const pane = el('div.pane');
      if (many) {
        s.paneTitle ||= el('span.pane-title');
        pane.append(el('div.pane-head', {},
          s.paneTitle,
          el('button.icon-btn.small', { title: 'Maximize (toggle)', on: { click: () => { tab.active = s; toggleMaximize(); } } }, icon('maximize')),
          el('button.icon-btn.small', { title: 'Close pane', on: { click: () => closeSession(s) } }, icon('close'))));
      }
      pane.addEventListener('mousedown', () => { if (tab.active !== s) { tab.active = s; markActivePane(tab); updateTitles(); } }, true);
      pane.addEventListener('contextmenu', (e) => { e.preventDefault(); tab.active = s; markActivePane(tab); bus.emit('pane:contextmenu', s, e); });
      s.mount(pane);
      s.paneEl = pane;
      return pane;
    }
    const box = el(`div.split.${node.dir}`);
    node.children.forEach((c, i) => {
      const child = build(c);
      child.style.flex = `${node.sizes[i]} 1 0`;
      box.append(child);
      if (i < node.children.length - 1) box.append(sash(node, i, box));
    });
    return box;
  };
  tab.body.replaceChildren(build(tab.root));
  tab.body.classList.toggle('maximized', !!tab.maximized);
  markActivePane(tab);
  updateTitles();
  requestAnimationFrame(() => tab.sessions().forEach((s) => s.doFit()));
}

function markActivePane(tab) {
  for (const s of tab.sessions()) {
    s.paneEl?.classList.toggle('active', s === tab.active);
    s.paneEl?.classList.toggle('is-max', s === tab.maximized);
  }
}

function sash(node, i, box) {
  const s = el(`div.sash.${node.dir}`);
  s.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    s.setPointerCapture(e.pointerId);
    const kids = [...box.children].filter((c) => !c.classList.contains('sash'));
    const a = kids[i].getBoundingClientRect();
    const b = kids[i + 1].getBoundingClientRect();
    const horizontal = node.dir === 'row';
    const start = horizontal ? e.clientX : e.clientY;
    const total = horizontal ? a.width + b.width : a.height + b.height;
    const sum = node.sizes[i] + node.sizes[i + 1];
    const first = horizontal ? a.width : a.height;
    const move = (ev) => {
      const d = (horizontal ? ev.clientX : ev.clientY) - start;
      const f = Math.max(60, Math.min(total - 60, first + d)) / total;
      node.sizes[i] = sum * f;
      node.sizes[i + 1] = sum * (1 - f);
      kids[i].style.flex = `${node.sizes[i]} 1 0`;
      kids[i + 1].style.flex = `${node.sizes[i + 1]} 1 0`;
    };
    const up = () => { s.removeEventListener('pointermove', move); s.removeEventListener('pointerup', up); };
    s.addEventListener('pointermove', move);
    s.addEventListener('pointerup', up);
  });
  s.addEventListener('dblclick', () => {
    const avg = (node.sizes[i] + node.sizes[i + 1]) / 2;
    node.sizes[i] = node.sizes[i + 1] = avg;
    render(activeTab);
  });
  return s;
}

export function toggleMaximize() {
  const tab = activeTab;
  if (!tab || tab.sessions().length < 2) return;
  tab.maximized = tab.maximized ? null : tab.active;
  tab.body.classList.toggle('maximized', !!tab.maximized);
  markActivePane(tab);
  updateTitles();
  requestAnimationFrame(() => tab.sessions().forEach((s) => s.doFit()));
  tab.active?.focus();
}

/** Move to the pane next to this one: 'left', 'right', 'up' or 'down'. */
export function focusPane(direction) {
  const tab = activeTab;
  if (!tab?.active || tab.maximized) return;
  const from = tab.active.paneEl.getBoundingClientRect();
  const cx = from.left + from.width / 2;
  const cy = from.top + from.height / 2;
  let best = null;
  let bestScore = Infinity;
  for (const s of tab.sessions()) {
    if (s === tab.active) continue;
    const r = s.paneEl.getBoundingClientRect();
    const x = r.left + r.width / 2;
    const y = r.top + r.height / 2;
    const ok = { left: r.right <= from.left + 2, right: r.left >= from.right - 2, up: r.bottom <= from.top + 2, down: r.top >= from.bottom - 2 }[direction];
    if (!ok) continue;
    const main = direction === 'left' || direction === 'right' ? Math.abs(x - cx) : Math.abs(y - cy);
    const cross = direction === 'left' || direction === 'right' ? Math.abs(y - cy) : Math.abs(x - cx);
    const score = main + cross * 2;
    if (score < bestScore) { bestScore = score; best = s; }
  }
  if (best) { tab.active = best; markActivePane(tab); best.focus(); updateTitles(); }
}

export function cyclePane(delta) {
  const tab = activeTab;
  const list = tab?.sessions() || [];
  if (list.length < 2) return;
  const next = list[(list.indexOf(tab.active) + delta + list.length) % list.length];
  tab.active = next;
  if (tab.maximized) tab.maximized = next;
  markActivePane(tab);
  next.focus();
  updateTitles();
}

export function toggleBroadcast() {
  if (!activeTab) return;
  activeTab.broadcast = !activeTab.broadcast;
  activeTab.body.classList.toggle('broadcast', activeTab.broadcast);
  updateTitles();
  return activeTab.broadcast;
}

export async function renameTab(tab = activeTab) {
  if (!tab) return;
  const name = await prompt({ title: 'Rename tab', message: 'Leave empty to name it after what runs in it.', value: tab.userTitle || tab.title() });
  if (name == null) return;
  tab.userTitle = name;
  updateTitles();
  tab.active?.focus();
}

function tabMenu(tab, e) {
  showMenu([
    { label: 'Rename…', icon: 'edit', run: () => renameTab(tab) },
    { header: 'Colour' },
    ...TAB_COLORS.map((c) => ({ label: c ? ' ' : 'None', color: c, checked: tab.color === c, run: () => { tab.color = c; updateTitles(); } })),
    { separator: true },
    { label: 'Duplicate', icon: 'copy', run: async () => newTab({ host: tab.active?.host, profileId: tab.active?.profile.id, cwd: await tab.active?.currentCwd() }, { index: tabs.indexOf(tab) + 1 }) },
    { label: 'Broadcast input to all its panes', icon: 'broadcast', checked: tab.broadcast, run: () => { activateTab(tab); toggleBroadcast(); } },
    { separator: true },
    { label: 'Close other tabs', disabled: tabs.length < 2, run: async () => { for (const t of tabs.filter((x) => x !== tab)) await closeTab(t); } },
    { label: 'Close tab', icon: 'close', run: () => closeTab(tab) },
  ], { x: e.clientX, y: e.clientY });
}

// ---------------------------------------------------------------------------
// What to bring back next time
// ---------------------------------------------------------------------------
export function snapshot() {
  const snap = (n) => (n.type === 'pane' ? { type: 'pane', ...n.session.snapshot() } : { type: 'split', dir: n.dir, sizes: n.sizes, children: n.children.map(snap) });
  return { tabs: tabs.map((t) => ({ title: t.userTitle, color: t.color, root: snap(t.root), active: t.sessions().indexOf(t.active) })), active: tabs.indexOf(activeTab) };
}

export function restore(saved) {
  if (!saved?.tabs?.length) return false;
  for (const t of saved.tabs) {
    const tab = new Tab();
    tab.userTitle = t.title || '';
    tab.color = t.color || '';
    const build = (n) => {
      if (n.type === 'split') return { type: 'split', dir: n.dir === 'col' ? 'col' : 'row', sizes: n.sizes?.length === n.children.length ? n.sizes : n.children.map(() => 1), children: n.children.map(build) };
      // Connections wait for you; local shells come back in their folders.
      const opts = { profileId: n.profileId, cwd: n.cwd || null, host: n.host || null, title: n.title || '', paused: !!n.host };
      return { type: 'pane', session: wire(new Session(opts)) };
    };
    try { tab.root = build(t.root); } catch { continue; }
    const list = tab.sessions();
    tab.active = list[t.active] || list[0];
    tabs.push(tab);
    bodyEl.append(tab.body);
    render(tab);
  }
  if (!tabs.length) return false;
  renderTabBar();
  activateTab(tabs[saved.active] || tabs[0]);
  return true;
}

export { platform };
