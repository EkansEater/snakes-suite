// Charts drawn on a canvas: column, bar, line, area, pie, doughnut and scatter,
// with stacking, legends, axis titles and data labels. Shared by Spreadsheets
// and Slides. drawChart() returns a hit-tester for tooltips.

export const CHART_COLORS = ['#2f81f7', '#3fb950', '#f0883e', '#a371f7', '#e5534b', '#d4a72c', '#0e8a9a', '#db61a2', '#6e7781', '#1f6feb'];
export const CHART_TYPES = [
  ['column', 'Column'], ['stacked', 'Stacked column'], ['bar', 'Bar'], ['line', 'Line'], ['area', 'Area'],
  ['pie', 'Pie'], ['doughnut', 'Doughnut'], ['scatter', 'Scatter'],
];

function niceStep(range, ticks) {
  const raw = range / Math.max(1, ticks);
  const mag = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / mag;
  return (n < 1.5 ? 1 : n < 3 ? 2 : n < 7 ? 5 : 10) * mag;
}

export function shortNumber(v) {
  const a = Math.abs(v);
  if (a >= 1e9) return `${+(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${+(v / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${+(v / 1e3).toFixed(1)}K`;
  if (a && a < 0.01) return v.toExponential(1);
  return String(+v.toFixed(2));
}

/**
 * spec: { type, title, categories, series: [{ name, values, color }], legend, xTitle, yTitle,
 *         dataLabels, smooth, theme: 'light' | 'dark', background, font }
 */
