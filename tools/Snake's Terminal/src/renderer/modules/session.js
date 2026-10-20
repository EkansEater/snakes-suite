// One terminal session: an xterm.js screen tied to a shell (or ssh) running on a pty.
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { SearchAddon } from '@xterm/addon-search';
import { WebLinksAddon } from '@xterm/addon-web-links';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { ImageAddon } from '@xterm/addon-image';
import { ClipboardAddon } from '@xterm/addon-clipboard';
import { WebglAddon } from '@xterm/addon-webgl';
import { el, bus, basename, platform, debounce, uid } from './util.js';
import { settings, profileById, schemeById, FONT_FALLBACK, hostLabel, saveSettings } from './settings.js';
import { xtermTheme } from './themes.js';
import { env } from './env.js';
import { applyMods } from './touchkeys.js';

const sessions = new Map(); // pty id -> Session
const SHELLS = new Set(['bash', 'zsh', 'fish', 'sh', 'dash', 'ksh', 'mksh', 'tcsh', 'csh', 'nu', 'xonsh', 'elvish', 'pwsh', 'powershell', 'cmd', 'login', 'wsl', 'bash.exe', 'pwsh.exe', 'powershell.exe', 'cmd.exe', 'wsl.exe']);

// A fast program can speak (or end) before the page has heard back that it started:
// keep what arrives for an id not known yet, and hand it over when it is.
const early = new Map();
window.snake.pty.onData((id, data) => {
  const s = sessions.get(id);
  if (s) s.receive(data);
  else early.set(id, { data: (early.get(id)?.data || '') + data, exit: early.get(id)?.exit });
});
window.snake.pty.onExit((id, code, signal) => {
  const s = sessions.get(id);
  if (s) s.exited(code, signal);
  else early.set(id, { data: early.get(id)?.data || '', exit: [code, signal] });
});

/** The last text selected in any pane (for "Paste selection" where there is no primary selection). */
export let lastSelection = '';

export let fontZoom = 0; // window-wide font size change (Ctrl/Cmd + and -)
export function setFontZoom(z) {
  fontZoom = Math.max(-8, Math.min(30, z));
  bus.emit('font:zoom', fontZoom);
}

/**
 * opts: { profileId, host (a saved or ad-hoc SSH host), cwd, command: [file, ...args], paused,
 *         title, keepOpen }
 */
export class Session {
  constructor(opts = {}) {
    this.key = uid();
    this.opts = opts;
    this.profile = profileById(opts.profileId || opts.host?.profile);
    this.host = opts.host || null;
    this.id = null;
    this.state = 'new'; // new, running, ended, paused
    this.cwd = opts.cwd || null;
    this.oscTitle = '';
    this.userTitle = opts.title || '';
    this.procName = '';
    this.events = { title: [], exit: [], activity: [], bell: [], focus: [] };

    this.el = el('div.term', { tabindex: '-1' });
    this.term = new Terminal(this.options());
    this.el.style.background = this.scheme.bg;
    this.fit = new FitAddon();
    this.search = new SearchAddon({ highlightLimit: 2000 });
    this.term.loadAddon(this.fit);
    this.term.loadAddon(this.search);
    this.term.loadAddon(new Unicode11Addon());
    this.term.unicode.activeVersion = '11';
    this.term.loadAddon(new WebLinksAddon((e, uri) => this.openLink(e, uri), {
      hover: (e) => { this.el.title = `${platform.mac ? 'Cmd' : 'Ctrl'}+click to open`; },
      leave: () => { this.el.title = ''; },
    }));
    // Inline pictures: iTerm2's protocol (imgcat) and Sixel.
    this.term.loadAddon(new ImageAddon({ sixelSupport: true, iipSupport: true, storageLimit: 128, showPlaceholder: true }));
    // OSC 52: programs (also over SSH, in tmux or vim) may copy to your clipboard, never read it.
    this.term.loadAddon(new ClipboardAddon(undefined, {
      readText: () => '',
      writeText: (_sel, text) => window.snake.clipboard.write(text),
    }));
    this.registerOsc();

    this.term.onTitleChange((t) => { this.oscTitle = t; this.emit('title'); });
    this.term.onBell(() => this.emit('bell'));
    // Selecting copies once the selection settles, not on every step of a drag.
    const settle = debounce(() => {
      if (!this.term.hasSelection()) return;
      const text = this.selectedText();
      if (!text) return;
      lastSelection = text;
      if (platform.os === 'linux') window.snake.clipboard.write(text, 'selection');
      if (settings.copyOnSelect && text !== this.copiedText) {
        this.copiedText = text;
        window.snake.clipboard.write(text);
        if (settings.copyNotice) this.notice(text.includes('\n') ? `Copied ${text.split('\n').length} lines` : 'Copied');
      }
    }, 180);
    this.term.onSelectionChange(() => { if (!this.term.hasSelection()) this.copiedText = null; settle(); });
    this.term.onData((d) => this.input(d));
    this.term.onBinary((d) => this.input(d));
    this.term.onResize(({ cols, rows }) => { if (this.id) window.snake.pty.resize(this.id, cols, rows); });
    this.term.textarea?.addEventListener('focus', () => this.emit('focus'));

    // Middle click pastes the selection (the Linux habit).
    this.el.addEventListener('mousedown', async (e) => {
      if (e.button === 1 && platform.os === 'linux') {
        e.preventDefault();
        const text = await window.snake.clipboard.read('selection');
        if (text) this.paste(text);
      }
    });
    // Ctrl (or Cmd) + wheel, or a touchpad pinch: text size.
    this.el.addEventListener('wheel', (e) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      e.preventDefault();
      e.stopPropagation();
      const step = Math.abs(e.deltaY) < 20 ? 0.25 : 1; // pinches come in small steps
      setFontZoom(fontZoom + (e.deltaY < 0 ? step : -step));
    }, { passive: false, capture: true });

