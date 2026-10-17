// The Devices panel: connect to your other computers (and let them connect to this one).
import { el, icon, bus, platform } from './util.js';
import { settings, saveSettings, newHost, hostLabel, allSchemes } from './settings.js';
import { newTab, split } from './layout.js';
import { showMenu, toast, modal, prompt, field, confirmDialog } from './ui.js';
import { env } from './env.js';
import { TAB_COLORS } from './layout.js';

let panel;
let lists = {};
let nearby = [];
let scanned = [];
let scanning = false;
let local = null;
let configHosts = [];
let tail = { peers: [] };
let keyInfo = [];
let filter = '';

const OS_LABEL = { macos: 'Mac', windows: 'Windows', linux: 'Linux', android: 'Android', ios: 'iPhone' };

export function initDevices(container) {
  panel = container;
  const quick = el('input.input.quick', {
    placeholder: 'Connect to… (name, user@host or address)',
    spellcheck: 'false',
    on: {
      input: () => { filter = quick.value.trim().toLowerCase(); renderLists(); },
      keydown: (e) => {
        if (e.key === 'Enter' && quick.value.trim()) { quickConnect(quick.value.trim()); quick.value = ''; filter = ''; renderLists(); }
        if (e.key === 'Escape') { quick.value = ''; filter = ''; renderLists(); bus.emit('devices:close'); }
        e.stopPropagation();
      },
    },
  });
  lists = {
    here: el('div.dev-here'),
    saved: el('div.dev-list'),
    nearby: el('div.dev-list'),
    tailscale: el('div.dev-list'),
    config: el('div.dev-list'),
    keys: el('div.dev-keys'),
  };
  const section = (title, body, actions = []) => el('section.dev-section', { dataset: { name: title } },
    el('div.dev-section-head', {}, el('span', { text: title }), ...actions), body);
  panel.append(
    el('div.dev-head', {}, el('span.dev-title', { text: 'Devices' }),
      el('button.icon-btn', { title: 'Refresh', on: { click: () => refresh(true) } }, icon('refresh')),
      el('button.icon-btn', { title: 'Close', on: { click: () => bus.emit('devices:close') } }, icon('close'))),
    quick,
    el('div.dev-scroll', {},
      section('This computer', lists.here),
      section('Saved', lists.saved, [el('button.link-btn', { on: { click: () => editHost() } }, icon('plus'), 'Add')]),
      section('Nearby', lists.nearby, [el('button.link-btn.scan', { title: 'Look for computers with SSH on this network', on: { click: scanNetwork } }, icon('search'), 'Scan network')]),
      section('Tailscale', lists.tailscale),
      section('From ~/.ssh/config', lists.config),
      section('Key login', lists.keys)),
  );
  window.snake.devices.onNearby((list) => { nearby = list; renderLists(); });
  window.snake.devices.onScanFound((list) => { scanned = list; renderLists(); });
  bus.on('settings:changed', () => panel.isConnected && renderLists());
}

export function onOpen() {
  window.snake.devices.browse(true);
  refresh();
  setTimeout(() => panel.querySelector('.quick')?.focus(), 30);
}

export function onClose() {
  window.snake.devices.browse(false);
}

async function refresh(all = false) {
  const [l, cfg, ts, k] = await Promise.all([
    window.snake.devices.local(),
    window.snake.devices.sshConfig(),
    window.snake.devices.tailscale(),
    window.snake.devices.keys(),
  ]);
  local = l;
  configHosts = cfg;
  tail = ts;
  keyInfo = k;
  if (all) window.snake.devices.browse(true);
  renderHere();
  renderLists();
  renderKeys();
}

