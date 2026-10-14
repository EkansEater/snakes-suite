// Custom editor pages: Settings UI, Keyboard Shortcuts, Welcome, About.
import { el, icon, bus, tildify, debounce } from './util.js';
import * as settings from './settings.js';
import { themes } from './themes.js';
import { registerEditorKind, openInput } from './editors.js';
import { specialIcon } from './icons.js';
import { allCommands, getBindings, formatKey, executeCommand, eventToKey, keybindingFor } from './commands.js';
import { env, getState, removeRecent } from './workspace.js';
import { contextMenu, notify } from './ui.js';

const CATEGORY_LABELS = { editor: 'Text Editor', files: 'Files', workbench: 'Workbench', window: 'Window', explorer: 'Explorer', search: 'Search', terminal: 'Terminal', git: 'Git' };

function humanize(key) {
  const parts = key.split('.');
  const last = parts.slice(1);
  const cat = last.length > 1 ? last.slice(0, -1).map(cap).join(' › ') + ': ' : '';
  return { cat: CATEGORY_LABELS[parts[0]] || cap(parts[0]), title: cat + cap(last[last.length - 1].replace(/([a-z])([A-Z])/g, '$1 $2')) };
}
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// ===========================================================================
// Settings
// ===========================================================================
registerEditorKind('settings', {
  title: () => 'Settings',
  icon: () => specialIcon('settings-gear'),
  render(input, host) {
    const search = el('input.settings-search', { placeholder: 'Search settings', spellcheck: 'false', value: input.query || '' });
    const modifiedOnly = el('label.settings-check', {}, el('input', { type: 'checkbox' }), ' Modified only');
    const jsonBtn = el('span.action-btn', { title: 'Open Settings (JSON)', onclick: () => executeCommand('workbench.action.openSettingsJson') }, icon('json'));
    const toc = el('div.settings-toc');
    const list = el('div.settings-list');
    const count = el('span.settings-count');
    const page = el(
      'div.settings-page',
      {},
      el('div.settings-header', {}, el('div.settings-search-row', {}, icon('search', 'settings-search-icon'), search, count, modifiedOnly, jsonBtn)),
      el('div.settings-main', {}, toc, list),
    );
    host.append(page);

    const control = (s) => {
      const value = settings.get(s.key);
      const set = (v) => settings.set(s.key, v);
      if (s.type === 'boolean') {
        const cb = el('input', { type: 'checkbox' });
        cb.checked = !!value;
        cb.addEventListener('change', () => set(cb.checked));
        return el('label.setting-bool', {}, cb, el('span', {}, s.description));
      }
      if (s.type === 'enum') {
        const sel = el('select.setting-select');
        for (const opt of s.enum) sel.append(el('option', { value: opt, selected: String(opt) === String(value) }, opt === '\n' ? 'LF (\\n)' : opt === '\r\n' ? 'CRLF (\\r\\n)' : String(opt)));
        sel.addEventListener('change', () => set(sel.value));
        return sel;
      }
      if (s.type === 'theme') {
        const sel = el('select.setting-select');
        for (const t of themes) sel.append(el('option', { value: t.id, selected: t.id === value }, t.label));
        sel.addEventListener('change', () => set(sel.value));
        return sel;
      }
      if (s.type === 'number') {
        const inp = el('input.setting-input.number', { type: 'number', value: String(value), min: s.min ?? '', max: s.max ?? '' });
        inp.addEventListener('change', () => { const n = parseFloat(inp.value); if (!isNaN(n)) set(n); });
        return inp;
      }
      const inp = el('input.setting-input', { type: 'text', value: String(value ?? ''), spellcheck: 'false' });
      inp.addEventListener('change', () => set(inp.value));
      return inp;
    };

    const render = () => {
      const q = search.value.trim().toLowerCase();
      const onlyMod = modifiedOnly.querySelector('input').checked;
      const groups = new Map();
      let n = 0;
      for (const s of settings.schema) {
        const h = humanize(s.key);
        if (q && !(`${s.key} ${h.title} ${s.description} ${h.cat}`.toLowerCase().includes(q))) continue;
        if (onlyMod && !settings.isModified(s.key)) continue;
        if (!groups.has(h.cat)) groups.set(h.cat, []);
        groups.get(h.cat).push({ s, h });
        n++;
      }
      count.textContent = q || onlyMod ? `${n} Setting${n === 1 ? '' : 's'} Found` : '';
      list.replaceChildren();
      toc.replaceChildren();
      for (const [cat, entries] of groups) {
        const header = el('h2.settings-group', { id: 'settings-' + cat }, cat);
        list.append(header);
        const tocItem = el('div.toc-item', {}, cat);
        tocItem.addEventListener('click', () => header.scrollIntoView({ behavior: 'smooth' }));
        toc.append(tocItem);
        for (const { s, h } of entries) {
          const modified = settings.isModified(s.key);
          const gear = el('span.setting-gear', { title: 'More Actions...' }, icon('gear'));
          const row = el(
            'div.setting' + (modified ? '.modified' : ''),
            { dataset: { key: s.key } },
            gear,
            el('div.setting-title', {}, el('span.setting-cat', {}, h.cat + ': '), el('b', {}, h.title.replace(/^.*: /, '')), modified ? el('span.setting-mod', {}, ' (Modified)') : null),
            s.type !== 'boolean' ? el('div.setting-desc', {}, s.description) : null,
            el('div.setting-control', {}, control(s)),
            el('div.setting-key', {}, s.key),
          );
          const menu = (e) =>
            contextMenu(e, [
              { label: 'Reset Setting', disabled: !modified, run: () => settings.reset(s.key) },
              { separator: true },
              { label: 'Copy Setting ID', run: () => window.snake.clipboard.write(s.key) },
              { label: 'Copy Setting as JSON', run: () => window.snake.clipboard.write(`"${s.key}": ${JSON.stringify(settings.get(s.key))}`) },
            ]);
          gear.addEventListener('click', menu);
          row.addEventListener('contextmenu', menu);
          list.append(row);
        }
      }
      if (!n) list.append(el('div.settings-none', {}, 'No settings found.'));
    };
    const renderSoon = debounce(render, 120);
    search.addEventListener('input', renderSoon);
    modifiedOnly.querySelector('input').addEventListener('change', render);
    const off = bus.on('settings:changed', () => {
      // don't steal focus from a control being edited
      if (page.contains(document.activeElement) && document.activeElement !== search) {
        const key = document.activeElement.closest('.setting')?.dataset.key;
        render();
        if (key) list.querySelector(`.setting[data-key="${key}"] .setting-control > *`)?.focus();
      } else render();
    });
    render();
    return {
      dispose: () => { off(); page.remove(); },
      focus: () => search.focus(),
    };
  },
});

