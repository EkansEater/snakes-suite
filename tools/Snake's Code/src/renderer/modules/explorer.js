// Explorer view: open editors list + file tree with full file operations.
import { el, icon, bus, basename, dirname, join, extname, relative, isInside, debounce } from './util.js';
import * as settings from './settings.js';
import { workspace, env, invalidateFileList, getState, saveState } from './workspace.js';
import { registerView, section, showView } from './sidebar.js';
import { fileIcon, folderIcon } from './icons.js';
import { contextMenu, confirm, notify } from './ui.js';
import { openFile, getGroups, handleRename, handleDelete, activeInput, openDiff, getDocument, setActiveGroup } from './editors.js';
import { statusFor, folderHasChanges } from './git.js';
import { executeCommand } from './commands.js';

const children = new Map(); // dir path -> [{name,path,isDir,isSymlink}] (null while loading)
const expanded = new Set();
const selection = new Set();
let focused = null;
let anchor = null;
let editing = null; // { kind: 'new-file'|'new-folder'|'rename', dir, path }
let clipboard = null; // { paths, cut }
let compareSource = null;
let treeEl;
let rootSection;
let openEditorsSection;

function excludes() {
  return new Set(String(settings.get('files.exclude') || '').split(',').map((s) => s.trim()).filter(Boolean));
}

function sortEntries(list) {
  const order = settings.get('explorer.sortOrder');
  const cmp = (a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
  return [...list].sort((a, b) => {
    if (order === 'mixed') return cmp(a, b);
    if (order === 'filesFirst') return a.isDir === b.isDir ? cmp(a, b) : a.isDir ? 1 : -1;
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    if (order === 'type' && !a.isDir) return extname(a.name).localeCompare(extname(b.name)) || cmp(a, b);
    return cmp(a, b);
  });
}

async function loadDir(dir, force = false) {
  if (children.has(dir) && !force) return children.get(dir);
  try {
    const list = await window.snake.fs.readDir(dir);
    const ex = excludes();
    children.set(dir, sortEntries(list.filter((e) => !ex.has(e.name))));
  } catch {
    children.set(dir, []);
  }
  return children.get(dir);
}

const scheduleRender = (() => {
  let queued = false;
  return () => {
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; render(); });
  };
})();

function updateWatchers() {
  if (!workspace.root) { window.snake.fs.watchDirs([]); return; }
  const dirs = new Set([workspace.root, ...[...expanded].filter((d) => children.has(d))]);
  for (const g of getGroups()) for (const t of g.tabs) if (t.doc?.path) dirs.add(dirname(t.doc.path));
  window.snake.fs.watchDirs([...dirs]);
}
const updateWatchersSoon = debounce(updateWatchers, 200);

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
function visibleRows() {
  const rows = [];
  const walk = (dir, depth) => {
    const list = children.get(dir);
    if (!list) return;
    if (editing && (editing.kind === 'new-file' || editing.kind === 'new-folder') && editing.dir === dir) rows.push({ editRow: true, depth, isDir: editing.kind === 'new-folder' });
    for (const e of list) {
      rows.push({ entry: e, depth });
      if (e.isDir && expanded.has(e.path)) walk(e.path, depth + 1);
    }
  };
  walk(workspace.root, 0);
  return rows;
}

