//! Application state and everything the UI can ask for: projects, tracks, effects,
//! transport, recording, editing and export.

use crate::audio::{wav_spec, AudioData};
use crate::desktop;
use crate::engine::{ClipRt, Cmd, Garbage, Mixer, RecSink, TrackRt, TrackShared, Transport, NUM_INPUTS};
use crate::fx::{self, lv2::Lv2Host, FxShared, FxSlot, ParamInfo};
use crate::audioio::AudioIo;
use crate::looper::{self, LoopAction, LoopBuf, Looper, LooperShared};
use crate::project::{ClipDef, Config, FxDef, InputSel, Project, TrackDef};
use crate::recorder::{spawn_writer, LivePeaks};
use crate::tuner::Tuner;
use crate::ui::UiState;
use crate::util::{db_to_gain, sanitize, AtomicF32};
use anyhow::{anyhow, Result};
use rtrb::{Consumer, Producer, RingBuffer};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering::Relaxed;
use std::sync::Arc;
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

pub struct FxHandle {
    pub name: String,
    pub infos: Vec<ParamInfo>,
    pub shared: Arc<FxShared>,
}

pub struct ActiveRec {
    pub track: u64,
    pub file: String,
    pub peaks: LivePeaks,
    handle: Option<JoinHandle<Result<AudioData>>>,
}

pub struct Export {
    pub progress: Arc<AtomicF32>,
    handle: Option<JoinHandle<Result<PathBuf>>>,
}

#[derive(Clone, Copy, PartialEq)]
pub enum Preset {
    Guitar,
    Mic,
    Desktop,
    Empty,
}

type Snapshot = Vec<(u64, Vec<ClipDef>)>;

pub struct App {
    pub cfg: Config,
    pub project: Project,
    pub dir: PathBuf,
    pub io: AudioIo,
    pub tr: Arc<Transport>,
    cmd: Producer<Cmd>,
    garbage: Consumer<Garbage>,
    pub lv2: Lv2Host,
    pub tuner: Tuner,
    pub looper: Arc<LooperShared>,
    pub shared: HashMap<u64, Arc<TrackShared>>,
    pub fx: HashMap<u64, FxHandle>,
    pub cache: HashMap<String, Arc<AudioData>>,
    pub recs: Vec<ActiveRec>,
    pub rec_at: i64,
    pub export: Option<Export>,
    undo: Vec<Snapshot>,
    redo: Vec<Snapshot>,
    pub status: String,
    pub desktop_on: bool,
    /// How many hardware inputs the interface offers (refreshed while running).
    pub inputs_available: usize,
    pub ui: UiState,
    last_check: Instant,
}

impl App {
    pub fn new(mut cfg: Config) -> Result<Self> {
        let tr = Arc::new(Transport::new());
        let (cmd, cmd_rx) = RingBuffer::new(1024);
        let (garbage_tx, garbage) = RingBuffer::new(4096);
        let (tuner_tx, tuner_rx) = RingBuffer::new(1 << 16);
        let looper = Arc::new(LooperShared::new());
        let io = AudioIo::start(tr.clone(), &cfg, |sr| {
            Mixer::new(sr, tr.clone(), cmd_rx, garbage_tx, tuner_tx, Looper::new(sr, looper.clone()))
        })?;

        // A previous session that crashed may have left desktop audio redirected into nothing.
        if io.supports_desktop() && desktop::left_enabled() {
            desktop::disable(cfg.prev_default_sink.as_deref());
            cfg.prev_default_sink = None;
        }
        io.apply_connections(&cfg);
        let inputs_available = io.input_count(&cfg);

        let mut app = Self {
            dir: PathBuf::new(),
            project: Project::default(),
            io,
            tr,
            cmd,
            garbage,
            lv2: Lv2Host::new(),
            tuner: Tuner::new(tuner_rx),
            looper,
            shared: HashMap::new(),
            fx: HashMap::new(),
            cache: HashMap::new(),
            recs: Vec::new(),
            rec_at: 0,
            export: None,
            undo: Vec::new(),
            redo: Vec::new(),
            status: String::new(),
            desktop_on: false,
            inputs_available,
            ui: UiState::default(),
            last_check: Instant::now(),
            cfg,
        };
        let last = app.cfg.last_project.clone().filter(|d| d.join("project.json").exists());
        match last {
            Some(dir) => {
                if let Err(e) = app.open_project(&dir) {
                    app.new_project("My First Session");
                    app.status = format!("Could not open the last project: {e:#}");
                }
            }
            None => app.new_project("My First Session"),
        }
        Ok(app)
    }

