// Search view: find & replace across files (ripgrep-backed).
import * as monaco from 'monaco-editor';
import { el, icon, bus, basename, dirname, relative, debounce } from './util.js';
import * as settings from './settings.js';
import { workspace } from './workspace.js';
import { registerView, showView } from './sidebar.js';
import { fileIcon } from './icons.js';
import { notify, confirm, contextMenu } from './ui.js';
import { openFile, getDocument, saveDocument, openDiff } from './editors.js';

let ui = null;
let lastResults = null;
let collapsedFiles = new Set();
let searchSeq = 0;

function toggleBtn(name, title) {
  const b = el('span.input-toggle', { title, tabindex: '-1' }, icon(name));
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', () => { b.classList.toggle('on'); ui?.run(); });
  return b;
}

function buildSearch(container) {
  container.classList.add('search-view');
  const query = el('textarea.search-input', { rows: '1', placeholder: 'Search', spellcheck: 'false' });
  const caseBtn = toggleBtn('case-sensitive', 'Match Case (Alt+C)');
  const wordBtn = toggleBtn('whole-word', 'Match Whole Word (Alt+W)');
  const regexBtn = toggleBtn('regex', 'Use Regular Expression (Alt+R)');
  const replace = el('textarea.search-input', { rows: '1', placeholder: 'Replace', spellcheck: 'false' });
  const preserveCase = toggleBtn('preserve-case', 'Preserve Case (Alt+P)');
  const replaceAllBtn = el('span.action-btn', { title: 'Replace All (Ctrl+Alt+Enter)' }, icon('replace-all'));
  const replaceToggle = el('span.search-replace-toggle', { title: 'Toggle Replace' }, icon('chevron-right'));
  const include = el('input.search-small', { placeholder: 'e.g. *.ts, src/**/include', spellcheck: 'false' });
  const exclude = el('input.search-small', { placeholder: 'e.g. *.ts, src/**/exclude', spellcheck: 'false' });
  const useIgnore = el('span.input-toggle.on', { title: 'Use Exclude Settings and Ignore Files' }, icon('exclude'));
  useIgnore.addEventListener('click', () => { useIgnore.classList.toggle('on'); run(); });
  const details = el('div.search-details', {}, el('label', {}, 'files to include'), el('div.search-field', {}, include), el('label', {}, 'files to exclude'), el('div.search-field', {}, exclude, useIgnore));
  details.style.display = 'none';
  const detailsToggle = el('span.action-btn.search-details-toggle', { title: 'Toggle Search Details' }, icon('ellipsis'));
  detailsToggle.addEventListener('click', () => { details.style.display = details.style.display === 'none' ? '' : 'none'; });
  const replaceRow = el('div.search-field.replace-row', {}, replace, preserveCase, replaceAllBtn);
  replaceRow.style.display = 'none';
  const message = el('div.search-message');
  const results = el('div.search-results', { tabindex: '0' });
  const form = el(
    'div.search-form',
    {},
    replaceToggle,
    el('div.search-fields', {}, el('div.search-field', {}, query, caseBtn, wordBtn, regexBtn), replaceRow),
  );
  container.append(form, el('div.search-details-row', {}, detailsToggle), details, message, results);

  replaceToggle.addEventListener('click', () => {
    const show = replaceRow.style.display === 'none';
    replaceRow.style.display = show ? '' : 'none';
    replaceToggle.replaceChildren(icon(show ? 'chevron-down' : 'chevron-right'));
    renderResults();
  });

  for (const ta of [query, replace]) {
    ta.addEventListener('input', () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 120) + 'px'; });
    ta.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (ta === replace && e.ctrlKey && e.altKey) replaceAll();
        else run();
      }
      if (e.altKey && !e.ctrlKey) {
        const k = e.key.toLowerCase();
        const map = { c: caseBtn, w: wordBtn, r: regexBtn, p: preserveCase };
        if (map[k]) { e.preventDefault(); map[k].click(); }
      }
      if (e.key === 'ArrowDown' && ta === query && !query.value.includes('\n')) { /* allow navigation into results */ }
    });
  }
  query.addEventListener('input', debounce(() => run(), 300));
  replace.addEventListener('input', debounce(() => renderResults(), 150));
  include.addEventListener('keydown', (e) => e.key === 'Enter' && run());
  exclude.addEventListener('keydown', (e) => e.key === 'Enter' && run());
  include.addEventListener('input', debounce(() => run(), 500));
  exclude.addEventListener('input', debounce(() => run(), 500));
  replaceAllBtn.addEventListener('click', () => replaceAll());

  function opts() {
    const ex = [exclude.value, useIgnore.classList.contains('on') ? settings.get('search.exclude') : ''].filter(Boolean).join(',');
    return {
      root: workspace.root,
      query: query.value,
      isRegex: regexBtn.classList.contains('on'),
      matchCase: caseBtn.classList.contains('on'),
      wholeWord: wordBtn.classList.contains('on'),
      include: include.value,
      exclude: ex,
      noIgnore: !useIgnore.classList.contains('on') || !settings.get('search.useIgnoreFiles'),
      maxResults: settings.get('search.maxResults'),
    };
  }

  async function run() {
    const o = opts();
    const seq = ++searchSeq;
    if (!o.query) {
      lastResults = null;
      window.snake.search.cancel();
      message.textContent = '';
      results.replaceChildren();
      return;
    }
    if (!workspace.root) {
      message.textContent = 'You have not opened or specified a folder. Only open files are searched.';
      lastResults = searchOpenDocs(o);
      renderResults();
      return;
    }
    if (o.isRegex) {
      try { new RegExp(o.query); } catch (err) { message.textContent = 'Invalid regular expression: ' + err.message; return; }
    }
    container.classList.add('busy');
    const res = await window.snake.search.run(o);
    if (seq !== searchSeq) return;
    container.classList.remove('busy');
    if (res.error) { message.textContent = res.error; results.replaceChildren(); return; }
    // include unsaved content from dirty open documents
    for (const f of res.files) {
      const doc = getDocument(f.path);
      if (doc?.dirty) f.matches = matchesInDoc(doc, o);
    }
    res.files = res.files.filter((f) => f.matches.length);
    res.count = res.files.reduce((s, f) => s + f.matches.length, 0);
    lastResults = { ...res, opts: o };
    renderResults();
  }

  function renderResults() {
    if (!lastResults) return;
    const { files, count, limitHit } = lastResults;
    const showReplace = replaceRow.style.display !== 'none';
    const rep = replace.value;
    message.textContent = count ? `${count} result${count === 1 ? '' : 's'} in ${files.length} file${files.length === 1 ? '' : 's'}${limitHit ? ' (limit reached; refine your search)' : ''}` : 'No results found. Review your settings for configured exclusions and check your gitignore files.';
    const frag = document.createDocumentFragment();
    for (const f of files) {
      const collapsed = collapsedFiles.has(f.path);
      const fileActions = el('span.row-actions');
      if (showReplace) fileActions.append(el('span.action-btn', { title: 'Replace All in File', onclick: (e) => { e.stopPropagation(); replaceInFile(f); } }, icon('replace-all')));
      fileActions.append(el('span.action-btn', { title: 'Dismiss', onclick: (e) => { e.stopPropagation(); lastResults.files = lastResults.files.filter((x) => x !== f); lastResults.count -= f.matches.length; renderResults(); } }, icon('close')));
      const header = el(
        'div.search-file.list-row',
        { title: f.path },
        icon(collapsed ? 'chevron-right' : 'chevron-down', 'twistie'),
        fileIcon(basename(f.path)),
        el('span.search-file-name', {}, basename(f.path)),
        el('span.search-file-dir', {}, relative(workspace.root, dirname(f.path)).replace(/^\.$/, '')),
        fileActions,
        el('span.badge', {}, String(f.matches.length)),
      );
      header.addEventListener('click', () => { collapsed ? collapsedFiles.delete(f.path) : collapsedFiles.add(f.path); renderResults(); });
      header.addEventListener('contextmenu', (e) => contextMenu(e, [
        { label: 'Open File', run: () => openFile(f.path, { pinned: true }) },
        { label: 'Replace All in File', hidden: !showReplace, run: () => replaceInFile(f) },
        { label: 'Copy Path', run: () => window.snake.clipboard.write(f.path) },
        { label: 'Dismiss', run: () => { lastResults.files = lastResults.files.filter((x) => x !== f); renderResults(); } },
      ]));
      frag.append(header);
      if (collapsed) continue;
      for (const m of f.matches.slice(0, 500)) {
        const pre = m.text.slice(Math.max(0, m.start - 40), m.start);
        const hit = m.text.slice(m.start, m.end);
        const post = m.text.slice(m.end, m.end + 200);
        const preview = el('span.search-preview', {}, (m.start > 40 ? '…' : '') + pre.replace(/^\s+/, ''));
        if (showReplace && (rep || true)) {
          preview.append(el('span.search-hit.removed', {}, hit), el('span.search-hit.added', {}, computeReplacement(hit, lastResults.opts, rep, preserveCase.classList.contains('on'))));
        } else preview.append(el('span.search-hit', {}, hit));
        preview.append(post);
        const lineActions = el('span.row-actions');
        if (showReplace) lineActions.append(el('span.action-btn', { title: 'Replace', onclick: (e) => { e.stopPropagation(); replaceOne(f, m); } }, icon('replace')));
        lineActions.append(el('span.action-btn', { title: 'Dismiss', onclick: (e) => { e.stopPropagation(); f.matches = f.matches.filter((x) => x !== m); lastResults.count--; if (!f.matches.length) lastResults.files = lastResults.files.filter((x) => x !== f); renderResults(); } }, icon('close')));
        const row = el('div.search-match.list-row', { title: m.text.trim().slice(0, 300) }, preview, lineActions, el('span.search-line-no', {}, String(m.line)));
        row.addEventListener('click', () => openMatch(f, m, false));
        row.addEventListener('dblclick', () => openMatch(f, m, true));
        frag.append(row);
      }
      if (f.matches.length > 500) frag.append(el('div.search-more', {}, `… ${f.matches.length - 500} more matches in this file`));
    }
    results.replaceChildren(frag);
  }

  async function openMatch(f, m, pinned) {
    if (replaceRow.style.display !== 'none' && replace.value !== undefined && !pinned) {
      // preview the replacement as a diff
      const doc = getDocument(f.path);
      const original = doc ? doc.model.getValue() : (await window.snake.fs.readFile(f.path)).content || '';
      const replaced = applyReplace(original, lastResults.opts, replace.value, preserveCase.classList.contains('on'));
      const input = openDiff({ originalText: original, modifiedText: replaced, path: f.path, title: `${basename(f.path)} ↔ ${basename(f.path)} (Replace Preview)`, key: 'replace-preview:' + f.path });
      return input;
    }
    await openFile(f.path, { preview: !pinned, pinned, selection: { startLineNumber: m.line, startColumn: m.start + 1, endLineNumber: m.line, endColumn: m.end + 1 }, focus: pinned });
  }

  async function replaceInFile(f) {
    const o = lastResults.opts;
    const rep = replace.value;
    const pc = preserveCase.classList.contains('on');
    const doc = getDocument(f.path);
    if (doc) {
      const text = doc.model.getValue();
      const next = applyReplace(text, o, rep, pc);
      doc.model.pushEditOperations([], [{ range: doc.model.getFullModelRange(), text: next }], () => null);
      if (!doc.untitled) await saveDocument(doc, { skipParticipants: true });
    } else {
      const r = await window.snake.fs.readFile(f.path);
      if (r.content == null) return;
      await window.snake.fs.writeFile(f.path, applyReplace(r.content, o, rep, pc));
    }
    lastResults.files = lastResults.files.filter((x) => x !== f);
    lastResults.count -= f.matches.length;
    renderResults();
  }

  async function replaceOne(f, m) {
    const o = lastResults.opts;
    const rep = replace.value;
    let doc = getDocument(f.path);
    if (!doc) { await openFile(f.path, { preview: true, focus: false }); doc = getDocument(f.path); }
    if (!doc) return;
    const range = new monaco.Range(m.line, m.start + 1, m.line, m.end + 1);
    const hit = doc.model.getValueInRange(range);
    doc.model.pushEditOperations([], [{ range, text: computeReplacement(hit, o, rep, preserveCase.classList.contains('on')) }], () => null);
    f.matches = f.matches.filter((x) => x !== m);
    // shift later matches on the same line
    const delta = computeReplacement(hit, o, rep, preserveCase.classList.contains('on')).length - hit.length;
    for (const x of f.matches) if (x.line === m.line && x.start > m.start) { x.start += delta; x.end += delta; }
    lastResults.count--;
    if (!f.matches.length) lastResults.files = lastResults.files.filter((x) => x !== f);
    renderResults();
  }

  async function replaceAll() {
    if (!lastResults?.files.length) return;
    const { count, files } = lastResults;
    const r = await confirm(`Replace ${count} occurrence${count === 1 ? '' : 's'} across ${files.length} file${files.length === 1 ? '' : 's'} with '${replace.value}'?`, { buttons: ['Replace', 'Cancel'], cancelId: 1 });
    if (r !== 0) return;
    for (const f of [...files]) await replaceInFile(f);
    notify({ type: 'success', message: `Replaced ${count} occurrence${count === 1 ? '' : 's'} across ${files.length} file${files.length === 1 ? '' : 's'}.`, timeout: 3000 });
    run();
  }

  results.addEventListener('keydown', (e) => {
    const rows = [...results.querySelectorAll('.list-row')];
    const i = rows.indexOf(results.querySelector('.list-row.focused'));
    const focusRow = (j) => { rows.forEach((r) => r.classList.remove('focused')); const r = rows[Math.max(0, Math.min(rows.length - 1, j))]; r?.classList.add('focused'); r?.scrollIntoView({ block: 'nearest' }); r?.click(); };
    if (e.key === 'ArrowDown') { e.preventDefault(); focusRow(i + 1); }
    if (e.key === 'ArrowUp') { e.preventDefault(); focusRow(i - 1); }
  });

  bus.on('workspace:changed', () => { lastResults = null; results.replaceChildren(); message.textContent = ''; });

  ui = {
    run,
    focus(text) {
      if (typeof text === 'string' && text) { query.value = text; run(); }
      query.focus();
      query.select();
    },
    setOptions({ include: inc, replace: showRep, query: q }) {
      if (inc != null) { include.value = inc; details.style.display = ''; }
      if (q != null) query.value = q;
      if (showRep && replaceRow.style.display === 'none') replaceToggle.click();
      run();
    },
    toggleReplace(show) { if ((replaceRow.style.display === 'none') === show) replaceToggle.click(); },
  };

  return {
    actions: [
      { icon: 'refresh', title: 'Refresh', run: () => run() },
      { icon: 'clear-all', title: 'Clear Search Results', run: () => { query.value = ''; replace.value = ''; run(); } },
      { icon: 'collapse-all', title: 'Collapse All', run: () => { for (const f of lastResults?.files || []) collapsedFiles.add(f.path); renderResults(); } },
      { icon: 'expand-all', title: 'Expand All', run: () => { collapsedFiles.clear(); renderResults(); } },
    ],
    focus: () => ui.focus(),
  };
}

