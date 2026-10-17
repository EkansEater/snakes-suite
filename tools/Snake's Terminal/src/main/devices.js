// Devices: everything the "connect to another computer" side of Snake's Terminal needs.
// SSH itself is the computer's own OpenSSH client (built into macOS, Windows 10/11 and
// Linux), run in a terminal tab, so keys, the agent, ~/.ssh/config and known hosts work
// exactly as they do everywhere else. This file finds hosts and prepares commands.
const fs = require('fs');
const fsp = require('fs/promises');
const net = require('net');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const WIN = process.platform === 'win32';
const MAC = process.platform === 'darwin';
const SSH_DIR = path.join(os.homedir(), '.ssh');

/** The full path of a program on the PATH (with Windows' .exe endings), or null. */
function which(name) {
  const exts = WIN ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').map((x) => x.toLowerCase()) : [''];
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  if (!WIN) dirs.push('/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin');
  for (const d of dirs) {
    for (const ext of exts) {
      const full = path.join(d, name + (WIN && !name.toLowerCase().endsWith(ext) ? ext : ''));
      try { if (fs.statSync(full).isFile()) return full; } catch {}
    }
  }
  return null;
}

function sshPath() {
  if (WIN) {
    const builtIn = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh.exe');
    if (fs.existsSync(builtIn)) return builtIn;
  }
  return which('ssh');
}

function run(file, args, { timeout = 8000, input } = {}) {
  return new Promise((resolve) => {
    const child = execFile(file, args, { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout), stderr: String(stderr), error: err && err.code === 'ENOENT' ? 'not found' : null });
    });
    if (input != null) { child.stdin.end(input); }
  });
}

// ---------------------------------------------------------------------------
// This computer
// ---------------------------------------------------------------------------
function addresses() {
  const out = [];
  for (const [iface, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.internal || a.family !== 'IPv4' || a.address.startsWith('169.254.')) continue;
      out.push({ iface, address: a.address, netmask: a.netmask, cidr: a.cidr, tailscale: /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(a.address) || /tailscale/i.test(iface) });
    }
  }
  // Home and office networks first, VPNs and containers last.
  const rank = (a) => (a.tailscale ? 2 : /^(docker|br-|veth|virbr|vmnet|vboxnet|lxc|cni)/.test(a.iface) ? 3 : 0);
  return out.sort((a, b) => rank(a) - rank(b));
}

function portOpen(host, port = 22, timeout = 600) {
  return new Promise((resolve) => {
    const sock = net.connect({ host, port });
    let banner = '';
    const done = (open) => { sock.destroy(); resolve(open ? { open: true, banner: banner.trim() } : { open: false }); };
    sock.setTimeout(timeout, () => done(!!banner || sock.readyState === 'open'));
    sock.on('connect', () => setTimeout(() => done(true), 350));
    sock.on('data', (d) => { banner += d.toString('latin1'); if (banner.includes('\n')) done(true); });
    sock.on('error', () => done(false));
  });
}

async function local() {
  const ssh = await portOpen('127.0.0.1', 22, 500);
  return {
    hostname: os.hostname().replace(/\.local$/, ''),
    user: os.userInfo().username,
    os: WIN ? 'windows' : MAC ? 'macos' : 'linux',
    addresses: addresses(),
    sshServer: ssh.open,
    sshBanner: ssh.banner || '',
    sshClient: !!sshPath(),
  };
}