    pub fn sr(&self) -> f64 {
        self.io.sample_rate as f64
    }

    pub fn pos(&self) -> i64 {
        self.tr.pos.load(Relaxed)
    }

    pub fn beat_frames(&self) -> f64 {
        self.sr() * 60.0 / self.project.bpm.max(20.0) as f64
    }

    pub fn is_recording(&self) -> bool {
        !self.recs.is_empty()
    }

    fn send(&mut self, mut cmd: Cmd) {
        // The audio thread empties the queue every block, so a full queue clears within milliseconds.
        for _ in 0..500 {
            match self.cmd.push(cmd) {
                Ok(()) => return,
                Err(rtrb::PushError::Full(c)) => cmd = c,
            }
            std::thread::sleep(Duration::from_millis(1));
        }
    }

    // ------------------------------------------------------------ projects

    pub fn list_projects(&self) -> Vec<PathBuf> {
        let mut dirs: Vec<PathBuf> = std::fs::read_dir(&self.cfg.projects_dir)
            .into_iter()
            .flatten()
            .flatten()
            .map(|e| e.path())
            .filter(|p| p.join("project.json").exists())
            .collect();
        dirs.sort();
        dirs
    }

    fn clear_engine(&mut self) {
        self.send(Cmd::Stop);
        self.send(Cmd::Seek(0));
        let ids: Vec<u64> = self.shared.keys().copied().collect();
        for id in ids {
            self.send(Cmd::RemoveTrack(id));
        }
        self.shared.clear();
        self.fx.clear();
        self.cache.clear();
        self.undo.clear();
        self.redo.clear();
        self.ui.sel_track = None;
        self.ui.sel_clip = None;
    }

    pub fn new_project(&mut self, name: &str) {
        self.save();
        let base = sanitize(name);
        let mut dir = self.cfg.projects_dir.join(&base);
        let mut n = 2;
        while dir.exists() {
            dir = self.cfg.projects_dir.join(format!("{base} {n}"));
            n += 1;
        }
        self.clear_engine();
        self.project = Project { name: name.trim().to_string(), ..Default::default() };
        self.dir = dir;
        self.add_track(Preset::Guitar);
        self.after_open();
    }

    pub fn open_project(&mut self, dir: &Path) -> Result<()> {
        let project = Project::load(dir)?;
        self.save();
        self.clear_engine();
        self.project = project;
        self.dir = dir.to_path_buf();
        let mut tracks = std::mem::take(&mut self.project.tracks);
        for t in &mut tracks {
            self.load_clip_audio(t);
            let rt = self.build_track(t);
            self.send(Cmd::AddTrack(rt));
        }
        self.project.tracks = tracks;
        self.after_open();
        Ok(())
    }

    fn after_open(&mut self) {
        self.ui.sel_track = self.project.tracks.first().map(|t| t.id);
        self.cfg.last_project = Some(self.dir.clone());
        self.cfg.save();
        self.save();
    }

    pub fn save(&mut self) {
        if self.dir.as_os_str().is_empty() {
            return;
        }
        if let Err(e) = self.project.save(&self.dir) {
            self.status = format!("Save failed: {e:#}");
        }
    }

    fn load_clip_audio(&mut self, t: &mut TrackDef) {
        for c in &t.clips {
            if self.cache.contains_key(&c.file) {
                continue;
            }
            match AudioData::load_wav(&self.dir.join(&c.file)) {
                Ok(data) => {
                    self.cache.insert(c.file.clone(), Arc::new(data));
                }
                Err(e) => self.status = format!("Missing audio: {e:#}"),
            }
        }
    }

