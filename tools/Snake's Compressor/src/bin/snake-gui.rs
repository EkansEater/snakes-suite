// Don't open a console window alongside the app on Windows.
#![cfg_attr(windows, windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result};
use eframe::egui;
use snake::format::human;
use snake::other::{self, Kind};
use snake::unpack::Entry;
use snake::{pack, unpack};

#[path = "../gui/snake_theme.rs"]
mod snake_theme;

const ICON: &[u8] = include_bytes!("../../assets/icon64.rgba");

fn main() -> eframe::Result {
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_title("Snake's Compressor")
            .with_app_id("snakes-compressor")
            .with_icon(snake_theme::icon_data(ICON))
            .with_inner_size([620.0, 540.0])
            .with_min_inner_size([460.0, 400.0])
            .with_drag_and_drop(true),
        ..Default::default()
    };
    eframe::run_native(
        "Snake's Compressor",
        options,
        Box::new(|cc| {
            snake_theme::apply(&cc.egui_ctx);
            let logo = snake_theme::logo_texture(&cc.egui_ctx, ICON);
            let mut app = App { logo: Some(logo), ..App::default() };
            // Files given on the command line ("Open with" from a file manager).
            app.add(std::env::args_os().skip(1).map(PathBuf::from).filter(|p| p.exists()).collect());
            Ok(Box::new(app))
        }),
    )
}

/// Progress shared between the worker thread and the window.
#[derive(Default)]
struct Meter {
    done: AtomicU64,
    total: AtomicU64,
}

struct Job {
    label: String,
    meter: Arc<Meter>,
    cancel: Arc<AtomicBool>,
    result: Receiver<Result<String>>,
}

struct App {
    /// Files and folders waiting to be compressed.
    inputs: Vec<PathBuf>,
    /// An archive waiting to be unpacked. Takes over the window when set.
    archive: Option<PathBuf>,
    /// What kind of archive it is.
    kind: Option<Kind>,
    /// Password of an encrypted ZIP or 7z archive.
    password: String,
    /// What is inside the archive, once read; and the search over it.
    entries: Option<Vec<Entry>>,
    listing: Option<Arc<Mutex<Vec<Entry>>>>,
    filter: String,
    /// Make ZIP archives (open anywhere) instead of .snake ones.
    zip: bool,
    /// The folder the last unpacking went into, to open it.
    unpacked_to: Option<PathBuf>,
    level: i32,
    /// Where the new archive goes, if the user picked somewhere.
    output: Option<PathBuf>,
    /// Where to unpack, if the user picked somewhere.
    dest: Option<PathBuf>,
    overwrite: bool,
    job: Option<Job>,
    message: Option<Result<String, String>>,
    logo: Option<egui::TextureHandle>,
}

impl Default for App {
    fn default() -> Self {
        App {
            inputs: Vec::new(),
            archive: None,
            kind: None,
            password: String::new(),
            entries: None,
            listing: None,
            filter: String::new(),
            zip: false,
            unpacked_to: None,
            level: 9,
            output: None,
            dest: None,
            overwrite: false,
            job: None,
            message: None,
            logo: None,
        }
    }
}