// ---------------------------------------------------------------------------
// ~/.ssh/config and keys
// ---------------------------------------------------------------------------
async function readConfig(file, depth = 0, seen = new Set()) {
  if (depth > 4 || seen.has(file)) return [];
  seen.add(file);
  let text;
  try { text = await fsp.readFile(file, 'utf8'); } catch { return []; }
  const hosts = [];
  let current = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, '').trim();
    if (!line) continue;
    const m = /^(\S+)\s*(?:=\s*|\s+)(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim().replace(/^"(.*)"$/, '$1');
    if (key === 'include') {
      for (const pattern of value.split(/\s+/)) {
        const p = pattern.replace(/^~(?=\/|\\|$)/, os.homedir());
        const full = path.isAbsolute(p) ? p : path.join(SSH_DIR, p);
        const dir = path.dirname(full);
        const base = path.basename(full);
        const rx = new RegExp('^' + base.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
        let names = [];
        try { names = (await fsp.readdir(dir)).filter((n) => rx.test(n)).sort(); } catch {}
        for (const n of names) hosts.push(...await readConfig(path.join(dir, n), depth + 1, seen));
      }
    } else if (key === 'host') {
      current = value.split(/\s+/).filter((h) => !/[*?!]/.test(h)).map((alias) => ({ alias }));
      hosts.push(...current);
    } else if (key === 'match') {
      current = [];
    } else {
      for (const h of current) {
        if (key === 'hostname') h.hostname ??= value;
        else if (key === 'user') h.user ??= value;
        else if (key === 'port') h.port ??= Number(value) || undefined;
        else if (key === 'identityfile') h.identity ??= value;
        else if (key === 'proxyjump') h.jump ??= value;
      }
    }
  }
  return hosts;
}

async function sshConfig() {
  const list = await readConfig(path.join(SSH_DIR, 'config'));
  const seen = new Set();
  return list.filter((h) => !seen.has(h.alias) && seen.add(h.alias));
}

/** A public key line, with a comment safe to put inside quotes on any remote shell. */
function safeKeyLine(line) {
  const [type, data, ...rest] = line.trim().split(/\s+/);
  if (!/^(ssh-|ecdsa-|sk-)[\w@.-]+$/.test(type || '') || !/^[A-Za-z0-9+/=]+$/.test(data || '')) return null;
  const comment = rest.join(' ').replace(/[^\w@.\-() ]/g, '').slice(0, 80);
  return [type, data, comment].filter(Boolean).join(' ');
}

async function keys() {
  let names = [];
  try { names = (await fsp.readdir(SSH_DIR)).filter((n) => n.endsWith('.pub')); } catch {}
  const out = [];
  for (const n of names.sort()) {
    try {
      const line = safeKeyLine(await fsp.readFile(path.join(SSH_DIR, n), 'utf8'));
      if (line) out.push({ file: path.join(SSH_DIR, n), name: n.replace(/\.pub$/, ''), type: line.split(' ')[0], comment: line.split(' ').slice(2).join(' '), line });
    } catch {}
  }
  // The usual preference: ed25519 first.
  const order = ['id_ed25519', 'id_ecdsa', 'id_rsa'];
  return out.sort((a, b) => (order.indexOf(a.name) + 1 || 9) - (order.indexOf(b.name) + 1 || 9));
}

/** Make ~/.ssh/id_ed25519 (no passphrase) if there is no key yet; returns the key to share. */
async function makeKey() {
  const existing = await keys();
  if (existing.length) return { ok: true, key: existing[0], created: false };
  const keygen = WIN ? path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'OpenSSH', 'ssh-keygen.exe') : which('ssh-keygen');
  if (!keygen || !fs.existsSync(keygen)) return { ok: false, error: 'ssh-keygen was not found: install OpenSSH first.' };
  await fsp.mkdir(SSH_DIR, { recursive: true, mode: 0o700 });
  const file = path.join(SSH_DIR, 'id_ed25519');
  const comment = `${os.userInfo().username}@${os.hostname().replace(/\.local$/, '')} (Snake's Terminal)`.replace(/[^\w@.\-() ]/g, '');
  const r = await run(keygen, ['-q', '-t', 'ed25519', '-N', '', '-C', comment, '-f', file], { timeout: 20000 });
  if (r.code !== 0) return { ok: false, error: (r.stderr || r.stdout || 'ssh-keygen failed').trim() };
  return { ok: true, key: (await keys())[0], created: true };
}

