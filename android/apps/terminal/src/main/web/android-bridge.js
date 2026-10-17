// Snake's Terminal on Android: the window.snake API that src/main/preload.js gives the page
// on the desktop, here answered by the app's Kotlin side (SnakeNative, see Bridge.kt).
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
  };
})();
