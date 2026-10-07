// A windowed program on Windows: do not open a console next to it.
#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod app;
mod audio;
mod audioio;
mod cpalio;
mod desktop;
mod engine;
mod fx;
#[cfg(feature = "jack-backend")]
mod jackio;
mod looper;
mod project;
mod recorder;
#[cfg(test)]
mod tests;
mod tuner;
mod ui;
mod util;

use eframe::egui;

/// Shown instead of the DAW when the audio server cannot be reached.
struct ErrorApp(String);

impl eframe::App for ErrorApp {
    fn update(&mut self, ctx: &egui::Context, _: &mut eframe::Frame) {
        egui::CentralPanel::default().show(ctx, |ui| {
            ui.heading("SnakeDAW could not start");
            ui.add_space(8.0);
            ui.label(&self.0);
        });
    }
}

fn main() -> eframe::Result<()> {
    let cfg = project::Config::load();
    #[cfg(feature = "jack-backend")]
    if std::env::args().any(|a| a == "--ports") {
        // Diagnostic: list the audio ports the DAW can see, then exit.
        jackio::print_ports();
        return Ok(());
    }
    // Ask PipeWire for a small buffer so live monitoring feels immediate.
    std::env::set_var("PIPEWIRE_LATENCY", format!("{}/48000", cfg.buffer_size));
    let options = eframe::NativeOptions {
        viewport: egui::ViewportBuilder::default().with_title("SnakeDAW").with_app_id("snakedaw").with_inner_size([1440.0, 880.0]),
        ..Default::default()
    };
    eframe::run_native(
        "SnakeDAW",
        options,
        Box::new(move |_cc| {
            Ok(match app::App::new(cfg) {
                Ok(app) => Box::new(app) as Box<dyn eframe::App>,
                Err(e) => Box::new(ErrorApp(format!("{e:#}"))),
            })
        }),
    )
}
