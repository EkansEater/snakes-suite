//! Archives made by other programs: ZIP, 7z, tar (plain, .gz, .bz2, .xz, .zst) and
//! single compressed files (.gz, .bz2, .xz, .zst). They are listed, tested and
//! unpacked with the same protections as .snake archives (nothing lands outside the
//! destination, nothing is written through a symlink). ZIP archives can also be made,
//! for people without Snake's Compressor.

use std::fs::{self, File, OpenOptions};
use std::io::{self, BufReader, BufWriter, Read, Seek, SeekFrom, Write};
use std::path::{Component, Path, PathBuf};
use std::time::{Instant, UNIX_EPOCH};

use anyhow::{anyhow, bail, Context, Result};
use walkdir::WalkDir;

use crate::unpack::{check_no_symlinks, make_symlink, prepare, restore_metadata, safe_path, Entry, Mode, Summary};

/// The kind of archive a file is, from its first bytes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Snake,
    Zip,
    SevenZ,
    /// A tar archive, perhaps inside a compressed stream.
    Tar(Wrap),
    /// One compressed file (not a tar inside).
    Single(Wrap),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Wrap {
    None,
    Gzip,
    Bzip2,
    Xz,
    Zstd,
}

impl Kind {
    pub fn label(self) -> &'static str {
        match self {
            Kind::Snake => "Snake archive",
            Kind::Zip => "ZIP archive",
            Kind::SevenZ => "7-Zip archive",
            Kind::Tar(Wrap::None) => "tar archive",
            Kind::Tar(Wrap::Gzip) => "tar.gz archive",
            Kind::Tar(Wrap::Bzip2) => "tar.bz2 archive",
            Kind::Tar(Wrap::Xz) => "tar.xz archive",
            Kind::Tar(Wrap::Zstd) => "tar.zst archive",
            Kind::Single(Wrap::Gzip) => "gzip file",
            Kind::Single(Wrap::Bzip2) => "bzip2 file",
            Kind::Single(Wrap::Xz) => "xz file",
            Kind::Single(Wrap::Zstd) => "zstd file",
            Kind::Single(Wrap::None) => "file",
        }
    }
}

fn wrap_of(head: &[u8]) -> Wrap {
    if head.starts_with(&[0x1f, 0x8b]) {
        Wrap::Gzip
    } else if head.starts_with(b"BZh") {
        Wrap::Bzip2
    } else if head.starts_with(&[0xfd, b'7', b'z', b'X', b'Z', 0]) {
        Wrap::Xz
    } else if head.starts_with(&[0x28, 0xb5, 0x2f, 0xfd]) {
        Wrap::Zstd
    } else {
        Wrap::None
    }
}

fn is_tar(block: &[u8]) -> bool {
    block.len() >= 262 && &block[257..262] == b"ustar"
}

/// What kind of archive `path` is, or None when it is not one we read.
pub fn detect(path: &Path) -> Result<Option<Kind>> {
    let mut f = File::open(path).with_context(|| format!("cannot open {}", path.display()))?;
    let mut head = [0u8; 512];
    let n = read_up_to(&mut f, &mut head)?;
    let head = &head[..n];
    if head.starts_with(crate::format::MAGIC) {
        return Ok(Some(Kind::Snake));
    }
    if head.starts_with(b"PK\x03\x04") || head.starts_with(b"PK\x05\x06") || head.starts_with(b"PK\x07\x08") {
        return Ok(Some(Kind::Zip));
    }
    if head.starts_with(&[b'7', b'z', 0xbc, 0xaf, 0x27, 0x1c]) {
        return Ok(Some(Kind::SevenZ));
    }
    if is_tar(head) {
        return Ok(Some(Kind::Tar(Wrap::None)));
    }
    let wrap = wrap_of(head);
    if wrap == Wrap::None {
        return Ok(None);
    }
    // A compressed stream: a tar inside, or one file?
    f.seek(SeekFrom::Start(0))?;
    let mut inner = decoder(wrap, BufReader::new(f))?;
    let mut block = [0u8; 512];
    let n = read_up_to(&mut inner, &mut block).unwrap_or(0);
    Ok(Some(if is_tar(&block[..n]) { Kind::Tar(wrap) } else { Kind::Single(wrap) }))
}