    // ------------------------------------------------------------ tracks

    fn make_shared(t: &TrackDef) -> Arc<TrackShared> {
        let s = Arc::new(TrackShared::new());
        Self::sync_track(t, &s);
        s
    }

    fn sync_track(t: &TrackDef, s: &TrackShared) {
        s.gain.set(db_to_gain(t.volume_db));
        s.pan.set(t.pan);
        s.mute.store(t.mute, Relaxed);
        s.solo.store(t.solo, Relaxed);
        s.arm.store(t.arm, Relaxed);
        s.monitor.store(t.monitor, Relaxed);
        s.fx_on.store(t.fx_on, Relaxed);
        s.input.store(t.input.src(), Relaxed);
    }

    fn clips_rt(&self, t: &TrackDef) -> Vec<ClipRt> {
        t.clips
            .iter()
            .filter_map(|c| {
                let data = self.cache.get(&c.file)?.clone();
                Some(ClipRt { start: c.start, offset: c.offset as usize, len: c.len as usize, data })
            })
            .collect()
    }

    /// Create the effect for `def`, filling in default parameter values if it has none yet.
    fn make_fx(&mut self, def: &mut FxDef) -> Box<FxSlot> {
        let created = fx::create(&def.kind, self.io.sample_rate as f32, &self.lv2);
        if def.params.len() != created.infos.len() && !created.infos.is_empty() {
            def.params = created.infos.iter().map(|i| i.default).collect();
        }
        let values = if created.infos.is_empty() { &[][..] } else { &def.params[..] };
        let (slot, shared) = FxSlot::new(def.id, created.fx, values, def.bypass);
        self.fx.insert(def.id, FxHandle { name: created.name, infos: created.infos, shared });
        Box::new(slot)
    }

    fn build_track(&mut self, t: &mut TrackDef) -> Box<TrackRt> {
        let shared = Self::make_shared(t);
        self.shared.insert(t.id, shared.clone());
        let slots = t.fx.iter_mut().map(|f| self.make_fx(f)).collect();
        Box::new(TrackRt::new(t.id, shared, self.clips_rt(t), slots))
    }

    fn free_input(&self) -> InputSel {
        (0..self.inputs_available.clamp(1, NUM_INPUTS) as u8)
            .map(InputSel::Hw)
            .find(|i| !self.project.tracks.iter().any(|t| t.input == *i))
            .unwrap_or(InputSel::Hw(0))
    }

    pub fn add_track(&mut self, preset: Preset) {
        if self.project.tracks.len() >= crate::engine::MAX_TRACKS {
            return;
        }
        let (name, input, chain): (&str, InputSel, &[(&str, bool)]) = match preset {
            Preset::Guitar => (
                "Guitar",
                self.free_input(),
                &[("gate", false), ("drive", true), ("amp", false), ("cab", false), ("delay", true), ("reverb", false)],
            ),
            Preset::Mic => ("Mic", self.free_input(), &[("gate", true), ("comp", false), ("eq", false), ("reverb", false)]),
            Preset::Desktop => ("Play-along", InputSel::Desktop, &[]),
            Preset::Empty => ("Audio", self.free_input(), &[]),
        };
        let id = self.project.id();
        let fx = chain
            .iter()
            .map(|(kind, bypass)| FxDef { id: self.project.id(), kind: kind.to_string(), bypass: *bypass, params: vec![] })
            .collect();
        let live = preset != Preset::Desktop;
        if live {
            // Only one track records at a time unless the user arms more.
            self.project.tracks.iter_mut().for_each(|t| t.arm = false);
        }
        let mut t = TrackDef {
            id,
            name: name.to_string(),
            input,
            volume_db: 0.0,
            pan: 0.0,
            mute: false,
            solo: false,
            arm: live,
            monitor: true,
            fx_on: true,
            color: self.project.tracks.len(),
            height: crate::project::default_height(),
            clips: vec![],
            fx,
        };
        let rt = self.build_track(&mut t);
        self.send(Cmd::AddTrack(rt));
        self.project.tracks.push(t);
        self.ui.sel_track = Some(id);
    }