export function openSettings(query) {
  openInput({ kind: 'settings', key: 'settings', query, clone() { return { ...this, preview: false }; } });
}

// ===========================================================================
// Keyboard shortcuts
// ===========================================================================
registerEditorKind('keybindings', {
  title: () => 'Keyboard Shortcuts',
  icon: () => specialIcon('keyboard'),
  render(input, host) {
    const search = el('input.settings-search', { placeholder: 'Type to search in keybindings', spellcheck: 'false' });
    const recordBtn = el('span.action-btn', { title: 'Record Keys' }, icon('record-keys'));
    const jsonBtn = el('span.action-btn', { title: 'Open Keyboard Shortcuts (JSON)', onclick: () => executeCommand('workbench.action.openGlobalKeybindingsFile') }, icon('json'));
    const table = el('div.kb-table');
    const page = el('div.settings-page.kb-page', {}, el('div.settings-header', {}, el('div.settings-search-row', {}, icon('search', 'settings-search-icon'), search, recordBtn, jsonBtn)), table);
    host.append(page);
    let recording = false;
    recordBtn.addEventListener('click', () => { recording = !recording; recordBtn.classList.toggle('on', recording); search.value = ''; search.focus(); search.placeholder = recording ? 'Recording keys. Press Escape to exit' : 'Type to search in keybindings'; render(); });
    search.addEventListener('keydown', (e) => {
      if (!recording) return;
      if (e.key === 'Escape') { recordBtn.click(); return; }
      e.preventDefault();
      e.stopPropagation();
      const k = eventToKey(e);
      if (k) { search.value = (search.value && search.value.split(' ').length < 2 && search.dataset.chord ? search.value + ' ' : '') + k; search.dataset.chord = '1'; render(); }
    });
    const render = () => {
      const q = search.value.trim().toLowerCase();
      const bindings = getBindings();
      const rows = [];
      for (const c of allCommands()) {
        const label = c.category ? `${c.category}: ${c.title}` : c.title;
        const keys = bindings.filter((b) => b.command === c.id);
        const keyText = keys.map((b) => b.key).join(' ');
        if (q) {
          if (recording) { if (!keys.some((b) => b.key === q)) continue; }
          else if (!`${label} ${c.id} ${keyText} ${keys.map((b) => formatKey(b.key)).join(' ')}`.toLowerCase().includes(q)) continue;
        }
        rows.push({ c, label, keys });
      }
      rows.sort((a, b) => (b.keys.length > 0) - (a.keys.length > 0) || a.label.localeCompare(b.label));
      const frag = document.createDocumentFragment();
      frag.append(el('div.kb-row.kb-head', {}, el('span', {}, 'Command'), el('span', {}, 'Keybinding'), el('span', {}, 'Source'), el('span', {}, 'Command ID')));
      for (const r of rows) {
        const keyEl = el('span.kb-keys');
        for (const b of r.keys) keyEl.append(el('span.kb-key', {}, ...formatKey(b.key).split(' ').map((k) => el('kbd', {}, k))));
        const row = el('div.kb-row', { title: 'Double-click to change keybinding' }, el('span', {}, r.label), keyEl, el('span.kb-src', {}, r.keys.some((b) => b.user) ? 'User' : r.keys.length ? 'Default' : ''), el('span.kb-id', {}, r.c.id));
        row.addEventListener('dblclick', () => defineKeybinding(r.c.id, render));
        row.addEventListener('contextmenu', (e) => contextMenu(e, [
          { label: 'Change Keybinding...', run: () => defineKeybinding(r.c.id, render) },
          { label: 'Remove Keybinding', disabled: !r.keys.length, run: () => removeKeybinding(r.c.id) },
          { separator: true },
          { label: 'Copy Command ID', run: () => window.snake.clipboard.write(r.c.id) },
          { label: 'Copy', run: () => window.snake.clipboard.write(`${r.label}  ${r.keys.map((b) => formatKey(b.key)).join(', ')}`) },
        ]));
        frag.append(row);
      }
      table.replaceChildren(frag);
    };
    search.addEventListener('input', debounce(render, 100));
    const off = bus.on('keybindings:changed', render);
    render();
    return { dispose: () => { off(); page.remove(); }, focus: () => search.focus() };
  },
});

