// Activity bar + side bar view containers, and collapsible view sections.
import { el, icon, bus } from './util.js';
import { keyLabelFor } from './commands.js';

const views = new Map();
let activeView = null;
let sidebarVisible = true;

/**
 * view: { id, title, icon, order, command, build(container) -> {onShow?, onHide?, actions?: [{icon,title,run}], focus?} }
 */
export function registerView(view) {
  views.set(view.id, view);
}

export function initSidebar() {
  const bar = document.getElementById('activitybar');
  const top = el('div.activity-top');
  const bottom = el('div.activity-bottom');
  bar.append(top, bottom);
  const sorted = [...views.values()].sort((a, b) => a.order - b.order);
  for (const v of sorted) {
    const badge = el('span.activity-badge');
    const item = el('div.activity-item', { dataset: { view: v.id } }, icon(v.icon), badge);
    item.title = v.title;
    item.addEventListener('mouseenter', () => (item.title = `${v.title}${v.command && keyLabelFor(v.command) ? ` (${keyLabelFor(v.command)})` : ''}`));
    item.addEventListener('click', () => {
      if (activeView === v.id && sidebarVisible) setSidebarVisible(false);
      else showView(v.id);
    });
    v.item = item;
    v.badge = badge;
    top.append(item);
  }
  const accounts = el('div.activity-item', { title: 'Accounts' }, icon('account'));
  accounts.addEventListener('click', (e) => bus.emit('activity:accounts', e));
  const manage = el('div.activity-item', { title: 'Manage' }, icon('settings-gear'));
  manage.addEventListener('click', (e) => bus.emit('activity:manage', e));
  bottom.append(accounts, manage);

  const sidebar = document.getElementById('sidebar');
  for (const v of sorted) {
    const actions = el('div.sidebar-actions');
    const header = el('div.sidebar-header', {}, el('span.sidebar-title', {}, v.title.toUpperCase()), actions);
    const content = el('div.sidebar-content');
    const container = el('div.view-container', { dataset: { view: v.id } }, header, content);
    container.style.display = 'none';
    sidebar.append(container);
    v.container = container;
    v.instance = v.build(content) || {};
    for (const a of v.instance.actions || []) {
      const b = el('span.action-btn', { title: a.title, onclick: (e) => a.run(e) }, icon(a.icon));
      actions.append(b);
    }
  }
}

export function showView(id, { focus = true } = {}) {
  const v = views.get(id);
  if (!v) return;
  if (activeView && activeView !== id) {
    const prev = views.get(activeView);
    prev.container.style.display = 'none';
    prev.item.classList.remove('active');
    prev.instance.onHide?.();
  }
  activeView = id;
  v.container.style.display = '';
  v.item.classList.add('active');
  setSidebarVisible(true);
  v.instance.onShow?.();
  if (focus) v.instance.focus?.();
  bus.emit('sidebar:viewChanged', id);
}

export function getActiveView() {
  return activeView;
}

export function isSidebarVisible() {
  return sidebarVisible;
}

export function setSidebarVisible(visible) {
  sidebarVisible = visible;
  document.getElementById('workbench').classList.toggle('sidebar-hidden', !visible);
  if (activeView) views.get(activeView).item.classList.toggle('active', visible);
  bus.emit('layout:changed');
}

export function toggleSidebar() {
  if (!activeView) showView([...views.keys()][0]);
  else setSidebarVisible(!sidebarVisible);
}

export function setBadge(id, count) {
  const v = views.get(id);
  if (!v?.badge) return;
  v.badge.textContent = count > 999 ? '999+' : count ? String(count) : '';
  v.badge.style.display = count ? '' : 'none';
}

/**
 * A collapsible section inside a view (e.g. "OPEN EDITORS").
 * Returns { el, body, setTitle, setCollapsed, actions }
 */
export function section({ title, collapsed = false, actions = [], grow = false, onToggle }) {
  const actionsEl = el('div.section-actions');
  for (const a of actions) actionsEl.append(el('span.action-btn', { title: a.title, onclick: (e) => { e.stopPropagation(); a.run(e); } }, icon(a.icon)));
  const titleEl = el('span.section-title', {}, title);
  const countEl = el('span.section-count');
  const twistie = icon('chevron-down', 'section-twistie');
  const header = el('div.section-header', { tabindex: '0' }, twistie, titleEl, countEl, actionsEl);
  const body = el('div.section-body');
  const root = el('div.view-section' + (grow ? '.grow' : ''), {}, header, body);
  const setCollapsed = (c) => {
    root.classList.toggle('collapsed', c);
    twistie.className = `codicon codicon-chevron-${c ? 'right' : 'down'} section-twistie`;
    onToggle?.(c);
  };
  header.addEventListener('click', () => setCollapsed(!root.classList.contains('collapsed')));
  header.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); header.click(); } });
  setCollapsed(collapsed);
  const setCount = (n) => { countEl.textContent = n ? String(n) : ''; countEl.style.display = n ? '' : 'none'; };
  setCount(0);
  return { el: root, body, header, setTitle: (t) => (titleEl.textContent = t), setCollapsed, setCount, actionsEl };
}