    pub fn remove_track(&mut self, id: u64) {
        if self.is_recording() {
            return;
        }
        if let Some(i) = self.project.tracks.iter().position(|t| t.id == id) {
            let t = self.project.tracks.remove(i);
            for f in &t.fx {
                self.fx.remove(&f.id);
            }
            self.shared.remove(&id);
            self.send(Cmd::RemoveTrack(id));
            if self.ui.sel_track == Some(id) {
                self.ui.sel_track = self.project.tracks.first().map(|t| t.id);
            }
            self.ui.sel_clip = None;
        }
    }

    pub fn sync_clips(&mut self, id: u64) {
        if let Some(t) = self.project.tracks.iter().find(|t| t.id == id) {
            let clips = self.clips_rt(t);
            self.send(Cmd::SetClips(id, clips));
        }
    }

    // ------------------------------------------------------------ effects

    pub fn add_fx(&mut self, track: u64, kind: &str) {
        let Some(i) = self.project.tracks.iter().position(|t| t.id == track) else { return };
        if self.project.tracks[i].fx.len() >= crate::engine::MAX_FX {
            return;
        }
        let mut def = FxDef { id: self.project.id(), kind: kind.to_string(), bypass: false, params: vec![] };
        let slot = self.make_fx(&mut def);
        let index = self.project.tracks[i].fx.len();
        self.project.tracks[i].fx.push(def);
        self.send(Cmd::AddFx { track, index, slot });
    }

    pub fn remove_fx(&mut self, track: u64, fx: u64) {
        if let Some(t) = self.project.tracks.iter_mut().find(|t| t.id == track) {
            t.fx.retain(|f| f.id != fx);
            self.fx.remove(&fx);
            self.send(Cmd::RemoveFx { track, fx });
        }
    }

    pub fn move_fx(&mut self, track: u64, fx: u64, by: i32) {
        let Some(t) = self.project.tracks.iter_mut().find(|t| t.id == track) else { return };
        let Some(i) = t.fx.iter().position(|f| f.id == fx) else { return };
        let j = i as i32 + by;
        if j < 0 || j as usize >= t.fx.len() {
            return;
        }
        t.fx.swap(i, j as usize);
        self.send(Cmd::MoveFx { track, fx, index: j as usize });
    }

    // ------------------------------------------------------------ transport

    pub fn seek(&mut self, pos: i64) {
        if !self.is_recording() {
            self.send(Cmd::Seek(pos.max(0)));
        }
    }

    pub fn toggle_play(&mut self) {
        if self.tr.playing.load(Relaxed) {
            self.send(Cmd::Stop);
        } else {
            self.send(Cmd::Play);
        }
    }

    pub fn stop(&mut self) {
        self.send(Cmd::Stop);
    }

    pub fn toggle_record(&mut self) {
        if self.is_recording() || self.tr.recording.load(Relaxed) {
            self.stop();
            return;
        }
        let armed: Vec<(u64, String, bool)> = self
            .project
            .tracks
            .iter()
            .filter(|t| t.arm && t.input != InputSel::None)
            .map(|t| (t.id, t.name.clone(), t.input == InputSel::Desktop))
            .collect();
        if armed.is_empty() {
            self.status = "Nothing to record: arm a track with the red ⏺ button on its left.".into();
            return;
        }
        if std::fs::create_dir_all(self.dir.join("audio")).is_err() {
            self.status = format!("Cannot write to {}", self.dir.display());
            return;
        }
        let sr = self.io.sample_rate;
        let at = self.pos().max(0);
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
        let mut sinks = Vec::with_capacity(armed.len());
        for (track, name, stereo) in armed {
            let file = format!("audio/{}-{stamp}-{track}.wav", sanitize(&name));
            let (tx, rx) = RingBuffer::new(sr as usize * 8);
            let peaks = LivePeaks::default();
            let handle = spawn_writer(self.dir.join(&file), sr, stereo, rx, peaks.clone());
            sinks.push(RecSink { track, tx, stereo });
            self.recs.push(ActiveRec { track, file, peaks, handle: Some(handle) });
        }
        let count_in = if self.project.count_in { (self.beat_frames() * self.project.beats_per_bar as f64) as i64 } else { 0 };
        self.rec_at = at;
        self.send(Cmd::Record { from: at - count_in, at, sinks });
        self.status = "Recording…".into();
    }

