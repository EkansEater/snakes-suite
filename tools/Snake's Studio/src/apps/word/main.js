// Snake's Word.
import { h, uid, escapeHtml, extOf, baseName, clamp, debounce } from '../../kit/dom.js';
import { icon } from '../../kit/icons.js';
import { host, inElectron, readText, decodeText } from '../../kit/host.js';
import * as commands from '../../kit/commands.js';
import { createShell, tb, sep, combo, select, startScreen, onDropFiles, guardClose, refresh, splitter } from '../../kit/shell.js';
import { toggleDrawer, isPhone } from '../../kit/phone.js';
import { showMenu, contextMenu, popover, closeMenus } from '../../kit/menu.js';
import { modal, toast, errorToast, busy, promptBox, confirmBox } from '../../kit/dialogs.js';
import { pickColor } from '../../kit/color.js';
import { sanitizeToString } from '../../kit/sanitize.js';
import { knownFonts, allFonts, FONT_SIZES, fontStack } from '../../kit/fonts.js';
import { stepZoom } from '../../kit/zoom.js';
import { WordEditor, PAGE_SIZES, DOC_CLASSES, defaultMeta } from './editor.js';
import { readDocx, writeDocx, readOdt } from './docx.js';
import { markdownToHtml, htmlToMarkdown, htmlToText, textToHtml, rtfToHtml } from './markdown.js';
import { TEMPLATES, templateThumb } from './templates.js';
import { Comments } from './comments.js';