function buildRegex(o) {
  let src = o.isRegex ? o.query : o.query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (o.wholeWord) src = `\\b(?:${src})\\b`;
  return new RegExp(src, o.matchCase ? 'gm' : 'gim');
}

function preserve(original, replacement) {
  if (!original) return replacement;
  if (original === original.toUpperCase()) return replacement.toUpperCase();
  if (original === original.toLowerCase()) return replacement.toLowerCase();
  if (original[0] === original[0].toUpperCase()) return replacement[0].toUpperCase() + replacement.slice(1);
  return replacement;
}

function computeReplacement(hit, o, rep, pc) {
  let out = rep;
  if (o.isRegex) {
    try { out = hit.replace(buildRegex({ ...o, wholeWord: false }), rep.replace(/\\n/g, '\n').replace(/\\t/g, '\t')); } catch {}
  }
  return pc ? preserve(hit, out) : out;
}

function applyReplace(text, o, rep, pc) {
  const re = buildRegex(o);
  const r = o.isRegex ? rep.replace(/\\n/g, '\n').replace(/\\t/g, '\t') : rep.replace(/\$/g, '$$$$');
  if (!pc) return text.replace(re, r);
  return text.replace(re, (...args) => preserve(args[0], o.isRegex ? args[0].replace(buildRegex({ ...o, wholeWord: false }), r) : rep));
}

function matchesInDoc(doc, o) {
  const re = buildRegex(o);
  const out = [];
  const lines = doc.model.getLinesContent();
  lines.forEach((text, i) => {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text))) {
      out.push({ line: i + 1, start: m.index, end: m.index + m[0].length, text });
      if (!m[0].length) re.lastIndex++;
    }
  });
  return out;
}

function searchOpenDocs(o) {
  const files = [];
  for (const doc of monaco.editor.getModels()) {
    const d = getDocument(doc.uri.scheme === 'file' ? doc.uri.fsPath : `untitled:${doc.uri.path.slice(1)}`);
    if (!d) continue;
    const matches = matchesInDoc(d, o);
    if (matches.length) files.push({ path: d.path || d.key, matches });
  }
  return { files, count: files.reduce((s, f) => s + f.matches.length, 0), opts: o };
}

export function focusSearch(opts = {}) {
  showView('search', { focus: false });
  if (opts.include != null || opts.replace) ui?.setOptions(opts);
  ui?.focus(opts.query);
}

registerView({ id: 'search', title: 'Search', icon: 'search', order: 2, command: 'workbench.action.findInFiles', build: buildSearch });
