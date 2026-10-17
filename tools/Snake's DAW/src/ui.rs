//! The interface: transport bar, track list with timeline, effects panel and dialogs.

use crate::app::{App, Preset};
use crate::audio::PEAK_CHUNK;
use crate::engine::NUM_INPUTS;
use crate::fx::builtin;
use crate::looper::{self, LoopAction};
use crate::project::{ClipDef, InputSel, TrackDef};
use crate::snake_theme as theme;
use crate::util::gain_to_db;
use eframe::egui::{
    self, pos2, vec2, Align, Align2, Button, Color32, ComboBox, CursorIcon, DragValue, FontId, Key, Layout, Modifiers,
    Painter, PointerButton, Pos2, Rect, Response, RichText, ScrollArea, Sense, Slider, Stroke, StrokeKind, TextEdit, Ui,
    UiBuilder,
};
use std::collections::HashMap;
use std::sync::atomic::Ordering::Relaxed;
use std::time::Duration;

const HEADER_W: f32 = 292.0;
const MIN_ROW_H: f32 = 34.0;
const MAX_ROW_H: f32 = 420.0;
const RULER_H: f32 = 40.0;
/// Height of the loop strip at the top of the ruler.
const LOOP_H: f32 = 14.0;
const SCROLLBAR_H: f32 = 14.0;
/// Width of one loop in the loop station window.
const SLOT_W: f32 = 128.0;

/// A track's loop region being dragged from the timeline to the loop station.
#[derive(Clone, Copy)]
struct LoopDrag {
    track: u64,
}
const EDGE: f32 = 6.0;

const COLORS: [Color32; 8] = [
    Color32::from_rgb(86, 156, 214),
    Color32::from_rgb(214, 143, 86),
    Color32::from_rgb(120, 190, 110),
    Color32::from_rgb(190, 120, 200),
    Color32::from_rgb(210, 190, 90),
    Color32::from_rgb(90, 195, 195),
    Color32::from_rgb(215, 110, 130),
    Color32::from_rgb(150, 150, 220),
];
const RED: Color32 = Color32::from_rgb(225, 70, 70);
const GREEN: Color32 = theme::HIGHLIGHT;
const ORANGE: Color32 = Color32::from_rgb(230, 150, 60);
const YELLOW: Color32 = Color32::from_rgb(230, 210, 80);
const BLUE: Color32 = Color32::from_rgb(100, 170, 240);

#[derive(Clone, Copy, PartialEq)]
pub enum Drag {
    None,
    Move { track: u64, clip: u64, grab: i64 },
    TrimL { track: u64, clip: u64 },
    TrimR { track: u64, clip: u64 },
    /// Drawing a new loop region from `anchor`.
    Loop { anchor: i64 },
    LoopStart,
    LoopEnd,
    LoopMove { grab: i64 },
    Seek,
    /// Sliding the timeline sideways by dragging empty space.
    Pan,
}

/// Work the timeline queues while the track list is borrowed, applied right after drawing.
enum Act {
    PushUndo,
    Sync(u64),
    Seek(i64),
}

pub struct UiState {
    pub sel_track: Option<u64>,
    pub sel_clip: Option<(u64, u64)>,
    /// Horizontal zoom in pixels per second, and the time at the left edge in seconds.
    pub zoom: f32,
    pub scroll: f64,
    pub drag: Drag,
    pub snap: bool,
    pub show_settings: bool,
    pub show_tuner: bool,
    pub show_open: bool,
    pub show_new: bool,
    pub show_lv2: bool,
    pub show_help: bool,
    pub show_looper: bool,
    /// An audio setting was changed that only takes effect when the program starts.
    pub restart_needed: bool,
    pub new_name: String,
    pub lv2_search: String,
    /// The app icon, shown in the top bar.
    pub logo: Option<egui::TextureHandle>,
    meters: HashMap<u64, (f32, f32)>,
    master_meter: (f32, f32),
    in_levels: [f32; NUM_INPUTS + 1],
    acts: Vec<Act>,
}

impl Default for UiState {
    fn default() -> Self {
        Self {
            sel_track: None,
            sel_clip: None,
            zoom: 60.0,
            scroll: 0.0,
            drag: Drag::None,
            snap: false,
            show_settings: false,
            show_tuner: false,
            show_open: false,
            show_new: false,
            show_lv2: false,
            logo: None,
            show_help: false,
            show_looper: false,
            restart_needed: false,
            new_name: String::new(),
            lv2_search: String::new(),
            meters: HashMap::new(),
            master_meter: (0.0, 0.0),
            in_levels: [0.0; NUM_INPUTS + 1],
            acts: Vec::new(),
        }
    }
}

/// Maps between timeline frames and screen x coordinates.
#[derive(Clone, Copy)]
struct View {
    x0: f32,
    zoom: f32,
    scroll: f64,
    sr: f64,
}

impl View {
    fn x(&self, frame: i64) -> f32 {
        self.x0 + ((frame as f64 / self.sr - self.scroll) * self.zoom as f64) as f32
    }
    fn frame(&self, x: f32) -> i64 {
        (((x - self.x0) as f64 / self.zoom as f64 + self.scroll) * self.sr).round() as i64
    }
}

fn toggle(ui: &mut Ui, on: &mut bool, text: &str, color: Color32) -> Response {
    let (fill, fg) = if *on { (color, Color32::BLACK) } else { (ui.visuals().widgets.inactive.bg_fill, ui.visuals().text_color()) };
    let r = ui.add(Button::new(RichText::new(text).color(fg)).fill(fill).min_size(vec2(28.0, 22.0)));
    if r.clicked() {
        *on = !*on;
    }
    r
}

fn big(ui: &mut Ui, text: &str, color: Option<Color32>) -> Response {
    let mut t = RichText::new(text).size(20.0);
    if let Some(c) = color {
        t = t.color(c);
    }
    ui.add(Button::new(t).min_size(vec2(38.0, 32.0)))
}

/// Draw a level meter for a linear peak value, on a -60..0 dB scale.
fn meter(p: &Painter, rect: Rect, level: f32, vertical: bool) {
    p.rect_filled(rect, 1.0, theme::INPUT);
    let db = gain_to_db(level);
    let frac = ((db + 60.0) / 60.0).clamp(0.0, 1.0);
    let color = if db > -1.0 { RED } else if db > -9.0 { YELLOW } else { GREEN };
    let fill = if vertical {
        Rect::from_min_max(pos2(rect.left(), rect.bottom() - rect.height() * frac), rect.max)
    } else {
        Rect::from_min_max(rect.min, pos2(rect.left() + rect.width() * frac, rect.bottom()))
    };
    p.rect_filled(fill, 1.0, color);
}

fn smooth(old: f32, new: f32) -> f32 {
    new.max(old * 0.88)
}

/// Show a folder in the system's file manager.
fn open_folder(dir: &std::path::Path) {
    let program = if cfg!(target_os = "windows") {
        "explorer"
    } else if cfg!(target_os = "macos") {
        "open"
    } else {
        "xdg-open"
    };
    let _ = std::process::Command::new(program).arg(dir).spawn();
}

#[cfg(feature = "jack-backend")]
fn short_port(name: &str) -> String {
    name.trim_start_matches("alsa_input.").trim_start_matches("alsa_output.").replace("usb-BEHRINGER_", "").replace("HiFi__", "")
}

/// Draw a waveform from peak data. `first` is the timeline frame where `peaks[0]` begins.
fn draw_wave(p: &Painter, rect: Rect, view: View, first: i64, peaks: &[(f32, f32)], color: Color32) {
    let mid = rect.center().y;
    let half = rect.height() * 0.46;
    let (x_from, x_to) = (rect.left().ceil() as i32, rect.right().floor() as i32);
    for x in x_from..=x_to {
        let f0 = view.frame(x as f32) - first;
        let f1 = view.frame(x as f32 + 1.0) - first;
        if f1 <= 0 {
            continue;
        }
        let i0 = (f0.max(0) as usize) / PEAK_CHUNK;
        let i1 = ((f1 as usize) / PEAK_CHUNK).max(i0 + 1).min(peaks.len());
        if i0 >= i1 {
            break;
        }
        let step = ((i1 - i0) / 48).max(1);
        let (mut lo, mut hi) = (0.0f32, 0.0f32);
        for pk in peaks[i0..i1].iter().step_by(step) {
            lo = lo.min(pk.0);
            hi = hi.max(pk.1);
        }
        let (y0, y1) = (mid - hi.min(1.0) * half, mid - lo.max(-1.0) * half);
        p.vline(x as f32 + 0.5, y0..=(y1.max(y0 + 1.0)), Stroke::new(1.0_f32, color));
    }
}

