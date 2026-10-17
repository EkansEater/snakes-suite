//! snakessh: the ssh of Snake's Terminal on Android, where there is no ssh program.
//! It runs in the terminal's pty and behaves like OpenSSH's client for what the app needs:
//!
//!   snakessh [-p port] [-i keyfile]... [-o Name=value]... [-t] [user@]host [command...]
//!   snakessh keygen FILE [COMMENT]       a new ed25519 key: FILE and FILE.pub
//!
//! Known hosts and keys live in $SNAKESSH_HOME (the app's private folder): known_hosts,
//! id_ed25519 (used when no -i is given).

use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, bail, Context, Result};
use russh::client::{self, AuthResult, KeyboardInteractiveAuthResponse};
use russh::keys::{self, ssh_key, HashAlg, PrivateKey, PrivateKeyWithHashAlg, PublicKey};
use russh::{ChannelMsg, Disconnect, MethodKind};
use tokio::sync::mpsc;

struct Args {
    host: String,
    user: Option<String>,
    port: u16,
    identities: Vec<PathBuf>,
    command: Option<String>,
}

fn usage() -> ! {
    eprintln!("usage: snakessh [-p port] [-i keyfile] [user@]host [command]\n       snakessh keygen FILE [COMMENT]");
    std::process::exit(255);
}

fn parse() -> Args {
    let mut it = std::env::args().skip(1).peekable();
    let mut a = Args { host: String::new(), user: None, port: 22, identities: vec![], command: None };
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "-p" => a.port = it.next().and_then(|p| p.parse().ok()).unwrap_or_else(|| usage()),
            "-i" => a.identities.push(PathBuf::from(it.next().unwrap_or_else(|| usage()))),
            "-l" => a.user = Some(it.next().unwrap_or_else(|| usage())),
            "-o" => { it.next(); } // OpenSSH options: nothing needed here
            "-t" | "-tt" | "-q" | "-v" | "-4" | "-6" | "-A" | "-C" => {}
            "-J" => {
                eprintln!("Jump hosts are not supported on Android yet: connect to the gateway first, then ssh from there.");
                std::process::exit(255);
            }
            s if s.starts_with('-') => { eprintln!("snakessh: unknown option {s}"); usage(); }
            _ => {
                let (user, host) = match arg.rsplit_once('@') {
                    Some((u, h)) => (Some(u.to_string()), h.to_string()),
                    None => (None, arg.clone()),
                };
                a.host = host.trim_start_matches('[').trim_end_matches(']').to_string();
                if a.user.is_none() { a.user = user; }
                let rest: Vec<String> = it.by_ref().collect();
                if !rest.is_empty() { a.command = Some(rest.join(" ")); }
            }
        }
    }
    if a.host.is_empty() { usage(); }
    a
}

fn home() -> PathBuf {
    std::env::var_os("SNAKESSH_HOME").map(PathBuf::from).unwrap_or_else(|| PathBuf::from("."))
}

// ---------------------------------------------------------------------------
// The terminal: answers typed at prompts, and raw mode while connected
// ---------------------------------------------------------------------------
fn prompt_line(text: &str, echo: bool) -> String {
    eprint!("{text}");
    let _ = std::io::stderr().flush();
    let mut old: libc::termios = unsafe { std::mem::zeroed() };
    let have = unsafe { libc::tcgetattr(0, &mut old) } == 0;
    if have && !echo {
        let mut t = old;
        t.c_lflag &= !libc::ECHO;
        unsafe { libc::tcsetattr(0, libc::TCSANOW, &t) };
    }
    let mut line = Vec::new();
    let mut b = [0u8; 1];
    while let Ok(1) = std::io::stdin().read(&mut b) {
        if b[0] == b'\n' || b[0] == b'\r' { break; }
        if b[0] == 3 || b[0] == 4 { line.clear(); if have { unsafe { libc::tcsetattr(0, libc::TCSANOW, &old) }; } eprintln!(); std::process::exit(255); }
        if b[0] == 127 || b[0] == 8 { line.pop(); continue; }
        line.push(b[0]);
    }
    if have && !echo { unsafe { libc::tcsetattr(0, libc::TCSANOW, &old) }; eprintln!(); }
    String::from_utf8_lossy(&line).into_owned()
}

