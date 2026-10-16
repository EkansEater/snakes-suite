// Presentations: themes, layouts, and turning a slide into elements.
// The same renderer draws the editor, thumbnails, the slide show and exports.
import { h, uid, escapeHtml } from '../../kit/dom.js';
import { drawChart } from '../../kit/charts.js';
import { shapePath } from '../../kit/shapes.js';

export { shapePath };

export const SIZES = {
  wide: { name: 'Widescreen 16:9', w: 1280, h: 720 },
  standard: { name: 'Standard 4:3', w: 960, h: 720 },
  square: { name: 'Square 1:1', w: 1080, h: 1080 },
  portrait: { name: 'Portrait 9:16 (phone)', w: 720, h: 1280 },
  a4: { name: 'A4 landscape', w: 1123, h: 794 },
};

export const THEMES = {
  snake: { name: 'Snake', bg: 'linear-gradient(135deg, #16241b 0%, #0d1410 100%)', title: '#7ee787', text: '#d5ddd7', muted: '#8a978e', accents: ['#3fb950', '#2f81f7', '#f0883e', '#a371f7', '#e5534b', '#d4a72c'], heading: 'Inter, "Segoe UI", sans-serif', body: 'Inter, "Segoe UI", sans-serif', titleWeight: 700 },
  clean: { name: 'Clean', bg: '#ffffff', title: '#1b1f1c', text: '#2b332e', muted: '#6b756f', accents: ['#1f883d', '#0969da', '#bc4c00', '#8250df', '#cf222e', '#9a6700'], heading: 'Inter, "Segoe UI", sans-serif', body: 'Inter, "Segoe UI", sans-serif', titleWeight: 700, bar: '#1f883d' },
  midnight: { name: 'Midnight', bg: 'linear-gradient(160deg, #0f172a 0%, #1e293b 100%)', title: '#f8fafc', text: '#cbd5e1', muted: '#94a3b8', accents: ['#38bdf8', '#a78bfa', '#f472b6', '#34d399', '#fbbf24', '#f87171'], heading: '"Segoe UI", Inter, sans-serif', body: '"Segoe UI", Inter, sans-serif', titleWeight: 600 },
  sunset: { name: 'Sunset', bg: 'linear-gradient(135deg, #ff7e5f 0%, #feb47b 100%)', title: '#ffffff', text: '#fff7f0', muted: '#ffe3d3', accents: ['#ffffff', '#5a1f00', '#ffd166', '#06d6a0', '#118ab2', '#073b4c'], heading: 'Georgia, "Times New Roman", serif', body: 'Inter, "Segoe UI", sans-serif', titleWeight: 700 },
  paper: { name: 'Paper', bg: '#f7f3ea', title: '#3b2f1e', text: '#4a3f2e', muted: '#8a7b63', accents: ['#b5651d', '#5c7a3a', '#2f5d8a', '#8a3a5c', '#c49a3a', '#3a3a3a'], heading: 'Georgia, "Palatino Linotype", serif', body: 'Georgia, "Palatino Linotype", serif', titleWeight: 600 },
  bold: { name: 'Bold', bg: '#111111', title: '#ffd60a', text: '#f5f5f5', muted: '#a3a3a3', accents: ['#ffd60a', '#ff4d6d', '#4cc9f0', '#80ed99', '#f72585', '#ffffff'], heading: 'Impact, "Arial Black", sans-serif', body: 'Arial, Helvetica, sans-serif', titleWeight: 400, upper: true },
  ocean: { name: 'Ocean', bg: 'linear-gradient(180deg, #0b3954 0%, #087e8b 100%)', title: '#ffffff', text: '#e0fbfc', muted: '#bfe9ec', accents: ['#ff5a5f', '#ffd166', '#c8f2f5', '#7ae582', '#ffffff', '#ff9f1c'], heading: 'Inter, "Segoe UI", sans-serif', body: 'Inter, "Segoe UI", sans-serif', titleWeight: 700 },
  mono: { name: 'Mono', bg: '#1b1b1b', title: '#ffffff', text: '#dddddd', muted: '#9a9a9a', accents: ['#ffffff', '#bbbbbb', '#888888', '#5d5d5d', '#3fb950', '#e5534b'], heading: '"JetBrains Mono", "Cascadia Code", Consolas, monospace', body: 'Inter, "Segoe UI", sans-serif', titleWeight: 600 },
};

