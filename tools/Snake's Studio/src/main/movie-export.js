// Turning a Movie Maker timeline into one ffmpeg command.
//
// The page sends a description of what to draw (already worked out by the same
// code that draws the preview); this file only turns numbers into filters. No
// text from the project ever reaches ffmpeg: titles arrive as pictures the page
// drew, written to our own temporary folder. Files are only ever paths of
// media the user opened (looked up from page tokens).
'use strict';

const FORMATS = {
  mp4: { video: true, audio: true },
  webm: { video: true, audio: true },
  gif: { video: true, audio: false },
  mp3: { video: false, audio: true },
  m4a: { video: false, audio: true },
  wav: { video: false, audio: true },
};

const num = (v, lo, hi, d = lo) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const f3 = (v) => Number(v).toFixed(3);
const even = (v) => Math.max(2, Math.round(v / 2) * 2);
const hex = (c) => (/^#[0-9a-f]{6}$/i.test(String(c)) ? `0x${String(c).slice(1)}` : '0x000000');

/** Filters for brightness, contrast, colour and the looks. */
function colourFilters(f = {}) {
  const out = [];
  const b = num(f.brightness, 0, 3, 1);
  const c = num(f.contrast, 0, 3, 1);
  const s = num(f.saturation, 0, 4, 1);
  const hue = num(f.hue, -360, 360, 0);
  const gray = num(f.gray, 0, 1, 0);
  const sepia = num(f.sepia, 0, 1, 0);
  const blur = num(f.blur, 0, 100, 0);
  // Same order as the preview: brightness, contrast, saturation, hue, grey, sepia, blur.
  if (b !== 1) out.push(`colorchannelmixer=rr=${f3(b)}:gg=${f3(b)}:bb=${f3(b)}`);
  if (c !== 1) out.push(`eq=contrast=${f3(c)}`);
  if (s !== 1) out.push(`eq=saturation=${f3(s)}`);
  if (hue) out.push(`hue=h=${f3(hue)}`);
  if (gray) out.push(`hue=s=${f3(1 - gray)}`);
  if (sepia) {
    const k = sepia;
    const m = (a, x) => f3(a + (x - a) * k);
    out.push(`colorchannelmixer=rr=${m(1, 0.393)}:rg=${m(0, 0.769)}:rb=${m(0, 0.189)}:gr=${m(0, 0.349)}:gg=${m(1, 0.686)}:gb=${m(0, 0.168)}:br=${m(0, 0.272)}:bg=${m(0, 0.534)}:bb=${m(1, 0.131)}`);
  }
  if (blur) out.push(`gblur=sigma=${f3(blur)}`);
  return out;
}

/** atempo only takes 0.5…2 per step: chain steps for other speeds. */
function tempo(speed) {
  const out = [];
  let s = speed;
  while (s > 2) { out.push('atempo=2'); s /= 2; }
  while (s < 0.5) { out.push('atempo=0.5'); s /= 0.5; }
  if (Math.abs(s - 1) > 1e-3) out.push(`atempo=${f3(s)}`);
  return out;
}

/**
 * job: { width, height, fps, duration, background, format, quality, layers, audio }
 * resolve(token) -> a granted file path; overlayPaths[i] -> the picture of title i.
 */
function buildArgs(job, resolve, outPath, overlayPaths = []) {
  const fmt = FORMATS[job.format] ? job.format : 'mp4';
  const kind = FORMATS[fmt];
  const W = even(num(job.width, 16, 7680, 1920));
  const H = even(num(job.height, 16, 7680, 1080));
  const fps = num(job.fps, 1, 120, 30);
  const D = num(job.duration, 0.1, 6 * 3600, 1);
  const q = ['high', 'good', 'small'].includes(job.quality) ? job.quality : 'good';
  const inputs = [];
  const graph = [];
  let n = 0;
  const input = (args) => { inputs.push(...args); return n++; };

  if (kind.video) {
    const base = input(['-f', 'lavfi', '-i', `color=c=${hex(job.background)}:s=${W}x${H}:r=${fps}:d=${f3(D)}`]);
    graph.push(`[${base}:v]format=yuva420p[b0]`);
    let cur = 'b0';
    let k = 0;
    for (const L of (Array.isArray(job.layers) ? job.layers : []).slice(0, 400)) {
      const start = num(L.start, -60, D, 0);
      const dur = num(L.dur, 0.04, D + 60, 1);
      const chain = [];
      let idx;
      let x = '0';
      let y = '0';
      if (L.kind === 'clip') {
        const file = resolve(String(L.token));
        const speed = num(L.speed, 0.1, 16, 1);
        const w = even(num(L.w, 2, 16384, W));
        const h = even(num(L.h, 2, 16384, H));
        if (L.media === 'image') {
          idx = input(['-loop', '1', '-framerate', String(fps), '-t', f3(dur + 0.1), '-i', file]);
          chain.push(`trim=duration=${f3(dur)}`, 'format=rgba');
          if (L.motion) {
            // Ken Burns: zoompan between the start and end framings (on a bigger copy, so it glides).
            const m = L.motion;
            const z0 = num(m.from && m.from.s, 1, 10, 1); const z1 = num(m.to && m.to.s, 1, 10, 1);
            const x0 = num(m.from && m.from.x, 0, 1, 0.5); const x1 = num(m.to && m.to.x, 0, 1, 0.5);
            const y0 = num(m.from && m.from.y, 0, 1, 0.5); const y1 = num(m.to && m.to.y, 0, 1, 0.5);
            const N = Math.max(2, Math.round(dur * fps));
            const e = `(on/${N - 1})*(on/${N - 1})*(3-2*(on/${N - 1}))`;
            chain.push(`scale=${even(w * 3)}:${even(h * 3)}`,
              `zoompan=z='${f3(z0)}+(${f3(z1 - z0)})*${e}':x='max(0,min(iw-iw/zoom,(${f3(x0)}+(${f3(x1 - x0)})*${e})*iw-iw/zoom/2))':y='max(0,min(ih-ih/zoom,(${f3(y0)}+(${f3(y1 - y0)})*${e})*ih-ih/zoom/2))':d=1:s=${w}x${h}:fps=${fps}`,
              'format=rgba');
          } else chain.push(`scale=${w}:${h}`);
        } else {
          const inT = num(L.in, 0, 1e7, 0);
          idx = input(['-ss', f3(inT), '-t', f3(dur * speed + 0.2), '-i', file]);
          chain.push(`setpts=(PTS-STARTPTS)/${f3(speed)}`, `fps=${fps}`, `trim=duration=${f3(dur)}`, `scale=${w}:${h}`, 'format=rgba');
        }
        chain.push(...colourFilters(L.filters));
        let ow = w;
        let oh = h;
        const rot = num(L.rot, -3600, 3600, 0) % 360;
        if (rot) {
          const a = (rot * Math.PI) / 180;
          ow = even(Math.abs(w * Math.cos(a)) + Math.abs(h * Math.sin(a)));
          oh = even(Math.abs(w * Math.sin(a)) + Math.abs(h * Math.cos(a)));
          chain.push(`rotate=${f3(a)}:ow=${ow}:oh=${oh}:c=none`);
        }
        const op = num(L.opacity, 0, 1, 1);
        if (op < 1) chain.push(`colorchannelmixer=aa=${f3(op)}`);
        const fi = num(L.fadeIn, 0, dur, 0);
        const fo = num(L.fadeOut, 0, dur, 0);
        if (fi > 0) chain.push(`fade=t=in:st=0:d=${f3(fi)}:alpha=1`);
        if (fo > 0) chain.push(`fade=t=out:st=${f3(dur - fo)}:d=${f3(fo)}:alpha=1`);
        const cx = num(L.cx, -1e5, 1e5, W / 2);
        const cy = num(L.cy, -1e5, 1e5, H / 2);
        x = String(Math.round(cx - ow / 2));
        y = String(Math.round(cy - oh / 2));
        // Slides: the picture glides in from one side (eased like the preview).
        const sl = L.slide && ['slideLeft', 'slideRight', 'slideUp'].includes(L.slide.kind) ? L.slide : null;
        if (sl) {
          const sd = num(sl.dur, 0.05, 10, 0.5);
          const ease = `pow(1-clip((t-${f3(start)})/${f3(sd)},0,1),3)`;
          if (sl.kind === 'slideLeft') x = `'${x}+${W}*${ease}'`;
          if (sl.kind === 'slideRight') x = `'${x}-${W}*${ease}'`;
          if (sl.kind === 'slideUp') y = `'${y}+${H}*${ease}'`;
        }
      } else if (L.kind === 'title') {
        const path = overlayPaths[num(L.index, 0, 1e4, 0)];
        if (!path) continue;
        idx = input(['-loop', '1', '-framerate', String(fps), '-t', f3(dur), '-i', path]);
        chain.push('format=rgba', `scale=${W}:${H}`);
        const anim = ['none', 'fade', 'slide', 'rise'].includes(L.anim) ? L.anim : 'fade';
        const fd = Math.min(0.5, dur / 3);
        const op = num(L.opacity, 0, 1, 1);
        if (op < 1) chain.push(`colorchannelmixer=aa=${f3(op)}`);
        if (anim !== 'none' && fd > 0) chain.push(`fade=t=in:st=0:d=${f3(fd)}:alpha=1`, `fade=t=out:st=${f3(dur - fd)}:d=${f3(fd)}:alpha=1`);
        const e = `(1-pow(1-clip((t-${f3(start)})/${f3(fd)},0,1),3))`;
        if (anim === 'slide') x = `'-(1-${e})*${f3(W * 0.08)}'`;
        if (anim === 'rise') y = `'(1-${e})*${f3(H * 0.06)}'`;
      } else if (L.kind === 'black') {
        idx = input(['-f', 'lavfi', '-i', `color=c=black:s=${W}x${H}:r=${fps}:d=${f3(dur)}`]);
        const half = dur / 2;
        chain.push('format=rgba', `fade=t=in:st=0:d=${f3(half)}:alpha=1`, `fade=t=out:st=${f3(half)}:d=${f3(half)}:alpha=1`);
      } else continue;
      chain.push(`setpts=PTS+${f3(Math.max(0, start))}/TB`);
      k++;
      graph.push(`[${idx}:v]${chain.join(',')}[l${k}]`);
      graph.push(`[${cur}][l${k}]overlay=x=${x}:y=${y}:eof_action=pass:format=auto[o${k}]`);
      cur = `o${k}`;
    }
    if (fmt === 'gif') {
      const gw = Math.min(W, 720);
      graph.push(`[${cur}]fps=${Math.min(fps, 15)},scale=${gw}:-1:flags=lanczos,split[g1][g2];[g1]palettegen=stats_mode=diff[gp];[g2][gp]paletteuse=dither=bayer:bayer_scale=4[vout]`);
    } else graph.push(`[${cur}]format=yuv420p[vout]`);
  }

  if (kind.audio) {
    const parts = [];
    for (const a of (Array.isArray(job.audio) ? job.audio : []).slice(0, 300)) {
      const file = resolve(String(a.token));
      const start = num(a.start, 0, D, 0);
      const dur = num(a.dur, 0.04, D, 1);
      const speed = num(a.speed, 0.1, 16, 1);
      const idx = input(['-ss', f3(num(a.in, 0, 1e7, 0)), '-t', f3(dur * speed + 0.05), '-i', file]);
      const chain = ['aresample=48000', 'aformat=channel_layouts=stereo', 'asetpts=PTS-STARTPTS', ...tempo(speed)];
      const v = num(a.volume, 0, 4, 1);
      if (v !== 1) chain.push(`volume=${f3(v)}`);
      const fi = num(a.fadeIn, 0, dur, 0);
      const fo = num(a.fadeOut, 0, dur, 0);
      if (fi > 0) chain.push(`afade=t=in:st=0:d=${f3(fi)}`);
      if (fo > 0) chain.push(`afade=t=out:st=${f3(Math.max(0, dur - fo))}:d=${f3(fo)}`);
      chain.push(`atrim=0:${f3(dur)}`);
      const ms = Math.round(start * 1000);
      if (ms > 0) chain.push(`adelay=${ms}:all=1`);
      graph.push(`[${idx}:a]${chain.join(',')}[a${parts.length}]`);
      parts.push(`[a${parts.length}]`);
    }
    if (parts.length) graph.push(`${parts.join('')}amix=inputs=${parts.length}:normalize=0:duration=longest:dropout_transition=0,apad,atrim=0:${f3(D)}[aout]`);
    else {
      const s = input(['-f', 'lavfi', '-t', f3(D), '-i', 'anullsrc=r=48000:cl=stereo']);
      graph.push(`[${s}:a]anull[aout]`);
    }
  }

  const args = [...inputs, '-filter_complex', graph.join(';')];
  if (kind.video) args.push('-map', '[vout]');
  if (kind.audio) args.push('-map', '[aout]');
  const crf = { high: 18, good: 21, small: 26 }[q];
  if (fmt === 'mp4') args.push('-c:v', 'libx264', '-preset', 'medium', '-crf', String(crf), '-pix_fmt', 'yuv420p', '-r', String(fps), '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart');
  else if (fmt === 'webm') args.push('-c:v', 'libvpx-vp9', '-crf', String(crf + 12), '-b:v', '0', '-row-mt', '1', '-r', String(fps), '-c:a', 'libopus', '-b:a', '160k');
  else if (fmt === 'gif') args.push('-loop', '0');
  else if (fmt === 'mp3') args.push('-c:a', 'libmp3lame', '-q:a', '2');
  else if (fmt === 'm4a') args.push('-c:a', 'aac', '-b:a', '256k');
  else if (fmt === 'wav') args.push('-c:a', 'pcm_s16le');
  args.push('-t', f3(D), outPath);
  return { args, duration: D };
}

module.exports = { buildArgs, colourFilters, tempo };