impl eframe::App for App {
    fn update(&mut self, ctx: &egui::Context, _: &mut eframe::Frame) {
        crate::snake_theme::screenshot_hook(ctx);
        crate::snake_theme::ergonomics(ctx, "daw");
        self.tick();
        self.shortcuts(ctx);
        egui::TopBottomPanel::top("top").frame(theme::header_frame()).show(ctx, |ui| self.top_bar(ui));
        egui::TopBottomPanel::bottom("status").frame(theme::status_frame()).show(ctx, |ui| self.status_bar(ui));
        egui::TopBottomPanel::bottom("fx")
            .frame(egui::Frame::new().fill(theme::SIDE).inner_margin(8.0).stroke(Stroke::new(1.0_f32, theme::BORDER)))
            .resizable(true).default_height(328.0).min_height(120.0).show(ctx, |ui| self.fx_panel(ui));
        egui::CentralPanel::default().show(ctx, |ui| self.timeline(ui));
        self.windows(ctx);
        self.dev_screenshot(ctx);
        // Meters and the playhead need steady redraws even without input.
        let playing = self.tr.playing.load(Relaxed);
        ctx.request_repaint_after(Duration::from_millis(if playing { 16 } else { 40 }));
    }
}

impl App {
    /// Development aid: with SNAKEDAW_SHOT=<file.ppm> set, save a picture of the window and quit.
    /// SNAKEDAW_SHOT_UI may list dialogs to open first (looper, tuner, settings, help).
    fn dev_screenshot(&mut self, ctx: &egui::Context) {
        let Ok(path) = std::env::var("SNAKEDAW_SHOT") else { return };
        let frame = ctx.cumulative_pass_nr();
        if frame == 2 {
            let ui = std::env::var("SNAKEDAW_SHOT_UI").unwrap_or_default();
            self.ui.show_looper = ui.contains("looper");
            self.ui.show_tuner = ui.contains("tuner");
            self.ui.show_settings = ui.contains("settings");
            self.ui.show_help = ui.contains("help");
        }
        if frame == 10 && std::env::var("SNAKEDAW_SHOT_UI").is_ok_and(|ui| ui.contains("import")) {
            if let Some(id) = self.project.tracks.first().map(|t| t.id) {
                self.import_loop_region(0, id);
                self.project.loop_sources[1] = self.project.tracks.iter().map(|t| t.id).take(2).collect();
            }
        }
        if frame == 40 {
            ctx.send_viewport_cmd(egui::ViewportCommand::Screenshot(Default::default()));
        }
        let shot = ctx.input(|i| {
            i.raw.events.iter().find_map(|e| match e {
                egui::Event::Screenshot { image, .. } => Some(image.clone()),
                _ => None,
            })
        });
        if let Some(image) = shot {
            let mut data = format!("P6\n{} {}\n255\n", image.width(), image.height()).into_bytes();
            data.extend(image.pixels.iter().flat_map(|p| [p.r(), p.g(), p.b()]));
            let _ = std::fs::write(path, data);
            ctx.send_viewport_cmd(egui::ViewportCommand::Close);
        }
        ctx.request_repaint();
    }

    fn shortcuts(&mut self, ctx: &egui::Context) {
        if ctx.wants_keyboard_input() {
            return;
        }
        let hit = |m: Modifiers, k: Key| ctx.input_mut(|i| i.consume_key(m, k));
        if hit(Modifiers::CTRL | Modifiers::SHIFT, Key::Z) || hit(Modifiers::CTRL, Key::Y) {
            self.redo();
        }
        if hit(Modifiers::CTRL, Key::Z) {
            self.undo();
        }
        if hit(Modifiers::CTRL, Key::S) {
            self.save();
            self.status = "Project saved.".into();
        }
        if hit(Modifiers::CTRL, Key::D) {
            self.duplicate_selected();
        }
        if hit(Modifiers::NONE, Key::Space) {
            self.toggle_play();
        }
        if hit(Modifiers::NONE, Key::R) {
            self.toggle_record();
        }
        if hit(Modifiers::NONE, Key::Home) {
            self.seek(0);
        }
        if hit(Modifiers::NONE, Key::S) {
            self.split();
        }
        if hit(Modifiers::NONE, Key::Delete) || hit(Modifiers::NONE, Key::Backspace) {
            self.delete_selected();
        }
        if hit(Modifiers::NONE, Key::L) {
            self.toggle_loop();
        }
        if hit(Modifiers::NONE, Key::M) {
            self.project.metronome = !self.project.metronome;
        }
        if hit(Modifiers::NONE, Key::T) {
            self.ui.show_tuner = !self.ui.show_tuner;
        }
        for (slot, key) in [Key::Num1, Key::Num2, Key::Num3, Key::Num4].into_iter().enumerate() {
            if hit(Modifiers::SHIFT, key) {
                self.loop_action(slot, LoopAction::ToggleStop);
            } else if hit(Modifiers::NONE, key) {
                self.loop_action(slot, LoopAction::Press);
            }
        }
    }

    fn toggle_loop(&mut self) {
        self.project.loop_on = !self.project.loop_on;
        if self.project.loop_on && self.project.loop_end <= self.project.loop_start {
            // No region yet: loop four bars from the playhead.
            let bars = (self.beat_frames() * self.project.beats_per_bar as f64 * 4.0) as i64;
            self.project.loop_start = self.pos().max(0);
            self.project.loop_end = self.project.loop_start + bars;
        }
    }

    fn snapped(&self, frame: i64) -> i64 {
        if !self.ui.snap {
            return frame;
        }
        let beat = self.beat_frames();
        ((frame as f64 / beat).round() * beat) as i64
    }

    // ------------------------------------------------------------ top bar

