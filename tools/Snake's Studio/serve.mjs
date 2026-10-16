// Serves dist/ on http://localhost:5178 with the same security headers as the app,
// for trying the apps in a browser (the online mirror) while developing.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve('dist');
const port = Number(process.env.PORT || 5178);
const types = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.woff2': 'font/woff2' };

// For automated tests only: with SNAKE_TEST_DIR set, PUT /__save/<name> writes the body there.
const testDir = process.env.SNAKE_TEST_DIR ? path.resolve(process.env.SNAKE_TEST_DIR) : null;

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  if (testDir && req.method === 'PUT' && url.pathname.startsWith('/__save/')) {
    const name = path.basename(decodeURIComponent(url.pathname.slice(8)));
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => { fs.writeFileSync(path.join(testDir, name), Buffer.concat(chunks)); res.writeHead(204).end(); });
    return;
  }
  let file = path.normalize(path.join(root, decodeURIComponent(url.pathname)));
  if (!file.startsWith(root)) { res.writeHead(403).end(); return; }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404).end('Not found'); return; }
    res.writeHead(200, {
      'Content-Type': types[path.extname(file)] || 'application/octet-stream',
      'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Cache-Control': 'no-store',
      'Cross-Origin-Opener-Policy': 'same-origin',
    });
    res.end(data);
  });
}).listen(port, '127.0.0.1', () => console.log(`Snake's Studio on http://localhost:${port}/`));