    /// Turn finished recordings into clips. Called every frame.
    fn poll_recordings(&mut self) {
        if self.recs.is_empty() || !self.recs.iter().all(|r| r.handle.as_ref().is_some_and(|h| h.is_finished())) {
            return;
        }
        self.push_undo();
        let shift = self.io.roundtrip_latency() + (self.cfg.rec_offset_ms as f64 * self.sr() / 1000.0) as i64;
        let recs = std::mem::take(&mut self.recs);
        let mut count = 0;
        for mut rec in recs {
            let result = rec.handle.take().unwrap().join().unwrap_or_else(|_| Err(anyhow!("recorder thread crashed")));
            let data = match result {
                Ok(d) => d,
                Err(e) => {
                    self.status = format!("Recording failed: {e:#}");
                    continue;
                }
            };
            // Shift the take earlier by the round-trip latency so it lines up with what was heard.
            let start = self.rec_at - shift;
            let offset = (-start).max(0);
            let len = data.frames() as i64 - offset;
            if len <= 0 {
                let _ = std::fs::remove_file(self.dir.join(&rec.file));
                continue;
            }
            self.cache.insert(rec.file.clone(), Arc::new(data));
            let id = self.project.id();
            if let Some(t) = self.project.tracks.iter_mut().find(|t| t.id == rec.track) {
                t.clips.push(ClipDef { id, file: rec.file, start: start.max(0), offset: offset as u64, len: len as u64 });
                self.ui.sel_clip = Some((rec.track, id));
                count += 1;
            }
            self.sync_clips(rec.track);
        }
        if count > 0 {
            self.status = format!("Recorded {count} clip{}.", if count == 1 { "" } else { "s" });
        }
        self.save();
    }

    // ------------------------------------------------------------ editing

    fn snapshot(&self) -> Snapshot {
        self.project.tracks.iter().map(|t| (t.id, t.clips.clone())).collect()
    }

    pub fn push_undo(&mut self) {
        self.undo.push(self.snapshot());
        if self.undo.len() > 100 {
            self.undo.remove(0);
        }
        self.redo.clear();
    }

    fn restore(&mut self, snap: Snapshot) {
        for (id, clips) in snap {
            if let Some(t) = self.project.tracks.iter_mut().find(|t| t.id == id) {
                t.clips = clips;
                self.sync_clips(id);
            }
        }
        self.ui.sel_clip = None;
    }

    pub fn undo(&mut self) {
        if let Some(snap) = self.undo.pop() {
            self.redo.push(self.snapshot());
            self.restore(snap);
        }
    }

    pub fn redo(&mut self) {
        if let Some(snap) = self.redo.pop() {
            self.undo.push(self.snapshot());
            self.restore(snap);
        }
    }

    /// Split the selected clip at the playhead, or every clip under it on the selected track.
    pub fn split(&mut self) {
        let p = self.pos();
        let Some(track) = self.ui.sel_clip.map(|c| c.0).or(self.ui.sel_track) else { return };
        let only = self.ui.sel_clip.map(|c| c.1);
        let Some(ti) = self.project.tracks.iter().position(|t| t.id == track) else { return };
        let hits: Vec<usize> = self.project.tracks[ti]
            .clips
            .iter()
            .enumerate()
            .filter(|(_, c)| p > c.start && p < c.start + c.len as i64 && only.is_none_or(|id| id == c.id))
            .map(|(i, _)| i)
            .collect();
        if hits.is_empty() {
            return;
        }
        self.push_undo();
        for i in hits {
            let id = self.project.id();
            let clips = &mut self.project.tracks[ti].clips;
            let head = (p - clips[i].start) as u64;
            let mut tail = clips[i].clone();
            tail.id = id;
            tail.start = p;
            tail.offset += head;
            tail.len -= head;
            clips[i].len = head;
            clips.push(tail);
        }
        self.sync_clips(track);
    }

