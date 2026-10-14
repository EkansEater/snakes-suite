//! The .snake archive format.
//!
//! ```text
//! "SNAKE\0"  version:u8                      (uncompressed)
//! one zstd frame (with checksum) containing a stream of entries:
//!   kind:u8  path_len:u32  path  mode:u32  mtime:i64
//!   file:     { chunk_len:u32  chunk }*  0:u32  size:u64  blake3:[u8; 32]
//!   symlink:  target_len:u32  target
//!   dir:      (nothing)
//! kind 0 ends the archive.
//! ```
//!
//! All integers are little-endian. Paths are UTF-8, relative, '/'-separated.

use std::io::{self, Read, Write};

pub const MAGIC: &[u8; 6] = b"SNAKE\0";
pub const VERSION: u8 = 1;

/// Match window used when compressing: 2^27 = 128 MiB. Lets zstd find
/// repeats that are far apart in big files; decompression needs this much RAM.
pub const WINDOW_LOG: u32 = 27;
/// Largest window the decompressor accepts.
pub const WINDOW_LOG_MAX: u32 = 31;

pub const CHUNK: usize = 1 << 20;
pub const MAX_PATH_LEN: usize = 1 << 16;

pub const KIND_END: u8 = 0;
pub const KIND_FILE: u8 = 1;
pub const KIND_DIR: u8 = 2;
pub const KIND_SYMLINK: u8 = 3;

pub fn write_u32(w: &mut impl Write, v: u32) -> io::Result<()> {
    w.write_all(&v.to_le_bytes())
}

pub fn write_u64(w: &mut impl Write, v: u64) -> io::Result<()> {
    w.write_all(&v.to_le_bytes())
}

pub fn write_i64(w: &mut impl Write, v: i64) -> io::Result<()> {
    w.write_all(&v.to_le_bytes())
}

pub fn write_str(w: &mut impl Write, s: &str) -> io::Result<()> {
    write_u32(w, s.len() as u32)?;
    w.write_all(s.as_bytes())
}

pub fn read_u8(r: &mut impl Read) -> io::Result<u8> {
    let mut b = [0u8; 1];
    r.read_exact(&mut b)?;
    Ok(b[0])
}

pub fn read_u32(r: &mut impl Read) -> io::Result<u32> {
    let mut b = [0u8; 4];
    r.read_exact(&mut b)?;
    Ok(u32::from_le_bytes(b))
}

pub fn read_u64(r: &mut impl Read) -> io::Result<u64> {
    let mut b = [0u8; 8];
    r.read_exact(&mut b)?;
    Ok(u64::from_le_bytes(b))
}

pub fn read_i64(r: &mut impl Read) -> io::Result<i64> {
    let mut b = [0u8; 8];
    r.read_exact(&mut b)?;
    Ok(i64::from_le_bytes(b))
}

pub fn read_str(r: &mut impl Read) -> io::Result<String> {
    let len = read_u32(r)? as usize;
    if len > MAX_PATH_LEN {
        return Err(io::Error::new(io::ErrorKind::InvalidData, "path too long"));
    }
    let mut buf = vec![0u8; len];
    r.read_exact(&mut buf)?;
    String::from_utf8(buf).map_err(|e| io::Error::new(io::ErrorKind::InvalidData, e))
}

pub fn human(bytes: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KiB", "MiB", "GiB", "TiB"];
    let mut v = bytes as f64;
    let mut unit = 0;
    while v >= 1024.0 && unit < UNITS.len() - 1 {
        v /= 1024.0;
        unit += 1;
    }
    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{v:.2} {}", UNITS[unit])
    }
}
