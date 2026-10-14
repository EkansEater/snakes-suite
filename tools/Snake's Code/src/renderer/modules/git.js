// Git integration: status model, operations, and the Source Control view.
import { el, icon, bus, basename, dirname, join, relative, debounce, isInside, timeAgo } from './util.js';
import * as settings from './settings.js';
import { workspace } from './workspace.js';
import { notify, confirm, contextMenu, showMenu, pick, inputBox } from './ui.js';
import { registerView, section, setBadge, showView } from './sidebar.js';
import { openFile, openDiff, getDocument, setGitProviders, openUntitled, getGroups } from './editors.js';
import { fileIcon } from './icons.js';
import { executeCommand } from './commands.js';

export const git = {
  isRepo: false,
  root: null,
  branch: null,
  detached: false,
  upstream: null,
  ahead: 0,
  behind: 0,
  files: [], // { path, rel, origRel?, x, y }
  byPath: new Map(), // abs path -> decoration letter
  dirsWithChanges: new Set(),
  busy: false,
  hasCommits: true,
};

const headCache = new Map();

async function run(args, { cwd, quiet = false, env } = {}) {
  const dir = cwd || git.root || workspace.root;
  const res = await window.snake.git.run(dir, args, { env });
  if (!quiet) bus.emit('output:append', 'Git', `> git ${args.join(' ')}\n${res.stdout}${res.stderr}`);
  return res;
}

function letterFor(x, y) {
  const conflict = ['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU'];
  if (conflict.includes(x + y)) return '!';
  if (x === '?' && y === '?') return 'U';
  if (x === '!' && y === '!') return 'I';
  if (y === 'D' || x === 'D') return 'D';
  if (x === 'A') return 'A';
  if (x === 'R' || y === 'R') return 'R';
  return 'M';
}

export async function refresh() {
  const root = workspace.root;
  if (!root || !settings.get('git.enabled')) {
    Object.assign(git, { isRepo: false, root: null, branch: null, files: [], byPath: new Map(), dirsWithChanges: new Set() });
    emitChanged();
    return;
  }
  const top = await window.snake.git.run(root, ['rev-parse', '--show-toplevel']);
  if (top.code !== 0) {
    Object.assign(git, { isRepo: false, root: null, branch: null, files: [], byPath: new Map(), dirsWithChanges: new Set() });
    emitChanged();
    return;
  }
  const repoRoot = top.stdout.trim();
  const st = await window.snake.git.run(repoRoot, ['status', '--porcelain=v1', '-b', '-z', '--untracked-files=all']);
  if (st.code !== 0) return;
  const parts = st.stdout.split('\0');
  const files = [];
  let branchLine = '';
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (!entry) continue;
    if (entry.startsWith('## ')) { branchLine = entry.slice(3); continue; }
    const x = entry[0];
    const y = entry[1];
    const rel = entry.slice(3);
    let origRel;
    if (x === 'R' || x === 'C') origRel = parts[++i];
    files.push({ x, y, rel, origRel, path: join(repoRoot, rel) });
  }
  // "main...origin/main [ahead 1, behind 2]" | "No commits yet on main" | "HEAD (no branch)"
  let branch = branchLine;
  let upstream = null;
  let ahead = 0;
  let behind = 0;
  let hasCommits = true;
  const m = /^(?:No commits yet on |Initial commit on )(.+)$/.exec(branchLine);
  if (m) { branch = m[1]; hasCommits = false; }
  else {
    const mm = /^(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/.exec(branchLine);
    if (mm) {
      branch = mm[1];
      upstream = mm[2] || null;
      const info = mm[3] || '';
      ahead = +(/ahead (\d+)/.exec(info)?.[1] || 0);
      behind = +(/behind (\d+)/.exec(info)?.[1] || 0);
    }
  }
  const detached = branch.startsWith('HEAD');
  if (detached) {
    const h = await window.snake.git.run(repoRoot, ['rev-parse', '--short', 'HEAD']);
    branch = h.stdout.trim() || 'HEAD';
  }
  const byPath = new Map();
  const dirs = new Set();
  for (const f of files) {
    const letter = letterFor(f.x, f.y);
    f.letter = letter;
    byPath.set(f.path, letter);
    let d = dirname(f.path);
    while (d.length >= repoRoot.length && !dirs.has(d)) {
      dirs.add(d);
      const nd = dirname(d);
      if (nd === d) break;
      d = nd;
    }
  }
  const changedKey = JSON.stringify([repoRoot, branch, upstream, ahead, behind, files.map((f) => f.x + f.y + f.rel)]);
  const changed = changedKey !== git.lastKey;
  Object.assign(git, { isRepo: true, root: repoRoot, branch, detached, upstream, ahead, behind, files, byPath, dirsWithChanges: dirs, hasCommits, lastKey: changedKey });
  if (changed) {
    headCache.clear();
    emitChanged();
  }
}

