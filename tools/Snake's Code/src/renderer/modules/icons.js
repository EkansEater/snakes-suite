// File type icons: small colored glyph badges keyed by file name / extension.
import { el, icon, extname } from './util.js';

const C = {
  yellow: '#e8d44d', blue: '#3b8eea', lblue: '#519aba', orange: '#e37933', red: '#e44d26', green: '#8dc149',
  purple: '#a074c4', pink: '#f55385', gray: '#8c8c8c', teal: '#26a69a', cyan: '#00acc1', brown: '#b07219',
  rust: '#dea584', go: '#00add8', mint: '#4ec9b0', white: '#cccccc',
};

// ext -> [glyph, color]
const BY_EXT = {
  '.js': ['JS', C.yellow], '.mjs': ['JS', C.yellow], '.cjs': ['JS', C.yellow], '.jsx': ['⚛', C.cyan],
  '.ts': ['TS', C.blue], '.mts': ['TS', C.blue], '.cts': ['TS', C.blue], '.tsx': ['⚛', C.blue], '.d.ts': ['TS', C.lblue],
  '.json': ['{}', C.yellow], '.jsonc': ['{}', C.yellow], '.json5': ['{}', C.yellow],
  '.html': ['<>', C.red], '.htm': ['<>', C.red], '.xml': ['<>', C.orange], '.svg': ['◈', C.orange], '.vue': ['V', C.green], '.svelte': ['S', C.red],
  '.css': ['#', C.blue], '.scss': ['#', C.pink], '.sass': ['#', C.pink], '.less': ['#', C.lblue],
  '.md': ['M↓', C.lblue], '.mdx': ['M↓', C.yellow], '.markdown': ['M↓', C.lblue], '.txt': ['≡', C.gray], '.rst': ['≡', C.gray],
  '.py': ['py', C.lblue], '.pyw': ['py', C.lblue], '.ipynb': ['nb', C.orange], '.pyi': ['py', C.yellow],
  '.rb': ['rb', C.red], '.php': ['php', C.purple], '.java': ['J', C.red], '.kt': ['K', C.purple], '.kts': ['K', C.purple],
  '.c': ['C', C.blue], '.h': ['h', C.purple], '.cpp': ['C++', C.blue], '.cc': ['C++', C.blue], '.cxx': ['C++', C.blue], '.hpp': ['h', C.purple],
  '.cs': ['C#', C.green], '.go': ['go', C.go], '.rs': ['rs', C.rust], '.swift': ['sw', C.orange], '.dart': ['dt', C.cyan],
  '.lua': ['lua', C.blue], '.pl': ['pl', C.blue], '.r': ['R', C.blue], '.scala': ['sc', C.red], '.ex': ['ex', C.purple], '.exs': ['ex', C.purple],
  '.erl': ['erl', C.red], '.hs': ['hs', C.purple], '.clj': ['clj', C.green], '.zig': ['zig', C.orange], '.nim': ['nim', C.yellow],
  '.sh': ['$', C.green], '.bash': ['$', C.green], '.zsh': ['$', C.green], '.fish': ['$', C.green], '.ps1': ['PS', C.blue], '.bat': ['bat', C.green], '.cmd': ['bat', C.green],
  '.yml': ['yml', C.purple], '.yaml': ['yml', C.purple], '.toml': ['tml', C.gray], '.ini': ['ini', C.gray], '.cfg': ['cfg', C.gray], '.conf': ['cfg', C.gray], '.env': ['env', C.yellow],
  '.sql': ['sql', C.pink], '.graphql': ['gql', C.pink], '.gql': ['gql', C.pink], '.prisma': ['◭', C.mint],
  '.png': ['img', C.purple], '.jpg': ['img', C.purple], '.jpeg': ['img', C.purple], '.gif': ['img', C.purple], '.webp': ['img', C.purple], '.ico': ['img', C.purple], '.bmp': ['img', C.purple], '.avif': ['img', C.purple],
  '.mp4': ['▶', C.pink], '.mov': ['▶', C.pink], '.webm': ['▶', C.pink], '.mp3': ['♪', C.pink], '.wav': ['♪', C.pink], '.ogg': ['♪', C.pink],
  '.pdf': ['pdf', C.red], '.zip': ['zip', C.brown], '.gz': ['zip', C.brown], '.tar': ['zip', C.brown], '.7z': ['zip', C.brown],
  '.lock': ['🔒', C.gray], '.log': ['log', C.gray], '.csv': ['csv', C.green], '.tsv': ['csv', C.green],
  '.dockerfile': ['🐳', C.blue], '.tf': ['tf', C.purple], '.proto': ['pb', C.teal], '.wasm': ['wa', C.purple],
  '.ttf': ['A', C.red], '.otf': ['A', C.red], '.woff': ['A', C.red], '.woff2': ['A', C.red],
  '.diff': ['±', C.green], '.patch': ['±', C.green], '.gitignore': ['git', C.orange],
};

