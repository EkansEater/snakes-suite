// Which program is this process?
//
// On the desktop, Snake's Code and Snake's Terminal ship inside the Studio package, so one
// Electron serves every web-stack app of the suite (one download instead of three). The
// release build (packaging/build.py) copies each of them into hosted/<id>/ with its own
// main process, pages and package.json. `--app=code` and `--app=terminal` start that main
// process as it is, with the name, window class and settings folder it has on its own;
// everything else is a Studio app (main.js).
'use strict';

const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const HOSTED = {
  code: { name: "Snake's Code", windowClass: 'snakes-code' },
  terminal: { name: "Snake's Terminal", windowClass: 'snakes-terminal' },
};

const id = (process.argv.find((a) => a.startsWith('--app=')) || '').slice(6);
const hosted = Object.hasOwn(HOSTED, id) ? HOSTED[id] : null;

// The Wayland app id names the taskbar entry and finds its icon: it has to be the app's own
// menu entry (snakes-word.desktop, snakes-code.desktop…), which the hub and install.py create.
// Electron takes it from CHROME_DESKTOP (else the package's name, which would be Studio's for all).
if (process.platform === 'linux') {
  const { APPS } = require('./apps');
  process.env.CHROME_DESKTOP = `${hosted || Object.hasOwn(APPS, id) ? `snakes-${id}` : 'snakes-studio'}.desktop`;
}
const entry = hosted && path.join(__dirname, '..', '..', 'hosted', id, 'src', 'main', 'main.js');

if (entry && fs.existsSync(entry)) {
  // The taskbar group and icon (X11 WM_CLASS, Wayland app id), as when it was its own program.
  app.commandLine.appendSwitch('class', hosted.windowClass);
  // The same settings folder (and so the same single-instance lock) as the standalone app.
  if (!process.env.SNAKE_USER_DATA) app.setPath('userData', path.join(app.getPath('appData'), hosted.name));
  require(entry);
} else {
  require('./main.js');
}