function sshArgs(host) {
  const args = [];
  if (host.port && Number(host.port) !== 22) args.push('-p', String(host.port | 0));
  if (host.identity) args.push('-i', String(host.identity));
  if (host.jump) args.push('-J', String(host.jump));
  args.push(host.user ? `${host.user}@${host.host}` : String(host.host));
  return args;
}

/** The command (run in a tab, so you can answer the password prompt) that puts your key on `host`. */
async function installKeyCommand(host) {
  const made = await makeKey();
  if (!made.ok) return made;
  const ssh = sshPath();
  if (!ssh) return { ok: false, error: 'The ssh program was not found.' };
  const key = made.key.line;
  let remote;
  if (host.os === 'windows') {
    // Windows' OpenSSH server: administrators use one shared file with strict permissions.
    const ps = [
      `$k = '${key}'`,
      '$admin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)',
      'if ($admin) { $f = Join-Path $env:ProgramData "ssh\\administrators_authorized_keys" } else { New-Item -Force -ItemType Directory (Join-Path $HOME ".ssh") | Out-Null; $f = Join-Path $HOME ".ssh\\authorized_keys" }',
      'if (-not (Test-Path $f) -or -not (Select-String -Quiet -SimpleMatch -Pattern $k -Path $f)) { Add-Content -Path $f -Value $k }',
      'if ($admin) { icacls $f /inheritance:r /grant "Administrators:F" /grant "SYSTEM:F" | Out-Null }',
      'Write-Output "Key login is set up."',
    ].join('; ');
    remote = `powershell -NoProfile -EncodedCommand ${Buffer.from(ps, 'utf16le').toString('base64')}`;
  } else {
    remote = `umask 077; mkdir -p ~/.ssh && touch ~/.ssh/authorized_keys && (grep -qxF '${key}' ~/.ssh/authorized_keys || echo '${key}' >> ~/.ssh/authorized_keys) && echo 'Key login is set up.'`;
  }
  return { ok: true, file: ssh, args: [...sshArgs(host), remote], created: made.created, key: made.key };
}

/** How to let other devices connect to this one (turn on its SSH server). */
async function enableSshCommand() {
  if (MAC) {
    return { os: 'macos', steps: ['Open System Settings → General → Sharing.', 'Turn on Remote Login.'], settings: true };
  }
  if (WIN) {
    const ps = [
      '$c = Get-WindowsCapability -Online -Name OpenSSH.Server*',
      'if ($c.State -ne "Installed") { Write-Output "Installing OpenSSH Server (a minute or two)..."; Add-WindowsCapability -Online -Name $c.Name | Out-Null }',
      'Set-Service -Name sshd -StartupType Automatic; Start-Service sshd',
      'if (-not (Get-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -ErrorAction SilentlyContinue)) { New-NetFirewallRule -Name "OpenSSH-Server-In-TCP" -DisplayName "OpenSSH Server (sshd)" -Enabled True -Direction Inbound -Protocol TCP -Action Allow -LocalPort 22 | Out-Null }',
      'Write-Output "SSH is on. Other devices can connect now."; Read-Host "Press Enter to close"',
    ].join('; ');
    const inner = Buffer.from(ps, 'utf16le').toString('base64');
    const powershell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    return {
      os: 'windows',
      steps: ['Windows asks for permission (it changes a system setting), then installs and starts OpenSSH Server.'],
      file: powershell,
      args: ['-NoProfile', '-Command', `Start-Process powershell -Verb RunAs -ArgumentList '-NoProfile','-EncodedCommand','${inner}'; Write-Output 'Answer the Windows prompt to continue.'`],
    };
  }
  const sshd = ['/usr/bin/sshd', '/usr/sbin/sshd'].some((p) => fs.existsSync(p));
  const unit = ['sshd', 'ssh'].find((u) => ['/usr/lib/systemd/system', '/lib/systemd/system', '/etc/systemd/system'].some((d) => fs.existsSync(path.join(d, `${u}.service`)))) || 'sshd';
  let install = '';
  if (!sshd) {
    if (which('pacman')) install = 'sudo pacman -S --needed openssh && ';
    else if (which('apt')) install = 'sudo apt install -y openssh-server && ';
    else if (which('dnf')) install = 'sudo dnf install -y openssh-server && ';
    else if (which('zypper')) install = 'sudo zypper install -y openssh-server && ';
  }
  const unitAfter = !sshd && which('apt') ? 'ssh' : unit;
  const command = `${install}sudo systemctl enable --now ${unitAfter} && echo && echo 'SSH is on. Other devices can connect now.'`;
  return {
    os: 'linux',
    steps: [sshd ? 'Starts the SSH server and turns it on at every startup.' : 'Installs OpenSSH, then starts its server and turns it on at every startup.', 'It asks for your password (sudo).'],
    command,
    file: '/bin/sh',
    args: ['-c', `${command}; echo; printf 'Press Enter to close. '; read _`],
  };
}