const BY_NAME = {
  'package.json': ['npm', C.red], 'package-lock.json': ['npm', C.red], 'yarn.lock': ['yarn', C.lblue], 'pnpm-lock.yaml': ['pn', C.orange],
  'tsconfig.json': ['TS', C.blue], 'jsconfig.json': ['JS', C.yellow], 'dockerfile': ['🐳', C.blue], 'docker-compose.yml': ['🐳', C.blue],
  'makefile': ['mk', C.orange], 'cmakelists.txt': ['cm', C.blue], 'cargo.toml': ['rs', C.rust], 'cargo.lock': ['rs', C.rust],
  'go.mod': ['go', C.go], 'go.sum': ['go', C.go], 'readme.md': ['ⓘ', C.lblue], 'license': ['§', C.yellow], 'license.md': ['§', C.yellow],
  '.gitignore': ['git', C.orange], '.gitattributes': ['git', C.orange], '.gitmodules': ['git', C.orange], '.editorconfig': ['ec', C.gray],
  '.prettierrc': ['pr', C.pink], '.eslintrc': ['es', C.purple], '.eslintrc.json': ['es', C.purple], 'eslint.config.js': ['es', C.purple],
  '.npmrc': ['npm', C.red], '.nvmrc': ['nvm', C.green], 'requirements.txt': ['py', C.lblue], 'pyproject.toml': ['py', C.lblue],
  'gemfile': ['rb', C.red], 'vite.config.js': ['⚡', C.purple], 'vite.config.ts': ['⚡', C.purple], '.env': ['env', C.yellow],
};

const FOLDER_COLORS = {
  src: C.green, lib: C.green, test: C.red, tests: C.red, __tests__: C.red, spec: C.red, node_modules: C.gray, dist: C.gray, build: C.gray,
  out: C.gray, '.git': C.orange, '.github': C.gray, '.vscode': C.blue, docs: C.lblue, doc: C.lblue, assets: C.yellow, public: C.lblue,
  images: C.purple, img: C.purple, components: C.cyan, config: C.gray, scripts: C.green, styles: C.pink, css: C.pink,
};

export function fileIconInfo(name) {
  const lower = name.toLowerCase();
  if (BY_NAME[lower]) return BY_NAME[lower];
  if (lower.endsWith('.d.ts')) return BY_EXT['.d.ts'];
  if (lower.startsWith('dockerfile')) return BY_NAME.dockerfile;
  if (lower.startsWith('.env')) return BY_EXT['.env'];
  return BY_EXT[extname(lower)] || ['', null];
}

export function fileIcon(name) {
  const [glyph, color] = fileIconInfo(name);
  if (!glyph) return el('span.file-icon.generic', {}, icon('file'));
  return el('span.file-icon', { style: { color }, 'data-len': String([...glyph].length) }, glyph);
}

export function folderIcon(name, open) {
  const color = FOLDER_COLORS[name.toLowerCase()];
  const node = icon(open ? 'folder-opened' : 'folder', 'folder-icon');
  if (color) node.style.color = color;
  return node;
}

/** Icon for special editor inputs (settings, welcome, diff...). */
export function specialIcon(name) {
  return el('span.file-icon.special', {}, icon(name));
}