function render() {
  if (!treeEl) return;
  if (!workspace.root) return;
  const indent = settings.get('workbench.tree.indent') + 6;
  const rows = visibleRows();
  const frag = document.createDocumentFragment();
  const activePath = activeInput()?.doc?.path || activeInput()?.path;
  let editInput = null;
  for (const r of rows) {
    if (r.editRow) {
      const input = el('input.tree-input', { type: 'text', spellcheck: 'false' });
      const row = el('div.tree-row.editing', { style: { paddingLeft: 8 + r.depth * indent + 'px' } }, el('span.twistie'), r.isDir ? folderIcon('', false) : icon('file', 'file-icon generic'), input);
      frag.append(row);
      editInput = input;
      continue;
    }
    const e = r.entry;
    const isExp = e.isDir && expanded.has(e.path);
    const row = el('div.tree-row', { dataset: { path: e.path }, draggable: 'true', title: e.path, style: { paddingLeft: 8 + r.depth * indent + 'px' } });
    for (let i = 0; i < r.depth; i++) row.append(el('span.indent-guide', { style: { left: 8 + i * indent + 7 + 'px' } }));
    row.append(e.isDir ? icon(isExp ? 'chevron-down' : 'chevron-right', 'twistie') : el('span.twistie'));
    row.append(e.isDir ? folderIcon(e.name, isExp) : fileIcon(e.name));
    if (editing?.kind === 'rename' && editing.path === e.path) {
      const input = el('input.tree-input', { type: 'text', spellcheck: 'false', value: e.name });
      row.append(input);
      row.classList.add('editing');
      editInput = input;
    } else {
      row.append(el('span.tree-label', {}, e.name));
      if (e.isSymlink) row.append(icon('link', 'tree-symlink'));
      const st = e.isDir ? null : statusFor(e.path);
      if (st) {
        row.dataset.git = st;
        row.append(el('span.tree-deco', {}, st === '!' ? 'C' : st));
      } else if (e.isDir && settings.get('explorer.decorations.git') && folderHasChanges(e.path)) {
        row.dataset.git = 'dir';
        row.append(el('span.tree-deco.dot', {}, '•'));
      }
      const doc = getDocument(e.path);
      if (doc?.dirty) row.classList.add('dirty');
    }
    if (selection.has(e.path)) row.classList.add('selected');
    if (focused === e.path) row.classList.add('focused');
    if (e.path === activePath) row.classList.add('active-file');
    if (clipboard?.cut && clipboard.paths.includes(e.path)) row.classList.add('cut');
    frag.append(row);
  }
  treeEl.replaceChildren(frag);
  if (!rows.length && children.has(workspace.root)) treeEl.append(el('div.tree-empty', {}, 'This folder is empty.'));
  if (editInput) setupEditInput(editInput);
}

