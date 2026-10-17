//! Snake's Compressor's engine for the browser: zstd streaming (compress and decompress)
//! and BLAKE3 hashing, behind a small C-style interface that the page drives
//! (apps/compressor/engine.js in the Studio). Pointers are offsets into this module's memory.

use std::slice;

use zstd::stream::raw::{CParameter, DParameter, Decoder, Encoder, InBuffer, Operation, OutBuffer};

/// Memory the page fills with input (and frees again).
#[no_mangle]
pub extern "C" fn buf_alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// `p` and `len` must come from `buf_alloc`.
#[no_mangle]
pub unsafe extern "C" fn buf_free(p: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(p, 0, len));
}

enum Codec {
    Enc(Encoder<'static>),
    Dec(Decoder<'static>),
}

/// A compression or decompression stream; its output collects in `out` until the page takes it.
pub struct Stream {
    codec: Codec,
    out: Vec<u8>,
    /// Decompression: the frame ended.
    done: bool,
}

const SCRATCH: usize = 1 << 17;

/// A compressor like the desktop's: `level` 1-22, a 2^`window_log` byte window, long-distance
/// matching, and a checksum at the end of the frame. Null on failure.
#[no_mangle]
pub extern "C" fn enc_new(level: i32, window_log: u32) -> *mut Stream {
    let make = || -> std::io::Result<Encoder<'static>> {
        let mut e = Encoder::new(level)?;
        e.set_parameter(CParameter::ChecksumFlag(true))?;
        e.set_parameter(CParameter::EnableLongDistanceMatching(true))?;
        e.set_parameter(CParameter::WindowLog(window_log))?;
        Ok(e)
    };
    match make() {
        Ok(e) => Box::into_raw(Box::new(Stream { codec: Codec::Enc(e), out: Vec::new(), done: false })),
        Err(_) => std::ptr::null_mut(),
    }
}

/// A decompressor that accepts windows up to 2^30, the most zstd allows on 32-bit WebAssembly
/// (the desktop allows 2^31; archives use 2^27). Null on failure.
#[no_mangle]
pub extern "C" fn dec_new() -> *mut Stream {
    let make = || -> std::io::Result<Decoder<'static>> {
        let mut d = Decoder::new()?;
        d.set_parameter(DParameter::WindowLogMax(30))?;
        Ok(d)
    };
    match make() {
        Ok(d) => Box::into_raw(Box::new(Stream { codec: Codec::Dec(d), out: Vec::new(), done: false })),
        Err(_) => std::ptr::null_mut(),
    }
}

/// Feed `len` bytes at `p`. Returns how many were used (decompression stops at the end of
/// the frame), or -1 if the data is damaged.
///
/// # Safety
/// `s` from `enc_new`/`dec_new`; `p` points to `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn stream_write(s: *mut Stream, p: *const u8, len: usize) -> isize {
    let s = &mut *s;
    let input = slice::from_raw_parts(p, len);
    let mut inb = InBuffer::around(input);
    let mut scratch = vec![0u8; SCRATCH];
    loop {
        let mut outb = OutBuffer::around(&mut scratch[..]);
        let hint = match &mut s.codec {
            Codec::Enc(e) => e.run(&mut inb, &mut outb),
            Codec::Dec(d) => d.run(&mut inb, &mut outb),
        };
        let wrote = outb.pos();
        s.out.extend_from_slice(&scratch[..wrote]);
        match hint {
            Err(_) => return -1,
            Ok(h) => {
                if matches!(s.codec, Codec::Dec(_)) && h == 0 {
                    s.done = true;
                    return inb.pos as isize;
                }
            }
        }
        // Done when all input is used and the last round did not fill the scratch buffer.
        if inb.pos >= input.len() && wrote < SCRATCH {
            return inb.pos as isize;
        }
    }
}

/// Compression: end the frame (writes the rest and the checksum). 0, or -1 on failure.
///
/// # Safety
/// `s` from `enc_new`.
#[no_mangle]
pub unsafe extern "C" fn enc_finish(s: *mut Stream) -> i32 {
    let s = &mut *s;
    let Codec::Enc(e) = &mut s.codec else { return -1 };
    let mut scratch = vec![0u8; SCRATCH];
    loop {
        let mut outb = OutBuffer::around(&mut scratch[..]);
        let left = match e.finish(&mut outb, true) {
            Ok(n) => n,
            Err(_) => return -1,
        };
        let wrote = outb.pos();
        s.out.extend_from_slice(&scratch[..wrote]);
        if left == 0 {
            return 0;
        }
    }
}

/// # Safety
/// `s` from `dec_new`.
#[no_mangle]
pub unsafe extern "C" fn dec_done(s: *mut Stream) -> i32 {
    (*s).done as i32
}

/// # Safety
/// `s` from `enc_new`/`dec_new`.
#[no_mangle]
pub unsafe extern "C" fn out_ptr(s: *mut Stream) -> *const u8 {
    (*s).out.as_ptr()
}

/// # Safety
/// `s` from `enc_new`/`dec_new`.
#[no_mangle]
pub unsafe extern "C" fn out_len(s: *mut Stream) -> usize {
    (*s).out.len()
}

/// The page took the output: forget it.
///
/// # Safety
/// `s` from `enc_new`/`dec_new`.
#[no_mangle]
pub unsafe extern "C" fn out_clear(s: *mut Stream) {
    (*s).out.clear();
}

/// # Safety
/// `s` from `enc_new`/`dec_new`, not used again.
#[no_mangle]
pub unsafe extern "C" fn stream_free(s: *mut Stream) {
    drop(Box::from_raw(s));
}

#[no_mangle]
pub extern "C" fn hash_new() -> *mut blake3::Hasher {
    Box::into_raw(Box::new(blake3::Hasher::new()))
}

/// # Safety
/// `h` from `hash_new`; `p` points to `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn hash_update(h: *mut blake3::Hasher, p: *const u8, len: usize) {
    (*h).update(slice::from_raw_parts(p, len));
}

/// Writes the 32-byte hash to `out` and frees the hasher.
///
/// # Safety
/// `h` from `hash_new`, not used again; `out` has room for 32 bytes.
#[no_mangle]
pub unsafe extern "C" fn hash_finish(h: *mut blake3::Hasher, out: *mut u8) {
    let h = Box::from_raw(h);
    slice::from_raw_parts_mut(out, 32).copy_from_slice(h.finalize().as_bytes());
}
