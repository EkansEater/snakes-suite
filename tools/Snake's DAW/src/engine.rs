//! The realtime mixer. It runs inside the JACK process callback (or offline for export),
//! so nothing here may block: the UI talks to it through lock-free queues and atomics.

use crate::audio::AudioData;
use crate::fx::FxSlot;
use crate::looper::{LoopAction, LoopBuf, Looper, SLOTS};
use crate::util::{peak, AtomicF32};
use rtrb::{Consumer, Producer};
use std::sync::atomic::{AtomicBool, AtomicI64, AtomicU32, Ordering::Relaxed};
use std::sync::Arc;

/// Most hardware inputs the DAW can use at once.
pub const NUM_INPUTS: usize = 8;
pub const MAX_BLOCK: usize = 8192;
pub const MAX_TRACKS: usize = 64;
pub const MAX_FX: usize = 32;

/// Track input source ids as stored in `TrackShared::input` (0..NUM_INPUTS are hardware inputs).
pub const SRC_DESKTOP: u32 = 100;
pub const SRC_NONE: u32 = 255;

/// Treat denormal floats as zero so decaying filter tails cannot spike the CPU.
/// Called at the start of every audio callback.
#[inline]
pub fn no_denormals() {
    #[cfg(target_arch = "x86_64")]
    #[allow(deprecated)]
    unsafe {
        use std::arch::x86_64::{_mm_getcsr, _mm_setcsr};
        _mm_setcsr(_mm_getcsr() | 0x8040);
    }
}

/// Per-track controls written by the UI, and meters written by the mixer.
pub struct TrackShared {
    pub gain: AtomicF32,
    pub pan: AtomicF32,
    pub mute: AtomicBool,
    pub solo: AtomicBool,
    pub arm: AtomicBool,
    pub monitor: AtomicBool,
    pub fx_on: AtomicBool,
    pub input: AtomicU32,
    /// Loop station slots that record this track: bit N set = slot N listens to it.
    pub loop_mask: AtomicU32,
    pub peak_l: AtomicF32,
    pub peak_r: AtomicF32,
}

impl TrackShared {
    pub fn new() -> Self {
        Self {
            gain: AtomicF32::new(1.0),
            pan: AtomicF32::new(0.0),
            mute: AtomicBool::new(false),
            solo: AtomicBool::new(false),
            arm: AtomicBool::new(false),
            monitor: AtomicBool::new(false),
            fx_on: AtomicBool::new(true),
            input: AtomicU32::new(SRC_NONE),
            loop_mask: AtomicU32::new(0),
            peak_l: AtomicF32::new(0.0),
            peak_r: AtomicF32::new(0.0),
        }
    }
}

/// Global controls and state shared between the UI and the mixer.
pub struct Transport {
    pub playing: AtomicBool,
    pub recording: AtomicBool,
    pub pos: AtomicI64,
    pub loop_on: AtomicBool,
    pub loop_start: AtomicI64,
    pub loop_end: AtomicI64,
    pub metro_on: AtomicBool,
    pub bpm: AtomicF32,
    pub beats_per_bar: AtomicU32,
    pub master_gain: AtomicF32,
    pub master_peak_l: AtomicF32,
    pub master_peak_r: AtomicF32,
    pub input_peaks: [AtomicF32; NUM_INPUTS],
    pub desktop_peak: AtomicF32,
    pub xruns: AtomicU32,
    pub tuner_on: AtomicBool,
    pub tuner_input: AtomicU32,
}

impl Transport {
    pub fn new() -> Self {
        Self {
            playing: AtomicBool::new(false),
            recording: AtomicBool::new(false),
            pos: AtomicI64::new(0),
            loop_on: AtomicBool::new(false),
            loop_start: AtomicI64::new(0),
            loop_end: AtomicI64::new(0),
            metro_on: AtomicBool::new(false),
            bpm: AtomicF32::new(120.0),
            beats_per_bar: AtomicU32::new(4),
            master_gain: AtomicF32::new(1.0),
            master_peak_l: AtomicF32::new(0.0),
            master_peak_r: AtomicF32::new(0.0),
            input_peaks: std::array::from_fn(|_| AtomicF32::new(0.0)),
            desktop_peak: AtomicF32::new(0.0),
            xruns: AtomicU32::new(0),
            tuner_on: AtomicBool::new(false),
            tuner_input: AtomicU32::new(0),
        }
    }
}

pub struct ClipRt {
    /// Timeline position of the clip's first audible frame.
    pub start: i64,
    /// First frame of `data` that the clip plays.
    pub offset: usize,
    pub len: usize,
    pub data: Arc<AudioData>,
}

/// Where a recording track sends its dry input; a writer thread drains the other end.
pub struct RecSink {
    pub track: u64,
    pub tx: Producer<f32>,
    /// Stereo sinks receive interleaved L/R frames.
    pub stereo: bool,
}