// ---------------------------------------------------------------------------
// This computer
// ---------------------------------------------------------------------------
function renderHere() {
  if (!local) return;
  if (local.os === 'android') {
    // A phone connects out; it does not take connections.
    lists.here.replaceChildren(
      el('div.dev-me', {}, el('strong', { text: local.hostname }), el('span.dev-os', { text: 'Android' })),
      el('div.dev-status', {}, el('span.dot'), 'Connect from here to your computers. Your computers show up below when they are on this network (or save them).'),
    );
    return;
  }
  const status = local.sshServer
    ? el('div.dev-status.on', {}, el('span.dot'), 'SSH is on: your other devices can connect to this one.')
    : el('div.dev-status', {}, el('span.dot'), 'SSH is off: this computer can connect out, but not be connected to.');
  const rows = local.addresses.slice(0, 4).map((a) => {
    const cmd = `ssh ${local.user}@${a.address}`;
    return el('div.dev-addr', {},
      el('code', { text: cmd }),
      el('span.dev-addr-kind', { text: a.tailscale ? 'Tailscale' : a.iface }),
      el('button.icon-btn.small', { title: 'Copy', on: { click: () => { window.snake.clipboard.write(cmd); toast('Copied. Paste it in a terminal on your other device.'); } } }, icon('copy')));
  });
  lists.here.replaceChildren(
    el('div.dev-me', {}, el('strong', { text: `${local.user}@${local.hostname}` }), el('span.dev-os', { text: OS_LABEL[local.os] || '' })),
    ...rows,
    status,
    local.sshServer ? '' : el('button.btn.primary.small', { on: { click: turnOnSsh } }, 'Let other devices connect…'),
    local.sshClient ? '' : el('div.dev-warn', { text: platform.win ? 'The ssh program is missing: Settings → System → Optional features → add "OpenSSH Client".' : 'The ssh program is missing: install OpenSSH.' }),
  );
}

async function turnOnSsh() {
  const how = await window.snake.devices.enableSshCommand();
  const body = el('div.stack', {},
    el('p', { text: 'Turning on SSH lets your other devices open a terminal on this computer. They still need your password or your key to get in.' }),
    el('ul.steps', {}, how.steps.map((s) => el('li', { text: s }))),
    how.command ? el('pre.cmd', { text: how.command }) : '');
  modal({
    title: 'Let other devices connect',
    body,
    buttons: [
      { label: 'Cancel' },
      how.settings
        ? { label: 'Open Sharing settings', primary: true, run: () => window.snake.devices.openSharingSettings() }
        : { label: 'Turn it on', primary: true, run: () => runSetup(how, 'Turn on SSH') },
    ],
  });
}

async function runSetup(how, title) {
  const tab = await newTab({ command: [how.file, ...how.args], title, keepOpen: true });
  tab.active.on('exit', () => setTimeout(refresh, 800));
}

// ---------------------------------------------------------------------------
// Lists
// ---------------------------------------------------------------------------
function matches(...texts) {
  return !filter || texts.some((t) => String(t || '').toLowerCase().includes(filter));
}

function row({ title, subtitle, os, color, connect, menu, badge }) {
  const r = el('div.dev-row', { tabindex: '0', on: {
    click: (e) => { if (!e.target.closest('button')) connect(); },
    keydown: (e) => { if (e.key === 'Enter') connect(); },
    contextmenu: (e) => { e.preventDefault(); menu && showMenu(menu(), { x: e.clientX, y: e.clientY }); },
  } },
  el('span.dev-dot', { style: { background: color || 'var(--fg3)' } }),
  el('div.dev-text', {}, el('div.dev-name', {}, title, badge ? el('span.dev-badge', { text: badge }) : ''), subtitle ? el('div.dev-sub', { text: subtitle }) : ''),
  os ? el('span.dev-os', { text: OS_LABEL[os] || os }) : '',
  el('button.icon-btn.small.go', { title: 'Connect', on: { click: connect } }, icon('right')),
  menu ? el('button.icon-btn.small', { title: 'More', on: { click: (e) => showMenu(menu(), e.currentTarget) } }, icon('more')) : '');
  return r;
}