impl eframe::App for App {
    fn ui(&mut self, ui: &mut egui::Ui, _frame: &mut eframe::Frame) {
        self.poll_job();
        snake_theme::screenshot_hook(ui.ctx());
        snake_theme::ergonomics(ui.ctx(), "compressor");

        let dropped: Vec<PathBuf> =
            ui.ctx().input(|i| i.raw.dropped_files.iter().map(|f| f.path().to_path_buf()).collect());
        if self.job.is_none() {
            self.add(dropped);
        }

        egui::Panel::top("header").frame(snake_theme::header_frame()).show(ui, |ui| {
            snake_theme::header_title(ui, self.logo.as_ref(), "Snake's Compressor", "Lossless archives; opens ZIP, 7z and tar too");
        });

        egui::Panel::bottom("status").frame(snake_theme::status_frame()).show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.set_min_height(20.0);
                if let Some(job) = &self.job {
                    ui.add(egui::Spinner::new().color(snake_theme::HIGHLIGHT));
                    ui.label(egui::RichText::new(&job.label).color(snake_theme::FG2));
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if ui.button("Cancel").clicked() {
                            job.cancel.store(true, Ordering::Relaxed);
                        }
                    });
                } else {
                    let text = match self.archive {
                        Some(_) => "Ready to unpack or verify",
                        None if self.inputs.is_empty() => "Ready",
                        None => "Ready to compress",
                    };
                    ui.label(egui::RichText::new(text).color(snake_theme::FG2));
                }
            });
        });

        egui::CentralPanel::default().frame(egui::Frame::new().inner_margin(16.0).fill(snake_theme::BG)).show(ui, |ui| {
            ui.add_enabled_ui(self.job.is_none(), |ui| {
                if self.archive.is_some() {
                    self.unpack_ui(ui);
                } else if self.inputs.is_empty() {
                    self.empty_ui(ui);
                } else {
                    self.pack_ui(ui);
                }
            });

            ui.add_space(12.0);
            if let Some(job) = &self.job {
                let done = job.meter.done.load(Ordering::Relaxed);
                let total = job.meter.total.load(Ordering::Relaxed);
                let fraction = if total > 0 { (done as f32 / total as f32).min(1.0) } else { 0.0 };
                ui.add(egui::ProgressBar::new(fraction).show_percentage().animate(true).fill(snake_theme::ACCENT));
                ui.ctx().request_repaint_after(Duration::from_millis(100));
            } else {
                match &self.message {
                    Some(Ok(text)) => {
                        ui.colored_label(snake_theme::HIGHLIGHT, text);
                        if let Some(dir) = self.unpacked_to.clone() {
                            if ui.button("Open the folder").clicked() {
                                open_folder(&dir);
                            }
                        }
                    }
                    Some(Err(text)) => {
                        ui.colored_label(snake_theme::ERROR_SOFT, text);
                    }
                    None => {}
                };
            }
        });
    }
}

impl App {
    fn poll_job(&mut self) {
        let Some(job) = &self.job else { return };
        if let Ok(result) = job.result.try_recv() {
            let cancelled = job.cancel.load(Ordering::Relaxed);
            self.message = Some(result.map_err(|e| {
                let text = format!("{e:#}");
                if cancelled || text.contains("cancelled") {
                    "Cancelled.".to_owned()
                } else if text.contains("password required") {
                    "This archive is protected by a password: type it in the Password box, then try again.".to_owned()
                } else if text.contains("wrong password") {
                    "That password is not right. Check it and try again.".to_owned()
                } else {
                    format!("Error: {text}")
                }
            }));
            if matches!(self.message, Some(Err(_))) {
                self.unpacked_to = None;
            }
            if let Some(list) = self.listing.take() {
                let mut items = std::mem::take(&mut *list.lock().unwrap());
                items.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
                if matches!(self.message, Some(Ok(_))) {
                    self.message = None;
                    self.entries = Some(items);
                }
            }
            self.job = None;
        }
    }

    /// Takes in dropped or picked paths. A lone archive (.snake, ZIP, 7z, tar…) means "unpack this".
    fn add(&mut self, paths: Vec<PathBuf>) {
        let paths: Vec<PathBuf> = paths.into_iter().filter(|p| !p.as_os_str().is_empty()).collect();
        if paths.is_empty() {
            return;
        }
        self.message = None;
        self.unpacked_to = None;
        if self.inputs.is_empty() && paths.len() == 1 && paths[0].is_file() {
            if let Ok(Some(kind)) = other::detect(&paths[0]) {
                self.archive = Some(paths[0].clone());
                self.kind = Some(kind);
                self.dest = None;
                self.entries = None;
                self.filter.clear();
                self.password.clear();
                return;
            }
        }
        self.archive = None;
        self.kind = None;
        for path in paths {
            if !self.inputs.contains(&path) {
                self.inputs.push(path);
            }
        }
    }

    fn clear(&mut self) {
        self.inputs.clear();
        self.archive = None;
        self.kind = None;
        self.entries = None;
        self.password.clear();
        self.unpacked_to = None;
        self.output = None;
        self.dest = None;
    }

    fn add_buttons(&mut self, ui: &mut egui::Ui) {
        if ui.button("Add files…").clicked() {
            self.add(rfd::FileDialog::new().pick_files().unwrap_or_default());
        }
        if ui.button("Add folder…").clicked() {
            self.add(rfd::FileDialog::new().pick_folders().unwrap_or_default());
        }
    }

