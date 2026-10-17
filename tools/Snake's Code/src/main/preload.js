// Exposes a narrow, typed bridge from the renderer to the main process.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);
const send = (ch) => (...args) => ipcRenderer.send(ch, ...args);
const on = (ch) => (cb) => {
  const fn = (_e, ...args) => cb(...args);
  ipcRenderer.on(ch, fn);
  return () => ipcRenderer.removeListener(ch, fn);
};

contextBridge.exposeInMainWorld('snake', {
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
    pathForFile: (file) => webUtils.getPathForFile(file),
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

  lsp: {
    which: invoke('lsp:which'),
    start: invoke('lsp:start'),
    send: send('lsp:send'),
    stop: send('lsp:stop'),
    onMessage: on('lsp:message'),
    onExit: on('lsp:exit'),
    onStderr: on('lsp:stderr'),
  },
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
});
