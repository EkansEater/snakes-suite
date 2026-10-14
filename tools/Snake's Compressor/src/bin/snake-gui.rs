// Don't open a console window alongside the app on Windows.
#![cfg_attr(windows, windows_subsystem = "windows")]

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Receiver};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use eframe::egui;
use snake::format::human;
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
            Ok(Box::new(App { logo: Some(logo), ..App::default() }))
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
    result: Receiver<Result<String>>,
}

struct App {
    /// Files and folders waiting to be compressed.
    inputs: Vec<PathBuf>,
    /// An archive waiting to be unpacked. Takes over the window when set.
    archive: Option<PathBuf>,
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

        let dropped: Vec<PathBuf> =
            ui.ctx().input(|i| i.raw.dropped_files.iter().map(|f| f.path().to_path_buf()).collect());
        if self.job.is_none() {
            self.add(dropped);
        }

        egui::Panel::top("header").frame(snake_theme::header_frame()).show(ui, |ui| {
            snake_theme::header_title(ui, self.logo.as_ref(), "Snake's Compressor", "Lossless archives, checksummed");
        });

        egui::Panel::bottom("status").frame(snake_theme::status_frame()).show(ui, |ui| {
            ui.horizontal(|ui| {
                ui.set_min_height(20.0);
                if let Some(job) = &self.job {
                    ui.add(egui::Spinner::new().color(snake_theme::HIGHLIGHT));
                    ui.label(egui::RichText::new(&job.label).color(snake_theme::FG2));
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
                    Some(Ok(text)) => ui.colored_label(snake_theme::HIGHLIGHT, text),
                    Some(Err(text)) => ui.colored_label(snake_theme::ERROR_SOFT, text),
                    None => ui.label(""),
                };
            }
        });
    }
}

impl App {
    fn poll_job(&mut self) {
        let Some(job) = &self.job else { return };
        if let Ok(result) = job.result.try_recv() {
            self.message = Some(result.map_err(|e| format!("Error: {e:#}")));
            self.job = None;
        }
    }

    /// Takes in dropped or picked paths. A lone .snake file means "unpack this".
    fn add(&mut self, paths: Vec<PathBuf>) {
        let paths: Vec<PathBuf> = paths.into_iter().filter(|p| !p.as_os_str().is_empty()).collect();
        if paths.is_empty() {
            return;
        }
        self.message = None;
        let is_archive = |p: &Path| p.is_file() && p.extension().is_some_and(|e| e.eq_ignore_ascii_case("snake"));
        if self.inputs.is_empty() && paths.len() == 1 && is_archive(&paths[0]) {
            self.archive = Some(paths[0].clone());
            self.dest = None;
            return;
        }
        self.archive = None;
        for path in paths {
            if !self.inputs.contains(&path) {
                self.inputs.push(path);
            }
        }
    }

    fn clear(&mut self) {
        self.inputs.clear();
        self.archive = None;
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
                    ui.label(egui::RichText::new("or drop a .snake archive to unpack it").color(snake_theme::FG2));
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
        let output = self.output.clone().unwrap_or_else(|| default_output(first));

        ui.add_space(8.0);
        ui.horizontal(|ui| {
            ui.label("Compression:");
            ui.add(egui::Slider::new(&mut self.level, 1..=22));
            ui.label(match self.level {
                1..=5 => "fast",
                6..=12 => "balanced",
                13..=18 => "small, slow",
                _ => "smallest, very slow, needs several GB of RAM",
            });
        });
        ui.horizontal(|ui| {
            ui.label("Save as:");
            if ui.button("Change…").clicked() {
                let mut dialog = rfd::FileDialog::new().add_filter("Snake archive", &["snake"]);
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
            ui.label(output.display().to_string());
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

        ui.label(egui::RichText::new("ARCHIVE").size(11.0).strong().color(snake_theme::FG2));
        snake_theme::card().show(ui, |ui| {
            ui.set_width(ui.available_width());
            ui.label(archive.display().to_string());
        });
        ui.add_space(8.0);
        ui.horizontal(|ui| {
            ui.label("Unpack into:");
            if ui.button("Change…").clicked() {
                if let Some(picked) = rfd::FileDialog::new().set_directory(&dest).pick_folder() {
                    self.dest = Some(picked);
                }
            }
            ui.label(dest.display().to_string());
        });
        ui.checkbox(&mut self.overwrite, "Replace files that already exist");

        ui.add_space(8.0);
        ui.horizontal(|ui| {
            if snake_theme::primary_button(ui, "Unpack").clicked() {
                let mode = unpack::Mode::Extract { dest: dest.clone(), force: self.overwrite };
                self.start_unpack(ui.ctx(), archive.clone(), mode);
            }
            if ui.button("Verify").on_hover_text("Check the archive for damage without unpacking it").clicked() {
                self.start_unpack(ui.ctx(), archive.clone(), unpack::Mode::Test);
            }
            if ui.button("Close archive").clicked() {
                self.clear();
            }
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
        };
        self.start(ctx, "Compressing…", move |meter| {
            meter.total.store(total_size(&opts.inputs), Ordering::Relaxed);
            let s = pack::run(&opts, &mut |bytes| meter.done.store(bytes, Ordering::Relaxed))?;
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
        self.start(ctx, label, move |meter| {
            let size = std::fs::metadata(&archive).with_context(|| format!("cannot open {}", archive.display()))?.len();
            meter.total.store(size, Ordering::Relaxed);
            let s = unpack::run(&archive, mode, false, &mut |bytes| meter.done.store(bytes, Ordering::Relaxed))?;
            let verb = if extracting { "Unpacked" } else { "Archive is intact:" };
            Ok(format!("{verb} {} files ({}) in {:.1}s, all checksums OK", s.files, human(s.bytes), s.secs))
        });
    }

    fn start(&mut self, ctx: &egui::Context, label: &str, work: impl FnOnce(&Meter) -> Result<String> + Send + 'static) {
        let meter = Arc::new(Meter::default());
        let (tx, result) = mpsc::channel();
        let (ctx, worker_meter) = (ctx.clone(), meter.clone());
        std::thread::spawn(move || {
            let _ = tx.send(work(&worker_meter));
            ctx.request_repaint();
        });
        self.message = None;
        self.job = Some(Job { label: label.to_owned(), meter, result });
    }
}

fn parent_of(path: &Path) -> PathBuf {
    let full = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    full.parent().map_or_else(|| PathBuf::from("."), Path::to_path_buf)
}

/// New archives go next to the first thing being compressed.
fn default_output(first: &Path) -> PathBuf {
    let name = pack::default_output(first).unwrap_or_else(|_| PathBuf::from("archive.snake"));
    parent_of(first).join(name)
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