function emitChanged() {
  bus.emit('git:statusChanged', git);
  refreshOpenDiffs();
  const count = git.files.filter((f) => f.letter !== 'I').length;
  setBadge('scm', count);
}

const refreshSoon = debounce(refresh, 600);

async function refreshOpenDiffs() {
  if (!git.isRepo) return;
  for (const g of getGroups()) {
    for (const t of g.tabs) {
      if (t.kind !== 'diff' || !t.key.startsWith('git-diff:') || !t.doc) continue;
      const f = git.files.find((x) => x.path === t.path);
      const rel = relative(git.root, t.path).replace(/\\/g, '/');
      const orig = f && (f.x === 'A' || f.x === 'M' || f.x === 'R') ? await indexContent(rel) : await showAt('HEAD', rel);
      if (!t.original.isDisposed() && t.original.getValue() !== orig) t.original.setValue(orig);
    }
  }
}

/** Decoration for a path: a status letter for files, or 'dot' for folders containing changes. */
export function statusFor(path) {
  if (!git.isRepo || !settings.get('explorer.decorations.git')) return null;
  return git.byPath.get(path) || null;
}
export function folderHasChanges(path) {
  return git.isRepo && git.dirsWithChanges.has(path);
}

export async function headContent(path) {
  if (!git.isRepo || !isInside(git.root, path)) return null;
  if (headCache.has(path)) return headCache.get(path);
  const letter = git.byPath.get(path);
  if (letter === 'U' || letter === 'A' || !git.hasCommits) { headCache.set(path, null); return null; }
  const rel = relative(git.root, path).replace(/\\/g, '/');
  const res = await window.snake.git.run(git.root, ['show', `HEAD:${rel}`]);
  const content = res.code === 0 ? res.stdout : null;
  headCache.set(path, content);
  return content;
}

async function indexContent(rel) {
  const res = await window.snake.git.run(git.root, ['show', `:${rel}`]);
  return res.code === 0 ? res.stdout : '';
}

async function showAt(ref, rel) {
  const res = await window.snake.git.run(git.root, ['show', `${ref}:${rel}`]);
  return res.code === 0 ? res.stdout : '';
}

setGitProviders({
  original: (p) => headContent(p),
  status: (p) => statusFor(p),
});

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------
async function op(label, fn) {
  git.busy = true;
  bus.emit('git:busy', true, label);
  try {
    return await fn();
  } finally {
    git.busy = false;
    bus.emit('git:busy', false);
    await refresh();
  }
}

function fail(res, what) {
  if (res.code !== 0) {
    notify({ type: 'error', message: `Git: ${what} failed.`, detail: (res.stderr || res.stdout).trim().slice(0, 600), actions: [{ label: 'Show Output', run: () => executeCommand('workbench.action.output.show') }] });
    return true;
  }
  return false;
}

export const stage = (files) => op('stage', async () => fail(await run(['add', '-A', '--', ...files.map((f) => f.rel)]), 'stage'));
export const unstage = (files) =>
  op('unstage', async () => {
    const args = git.hasCommits ? ['restore', '--staged', '--', ...files.map((f) => f.rel)] : ['rm', '--cached', '-r', '-q', '--', ...files.map((f) => f.rel)];
    fail(await run(args), 'unstage');
  });

export async function discard(files) {
  if (!files.length) return;
  const untracked = files.filter((f) => f.letter === 'U');
  const tracked = files.filter((f) => f.letter !== 'U');
  const msg = files.length === 1 ? `Are you sure you want to discard changes in '${basename(files[0].rel)}'?` : `Are you sure you want to discard ALL changes in ${files.length} files?`;
  const r = await confirm(msg, { detail: untracked.length ? 'Untracked files will be moved to the trash.' : 'This is IRREVERSIBLE! Your current working set will be FOREVER LOST.', buttons: ['Discard', 'Cancel'], type: 'warning', cancelId: 1 });
  if (r !== 0) return;
  await op('discard', async () => {
    if (tracked.length) fail(await run(['checkout', '--', ...tracked.map((f) => f.origRel && f.x === 'R' ? f.rel : f.rel)]), 'discard');
    for (const f of untracked) { try { await window.snake.fs.trash(f.path); } catch {} }
  });
  for (const f of files) {
    const doc = getDocument(f.path);
    if (doc && !doc.dirty) bus.emit('fs:changed', [f.path]);
  }
}

