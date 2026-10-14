use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, UNIX_EPOCH};

use anyhow::{bail, Context, Result};

use crate::format::*;

pub enum Mode {
    Extract { dest: PathBuf, force: bool },
    List,
    Test,
}

pub struct Summary {
    pub files: u64,
    pub bytes: u64,
    pub secs: f64,
}

/// Reports how far into the archive file we are.
struct Counting<'a> {
    inner: File,
    pos: u64,
    progress: &'a mut dyn FnMut(u64),
}

impl Read for Counting<'_> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.pos += n as u64;
        (self.progress)(self.pos);
        Ok(n)
    }
}

/// Reads an archive, verifying every checksum. `progress` is called with the
/// number of archive bytes consumed so far.
pub fn run(archive: &Path, mode: Mode, verbose: bool, progress: &mut dyn FnMut(u64)) -> Result<Summary> {
    let file = File::open(archive).with_context(|| format!("cannot open {}", archive.display()))?;
    let mut raw = BufReader::new(Counting { inner: file, pos: 0, progress });

    let mut header = [0u8; MAGIC.len() + 1];
    raw.read_exact(&mut header).context("not a .snake archive")?;
    if &header[..MAGIC.len()] != MAGIC {
        bail!("{} is not a .snake archive", archive.display());
    }
    if header[MAGIC.len()] != VERSION {
        bail!("archive format version {} is not supported by this build", header[MAGIC.len()]);
    }

    let mut dec = zstd::stream::read::Decoder::with_buffer(raw)?;
    dec.window_log_max(WINDOW_LOG_MAX)?;

    let started = Instant::now();
    let mut buf = vec![0u8; CHUNK];
    let mut files = 0u64;
    let mut bytes = 0u64;

    loop {
        let kind = read_u8(&mut dec).context("archive is truncated or corrupt")?;
        if kind == KIND_END {
            break;
        }
        let name = read_str(&mut dec).context("archive is corrupt")?;
        let mode_bits = read_u32(&mut dec)?;
        let mtime = read_i64(&mut dec)?;
        let rel = safe_path(&name)?;

        match kind {
            KIND_DIR => {
                if let Mode::Extract { dest, .. } = &mode {
                    check_no_symlinks(dest, &rel, true)?;
                    fs::create_dir_all(dest.join(&rel))?;
                }
                if matches!(mode, Mode::List) {
                    println!("{:>12}  {name}/", "");
                }
            }
            KIND_SYMLINK => {
                let target = read_str(&mut dec).context("archive is corrupt")?;
                if let Mode::Extract { dest, force } = &mode {
                    let path = prepare(dest, &rel, *force)?;
                    make_symlink(&target, &path)?;
                }
                if matches!(mode, Mode::List) {
                    println!("{:>12}  {name} -> {target}", "");
                }
            }
            KIND_FILE => {
                let mut out = match &mode {
                    Mode::Extract { dest, force } => {
                        let path = prepare(dest, &rel, *force)?;
                        let f = OpenOptions::new()
                            .write(true)
                            .create_new(true)
                            .open(&path)
                            .with_context(|| format!("cannot create {}", path.display()))?;
                        Some(f)
                    }
                    _ => None,
                };

                let mut hasher = blake3::Hasher::new();
                let mut size = 0u64;
                loop {
                    let n = read_u32(&mut dec).context("archive is truncated or corrupt")? as usize;
                    if n == 0 {
                        break;
                    }
                    if n > CHUNK {
                        bail!("archive is corrupt (bad chunk in {name})");
                    }
                    dec.read_exact(&mut buf[..n]).context("archive is truncated or corrupt")?;
                    hasher.update(&buf[..n]);
                    if let Some(f) = &mut out {
                        f.write_all(&buf[..n])?;
                    }
                    size += n as u64;
                }

                let stored_size = read_u64(&mut dec)?;
                let mut stored_hash = [0u8; 32];
                dec.read_exact(&mut stored_hash)?;
                if stored_size != size || hasher.finalize().as_bytes() != &stored_hash {
                    bail!("checksum mismatch in {name}: the archive is damaged");
                }

                if let Some(f) = out {
                    restore_metadata(&f, mode_bits, mtime);
                }
                if matches!(mode, Mode::List) {
                    println!("{size:>12}  {name}");
                }
                files += 1;
                bytes += size;
            }
            other => bail!("archive is corrupt (unknown entry type {other})"),
        }

        if verbose && !matches!(mode, Mode::List) {
            println!("{name}");
        }
    }

    // Reading to the end of the zstd frame makes it verify its own checksum.
    if dec.read(&mut buf[..1]).context("archive is corrupt")? != 0 {
        bail!("archive is corrupt (unexpected data after the end)");
    }

    Ok(Summary { files, bytes, secs: started.elapsed().as_secs_f64() })
}

/// Turns an archive path into a relative filesystem path, refusing anything
/// that could land outside the destination folder.
fn safe_path(name: &str) -> Result<PathBuf> {
    let mut path = PathBuf::new();
    for part in name.split('/') {
        let bad = part.is_empty()
            || part == "."
            || part == ".."
            || part.contains('\0')
            || (cfg!(windows) && part.contains(['\\', ':']));
        if bad {
            bail!("refusing unsafe path in archive: {name:?}");
        }
        path.push(part);
    }
    Ok(path)
}

/// Refuses to extract through a symlink, which could redirect writes outside
/// `dest`. Checks the parents of `rel`, and `rel` itself if `include_last`.
fn check_no_symlinks(dest: &Path, rel: &Path, include_last: bool) -> Result<()> {
    let count = rel.components().count();
    let mut cur = dest.to_path_buf();
    for (i, part) in rel.components().enumerate() {
        if i + 1 == count && !include_last {
            break;
        }
        cur.push(part);
        if fs::symlink_metadata(&cur).is_ok_and(|m| m.file_type().is_symlink()) {
            bail!("refusing to extract through symlink {}", cur.display());
        }
    }
    Ok(())
}

/// Makes `dest/rel` ready to be created: parents exist, nothing is in the way.
fn prepare(dest: &Path, rel: &Path, force: bool) -> Result<PathBuf> {
    check_no_symlinks(dest, rel, false)?;
    let path = dest.join(rel);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)?;
    }
    if let Ok(meta) = fs::symlink_metadata(&path) {
        if !force {
            bail!("{} already exists (use --force to overwrite)", path.display());
        }
        if meta.is_dir() {
            bail!("{} is a folder, cannot replace it with a file", path.display());
        }
        fs::remove_file(&path)?;
    }
    Ok(path)
}

fn restore_metadata(file: &File, mode_bits: u32, mtime: i64) {
    #[cfg(unix)]
    if mode_bits != 0 {
        use std::os::unix::fs::PermissionsExt;
        let _ = file.set_permissions(fs::Permissions::from_mode(mode_bits & 0o7777));
    }
    #[cfg(not(unix))]
    let _ = mode_bits;

    if mtime > 0 {
        let _ = file.set_modified(UNIX_EPOCH + Duration::from_secs(mtime as u64));
    }
}

#[cfg(unix)]
fn make_symlink(target: &str, path: &Path) -> Result<()> {
    std::os::unix::fs::symlink(target, path).with_context(|| format!("cannot create symlink {}", path.display()))
}

#[cfg(not(unix))]
fn make_symlink(target: &str, path: &Path) -> Result<()> {
    eprintln!("skipping symlink {} -> {target} (not supported on this system)", path.display());
    Ok(())
}
