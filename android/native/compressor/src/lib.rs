//! Snake's Compressor on Android.
//!
//! Android hands out content Uris, not paths, so Kotlin walks the folders and
//! gives this library one open file descriptor at a time. The archive layout is
//! written with the desktop crate's `format` module, so a `.snake` made on a
//! phone unpacks on a PC and the other way round.
//!
//! Packing:   packBegin(fd) → packDir/packFile/packSymlink ... → packEnd
//! Unpacking: unpackBegin(fd) → unpackNext → unpackFile (for files) ... → unpackEnd
//!
//! `progress()` reads the bytes done so far from any thread; `cancel()` stops
//! the running operation at the next chunk.

use std::fs::File;
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::os::fd::FromRawFd;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};

use anyhow::{bail, Context, Result};
use jni::objects::{JClass, JString};
use jni::sys::{jboolean, jint, jlong, jstring, JNI_TRUE};
use jni::JNIEnv;
use snake::format::*;

static PROGRESS: AtomicU64 = AtomicU64::new(0);
static CANCEL: AtomicBool = AtomicBool::new(false);

fn check_cancel() -> Result<()> {
    if CANCEL.load(Ordering::Relaxed) {
        bail!("Cancelled");
    }
    Ok(())
}

/// Takes ownership of a file descriptor detached from a ParcelFileDescriptor.
fn file_from_fd(fd: jint) -> File {
    unsafe { File::from_raw_fd(fd) }
}

fn throw(env: &mut JNIEnv, e: anyhow::Error) {
    let _ = env.throw_new("java/io/IOException", format!("{e:#}"));
}

fn string(env: &mut JNIEnv, s: &JString) -> Result<String> {
    Ok(env.get_string(s).context("bad string from Java")?.into())
}

// ---------------------------------------------------------------- packing

struct Packer {
    enc: zstd::stream::write::Encoder<'static, CountingWriter>,
    buf: Vec<u8>,
}

/// Counts what reaches the archive, so the UI can show the packed size.
struct CountingWriter {
    inner: BufWriter<File>,
    written: u64,
}