// ---------------------------------------------------------------------------
// Tailscale: your devices anywhere, not only on this network
// ---------------------------------------------------------------------------
async function tailscale() {
  const candidates = [which('tailscale'), MAC && '/Applications/Tailscale.app/Contents/MacOS/Tailscale', WIN && 'C:\\Program Files\\Tailscale\\tailscale.exe'].filter(Boolean);
  const bin = candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
  if (!bin) return { installed: false, peers: [] };
  const r = await run(bin, ['status', '--json'], { timeout: 5000 });
  if (r.code !== 0) return { installed: true, running: false, peers: [] };
  try {
    const s = JSON.parse(r.stdout);
    const peers = Object.values(s.Peer || {}).map((p) => ({
      name: p.HostName, dns: String(p.DNSName || '').replace(/\.$/, ''), address: (p.TailscaleIPs || [])[0], os: p.OS, online: !!p.Online,
    })).filter((p) => p.address).sort((a, b) => Number(b.online) - Number(a.online) || a.name.localeCompare(b.name));
    return { installed: true, running: true, self: s.Self?.HostName, peers };
  } catch {
    return { installed: true, running: false, peers: [] };
  }
}

// ---------------------------------------------------------------------------
// Scan this network for SSH servers (for computers that do not announce themselves)
// ---------------------------------------------------------------------------
let scanning = null;
function hostsOf(a) {
  const ip = a.address.split('.').map(Number);
  const mask = a.netmask.split('.').map(Number);
  const toInt = (x) => ((x[0] << 24) >>> 0) + (x[1] << 16) + (x[2] << 8) + x[3];
  let net = toInt(ip.map((b, i) => b & mask[i]));
  let size = 2 ** (32 - (a.cidr ? Number(a.cidr.split('/')[1]) : 24));
  if (size > 1024) { net = toInt([ip[0], ip[1], ip[2], 0]); size = 256; } // big networks: only the nearby /24
  const self = toInt(ip);
  const out = [];
  for (let i = 1; i < size - 1; i++) {
    const n = net + i;
    if (n !== self) out.push([n >>> 24, (n >> 16) & 255, (n >> 8) & 255, n & 255].join('.'));
  }
  return out;
}

