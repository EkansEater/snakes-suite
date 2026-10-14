// Color themes: workbench CSS variables, Monaco token/color rules, and terminal ANSI palettes.
import * as monaco from 'monaco-editor';
import { bus } from './util.js';

/**
 * Compact theme definition expanded by makeTheme().
 *  p: workbench palette, s: syntax palette, a: 16 ansi colors (optional)
 */
const DEFS = [
  {
    id: 'snake-dark', label: "Snake Dark", type: 'dark',
    p: { bg: '#1a1e1b', side: '#151916', act: '#111412', title: '#111412', fg: '#d5ddd7', fg2: '#8a978e', accent: '#3fb950', accentFg: '#ffffff', border: '#252b27', sel: '#2b4a35', hover: '#222823', status: '#111412', statusFg: '#9fb0a4', statusAccent: true, widget: '#1f2420', input: '#121513', lineHl: '#212722', selection: '#2e5a3c88', cursor: '#7ee787', hl: '#7ee787' },
    s: { comment: '#62786a', keyword: '#56d4a8', control: '#ff8b70', string: '#e6c07b', number: '#f78c6c', type: '#82aaff', fn: '#dcdcaa', var: '#d5ddd7', constant: '#f78c6c', tag: '#7ee787', attr: '#c3a6ff', delim: '#9aa8a0', regexp: '#ff7eb6', op: '#89ddff' },
  },
  {
    id: 'snake-light', label: "Snake Light", type: 'light',
    p: { bg: '#fcfdfc', side: '#f3f6f4', act: '#eaefeb', title: '#eaefeb', fg: '#1f2a22', fg2: '#5d6b62', accent: '#1a7f37', accentFg: '#ffffff', border: '#dbe2dd', sel: '#cfe9d6', hover: '#e6ece8', status: '#eaefeb', statusFg: '#3d4a41', statusAccent: true, widget: '#ffffff', input: '#ffffff', lineHl: '#f0f5f1', selection: '#b7e3c3aa', cursor: '#1a7f37', hl: '#1a7f37' },
    s: { comment: '#6e8a77', keyword: '#0f7b6c', control: '#c4432b', string: '#9a6700', number: '#c4432b', type: '#0550ae', fn: '#795e26', var: '#1f2a22', constant: '#0550ae', tag: '#116329', attr: '#8250df', delim: '#57606a', regexp: '#cf222e', op: '#0550ae' },
  },
  {
    id: 'dark-modern', label: 'Dark Modern', type: 'dark',
    p: { bg: '#1f1f1f', side: '#181818', act: '#181818', title: '#181818', fg: '#cccccc', fg2: '#9d9d9d', accent: '#0078d4', accentFg: '#ffffff', border: '#2b2b2b', sel: '#04395e', hover: '#2a2d2e', status: '#181818', statusFg: '#cccccc', statusAccent: true, widget: '#202020', input: '#313131', lineHl: '#282828', selection: '#264f78', cursor: '#aeafad', hl: '#2aaaff' },
    s: { comment: '#6a9955', keyword: '#569cd6', control: '#c586c0', string: '#ce9178', number: '#b5cea8', type: '#4ec9b0', fn: '#dcdcaa', var: '#9cdcfe', constant: '#4fc1ff', tag: '#569cd6', attr: '#9cdcfe', delim: '#d4d4d4', regexp: '#d16969', op: '#d4d4d4' },
  },
  {
    id: 'light-modern', label: 'Light Modern', type: 'light',
    p: { bg: '#ffffff', side: '#f8f8f8', act: '#f8f8f8', title: '#f8f8f8', fg: '#3b3b3b', fg2: '#717171', accent: '#005fb8', accentFg: '#ffffff', border: '#e5e5e5', sel: '#e4e6f1', hover: '#f2f2f2', status: '#f8f8f8', statusFg: '#3b3b3b', statusAccent: true, widget: '#f8f8f8', input: '#ffffff', lineHl: '#f5f5f5', selection: '#add6ff', cursor: '#000000', hl: '#005fb8' },
    s: { comment: '#008000', keyword: '#0000ff', control: '#af00db', string: '#a31515', number: '#098658', type: '#267f99', fn: '#795e26', var: '#001080', constant: '#0070c1', tag: '#800000', attr: '#e50000', delim: '#3b3b3b', regexp: '#811f3f', op: '#000000' },
  },
  {
    id: 'monokai', label: 'Monokai', type: 'dark',
    p: { bg: '#272822', side: '#1e1f1c', act: '#1e1f1c', title: '#1e1f1c', fg: '#f8f8f2', fg2: '#a59f85', accent: '#a6e22e', accentFg: '#1e1f1c', border: '#3b3c35', sel: '#49483e', hover: '#3e3d32', status: '#414339', statusFg: '#f8f8f2', widget: '#1e1f1c', input: '#414339', lineHl: '#3e3d32', selection: '#49483e', cursor: '#f8f8f0', hl: '#e6db74' },
    s: { comment: '#88846f', keyword: '#f92672', control: '#f92672', string: '#e6db74', number: '#ae81ff', type: '#66d9ef', fn: '#a6e22e', var: '#f8f8f2', constant: '#ae81ff', tag: '#f92672', attr: '#a6e22e', delim: '#f8f8f2', regexp: '#e6db74', op: '#f92672' },
  },
  {
    id: 'dracula', label: 'Dracula', type: 'dark',
    p: { bg: '#282a36', side: '#21222c', act: '#343746', title: '#21222c', fg: '#f8f8f2', fg2: '#a3a6c3', accent: '#bd93f9', accentFg: '#21222c', border: '#191a21', sel: '#44475a', hover: '#343746', status: '#191a21', statusFg: '#f8f8f2', widget: '#21222c', input: '#282a36', lineHl: '#44475a75', selection: '#44475a', cursor: '#f8f8f2', hl: '#ff79c6' },
    s: { comment: '#6272a4', keyword: '#ff79c6', control: '#ff79c6', string: '#f1fa8c', number: '#bd93f9', type: '#8be9fd', fn: '#50fa7b', var: '#f8f8f2', constant: '#bd93f9', tag: '#ff79c6', attr: '#50fa7b', delim: '#f8f8f2', regexp: '#ff5555', op: '#ff79c6' },
  },
  {
    id: 'one-dark', label: 'One Dark Pro', type: 'dark',
    p: { bg: '#282c34', side: '#21252b', act: '#282c34', title: '#21252b', fg: '#abb2bf', fg2: '#7f848e', accent: '#528bff', accentFg: '#ffffff', border: '#181a1f', sel: '#2c313a', hover: '#2c313a', status: '#21252b', statusFg: '#9da5b4', widget: '#21252b', input: '#1d1f23', lineHl: '#2c313c', selection: '#3e4451', cursor: '#528bff', hl: '#61afef' },
    s: { comment: '#7f848e', keyword: '#c678dd', control: '#c678dd', string: '#98c379', number: '#d19a66', type: '#e5c07b', fn: '#61afef', var: '#e06c75', constant: '#d19a66', tag: '#e06c75', attr: '#d19a66', delim: '#abb2bf', regexp: '#56b6c2', op: '#56b6c2' },
  },
  {
    id: 'github-dark', label: 'GitHub Dark', type: 'dark',
    p: { bg: '#0d1117', side: '#010409', act: '#010409', title: '#010409', fg: '#e6edf3', fg2: '#8d96a0', accent: '#1f6feb', accentFg: '#ffffff', border: '#30363d', sel: '#1f6feb44', hover: '#161b22', status: '#010409', statusFg: '#8d96a0', statusAccent: true, widget: '#161b22', input: '#0d1117', lineHl: '#161b22', selection: '#264f78', cursor: '#2f81f7', hl: '#2f81f7' },
    s: { comment: '#8b949e', keyword: '#ff7b72', control: '#ff7b72', string: '#a5d6ff', number: '#79c0ff', type: '#ffa657', fn: '#d2a8ff', var: '#e6edf3', constant: '#79c0ff', tag: '#7ee787', attr: '#79c0ff', delim: '#e6edf3', regexp: '#7ee787', op: '#ff7b72' },
  },
  {
    id: 'nord', label: 'Nord', type: 'dark',
    p: { bg: '#2e3440', side: '#2e3440', act: '#2e3440', title: '#2e3440', fg: '#d8dee9', fg2: '#8891a3', accent: '#88c0d0', accentFg: '#2e3440', border: '#3b4252', sel: '#434c5e', hover: '#3b4252', status: '#3b4252', statusFg: '#d8dee9', widget: '#2e3440', input: '#3b4252', lineHl: '#3b4252', selection: '#434c5ecc', cursor: '#d8dee9', hl: '#88c0d0' },
    s: { comment: '#616e88', keyword: '#81a1c1', control: '#81a1c1', string: '#a3be8c', number: '#b48ead', type: '#8fbcbb', fn: '#88c0d0', var: '#d8dee9', constant: '#b48ead', tag: '#81a1c1', attr: '#8fbcbb', delim: '#eceff4', regexp: '#ebcb8b', op: '#81a1c1' },
  },
  {
    id: 'solarized-dark', label: 'Solarized Dark', type: 'dark',
    p: { bg: '#002b36', side: '#00212b', act: '#003847', title: '#002c39', fg: '#93a1a1', fg2: '#657b83', accent: '#2aa198', accentFg: '#002b36', border: '#073642', sel: '#005a6f', hover: '#004454', status: '#00212b', statusFg: '#93a1a1', widget: '#00212b', input: '#003847', lineHl: '#073642', selection: '#274642', cursor: '#d30102', hl: '#2aa198' },
    s: { comment: '#586e75', keyword: '#859900', control: '#859900', string: '#2aa198', number: '#d33682', type: '#b58900', fn: '#268bd2', var: '#93a1a1', constant: '#cb4b16', tag: '#268bd2', attr: '#93a1a1', delim: '#839496', regexp: '#dc322f', op: '#859900' },
  },
  {
    id: 'solarized-light', label: 'Solarized Light', type: 'light',
    p: { bg: '#fdf6e3', side: '#eee8d5', act: '#ddd6c1', title: '#eee8d5', fg: '#586e75', fg2: '#839496', accent: '#2aa198', accentFg: '#fdf6e3', border: '#ddd6c1', sel: '#dfca88', hover: '#e5dfc9', status: '#eee8d5', statusFg: '#586e75', widget: '#eee8d5', input: '#fdf6e3', lineHl: '#eee8d5', selection: '#eee8d5', cursor: '#657b83', hl: '#b58900' },
    s: { comment: '#93a1a1', keyword: '#859900', control: '#859900', string: '#2aa198', number: '#d33682', type: '#b58900', fn: '#268bd2', var: '#657b83', constant: '#cb4b16', tag: '#268bd2', attr: '#93a1a1', delim: '#657b83', regexp: '#dc322f', op: '#859900' },
  },
  {
    id: 'high-contrast', label: 'High Contrast Dark', type: 'hc',
    p: { bg: '#000000', side: '#000000', act: '#000000', title: '#000000', fg: '#ffffff', fg2: '#dddddd', accent: '#f38518', accentFg: '#000000', border: '#6fc3df', sel: '#0f4a85', hover: '#1a1a1a', status: '#000000', statusFg: '#ffffff', widget: '#0c141f', input: '#000000', lineHl: '#00000000', selection: '#ffffff40', cursor: '#ffffff', hl: '#f38518' },
    s: { comment: '#7ca668', keyword: '#569cd6', control: '#c586c0', string: '#ce9178', number: '#b5cea8', type: '#4ec9b0', fn: '#dcdcaa', var: '#9cdcfe', constant: '#4fc1ff', tag: '#569cd6', attr: '#9cdcfe', delim: '#ffffff', regexp: '#d16969', op: '#ffffff' },
  },
];