struct RawMode(Option<libc::termios>);
impl RawMode {
    fn on() -> Self {
        let mut old: libc::termios = unsafe { std::mem::zeroed() };
        if unsafe { libc::tcgetattr(0, &mut old) } != 0 { return RawMode(None); }
        let mut t = old;
        unsafe { libc::cfmakeraw(&mut t) };
        unsafe { libc::tcsetattr(0, libc::TCSANOW, &t) };
        RawMode(Some(old))
    }
}
impl Drop for RawMode {
    fn drop(&mut self) {
        if let Some(old) = self.0 { unsafe { libc::tcsetattr(0, libc::TCSANOW, &old) }; }
    }
}

fn window_size() -> (u32, u32) {
    let mut ws: libc::winsize = unsafe { std::mem::zeroed() };
    if unsafe { libc::ioctl(0, libc::TIOCGWINSZ, &mut ws) } == 0 && ws.ws_col > 0 {
        (ws.ws_col as u32, ws.ws_row as u32)
    } else {
        (80, 24)
    }
}

// ---------------------------------------------------------------------------
// Host keys: like OpenSSH, ask the first time, refuse when they change
// ---------------------------------------------------------------------------
struct Client {
    host: String,
    port: u16,
    known_hosts: PathBuf,
}

impl client::Handler for Client {
    type Error = anyhow::Error;

    async fn check_server_key(&mut self, key: &keys::PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let key: PublicKey = match key {
            keys::PublicKeyOrCertificate::PublicKey { key, .. } => key.clone(),
            keys::PublicKeyOrCertificate::Certificate(c) => PublicKey::from(c.public_key().clone()),
        };
        if !self.known_hosts.exists() {
            if let Some(dir) = self.known_hosts.parent() { let _ = std::fs::create_dir_all(dir); }
            let _ = std::fs::write(&self.known_hosts, b"");
        }
        match keys::check_known_hosts_path(&self.host, self.port, &key, &self.known_hosts) {
            Ok(true) => Ok(true),
            Ok(false) => {
                let fp = key.fingerprint(HashAlg::Sha256);
                eprintln!("The authenticity of host '{}' can't be established.", self.host);
                eprintln!("{} key fingerprint is {}.", key.algorithm().as_str().trim_start_matches("ssh-").to_uppercase(), fp);
                let (host, port, path) = (self.host.clone(), self.port, self.known_hosts.clone());
                let answer = tokio::task::spawn_blocking(|| loop {
                    let a = prompt_line("Are you sure you want to continue connecting (yes/no)? ", true).trim().to_lowercase();
                    if a == "yes" || a == "no" { break a; }
                }).await?;
                if answer != "yes" { bail!("Host key verification failed."); }
                keys::known_hosts::learn_known_hosts_path(&host, port, &key, &path).context("could not save the host key")?;
                eprintln!("Warning: Permanently added '{host}' to the list of known hosts.");
                Ok(true)
            }
            Err(keys::Error::KeyChanged { line }) => {
                eprintln!("@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@");
                eprintln!("@    WARNING: REMOTE HOST IDENTIFICATION HAS CHANGED!     @");
                eprintln!("@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@@");
                eprintln!("Someone could be eavesdropping on you right now, or the computer was reinstalled.");
                eprintln!("The key it showed is {}.", key.fingerprint(HashAlg::Sha256));
                eprintln!("If you trust the change, remove line {line} of {}.", self.known_hosts.display());
                bail!("Host key verification failed.")
            }
            Err(e) => Err(anyhow!(e)),
        }
    }
}

// ---------------------------------------------------------------------------
// Logging in: keys first, then the password (or the server's questions)
// ---------------------------------------------------------------------------
/// Before the server has said which ways to log in remain, try them all.
fn offered(methods: &Option<russh::MethodSet>, m: MethodKind) -> bool {
    methods.as_ref().map_or(true, |s| s.contains(&m))
}