async function scan(onFound) {
  if (scanning) return scanning;
  scanning = (async () => {
    const targets = [...new Set(addresses().filter((a) => !a.tailscale && !/^(docker|br-|veth|virbr|lxc|cni)/.test(a.iface)).flatMap(hostsOf))];
    const found = [];
    let next = 0;
    const worker = async () => {
      while (next < targets.length) {
        const host = targets[next++];
        const r = await portOpen(host, 22, 700);
        if (r.open) {
          const banner = r.banner.replace(/^SSH-[\d.]+-/, '');
          found.push({ address: host, banner, os: /windows/i.test(banner) ? 'windows' : /ubuntu|debian|raspbian|fedora|arch|linux/i.test(banner) ? 'linux' : /apple|darwin/i.test(banner) ? 'macos' : '' });
          onFound([...found]);
        }
      }
    };
    await Promise.all(Array.from({ length: 64 }, worker));
    // Names, where the network's DNS knows them.
    const dns = require('dns').promises;
    await Promise.all(found.map(async (f) => {
      try { f.name = (await Promise.race([dns.reverse(f.address), new Promise((_, rej) => setTimeout(rej, 1500))]))[0]; } catch {}
    }));
    return { scanned: targets.length, found };
  })();
  try { return await scanning; } finally { scanning = null; }
}

// ---------------------------------------------------------------------------
// mDNS (Bonjour): Macs with Remote Login on, Linux with Avahi, and other Snake's Terminals
// ---------------------------------------------------------------------------
const SSH_SERVICE = '_ssh._tcp.local';
const OUR_SERVICE = '_snaketerm._tcp.local';
let mdns = null;
let browseCb = null;
let browseTimer = null;
let advertising = false;
let advertiseTimer = null;
let sshOnHere = false;
const seen = new Map(); // instance name -> device

function ensureMdns() {
  if (mdns) return mdns;
  try {
    mdns = require('multicast-dns')({ reuseAddr: true });
  } catch (err) {
    console.error('mDNS unavailable:', err.message);
    return null;
  }
  mdns.on('error', () => {});
  mdns.on('warning', () => {});
  mdns.on('response', onResponse);
  mdns.on('query', onQuery);
  return mdns;
}

function releaseMdns() {
  if (mdns && !browseCb && !advertising) { try { mdns.destroy(); } catch {} mdns = null; }
}

function onResponse(res, rinfo) {
  if (!browseCb) return;
  const records = [...(res.answers || []), ...(res.additionals || [])];
  const byName = (name, type) => records.filter((r) => r.name === name && r.type === type);
  let changed = false;
  for (const ptr of records.filter((r) => r.type === 'PTR' && (r.name === SSH_SERVICE || r.name === OUR_SERVICE))) {
    const instance = String(ptr.data);
    if (ptr.ttl === 0) { if (seen.delete(instance)) changed = true; continue; }
    const srv = byName(instance, 'SRV')[0];
    const txt = byName(instance, 'TXT')[0];
    const kv = {};
    for (const b of (txt?.data || [])) {
      const s = Buffer.isBuffer(b) ? b.toString('utf8') : String(b);
      const i = s.indexOf('=');
      if (i > 0) kv[s.slice(0, i)] = s.slice(i + 1);
    }
    const target = srv?.data?.target;
    const a = target ? byName(target, 'A')[0] : null;
    const prev = seen.get(instance) || {};
    const label = instance.slice(0, -(ptr.name.length + 1)).replace(/\\032/g, ' ');
    const device = {
      ...prev,
      id: instance,
      name: kv.name || label || prev.name,
      host: target ? target.replace(/\.$/, '') : prev.host,
      address: a?.data || prev.address || rinfo?.address,
      port: srv?.data?.port || prev.port || 22,
      user: kv.user || prev.user,
      os: kv.os || prev.os,
      snake: ptr.name === OUR_SERVICE || prev.snake,
      seen: Date.now(),
    };
    if (device.address && advertisingSelf(device)) continue;
    seen.set(instance, device);
    changed = true;
    // Ask for what the answer left out: where it is (SRV), then its address (A).
    if (!srv) mdns?.query({ questions: [{ name: instance, type: 'SRV' }] });
    else if (!a && target) mdns?.query({ questions: [{ name: target, type: 'A' }] });
  }
  // A late SRV or A answer completes a device already listed.
  for (const r of records) {
    for (const d of seen.values()) {
      if (r.type === 'SRV' && r.name === d.id && r.data?.target) { d.host = r.data.target.replace(/\.$/, ''); d.port = r.data.port || d.port; changed = true; }
      if (r.type === 'A' && d.host && r.name.replace(/\.$/, '') === d.host) { d.address = r.data; changed = true; }
    }
  }
  if (changed) report();
}

