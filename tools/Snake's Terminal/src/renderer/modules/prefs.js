// Preferences: General, Profiles, Colours and Keys.
import { el, icon, platform } from './util.js';
import { settings, saveSettings, allSchemes, newProfile, defaultProfile, DEFAULT_WORD_SEPARATORS } from './settings.js';
import { BUILT_IN, parseItermColors, parseJsonSchemes } from './themes.js';
import { DEFAULT_KEYS, keysFor, eventKey, rebuild } from './keys.js';
import { modal, field, toast, confirmDialog } from './ui.js';
import { env } from './env.js';
import { COMMAND_TITLES } from './commands.js';

let dialog = null;
let section = 'general';
let profileId = null;

export function openPrefs(which) {
  if (which) section = which;
  if (dialog) { draw(); return; }
  const body = el('div.prefs');
  dialog = modal({ title: 'Settings', body, wide: true, onClose: () => { dialog = null; } });
  draw();
}

function draw() {
  const body = dialog.box.querySelector('.prefs');
  const nav = el('nav.prefs-nav', {}, [['general', 'General'], ['profiles', 'Profiles'], ['colours', 'Colours'], ['keys', 'Keys']].map(([id, label]) =>
    el(`button.prefs-tab${section === id ? '.on' : ''}`, { on: { click: () => { section = id; draw(); } } }, label)));
  const page = el('div.prefs-page');
  ({ general, profiles, colours, keys })[section](page);
  body.replaceChildren(nav, page);
}

const save = () => { saveSettings(); };

function check(label, key, hint) {
  return el('label.check', {}, el('input', { type: 'checkbox', checked: !!settings[key], on: { change: (e) => { settings[key] = e.target.checked; save(); } } }), el('span', {}, label, hint ? el('span.field-hint', { text: hint }) : ''));
}

function select(value, options, onChange) {
  return el('select.input', { on: { change: (e) => onChange(e.target.value) } }, options.map(([v, label]) => el('option', { value: v, text: label, selected: String(value) === String(v) })));
}

// ---------------------------------------------------------------------------
function general(page) {
  const hotkey = el('input.input.hotkey', {
    value: settings.hotkey || '', placeholder: 'Click, then press a key combination', readonly: true,
    on: {
      keydown: async (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === 'Escape') { hotkey.blur(); return; }
        if (e.key === 'Backspace' || e.key === 'Delete') { hotkey.value = ''; await setHotkey(''); return; }
        const k = eventKey(e);
        if (!k || (!k.includes('+') && !/^F\d+$/.test(k))) return; // needs a modifier (or an F key)
        // Electron's spelling: Control, Command (Mac) or Super (Windows key), Alt, Shift.
        const accel = k.split('+').map((part) => ({ Ctrl: 'Control', Cmd: platform.mac ? 'Command' : 'Super' })[part] || part).join('+');
        hotkey.value = accel;
        await setHotkey(accel);
      },
    },
  });
  const setHotkey = async (accel) => {
    settings.hotkey = accel;
    const r = await saveSettings();
    if (accel && r && !r.ok) toast(`The system did not allow ${accel} (another app may use it${platform.os === 'linux' ? ', or Wayland keeps shortcuts for itself' : ''}). Try another, or bind "snakes-terminal --toggle" in your system's keyboard settings.`, { type: 'error', timeout: 12000 });
    else if (accel) toast(`${accel} now shows and hides Snake's Terminal from anywhere.`);
  };
  page.append(
    el('h3', { text: 'Starting' }),
    field('When Snake\'s Terminal opens', select(settings.startup, [['restore', 'Bring back the tabs of last time'], ['new', 'Open one new tab']], (v) => { settings.startup = v; save(); }),
      'Connections come back paused: press Enter in one to reconnect.'),
    field('Hotkey window', hotkey, 'A key combination that brings Snake\'s Terminal forward from any app, and puts it away again. Backspace clears it.'),
    check('Show the menu bar', 'menuBar', 'Shell, Edit, View, Session, Window and Help under the tabs. The ☰ button has the same menus either way.'),
    el('h3', { text: 'Selecting and copying' }),
    check('Copy text when you select it', 'copyOnSelect', 'Drag or double-click over text and it is on the clipboard, ready to paste anywhere.'),
    check('Show "Copied" when it does', 'copyNotice'),
    check('Drop spaces at the ends of copied lines', 'copyTrim'),
    field('Right-click', select(settings.rightClick, [['menu', 'Opens the menu'], ['paste', 'Pastes'], ['smart', 'Copies the selection, or pastes when nothing is selected']], (v) => { settings.rightClick = v; save(); }),
      'Shift+right-click always opens the menu.'),
    field('A double-click selects a word up to', el('div.row-inline', {},
      el('input.input.mono', { value: settings.wordSeparators, spellcheck: 'false', on: { change: (e) => { settings.wordSeparators = e.target.value; save(); } } }),
      el('button.btn.small', { on: { click: (e) => { settings.wordSeparators = DEFAULT_WORD_SEPARATORS; e.target.previousSibling.value = DEFAULT_WORD_SEPARATORS; save(); } } }, 'Default')),
      'These characters end a word. Take out / and . to select whole paths with one double-click. A triple-click selects the line; Alt+drag selects a block.'),
    el('h3', { text: 'Working' }),
    check('Ask before pasting several lines', 'pasteWarning', 'Each line of a multi-line paste runs as a command.'),
    check('Ask before closing a pane where something is still running', 'confirmClose'),
    platform.mac ? check('Option key works as Meta (Esc+)', 'optionAsMeta', 'For Alt shortcuts in the shell; off lets Option type special characters.') : '',
    field('Bell', select(settings.bell, [['visual', 'Flash the pane'], ['sound', 'Beep'], ['none', 'Nothing']], (v) => { settings.bell = v; save(); })),
    el('h3', { text: 'Devices' }),
    check('Let my other devices find this computer', 'advertise', 'While its SSH server is on, other copies of Snake\'s Terminal on this network list it under Nearby (name and user name only).'),
    el('p.hint', { text: `Snake's Terminal ${env.versions.app} · Electron ${env.versions.electron}` }),
  );
}