function renderLists() {
  // Saved
  const saved = settings.hosts.filter((h) => matches(h.name, h.host, h.user));
  lists.saved.replaceChildren(...saved.map((h) => row({
    title: hostLabel(h),
    subtitle: `${h.user ? h.user + '@' : ''}${h.host}${h.port && Number(h.port) !== 22 ? ':' + h.port : ''}${h.keyReady ? ' · key login' : ''}`,
    os: h.os !== 'auto' ? h.os : '',
    color: h.color || 'var(--accent)',
    connect: () => connect(h),
    menu: () => hostMenu(h),
  })), saved.length ? '' : el('div.dev-empty', { text: filter ? 'No saved device matches.' : 'Devices you save show up here. Connect to one from Nearby, then save it.' }));

  // Nearby: announced (mDNS) and found by a scan, one row per address
  const byAddr = new Map();
  for (const d of nearby) byAddr.set(d.address || d.host, { ...d });
  for (const s of scanned) {
    const prev = byAddr.get(s.address);
    byAddr.set(s.address, { ...s, ...prev, name: prev?.name || s.name || s.address, os: prev?.os || s.os });
  }
  const near = [...byAddr.values()].filter((d) => matches(d.name, d.address, d.host, d.user));
  lists.nearby.replaceChildren(...near.map((d) => row({
    title: d.name || d.address,
    subtitle: [d.user && `${d.user}@`, d.host && !/\d+\.\d+\.\d+\.\d+/.test(d.host) ? d.host : d.address].filter(Boolean).join(''),
    os: d.os,
    badge: d.snake ? 'Snake\'s Terminal' : '',
    connect: () => connectDiscovered(d),
    menu: () => [
      { label: 'Connect', icon: 'right', run: () => connectDiscovered(d) },
      { label: 'Connect in a split', icon: 'splitRight', run: () => connectDiscovered(d, true) },
      { label: 'Save…', icon: 'star', run: () => editHost({ name: d.name, host: d.address || d.host, user: d.user || '', port: d.port || 22, os: d.os || 'auto' }) },
    ],
  })), near.length ? '' : el('div.dev-empty', { text: scanning ? 'Looking…' : 'Nothing announced itself yet. Macs with Remote Login on, Linux with Avahi, and other copies of Snake\'s Terminal show up here; "Scan network" finds the rest.' }));
  panel.querySelector('.scan')?.classList.toggle('busy', scanning);

  // Tailscale
  const tsSection = panel.querySelector('[data-name="Tailscale"]');
  tsSection.hidden = !tail.installed;
  const peers = (tail.peers || []).filter((p) => matches(p.name, p.dns, p.address));
  lists.tailscale.replaceChildren(...peers.map((p) => row({
    title: p.name,
    subtitle: `${p.dns || p.address}${p.online ? '' : ' · offline'}`,
    os: p.os,
    color: p.online ? '#58a6ff' : 'var(--fg3)',
    connect: () => connectDiscovered({ name: p.name, address: p.dns || p.address, os: p.os }),
    menu: () => [
      { label: 'Connect', icon: 'right', run: () => connectDiscovered({ name: p.name, address: p.dns || p.address, os: p.os }) },
      { label: 'Save…', icon: 'star', run: () => editHost({ name: p.name, host: p.dns || p.address, os: p.os || 'auto' }) },
    ],
  })), tail.installed && !tail.running ? el('div.dev-empty', { text: 'Tailscale is installed but not connected.' }) : '');

  // ~/.ssh/config
  const cfg = configHosts.filter((h) => matches(h.alias, h.hostname, h.user));
  panel.querySelector('[data-name="From ~/.ssh/config"]').hidden = !configHosts.length;
  lists.config.replaceChildren(...cfg.map((h) => row({
    title: h.alias,
    subtitle: [h.user && `${h.user}@`, h.hostname || h.alias, h.port && h.port !== 22 ? `:${h.port}` : ''].filter(Boolean).join(''),
    connect: () => connect({ name: h.alias, alias: h.alias, host: h.hostname || h.alias, user: h.user || '' }),
    menu: () => [
      { label: 'Connect', icon: 'right', run: () => connect({ name: h.alias, alias: h.alias, host: h.hostname || h.alias }) },
      { label: 'Connect in a split', icon: 'splitRight', run: () => connect({ name: h.alias, alias: h.alias, host: h.hostname || h.alias }, true) },
    ],
  })));
}

