// The command palette: every command, plus connecting to devices and opening profiles.
import { el, fuzzy } from './util.js';
import { COMMAND_TITLES, run } from './commands.js';
import { keyLabel } from './keys.js';
import { settings, hostLabel } from './settings.js';
import { newTab } from './layout.js';
import { connect } from './devices.js';
import { env } from './env.js';

let box = null;

export function openPalette(prefix = '') {
  if (box) { close(); return; }
  const input = el('input.input.palette-input', { placeholder: 'Type a command, a device or a profile', spellcheck: 'false', value: prefix });
  const list = el('div.palette-list');
  box = el('div.palette-back', {}, el('div.palette', {}, input, list));
  let items = [];
  let index = 0;
  const all = () => [
    ...Object.entries(COMMAND_TITLES).map(([id, title]) => ({ title, key: keyLabel(id), run: () => run(id) })),
    ...settings.hosts.map((h) => ({ title: `Connect: ${hostLabel(h)}`, detail: h.host, run: () => connect(h) })),
    ...settings.profiles.map((p) => ({ title: `New tab: ${p.name}`, detail: 'profile', run: () => newTab({ profileId: p.id }) })),
    ...env.shells.map((s) => ({ title: `New tab: ${s.name}`, detail: s.file, run: () => newTab({ command: [s.file, ...s.args], title: s.name }) })),
  ];
  const draw = () => {
    const q = input.value.trim();
    items = all().map((it) => ({ ...it, score: fuzzy(q, it.title + ' ' + (it.detail || '')) })).filter((it) => it.score >= 0);
    if (q) items.sort((a, b) => b.score - a.score);
    items = items.slice(0, 60);
    index = Math.min(index, Math.max(0, items.length - 1));
    list.replaceChildren(...items.map((it, i) => el(`div.palette-item${i === index ? '.active' : ''}`, {
      on: { click: () => choose(i), mousemove: () => { if (index !== i) { index = i; draw(); } } },
    }, el('span.palette-title', { text: it.title }), it.detail ? el('span.palette-detail', { text: it.detail }) : '', it.key ? el('span.palette-key', { text: it.key }) : '')));
    list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  };
  const choose = (i) => { const it = items[i]; close(); it?.run(); };
  input.addEventListener('input', () => { index = 0; draw(); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') { index = Math.min(items.length - 1, index + 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { index = Math.max(0, index - 1); draw(); e.preventDefault(); }
    else if (e.key === 'Enter') { choose(index); e.preventDefault(); }
    else if (e.key === 'Escape') { close(); e.preventDefault(); }
    e.stopPropagation();
  });
  box.addEventListener('mousedown', (e) => { if (e.target === box) close(); });
  document.body.append(box);
  draw();
  input.focus();
}

function close() {
  box?.remove();
  box = null;
  run('focus');
}