const DOC_FILTERS = [
  { name: 'All documents', exts: ['snakedoc', 'docx', 'odt', 'html', 'htm', 'md', 'markdown', 'txt', 'rtf'] },
  { name: "Snake's Word document", exts: ['snakedoc'] },
  { name: 'Word document', exts: ['docx'] },
  { name: 'Web page', exts: ['html', 'htm'] },
  { name: 'Markdown', exts: ['md', 'markdown'] },
  { name: 'Plain text', exts: ['txt'] },
];
const SAVE_FORMATS = {
  snakedoc: { name: "Snake's Word document", exts: ['snakedoc'] },
  docx: { name: 'Word document', exts: ['docx'] },
  html: { name: 'Web page', exts: ['html'] },
  md: { name: 'Markdown', exts: ['md'] },
  txt: { name: 'Plain text', exts: ['txt'] },
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
const doc = { file: null, name: 'Untitled', format: 'snakedoc', id: uid('doc'), opened: false };
let painter = null; // format painter: { format, sticky }

const shell = await createShell({
  id: 'word', name: "Snake's Word",
  quick: ['file.save', 'edit.undo', 'edit.redo'],
  menus: [
    { label: '&File', items: () => fileMenu() },
    { label: '&Edit', items: () => editMenu() },
    { label: '&View', items: () => viewMenu() },
    { label: '&Insert', items: () => insertMenu() },
    { label: 'F&ormat', items: () => formatMenu() },
    { label: '&Tools', items: () => toolsMenu() },
    { label: '&Help', items: () => [commands.item('app.palette'), commands.item('app.shortcuts'), { type: 'separator' }, commands.item('app.about')] },
  ],
  about: 'A word processor that reads and writes Word (.docx), web pages, Markdown and plain text, and prints to PDF.',
});

const settings = host.settings;
let comments = null;
const ed = new WordEditor({
  settings,
  onChange: () => { updateTitle(); refresh(); if (comments) comments.paint(); },
  onSelection: () => { refresh(); if (painter && !painter.waiting) applyPainterSoon(); if (comments) comments.caretMoved(); },
  onStats: (s) => updateStatus(s),
});
ed.markdownToHtml = markdownToHtml;
ed.onOpenLink = (href) => host.openExternal(href);
ed.onPickImage = () => insertPicture();
ed.onEditHeader = () => headerFooterDialog();
comments = new Comments(ed, settings, { onShow: (on) => { cmtSplit.classList.toggle('hidden', !on); settings.set('comments', on); refresh(); } });

// Layout: navigation pane | workspace | find bar overlay
const nav = h('div.panel.nav-pane', h('div.panel-head', 'Navigation', h('span.grow'),
  tb({ icon: 'x', tip: 'Close', run: () => commands.run('view.nav') })), h('div.panel-body.nav-list'));
const navSplit = splitter(nav, { side: 'left', key: 'navWidth', initial: 240, min: 160, max: 480, title: 'Navigation', icon: 'toc' });
const cmtSplit = splitter(comments.pane, { side: 'right', key: 'cmtWidth', initial: 300, min: 220, max: 520, title: 'Comments', icon: 'comment' });
shell.main.append(nav, navSplit, ed.el, cmtSplit, comments.pane);
if (!settings.get('nav', false)) { nav.classList.add('hidden'); navSplit.classList.add('hidden'); }
comments.pane.classList.add('hidden');
cmtSplit.classList.add('hidden');

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------
const C = (id, label, keys, run, extra = {}) => ({ id, label, keys, run, ...extra });
const st = () => ed.state();
commands.register(
  // File
  C('file.new', 'New Document', 'Ctrl+N', () => newDocument(), { icon: 'new', category: 'File' }),
  C('file.open', 'Open…', 'Ctrl+O', () => openDialog(), { icon: 'open', category: 'File' }),
  C('file.save', 'Save', 'Ctrl+S', () => save(), { icon: 'save', category: 'File' }),
  C('file.saveAs', 'Save As…', 'Ctrl+Shift+S', () => saveAs(), { icon: 'saveAs', category: 'File' }),
  C('file.pdf', 'Export as PDF…', 'Ctrl+Shift+E', () => exportPdf(), { icon: 'pdf', category: 'File' }),
  C('file.docx', 'Export as Word (.docx)…', null, () => saveAs('docx'), { icon: 'export', category: 'File' }),
  C('file.html', 'Export as Web Page…', null, () => saveAs('html'), { icon: 'export', category: 'File' }),
  C('file.md', 'Export as Markdown…', null, () => saveAs('md'), { icon: 'export', category: 'File' }),
  C('file.txt', 'Export as Plain Text…', null, () => saveAs('txt'), { icon: 'export', category: 'File' }),
  C('file.print', 'Print…', 'Ctrl+P', () => print(), { icon: 'print', category: 'File' }),
  C('file.pageSetup', 'Page Setup…', null, () => pageSetupDialog(), { icon: 'pageSize', category: 'File' }),
  C('file.properties', 'Document Properties…', null, () => propertiesDialog(), { icon: 'info', category: 'File' }),
  C('file.home', 'Start Screen', null, () => start.show(), { icon: 'home', category: 'File' }),
  C('file.reveal', 'Show in Folder', null, () => doc.file && host.reveal(doc.file), { category: 'File', when: () => !!(doc.file && doc.file.id && inElectron) }),
  // Edit
  C('edit.undo', 'Undo', 'Ctrl+Z', () => ed.undo(), { icon: 'undo', category: 'Edit', when: () => ed.history.canUndo || ed.typing, inputs: true }),
  C('edit.redo', 'Redo', ['Ctrl+Y', 'Ctrl+Shift+Z'], () => ed.redo(), { icon: 'redo', category: 'Edit', when: () => ed.history.canRedo, inputs: true }),
  C('edit.cut', 'Cut', null, () => { ed.focus(); document.execCommand('cut'); }, { icon: 'cut', category: 'Edit' }),
  C('edit.copy', 'Copy', null, () => { ed.focus(); document.execCommand('copy'); }, { icon: 'copy', category: 'Edit' }),
  C('edit.paste', 'Paste', null, () => pasteFromClipboard({}), { icon: 'paste', category: 'Edit' }),
  C('edit.pastePlain', 'Paste as Plain Text', 'Ctrl+Shift+V', () => pasteFromClipboard({ plain: true }), { icon: 'paste', category: 'Edit' }),
  C('edit.pasteMarkdown', 'Paste Markdown as Formatted Text', 'Ctrl+Alt+V', () => pasteFromClipboard({ markdown: true }), { icon: 'paste', category: 'Edit' }),
  C('edit.selectAll', 'Select All', null, () => { ed.focus(); document.execCommand('selectAll'); }, { category: 'Edit' }),
  C('edit.find', 'Find', 'Ctrl+F', () => findBar.open(false), { icon: 'search', category: 'Edit' }),
  C('edit.replace', 'Replace', 'Ctrl+H', () => findBar.open(true), { icon: 'replace', category: 'Edit' }),
  C('edit.findNext', 'Find Next', 'F3', () => findBar.next(1), { category: 'Edit', inputs: true }),
  C('edit.findPrev', 'Find Previous', 'Shift+F3', () => findBar.next(-1), { category: 'Edit', inputs: true }),
  C('edit.goto', 'Go to Page…', 'Ctrl+G', () => gotoPage(), { category: 'Edit' }),
  // Format: characters
  C('fmt.bold', 'Bold', 'Ctrl+B', () => ed.toggle('bold', 'Bold'), { icon: 'bold', category: 'Format', checked: () => st().bold, inputs: true }),
  C('fmt.italic', 'Italic', 'Ctrl+I', () => ed.toggle('italic', 'Italic'), { icon: 'italic', category: 'Format', checked: () => st().italic, inputs: true }),
  C('fmt.underline', 'Underline', 'Ctrl+U', () => ed.toggle('underline', 'Underline'), { icon: 'underline', category: 'Format', checked: () => st().underline, inputs: true }),
  C('fmt.strike', 'Strikethrough', 'Alt+Shift+5', () => ed.toggle('strikeThrough', 'Strikethrough'), { icon: 'strike', category: 'Format', checked: () => st().strikeThrough }),
  C('fmt.sub', 'Subscript', 'Ctrl+,', () => ed.toggle('subscript', 'Subscript'), { icon: 'subscript', category: 'Format', checked: () => st().subscript }),
  C('fmt.sup', 'Superscript', 'Ctrl+.', () => ed.toggle('superscript', 'Superscript'), { icon: 'superscript', category: 'Format', checked: () => st().superscript }),
  C('fmt.grow', 'Bigger Text', 'Ctrl+]', () => ed.growFont(1), { icon: 'plus', category: 'Format' }),
  C('fmt.shrink', 'Smaller Text', 'Ctrl+[', () => ed.growFont(-1), { icon: 'minus', category: 'Format' }),
  C('fmt.clear', 'Clear Formatting', 'Ctrl+\\', () => ed.clearFormatting(), { icon: 'clearFormat', category: 'Format' }),
  C('fmt.color', 'Text Colour…', null, () => colorPick(null, 'color'), { icon: 'textColor', category: 'Format' }),
  C('fmt.highlight', 'Highlight…', null, () => colorPick(null, 'highlight'), { icon: 'highlighter', category: 'Format' }),
  C('fmt.painter', 'Copy Formatting (Format Painter)', 'Ctrl+Shift+C', () => startPainter(false), { icon: 'painter', category: 'Format', checked: () => !!painter }),
  C('fmt.link', 'Link…', 'Ctrl+K', () => linkDialog(), { icon: 'link', category: 'Insert' }),
  // Format: paragraphs
  C('para.normal', 'Normal Text', 'Ctrl+Alt+0', () => ed.setStyle('Normal'), { category: 'Styles' }),
  C('para.h1', 'Heading 1', 'Ctrl+Alt+1', () => ed.setStyle('Heading 1'), { category: 'Styles', icon: 'heading' }),
  C('para.h2', 'Heading 2', 'Ctrl+Alt+2', () => ed.setStyle('Heading 2'), { category: 'Styles', icon: 'heading' }),
  C('para.h3', 'Heading 3', 'Ctrl+Alt+3', () => ed.setStyle('Heading 3'), { category: 'Styles', icon: 'heading' }),
  C('para.h4', 'Heading 4', 'Ctrl+Alt+4', () => ed.setStyle('Heading 4'), { category: 'Styles', icon: 'heading' }),
  C('para.title', 'Title', null, () => ed.setStyle('Title'), { category: 'Styles' }),
  C('para.subtitle', 'Subtitle', null, () => ed.setStyle('Subtitle'), { category: 'Styles' }),
  C('para.quote', 'Quote', null, () => ed.setStyle('Quote'), { category: 'Styles', icon: 'quote' }),
  C('para.code', 'Code Block', null, () => ed.setStyle('Code'), { category: 'Styles', icon: 'code' }),
  C('para.bullets', 'Bulleted List', 'Ctrl+Shift+8', () => ed.list('ul'), { icon: 'listBullets', category: 'Paragraph', checked: () => st().insertUnorderedList && !st().checklist }),
  C('para.numbers', 'Numbered List', 'Ctrl+Shift+7', () => ed.list('ol'), { icon: 'listNumbers', category: 'Paragraph', checked: () => st().insertOrderedList }),
  C('para.checklist', 'Checklist', 'Ctrl+Shift+9', () => ed.list('check'), { icon: 'listCheck', category: 'Paragraph', checked: () => st().checklist }),
  C('para.left', 'Align Left', 'Ctrl+L', () => ed.align('left'), { icon: 'alignLeft', category: 'Paragraph', checked: () => ['left', 'start'].includes(st().align) }),
  C('para.center', 'Center', 'Ctrl+E', () => ed.align('center'), { icon: 'alignCenter', category: 'Paragraph', checked: () => st().align === 'center' }),
  C('para.right', 'Align Right', 'Ctrl+R', () => ed.align('right'), { icon: 'alignRight', category: 'Paragraph', checked: () => ['right', 'end'].includes(st().align) }),
  C('para.justify', 'Justify', 'Ctrl+J', () => ed.align('justify'), { icon: 'alignJustify', category: 'Paragraph', checked: () => st().align === 'justify' }),
  C('para.indent', 'Increase Indent', 'Ctrl+M', () => ed.indent(1), { icon: 'indent', category: 'Paragraph' }),
  C('para.outdent', 'Decrease Indent', 'Ctrl+Shift+M', () => ed.indent(-1), { icon: 'outdent', category: 'Paragraph' }),
  // Insert
  C('ins.table', 'Table…', null, () => tableDialog(), { icon: 'table', category: 'Insert' }),
  C('ins.picture', 'Picture…', null, () => insertPicture(), { icon: 'image', category: 'Insert' }),
  C('ins.pageBreak', 'Page Break', 'Ctrl+Enter', () => ed.insertPageBreak(), { icon: 'pageBreak', category: 'Insert' }),
  C('ins.hr', 'Horizontal Line', null, () => ed.insertBlock('<hr>', 'Line'), { icon: 'hr', category: 'Insert' }),
  C('ins.symbol', 'Symbol or Emoji…', null, () => symbolPicker(null), { icon: 'omega', category: 'Insert' }),
  C('ins.date', 'Date and Time', 'Alt+Shift+D', () => ed.insertHTML(escapeHtml(new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' })), 'Date'), { icon: 'calendar', category: 'Insert' }),
  C('ins.toc', 'Table of Contents', null, () => ed.insertToc(), { icon: 'toc', category: 'Insert' }),
  C('ins.updateToc', 'Update Table of Contents', null, () => { if (!ed.updateToc()) toast('There is no table of contents yet: Insert › Table of Contents.'); }, { icon: 'toc', category: 'Insert' }),
  C('ins.cols2', 'Two Columns', null, () => ed.insertColumns(2), { icon: 'columns', category: 'Insert' }),
  C('ins.cols3', 'Three Columns', null, () => ed.insertColumns(3), { icon: 'columns', category: 'Insert' }),
  C('ins.note', 'Note Box', null, () => ed.insertBlock('<div class="note"><p>Note</p></div>', 'Note'), { icon: 'info', category: 'Insert' }),
  // View
  C('view.zoomIn', 'Zoom In', ['Ctrl+=', 'Ctrl+Shift+='], () => ed.setZoom(stepZoom(ed.zoom, 1, 0.25, 5)), { icon: 'zoomIn', category: 'View', inputs: true }),
  C('view.zoomOut', 'Zoom Out', 'Ctrl+-', () => ed.setZoom(stepZoom(ed.zoom, -1, 0.25, 5)), { icon: 'zoomOut', category: 'View', inputs: true }),
  C('view.zoom100', 'Actual Size', 'Ctrl+0', () => ed.setZoom(1), { category: 'View', inputs: true }),
  C('view.fitWidth', 'Fit Page Width', null, () => ed.fitWidth(), { icon: 'fit', category: 'View' }),
  C('view.fitPage', 'Whole Page', null, () => ed.fitPage(), { icon: 'fit', category: 'View' }),
  C('view.nav', 'Navigation Pane', 'Ctrl+Shift+O', () => toggleNav(), { icon: 'outline', category: 'View', checked: () => !nav.classList.contains('hidden') }),
  C('view.ruler', 'Ruler', null, () => toggleSetting('ruler', true, () => ed.drawRuler()), { icon: 'ruler', category: 'View', checked: () => settings.get('ruler', true) }),
  C('view.focus', 'Focus Mode', 'Ctrl+Shift+F', () => toggleSetting('focusMode', false, (on) => (on ? ed.markFocus() : ed.clearFocusMarks())), { icon: 'focus', category: 'View', checked: () => settings.get('focusMode', false) }),
  C('view.typewriter', 'Typewriter Scrolling', null, () => toggleSetting('typewriter', false), { category: 'View', checked: () => settings.get('typewriter', false) }),
  C('view.darkPage', 'Dark Page (for night writing)', null, () => toggleSetting('darkPage', false, (on) => ed.el.classList.toggle('dark-page', on)), { icon: 'moon', category: 'View', checked: () => settings.get('darkPage', false) }),
  C('view.read', 'Read Mode', null, () => toggleReadMode(), { icon: 'book', category: 'View', checked: () => document.body.classList.contains('read-mode') }),
  C('view.spell', 'Check Spelling as You Type', null, () => toggleSetting('spellcheck', true, (on) => { ed.doc.spellcheck = on; }), { icon: 'spell', category: 'Review', checked: () => settings.get('spellcheck', true) }),
  // Review / tools
  C('ins.footnote', 'Footnote', 'Ctrl+Alt+F', () => ed.insertFootnote(), { icon: 'superscript', category: 'Insert' }),
  C('review.comment', 'New Comment', 'Ctrl+Alt+M', async () => { if (!(await comments.add())) toast('Select the text the comment is about first.', { timeout: 2500 }); }, { icon: 'comment', category: 'Review' }),
  C('review.comments', 'Show Comments', null, () => comments.show(), { icon: 'comment', category: 'Review', checked: () => comments.visible }),
  C('review.nextComment', 'Next Comment', null, () => comments.step(1), { icon: 'chevronDown', category: 'Review', when: () => comments.ordered().length > 0 }),
  C('review.prevComment', 'Previous Comment', null, () => comments.step(-1), { icon: 'chevronUp', category: 'Review', when: () => comments.ordered().length > 0 }),
  C('review.deleteComments', 'Delete All Comments…', null, () => comments.removeAll(), { icon: 'trash', category: 'Review', when: () => comments.ordered().length > 0 }),
  C('tools.wordCount', 'Word Count…', 'Ctrl+Shift+G', () => wordCountDialog(), { icon: 'fileText', category: 'Review' }),
  C('tools.readAloud', 'Read Aloud', 'Ctrl+Alt+Space', () => readAloud(), { icon: 'speaker', category: 'Review', checked: () => !!speaking }),
  C('tools.goal', 'Word Goal…', null, () => goalDialog(), { icon: 'star', category: 'Review' }),
  C('tools.options', 'Options…', null, () => optionsDialog(), { icon: 'settings', category: 'Tools' }),
  C('tools.lookup', 'Search the Web for the Selection', null, () => lookUp(), { icon: 'search', category: 'Review' }),
  // Tables
  C('tbl.rowAbove', 'Insert Row Above', null, () => ed.tableOp('rowAbove'), { icon: 'insertRow', category: 'Table', when: () => !!st().cell }),
  C('tbl.rowBelow', 'Insert Row Below', null, () => ed.tableOp('rowBelow'), { icon: 'insertRow', category: 'Table', when: () => !!st().cell }),
  C('tbl.colLeft', 'Insert Column Left', null, () => ed.tableOp('colLeft'), { icon: 'insertCol', category: 'Table', when: () => !!st().cell }),
  C('tbl.colRight', 'Insert Column Right', null, () => ed.tableOp('colRight'), { icon: 'insertCol', category: 'Table', when: () => !!st().cell }),
  C('tbl.deleteRow', 'Delete Row', null, () => ed.tableOp('deleteRow'), { icon: 'deleteRow', category: 'Table', when: () => !!st().cell }),
  C('tbl.deleteCol', 'Delete Column', null, () => ed.tableOp('deleteCol'), { icon: 'trash', category: 'Table', when: () => !!st().cell }),
  C('tbl.delete', 'Delete Table', null, () => ed.tableOp('deleteTable'), { icon: 'trash', category: 'Table', when: () => !!st().cell }),
  C('tbl.merge', 'Merge Cells', null, () => ed.tableOp('merge'), { icon: 'merge', category: 'Table', when: () => ed.doc.querySelectorAll('.cell-sel').length > 1 }),
  C('tbl.split', 'Split Cell', null, () => ed.tableOp('split'), { icon: 'columns', category: 'Table', when: () => { const c = st().cell; return !!c && ((c.colSpan || 1) > 1 || (c.rowSpan || 1) > 1); } }),
  C('tbl.header', 'Header Row', null, () => ed.tableOp('header'), { icon: 'table', category: 'Table', when: () => !!st().cell, checked: () => !!(st().table && st().table.rows[0] && st().table.rows[0].cells[0] && st().table.rows[0].cells[0].tagName === 'TH') }),
  C('tbl.distribute', 'Distribute Columns Evenly', null, () => ed.tableOp('distribute'), { icon: 'distributeH', category: 'Table', when: () => !!st().cell }),
);

// ---------------------------------------------------------------------------
// Ribbon
// ---------------------------------------------------------------------------
const fontBox = combo({
  values: () => fontList, width: 170, tip: 'Font',
  itemStyle: (f) => ({ fontFamily: `"${f}"` }),
  onCommit: (v) => { if (v.trim()) ed.setFont(v.trim()); },
  update: (w) => w.set(st().font || ''),
});
let fontList = knownFonts();
fontBox.input.addEventListener('focus', async () => { fontList = await allFonts(); });
const sizeBox = combo({
  values: FONT_SIZES, width: 70, tip: 'Font size', numeric: true, min: 1, max: 400,
  onCommit: (v) => { const n = parseFloat(v); if (n > 0 && n < 1000) ed.setSize(n); },
  update: (w) => w.set(String(st().size || '')),
});
sizeBox.input.dataset.step = '1';

let lastColor = settings.get('lastColor', '#e5484d');
let lastHighlight = settings.get('lastHighlight', '#ffe066');
const colorBtn = tb({ icon: 'textColor', tip: 'Text colour', split: true, run: () => ed.setColor(lastColor), menu: () => [{ custom: colorPanel('color') }], cls: 'color-bar' });
colorBtn.button.style.setProperty('--swatch', lastColor);
const hlBtn = tb({ icon: 'highlighter', tip: 'Highlight', split: true, run: () => ed.setHighlight(lastHighlight), menu: () => [{ custom: colorPanel('highlight') }], cls: 'color-bar' });
hlBtn.button.style.setProperty('--swatch', lastHighlight);

function colorPanel(kind) {
  // Reuse the full picker inside the drop-down.
  const box = h('div');
  queueMicrotask(() => colorPick(box.closest('.menu') ? null : null, kind, box));
  return box;
}

function colorPick(anchor, kind, inlineBox = null) {
  const apply = (c) => {
    if (kind === 'color') {
      if (c !== 'none') { lastColor = c; settings.set('lastColor', c); colorBtn.button.style.setProperty('--swatch', c); }
      ed.setColor(c);
    } else {
      if (c !== 'none') { lastHighlight = c; settings.set('lastHighlight', c); hlBtn.button.style.setProperty('--swatch', c); }
      ed.setHighlight(c);
    }
  };
  if (inlineBox) {
    import('../../kit/color.js').then(({ colorPicker }) => {
      inlineBox.append(colorPicker({ value: kind === 'color' ? lastColor : lastHighlight, allowNone: true, noneLabel: kind === 'color' ? 'Automatic' : 'No highlight', onPick: (c) => { closeMenus(); apply(c); } }));
    });
    return;
  }
  pickColor(anchor || colorBtn, { value: kind === 'color' ? lastColor : lastHighlight, allowNone: true, onChange: apply });
}

const STYLES = [
  ['Normal', 'para.normal', 'font-size:12px'], ['Title', 'para.title', 'font-size:17px;font-weight:300'],
  ['Heading 1', 'para.h1', 'font-size:15px;font-weight:600;color:var(--highlight)'], ['Heading 2', 'para.h2', 'font-size:13.5px;font-weight:600;color:var(--highlight)'],
  ['Heading 3', 'para.h3', 'font-size:12.5px;font-weight:600'], ['Quote', 'para.quote', 'font-style:italic'], ['Code', 'para.code', 'font-family:var(--mono);font-size:11.5px'],
];
const styleGallery = h('div.style-gallery', ...STYLES.map(([name, id, css]) => {
  const b = h('button.style-chip', { 'data-tip': name, 'data-keys': commands.keysOf(id) }, h('span', { style: css.split(';').reduce((o, d) => { const [k, v] = d.split(':'); if (k) o[k.trim().replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v; return o; }, {}) }, name === 'Normal' ? 'Normal' : name));
  b.addEventListener('mousedown', (e) => e.preventDefault());
  b.addEventListener('click', () => commands.run(id));
  return b;
}));
const styleUpd = () => { const s = st().style; for (const b of styleGallery.children) b.classList.toggle('on', b.dataset.tip === s); };
document.addEventListener('selectionchange', debounce(styleUpd, 60));

const lineMenu = () => [1, 1.15, 1.5, 2, 2.5, 3].map((v) => ({ label: String(v), checked: () => Math.abs((parseFloat(st().block && st().block.style.lineHeight) || ed.meta.lineHeight) - v) < 0.01, run: () => ed.lineSpacing(v) }))
  .concat([{ type: 'separator' }, { label: 'Space before paragraph', run: () => ed.blockStyle('margin-top', '12pt', 'Spacing') }, { label: 'Remove space before', run: () => ed.blockStyle('margin-top', '0', 'Spacing') },
    { label: 'Space after paragraph', run: () => ed.blockStyle('margin-bottom', '12pt', 'Spacing') }, { label: 'Remove space after', run: () => ed.blockStyle('margin-bottom', '0', 'Spacing') }]);
const bulletMenu = () => [['Disc', 'disc'], ['Circle', 'circle'], ['Square', 'square'], ['Dash', '"– "']].map(([n, v]) => ({ label: n, run: () => ed.list('ul', v) }));
const numberMenu = () => [['1. 2. 3.', 'decimal'], ['a. b. c.', 'lower-alpha'], ['A. B. C.', 'upper-alpha'], ['i. ii. iii.', 'lower-roman'], ['I. II. III.', 'upper-roman'], ['01. 02. 03.', 'decimal-leading-zero']].map(([n, v]) => ({ label: n, run: () => ed.list('ol', v) }));

const marginPresets = [['Normal (1″)', 1, 1, 1, 1], ['Narrow (0.5″)', 0.5, 0.5, 0.5, 0.5], ['Moderate', 1, 0.75, 1, 0.75], ['Wide', 1, 2, 1, 2], ['Mirrored book (1″ / 1.25″)', 1, 1, 1, 1.25]];
const marginMenu = () => [...marginPresets.map(([n, t, r, b, l]) => ({ label: n, checked: () => { const m = ed.meta.page.margins; return m.top === t && m.right === r && m.bottom === b && m.left === l; }, run: () => setMeta('Margins', (m) => { m.page.margins = { top: t, right: r, bottom: b, left: l }; }) })), { type: 'separator' }, { label: 'Custom margins…', run: () => pageSetupDialog() }];
const sizeMenu = () => Object.entries(PAGE_SIZES).map(([k, p]) => ({ label: `${p.name} (${p.w}″ × ${p.h}″)`, checked: () => ed.meta.page.size === k, run: () => setMeta('Page size', (m) => { m.page.size = k; }) }));
const orientMenu = () => ['portrait', 'landscape'].map((o) => ({ label: o[0].toUpperCase() + o.slice(1), checked: () => ed.meta.page.orientation === o, run: () => setMeta('Orientation', (m) => { m.page.orientation = o; }) }));

const tableGrid = () => {
  const cells = [];
  const label = h('div.muted', { style: { textAlign: 'center', padding: '4px' } }, 'Insert a table');
  const grid = h('div.tgrid');
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 10; c++) {
      const cell = h('span', { dataset: { r, c } });
      cells.push(cell);
      grid.append(cell);
    }
  }
  grid.addEventListener('mousemove', (e) => {
    const t = e.target.dataset;
    if (t.r === undefined) return;
    for (const cell of cells) cell.classList.toggle('on', Number(cell.dataset.r) <= Number(t.r) && Number(cell.dataset.c) <= Number(t.c));
    label.textContent = `${Number(t.c) + 1} × ${Number(t.r) + 1} table`;
  });
  grid.addEventListener('click', (e) => {
    const t = e.target.dataset;
    if (t.r === undefined) return;
    closeMenus();
    ed.insertTable(Number(t.r) + 1, Number(t.c) + 1);
  });
  return h('div', label, grid);
};

const tableStyles = [['Grid', 'tbl-grid'], ['Rows only', 'tbl-rows'], ['Green header', 'tbl-green'], ['Grey header', 'tbl-grey'], ['Dark header', 'tbl-dark'], ['No borders', 'tbl-plain']];

shell.setRibbon([
  {
    id: 'home', label: 'Home', groups: [
      { label: 'Clipboard', items: [tb({ icon: 'paste', label: 'Paste', big: true, split: true, run: () => commands.run('edit.paste'), menu: () => [commands.item('edit.paste'), commands.item('edit.pastePlain'), commands.item('edit.pasteMarkdown')] }),
        h('div.rstack', tb('edit.cut'), tb('edit.copy'), tb('fmt.painter'))] },
      { label: 'Font', items: [h('div.rstack',
        h('div.row', { style: { gap: '2px' } }, fontBox, sizeBox, tb('fmt.grow'), tb('fmt.shrink'), tb('fmt.clear')),
        h('div.row', { style: { gap: '2px' } }, tb('fmt.bold'), tb('fmt.italic'), tb('fmt.underline'), tb('fmt.strike'), tb('fmt.sub'), tb('fmt.sup'), sep(), colorBtn, hlBtn))] },
      { label: 'Paragraph', items: [h('div.rstack',
        h('div.row', { style: { gap: '2px' } }, tb('para.bullets', { split: true, menu: bulletMenu }), tb('para.numbers', { split: true, menu: numberMenu }), tb('para.checklist'), sep(), tb('para.outdent'), tb('para.indent')),
        h('div.row', { style: { gap: '2px' } }, tb('para.left'), tb('para.center'), tb('para.right'), tb('para.justify'), sep(), tb({ icon: 'lineSpacing', tip: 'Line and paragraph spacing', menu: lineMenu })))] },
      { label: 'Styles', items: [styleGallery, tb({ icon: 'chevronDown', tip: 'More styles', menu: () => ['Normal', 'Title', 'Subtitle', 'Heading 1', 'Heading 2', 'Heading 3', 'Heading 4', 'Heading 5', 'Heading 6', 'Quote', 'Caption', 'Code'].map((n) => ({ label: n, checked: () => st().style === n, run: () => ed.setStyle(n) })) })] },
      { label: 'Editing', items: [h('div.rstack', tb('edit.find', { showLabel: true }), tb('edit.replace', { showLabel: true }), tb('edit.selectAll', { showLabel: true, icon: 'select' }))] },
    ],
  },
  {
    id: 'insert', label: 'Insert', groups: [
      { label: 'Pages', items: [tb('ins.pageBreak', { big: true, label: 'Page break' }), tb('ins.toc', { big: true, label: 'Contents', split: true, menu: () => [commands.item('ins.toc'), commands.item('ins.updateToc')] })] },
      { label: 'Tables', items: [tb({ icon: 'table', label: 'Table', big: true, menu: () => [{ custom: tableGrid() }, { type: 'separator' }, { label: 'Insert table…', icon: 'table', run: () => tableDialog() }] })] },
      { label: 'Illustrations', items: [tb('ins.picture', { big: true, label: 'Picture' })] },
      { label: 'Links', items: [tb('fmt.link', { big: true, label: 'Link' })] },
      { label: 'Notes', items: [tb('ins.footnote', { big: true, label: 'Footnote' }), tb('review.comment', { big: true, label: 'Comment' })] },
      { label: 'Layout', items: [tb('ins.cols2', { big: true, label: 'Columns', menu: () => [commands.item('ins.cols2'), commands.item('ins.cols3')] }), tb('ins.note', { big: true, label: 'Note box' })] },
      { label: 'Text', items: [h('div.rstack', tb('ins.date', { showLabel: true, label: 'Date' }), tb('ins.hr', { showLabel: true, label: 'Line' }), tb('para.code', { showLabel: true, label: 'Code' }))] },
      { label: 'Symbols', items: [tb({ icon: 'omega', label: 'Symbol', big: true, run: (b) => symbolPicker(b, 'symbols') }), tb({ icon: 'smile', label: 'Emoji', big: true, run: (b) => symbolPicker(b, 'emoji') })] },
    ],
  },
  {
    id: 'layout', label: 'Layout', groups: [
      { label: 'Page Setup', items: [tb({ icon: 'margins', label: 'Margins', big: true, menu: marginMenu }), tb({ icon: 'orientation', label: 'Orientation', big: true, menu: orientMenu }), tb({ icon: 'pageSize', label: 'Size', big: true, menu: sizeMenu }),
        tb({ icon: 'settings', label: 'Page setup', big: true, run: () => pageSetupDialog() })] },
      { label: 'Header & Footer', items: [tb({ icon: 'headerFooter', label: 'Header & footer', big: true, run: () => headerFooterDialog() }),
        tb({ icon: 'pageNumber', label: 'Page numbers', big: true, menu: () => pageNumberMenu() })] },
      { label: 'Background', items: [tb({ icon: 'palette', label: 'Page colour', big: true, run: (b) => pickColor(b, { value: ed.meta.pageColor, onChange: (c) => setMeta('Page colour', (m) => { m.pageColor = c === 'none' ? '#ffffff' : c; }), allowNone: true }) })] },
    ],
  },
  {
    id: 'review', label: 'Review', groups: [
      { label: 'Comments', items: [tb('review.comment', { big: true, label: 'New comment' }), h('div.rstack', tb('review.prevComment', { showLabel: true, label: 'Previous' }), tb('review.nextComment', { showLabel: true, label: 'Next' }), tb('review.deleteComments', { showLabel: true, label: 'Delete all' })), tb('review.comments', { big: true, label: 'Show comments' })] },
      { label: 'Proofing', items: [tb('view.spell', { big: true, label: 'Spelling' }), tb('tools.wordCount', { big: true, label: 'Word count' })] },
      { label: 'Speech', items: [tb('tools.readAloud', { big: true, label: 'Read aloud' })] },
      { label: 'Goals', items: [tb('tools.goal', { big: true, label: 'Word goal' })] },
      { label: 'Contents', items: [tb('ins.updateToc', { big: true, label: 'Update contents' })] },
    ],
  },
  {
    id: 'view', label: 'View', groups: [
      { label: 'Views', items: [tb('view.read', { big: true, label: 'Read mode' }), tb('view.focus', { big: true, label: 'Focus' }), tb('view.darkPage', { big: true, label: 'Dark page' })] },
      { label: 'Show', items: [h('div.rstack', tb('view.ruler', { showLabel: true }), tb('view.nav', { showLabel: true, label: 'Navigation' }), tb('view.typewriter', { showLabel: true, icon: 'text', label: 'Typewriter' }))] },
      { label: 'Zoom', items: [tb('view.zoomOut', { big: true, label: 'Out' }), tb('view.zoom100', { big: true, icon: 'search', label: '100%' }), tb('view.zoomIn', { big: true, label: 'In' }), tb('view.fitWidth', { big: true, label: 'Page width' }), tb('view.fitPage', { big: true, label: 'One page' })] },
    ],
  },
  {
    id: 'table', label: 'Table', contextual: true, visible: () => !!st().cell, groups: [
      { label: 'Rows & Columns', items: [h('div.rstack', tb('tbl.rowAbove', { showLabel: true, label: 'Row above' }), tb('tbl.rowBelow', { showLabel: true, label: 'Row below' })),
        h('div.rstack', tb('tbl.colLeft', { showLabel: true, label: 'Column left' }), tb('tbl.colRight', { showLabel: true, label: 'Column right' })),
        tb({ icon: 'trash', label: 'Delete', big: true, menu: () => [commands.item('tbl.deleteRow'), commands.item('tbl.deleteCol'), commands.item('tbl.delete')] })] },
      { label: 'Merge', items: [tb('tbl.merge', { big: true, label: 'Merge' }), tb('tbl.split', { big: true, label: 'Split' })] },
      { label: 'Style', items: [tb('tbl.header', { big: true, label: 'Header row' }), tb({ icon: 'palette', label: 'Style', big: true, menu: () => tableStyles.map(([n, c]) => ({ label: n, checked: () => !!(st().table && st().table.classList.contains(c)), run: () => ed.tableOp('style', c) })) }),
        tb({ icon: 'bucket', label: 'Shading', big: true, run: (b) => pickColor(b, { value: '#e7f5ea', allowNone: true, onChange: (c) => ed.tableOp('shade', c) }) })] },
      { label: 'Cell', items: [tb({ icon: 'alignObjMiddle', label: 'Align', big: true, menu: () => [['Top', 'top'], ['Middle', 'middle'], ['Bottom', 'bottom']].map(([n, v]) => ({ label: n, run: () => ed.tableOp('valign', v) })) }), tb('tbl.distribute', { big: true, label: 'Even columns' })] },
    ],
  },
  {
    id: 'picture', label: 'Picture', contextual: true, visible: () => !!ed.selectedImage, groups: [
      { label: 'Layout', items: [tb({ icon: 'alignLeft', label: 'In line', big: true, run: () => ed.imageStyle('inline') }), tb({ icon: 'alignObjLeft', label: 'Left', big: true, run: () => ed.imageStyle('left') }),
        tb({ icon: 'alignObjCenter', label: 'Centre', big: true, run: () => ed.imageStyle('center') }), tb({ icon: 'alignObjRight', label: 'Right', big: true, run: () => ed.imageStyle('right') })] },
      { label: 'Size', items: [tb({ icon: 'resize', label: 'Size', big: true, menu: () => [['Quarter width', 0.25], ['Half width', 0.5], ['Three quarters', 0.75], ['Full width', 1], ['Original size', 0]].map(([n, f]) => ({ label: n, run: () => ed.imageSize(f) })) })] },
      { label: 'Arrange', items: [tb({ icon: 'rotateCcw', label: 'Left', big: true, run: () => ed.rotateImage(-90) }), tb({ icon: 'rotateCw', label: 'Right', big: true, run: () => ed.rotateImage(90) })] },
      { label: 'Style', items: [tb({ icon: 'square', label: 'Border', big: true, run: () => ed.imageToggle('img-border'), on: () => !!(ed.selectedImage && ed.selectedImage.classList.contains('img-border')) }),
        tb({ icon: 'layers', label: 'Shadow', big: true, run: () => ed.imageToggle('img-shadow'), on: () => !!(ed.selectedImage && ed.selectedImage.classList.contains('img-shadow')) }),
        tb({ icon: 'text', label: 'Alt text', big: true, run: () => altTextDialog() })] },
    ],
  },
]);

function pageNumberMenu() {
  const put = (zone, where) => setMeta('Page numbers', (m) => {
    m.header = { ...m.header };
    m.footer = { ...m.footer };
    for (const z of ['left', 'center', 'right']) {
      m.header[z] = m.header[z].replace(/(Page )?\{page\}( of \{pages\})?/g, '').trim();
      m.footer[z] = m.footer[z].replace(/(Page )?\{page\}( of \{pages\})?/g, '').trim();
    }
    if (zone) m[where][zone] = settings.get('pageNumberStyle', '{page}');
  });
  return [
    { label: 'Bottom centre', run: () => put('center', 'footer') }, { label: 'Bottom right', run: () => put('right', 'footer') },
    { label: 'Top right', run: () => put('right', 'header') }, { type: 'separator' },
    { label: 'Style: 1', checked: () => settings.get('pageNumberStyle', '{page}') === '{page}', run: () => settings.set('pageNumberStyle', '{page}') },
    { label: 'Style: Page 1 of 9', checked: () => settings.get('pageNumberStyle', '{page}') !== '{page}', run: () => settings.set('pageNumberStyle', 'Page {page} of {pages}') },
    { type: 'separator' }, { label: 'Remove page numbers', run: () => put(null) },
  ];
}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------
const I = (id, extra) => commands.item(id, extra);
function fileMenu() {
  return [I('file.new'), I('app.newWindow'), I('file.open'), { label: 'Open Recent', icon: 'clock', submenu: () => recentItems() }, { type: 'separator' },
    I('file.save'), I('file.saveAs'), { label: 'Export', icon: 'export', submenu: [I('file.pdf'), I('file.docx'), I('file.html'), I('file.md'), I('file.txt')] },
    { type: 'separator' }, I('file.print'), I('file.pageSetup'), I('file.properties'), I('file.reveal'), { type: 'separator' }, I('file.home'), I('app.close')];
}
function editMenu() {
  return [I('edit.undo', { label: ed.history.undoLabel ? `Undo ${ed.history.undoLabel}` : 'Undo' }), I('edit.redo', { label: ed.history.redoLabel ? `Redo ${ed.history.redoLabel}` : 'Redo' }), { type: 'separator' },
    I('edit.cut'), I('edit.copy'), I('edit.paste'), I('edit.pastePlain'), I('edit.pasteMarkdown'), { type: 'separator' }, I('edit.selectAll'), I('edit.find'), I('edit.replace'), I('edit.goto')];
}
function viewMenu() {
  return [I('view.read'), I('view.focus'), I('view.typewriter'), I('view.darkPage'), { type: 'separator' }, I('view.nav'), I('view.ruler'), I('view.ribbon'),
    { type: 'separator' }, I('view.zoomIn'), I('view.zoomOut'), I('view.zoom100'), I('view.fitWidth'), I('view.fitPage'),
    { type: 'separator' }, I('view.themeDark'), I('view.themeLight'), I('view.themeSystem'), { label: 'Interface size', submenu: [I('view.uiBigger'), I('view.uiSmaller'), I('view.uiReset')] }, I('view.fullscreen')];
}
function insertMenu() {
  return [I('ins.table'), I('ins.picture'), I('fmt.link'), { type: 'separator' }, I('ins.footnote'), I('review.comment'), { type: 'separator' }, I('ins.pageBreak'), I('ins.hr'), I('ins.cols2'), I('ins.cols3'), I('ins.note'),
    { type: 'separator' }, I('ins.symbol'), I('ins.date'), I('ins.toc'), I('ins.updateToc')];
}
function formatMenu() {
  return [I('fmt.bold'), I('fmt.italic'), I('fmt.underline'), I('fmt.strike'), I('fmt.sub'), I('fmt.sup'), { type: 'separator' },
    { label: 'Paragraph style', submenu: () => ['Normal', 'Title', 'Subtitle', 'Heading 1', 'Heading 2', 'Heading 3', 'Heading 4', 'Quote', 'Caption', 'Code'].map((n) => ({ label: n, checked: () => st().style === n, run: () => ed.setStyle(n) })) },
    { label: 'Align', submenu: [I('para.left'), I('para.center'), I('para.right'), I('para.justify')] },
    { label: 'Line spacing', submenu: lineMenu }, { label: 'Lists', submenu: [I('para.bullets'), I('para.numbers'), I('para.checklist')] },
    I('para.indent'), I('para.outdent'), { type: 'separator' }, I('fmt.color'), I('fmt.highlight'), I('fmt.painter'), I('fmt.clear')];
}
function toolsMenu() {
  return [I('review.comment'), I('review.comments'), I('review.prevComment'), I('review.nextComment'), I('review.deleteComments'), { type: 'separator' }, I('tools.wordCount'), I('tools.readAloud'), I('tools.goal'), I('view.spell'), I('tools.lookup'), { type: 'separator' }, I('tools.options')];
}

// Recent files load asynchronously: fill the submenu when it is asked for.
let recentCache = [];
const refreshRecent = () => host.recent().then((r) => { recentCache = r; }).catch(() => {});
refreshRecent();
function recentItems() {
  if (!recentCache.length) return [{ label: 'No recent documents', disabled: true }];
  return recentCache.slice(0, 15).map((r) => ({ label: r.name, tip: r.dir, disabled: !r.exists, run: () => openRecent(r) }))
    .concat([{ type: 'separator' }, { label: 'Clear list', run: async () => { for (const r of recentCache) await host.forgetRecent(r.key); refreshRecent(); } }]);
}
// ---------------------------------------------------------------------------
// Status bar
// ---------------------------------------------------------------------------
const pageItem = h('button.item', { 'data-tip': 'Go to page (Ctrl+G)' }, 'Page 1 of 1');
pageItem.addEventListener('click', () => gotoPage());
const wordsItem = h('button.item', { 'data-tip': 'Word count (Ctrl+Shift+G)' }, '0 words');
wordsItem.addEventListener('click', () => wordCountDialog());
const goalItem = h('button.item.hidden', { 'data-tip': 'Word goal' });
goalItem.addEventListener('click', () => goalDialog());
const saveItem = h('span.item.muted');
const zoomBox = shell.zoomBox({ get: () => ed.zoom, set: (z) => ed.setZoom(z), min: 0.25, max: 5, fit: [{ label: 'Page width', run: () => ed.fitWidth() }, { label: 'One page', run: () => ed.fitPage() }] });
const viewBtns = h('div.row', { style: { gap: '0', height: '100%' } },
  tb('view.read', { cls: 'status-tb' }), tb('view.focus', { cls: 'status-tb' }), tb('view.nav', { cls: 'status-tb' }));
shell.statusLeft.append(pageItem, wordsItem, goalItem, saveItem);
shell.statusRight.append(viewBtns, zoomBox);

let goalHit = false;
function updateStatus(s) {
  if (s.pages || s.page) pageItem.textContent = `Page ${s.page || ed.currentPage()} of ${ed.pages}`;
  if (s.zoom !== undefined) zoomBox.update();
  if (s.words !== undefined) {
    wordsItem.textContent = s.selWords ? `${s.selWords.toLocaleString()} of ${s.words.toLocaleString()} words` : `${s.words.toLocaleString()} words`;
    const goal = ed.meta.goal || 0;
    goalItem.classList.toggle('hidden', !goal);
    if (goal) {
      const pct = Math.min(1, s.words / goal);
      goalItem.replaceChildren(h('span.goal-bar', h('span', { style: { width: `${pct * 100}%` } })), `${Math.round(pct * 100)}%`);
      if (pct >= 1 && !goalHit) { goalHit = true; toast(`Goal reached: ${goal.toLocaleString()} words. Nice work!`); }
      if (pct < 1) goalHit = false;
    }
  }
}

function updateTitle() {
  const dirty = ed.history.dirty || ed.typing;
  shell.setTitle(doc.name, dirty);
  saveItem.textContent = dirty ? 'Not saved' : (doc.file ? 'Saved' : '');
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------
function pristine() {
  return !doc.file && !ed.history.dirty && !ed.typing && ed.doc.textContent.trim() === '' && !ed.doc.querySelector('img, table');
}

function loadDocument(html, meta, { name = 'Untitled', file = null, format = 'snakedoc' } = {}) {
  const clean = sanitizeToString(html, { keepClasses: DOC_CLASSES, idPattern: /^h-[\w-]{1,60}$/, customProps: ['--n'] });
  ed.load(clean, meta);
  doc.file = file;
  doc.name = name;
  doc.format = format;
  doc.id = uid('doc');
  doc.opened = true;
  start.hide();
  updateTitle();
  buildNav();
  comments.active = null;
  comments.editing = null;
  if (!isPhone()) comments.show(settings.get('comments', false) ? true : comments.ordered().length > 0);
  else comments.paint();
  setTimeout(() => { ed.layout(); if (isPhone()) ed.fitWidth(); }, 50);
  ed.focus();
}

async function parseFile(file, bytes) {
  const ext = extOf(file.name);
  if (ext === 'docx') return { ...(await readDocx(bytes)), format: 'docx' };
  if (ext === 'odt') return { ...(await readOdt(bytes)), format: 'odt' };
  const text = decodeText(bytes);
  if (ext === 'snakedoc') {
    const j = JSON.parse(text);
    if (j.format !== 'snakedoc') throw new Error("This is not a Snake's Word document.");
    return { html: j.html, meta: j.meta, format: 'snakedoc' };
  }
  if (ext === 'html' || ext === 'htm') {
    const d = new DOMParser().parseFromString(text, 'text/html');
    return { html: d.body ? d.body.innerHTML : text, meta: { ...defaultMeta(), title: d.title || '' }, format: 'html' };
  }
  if (ext === 'md' || ext === 'markdown') return { html: markdownToHtml(text), meta: defaultMeta(), format: 'md' };
  if (ext === 'rtf') return { html: rtfToHtml(text), meta: defaultMeta(), format: 'rtf' };
  return { html: textToHtml(text), meta: defaultMeta(), format: 'txt' };
}

async function openFile(file, { here = false } = {}) {
  if (!here && !pristine() && host.openInNewWindow && file.id) {
    host.openInNewWindow(file);
    return;
  }
  if (!here && !pristine() && !(await confirmLeave())) return;
  const b = busy(`Opening ${file.name}…`);
  try {
    const bytes = await host.read(file);
    const parsed = await parseFile(file, bytes);
    const keep = ['snakedoc', 'docx', 'html', 'md', 'txt'].includes(parsed.format);
    loadDocument(parsed.html, parsed.meta, { name: file.name, file: keep ? file : null, format: keep ? parsed.format : 'docx' });
    if (!keep) toast(`Opened a copy: saving will make a new .docx (the original ${extOf(file.name).toUpperCase()} stays as it is).`, { timeout: 6000 });
    refreshRecent();
  } catch (err) {
    errorToast(err);
  } finally {
    b.close();
  }
}

async function confirmLeave() {
  if (!(ed.history.dirty || ed.typing)) return true;
  const { saveChangesBox } = await import('../../kit/dialogs.js');
  const r = await saveChangesBox(doc.name);
  if (r === 'save') return save();
  return r === 'discard';
}

async function openDialog() {
  const files = await host.openFiles({ filters: DOC_FILTERS, multiple: true });
  for (const f of files) await openFile(f);
}

async function openRecent(r) {
  try {
    const f = await host.openRecent(r.key);
    await openFile(f);
  } catch (err) { errorToast(err); refreshRecent(); }
}

async function newDocument(template = TEMPLATES[0]) {
  if (!pristine() && doc.opened) {
    if (inElectron) { host.win.newWindow(`new=${template.id}`); return; }
    if (!(await confirmLeave())) return;
  }
  const meta = { ...defaultMeta(), ...(template.meta || {}) };
  loadDocument(template.html(), meta, { name: template.id === 'blank' ? 'Untitled' : `${template.name}`, file: null });
}

async function serialize(format) {
  ed.commit('Typing');
  const html = ed.html();
  const meta = ed.meta;
  switch (format) {
    case 'docx': return writeDocx(html, meta);
    case 'html': return htmlPage(notesAtEnd(html, 'html'), meta);
    case 'md': return htmlToMarkdown(notesAtEnd(html, 'md'));
    case 'txt': return htmlToText(notesAtEnd(html, 'txt'));
    default: return JSON.stringify({ format: 'snakedoc', version: 1, app: "Snake's Word", meta, html });
  }
}

/** For formats without footnotes or comments: the notes numbered at the end, comment marks gone. */
function notesAtEnd(html, format) {
  const box = document.createElement('div');
  box.innerHTML = html;
  for (const c of box.querySelectorAll('span.cmt')) c.replaceWith(...c.childNodes);
  const refs = [...box.querySelectorAll('sup.fn-ref')];
  if (!refs.length) return box.innerHTML;
  const notes = refs.map((r, i) => {
    const n = i + 1;
    const note = r.dataset.note || '';
    if (format === 'html') {
      const sup = document.createElement('sup');
      sup.innerHTML = `<a href="#fn-${n}" id="fnref-${n}">${n}</a>`;
      r.replaceWith(sup);
      return `<li id="fn-${n}">${note} <a href="#fnref-${n}" aria-label="Back">↩</a></li>`;
    }
    r.replaceWith(format === 'md' ? `[^${n}]` : `[${n}]`);
    return format === 'md' ? `<p>[^${n}]: ${note}</p>` : `<p>[${n}] ${note}</p>`;
  });
  return format === 'html' ? `${box.innerHTML}<hr><ol class="footnotes">${notes.join('')}</ol>` : `${box.innerHTML}<hr>${notes.join('')}`;
}

function htmlPage(html, meta) {
  const css = [...document.styleSheets].map((s) => { try { return [...s.cssRules].map((r) => r.cssText).filter((t) => t.startsWith('.doc') || t.includes('.doc ')).join('\n'); } catch { return ''; } }).join('\n');
  return `<!doctype html>\n<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(meta.title || doc.name)}</title>
<style>:root{--doc-font:"Carlito","Calibri","Aptos","Segoe UI","Inter","Noto Sans","Liberation Sans",Arial,sans-serif}body{margin:0;background:#f4f6f4}.doc{max-width:${8.5 * 96 - 192}px;margin:40px auto;padding:48px;background:#fff;box-shadow:0 2px 12px rgba(0,0,0,.12);font-family:${meta.font ? fontStack(meta.font, 'var(--doc-font)') : 'var(--doc-font)'};font-size:${meta.fontSize}pt;line-height:${meta.lineHeight}}
${css}
${ed.styleCss('.doc')}</style></head><body><div class="doc">${html}</div></body></html>\n`;
}

async function save() {
  if (!doc.file || !doc.file.writable || !SAVE_FORMATS[doc.format]) return saveAs();
  try {
    const data = await serialize(doc.format);
    doc.file = await host.write(doc.file, data);
    ed.history.markSaved();
    host.recovery.delete(doc.id).catch(() => {});
    updateTitle();
    toast(`Saved ${doc.name}`, { timeout: 1500 });
    return true;
  } catch (err) { errorToast(err); return false; }
}

async function saveAs(format = null) {
  const fmt = format || (doc.format && SAVE_FORMATS[doc.format] ? doc.format : 'snakedoc');
  const base = baseName(doc.name === 'Untitled' ? (ed.meta.title || firstLine() || 'Untitled') : doc.name);
  const filters = format ? [SAVE_FORMATS[fmt]] : [SAVE_FORMATS[fmt], ...Object.entries(SAVE_FORMATS).filter(([k]) => k !== fmt).map(([, v]) => v)];
  try {
    const data = await serialize(fmt);
    const f = await host.saveAs({ name: `${base}.${SAVE_FORMATS[fmt].exts[0]}`, filters, near: doc.file && doc.file.id }, data);
    if (!f) return false;
    const realFmt = SAVE_FORMATS[extOf(f.name)] ? extOf(f.name) : fmt;
    if (realFmt !== fmt) {
      // The person typed another extension: write that format instead.
      await host.write(f, await serialize(realFmt));
    }
    if (!format || ['snakedoc', 'docx'].includes(realFmt)) {
      doc.file = f;
      doc.name = f.name;
      doc.format = realFmt;
      ed.history.markSaved();
      host.recovery.delete(doc.id).catch(() => {});
    }
    updateTitle();
    refreshRecent();
    toast(`Saved ${f.name}`, { timeout: 1800 });
    return true;
  } catch (err) { errorToast(err); return false; }
}

function firstLine() {
  const el = ed.doc.querySelector('h1, p.title, p, h2');
  return el ? el.textContent.trim().slice(0, 60).replace(/[\\/:*?"<>|]/g, '') : '';
}

async function exportPdf() {
  ed.commit('Typing');
  document.body.classList.add('printing');
  ed.clearFind();
  ed.preparePrint();
  try {
    if (inElectron) {
      const f = await host.printPDF({ name: baseName(doc.name === 'Untitled' ? firstLine() || 'Document' : doc.name) });
      if (f) toast(`Exported ${f.name}`, { action: { label: 'Show', run: () => host.reveal(f) } });
    } else await host.printPDF();
  } catch (err) { errorToast(err); } finally { ed.endPrint(); document.body.classList.remove('printing'); }
}

async function print() {
  document.body.classList.add('printing');
  ed.preparePrint();
  try { await host.print(); } finally { ed.endPrint(); document.body.classList.remove('printing'); }
}

async function pasteFromClipboard(opts) {
  ed.focus();
  try {
    const items = await navigator.clipboard.read();
    const data = { html: '', text: '', files: [] };
    for (const it of items) {
      for (const type of it.types) {
        const blob = await it.getType(type);
        if (type === 'text/html') data.html = await blob.text();
        else if (type === 'text/plain') data.text = await blob.text();
        else if (type.startsWith('image/')) data.files.push(new File([blob], 'Pasted picture.png', { type }));
      }
    }
    const fake = { clipboardData: { files: data.files, getData: (t) => (t === 'text/html' ? data.html : t === 'text/plain' ? data.text : '') }, preventDefault() {} };
    await ed.paste(fake, opts);
  } catch {
    toast('Use Ctrl+V to paste here (the clipboard could not be read from the menu).', { type: 'warn' });
  }
}

// ---------------------------------------------------------------------------
// Dialogs
// ---------------------------------------------------------------------------
function setMeta(label, fn) {
  ed.change(label, () => {
    const m = JSON.parse(JSON.stringify(ed.meta));
    fn(m);
    ed.meta = m;
    ed.applyPage();
    ed.drawSheets();
  });
  ed.layout();
}

function pageSetupDialog() {
  const m = JSON.parse(JSON.stringify(ed.meta));
  const metric = settings.get('units', 'in') === 'cm';
  const conv = (v) => Math.round((metric ? v * 2.54 : v) * 100) / 100;
  const back = (v) => (metric ? v / 2.54 : v);
  const num = (v) => h('input.input.num', { type: 'number', step: metric ? 0.1 : 0.05, min: 0, max: metric ? 10 : 4, value: conv(v), style: { width: '80px' } });
  const size = select({ options: Object.entries(PAGE_SIZES).map(([k, p]) => ({ value: k, label: `${p.name} (${p.w}″ × ${p.h}″)` })), value: m.page.size, onChange: () => {} });
  const orient = select({ options: [{ value: 'portrait', label: 'Portrait' }, { value: 'landscape', label: 'Landscape' }], value: m.page.orientation, onChange: () => {} });
  const mt = num(m.page.margins.top); const mr = num(m.page.margins.right); const mb = num(m.page.margins.bottom); const ml = num(m.page.margins.left);
  const font = combo({ values: () => fontList, value: m.font || '', width: 200, onCommit: () => {}, itemStyle: (f) => ({ fontFamily: `"${f}"` }) });
  const fsize = h('input.input.num', { type: 'number', min: 6, max: 72, step: 0.5, value: m.fontSize });
  const lh = h('input.input.num', { type: 'number', min: 0.8, max: 4, step: 0.05, value: m.lineHeight });
  const first = h('input', { type: 'checkbox', checked: !!m.firstPageDifferent });
  const unit = metric ? 'cm' : 'in';
  const body = h('div.col', { style: { gap: '10px', minWidth: '420px' } },
    h('label.field', h('span', 'Paper size'), size), h('label.field', h('span', 'Orientation'), orient),
    h('div.field', h('span', `Margins (${unit})`), h('div.row', h('span.muted', 'Top'), mt, h('span.muted', 'Bottom'), mb)),
    h('div.field', h('span', ''), h('div.row', h('span.muted', 'Left'), ml, h('span.muted', 'Right'), mr)),
    h('div.field', h('span', 'Document font'), font), h('div.field', h('span', 'Font size (pt)'), fsize),
    h('div.field', h('span', 'Line spacing'), lh),
    h('label.check', first, 'No header or footer on the first page'));
  modal({ title: 'Page setup', body, buttons: [{ label: 'Cancel', value: false }, { label: 'Apply', value: true, primary: true }] }).then((ok) => {
    if (!ok) return;
    setMeta('Page setup', (x) => {
      x.page = { size: size.value, orientation: orient.value, margins: { top: back(+mt.value), right: back(+mr.value), bottom: back(+mb.value), left: back(+ml.value) } };
      x.font = font.input.value.trim();
      x.fontSize = clamp(+fsize.value || 11, 6, 72);
      x.lineHeight = clamp(+lh.value || 1.15, 0.8, 4);
      x.firstPageDifferent = first.checked;
    });
  });
}

function headerFooterDialog() {
  const m = ed.meta;
  let focused = null;
  const inp = (v) => {
    const i = h('input.input', { value: v || '', spellcheck: false, style: { width: '100%' } });
    i.addEventListener('focus', () => { focused = i; });
    return i;
  };
  const hl = inp(m.header.left); const hc = inp(m.header.center); const hr = inp(m.header.right);
  const fl = inp(m.footer.left); const fc = inp(m.footer.center); const fr = inp(m.footer.right);
  const first = h('input', { type: 'checkbox', checked: !!m.firstPageDifferent });
  const field = (label, code) => {
    const b = h('button.btn.small', label);
    b.addEventListener('mousedown', (e) => e.preventDefault());
    b.addEventListener('click', () => {
      const i = focused || hc;
      const s = i.selectionStart ?? i.value.length;
      i.value = i.value.slice(0, s) + code + i.value.slice(i.selectionEnd ?? s);
      i.focus();
    });
    return b;
  };
  const grid = (a, b, c) => h('div', { style: { display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '6px' } }, a, b, c);
  const body = h('div.col', { style: { minWidth: '560px' } },
    h('div.muted', 'Each line has a left, centre and right part. Fields fill in on every page.'),
    h('b', 'Header'), grid(hl, hc, hr), h('b', 'Footer'), grid(fl, fc, fr),
    h('div.row', h('span.muted', 'Insert field:'), field('Page number', '{page}'), field('Page count', '{pages}'), field('Title', '{title}'), field('Date', '{date}')),
    h('label.check', first, 'Different first page (nothing on page 1)'));
  modal({ title: 'Header and footer', body, buttons: [{ label: 'Cancel', value: false }, { label: 'Apply', value: true, primary: true }] }).then((ok) => {
    if (!ok) return;
    setMeta('Header and footer', (x) => {
      x.header = { left: hl.value, center: hc.value, right: hr.value };
      x.footer = { left: fl.value, center: fc.value, right: fr.value };
      x.firstPageDifferent = first.checked;
    });
  });
}

function propertiesDialog() {
  const title = h('input.input', { value: ed.meta.title || '' });
  const author = h('input.input', { value: ed.meta.author || '' });
  const s = ed.stats();
  modal({
    title: 'Document properties',
    body: h('div.col', { style: { minWidth: '380px' } }, h('label.field', h('span', 'Title'), title), h('label.field', h('span', 'Author'), author),
      h('div.muted', `${s.pages} pages · ${s.words.toLocaleString()} words · ${doc.file ? doc.name : 'not saved yet'}`)),
    buttons: [{ label: 'Cancel', value: false }, { label: 'OK', value: true, primary: true }],
  }).then((ok) => { if (ok) setMeta('Properties', (m) => { m.title = title.value; m.author = author.value; }); });
}

async function linkDialog() {
  const s = st();
  const sel = window.getSelection();
  const text = h('input.input', { value: s.link ? s.link.textContent : (sel ? sel.toString() : ''), placeholder: 'Text to show' });
  const url = h('input.input', { value: s.link ? s.link.getAttribute('href') : '', placeholder: 'https://example.com', spellcheck: false });
  const heads = ed.headings().filter((x) => x.level >= 1);
  const jump = heads.length ? select({ options: [{ value: '', label: 'or jump to a heading…' }, ...heads.map((x, i) => ({ value: String(i), label: `${'  '.repeat(x.level - 1)}${x.text}` }))], onChange: (v) => {
    if (v === '') return;
    const el = heads[Number(v)].el;
    if (!el.id) el.id = `h-${uid('')}`;
    url.value = `#${el.id}`;
    if (!text.value) text.value = heads[Number(v)].text;
  } }) : null;
  const saved = ed.saveSelection();
  const buttons = [{ label: 'Cancel', value: false }, { label: s.link ? 'Update' : 'Insert', value: true, primary: true }];
  if (s.link) buttons.unshift({ label: 'Remove link', value: 'remove', danger: true, left: true });
  const r = await modal({ title: s.link ? 'Edit link' : 'Insert link', body: h('div.col', { style: { minWidth: '400px' } }, h('label.field', h('span', 'Text'), text), h('label.field', h('span', 'Address'), url), jump), buttons });
  ed.focus();
  ed.restoreSelection(saved);
  if (r === 'remove') { ed.unlink(); return; }
  if (!r || !url.value.trim()) return;
  if (s.link) {
    ed.change('Edit link', () => { s.link.setAttribute('href', /^(https?:|mailto:|#)/i.test(url.value) ? url.value : `https://${url.value}`); if (text.value) s.link.textContent = text.value; });
  } else ed.link(url.value.trim(), text.value && text.value !== (window.getSelection() || '').toString() ? text.value : '');
}

function tableDialog() {
  const rows = h('input.input.num', { type: 'number', min: 1, max: 200, value: 3 });
  const cols = h('input.input.num', { type: 'number', min: 1, max: 30, value: 3 });
  const style = select({ options: tableStyles.map(([n, c]) => ({ value: c, label: n })), value: 'tbl-grid', onChange: () => {} });
  const saved = ed.saveSelection();
  modal({ title: 'Insert table', body: h('div.col', h('label.field', h('span', 'Columns'), cols), h('label.field', h('span', 'Rows'), rows), h('label.field', h('span', 'Style'), style)),
    buttons: [{ label: 'Cancel', value: false }, { label: 'Insert', value: true, primary: true }] }).then((ok) => {
    if (!ok) return;
    ed.focus();
    ed.restoreSelection(saved);
    ed.insertTable(clamp(+rows.value || 3, 1, 200), clamp(+cols.value || 3, 1, 30), style.value);
  });
}

async function insertPicture() {
  const saved = ed.saveSelection();
  const files = await host.openFiles({ filters: [{ name: 'Pictures', exts: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'] }], multiple: true, readOnly: true });
  ed.focus();
  ed.restoreSelection(saved);
  for (const f of files) {
    try {
      const bytes = await host.read(f);
      const type = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', bmp: 'image/bmp', avif: 'image/avif' }[extOf(f.name)] || 'image/png';
      await ed.insertImageFile(new File([bytes], f.name, { type }));
    } catch (err) { errorToast(err); }
  }
}

function altTextDialog() {
  const img = ed.selectedImage;
  if (!img) return;
  promptBox('Alternative text', { label: 'Describe the picture for people who cannot see it (screen readers read this).', value: img.alt || '', multiline: true }).then((v) => {
    if (v !== null) ed.change('Alt text', () => { img.alt = v; });
  });
}

function wordCountDialog() {
  const s = ed.stats();
  const row = (k, v) => h('div.row', { style: { justifyContent: 'space-between', gap: '40px' } }, h('span.muted', k), h('b', typeof v === 'number' ? v.toLocaleString() : v));
  modal({
    title: 'Word count',
    body: h('div.col', { style: { minWidth: '300px' } }, row('Pages', s.pages), row('Words', s.words), row('Characters (no spaces)', s.charsNoSpaces), row('Characters (with spaces)', s.chars),
      row('Paragraphs', s.paragraphs), s.selWords ? row('Words selected', s.selWords) : null, row('Reading time', `${s.readMinutes} min`), row('Speaking time', `${s.speakMinutes} min`)),
    buttons: [{ label: 'Close', value: true, primary: true }],
  });
}

function goalDialog() {
  promptBox('Word goal', { label: 'How many words are you aiming for? (0 turns the goal off)', value: String(ed.meta.goal || 1000) }).then((v) => {
    if (v === null) return;
    const n = Math.max(0, parseInt(v, 10) || 0);
    setMeta('Word goal', (m) => { m.goal = n; });
    ed.stats();
  });
}

function gotoPage() {
  promptBox('Go to page', { label: `Page number (1 – ${ed.pages})`, value: String(ed.currentPage()) }).then((v) => {
    const n = parseInt(v, 10);
    if (n >= 1) ed.scrollToPage(Math.min(n, ed.pages));
  });
}

function optionsDialog() {
  const opt = (key, def, label) => {
    const c = h('input', { type: 'checkbox', checked: settings.get(key, def) });
    c.addEventListener('change', () => settings.set(key, c.checked));
    return h('label.check', c, label);
  };
  const units = select({ options: [{ value: 'in', label: 'Inches' }, { value: 'cm', label: 'Centimetres' }], value: settings.get('units', 'in'), onChange: (v) => { settings.set('units', v); ed.drawRuler(); } });
  const autosave = select({ options: [{ value: '0', label: 'Off' }, { value: '30', label: 'Every 30 seconds' }, { value: '120', label: 'Every 2 minutes' }], value: String(settings.get('autosaveFile', 0)), onChange: (v) => settings.set('autosaveFile', Number(v)) });
  modal({
    title: 'Options',
    body: h('div.col', { style: { minWidth: '420px', gap: '9px' } },
      h('b', 'While you type'), opt('smartQuotes', true, 'Curly “smart” quotes'), opt('autocorrect', true, 'AutoCorrect: (c) → ©, -> → →, -- → —, ... → …'),
      opt('markdown', true, 'Markdown shortcuts: # heading, - list, **bold**, `code`'), opt('slashMenu', true, 'Type / at the start of a line to insert blocks'),
      h('b', 'Saving'), h('label.field', h('span', 'Save to the file'), autosave), h('div.muted', { style: { fontSize: '12px' } }, 'A recovery copy is always kept while you work, whatever you choose here.'),
      h('b', 'Measurements'), h('label.field', h('span', 'Units'), units)),
    buttons: [{ label: 'Close', value: true, primary: true }],
  });
}

// ---- symbols and emoji ----
const SYMBOLS = '© ® ™ § ¶ † ‡ • … – — ‘ ’ “ ” « » ‹ › ° ± × ÷ ≈ ≠ ≤ ≥ ∞ √ ∑ ∏ ∫ ∂ ∆ ∇ π µ Ω α β γ δ ε θ λ σ φ ψ ω ½ ⅓ ⅔ ¼ ¾ ⅛ ¹ ² ³ € £ ¥ ¢ ₹ ₽ ₩ ← ↑ → ↓ ↔ ↕ ⇐ ⇒ ⇔ ↩ ↪ ✓ ✗ ✔ ✘ ★ ☆ ♥ ♦ ♣ ♠ ☐ ☑ ☒ ● ○ ■ □ ▲ △ ▼ ▽ ◆ ◇ ♪ ♫ ☀ ☁ ☂ ☎ ✉ ✂ ✎ ⌘ ⌥ ⇧ ⏎ ⌫'.split(' ');
const EMOJI = '😀 😃 😄 😁 😆 😅 😂 🤣 😊 😇 🙂 😉 😍 🥰 😘 😋 😎 🤓 🤔 🤨 😐 😑 😶 🙄 😏 😬 😴 😷 🤒 🥳 😢 😭 😤 😠 😱 🤯 👍 👎 👌 ✌️ 🤞 👏 🙌 🙏 💪 👋 👀 🧠 ❤️ 🧡 💛 💚 💙 💜 🖤 💯 ✅ ❌ ⚠️ ❓ ❗ 💡 🔥 ⭐ 🌟 ✨ 🎉 🎊 🎁 🏆 🥇 📌 📎 📝 📅 📈 📉 📊 📁 📄 📚 ✏️ 🖊️ 💻 🖥️ 📱 ⌚ 📷 🎵 🎧 🎮 🐍 🐢 🐶 🐱 🦊 🐻 🐼 🌱 🌳 🌸 🌍 ☀️ 🌙 ⛅ ☔ ❄️ 🍎 🍕 🍔 ☕ 🍺 🚀 ✈️ 🚗 🏠 🏢 ⏰ 🔒 🔑 💰 💬 📣 🔔'.split(' ');
function symbolPicker(anchor, tab = 'symbols') {
  const saved = ed.saveSelection();
  const grid = h('div.sym-grid');
  const fill = (list) => {
    grid.replaceChildren(...list.map((s) => {
      const b = h('button', { 'data-tip': s }, s);
      b.addEventListener('mousedown', (e) => e.preventDefault());
      b.addEventListener('click', () => {
        closeMenus();
        ed.focus();
        ed.restoreSelection(saved);
        ed.change('Symbol', () => document.execCommand('insertText', false, s));
        const rec = [s, ...settings.get('recentSymbols', []).filter((x) => x !== s)].slice(0, 20);
        settings.set('recentSymbols', rec);
      });
      return b;
    }));
  };
  const seg = h('div.seg');
  const tabs = [['symbols', 'Symbols', SYMBOLS], ['emoji', 'Emoji', EMOJI], ['recent', 'Recent', null]];
  for (const [id, label, list] of tabs) {
    const b = h('button', label);
    b.addEventListener('click', () => { for (const x of seg.children) x.classList.remove('on'); b.classList.add('on'); fill(list || settings.get('recentSymbols', [])); });
    if (id === tab) { b.classList.add('on'); fill(list || settings.get('recentSymbols', [])); }
    seg.append(b);
  }
  popover(h('div.col', { style: { padding: '6px', width: '340px' } }, seg, grid), anchor ? { anchor } : { x: window.innerWidth / 2 - 170, y: 140 });
}

// ---- read aloud ----
let speaking = null;
function readAloud() {
  if (speaking) { speechSynthesis.cancel(); speaking = null; if (CSS.highlights) CSS.highlights.delete('snake-speak'); refresh(); return; }
  if (!window.speechSynthesis) { toast('Reading aloud is not available here.', { type: 'warn' }); return; }
  const r = ed.range();
  let range;
  if (r && !r.collapsed) range = r.cloneRange();
  else {
    range = document.createRange();
    range.selectNodeContents(ed.doc);
    if (r) range.setStart(r.startContainer, r.startOffset);
  }
  // Map characters back to text nodes so the spoken word can be highlighted.
  const map = [];
  let text = '';
  const walker = document.createTreeWalker(ed.doc, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const n = walker.currentNode;
    if (!range.intersectsNode(n)) continue;
    const start = n === range.startContainer ? range.startOffset : 0;
    const end = n === range.endContainer ? range.endOffset : n.length;
    map.push([text.length, n, start]);
    text += `${n.data.slice(start, end)} `;
  }
  if (!text.trim()) return;
  const u = new SpeechSynthesisUtterance(text);
  u.rate = settings.get('speechRate', 1);
  const voice = speechSynthesis.getVoices().find((v) => v.name === settings.get('voice', ''));
  if (voice) u.voice = voice;
  u.onboundary = (e) => {
    if (e.name !== 'word' || !CSS.highlights) return;
    const pos = e.charIndex;
    let k = map.length - 1;
    while (k > 0 && map[k][0] > pos) k--;
    const [base, node, off] = map[k];
    const s = off + (pos - base);
    const len = e.charLength || (/^\S+/.exec(text.slice(pos)) || [''])[0].length;
    try {
      const hr = document.createRange();
      hr.setStart(node, Math.min(node.length, s));
      hr.setEnd(node, Math.min(node.length, s + len));
      CSS.highlights.set('snake-speak', new Highlight(hr));
      const el = node.parentElement;
      if (el) el.scrollIntoView({ block: 'nearest' });
    } catch {}
  };
  u.onend = () => { speaking = null; if (CSS.highlights) CSS.highlights.delete('snake-speak'); refresh(); };
  speaking = u;
  speechSynthesis.speak(u);
  refresh();
}

function lookUp() {
  const s = (window.getSelection() || '').toString().trim();
  if (s) host.openExternal(`https://duckduckgo.com/?q=${encodeURIComponent(s.slice(0, 200))}`);
}

// ---- format painter ----
function startPainter(sticky) {
  if (painter) { painter = null; ed.doc.classList.remove('painting'); refresh(); return; }
  painter = { format: ed.pickFormat(), sticky, waiting: true };
  ed.doc.classList.add('painting');
  toast('Select the text to format. Press Esc to stop.', { timeout: 2500 });
  setTimeout(() => { if (painter) painter.waiting = false; }, 0);
  refresh();
}
const applyPainterSoon = debounce(() => {}, 0);
ed.doc.addEventListener('mouseup', () => {
  if (!painter || painter.waiting) return;
  const r = ed.range();
  if (!r || r.collapsed) return;
  ed.applyFormat(painter.format);
  if (!painter.sticky) { painter = null; ed.doc.classList.remove('painting'); }
  refresh();
});
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && painter) { painter = null; ed.doc.classList.remove('painting'); refresh(); }
  if (e.key === 'Escape' && document.body.classList.contains('read-mode')) toggleReadMode();
});

// ---------------------------------------------------------------------------
// Find bar
// ---------------------------------------------------------------------------
const findBar = (() => {
  const q = h('input.input', { placeholder: 'Find', spellcheck: false });
  const rep = h('input.input', { placeholder: 'Replace with', spellcheck: false });
  const count = h('span.muted', { style: { minWidth: '64px', fontSize: '12px', textAlign: 'center' } });
  const opts = { matchCase: false, word: false, regex: false };
  const toggle = (key, label, tip) => {
    const b = h('button.tb', { 'data-tip': tip, style: { fontFamily: 'var(--mono)', fontSize: '11px' } }, label);
    b.addEventListener('click', () => { opts[key] = !opts[key]; b.classList.toggle('on', opts[key]); run(); });
    return b;
  };
  const prev = tb({ icon: 'chevronUp', tip: 'Previous match', keys: 'Shift+Enter', run: () => next(-1) });
  const nxt = tb({ icon: 'chevronDown', tip: 'Next match', keys: 'Enter', run: () => next(1) });
  const close = tb({ icon: 'x', tip: 'Close', keys: 'Esc', run: () => hide() });
  const one = h('button.btn.small', 'Replace');
  const allBtn = h('button.btn.small', 'Replace all');
  const repRow = h('div.row', rep, one, allBtn);
  const el = h('div.find-bar.hidden', h('div.row', q, count, toggle('matchCase', 'Aa', 'Match case'), toggle('word', 'ab', 'Whole words'), toggle('regex', '.*', 'Regular expression'), prev, nxt, close), repRow);
  ed.el.append(el);
  const run = debounce(() => {
    const n = ed.find(q.value, opts);
    count.textContent = n < 0 ? 'Bad pattern' : q.value ? (n ? `${n} found` : 'No results') : '';
  }, 120);
  const next = (dir) => {
    if (el.classList.contains('hidden')) { open(false); return; }
    if (!ed.matches || !ed.matches.length) run.flush();
    const i = ed.gotoMatch(dir);
    if (i >= 0) count.textContent = `${i + 1} of ${ed.matches.length}`;
  };
  const open = (withReplace) => {
    el.classList.remove('hidden');
    repRow.classList.toggle('hidden', !withReplace);
    const sel = (window.getSelection() || '').toString();
    if (sel && sel.length < 100 && !sel.includes('\n')) q.value = sel;
    q.focus();
    q.select();
    run();
  };
  const hide = () => { el.classList.add('hidden'); ed.clearFind(); ed.focus(); };
  q.addEventListener('input', run);
  q.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); next(e.shiftKey ? -1 : 1); }
    if (e.key === 'Escape') { e.preventDefault(); hide(); }
  });
  rep.addEventListener('keydown', (e) => { if (e.key === 'Escape') hide(); if (e.key === 'Enter') one.click(); });
  one.addEventListener('click', () => {
    if (ed.matchIndex === undefined || ed.matchIndex < 0) next(1);
    ed.replaceCurrent(rep.value);
    run.flush();
    next(1);
  });
  allBtn.addEventListener('click', () => {
    const n = ed.replaceAll(q.value, rep.value, opts);
    count.textContent = `${n} replaced`;
    toast(`Replaced ${n} ${n === 1 ? 'match' : 'matches'}.`);
  });
  return { open, next, hide };
})();

// ---------------------------------------------------------------------------
// Navigation pane: headings, click to jump, drag to move a whole section
// ---------------------------------------------------------------------------
const navList = nav.querySelector('.nav-list');
function buildNav() {
  if (nav.classList.contains('hidden')) return;
  const heads = ed.headings();
  navList.replaceChildren();
  if (!heads.length) { navList.append(h('div.empty', 'Headings you add show up here. Drag them to move whole sections.')); return; }
  const cur = ed.range() && ed.blockOf(ed.range().startContainer);
  heads.forEach((x) => {
    const row = h('div.list-item.nav-item', { draggable: 'true', style: { paddingLeft: `${8 + Math.max(0, x.level - 1) * 14}px`, fontWeight: x.level <= 1 ? '600' : '400' } }, x.text);
    if (cur === x.el) row.classList.add('on');
    row.addEventListener('click', () => {
      x.el.scrollIntoView({ block: 'start', behavior: 'smooth' });
      ed.caretIn(x.el);
      ed.focus();
    });
    row.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/snake-heading', String(heads.indexOf(x))); row.classList.add('dragging'); });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
    row.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/snake-heading')) { e.preventDefault(); row.classList.add('drop'); } });
    row.addEventListener('dragleave', () => row.classList.remove('drop'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('drop');
      const from = heads[Number(e.dataTransfer.getData('text/snake-heading'))];
      if (from && from !== x) moveSection(from, x);
    });
    contextMenu(row, () => [
      { label: 'Go to heading', run: () => row.click() },
      { label: 'Promote', run: () => { ed.caretIn(x.el); ed.setStyle(`Heading ${Math.max(1, x.level - 1)}`); buildNav(); } },
      { label: 'Demote', run: () => { ed.caretIn(x.el); ed.setStyle(`Heading ${Math.min(6, x.level + 1)}`); buildNav(); } },
      { type: 'separator' },
      { label: 'Select section', run: () => { const r = sectionRange(x); window.getSelection().removeAllRanges(); window.getSelection().addRange(r); } },
      { label: 'Delete section', icon: 'trash', danger: true, run: () => ed.change('Delete section', () => sectionRange(x).deleteContents()) },
    ]);
    navList.append(row);
  });
}
function topOf(el) { while (el.parentNode !== ed.doc) el = el.parentNode; return el; }
function sectionRange(x) {
  const start = topOf(x.el);
  let end = start;
  let n = start.nextElementSibling;
  while (n) {
    const lvl = /^H([1-6])$/.exec(n.tagName);
    if ((lvl && Number(lvl[1]) <= x.level) || (n.classList.contains('title'))) break;
    end = n;
    n = n.nextElementSibling;
  }
  const r = document.createRange();
  r.setStartBefore(start);
  r.setEndAfter(end);
  return r;
}
function moveSection(from, to) {
  ed.change('Move section', () => {
    const frag = sectionRange(from).extractContents();
    topOf(to.el).before(frag);
  });
  buildNav();
}
function toggleNav() {
  if (toggleDrawer(nav)) { buildNav(); return; } // a phone: the pane slides in
  const hide = !nav.classList.contains('hidden');
  nav.classList.toggle('hidden', hide);
  navSplit.classList.toggle('hidden', hide);
  settings.set('nav', !hide);
  buildNav();
  refresh();
}
const navSoon = debounce(buildNav, 400);
ed.doc.addEventListener('input', navSoon);
document.addEventListener('selectionchange', debounce(() => {
  if (nav.classList.contains('hidden')) return;
  const b = ed.range() && ed.blockOf(ed.range().startContainer);
  for (const row of navList.children) row.classList.remove('on');
  const heads = ed.headings();
  let best = -1;
  heads.forEach((x, i) => { if (b && (x.el === b || (x.el.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING))) best = i; });
  if (best >= 0 && navList.children[best]) navList.children[best].classList.add('on');
}, 150));

// ---------------------------------------------------------------------------
// Right-click menu (with spelling suggestions in the desktop app)
// ---------------------------------------------------------------------------
let ctxPending = null;
ed.doc.addEventListener('contextmenu', (e) => {
  const target = e.target;
  if (target.tagName === 'IMG') ed.selectImage(target);
  if (host.spell && settings.get('spellcheck', true)) {
    // Let the app's own spelling engine see the click; its answer opens the menu.
    ctxPending = { x: e.clientX, y: e.clientY, target, timer: setTimeout(() => openDocMenu(ctxPending, null), 180) };
    return;
  }
  e.preventDefault();
  openDocMenu({ x: e.clientX, y: e.clientY, target }, null);
});
if (host.spell) {
  host.spell.onContext((info) => {
    if (!ctxPending) return;
    clearTimeout(ctxPending.timer);
    openDocMenu(ctxPending, info);
  });
}

function openDocMenu(at, spell) {
  if (!at) return;
  ctxPending = null;
  const s = st();
  const sel = (window.getSelection() || '').toString();
  const items = [];
  if (spell && spell.word) {
    if (spell.suggestions.length) items.push(...spell.suggestions.slice(0, 6).map((w) => ({ label: w, labelStyle: { fontWeight: 600 }, run: () => { host.spell.replace(w); setTimeout(() => ed.commit('Spelling'), 30); } })));
    else items.push({ label: 'No suggestions', disabled: true });
    items.push({ label: `Add “${spell.word}” to dictionary`, icon: 'plus', run: () => host.spell.learn(spell.word) }, { type: 'separator' });
  }
  if (ed.selectedImage && at.target.tagName === 'IMG') {
    items.push({ label: 'Picture layout', icon: 'image', submenu: [['In line with text', 'inline'], ['Left, text wraps', 'left'], ['Centred', 'center'], ['Right, text wraps', 'right']].map(([n, k]) => ({ label: n, run: () => ed.imageStyle(k) })) },
      { label: 'Size', icon: 'resize', submenu: [['Quarter width', 0.25], ['Half width', 0.5], ['Three quarters', 0.75], ['Full width', 1], ['Original size', 0]].map(([n, f]) => ({ label: n, run: () => ed.imageSize(f) })) },
      { label: 'Rotate left', icon: 'rotateCcw', run: () => ed.rotateImage(-90) }, { label: 'Rotate right', icon: 'rotateCw', run: () => ed.rotateImage(90) },
      { label: 'Alt text…', icon: 'text', run: () => altTextDialog() },
      { label: 'Copy picture', icon: 'copy', run: async () => { const blob = await (await fetch(ed.selectedImage.src)).blob(); const png = await toPng(blob); host.clipboard.writeImage(png); } },
      { label: 'Delete picture', icon: 'trash', danger: true, run: () => { const im = ed.selectedImage; ed.change('Delete picture', () => im.remove()); ed.selectImage(null); } },
      { type: 'separator' });
  }
  items.push(I('edit.cut', { disabled: !sel }), I('edit.copy', { disabled: !sel }), I('edit.paste'), I('edit.pastePlain'));
  if (s.link) {
    items.push({ type: 'separator' }, { label: 'Open link', icon: 'external', run: () => ed.onOpenLink(s.link.getAttribute('href')) }, { label: 'Edit link…', icon: 'link', run: () => linkDialog() },
      { label: 'Copy link address', icon: 'copy', run: () => navigator.clipboard.writeText(s.link.getAttribute('href') || '') }, { label: 'Remove link', icon: 'unlink', run: () => ed.unlink() });
  } else if (sel) items.push(I('fmt.link'));
  items.push(I('review.comment'));
  const cmtSpan = at.target.closest && at.target.closest('span.cmt');
  if (cmtSpan) {
    const cid = cmtSpan.dataset.cmt;
    const c = comments.byId(cid);
    items.push({ label: c && c.done ? 'Reopen comment' : 'Resolve comment', icon: 'check', run: () => comments.resolve(cid, !(c && c.done)) },
      { label: 'Delete comment', icon: 'trash', run: () => comments.remove(cid) });
  }
  if (s.cell) {
    items.push({ type: 'separator' },
      { label: 'Insert', icon: 'plus', submenu: [I('tbl.rowAbove'), I('tbl.rowBelow'), I('tbl.colLeft'), I('tbl.colRight')] },
      { label: 'Delete', icon: 'trash', submenu: [I('tbl.deleteRow'), I('tbl.deleteCol'), I('tbl.delete')] },
      I('tbl.merge'), I('tbl.split'),
      { label: 'Cell shading', icon: 'bucket', submenu: [['None', 'none'], ['Light green', '#e7f5ea'], ['Light grey', '#eef1ef'], ['Light blue', '#e6f0fd'], ['Light yellow', '#fff6cc'], ['Light red', '#fde8e8']].map(([n, c]) => ({ label: n, swatch: c === 'none' ? 'transparent' : c, run: () => ed.tableOp('shade', c) })) },
      { label: 'Table style', icon: 'palette', submenu: tableStyles.map(([n, c]) => ({ label: n, run: () => ed.tableOp('style', c) })) });
  }
  items.push({ type: 'separator' },
    { label: 'Paragraph style', icon: 'text', submenu: () => ['Normal', 'Title', 'Heading 1', 'Heading 2', 'Heading 3', 'Quote', 'Code'].map((n) => ({ label: n, checked: () => s.style === n, run: () => ed.setStyle(n) })) },
    { label: 'Line spacing', icon: 'lineSpacing', submenu: lineMenu },
    { label: 'Lists', icon: 'listBullets', submenu: [I('para.bullets'), I('para.numbers'), I('para.checklist')] },
    I('fmt.clear'));
  if (sel) {
    const words = (sel.match(/[\p{L}\p{N}][\p{L}\p{N}'’_-]*/gu) || []).length;
    items.push({ type: 'separator' }, I('tools.readAloud', { label: 'Read selection aloud' }), I('tools.lookup', { label: `Search the web for “${sel.slice(0, 24)}${sel.length > 24 ? '…' : ''}”` }),
      { label: `${words.toLocaleString()} ${words === 1 ? 'word' : 'words'} selected`, disabled: true });
  }
  showMenu(items, { x: at.x, y: at.y });
}

async function toPng(blob) {
  const bmp = await createImageBitmap(blob);
  const c = new OffscreenCanvas(bmp.width, bmp.height);
  c.getContext('2d').drawImage(bmp, 0, 0);
  return new Uint8Array(await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer());
}

// ---------------------------------------------------------------------------
// Misc behaviour
// ---------------------------------------------------------------------------
function toggleSetting(key, def, after) {
  const on = !settings.get(key, def);
  settings.set(key, on);
  if (after) after(on);
  refresh();
}

function toggleReadMode() {
  const on = !document.body.classList.contains('read-mode');
  document.body.classList.toggle('read-mode', on);
  if (on) { ed.doc.contentEditable = 'false'; ed.fitWidth(); toast('Read mode: Esc to go back to editing.', { timeout: 2000 }); }
  else ed.doc.contentEditable = 'true';
  refresh();
}

if (settings.get('darkPage', false)) ed.el.classList.add('dark-page');

// Crash recovery: a copy of unsaved work every 15 seconds.
let lastBackup = -1;
setInterval(() => {
  if (!doc.opened || !(ed.history.dirty || ed.typing)) return;
  if (ed.history.version === lastBackup && !ed.typing) return;
  lastBackup = ed.history.version;
  host.recovery.put(doc.id, { name: doc.name, html: ed.html(), meta: ed.meta, time: Date.now() }).catch(() => {});
}, 15000);
// Optional saving to the file itself.
setInterval(() => {
  const every = settings.get('autosaveFile', 0);
  if (!every || !doc.file || !doc.file.writable) return;
  if ((ed.history.dirty || ed.typing) && Date.now() - (window.__lastAuto || 0) > every * 1000) { window.__lastAuto = Date.now(); save(); }
}, 5000);

guardClose({ dirty: () => doc.opened && (ed.history.dirty || ed.typing), save: () => save(), name: () => doc.name });

onDropFiles((files) => {
  const docs = files.filter((f) => DOC_FILTERS[0].exts.includes(extOf(f.name)));
  const pics = files.filter((f) => ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'avif'].includes(extOf(f.name)));
  docs.forEach((f, i) => openFile(f, { here: i === 0 && pristine() }));
  if (pics.length && doc.opened) {
    for (const f of pics) host.read(f).then((b) => ed.insertImageFile(new File([b], f.name, { type: `image/${extOf(f.name) === 'jpg' ? 'jpeg' : extOf(f.name)}` })));
  }
}, 'Drop documents to open them, or pictures to insert them');
host.onOpen((files) => files.forEach((f) => openFile(f)));

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const start = startScreen({
  shell, title: 'Start a new document', templates: TEMPLATES.map((t) => ({ ...t, thumb: () => templateThumb(t) })),
  onTemplate: (t) => newDocument(t), onOpen: () => openDialog(), onRecent: (r) => openRecent(r),
});
shell.main.append(start.el);
// Keep the File › Open Recent list fresh.
shell.titlebar.querySelector('.menubar button').addEventListener('pointerdown', refreshRecent, true);

(async () => {
  const params = new URLSearchParams(location.search);
  const recovered = await host.recovery.list().catch(() => []);
  if (recovered.length) {
    const box = h('div.recover', h('h2', 'Recovered documents'));
    for (const r of recovered.sort((a, b) => b.time - a.time).slice(0, 8)) {
      const rec = await host.recovery.get(r.key).catch(() => null);
      if (!rec || !rec.value) continue;
      const row = h('div.list-item', h('span', { html: icon('history', 18) }), h('div.grow', h('div', rec.value.name || 'Untitled'), h('div.dir', `Unsaved changes from ${new Date(rec.time).toLocaleString()}`)));
      const keep = h('button.btn.small.primary', 'Open');
      const drop = h('button.btn.small', 'Discard');
      keep.addEventListener('click', () => {
        loadDocument(rec.value.html, rec.value.meta, { name: rec.value.name || 'Recovered', file: null });
        ed.history.savedAt = -1;
        updateTitle();
        host.recovery.delete(r.key);
      });
      drop.addEventListener('click', () => { host.recovery.delete(r.key); row.remove(); });
      row.append(keep, drop);
      box.append(row);
    }
    if (box.children.length > 1) start.el.querySelector('.start-main').prepend(box);
  }
  if (shell.info.files && shell.info.files.length) {
    await openFile(shell.info.files[0], { here: true });
  } else if (params.get('new')) {
    const t = TEMPLATES.find((x) => x.id === params.get('new')) || TEMPLATES[0];
    newDocument(t);
  } else if (!settings.get('showStart', true)) {
    newDocument();
  }
})();

updateTitle();

// For automated tests and the developer console.
window.snakeApp = { ed, doc, commands, shell };
Object.assign(window.snakeApp, { readDocx, writeDocx, markdownToHtml, htmlToMarkdown });
