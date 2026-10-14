//! Loop station: a few stereo loop slots that are recorded, overdubbed and muted on the fly.
//! The first loop recorded sets the length; every later loop stays in sync with it.
//! Runs on the audio thread, independent of the timeline transport.

use crate::util::AtomicF32;
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering::Relaxed};
use std::sync::Arc;

pub const SLOTS: usize = 4;
pub const MAX_SECONDS: usize = 60;

pub const EMPTY: u32 = 0;
pub const RECORDING: u32 = 1;
pub const PLAYING: u32 = 2;
pub const OVERDUB: u32 = 3;
pub const STOPPED: u32 = 4;
/// Clicking one bar before the first loop starts recording.
pub const COUNTING: u32 = 5;

/// Audio for one loop slot: left and right, each `MAX_SECONDS` long.
pub type LoopBuf = Box<[Vec<f32>; 2]>;

#[derive(Clone, Copy)]
pub enum LoopAction {
    /// The main button: empty → (count-in →) record → play → overdub → play …
    Press,
    /// Mute or unmute a loop without erasing it.
    ToggleStop,
    Clear,
}

pub struct LooperShared {
    pub state: [AtomicU32; SLOTS],
    pub gain: [AtomicF32; SLOTS],
    /// Loop length and current position in frames (length 0 = nothing recorded yet).
    pub len: AtomicU64,
    pub pos: AtomicU64,
    /// One bar of clicks before the first loop records.
    pub count_in: AtomicBool,
    /// The looper's own metronome. With it (or the count-in) on, the first loop is rounded to whole bars.
    pub click: AtomicBool,
    pub bpm: AtomicF32,
    pub beats_per_bar: AtomicU32,
}

impl LooperShared {
    pub fn new() -> Self {
        Self {
            state: std::array::from_fn(|_| AtomicU32::new(EMPTY)),
            gain: std::array::from_fn(|_| AtomicF32::new(1.0)),
            len: AtomicU64::new(0),
            pos: AtomicU64::new(0),
            count_in: AtomicBool::new(true),
            click: AtomicBool::new(false),
            bpm: AtomicF32::new(120.0),
            beats_per_bar: AtomicU32::new(4),
        }
    }
}

pub struct Looper {
    pub shared: Arc<LooperShared>,
    bufs: Vec<LoopBuf>,
    state: [u32; SLOTS],
    /// Frames left before a synced recording has gone once around the loop.
    rec_left: [usize; SLOTS],
    len: usize,
    /// Position in the loop, or frames recorded so far while the first loop is being recorded.
    pos: usize,
    cap: usize,
    fade: usize,
    sr: f64,
    count_total: usize,
    count_left: usize,
    /// Length at which the first loop will close by itself (0 = wait for the button).
    first_target: usize,
    click_env: f32,
    click_phase: f32,
    click_inc: f32,
}

impl Looper {
    pub fn new(sr: u32, shared: Arc<LooperShared>) -> Self {
        let cap = sr as usize * MAX_SECONDS;
        Self {
            shared,
            bufs: (0..SLOTS).map(|_| Box::new([vec![0.0; cap], vec![0.0; cap]])).collect(),
            state: [EMPTY; SLOTS],
            rec_left: [0; SLOTS],
            len: 0,
            pos: 0,
            cap,
            fade: (sr as usize / 200).max(1),
            sr: sr as f64,
            count_total: 0,
            count_left: 0,
            first_target: 0,
            click_env: 0.0,
            click_phase: 0.0,
            click_inc: 0.0,
        }
    }

    fn beat_frames(&self) -> f64 {
        self.sr * 60.0 / self.shared.bpm.get().clamp(20.0, 400.0) as f64
    }

    fn beats_per_bar(&self) -> usize {
        self.shared.beats_per_bar.load(Relaxed).max(1) as usize
    }

    fn tempo_synced(&self) -> bool {
        self.shared.count_in.load(Relaxed) || self.shared.click.load(Relaxed)
    }

