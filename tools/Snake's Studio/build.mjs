// Builds every Studio app into dist/: dist/<app>/index.html, app.js, style.css.
// dist/ runs inside Snake's Studio (snake://studio/) and, as it is, as a static
// website (the online mirror).
//
//   node build.mjs            minified build
//   node build.mjs --watch    rebuild on change, with source maps
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { APPS, WEB_APPS, WEB_HOME } = require('./src/main/apps.js');

const watch = process.argv.includes('--watch');
const out = 'dist';
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'icons'), { recursive: true });

// The same policy the Electron protocol sends as a header (minus snake-media:, which
// only exists there). A <meta> policy cannot carry frame-ancestors.
const CSP = [
  "default-src 'self'", "script-src 'self'", "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: snake-media:", "media-src 'self' data: blob: snake-media:", "font-src 'self' data:",
  "connect-src 'self' data: blob: snake-media:", "worker-src 'self' blob:", "frame-src 'none'", "object-src 'none'",
  "base-uri 'none'", "form-action 'none'",
].join('; ');

const page = (id, title, icon, script = 'app.js', css = 'style.css') => `<!doctype html>
<html lang="en" data-app="${id}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#111412">
<title>${title}</title>
<link rel="icon" href="../icons/${icon}.svg">
<link rel="manifest" href="manifest.webmanifest">
<link rel="apple-touch-icon" href="../icons/${icon}.png">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="${title.replace("Snake's ", '')}">
<link rel="stylesheet" href="${css}">
</head>
<body>
<script type="module" src="${script}"></script>
</body>
</html>
`;

const entries = {};
const pages = [];
const all = { ...APPS, ...WEB_APPS, home: WEB_HOME };
for (const [id, meta] of Object.entries(all)) {
  const dir = path.join('src', id === 'home' ? 'home' : `apps/${id}`);
  if (!fs.existsSync(path.join(dir, 'main.js'))) continue;
  entries[`${id}/app`] = path.join(dir, 'main.js');
  entries[`${id}/style`] = path.join(dir, 'style.css');
  pages.push([path.join(out, id, 'index.html'), page(id, meta.name, id === 'home' ? 'suite' : id)]);
  // On the website each app can be installed as its own window (Install app in Chrome/Edge).
  const icon = id === 'home' ? 'suite' : id;
  pages.push([path.join(out, id, 'manifest.webmanifest'), JSON.stringify({
    name: meta.name, short_name: meta.short, description: meta.tagline,
    start_url: './index.html', scope: './', display: 'standalone', background_color: '#1a1e1b', theme_color: '#111412',
    icons: [{ src: `../icons/${icon}.png`, sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: `../icons/${icon}.svg`, sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
  }, null, 2)]);
  // Extra windows of an app: src/apps/<id>/pages/<name>.js (+ <name>.css) -> dist/<id>/<name>.html
  const extra = path.join(dir, 'pages');
  if (fs.existsSync(extra)) {
    for (const f of fs.readdirSync(extra).filter((n) => n.endsWith('.js'))) {
      const name = f.slice(0, -3);
      entries[`${id}/${name}`] = path.join(extra, f);
      const css = fs.existsSync(path.join(extra, `${name}.css`));
      if (css) entries[`${id}/${name}-style`] = path.join(extra, `${name}.css`);
      pages.push([path.join(out, id, `${name}.html`), page(id, meta.name, id === 'home' ? 'studio' : id, `${name}.js`, css ? `${name}-style.css` : 'style.css')]);
    }
  }
}

function copyStatic() {
  for (const [file, html] of pages) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, html);
  }
  for (const f of fs.readdirSync('assets/icons')) fs.copyFileSync(path.join('assets/icons', f), path.join(out, 'icons', f));
  // Every other Snake app's icon, for the suite's front page (shared/icons is their home).
  const shared = path.join('..', '..', 'shared', 'icons');
  for (const f of fs.readdirSync(shared).filter((n) => /\.(svg|png)$/.test(n))) {
    if (!fs.existsSync(path.join(out, 'icons', f))) fs.copyFileSync(path.join(shared, f), path.join(out, 'icons', f));
  }
  // The website's front door.
  fs.writeFileSync(path.join(out, 'index.html'), `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=home/index.html"><title>Snake's Master Suite</title><a href="home/index.html">Snake's Master Suite</a>\n`);
}