export const SHAPES = [
  ['rect', 'Rectangle'], ['roundRect', 'Rounded rectangle'], ['ellipse', 'Oval'], ['triangle', 'Triangle'], ['rightTriangle', 'Right triangle'],
  ['diamond', 'Diamond'], ['pentagon', 'Pentagon'], ['hexagon', 'Hexagon'], ['star', 'Star'], ['arrowRight', 'Arrow'], ['arrowLeft', 'Left arrow'],
  ['chevron', 'Chevron'], ['callout', 'Speech bubble'], ['heart', 'Heart'], ['plus', 'Plus'], ['cloud', 'Cloud'], ['parallelogram', 'Parallelogram'], ['ring', 'Ring'],
];

// ---------------------------------------------------------------------------
// New slides from layouts
// ---------------------------------------------------------------------------
const txt = (props) => ({ id: uid('it'), type: 'text', rot: 0, ...props });

export const LAYOUTS = [
  ['title', 'Title slide'], ['content', 'Title and content'], ['section', 'Section header'], ['two', 'Two columns'],
  ['compare', 'Comparison'], ['titleOnly', 'Title only'], ['quote', 'Quote'], ['big', 'Big number'], ['picture', 'Picture with caption'], ['blank', 'Blank'],
];

export function makeSlide(layout, size) {
  const { w, h: H } = size;
  const m = w * 0.07;
  const items = [];
  const title = (y, hh, align = 'left', size2 = 44, ph = 'title') => txt({ ph, x: m, y, w: w - m * 2, h: hh, html: '', style: { size: size2, align, valign: 'middle', role: 'title' } });
  const body = (x, y, ww, hh, ph = 'body', bullets = true) => txt({ ph, x, y, w: ww, h: hh, html: '', style: { size: 24, align: 'left', valign: 'top', role: 'body', bullets } });
  switch (layout) {
    case 'title':
      items.push(title(H * 0.3, H * 0.22, 'center', 60));
      items.push(txt({ ph: 'subtitle', x: m, y: H * 0.54, w: w - m * 2, h: H * 0.12, html: '', style: { size: 26, align: 'center', valign: 'top', role: 'subtitle' } }));
      break;
    case 'section':
      items.push(title(H * 0.38, H * 0.18, 'left', 54));
      items.push(txt({ ph: 'subtitle', x: m, y: H * 0.57, w: w - m * 2, h: H * 0.1, html: '', style: { size: 24, align: 'left', valign: 'top', role: 'subtitle' } }));
      items.push({ id: uid('it'), type: 'shape', shape: 'rect', x: m, y: H * 0.36, w: w * 0.12, h: 8, rot: 0, style: { fill: 'accent0', stroke: 'none' } });
      break;
    case 'content':
      items.push(title(H * 0.06, H * 0.16));
      items.push(body(m, H * 0.26, w - m * 2, H * 0.66));
      break;
    case 'two':
      items.push(title(H * 0.06, H * 0.16));
      items.push(body(m, H * 0.26, (w - m * 3) / 2, H * 0.66));
      items.push(body(m * 2 + (w - m * 3) / 2, H * 0.26, (w - m * 3) / 2, H * 0.66, 'body2'));
      break;
    case 'compare':
      items.push(title(H * 0.06, H * 0.14));
      items.push(txt({ ph: 'head1', x: m, y: H * 0.23, w: (w - m * 3) / 2, h: H * 0.08, html: '', style: { size: 26, bold: true, role: 'subtitle' } }));
      items.push(txt({ ph: 'head2', x: m * 2 + (w - m * 3) / 2, y: H * 0.23, w: (w - m * 3) / 2, h: H * 0.08, html: '', style: { size: 26, bold: true, role: 'subtitle' } }));
      items.push(body(m, H * 0.33, (w - m * 3) / 2, H * 0.58));
      items.push(body(m * 2 + (w - m * 3) / 2, H * 0.33, (w - m * 3) / 2, H * 0.58, 'body2'));
      break;
    case 'titleOnly':
      items.push(title(H * 0.06, H * 0.16));
      break;
    case 'quote':
      items.push(txt({ ph: 'quote', x: w * 0.12, y: H * 0.22, w: w * 0.76, h: H * 0.4, html: '', style: { size: 40, italic: true, align: 'center', valign: 'middle', role: 'title', font: 'heading' } }));
      items.push(txt({ ph: 'author', x: w * 0.12, y: H * 0.66, w: w * 0.76, h: H * 0.08, html: '', style: { size: 22, align: 'center', role: 'subtitle' } }));
      break;
    case 'big':
      items.push(txt({ ph: 'number', x: m, y: H * 0.18, w: w - m * 2, h: H * 0.4, html: '', style: { size: 160, bold: true, align: 'center', valign: 'middle', role: 'accent' } }));
      items.push(txt({ ph: 'subtitle', x: m, y: H * 0.62, w: w - m * 2, h: H * 0.12, html: '', style: { size: 30, align: 'center', role: 'subtitle' } }));
      break;
    case 'picture':
      items.push({ id: uid('it'), type: 'image', ph: 'picture', x: m, y: H * 0.08, w: w - m * 2, h: H * 0.66, rot: 0, asset: null, style: { fit: 'cover', radius: 12 } });
      items.push(txt({ ph: 'caption', x: m, y: H * 0.78, w: w - m * 2, h: H * 0.12, html: '', style: { size: 24, align: 'center', role: 'subtitle' } }));
      break;
    default: break;
  }
  return { id: uid('sl'), layout, items, notes: '', transition: { type: 'fade', duration: 0.5 }, hidden: false };
}

