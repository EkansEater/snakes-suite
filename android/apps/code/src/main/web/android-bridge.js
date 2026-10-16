// Snake's Code on Android: the window.snake API that src/main/preload.js gives
// the renderer on the desktop, here backed by the app's Kotlin side
// (SnakeNative, see Bridge.kt) instead of Electron's main process.
//
// invoke(channel, ...args) -> Promise   Kotlin answers with __snakeReply(id, ok, json)
// send(channel, ...args)                fire and forget
// on(channel)(callback) -> unsubscribe  Kotlin calls __snakeEmit(channel, jsonArgs)
(() => {
  const native = window.SnakeNative;
  const pending = new Map();
  const listeners = new Map();
  let seq = 0;

  window.__snakeReply = (id, ok, json) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    const value = json == null ? undefined : JSON.parse(json);
    if (ok) p.resolve(value);
    else p.reject(new Error(value));
  };

  window.__snakeEmit = (channel, json) => {
    const args = JSON.parse(json);
    for (const cb of listeners.get(channel) || []) {
      try { cb(...args); } catch (err) { console.error(err); }
    }
  };

  const invoke = (ch) => (...args) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    native.invoke(id, ch, JSON.stringify(args));
  });
  const send = (ch) => (...args) => native.send(ch, JSON.stringify(args));
  const on = (ch) => (cb) => {
    if (!listeners.has(ch)) listeners.set(ch, new Set());
    listeners.get(ch).add(cb);
    return () => listeners.get(ch).delete(cb);
  };

  window.snake = {
    init: invoke('app:init'),
    quit: send('app:quit'),
    onBeforeClose: on('app:beforeClose'),

    win: {
      minimize: send('win:minimize'),
      toggleMaximize: send('win:toggleMaximize'),
      close: send('win:close'),
      forceClose: send('win:forceClose'),
      newWindow: send('win:new'),
      setTitle: send('win:setTitle'),
      toggleFullScreen: send('win:toggleFullScreen'),
      setFullScreen: send('win:setFullScreen'),
      toggleDevTools: send('win:toggleDevTools'),
      reload: send('win:reload'),
      setZoom: send('win:setZoom'),
      isMaximized: invoke('win:isMaximized'),
      onMaximized: on('win:maximized'),
      onFullScreen: on('win:fullscreen'),
    },

    store: { get: invoke('store:get'), set: invoke('store:set') },

    fs: {
      readDir: invoke('fs:readDir'),
      readFile: invoke('fs:readFile'),
      writeFile: invoke('fs:writeFile'),
      stat: invoke('fs:stat'),
      mkdir: invoke('fs:mkdir'),
      createFile: invoke('fs:createFile'),
      rename: invoke('fs:rename'),
      copy: invoke('fs:copy'),
      trash: invoke('fs:trash'),
      delete: invoke('fs:delete'),
      listFiles: invoke('fs:listFiles'),
      watchDirs: send('fs:watchDirs'),
      onChanged: on('fs:changed'),
      pathForFile: () => '',   // nothing is dropped in from other apps on Android
    },

    search: { run: invoke('search:run'), cancel: send('search:cancel') },

    pty: {
      create: invoke('pty:create'),
      write: send('pty:write'),
      resize: send('pty:resize'),
      kill: send('pty:kill'),
      cwd: invoke('pty:cwd'),
      onData: on('pty:data'),
      onExit: on('pty:exit'),
    },

    git: { run: invoke('git:run') },
    exec: invoke('proc:exec'),

    dialog: {
      openFolder: invoke('dialog:openFolder'),
      openFiles: invoke('dialog:openFiles'),
      saveAs: invoke('dialog:saveAs'),
      message: invoke('dialog:message'),
    },

    shell: {
      openExternal: send('shell:openExternal'),
      showItemInFolder: send('shell:showItemInFolder'),
      openPath: send('shell:openPath'),
    },

    clipboard: { write: send('clipboard:write'), read: invoke('clipboard:read') },
  };

  // The page comes from https://appassets.androidplatform.net, where file:// URLs
  // (image and media viewers, Markdown preview) are blocked. Serve them through
  // the app's /fs/ route instead.
  const FS = location.origin + '/fs';
  const rewrite = (v) => (typeof v === 'string' && v.startsWith('file://') ? FS + v.slice('file://'.length) : v);
  for (const proto of [HTMLImageElement.prototype, HTMLMediaElement.prototype, HTMLSourceElement.prototype]) {
    const desc = Object.getOwnPropertyDescriptor(proto, 'src');
    if (!desc) continue;
    Object.defineProperty(proto, 'src', { ...desc, set(v) { desc.set.call(this, rewrite(v)); } });
  }
  const setAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function (name, value) {
    return setAttribute.call(this, name, (name === 'src' || name === 'href') ? rewrite(value) : value);
  };

  document.documentElement.classList.add('android');

  // ------------------------------------------------------------------ View button
  // A phone shows just the editor. The floating button brings back any part of the
  // workbench and runs the commands the menu bar would. Commands go through the
  // editor's own keyboard shortcuts, so its state stays right (see Bridge.ANDROID_KEYS).
  const PREFS = 'snake.android.view';
  const prefs = (() => { try { return JSON.parse(localStorage.getItem(PREFS)) || null; } catch { return null; } })();
  const first = prefs === null;
  const view = Object.assign({ menubar: false, tabs: true }, prefs || {});
  const save = () => { try { localStorage.setItem(PREFS, JSON.stringify(view)); } catch {} };
  const root = document.documentElement;
  const apply = () => {
    root.classList.toggle('hide-menubar', !view.menubar);
    root.classList.toggle('hide-tabs', !view.tabs);
    requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
  };
  apply();

  const CODES = { '=': 'Equal', '-': 'Minus', '`': 'Backquote', '0': 'Digit0' };
  const press = (combo) => {
    // "ctrl+shift+p" -> a keydown the editor's dispatcher understands (it reads e.code).
    const parts = combo.split('+');
    const k = parts.pop();
    const code = CODES[k] || (/^f\d+$/.test(k) ? k.toUpperCase() : 'Key' + k.toUpperCase());
    const ev = new KeyboardEvent('keydown', {
      key: k, code, bubbles: true, cancelable: true,
      ctrlKey: parts.includes('ctrl'), shiftKey: parts.includes('shift'), altKey: parts.includes('alt'),
    });
    document.body.dispatchEvent(ev);
  };
  const shown = (sel) => { const e = document.querySelector(sel); return !!e && e.offsetWidth > 0 && e.offsetHeight > 0; };

  const toggles = [
    ['Menu bar', () => view.menubar, () => { view.menubar = !view.menubar; save(); apply(); }],
    ['Explorer', () => shown('#sidebar'), () => press('ctrl+b')],
    ['Activity bar', () => shown('#activitybar'), () => press('ctrl+alt+shift+f1')],
    ['Tabs', () => view.tabs, () => { view.tabs = !view.tabs; save(); apply(); }],
    ['Breadcrumbs', () => shown('.breadcrumbs'), () => press('ctrl+alt+shift+f3')],
    ['Minimap', () => shown('.minimap'), () => press('ctrl+alt+shift+f4')],
    ['Terminal and panel', () => shown('#panel'), () => press('ctrl+j')],
    ['Status bar', () => shown('#statusbar'), () => press('ctrl+alt+shift+f2')],
  ];
  const actions = [
    ['New file', 'ctrl+n'], ['Open file', 'ctrl+o'], ['Open folder', 'ctrl+alt+shift+f5'], ['Save', 'ctrl+s'],
    ['Go to file', 'ctrl+p'], ['Commands', 'ctrl+shift+p'], ['Word wrap', 'alt+z'], ['New terminal', 'ctrl+shift+`'],
    ['Text smaller', 'ctrl+-'], ['Text bigger', 'ctrl+='],
  ];

  const build = () => {
    const btn = document.createElement('button');
    btn.id = 'android-view-button';
    btn.title = 'View';
    btn.textContent = '\u22EE';
    const sheet = document.createElement('div');
    sheet.id = 'android-view-sheet';
    const close = () => sheet.classList.remove('open');
    const render = () => {
      sheet.replaceChildren();
      const h = (t) => { const d = document.createElement('div'); d.className = 'avs-head'; d.textContent = t; sheet.append(d); };
      h('View');
      for (const [label, on, run] of toggles) {
        const row = document.createElement('button');
        row.className = 'avs-toggle' + (on() ? ' on' : '');
        row.innerHTML = '<span class="avs-check"></span>';
        row.append(label);
        row.onclick = () => { run(); setTimeout(render, 150); };
        sheet.append(row);
      }
      h('Actions');
      const grid = document.createElement('div');
      grid.className = 'avs-grid';
      for (const [label, combo] of actions) {
        const b = document.createElement('button');
        b.textContent = label;
        b.onclick = () => { close(); setTimeout(() => press(combo), 50); };
        grid.append(b);
      }
      sheet.append(grid);
    };
    btn.onclick = (e) => { e.stopPropagation(); if (sheet.classList.toggle('open')) render(); };
    document.addEventListener('pointerdown', (e) => { if (!sheet.contains(e.target) && e.target !== btn) close(); }, true);
    document.body.append(sheet, btn);
  };

  // On the very first start, close the explorer once the workbench is up: just the editor.
  const ready = () => {
    build();
    if (first) {
      save();
      setTimeout(() => { if (shown('#sidebar')) press('ctrl+b'); if (shown('#panel')) press('ctrl+j'); }, 600);
    }
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready);
  else ready();
})();