pub struct TrackRt {
    pub id: u64,
    pub shared: Arc<TrackShared>,
    pub clips: Vec<ClipRt>,
    pub fx: Vec<Box<FxSlot>>,
    rec: Option<RecSink>,
    buf_l: Vec<f32>,
    buf_r: Vec<f32>,
}

impl TrackRt {
    pub fn new(id: u64, shared: Arc<TrackShared>, clips: Vec<ClipRt>, mut fx: Vec<Box<FxSlot>>) -> Self {
        fx.reserve(MAX_FX);
        Self { id, shared, clips, fx, rec: None, buf_l: vec![0.0; MAX_BLOCK], buf_r: vec![0.0; MAX_BLOCK] }
    }
}

pub enum Cmd {
    AddTrack(Box<TrackRt>),
    RemoveTrack(u64),
    SetClips(u64, Vec<ClipRt>),
    AddFx { track: u64, index: usize, slot: Box<FxSlot> },
    RemoveFx { track: u64, fx: u64 },
    MoveFx { track: u64, fx: u64, index: usize },
    Play,
    Stop,
    Seek(i64),
    /// Start playing at `from` and record armed tracks from `at` onwards (`from < at` is a count-in).
    Record { from: i64, at: i64, sinks: Vec<RecSink> },
    Loop(usize, LoopAction),
    /// Fill a loop slot with prepared audio of `len` frames.
    LoopLoad { slot: usize, bufs: LoopBuf, len: usize },
}

/// Things the mixer no longer needs. They are sent back so the UI thread frees them.
#[allow(dead_code)]
pub enum Garbage {
    Track(Box<TrackRt>),
    Clips(Vec<ClipRt>),
    Fx(Box<FxSlot>),
    Sink(RecSink),
    Sinks(Vec<RecSink>),
    LoopBuf(LoopBuf),
}

pub struct Mixer {
    sr: f64,
    transport: Arc<Transport>,
    cmd: Consumer<Cmd>,
    garbage: Producer<Garbage>,
    tuner: Producer<f32>,
    tracks: Vec<Box<TrackRt>>,
    looper: Looper,
    /// What each loop slot hears this block: the sum of the tracks assigned to it.
    loop_in: Vec<[Vec<f32>; 2]>,
    pos: i64,
    playing: bool,
    recording: bool,
    rec_at: i64,
    click_env: f32,
    click_phase: f32,
    click_inc: f32,
}

impl Mixer {
    pub fn new(sr: u32, transport: Arc<Transport>, cmd: Consumer<Cmd>, garbage: Producer<Garbage>, tuner: Producer<f32>, looper: Looper) -> Self {
        Self {
            sr: sr as f64,
            transport,
            cmd,
            garbage,
            tuner,
            tracks: Vec::with_capacity(MAX_TRACKS),
            looper,
            loop_in: (0..SLOTS).map(|_| [vec![0.0; MAX_BLOCK], vec![0.0; MAX_BLOCK]]).collect(),
            pos: 0,
            playing: false,
            recording: false,
            rec_at: 0,
            click_env: 0.0,
            click_phase: 0.0,
            click_inc: 0.0,
        }
    }

    /// Add a track without going through the command queue (offline rendering).
    pub fn add_track_direct(&mut self, track: Box<TrackRt>) {
        self.tracks.push(track);
    }

    pub fn play_from(&mut self, pos: i64) {
        self.pos = pos;
        self.playing = true;
    }

    fn trash(&mut self, g: Garbage) {
        // If the queue is full the value is dropped here instead; rare and harmless.
        let _ = self.garbage.push(g);
    }

    fn stop_recording(&mut self) {
        self.recording = false;
        for i in 0..self.tracks.len() {
            if let Some(sink) = self.tracks[i].rec.take() {
                self.trash(Garbage::Sink(sink));
            }
        }
    }

