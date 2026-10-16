// The only bridge between a Snake's Studio page and the main process.
// Sandboxed: it can use ipcRenderer, contextBridge and webUtils, nothing else.
'use strict';

const { contextBridge, ipcRenderer, webUtils } = require('electron');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);
const send = (ch) => (...args) => ipcRenderer.send(ch, ...args);
const on = (ch) => (cb) => {
  const fn = (_e, ...args) => cb(...args);
  ipcRenderer.on(ch, fn);
  return () => ipcRenderer.removeListener(ch, fn);
};

contextBridge.exposeInMainWorld('snakeHost', {
  kind: 'electron',
  init: invoke('app:init'),
  launch: invoke('app:launch'),
  onBeforeClose: on('app:beforeClose'),

  win: {
    minimize: send('win:minimize'),
    toggleMaximize: send('win:toggleMaximize'),
    close: send('win:close'),
    forceClose: send('win:forceClose'),
    setTitle: send('win:setTitle'),
    setFullScreen: send('win:setFullScreen'),
    toggleFullScreen: send('win:toggleFullScreen'),
    setAlwaysOnTop: send('win:setAlwaysOnTop'),
    setSize: send('win:setSize'),
    setProgress: send('win:setProgress'),
    setZoom: send('win:setZoom'),
    newWindow: send('win:new'),
    toggleDevTools: send('win:toggleDevTools'),
    openPage: invoke('win:openPage'),
    isMaximized: invoke('win:isMaximized'),
    onMaximized: on('win:maximized'),
    onFullScreen: on('win:fullscreen'),
    onFocus: on('win:focus'),
  },

  file: {
    open: invoke('file:open'),
    read: invoke('file:read'),
    write: invoke('file:write'),
    saveAs: invoke('file:saveAs'),
    recent: invoke('file:recent'),
    openRecent: invoke('file:openRecent'),
    forgetRecent: invoke('file:forgetRecent'),
    siblings: invoke('file:siblings'),
    reveal: send('file:reveal'),
    openInNewWindow: send('file:openInNewWindow'),
    openWithSystem: send('file:openWithSystem'),
    onOpened: on('file:opened'),
    // Dropped files: the path is read here from the real File object, so a page
    // cannot ask for a file the user did not drop.
    dropped: (files) => ipcRenderer.invoke('file:dropped',
      Array.from(files || []).map((f) => { try { return webUtils.getPathForFile(f); } catch { return ''; } })),
  },

  store: { get: invoke('store:get'), set: invoke('store:set') },
  recovery: {
    put: invoke('recovery:put'), get: invoke('recovery:get'), list: invoke('recovery:list'), delete: invoke('recovery:delete'),
  },
  print: { pdf: invoke('print:pdf'), print: invoke('print:print') },
  spell: { replace: send('spell:replace'), learn: send('spell:learn'), onContext: on('spell:context') },
  clipboard: { readImage: invoke('clipboard:readImage'), writeImage: invoke('clipboard:writeImage') },
  shell: { openExternal: send('shell:openExternal') },

  media: {
    probe: invoke('media:probe'),
    frame: invoke('media:frame'),
    waveform: invoke('media:waveform'),
    subtitle: invoke('media:subtitle'),
    readText: invoke('media:readText'),
    playlist: invoke('media:playlist'),
    proxy: invoke('media:proxy'),
    project: invoke('media:project'),
    exportMovie: invoke('media:export'),
    convert: invoke('media:convert'),
    cancel: send('media:cancel'),
    onProgress: on('media:progress'),
    onDone: on('media:done'),
  },
});