export async function commit({ all = false, amend = false, message } = {}) {
  if (!git.isRepo) return;
  let msg = message ?? scm?.getMessage();
  const staged = git.files.filter((f) => isStaged(f));
  if (!amend && !msg?.trim()) {
    msg = await inputBox({ prompt: 'Commit message', placeholder: `Message (commit on '${git.branch}')` });
    if (!msg?.trim()) return;
  }
  let commitAll = all;
  if (!amend && !all && !staged.length) {
    if (!git.files.length) { notify('There are no changes to commit.'); return; }
    if (!settings.get('git.enableSmartCommit')) {
      const r = await confirm('There are no staged changes to commit.', { detail: 'Would you like to stage all your changes and commit them directly?', buttons: ['Yes', 'Always', 'Cancel'], cancelId: 2 });
      if (r === 2) return;
      if (r === 1) settings.set('git.enableSmartCommit', true);
    }
    commitAll = true;
  }
  await op('commit', async () => {
    if (commitAll) {
      const r = await run(['add', '-A']);
      if (fail(r, 'stage')) return;
    }
    const args = ['commit'];
    if (amend) args.push('--amend');
    if (msg?.trim()) args.push('-m', msg);
    else if (amend) args.push('--no-edit');
    const res = await run(args);
    if (fail(res, 'commit')) return;
    scm?.setMessage('');
    notify({ type: 'success', message: `Committed to ${git.branch}${amend ? ' (amended)' : ''}.`, timeout: 2500 });
    refreshLog();
  });
}

async function remoteOp(name, args) {
  return op(name, async () => {
    const n = notify({ message: `Git: ${name}...`, progress: true, transient: true });
    const res = await run(args);
    n.close();
    if (!fail(res, name)) notify({ type: 'success', message: `Git: ${name} completed.`, timeout: 2000, transient: true });
    refreshLog();
  });
}

export const pull = () => remoteOp('Pull', ['pull', '--no-rebase']);
export const fetch = () => remoteOp('Fetch', ['fetch', '--all', '--prune']);
export async function push() {
  if (!git.upstream) {
    const remotes = (await run(['remote'], { quiet: true })).stdout.split('\n').filter(Boolean);
    if (!remotes.length) { notify({ type: 'warning', message: 'Your repository has no remotes configured to push to.' }); return; }
    const remote = remotes.length === 1 ? remotes[0] : (await pick(remotes.map((r) => ({ label: r })), { placeholder: 'Pick a remote to publish the branch to' }))?.label;
    if (!remote) return;
    return remoteOp('Publish Branch', ['push', '-u', remote, git.branch]);
  }
  return remoteOp('Push', ['push']);
}
export async function sync() {
  if (settings.get('git.confirmSync')) {
    const r = await confirm(`This action will pull and push commits from and to '${git.upstream || 'origin'}'.`, { buttons: ['OK', "OK, Don't Show Again", 'Cancel'], cancelId: 2 });
    if (r === 2) return;
    if (r === 1) settings.set('git.confirmSync', false);
  }
  await remoteOp('Pull', ['pull', '--no-rebase']);
  await remoteOp('Push', ['push']);
}