fn read_up_to(r: &mut dyn Read, buf: &mut [u8]) -> io::Result<usize> {
    let mut got = 0;
    while got < buf.len() {
        match r.read(&mut buf[got..])? {
            0 => break,
            n => got += n,
        }
    }
    Ok(got)
}

fn decoder<'a, R: Read + 'a>(wrap: Wrap, r: R) -> Result<Box<dyn Read + 'a>> {
    Ok(match wrap {
        Wrap::None => Box::new(r),
        Wrap::Gzip => Box::new(flate2::read::MultiGzDecoder::new(r)),
        Wrap::Bzip2 => Box::new(bzip2::read::MultiBzDecoder::new(r)),
        Wrap::Xz => Box::new(lzma_rust2::XzReader::new(r, true)),
        Wrap::Zstd => {
            let mut d = zstd::stream::read::Decoder::new(r)?;
            d.window_log_max(31).ok();
            Box::new(d)
        }
    })
}

/// Counts how far into the archive file reading has got, and stops when asked to.
struct Counting<'a, R> {
    inner: R,
    pos: u64,
    progress: &'a mut dyn FnMut(u64) -> bool,
}

impl<R: Read> Read for Counting<'_, R> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        self.pos += n as u64;
        if !(self.progress)(self.pos) {
            return Err(io::Error::other("cancelled"));
        }
        Ok(n)
    }
}

impl<R: Seek> Seek for Counting<'_, R> {
    fn seek(&mut self, to: SeekFrom) -> io::Result<u64> {
        self.pos = self.inner.seek(to)?;
        Ok(self.pos)
    }
}


/// Lists, tests or unpacks an archive of another program. `password` opens encrypted
/// ZIP and 7z archives.
pub fn run(archive: &Path, kind: Kind, mode: Mode, password: Option<&str>, verbose: bool, progress: &mut dyn FnMut(u64) -> bool) -> Result<Summary> {
    let started = Instant::now();
    let file = File::open(archive).with_context(|| format!("cannot open {}", archive.display()))?;
    let mut w = Writer { mode: &mode, verbose, files: 0, bytes: 0, current: None };
    let result = match kind {
        Kind::Zip => zip_run(BufReader::new(Counting { inner: file, pos: 0, progress }), password, &mut w),
        Kind::SevenZ => seven_run(Counting { inner: BufReader::new(file), pos: 0, progress }, password, &mut w),
        Kind::Tar(wrap) => {
            let inner = decoder(wrap, BufReader::new(Counting { inner: file, pos: 0, progress }))?;
            tar_run(inner, &mut w)
        }
        Kind::Single(wrap) => {
            let inner = decoder(wrap, BufReader::new(Counting { inner: file, pos: 0, progress }))?;
            let name = single_name(archive);
            w.file(&name, 0o644, 0, &mut { inner })
        }
        Kind::Snake => bail!("not another program's archive"),
    };
    if let Err(e) = result {
        // A file left half written is removed.
        if let Some(p) = w.current.take() {
            let _ = fs::remove_file(p);
        }
        return Err(e);
    }
    Ok(Summary { files: w.files, bytes: w.bytes, secs: started.elapsed().as_secs_f64() })
}