export const PROMPTS = {
  title: 'Click to add a title', subtitle: 'Click to add a subtitle', body: 'Click to add text', body2: 'Click to add text', head1: 'Heading', head2: 'Heading',
  quote: '“Click to add a quote”', author: '— Who said it', number: '99%', caption: 'Click to add a caption', picture: 'Drop a picture here',
};

export function newPresentation(themeId = 'snake', sizeId = 'wide') {
  const size = { ...SIZES[sizeId] };
  return { format: 'snakeslides', version: 1, size, sizeId, theme: themeId, slides: [makeSlide('title', size)], assets: {} };
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------
/** Resolve "accent0".."accent5", "title", "text" to colours of the theme. */
export function themeColor(theme, c, fallback = null) {
  if (!c) return fallback;
  const m = /^accent(\d)$/.exec(c);
  if (m) return theme.accents[Number(m[1])] || fallback;
  if (c === 'title') return theme.title;
  if (c === 'text') return theme.text;
  if (c === 'muted') return theme.muted;
  return c;
}

function textCss(theme, st = {}) {
  const role = st.role || 'body';
  const color = themeColor(theme, st.color) || (role === 'title' ? theme.title : role === 'subtitle' ? theme.muted : role === 'accent' ? theme.accents[0] : theme.text);
  const font = st.font === 'heading' || (!st.font && (role === 'title' || role === 'accent')) ? theme.heading : st.font === 'body' || !st.font ? theme.body : `"${st.font}", ${theme.body}`;
  return {
    color, fontFamily: font, fontSize: `${st.size || 24}px`, fontWeight: st.bold || role === 'accent' ? '700' : role === 'title' ? String(theme.titleWeight || 700) : '400',
    fontStyle: st.italic ? 'italic' : '', textDecoration: [st.underline ? 'underline' : '', st.strike ? 'line-through' : ''].filter(Boolean).join(' '),
    textAlign: st.align || 'left', lineHeight: String(st.lineHeight || (role === 'title' ? 1.12 : 1.3)), textTransform: role === 'title' && theme.upper ? 'uppercase' : '',
    letterSpacing: st.spacing ? `${st.spacing}px` : '', textShadow: st.textShadow ? '0 2px 8px rgba(0,0,0,.45)' : '',
  };
}

/**
 * The element for one item. opts.editing marks placeholders and keeps empty
 * ones visible; opts.assets resolves pictures.
 */
export function renderItem(item, theme, pres, opts = {}) {
  const st = item.style || {};
  const el = h('div.item', { dataset: { id: item.id, type: item.type } });
  Object.assign(el.style, {
    left: `${item.x}px`, top: `${item.y}px`, width: `${item.w}px`, height: `${item.h}px`,
    transform: `rotate(${item.rot || 0}deg)${item.flipH ? ' scaleX(-1)' : ''}${item.flipV ? ' scaleY(-1)' : ''}`, opacity: st.opacity !== undefined ? String(st.opacity) : '',
    filter: st.shadow ? 'drop-shadow(0 8px 18px rgba(0,0,0,.35))' : '',
  });
  if (item.type === 'shape' || item.type === 'text') {
    const fill = themeColor(theme, st.fill);
    const stroke = themeColor(theme, st.stroke);
    if (item.type === 'shape' || (fill && fill !== 'none') || (stroke && stroke !== 'none')) {
      const ns = 'http://www.w3.org/2000/svg';
      const svgEl = document.createElementNS(ns, 'svg');
      svgEl.setAttribute('class', 'shape-svg');
      svgEl.setAttribute('viewBox', `0 0 ${item.w} ${item.h}`);
      svgEl.setAttribute('preserveAspectRatio', 'none');
      if (st.gradient && fill && fill !== 'none') {
        const defs = document.createElementNS(ns, 'defs');
        const lg = document.createElementNS(ns, 'linearGradient');
        const gid = `g${item.id}`;
        lg.setAttribute('id', gid);
        lg.setAttribute('x1', '0'); lg.setAttribute('y1', '0'); lg.setAttribute('x2', '1'); lg.setAttribute('y2', '1');
        for (const [off, col] of [[0, fill], [1, themeColor(theme, st.gradient)]]) {
          const s = document.createElementNS(ns, 'stop');
          s.setAttribute('offset', String(off));
          s.setAttribute('stop-color', col);
          lg.append(s);
        }
        defs.append(lg);
        svgEl.append(defs);
      }
      const path = document.createElementNS(ns, 'path');
      const kind = item.type === 'text' ? (st.radius ? 'roundRect' : 'rect') : item.shape;
      path.setAttribute('d', shapePath(kind, item.w, item.h, st.radius ? Math.min(0.5, st.radius / Math.min(item.w, item.h)) : 0.12));
      path.setAttribute('fill', st.gradient && fill && fill !== 'none' ? `url(#g${item.id})` : fill && fill !== 'none' ? fill : item.type === 'shape' && !st.fill ? theme.accents[0] : 'none');
      if (st.fillOpacity !== undefined) path.setAttribute('fill-opacity', String(st.fillOpacity));
      if (stroke && stroke !== 'none') {
        path.setAttribute('stroke', stroke);
        path.setAttribute('stroke-width', String(st.strokeWidth || 2));
        path.setAttribute('vector-effect', 'non-scaling-stroke');
        if (st.dash) path.setAttribute('stroke-dasharray', st.dash === 'dot' ? '2 4' : '10 6');
      }
      if (item.shape === 'ring') path.setAttribute('fill-rule', 'evenodd');
      svgEl.append(path);
      el.append(svgEl);
    }
  }
  if (item.type === 'line') {
    const ns = 'http://www.w3.org/2000/svg';
    const svgEl = document.createElementNS(ns, 'svg');
    svgEl.setAttribute('class', 'shape-svg');
    svgEl.setAttribute('viewBox', `0 0 ${Math.max(1, item.w)} ${Math.max(1, item.h)}`);
    svgEl.setAttribute('preserveAspectRatio', 'none');
    svgEl.setAttribute('overflow', 'visible');
    const color = themeColor(theme, st.stroke) || theme.text;
    const sw = st.strokeWidth || 4;
    const line = document.createElementNS(ns, 'line');
    const [x1, y1, x2, y2] = item.dir === 'up' ? [0, item.h, item.w, 0] : [0, 0, item.w, item.h];
    line.setAttribute('x1', x1); line.setAttribute('y1', y1); line.setAttribute('x2', x2); line.setAttribute('y2', y2);
    line.setAttribute('stroke', color);
    line.setAttribute('stroke-width', sw);
    line.setAttribute('stroke-linecap', 'round');
    if (st.dash) line.setAttribute('stroke-dasharray', st.dash === 'dot' ? '1 8' : '14 10');
    svgEl.append(line);
    if (st.arrow) {
      const ang = Math.atan2(y2 - y1, x2 - x1);
      const a = sw * 4;
      const head = document.createElementNS(ns, 'path');
      head.setAttribute('d', `M${x2},${y2} L${x2 - a * Math.cos(ang - 0.45)},${y2 - a * Math.sin(ang - 0.45)} L${x2 - a * Math.cos(ang + 0.45)},${y2 - a * Math.sin(ang + 0.45)} Z`);
      head.setAttribute('fill', color);
      svgEl.append(head);
    }
    el.append(svgEl);
  }
  if (item.type === 'text' || (item.type === 'shape' && (item.html || opts.editing))) {
    const pad = st.padding !== undefined ? st.padding : item.type === 'shape' ? 16 : 8;
    const body = h('div.item-text', { style: { padding: `${pad}px`, justifyContent: st.valign === 'middle' ? 'center' : st.valign === 'bottom' ? 'flex-end' : 'flex-start' } });
    const inner = h(`div.text-inner${st.bullets ? '.bullets' : ''}${st.numbered ? '.numbered' : ''}`);
    Object.assign(inner.style, textCss(theme, { ...st, role: st.role || (item.type === 'shape' ? 'shape' : 'body') }));
    if (item.type === 'shape' && !st.color) inner.style.color = '#ffffff';
    if (st.columns > 1) { inner.style.columnCount = String(st.columns); inner.style.columnGap = '32px'; }
    inner.innerHTML = item.html || '';
    if (!item.html && opts.editing && item.ph) {
      inner.dataset.prompt = PROMPTS[item.ph] || 'Click to add text';
      inner.classList.add('empty');
    }
    if (st.autofit !== false && item.type === 'text' && opts.fit !== false) inner.dataset.autofit = '1';
    body.append(inner);
    el.append(body);
  }
  if (item.type === 'image') {
    const src = item.asset && pres.assets[item.asset];
    if (src) {
      const img = h('img.item-img', { src, alt: item.alt || '', draggable: 'false' });
      Object.assign(img.style, { objectFit: st.fit || 'cover', borderRadius: st.radius ? `${st.radius}px` : '', border: st.border ? `${st.borderWidth || 4}px solid ${themeColor(theme, st.border)}` : '', objectPosition: st.focus || 'center' });
      if (st.filter) img.style.filter = st.filter;
      el.append(img);
    } else if (opts.editing) {
      el.append(h('div.img-placeholder', h('div', PROMPTS.picture), h('div.muted', 'or double-click to choose one')));
    }
  }
  if (item.type === 'chart') {
    const canvas = h('canvas.item-chart');
    el.append(canvas);
    el.chartDraw = (scale = 1) => drawChart(canvas, { ...item.chart, theme: isDarkBg(theme, item) ? 'dark' : 'light', background: 'transparent', font: theme.body }, { width: item.w, height: item.h, dpr: (window.devicePixelRatio || 1) * scale });
  }
  if (item.type === 'table') {
    const table = h('table.item-table');
    const head = themeColor(theme, st.header || 'accent0');
    (item.rows || []).forEach((row, r) => {
      const tr = h('tr');
      row.forEach((cell) => {
        const td = h(r === 0 && st.headerRow !== false ? 'th' : 'td');
        td.innerHTML = cell.html || '';
        tr.append(td);
      });
      table.append(tr);
    });
    Object.assign(table.style, { fontFamily: theme.body, fontSize: `${st.size || 20}px`, color: themeColor(theme, st.color) || theme.text });
    table.style.setProperty('--head', head);
    table.style.setProperty('--line', st.line || 'rgba(128,128,128,.35)');
    if (st.striped) table.classList.add('striped');
    el.append(table);
  }
  if (item.link) el.dataset.link = item.link;
  return el;
}

function isDarkBg(theme, item) {
  const bg = (item.style && item.style.fill) || theme.bg;
  const m = /#([0-9a-f]{6})/i.exec(bg);
  if (!m) return false;
  const n = parseInt(m[1], 16);
  return 0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255) < 140;
}