async function scanNetwork() {
  if (scanning) return;
  scanning = true;
  scanned = [];
  renderLists();
  try {
    const r = await window.snake.devices.scan();
    scanned = r.found;
    toast(`Checked ${r.scanned} addresses on this network: ${r.found.length} with SSH on.`);
  } finally {
    scanning = false;
    renderLists();
  }
}

function renderKeys() {
  const k = keyInfo[0];
  lists.keys.replaceChildren(
    k ? el('div.dev-key', {}, icon('key'), el('span', { text: `${k.name} (${k.type.replace('ssh-', '')})` }), el('button.icon-btn.small', { title: 'Copy the public key', on: { click: () => { window.snake.clipboard.write(k.line); toast('Public key copied.'); } } }, icon('copy')))
      : el('div.dev-empty', { text: 'No key yet. With a key, devices let you in without typing a password; "Set up key login" on a device makes one.' }),
  );
}

function hostMenu(h) {
  return [
    { label: 'Connect', icon: 'right', run: () => connect(h) },
    { label: 'Connect in a split', icon: 'splitRight', run: () => connect(h, true) },
    { label: 'Set up key login…', icon: 'key', run: () => setupKeyLogin(h) },
    { label: 'Copy ssh command', icon: 'copy', run: () => window.snake.clipboard.write(sshCommand(h)) },
    { separator: true },
    { label: 'Edit…', icon: 'edit', run: () => editHost(h) },
    { label: 'Delete', icon: 'trash', danger: true, run: async () => {
      if (await confirmDialog({ title: 'Delete device', message: `Forget "${hostLabel(h)}"? Its keys and files are not touched.`, ok: 'Delete', danger: true })) {
        settings.hosts = settings.hosts.filter((x) => x !== h);
        saveSettings();
      }
    } },
  ];
}

const sshCommand = (h) => ['ssh', h.port && Number(h.port) !== 22 ? `-p ${h.port}` : '', h.jump ? `-J ${h.jump}` : '', h.alias || (h.user ? `${h.user}@${h.host}` : h.host)].filter(Boolean).join(' ');

// ---------------------------------------------------------------------------
// Connecting
// ---------------------------------------------------------------------------
export function connect(host, inSplit = false) {
  bus.emit('devices:close');
  return inSplit ? split('right', { host }) : newTab({ host });
}

async function connectDiscovered(d, inSplit = false) {
  const saved = settings.hosts.find((h) => h.host === d.address || h.host === d.host);
  if (saved) return connect(saved, inSplit);
  let user = d.user;
  if (!user) {
    user = await prompt({ title: `Connect to ${d.name || d.address}`, message: 'Your user name on that computer:', value: env.user, ok: 'Connect' });
    if (!user) return null;
  }
  return connect({ name: d.name || d.address, host: d.address || d.host, user, port: d.port || 22, os: d.os || 'auto' }, inSplit);
}

/** "name", "user@host", "host:2222" or "user@host:port". */
async function quickConnect(text) {
  const saved = settings.hosts.find((h) => hostLabel(h).toLowerCase() === text.toLowerCase() || h.name.toLowerCase() === text.toLowerCase());
  if (saved) return connect(saved);
  const cfg = configHosts.find((h) => h.alias.toLowerCase() === text.toLowerCase());
  if (cfg) return connect({ name: cfg.alias, alias: cfg.alias, host: cfg.hostname || cfg.alias });
  const m = /^(?:([^@\s]+)@)?(\[[^\]]+\]|[^:\s]+)(?::(\d+))?$/.exec(text);
  if (!m) { toast('Type a device name, user@host or an address.', { type: 'error' }); return null; }
  const found = [...nearby, ...scanned].find((d) => (d.name || '').toLowerCase() === m[2].toLowerCase());
  if (found && !m[1]) return connectDiscovered(found);
  return connect({ name: '', host: m[2].replace(/^\[|\]$/g, ''), user: m[1] || '', port: Number(m[3]) || 22 });
}