impl Write for CountingWriter {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let n = self.inner.write(buf)?;
        self.written += n as u64;
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

fn pack_begin(fd: jint, level: jint, threads: jint) -> Result<Box<Packer>> {
    PROGRESS.store(0, Ordering::Relaxed);
    CANCEL.store(false, Ordering::Relaxed);
    let mut raw = CountingWriter { inner: BufWriter::new(file_from_fd(fd)), written: 0 };
    raw.write_all(MAGIC)?;
    raw.write_all(&[VERSION])?;
    let mut enc = zstd::stream::write::Encoder::new(raw, level)?;
    if threads > 1 {
        enc.multithread(threads as u32)?;
    }
    enc.long_distance_matching(true)?;
    enc.window_log(WINDOW_LOG)?;
    enc.include_checksum(true)?;
    Ok(Box::new(Packer { enc, buf: vec![0u8; CHUNK] }))
}

fn entry_header(p: &mut Packer, kind: u8, name: &str, mode: u32, mtime: i64) -> Result<()> {
    if name.is_empty() || name.len() > MAX_PATH_LEN {
        bail!("bad name {name:?}");
    }
    p.enc.write_all(&[kind])?;
    write_str(&mut p.enc, name)?;
    write_u32(&mut p.enc, mode)?;
    write_i64(&mut p.enc, mtime)?;
    Ok(())
}

fn pack_file(p: &mut Packer, name: &str, mode: u32, mtime: i64, fd: jint) -> Result<()> {
    let mut f = file_from_fd(fd);
    entry_header(p, KIND_FILE, name, mode, mtime)?;
    let mut hasher = blake3::Hasher::new();
    let mut size = 0u64;
    loop {
        check_cancel()?;
        let n = f.read(&mut p.buf).with_context(|| format!("cannot read {name}"))?;
        if n == 0 {
            break;
        }
        write_u32(&mut p.enc, n as u32)?;
        p.enc.write_all(&p.buf[..n])?;
        hasher.update(&p.buf[..n]);
        size += n as u64;
        PROGRESS.fetch_add(n as u64, Ordering::Relaxed);
    }
    write_u32(&mut p.enc, 0)?;
    write_u64(&mut p.enc, size)?;
    p.enc.write_all(hasher.finalize().as_bytes())?;
    Ok(())
}

fn pack_end(p: Box<Packer>) -> Result<u64> {
    let mut p = p;
    p.enc.write_all(&[KIND_END])?;
    let mut raw = p.enc.finish()?;
    raw.flush()?;
    raw.inner.get_ref().sync_all().ok();
    Ok(raw.written)
}

#[no_mangle]
pub extern "system" fn Java_com_snake_suite_compressor_NativeSnake_packBegin(
    mut env: JNIEnv, _: JClass, fd: jint, level: jint, threads: jint,
) -> jlong {
    match pack_begin(fd, level, threads) {
        Ok(p) => Box::into_raw(p) as jlong,
        Err(e) => {
            throw(&mut env, e);
            0
        }
    }
}

#[no_mangle]
pub extern "system" fn Java_com_snake_suite_compressor_NativeSnake_packDir(
    mut env: JNIEnv, _: JClass, h: jlong, name: JString, mode: jint, mtime: jlong,
) {
    let p = unsafe { &mut *(h as *mut Packer) };
    let r = string(&mut env, &name).and_then(|n| entry_header(p, KIND_DIR, &n, mode as u32, mtime));
    if let Err(e) = r {
        throw(&mut env, e);
    }
}

#[no_mangle]
pub extern "system" fn Java_com_snake_suite_compressor_NativeSnake_packFile(
    mut env: JNIEnv, _: JClass, h: jlong, name: JString, mode: jint, mtime: jlong, fd: jint,
) {
    let p = unsafe { &mut *(h as *mut Packer) };
    let r = string(&mut env, &name).and_then(|n| pack_file(p, &n, mode as u32, mtime, fd));
    if let Err(e) = r {
        throw(&mut env, e);
    }
}

/// Finishes the archive; returns its size in bytes.
#[no_mangle]
pub extern "system" fn Java_com_snake_suite_compressor_NativeSnake_packEnd(
    mut env: JNIEnv, _: JClass, h: jlong,
) -> jlong {
    let p = unsafe { Box::from_raw(h as *mut Packer) };
    match pack_end(p) {
        Ok(n) => n as jlong,
        Err(e) => {
            throw(&mut env, e);
            0
        }
    }
}

/// Drops a half-written archive (the Kotlin side deletes the file).
#[no_mangle]
pub extern "system" fn Java_com_snake_suite_compressor_NativeSnake_packAbort(_: JNIEnv, _: JClass, h: jlong) {
    if h != 0 {
        drop(unsafe { Box::from_raw(h as *mut Packer) });
    }
}

// ---------------------------------------------------------------- unpacking

/// Reports how far into the archive file we are.
struct CountingReader {
    inner: File,
}

impl Read for CountingReader {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let n = self.inner.read(buf)?;
        PROGRESS.fetch_add(n as u64, Ordering::Relaxed);
        Ok(n)
    }
}

struct Unpacker {
    dec: zstd::stream::read::Decoder<'static, BufReader<CountingReader>>,
    buf: Vec<u8>,
}

fn unpack_begin(fd: jint) -> Result<Box<Unpacker>> {
    PROGRESS.store(0, Ordering::Relaxed);
    CANCEL.store(false, Ordering::Relaxed);
    let mut raw = BufReader::new(CountingReader { inner: file_from_fd(fd) });
    let mut header = [0u8; MAGIC.len() + 1];
    raw.read_exact(&mut header).context("not a .snake archive")?;
    if &header[..MAGIC.len()] != MAGIC {
        bail!("not a .snake archive");
    }
    if header[MAGIC.len()] != VERSION {
        bail!("archive format version {} is not supported by this version", header[MAGIC.len()]);
    }
    let mut dec = zstd::stream::read::Decoder::with_buffer(raw)?;
    dec.window_log_max(WINDOW_LOG_MAX)?;
    Ok(Box::new(Unpacker { dec, buf: vec![0u8; CHUNK] }))
}