async fn authenticate(session: &mut client::Handle<Client>, user: &str, host: &str, identities: &[PathBuf]) -> Result<()> {
    let mut methods: Option<russh::MethodSet> = None;
    let rsa_hash = session.best_supported_rsa_hash().await.ok().flatten().flatten();
    for path in identities {
        if !path.exists() { continue; }
        let key = match keys::load_secret_key(path, None) {
            Ok(k) => k,
            Err(_) => {
                let pass = prompt_line(&format!("Enter passphrase for key '{}': ", path.display()), false);
                match keys::load_secret_key(path, Some(&pass)) { Ok(k) => k, Err(_) => { eprintln!("Wrong passphrase."); continue; } }
            }
        };
        let r = session.authenticate_publickey(user, PrivateKeyWithHashAlg::new(Arc::new(key), rsa_hash)).await?;
        match r {
            AuthResult::Success => return Ok(()),
            AuthResult::Failure { remaining_methods, .. } => methods = Some(remaining_methods),
        }
    }
    for _ in 0..3 {
        if offered(&methods, MethodKind::KeyboardInteractive) {
            let mut r = session.authenticate_keyboard_interactive_start(user, None).await?;
            loop {
                match r {
                    KeyboardInteractiveAuthResponse::Success => return Ok(()),
                    KeyboardInteractiveAuthResponse::Failure { remaining_methods, .. } => { methods = Some(remaining_methods); break; }
                    KeyboardInteractiveAuthResponse::InfoRequest { name, instructions, prompts } => {
                        if !name.is_empty() { eprintln!("{name}"); }
                        if !instructions.is_empty() { eprintln!("{instructions}"); }
                        let answers = prompts.iter().map(|p| {
                            let text = if p.prompt.to_lowercase().starts_with("password") { format!("{user}@{host}'s password: ") } else { p.prompt.clone() };
                            prompt_line(&text, p.echo)
                        }).collect();
                        r = session.authenticate_keyboard_interactive_respond(answers).await?;
                    }
                }
            }
            if methods.as_ref().is_some_and(|m| m.contains(&MethodKind::KeyboardInteractive)) { eprintln!("Permission denied, please try again."); continue; }
        }
        if offered(&methods, MethodKind::Password) {
            let pw = prompt_line(&format!("{user}@{host}'s password: "), false);
            match session.authenticate_password(user, pw).await? {
                AuthResult::Success => return Ok(()),
                AuthResult::Failure { remaining_methods, .. } => { methods = Some(remaining_methods); eprintln!("Permission denied, please try again."); }
            }
        } else if !offered(&methods, MethodKind::KeyboardInteractive) {
            break;
        }
    }
    bail!("{user}@{host}: Permission denied (publickey{}).", if offered(&methods, MethodKind::Password) { ",password" } else { "" })
}

