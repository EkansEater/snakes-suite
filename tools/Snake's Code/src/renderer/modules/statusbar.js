// Status bar: git branch/sync, problems, cursor position, indentation, encoding, EOL, language, notifications.
import { el, icon, bus } from './util.js';
import { git, checkout, sync, push } from './git.js';
import { activeCodeEditor, activeInput, activeDoc, languageName } from './editors.js';
import { executeCommand } from './commands.js';
import { notificationHistory, clearNotificationHistory, showMenu } from './ui.js';
import { workspace } from './workspace.js';
import { getProblemCounts, showPanel } from './panel.js';

let items = {};

function item(id, { left = true, title, onclick, priority = 0 } = {}) {
  const node = el('div.sb-item', { title: title || '', dataset: { id } });
  if (onclick) { node.classList.add('clickable'); node.addEventListener('click', onclick); }
  node.style.order = String(priority);
  items[id] = node;
  return node;
}

export function initStatusbar() {
  const bar = document.getElementById('statusbar');
  const left = el('div.sb-left');
  const right = el('div.sb-right');
  bar.append(left, right);

  left.append(
    item('remote', { title: "Snake's Code", onclick: () => executeCommand('workbench.action.showCommands'), priority: -10 }),
    item('branch', { title: 'Checkout Branch/Tag...', onclick: () => checkout() }),
    item('sync', { title: 'Synchronize Changes', onclick: () => (git.upstream ? sync() : push()) }),
    item('problems', { title: 'Problems', onclick: () => showPanel('problems') }),
    item('gitbusy', {}),
  );
  items.remote.append(icon('remote'));

  right.append(
    item('chord', {}),
    item('cursor', { title: 'Go to Line/Column', onclick: () => executeCommand('workbench.action.gotoLine') }),
    item('indent', { title: 'Select Indentation', onclick: () => executeCommand('editor.action.changeIndentation') }),
    item('encoding', { title: 'Select Encoding', onclick: () => executeCommand('workbench.action.editor.changeEncoding') }),
    item('eol', { title: 'Select End of Line Sequence', onclick: () => executeCommand('workbench.action.editor.changeEOL') }),
    item('language', { title: 'Select Language Mode', onclick: () => executeCommand('workbench.action.editor.changeLanguageMode') }),
    item('feedback', { title: 'Toggle Zen Mode', onclick: () => executeCommand('workbench.action.toggleZenMode') }),
    item('bell', { title: 'Notifications', onclick: (e) => showNotificationCenter(e) }),
  );
  items.feedback.append(icon('screen-full'));

  bus.on('git:statusChanged', renderGit);
  bus.on('git:busy', (b, label) => {
    items.gitbusy.replaceChildren(...(b ? [icon('sync', 'spin'), el('span', {}, ` ${label}`)] : []));
    items.gitbusy.style.display = b ? '' : 'none';
  });
  bus.on('problems:changed', renderProblems);
  bus.on('editor:cursor', renderEditor);
  bus.on('editor:activeChanged', renderEditor);
  bus.on('doc:saved', renderEditor);
  bus.on('notifications:changed', renderBell);
  bus.on('workspace:changed', () => { renderFolderState(); renderGit(); });
  bus.on('chord', (k) => {
    items.chord.textContent = k ? `(${k}) was pressed. Waiting for second key of chord...` : '';
    items.chord.style.display = k ? '' : 'none';
  });
  renderGit();
  renderProblems(getProblemCounts());
  renderEditor();
  renderBell();
  renderFolderState();
  items.chord.style.display = 'none';
  items.gitbusy.style.display = 'none';
}

function renderFolderState() {
  document.getElementById('statusbar').classList.toggle('no-folder', !workspace.root);
}

function renderGit() {
  if (!git.isRepo) {
    items.branch.style.display = 'none';
    items.sync.style.display = 'none';
    return;
  }
  const dirty = git.files.some((f) => f.letter !== 'I');
  items.branch.style.display = '';
  items.branch.replaceChildren(icon(git.detached ? 'git-commit' : 'git-branch'), el('span', {}, ` ${git.branch}${dirty ? '*' : ''}`));
  items.sync.style.display = git.hasCommits ? '' : 'none';
  if (git.upstream) {
    items.sync.replaceChildren(icon('sync'), el('span', {}, git.ahead || git.behind ? ` ${git.behind}↓ ${git.ahead}↑` : ''));
    items.sync.title = `${git.upstream}: ${git.behind} incoming, ${git.ahead} outgoing — Synchronize Changes`;
  } else {
    items.sync.replaceChildren(icon('cloud-upload'));
    items.sync.title = 'Publish Branch';
  }
}

function renderProblems(c) {
  items.problems.replaceChildren(icon('error'), el('span', {}, ` ${c.errors} `), icon('warning'), el('span', {}, ` ${c.warnings}`));
  if (c.infos) items.problems.append(icon('info'), el('span', {}, ` ${c.infos}`));
  items.problems.title = `Errors: ${c.errors}, Warnings: ${c.warnings}, Infos: ${c.infos}`;
}

function renderEditor() {
  const ed = activeCodeEditor();
  const input = activeInput();
  const doc = activeDoc();
  const show = !!ed && !!ed.getModel();
  for (const id of ['cursor', 'indent', 'encoding', 'eol', 'language']) items[id].style.display = show ? '' : 'none';
  if (!show) return;
  const model = ed.getModel();
  const pos = ed.getPosition();
  const sels = ed.getSelections() || [];
  let text = `Ln ${pos?.lineNumber ?? 1}, Col ${pos?.column ?? 1}`;
  if (sels.length > 1) text += ` (${sels.length} selections)`;
  else if (sels[0] && !sels[0].isEmpty()) {
    const chars = model.getValueLengthInRange(sels[0]);
    const lines = sels[0].endLineNumber - sels[0].startLineNumber + 1;
    text += ` (${chars} selected${lines > 1 ? `, ${lines} lines` : ''})`;
  }
  items.cursor.textContent = text;
  const o = model.getOptions();
  items.indent.textContent = `${o.insertSpaces ? 'Spaces' : 'Tab Size'}: ${o.tabSize}`;
  items.encoding.textContent = doc?.bom ? 'UTF-8 with BOM' : 'UTF-8';
  items.eol.textContent = model.getEOL() === '\r\n' ? 'CRLF' : 'LF';
  items.language.textContent = languageName(model.getLanguageId());
  if (input?.kind === 'diff') items.language.textContent += ' (diff)';
}

function renderBell() {
  const n = notificationHistory().length;
  items.bell.replaceChildren(icon(n ? 'bell-dot' : 'bell'));
  items.bell.title = n ? `${n} Notification${n > 1 ? 's' : ''}` : 'No Notifications';
}

function showNotificationCenter(e) {
  const list = notificationHistory();
  const r = e.currentTarget.getBoundingClientRect();
  const entries = list.slice(0, 15).map((n) => ({ label: `${n.type === 'error' ? '⛔' : n.type === 'warning' ? '⚠️' : n.type === 'success' ? '✅' : 'ℹ️'}  ${n.message.slice(0, 90)}`, run: () => {} }));
  showMenu(
    [
      ...(entries.length ? entries : [{ label: 'No new notifications', disabled: true }]),
      { separator: true },
      { label: 'Clear All Notifications', disabled: !list.length, run: () => clearNotificationHistory() },
    ],
    { x: r.right - 420, y: r.top - 8 - Math.min(17, entries.length + 2) * 26 },
  );
}

export function setStatusbarVisible(v) {
  document.getElementById('workbench').classList.toggle('statusbar-hidden', !v);
}