    this.unsub = [
      bus.on('font:zoom', () => this.applyOptions()),
      bus.on('settings:changed', () => { this.profile = profileById(this.profile.id); this.applyOptions(); }),
    ];
    this.refit = debounce(() => this.doFit(), 30);
    this.resizeObserver = new ResizeObserver(() => this.refit());
  }

  on(ev, fn) { this.events[ev].push(fn); }
  emit(ev, ...a) { for (const fn of this.events[ev]) fn(this, ...a); }

  options() {
    const p = this.profile;
    return {
      allowProposedApi: true,
      fontFamily: `"${p.fontFamily || 'JetBrains Mono'}", "JetBrains Mono", ${FONT_FALLBACK}`,
      fontSize: Math.max(6, (p.fontSize || 14) + fontZoom),
      lineHeight: p.lineHeight || 1.15,
      cursorStyle: p.cursorStyle || 'block',
      cursorInactiveStyle: 'outline',
      cursorBlink: p.cursorBlink !== false,
      scrollback: Math.max(100, Math.min(1_000_000, p.scrollback || 10000)),
      theme: xtermTheme(schemeById(this.host?.scheme || p.scheme)),
      macOptionIsMeta: !!settings.optionAsMeta,
      macOptionClickForcesSelection: true,
      wordSeparator: settings.wordSeparators || ' ()[]{}\',"`',
      rightClickSelectsWord: false,
      drawBoldTextInBrightColors: true,
      minimumContrastRatio: 1,
      rescaleOverlappingGlyphs: true,
      smoothScrollDuration: 0,
      windowsPty: platform.win ? { backend: 'conpty', buildNumber: 22000 } : undefined,
    };
  }

  applyOptions() {
    const o = this.options();
    for (const k of ['fontFamily', 'fontSize', 'lineHeight', 'cursorStyle', 'cursorBlink', 'scrollback', 'theme', 'macOptionIsMeta', 'wordSeparator']) {
      if (JSON.stringify(this.term.options[k]) !== JSON.stringify(o[k])) this.term.options[k] = o[k];
    }
    this.el.style.background = this.scheme.bg;
    this.refit();
  }

  get scheme() { return schemeById(this.host?.scheme || this.profile.scheme); }

  /** Put the terminal on the page (once) and start it. */
  mount(parent) {
    parent.append(this.el);
    if (!this.opened) {
      this.opened = true;
      this.term.open(this.el);
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => webgl.dispose()); // back to the plain renderer
        this.term.loadAddon(webgl);
      } catch {}
      this.resizeObserver.observe(this.el);
      this.doFit();
      if (this.opts.paused) this.pause(this.opts.pausedMessage);
      else this.start();
    }
  }

  doFit() {
    if (!this.el.isConnected || !this.el.offsetWidth || !this.el.offsetHeight) return;
    try { this.fit.fit(); } catch {}
  }

  title() {
    if (this.userTitle) return this.userTitle;
    if (this.host) return hostLabel(this.host);
    if (this.oscTitle) return this.oscTitle;
    if (this.procName && !SHELLS.has(this.procName.toLowerCase())) return this.procName;
    if (this.cwd) return this.cwd === env.home ? '~' : basename(this.cwd);
    return this.shellName || 'Terminal';
  }

  /** What to run: ssh for a host, the given command, or the profile's shell. */
  launch() {
    if (this.host) {
      const h = this.host;
      const args = [];
      if (h.port && Number(h.port) !== 22) args.push('-p', String(h.port));
      if (h.identity) args.push('-i', h.identity);
      if (h.jump) args.push('-J', h.jump);
      if (h.alias) args.push(h.alias); // from ~/.ssh/config: ssh knows the rest
      else args.push(h.user ? `${h.user}@${h.host}` : h.host);
      return { file: env.ssh || 'ssh', args };
    }
    if (this.opts.command?.length) return { file: this.opts.command[0], args: this.opts.command.slice(1) };
    const p = this.profile;
    const shell = p.shell || env.defaultShell;
    const args = p.args ? splitArgs(p.args) : env.shells.find((s) => s.file === shell)?.args || [];
    return { file: shell, args };
  }

  async start() {
    const { file, args } = this.launch();
    this.shellName = basename(file).replace(/\.exe$/i, '');
    if (this.host && !env.ssh) {
      this.term.write('\x1b[31mThe ssh program was not found on this computer.\x1b[0m\r\n');
      this.term.write(platform.win ? 'Windows: Settings → System → Optional features → add "OpenSSH Client".\r\n' : 'Install OpenSSH (the openssh or openssh-client package).\r\n');
      this.state = 'ended';
      return;
    }
    let cwd = this.cwd;
    if (!cwd && this.profile.cwd && !['home', 'inherit'].includes(this.profile.cwd)) cwd = this.profile.cwd;
    try {
      const res = await window.snake.pty.create({ file, args, cwd: cwd || env.home, cols: this.term.cols, rows: this.term.rows, env: this.opts.env });
      this.id = res.id;
      sessions.set(res.id, this);
      this.state = 'running';
      // The window may have changed size while the program was starting.
      this.doFit();
      window.snake.pty.resize(this.id, this.term.cols, this.term.rows);
      const before = early.get(res.id);
      if (before) {
        early.delete(res.id);
        if (before.data) this.receive(before.data);
        if (before.exit) this.exited(...before.exit);
      }
      this.started = Date.now();
      if (this.opts.input) setTimeout(() => this.write(this.opts.input), 300);
    } catch (err) {
      this.term.write(`\x1b[31mCould not start ${file}: ${String(err.message).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')}\x1b[0m\r\n`);
      this.state = 'ended';
    }
    this.emit('title');
  }

  receive(data) {
    this.term.write(data);
    this.emit('activity');
  }

  input(data) {
    if (platform.android) data = applyMods(data);
    if (this.state === 'running') {
      this.write(data);
      bus.emit('session:input', this, data);
    } else if (this.state === 'ended' || this.state === 'paused') {
      if (data === '\r') this.restart();
      else if (data === '\x1b' || data === '\x04') this.emit('exit', 'close');
    }
  }

  write(data) { if (this.id && this.state === 'running') window.snake.pty.write(this.id, data); }

  exited(code, signal) {
    sessions.delete(this.id);
    this.id = null;
    if (this.state === 'closing') return;
    this.state = 'ended';
    const quick = Date.now() - (this.started || 0) < 2500;
    // A shell you left with `exit` closes its pane; a dropped connection or a failed start says why.
    if (!this.opts.keepOpen && !quick && (!this.host || code === 0)) { this.emit('exit', 'close'); return; }
    const what = this.host ? `Connection to ${hostLabel(this.host)} closed` : `${this.shellName} exited`;
    this.term.write(`\r\n\x1b[2m${what}${code ? ` (code ${code})` : ''}. Press Enter to ${this.host ? 'reconnect' : 'start it again'}, or Esc to close.\x1b[0m\r\n`);
    this.emit('exit', 'ended', code);
  }

  pause(message) {
    this.state = 'paused';
    this.term.write(`\x1b[2m${message || `Press Enter to connect to ${this.host ? hostLabel(this.host) : 'the shell'}, or Esc to close.`}\x1b[0m\r\n`);
  }

  restart() {
    this.term.write('\r\n');
    this.state = 'new';
    this.start();
  }

  /** Close the program (asked by the user). */
  kill() {
    this.state = 'closing';
    if (this.id) window.snake.pty.kill(this.id);
  }

  dispose() {
    this.kill();
    sessions.delete(this.id);
    for (const u of this.unsub) u();
    this.resizeObserver.disconnect();
    this.term.dispose();
    this.el.remove();
  }

  focus() { this.term.focus(); }

  async currentCwd() {
    if (this.host) return null;
    if (this.id) {
      const c = await window.snake.pty.cwd(this.id);
      if (c) this.cwd = c;
    }
    return this.cwd;
  }

  async refreshProcess() {
    if (!this.id) return;
    const name = await window.snake.pty.process(this.id);
    if (name !== this.procName) { this.procName = name || ''; this.emit('title'); }
  }

  /** Something other than the shell is running (closing would stop it). */
  async busy() {
    if (this.state !== 'running') return false;
    if (this.host) return true;
    await this.refreshProcess();
    return !!this.procName && !SHELLS.has(this.procName.toLowerCase()) && this.procName.toLowerCase() !== this.shellName.toLowerCase();
  }

  /** The selection as text, with the spaces at the ends of lines dropped when set to. */
  selectedText() {
    const t = this.term.getSelection();
    return settings.copyTrim ? t.replace(/[ \t]+$/gm, '') : t;
  }

  /** A short sign in the corner of the pane ("Copied"). */
  notice(text) {
    this.noticeEl?.remove();
    clearTimeout(this.noticeTimer);
    const n = el('div.pane-notice', { text });
    (this.paneEl || this.el).append(n);
    this.noticeEl = n;
    this.noticeTimer = setTimeout(() => { n.classList.add('closing'); setTimeout(() => n.remove(), 200); }, 1100);
  }

  /** Copy the selection; oneLine joins its lines with spaces (for a command broken over lines). */
  copy({ oneLine = false } = {}) {
    if (!this.term.hasSelection()) return false;
    let text = this.selectedText();
    if (oneLine) text = text.split('\n').map((l) => l.trim()).filter(Boolean).join(' ');
    window.snake.clipboard.write(text);
    this.copiedText = text;
    if (settings.copyNotice) this.notice(oneLine ? 'Copied as one line' : 'Copied');
    return true;
  }

  /** The whole scrollback and screen as text. */
  allText() {
    const b = this.term.buffer.active;
    const out = [];
    let line = '';
    for (let i = 0; i < b.length; i++) {
      const l = b.getLine(i);
      if (!l) continue;
      line += l.translateToString(true);
      const next = b.getLine(i + 1);
      if (next?.isWrapped) continue;
      out.push(line);
      line = '';
    }
    while (out.length && !out[out.length - 1].trim()) out.pop();
    return out.join('\n') + '\n';
  }

  async paste(text) {
    if (text == null) text = await window.snake.clipboard.read();
    if (!text) return;
    const lines = text.replace(/\r?\n$/, '').split(/\r?\n/).length;
    if (settings.pasteWarning && lines > 1 && !this.term.modes.bracketedPasteMode) {
      const r = await window.snake.confirm({ message: `Paste ${lines} lines?`, detail: 'Each line runs as a command as soon as it is pasted.', buttons: ['Paste', 'Cancel'], checkbox: 'Do not ask again' });
      if (r.response !== 0) return;
      if (r.checked) { settings.pasteWarning = false; saveSettings(); }
    }
    this.term.paste(text);
    this.term.scrollToBottom();
  }

  openLink(e, uri) {
    if (!(e.ctrlKey || e.metaKey)) return;
    window.snake.openExternal(uri);
  }

  registerOsc() {
    const p = this.term.parser;
    // OSC 7: the shell says which folder it is in (file://host/path).
    p.registerOscHandler(7, (data) => {
      try {
        const u = new URL(data);
        if (u.protocol === 'file:') {
          let dir = decodeURIComponent(u.pathname);
          if (/^\/[A-Za-z]:/.test(dir)) dir = dir.slice(1);
          if (!this.host) this.cwd = dir;
          this.emit('title');
        }
      } catch {}
      return true;
    });
    // OSC 9 (iTerm2) and OSC 777 (rxvt): a desktop notification from the program.
    p.registerOscHandler(9, (data) => {
      if (/^\d+;/.test(data)) return false; // ConEmu progress, not a message
      window.snake.notify(this.title(), data);
      return true;
    });
    p.registerOscHandler(777, (data) => {
      const [kind, title, ...body] = data.split(';');
      if (kind === 'notify') window.snake.notify(title || this.title(), body.join(';'));
      return true;
    });
    // OSC 1337 CurrentDir= (iTerm2 shell integration); pictures are the image addon's.
    p.registerOscHandler(1337, (data) => {
      if (!data.startsWith('CurrentDir=')) return false;
      if (!this.host) this.cwd = data.slice(11);
      this.emit('title');
      return true;
    });
  }

  /** What restores this pane next time. */
  snapshot() {
    return { profileId: this.profile.id, cwd: this.host ? null : this.cwd, host: this.host, title: this.userTitle || '' };
  }
}

/** Split a command line into arguments ("quoted parts" stay together). */
export function splitArgs(s) {
  const out = [];
  for (const m of String(s).matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}