export function drawChart(canvas, spec, { width, height, dpr = window.devicePixelRatio || 1 } = {}) {
  const W = width || canvas.clientWidth || 480;
  const H = height || canvas.clientHeight || 300;
  canvas.width = Math.round(W * dpr);
  canvas.height = Math.round(H * dpr);
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const dark = spec.theme === 'dark';
  const C = {
    bg: spec.background || (dark ? '#1b1f1c' : '#ffffff'), text: dark ? '#d5ddd7' : '#2b332e', muted: dark ? '#8a978e' : '#6b756f',
    grid: dark ? '#2b322d' : '#e5e9e6', axis: dark ? '#4a554d' : '#b7c1ba',
  };
  const font = spec.font || '"Inter", "Segoe UI", "Noto Sans", "DejaVu Sans", Arial, sans-serif';
  const scale = Math.max(0.6, Math.min(2, Math.min(W / 480, H / 300)));
  const fs = (n) => `${Math.round(n * scale)}px ${font}`;
  ctx.fillStyle = C.bg;
  ctx.fillRect(0, 0, W, H);
  const series = (spec.series || []).map((s, i) => ({ ...s, color: s.color || CHART_COLORS[i % CHART_COLORS.length], values: s.values.map((v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)) }));
  const cats = spec.categories || [];
  const hits = [];
  let top = 10 * scale;
  if (spec.title) {
    ctx.fillStyle = C.text;
    ctx.font = `600 ${fs(15)}`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillText(spec.title, W / 2, top, W - 20);
    top += 26 * scale;
  }
  const type = spec.type || 'column';
  const pie = type === 'pie' || type === 'doughnut';
  // Legend.
  const legendItems = pie ? cats.map((c, i) => ({ name: String(c), color: (series[0] && series[0].colors && series[0].colors[i]) || CHART_COLORS[i % CHART_COLORS.length] })) : series.map((s) => ({ name: s.name || '', color: s.color }));
  const legend = spec.legend === undefined ? (legendItems.length > 1 || pie ? 'bottom' : 'none') : spec.legend;
  let bottom = H - 10 * scale;
  let right = W - 12 * scale;
  ctx.font = fs(11.5);
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  if (legend === 'bottom' && legendItems.length) {
    const rows = [];
    let row = [];
    let w = 0;
    for (const it of legendItems) {
      const iw = 18 * scale + ctx.measureText(it.name).width + 14 * scale;
      if (w + iw > W - 20 && row.length) { rows.push([row, w]); row = []; w = 0; }
      row.push([it, iw]);
      w += iw;
    }
    if (row.length) rows.push([row, w]);
    const lh = 18 * scale;
    bottom -= rows.length * lh;
    rows.forEach(([items, total], ri) => {
      let x = (W - total) / 2;
      const y = bottom + ri * lh + lh / 2 + 4 * scale;
      for (const [it, iw] of items) {
        ctx.fillStyle = it.color;
        ctx.fillRect(x, y - 5 * scale, 11 * scale, 11 * scale);
        ctx.fillStyle = C.text;
        ctx.fillText(it.name, x + 16 * scale, y);
        x += iw;
      }
    });
    bottom -= 6 * scale;
  } else if (legend === 'right' && legendItems.length) {
    const lw = Math.min(W * 0.32, Math.max(...legendItems.map((it) => ctx.measureText(it.name).width)) + 30 * scale);
    right -= lw;
    legendItems.forEach((it, i) => {
      const y = top + 10 * scale + i * 18 * scale;
      ctx.fillStyle = it.color;
      ctx.fillRect(right + 10 * scale, y - 5 * scale, 11 * scale, 11 * scale);
      ctx.fillStyle = C.text;
      ctx.fillText(it.name, right + 26 * scale, y, lw - 30 * scale);
    });
  }

  if (pie) {
    const s = series[0] || { values: [] };
    const vals = s.values.map((v) => Math.max(0, v || 0));
    const total = vals.reduce((a, b) => a + b, 0) || 1;
    const cx = (12 * scale + right) / 2;
    const cy = (top + bottom) / 2;
    const r = Math.max(10, Math.min(right - 12 * scale, bottom - top) / 2 - 6 * scale);
    let a = -Math.PI / 2;
    vals.forEach((v, i) => {
      const a2 = a + (v / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, r, a, a2);
      ctx.closePath();
      ctx.fillStyle = legendItems[i] ? legendItems[i].color : CHART_COLORS[i % CHART_COLORS.length];
      ctx.fill();
      ctx.strokeStyle = C.bg;
      ctx.lineWidth = 2;
      ctx.stroke();
      hits.push({ kind: 'arc', cx, cy, r, a0: a, a1: a2, label: String(cats[i] ?? ''), value: v, series: s.name || '', pct: v / total });
      if (spec.dataLabels !== false && v / total > 0.04) {
        const mid = (a + a2) / 2;
        const lr = type === 'doughnut' ? r * 0.78 : r * 0.62;
        ctx.fillStyle = '#ffffff';
        ctx.font = `600 ${fs(11)}`;
        ctx.textAlign = 'center';
        ctx.fillText(`${Math.round((v / total) * 100)}%`, cx + Math.cos(mid) * lr, cy + Math.sin(mid) * lr);
      }
      a = a2;
    });
    if (type === 'doughnut') {
      ctx.beginPath();
      ctx.arc(cx, cy, r * 0.55, 0, Math.PI * 2);
      ctx.fillStyle = C.bg;
      ctx.fill();
      ctx.fillStyle = C.text;
      ctx.font = `600 ${fs(16)}`;
      ctx.textAlign = 'center';
      ctx.fillText(shortNumber(total), cx, cy);
    }
    return makeHit(hits);
  }

  // Axes.
  const horizontal = type === 'bar';
  const stacked = type === 'stacked' || spec.stacked;
  const scatter = type === 'scatter';
  let all = [];
  if (stacked) {
    for (let i = 0; i < cats.length; i++) {
      let pos = 0;
      let neg = 0;
      for (const s of series) { const v = s.values[i] || 0; if (v >= 0) pos += v; else neg += v; }
      all.push(pos, neg);
    }
  } else all = series.flatMap((s) => s.values.filter((v) => v !== null));
  if (!all.length) all = [0, 1];
  let min = Math.min(0, ...all);
  let max = Math.max(0, ...all);
  if (scatter) { min = Math.min(...all); max = Math.max(...all); }
  if (max === min) max = min + 1;
  const step = niceStep(max - min, horizontal ? 5 : Math.max(3, Math.min(8, Math.floor((bottom - top) / (34 * scale)))));
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  ctx.font = fs(11);
  const ticks = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v / step) * step);
  const labelW = Math.max(...ticks.map((t) => ctx.measureText(shortNumber(t)).width));
  let left = 12 * scale + (horizontal ? Math.min(W * 0.3, Math.max(...cats.map((c) => ctx.measureText(String(c)).width), 20)) + 8 * scale : labelW + 10 * scale);
  if (spec.yTitle) left += 18 * scale;
  if (spec.xTitle) bottom -= 18 * scale;
  bottom -= horizontal ? 18 * scale : 22 * scale;
  const plotW = Math.max(10, right - left);
  const plotH = Math.max(10, bottom - top);
  const vToPos = horizontal ? (v) => left + ((v - lo) / (hi - lo)) * plotW : (v) => bottom - ((v - lo) / (hi - lo)) * plotH;
  // Gridlines and value labels.
  ctx.strokeStyle = C.grid;
  ctx.lineWidth = 1;
  ctx.fillStyle = C.muted;
  ctx.textBaseline = 'middle';
  for (const t of ticks) {
    const p = Math.round(vToPos(t)) + 0.5;
    ctx.beginPath();
    if (horizontal) { ctx.moveTo(p, top); ctx.lineTo(p, bottom); } else { ctx.moveTo(left, p); ctx.lineTo(right, p); }
    ctx.stroke();
    if (horizontal) { ctx.textAlign = 'center'; ctx.fillText(shortNumber(t), p, bottom + 10 * scale); }
    else { ctx.textAlign = 'right'; ctx.fillText(shortNumber(t), left - 6 * scale, p); }
  }
  ctx.strokeStyle = C.axis;
  ctx.beginPath();
  if (horizontal) { ctx.moveTo(vToPos(0), top); ctx.lineTo(vToPos(0), bottom); } else { ctx.moveTo(left, vToPos(Math.max(lo, 0))); ctx.lineTo(right, vToPos(Math.max(lo, 0))); }
  ctx.stroke();
  // Axis titles.
  ctx.fillStyle = C.muted;
  ctx.font = fs(11.5);
  if (spec.xTitle) { ctx.textAlign = 'center'; ctx.fillText(spec.xTitle, (left + right) / 2, H - (legend === 'bottom' ? 30 : 12) * scale); }
  if (spec.yTitle) {
    ctx.save();
    ctx.translate(14 * scale, (top + bottom) / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = 'center';
    ctx.fillText(spec.yTitle, 0, 0);
    ctx.restore();
  }

  const n = Math.max(1, cats.length || Math.max(...series.map((s) => s.values.length)));
  const band = (horizontal ? plotH : plotW) / n;
  // Category labels.
  ctx.fillStyle = C.muted;
  ctx.font = fs(11);
  if (!scatter) {
    const every = horizontal ? Math.max(1, Math.ceil((14 * scale) / band)) : Math.max(1, Math.ceil(Math.max(...cats.map((c) => ctx.measureText(String(c)).width), 10) / (band - 6)));
    cats.forEach((c, i) => {
      if (i % every) return;
      const mid = (horizontal ? top : left) + band * (i + 0.5);
      if (horizontal) { ctx.textAlign = 'right'; ctx.fillText(String(c), left - 6 * scale, mid, W * 0.3); }
      else { ctx.textAlign = 'center'; ctx.fillText(String(c), mid, bottom + 12 * scale, band * every - 4); }
    });
  }

  if (type === 'column' || type === 'bar' || stacked) {
    const groups = stacked ? 1 : series.length;
    const gap = band * 0.18;
    const bw = (band - gap * 2) / groups;
    const posAcc = new Array(n).fill(0);
    const negAcc = new Array(n).fill(0);
    series.forEach((s, si) => {
      ctx.fillStyle = s.color;
      s.values.forEach((v, i) => {
        if (v === null) return;
        let a; let b;
        if (stacked) {
          if (v >= 0) { a = posAcc[i]; posAcc[i] += v; b = posAcc[i]; } else { a = negAcc[i]; negAcc[i] += v; b = negAcc[i]; }
        } else { a = 0; b = v; }
        const start = (horizontal ? top : left) + band * i + gap + (stacked ? 0 : bw * si);
        const p0 = vToPos(Math.max(lo, Math.min(hi, a)));
        const p1 = vToPos(Math.max(lo, Math.min(hi, b)));
        let rect;
        if (horizontal) rect = [Math.min(p0, p1), start, Math.abs(p1 - p0), bw - 1];
        else rect = [start, Math.min(p0, p1), bw - 1, Math.abs(p1 - p0)];
        roundRect(ctx, ...rect, Math.min(3 * scale, bw / 4), horizontal ? (v >= 0 ? 'right' : 'left') : (v >= 0 ? 'top' : 'bottom'));
        hits.push({ kind: 'rect', x: rect[0], y: rect[1], w: rect[2], h: rect[3], label: String(cats[i] ?? i + 1), value: v, series: s.name || '' });
        if (spec.dataLabels && !stacked) {
          ctx.save();
          ctx.fillStyle = C.text;
          ctx.font = fs(10.5);
          ctx.textAlign = horizontal ? 'left' : 'center';
          ctx.textBaseline = horizontal ? 'middle' : 'bottom';
          if (horizontal) ctx.fillText(shortNumber(v), rect[0] + rect[2] + 3, rect[1] + rect[3] / 2);
          else ctx.fillText(shortNumber(v), rect[0] + rect[2] / 2, rect[1] - 2);
          ctx.restore();
        }
      });
    });
    return makeHit(hits);
  }

  if (scatter) {
    // First series: x values; the rest: y values.
    const xs = series[0] ? series[0].values : [];
    const ys = series.slice(1);
    const xmin = Math.min(...xs.filter((v) => v !== null));
    const xmax = Math.max(...xs.filter((v) => v !== null), xmin + 1);
    const xp = (v) => left + ((v - xmin) / (xmax - xmin || 1)) * plotW;
    ctx.textAlign = 'center';
    ctx.fillStyle = C.muted;
    const xs2 = niceStep(xmax - xmin, 5);
    for (let v = Math.ceil(xmin / xs2) * xs2; v <= xmax; v += xs2) ctx.fillText(shortNumber(v), xp(v), bottom + 12 * scale);
    (ys.length ? ys : series).forEach((s) => {
      ctx.fillStyle = s.color;
      s.values.forEach((v, i) => {
        if (v === null || xs[i] === null || xs[i] === undefined) return;
        const x = xp(xs[i]);
        const y = vToPos(v);
        ctx.beginPath();
        ctx.arc(x, y, 4 * scale, 0, Math.PI * 2);
        ctx.fill();
        hits.push({ kind: 'dot', x, y, r: 6 * scale, label: shortNumber(xs[i]), value: v, series: s.name || '' });
      });
    });
    return makeHit(hits);
  }

  // Line and area.
  series.forEach((s) => {
    const pts = s.values.map((v, i) => (v === null ? null : [left + band * (i + 0.5), vToPos(v)]));
    ctx.strokeStyle = s.color;
    ctx.lineWidth = 2.2 * scale;
    ctx.lineJoin = 'round';
    if (type === 'area') {
      const first = pts.find(Boolean);
      const last = [...pts].reverse().find(Boolean);
      if (first) {
        ctx.beginPath();
        ctx.moveTo(first[0], vToPos(Math.max(lo, 0)));
        for (const p of pts) if (p) ctx.lineTo(p[0], p[1]);
        ctx.lineTo(last[0], vToPos(Math.max(lo, 0)));
        ctx.closePath();
        ctx.globalAlpha = 0.25;
        ctx.fillStyle = s.color;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    }
    ctx.beginPath();
    let pen = false;
    pts.forEach((p, i) => {
      if (!p) { pen = false; return; }
      if (!pen) { ctx.moveTo(p[0], p[1]); pen = true; return; }
      if (spec.smooth) {
        const prev = pts[i - 1];
        const mx = (prev[0] + p[0]) / 2;
        ctx.bezierCurveTo(mx, prev[1], mx, p[1], p[0], p[1]);
      } else ctx.lineTo(p[0], p[1]);
    });
    ctx.stroke();
    ctx.fillStyle = s.color;
    pts.forEach((p, i) => {
      if (!p) return;
      if (n <= 40) { ctx.beginPath(); ctx.arc(p[0], p[1], 3 * scale, 0, Math.PI * 2); ctx.fill(); }
      hits.push({ kind: 'dot', x: p[0], y: p[1], r: 7 * scale, label: String(cats[i] ?? i + 1), value: s.values[i], series: s.name || '' });
      if (spec.dataLabels) {
        ctx.save();
        ctx.fillStyle = C.text;
        ctx.font = fs(10.5);
        ctx.textAlign = 'center';
        ctx.fillText(shortNumber(s.values[i]), p[0], p[1] - 9 * scale);
        ctx.restore();
      }
    });
  });
  return makeHit(hits);
}

function roundRect(ctx, x, y, w, h, r, side) {
  if (w <= 0 || h <= 0) return;
  r = Math.min(r, w / 2, h / 2);
  const rr = { top: [r, r, 0, 0], bottom: [0, 0, r, r], right: [0, r, r, 0], left: [r, 0, 0, r] }[side] || [0, 0, 0, 0];
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, rr);
  ctx.fill();
}

