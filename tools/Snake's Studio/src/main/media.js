// Media for Snake's Player and Movie Maker: streaming granted files to <video>
// (with seeking), playing formats Chromium cannot by remuxing or transcoding
// them through ffmpeg on the fly, probing, thumbnails, waveforms and exports.
//
// ffmpeg always gets an argument list (never a shell), and only ever paths of
// files the user granted.
'use strict';

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const { spawn, execFile } = require('child_process');
const { Readable } = require('stream');
const os = require('os');
const crypto = require('crypto');
const { VIDEO_EXTS, AUDIO_EXTS, IMAGE_EXTS } = require('./apps');

// Only the Studio's own pages may read media across origins (for the equaliser and snapshots).
const CORS = { 'Access-Control-Allow-Origin': 'snake://studio', 'Cross-Origin-Resource-Policy': 'cross-origin', Vary: 'Origin' };

const EXE = process.platform === 'win32' ? '.exe' : '';
const MIME = {
  mp4: 'video/mp4', m4v: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', mkv: 'video/x-matroska',
  ogv: 'video/ogg', avi: 'video/x-msvideo', wmv: 'video/x-ms-wmv', flv: 'video/x-flv', ts: 'video/mp2t',
  m2ts: 'video/mp2t', mpg: 'video/mpeg', mpeg: 'video/mpeg', '3gp': 'video/3gpp',
  mp3: 'audio/mpeg', m4a: 'audio/mp4', aac: 'audio/aac', flac: 'audio/flac', wav: 'audio/wav', ogg: 'audio/ogg',
  oga: 'audio/ogg', opus: 'audio/ogg', wma: 'audio/x-ms-wma', aiff: 'audio/aiff', aif: 'audio/aiff', mka: 'audio/x-matroska',
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp',
  svg: 'image/svg+xml', avif: 'image/avif', srt: 'text/plain', vtt: 'text/vtt', ass: 'text/plain', ssa: 'text/plain',
};

// ---------------------------------------------------------------------------
// Finding ffmpeg
// ---------------------------------------------------------------------------
const found = {};
function findTool(name) {
  if (name in found) return found[name];
  const env = process.env[`SNAKE_${name.toUpperCase()}`];
  const candidates = [];
  if (env) candidates.push(env);
  if (process.resourcesPath) candidates.push(path.join(process.resourcesPath, 'ffmpeg', name + EXE));
  for (const dir of (process.env.PATH || '').split(path.delimiter)) if (dir) candidates.push(path.join(dir, name + EXE));
  candidates.push(`/opt/homebrew/bin/${name}`, `/usr/local/bin/${name}`, `/usr/bin/${name}`);
  found[name] = candidates.find((c) => {
    try { return fs.statSync(c).isFile(); } catch { return false; }
  }) || null;
  return found[name];
}
const ffmpegPath = () => findTool('ffmpeg');
const ffprobePath = () => findTool('ffprobe');

// ---------------------------------------------------------------------------
// Streaming
// ---------------------------------------------------------------------------
const live = new Set(); // running ffmpeg processes
const jobs = new Map(); // export id -> { proc, win }