/// The next entry as "kind\tmode\tmtime\tname[\ttarget]", or None at the end.
fn unpack_next(u: &mut Unpacker) -> Result<Option<String>> {
    check_cancel()?;
    let kind = read_u8(&mut u.dec).context("archive is truncated or corrupt")?;
    if kind == KIND_END {
        return Ok(None);
    }
    let name = read_str(&mut u.dec).context("archive is corrupt")?;
    let mode = read_u32(&mut u.dec)?;
    let mtime = read_i64(&mut u.dec)?;
    let mut line = format!("{kind}\t{mode}\t{mtime}\t{name}");
    match kind {
        KIND_DIR | KIND_FILE => {}
        KIND_SYMLINK => {
            let target = read_str(&mut u.dec).context("archive is corrupt")?;
            line.push('\t');
            line.push_str(&target);
        }
        other => bail!("archive is corrupt (unknown entry type {other})"),
    }
    Ok(Some(line))
}

/// Streams the current file entry into `fd` (or nowhere when fd < 0), verifying its checksum.
fn unpack_file(u: &mut Unpacker, fd: jint) -> Result<u64> {
    let mut out = (fd >= 0).then(|| BufWriter::new(file_from_fd(fd)));
    let mut hasher = blake3::Hasher::new();
    let mut size = 0u64;
    loop {
        check_cancel()?;
        let n = read_u32(&mut u.dec).context("archive is truncated or corrupt")? as usize;
        if n == 0 {
            break;
        }
        if n > CHUNK {
            bail!("archive is corrupt (bad chunk)");
        }
        u.dec.read_exact(&mut u.buf[..n]).context("archive is truncated or corrupt")?;
        hasher.update(&u.buf[..n]);
        if let Some(f) = &mut out {
            f.write_all(&u.buf[..n])?;
        }
        size += n as u64;
    }
    let stored_size = read_u64(&mut u.dec)?;
    let mut stored_hash = [0u8; 32];
    u.dec.read_exact(&mut stored_hash)?;
    if stored_size != size || hasher.finalize().as_bytes() != &stored_hash {
        bail!("checksum mismatch: the archive is damaged");
    }
    if let Some(mut f) = out {
        f.flush()?;
    }
    Ok(size)
}

fn unpack_end(u: Box<Unpacker>) -> Result<()> {
    let mut u = u;
    // Reading to the end of the zstd frame makes it verify its own checksum.
    if u.dec.read(&mut u.buf[..1]).context("archive is corrupt")? != 0 {
        bail!("archive is corrupt (unexpected data after the end)");
    }
    Ok(())
}

#[no_mangle]
pub extern "system" fn Java_com_snake_suite_compressor_NativeSnake_unpackBegin(
    mut env: JNIEnv, _: JClass, fd: jint,
) -> jlong {
    match unpack_begin(fd) {
        Ok(u) => Box::into_raw(u) as jlong,
        Err(e) => {
            throw(&mut env, e);
            0
        }
    }
}

#[no_mangle]
pub extern "system" fn Java_com_snake_suite_compressor_NativeSnake_unpackNext(
    mut env: JNIEnv, _: JClass, h: jlong,
) -> jstring {
    let u = unsafe { &mut *(h as *mut Unpacker) };
    match unpack_next(u) {
        Ok(Some(line)) => env.new_string(line).map(|s| s.into_raw()).unwrap_or(std::ptr::null_mut()),
        Ok(None) => std::ptr::null_mut(),
        Err(e) => {
            throw(&mut env, e);
            std::ptr::null_mut()
        }
    }
}

#[no_mangle]
pub extern "system" fn Java_com_snake_suite_compressor_NativeSnake_unpackFile(
    mut env: JNIEnv, _: JClass, h: jlong, fd: jint,
) -> jlong {
    let u = unsafe { &mut *(h as *mut Unpacker) };
    match unpack_file(u, fd) {
        Ok(n) => n as jlong,
        Err(e) => {
            throw(&mut env, e);
            0
        }
    }
}

