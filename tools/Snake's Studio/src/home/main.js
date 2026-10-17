// The home page. On the website and in the iPhone app it is Snake's Master Suite: every
// Snake app, opening in place where it runs here, otherwise saying where it does. On
// the desktop it is the Studio's own window (the hub, Snake's Master Suite, lists the rest).
import { h } from '../kit/dom.js';
import { createShell } from '../kit/shell.js';
import { host, inElectron, inPhoneApp, platform } from '../kit/host.js';
import { contextMenu } from '../kit/menu.js';
import { toast, modal } from '../kit/dialogs.js';
import { item } from '../kit/commands.js';

const EVERYWHERE = 'Windows, macOS, Linux and Android';

// kind: 'studio' runs here everywhere; 'web' has a version for the browser and the iPhone
// (native apps on the desktop and Android); 'native' only on the systems in `where`.
const SUITE = [
  { id: 'word', name: "Snake's Word", tag: 'Documents, letters and reports', group: 'Office', kind: 'studio' },
  { id: 'sheets', name: "Snake's Spreadsheets", tag: 'Numbers, formulas and charts', group: 'Office', kind: 'studio' },
  { id: 'slides', name: "Snake's Slides", tag: 'Presentations with a presenter view', group: 'Office', kind: 'studio' },
  { id: 'paint', name: "Snake's Paint", tag: 'Quick drawings and pixel art', group: 'Create', kind: 'studio' },
  { id: 'photo', name: "Snake's Photo", tag: 'Layers, selections and adjustments', group: 'Create', kind: 'studio' },
  { id: 'movie', name: "Snake's Movie Maker", tag: 'Cut, title and export videos', group: 'Create', kind: 'studio' },
  { id: 'code', name: "Snake's Code", tag: 'Code editor', group: 'Create', kind: 'native', where: EVERYWHERE },
  { id: 'player', name: "Snake's Player", tag: 'Plays almost any video or song', group: 'Media', kind: 'studio' },
  { id: 'soundpad', name: "Snake's SoundPad", tag: 'A soundboard: one tap per sound', group: 'Media', kind: 'web', where: EVERYWHERE },
  { id: 'screen', name: "Snake's Screen Recorder", tag: 'Screen to video or GIF, sound to audio', group: 'Media', kind: 'web', where: EVERYWHERE },
  { id: 'daw', name: "Snake's DAW", tag: 'Amp, effects, looper and recording', group: 'Media', kind: 'native', where: EVERYWHERE },
  { id: 'mp3', name: "Snake's MP3 Converter", tag: 'Video links to tagged MP3s', group: 'Media', kind: 'native', where: EVERYWHERE,
    why: 'It downloads from video sites, which a web page is not allowed to do.' },
  { id: 'converter', name: "Snake's Converter", tag: 'Audio, video, pictures, documents', group: 'Tools', kind: 'web', where: EVERYWHERE },
  { id: 'compressor', name: "Snake's Compressor", tag: 'Lossless .snake archives', group: 'Tools', kind: 'native', where: EVERYWHERE },
  { id: 'recompiler', name: "Snake's Recompiler", tag: 'Your N64 games as native programs', group: 'Tools', kind: 'native', where: 'Linux',
    why: 'It builds programs on your computer.' },
];

// On the desktop this is the Studio's window; everywhere else, the whole suite.
const asSuite = !inElectron;
const runsHere = (a) => a.kind === 'studio' || (asSuite && a.kind === 'web');
const shown = asSuite ? SUITE : SUITE.filter((a) => a.kind === 'studio');
const title = asSuite ? "Snake's Master Suite" : "Snake's Studio";

const shell = await createShell({
  id: asSuite ? 'suite' : 'studio', name: title,
  menus: [
    { label: '&File', items: () => shown.filter(runsHere).map((a) => ({ label: `Open ${a.name}`, run: () => launch(a) })) },
    { label: '&View', items: () => [item('view.themeDark'), item('view.themeLight'), item('view.themeSystem'), { type: 'separator' }, item('view.fullscreen')] },
    { label: '&Help', items: () => [item('app.palette'), item('app.shortcuts'), item('app.about')] },
  ],
});
shell.showStatus(true);
shell.statusLeft.append(h('span.item', inElectron || inPhoneApp ? 'Sandboxed · files only open when you choose them' : 'Running in your browser'));
const DOWNLOAD = 'https://github.com/EkansEater/snakes-suite/releases/latest';

function launch(a) {
  if (!runsHere(a)) { aboutApp(a); return; }
  if (inElectron || inPhoneApp) {
    host.launch(a.id).then(() => toast(`Opening ${a.name}…`, { timeout: 2000 }));
  } else location.href = `../${a.id}/index.html`;
}

/** An app that does not run here: what it is, where it runs, how to get it. */
function aboutApp(a) {
  const body = h('div.col', { style: { gap: '10px', maxWidth: '420px' } },
    h('div.row', { style: { gap: '14px' } }, h('img', { src: `../icons/${a.id}.svg`, alt: '', style: { width: '56px', height: '56px' } }),
      h('div', h('b', a.tag), h('div.muted', `Runs on ${a.where}.`))),
    a.why ? h('div.muted', a.why) : null,
    h('div', platform === 'ios'
      ? 'It is not on iPhone yet. On a computer or an Android phone, Snake’s Master Suite installs it.'
      : 'Snake’s Master Suite installs it on your computer or Android phone, with the other apps.'));
  modal({
    title: a.name, body,
    buttons: [
      { label: 'Close', value: null },
      { label: 'Get Snake’s Master Suite', value: 'get', primary: true, run: () => { host.openExternal(DOWNLOAD); } },
    ],
  });
}

const groups = ['Office', 'Create', 'Media', 'Tools'];
const page = h('div.home',
  h('div.hero', h('img', { src: `../icons/${asSuite ? 'suite' : 'studio'}.svg`, alt: '' }),
    h('div', h('h1', title),
      h('p', asSuite ? 'Every Snake app in one place: office, creative, media and tools.' : 'Office, creative and media apps. Part of Snake’s Master Suite.'),
      inElectron || inPhoneApp ? null : h('p.web-note', 'Your files stay on your device: nothing you open here is uploaded. ',
        h('a', { href: DOWNLOAD, target: '_blank', rel: 'noopener noreferrer' }, 'Get the apps'),
        ' for Windows, macOS, Linux and Android (they do more: every video format, voice chat, downloads).'))),
  ...groups.map((g) => {
    const apps = shown.filter((a) => a.group === g);
    if (!apps.length) return null;
    return h('section',
      h('h2', g),
      h('div.grid', ...apps.map((a) => {
        const here = runsHere(a);
        const tile = h(`button.tile${here ? '' : '.elsewhere'}`, { 'data-tip': here ? `Open ${a.name}` : `${a.name}: ${a.where}` },
          h('img', { src: `../icons/${a.id}.svg`, alt: '' }),
          h('div.name', a.name.replace("Snake's ", '')),
          h('div.tag', a.tag),
          here ? null : h('div.where', a.where === EVERYWHERE ? 'Desktop and Android' : a.where));
        tile.addEventListener('click', () => launch(a));
        contextMenu(tile, () => [{ label: here ? `Open ${a.name}` : `About ${a.name}`, icon: here ? 'open' : 'info', run: () => launch(a) }]);
        return tile;
      })));
  }).filter(Boolean));
shell.main.append(page);
