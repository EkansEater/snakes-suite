// Colour schemes: the built-in ones, and importing iTerm2 (.itermcolors) and Windows Terminal (JSON) files.

const NAMES = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white',
  'brightBlack', 'brightRed', 'brightGreen', 'brightYellow', 'brightBlue', 'brightMagenta', 'brightCyan', 'brightWhite'];

const scheme = (id, name, bg, fg, cursor, selection, ansi, light = false) => ({ id, name, bg, fg, cursor, selection, ansi, light, builtIn: true });

export const BUILT_IN = [
  // Snake: the suite's own greens on its dark background.
  scheme('snake', 'Snake', '#151916', '#d5ddd7', '#7ee787', '#2e5a3c',
    ['#262c28', '#ff7b72', '#3fb950', '#d29922', '#58a6ff', '#bc8cff', '#39c5cf', '#c9d1cb',
      '#6e7a71', '#ffa198', '#7ee787', '#e3b341', '#79c0ff', '#d2a8ff', '#56d4dd', '#f0f6f2']),
  scheme('snake-light', 'Snake Light', '#fcfdfc', '#1f2a22', '#1a7f37', '#b7e3c3',
    ['#24292f', '#cf222e', '#1a7f37', '#9a6700', '#0969da', '#8250df', '#1b7c83', '#6e7781',
      '#57606a', '#a40e26', '#2da44e', '#bf8700', '#218bff', '#a475f9', '#3192aa', '#8c959f'], true),
  scheme('classic', 'Classic (iTerm style)', '#000000', '#c7c7c7', '#c7c7c7', '#4a5569',
    ['#000000', '#c91b00', '#00c200', '#c7c400', '#0225c7', '#ca30c7', '#00c5c7', '#c7c7c7',
      '#686868', '#ff6e67', '#5ffa68', '#fffc67', '#6871ff', '#ff77ff', '#60fdff', '#ffffff']),
  scheme('solarized-dark', 'Solarized Dark', '#002b36', '#839496', '#93a1a1', '#274642',
    ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5',
      '#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3']),
  scheme('solarized-light', 'Solarized Light', '#fdf6e3', '#657b83', '#586e75', '#eee8d5',
    ['#073642', '#dc322f', '#859900', '#b58900', '#268bd2', '#d33682', '#2aa198', '#eee8d5',
      '#002b36', '#cb4b16', '#586e75', '#657b83', '#839496', '#6c71c4', '#93a1a1', '#fdf6e3'], true),
  scheme('dracula', 'Dracula', '#282a36', '#f8f8f2', '#f8f8f2', '#44475a',
    ['#21222c', '#ff5555', '#50fa7b', '#f1fa8c', '#bd93f9', '#ff79c6', '#8be9fd', '#f8f8f2',
      '#6272a4', '#ff6e6e', '#69ff94', '#ffffa5', '#d6acff', '#ff92df', '#a4ffff', '#ffffff']),
  scheme('nord', 'Nord', '#2e3440', '#d8dee9', '#d8dee9', '#434c5e',
    ['#3b4252', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#88c0d0', '#e5e9f0',
      '#4c566a', '#bf616a', '#a3be8c', '#ebcb8b', '#81a1c1', '#b48ead', '#8fbcbb', '#eceff4']),
  scheme('one-dark', 'One Dark', '#282c34', '#abb2bf', '#528bff', '#3e4451',
    ['#282c34', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#abb2bf',
      '#5c6370', '#e06c75', '#98c379', '#e5c07b', '#61afef', '#c678dd', '#56b6c2', '#ffffff']),
  scheme('gruvbox-dark', 'Gruvbox Dark', '#282828', '#ebdbb2', '#ebdbb2', '#504945',
    ['#282828', '#cc241d', '#98971a', '#d79921', '#458588', '#b16286', '#689d6a', '#a89984',
      '#928374', '#fb4934', '#b8bb26', '#fabd2f', '#83a598', '#d3869b', '#8ec07c', '#ebdbb2']),
  scheme('tokyo-night', 'Tokyo Night', '#1a1b26', '#c0caf5', '#c0caf5', '#33467c',
    ['#15161e', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#a9b1d6',
      '#414868', '#f7768e', '#9ece6a', '#e0af68', '#7aa2f7', '#bb9af7', '#7dcfff', '#c0caf5']),
  scheme('catppuccin-mocha', 'Catppuccin Mocha', '#1e1e2e', '#cdd6f4', '#f5e0dc', '#585b70',
    ['#45475a', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#bac2de',
      '#585b70', '#f38ba8', '#a6e3a1', '#f9e2af', '#89b4fa', '#f5c2e7', '#94e2d5', '#a6adc8']),
  scheme('monokai', 'Monokai', '#272822', '#f8f8f2', '#f8f8f0', '#49483e',
    ['#272822', '#f92672', '#a6e22e', '#f4bf75', '#66d9ef', '#ae81ff', '#a1efe4', '#f8f8f2',
      '#75715e', '#f92672', '#a6e22e', '#f4bf75', '#66d9ef', '#ae81ff', '#a1efe4', '#f9f8f5']),
];