    /// Close the first loop at `len` frames and start playing it.
    fn finish_first(&mut self, slot: usize, len: usize) {
        let len = len.clamp(self.fade * 2, self.cap);
        let recorded = self.pos.min(self.cap);
        for ch in self.bufs[slot].iter_mut() {
            // Anything played past the end is dropped; unused space must stay silent.
            if recorded > len {
                ch[len..recorded].fill(0.0);
            }
            // Short fades at both ends so the loop point does not click.
            for i in 0..self.fade {
                let g = i as f32 / self.fade as f32;
                ch[i] *= g;
                ch[len - 1 - i] *= g;
            }
        }
        self.pos = recorded.saturating_sub(len) % len;
        self.len = len;
        self.first_target = 0;
        self.state[slot] = PLAYING;
    }

    /// The player asked to end the first loop. In time with the click it closes on a whole bar.
    fn request_finish(&mut self, slot: usize) {
        if !self.tempo_synced() {
            return self.finish_first(slot, self.pos);
        }
        let bar = self.beat_frames() * self.beats_per_bar() as f64;
        let max_bars = (self.cap as f64 / bar).floor();
        if max_bars < 1.0 {
            return self.finish_first(slot, self.pos);
        }
        let bars = (self.pos as f64 / bar).round().clamp(1.0, max_bars);
        let target = (bars * bar).round() as usize;
        if target <= self.pos {
            self.finish_first(slot, target);
        } else {
            self.first_target = target;
        }
    }

    fn clear(&mut self, slot: usize) {
        let used = if self.len > 0 { self.len } else { self.pos };
        for ch in self.bufs[slot].iter_mut() {
            ch[..used.min(self.cap)].fill(0.0);
        }
        self.state[slot] = EMPTY;
        if self.state.iter().all(|s| *s == EMPTY) {
            self.len = 0;
            self.pos = 0;
            self.first_target = 0;
        }
    }

    pub fn action(&mut self, slot: usize, action: LoopAction) {
        if slot >= SLOTS {
            return;
        }
        match action {
            LoopAction::Press => match self.state[slot] {
                EMPTY if self.len == 0 => {
                    // Only one slot can be recording the first loop.
                    if self.state.iter().any(|s| matches!(*s, RECORDING | COUNTING)) {
                        return;
                    }
                    self.pos = 0;
                    if self.shared.count_in.load(Relaxed) {
                        self.count_total = (self.beat_frames() * self.beats_per_bar() as f64).round() as usize;
                        self.count_left = self.count_total;
                        self.state[slot] = COUNTING;
                    } else {
                        self.state[slot] = RECORDING;
                    }
                }
                EMPTY => {
                    self.rec_left[slot] = self.len;
                    self.state[slot] = RECORDING;
                }
                COUNTING => self.state[slot] = EMPTY,
                RECORDING if self.len == 0 => self.request_finish(slot),
                RECORDING | OVERDUB => self.state[slot] = PLAYING,
                PLAYING => self.state[slot] = OVERDUB,
                _ => self.state[slot] = PLAYING,
            },
            LoopAction::ToggleStop => match self.state[slot] {
                PLAYING | OVERDUB => self.state[slot] = STOPPED,
                STOPPED => self.state[slot] = PLAYING,
                COUNTING => self.state[slot] = EMPTY,
                RECORDING if self.len == 0 => self.request_finish(slot),
                RECORDING => self.state[slot] = PLAYING,
                _ => {}
            },
            LoopAction::Clear => self.clear(slot),
        }
    }

    /// Put ready-made audio into a slot. `bufs` is swapped with the slot's old buffer.
    /// If nothing is looping yet, `len` becomes the loop length.
    pub fn load(&mut self, slot: usize, bufs: &mut LoopBuf, len: usize) {
        if slot >= SLOTS {
            return;
        }
        if self.len == 0 {
            // Abandon a first loop that was still being counted in or recorded.
            for s in 0..SLOTS {
                if self.state[s] != EMPTY {
                    self.clear(s);
                }
            }
            self.len = len.clamp(self.fade * 2, self.cap);
            self.pos = 0;
            self.first_target = 0;
        }
        std::mem::swap(&mut self.bufs[slot], bufs);
        self.state[slot] = PLAYING;
    }