/// Checks the end of the archive and frees the reader. With `verify` false it only frees.
#[no_mangle]
pub extern "system" fn Java_com_snake_suite_compressor_NativeSnake_unpackEnd(
    mut env: JNIEnv, _: JClass, h: jlong, verify: jboolean,
) {
    if h == 0 {
        return;
    }
    let u = unsafe { Box::from_raw(h as *mut Unpacker) };
    if verify == JNI_TRUE {
        if let Err(e) = unpack_end(u) {
            throw(&mut env, e);
        }
    }
}

// ---------------------------------------------------------------- shared

#[no_mangle]
pub extern "system" fn Java_com_snake_suite_compressor_NativeSnake_progress(_: JNIEnv, _: JClass) -> jlong {
    PROGRESS.load(Ordering::Relaxed) as jlong
}

#[no_mangle]
pub extern "system" fn Java_com_snake_suite_compressor_NativeSnake_cancel(_: JNIEnv, _: JClass) {
    CANCEL.store(true, Ordering::Relaxed);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::fd::IntoRawFd;

    /// An archive packed through the Android bridge unpacks with the desktop engine, and back.
    #[test]
    fn archives_move_between_android_and_desktop() {
        let dir = std::env::temp_dir().join(format!("snake-android-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src/sub")).unwrap();
        let data: Vec<u8> = (0..3_000_000u32).map(|i| (i % 251) as u8).collect();
        std::fs::write(dir.join("src/big.bin"), &data).unwrap();
        std::fs::write(dir.join("src/sub/hello.txt"), b"hello snake").unwrap();

        // Pack like the app does: entries one by one from fds.
        let archive = dir.join("phone.snake");
        let mut p = pack_begin(File::create(&archive).unwrap().into_raw_fd(), 9, 2).unwrap();
        entry_header(&mut p, KIND_DIR, "src", 0o755, 0).unwrap();
        pack_file(&mut p, "src/big.bin", 0o644, 1_700_000_000, File::open(dir.join("src/big.bin")).unwrap().into_raw_fd()).unwrap();
        entry_header(&mut p, KIND_DIR, "src/sub", 0o755, 0).unwrap();
        pack_file(&mut p, "src/sub/hello.txt", 0o644, 0, File::open(dir.join("src/sub/hello.txt")).unwrap().into_raw_fd()).unwrap();
        let packed = pack_end(p).unwrap();
        assert_eq!(packed, std::fs::metadata(&archive).unwrap().len());

        // The desktop engine reads it.
        let out = dir.join("out");
        snake::unpack::run(&archive, snake::unpack::Mode::Extract { dest: out.clone(), force: false }, false, &mut |_| {}).unwrap();
        assert_eq!(std::fs::read(out.join("src/big.bin")).unwrap(), data);
        assert_eq!(std::fs::read(out.join("src/sub/hello.txt")).unwrap(), b"hello snake");

        // A desktop archive unpacks through the bridge.
        let desktop = dir.join("pc.snake");
        snake::pack::run(&snake::pack::Options { inputs: vec![dir.join("src")], output: Some(desktop.clone()), level: 3,
            threads: 1, force: true, verbose: false }, &mut |_| {}).unwrap();
        let mut u = unpack_begin(File::open(&desktop).unwrap().into_raw_fd()).unwrap();
        let mut names = vec![];
        while let Some(line) = unpack_next(&mut u).unwrap() {
            let parts: Vec<&str> = line.split('\t').collect();
            if parts[0] == KIND_FILE.to_string() {
                let target = dir.join("copy");
                let n = unpack_file(&mut u, File::create(&target).unwrap().into_raw_fd()).unwrap();
                assert_eq!(n, std::fs::metadata(&target).unwrap().len());
            }
            names.push(parts[3].to_string());
        }
        unpack_end(u).unwrap();
        assert_eq!(names, ["src", "src/big.bin", "src/sub", "src/sub/hello.txt"]);
        std::fs::remove_dir_all(&dir).unwrap();
    }
}