// ---------------------------------------------------------------------------
async fn run(a: Args) -> Result<u32> {
    let user = a.user.clone().or_else(|| std::env::var("USER").ok()).ok_or_else(|| anyhow!("Which user? Use user@{}", a.host))?;
    let mut identities = a.identities.clone();
    if identities.is_empty() {
        for n in ["id_ed25519", "id_ecdsa", "id_rsa"] { identities.push(home().join(n)); }
    }
    let config = Arc::new(client::Config {
        inactivity_timeout: None,
        keepalive_interval: Some(Duration::from_secs(30)),
        keepalive_max: 4,
        nodelay: true,
        ..Default::default()
    });
    let handler = Client { host: a.host.clone(), port: a.port, known_hosts: home().join("known_hosts") };
    let addr = (a.host.as_str(), a.port);
    let stream = tokio::time::timeout(Duration::from_secs(20), tokio::net::TcpStream::connect(addr)).await
        .map_err(|_| anyhow!("ssh: connect to host {} port {}: Connection timed out", a.host, a.port))?
        .map_err(|e| anyhow!("ssh: connect to host {} port {}: {}", a.host, a.port, e))?;
    let mut session = client::connect_stream(config, stream, handler).await?;
    authenticate(&mut session, &user, &a.host, &identities).await?;

    let mut channel = session.channel_open_session().await?;
    let interactive = a.command.is_none();
    let (cols, rows) = window_size();
    if interactive {
        channel.request_pty(false, "xterm-256color", cols, rows, 0, 0, &[]).await?;
        channel.request_shell(true).await?;
    } else {
        channel.exec(true, a.command.clone().unwrap_or_default()).await?;
    }
    let _raw = if interactive { Some(RawMode::on()) } else { None };

    // Typing comes from a plain thread: reading the terminal blocks.
    let (tx, mut rx) = mpsc::unbounded_channel::<Vec<u8>>();
    std::thread::spawn(move || {
        let mut buf = [0u8; 4096];
        let mut stdin = std::io::stdin();
        loop {
            match stdin.read(&mut buf) {
                Ok(0) | Err(_) => { let _ = tx.send(Vec::new()); break; }
                Ok(n) => { if tx.send(buf[..n].to_vec()).is_err() { break; } }
            }
        }
    });
    let mut winch = tokio::signal::unix::signal(tokio::signal::unix::SignalKind::window_change())?;
    let mut stdout = std::io::stdout();
    let mut stderr = std::io::stderr();
    let mut code = 0u32;
    let mut stdin_open = true;
    loop {
        tokio::select! {
            msg = channel.wait() => match msg {
                Some(ChannelMsg::Data { data }) => { stdout.write_all(&data)?; stdout.flush()?; }
                Some(ChannelMsg::ExtendedData { data, .. }) => { stderr.write_all(&data)?; stderr.flush()?; }
                Some(ChannelMsg::ExitStatus { exit_status }) => code = exit_status,
                Some(ChannelMsg::ExitSignal { .. }) => code = 255,
                Some(ChannelMsg::Eof) => {}
                Some(ChannelMsg::Close) | None => break,
                _ => {}
            },
            input = rx.recv(), if stdin_open => match input {
                Some(bytes) if !bytes.is_empty() => channel.data_bytes(bytes).await?,
                _ => { stdin_open = false; if !interactive { channel.eof().await?; } }
            },
            _ = winch.recv() => {
                let (c, r) = window_size();
                let _ = channel.window_change(c, r, 0, 0).await;
            }
        }
    }
    drop(_raw);
    let _ = session.disconnect(Disconnect::ByApplication, "", "en").await;
    Ok(code)
}

/// `snakessh keygen FILE [COMMENT]`: an ed25519 key in OpenSSH's format, like ssh-keygen.
fn keygen(file: &Path, comment: &str) -> Result<()> {
    if file.exists() { bail!("{} already exists", file.display()); }
    let mut seed = [0u8; 32];
    std::fs::File::open("/dev/urandom")?.read_exact(&mut seed)?;
    let pair = ssh_key::private::Ed25519Keypair::from_seed(&seed);
    let key = PrivateKey::new(ssh_key::private::KeypairData::Ed25519(pair), comment)?;
    let private = key.to_openssh(ssh_key::LineEnding::LF)?;
    if let Some(dir) = file.parent() { std::fs::create_dir_all(dir)?; }
    {
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(file)?;
        f.write_all(private.as_bytes())?;
    }
    let public = key.public_key().to_openssh()?;
    std::fs::write(file.with_extension("pub"), format!("{public}\n"))?;
    println!("{public}");
    Ok(())
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("keygen") {
        let file = args.get(2).map(PathBuf::from).unwrap_or_else(|| home().join("id_ed25519"));
        let comment = args.get(3).cloned().unwrap_or_else(|| "Snake's Terminal (Android)".into());
        match keygen(&file, &comment) {
            Ok(()) => std::process::exit(0),
            Err(e) => { eprintln!("snakessh keygen: {e}"); std::process::exit(1); }
        }
    }
    let a = parse();
    let host = a.host.clone();
    let rt = tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime");
    let code = rt.block_on(run(a));
    match code {
        Ok(c) => std::process::exit(c as i32),
        Err(e) => {
            let msg = e.to_string();
            if msg.starts_with("ssh:") || msg.contains("Permission denied") || msg.contains("verification failed") { eprintln!("{msg}"); }
            else { eprintln!("ssh: {host}: {msg}"); }
            std::process::exit(255);
        }
    }
}