export async function checkout() {
  if (!git.isRepo) return;
  const res = await run(['for-each-ref', '--sort=-committerdate', '--format=%(refname:short)%09%(objectname:short)%09%(committerdate:relative)%09%(refname)', 'refs/heads', 'refs/remotes', 'refs/tags'], { quiet: true });
  const items = [
    { label: 'Create new branch...', icon: 'add', action: 'create', alwaysShow: true },
    { label: 'Create new branch from...', icon: 'add', action: 'createFrom', alwaysShow: true },
    { label: 'Checkout detached...', icon: 'debug-disconnect', action: 'detached', alwaysShow: true },
  ];
  const lines = res.stdout.split('\n').filter(Boolean);
  let sepShown = { heads: false, remotes: false, tags: false };
  for (const l of lines) {
    const [name, hash, date, full] = l.split('\t');
    if (full.endsWith('/HEAD')) continue;
    const kind = full.startsWith('refs/heads') ? 'heads' : full.startsWith('refs/remotes') ? 'remotes' : 'tags';
    items.push({
      label: name,
      description: `${hash} · ${date}`,
      icon: kind === 'heads' ? 'git-branch' : kind === 'remotes' ? 'cloud' : 'tag',
      ref: name,
      kind,
      separator: sepShown[kind] ? undefined : kind === 'heads' ? 'branches' : kind === 'remotes' ? 'remote branches' : 'tags',
    });
    sepShown[kind] = true;
  }
  const chosen = await pick(items, { placeholder: 'Select a ref to checkout', matchOnDescription: true });
  if (!chosen) return;
  if (chosen.action === 'create') return createBranch();
  if (chosen.action === 'createFrom') {
    const from = await pick(items.filter((i) => i.ref), { placeholder: 'Select a ref to create the branch from' });
    if (from) return createBranch(from.ref);
    return;
  }
  if (chosen.action === 'detached') {
    const from = await pick(items.filter((i) => i.ref), { placeholder: 'Select a ref to checkout in detached mode' });
    if (from) await op('checkout', async () => fail(await run(['checkout', '--detach', from.ref]), 'checkout'));
    return;
  }
  if (chosen.kind === 'remotes') {
    const local = chosen.ref.split('/').slice(1).join('/');
    await op('checkout', async () => fail(await run(['checkout', '-b', local, '--track', chosen.ref]), 'checkout'));
  } else await op('checkout', async () => fail(await run(['checkout', chosen.ref]), 'checkout'));
  refreshLog();
  bus.emit('git:checkedOut');
}