async function serveFile(file, rangeHeader) {
  const st = await fsp.stat(file);
  const size = st.size;
  const type = MIME[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream';
  let start = 0;
  let end = size - 1;
  let status = 200;
  const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader || '');
  if (m && size > 0) {
    status = 206;
    if (m[1] === '') start = Math.max(0, size - Number(m[2]));
    else {
      start = Number(m[1]);
      if (m[2] !== '') end = Math.min(Number(m[2]), size - 1);
    }
    if (start > end || start >= size) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}`, ...CORS } });
    }
  }
  const headers = {
    'Content-Type': type,
    'Content-Length': String(size ? end - start + 1 : 0),
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...CORS,
  };
  if (status === 206) headers['Content-Range'] = `bytes ${start}-${end}/${size}`;
  const body = size ? Readable.toWeb(fs.createReadStream(file, { start, end })) : null;
  return new Response(body, { status, headers });
}

function processStream(proc, type) {
  live.add(proc);
  proc.on('close', () => live.delete(proc));
  proc.stderr.on('data', () => {}); // drain
  const reader = Readable.toWeb(proc.stdout).getReader();
  const body = new ReadableStream({
    async pull(ctrl) {
      try {
        const { done, value } = await reader.read();
        if (done) ctrl.close();
        else ctrl.enqueue(value);
      } catch (err) { ctrl.error(err); }
    },
    cancel() {
      reader.cancel().catch(() => {});
      proc.kill('SIGKILL');
    },
  });
  return new Response(body, { status: 200, headers: { 'Content-Type': type, 'Cache-Control': 'no-store', ...CORS } });
}

// A format Chromium cannot play, as fragmented MP4 from `t` seconds on.
function liveStream(file, params) {
  const ffmpeg = ffmpegPath();
  if (!ffmpeg) return new Response('ffmpeg is not installed', { status: 501 });
  const t = Math.max(0, Number(params.get('t')) || 0);
  const mode = params.get('mode') || 'transcode';
  const audioTrack = Math.max(0, Math.min(64, Number(params.get('a')) || 0));
  const args = ['-hide_banner', '-loglevel', 'error', '-nostdin'];
  if (t > 0) args.push('-ss', t.toFixed(3));
  args.push('-i', file);
  if (mode === 'audio') {
    args.push('-map', `0:a:${audioTrack}?`, '-vn', '-c:a', 'aac', '-b:a', '256k');
  } else {
    args.push('-map', '0:v:0?', '-map', `0:a:${audioTrack}?`, '-sn');
    if (mode === 'remux') args.push('-c:v', 'copy');
    else args.push('-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency', '-crf', '20', '-pix_fmt', 'yuv420p');
    args.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');
  }
  args.push('-f', 'mp4', '-movflags', 'frag_keyframe+empty_moov+default_base_moof', 'pipe:1');
  const proc = spawn(ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  return processStream(proc, mode === 'audio' ? 'audio/mp4' : 'video/mp4');
}

async function serve(request, grants) {
  const url = new URL(request.url);
  const token = url.pathname.split('/')[1] || '';
  const g = grants.get(token);
  if (!g) return new Response('Not found', { status: 404 });
  try {
    if (url.hostname === 'file') return await serveFile(g.path, request.headers.get('range'));
    if (url.hostname === 'live') return liveStream(g.path, url.searchParams);
  } catch (err) {
    return new Response(String(err.message || err), { status: 500 });
  }
  return new Response('Not found', { status: 404 });
}

// ---------------------------------------------------------------------------
// Probing, frames and waveforms
// ---------------------------------------------------------------------------
function run(exe, args, { maxBuffer = 64 * 1024 * 1024, encoding = 'buffer', timeout = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(exe, args, { maxBuffer, encoding, timeout, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).slice(-600)));
      else resolve(stdout);
    });
  });
}

async function probe(file) {
  const ffprobe = ffprobePath();
  if (!ffprobe) return null;
  const out = await run(ffprobe, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams',
    '-show_chapters', file], { encoding: 'utf8', timeout: 30000 });
  const j = JSON.parse(out);
  const tags = (j.format && j.format.tags) || {};
  return {
    duration: Number(j.format && j.format.duration) || 0,
    format: (j.format && j.format.format_name) || '',
    bitrate: Number(j.format && j.format.bit_rate) || 0,
    tags,
    chapters: (j.chapters || []).map((c) => ({
      start: Number(c.start_time) || 0, end: Number(c.end_time) || 0, title: (c.tags && c.tags.title) || '',
    })),
    streams: (j.streams || []).map((s) => ({
      index: s.index, type: s.codec_type, codec: s.codec_name, profile: s.profile,
      width: s.width, height: s.height, fps: s.avg_frame_rate, channels: s.channels, rate: s.sample_rate,
      language: (s.tags && s.tags.language) || '', title: (s.tags && s.tags.title) || '',
      rotation: Number((s.tags && s.tags.rotate) || 0), pixfmt: s.pix_fmt,
      attached: !!(s.disposition && s.disposition.attached_pic),
    })),
  };
}

async function frame(file, t, width) {
  const ffmpeg = ffmpegPath();
  if (!ffmpeg) return null;
  const w = Math.max(16, Math.min(1920, Math.round(width) || 320));
  // No seek at 0: seeking skips a music file's cover picture. Full-range output: JPEG needs it.
  const seek = t > 0 ? ['-ss', Number(t).toFixed(3)] : [];
  const out = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', ...seek,
    '-i', file, '-map', '0:v:0', '-frames:v', '1', '-vf', `scale=${w}:-2:out_range=full,format=yuvj420p`, '-f', 'image2pipe', '-c:v', 'mjpeg', '-q:v', '4', 'pipe:1'],
  { timeout: 30000 });
  return new Uint8Array(out);
}

// Peaks for drawing a waveform: `buckets` max-abs values between 0 and 1.
async function waveform(file, buckets) {
  const ffmpeg = ffmpegPath();
  if (!ffmpeg) return null;
  const n = Math.max(16, Math.min(200000, Math.round(buckets) || 2000));
  const pcm = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', file, '-vn', '-ac', '1',
    '-ar', '4000', '-f', 's16le', 'pipe:1'], { maxBuffer: 1024 * 1024 * 1024, timeout: 600000 });
  const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
  const peaks = new Float32Array(n);
  const per = samples.length / n;
  for (let i = 0; i < n; i++) {
    let max = 0;
    const end = Math.min(samples.length, Math.floor((i + 1) * per));
    for (let j = Math.floor(i * per); j < end; j++) {
      const v = Math.abs(samples[j]);
      if (v > max) max = v;
    }
    peaks[i] = max / 32768;
  }
  return { peaks, duration: samples.length / 4000 };
}

// Subtitles embedded in a video, as WebVTT text.
async function extractSubtitle(file, stream) {
  const ffmpeg = ffmpegPath();
  if (!ffmpeg) return null;
  const out = await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-nostdin', '-i', file,
    '-map', `0:s:${Math.max(0, Math.round(stream) || 0)}`, '-f', 'webvtt', 'pipe:1'], { encoding: 'utf8', timeout: 120000 });
  return out;
}

// ---------------------------------------------------------------------------
// Exports (Movie Maker) and conversions (Player)
// ---------------------------------------------------------------------------
function startJob(win, id, args, duration, onClose = null) {
  const ffmpeg = ffmpegPath();
  if (!ffmpeg) throw new Error('ffmpeg is not installed');
  const proc = spawn(ffmpeg, ['-hide_banner', '-nostdin', '-y', '-progress', 'pipe:1', '-nostats', ...args],
    { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  jobs.set(id, { proc, win: win.id });
  let tail = '';
  let buf = '';
  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      const m = /^out_time_(?:us|ms)=(\d+)/.exec(line);
      if (m && duration > 0 && !win.isDestroyed()) {
        win.webContents.send('media:progress', { id, progress: Math.min(1, Number(m[1]) / 1e6 / duration) });
      }
    }
  });
  proc.stderr.on('data', (c) => { tail = (tail + c.toString()).slice(-4000); });
  proc.on('close', (code) => {
    jobs.delete(id);
    if (onClose) onClose(code === 0, tail);
    if (!win.isDestroyed()) {
      win.webContents.send('media:done', { id, ok: code === 0, error: code === 0 ? '' : tail.split('\n').slice(-6).join('\n') });
    }
  });
}

function stopFor(winId) {
  for (const [id, job] of jobs) if (job.win === winId) { job.proc.kill('SIGKILL'); jobs.delete(id); }
}
function stopAll() {
  for (const p of live) p.kill('SIGKILL');
  for (const job of jobs.values()) job.proc.kill('SIGKILL');
}

const isPng = (b) => b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47;

function register(handle, listen, { need, grant, describe, str, dataDir }) {
  handle('media:probe', async (_e, _win, token) => probe(need(str(token)).path));
  handle('media:frame', async (_e, _win, token, t, width) => frame(need(str(token)).path, Number(t), Number(width)));
  handle('media:waveform', async (_e, _win, token, buckets) => waveform(need(str(token)).path, Number(buckets)));
  handle('media:subtitle', async (_e, _win, token, stream) => extractSubtitle(need(str(token)).path, Number(stream)));
  handle('media:readText', async (_e, _win, token) => {
    // Small text files next to media (subtitles, playlists).
    const g = need(str(token));
    const st = await fsp.stat(g.path);
    if (st.size > 20 * 1024 * 1024) throw new Error('Too large');
    return fsp.readFile(g.path, 'utf8');
  });
  handle('media:export', async (_e, win, id, job, outToken) => {
    const out = need(str(outToken), true).path;
    // Titles arrive as pictures the page drew: they go to our own temporary folder.
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'snake-movie-'));
    const overlayPaths = [];
    const overlays = job && Array.isArray(job.overlays) ? job.overlays.slice(0, 400) : [];
    for (const [i, o] of overlays.entries()) {
      const png = o && o.png;
      if (!(png instanceof Uint8Array) || png.length > 64 * 1024 * 1024 || !isPng(png)) { overlayPaths.push(null); continue; }
      const file = path.join(dir, `title${i}.png`);
      await fsp.writeFile(file, png);
      overlayPaths.push(file);
    }
    const { buildArgs } = require('./movie-export');
    let built;
    try { built = buildArgs(job, (t) => need(str(t)).path, out, overlayPaths); } catch (err) { await fsp.rm(dir, { recursive: true, force: true }).catch(() => {}); throw err; }
    startJob(win, str(id, 64), built.args, built.duration, () => fsp.rm(dir, { recursive: true, force: true }).catch(() => {}));
    return describe(str(outToken));
  });
  handle('media:proxy', async (_e, win, token, id) => {
    // A smaller, easy-to-play copy of a video for smooth editing (the export still uses the original).
    const g = need(str(token));
    const st = await fsp.stat(g.path);
    const key = crypto.createHash('sha1').update(`${g.path}|${st.size}|${st.mtimeMs}`).digest('hex').slice(0, 24);
    const dir = path.join(dataDir(), 'proxies');
    await fsp.mkdir(dir, { recursive: true });
    const out = path.join(dir, `${key}.mp4`);
    if (!fs.existsSync(out)) {
      await pruneProxies(dir);
      const info = await probe(g.path).catch(() => null);
      const tmp = `${out}.part.mp4`;
      const args = ['-i', g.path, '-map', '0:v:0?', '-map', '0:a:0?', '-sn', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-g', '30',
        '-vf', "scale='min(1280,iw)':-2", '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k', '-ac', '2', '-movflags', '+faststart', tmp];
      await new Promise((resolve, reject) => startJob(win, str(id, 64), args, (info && info.duration) || 0, (ok, tail) => (ok ? resolve() : reject(new Error(tail.split('\n').slice(-4).join(' '))))));
      await fsp.rename(tmp, out);
    }
    return describe(grant(out, false));
  });
  handle('media:project', async (_e, _win, token) => {
    // A project names its media by path: grant only the ones that exist and are media.
    const g = need(str(token));
    const st = await fsp.stat(g.path);
    if (st.size > 20 * 1024 * 1024) throw new Error('This project file is too large.');
    const text = await fsp.readFile(g.path, 'utf8');
    const j = JSON.parse(text);
    const allow = new Set([...VIDEO_EXTS, ...AUDIO_EXTS, ...IMAGE_EXTS]);
    const links = {};
    for (const m of (Array.isArray(j.media) ? j.media : []).slice(0, 2000)) {
      const p = typeof m.path === 'string' ? m.path : '';
      if (!p || !path.isAbsolute(p) || !allow.has(path.extname(p).slice(1).toLowerCase())) continue;
      try { if (!fs.statSync(p).isFile()) continue; } catch { continue; }
      links[String(m.id)] = describe(grant(p, false));
    }
    return { text, links };
  });
  handle('media:convert', async (_e, win, id, inToken, outToken, preset) => {
    const input = need(str(inToken)).path;
    const out = need(str(outToken), true).path;
    const info = await probe(input).catch(() => null);
    const presets = {
      mp4: ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'],
      webm: ['-c:v', 'libvpx-vp9', '-crf', '32', '-b:v', '0', '-c:a', 'libopus', '-b:a', '160k'],
      mp3: ['-vn', '-c:a', 'libmp3lame', '-q:a', '2'],
      m4a: ['-vn', '-c:a', 'aac', '-b:a', '256k'],
      flac: ['-vn', '-c:a', 'flac'],
      wav: ['-vn', '-c:a', 'pcm_s16le'],
      gif: ['-vf', 'fps=12,scale=480:-1:flags=lanczos,split[a][b];[a]palettegen[p];[b][p]paletteuse', '-an'],
    };
    const args = presets[str(preset, 8)];
    if (!args) throw new Error('Unknown format');
    startJob(win, str(id, 64), ['-i', input, ...args, out], (info && info.duration) || 0);
    return describe(str(outToken));
  });
  handle('media:playlist', async (_e, _win, token) => {
    // The page names a playlist the user opened; we read it here and grant only
    // the media files it lists that really exist (never other kinds of file).
    const g = need(str(token));
    const st = await fsp.stat(g.path);
    if (st.size > 5 * 1024 * 1024) throw new Error('This playlist is too large.');
    const text = await fsp.readFile(g.path, 'utf8');
    const entries = parsePlaylist(text, path.extname(g.path).slice(1).toLowerCase());
    const allow = new Set([...VIDEO_EXTS, ...AUDIO_EXTS]);
    const out = [];
    for (const e of entries.slice(0, 5000)) {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(e.path) && !/^file:\/\//i.test(e.path)) continue; // web addresses are skipped
      let p = e.path.replace(/^file:\/\//i, '');
      try { p = decodeURIComponent(p); } catch {}
      if (process.platform === 'win32' && /^\/[a-z]:/i.test(p)) p = p.slice(1);
      const full = path.resolve(path.dirname(g.path), p);
      if (!allow.has(path.extname(full).slice(1).toLowerCase())) continue;
      try { if (!fs.statSync(full).isFile()) continue; } catch { continue; }
      out.push({ ...describe(grant(full, false)), title: e.title || '' });
    }
    return out;
  });
  listen('media:cancel', (_win, id) => {
    const job = jobs.get(str(id, 64));
    if (job) job.proc.kill('SIGKILL');
  });
}

/** Keep the editing copies from piling up: the newest 60 stay. */
async function pruneProxies(dir) {
  try {
    const names = (await fsp.readdir(dir)).filter((n) => n.endsWith('.mp4'));
    if (names.length < 60) return;
    const withTime = await Promise.all(names.map(async (n) => ({ n, t: (await fsp.stat(path.join(dir, n))).mtimeMs })));
    withTime.sort((a, b) => b.t - a.t);
    for (const { n } of withTime.slice(59)) await fsp.rm(path.join(dir, n), { force: true });
  } catch {}
}

/** Entries of an M3U/M3U8 or PLS playlist: [{ path, title }]. */
function parsePlaylist(text, ext) {
  const out = [];
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (ext === 'pls' || /^\s*\[playlist\]/i.test(lines[0] || '')) {
    const files = {};
    const titles = {};
    for (const l of lines) {
      const m = /^\s*(File|Title)(\d+)\s*=\s*(.*)$/i.exec(l);
      if (!m) continue;
      if (m[1].toLowerCase() === 'file') files[m[2]] = m[3].trim(); else titles[m[2]] = m[3].trim();
    }
    for (const k of Object.keys(files).sort((a, b) => a - b)) out.push({ path: files[k], title: titles[k] || '' });
    return out;
  }
  let title = '';
  for (const raw of lines) {
    const l = raw.trim();
    if (!l) continue;
    if (l.startsWith('#')) {
      const m = /^#EXTINF:[^,]*,(.*)$/i.exec(l);
      if (m) title = m[1].trim();
      continue;
    }
    out.push({ path: l, title });
    title = '';
  }
  return out;
}

module.exports = { register, serve, ffmpegPath, ffprobePath, stopFor, stopAll, probe, parsePlaylist };
