//! Snake's Suite look for egui apps: the "Snake Dark" theme of Snake's Code.
//!
//! Shared by every egui tool in the suite. The master copy lives in
//! Snake's Suite/shared/egui/; `python shared/sync.py` copies it into each tool,
//! so edit it there. Only uses the parts of egui that are the same from 0.31 on.
//!
//!     snake_theme::apply(&cc.egui_ctx);
//!     snake_theme::header(ui, "Snake's Compressor", "Lossless archives");

#![allow(dead_code)]

use eframe::egui::{self, Color32, CornerRadius, FontId, RichText, Stroke, TextStyle};

pub const BG: Color32 = Color32::from_rgb(0x1a, 0x1e, 0x1b);
pub const SIDE: Color32 = Color32::from_rgb(0x15, 0x19, 0x16);
pub const TITLE: Color32 = Color32::from_rgb(0x11, 0x14, 0x12);
pub const FG: Color32 = Color32::from_rgb(0xd5, 0xdd, 0xd7);
pub const FG2: Color32 = Color32::from_rgb(0x8a, 0x97, 0x8e);
pub const FG3: Color32 = Color32::from_rgb(0x5d, 0x6a, 0x62);
pub const ACCENT: Color32 = Color32::from_rgb(0x3f, 0xb9, 0x50);
pub const ACCENT_HOVER: Color32 = Color32::from_rgb(0x4c, 0xc7, 0x5d);
pub const HIGHLIGHT: Color32 = Color32::from_rgb(0x7e, 0xe7, 0x87);
pub const BORDER: Color32 = Color32::from_rgb(0x25, 0x2b, 0x27);
pub const BORDER2: Color32 = Color32::from_rgb(0x32, 0x3a, 0x34);
pub const SELECTION: Color32 = Color32::from_rgb(0x2b, 0x4a, 0x35);
pub const HOVER: Color32 = Color32::from_rgb(0x22, 0x28, 0x23);
pub const WIDGET: Color32 = Color32::from_rgb(0x1f, 0x24, 0x20);
pub const INPUT: Color32 = Color32::from_rgb(0x12, 0x15, 0x13);
pub const BUTTON2: Color32 = Color32::from_rgb(0x2a, 0x2f, 0x2b);
pub const BUTTON2_HOVER: Color32 = Color32::from_rgb(0x33, 0x3a, 0x35);
pub const ERROR: Color32 = Color32::from_rgb(0xf1, 0x4c, 0x4c);
pub const ERROR_SOFT: Color32 = Color32::from_rgb(0xff, 0x8a, 0x8a);
pub const WARNING: Color32 = Color32::from_rgb(0xcc, 0xa7, 0x00);
pub const INFO: Color32 = Color32::from_rgb(0x37, 0x94, 0xff);
pub const RECORD: Color32 = Color32::from_rgb(0xe5, 0x48, 0x4d);

/// Gives the whole app the suite look. Call once from the eframe creation closure.
pub fn apply(ctx: &egui::Context) {
    ctx.set_theme(egui::ThemePreference::Dark);
    ctx.all_styles_mut(|style| {
        let v = &mut style.visuals;
        *v = egui::Visuals::dark();
        v.override_text_color = None;
        v.panel_fill = BG;
        v.window_fill = WIDGET;
        v.window_stroke = Stroke::new(1.0_f32, BORDER2);
        v.window_corner_radius = CornerRadius::same(8);
        v.menu_corner_radius = CornerRadius::same(6);
        v.faint_bg_color = SIDE;
        v.extreme_bg_color = INPUT;
        v.code_bg_color = INPUT;
        v.hyperlink_color = HIGHLIGHT;
        v.warn_fg_color = WARNING;
        v.error_fg_color = ERROR_SOFT;
        v.selection.bg_fill = SELECTION;
        v.selection.stroke = Stroke::new(1.0_f32, HIGHLIGHT);
        v.slider_trailing_fill = true;
        v.striped = false;

        let r4 = CornerRadius::same(4);
        let w = &mut v.widgets;
        // Labels, frames and other things you cannot click.
        w.noninteractive.bg_fill = SIDE;
        w.noninteractive.weak_bg_fill = SIDE;
        w.noninteractive.bg_stroke = Stroke::new(1.0_f32, BORDER);
        w.noninteractive.fg_stroke = Stroke::new(1.0_f32, FG);
        w.noninteractive.corner_radius = CornerRadius::same(6);
        // Buttons and other controls at rest: the Snake's Code secondary button.
        w.inactive.bg_fill = BUTTON2;
        w.inactive.weak_bg_fill = BUTTON2;
        w.inactive.bg_stroke = Stroke::NONE;
        w.inactive.fg_stroke = Stroke::new(1.0_f32, FG);
        w.inactive.corner_radius = r4;
        w.hovered.bg_fill = BUTTON2_HOVER;
        w.hovered.weak_bg_fill = BUTTON2_HOVER;
        w.hovered.bg_stroke = Stroke::new(1.0_f32, BORDER2);
        w.hovered.fg_stroke = Stroke::new(1.5_f32, FG);
        w.hovered.corner_radius = r4;
        w.hovered.expansion = 0.0;
        w.active.bg_fill = ACCENT;
        w.active.weak_bg_fill = SELECTION;
        w.active.bg_stroke = Stroke::new(1.0_f32, ACCENT);
        w.active.fg_stroke = Stroke::new(1.5_f32, Color32::WHITE);
        w.active.corner_radius = r4;
        w.active.expansion = 0.0;
        w.open.bg_fill = WIDGET;
        w.open.weak_bg_fill = SELECTION;
        w.open.bg_stroke = Stroke::new(1.0_f32, BORDER2);
        w.open.fg_stroke = Stroke::new(1.0_f32, FG);
        w.open.corner_radius = r4;

        let s = &mut style.spacing;
        s.item_spacing = egui::vec2(7.0, 5.0);
        s.button_padding = egui::vec2(6.0, 3.0);
        s.interact_size.y = 22.0;

        style.text_styles.insert(TextStyle::Heading, FontId::proportional(20.0));
        style.text_styles.insert(TextStyle::Body, FontId::proportional(13.0));
        style.text_styles.insert(TextStyle::Button, FontId::proportional(13.0));
        style.text_styles.insert(TextStyle::Small, FontId::proportional(11.0));
    });
}