/** Background of a slide as CSS. */
export function slideBackground(slide, theme, pres) {
  const bg = slide.bg;
  if (!bg) return theme.bg;
  if (bg.image && pres.assets[bg.image]) return `${bg.overlay ? `linear-gradient(rgba(0,0,0,${bg.overlay}), rgba(0,0,0,${bg.overlay})), ` : ''}url("${pres.assets[bg.image]}") center / cover no-repeat`;
  if (bg.gradient) return `linear-gradient(${bg.angle || 135}deg, ${bg.color}, ${bg.gradient})`;
  return bg.color || theme.bg;
}

/** A whole slide as an element at its real size (scale it with CSS). */
export function renderSlide(slide, pres, opts = {}) {
  const theme = THEMES[pres.theme] || THEMES.snake;
  const el = h('div.slide', { dataset: { id: slide.id } });
  Object.assign(el.style, { width: `${pres.size.w}px`, height: `${pres.size.h}px`, background: slideBackground(slide, theme, pres) });
  if (theme.bar && !slide.bg && slide.layout !== 'blank') el.append(h('div.theme-bar', { style: { background: theme.bar } }));
  for (const item of slide.items) {
    if (opts.hideItems && opts.hideItems.has(item.id)) continue;
    el.append(renderItem(item, theme, pres, opts));
  }
  if (opts.number && pres.showNumbers) el.append(h('div.slide-number', { style: { color: theme.muted, fontFamily: theme.body } }, String(opts.number)));
  return el;
}

/** After an element is in the page: draw charts and shrink text that overflows. */
export function settle(root, scale = 1) {
  for (const el of root.querySelectorAll('.item')) {
    if (el.chartDraw) el.chartDraw(scale);
  }
  for (const inner of root.querySelectorAll('.text-inner[data-autofit]')) {
    const box = inner.parentElement;
    inner.style.zoom = '';
    let z = 1;
    let guard = 0;
    while (inner.scrollHeight * z > box.clientHeight - 2 && z > 0.35 && guard++ < 30) {
      z -= 0.05;
      inner.style.zoom = String(z);
    }
  }
}

export function textOf(html) {
  const d = document.createElement('div');
  d.innerHTML = html || '';
  return d.textContent || '';
}

export function htmlFromText(text) {
  return text.split('\n').map((l) => `<p>${escapeHtml(l) || '<br>'}</p>`).join('');
}
