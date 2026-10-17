use std::io::{self, IsTerminal};
use std::path::{Path, PathBuf};
use std::process::ExitCode;
use std::time::{Duration, Instant};

use anyhow::Result;
use clap::{Parser, Subcommand};
use snake::format::human;
use snake::{pack, unpack};

#[derive(Parser)]
#[command(name = "snake", version, about = "Snake's Compressor - lossless archiver for transferring big files")]
struct Cli {
    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// Compress files and folders into a .snake archive (or a ZIP with --zip)
    Pack {
        /// Files and folders to compress
        #[arg(required = true)]
        inputs: Vec<PathBuf>,
        /// Archive to create [default: <first input>.snake]
        #[arg(short, long)]
        output: Option<PathBuf>,
        /// Compression level: 1 (fastest) to 22 (smallest)
        #[arg(short, long, default_value_t = 9, value_parser = clap::value_parser!(i32).range(1..=22))]
        level: i32,
        /// Smallest output: level 19. Much slower and uses several GB of RAM
        #[arg(long, conflicts_with = "level")]
        max: bool,
        /// Worker threads [default: all cores, or 4 with --max]
        #[arg(short, long)]
        threads: Option<u32>,
        /// Overwrite the archive if it already exists
        #[arg(short, long)]
        force: bool,
        /// Print each path as it is packed
        #[arg(short, long)]
        verbose: bool,
        /// Make a ZIP archive instead, for people without Snake's Compressor
        #[arg(long)]
        zip: bool,
    },
    /// Restore the contents of an archive (.snake, ZIP, 7z, tar, .tar.gz/.bz2/.xz/.zst, .gz...)
    Unpack {
        archive: PathBuf,
        /// Password of an encrypted ZIP or 7z archive
        #[arg(short, long)]
        password: Option<String>,
        /// Folder to unpack into
        #[arg(short, long, default_value = ".")]
        output: PathBuf,
        /// Overwrite files that already exist
        #[arg(short, long)]
        force: bool,
        /// Print each path as it is unpacked
        #[arg(short, long)]
        verbose: bool,
    },
    /// Show what is inside an archive
    List {
        archive: PathBuf,
        #[arg(short, long)]
        password: Option<String>,
    },
    /// Check an archive for damage without unpacking it
    Test {
        archive: PathBuf,
        #[arg(short, long)]
        password: Option<String>,
    },
}

/// A throttled one-line progress readout on stderr, shown only in a terminal.
struct Progress {
    enabled: bool,
    last: Instant,
}

impl Progress {
    fn new() -> Self {
        Progress { enabled: io::stderr().is_terminal(), last: Instant::now() }
    }

    fn tick(&mut self, bytes: u64) {
        if self.enabled && self.last.elapsed() >= Duration::from_millis(250) {
            self.last = Instant::now();
            eprint!("\r  {} read...   ", human(bytes));
        }
    }

    fn clear(&self) {
        if self.enabled {
            eprint!("\r{:40}\r", "");
        }
    }
}

fn pack(opts: &pack::Options) -> Result<()> {
    let mut progress = Progress::new();
    // Verbose output already shows activity, and the two would garble each other.
    let result = pack::run(opts, &mut |bytes| {
        if !opts.verbose {
            progress.tick(bytes)
        }
        true
    });
    progress.clear();
    let s = result?;
    let percent = if s.bytes > 0 { s.packed as f64 * 100.0 / s.bytes as f64 } else { 100.0 };
    println!(
        "{}: {} files, {} -> {} ({percent:.1}% of original) in {:.1}s",
        s.output.display(),
        s.files,
        human(s.bytes),
        human(s.packed),
        s.secs
    );
    Ok(())
}

fn unpack(archive: &Path, mode: unpack::Mode, password: Option<&str>, verbose: bool) -> Result<()> {
    let label = match &mode {
        unpack::Mode::Extract { dest, .. } => Some(dest.display().to_string()),
        _ => None,
    };
    let (list, quiet) = (matches!(mode, unpack::Mode::List), verbose || matches!(mode, unpack::Mode::List));
    let mut progress = Progress::new();
    let result = unpack::run_any(archive, mode, password, verbose, &mut |bytes| {
        if !quiet {
            progress.tick(bytes)
        }
        true
    });
    progress.clear();
    let s = result?;
    match label {
        Some(dest) => {
            println!("unpacked {} files ({}) into {dest} in {:.1}s, all checks passed", s.files, human(s.bytes), s.secs)
        }
        None if list => println!("{} files, {}", s.files, human(s.bytes)),
        None => println!("OK: {} files ({}) verified in {:.1}s", s.files, human(s.bytes), s.secs),
    }
    Ok(())
}

fn main() -> ExitCode {
    let result = match Cli::parse().cmd {
        Cmd::Pack { inputs, output, level, max, threads, force, verbose, zip } => {
            let cores = std::thread::available_parallelism().map_or(1, |n| n.get() as u32);
            // Each worker needs hundreds of MB at high levels, so --max uses fewer.
            let threads = threads.unwrap_or(if max { cores.min(4) } else { cores });
            let level = if max { 19 } else { level };
            pack(&pack::Options { inputs, output, level, threads, force, verbose, zip })
        }
        Cmd::Unpack { archive, output, force, verbose, password } => {
            unpack(&archive, unpack::Mode::Extract { dest: output, force }, password.as_deref(), verbose)
        }
        Cmd::List { archive, password } => unpack(&archive, unpack::Mode::List, password.as_deref(), false),
        Cmd::Test { archive, password } => unpack(&archive, unpack::Mode::Test, password.as_deref(), false),
    };

    match result {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("error: {e:#}");
            ExitCode::FAILURE
        }
    }
}