// ---------------------------------------------------------------------------
function profiles(page) {
  const list = settings.profiles;
  profileId ||= settings.defaultProfile;
  let p = list.find((x) => x.id === profileId) || list[0];
  profileId = p.id;
  const side = el('div.prefs-list', {},
    list.map((x) => el(`button.prefs-item${x.id === p.id ? '.on' : ''}`, { on: { click: () => { profileId = x.id; draw(); } } },
      el('span', { text: x.name }), x.id === settings.defaultProfile ? el('span.tag', { text: 'default' }) : '')),
    el('div.prefs-list-actions', {},
      el('button.icon-btn', { title: 'New profile', on: { click: () => { profileId = newProfile().id; save(); draw(); } } }, icon('plus')),
      el('button.icon-btn', { title: 'Duplicate', on: { click: () => { profileId = newProfile(p).id; save(); draw(); } } }, icon('copy')),
      el('button.icon-btn', { title: 'Delete', disabled: list.length < 2, on: { click: async () => {
        if (!await confirmDialog({ title: 'Delete profile', message: `Delete "${p.name}"?`, ok: 'Delete', danger: true })) return;
        settings.profiles = list.filter((x) => x !== p);
        if (settings.defaultProfile === p.id) settings.defaultProfile = settings.profiles[0].id;
        profileId = null; save(); draw();
      } } }, icon('trash'))));
  const set = (key, value) => { p[key] = value; save(); };
  const input = (key, attrs = {}) => el('input.input', { value: p[key] ?? '', spellcheck: 'false', ...attrs, on: { change: (e) => set(key, attrs.type === 'number' ? Number(e.target.value) : e.target.value) } });
  const shellOptions = [['', `This computer's shell (${env.defaultShell.split(/[\\/]/).pop()})`], ...env.shells.map((s) => [s.file, `${s.name} (${s.file})`])];
  const custom = p.shell && !env.shells.some((s) => s.file === p.shell);
  const form = el('div.form', {},
    field('Name', input('name')),
    el('label.check', {}, el('input', { type: 'checkbox', checked: settings.defaultProfile === p.id, disabled: settings.defaultProfile === p.id, on: { change: () => { settings.defaultProfile = p.id; save(); draw(); } } }), el('span', { text: 'New tabs use this profile' })),
    field('Program', select(custom ? '__custom' : p.shell, [...shellOptions, ['__custom', 'Another program…']], (v) => { if (v !== '__custom') set('shell', v); else { p.shell = p.shell || ''; draw(); } })),
    custom || p.shell === '' ? '' : '',
    custom ? field('Program path', input('shell', { placeholder: '/usr/bin/fish' })) : '',
    field('Arguments', input('args', { placeholder: 'optional, e.g. --login' })),
    field('Starts in', select(['home', 'inherit'].includes(p.cwd) ? p.cwd : 'path', [['inherit', 'The folder of the pane it comes from'], ['home', 'Your home folder'], ['path', 'This folder…']], (v) => { set('cwd', v === 'path' ? env.home : v); draw(); })),
    !['home', 'inherit'].includes(p.cwd) ? field('Folder', input('cwd')) : '',
    el('h3', { text: 'Look' }),
    field('Colours', select(p.scheme, allSchemes().map((s) => [s.id, s.name]), (v) => set('scheme', v))),
    el('div.row2', {},
      field('Font', input('fontFamily', { placeholder: 'JetBrains Mono' }), 'Any installed monospaced font; Nerd Font icons work when one is installed.'),
      field('Size', input('fontSize', { type: 'number', min: 6, max: 72, style: { width: '80px' } }))),
    el('div.row2', {},
      field('Line height', input('lineHeight', { type: 'number', min: 0.8, max: 2, step: 0.05, style: { width: '80px' } })),
      field('Cursor', select(p.cursorStyle, [['block', 'Block'], ['bar', 'Bar'], ['underline', 'Underline']], (v) => set('cursorStyle', v)))),
    el('label.check', {}, el('input', { type: 'checkbox', checked: p.cursorBlink !== false, on: { change: (e) => set('cursorBlink', e.target.checked) } }), el('span', { text: 'Blinking cursor' })),
    field('Scrollback', input('scrollback', { type: 'number', min: 100, max: 1000000, step: 1000, style: { width: '120px' } }), 'Lines kept above the screen.'),
  );
  page.append(el('div.prefs-split', {}, side, form));
}