export async function createBranch(from) {
  const name = await inputBox({
    prompt: 'Branch name',
    placeholder: 'Please provide a new branch name',
    validate: (v) => (/^(?!\/|.*([/.]\.|\/\/|@\{|\\))[^\x00-\x20~^:?*[]+(?<![/.])$/.test(v.trim()) ? null : 'Invalid branch name'),
  });
  if (!name) return;
  await op('branch', async () => fail(await run(['checkout', '-b', name.trim(), ...(from ? [from] : [])]), 'create branch'));
  refreshLog();
}

export async function deleteBranch() {
  const res = await run(['branch', '--format=%(refname:short)'], { quiet: true });
  const items = res.stdout.split('\n').filter((b) => b && b !== git.branch).map((b) => ({ label: b, icon: 'git-branch' }));
  const chosen = await pick(items, { placeholder: 'Select a branch to delete' });
  if (!chosen) return;
  let r = await run(['branch', '-d', chosen.label]);
  if (r.code !== 0 && /not fully merged/.test(r.stderr)) {
    const c = await confirm(`The branch '${chosen.label}' is not fully merged. Delete anyway?`, { buttons: ['Delete Branch', 'Cancel'], type: 'warning', cancelId: 1 });
    if (c === 0) r = await run(['branch', '-D', chosen.label]);
  }
  if (!fail(r, 'delete branch')) notify({ message: `Deleted branch ${chosen.label}.`, timeout: 2000 });
}

export async function mergeBranch() {
  const res = await run(['branch', '-a', '--format=%(refname:short)'], { quiet: true });
  const items = res.stdout.split('\n').filter((b) => b && b !== git.branch).map((b) => ({ label: b, icon: 'git-merge' }));
  const chosen = await pick(items, { placeholder: 'Select a branch to merge into the current branch' });
  if (!chosen) return;
  await op('merge', async () => fail(await run(['merge', chosen.label]), 'merge'));
  refreshLog();
}

export const stash = (pop = false) =>
  op('stash', async () => {
    if (pop) fail(await run(['stash', 'pop']), 'stash pop');
    else {
      const msg = await inputBox({ prompt: 'Stash message (optional)', placeholder: 'Message' });
      if (msg === null) return;
      fail(await run(['stash', 'push', '-u', ...(msg ? ['-m', msg] : [])]), 'stash');
    }
  });

export const undoLastCommit = () =>
  op('undo', async () => {
    const r = await confirm('Undo the last commit? The changes will be kept staged.', { buttons: ['Undo Commit', 'Cancel'], cancelId: 1 });
    if (r === 0) fail(await run(['reset', '--soft', 'HEAD~1']), 'undo last commit');
    refreshLog();
  });

export async function init() {
  if (!workspace.root) { notify({ type: 'warning', message: 'Open a folder first to initialize a repository.' }); return; }
  await op('init', async () => fail(await run(['init'], { cwd: workspace.root }), 'init'));
  refreshLog();
}

export async function clone() {
  const url = await inputBox({ prompt: 'Repository URL', placeholder: 'https://github.com/user/repo.git' });
  if (!url) return;
  const parent = await window.snake.dialog.openFolder('Choose a folder to clone into');
  if (!parent) return;
  const name = basename(url.replace(/\.git$/, '').replace(/\/$/, ''));
  const n = notify({ message: `Cloning ${url}...`, progress: true, transient: true });
  const res = await window.snake.git.run(parent, ['clone', '--progress', url, name]);
  n.close();
  bus.emit('output:append', 'Git', `> git clone ${url}\n${res.stdout}${res.stderr}`);
  if (fail(res, 'clone')) return;
  const target = join(parent, name);
  notify({ type: 'success', message: `Cloned into ${target}.`, actions: [{ label: 'Open', run: () => bus.emit('workspace:openFolderRequest', target) }, { label: 'Open in New Window', secondary: true, run: () => window.snake.win.newWindow(target) }] });
}

/** Open the diff view for a changed file. */
export async function openChange(f, staged = false) {
  if (typeof f === 'string') {
    f = git.files.find((x) => x.path === f);
    if (!f) {
      const doc = getDocument(arguments[0]);
      if (doc && git.isRepo) {
        const orig = await headContent(doc.path);
        if (orig == null) return notify({ message: 'This file has no changes compared to HEAD.' });
        return openDiff({ originalText: orig, doc, title: `${doc.name} (HEAD) ↔ ${doc.name}`, key: 'git-diff:' + doc.path });
      }
      return notify({ message: 'This file has no git changes.' });
    }
    staged = isStaged(f) && f.y === ' ';
  }
  const name = basename(f.rel);
  if (f.letter === 'U') return openFile(f.path, { pinned: true });
  if (staged) {
    const orig = f.x === 'A' ? '' : await showAt('HEAD', f.origRel || f.rel);
    const idx = f.x === 'D' ? '' : await indexContent(f.rel);
    return openDiff({ originalText: orig, modifiedText: idx, path: f.path, title: `${name} (Index)`, description: 'Staged', key: 'git-staged:' + f.path });
  }
  const orig = f.x === 'A' || f.x === 'M' || f.x === 'R' ? await indexContent(f.rel) : await showAt('HEAD', f.rel);
  if (f.y === 'D' || f.x === 'D') return openDiff({ originalText: orig, modifiedText: '', path: f.path, title: `${name} (Deleted)`, key: 'git-diff:' + f.path });
  // compare against the editable working copy
  await openFile(f.path, { pinned: true, focus: false, noRecent: true });
  const doc = getDocument(f.path);
  if (!doc) return;
  openDiff({ originalText: orig, doc, title: `${name} (Working Tree)`, key: 'git-diff:' + f.path });
}

function isStaged(f) {
  return f.x !== ' ' && f.x !== '?' && f.x !== '!';
}
function isUnstaged(f) {
  return f.y !== ' ' || f.x === '?';
}

// ---------------------------------------------------------------------------
// Source Control view
// ---------------------------------------------------------------------------
let scm = null;
let logEntries = [];

async function refreshLog() {
  if (!git.isRepo || !git.hasCommits) { logEntries = []; scm?.renderLog(); return; }
  const res = await run(['log', '-n', '80', '--date=unix', '--pretty=format:%h%x09%an%x09%ad%x09%D%x09%s'], { quiet: true });
  logEntries = res.stdout.split('\n').filter(Boolean).map((l) => {
    const [hash, author, date, refs, ...subject] = l.split('\t');
    return { hash, author, date: +date * 1000, refs, subject: subject.join('\t') };
  });
  scm?.renderLog();
}

async function showCommit(entry) {
  const res = await run(['show', '--stat', '--patch', '--format=commit %H%nAuthor: %an <%ae>%nDate:   %ad%n%n%w(0,4,4)%B', entry.hash], { quiet: true });
  openUntitled(res.stdout, 'diff');
}

function buildScmView(container) {
  const statusArea = el('div.scm-status');
  const msg = el('textarea.scm-input', { rows: '1', placeholder: 'Message (Ctrl+Enter to commit)', spellcheck: 'true' });
  const autosize = () => { msg.style.height = 'auto'; msg.style.height = Math.min(msg.scrollHeight, 200) + 'px'; };
  msg.addEventListener('input', autosize);
  msg.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); }
  });
  const commitBtn = el('button.btn.scm-commit', { onclick: () => commit() }, icon('check'), el('span', {}, 'Commit'));
  const commitMore = el('button.btn.scm-commit-more', {
    title: 'More Commit Actions',
    onclick: (e) => {
      const r = e.currentTarget.getBoundingClientRect();
      showMenu([
        { label: 'Commit', run: () => commit() },
        { label: 'Commit All', run: () => commit({ all: true }) },
        { label: 'Commit (Amend)', run: () => commit({ amend: true }) },
        { separator: true },
        { label: 'Commit & Push', run: async () => { await commit(); await push(); } },
        { label: 'Commit & Sync', run: async () => { await commit(); await sync(); } },
      ], { x: r.left, y: r.bottom + 2 });
    },
  }, icon('chevron-down'));
  const syncBtn = el('button.btn.secondary.scm-sync', { onclick: () => (git.upstream ? sync() : push()) });
  const inputArea = el('div.scm-input-area', {}, msg, el('div.scm-buttons', {}, commitBtn, commitMore), syncBtn);

  const noRepo = el(
    'div.scm-empty',
    {},
    el('p', {}, 'The folder currently open doesn\'t have a git repository. You can initialize a repository which will enable source control features powered by git.'),
    el('button.btn', { onclick: () => init() }, 'Initialize Repository'),
    el('p', {}, 'You can also clone a repository from a URL.'),
    el('button.btn', { onclick: () => clone() }, 'Clone Repository'),
  );
  const noFolder = el('div.scm-empty', {}, el('p', {}, 'Open a folder that contains a git repository, or clone from a URL.'), el('button.btn', { onclick: () => executeCommand('workbench.action.files.openFolder') }, 'Open Folder'), el('button.btn', { onclick: () => clone() }, 'Clone Repository'));

  const mergeSec = section({ title: 'Merge Changes', actions: [{ icon: 'add', title: 'Stage All Merge Changes', run: () => stage(git.files.filter((f) => f.letter === '!')) }] });
  const stagedSec = section({ title: 'Staged Changes', actions: [{ icon: 'remove', title: 'Unstage All Changes', run: () => unstage(git.files.filter(isStaged)) }] });
  const changesSec = section({
    title: 'Changes',
    actions: [
      { icon: 'discard', title: 'Discard All Changes', run: () => discard(git.files.filter((f) => isUnstaged(f) && f.letter !== '!')) },
      { icon: 'add', title: 'Stage All Changes', run: () => stage(git.files.filter((f) => isUnstaged(f) && f.letter !== '!')) },
    ],
  });
  const logSec = section({ title: 'Commits', collapsed: false, actions: [{ icon: 'refresh', title: 'Refresh', run: () => refreshLog() }] });
  const lists = el('div.scm-lists', {}, mergeSec.el, stagedSec.el, changesSec.el, logSec.el);
  container.append(noFolder, noRepo, statusArea, inputArea, lists);
  container.classList.add('scm-view');


  const renderFile = (f, staged) => {
    const name = basename(f.rel);
    const dir = dirname(f.rel);
    const row = el('div.scm-item.list-row', { title: `${f.rel} • ${statusLabel(f.letter, staged)}`, dataset: { git: staged ? (f.x === 'A' ? 'A' : f.x === 'D' ? 'D' : f.x === 'R' ? 'R' : 'M') : f.letter } });
    const actions = el('span.row-actions');
    const act = (ic, title, fn) => actions.append(el('span.action-btn', { title, onclick: (e) => { e.stopPropagation(); fn(); } }, icon(ic)));
    act('go-to-file', 'Open File', () => openFile(f.path, { pinned: true }));
    if (staged) act('remove', 'Unstage Changes', () => unstage([f]));
    else {
      if (f.letter !== '!') act('discard', 'Discard Changes', () => discard([f]));
      act('add', 'Stage Changes', () => stage([f]));
    }
    const letter = staged ? (f.x === '?' ? 'U' : f.x === ' ' ? 'M' : f.x) : f.letter === 'U' ? 'U' : f.y === ' ' ? f.x : f.y;
    row.append(fileIcon(name), el('span.scm-name' + (f.letter === 'D' || (staged && f.x === 'D') ? '.strike' : ''), {}, name), el('span.scm-dir', {}, dir === '.' ? '' : dir), actions, el('span.scm-letter', {}, letter === '!' ? 'C' : letter));
    row.addEventListener('click', () => openChange(f, staged));
    row.addEventListener('contextmenu', (e) =>
      contextMenu(e, [
        { label: 'Open Changes', run: () => openChange(f, staged) },
        { label: 'Open File', run: () => openFile(f.path, { pinned: true }) },
        { separator: true },
        staged ? { label: 'Unstage Changes', run: () => unstage([f]) } : { label: 'Stage Changes', run: () => stage([f]) },
        !staged ? { label: 'Discard Changes', run: () => discard([f]) } : null,
        { separator: true },
        { label: 'Add to .gitignore', hidden: f.letter !== 'U', run: () => addToGitignore(f) },
        { label: 'Reveal in Explorer View', run: () => bus.emit('explorer:reveal', f.path, true) },
        { label: 'Copy Path', run: () => window.snake.clipboard.write(f.path) },
      ]),
    );
    return row;
  };

  const render = () => {
    const hasFolder = !!workspace.root;
    noFolder.style.display = hasFolder ? 'none' : '';
    noRepo.style.display = hasFolder && !git.isRepo ? '' : 'none';
    const show = git.isRepo;
    inputArea.style.display = show ? '' : 'none';
    lists.style.display = show ? '' : 'none';
    statusArea.style.display = 'none';
    if (!show) return;
    msg.placeholder = `Message (Ctrl+Enter to commit on '${git.branch}')`;
    const merge = git.files.filter((f) => f.letter === '!');
    const staged = git.files.filter((f) => isStaged(f) && f.letter !== '!');
    const changes = git.files.filter((f) => isUnstaged(f) && f.letter !== '!');
    mergeSec.el.style.display = merge.length ? '' : 'none';
    stagedSec.el.style.display = staged.length ? '' : 'none';
    mergeSec.setTitle(`Merge Changes`);
    mergeSec.body.replaceChildren(...merge.map((f) => renderFile(f, false)));
    stagedSec.setTitle(`Staged Changes`);
    stagedSec.setCount(staged.length);
    changesSec.setCount(changes.length);
    mergeSec.setCount(merge.length);
    stagedSec.body.replaceChildren(...staged.map((f) => renderFile(f, true)));
    changesSec.body.replaceChildren(...(changes.length ? changes.map((f) => renderFile(f, false)) : [el('div.scm-none', {}, 'No changes.')]));
    // sync button
    if (git.upstream) {
      syncBtn.replaceChildren(icon('sync'), el('span', {}, `Sync Changes ${git.behind ? git.behind + '↓ ' : ''}${git.ahead ? git.ahead + '↑' : ''}`));
      syncBtn.style.display = git.ahead || git.behind ? '' : 'none';
    } else {
      syncBtn.replaceChildren(icon('cloud-upload'), el('span', {}, 'Publish Branch'));
      syncBtn.style.display = git.hasCommits ? '' : 'none';
    }
    commitBtn.disabled = git.busy;
  };

  const renderLog = () => {
    logSec.body.replaceChildren(
      ...logEntries.map((c) => {
        const refs = c.refs ? c.refs.split(', ').filter(Boolean).map((r) => el('span.scm-ref' + (r.startsWith('HEAD') ? '.head' : r.startsWith('tag:') ? '.tag' : r.includes('/') ? '.remote' : ''), {}, r.replace('HEAD -> ', ''))) : [];
        const row = el('div.scm-commit.list-row', { title: `${c.hash} • ${c.author} • ${new Date(c.date).toLocaleString()}\n\n${c.subject}` }, el('span.scm-graph-dot'), el('span.scm-commit-subject', {}, c.subject), ...refs, el('span.scm-dir', {}, `${c.author}, ${timeAgo(c.date)}`));
        row.addEventListener('click', () => showCommit(c));
        row.addEventListener('contextmenu', (e) =>
          contextMenu(e, [
            { label: 'Open Commit', run: () => showCommit(c) },
            { label: 'Copy Commit Hash', run: () => window.snake.clipboard.write(c.hash) },
            { label: 'Copy Commit Message', run: () => window.snake.clipboard.write(c.subject) },
            { separator: true },
            { label: 'Checkout (Detached)', run: () => op('checkout', async () => fail(await run(['checkout', '--detach', c.hash]), 'checkout')) },
            { label: 'Create Branch from Commit...', run: () => createBranch(c.hash) },
            { label: 'Revert Commit', run: () => op('revert', async () => { fail(await run(['revert', '--no-edit', c.hash]), 'revert'); refreshLog(); }) },
          ]),
        );
        return row;
      }),
    );
    if (!logEntries.length) logSec.body.append(el('div.scm-none', {}, 'No commits yet.'));
  };

  bus.on('git:statusChanged', render);
  bus.on('git:busy', (b) => { container.classList.toggle('busy', b); commitBtn.disabled = b; });
  bus.on('workspace:changed', () => { render(); refreshLog(); });
  render();

  scm = {
    getMessage: () => msg.value,
    setMessage: (v) => { msg.value = v; autosize(); },
    renderLog,
  };

  return {
    actions: [
      { icon: 'check', title: 'Commit (Ctrl+Enter)', run: () => commit() },
      { icon: 'refresh', title: 'Refresh', run: () => { refresh(); refreshLog(); } },
      { icon: 'ellipsis', title: 'More Actions...', run: (e) => { const r = e.currentTarget.getBoundingClientRect(); showMenu(moreMenu(), { x: r.left, y: r.bottom + 2 }); } },
    ],
    onShow: () => { refresh(); refreshLog(); },
    focus: () => msg.focus(),
  };
}