    pub fn delete_selected(&mut self) {
        let Some((track, clip)) = self.ui.sel_clip.take() else { return };
        self.push_undo();
        if let Some(t) = self.project.tracks.iter_mut().find(|t| t.id == track) {
            t.clips.retain(|c| c.id != clip);
        }
        self.sync_clips(track);
    }

    pub fn duplicate_selected(&mut self) {
        let Some((track, clip)) = self.ui.sel_clip else { return };
        self.push_undo();
        let id = self.project.id();
        if let Some(t) = self.project.tracks.iter_mut().find(|t| t.id == track) {
            if let Some(mut c) = t.clips.iter().find(|c| c.id == clip).cloned() {
                c.id = id;
                c.start += c.len as i64;
                t.clips.push(c);
                self.ui.sel_clip = Some((track, id));
            }
        }
        self.sync_clips(track);
    }

    pub fn project_end(&self) -> i64 {
        self.project.tracks.iter().flat_map(|t| &t.clips).map(|c| c.start + c.len as i64).max().unwrap_or(0)
    }

    // ------------------------------------------------------------ export

    /// A private copy of the mixer for rendering without the sound card: the whole project with
    /// its master volume, or just one track at its own volume when `only` is given.
    fn offline_mixer(&self, only: Option<u64>) -> Mixer {
        let sr = self.io.sample_rate;
        let tr = Arc::new(Transport::new());
        tr.master_gain.set(if only.is_some() { 1.0 } else { db_to_gain(self.project.master_db) });
        let (_cmd_tx, cmd_rx) = RingBuffer::new(1);
        let (garbage_tx, _garbage_rx) = RingBuffer::new(1);
        let (tuner_tx, _tuner_rx) = RingBuffer::new(1);
        // Its looper stays empty: loops are a live tool and are not part of a render.
        let mut mixer = Mixer::new(sr, tr, cmd_rx, garbage_tx, tuner_tx, Looper::new(1, Arc::new(LooperShared::new())));
        for t in self.project.tracks.iter().filter(|t| only.is_none_or(|id| id == t.id)) {
            // Fresh effect instances: the live ones belong to the audio thread.
            let mut t = t.clone();
            t.monitor = false;
            t.arm = false;
            if only.is_some() {
                t.mute = false;
                t.solo = false;
            }
            let slots = t
                .fx
                .iter()
                .map(|f| {
                    let created = fx::create(&f.kind, sr as f32, &self.lv2);
                    let values = if created.infos.len() == f.params.len() { &f.params[..] } else { &[][..] };
                    Box::new(FxSlot::new(f.id, created.fx, values, f.bypass).0)
                })
                .collect();
            mixer.add_track_direct(Box::new(TrackRt::new(t.id, Self::make_shared(&t), self.clips_rt(&t), slots)));
        }
        mixer
    }