    fn handle_commands(&mut self) {
        while let Ok(cmd) = self.cmd.pop() {
            match cmd {
                Cmd::AddTrack(t) => {
                    if self.tracks.len() < MAX_TRACKS {
                        self.tracks.push(t);
                    } else {
                        self.trash(Garbage::Track(t));
                    }
                }
                Cmd::RemoveTrack(id) => {
                    if let Some(i) = self.tracks.iter().position(|t| t.id == id) {
                        let t = self.tracks.remove(i);
                        self.trash(Garbage::Track(t));
                    }
                }
                Cmd::SetClips(id, clips) => {
                    let old = match self.tracks.iter_mut().find(|t| t.id == id) {
                        Some(t) => std::mem::replace(&mut t.clips, clips),
                        None => clips,
                    };
                    self.trash(Garbage::Clips(old));
                }
                Cmd::AddFx { track, index, slot } => match self.tracks.iter_mut().find(|t| t.id == track) {
                    Some(t) if t.fx.len() < MAX_FX => {
                        let index = index.min(t.fx.len());
                        t.fx.insert(index, slot);
                    }
                    _ => self.trash(Garbage::Fx(slot)),
                },
                Cmd::RemoveFx { track, fx } => {
                    let removed = self.tracks.iter_mut().find(|t| t.id == track).and_then(|t| {
                        let i = t.fx.iter().position(|f| f.id == fx)?;
                        Some(t.fx.remove(i))
                    });
                    if let Some(slot) = removed {
                        self.trash(Garbage::Fx(slot));
                    }
                }
                Cmd::MoveFx { track, fx, index } => {
                    if let Some(t) = self.tracks.iter_mut().find(|t| t.id == track) {
                        if let Some(i) = t.fx.iter().position(|f| f.id == fx) {
                            let slot = t.fx.remove(i);
                            let index = index.min(t.fx.len());
                            t.fx.insert(index, slot);
                        }
                    }
                }
                Cmd::Play => self.playing = true,
                Cmd::Stop => {
                    self.playing = false;
                    self.stop_recording();
                }
                Cmd::Seek(p) => self.pos = p,
                Cmd::Record { from, at, mut sinks } => {
                    self.stop_recording();
                    for sink in sinks.drain(..) {
                        match self.tracks.iter_mut().find(|t| t.id == sink.track) {
                            Some(t) => t.rec = Some(sink),
                            None => self.trash(Garbage::Sink(sink)),
                        }
                    }
                    self.trash(Garbage::Sinks(sinks));
                    self.pos = from;
                    self.rec_at = at;
                    self.playing = true;
                    self.recording = true;
                }
                Cmd::Loop(slot, action) => self.looper.action(slot, action),
                Cmd::LoopLoad { slot, mut bufs, len } => {
                    self.looper.load(slot, &mut bufs, len);
                    self.trash(Garbage::LoopBuf(bufs));
                }
            }
        }
    }

    /// Render one block. `ins` are the hardware inputs, `desk` is stereo desktop audio.
    pub fn process(&mut self, ins: [&[f32]; NUM_INPUTS], desk: [&[f32]; 2], out_l: &mut [f32], out_r: &mut [f32]) {
        self.handle_commands();
        let n = out_l.len();
        let tr = self.transport.clone();

        for (i, input) in ins.iter().enumerate() {
            tr.input_peaks[i].raise(peak(input));
        }
        tr.desktop_peak.raise(peak(desk[0]).max(peak(desk[1])));
        if tr.tuner_on.load(Relaxed) {
            let src = (tr.tuner_input.load(Relaxed) as usize).min(NUM_INPUTS - 1);
            for &s in ins[src] {
                let _ = self.tuner.push(s);
            }
        }

        let mut done = 0;
        while done < n {
            let mut seg = (n - done).min(MAX_BLOCK);
            if self.playing && !self.recording && tr.loop_on.load(Relaxed) {
                let (ls, le) = (tr.loop_start.load(Relaxed), tr.loop_end.load(Relaxed));
                if le > ls {
                    if self.pos >= le {
                        self.pos = ls;
                    }
                    seg = seg.min((le - self.pos) as usize);
                }
            }
            let end = done + seg;
            let ins_seg: [&[f32]; NUM_INPUTS] = std::array::from_fn(|i| &ins[i][done..end]);
            let desk_seg = [&desk[0][done..end], &desk[1][done..end]];
            self.render(ins_seg, desk_seg, &mut out_l[done..end], &mut out_r[done..end]);
            if self.playing {
                self.pos += seg as i64;
            }
            done = end;
        }

        self.looper.publish();
        tr.master_peak_l.raise(peak(out_l));
        tr.master_peak_r.raise(peak(out_r));
        tr.pos.store(self.pos, Relaxed);
        tr.playing.store(self.playing, Relaxed);
        tr.recording.store(self.recording, Relaxed);
    }

