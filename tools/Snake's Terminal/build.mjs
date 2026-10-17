// Bundles the page into dist/ with esbuild (the JetBrains Mono font files come in through styles.css).
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';

const watch = process.argv.includes('--watch');
const outdir = 'dist';
fs.mkdirSync(path.join(outdir, 'fonts'), { recursive: true });

const options = {
  entryPoints: { app: 'src/renderer/app.js' },
  bundle: true,
  minify: !watch,
  sourcemap: watch ? 'inline' : false,
  logLevel: 'info',
  target: 'chrome130',
  outdir,
  format: 'esm',
  loader: { '.woff2': 'file', '.woff': 'file', '.ttf': 'file', '.svg': 'file', '.png': 'file' },
};

function copyStatic() {
  fs.copyFileSync('src/renderer/index.html', path.join(outdir, 'index.html'));
  fs.copyFileSync('assets/icon.svg', path.join(outdir, 'icon.svg'));
  // The terminal font itself is bundled from styles.css; its licence goes along.
  fs.copyFileSync('node_modules/@fontsource/jetbrains-mono/LICENSE', path.join(outdir, 'fonts', 'LICENSE-JetBrainsMono.txt'));
}

copyStatic();
if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  fs.watch('src/renderer/index.html', copyStatic);
} else {
  await esbuild.build(options);
}
