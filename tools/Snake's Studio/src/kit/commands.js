// Commands: every action an app offers, with its shortcut. Menus, the command
// palette, tooltips and the shortcut list all read from here.
import { h } from './dom.js';
import { icon } from './icons.js';
import { eventKeys, normKeys, formatKeys } from './keys.js';

const registry = new Map();
const byKeys = new Map(); // normalised keys -> [ids]
const RECENT_KEY = `snake-palette-${location.pathname}`;

/**
 * register({ id, label, category, keys: 'Ctrl+S' | ['Ctrl+S', 'F2'], run, when, icon, inputs })
 * `inputs`: also fire while typing in a text field (default: only shortcuts with Ctrl or Alt do).
 */
export function register(...cmds) {
  for (const c of cmds.flat()) {
    if (!c || !c.id) continue;
    const keys = (Array.isArray(c.keys) ? c.keys : c.keys ? [c.keys] : []).map(normKeys);
    const cmd = { category: '', ...c, keys };
    registry.set(c.id, cmd);
    for (const k of keys) {
      if (!byKeys.has(k)) byKeys.set(k, []);
      const list = byKeys.get(k);
      if (!list.includes(c.id)) list.unshift(c.id);
    }
  }
}

export const get = (id) => registry.get(id);
export const all = () => [...registry.values()];
export const keysOf = (id) => (registry.get(id) ? registry.get(id).keys[0] || '' : '');
export const enabled = (cmd) => !cmd.when || cmd.when();

export function run(id, ...args) {
  const cmd = registry.get(id);
  if (!cmd || !enabled(cmd)) return false;
  remember(id);
  cmd.run(...args);
  return true;
}

/** A menu item for a command: { label, keys, icon, run, disabled, checked }. */
export function item(id, extra = {}) {
  const cmd = registry.get(id);
  if (!cmd) return null;
  return {
    label: cmd.menuLabel || cmd.label,
    keys: cmd.keys[0],
    icon: cmd.icon,
    run: () => run(id),
    disabled: () => !enabled(cmd),
    checked: cmd.checked,
    ...extra,
  };
}

function typingIn(target) {
  if (!target || !(target instanceof Element)) return false;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || target.isContentEditable) return true;
  if (tag === 'INPUT') return !['checkbox', 'radio', 'range', 'button', 'color'].includes(target.type);
  return tag === 'SELECT';
}

let installed = false;
/** Listen for shortcuts on the whole window. */
export function installKeys() {
  if (installed) return;
  installed = true;
  window.addEventListener('keydown', (e) => {
    if (e.defaultPrevented || e.isComposing) return;
    const keys = eventKeys(e);
    if (!keys) return;
    const ids = byKeys.get(keys);
    if (!ids) return;
    const typing = typingIn(e.target);
    const modified = /^(Ctrl|Alt|Meta)\+/.test(keys) || /^F\d+$/.test(keys);
    for (const id of ids) {
      const cmd = registry.get(id);
      if (!cmd || !enabled(cmd)) continue;
      if (typing && !(cmd.inputs === true || (modified && cmd.inputs !== false))) continue;
      e.preventDefault();
      e.stopPropagation();
      remember(id);
      cmd.run(e);
      return;
    }
  });
}

// ---------------------------------------------------------------------------
// Command palette
// ---------------------------------------------------------------------------
function recent() {
  try { return JSON.parse(localStorage.getItem(RECENT_KEY) || '[]'); } catch { return []; }
}
function remember(id) {
  try {
    const list = [id, ...recent().filter((x) => x !== id)].slice(0, 12);
    localStorage.setItem(RECENT_KEY, JSON.stringify(list));
  } catch {}
}

/** Fuzzy match: returns [score, matchedIndexes] or null. */
export function fuzzy(query, text) {
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  if (!q) return [0, []];
  const direct = t.indexOf(q);
  if (direct >= 0) return [1000 - direct * 2 - t.length * 0.1, [...Array(q.length).keys()].map((i) => i + direct)];
  let ti = 0;
  let score = 0;
  let prev = -2;
  const hits = [];
  for (const ch of q) {
    const i = t.indexOf(ch, ti);
    if (i < 0) return null;
    score += i === prev + 1 ? 8 : (i === 0 || ' :-_/'.includes(t[i - 1]) ? 6 : 1);
    hits.push(i);
    prev = i;
    ti = i + 1;
  }
  return [score - t.length * 0.05, hits];
}

function highlight(text, hits) {
  const set = new Set(hits);
  return [...text].map((ch, i) => (set.has(i) ? h('b', ch) : ch));
}