    fn render(&mut self, ins: [&[f32]; NUM_INPUTS], desk: [&[f32]; 2], out_l: &mut [f32], out_r: &mut [f32]) {
        let n = out_l.len();
        let pos = self.pos;
        out_l.fill(0.0);
        out_r.fill(0.0);
        let any_solo = self.tracks.iter().any(|t| t.shared.solo.load(Relaxed));
        let (playing, recording, rec_at) = (self.playing, self.recording, self.rec_at);
        let loop_in = &mut self.loop_in;
        for [l, r] in loop_in.iter_mut() {
            l[..n].fill(0.0);
            r[..n].fill(0.0);
        }

        for t in self.tracks.iter_mut() {
            let sh = &t.shared;
            let (bl, br) = (&mut t.buf_l[..n], &mut t.buf_r[..n]);
            bl.fill(0.0);
            br.fill(0.0);

            if playing {
                for c in &t.clips {
                    let a = pos.max(c.start);
                    let b = (pos + n as i64).min(c.start + c.len as i64);
                    if a >= b {
                        continue;
                    }
                    let src = c.offset + (a - c.start) as usize;
                    let dst = (a - pos) as usize;
                    let count = ((b - a) as usize).min(c.data.frames().saturating_sub(src));
                    let left = &c.data.ch[0][src..src + count];
                    let right = &c.data.ch[c.data.ch.len() - 1][src..src + count];
                    for i in 0..count {
                        bl[dst + i] += left[i];
                        br[dst + i] += right[i];
                    }
                }
            }

            let src = sh.input.load(Relaxed);
            let live: Option<(&[f32], &[f32])> = match src {
                SRC_DESKTOP => Some((desk[0], desk[1])),
                i if (i as usize) < NUM_INPUTS => Some((ins[i as usize], ins[i as usize])),
                _ => None,
            };
            if let Some((il, ir)) = live {
                if recording && playing {
                    if let Some(sink) = t.rec.as_mut() {
                        // Skip the count-in: only frames at or after `rec_at` are recorded.
                        let skip = (rec_at - pos).clamp(0, n as i64) as usize;
                        for i in skip..n {
                            let _ = sink.tx.push(il[i]);
                            if sink.stereo {
                                let _ = sink.tx.push(ir[i]);
                            }
                        }
                    }
                }
                if sh.monitor.load(Relaxed) {
                    for i in 0..n {
                        bl[i] += il[i];
                        br[i] += ir[i];
                    }
                }
            }

            if sh.fx_on.load(Relaxed) {
                for fx in t.fx.iter_mut() {
                    fx.process(bl, br);
                }
            }

            let audible = !sh.mute.load(Relaxed) && (!any_solo || sh.solo.load(Relaxed));
            let gain = if audible { sh.gain.get() } else { 0.0 };
            let pan = sh.pan.get().clamp(-1.0, 1.0);
            let (gl, gr) = (gain * (1.0 - pan).min(1.0), gain * (1.0 + pan).min(1.0));
            let (mut pl, mut pr) = (0.0f32, 0.0f32);
            for i in 0..n {
                let (l, r) = (bl[i] * gl, br[i] * gr);
                pl = pl.max(l.abs());
                pr = pr.max(r.abs());
                out_l[i] += l;
                out_r[i] += r;
            }
            let mask = sh.loop_mask.load(Relaxed);
            for (slot, [l, r]) in loop_in.iter_mut().enumerate() {
                if mask & (1 << slot) != 0 {
                    // The loop hears this track exactly as it sounds in the mix.
                    for i in 0..n {
                        l[i] += bl[i] * gl;
                        r[i] += br[i] * gr;
                    }
                }
            }
            sh.peak_l.raise(pl);
            sh.peak_r.raise(pr);
        }

        self.looper.process(&self.loop_in, out_l, out_r);
        let master = self.transport.master_gain.get();
        self.click(out_l, out_r, master);
    }

    /// Apply the master gain, add the metronome and keep the output within full scale.
    fn click(&mut self, out_l: &mut [f32], out_r: &mut [f32], master: f32) {
        let tr = &self.transport;
        let n = out_l.len();
        let counting_in = self.recording && self.pos < self.rec_at;
        let active = self.playing && (tr.metro_on.load(Relaxed) || counting_in);
        let spb = self.sr * 60.0 / (tr.bpm.get().clamp(20.0, 400.0) as f64);
        let bpb = tr.beats_per_bar.load(Relaxed).max(1) as i64;
        let mut beat = (self.pos as f64 / spb).ceil() as i64;
        let mut next = (beat as f64 * spb).round() as i64;
        if next < self.pos {
            beat += 1;
            next = (beat as f64 * spb).round() as i64;
        }
        let decay = (-1.0 / (0.012 * self.sr as f32)).exp();
        for i in 0..n {
            if active && self.pos + i as i64 == next {
                let accent = beat.rem_euclid(bpb) == 0;
                self.click_env = if accent { 0.6 } else { 0.4 };
                self.click_inc = std::f32::consts::TAU * if accent { 1760.0 } else { 1175.0 } / self.sr as f32;
                self.click_phase = 0.0;
                beat += 1;
                next = (beat as f64 * spb).round() as i64;
            }
            let mut c = 0.0;
            if self.click_env > 0.0005 {
                c = self.click_phase.sin() * self.click_env;
                self.click_phase += self.click_inc;
                self.click_env *= decay;
            }
            out_l[i] = (out_l[i] * master + c).clamp(-1.0, 1.0);
            out_r[i] = (out_r[i] * master + c).clamp(-1.0, 1.0);
        }
    }
}
