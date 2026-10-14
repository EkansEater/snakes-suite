use std::fs::{self, File};
use std::io::{BufWriter, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{Instant, UNIX_EPOCH};

use anyhow::{bail, Context, Result};
use walkdir::WalkDir;

use crate::format::*;

pub struct Options {
    pub inputs: Vec<PathBuf>,
    pub output: Option<PathBuf>,
    pub level: i32,
    pub threads: u32,
    pub force: bool,
    pub verbose: bool,
}

pub struct Summary {
    pub output: PathBuf,
    pub files: u64,
    /// Total size of the files that were packed.
    pub bytes: u64,
    /// Size of the finished archive.
    pub packed: u64,
    pub secs: f64,
}

#[derive(Default)]
struct Stats {
    files: u64,
    bytes: u64,
}

/// Where the archive goes when no output is given: `<first input>.snake`.
pub fn default_output(input: &Path) -> Result<PathBuf> {
    Ok(PathBuf::from(format!("{}.snake", root_name(input)?)))
}

/// Packs `opts.inputs` into an archive. `progress` is called with the number
/// of input bytes read so far.
pub fn run(opts: &Options, progress: &mut dyn FnMut(u64)) -> Result<Summary> {
    let output = match &opts.output {
        Some(p) => p.clone(),
        None => default_output(&opts.inputs[0])?,
    };
    if output.exists() && !opts.force {
        bail!("{} already exists (use --force to overwrite)", output.display());
    }

    let started = Instant::now();
    let stats = match write_archive(opts, &output, progress) {
        Ok(stats) => stats,
        Err(e) => {
            let _ = fs::remove_file(&output);
            return Err(e);
        }
    };

    let packed = fs::metadata(&output)?.len();
    Ok(Summary { output, files: stats.files, bytes: stats.bytes, packed, secs: started.elapsed().as_secs_f64() })
}

/// The name an input gets at the top level of the archive.
fn root_name(input: &Path) -> Result<String> {
    let full = fs::canonicalize(input).with_context(|| format!("cannot read {}", input.display()))?;
    match full.file_name() {
        Some(name) => Ok(utf8(name.as_ref())?.to_owned()),
        None => bail!("cannot pack {}: it has no name", input.display()),
    }
}

fn utf8(p: &Path) -> Result<&str> {
    p.to_str().with_context(|| format!("{} is not valid UTF-8", p.display()))
}

fn write_archive(opts: &Options, output: &Path, progress: &mut dyn FnMut(u64)) -> Result<Stats> {
    let file = File::create(output).with_context(|| format!("cannot create {}", output.display()))?;
    let out_canon = fs::canonicalize(output)?;
    let mut raw = BufWriter::new(file);
    raw.write_all(MAGIC)?;
    raw.write_all(&[VERSION])?;

    let mut enc = zstd::stream::write::Encoder::new(raw, opts.level)?;
    enc.multithread(opts.threads)?;
    enc.long_distance_matching(true)?;
    enc.window_log(WINDOW_LOG)?;
    enc.include_checksum(true)?;

    let mut stats = Stats::default();
    let mut buf = vec![0u8; CHUNK];

    for input in &opts.inputs {
        let root = root_name(input)?;
        for entry in WalkDir::new(input).follow_links(false).sort_by_file_name() {
            let entry = entry?;
            let path = entry.path();
            let ftype = entry.file_type();

            // Don't pack the archive into itself.
            if ftype.is_file()
                && path.file_name() == output.file_name()
                && fs::canonicalize(path).ok().as_deref() == Some(out_canon.as_path())
            {
                continue;
            }

            let mut name = root.clone();
            for part in path.strip_prefix(input)?.components() {
                if let Component::Normal(part) = part {
                    name.push('/');
                    name.push_str(utf8(part.as_ref())?);
                }
            }

            let kind = if ftype.is_dir() {
                KIND_DIR
            } else if ftype.is_symlink() {
                KIND_SYMLINK
            } else if ftype.is_file() {
                KIND_FILE
            } else {
                eprintln!("skipping {} (not a regular file)", path.display());
                continue;
            };

            let meta = entry.metadata()?;
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_secs() as i64);

            enc.write_all(&[kind])?;
            write_str(&mut enc, &name)?;
            write_u32(&mut enc, mode_of(&meta))?;
            write_i64(&mut enc, mtime)?;

            match kind {
                KIND_SYMLINK => {
                    let target = fs::read_link(path)?;
                    write_str(&mut enc, utf8(&target)?)?;
                }
                KIND_FILE => {
                    let mut f = File::open(path).with_context(|| format!("cannot open {}", path.display()))?;
                    let mut hasher = blake3::Hasher::new();
                    let mut size = 0u64;
                    loop {
                        let n = f.read(&mut buf).with_context(|| format!("cannot read {}", path.display()))?;
                        if n == 0 {
                            break;
                        }
                        write_u32(&mut enc, n as u32)?;
                        enc.write_all(&buf[..n])?;
                        hasher.update(&buf[..n]);
                        size += n as u64;
                        stats.bytes += n as u64;
                        progress(stats.bytes);
                    }
                    write_u32(&mut enc, 0)?;
                    write_u64(&mut enc, size)?;
                    enc.write_all(hasher.finalize().as_bytes())?;
                    stats.files += 1;
                }
                _ => {}
            }

            if opts.verbose {
                println!("{name}");
            }
        }
    }

    enc.write_all(&[KIND_END])?;
    let mut raw = enc.finish()?;
    raw.flush()?;
    Ok(stats)
}

#[cfg(unix)]
fn mode_of(meta: &fs::Metadata) -> u32 {
    use std::os::unix::fs::PermissionsExt;
    meta.permissions().mode()
}

#[cfg(not(unix))]
fn mode_of(_meta: &fs::Metadata) -> u32 {
    0
}
