//! What gets saved: the project file (`project.json` inside a project folder) and app settings.

use crate::engine::{NUM_INPUTS, SRC_DESKTOP, SRC_NONE};
use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Serialize, Deserialize, Clone, Copy, PartialEq, Debug)]
pub enum InputSel {
    None,
    /// Hardware input, zero-based (Hw(0) is "Input 1").
    Hw(u8),
    Desktop,
}

impl InputSel {
    pub fn src(self) -> u32 {
        match self {
            InputSel::None => SRC_NONE,
            InputSel::Hw(i) => i as u32,
            InputSel::Desktop => SRC_DESKTOP,
        }
    }

    pub fn label(self) -> String {
        match self {
            InputSel::None => "No input".into(),
            InputSel::Hw(i) => format!("Input {}", i + 1),
            InputSel::Desktop => "Desktop audio".into(),
        }
    }

    /// The choices to offer when the interface has `inputs` inputs.
    pub fn all(inputs: usize, desktop: bool) -> Vec<InputSel> {
        let mut v: Vec<_> = (0..inputs.min(NUM_INPUTS) as u8).map(InputSel::Hw).collect();
        if !desktop {
            v.push(InputSel::None);
            return v;
        }
        v.push(InputSel::Desktop);
        v.push(InputSel::None);
        v
    }
}

#[derive(Serialize, Deserialize, Clone, PartialEq, Debug)]
pub struct ClipDef {
    pub id: u64,
    /// Audio file, relative to the project folder.
    pub file: String,
    pub start: i64,
    pub offset: u64,
    pub len: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct FxDef {
    pub id: u64,
    pub kind: String,
    pub bypass: bool,
    pub params: Vec<f32>,
}

pub fn default_height() -> f32 {
    94.0
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct TrackDef {
    pub id: u64,
    pub name: String,
    pub input: InputSel,
    pub volume_db: f32,
    pub pan: f32,
    pub mute: bool,
    pub solo: bool,
    pub arm: bool,
    pub monitor: bool,
    pub fx_on: bool,
    pub color: usize,
    /// Height of the track row in the timeline, in pixels.
    #[serde(default = "default_height")]
    pub height: f32,
    pub clips: Vec<ClipDef>,
    pub fx: Vec<FxDef>,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Project {
    pub name: String,
    pub bpm: f32,
    pub beats_per_bar: u32,
    pub master_db: f32,
    pub metronome: bool,
    pub count_in: bool,
    pub loop_on: bool,
    pub loop_start: i64,
    pub loop_end: i64,
    pub next_id: u64,
    pub tracks: Vec<TrackDef>,
    /// For each loop station slot, the ids of the tracks it records.
    pub loop_sources: [Vec<u64>; crate::looper::SLOTS],
}

impl Default for Project {
    fn default() -> Self {
        Self {
            name: "Untitled".into(),
            bpm: 120.0,
            beats_per_bar: 4,
            master_db: 0.0,
            metronome: false,
            count_in: false,
            loop_on: false,
            loop_start: 0,
            loop_end: 0,
            next_id: 1,
            tracks: vec![],
            loop_sources: Default::default(),
        }
    }
}

impl Project {
    pub fn id(&mut self) -> u64 {
        self.next_id += 1;
        self.next_id
    }

    pub fn load(dir: &Path) -> Result<Self> {
        let path = dir.join("project.json");
        let text = std::fs::read_to_string(&path).with_context(|| format!("reading {}", path.display()))?;
        serde_json::from_str(&text).with_context(|| format!("parsing {}", path.display()))
    }

    pub fn save(&self, dir: &Path) -> Result<()> {
        std::fs::create_dir_all(dir.join("audio"))?;
        // Write to a temporary file first so a crash mid-save cannot corrupt the project.
        let tmp = dir.join("project.json.tmp");
        std::fs::write(&tmp, serde_json::to_string_pretty(self)?)?;
        std::fs::rename(&tmp, dir.join("project.json"))?;
        Ok(())
    }
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct Config {
    pub projects_dir: PathBuf,
    pub last_project: Option<PathBuf>,
    pub buffer_size: u32,
    /// Port per hardware input: "" = auto-detect the interface, "none" = unconnected.
    pub inputs: Vec<String>,
    pub out_l: String,
    pub out_r: String,
    /// Extra shift applied to new recordings, on top of the latency the audio server reports.
    pub rec_offset_ms: f32,
    /// The system's default output before we redirected desktop audio, to restore it afterwards.
    pub prev_default_sink: Option<String>,
    /// Audio backend: "" = best available, "jack" or "system".
    pub backend: String,
    /// Devices for the system backend, by id ("" = the system default).
    pub device_in: String,
    pub device_out: String,
}

impl Default for Config {
    fn default() -> Self {
        let music = dirs::audio_dir().or_else(dirs::home_dir).unwrap_or_else(|| PathBuf::from("."));
        Self {
            projects_dir: music.join("SnakeDAW"),
            last_project: None,
            buffer_size: 128,
            inputs: vec![String::new(); NUM_INPUTS],
            out_l: String::new(),
            out_r: String::new(),
            rec_offset_ms: 0.0,
            prev_default_sink: None,
            backend: String::new(),
            device_in: String::new(),
            device_out: String::new(),
        }
    }
}

impl Config {
    fn path() -> PathBuf {
        dirs::config_dir().unwrap_or_else(|| PathBuf::from(".")).join("snakedaw").join("config.json")
    }

    pub fn load() -> Self {
        let mut cfg: Self = std::fs::read_to_string(Self::path()).ok().and_then(|t| serde_json::from_str(&t).ok()).unwrap_or_default();
        cfg.inputs.resize(NUM_INPUTS, String::new());
        cfg
    }

    pub fn save(&self) {
        let path = Self::path();
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        if let Ok(text) = serde_json::to_string_pretty(self) {
            let _ = std::fs::write(path, text);
        }
    }
}
