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
mod snake_theme;
#[cfg(test)]
mod tests;
mod tuner;
mod ui;
mod util;

use eframe::egui;

const ICON: &[u8] = include_bytes!("../assets/icon64.rgba");

/// Shown instead of the DAW when the audio server cannot be reached.
struct ErrorApp(String);

impl eframe::App for ErrorApp {
    fn update(&mut self, ctx: &egui::Context, _: &mut eframe::Frame) {
        egui::CentralPanel::default().frame(egui::Frame::new().fill(snake_theme::BG).inner_margin(24.0)).show(ctx, |ui| {
            ui.heading(egui::RichText::new("Snake's DAW could not start").color(snake_theme::ERROR_SOFT));
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
        viewport: egui::ViewportBuilder::default().with_title("Snake's DAW")
            .with_app_id("snakedaw")
            .with_icon(snake_theme::icon_data(ICON))
            .with_inner_size([1440.0, 880.0]),
        ..Default::default()
    };
    eframe::run_native(
        "SnakeDAW",
        options,
        Box::new(move |cc| {
            snake_theme::apply(&cc.egui_ctx);
            Ok(match app::App::new(cfg) {
                Ok(mut app) => {
                    app.ui.logo = Some(snake_theme::logo_texture(&cc.egui_ctx, ICON));
                    Box::new(app) as Box<dyn eframe::App>
                }
                Err(e) => Box::new(ErrorApp(format!("{e:#}"))),
            })
        }),
    )
}