function setupEditInput(input) {
  const cur = editing;
  if (cur.kind === 'rename') {
    const name = basename(cur.path);
    const dot = name.lastIndexOf('.');
    requestAnimationFrame(() => { input.focus(); input.setSelectionRange(0, dot > 0 ? dot : name.length); });
  } else requestAnimationFrame(() => input.focus());
  input.addEventListener('mousedown', (e) => e.stopPropagation());
  input.addEventListener('click', (e) => e.stopPropagation());
  let done = false;
  const validate = () => {
    const v = input.value.trim();
    let err = null;
    if (/[\x00]/.test(v) || (env.platform === 'win32' && /[<>:"|?*]/.test(v))) err = 'The name contains invalid characters.';
    const dir = cur.kind === 'rename' ? dirname(cur.path) : cur.dir;
    const siblings = children.get(dir) || [];
    const first = v.split(/[\\/]/)[0];
    if (v && siblings.some((s) => s.name === first && s.path !== cur.path) && !(cur.kind !== 'rename' && v.includes('/') && siblings.find((s) => s.name === first)?.isDir)) err = `A file or folder ${first} already exists at this location. Please choose a different name.`;
    input.classList.toggle('invalid', !!err);
    input.title = err || '';
    return err;
  };
  input.addEventListener('input', validate);
  const finish = async (commit) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    editing = null;
    if (commit && v && !validate()) {
      try {
        if (cur.kind === 'rename') {
          if (v !== basename(cur.path)) {
            const target = join(dirname(cur.path), v);
            await window.snake.fs.rename(cur.path, target);
            handleRename(cur.path, target);
            renameTracked(cur.path, target);
            await loadDir(dirname(cur.path), true);
            selectOnly(target);
          }
        } else {
          const target = join(cur.dir, v);
          if (cur.kind === 'new-folder' || v.endsWith('/')) await window.snake.fs.mkdir(target);
          else await window.snake.fs.createFile(target);
          // expand intermediate folders created via "a/b/c.txt"
          let d = dirname(target);
          while (d.length > cur.dir.length) { expanded.add(d); d = dirname(d); }
          await loadDir(cur.dir, true);
          for (const x of [...expanded]) if (isInside(cur.dir, x)) await loadDir(x, true);
          selectOnly(target);
          if (cur.kind === 'new-file' && !v.endsWith('/')) openFile(target, { pinned: true });
        }
        invalidateFileList();
      } catch (err) {
        notify({ type: 'error', message: err.message });
      }
    }
    render();
    if (!(cur.kind === 'new-file' && commit)) treeEl.focus();
    updateWatchersSoon();
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
}

function renameTracked(from, to) {
  for (const p of [...expanded]) if (p === from || isInside(from, p)) { expanded.delete(p); expanded.add(to + p.slice(from.length)); }
  for (const p of [...children.keys()]) if (p === from || isInside(from, p)) children.delete(p);
}

// ---------------------------------------------------------------------------
// Selection & interaction
// ---------------------------------------------------------------------------
function rowPaths() {
  return visibleRows().filter((r) => r.entry).map((r) => r.entry.path);
}

function entryFor(path) {
  const list = children.get(dirname(path));
  return list?.find((e) => e.path === path) || (path === workspace.root ? { path, name: basename(path), isDir: true } : null);
}

function selectOnly(path) {
  selection.clear();
  if (path) selection.add(path);
  focused = path;
  anchor = path;
  scheduleRender();
  requestAnimationFrame(() => treeEl?.querySelector(`.tree-row[data-path="${CSS.escape(path || '')}"]`)?.scrollIntoView({ block: 'nearest' }));
}

async function toggleDir(path, force) {
  const open = force ?? !expanded.has(path);
  if (open) {
    expanded.add(path);
    await loadDir(path);
  } else expanded.delete(path);
  scheduleRender();
  updateWatchersSoon();
  persistExpanded();
}

const persistExpanded = debounce(() => {
  if (!workspace.root) return;
  const st = getState();
  st.explorer ||= {};
  st.explorer[workspace.root] = [...expanded].filter((p) => isInside(workspace.root, p)).slice(0, 300);
  saveState();
}, 1000);

function onRowClick(e, path) {
  const entry = entryFor(path);
  if (!entry) return;
  if (e.ctrlKey || e.metaKey) {
    selection.has(path) ? selection.delete(path) : selection.add(path);
    focused = path;
    anchor = path;
    scheduleRender();
    return;
  }
  if (e.shiftKey && anchor) {
    const paths = rowPaths();
    const a = paths.indexOf(anchor);
    const b = paths.indexOf(path);
    selection.clear();
    for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selection.add(paths[i]);
    focused = path;
    scheduleRender();
    return;
  }
  selectOnly(path);
  if (entry.isDir) toggleDir(path);
  else openFile(path, { preview: true, focus: false });
}

function selectedOrFocused(path) {
  if (path && !selection.has(path)) return [path];
  return selection.size ? [...selection] : path ? [path] : [];
}

function targetDir(path) {
  if (!path) return workspace.root;
  const e = entryFor(path);
  return e?.isDir ? path : dirname(path);
}

async function startNew(kind, path) {
  if (!workspace.root) return;
  showView('explorer');
  const dir = targetDir(path ?? (focused || null));
  if (dir !== workspace.root) { expanded.add(dir); await loadDir(dir); }
  rootSection.setCollapsed(false);
  editing = { kind, dir };
  render();
}

function startRename(path) {
  path ||= focused;
  if (!path || path === workspace.root) return;
  editing = { kind: 'rename', path };
  render();
}

async function deletePaths(paths, permanent = false) {
  paths = paths.filter((p) => p !== workspace.root);
  if (!paths.length) return;
  if (settings.get('explorer.confirmDelete') || permanent) {
    const what = paths.length === 1 ? `'${basename(paths[0])}'` : `the following ${paths.length} files/directories`;
    const r = await confirm(permanent ? `Are you sure you want to permanently delete ${what}?` : `Are you sure you want to delete ${what}?`, {
      detail: (paths.length > 1 ? paths.map((p) => basename(p)).slice(0, 10).join('\n') + '\n\n' : '') + (permanent ? 'This action is irreversible!' : 'You can restore from the Trash.'),
      buttons: [permanent ? 'Delete' : 'Move to Trash', 'Cancel'],
      type: 'warning',
      cancelId: 1,
    });
    if (r !== 0) return;
  }
  for (const p of paths) {
    try {
      if (permanent) await window.snake.fs.delete(p);
      else await window.snake.fs.trash(p);
      handleDelete(p);
      selection.delete(p);
      renameTracked(p, p + '\0deleted');
    } catch (err) {
      notify({ type: 'error', message: err.message });
    }
  }
  for (const d of new Set(paths.map(dirname))) await loadDir(d, true);
  invalidateFileList();
  render();
}

async function uniqueName(dir, name) {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  let candidate = name;
  let i = 1;
  while ((await window.snake.fs.stat(join(dir, candidate))).exists) {
    candidate = `${base} copy${i > 1 ? ' ' + i : ''}${ext}`;
    i++;
  }
  return join(dir, candidate);
}

async function paste(path) {
  if (!clipboard) return;
  const dir = targetDir(path);
  for (const src of clipboard.paths) {
    if (clipboard.cut && (dir === src || isInside(src, dir))) continue;
    try {
      if (clipboard.cut) {
        const target = join(dir, basename(src));
        if (target === src) continue;
        if ((await window.snake.fs.stat(target)).exists) { notify({ type: 'error', message: `'${basename(src)}' already exists in the destination.` }); continue; }
        await window.snake.fs.rename(src, target);
        handleRename(src, target);
        renameTracked(src, target);
        await loadDir(dirname(src), true);
      } else {
        const target = await uniqueName(dir, basename(src));
        await window.snake.fs.copy(src, target);
      }
    } catch (err) {
      notify({ type: 'error', message: err.message });
    }
  }
  if (clipboard.cut) clipboard = null;
  if (dir !== workspace.root) expanded.add(dir);
  await loadDir(dir, true);
  invalidateFileList();
  render();
}

async function moveInto(paths, dir) {
  paths = paths.filter((p) => dirname(p) !== dir && p !== dir && !isInside(p, dir));
  if (!paths.length) return;
  if (settings.get('explorer.confirmDragAndDrop')) {
    const what = paths.length === 1 ? `'${basename(paths[0])}'` : `${paths.length} files`;
    const r = await confirm(`Are you sure you want to move ${what} into '${basename(dir)}'?`, { buttons: ['Move', "Move and Don't Ask Again", 'Cancel'], cancelId: 2 });
    if (r === 2) return;
    if (r === 1) settings.set('explorer.confirmDragAndDrop', false);
  }
  for (const src of paths) {
    const target = join(dir, basename(src));
    try {
      if ((await window.snake.fs.stat(target)).exists) { notify({ type: 'error', message: `'${basename(src)}' already exists in '${basename(dir)}'.` }); continue; }
      await window.snake.fs.rename(src, target);
      handleRename(src, target);
      renameTracked(src, target);
      await loadDir(dirname(src), true);
    } catch (err) {
      notify({ type: 'error', message: err.message });
    }
  }
  await loadDir(dir, true);
  invalidateFileList();
  render();
}

function rowMenu(path) {
  const entry = path ? entryFor(path) : { isDir: true, path: workspace.root };
  const paths = selectedOrFocused(path);
  const multi = paths.length > 1;
  const isDir = entry?.isDir;
  const dir = targetDir(path);
  return [
    { label: 'New File...', run: () => startNew('new-file', path) },
    { label: 'New Folder...', run: () => startNew('new-folder', path) },
    { label: 'Reveal in File Manager', key: 'ctrl+alt+r', run: () => window.snake.shell.showItemInFolder(path || workspace.root) },
    { label: 'Open in Integrated Terminal', run: () => executeCommand('workbench.action.terminal.newInDir', dir) },
    { separator: true },
    { label: 'Open to the Side', hidden: isDir || multi, key: 'ctrl+enter', run: () => openFile(path, { sideBySide: true, pinned: true }) },
    { label: 'Open in New Window', hidden: !isDir || multi, run: () => window.snake.win.newWindow(path) },
    { label: 'Open with System Default', hidden: multi || !path, run: () => window.snake.shell.openPath(path) },
    { label: 'Find in Folder...', hidden: !isDir, key: 'shift+alt+f', run: () => executeCommand('workbench.action.findInFiles', { include: relative(workspace.root, path || workspace.root) ? relative(workspace.root, path) + '/**' : '' }) },
    { separator: true },
    { label: 'Select for Compare', hidden: isDir || multi || !path, run: () => { compareSource = path; } },
    { label: compareSource ? `Compare with '${basename(compareSource)}'` : 'Compare with Selected', hidden: isDir || multi || !path || !compareSource || compareSource === path, run: () => compareFiles(compareSource, path) },
    { label: 'Compare Selected', hidden: paths.length !== 2, run: () => compareFiles(paths[0], paths[1]) },
    { separator: true },
    { label: 'Cut', key: 'ctrl+x', hidden: !path, run: () => { clipboard = { paths, cut: true }; render(); } },
    { label: 'Copy', key: 'ctrl+c', hidden: !path, run: () => { clipboard = { paths, cut: false }; render(); } },
    { label: 'Paste', key: 'ctrl+v', disabled: !clipboard, run: () => paste(path) },
    { label: 'Duplicate', hidden: !path || multi, run: () => { clipboard = { paths, cut: false }; paste(dirname(path)); } },
    { separator: true },
    { label: 'Copy Path', key: 'ctrl+alt+c', run: () => window.snake.clipboard.write(paths.join('\n') || workspace.root) },
    { label: 'Copy Relative Path', key: 'ctrl+shift+alt+c', run: () => window.snake.clipboard.write(paths.map((p) => relative(workspace.root, p)).join('\n')) },
    { separator: true },
    { label: 'Rename...', key: 'f2', hidden: !path || multi, run: () => startRename(path) },
    { label: 'Delete', key: 'delete', hidden: !path, run: () => deletePaths(paths) },
    { label: 'Delete Permanently', key: 'shift+delete', hidden: !path, run: () => deletePaths(paths, true) },
  ];
}

async function compareFiles(a, b) {
  const [ra, rb] = await Promise.all([window.snake.fs.readFile(a), window.snake.fs.readFile(b)]);
  await openFile(b, { pinned: true, focus: false });
  const doc = getDocument(b);
  openDiff({ originalText: ra.content ?? '', doc, modifiedText: doc ? undefined : rb.content ?? '', path: b, title: `${basename(a)} ↔ ${basename(b)}`, key: `compare:${a}|${b}` });
}

function onKey(e) {
  if (editing) return;
  const paths = rowPaths();
  const idx = paths.indexOf(focused);
  const move = (i) => {
    const p = paths[Math.max(0, Math.min(paths.length - 1, i))];
    if (!p) return;
    if (e.shiftKey) { selection.add(p); focused = p; scheduleRender(); }
    else selectOnly(p);
    const entry = entryFor(p);
    if (entry && !entry.isDir && !e.shiftKey) openFile(p, { preview: true, focus: false });
  };
  const entry = focused ? entryFor(focused) : null;
  const mod = e.ctrlKey || e.metaKey;
  switch (e.key) {
    case 'ArrowDown': e.preventDefault(); move(idx + 1); break;
    case 'ArrowUp': e.preventDefault(); move(idx - 1); break;
    case 'Home': e.preventDefault(); move(0); break;
    case 'End': e.preventDefault(); move(paths.length - 1); break;
    case 'PageDown': e.preventDefault(); move(idx + 15); break;
    case 'PageUp': e.preventDefault(); move(idx - 15); break;
    case 'ArrowRight':
      e.preventDefault();
      if (entry?.isDir) { if (!expanded.has(focused)) toggleDir(focused, true); else move(idx + 1); }
      break;
    case 'ArrowLeft':
      e.preventDefault();
      if (entry?.isDir && expanded.has(focused)) toggleDir(focused, false);
      else if (focused && dirname(focused) !== workspace.root && dirname(focused) !== focused) selectOnly(dirname(focused));
      break;
    case 'Enter':
      e.preventDefault();
      if (!entry) break;
      if (mod && !entry.isDir) openFile(focused, { sideBySide: true, pinned: true });
      else if (entry.isDir) toggleDir(focused);
      else openFile(focused, { pinned: true });
      break;
    case ' ':
      e.preventDefault();
      if (entry && !entry.isDir) openFile(focused, { preview: true, focus: false });
      else if (entry) toggleDir(focused);
      break;
    case 'F2': e.preventDefault(); startRename(); break;
    case 'Delete': e.preventDefault(); deletePaths(selectedOrFocused(focused), e.shiftKey); break;
    case 'Escape': selection.clear(); clipboard = clipboard?.cut ? null : clipboard; scheduleRender(); break;
    default:
      if (mod && e.key.toLowerCase() === 'c' && !e.shiftKey) { e.preventDefault(); clipboard = { paths: selectedOrFocused(focused), cut: false }; }
      else if (mod && e.key.toLowerCase() === 'x') { e.preventDefault(); clipboard = { paths: selectedOrFocused(focused), cut: true }; render(); }
      else if (mod && e.key.toLowerCase() === 'v') { e.preventDefault(); paste(focused); }
      else if (mod && e.key.toLowerCase() === 'a') { e.preventDefault(); paths.forEach((p) => selection.add(p)); scheduleRender(); }
      else if (e.key.length === 1 && !mod && !e.altKey) {
        // type-to-navigate
        const ch = e.key.toLowerCase();
        const start = idx + 1;
        const order = [...paths.slice(start), ...paths.slice(0, start)];
        const hit = order.find((p) => basename(p).toLowerCase().startsWith(ch));
        if (hit) selectOnly(hit);
      }
  }
}

// ---------------------------------------------------------------------------
// Reveal / refresh
// ---------------------------------------------------------------------------
export async function reveal(path, focusTree = false) {
  if (!workspace.root || !path || !isInside(workspace.root, path)) return;
  let d = dirname(path);
  const chain = [];
  while (d.length > workspace.root.length && isInside(workspace.root, d)) { chain.unshift(d); d = dirname(d); }
  await loadDir(workspace.root);
  for (const c of chain) { expanded.add(c); await loadDir(c); }
  selectOnly(path);
  render();
  requestAnimationFrame(() => treeEl.querySelector(`.tree-row[data-path="${CSS.escape(path)}"]`)?.scrollIntoView({ block: 'center' }));
  updateWatchersSoon();
  if (focusTree) { showView('explorer'); rootSection.setCollapsed(false); treeEl.focus(); }
}

export async function refreshTree() {
  if (!workspace.root) return;
  const dirs = [workspace.root, ...[...expanded].filter((d) => children.has(d))];
  children.clear();
  for (const d of dirs) await loadDir(d, true);
  render();
}

export function collapseAll() {
  expanded.clear();
  render();
  updateWatchersSoon();
  persistExpanded();
}

export function newFile() { return startNew('new-file'); }
export function newFolder() { return startNew('new-folder'); }

// ---------------------------------------------------------------------------
// Open editors section
// ---------------------------------------------------------------------------
function renderOpenEditors() {
  const body = openEditorsSection.body;
  body.replaceChildren();
  const groups = getGroups();
  let count = 0;
  groups.forEach((g, gi) => {
    if (groups.length > 1) body.append(el('div.oe-group', {}, `Group ${gi + 1}`));
    for (const t of g.tabs) {
      count++;
      const name = t.doc ? t.doc.name : t.title || (t.kind === 'settings' ? 'Settings' : t.kind);
      const dirty = t.kind === 'text' && t.doc.dirty;
      const iconEl = t.doc ? fileIcon(t.doc.name) : el('span.file-icon.special', {}, icon(t.kind === 'diff' ? 'diff' : t.kind === 'settings' ? 'settings' : 'file'));
      const close = el('span.oe-close', { title: 'Close' }, icon('close'));
      close.addEventListener('click', (e) => { e.stopPropagation(); g.close(t); });
      const row = el(
        'div.oe-row.list-row' + (g.active === t ? '.active' : '') + (dirty ? '.dirty' : '') + (t.preview ? '.preview' : ''),
        { title: t.doc?.path || name },
        close,
        iconEl,
        el('span.oe-name', {}, name),
        el('span.oe-dir', {}, t.doc?.path && workspace.root ? relative(workspace.root, dirname(t.doc.path)).replace(/^\.$/, '') : t.description || ''),
      );
      row.addEventListener('click', () => { setActiveGroup(g); g.activate(t); });
      row.addEventListener('auxclick', (e) => { if (e.button === 1) g.close(t); });
      body.append(row);
    }
  });
  openEditorsSection.setCount(count);
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------
function buildExplorer(container) {
  openEditorsSection = section({
    title: 'Open Editors',
    collapsed: true,
    actions: [
      { icon: 'save-all', title: 'Save All', run: () => executeCommand('workbench.action.files.saveAll') },
      { icon: 'close-all', title: 'Close All Editors', run: () => executeCommand('workbench.action.closeAllEditors') },
    ],
  });
  rootSection = section({
    title: 'No Folder Opened',
    grow: true,
    actions: [
      { icon: 'new-file', title: 'New File...', run: () => startNew('new-file') },
      { icon: 'new-folder', title: 'New Folder...', run: () => startNew('new-folder') },
      { icon: 'refresh', title: 'Refresh Explorer', run: () => refreshTree() },
      { icon: 'collapse-all', title: 'Collapse Folders in Explorer', run: () => collapseAll() },
    ],
  });
  treeEl = el('div.tree', { tabindex: '0', role: 'tree' });
  const emptyEl = el(
    'div.explorer-empty',
    {},
    el('p', {}, 'You have not yet opened a folder.'),
    el('button.btn', { onclick: () => executeCommand('workbench.action.files.openFolder') }, 'Open Folder'),
    el('p', {}, 'Opening a folder will close all currently open editors. To keep them open, add a folder instead.'),
    el('button.btn', { onclick: () => executeCommand('git.clone') }, 'Clone Repository'),
  );
  rootSection.body.append(treeEl, emptyEl);
  container.append(openEditorsSection.el, rootSection.el);

  treeEl.addEventListener('click', (e) => {
    const row = e.target.closest('.tree-row');
    if (row?.dataset.path) onRowClick(e, row.dataset.path);
  });
  treeEl.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.tree-row');
    if (!row?.dataset.path) return;
    const entry = entryFor(row.dataset.path);
    if (entry && !entry.isDir) openFile(row.dataset.path, { pinned: true });
  });
  treeEl.addEventListener('auxclick', (e) => {
    const row = e.target.closest('.tree-row');
    if (e.button === 1 && row?.dataset.path && !entryFor(row.dataset.path)?.isDir) openFile(row.dataset.path, { pinned: true, sideBySide: e.ctrlKey });
  });
  treeEl.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.tree-row');
    const p = row?.dataset.path || null;
    if (p && !selection.has(p)) selectOnly(p);
    if (!workspace.root) return;
    contextMenu(e, rowMenu(p));
  });
  treeEl.addEventListener('keydown', onKey);

  // drag & drop
  let dragPaths = [];
  treeEl.addEventListener('dragstart', (e) => {
    const row = e.target.closest('.tree-row');
    if (!row) return;
    const p = row.dataset.path;
    dragPaths = selection.has(p) ? [...selection] : [p];
    e.dataTransfer.setData('application/x-snake-path', p);
    e.dataTransfer.setData('text/plain', dragPaths.join('\n'));
    e.dataTransfer.effectAllowed = 'copyMove';
  });
  let hoverTimer;
  treeEl.addEventListener('dragover', (e) => {
    const types = [...e.dataTransfer.types];
    if (!types.includes('application/x-snake-path') && !types.includes('Files')) return;
    e.preventDefault();
    const row = e.target.closest('.tree-row');
    const dir = row ? targetDir(row.dataset.path) : workspace.root;
    treeEl.querySelectorAll('.drop-target').forEach((x) => x.classList.remove('drop-target'));
    if (dir === workspace.root) treeEl.classList.add('drop-target-root');
    else {
      treeEl.classList.remove('drop-target-root');
      treeEl.querySelector(`.tree-row[data-path="${CSS.escape(dir)}"]`)?.classList.add('drop-target');
    }
    e.dataTransfer.dropEffect = types.includes('Files') ? 'copy' : 'move';
    clearTimeout(hoverTimer);
    if (row && entryFor(row.dataset.path)?.isDir && !expanded.has(row.dataset.path)) hoverTimer = setTimeout(() => toggleDir(row.dataset.path, true), 700);
  });
  treeEl.addEventListener('dragleave', (e) => {
    if (!treeEl.contains(e.relatedTarget)) {
      treeEl.classList.remove('drop-target-root');
      treeEl.querySelectorAll('.drop-target').forEach((x) => x.classList.remove('drop-target'));
    }
  });
  treeEl.addEventListener('drop', async (e) => {
    e.preventDefault();
    clearTimeout(hoverTimer);
    treeEl.classList.remove('drop-target-root');
    treeEl.querySelectorAll('.drop-target').forEach((x) => x.classList.remove('drop-target'));
    const row = e.target.closest('.tree-row');
    const dir = row ? targetDir(row.dataset.path) : workspace.root;
    if (e.dataTransfer.files.length) {
      // copy files from the OS into the folder
      for (const f of e.dataTransfer.files) {
        const src = window.snake.fs.pathForFile(f);
        if (!src) continue;
        if (isInside(workspace.root, src)) { await moveInto([src], dir); continue; }
        try { await window.snake.fs.copy(src, await uniqueName(dir, basename(src))); } catch (err) { notify({ type: 'error', message: err.message }); }
      }
      await loadDir(dir, true);
      render();
      return;
    }
    if (dragPaths.length) await moveInto(dragPaths, dir);
    dragPaths = [];
  });

  const update = () => {
    const has = !!workspace.root;
    rootSection.setTitle(has ? workspace.name.toUpperCase() : 'NO FOLDER OPENED');
    treeEl.style.display = has ? '' : 'none';
    emptyEl.style.display = has ? 'none' : '';
    rootSection.actionsEl.style.display = has ? '' : 'none';
  };
  update();

  bus.on('workspace:changed', async (root) => {
    children.clear();
    expanded.clear();
    selection.clear();
    focused = null;
    update();
    if (root) {
      const saved = getState().explorer?.[root] || [];
      await loadDir(root);
      for (const p of saved) { expanded.add(p); }
      await Promise.all(saved.map((p) => loadDir(p)));
      render();
    } else treeEl.replaceChildren();
    updateWatchers();
  });

  bus.on('fs:dirChanged', async ({ dir, paths }) => {
    if (children.has(dir)) {
      await loadDir(dir, true);
      // drop cached state for removed dirs
      for (const p of paths) {
        if (!children.get(dir).some((e) => e.path === p) && children.has(p)) { children.delete(p); expanded.delete(p); }
      }
      scheduleRender();
    }
  });
  bus.on('git:statusChanged', scheduleRender);
  bus.on('doc:dirty', scheduleRender);
  bus.on('editors:changed', () => { renderOpenEditors(); updateWatchersSoon(); scheduleRender(); });
  bus.on('editor:activeChanged', (input) => {
    const p = input?.doc?.path || input?.path;
    if (p && settings.get('explorer.autoReveal') && workspace.root && isInside(workspace.root, p)) {
      if (selection.size <= 1) reveal(p);
    }
  });
  bus.on('explorer:reveal', (p, f) => reveal(p, f));
  settings.onChange(['files.exclude', 'explorer.sortOrder', 'workbench.tree.indent', 'explorer.decorations.git'], () => refreshTree());

  return {
    actions: [],
    focus: () => { if (workspace.root) treeEl.focus(); },
  };
}

registerView({ id: 'explorer', title: 'Explorer', icon: 'files', order: 1, command: 'workbench.view.explorer', build: buildExplorer });
