//! Snake's DAW on Android.
//!
//! The engine, controller and effects are the desktop app's own source files,
//! compiled in by path, so the two stay one program. Only the window differs:
//! `ui` and `desktop` are small Android stand-ins for the egui interface and the
//! Linux desktop-audio routing, and `api` is the JNI facade the Compose UI uses.
#![allow(dead_code, unexpected_cfgs)]

#[path = "../../../../tools/Snake's DAW/src/app.rs"]
mod app;
#[path = "../../../../tools/Snake's DAW/src/audio.rs"]
mod audio;
#[path = "../../../../tools/Snake's DAW/src/audioio.rs"]
mod audioio;
#[path = "../../../../tools/Snake's DAW/src/cpalio.rs"]
mod cpalio;
#[path = "../../../../tools/Snake's DAW/src/engine.rs"]
mod engine;
#[path = "../../../../tools/Snake's DAW/src/fx/mod.rs"]
mod fx;
#[path = "../../../../tools/Snake's DAW/src/looper.rs"]
mod looper;
#[path = "../../../../tools/Snake's DAW/src/project.rs"]
mod project;
#[path = "../../../../tools/Snake's DAW/src/recorder.rs"]
mod recorder;
#[path = "../../../../tools/Snake's DAW/src/tuner.rs"]
mod tuner;
#[path = "../../../../tools/Snake's DAW/src/util.rs"]
mod util;

mod api;
mod desktop;
mod ui;