/// The names and sizes inside an archive (read quickly where the format has a directory).
pub fn entries(archive: &Path, kind: Kind, password: Option<&str>) -> Result<Vec<Entry>> {
    match kind {
        Kind::Zip => {
            let mut z = zip::ZipArchive::new(BufReader::new(File::open(archive)?)).map_err(zip_err)?;
            let mut out = Vec::with_capacity(z.len());
            for i in 0..z.len() {
                let f = z.by_index_raw(i).map_err(zip_err)?;
                out.push(Entry { name: f.name().replace('\\', "/"), size: f.size(), dir: f.is_dir() });
            }
            Ok(out)
        }
        Kind::SevenZ => {
            let pw = password.map(sevenz_rust2::Password::from).unwrap_or_else(sevenz_rust2::Password::empty);
            let a = sevenz_rust2::Archive::open_with_password(archive, &pw).map_err(seven_err)?;
            Ok(a.files.iter().map(|e| Entry { name: e.name().to_owned(), size: e.size(), dir: e.is_directory() }).collect())
        }
        _ => {
            // Tar and single files have no directory: the tar headers are read through.
            let mut out = Vec::new();
            if let Kind::Tar(wrap) = kind {
                let inner = decoder(wrap, BufReader::new(File::open(archive)?))?;
                let mut t = tar::Archive::new(inner);
                for e in t.entries()? {
                    let e = e?;
                    let name = e.path()?.to_string_lossy().replace('\\', "/");
                    out.push(Entry { name, size: e.header().size().unwrap_or(0), dir: e.header().entry_type().is_dir() });
                }
            } else if let Kind::Single(_) = kind {
                out.push(Entry { name: single_name(archive), size: 0, dir: false });
            }
            Ok(out)
        }
    }
}

/// The file a single compressed file holds: its own name without the compression ending.
fn single_name(archive: &Path) -> String {
    let name = archive.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "file".into());
    for end in [".gz", ".bz2", ".xz", ".zst", ".tgz", ".zstd"] {
        if name.len() > end.len() && name.to_ascii_lowercase().ends_with(end) {
            return name[..name.len() - end.len()].to_owned();
        }
    }
    format!("{name}.out")
}

/// Where entries go: listed, read through (test) or written out (extract).
struct Writer<'a> {
    mode: &'a Mode,
    verbose: bool,
    files: u64,
    bytes: u64,
    current: Option<PathBuf>,
}

impl Writer<'_> {
    fn clean(name: &str) -> String {
        name.replace('\\', "/").trim_start_matches("./").trim_start_matches('/').trim_end_matches('/').to_owned()
    }

    fn dir(&mut self, name: &str) -> Result<()> {
        let name = Self::clean(name);
        if name.is_empty() {
            return Ok(());
        }
        let rel = safe_path(&name)?;
        match self.mode {
            Mode::Extract { dest, .. } => {
                check_no_symlinks(dest, &rel, true)?;
                fs::create_dir_all(dest.join(&rel))?;
            }
            Mode::List => println!("{:>12}  {name}/", ""),
            Mode::Test | Mode::Collect(_) => {}
        }
        self.mode.note(&name, 0, true);
        Ok(())
    }

    fn file(&mut self, name: &str, mode_bits: u32, mtime: i64, data: &mut dyn Read) -> Result<()> {
        let name = Self::clean(name);
        let rel = safe_path(&name)?;
        let size = match self.mode {
            Mode::Extract { dest, force } => {
                let path = prepare(dest, &rel, *force)?;
                let f = OpenOptions::new().write(true).create_new(true).open(&path).with_context(|| format!("cannot create {}", path.display()))?;
                self.current = Some(path);
                let mut out = BufWriter::new(f);
                let n = io::copy(data, &mut out).with_context(|| format!("cannot unpack {name}"))?;
                let f = out.into_inner().map_err(|e| anyhow!("cannot write {name}: {e}"))?;
                restore_metadata(&f, mode_bits, mtime);
                self.current = None;
                n
            }
            Mode::Test | Mode::Collect(_) => io::copy(data, &mut io::sink()).with_context(|| format!("{name} is damaged"))?,
            Mode::List => {
                let n = io::copy(data, &mut io::sink()).unwrap_or(0);
                println!("{n:>12}  {name}");
                n
            }
        };
        if self.verbose && !matches!(self.mode, Mode::List) {
            println!("{name}");
        }
        self.mode.note(&name, size, false);
        self.files += 1;
        self.bytes += size;
        Ok(())
    }

    fn symlink(&mut self, name: &str, target: &str) -> Result<()> {
        let name = Self::clean(name);
        let rel = safe_path(&name)?;
        match self.mode {
            Mode::Extract { dest, force } => {
                let path = prepare(dest, &rel, *force)?;
                make_symlink(target, &path)?;
            }
            Mode::List => println!("{:>12}  {name} -> {target}", ""),
            Mode::Test | Mode::Collect(_) => {}
        }
        self.mode.note(&name, 0, false);
        Ok(())
    }
}