const ANSI_DARK = ['#000000', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#cccccc', '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#e5e5e5'];
const ANSI_LIGHT = ['#000000', '#cd3131', '#00bc00', '#949800', '#0451a5', '#bc05bc', '#0598bc', '#555555', '#666666', '#cd3131', '#14ce14', '#b5ba00', '#0451a5', '#bc05bc', '#0598bc', '#a5a5a5'];

const strip = (c) => c.replace('#', '');

function mix(hex, alpha) {
  return hex.length === 7 ? hex + alpha : hex;
}

function makeTheme(def) {
  const { p, s, type } = def;
  const dark = type !== 'light';
  const css = {
    '--bg': p.bg,
    '--fg': p.fg,
    '--fg2': p.fg2,
    '--sidebar-bg': p.side,
    '--activity-bg': p.act,
    '--activity-fg': p.fg,
    '--activity-inactive': p.fg2,
    '--titlebar-bg': p.title,
    '--titlebar-fg': p.fg2,
    '--statusbar-bg': p.status,
    '--statusbar-fg': p.statusFg,
    '--statusbar-accent': p.statusAccent ? p.accent : 'transparent',
    '--statusbar-hover': dark ? '#ffffff1f' : '#0000001a',
    '--tabs-bg': p.side,
    '--tab-bg': p.side,
    '--tab-active-bg': p.bg,
    '--tab-active-fg': p.fg,
    '--tab-inactive-fg': p.fg2,
    '--tab-hover-bg': p.hover,
    '--panel-bg': p.side,
    '--border': p.border,
    '--accent': p.accent,
    '--accent-fg': p.accentFg,
    '--focus': type === 'hc' ? '#f38518' : p.accent,
    '--input-bg': p.input,
    '--input-border': type === 'hc' ? '#6fc3df' : p.border,
    '--list-hover': p.hover,
    '--list-active': p.sel,
    '--list-inactive': mix(p.sel, 'aa'),
    '--widget-bg': p.widget,
    '--widget-border': type === 'hc' ? '#6fc3df' : p.border,
    '--shadow': dark ? 'rgba(0,0,0,.45)' : 'rgba(0,0,0,.16)',
    '--badge-bg': p.accent,
    '--badge-fg': p.accentFg,
    '--button-bg': p.accent,
    '--button-fg': p.accentFg,
    '--button2-bg': dark ? '#ffffff14' : '#0000000f',
    '--hl': p.hl,
    '--link': p.hl,
    '--scrollbar': dark ? '#79797966' : '#64646466',
    '--scrollbar-hover': dark ? '#646464b3' : '#646464b3',
    '--git-modified': dark ? '#e2c08d' : '#895503',
    '--git-added': dark ? '#81b88b' : '#587c0c',
    '--git-untracked': dark ? '#73c991' : '#007100',
    '--git-deleted': dark ? '#c74e39' : '#ad0707',
    '--git-conflict': dark ? '#e4676b' : '#ad0707',
    '--git-ignored': dark ? '#8c8c8c' : '#8e8e90',
    '--error': dark ? '#f14c4c' : '#e51400',
    '--warning': dark ? '#cca700' : '#bf8803',
    '--info': dark ? '#3794ff' : '#1a85ff',
  };

  const rule = (token, color, fontStyle) => ({ token, foreground: strip(color), ...(fontStyle ? { fontStyle } : {}) });
  const rules = [
    { token: '', foreground: strip(p.fg), background: strip(p.bg) },
    rule('comment', s.comment, 'italic'),
    rule('comment.doc', s.comment, 'italic'),
    rule('keyword', s.keyword),
    rule('keyword.control', s.control),
    rule('keyword.flow', s.control),
    rule('keyword.json', s.constant),
    rule('storage', s.keyword),
    rule('string', s.string),
    rule('string.escape', s.regexp),
    rule('string.key.json', s.var),
    rule('string.value.json', s.string),
    rule('string.link', s.hl || s.fn),
    rule('number', s.number),
    rule('number.hex', s.number),
    rule('number.float', s.number),
    rule('regexp', s.regexp),
    rule('type', s.type),
    rule('type.identifier', s.type),
    rule('class', s.type),
    rule('interface', s.type),
    rule('namespace', s.type),
    rule('identifier', s.var),
    rule('variable', s.var),
    rule('variable.predefined', s.constant),
    rule('variable.parameter', s.var),
    rule('constant', s.constant),
    rule('predefined', s.fn),
    rule('function', s.fn),
    rule('annotation', s.fn),
    rule('attribute.name', s.attr),
    rule('attribute.value', s.string),
    rule('attribute.value.number', s.number),
    rule('attribute.value.unit', s.number),
    rule('tag', s.tag),
    rule('tag.id', s.fn),
    rule('tag.class', s.type),
    rule('metatag', s.keyword),
    rule('metatag.content', s.string),
    rule('delimiter', s.delim),
    rule('delimiter.html', s.delim),
    rule('delimiter.xml', s.delim),
    rule('operator', s.op),
    rule('operators', s.op),
    rule('key', s.var),
    rule('emphasis', s.var, 'italic'),
    rule('strong', s.var, 'bold'),
    rule('header', s.keyword, 'bold'),
    rule('keyword.md', s.keyword, 'bold'),
    rule('variable.source', s.string),
    rule('invalid', css['--error']),
  ];

  const colors = {
    'editor.background': p.bg,
    'editor.foreground': p.fg,
    'editor.lineHighlightBackground': p.lineHl,
    'editor.lineHighlightBorder': type === 'hc' ? '#f38518' : '#00000000',
    'editor.selectionBackground': p.selection,
    'editor.inactiveSelectionBackground': mix(p.selection.slice(0, 7), '66'),
    'editor.selectionHighlightBackground': mix(p.selection.slice(0, 7), '55'),
    'editor.wordHighlightBackground': dark ? '#575757b8' : '#57575740',
    'editor.findMatchHighlightBackground': dark ? '#ea5c0055' : '#ea5c0040',
    'editorCursor.foreground': p.cursor,
    'editorLineNumber.foreground': mix(p.fg2.slice(0, 7), '99'),
    'editorLineNumber.activeForeground': p.fg,
    'editorIndentGuide.background1': dark ? '#ffffff14' : '#00000014',
    'editorIndentGuide.activeBackground1': dark ? '#ffffff40' : '#00000040',
    'editorWhitespace.foreground': dark ? '#ffffff26' : '#00000033',
    'editorRuler.foreground': dark ? '#ffffff1a' : '#0000001a',
    'editorGutter.background': p.bg,
    'editorWidget.background': p.widget,
    'editorWidget.border': p.border,
    'editorSuggestWidget.background': p.widget,
    'editorSuggestWidget.border': p.border,
    'editorSuggestWidget.selectedBackground': p.sel,
    'editorSuggestWidget.highlightForeground': p.hl,
    'editorHoverWidget.background': p.widget,
    'editorHoverWidget.border': p.border,
    'editorStickyScroll.background': p.bg,
    'editorStickyScrollHover.background': p.hover,
    'input.background': p.input,
    'input.border': p.border,
    'focusBorder': css['--focus'],
    'list.hoverBackground': p.hover,
    'list.activeSelectionBackground': p.sel,
    'list.highlightForeground': p.hl,
    'quickInput.background': p.widget,
    'minimap.background': p.bg,
    'scrollbarSlider.background': css['--scrollbar'],
    'scrollbarSlider.hoverBackground': css['--scrollbar-hover'],
    'diffEditor.insertedTextBackground': dark ? '#9ccc2c33' : '#9ccc2c40',
    'diffEditor.removedTextBackground': dark ? '#ff000033' : '#ff000033',
    'editorBracketHighlight.foreground1': dark ? '#ffd700' : '#0431fa',
    'editorBracketHighlight.foreground2': dark ? '#da70d6' : '#319331',
    'editorBracketHighlight.foreground3': dark ? '#179fff' : '#7b3814',
    'editorOverviewRuler.border': '#00000000',
    'widget.shadow': css['--shadow'],
  };

  const ansi = def.a || (dark ? ANSI_DARK : ANSI_LIGHT);
  const terminal = {
    background: p.side,
    foreground: p.fg,
    cursor: p.cursor,
    cursorAccent: p.side,
    selectionBackground: p.selection.length === 7 ? p.selection + '99' : p.selection,
    black: ansi[0], red: ansi[1], green: ansi[2], yellow: ansi[3], blue: ansi[4], magenta: ansi[5], cyan: ansi[6], white: ansi[7],
    brightBlack: ansi[8], brightRed: ansi[9], brightGreen: ansi[10], brightYellow: ansi[11], brightBlue: ansi[12], brightMagenta: ansi[13], brightCyan: ansi[14], brightWhite: ansi[15],
  };

  return {
    id: def.id,
    label: def.label,
    type,
    css,
    terminal,
    monaco: { base: type === 'light' ? 'vs' : type === 'hc' ? 'hc-black' : 'vs-dark', inherit: true, rules, colors },
  };
}

export const themes = DEFS.map(makeTheme);
for (const t of themes) monaco.editor.defineTheme(t.id, t.monaco);

let current = themes[0];
export function currentTheme() {
  return current;
}

export function applyTheme(id) {
  const t = themes.find((x) => x.id === id) || themes[0];
  current = t;
  const root = document.documentElement;
  for (const [k, v] of Object.entries(t.css)) root.style.setProperty(k, v);
  root.dataset.themeType = t.type;
  monaco.editor.setTheme(t.id);
  bus.emit('theme:changed', t);
}