    fn empty_ui(&mut self, ui: &mut egui::Ui) {
        let hovering = ui.ctx().input(|i| !i.raw.hovered_files.is_empty());
        snake_theme::card()
            .stroke(egui::Stroke::new(if hovering { 2.0_f32 } else { 1.0 }, if hovering { snake_theme::ACCENT } else { snake_theme::BORDER2 }))
            .inner_margin(egui::Margin::same(40))
            .show(ui, |ui| {
                ui.set_width(ui.available_width());
                ui.vertical_centered(|ui| {
                    ui.label(egui::RichText::new("Drop files or folders here to compress them").size(16.0).color(snake_theme::FG));
                    ui.add_space(4.0);
                    ui.label(egui::RichText::new("or drop an archive to unpack it: .snake, ZIP, 7z, tar, .tar.gz, .tar.xz…").color(snake_theme::FG2));
                });
            });
        ui.add_space(8.0);
        ui.horizontal(|ui| self.add_buttons(ui));
    }

    fn pack_ui(&mut self, ui: &mut egui::Ui) {
        ui.label(egui::RichText::new("TO COMPRESS").size(11.0).strong().color(snake_theme::FG2));
        snake_theme::card().show(ui, |ui| {
            ui.set_width(ui.available_width());
            egui::ScrollArea::vertical().max_height(140.0).show(ui, |ui| {
                let mut remove = None;
                for (i, path) in self.inputs.iter().enumerate() {
                    ui.horizontal(|ui| {
                        if ui.small_button("✖").on_hover_text("Remove from the list").clicked() {
                            remove = Some(i);
                        }
                        ui.label(path.display().to_string());
                    });
                }
                if let Some(i) = remove {
                    self.inputs.remove(i);
                }
            });
        });
        ui.horizontal(|ui| {
            self.add_buttons(ui);
            if ui.button("Clear").clicked() {
                self.clear();
            }
        });
        let Some(first) = self.inputs.first() else { return };

        ui.add_space(8.0);
        ui.horizontal(|ui| {
            ui.label("Kind:");
            let before = self.zip;
            ui.radio_value(&mut self.zip, false, "Snake archive").on_hover_text("The smallest result, and every file is checked when it is unpacked");
            ui.radio_value(&mut self.zip, true, "ZIP").on_hover_text("Opens on any computer, without Snake's Compressor");
            if before != self.zip {
                // Keep a chosen name, with the right ending.
                if let Some(out) = &self.output {
                    self.output = Some(out.with_extension(if self.zip { "zip" } else { "snake" }));
                }
            }
        });
        let output = self.output.clone().unwrap_or_else(|| default_output(first, self.zip));
        ui.horizontal(|ui| {
            ui.label("Compression:");
            ui.add(egui::Slider::new(&mut self.level, 1..=22).show_value(!self.zip));
            ui.label(match (self.zip, self.level) {
                (true, 1..=3) => "fast",
                (true, 4..=8) => "normal",
                (true, _) => "smallest",
                (false, 1..=5) => "fast",
                (false, 6..=12) => "balanced",
                (false, 13..=18) => "small, slow",
                _ => "smallest, very slow, needs several GB of RAM",
            });
        });
        ui.horizontal(|ui| {
            ui.label("Save as:");
            if ui.button("Change…").clicked() {
                let mut dialog = if self.zip {
                    rfd::FileDialog::new().add_filter("ZIP archive", &["zip"])
                } else {
                    rfd::FileDialog::new().add_filter("Snake archive", &["snake"])
                };
                if let Some(dir) = output.parent() {
                    dialog = dialog.set_directory(dir);
                }
                if let Some(name) = output.file_name() {
                    dialog = dialog.set_file_name(name.to_string_lossy());
                }
                if let Some(picked) = dialog.save_file() {
                    self.output = Some(picked);
                }
            }
            ui.add(egui::Label::new(output.display().to_string()).truncate());
        });
        ui.checkbox(&mut self.overwrite, "Replace the archive if it already exists");

        ui.add_space(8.0);
        if snake_theme::primary_button(ui, "Compress").clicked() {
            self.start_pack(ui.ctx(), output);
        }
    }