let paletteEl = null;
/** Open the palette. `source` may supply other items: () => [{ label, detail, run }]. */
export function openPalette({ placeholder = 'Type a command…', source = null, initial = '' } = {}) {
  if (paletteEl) paletteEl.remove();
  const prevFocus = document.activeElement;
  const input = h('input', { placeholder, spellcheck: false, value: initial });
  const list = h('div.items');
  const el = h('div.palette', input, list);
  paletteEl = el;
  let rows = [];
  let active = 0;

  const items = () => {
    if (source) return source();
    const rec = recent();
    return all().filter((c) => !c.hidden && enabled(c)).map((c) => ({
      label: c.label, detail: c.category, keys: c.keys[0], icon: c.icon, run: () => run(c.id), rank: rec.indexOf(c.id),
    }));
  };

  const render = () => {
    const q = input.value.trim();
    const scored = [];
    for (const it of items()) {
      const text = it.detail ? `${it.detail}: ${it.label}` : it.label;
      const m = fuzzy(q, it.label) || fuzzy(q, text);
      if (!m) continue;
      let score = m[0];
      if (!q && it.rank >= 0) score += 10000 - it.rank;
      scored.push({ it, score, hits: fuzzy(q, it.label) ? m[1] : [] });
    }
    scored.sort((a, b) => b.score - a.score || a.it.label.localeCompare(b.it.label));
    list.replaceChildren();
    rows = scored.slice(0, 200).map(({ it, hits }, i) => {
      const ic = h('span.mi-icon');
      if (it.icon) ic.innerHTML = icon(it.icon, 15);
      const row = h('div.menu-item', ic,
        h('span.mi-label', it.detail ? h('span.cat', `${it.detail}:`) : null, highlight(it.label, hits)),
        it.keys ? h('span.mi-keys', formatKeys(it.keys)) : null);
      row.addEventListener('mousemove', () => setActive(i));
      row.addEventListener('click', () => choose(i));
      list.append(row);
      return { row, it };
    });
    if (!rows.length) list.append(h('div.empty', 'No matching commands'));
    setActive(0);
  };
  const setActive = (i) => {
    if (rows[active]) rows[active].row.classList.remove('active');
    active = Math.max(0, Math.min(rows.length - 1, i));
    if (rows[active]) {
      rows[active].row.classList.add('active');
      rows[active].row.scrollIntoView({ block: 'nearest' });
    }
  };
  const close = (refocus = true) => {
    el.remove();
    if (paletteEl === el) paletteEl = null;
    if (refocus && prevFocus && prevFocus.focus) prevFocus.focus({ preventScroll: true });
  };
  const choose = (i) => {
    const r = rows[i];
    close();
    if (r) setTimeout(() => r.it.run(), 0);
  };
  input.addEventListener('input', render);
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'ArrowDown') { setActive(active + 1); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { setActive(active - 1); e.preventDefault(); }
    else if (e.key === 'PageDown') { setActive(active + 10); e.preventDefault(); }
    else if (e.key === 'PageUp') { setActive(active - 10); e.preventDefault(); }
    else if (e.key === 'Enter') { choose(active); e.preventDefault(); }
    else if (e.key === 'Escape') { close(); e.preventDefault(); }
  });
  input.addEventListener('blur', () => setTimeout(() => { if (paletteEl === el && !el.contains(document.activeElement)) close(false); }, 120));
  document.body.append(el);
  render();
  input.focus();
  input.select();
}

/** Shortcut list, grouped by category, for Help > Keyboard Shortcuts. */
export function shortcutTable(filter = '') {
  const groups = new Map();
  for (const c of all()) {
    if (!c.keys.length || c.hidden) continue;
    if (filter && !fuzzy(filter, `${c.category} ${c.label} ${c.keys.join(' ')}`)) continue;
    const g = c.category || 'General';
    if (!groups.has(g)) groups.set(g, []);
    groups.get(g).push(c);
  }
  const out = h('div.col', { style: { gap: '14px' } });
  for (const [g, list] of [...groups].sort((a, b) => a[0].localeCompare(b[0]))) {
    out.append(h('div', h('div.menu-head', { style: { padding: '0 0 6px' } }, g),
      ...list.map((c) => h('div.row', { style: { justifyContent: 'space-between', padding: '3px 0', gap: '24px' } },
        h('span', c.label), h('span.row', { style: { gap: '4px' } }, ...c.keys.map((k) => h('span.kbd', formatKeys(k))))))));
  }
  if (!groups.size) out.append(h('div.empty', 'No shortcuts match'));
  return out;
}

export { formatKeys };