function moreMenu() {
  return [
    { label: 'Pull', run: pull },
    { label: 'Push', run: push },
    { label: 'Fetch', run: fetch },
    { label: 'Sync', run: sync },
    { separator: true },
    { label: 'Checkout to...', run: checkout },
    { label: 'Branch', submenu: [
      { label: 'Create Branch...', run: () => createBranch() },
      { label: 'Delete Branch...', run: deleteBranch },
      { label: 'Merge Branch...', run: mergeBranch },
    ] },
    { label: 'Commit', submenu: [
      { label: 'Commit', run: () => commit() },
      { label: 'Commit All', run: () => commit({ all: true }) },
      { label: 'Commit (Amend)', run: () => commit({ amend: true }) },
      { label: 'Undo Last Commit', run: undoLastCommit },
    ] },
    { label: 'Changes', submenu: [
      { label: 'Stage All Changes', run: () => stage(git.files.filter(isUnstaged)) },
      { label: 'Unstage All Changes', run: () => unstage(git.files.filter(isStaged)) },
      { label: 'Discard All Changes', run: () => discard(git.files.filter(isUnstaged)) },
    ] },
    { label: 'Stash', submenu: [
      { label: 'Stash (Include Untracked)', run: () => stash(false) },
      { label: 'Pop Latest Stash', run: () => stash(true) },
    ] },
    { separator: true },
    { label: 'Show Git Output', run: () => executeCommand('workbench.action.output.show') },
  ];
}