/** This computer's own announcements (its Avahi, or this app) are not "nearby devices". */
function advertisingSelf(device) {
  return addresses().some((a) => a.address === device.address);
}

function report() {
  const now = Date.now();
  for (const [k, d] of seen) if (now - d.seen > 90000) seen.delete(k);
  // One entry per computer: a Snake's Terminal announcement wins over the plain SSH one.
  const merged = new Map();
  for (const d of seen.values()) {
    const key = d.address || d.host;
    const prev = merged.get(key);
    if (!prev || (d.snake && !prev.snake)) merged.set(key, { ...prev, ...d, user: d.user || prev?.user });
  }
  browseCb?.([...merged.values()].sort((a, b) => a.name.localeCompare(b.name)));
}

function query() {
  ensureMdns()?.query({ questions: [{ name: SSH_SERVICE, type: 'PTR' }, { name: OUR_SERVICE, type: 'PTR' }] });
}

function browse(cb) {
  browseCb = cb;
  clearTimeout(browseTimer);
  if (!cb) { releaseMdns(); return; }
  let delay = 1000;
  const tick = () => { query(); report(); delay = Math.min(delay * 2, 20000); browseTimer = setTimeout(tick, delay); };
  tick();
}

// Announcing this computer, while its SSH server is on, as "user@host (Snake's Terminal)".
function instanceName() {
  return `${os.userInfo().username}@${os.hostname().replace(/\.local$/, '')}.${OUR_SERVICE}`;
}
function targetName() {
  return `${os.hostname().replace(/\.local$/, '').replace(/[^A-Za-z0-9-]/g, '-')}-snaketerm.local`;
}
function ourRecords() {
  const user = os.userInfo().username;
  return {
    answers: [{ name: OUR_SERVICE, type: 'PTR', ttl: 120, data: instanceName() }],
    additionals: [
      { name: instanceName(), type: 'SRV', ttl: 120, data: { port: 22, weight: 0, priority: 0, target: targetName() } },
      { name: instanceName(), type: 'TXT', ttl: 120, data: [`user=${user}`, `os=${WIN ? 'windows' : MAC ? 'macos' : 'linux'}`, `name=${os.hostname().replace(/\.local$/, '')}`, 'app=Snake\'s Terminal'] },
      ...addresses().filter((a) => !a.tailscale).map((a) => ({ name: targetName(), type: 'A', ttl: 120, data: a.address })),
    ],
  };
}
function onQuery(q) {
  if (!advertising || !sshOnHere) return;
  if ((q.questions || []).some((x) => x.name === OUR_SERVICE && (x.type === 'PTR' || x.type === 'ANY'))) {
    try { mdns.respond(ourRecords()); } catch {}
  }
}
async function checkSshHere() {
  const was = sshOnHere;
  sshOnHere = (await portOpen('127.0.0.1', 22, 500)).open;
  if (advertising && sshOnHere && !was) { try { ensureMdns()?.respond(ourRecords()); } catch {} }
}
function advertise(on) {
  if (on === advertising) return;
  advertising = on;
  clearInterval(advertiseTimer);
  if (!on) { releaseMdns(); return; }
  ensureMdns();
  checkSshHere();
  advertiseTimer = setInterval(checkSshHere, 30000);
  advertiseTimer.unref?.();
}

function stopAll() {
  browseCb = null;
  advertising = false;
  clearTimeout(browseTimer);
  clearInterval(advertiseTimer);
  if (mdns) { try { mdns.destroy(); } catch {} mdns = null; }
}

module.exports = { which, sshPath, local, sshConfig, keys, makeKey, installKeyCommand, enableSshCommand, tailscale, scan, browse, advertise, stopAll, sshArgs };