/** The xterm.js theme for a scheme. */
export function xtermTheme(s) {
  const t = {
    background: s.bg,
    foreground: s.fg,
    cursor: s.cursor || s.fg,
    cursorAccent: s.cursorText || s.bg,
    selectionBackground: withAlpha(s.selection || '#44475a', 0.75),
    selectionInactiveBackground: withAlpha(s.selection || '#44475a', 0.45),
    scrollbarSliderBackground: s.light ? '#00000026' : '#ffffff1f',
    scrollbarSliderHoverBackground: s.light ? '#00000040' : '#ffffff33',
    scrollbarSliderActiveBackground: s.light ? '#00000059' : '#ffffff4d',
  };
  NAMES.forEach((n, i) => { t[n] = s.ansi[i]; });
  return t;
}

function withAlpha(hex, a) {
  const h = hex.replace('#', '');
  if (h.length === 8) return '#' + h;
  return '#' + h.slice(0, 6) + Math.round(a * 255).toString(16).padStart(2, '0');
}

const hex2 = (x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0');

/** An iTerm2 .itermcolors file (a property list of colour components) as a scheme. */
export function parseItermColors(text, name) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('This is not an .itermcolors file.');
  const root = doc.querySelector('plist > dict');
  if (!root) throw new Error('This is not an .itermcolors file.');
  const colors = {};
  const kids = [...root.children];
  for (let i = 0; i < kids.length - 1; i++) {
    if (kids[i].tagName !== 'key' || kids[i + 1].tagName !== 'dict') continue;
    const comp = {};
    const inner = [...kids[i + 1].children];
    for (let j = 0; j < inner.length - 1; j += 2) comp[inner[j].textContent] = Number(inner[j + 1].textContent);
    if ('Red Component' in comp) colors[kids[i].textContent] = '#' + hex2(comp['Red Component']) + hex2(comp['Green Component']) + hex2(comp['Blue Component']);
  }
  const ansi = Array.from({ length: 16 }, (_, i) => colors[`Ansi ${i} Color`]);
  if (ansi.some((c) => !c) || !colors['Background Color'] || !colors['Foreground Color']) throw new Error('The file does not have all 16 colours.');
  return finish({ name, bg: colors['Background Color'], fg: colors['Foreground Color'], cursor: colors['Cursor Color'], cursorText: colors['Cursor Text Color'], selection: colors['Selection Color'], ansi });
}

/** A Windows Terminal scheme ({"name", "background", "black", …, "brightWhite"}), one or a list. */
export function parseJsonSchemes(text) {
  const data = JSON.parse(text);
  const list = Array.isArray(data) ? data : Array.isArray(data.schemes) ? data.schemes : [data];
  return list.map((s) => {
    const pick = (n) => s[n] ?? s[n.replace('magenta', 'purple').replace('Magenta', 'Purple')];
    const ansi = NAMES.map(pick);
    if (ansi.some((c) => !/^#[0-9a-f]{6}/i.test(c || '')) || !s.background || !s.foreground) throw new Error(`"${s.name || 'scheme'}" is missing colours.`);
    return finish({ name: s.name || 'Imported', bg: s.background, fg: s.foreground, cursor: s.cursorColor, selection: s.selectionBackground, ansi });
  });
}

function finish(s) {
  const lum = (hex) => {
    const n = parseInt(hex.slice(1, 7), 16);
    return (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  };
  return { id: 'user-' + s.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'), builtIn: false, light: lum(s.bg) > 0.6, ...s };
}