async function saveUserKeybinding(entry) {
  const list = (await window.snake.store.get('keybindings')) || [];
  list.push(entry);
  await window.snake.store.set('keybindings', list);
  bus.emit('userfile:saved', env.storePaths.keybindings);
}

async function removeKeybinding(id) {
  await saveUserKeybinding({ command: '-' + id });
}

function defineKeybinding(id, after) {
  const overlay = el('div.kb-define');
  const box = el('div.kb-define-box', {}, el('div', {}, 'Press desired key combination and then press ENTER.'), el('div.kb-define-keys', {}, ' '), el('div.kb-define-hint'));
  overlay.append(box);
  document.getElementById('overlay-root').append(overlay);
  const keysEl = box.querySelector('.kb-define-keys');
  const hint = box.querySelector('.kb-define-hint');
  let chord = [];
  const onKey = async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape') return close();
    if (e.key === 'Enter' && chord.length) {
      close();
      const old = keybindingFor(id);
      if (old) await saveUserKeybinding({ key: old, command: '-' + id });
      await saveUserKeybinding({ key: chord.join(' '), command: id });
      notify({ message: `Keybinding for '${id}' set to ${formatKey(chord.join(' '))}.`, timeout: 2500 });
      after?.();
      return;
    }
    const k = eventToKey(e);
    if (!k) return;
    chord = chord.length >= 2 ? [k] : [...chord, k];
    keysEl.replaceChildren(...formatKey(chord.join(' ')).split(' ').map((x) => el('kbd', {}, x)));
    const conflicts = getBindings().filter((b) => b.key === chord.join(' ') && b.command !== id);
    hint.textContent = conflicts.length ? `${conflicts.length} existing command${conflicts.length > 1 ? 's have' : ' has'} this keybinding: ${conflicts.map((c) => c.command).join(', ')}` : '';
  };
  const close = () => { window.removeEventListener('keydown', onKey, true); overlay.remove(); };
  window.addEventListener('keydown', onKey, true);
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
}