    fn top_bar(&mut self, ui: &mut Ui) {
        egui::menu::bar(ui, |ui| {
            if let Some(logo) = &self.ui.logo {
                ui.add(egui::Image::new(logo).fit_to_exact_size(vec2(20.0, 20.0)));
            }
            ui.label(RichText::new("Snake's DAW").strong().color(theme::FG));
            ui.add_space(6.0);
            ui.menu_button("File", |ui| {
                if ui.button("New project…").clicked() {
                    self.ui.new_name.clear();
                    self.ui.show_new = true;
                    ui.close_menu();
                }
                if ui.button("Open project…").clicked() {
                    self.ui.show_open = true;
                    ui.close_menu();
                }
                if ui.button("Save    Ctrl+S").clicked() {
                    self.save();
                    self.status = "Project saved.".into();
                    ui.close_menu();
                }
                ui.separator();
                if ui.button("Export mixdown (WAV)").clicked() {
                    self.start_export();
                    ui.close_menu();
                }
                if ui.button("Show project folder").clicked() {
                    open_folder(&self.dir);
                    ui.close_menu();
                }
            });
            ui.menu_button("Edit", |ui| {
                let items: [(&str, fn(&mut App)); 5] = [
                    ("Undo    Ctrl+Z", App::undo),
                    ("Redo    Ctrl+Shift+Z", App::redo),
                    ("Split at playhead    S", App::split),
                    ("Duplicate clip    Ctrl+D", App::duplicate_selected),
                    ("Delete clip    Del", App::delete_selected),
                ];
                for (label, action) in items {
                    if ui.button(label).clicked() {
                        action(self);
                        ui.close_menu();
                    }
                }
            });
            ui.menu_button("Track", |ui| self.add_track_menu(ui));
            ui.menu_button("Help", |ui| {
                if ui.button("Shortcuts and tips").clicked() {
                    self.ui.show_help = true;
                    ui.close_menu();
                }
            });
            ui.separator();
            ui.label(RichText::new(&self.project.name).color(theme::FG2));
        });
        ui.add_space(2.0);

        ui.horizontal(|ui| {
            let playing = self.tr.playing.load(Relaxed);
            let recording = self.is_recording();
            if big(ui, "⏮", None).on_hover_text("Back to start (Home)").clicked() {
                self.seek(0);
            }
            if big(ui, if playing { "⏸" } else { "▶" }, None).on_hover_text("Play / pause (Space)").clicked() {
                self.toggle_play();
            }
            if big(ui, "⏹", None).on_hover_text("Stop").clicked() {
                self.stop();
            }
            let rec_color = if recording { RED } else { Color32::from_rgb(170, 80, 80) };
            if big(ui, "⏺", Some(rec_color)).on_hover_text("Record armed tracks (R)").clicked() {
                self.toggle_record();
            }

            let pos = self.pos();
            let beat = pos as f64 / self.beat_frames();
            let bpb = self.project.beats_per_bar.max(1) as f64;
            let secs = pos.max(0) as f64 / self.sr();
            let time = format!(
                "{:>3}.{}   {}:{:04.1}",
                (beat / bpb).floor() as i64 + 1,
                beat.rem_euclid(bpb).floor() as i64 + 1,
                (secs / 60.0) as u32,
                secs % 60.0
            );
            ui.add_space(6.0);
            ui.label(RichText::new(time).font(FontId::monospace(20.0)).color(if recording { RED } else { Color32::WHITE }));
            ui.add_space(6.0);

            ui.add(DragValue::new(&mut self.project.bpm).range(30.0..=300.0).speed(0.25).suffix(" BPM")).on_hover_text("Tempo");
            ui.add(DragValue::new(&mut self.project.beats_per_bar).range(1..=12).suffix(" beats/bar"));
            ui.toggle_value(&mut self.project.metronome, "♪ Click").on_hover_text("Metronome (M)");
            ui.toggle_value(&mut self.project.count_in, "Count-in").on_hover_text("One bar of clicks before recording starts");
            let mut looping = self.project.loop_on;
            if ui.toggle_value(&mut looping, "Loop region").on_hover_text("Loop the region (L). Right-drag on the ruler to set it.").changed() {
                self.toggle_loop();
            }
            ui.toggle_value(&mut self.ui.snap, "Snap").on_hover_text("Snap clips, the playhead and the loop to beats");
            ui.separator();
            ui.toggle_value(&mut self.ui.show_tuner, "🎸 Tuner").on_hover_text("Chromatic tuner (T)");
            ui.toggle_value(&mut self.ui.show_looper, "🔁 Loop station").on_hover_text("Record and layer loops on the fly (keys 1-4)");
            if self.io.supports_desktop() {
                let mut desk = self.desktop_on;
                let tip = "Send browser / media player sound through the DAW so you can play along in your headphones";
                if ui.toggle_value(&mut desk, "🖥 Desktop audio").on_hover_text(tip).changed() {
                    self.set_desktop(desk);
                }
            }
            if ui.button("⚙ Audio").on_hover_text("Audio settings").clicked() {
                self.ui.show_settings = true;
            }

            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                let m = &mut self.ui.master_meter;
                *m = (smooth(m.0, self.tr.master_peak_l.take()), smooth(m.1, self.tr.master_peak_r.take()));
                let (rect, _) = ui.allocate_exact_size(vec2(110.0, 16.0), Sense::hover());
                let (top, bottom) = rect.split_top_bottom_at_fraction(0.5);
                meter(ui.painter(), top.shrink2(vec2(0.0, 1.0)), m.0, false);
                meter(ui.painter(), bottom.shrink2(vec2(0.0, 1.0)), m.1, false);
                ui.spacing_mut().slider_width = 90.0;
                ui.add(Slider::new(&mut self.project.master_db, -60.0..=6.0).suffix(" dB").fixed_decimals(1));
                ui.label("🔊");
            });
        });
        ui.add_space(2.0);
    }

    fn add_track_menu(&mut self, ui: &mut Ui) {
        let items = [
            ("🎸 Guitar (amp + effects)", Preset::Guitar),
            ("🎤 Microphone / vocal", Preset::Mic),
            ("🖥 Desktop audio (play-along)", Preset::Desktop),
            ("Empty audio track", Preset::Empty),
        ];
        for (label, preset) in items {
            if ui.button(label).clicked() {
                self.add_track(preset);
                ui.close_menu();
            }
        }
    }

    fn status_bar(&mut self, ui: &mut Ui) {
        ui.horizontal(|ui| {
            if let Some(ex) = &self.export {
                ui.add(egui::ProgressBar::new(ex.progress.get()).desired_width(160.0).text("Exporting…"));
            }
            ui.label(&self.status);
            ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                let buf = self.io.buffer_size();
                let xruns = self.tr.xruns.load(Relaxed);
                let text = format!(
                    "{} · {} Hz · buffer {} ({:.1} ms) · DSP {:.0}% · dropouts {}",
                    if self.io.system().is_some() { "System audio" } else { "JACK" },
                    self.io.sample_rate,
                    buf,
                    buf as f64 / self.sr() * 1000.0,
                    self.io.cpu_load(),
                    xruns
                );
                ui.label(RichText::new(text).color(if self.io.output_connected() { theme::FG2 } else { ORANGE }));
                if !self.io.output_connected() {
                    ui.label(RichText::new("No audio output connected – check ⚙ Audio").color(ORANGE));
                }
            });
        });
    }

    // ------------------------------------------------------------ timeline

    fn timeline(&mut self, ui: &mut Ui) {
        let sr = self.sr();
        let full = ui.available_rect_before_wrap();
        let lane_x0 = full.left() + HEADER_W;
        let lane_w = (full.width() - HEADER_W).max(50.0);
        let lanes = Rect::from_min_max(pos2(lane_x0, full.top()), full.max);

        let hover = ui.input(|i| i.pointer.hover_pos());
        if let Some(ptr) = hover.filter(|p| lanes.contains(*p) && ui.rect_contains_pointer(lanes)) {
            // Over the timeline the wheel zooms (Shift+wheel slides). The scroll is taken here so
            // the track list underneath does not move as well; over the track names it still does.
            let (pinch, wheel) = ui.input_mut(|i| (i.zoom_delta(), std::mem::take(&mut i.smooth_scroll_delta)));
            let factor = pinch * (wheel.y * 0.004).exp();
            if factor != 1.0 {
                // Keep the time under the mouse pointer fixed while zooming.
                let x = (ptr.x - lane_x0) as f64;
                let t = self.ui.scroll + x / self.ui.zoom as f64;
                self.ui.zoom = (self.ui.zoom * factor).clamp(2.0, 3000.0);
                self.ui.scroll = t - x / self.ui.zoom as f64;
            }
            self.ui.scroll -= wheel.x as f64 / self.ui.zoom as f64;
        }
        let pos = self.pos();
        if self.tr.playing.load(Relaxed) && self.ui.drag == Drag::None {
            let px = (pos as f64 / sr - self.ui.scroll) * self.ui.zoom as f64;
            if px > lane_w as f64 * 0.95 || px < 0.0 {
                self.ui.scroll = pos as f64 / sr - lane_w as f64 * 0.1 / self.ui.zoom as f64;
            }
        }
        self.ui.scroll = self.ui.scroll.max(0.0);
        let view = View { x0: lane_x0, zoom: self.ui.zoom, scroll: self.ui.scroll, sr };

        for i in 0..NUM_INPUTS {
            self.ui.in_levels[i] = smooth(self.ui.in_levels[i], self.tr.input_peaks[i].take());
        }
        self.ui.in_levels[NUM_INPUTS] = smooth(self.ui.in_levels[NUM_INPUTS], self.tr.desktop_peak.take());

        let (rrect, _) = ui.allocate_exact_size(vec2(full.width(), RULER_H), Sense::hover());
        let corner = Rect::from_min_size(rrect.min, vec2(HEADER_W, RULER_H)).shrink2(vec2(6.0, 2.0));
        let mut corner_ui = ui.new_child(UiBuilder::new().max_rect(corner).layout(Layout::left_to_right(Align::Center)));
        corner_ui.menu_button("+ Add track", |ui| self.add_track_menu(ui));
        corner_ui.label(RichText::new("scroll: zoom · drag: slide").weak().small());
        self.ruler(ui, Rect::from_min_max(pos2(lane_x0, rrect.top()), rrect.max), view);

        let mut tracks = std::mem::take(&mut self.project.tracks);
        let mut remove = None;
        let list_height = (ui.available_height() - SCROLLBAR_H - 4.0).max(40.0);
        ScrollArea::vertical().auto_shrink([false, false]).max_height(list_height).show(ui, |ui| {
            ui.spacing_mut().item_spacing.y = 2.0;
            for t in &mut tracks {
                t.height = t.height.clamp(MIN_ROW_H, MAX_ROW_H);
                let (rect, _) = ui.allocate_exact_size(vec2(ui.available_width(), t.height), Sense::hover());
                let header = Rect::from_min_size(rect.min, vec2(HEADER_W, rect.height()));
                let lane = Rect::from_min_max(pos2(rect.left() + HEADER_W, rect.top()), rect.max);
                if self.track_header(ui, header, t) {
                    remove = Some(t.id);
                }
                self.lane(ui, lane, t, view);

                // The bottom edge of a track is a handle for changing its height.
                let grip = Rect::from_min_max(pos2(rect.left(), rect.bottom() - 3.0), pos2(rect.right(), rect.bottom() + 2.0));
                let resp = ui.interact(grip, ui.id().with(("height", t.id)), Sense::click_and_drag());
                if resp.hovered() || resp.dragged() {
                    ui.ctx().set_cursor_icon(CursorIcon::ResizeVertical);
                    ui.painter().hline(rect.x_range(), rect.bottom(), Stroke::new(2.0_f32, Color32::from_gray(150)));
                }
                if resp.dragged() {
                    t.height = (t.height + resp.drag_delta().y).clamp(MIN_ROW_H, MAX_ROW_H);
                }
                if resp.double_clicked() {
                    t.height = crate::project::default_height();
                }
            }
            if tracks.is_empty() {
                ui.add_space(30.0);
                ui.vertical_centered(|ui| ui.label("No tracks yet. Use “+ Add track” above."));
            }
        });
        self.project.tracks = tracks;
        self.scrollbar(ui, lane_x0, lane_w);

        if let Some(id) = remove {
            self.remove_track(id);
        }
        for act in std::mem::take(&mut self.ui.acts) {
            match act {
                Act::PushUndo => self.push_undo(),
                Act::Sync(id) => self.sync_clips(id),
                Act::Seek(f) => self.seek(f),
            }
        }
    }

    /// Horizontal scrollbar under the lanes.
    fn scrollbar(&mut self, ui: &mut Ui, lane_x0: f32, lane_w: f32) {
        let (row, _) = ui.allocate_exact_size(vec2(ui.available_width(), SCROLLBAR_H), Sense::hover());
        let track = Rect::from_min_max(pos2(lane_x0, row.top()), pos2(lane_x0 + lane_w, row.bottom()));
        let visible = lane_w as f64 / self.ui.zoom as f64;
        // The bar covers the project plus some room to keep working past its end.
        let total = (self.project_end() as f64 / self.sr() + visible * 0.5).max(self.ui.scroll + visible).max(1.0);
        let resp = ui.interact(track, ui.id().with("hscroll"), Sense::click_and_drag());
        let handle_w = ((visible / total) as f32 * lane_w).clamp(24.0, lane_w);
        let travel = (lane_w - handle_w).max(1.0);
        let max_scroll = (total - visible).max(0.0);
        if let Some(ptr) = resp.interact_pointer_pos().filter(|_| resp.dragged() || resp.clicked()) {
            let frac = ((ptr.x - track.left() - handle_w / 2.0) / travel).clamp(0.0, 1.0);
            self.ui.scroll = frac as f64 * max_scroll;
        }
        let frac = if max_scroll > 0.0 { (self.ui.scroll / max_scroll).clamp(0.0, 1.0) as f32 } else { 0.0 };
        let handle = Rect::from_min_size(pos2(track.left() + frac * travel, track.top() + 2.0), vec2(handle_w, SCROLLBAR_H - 4.0));
        let p = ui.painter();
        p.rect_filled(track, 3.0, theme::INPUT);
        p.rect_filled(handle, 3.0, if resp.hovered() || resp.dragged() { theme::FG3 } else { theme::BORDER2 });
    }

    fn ruler(&mut self, ui: &mut Ui, rect: Rect, view: View) {
        let resp = ui.interact(rect, ui.id().with("ruler"), Sense::click_and_drag());
        let p = ui.painter_at(rect);
        // Top strip: the loop region. Below it: bar numbers, where clicking moves the playhead.
        let strip = Rect::from_min_max(rect.min, pos2(rect.right(), rect.top() + LOOP_H));
        p.rect_filled(rect, 0.0, theme::SIDE);
        p.rect_filled(strip, 0.0, theme::INPUT);

        let (ls, le) = (self.project.loop_start, self.project.loop_end);
        let has_loop = le > ls;
        let (lx0, lx1) = (view.x(ls), view.x(le));
        if has_loop {
            let bar = Rect::from_min_max(pos2(lx0, strip.top() + 1.0), pos2(lx1, strip.bottom() - 1.0));
            let (fill, edge) = if self.project.loop_on { (BLUE.gamma_multiply(0.75), Color32::WHITE) } else { (theme::BUTTON2, theme::FG3) };
            p.rect_filled(bar, 3.0, fill);
            for x in [lx0, lx1 - 3.0] {
                p.rect_filled(Rect::from_min_max(pos2(x, bar.top()), pos2(x + 3.0, bar.bottom())), 1.0, edge);
            }
        }

        let bar = self.beat_frames() * self.project.beats_per_bar.max(1) as f64;
        let bar_px = bar / view.sr * view.zoom as f64;
        let mut step = 1i64;
        while bar_px * (step as f64) < 55.0 {
            step *= 2;
        }
        let mut n = ((view.frame(rect.left()) as f64 / bar).floor() as i64).max(0) / step * step;
        loop {
            let x = view.x((n as f64 * bar) as i64);
            if x > rect.right() {
                break;
            }
            p.vline(x, strip.bottom() + 12.0..=rect.bottom(), Stroke::new(1.0_f32, theme::BORDER2));
            p.text(pos2(x + 3.0, strip.bottom() + 1.0), Align2::LEFT_TOP, (n + 1).to_string(), FontId::proportional(11.0), theme::FG2);
            n += step;
        }

        let px = view.x(self.pos());
        p.add(egui::Shape::convex_polygon(
            vec![pos2(px - 6.0, rect.bottom() - 10.0), pos2(px + 6.0, rect.bottom() - 10.0), pos2(px, rect.bottom())],
            Color32::WHITE,
            Stroke::NONE,
        ));

        // Which part of the ruler is under a point.
        #[derive(PartialEq)]
        enum Zone {
            Seek,
            NewLoop,
            LoopStart,
            LoopEnd,
            LoopBody,
        }
        let zone = |pt: Pos2| {
            if !strip.contains(pt) {
                Zone::Seek
            } else if has_loop && (pt.x - lx0).abs() <= EDGE {
                Zone::LoopStart
            } else if has_loop && (pt.x - lx1).abs() <= EDGE {
                Zone::LoopEnd
            } else if has_loop && pt.x > lx0 && pt.x < lx1 {
                Zone::LoopBody
            } else {
                Zone::NewLoop
            }
        };
        if let Some(pt) = resp.hover_pos().filter(|_| self.ui.drag == Drag::None) {
            match zone(pt) {
                Zone::LoopStart | Zone::LoopEnd => ui.ctx().set_cursor_icon(CursorIcon::ResizeHorizontal),
                Zone::LoopBody => ui.ctx().set_cursor_icon(CursorIcon::Grab),
                _ => {}
            }
        }

        if resp.drag_started() {
            if let Some(origin) = ui.input(|i| i.pointer.press_origin()) {
                let f = view.frame(origin.x).max(0);
                let shift = ui.input(|i| i.modifiers.shift);
                self.ui.drag = if resp.drag_started_by(PointerButton::Secondary) || shift {
                    Drag::Loop { anchor: self.snapped(f) }
                } else {
                    match zone(origin) {
                        Zone::Seek => Drag::Seek,
                        Zone::NewLoop => Drag::Loop { anchor: self.snapped(f) },
                        Zone::LoopStart => Drag::LoopStart,
                        Zone::LoopEnd => Drag::LoopEnd,
                        Zone::LoopBody => Drag::LoopMove { grab: f - ls },
                    }
                };
            }
        }
        if let Some(ptr) = resp.interact_pointer_pos() {
            let raw = view.frame(ptr.x);
            let f = self.snapped(raw).max(0);
            let min_len = (view.sr * 0.05) as i64;
            if resp.dragged() {
                match self.ui.drag {
                    Drag::Loop { anchor } if f != anchor => {
                        self.project.loop_start = anchor.min(f);
                        self.project.loop_end = anchor.max(f);
                        self.project.loop_on = true;
                    }
                    Drag::LoopStart => self.project.loop_start = f.min(le - min_len).max(0),
                    Drag::LoopEnd => self.project.loop_end = f.max(ls + min_len),
                    Drag::LoopMove { grab } => {
                        let start = self.snapped(raw - grab).max(0);
                        self.project.loop_start = start;
                        self.project.loop_end = start + (le - ls);
                    }
                    Drag::Seek => self.ui.acts.push(Act::Seek(f)),
                    _ => {}
                }
            } else if resp.clicked_by(PointerButton::Primary) {
                if zone(ptr) == Zone::LoopBody {
                    // A click on the loop bar switches looping on or off.
                    self.project.loop_on = !self.project.loop_on;
                } else {
                    self.ui.acts.push(Act::Seek(f));
                }
            }
        }
        if resp.drag_stopped() {
            self.ui.drag = Drag::None;
        }
        resp.on_hover_text("Top strip: drag to draw a loop, drag its middle to move it, its ends to resize it, click it to switch it on/off.\nBelow: click or drag to move the playhead.");
    }

    /// Draw one track's controls. Returns true if the user asked to delete the track.
    fn track_header(&mut self, ui: &mut Ui, rect: Rect, t: &mut TrackDef) -> bool {
        let selected = self.ui.sel_track == Some(t.id);
        let color = COLORS[t.color % COLORS.len()];
        ui.painter().rect_filled(rect, 0.0, if selected { theme::SELECTION } else { theme::WIDGET });
        ui.painter().rect_filled(Rect::from_min_size(rect.min, vec2(5.0, rect.height())), 0.0, color);
        let pressed = ui.input(|i| i.pointer.primary_pressed().then(|| i.pointer.interact_pos()).flatten());
        if pressed.is_some_and(|p| rect.contains(p)) && ui.rect_contains_pointer(rect) {
            self.ui.sel_track = Some(t.id);
        }

        let mut remove = false;
        let inner = Rect::from_min_max(rect.min + vec2(11.0, 5.0), rect.max - vec2(26.0, 4.0));
        let mut child = ui.new_child(UiBuilder::new().max_rect(inner).layout(Layout::top_down(Align::LEFT)));
        child.set_clip_rect(rect.intersect(ui.clip_rect()));
        // A short track shows fewer rows of controls.
        let (show_buttons, show_volume) = (rect.height() >= 58.0, rect.height() >= 86.0);
        child.push_id(t.id, |ui| {
            ui.spacing_mut().item_spacing = vec2(4.0, 5.0);
            ui.horizontal(|ui| {
                ui.add(TextEdit::singleline(&mut t.name).desired_width(96.0));
                ComboBox::from_id_salt("input").width(104.0).selected_text(t.input.label()).show_ui(ui, |ui| {
                    for input in InputSel::all(self.inputs_available, self.io.supports_desktop()) {
                        ui.selectable_value(&mut t.input, input, input.label());
                    }
                });
                if ui.small_button("🗑").on_hover_text("Delete this track").clicked() {
                    remove = true;
                }
            });
            if show_buttons {
            ui.horizontal(|ui| {
                toggle(ui, &mut t.arm, "⏺", RED).on_hover_text("Arm: record this track when you press Record");
                toggle(ui, &mut t.monitor, "🎧", GREEN).on_hover_text("Monitor: hear this input live in your headphones");
                toggle(ui, &mut t.mute, "M", ORANGE).on_hover_text("Mute");
                toggle(ui, &mut t.solo, "S", YELLOW).on_hover_text("Solo");
                toggle(ui, &mut t.fx_on, "FX", BLUE).on_hover_text("Effects on/off. Off = clean signal, e.g. when your pedals do the work");
            });
            }
            if show_volume {
            ui.horizontal(|ui| {
                ui.spacing_mut().slider_width = 104.0;
                ui.add(Slider::new(&mut t.volume_db, -60.0..=6.0).suffix(" dB").fixed_decimals(1)).on_hover_text("Volume");
                ui.add(DragValue::new(&mut t.pan).range(-1.0..=1.0).speed(0.01).fixed_decimals(2).prefix("Pan "))
                    .on_hover_text("Pan: -1 left, 0 centre, 1 right");
            });
            }
        });

        // Meters: input level (thin, grey-blue) and the track's stereo output.
        let (pl, pr) = self.shared.get(&t.id).map_or((0.0, 0.0), |s| (s.peak_l.take(), s.peak_r.take()));
        let m = self.ui.meters.entry(t.id).or_insert((0.0, 0.0));
        *m = (smooth(m.0, pl), smooth(m.1, pr));
        let (top, bottom) = (rect.top() + 6.0, rect.bottom() - 6.0);
        let bar = |x: f32, w: f32| Rect::from_min_max(pos2(rect.right() - x, top), pos2(rect.right() - x + w, bottom));
        let input_level = match t.input {
            InputSel::Hw(i) => self.ui.in_levels[(i as usize).min(NUM_INPUTS - 1)],
            InputSel::Desktop => self.ui.in_levels[NUM_INPUTS],
            InputSel::None => 0.0,
        };
        let p = ui.painter();
        meter(p, bar(21.0, 3.0), input_level, true);
        meter(p, bar(16.0, 5.0), m.0, true);
        meter(p, bar(10.0, 5.0), m.1, true);
        remove
    }

    fn lane(&mut self, ui: &mut Ui, rect: Rect, t: &mut TrackDef, view: View) {
        let resp = ui.interact(rect, ui.id().with(("lane", t.id)), Sense::click_and_drag());
        let p = ui.painter_at(rect);
        let selected = self.ui.sel_track == Some(t.id);
        p.rect_filled(rect, 0.0, if selected { theme::HOVER } else { theme::BG });

        // Beat and bar grid.
        let beat = self.beat_frames();
        let bpb = self.project.beats_per_bar.max(1) as i64;
        let beat_px = beat / view.sr * view.zoom as f64;
        let stride = if beat_px >= 9.0 { 1 } else { bpb };
        if beat_px * stride as f64 >= 5.0 {
            let mut n = ((view.frame(rect.left()) as f64 / beat).floor() as i64).max(0) / stride * stride;
            loop {
                let x = view.x((n as f64 * beat) as i64);
                if x > rect.right() {
                    break;
                }
                let line = if n % bpb == 0 { theme::BORDER2 } else { theme::BORDER };
                p.vline(x, rect.y_range(), Stroke::new(1.0_f32, line));
                n += stride;
            }
        }
        if self.project.loop_on && self.project.loop_end > self.project.loop_start {
            let r = Rect::from_min_max(pos2(view.x(self.project.loop_start), rect.top()), pos2(view.x(self.project.loop_end), rect.bottom()));
            p.rect_filled(r, 0.0, Color32::from_rgba_unmultiplied(100, 170, 240, 14));
        }

        // Clips.
        let color = COLORS[t.color % COLORS.len()];
        let clip_rect = |start: i64, len: i64| {
            Rect::from_min_max(pos2(view.x(start), rect.top() + 3.0), pos2(view.x(start + len), rect.bottom() - 3.0))
        };
        for c in &t.clips {
            let r = clip_rect(c.start, c.len as i64);
            if !r.intersects(rect) {
                continue;
            }
            let is_sel = self.ui.sel_clip == Some((t.id, c.id));
            p.rect_filled(r, 4.0, color.gamma_multiply(if is_sel { 0.55 } else { 0.32 }));
            if let Some(data) = self.cache.get(&c.file) {
                draw_wave(&p, r.intersect(rect), view, c.start - c.offset as i64, &data.peaks, color);
            }
            let stroke = if is_sel { Stroke::new(2.0_f32, Color32::WHITE) } else { Stroke::new(1.0_f32, color) };
            p.rect_stroke(r, 4.0, stroke, StrokeKind::Inside);
        }
        if let Some(rec) = self.recs.iter().find(|r| r.track == t.id) {
            let r = clip_rect(self.rec_at, (self.pos() - self.rec_at).max(0));
            p.rect_filled(r, 4.0, RED.gamma_multiply(0.3));
            draw_wave(&p, r.intersect(rect), view, self.rec_at, &rec.peaks.lock().unwrap(), RED);
        }
        p.vline(view.x(self.pos()), rect.y_range(), Stroke::new(1.0_f32, Color32::WHITE));

        // Mouse: click selects or moves the playhead; drag moves a clip or trims its edges.
        #[derive(Clone, Copy, PartialEq)]
        enum Zone {
            Left,
            Body,
            Right,
        }
        let hit = |clips: &[ClipDef], pos: Pos2| {
            clips.iter().rev().find_map(|c| {
                let r = clip_rect(c.start, c.len as i64);
                if !r.contains(pos) {
                    return None;
                }
                let can_trim = r.width() > 4.0 * EDGE;
                let zone = if can_trim && pos.x - r.left() < EDGE {
                    Zone::Left
                } else if can_trim && r.right() - pos.x < EDGE {
                    Zone::Right
                } else {
                    Zone::Body
                };
                Some((c.id, c.start, zone))
            })
        };
        if let Some(pos) = resp.hover_pos() {
            match hit(&t.clips, pos) {
                Some((_, _, Zone::Body)) => ui.ctx().set_cursor_icon(CursorIcon::Grab),
                Some(_) => ui.ctx().set_cursor_icon(CursorIcon::ResizeHorizontal),
                None => {}
            }
        }
        let recording = self.is_recording();
        if resp.drag_started_by(PointerButton::Primary) && !recording {
            let origin = ui.input(|i| i.pointer.press_origin());
            if let Some((clip, start, zone)) = origin.and_then(|o| hit(&t.clips, o)) {
                let track = t.id;
                self.ui.sel_clip = Some((track, clip));
                self.ui.drag = match zone {
                    Zone::Left => Drag::TrimL { track, clip },
                    Zone::Right => Drag::TrimR { track, clip },
                    Zone::Body => Drag::Move { track, clip, grab: view.frame(origin.unwrap().x) - start },
                };
                self.ui.acts.push(Act::PushUndo);
            } else {
                self.ui.drag = Drag::Pan;
            }
        } else if resp.dragged_by(PointerButton::Middle) || (resp.dragged() && self.ui.drag == Drag::Pan) {
            // Dragging empty space (or with the middle button anywhere) slides the timeline.
            self.ui.scroll -= resp.drag_delta().x as f64 / view.zoom as f64;
            ui.ctx().set_cursor_icon(CursorIcon::Grabbing);
        } else if resp.dragged() {
            if let Some(ptr) = resp.interact_pointer_pos() {
                let f = view.frame(ptr.x);
                let min_len = (view.sr * 0.02) as i64;
                match self.ui.drag {
                    Drag::Move { track, clip, grab } if track == t.id => {
                        let start = self.snapped(f - grab).max(0);
                        if let Some(c) = t.clips.iter_mut().find(|c| c.id == clip) {
                            c.start = start;
                        }
                    }
                    Drag::TrimL { track, clip } if track == t.id => {
                        let f = self.snapped(f);
                        if let Some(c) = t.clips.iter_mut().find(|c| c.id == clip) {
                            let delta = (f - c.start).clamp(-(c.offset as i64).min(c.start), c.len as i64 - min_len);
                            c.start += delta;
                            c.offset = (c.offset as i64 + delta) as u64;
                            c.len = (c.len as i64 - delta) as u64;
                        }
                    }
                    Drag::TrimR { track, clip } if track == t.id => {
                        let f = self.snapped(f);
                        if let Some(c) = t.clips.iter_mut().find(|c| c.id == clip) {
                            let source = self.cache.get(&c.file).map_or(c.len as i64, |d| d.frames() as i64);
                            c.len = (f - c.start).clamp(min_len, (source - c.offset as i64).max(min_len)) as u64;
                        }
                    }
                    _ => {}
                }
            }
        }
        if resp.drag_stopped() && self.ui.drag != Drag::None {
            if self.ui.drag != Drag::Pan {
                self.ui.acts.push(Act::Sync(t.id));
            }
            self.ui.drag = Drag::None;
        }
        self.loop_drag_tab(ui, rect, t, view);
        if resp.clicked() {
            self.ui.sel_track = Some(t.id);
            if let Some(pos) = resp.interact_pointer_pos() {
                match hit(&t.clips, pos) {
                    Some((clip, _, _)) => self.ui.sel_clip = Some((t.id, clip)),
                    None => {
                        self.ui.sel_clip = None;
                        let f = self.snapped(view.frame(pos.x)).max(0);
                        self.ui.acts.push(Act::Seek(f));
                    }
                }
            }
        }
    }

    /// While the loop station is open, every track shows a tab on the loop region that can be
    /// dragged onto a loop to fill it with that track's audio.
    fn loop_drag_tab(&mut self, ui: &mut Ui, lane: Rect, t: &TrackDef, view: View) {
        let (ls, le) = (self.project.loop_start, self.project.loop_end);
        // Only tracks that actually have audio inside the region offer it.
        let has_audio = t.clips.iter().any(|c| c.start < le && c.start + c.len as i64 > ls);
        if !self.ui.show_looper || le <= ls || lane.height() < 26.0 || !has_audio {
            return;
        }
        let left = view.x(ls).max(lane.left()) + 3.0;
        let tab = Rect::from_min_size(pos2(left, lane.top() + 4.0), vec2(96.0, 18.0));
        if tab.right() > view.x(le).min(lane.right()) + 60.0 {
            return;
        }
        let resp = ui.interact(tab, ui.id().with(("loop-tab", t.id)), Sense::drag());
        let active = resp.hovered() || resp.dragged();
        let p = ui.painter_at(lane);
        p.rect_filled(tab, 4.0, if active { Color32::WHITE } else { BLUE });
        p.text(tab.center(), Align2::CENTER_CENTER, "🔁 drag to loop", FontId::proportional(11.0), Color32::BLACK);
        if resp.hovered() {
            ui.ctx().set_cursor_icon(CursorIcon::Grab);
        }
        if resp.dragged() {
            resp.dnd_set_drag_payload(LoopDrag { track: t.id });
            ui.ctx().set_cursor_icon(CursorIcon::Grabbing);
            if let Some(ptr) = ui.ctx().pointer_interact_pos() {
                // A label that follows the pointer while the region is carried to the loop station.
                let layer = egui::LayerId::new(egui::Order::Tooltip, egui::Id::new("loop-drag"));
                let text = format!("{}: {:.1} s → drop on a loop", t.name, (le - ls) as f64 / view.sr);
                let painter = ui.ctx().layer_painter(layer);
                let galley = painter.layout_no_wrap(text, FontId::proportional(13.0), Color32::BLACK);
                let bubble = Rect::from_min_size(ptr + vec2(14.0, 10.0), galley.size() + vec2(12.0, 8.0));
                painter.rect_filled(bubble, 5.0, Color32::WHITE);
                painter.galley(bubble.min + vec2(6.0, 4.0), galley, Color32::BLACK);
            }
        }
        resp.on_hover_text("Drag this onto a loop in the loop station to fill it with this part of the track");
    }

    // ------------------------------------------------------------ effects panel

    fn fx_panel(&mut self, ui: &mut Ui) {
        let Some(ti) = self.ui.sel_track.and_then(|id| self.project.tracks.iter().position(|t| t.id == id)) else {
            ui.add_space(8.0);
            ui.label("Select a track to see its effects.");
            return;
        };
        let track = self.project.tracks[ti].id;
        let mut add: Option<String> = None;
        let mut remove = None;
        let mut shift = None;

        ui.add_space(4.0);
        ui.horizontal(|ui| {
            let t = &mut self.project.tracks[ti];
            ui.label(RichText::new(format!("Effects · {}", t.name)).strong().size(15.0));
            toggle(ui, &mut t.fx_on, "FX", BLUE).on_hover_text("All effects on/off for this track");
            ui.menu_button("+ Add effect", |ui| {
                for (kind, name) in builtin::LIST {
                    if ui.button(*name).clicked() {
                        add = Some(kind.to_string());
                        ui.close_menu();
                    }
                }
                if !self.lv2.plugins.is_empty() {
                    ui.separator();
                    if ui.button("LV2 plugin (Guitarix and others)…").clicked() {
                        self.ui.show_lv2 = true;
                        ui.close_menu();
                    }
                }
            });
            ui.label(RichText::new("Signal flows left to right. Recordings stay clean, so you can change the tone afterwards.").weak());
        });
        ui.separator();

        let mut chain = std::mem::take(&mut self.project.tracks[ti].fx);
        let count = chain.len();
        ScrollArea::horizontal().auto_shrink([false, false]).show(ui, |ui| {
            ui.horizontal_top(|ui| {
                let height = ui.available_height() - 16.0;
                for (i, f) in chain.iter_mut().enumerate() {
                    let Some(h) = self.fx.get(&f.id) else { continue };
                    ui.push_id(f.id, |ui| {
                        let fill = if f.bypass { theme::SIDE } else { theme::BUTTON2 };
                        egui::Frame::group(ui.style()).fill(fill).show(ui, |ui| {
                            ui.set_width(214.0);
                            ui.set_min_height(height.max(60.0));
                            ui.vertical(|ui| {
                                ui.horizontal(|ui| {
                                    let mut on = !f.bypass;
                                    ui.checkbox(&mut on, RichText::new(&h.name).strong()).on_hover_text("Switch this effect on/off");
                                    f.bypass = !on;
                                    ui.with_layout(Layout::right_to_left(Align::Center), |ui| {
                                        if ui.small_button("🗑").on_hover_text("Remove").clicked() {
                                            remove = Some(f.id);
                                        }
                                        if ui.add_enabled(i + 1 < count, Button::new("▶").small()).on_hover_text("Move later").clicked() {
                                            shift = Some((f.id, 1));
                                        }
                                        if ui.add_enabled(i > 0, Button::new("◀").small()).on_hover_text("Move earlier").clicked() {
                                            shift = Some((f.id, -1));
                                        }
                                    });
                                });
                                // The knobs scroll inside the card when the panel is too short for them all.
                                let room = (height - ui.min_rect().height() - ui.spacing().item_spacing.y).max(40.0);
                                ScrollArea::vertical().id_salt("params").max_height(room).show(ui, |ui| {
                                    ui.spacing_mut().slider_width = 120.0;
                                    ui.add_enabled_ui(!f.bypass, |ui| {
                                        for (info, value) in h.infos.iter().zip(f.params.iter_mut()) {
                                            if info.max <= info.min {
                                                continue;
                                            }
                                            ui.label(RichText::new(&info.name).small());
                                            let slider = Slider::new(value, info.min..=info.max)
                                                .logarithmic(info.log)
                                                .step_by(info.step as f64)
                                                .suffix(format!(" {}", info.unit));
                                            if ui.add(slider).on_hover_text("Double-click to reset").double_clicked() {
                                                *value = info.default;
                                            }
                                        }
                                    });
                                });
                            });
                        });
                    });
                }
                if count == 0 {
                    ui.label("No effects: this track is a clean signal. Use “+ Add effect”.");
                }
            });
        });
        self.project.tracks[ti].fx = chain;

        if let Some(kind) = add {
            self.add_fx(track, &kind);
        }
        if let Some(fx) = remove {
            self.remove_fx(track, fx);
        }
        if let Some((fx, by)) = shift {
            self.move_fx(track, fx, by);
        }
    }

    // ------------------------------------------------------------ dialogs

    fn windows(&mut self, ctx: &egui::Context) {
        self.tuner_window(ctx);
        self.looper_window(ctx);
        self.settings_window(ctx);
        self.lv2_window(ctx);

        let mut open = self.ui.show_new;
        egui::Window::new("New project").open(&mut open).collapsible(false).resizable(false).show(ctx, |ui| {
            ui.label("Project name");
            let entered = ui.text_edit_singleline(&mut self.ui.new_name).lost_focus() && ui.input(|i| i.key_pressed(Key::Enter));
            let ready = !self.ui.new_name.trim().is_empty();
            if (ui.add_enabled(ready, Button::new("Create")).clicked() || entered) && ready {
                let name = self.ui.new_name.clone();
                self.new_project(&name);
                self.ui.show_new = false;
            }
            ui.label(RichText::new(format!("Saved in {}", self.cfg.projects_dir.display())).weak().small());
        });
        self.ui.show_new &= open;

        let mut open = self.ui.show_open;
        egui::Window::new("Open project").open(&mut open).collapsible(false).show(ctx, |ui| {
            let projects = self.list_projects();
            if projects.is_empty() {
                ui.label("No saved projects yet.");
            }
            ScrollArea::vertical().max_height(360.0).show(ui, |ui| {
                for dir in projects {
                    let name = dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                    let current = dir == self.dir;
                    if ui.add_enabled(!current, Button::new(&name).min_size(vec2(260.0, 24.0))).clicked() {
                        if let Err(e) = self.open_project(&dir) {
                            self.status = format!("Could not open {name}: {e:#}");
                        }
                        self.ui.show_open = false;
                    }
                }
            });
        });
        self.ui.show_open &= open;

        egui::Window::new("Shortcuts and tips").open(&mut self.ui.show_help).collapsible(false).resizable(false).show(ctx, |ui| {
            egui::Grid::new("keys").num_columns(2).spacing([24.0, 5.0]).show(ui, |ui| {
                for (key, what) in [
                    ("Space", "Play / pause"),
                    ("R", "Record armed tracks / stop recording"),
                    ("Home", "Back to the start"),
                    ("L", "Loop on/off"),
                    ("M", "Metronome on/off"),
                    ("T", "Tuner"),
                    ("1 2 3 4", "Loop station: record / play / overdub a loop"),
                    ("Shift+1…4", "Loop station: mute / unmute a loop"),
                    ("S", "Split clip at the playhead"),
                    ("Del", "Delete selected clip"),
                    ("Ctrl+D", "Duplicate selected clip"),
                    ("Ctrl+Z / Ctrl+Shift+Z", "Undo / redo clip edits"),
                    ("Ctrl+S", "Save"),
                    ("Scroll on the timeline", "Zoom in / out at the pointer"),
                    ("Shift+scroll, or drag empty space", "Slide the timeline sideways"),
                    ("Scroll on the track names", "Scroll the track list"),
                    ("Drag a track's bottom edge", "Change its height (double-click resets)"),
                    ("Top strip of the ruler", "Draw, move and resize the loop region"),
                    ("Drag clip / clip edge", "Move / trim"),
                ] {
                    ui.label(RichText::new(key).monospace());
                    ui.label(what);
                    ui.end_row();
                }
            });
            ui.separator();
            ui.label("If your interface has a direct-monitor or MIX knob, turn it fully towards playback (PB / DAW)\nso you only hear the processed sound, not the dry signal on top of it.");
        });
    }

    fn tuner_window(&mut self, ctx: &egui::Context) {
        let mut open = self.ui.show_tuner;
        egui::Window::new("Tuner").open(&mut open).collapsible(false).resizable(false).show(ctx, |ui| {
            let mut input = self.tr.tuner_input.load(Relaxed);
            ComboBox::from_id_salt("tuner-in").selected_text(format!("Input {}", input + 1)).show_ui(ui, |ui| {
                for i in 0..self.inputs_available.max(1) as u32 {
                    ui.selectable_value(&mut input, i, format!("Input {}", i + 1));
                }
            });
            self.tr.tuner_input.store(input, Relaxed);

            let (rect, _) = ui.allocate_exact_size(vec2(320.0, 130.0), Sense::hover());
            let p = ui.painter_at(rect);
            p.rect_filled(rect, 6.0, theme::INPUT);
            let centre = rect.center().x;
            let bar_y = rect.bottom() - 30.0;
            p.hline(rect.left() + 20.0..=rect.right() - 20.0, bar_y, Stroke::new(2.0_f32, theme::BORDER2));
            p.vline(centre, bar_y - 12.0..=bar_y + 12.0, Stroke::new(2.0_f32, theme::FG2));
            match &self.tuner.reading {
                Some(r) => {
                    let in_tune = r.cents.abs() < 5.0;
                    let color = if in_tune { GREEN } else { ORANGE };
                    p.text(pos2(centre, rect.top() + 42.0), Align2::CENTER_CENTER, &r.note, FontId::proportional(54.0), color);
                    let x = centre + (r.cents / 50.0).clamp(-1.0, 1.0) * (rect.width() / 2.0 - 20.0);
                    p.circle_filled(pos2(x, bar_y), 9.0, color);
                    let hint = if in_tune { "in tune".to_string() } else if r.cents < 0.0 { "too low: tighten".into() } else { "too high: loosen".into() };
                    let text = format!("{:.1} Hz   {:+.0} cents   {hint}", r.freq, r.cents);
                    p.text(pos2(centre, rect.bottom() - 9.0), Align2::CENTER_CENTER, text, FontId::proportional(12.0), theme::FG2);
                }
                None => {
                    p.text(pos2(centre, rect.top() + 42.0), Align2::CENTER_CENTER, "–", FontId::proportional(54.0), theme::FG3);
                    p.text(pos2(centre, rect.bottom() - 9.0), Align2::CENTER_CENTER, "Play a single string", FontId::proportional(12.0), theme::FG2);
                }
            }
        });
        self.ui.show_tuner = open;
    }

    fn looper_window(&mut self, ctx: &egui::Context) {
        let mut open = self.ui.show_looper;
        egui::Window::new("Loop station").open(&mut open).collapsible(false).resizable(false).default_pos([620.0, 300.0]).show(ctx, |ui| {
            let lp = self.looper.clone();
            ui.horizontal(|ui| {
                let mut count_in = lp.count_in.load(Relaxed);
                ui.toggle_value(&mut count_in, "Count-in").on_hover_text("Click one bar before the first loop starts recording");
                lp.count_in.store(count_in, Relaxed);
                let mut click = lp.click.load(Relaxed);
                ui.toggle_value(&mut click, "♪ Click").on_hover_text("The loop station's own metronome, heard while you loop (it is not recorded)");
                lp.click.store(click, Relaxed);
                ui.add(DragValue::new(&mut self.project.bpm).range(30.0..=300.0).speed(0.25).suffix(" BPM"));
                ui.add(DragValue::new(&mut self.project.beats_per_bar).range(1..=12).suffix(" beats/bar"));
                if count_in || click {
                    ui.label(RichText::new("first loop ends on a whole bar").weak().small());
                }
            });

            let len = lp.len.load(Relaxed);
            let pos = lp.pos.load(Relaxed);
            let states: [u32; looper::SLOTS] = std::array::from_fn(|s| lp.state[s].load(Relaxed));
            let secs = |frames: u64| frames as f64 / self.sr();
            let (frac, text) = if len > 0 {
                (pos as f32 / len as f32, format!("{:.1} / {:.1} s", secs(pos), secs(len)))
            } else if states.contains(&looper::COUNTING) {
                let bar = self.beat_frames() * self.project.beats_per_bar.max(1) as f64;
                let beat = (pos as f64 / self.beat_frames()).floor() as u32 + 1;
                ((pos as f64 / bar) as f32, format!("count-in: {beat}"))
            } else if states.contains(&looper::RECORDING) {
                (pos as f32 / (self.sr() as f32 * looper::MAX_SECONDS as f32), format!("recording first loop: {:.1} s", secs(pos)))
            } else {
                (0.0, "empty – record a loop to set the length".to_string())
            };
            ui.add(egui::ProgressBar::new(frac).desired_width(SLOT_W * looper::SLOTS as f32 + 24.0).text(text));
            ui.add_space(4.0);

            let mut actions = Vec::new();
            let mut dropped = None;
            let track_names: Vec<(u64, String)> = self.project.tracks.iter().map(|t| (t.id, t.name.clone())).collect();
            ui.horizontal(|ui| {
                for slot in 0..looper::SLOTS {
                    ui.vertical(|ui| {
                        ui.set_width(SLOT_W);
                        let state = states[slot];
                        let sources = &mut self.project.loop_sources[slot];
                        let names: Vec<&str> = track_names.iter().filter(|(id, _)| sources.contains(id)).map(|(_, n)| n.as_str()).collect();
                        let selected = self.ui.sel_track.and_then(|id| track_names.iter().find(|(t, _)| *t == id));
                        let from = match names.as_slice() {
                            // Nothing chosen: pressing the loop will take the selected track.
                            [] => selected.map_or("no track".to_string(), |(_, n)| format!("{n} (selected)")),
                            [one] => one.to_string(),
                            [first, rest @ ..] => format!("{first} +{}", rest.len()),
                        };

                        let (label, color) = match state {
                            looper::COUNTING => ("Count-in…\npress to cancel", YELLOW),
                            looper::RECORDING => ("Recording\npress to play", RED),
                            looper::PLAYING => ("Playing\npress to overdub", GREEN),
                            looper::OVERDUB => ("Overdubbing\npress to finish", ORANGE),
                            looper::STOPPED => ("Muted\npress to play", Color32::from_gray(110)),
                            _ => ("Empty\npress to record", Color32::from_gray(70)),
                        };
                        let fg = if state == looper::EMPTY { Color32::WHITE } else { Color32::BLACK };
                        let text = RichText::new(format!("{}\n{label}", slot + 1)).color(fg).strong();
                        let button = ui.add(Button::new(text).fill(color).min_size(vec2(SLOT_W, 74.0)));
                        if button.clicked() {
                            actions.push((slot, LoopAction::Press));
                        }
                        // A loop region dragged over from the timeline can be dropped here.
                        if button.dnd_hover_payload::<LoopDrag>().is_some() {
                            ui.painter().rect_stroke(button.rect.expand(2.0), 4.0, Stroke::new(3.0_f32, Color32::WHITE), StrokeKind::Outside);
                        }
                        if let Some(drag) = button.dnd_release_payload::<LoopDrag>() {
                            dropped = Some((slot, drag.track));
                        }

                        // Which tracks this loop records.
                        let warn = names.is_empty() && selected.is_none();
                        let title = RichText::new(format!("⏺ {from}")).color(if warn { ORANGE } else { ui.visuals().text_color() });
                        ui.menu_button(title, |ui| {
                            ui.label(RichText::new(format!("Loop {} records:", slot + 1)).strong());
                            for (id, name) in &track_names {
                                let mut on = sources.contains(id);
                                if ui.checkbox(&mut on, name).changed() {
                                    if on {
                                        sources.push(*id);
                                    } else {
                                        sources.retain(|s| s != id);
                                    }
                                }
                            }
                            if track_names.is_empty() {
                                ui.label("There are no tracks yet.");
                            }
                        })
                        .response
                        .on_hover_text("Choose which tracks this loop records. Each loop can listen to different tracks.");

                        ui.horizontal(|ui| {
                            let half = vec2((SLOT_W - 8.0) / 2.0, 22.0);
                            let mute = if state == looper::STOPPED { "▶" } else { "⏹" };
                            if ui.add_enabled(state != looper::EMPTY, Button::new(mute).min_size(half)).on_hover_text("Mute / unmute").clicked() {
                                actions.push((slot, LoopAction::ToggleStop));
                            }
                            if ui.add_enabled(state != looper::EMPTY, Button::new("🗑").min_size(half)).on_hover_text("Erase this loop").clicked() {
                                actions.push((slot, LoopAction::Clear));
                            }
                        });
                        let mut db = gain_to_db(lp.gain[slot].get()).max(-60.0);
                        ui.spacing_mut().slider_width = SLOT_W - 52.0;
                        if ui.add(Slider::new(&mut db, -60.0..=6.0).suffix(" dB").fixed_decimals(0)).changed() {
                            lp.gain[slot].set(crate::util::db_to_gain(db));
                        }
                    });
                }
            });
            ui.add_space(4.0);
            ui.horizontal(|ui| {
                if ui.button("Erase all loops").clicked() {
                    actions.extend((0..looper::SLOTS).map(|s| (s, LoopAction::Clear)));
                }
                ui.label(RichText::new("Keys 1-4 press a loop, Shift+1-4 mutes it. The first loop sets the length.").weak());
            });
            let hint = if self.project.loop_end > self.project.loop_start {
                "To use something you recorded: drag the 🔁 tab on a track's loop region and drop it on a loop."
            } else {
                "To use something you recorded: draw a loop region on the ruler, then drag its 🔁 tab from a track onto a loop."
            };
            ui.label(RichText::new(hint).weak());

            for (slot, action) in actions {
                self.loop_action(slot, action);
            }
            if let Some((slot, track)) = dropped {
                self.import_loop_region(slot, track);
            }
        });
        self.ui.show_looper = open;
    }

    fn settings_window(&mut self, ctx: &egui::Context) {
        let mut open = self.ui.show_settings;
        egui::Window::new("Audio settings").open(&mut open).collapsible(false).show(ctx, |ui| {
            let sr = self.sr();
            let mut changed = false;
            // Some choices can only be made while audio is being started.
            let mut restart = false;

            #[cfg(feature = "jack-backend")]
            fn port_combo(ui: &mut Ui, label: &str, setting: &mut String, ports: &[String], auto: Option<String>) -> bool {
                let before = setting.clone();
                let auto_text = format!("Auto: {}", auto.map_or("nothing found".to_string(), |a| short_port(&a)));
                let text = match setting.as_str() {
                    "" => auto_text.clone(),
                    "none" => "Not connected".to_string(),
                    name => short_port(name),
                };
                ui.label(label);
                ComboBox::from_id_salt(label).width(380.0).selected_text(text).show_ui(ui, |ui| {
                    ui.selectable_value(setting, String::new(), auto_text);
                    ui.selectable_value(setting, "none".to_string(), "Not connected");
                    for port in ports {
                        ui.selectable_value(setting, port.clone(), short_port(port));
                    }
                });
                ui.end_row();
                *setting != before
            }

            fn device_combo(ui: &mut Ui, label: &str, setting: &mut String, devices: &[(String, String)], in_use: &str) -> bool {
                let before = setting.clone();
                let default = format!("System default ({in_use})");
                let text = devices.iter().find(|(id, _)| id == setting).map_or(default.clone(), |(_, name)| name.clone());
                ui.label(label);
                ComboBox::from_id_salt(label).width(380.0).selected_text(text).show_ui(ui, |ui| {
                    ui.selectable_value(setting, String::new(), default);
                    for (id, name) in devices {
                        ui.selectable_value(setting, id.clone(), name);
                    }
                });
                ui.end_row();
                *setting != before
            }

            egui::Grid::new("audio").num_columns(2).spacing([12.0, 6.0]).show(ui, |ui| {
                ui.label("Audio system");
                let running = if self.io.system().is_some() { "System audio" } else { "JACK / PipeWire" };
                let choices: &[(&str, &str)] = if cfg!(feature = "jack-backend") {
                    &[("", "Automatic"), ("jack", "JACK / PipeWire (Linux, lowest delay)"), ("system", "System audio")]
                } else {
                    &[("", "System audio")]
                };
                let before = self.cfg.backend.clone();
                let label = choices.iter().find(|(key, _)| *key == before).map_or("Automatic", |(_, name)| name);
                ComboBox::from_id_salt("backend").width(380.0).selected_text(format!("{label} – running: {running}")).show_ui(ui, |ui| {
                    for (key, name) in choices {
                        ui.selectable_value(&mut self.cfg.backend, key.to_string(), *name);
                    }
                });
                restart |= self.cfg.backend != before;
                ui.end_row();

                ui.label("Buffer size");
                let current = self.io.buffer_size();
                let wanted = self.cfg.buffer_size;
                let mut buf = wanted;
                ComboBox::from_id_salt("buffer").selected_text(format!("{current} frames")).show_ui(ui, |ui| {
                    for n in [32u32, 64, 128, 256, 512, 1024, 2048] {
                        ui.selectable_value(&mut buf, n, format!("{n} frames ({:.1} ms)", n as f64 / sr * 1000.0));
                    }
                });
                if buf != wanted {
                    self.io.set_buffer_size(buf);
                    self.cfg.buffer_size = buf;
                    changed = true;
                    restart |= self.io.system().is_some();
                }
                ui.end_row();
                ui.label("Monitoring delay");
                ui.label(format!("about {:.1} ms in and out", self.io.roundtrip_latency() as f64 / sr * 1000.0));
                ui.end_row();

                #[cfg(feature = "jack-backend")]
                if let Some(jack) = self.io.jack() {
                    let captures = jack.capture_ports();
                    let playbacks = jack.playback_ports();
                    let found = jack.auto_inputs();
                    let outs = jack.auto_outputs();
                    // Show a row per detected input, plus any the user has set by hand.
                    let set_by_hand = self.cfg.inputs.iter().rposition(|s| !s.is_empty()).map_or(0, |i| i + 1);
                    let rows = found.len().max(set_by_hand).clamp(2, NUM_INPUTS);
                    for i in 0..rows {
                        changed |= port_combo(ui, &format!("Input {}", i + 1), &mut self.cfg.inputs[i], &captures, found.get(i).cloned());
                    }
                    changed |= port_combo(ui, "Output left", &mut self.cfg.out_l, &playbacks, outs.clone().map(|o| o.0));
                    changed |= port_combo(ui, "Output right", &mut self.cfg.out_r, &playbacks, outs.map(|o| o.1));
                }
                if let Some(sys) = self.io.system() {
                    restart |= device_combo(ui, "Input device", &mut self.cfg.device_in, &sys.input_devices, &sys.input_name);
                    restart |= device_combo(ui, "Output device", &mut self.cfg.device_out, &sys.output_devices, &sys.output_name);
                    ui.label("In use");
                    ui.label(format!("{} input(s) from {} → {}", sys.inputs, sys.input_name, sys.output_name));
                    ui.end_row();
                    if let Some(problem) = &sys.input_problem {
                        ui.label("");
                        ui.label(RichText::new(format!("No input: {problem}")).color(ORANGE));
                        ui.end_row();
                    }
                }

                ui.label("Recording offset");
                changed |= ui
                    .add(DragValue::new(&mut self.cfg.rec_offset_ms).range(-100.0..=100.0).speed(0.1).suffix(" ms"))
                    .on_hover_text("Increase if new recordings sound late against the other tracks, decrease if early")
                    .changed();
                ui.end_row();
            });
            ui.label(RichText::new("Smaller buffers feel more immediate; raise the size if you hear crackles.").weak());
            self.ui.restart_needed |= restart;
            if self.ui.restart_needed {
                ui.label(RichText::new("Close and reopen Snake's DAW to use the new audio settings.").color(ORANGE));
            }
            if changed || restart {
                self.io.apply_connections(&self.cfg);
                self.cfg.save();
                self.inputs_available = self.io.input_count(&self.cfg);
            }
        });
        self.ui.show_settings = open;
    }

    fn lv2_window(&mut self, ctx: &egui::Context) {
        let mut open = self.ui.show_lv2;
        let mut pick = None;
        egui::Window::new("Add LV2 plugin").open(&mut open).collapsible(false).default_size([380.0, 420.0]).show(ctx, |ui| {
            ui.horizontal(|ui| {
                ui.label("Search");
                ui.text_edit_singleline(&mut self.ui.lv2_search);
            });
            let query = self.ui.lv2_search.to_lowercase();
            ScrollArea::vertical().auto_shrink([false, false]).show(ui, |ui| {
                for plugin in self.lv2.plugins.iter().filter(|p| query.is_empty() || p.name.to_lowercase().contains(&query)) {
                    if ui.button(&plugin.name).on_hover_text(&plugin.uri).clicked() {
                        pick = Some(format!("lv2:{}", plugin.uri));
                    }
                }
                if self.lv2.plugins.is_empty() {
                    ui.label("No LV2 effect plugins were found on this system.");
                }
            });
        });
        self.ui.show_lv2 = open;
        if let (Some(kind), Some(track)) = (pick, self.ui.sel_track) {
            self.add_fx(track, &kind);
            self.ui.show_lv2 = false;
        }
    }
}
