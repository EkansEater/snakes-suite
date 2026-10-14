// Bundles the renderer (app + Monaco web workers) into dist/ using esbuild.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const watch = process.argv.includes('--watch');
const outdir = 'dist';
fs.mkdirSync(outdir, { recursive: true });

const monacoEsm = 'node_modules/monaco-editor/esm/vs';
const workers = {
  'editor.worker': `${monacoEsm}/editor/editor.worker.js`,
  'json.worker': `${monacoEsm}/language/json/json.worker.js`,
  'css.worker': `${monacoEsm}/language/css/css.worker.js`,
  'html.worker': `${monacoEsm}/language/html/html.worker.js`,
  'ts.worker': `${monacoEsm}/language/typescript/ts.worker.js`,
};

const common = {
  bundle: true,
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  logLevel: 'info',
  target: 'chrome130',
};

const workerOpts = {
  ...common,
  entryPoints: workers,
  outdir: path.join(outdir, 'workers'),
  format: 'iife',
};

const appOpts = {
  ...common,
  entryPoints: { app: 'src/renderer/app.js' },
  outdir,
  format: 'esm',
  loader: { '.ttf': 'file', '.woff': 'file', '.woff2': 'file', '.svg': 'file', '.png': 'file' },
};

function copyStatic() {
  fs.copyFileSync('src/renderer/index.html', path.join(outdir, 'index.html'));
  fs.copyFileSync('assets/icon.svg', path.join(outdir, 'icon.svg'));
}

if (watch) {
  copyStatic();
  const ctxs = await Promise.all([esbuild.context(workerOpts), esbuild.context(appOpts)]);
  await Promise.all(ctxs.map((c) => c.watch()));
  fs.watch('src/renderer/index.html', copyStatic);
} else {
  await Promise.all([esbuild.build(workerOpts), esbuild.build(appOpts)]);
  copyStatic();
}
