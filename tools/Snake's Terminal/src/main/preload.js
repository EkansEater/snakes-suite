// The narrow bridge the terminal page gets from the main process (window.snake).
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (ch) => (...args) => ipcRenderer.invoke(ch, ...args);
const send = (ch) => (...args) => ipcRenderer.send(ch, ...args);
const on = (ch) => (cb) => {
  const fn = (_e, ...args) => cb(...args);
  ipcRenderer.on(ch, fn);
  return () => ipcRenderer.removeListener(ch, fn);
};

contextBridge.exposeInMainWorld('snake', {
  init: invoke('app:init'),
  onBeforeClose: on('app:beforeClose'),
  onFocusTerminal: on('app:focusTerminal'),
  onMenuCommand: on('menu:command'),
  setSettings: invoke('settings:set'),
  onSettingsChanged: on('settings:changed'),
  setState: invoke('state:set'),

  win: {
    minimize: send('win:minimize'),
    toggleMaximize: send('win:toggleMaximize'),
    close: send('win:close'),
    forceClose: send('win:forceClose'),
    newWindow: send('win:new'),
    setTitle: send('win:setTitle'),
    toggleFullScreen: send('win:toggleFullScreen'),
    flash: send('win:flash'),
    isMaximized: invoke('win:isMaximized'),
    onMaximized: on('win:maximized'),
    onFullScreen: on('win:fullscreen'),
    onFocus: on('win:focus'),
  },

  pty: {
    create: invoke('pty:create'),
    write: send('pty:write'),
    resize: send('pty:resize'),
    kill: send('pty:kill'),
    cwd: invoke('pty:cwd'),
    process: invoke('pty:process'),
    onData: on('pty:data'),
    onExit: on('pty:exit'),
  },

  clipboard: { read: invoke('clipboard:read'), write: send('clipboard:write') },
  openExternal: send('shell:openExternal'),
  editNative: send('edit:native'),
  notify: send('notify'),
  openScheme: invoke('dialog:openScheme'),
  saveText: invoke('dialog:saveText'),
  confirm: invoke('dialog:confirm'),

  devices: {
    local: invoke('devices:local'),
    sshConfig: invoke('devices:sshConfig'),
    keys: invoke('devices:keys'),
    makeKey: invoke('devices:makeKey'),
    tailscale: invoke('devices:tailscale'),
    scan: invoke('devices:scan'),
    onScanFound: on('devices:scanFound'),
    browse: send('devices:browse'),
    onNearby: on('devices:nearby'),
    installKeyCommand: invoke('devices:installKeyCommand'),
    enableSshCommand: invoke('devices:enableSshCommand'),
    openSharingSettings: send('devices:openSharingSettings'),
  },
});