export function openKeybindings() {
  openInput({ kind: 'keybindings', key: 'keybindings', clone() { return { ...this, preview: false }; } });
}

// ===========================================================================
// Welcome
// ===========================================================================
registerEditorKind('welcome', {
  title: () => 'Welcome',
  icon: () => el('span.file-icon.special', {}, el('img', { src: 'icon.svg', style: { width: '14px', height: '14px' } })),
  render(input, host) {
    const link = (ic, label, cmd, arg) => el('a.welcome-link', { href: '#', onclick: (e) => { e.preventDefault(); executeCommand(cmd, arg); } }, icon(ic), label);
    const recentList = el('div.welcome-recent');
    const renderRecent = () => {
      const items = (getState().recent || []).filter((r) => r.type === 'folder').slice(0, 8);
      recentList.replaceChildren(
        ...(items.length
          ? items.map((r) => {
              const a = el('a.welcome-recent-item', { href: '#', title: r.path }, el('span.recent-name', {}, r.path.split(/[\\/]/).pop()), el('span.recent-path', {}, tildify(r.path, env.homeDir)));
              a.addEventListener('click', (e) => { e.preventDefault(); bus.emit('workspace:openFolderRequest', r.path); });
              a.addEventListener('contextmenu', (e) => contextMenu(e, [
                { label: 'Open in New Window', run: () => window.snake.win.newWindow(r.path) },
                { label: 'Remove from Recently Opened', run: () => removeRecent(r.path) },
                { label: 'Copy Path', run: () => window.snake.clipboard.write(r.path) },
              ]));
              return a;
            })
          : [el('p.welcome-muted', {}, 'You have no recent folders, open a folder to start.')]),
      );
      if (items.length) recentList.append(el('a.welcome-more', { href: '#', onclick: (e) => { e.preventDefault(); executeCommand('workbench.action.openRecent'); } }, 'More...'));
    };
    renderRecent();
    const off = bus.on('recent:changed', renderRecent);

    const themeGrid = el('div.welcome-themes');
    const renderThemes = () => {
      themeGrid.replaceChildren(
        ...themes.map((t) => {
          const sw = el('div.theme-swatch' + (settings.get('workbench.colorTheme') === t.id ? '.active' : ''), { title: t.label },
            el('div.sw-bar', { style: { background: t.css['--activity-bg'] } }),
            el('div.sw-side', { style: { background: t.css['--sidebar-bg'] } }),
            el('div.sw-editor', { style: { background: t.css['--bg'] } }, el('span', { style: { background: t.css['--accent'] } }), el('span', { style: { background: t.monaco.rules.find((r) => r.token === 'string')?.foreground ? '#' + t.monaco.rules.find((r) => r.token === 'string').foreground : '#888' } }), el('span', { style: { background: '#' + (t.monaco.rules.find((r) => r.token === 'keyword')?.foreground || '888') } })),
            el('div.sw-label', {}, t.label));
          sw.addEventListener('click', () => settings.set('workbench.colorTheme', t.id));
          return sw;
        }),
      );
    };
    renderThemes();
    const offTheme = bus.on('theme:changed', renderThemes);

    const showOnStartup = el('input', { type: 'checkbox' });
    showOnStartup.checked = settings.get('workbench.startupEditor') === 'welcomePage';
    showOnStartup.addEventListener('change', () => settings.set('workbench.startupEditor', showOnStartup.checked ? 'welcomePage' : 'none'));

    const kb = (label, cmd) => el('div.welcome-kb', {}, el('span', {}, label), el('span.kb-keys', {}, ...formatKey(keybindingFor(cmd) || '').split(' ').filter(Boolean).map((k) => el('kbd', {}, k))));

    const page = el(
      'div.welcome-page',
      { tabindex: '0' },
      el(
        'div.welcome-inner',
        {},
        el('div.welcome-hero', {}, el('img.welcome-logo', { src: 'icon.svg', alt: '' }), el('div', {}, el('h1', {}, "Snake's Code"), el('p.welcome-sub', {}, 'Editing evolved, with a little bite'))),
        el(
          'div.welcome-cols',
          {},
          el(
            'div.welcome-col',
            {},
            el('h2', {}, 'Start'),
            link('new-file', 'New File...', 'workbench.action.files.newUntitledFile'),
            link('go-to-file', 'Open File...', 'workbench.action.files.openFile'),
            link('folder-opened', 'Open Folder...', 'workbench.action.files.openFolder'),
            link('source-control', 'Clone Git Repository...', 'git.clone'),
            link('terminal', 'New Terminal', 'workbench.action.terminal.new'),
            el('h2', {}, 'Recent'),
            recentList,
          ),
          el(
            'div.welcome-col',
            {},
            el('h2', {}, 'Pick a Theme'),
            themeGrid,
            el('h2', {}, 'Handy Shortcuts'),
            kb('Command Palette', 'workbench.action.showCommands'),
            kb('Quick Open File', 'workbench.action.quickOpen'),
            kb('Find in Files', 'workbench.action.findInFiles'),
            kb('Toggle Terminal', 'workbench.action.terminal.toggleTerminal'),
            kb('Split Editor', 'workbench.action.splitEditor'),
            kb('Toggle Side Bar', 'workbench.action.toggleSidebarVisibility'),
            kb('Zen Mode', 'workbench.action.toggleZenMode'),
            kb('Settings', 'workbench.action.openSettings'),
            el('h2', {}, 'Learn'),
            link('keyboard', 'Keyboard Shortcuts Reference', 'workbench.action.openGlobalKeybindings'),
            link('settings-gear', 'Customize Settings', 'workbench.action.openSettings'),
            link('info', "About Snake's Code", 'workbench.action.showAboutDialog'),
          ),
        ),
        el('label.welcome-startup', {}, showOnStartup, ' Show welcome page on startup'),
      ),
    );
    host.append(page);
    return { dispose: () => { off(); offTheme(); page.remove(); }, focus: () => page.focus() };
  },
});

export function openWelcome() {
  openInput({ kind: 'welcome', key: 'welcome', clone() { return { ...this, preview: false }; } });
}

export function showAbout() {
  const v = env.versions;
  const overlay = el('div.kb-define');
  const box = el(
    'div.about-box',
    {},
    el('img', { src: 'icon.svg', alt: '' }),
    el('h2', {}, "Snake's Code"),
    el('p', {}, `Version ${v.app}`),
    el('pre', {}, `Electron: ${v.electron}\nChromium: ${v.chrome}\nNode.js: ${v.node}\nOS: ${env.platform}\nShell: ${env.shell}`),
    el('div.about-buttons', {},
      el('button.btn', { onclick: () => { window.snake.clipboard.write(`Snake's Code ${v.app}\nElectron ${v.electron}\nChromium ${v.chrome}\nNode ${v.node}\nOS ${env.platform}`); close(); } }, 'Copy'),
      el('button.btn.secondary', { onclick: () => close() }, 'OK')),
  );
  overlay.append(box);
  const close = () => overlay.remove();
  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  overlay.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  document.getElementById('overlay-root').append(overlay);
  box.querySelector('button.secondary').focus();
}

