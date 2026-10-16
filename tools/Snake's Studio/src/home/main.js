// Snake's Studio home: every Studio app in one window (and the front page of the
// online mirror).
import { h } from '../kit/dom.js';
import { createShell } from '../kit/shell.js';
import { host, inElectron, inPhoneApp } from '../kit/host.js';
import { contextMenu } from '../kit/menu.js';
import { toast } from '../kit/dialogs.js';
import { item } from '../kit/commands.js';

const APPS = [
  ['word', "Snake's Word", 'Documents, letters and reports', 'Office'],
  ['sheets', "Snake's Spreadsheets", 'Numbers, formulas and charts', 'Office'],
  ['slides', "Snake's Slides", 'Presentations with a presenter view', 'Office'],
  ['paint', "Snake's Paint", 'Quick drawings and pixel art', 'Create'],
  ['photo', "Snake's Photo", 'Layers, selections and adjustments', 'Create'],
  ['movie', "Snake's Movie Maker", 'Cut, title and export videos', 'Create'],
  ['player', "Snake's Player", 'Plays almost any video or song', 'Media'],
];

const shell = await createShell({
  id: 'studio', name: "Snake's Studio",
  menus: [
    { label: '&File', items: () => APPS.map(([id, name]) => ({ label: `Open ${name}`, run: () => launch(id) })) },
    { label: '&View', items: () => [item('view.themeDark'), item('view.themeLight'), item('view.themeSystem'), { type: 'separator' }, item('view.fullscreen')] },
    { label: '&Help', items: () => [item('app.palette'), item('app.shortcuts'), item('app.about')] },
  ],
});
shell.showStatus(true);
shell.statusLeft.append(h('span.item', inElectron || inPhoneApp ? 'Sandboxed · files only open when you choose them' : 'Running in your browser'));
const DOWNLOAD = 'https://github.com/EkansEater/snakes-suite/releases/latest';

function launch(id) {
  if (inElectron || inPhoneApp) {
    host.launch(id).then(() => toast(`Opening ${APPS.find((a) => a[0] === id)[1]}…`, { timeout: 2000 }));
  } else location.href = `../${id}/index.html`;
}

const groups = ['Office', 'Create', 'Media'];
const page = h('div.home',
  h('div.hero', h('img', { src: '../icons/studio.svg', alt: '' }),
    h('div', h('h1', "Snake's Studio"), h('p', 'Office, creative and media apps. Part of Snake’s Master Suite.'),
      inElectron || inPhoneApp ? null : h('p.web-note', 'Your files stay on your computer: nothing you open here is uploaded. ',
        h('a', { href: DOWNLOAD, target: '_blank', rel: 'noopener noreferrer' }, 'Get the desktop apps'),
        ' for Windows, macOS and Linux (they also play and export many more video formats).'))),
  ...groups.map((g) => h('section',
    h('h2', g),
    h('div.grid', ...APPS.filter((a) => a[3] === g).map(([id, name, tag]) => {
      const tile = h('button.tile', { 'data-tip': `Open ${name}` },
        h('img', { src: `../icons/${id}.svg`, alt: '' }),
        h('div.name', name.replace("Snake's ", '')),
        h('div.tag', tag));
      tile.addEventListener('click', () => launch(id));
      contextMenu(tile, () => [{ label: `Open ${name}`, icon: 'open', run: () => launch(id) }]);
      return tile;
    })))));
shell.main.append(page);