    /// Render the whole project (tracks, effects, master volume) to a stereo WAV file.
    pub fn start_export(&mut self) {
        if self.export.is_some() {
            return;
        }
        let end = self.project_end();
        if end == 0 {
            self.status = "Nothing to export yet: record something first.".into();
            return;
        }
        let sr = self.io.sample_rate;
        let mut mixer = self.offline_mixer(None);
        let dir = self.dir.join("exports");
        let stamp = chrono::Local::now().format("%Y%m%d-%H%M%S");
        let path = dir.join(format!("{}-{stamp}.wav", sanitize(&self.project.name)));
        let progress = Arc::new(AtomicF32::new(0.0));
        let shown = progress.clone();
        let handle = std::thread::spawn(move || -> Result<PathBuf> {
            std::fs::create_dir_all(&dir)?;
            let mut wav = hound::WavWriter::create(&path, wav_spec(2, sr))?;
            const BLOCK: usize = 1024;
            let total = end + 3 * sr as i64; // leave room for reverb and delay tails
            let silence = [0.0f32; BLOCK];
            let (mut l, mut r) = ([0.0f32; BLOCK], [0.0f32; BLOCK]);
            mixer.play_from(0);
            let mut done = 0;
            while done < total {
                mixer.process([&silence; NUM_INPUTS], [&silence, &silence], &mut l, &mut r);
                for i in 0..BLOCK {
                    wav.write_sample(l[i])?;
                    wav.write_sample(r[i])?;
                }
                done += BLOCK as i64;
                progress.set(done as f32 / total as f32);
            }
            wav.finalize()?;
            Ok(path)
        });
        self.export = Some(Export { progress: shown, handle: Some(handle) });
    }

    fn poll_export(&mut self) {
        let Some(ex) = &mut self.export else { return };
        if !ex.handle.as_ref().is_some_and(|h| h.is_finished()) {
            return;
        }
        let result = ex.handle.take().unwrap().join().unwrap_or_else(|_| Err(anyhow!("export thread crashed")));
        self.status = match result {
            Ok(path) => format!("Exported to {}", path.display()),
            Err(e) => format!("Export failed: {e:#}"),
        };
        self.export = None;
    }

    // ------------------------------------------------------------ loop station

    /// Tell the audio thread which loops listen to which tracks (and forget deleted tracks).
    fn sync_loop_sources(&mut self) {
        let tracks = &self.project.tracks;
        for sources in &mut self.project.loop_sources {
            sources.retain(|id| tracks.iter().any(|t| t.id == *id));
        }
        for t in tracks {
            let mask = (0..looper::SLOTS).filter(|s| self.project.loop_sources[*s].contains(&t.id)).fold(0, |m, s| m | 1 << s);
            if let Some(shared) = self.shared.get(&t.id) {
                shared.loop_mask.store(mask, Relaxed);
            }
        }
    }

    pub fn loop_action(&mut self, slot: usize, action: LoopAction) {
        // A loop with no track chosen would record silence: give it the selected track.
        if matches!(action, LoopAction::Press) && self.project.loop_sources[slot].is_empty() {
            if let Some(id) = self.ui.sel_track.or(self.project.tracks.first().map(|t| t.id)) {
                self.project.loop_sources[slot].push(id);
                self.sync_loop_sources();
            }
        }
        self.send(Cmd::Loop(slot, action));
    }

    /// Copy the timeline's loop region of one track (with its effects) into a loop slot.
    pub fn import_loop_region(&mut self, slot: usize, track: u64) {
        let (start, end) = (self.project.loop_start, self.project.loop_end);
        let Some(track) = self.project.tracks.iter().find(|t| t.id == track) else { return };
        if end <= start {
            self.status = "Set a loop region on the ruler first.".into();
            return;
        }
        let (id, name) = (track.id, track.name.clone());
        let sr = self.io.sample_rate as usize;
        let cap = sr * looper::MAX_SECONDS;
        let region = (end - start) as usize;
        // An existing loop dictates the length; otherwise the region does.
        let current = self.looper.len.load(Relaxed) as usize;
        let len = if current > 0 { current } else { region.min(cap) };
        let render = region.min(len);

        let mut mixer = self.offline_mixer(Some(id));
        mixer.play_from(start);
        let mut bufs: LoopBuf = Box::new([vec![0.0; cap], vec![0.0; cap]]);
        let [left, right] = &mut *bufs;
        let silence = [0.0f32; 1024];
        let mut done = 0;
        while done < render {
            let n = (render - done).min(silence.len());
            let quiet = &silence[..n];
            mixer.process([quiet; NUM_INPUTS], [quiet, quiet], &mut left[done..done + n], &mut right[done..done + n]);
            done += n;
        }
        // Short fades so the loop point does not click.
        let fade = (sr / 200).min(render / 2);
        for ch in [left, right] {
            for i in 0..fade {
                let g = i as f32 / fade as f32;
                ch[i] *= g;
                ch[render - 1 - i] *= g;
            }
        }
        self.send(Cmd::LoopLoad { slot, bufs, len });
        let secs = |frames: usize| frames as f64 / sr as f64;
        self.status = if region == len {
            format!("Loop {}: loaded {:.1} s of “{name}”.", slot + 1, secs(len))
        } else if region > len {
            format!("Loop {}: loaded the first {:.1} s of “{name}” (the region is longer than the loop).", slot + 1, secs(len))
        } else {
            format!("Loop {}: loaded {:.1} s of “{name}”; the rest of the {:.1} s loop is silent.", slot + 1, secs(region), secs(len))
        };
    }