fn zip_err(e: zip::result::ZipError) -> anyhow::Error {
    match e {
        zip::result::ZipError::UnsupportedArchive(m) if m == zip::result::ZipError::PASSWORD_REQUIRED => anyhow!("password required: this archive is encrypted"),
        zip::result::ZipError::InvalidPassword => anyhow!("wrong password"),
        other => anyhow!("{other}"),
    }
}

fn seven_err(e: sevenz_rust2::Error) -> anyhow::Error {
    match e {
        sevenz_rust2::Error::PasswordRequired => anyhow!("password required: this archive is encrypted"),
        sevenz_rust2::Error::MaybeBadPassword(_) => anyhow!("wrong password (or the archive is damaged)"),
        other => anyhow!("{other}"),
    }
}

fn zip_run<R: Read + Seek>(r: R, password: Option<&str>, w: &mut Writer) -> Result<()> {
    let mut z = zip::ZipArchive::new(r).map_err(zip_err)?;
    for i in 0..z.len() {
        let mut f = match password {
            Some(p) => z.by_index_decrypt(i, p.as_bytes()).map_err(zip_err)?,
            None => z.by_index(i).map_err(zip_err)?,
        };
        let name = f.name().to_owned();
        let mtime = f.last_modified().map_or(0, zip_time);
        let mode_bits = f.unix_mode().unwrap_or(0);
        if f.is_dir() {
            w.dir(&name)?;
        } else if f.is_symlink() {
            let mut target = String::new();
            f.read_to_string(&mut target)?;
            w.symlink(&name, &target)?;
        } else {
            // Reading to the end checks the entry's CRC.
            w.file(&name, mode_bits, mtime, &mut f)?;
        }
    }
    Ok(())
}

fn seven_run<R: Read + Seek>(r: R, password: Option<&str>, w: &mut Writer) -> Result<()> {
    let pw = password.map(sevenz_rust2::Password::from).unwrap_or_else(sevenz_rust2::Password::empty);
    let mut a = sevenz_rust2::ArchiveReader::new(r, pw).map_err(seven_err)?;
    let mut failure: Option<anyhow::Error> = None;
    a.for_each_entries(|entry, data| {
        let mtime = if entry.has_last_modified_date {
            std::time::SystemTime::from(entry.last_modified_date()).duration_since(UNIX_EPOCH).map_or(0, |d| d.as_secs() as i64)
        } else {
            0
        };
        // p7zip and 7-Zip on Unix keep the Unix mode in the high half of the attributes
        // (with 0x8000 set); a symlink's data is its target.
        let unix = if entry.has_windows_attributes && entry.windows_attributes & 0x8000 != 0 { entry.windows_attributes >> 16 } else { 0 };
        let r = if entry.is_directory() {
            w.dir(entry.name())
        } else if unix & 0o170000 == 0o120000 {
            let mut target = String::new();
            match data.read_to_string(&mut target) {
                Ok(_) => w.symlink(entry.name(), &target),
                Err(e) => Err(e.into()),
            }
        } else {
            w.file(entry.name(), unix & 0o7777, mtime, data)
        };
        match r {
            Ok(()) => Ok(true),
            Err(e) => {
                failure = Some(e);
                Ok(false)
            }
        }
    })
    .map_err(seven_err)?;
    if let Some(e) = failure {
        return Err(e);
    }
    Ok(())
}

fn tar_run(r: Box<dyn Read + '_>, w: &mut Writer) -> Result<()> {
    let mut t = tar::Archive::new(r);
    for e in t.entries().context("this tar archive is damaged")? {
        let mut e = e.context("this tar archive is damaged")?;
        let name = e.path()?.to_string_lossy().into_owned();
        let h = e.header();
        let mode_bits = h.mode().unwrap_or(0o644);
        let mtime = h.mtime().unwrap_or(0) as i64;
        let kind = h.entry_type();
        if kind.is_dir() {
            w.dir(&name)?;
        } else if kind.is_symlink() {
            let target = e.link_name()?.map(|t| t.to_string_lossy().into_owned()).unwrap_or_default();
            w.symlink(&name, &target)?;
        } else if kind.is_file() || kind == tar::EntryType::Continuous || kind == tar::EntryType::GNUSparse {
            w.file(&name, mode_bits, mtime, &mut e)?;
        }
        // Hard links, devices and the like are skipped.
    }
    Ok(())
}