    /// Where the click falls right now: (frame index, frames per beat), if the click should run.
    fn click_grid(&self, counting: bool) -> Option<(usize, f64)> {
        if counting {
            Some((self.count_total - self.count_left, self.beat_frames()))
        } else if !self.shared.click.load(Relaxed) {
            None
        } else if self.len > 0 {
            // Divide the loop evenly so the click can never drift against it.
            let beats = (self.len as f64 / self.beat_frames()).round().max(1.0);
            Some((self.pos, self.len as f64 / beats))
        } else if self.state.contains(&RECORDING) {
            Some((self.pos, self.beat_frames()))
        } else {
            None
        }
    }

    /// Record each slot from its own input (`ins[slot]` = left, right) and add the playing loops
    /// and the looper's click to `out_*`.
    pub fn process(&mut self, ins: &[[Vec<f32>; 2]], out_l: &mut [f32], out_r: &mut [f32]) {
        if self.state.iter().all(|s| *s == EMPTY) && self.click_env < 0.0005 {
            return;
        }
        let gains: [f32; SLOTS] = std::array::from_fn(|s| self.shared.gain[s].get());
        let bpb = self.beats_per_bar();
        let decay = (-1.0 / (0.012 * self.sr as f32)).exp();
        for i in 0..out_l.len() {
            let counting = self.state.iter().position(|s| *s == COUNTING);
            if let Some((idx, beat)) = self.click_grid(counting.is_some()) {
                let k = (idx as f64 / beat).round();
                if (k * beat).round() as usize == idx {
                    let accent = k as usize % bpb == 0;
                    self.click_env = if accent { 0.6 } else { 0.4 };
                    self.click_inc = std::f32::consts::TAU * if accent { 1760.0 } else { 1175.0 } / self.sr as f32;
                    self.click_phase = 0.0;
                }
            }
            if self.click_env > 0.0005 {
                let c = self.click_phase.sin() * self.click_env;
                self.click_phase += self.click_inc;
                self.click_env *= decay;
                out_l[i] += c;
                out_r[i] += c;
            }
            if let Some(slot) = counting {
                self.count_left -= 1;
                if self.count_left == 0 {
                    self.pos = 0;
                    self.state[slot] = RECORDING;
                }
                continue;
            }

            let p = self.pos;
            for s in 0..SLOTS {
                let [bl, br] = &mut *self.bufs[s];
                let (in_l, in_r) = (&ins[s][0], &ins[s][1]);
                match self.state[s] {
                    RECORDING => {
                        bl[p] = in_l[i];
                        br[p] = in_r[i];
                        if self.len > 0 {
                            self.rec_left[s] -= 1;
                            if self.rec_left[s] == 0 {
                                self.state[s] = PLAYING;
                            }
                        }
                    }
                    PLAYING => {
                        out_l[i] += bl[p] * gains[s];
                        out_r[i] += br[p] * gains[s];
                    }
                    OVERDUB => {
                        out_l[i] += bl[p] * gains[s];
                        out_r[i] += br[p] * gains[s];
                        bl[p] += in_l[i];
                        br[p] += in_r[i];
                    }
                    _ => {}
                }
            }
            if self.len > 0 {
                self.pos = (self.pos + 1) % self.len;
            } else if let Some(slot) = self.state.iter().position(|s| *s == RECORDING) {
                self.pos += 1;
                if self.first_target > 0 && self.pos >= self.first_target {
                    self.finish_first(slot, self.first_target);
                } else if self.pos >= self.cap {
                    // Out of room: close the first loop at the maximum length.
                    self.finish_first(slot, self.cap);
                }
            }
        }
    }

    pub fn publish(&self) {
        for s in 0..SLOTS {
            self.shared.state[s].store(self.state[s], Relaxed);
        }
        self.shared.len.store(self.len as u64, Relaxed);
        let pos = if self.state.contains(&COUNTING) { self.count_total - self.count_left } else { self.pos };
        self.shared.pos.store(pos as u64, Relaxed);
    }
}