// ---------------------------------------------------------------------------
function colours(page) {
  const preview = (s) => el('div.scheme-preview', { style: { background: s.bg, color: s.fg } },
    el('div.scheme-line', {}, el('span', { style: { color: s.ansi[2] } }, 'snake@pc'), el('span', { style: { color: s.ansi[4] } }, ' ~/code'), ' $ ls'),
    el('div.scheme-swatches', {}, s.ansi.slice(0, 8).map((c) => el('span', { style: { background: c } }))),
    el('div.scheme-swatches', {}, s.ansi.slice(8).map((c) => el('span', { style: { background: c } }))));
  const current = settings.profiles.find((x) => x.id === (profileId || settings.defaultProfile)) || settings.profiles[0];
  page.append(
    el('p.hint', { text: `Click a scheme to use it in the "${current.name}" profile.` }),
    el('div.scheme-grid', {}, allSchemes().map((s) => {
      const remove = s.builtIn ? '' : el('span.remove', { title: 'Remove', on: { click: (e) => {
        e.stopPropagation();
        settings.schemes = settings.schemes.filter((x) => x.id !== s.id);
        for (const pr of settings.profiles) if (pr.scheme === s.id) pr.scheme = 'snake';
        save(); draw();
      } } }, icon('close'));
      return el(`button.scheme${current.scheme === s.id ? '.on' : ''}`, { on: { click: () => { current.scheme = s.id; save(); draw(); } } },
        preview(s), el('div.scheme-name', {}, s.name, remove));
    })),
    el('div.prefs-actions', {}, el('button.btn', { on: { click: importSchemes } }, icon('plus'), 'Import colours…'),
      el('span.hint', { text: 'iTerm2 .itermcolors files, or Windows Terminal schemes (.json).' })),
  );
}

async function importSchemes() {
  const files = await window.snake.openScheme();
  let added = 0;
  for (const f of files) {
    try {
      const list = /<plist/i.test(f.text) ? [parseItermColors(f.text, f.name)] : parseJsonSchemes(f.text);
      for (const s of list) {
        if (BUILT_IN.some((b) => b.id === s.id)) s.id += '-imported';
        settings.schemes = settings.schemes.filter((x) => x.id !== s.id).concat(s);
        added++;
      }
    } catch (err) {
      toast(`${f.name}: ${err.message}`, { type: 'error' });
    }
  }
  if (added) { save(); draw(); toast(`Imported ${added} colour scheme${added > 1 ? 's' : ''}.`); }
}

// ---------------------------------------------------------------------------
function keys(page) {
  const rows = Object.keys(DEFAULT_KEYS).filter((id) => COMMAND_TITLES[id]).map((id) => {
    const box = el('input.input.keybox', {
      value: keysFor(id).join(', '), readonly: true, placeholder: 'none',
      on: {
        keydown: (e) => {
          e.preventDefault();
          e.stopPropagation();
          if (e.key === 'Escape') { box.blur(); return; }
          if (e.key === 'Backspace' || e.key === 'Delete') { settings.keys[id] = ''; }
          else { const k = eventKey(e); if (!k) return; settings.keys[id] = k; }
          box.value = keysFor(id).join(', ');
          rebuild(); save();
        },
      },
    });
    const reset = el('button.icon-btn.small', { title: 'Back to the default', hidden: settings.keys[id] == null, on: { click: () => { delete settings.keys[id]; rebuild(); save(); draw(); } } }, icon('refresh'));
    return el('div.key-row', {}, el('span', { text: COMMAND_TITLES[id] }), box, reset);
  });
  page.append(el('p.hint', { text: 'Click a shortcut and press the new keys. Backspace removes it.' }), el('div.key-list', {}, rows));
}

export { defaultProfile };
