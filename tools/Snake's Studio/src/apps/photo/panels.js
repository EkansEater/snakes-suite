// The side panels of Snake's Photo: navigator and histogram, layers, history.
import { h, clamp } from '../../kit/dom.js';
import { icon } from '../../kit/icons.js';
import { showMenu, contextMenu } from '../../kit/menu.js';
import { select } from '../../kit/shell.js';
import { makeCanvas } from '../../kit/raster.js';
import { BLENDS } from './doc.js';
import { ADJUSTMENTS } from './adjust.js';
import * as D from './dialogs.js';

export function buildPanels(A, side) {
  // ---- Navigator and histogram (tabs) ----
  const navCanvas = h('canvas.ph-nav');
  const histCanvas = h('canvas.ph-hist');
  const tabsHead = h('div.ph-tabs');
  const tabBody = h('div.ph-tabbody');
  let tab = A.settings.get('topTab', 'navigator');
  const showTab = (t) => {
    tab = t;
    A.settings.set('topTab', t);
    for (const b of tabsHead.children) b.classList.toggle('on', b.dataset.tab === t);
    tabBody.replaceChildren(t === 'navigator' ? navCanvas : histCanvas);
    drawTop();
  };
  for (const [t, label] of [['navigator', 'Navigator'], ['histogram', 'Histogram']]) {
    const b = h('button', { dataset: { tab: t } }, label);
    b.addEventListener('click', () => showTab(t));
    tabsHead.append(b);
  }
  const top = h('div.ph-section', tabsHead, tabBody);

  const navGeom = () => {
    const doc = A.doc;
    const W = navCanvas.clientWidth || 260;
    const H = 160;
    const s = Math.min((W - 8) / doc.width, (H - 8) / doc.height);
    return { W, H, s, ox: (W - doc.width * s) / 2, oy: (H - doc.height * s) / 2 };
  };

  function drawNavigator() {
    const doc = A.doc;
    if (!doc) return;
    const { W, H, s, ox, oy } = navGeom();
    const dpr = window.devicePixelRatio || 1;
    navCanvas.width = W * dpr;
    navCanvas.height = H * dpr;
    navCanvas.style.height = `${H}px`;
    const ctx = navCanvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    ctx.imageSmoothingQuality = 'high';
    ctx.fillStyle = '#fff';
    ctx.fillRect(ox, oy, doc.width * s, doc.height * s);
    ctx.drawImage(A.composite(), ox, oy, doc.width * s, doc.height * s);
    // The part of the picture in view.
    const r = A.vp.el.getBoundingClientRect();
    const a = A.vp.toImage({ clientX: r.left, clientY: r.top });
    const b = A.vp.toImage({ clientX: r.right, clientY: r.bottom });
    const x0 = clamp(a.x, 0, doc.width); const y0 = clamp(a.y, 0, doc.height);
    const x1 = clamp(b.x, 0, doc.width); const y1 = clamp(b.y, 0, doc.height);
    if (x1 - x0 < doc.width - 1 || y1 - y0 < doc.height - 1) {
      ctx.strokeStyle = '#e5534b';
      ctx.lineWidth = 2;
      ctx.strokeRect(ox + x0 * s, oy + y0 * s, (x1 - x0) * s, (y1 - y0) * s);
    }
  }

  navCanvas.addEventListener('pointerdown', (e) => {
    if (!A.doc) return;
    const go = (ev) => {
      const { s, ox, oy } = navGeom();
      const r = navCanvas.getBoundingClientRect();
      const px = (ev.clientX - r.left - ox) / s;
      const py = (ev.clientY - r.top - oy) / s;
      // Put that point in the middle of the view.
      const vr = A.vp.el.getBoundingClientRect();
      const c = A.vp.toImage({ clientX: vr.left + vr.width / 2, clientY: vr.top + vr.height / 2 });
      A.vp.scroller.scrollLeft += (px - c.x) * A.vp.zoom;
      A.vp.scroller.scrollTop += (py - c.y) * A.vp.zoom;
      drawNavigator();
    };
    go(e);
    navCanvas.setPointerCapture(e.pointerId);
    const mv = (ev) => go(ev);
    const up = () => { navCanvas.removeEventListener('pointermove', mv); navCanvas.removeEventListener('pointerup', up); };
    navCanvas.addEventListener('pointermove', mv);
    navCanvas.addEventListener('pointerup', up);
  });
  navCanvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    A.vp.zoomStep(e.deltaY < 0 ? 1 : -1);
  }, { passive: false });

  function drawHistogram() {
    if (!A.doc) return;
    const W = histCanvas.clientWidth || 260;
    const H = 140;
    const dpr = window.devicePixelRatio || 1;
    histCanvas.width = W * dpr;
    histCanvas.height = H * dpr;
    histCanvas.style.height = `${H}px`;
    const ctx = histCanvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    D.drawHistogram(ctx, W, H, D.histogramOf(A.composite()));
  }

  function drawTop() { if (tab === 'navigator') drawNavigator(); else drawHistogram(); }

  // ---- Layers ----
  const blendSel = select({ options: BLENDS.map(([v, l]) => ({ value: v, label: l })), value: 'normal', tip: 'How this layer mixes with the ones below',
    onChange: (v) => { const L = A.active(); if (L) A.setLayerProps(L, { blend: v }, 'Blend mode'); } });
  const opRange = h('input', { type: 'range', min: 0, max: 100, value: 100, 'data-tip': 'Layer opacity', style: { flex: '1', minWidth: '60px' } });
  const opNum = h('input.input.num', { value: '100', style: { width: '48px' } });
  const setOpacity = (v) => { const L = A.active(); if (L) A.setLayerProps(L, { opacity: clamp(v, 0, 100) / 100 }, 'Layer opacity', `op:${L.id}`); };
  opRange.addEventListener('input', () => { opNum.value = opRange.value; setOpacity(Number(opRange.value)); });
  opNum.addEventListener('change', () => setOpacity(Number(opNum.value) || 0));
  const lockAll = h('button.tb', { 'data-tip': 'Lock the layer', html: icon('lock', 15) });
  const lockAlpha = h('button.tb', { 'data-tip': 'Keep see-through areas see-through (paint only on what is there)', html: icon('grid', 15) });
  lockAll.addEventListener('click', () => { const L = A.active(); if (L) A.setLayerProps(L, { locked: !L.locked }, L.locked ? 'Unlock layer' : 'Lock layer'); });
  lockAlpha.addEventListener('click', () => { const L = A.active(); if (L) A.setLayerProps(L, { lockAlpha: !L.lockAlpha }, 'Lock transparency'); });
  const list = h('div.ph-layers', { tabindex: 0 });
  const foot = h('div.ph-foot',
    footBtn('plus', 'New layer', () => A.runCommand('layer.new')),
    footBtn('sliders', 'New adjustment layer', (b) => showMenu(Object.entries(ADJUSTMENTS).map(([k, a]) => ({ label: a.label, run: () => A.addAdjustmentLayer(k) })), { anchor: b })),
    footBtn('mask', 'Add a mask (from the selection if there is one)', () => A.addMask(A.sel ? 'selection' : 'all')),
    footBtn('star', 'Layer effects', () => A.runCommand('layer.effects')),
    footBtn('duplicate', 'Duplicate layer', () => A.runCommand('layer.duplicate')),
    footBtn('trash', 'Delete layer', () => A.deleteLayer()));
  const layersSection = h('div.ph-section.grow',
    h('div.ph-head', 'Layers'),
    h('div.ph-row', blendSel, h('span.grow')),
    h('div.ph-row', h('span.muted', 'Opacity'), opRange, opNum, lockAll, lockAlpha),
    list, foot);

  function footBtn(ic, tip, run) {
    const b = h('button.tb', { 'data-tip': tip, html: icon(ic, 15) });
    b.addEventListener('click', () => run(b));
    return b;
  }

  const thumbs = new Map(); // id -> { key, layer, mask }
  function thumbFor(L, which) {
    let t = thumbs.get(L.id);
    const key = `${L.rev}:${A.doc.width}x${A.doc.height}:${L.x},${L.y}`;
    if (!t || t.key !== key) { t = { key }; thumbs.set(L.id, t); }
    if (!t[which]) t[which] = A.thumbOf(L, which);
    // A fresh copy for the DOM (a canvas can only sit in one place).
    const c = makeCanvas(t[which].width, t[which].height);
    c.getContext('2d').drawImage(t[which], 0, 0);
    return c;
  }

  let dragRow = null;
  function renderLayers() {
    const doc = A.doc;
    if (!doc) { list.replaceChildren(); return; }
    const act = A.active();
    blendSel.value = act ? act.blend : 'normal';
    blendSel.disabled = !act;
    const op = act ? Math.round(act.opacity * 100) : 100;
    if (document.activeElement !== opNum) opNum.value = String(op);
    opRange.value = String(op);
    lockAll.classList.toggle('on', !!(act && act.locked));
    lockAlpha.classList.toggle('on', !!(act && act.lockAlpha));
    const rows = [];
    for (let i = doc.layers.length - 1; i >= 0; i--) {
      const L = doc.layers[i];
      const eye = h('button.ph-eye', { 'data-tip': L.visible ? 'Hide' : 'Show', html: icon(L.visible ? 'eye' : 'eyeOff', 15) });
      eye.addEventListener('click', (e) => {
        e.stopPropagation();
        if (e.altKey) {
          // Alt+click: show only this layer (or everything again).
          const solo = doc.layers.every((x) => x === L || !x.visible);
          A.structural(solo ? 'Show all layers' : 'Show only this layer', () => { for (const x of doc.layers) x.visible = solo ? true : x === L; });
        } else A.setLayerProps(L, { visible: !L.visible }, L.visible ? 'Hide layer' : 'Show layer');
      });
      let thumb;
      if (L.kind === 'adjust') thumb = h('div.ph-thumb.special', { html: icon('sliders', 18) });
      else if (L.kind === 'text') thumb = h('div.ph-thumb.special', { html: icon('text', 18) });
      else thumb = h('div.ph-thumb', thumbFor(L, 'layer'));
      thumb.classList.toggle('editing', !!L.mask && !L.editMask && L === act && L.kind !== 'adjust');
      thumb.addEventListener('click', (e) => {
        if (e.ctrlKey || e.metaKey) { e.stopPropagation(); A.selectionFromLayer(L, e.shiftKey ? 'add' : e.altKey ? 'subtract' : 'replace'); return; }
        if (L.editMask) { L.editMask = false; A.buildOptions(); }
      });
      const parts = [eye, thumb];
      if (L.mask) {
        const m = h('div.ph-thumb.mask', thumbFor(L, 'mask'));
        m.classList.toggle('editing', !!(L.editMask || L.kind === 'adjust') && L === act);
        m.classList.toggle('off', !L.maskOn);
        m.dataset.tip = 'Mask: click to paint on it, Shift+click to turn it off or on';
        m.addEventListener('click', (e) => {
          if (e.shiftKey) { e.stopPropagation(); A.setLayerProps(L, { maskOn: !L.maskOn }, L.maskOn ? 'Disable mask' : 'Enable mask'); return; }
          L.editMask = true;
          A.buildOptions();
        });
        parts.push(m);
      }
      const name = h('span.ph-name', L.name);
      name.addEventListener('dblclick', (e) => { e.stopPropagation(); rename(L, name); });
      parts.push(name);
      if (L.effects && Object.values(L.effects).some((x) => x && x.on)) {
        const fx = h('button.ph-badge', { 'data-tip': 'Layer effects' }, 'fx');
        fx.addEventListener('click', (e) => { e.stopPropagation(); A.selectLayer(L.id); D.effectsDialog(A, L); });
        parts.push(fx);
      }
      if (L.locked) parts.push(h('span.ph-lock', { html: icon('lock', 12) }));
      const row = h(`div.ph-layer${L === act ? '.on' : ''}${L.visible ? '' : '.hidden-layer'}`, { dataset: { id: L.id } }, ...parts);
      row.addEventListener('click', () => A.selectLayer(L.id));
      row.addEventListener('dblclick', (e) => {
        if (e.target.closest('.ph-name, .ph-eye')) return;
        if (L.kind === 'adjust') D.adjustDialog(A, L.adjust.kind, { layer: L });
        else if (L.kind === 'text') { A.runCommand('tool.text'); }
        else D.effectsDialog(A, L);
      });
      contextMenu(row, () => A.layerMenu(L));
      row.addEventListener('pointerdown', (e) => startDrag(e, row, L));
      rows.push(row);
    }
    list.replaceChildren(...rows);
  }

  function rename(L, nameEl) {
    const input = h('input.input', { value: L.name, style: { width: '100%' } });
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      const v = input.value.trim();
      if (ok && v && v !== L.name) A.setLayerProps(L, { name: v.slice(0, 200) }, 'Rename layer'); else renderLayers();
    };
    input.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); });
    input.addEventListener('blur', () => finish(true));
  }

  // Drag a row up or down to change the order.
  function startDrag(e, row, L) {
    if (e.button !== 0 || e.target.closest('button, input')) return;
    const y0 = e.clientY;
    let moved = false;
    let target = null;
    const mv = (ev) => {
      if (!moved && Math.abs(ev.clientY - y0) < 5) return;
      moved = true;
      row.classList.add('dragging');
      for (const r of list.children) r.classList.remove('drop-before', 'drop-after');
      const over = document.elementFromPoint(ev.clientX, ev.clientY);
      const r = over && over.closest('.ph-layer');
      if (!r || r === row) { target = null; return; }
      const rect = r.getBoundingClientRect();
      const before = ev.clientY < rect.top + rect.height / 2;
      r.classList.add(before ? 'drop-before' : 'drop-after');
      target = { id: r.dataset.id, before };
    };
    const up = () => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
      row.classList.remove('dragging');
      for (const r of list.children) r.classList.remove('drop-before', 'drop-after');
      if (!moved || !target) return;
      const doc = A.doc;
      const other = doc.layer(target.id);
      // Rows are shown top first: "before" a row means above it.
      let j = doc.layers.indexOf(other) + (target.before ? 1 : 0);
      if (doc.layers.indexOf(L) < j) j--;
      A.moveLayerTo(L, j);
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  }

  // ---- History ----
  const histList = h('div.ph-history');
  const histSection = h('div.ph-section.ph-hist-section', h('div.ph-head', 'History'), histList);
  function renderHistory() {
    const hst = A.history;
    const rows = [];
    const mk = (label, index, state) => {
      const r = h(`div.ph-hrow${state === 'now' ? '.on' : state === 'undone' ? '.undone' : ''}`, label);
      r.addEventListener('click', () => A.jumpHistory(index));
      return r;
    };
    rows.push(mk('Opened', -1, hst.done.length === 0 ? 'now' : 'done'));
    hst.done.forEach((s, i) => rows.push(mk(s.label, i, i === hst.done.length - 1 ? 'now' : 'done')));
    [...hst.undone].reverse().forEach((s, k) => rows.push(mk(s.label, hst.done.length + k, 'undone')));
    histList.replaceChildren(...rows);
    const on = histList.querySelector('.on');
    if (on) on.scrollIntoView({ block: 'nearest' });
  }

  side.append(top, layersSection, histSection);
  showTab(tab);

  let timer = 0;
  return {
    layers: renderLayers,
    history: renderHistory,
    navigator: () => { if (tab === 'navigator') drawNavigator(); },
    soon() { clearTimeout(timer); timer = setTimeout(() => { drawTop(); renderLayers(); }, 250); },
  };
}
