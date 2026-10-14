use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

fn snake(dir: &Path, args: &[&str]) -> bool {
    Command::new(env!("CARGO_BIN_EXE_snake"))
        .current_dir(dir)
        .args(args)
        .status()
        .expect("failed to run snake")
        .success()
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("snake-test-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

/// Incompressible bytes, so the data spans several chunks after compression too.
fn noise(len: usize) -> Vec<u8> {
    let mut x = 0x2545F4914F6CDD1Du64;
    (0..len)
        .map(|_| {
            x ^= x << 13;
            x ^= x >> 7;
            x ^= x << 17;
            x as u8
        })
        .collect()
}

fn make_tree(root: &Path) {
    fs::create_dir_all(root.join("nested/deep")).unwrap();
    fs::create_dir_all(root.join("empty-dir")).unwrap();
    fs::write(root.join("text.txt"), "the quick brown fox\n".repeat(50_000)).unwrap();
    fs::write(root.join("empty.bin"), b"").unwrap();
    fs::write(root.join("nested/noise.bin"), noise(3 * 1024 * 1024 + 123)).unwrap();
    fs::write(root.join("nested/deep/one-byte"), b"x").unwrap();
}

fn assert_same(a: &Path, b: &Path) {
    let mut names: Vec<_> = fs::read_dir(a).unwrap().map(|e| e.unwrap().file_name()).collect();
    let mut other: Vec<_> = fs::read_dir(b).unwrap().map(|e| e.unwrap().file_name()).collect();
    names.sort();
    other.sort();
    assert_eq!(names, other, "different entries in {}", a.display());
    for name in names {
        let (pa, pb) = (a.join(&name), b.join(&name));
        if pa.is_dir() {
            assert!(pb.is_dir());
            assert_same(&pa, &pb);
        } else {
            assert!(fs::read(&pa).unwrap() == fs::read(&pb).unwrap(), "{} differs", pa.display());
        }
    }
}

#[test]
fn roundtrip_is_bit_exact() {
    let dir = scratch("roundtrip");
    make_tree(&dir.join("data"));

    assert!(snake(&dir, &["pack", "data"]));
    assert!(snake(&dir, &["test", "data.snake"]));
    assert!(snake(&dir, &["list", "data.snake"]));
    assert!(snake(&dir, &["unpack", "data.snake", "-o", "out"]));
    assert_same(&dir.join("data"), &dir.join("out/data"));

    let packed = fs::metadata(dir.join("data.snake")).unwrap().len();
    assert!(packed < 3 * 1024 * 1024 + 200_000, "text should have compressed away, got {packed}");

    // Refuses to clobber without --force, succeeds with it.
    assert!(!snake(&dir, &["unpack", "data.snake", "-o", "out"]));
    assert!(snake(&dir, &["unpack", "data.snake", "-o", "out", "--force"]));
    assert!(!snake(&dir, &["pack", "data"]));

    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn single_file_and_max_level() {
    let dir = scratch("single");
    fs::write(dir.join("big.log"), "2026-10-11 INFO request served in 12ms\n".repeat(100_000)).unwrap();

    assert!(snake(&dir, &["pack", "big.log", "--max", "-o", "log.snake"]));
    assert!(snake(&dir, &["unpack", "log.snake", "-o", "out"]));
    assert!(fs::read(dir.join("big.log")).unwrap() == fs::read(dir.join("out/big.log")).unwrap());

    fs::remove_dir_all(&dir).unwrap();
}

#[test]
fn damage_is_detected() {
    let dir = scratch("damage");
    make_tree(&dir.join("data"));
    assert!(snake(&dir, &["pack", "data"]));

    let archive = dir.join("data.snake");
    let good = fs::read(&archive).unwrap();

    let mut flipped = good.clone();
    let mid = flipped.len() / 2;
    flipped[mid] ^= 0x01;
    fs::write(&archive, &flipped).unwrap();
    assert!(!snake(&dir, &["test", "data.snake"]), "bit flip went unnoticed");

    fs::write(&archive, &good[..good.len() - 100]).unwrap();
    assert!(!snake(&dir, &["test", "data.snake"]), "truncation went unnoticed");

    fs::write(&archive, b"definitely not an archive").unwrap();
    assert!(!snake(&dir, &["test", "data.snake"]));

    fs::remove_dir_all(&dir).unwrap();
}