    // ------------------------------------------------------------ desktop audio

    pub fn set_desktop(&mut self, on: bool) {
        if on {
            match desktop::enable() {
                Ok(previous) => {
                    if previous.is_some() {
                        self.cfg.prev_default_sink = previous;
                        self.cfg.save();
                    }
                    self.desktop_on = true;
                    if !self.project.tracks.iter().any(|t| t.input == InputSel::Desktop) {
                        self.add_track(Preset::Desktop);
                    }
                    self.status = "Desktop audio now plays through the DAW (Play-along track).".into();
                }
                Err(e) => self.status = e,
            }
        } else {
            desktop::disable(self.cfg.prev_default_sink.as_deref());
            self.cfg.prev_default_sink = None;
            self.cfg.save();
            self.desktop_on = false;
            self.status = "Desktop audio is back on the normal system output.".into();
        }
        self.last_check = Instant::now() - Duration::from_secs(5);
    }

    // ------------------------------------------------------------ per-frame upkeep

    pub fn tick(&mut self) {
        while self.garbage.pop().is_ok() {}
        self.poll_recordings();
        self.poll_export();

        let p = &self.project;
        self.tr.bpm.set(p.bpm);
        self.tr.beats_per_bar.store(p.beats_per_bar, Relaxed);
        self.tr.metro_on.store(p.metronome, Relaxed);
        self.tr.master_gain.set(db_to_gain(p.master_db));
        self.tr.loop_on.store(p.loop_on, Relaxed);
        self.tr.loop_start.store(p.loop_start, Relaxed);
        self.tr.loop_end.store(p.loop_end, Relaxed);
        for t in &p.tracks {
            if let Some(s) = self.shared.get(&t.id) {
                Self::sync_track(t, s);
            }
            for f in &t.fx {
                if let Some(h) = self.fx.get(&f.id) {
                    h.shared.bypass.store(f.bypass, Relaxed);
                    for (a, v) in h.shared.params.iter().zip(&f.params) {
                        a.set(*v);
                    }
                }
            }
        }

        self.sync_loop_sources();
        let p = &self.project;
        self.looper.bpm.set(p.bpm);
        self.looper.beats_per_bar.store(p.beats_per_bar, Relaxed);
        self.tr.tuner_on.store(self.ui.show_tuner, Relaxed);
        if self.ui.show_tuner {
            self.tuner.update(self.io.sample_rate as f32);
        } else {
            self.tuner.drain();
        }

        // Hardware can appear late (interface switched on, play-along device created): keep wiring it up.
        if self.last_check.elapsed() > Duration::from_secs(1) {
            self.last_check = Instant::now();
            self.io.apply_connections(&self.cfg);
            self.inputs_available = self.io.input_count(&self.cfg);
        }
    }
}

impl Drop for App {
    fn drop(&mut self) {
        if self.desktop_on {
            desktop::disable(self.cfg.prev_default_sink.as_deref());
            self.cfg.prev_default_sink = None;
        }
        self.save();
        self.cfg.save();
    }
}
