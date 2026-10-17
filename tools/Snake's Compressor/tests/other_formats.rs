//! Archives of other programs: ZIP made here, tar.gz and plain .gz read, listing,
//! cancelling, and refusing paths that would escape the destination.
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};

use snake::other::{self, Kind, Wrap};
use snake::{pack, unpack};

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("snake-other-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn tree(root: &Path) {
    fs::create_dir_all(root.join("a/b")).unwrap();
    fs::create_dir_all(root.join("empty")).unwrap();
    fs::write(root.join("a/text.txt"), "hello zip\n".repeat(10_000)).unwrap();
    fs::write(root.join("a/b/bytes.bin"), (0..300_000u32).map(|i| (i * 7 % 251) as u8).collect::<Vec<_>>()).unwrap();
}

fn same(a: &Path, b: &Path) {
    for e in walkdir::WalkDir::new(a) {
        let e = e.unwrap();
        let rel = e.path().strip_prefix(a).unwrap();
        let other = b.join(rel);
        if e.file_type().is_dir() {
            assert!(other.is_dir(), "missing folder {}", other.display());
        } else {
            assert_eq!(fs::read(e.path()).unwrap(), fs::read(&other).unwrap(), "{} differs", rel.display());
        }
    }
}

#[test]
fn zip_made_here_unpacks_exactly() {
    let dir = scratch("zip");
    tree(&dir.join("data"));
    let out = dir.join("data.zip");
    let opts = pack::Options { inputs: vec![dir.join("data")], output: Some(out.clone()), level: 9, threads: 1, force: false, verbose: false, zip: true };
    let s = pack::run(&opts, &mut |_| true).unwrap();
    assert_eq!(s.files, 2);
    assert_eq!(other::detect(&out).unwrap(), Some(Kind::Zip));
    let list = other::entries(&out, Kind::Zip, None).unwrap();
    assert!(list.iter().any(|e| e.name == "data/a/b/bytes.bin" && e.size == 300_000));
    let dest = dir.join("out");
    unpack::run_any(&out, unpack::Mode::Extract { dest: dest.clone(), force: false }, None, false, &mut |_| true).unwrap();
    same(&dir.join("data"), &dest.join("data"));
}

#[test]
fn tar_gz_and_gz_are_read() {
    let dir = scratch("tgz");
    tree(&dir.join("data"));
    let tgz = dir.join("data.tar.gz");
    {
        let f = fs::File::create(&tgz).unwrap();
        let gz = flate2::write::GzEncoder::new(f, flate2::Compression::default());
        let mut t = tar::Builder::new(gz);
        t.append_dir_all("data", dir.join("data")).unwrap();
        t.into_inner().unwrap().finish().unwrap();
    }
    assert_eq!(other::detect(&tgz).unwrap(), Some(Kind::Tar(Wrap::Gzip)));
    let dest = dir.join("out");
    let s = unpack::run_any(&tgz, unpack::Mode::Extract { dest: dest.clone(), force: false }, None, false, &mut |_| true).unwrap();
    assert_eq!(s.files, 2);
    same(&dir.join("data"), &dest.join("data"));
    // Listing through Collect, as the window does.
    let list = Arc::new(Mutex::new(Vec::new()));
    unpack::run_any(&tgz, unpack::Mode::Collect(list.clone()), None, false, &mut |_| true).unwrap();
    assert!(list.lock().unwrap().iter().any(|e| e.name == "data/a/text.txt" && e.size == 100_000));

    let gz = dir.join("notes.txt.gz");
    let mut enc = flate2::write::GzEncoder::new(fs::File::create(&gz).unwrap(), flate2::Compression::default());
    enc.write_all(b"just one file\n").unwrap();
    enc.finish().unwrap();
    assert_eq!(other::detect(&gz).unwrap(), Some(Kind::Single(Wrap::Gzip)));
    unpack::run_any(&gz, unpack::Mode::Extract { dest: dir.join("one"), force: false }, None, false, &mut |_| true).unwrap();
    assert_eq!(fs::read(dir.join("one/notes.txt")).unwrap(), b"just one file\n");
}

#[test]
fn escaping_paths_are_refused_and_cancel_stops() {
    let dir = scratch("evil");
    let evil = dir.join("evil.zip");
    {
        let mut z = zip::ZipWriter::new(fs::File::create(&evil).unwrap());
        z.start_file("../../escaped.txt", zip::write::SimpleFileOptions::default()).unwrap();
        z.write_all(b"no").unwrap();
        z.finish().unwrap();
    }
    let dest = dir.join("out");
    fs::create_dir_all(&dest).unwrap();
    assert!(unpack::run_any(&evil, unpack::Mode::Extract { dest: dest.clone(), force: false }, None, false, &mut |_| true).is_err());
    assert!(!dir.join("escaped.txt").exists() && !dir.parent().unwrap().join("escaped.txt").exists());

    // Cancelling a pack leaves no half-written archive behind.
    tree(&dir.join("data"));
    let out = dir.join("data.snake");
    let opts = pack::Options { inputs: vec![dir.join("data")], output: Some(out.clone()), level: 3, threads: 1, force: false, verbose: false, zip: false };
    let err = match pack::run(&opts, &mut |_| false) {
        Ok(_) => panic!("packing should have stopped"),
        Err(e) => e,
    };
    assert!(format!("{err:#}").contains("cancelled"));
    assert!(!out.exists());
}