    fn unpack_ui(&mut self, ui: &mut egui::Ui) {
        let Some(archive) = self.archive.clone() else { return };
        let dest = self.dest.clone().unwrap_or_else(|| parent_of(&archive));

        let kind = self.kind.unwrap_or(Kind::Snake);
        ui.label(egui::RichText::new(kind.label().to_uppercase()).size(11.0).strong().color(snake_theme::FG2));
        snake_theme::card().show(ui, |ui| {
            ui.set_width(ui.available_width());
            let name = archive.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_default();
            let size = std::fs::metadata(&archive).map(|m| human(m.len())).unwrap_or_default();
            ui.horizontal(|ui| {
                ui.add(egui::Label::new(egui::RichText::new(name).size(16.0).strong().color(snake_theme::FG)).truncate());
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.label(egui::RichText::new(size).color(snake_theme::FG2));
                });
            });
            ui.add(egui::Label::new(egui::RichText::new(parent_of(&archive).display().to_string()).color(snake_theme::FG3)).truncate());
        });
        if matches!(kind, Kind::Zip | Kind::SevenZ) {
            ui.add_space(4.0);
            ui.horizontal(|ui| {
                ui.label("Password:");
                ui.add(egui::TextEdit::singleline(&mut self.password).password(true).hint_text("only if it has one").desired_width(220.0));
            });
        }
        ui.add_space(8.0);
        ui.horizontal(|ui| {
            ui.label("Unpack into:");
            if ui.button("Change…").clicked() {
                if let Some(picked) = rfd::FileDialog::new().set_directory(&dest).pick_folder() {
                    self.dest = Some(picked);
                }
            }
            ui.add(egui::Label::new(dest.display().to_string()).truncate());
        });
        ui.checkbox(&mut self.overwrite, "Replace files that already exist");

        ui.add_space(8.0);
        ui.horizontal(|ui| {
            if snake_theme::primary_button(ui, "Unpack").clicked() {
                let mode = unpack::Mode::Extract { dest: dest.clone(), force: self.overwrite };
                self.unpacked_to = Some(dest.clone());
                self.start_unpack(ui.ctx(), archive.clone(), mode);
            }
            if ui.button("Verify").on_hover_text("Check the archive for damage without unpacking it").clicked() {
                self.unpacked_to = None;
                self.start_unpack(ui.ctx(), archive.clone(), unpack::Mode::Test);
            }
            if self.entries.is_none() && ui.button("Show what's inside").clicked() {
                self.start_listing(ui.ctx(), archive.clone());
            }
            if ui.button("Close archive").clicked() {
                self.clear();
            }
        });

        if let Some(entries) = &self.entries {
            ui.add_space(8.0);
            let files = entries.iter().filter(|e| !e.dir).count();
            let total: u64 = entries.iter().map(|e| e.size).sum();
            ui.horizontal(|ui| {
                ui.label(egui::RichText::new(format!("INSIDE: {files} files, {}", human(total))).size(11.0).strong().color(snake_theme::FG2));
                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                    ui.add(egui::TextEdit::singleline(&mut self.filter).hint_text("Search").desired_width(180.0));
                });
            });
            let needle = self.filter.to_lowercase();
            let shown: Vec<&Entry> = entries.iter().filter(|e| needle.is_empty() || e.name.to_lowercase().contains(&needle)).collect();
            snake_theme::card().show(ui, |ui| {
                ui.set_width(ui.available_width());
                let row_h = ui.text_style_height(&egui::TextStyle::Body) + 4.0;
                egui::ScrollArea::vertical().max_height(220.0).auto_shrink([false, true]).show_rows(ui, row_h, shown.len(), |ui, range| {
                    for e in &shown[range] {
                        ui.horizontal(|ui| {
                            let name = if e.dir { format!("{}/", e.name.trim_end_matches('/')) } else { e.name.clone() };
                            ui.label(egui::RichText::new(name).color(if e.dir { snake_theme::FG2 } else { snake_theme::FG }));
                            if !e.dir {
                                ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                                    ui.label(egui::RichText::new(human(e.size)).color(snake_theme::FG2));
                                });
                            }
                        });
                    }
                });
            });
        }
    }

    fn start_listing(&mut self, ctx: &egui::Context, archive: PathBuf) {
        let kind = self.kind.unwrap_or(Kind::Snake);
        let password = (!self.password.is_empty()).then(|| self.password.clone());
        let list = Arc::new(Mutex::new(Vec::new()));
        self.listing = Some(list.clone());
        self.start(ctx, "Reading what is inside…", move |meter, cancel| {
            // ZIP and 7z keep a list of their contents; the others are read through.
            if matches!(kind, Kind::Zip | Kind::SevenZ) {
                let items = other::entries(&archive, kind, password.as_deref())?;
                *list.lock().unwrap() = items;
                return Ok(String::new());
            }
            let size = std::fs::metadata(&archive)?.len();
            meter.total.store(size, Ordering::Relaxed);
            unpack::run_any(&archive, unpack::Mode::Collect(list), password.as_deref(), false, &mut |bytes| {
                meter.done.store(bytes, Ordering::Relaxed);
                !cancel.load(Ordering::Relaxed)
            })?;
            Ok(String::new())
        });
    }

    fn start_pack(&mut self, ctx: &egui::Context, output: PathBuf) {
        let cores = std::thread::available_parallelism().map_or(1, |n| n.get() as u32);
        let opts = pack::Options {
            inputs: self.inputs.clone(),
            output: Some(output),
            level: self.level,
            // Each worker needs hundreds of MB at high levels.
            threads: if self.level >= 19 { cores.min(4) } else { cores },
            force: self.overwrite,
            verbose: false,
            zip: self.zip,
        };
        self.unpacked_to = None;
        self.start(ctx, "Compressing…", move |meter, cancel| {
            meter.total.store(total_size(&opts.inputs), Ordering::Relaxed);
            let s = pack::run(&opts, &mut |bytes| {
                meter.done.store(bytes, Ordering::Relaxed);
                !cancel.load(Ordering::Relaxed)
            })?;
            let percent = if s.bytes > 0 { s.packed as f64 * 100.0 / s.bytes as f64 } else { 100.0 };
            Ok(format!(
                "Done: {} files, {} → {} ({percent:.1}% of original) in {:.1}s\n{}",
                s.files,
                human(s.bytes),
                human(s.packed),
                s.secs,
                s.output.display()
            ))
        });
    }

    fn start_unpack(&mut self, ctx: &egui::Context, archive: PathBuf, mode: unpack::Mode) {
        let extracting = matches!(mode, unpack::Mode::Extract { .. });
        let label = if extracting { "Unpacking…" } else { "Verifying…" };
        let password = (!self.password.is_empty()).then(|| self.password.clone());
        let snake = matches!(self.kind, None | Some(Kind::Snake));
        self.start(ctx, label, move |meter, cancel| {
            let size = std::fs::metadata(&archive).with_context(|| format!("cannot open {}", archive.display()))?.len();
            meter.total.store(size, Ordering::Relaxed);
            let s = unpack::run_any(&archive, mode, password.as_deref(), false, &mut |bytes| {
                meter.done.store(bytes, Ordering::Relaxed);
                !cancel.load(Ordering::Relaxed)
            })?;
            let verb = if extracting { "Unpacked" } else { "Archive is intact:" };
            let checks = if snake { "every file's checksum is right" } else { "all checks passed" };
            Ok(format!("{verb} {} files ({}) in {:.1}s, {checks}", s.files, human(s.bytes), s.secs))
        });
    }

    fn start(&mut self, ctx: &egui::Context, label: &str, work: impl FnOnce(&Meter, &AtomicBool) -> Result<String> + Send + 'static) {
        let meter = Arc::new(Meter::default());
        let cancel = Arc::new(AtomicBool::new(false));
        let (tx, result) = mpsc::channel();
        let (ctx, worker_meter, worker_cancel) = (ctx.clone(), meter.clone(), cancel.clone());
        std::thread::spawn(move || {
            let _ = tx.send(work(&worker_meter, &worker_cancel));
            ctx.request_repaint();
        });
        self.message = None;
        self.job = Some(Job { label: label.to_owned(), meter, cancel, result });
    }
}

fn parent_of(path: &Path) -> PathBuf {
    let full = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    full.parent().map_or_else(|| PathBuf::from("."), Path::to_path_buf)
}

/// New archives go next to the first thing being compressed.
fn default_output(first: &Path, zip: bool) -> PathBuf {
    let name = pack::default_output_as(first, zip).unwrap_or_else(|_| PathBuf::from(if zip { "archive.zip" } else { "archive.snake" }));
    parent_of(first).join(name)
}

/// Shows a folder in the system's file manager.
fn open_folder(dir: &Path) {
    #[cfg(target_os = "windows")]
    let cmd = "explorer";
    #[cfg(target_os = "macos")]
    let cmd = "open";
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    let cmd = "xdg-open";
    let _ = std::process::Command::new(cmd).arg(dir).spawn();
}

fn total_size(inputs: &[PathBuf]) -> u64 {
    inputs
        .iter()
        .flat_map(|input| walkdir::WalkDir::new(input).follow_links(false))
        .filter_map(|entry| entry.ok())
        .filter(|entry| entry.file_type().is_file())
        .filter_map(|entry| entry.metadata().ok())
        .map(|meta| meta.len())
        .sum()
}