const opts = {
  entryPoints: entries,
  outdir: out,
  bundle: true,
  format: 'esm',
  splitting: false,
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  target: ['chrome120', 'firefox121', 'safari17'],
  loader: { '.svg': 'text', '.woff2': 'file', '.png': 'file' },
  logLevel: 'info',
  legalComments: 'none',
};

/**
 * sw.js: on the website, a copy of every file for offline use, so the apps work
 * without a connection once opened (and when installed to a phone's home screen).
 * The version is a hash of the files, so a new build replaces the copy.
 */
function serviceWorker() {
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const f = path.join(dir, e.name);
      if (e.isDirectory()) walk(f);
      else if (!f.endsWith('.map') && e.name !== 'sw.js' && !path.relative(out, f).startsWith(`code${path.sep}`)) files.push(path.relative(out, f).split(path.sep).join('/'));
    }
  };
  walk(out);
  files.sort();
  const hash = crypto.createHash('sha256');
  for (const f of files) hash.update(f).update(fs.readFileSync(path.join(out, f)));
  const version = hash.digest('hex').slice(0, 16);
  fs.writeFileSync(path.join(out, 'sw.js'), `// Snake's Studio, offline copy for the website. Made by build.mjs; do not edit.
const CACHE = 'snake-studio-${version}';
const FILES = ${JSON.stringify(files)};
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k.startsWith('snake-studio-') && k !== CACHE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin) return;
  e.respondWith(caches.open(CACHE).then(async (c) => {
    const hit = await c.match(req, { ignoreSearch: true }) || (url.pathname.endsWith('/') && await c.match(new URL('index.html', url)));
    if (hit) return hit;
    const res = await fetch(req);
    // Snake's Code is kept once it has been opened (it is too big to fetch for everyone).
    if (res.ok && url.pathname.includes('/code/')) c.put(req, res.clone());
    return res;
  }));
});
`);
}

/**
 * Snake's Code, for the website and the iPhone app: its own renderer (tools/Snake's Code/dist,
 * made by its `node build.mjs`) with the browser bridge (src/web) in dist/code. Skipped when
 * Code has not been built.
 */
function codeForTheWeb() {
  const code = path.join('..', "Snake's Code");
  const built = path.join(code, 'dist');
  if (!fs.existsSync(path.join(built, 'index.html'))) { console.warn("(Snake's Code is not built: no web version of it)"); return; }
  const dest = path.join(out, 'code');
  fs.cpSync(built, dest, { recursive: true });
  for (const f of ['web-bridge.js', 'web.css']) fs.copyFileSync(path.join(code, 'src', 'web', f), path.join(dest, f));
  let html = fs.readFileSync(path.join(dest, 'index.html'), 'utf8');
  html = html.replace('<link rel="stylesheet" href="app.css" />', '<link rel="stylesheet" href="app.css" />\n    <link rel="stylesheet" href="web.css" />\n    <link rel="manifest" href="manifest.webmanifest" />\n    <link rel="apple-touch-icon" href="../icons/code.png" />')
    .replace('<script type="module" src="app.js"></script>', '<script src="web-bridge.js"></script>\n    <script type="module" src="app.js"></script>')
    .replace('<meta charset="utf-8" />', '<meta charset="utf-8" />\n    <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />');
  if (!html.includes('web-bridge.js')) throw new Error("Snake's Code's index.html changed: cannot add the web bridge");
  fs.writeFileSync(path.join(dest, 'index.html'), html);
  fs.writeFileSync(path.join(dest, 'manifest.webmanifest'), JSON.stringify({
    name: "Snake's Code", short_name: 'Code', description: 'Code editor', start_url: './index.html', scope: './', display: 'standalone',
    background_color: '#1a1e1b', theme_color: '#111412', icons: [{ src: '../icons/code.png', sizes: '512x512', type: 'image/png' }, { src: '../icons/code.svg', sizes: 'any', type: 'image/svg+xml' }],
  }, null, 2));
}

copyStatic();
if (watch) {
  const ctx = await esbuild.context(opts);
  await ctx.watch();
} else {
  await esbuild.build(opts);
  codeForTheWeb();
  serviceWorker();
}