/// A filled green button, the Snake's Code primary button.
pub fn primary_button(ui: &mut egui::Ui, text: &str) -> egui::Response {
    ui.add(
        egui::Button::new(RichText::new(text).color(Color32::WHITE).strong())
            .fill(ACCENT)
            .corner_radius(CornerRadius::same(4))
            .min_size(egui::vec2(110.0, 30.0)),
    )
}

/// A card: the side-bar colour with a thin border, for grouping controls.
pub fn card() -> egui::Frame {
    egui::Frame::new()
        .fill(SIDE)
        .stroke(Stroke::new(1.0_f32, BORDER))
        .corner_radius(CornerRadius::same(8))
        .inner_margin(egui::Margin::same(12))
}

/// The strip along the top of every tool, like the Snake's Code title bar.
/// Put it in a `TopBottomPanel::top`, or call it first in a panel with no margin.
pub fn header_frame() -> egui::Frame {
    egui::Frame::new()
        .fill(TITLE)
        .inner_margin(egui::Margin { left: 14, right: 12, top: 8, bottom: 8 })
        .stroke(Stroke::new(1.0_f32, BORDER))
}

/// Logo, name and subtitle for the header strip. `logo` is the app's icon texture, if loaded.
pub fn header_title(ui: &mut egui::Ui, logo: Option<&egui::TextureHandle>, title: &str, subtitle: &str) {
    ui.horizontal(|ui| {
        if let Some(tex) = logo {
            ui.add(egui::Image::new(tex).fit_to_exact_size(egui::vec2(28.0, 28.0)));
            ui.add_space(4.0);
        }
        ui.vertical(|ui| {
            ui.spacing_mut().item_spacing.y = 0.0;
            ui.label(RichText::new(title).size(15.0).strong().color(FG));
            if !subtitle.is_empty() {
                ui.label(RichText::new(subtitle).size(11.5).color(FG2));
            }
        });
    });
}

/// The status strip along the bottom, like the Snake's Code status bar.
pub fn status_frame() -> egui::Frame {
    egui::Frame::new().fill(TITLE).inner_margin(egui::Margin { left: 12, right: 12, top: 3, bottom: 3 })
}

/// The app icon (a 64 px RGBA image made by `shared/sync.py`) as egui icon data for the window.
pub fn icon_data(rgba: &[u8]) -> egui::IconData {
    egui::IconData { rgba: rgba.to_vec(), width: 64, height: 64 }
}

/// Loads the same icon as a texture, for the header.
pub fn logo_texture(ctx: &egui::Context, rgba: &[u8]) -> egui::TextureHandle {
    let image = egui::ColorImage::from_rgba_unmultiplied([64, 64], rgba);
    ctx.load_texture("snake-logo", image, egui::TextureOptions::LINEAR)
}

/// Development aid: when the SNAKE_SCREENSHOT environment variable names a file, the app saves
/// one frame there (as a PPM image) shortly after starting, then closes. Call it every frame.
/// Without the variable it does nothing.
pub fn screenshot_hook(ctx: &egui::Context) {
    use std::sync::atomic::{AtomicU32, Ordering};
    static FRAMES: AtomicU32 = AtomicU32::new(0);
    let Some(path) = std::env::var_os("SNAKE_SCREENSHOT") else { return };
    let frame = FRAMES.fetch_add(1, Ordering::Relaxed);
    if frame == 20 {
        ctx.send_viewport_cmd(egui::ViewportCommand::Screenshot(Default::default()));
    }
    let shot = ctx.input(|i| {
        i.raw.events.iter().find_map(|e| match e {
            egui::Event::Screenshot { image, .. } => Some(image.clone()),
            _ => None,
        })
    });
    if let Some(image) = shot {
        let [w, h] = image.size;
        let mut ppm = format!("P6\n{w} {h}\n255\n").into_bytes();
        for p in &image.pixels {
            ppm.extend_from_slice(&[p.r(), p.g(), p.b()]);
        }
        let _ = std::fs::write(&path, ppm);
        ctx.send_viewport_cmd(egui::ViewportCommand::Close);
    }
    ctx.request_repaint();
}
