// Settings: profiles, saved hosts, colour schemes and preferences, saved by the main process.
import { bus, uid, platform } from './util.js';
import { BUILT_IN } from './themes.js';

export const FONT_FALLBACK = '"Symbols Nerd Font Mono", "MesloLGS NF", "Hack Nerd Font Mono", "JetBrainsMono Nerd Font", "FiraCode Nerd Font", "Cascadia Code", "Menlo", "Consolas", "DejaVu Sans Mono", monospace';

export function defaultProfile() {
  return {
    id: 'default',
    name: 'Default',
    shell: '', // '' = this computer's usual shell
    args: '',
    cwd: 'inherit', // 'home', 'inherit' (the folder of the pane you split from) or a path
    scheme: 'snake',
    fontFamily: 'JetBrains Mono',
    fontSize: platform.mac ? 13 : 14,
    lineHeight: 1.15,
    cursorStyle: 'block',
    cursorBlink: true,
    scrollback: 10000,
    color: '',
  };
}

const DEFAULTS = () => ({
  profiles: [defaultProfile()],
  defaultProfile: 'default',
  hosts: [],
  schemes: [], // imported ones
  startup: 'restore', // 'restore' the tabs of last time, or 'new'
  confirmClose: true,
  copyOnSelect: true,
  copyNotice: true, // a small "Copied" sign when selecting copies
  copyTrim: true, // no spaces at the ends of copied lines
  rightClick: 'menu', // 'menu', 'paste', or 'smart' (copy the selection if there is one, else paste)
  wordSeparators: ` ()[]{}',"\`│`, // what a double-click word stops at
  pasteWarning: true,
  bell: 'visual', // 'visual', 'sound', 'none'
  hotkey: '',
  advertise: true,
  optionAsMeta: false,
  keys: {},
  devicesOpen: false,
  menuBar: false, // the full menu bar under the title bar, besides the ☰ button
});

export const DEFAULT_WORD_SEPARATORS = DEFAULTS().wordSeparators;

export let settings = DEFAULTS();

export function loadSettings(saved) {
  const d = DEFAULTS();
  settings = { ...d, ...(saved || {}) };
  const base = defaultProfile();
  settings.profiles = (Array.isArray(settings.profiles) && settings.profiles.length ? settings.profiles : d.profiles).map((p) => ({ ...base, ...p }));
  if (!settings.profiles.some((p) => p.id === settings.defaultProfile)) settings.defaultProfile = settings.profiles[0].id;
  settings.hosts = Array.isArray(settings.hosts) ? settings.hosts : [];
  settings.schemes = Array.isArray(settings.schemes) ? settings.schemes : [];
  settings.keys = settings.keys && typeof settings.keys === 'object' ? settings.keys : {};
  return settings;
}

let saving = null;
export async function saveSettings() {
  // One save at a time; the latest settings win.
  const run = async () => {
    const r = await window.snake.setSettings(JSON.parse(JSON.stringify(settings)));
    bus.emit('settings:changed', settings);
    return r;
  };
  saving = (saving || Promise.resolve()).then(run, run);
  return saving;
}

export function update(patch) {
  Object.assign(settings, patch);
  return saveSettings();
}

export const allSchemes = () => [...BUILT_IN, ...settings.schemes];
export const schemeById = (id) => allSchemes().find((s) => s.id === id) || BUILT_IN[0];
export const profileById = (id) => settings.profiles.find((p) => p.id === id) || settings.profiles.find((p) => p.id === settings.defaultProfile) || settings.profiles[0];
export const defaultProfileObj = () => profileById(settings.defaultProfile);

export function newProfile(from) {
  const p = { ...(from || defaultProfile()), id: uid(), name: from ? `${from.name} copy` : 'New profile' };
  settings.profiles.push(p);
  return p;
}

export function newHost(fields) {
  const h = { id: uid(), name: '', host: '', user: '', port: 22, identity: '', jump: '', os: 'auto', color: '', profile: '', ...fields };
  settings.hosts.push(h);
  return h;
}

export const hostLabel = (h) => h.name || (h.user ? `${h.user}@${h.host}` : h.host);