/** Put this computer's key on a device, so it stops asking for a password. */
export async function setupKeyLogin(h) {
  if (!keyInfo.length) {
    const ok = await confirmDialog({ title: 'Set up key login', message: 'This computer has no SSH key yet. Make one now? It stays in your ~/.ssh folder; only its public half is copied to the other device.', ok: 'Make a key' });
    if (!ok) return;
  }
  const r = await window.snake.devices.installKeyCommand(h);
  if (!r.ok) { toast(r.error, { type: 'error' }); return; }
  if (r.created) toast('Made a key: ~/.ssh/id_ed25519.');
  bus.emit('devices:close');
  const tab = await newTab({ command: [r.file, ...r.args], title: `Key login · ${hostLabel(h)}`, keepOpen: true });
  tab.active.term.write(`\x1b[2mCopying your public key to ${hostLabel(h)}. Type that computer's password once when it asks.\x1b[0m\r\n\r\n`);
  tab.active.on('exit', (_s, _kind, code) => {
    if (code === 0) {
      if (settings.hosts.includes(h)) { h.keyReady = true; saveSettings(); }
      toast(`Key login is set up: ${hostLabel(h)} will not ask for a password any more.`, { type: 'success' });
    }
  });
  keyInfo = await window.snake.devices.keys();
  renderKeys();
}

export function editHost(existing) {
  const isNew = !existing || !settings.hosts.includes(existing);
  const h = { name: '', host: '', user: '', port: 22, identity: '', jump: '', os: 'auto', color: '', scheme: '', ...(existing || {}) };
  const input = (key, attrs = {}) => el('input.input', { value: h[key] ?? '', spellcheck: 'false', ...attrs, on: { input: (e) => { h[key] = e.target.value; } } });
  const select = (key, options) => {
    const s = el('select.input', { on: { change: (e) => { h[key] = e.target.value; } } }, options.map(([v, label]) => el('option', { value: v, text: label, selected: (h[key] || '') === v })));
    return s;
  };
  const body = el('div.form', {},
    field('Name', input('name', { placeholder: 'My laptop' })),
    field('Address', input('host', { placeholder: '192.168.1.20, laptop.local or a server name' })),
    el('div.row2', {},
      field('User', input('user', { placeholder: env.user })),
      field('Port', input('port', { type: 'number', min: 1, max: 65535, style: { width: '90px' } }))),
    field('Key file', input('identity', { placeholder: 'optional, e.g. ~/.ssh/work_key' }), 'Leave empty to use your usual keys.'),
    field('Jump host', input('jump', { placeholder: 'optional: user@gateway' }), 'Connect through another computer first (ssh -J).'),
    el('div.row2', {},
      field('System', select('os', [['auto', 'Unknown'], ['linux', 'Linux'], ['macos', 'Mac'], ['windows', 'Windows']]), 'Windows needs its own way to set up key login.'),
      field('Colours', select('scheme', [['', 'Same as the profile'], ...allSchemes().map((s) => [s.id, s.name])]))),
    field('Tab colour', el('div.swatches', {}, TAB_COLORS.map((c) => el(`button.swatch${(h.color || '') === c ? '.on' : ''}`, {
      title: c || 'None', style: { background: c || 'transparent' },
      on: { click: (e) => { h.color = c; e.currentTarget.parentElement.querySelectorAll('.swatch').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); } },
    })))),
  );
  modal({
    title: isNew ? 'Save a device' : `Edit ${hostLabel(existing)}`,
    body,
    buttons: [
      { label: 'Cancel' },
      { label: isNew ? 'Save' : 'Save changes', primary: true, run: () => {
        if (!String(h.host).trim()) { toast('The address is needed.', { type: 'error' }); return false; }
        h.host = String(h.host).trim();
        h.port = Number(h.port) || 22;
        if (isNew) newHost(h); else Object.assign(existing, h);
        saveSettings();
        renderLists();
        return true;
      } },
    ],
  });
}