async function addToGitignore(f) {
  const file = join(git.root, '.gitignore');
  const res = await window.snake.fs.readFile(file).catch(() => ({ content: '' }));
  const content = res.content || '';
  await window.snake.fs.writeFile(file, content + (content && !content.endsWith('\n') ? '\n' : '') + f.rel + '\n');
  refresh();
}

function statusLabel(letter, staged) {
  const base = { M: 'Modified', A: 'Added', D: 'Deleted', U: 'Untracked', R: 'Renamed', '!': 'Conflict', I: 'Ignored' }[letter] || 'Modified';
  return staged ? `Index ${base}` : base;
}

registerView({ id: 'scm', title: 'Source Control', icon: 'source-control', order: 3, command: 'workbench.view.scm', build: buildScmView });

// ---------------------------------------------------------------------------
// Refresh triggers
// ---------------------------------------------------------------------------
export function initGit() {
  bus.on('workspace:changed', () => { headCache.clear(); refresh(); });
  bus.on('fs:changed', () => { if (settings.get('git.autoRefresh')) refreshSoon(); });
  bus.on('doc:saved', () => refreshSoon());
  window.addEventListener('focus', () => refreshSoon());
  setInterval(() => { if (document.hasFocus() && settings.get('git.autoRefresh')) refresh(); }, 5000);
  setInterval(() => { if (settings.get('git.autofetch') && git.upstream) run(['fetch'], { quiet: true }).then(refresh); }, 180000);
  settings.onChange(['git.enabled', 'explorer.decorations.git'], () => { git.lastKey = null; refresh(); });
}

export { refreshLog, showView as showScm };