/// Unix seconds from a ZIP date (kept as written: ZIP stores no time zone).
fn zip_time(d: zip::DateTime) -> i64 {
    let (y, m, day) = (d.year() as i64, d.month() as i64, d.day() as i64);
    // Days since 1970-01-01 (Howard Hinnant's civil-to-days).
    let y2 = if m <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let doy = (153 * (if m > 2 { m - 3 } else { m + 9 }) + 2) / 5 + day - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    days * 86400 + d.hour() as i64 * 3600 + d.minute() as i64 * 60 + d.second() as i64
}

fn zip_date(secs: i64) -> zip::DateTime {
    let days = secs.div_euclid(86400);
    let rem = secs.rem_euclid(86400);
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + if m <= 2 { 1 } else { 0 };
    zip::DateTime::from_date_and_time(y.clamp(1980, 2107) as u16, m as u8, d as u8, (rem / 3600) as u8, (rem / 60 % 60) as u8, (rem % 60) as u8)
        .unwrap_or_default()
}

/// Packs `opts.inputs` into a ZIP archive (Deflate; ZIP64 for big files).
pub fn pack_zip(opts: &crate::pack::Options, output: &Path, progress: &mut dyn FnMut(u64) -> bool) -> Result<(u64, u64)> {
    use zip::write::SimpleFileOptions;

    let file = File::create(output).with_context(|| format!("cannot create {}", output.display()))?;
    let out_canon = fs::canonicalize(output)?;
    let mut z = zip::ZipWriter::new(BufWriter::new(file));
    let level = match opts.level {
        1..=3 => 1,
        4..=8 => 6,
        _ => 9,
    };
    let (mut files, mut bytes) = (0u64, 0u64);
    let mut buf = vec![0u8; 1 << 20];
    for input in &opts.inputs {
        let full = fs::canonicalize(input).with_context(|| format!("cannot read {}", input.display()))?;
        let root = full.file_name().map(|n| n.to_string_lossy().into_owned()).context("an input has no name")?;
        for entry in WalkDir::new(input).follow_links(false).sort_by_file_name() {
            let entry = entry?;
            let path = entry.path();
            let ftype = entry.file_type();
            if ftype.is_file() && fs::canonicalize(path).ok().as_deref() == Some(out_canon.as_path()) {
                continue;
            }
            let mut name = root.clone();
            for part in path.strip_prefix(input)?.components() {
                if let Component::Normal(part) = part {
                    name.push('/');
                    name.push_str(&part.to_string_lossy());
                }
            }
            let meta = entry.metadata()?;
            let mtime = meta.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map_or(0, |d| d.as_secs() as i64);
            let mut o = SimpleFileOptions::default().last_modified_time(zip_date(mtime));
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                o = o.unix_permissions(meta.permissions().mode() & 0o7777);
            }
            if ftype.is_dir() {
                z.add_directory(format!("{name}/"), o)?;
            } else if ftype.is_symlink() {
                let target = fs::read_link(path)?;
                z.add_symlink(name.clone(), target.to_string_lossy(), o)?;
            } else if ftype.is_file() {
                let o = o.compression_method(zip::CompressionMethod::Deflated).compression_level(Some(level)).large_file(meta.len() >= u32::MAX as u64);
                z.start_file(name.clone(), o)?;
                let mut f = File::open(path).with_context(|| format!("cannot open {}", path.display()))?;
                loop {
                    let n = f.read(&mut buf).with_context(|| format!("cannot read {}", path.display()))?;
                    if n == 0 {
                        break;
                    }
                    z.write_all(&buf[..n])?;
                    bytes += n as u64;
                    if !progress(bytes) {
                        bail!("cancelled");
                    }
                }
                files += 1;
            }
            if opts.verbose {
                println!("{name}");
            }
        }
    }
    let mut out = z.finish()?;
    out.flush()?;
    Ok((files, bytes))
}