function makeHit(hits) {
  return (x, y) => {
    for (let i = hits.length - 1; i >= 0; i--) {
      const t = hits[i];
      if (t.kind === 'rect' && x >= t.x && x <= t.x + t.w && y >= t.y && y <= t.y + t.h) return t;
      if (t.kind === 'dot' && (x - t.x) ** 2 + (y - t.y) ** 2 <= t.r ** 2) return t;
      if (t.kind === 'arc') {
        const d = Math.hypot(x - t.cx, y - t.cy);
        if (d > t.r) continue;
        let a = Math.atan2(y - t.cy, x - t.cx);
        if (a < -Math.PI / 2) a += Math.PI * 2;
        if (a >= t.a0 && a <= t.a1) return t;
      }
    }
    return null;
  };
}

/** Series from a 2D block of values: first row/column as labels when they are text. */
export function seriesFromGrid(rows, byColumns = true) {
  if (!rows.length) return { categories: [], series: [] };
  let data = rows;
  if (!byColumns) data = rows[0].map((_, c) => rows.map((r) => r[c]));
  const isText = (v) => typeof v === 'string' && v.trim() !== '' && Number.isNaN(Number(v));
  const headerRow = data[0].some(isText) && data.length > 1;
  const body = headerRow ? data.slice(1) : data;
  const labelCol = body.length && body.every((r) => r[0] === null || r[0] === undefined || isText(r[0]) || typeof r[0] !== 'number') && data[0].length > 1;
  const categories = labelCol ? body.map((r) => (r[0] === null || r[0] === undefined ? '' : String(r[0]))) : body.map((_, i) => String(i + 1));
  const start = labelCol ? 1 : 0;
  const series = [];
  for (let c = start; c < data[0].length; c++) {
    series.push({ name: headerRow ? String(data[0][c] ?? `Series ${c}`) : `Series ${c - start + 1}`, values: body.map((r) => (typeof r[c] === 'number' ? r[c] : Number.isFinite(Number(r[c])) && r[c] !== '' && r[c] !== null ? Number(r[c]) : null)) });
  }
  return { categories, series };
}
