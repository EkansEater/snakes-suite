# Snake's Compressor

A lossless archiver for moving big files and folders around. What you unpack is
bit-for-bit identical to what you packed, and every file is checksummed to prove it.

Works on Linux, Windows and macOS.

## Desktop app

Run `snake-gui`. Drop files or folders on the window (or use the Add buttons)
and press Compress; drop a `.snake` archive to unpack or verify it.

## Command line

```bash
snake pack my-folder                 # creates my-folder.snake
snake pack a.iso b.iso -o isos.snake # several inputs, chosen name
snake pack my-folder --max           # smallest output, much slower
snake unpack my-folder.snake         # restores into the current folder
snake unpack my-folder.snake -o dest # restores into dest/
snake list my-folder.snake           # show contents
snake test my-folder.snake           # verify integrity without unpacking
```

`--level 1` to `--level 22` trades speed for size (default 9). `snake pack --help`
lists everything.

## Build

Install Rust (https://rustup.rs), then:

```bash
cargo build --release
```

This produces two executables in `target/release/`: `snake` (command line) and
`snake-gui` (desktop app), with `.exe` added on Windows. Each is self-contained:
copy it anywhere, nothing else needs installing.

To build only the command line tool, for example on a server with no desktop:

```bash
cargo build --release --no-default-features
```

Run the tests with `cargo test`.

Each operating system needs its own build. The simplest way is to run the same
`cargo build --release` on a machine of each kind.

## How it works

- **Engine:** [Zstandard](https://facebook.github.io/zstd/), using every CPU
  core and a 128 MiB long-range match window, so repeated data far apart in a
  huge file is still found.
- **Integrity:** a BLAKE3 hash per file plus a checksum over the whole
  compressed stream. Damage in transfer is reported, never silently accepted.
- **Preserved:** file contents, folder structure, empty folders, modification
  times, Unix permissions, symlinks (symlinks are skipped when unpacking on Windows).
- **Safe unpacking:** archives cannot write outside the destination folder.

The format is described at the top of [src/format.rs](src/format.rs).

## What to expect

Text, logs, source code, databases, disk images and raw data shrink a lot.
Files that are already compressed (video, JPEG, MP3, zip, most game assets)
barely shrink with any lossless tool; that is a limit of mathematics, not of
this program.

Unpacking needs about 128 MiB of RAM. Packing with `--max` can use several GB.
