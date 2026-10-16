// Builds every Studio app into dist/: dist/<app>/index.html, app.js, style.css.
// dist/ runs inside Snake's Studio (snake://studio/) and, as it is, as a static
// website (the online mirror).
//
//   node build.mjs            minified build
//   node build.mjs --watch    rebuild on change, with source maps
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { APPS, HOME } = require('./src/main/apps.js');

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
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<meta name="referrer" content="no-referrer">
<title>${title}</title>
<link rel="icon" href="../icons/${icon}.svg">
<link rel="stylesheet" href="${css}">
</head>
<body>
<script type="module" src="${script}"></script>
</body>
</html>
`;

const entries = {};
const pages = [];
const all = { ...APPS, home: HOME };
for (const [id, meta] of Object.entries(all)) {
  const dir = path.join('src', id === 'home' ? 'home' : `apps/${id}`);
  if (!fs.existsSync(path.join(dir, 'main.js'))) continue;
  entries[`${id}/app`] = path.join(dir, 'main.js');
  entries[`${id}/style`] = path.join(dir, 'style.css');
  pages.push([path.join(out, id, 'index.html'), page(id, meta.name, id === 'home' ? 'studio' : id)]);
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
  // The website's front door.
  fs.writeFileSync(path.join(out, 'index.html'), `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0; url=home/index.html"><title>Snake's Studio</title><a href="home/index.html">Snake's Studio</a>\n`);
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

copyStatic();
if (watch) {
  const ctx = await esbuild.context(opts);
  await ctx.watch();
} else {
  await esbuild.build(opts);
}
