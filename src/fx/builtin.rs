//! Built-in effects. Each is stereo and keeps independent state per channel.

use super::{Created, Fx, ParamInfo};
use crate::util::db_to_gain;
use std::f32::consts::PI;

/// (kind, display name) of every built-in effect, in menu order.
pub const LIST: &[(&str, &str)] = &[
    ("gate", "Noise Gate"),
    ("comp", "Compressor"),
    ("drive", "Overdrive"),
    ("dist", "Distortion"),
    ("amp", "Amp"),
    ("cab", "Cabinet"),
    ("eq", "EQ"),
    ("pitch", "Pitch Shifter / Drop Tune"),
    ("tremolo", "Tremolo"),
    ("delay", "Delay"),
    ("reverb", "Reverb"),
];

fn p(name: &str, min: f32, max: f32, default: f32, unit: &'static str) -> ParamInfo {
    ParamInfo { name: name.into(), min, max, default, unit, log: false, step: 0.0 }
}

fn plog(name: &str, min: f32, max: f32, default: f32, unit: &'static str) -> ParamInfo {
    ParamInfo { name: name.into(), min, max, default, unit, log: true, step: 0.0 }
}

pub fn create(kind: &str, sr: f32) -> Option<Created> {
    let name = LIST.iter().find(|(k, _)| *k == kind)?.1.to_string();
    let (fx, infos): (Box<dyn Fx>, Vec<ParamInfo>) = match kind {
        "gate" => (
            Box::new(Gate::new(sr)),
            vec![p("Threshold", -80.0, -20.0, -55.0, "dB"), plog("Release", 20.0, 500.0, 120.0, "ms")],
        ),
        "comp" => (
            Box::new(Comp::new(sr)),
            vec![
                p("Threshold", -50.0, 0.0, -18.0, "dB"),
                plog("Ratio", 1.0, 20.0, 4.0, ":1"),
                plog("Attack", 1.0, 100.0, 10.0, "ms"),
                plog("Release", 20.0, 1000.0, 150.0, "ms"),
                p("Makeup", 0.0, 24.0, 0.0, "dB"),
            ],
        ),
        "drive" => (
            Box::new(Drive::new(sr)),
            vec![p("Drive", 0.0, 1.0, 0.5, ""), p("Tone", 0.0, 1.0, 0.5, ""), p("Level", -20.0, 10.0, -3.0, "dB")],
        ),
        "dist" => (
            Box::new(Dist::new(sr)),
            vec![p("Gain", 0.0, 1.0, 0.6, ""), p("Tone", 0.0, 1.0, 0.5, ""), p("Level", -30.0, 6.0, -10.0, "dB")],
        ),
        "pitch" => (
            Box::new(Pitch::new(sr)),
            vec![
                ParamInfo { step: 1.0, ..p("Semitones", -12.0, 12.0, -2.0, "st") },
                p("Fine", -50.0, 50.0, 0.0, "cents"),
                p("Mix", 0.0, 1.0, 1.0, ""),
            ],
        ),
        "tremolo" => (
            Box::new(Tremolo::new(sr)),
            vec![plog("Rate", 0.5, 15.0, 5.0, "Hz"), p("Depth", 0.0, 1.0, 0.6, "")],
        ),
        "amp" => (
            Box::new(Amp::new(sr)),
            vec![
                p("Gain", 0.0, 1.0, 0.4, ""),
                p("Bass", 0.0, 1.0, 0.5, ""),
                p("Mid", 0.0, 1.0, 0.5, ""),
                p("Treble", 0.0, 1.0, 0.55, ""),
                p("Master", -30.0, 6.0, -8.0, "dB"),
            ],
        ),
        "cab" => (
            Box::new(Cab::new(sr)),
            vec![p("Tone", 0.0, 1.0, 0.5, ""), p("Body", 0.0, 1.0, 0.5, ""), p("Level", -12.0, 12.0, 0.0, "dB")],
        ),
        "eq" => (
            Box::new(Eq::new(sr)),
            vec![
                p("Low", -15.0, 15.0, 0.0, "dB"),
                p("Mid", -15.0, 15.0, 0.0, "dB"),
                plog("Mid Freq", 200.0, 5000.0, 800.0, "Hz"),
                p("High", -15.0, 15.0, 0.0, "dB"),
            ],
        ),
        "delay" => (
            Box::new(Delay::new(sr)),
            vec![plog("Time", 20.0, 1500.0, 380.0, "ms"), p("Feedback", 0.0, 0.9, 0.35, ""), p("Mix", 0.0, 1.0, 0.25, "")],
        ),
        "reverb" => (
            Box::new(Reverb::new(sr)),
            vec![p("Size", 0.0, 1.0, 0.5, ""), p("Damping", 0.0, 1.0, 0.5, ""), p("Mix", 0.0, 1.0, 0.2, "")],
        ),
        _ => return None,
    };
    Some(Created { fx, name, infos })
}

// ---------------------------------------------------------------- biquad

/// Second-order filter (RBJ cookbook coefficients, transposed direct form II).
#[derive(Clone, Copy, Default)]
pub struct Biquad {
    b0: f32,
    b1: f32,
    b2: f32,
    a1: f32,
    a2: f32,
    z1: f32,
    z2: f32,
}

impl Biquad {
    fn set(&mut self, b0: f32, b1: f32, b2: f32, a0: f32, a1: f32, a2: f32) {
        self.b0 = b0 / a0;
        self.b1 = b1 / a0;
        self.b2 = b2 / a0;
        self.a1 = a1 / a0;
        self.a2 = a2 / a0;
    }

    fn wq(sr: f32, f: f32, q: f32) -> (f32, f32) {
        let w = 2.0 * PI * f.clamp(10.0, sr * 0.45) / sr;
        (w.cos(), w.sin() / (2.0 * q))
    }

    pub fn lowpass(&mut self, sr: f32, f: f32, q: f32) {
        let (c, al) = Self::wq(sr, f, q);
        self.set((1.0 - c) / 2.0, 1.0 - c, (1.0 - c) / 2.0, 1.0 + al, -2.0 * c, 1.0 - al);
    }

    pub fn highpass(&mut self, sr: f32, f: f32, q: f32) {
        let (c, al) = Self::wq(sr, f, q);
        self.set((1.0 + c) / 2.0, -(1.0 + c), (1.0 + c) / 2.0, 1.0 + al, -2.0 * c, 1.0 - al);
    }

    pub fn peak(&mut self, sr: f32, f: f32, q: f32, db: f32) {
        let (c, al) = Self::wq(sr, f, q);
        let a = 10f32.powf(db / 40.0);
        self.set(1.0 + al * a, -2.0 * c, 1.0 - al * a, 1.0 + al / a, -2.0 * c, 1.0 - al / a);
    }

    pub fn lowshelf(&mut self, sr: f32, f: f32, db: f32) {
        let (c, al) = Self::wq(sr, f, std::f32::consts::FRAC_1_SQRT_2);
        let a = 10f32.powf(db / 40.0);
        let k = 2.0 * a.sqrt() * al;
        self.set(
            a * ((a + 1.0) - (a - 1.0) * c + k),
            2.0 * a * ((a - 1.0) - (a + 1.0) * c),
            a * ((a + 1.0) - (a - 1.0) * c - k),
            (a + 1.0) + (a - 1.0) * c + k,
            -2.0 * ((a - 1.0) + (a + 1.0) * c),
            (a + 1.0) + (a - 1.0) * c - k,
        );
    }

    pub fn highshelf(&mut self, sr: f32, f: f32, db: f32) {
        let (c, al) = Self::wq(sr, f, std::f32::consts::FRAC_1_SQRT_2);
        let a = 10f32.powf(db / 40.0);
        let k = 2.0 * a.sqrt() * al;
        self.set(
            a * ((a + 1.0) + (a - 1.0) * c + k),
            -2.0 * a * ((a - 1.0) + (a + 1.0) * c),
            a * ((a + 1.0) + (a - 1.0) * c - k),
            (a + 1.0) - (a - 1.0) * c + k,
            2.0 * ((a - 1.0) - (a + 1.0) * c),
            (a + 1.0) - (a - 1.0) * c - k,
        );
    }

    #[inline]
    pub fn tick(&mut self, x: f32) -> f32 {
        let y = self.b0 * x + self.z1;
        self.z1 = self.b1 * x - self.a1 * y + self.z2;
        self.z2 = self.b2 * x - self.a2 * y;
        y
    }
}

/// One-pole smoothing coefficient for a time constant in milliseconds.
fn coef(ms: f32, sr: f32) -> f32 {
    (-1.0 / (ms.max(0.01) * 0.001 * sr)).exp()
}

// ---------------------------------------------------------------- gate

struct Gate {
    sr: f32,
    thresh: f32,
    release: f32,
    env: f32,
    gain: f32,
    hold: u32,
}

impl Gate {
    fn new(sr: f32) -> Self {
        Self { sr, thresh: db_to_gain(-55.0), release: coef(120.0, sr), env: 0.0, gain: 0.0, hold: 0 }
    }
}

impl Fx for Gate {
    fn set_param(&mut self, idx: usize, v: f32) {
        match idx {
            0 => self.thresh = 10f32.powf(v / 20.0),
            _ => self.release = coef(v, self.sr),
        }
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let env_rel = coef(10.0, self.sr);
        let attack = coef(1.0, self.sr);
        let hold = (self.sr * 0.05) as u32;
        for (a, b) in l.iter_mut().zip(r.iter_mut()) {
            let x = a.abs().max(b.abs());
            self.env = if x > self.env { x } else { x + (self.env - x) * env_rel };
            if self.env > self.thresh {
                self.hold = hold;
            }
            let target = if self.hold > 0 { 1.0 } else { 0.0 };
            self.hold = self.hold.saturating_sub(1);
            let c = if target > self.gain { attack } else { self.release };
            self.gain = target + (self.gain - target) * c;
            *a *= self.gain;
            *b *= self.gain;
        }
    }
}

// ---------------------------------------------------------------- compressor

struct Comp {
    sr: f32,
    thresh_db: f32,
    ratio: f32,
    attack: f32,
    release: f32,
    makeup: f32,
    env_db: f32,
}

impl Comp {
    fn new(sr: f32) -> Self {
        Self { sr, thresh_db: -18.0, ratio: 4.0, attack: coef(10.0, sr), release: coef(150.0, sr), makeup: 1.0, env_db: 0.0 }
    }
}

impl Fx for Comp {
    fn set_param(&mut self, idx: usize, v: f32) {
        match idx {
            0 => self.thresh_db = v,
            1 => self.ratio = v.max(1.0),
            2 => self.attack = coef(v, self.sr),
            3 => self.release = coef(v, self.sr),
            _ => self.makeup = 10f32.powf(v / 20.0),
        }
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for (a, b) in l.iter_mut().zip(r.iter_mut()) {
            let x = a.abs().max(b.abs()).max(1e-6);
            let over = (20.0 * x.log10() - self.thresh_db).max(0.0);
            let reduce = over * (1.0 - 1.0 / self.ratio);
            let c = if reduce > self.env_db { self.attack } else { self.release };
            self.env_db = reduce + (self.env_db - reduce) * c;
            let g = 10f32.powf(-self.env_db / 20.0) * self.makeup;
            *a *= g;
            *b *= g;
        }
    }
}

// ---------------------------------------------------------------- overdrive

struct Drive {
    sr: f32,
    gain: f32,
    level: f32,
    hp: [Biquad; 2],
    lp: [Biquad; 2],
}

impl Drive {
    fn new(sr: f32) -> Self {
        let mut d = Self { sr, gain: 20.0, level: 0.7, hp: [Biquad::default(); 2], lp: [Biquad::default(); 2] };
        for f in &mut d.hp {
            f.highpass(sr, 280.0, 0.7);
        }
        d.set_param(1, 0.5);
        d
    }
}

impl Fx for Drive {
    fn set_param(&mut self, idx: usize, v: f32) {
        match idx {
            0 => self.gain = 1.0 + v * v * 80.0,
            1 => {
                let f = 900.0 * 8f32.powf(v);
                for lp in &mut self.lp {
                    lp.lowpass(self.sr, f, 0.7);
                }
            }
            _ => self.level = 10f32.powf(v / 20.0),
        }
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for (c, buf) in [l, r].into_iter().enumerate() {
            for s in buf.iter_mut() {
                // Clip only the mids and highs, then blend the dry signal back in to keep the low end.
                let clipped = (self.hp[c].tick(*s) * self.gain).tanh();
                *s = self.lp[c].tick(clipped * 0.6 + *s * 0.5) * self.level;
            }
        }
    }
}

// ---------------------------------------------------------------- distortion

struct Dist {
    sr: f32,
    gain: f32,
    level: f32,
    hp: [Biquad; 2],
    lp: [Biquad; 2],
}

impl Dist {
    fn new(sr: f32) -> Self {
        let mut d = Self { sr, gain: 60.0, level: 0.3, hp: [Biquad::default(); 2], lp: [Biquad::default(); 2] };
        for f in &mut d.hp {
            f.highpass(sr, 110.0, 0.7);
        }
        d.set_param(1, 0.5);
        d
    }
}

impl Fx for Dist {
    fn set_param(&mut self, idx: usize, v: f32) {
        match idx {
            0 => self.gain = 4.0 + v * v * 600.0,
            1 => {
                let f = 1400.0 * 6f32.powf(v);
                for lp in &mut self.lp {
                    lp.lowpass(self.sr, f, 0.7);
                }
            }
            _ => self.level = 10f32.powf(v / 20.0),
        }
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for (c, buf) in [l, r].into_iter().enumerate() {
            for s in buf.iter_mut() {
                // Hard clipping with slightly rounded corners: tighter and buzzier than the overdrive.
                let x = (self.hp[c].tick(*s) * self.gain).clamp(-1.5, 1.5);
                let clipped = x - x * x * x * (4.0 / 27.0);
                *s = self.lp[c].tick(clipped) * self.level;
            }
        }
    }
}

// ---------------------------------------------------------------- pitch shifter

const PITCH_BUF: usize = 8192;

/// Delay-line pitch shifter: two read heads sweep through the recent past at a different
/// speed than the write head, crossfading into each other whenever one has to jump.
struct Pitch {
    window: f32,
    semis: f32,
    cents: f32,
    rate: f32,
    mix: f32,
    phase: f32,
    write: usize,
    buf: [Vec<f32>; 2],
}

impl Pitch {
    fn new(sr: f32) -> Self {
        let window = (sr * 0.04).min(PITCH_BUF as f32 - 4.0);
        let mut p = Self { window, semis: -2.0, cents: 0.0, rate: 0.0, mix: 1.0, phase: 0.0, write: 0, buf: [vec![0.0; PITCH_BUF], vec![0.0; PITCH_BUF]] };
        p.set_param(0, -2.0);
        p
    }
}

impl Fx for Pitch {
    fn set_param(&mut self, idx: usize, v: f32) {
        match idx {
            0 => self.semis = v.round(),
            1 => self.cents = v,
            _ => self.mix = v,
        }
        let ratio = 2f32.powf((self.semis + self.cents / 100.0) / 12.0);
        self.rate = (1.0 - ratio) / self.window;
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let mask = PITCH_BUF - 1;
        for i in 0..l.len() {
            self.buf[0][self.write] = l[i];
            self.buf[1][self.write] = r[i];
            let mut wet = [0.0f32; 2];
            for head in 0..2 {
                let ph = (self.phase + head as f32 * 0.5).fract();
                let weight = 0.5 - 0.5 * (ph * std::f32::consts::TAU).cos();
                let delay = ph * self.window + 1.0;
                let whole = delay as usize;
                let frac = delay - whole as f32;
                let a = (self.write + PITCH_BUF - whole) & mask;
                let b = (a + PITCH_BUF - 1) & mask;
                for c in 0..2 {
                    wet[c] += (self.buf[c][a] * (1.0 - frac) + self.buf[c][b] * frac) * weight;
                }
            }
            l[i] = l[i] * (1.0 - self.mix) + wet[0] * self.mix;
            r[i] = r[i] * (1.0 - self.mix) + wet[1] * self.mix;
            self.phase = (self.phase + self.rate).rem_euclid(1.0);
            self.write = (self.write + 1) & mask;
        }
    }
}

// ---------------------------------------------------------------- tremolo

struct Tremolo {
    sr: f32,
    inc: f32,
    depth: f32,
    phase: f32,
}

impl Tremolo {
    fn new(sr: f32) -> Self {
        Self { sr, inc: 5.0 / sr, depth: 0.6, phase: 0.0 }
    }
}

impl Fx for Tremolo {
    fn set_param(&mut self, idx: usize, v: f32) {
        match idx {
            0 => self.inc = v / self.sr,
            _ => self.depth = v,
        }
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for (a, b) in l.iter_mut().zip(r.iter_mut()) {
            let lfo = 0.5 + 0.5 * (self.phase * std::f32::consts::TAU).cos();
            let g = 1.0 - self.depth * (1.0 - lfo);
            *a *= g;
            *b *= g;
            self.phase = (self.phase + self.inc).fract();
        }
    }
}

// ---------------------------------------------------------------- amp

#[derive(Clone, Copy, Default)]
struct AmpCh {
    hp: Biquad,
    pre: Biquad,
    dc: Biquad,
    lp: Biquad,
    bass: Biquad,
    mid: Biquad,
    treble: Biquad,
}

struct Amp {
    sr: f32,
    g1: f32,
    g2: f32,
    master: f32,
    ch: [AmpCh; 2],
}

impl Amp {
    fn new(sr: f32) -> Self {
        let mut ch = AmpCh::default();
        ch.hp.highpass(sr, 70.0, 0.7);
        ch.pre.highshelf(sr, 1500.0, 6.0);
        ch.dc.highpass(sr, 30.0, 0.7);
        ch.lp.lowpass(sr, 7000.0, 0.7);
        let mut a = Self { sr, g1: 1.0, g2: 1.0, master: 0.4, ch: [ch; 2] };
        a.set_param(0, 0.4);
        for i in 1..4 {
            a.set_param(i, 0.5);
        }
        a
    }
}

impl Fx for Amp {
    fn set_param(&mut self, idx: usize, v: f32) {
        let db = (v - 0.5) * 24.0;
        let sr = self.sr;
        match idx {
            0 => {
                self.g1 = 2.0 + v * v * 150.0;
                self.g2 = 1.0 + v * 3.0;
            }
            1 => self.ch.iter_mut().for_each(|c| c.bass.lowshelf(sr, 120.0, db)),
            2 => self.ch.iter_mut().for_each(|c| c.mid.peak(sr, 600.0, 0.7, db)),
            3 => self.ch.iter_mut().for_each(|c| c.treble.highshelf(sr, 3200.0, db)),
            _ => self.master = 10f32.powf(v / 20.0),
        }
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        const BIAS: f32 = 0.15;
        let bias_out = BIAS.tanh();
        for (c, buf) in [l, r].into_iter().enumerate() {
            let ch = &mut self.ch[c];
            for s in buf.iter_mut() {
                let x = ch.pre.tick(ch.hp.tick(*s));
                // Two gain stages: the first is biased so it clips asymmetrically, like a tube.
                let y = (x * self.g1 + BIAS).tanh() - bias_out;
                let y = (ch.lp.tick(ch.dc.tick(y)) * self.g2).tanh();
                *s = ch.treble.tick(ch.mid.tick(ch.bass.tick(y))) * self.master;
            }
        }
    }
}

// ---------------------------------------------------------------- cabinet

#[derive(Clone, Copy, Default)]
struct CabCh {
    hp: Biquad,
    body: Biquad,
    scoop: Biquad,
    bite: Biquad,
    lp1: Biquad,
    lp2: Biquad,
}

/// Speaker cabinet approximated with filters (no impulse response files needed).
struct Cab {
    sr: f32,
    level: f32,
    ch: [CabCh; 2],
}

impl Cab {
    fn new(sr: f32) -> Self {
        let mut ch = CabCh::default();
        ch.hp.highpass(sr, 75.0, 0.8);
        ch.scoop.peak(sr, 400.0, 1.0, -4.0);
        ch.bite.peak(sr, 2600.0, 1.8, 5.0);
        let mut c = Self { sr, level: 1.0, ch: [ch; 2] };
        c.set_param(0, 0.5);
        c.set_param(1, 0.5);
        c
    }
}

impl Fx for Cab {
    fn set_param(&mut self, idx: usize, v: f32) {
        let sr = self.sr;
        match idx {
            0 => {
                let f = 3000.0 * 2.5f32.powf(v);
                for c in &mut self.ch {
                    c.lp1.lowpass(sr, f, 0.9);
                    c.lp2.lowpass(sr, f, 0.6);
                }
            }
            1 => self.ch.iter_mut().for_each(|c| c.body.peak(sr, 110.0, 1.2, v * 8.0)),
            _ => self.level = 10f32.powf(v / 20.0),
        }
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for (c, buf) in [l, r].into_iter().enumerate() {
            let ch = &mut self.ch[c];
            for s in buf.iter_mut() {
                let x = ch.scoop.tick(ch.body.tick(ch.hp.tick(*s)));
                *s = ch.lp2.tick(ch.lp1.tick(ch.bite.tick(x))) * self.level;
            }
        }
    }
}

// ---------------------------------------------------------------- eq

#[derive(Clone, Copy, Default)]
struct EqCh {
    low: Biquad,
    mid: Biquad,
    high: Biquad,
}

struct Eq {
    sr: f32,
    mid_db: f32,
    mid_freq: f32,
    ch: [EqCh; 2],
}

impl Eq {
    fn new(sr: f32) -> Self {
        let mut e = Self { sr, mid_db: 0.0, mid_freq: 800.0, ch: [EqCh::default(); 2] };
        e.set_param(0, 0.0);
        e.set_param(1, 0.0);
        e.set_param(3, 0.0);
        e
    }
}

impl Fx for Eq {
    fn set_param(&mut self, idx: usize, v: f32) {
        let sr = self.sr;
        match idx {
            0 => self.ch.iter_mut().for_each(|c| c.low.lowshelf(sr, 100.0, v)),
            3 => self.ch.iter_mut().for_each(|c| c.high.highshelf(sr, 5000.0, v)),
            _ => {
                if idx == 1 {
                    self.mid_db = v;
                } else {
                    self.mid_freq = v;
                }
                let (f, db) = (self.mid_freq, self.mid_db);
                self.ch.iter_mut().for_each(|c| c.mid.peak(sr, f, 0.9, db));
            }
        }
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for (c, buf) in [l, r].into_iter().enumerate() {
            let ch = &mut self.ch[c];
            for s in buf.iter_mut() {
                *s = ch.high.tick(ch.mid.tick(ch.low.tick(*s)));
            }
        }
    }
}

// ---------------------------------------------------------------- delay

struct Delay {
    sr: f32,
    buf: [Vec<f32>; 2],
    damp: [f32; 2],
    pos: usize,
    time: usize,
    feedback: f32,
    mix: f32,
}

impl Delay {
    fn new(sr: f32) -> Self {
        let n = (sr * 1.6) as usize;
        Self { sr, buf: [vec![0.0; n], vec![0.0; n]], damp: [0.0; 2], pos: 0, time: (sr * 0.38) as usize, feedback: 0.35, mix: 0.25 }
    }
}

impl Fx for Delay {
    fn set_param(&mut self, idx: usize, v: f32) {
        match idx {
            0 => self.time = ((v * 0.001 * self.sr) as usize).clamp(1, self.buf[0].len() - 1),
            1 => self.feedback = v.clamp(0.0, 0.95),
            _ => self.mix = v,
        }
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let n = self.buf[0].len();
        for i in 0..l.len() {
            let read = (self.pos + n - self.time) % n;
            for (c, s) in [&mut l[i], &mut r[i]].into_iter().enumerate() {
                let wet = self.buf[c][read];
                // Each repeat is slightly darker than the last.
                self.damp[c] = wet + (self.damp[c] - wet) * 0.35;
                self.buf[c][self.pos] = *s + self.damp[c] * self.feedback;
                *s += wet * self.mix;
            }
            self.pos = (self.pos + 1) % n;
        }
    }
}

// ---------------------------------------------------------------- reverb (Freeverb)

struct Comb {
    buf: Vec<f32>,
    pos: usize,
    filt: f32,
}

impl Comb {
    fn new(len: usize) -> Self {
        Self { buf: vec![0.0; len.max(1)], pos: 0, filt: 0.0 }
    }
    #[inline]
    fn tick(&mut self, x: f32, feedback: f32, damp: f32) -> f32 {
        let out = self.buf[self.pos];
        self.filt = out * (1.0 - damp) + self.filt * damp;
        self.buf[self.pos] = x + self.filt * feedback;
        self.pos = (self.pos + 1) % self.buf.len();
        out
    }
}

struct Allpass {
    buf: Vec<f32>,
    pos: usize,
}

impl Allpass {
    fn new(len: usize) -> Self {
        Self { buf: vec![0.0; len.max(1)], pos: 0 }
    }
    #[inline]
    fn tick(&mut self, x: f32) -> f32 {
        let delayed = self.buf[self.pos];
        self.buf[self.pos] = x + delayed * 0.5;
        self.pos = (self.pos + 1) % self.buf.len();
        delayed - x
    }
}

struct Reverb {
    combs: [Vec<Comb>; 2],
    allpasses: [Vec<Allpass>; 2],
    feedback: f32,
    damp: f32,
    mix: f32,
}

impl Reverb {
    fn new(sr: f32) -> Self {
        const COMBS: [usize; 8] = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
        const ALLPASSES: [usize; 4] = [556, 441, 341, 225];
        let scale = |len: usize, spread: usize| ((len + spread) as f32 * sr / 44100.0) as usize;
        let side = |spread: usize| {
            (
                COMBS.iter().map(|&n| Comb::new(scale(n, spread))).collect::<Vec<_>>(),
                ALLPASSES.iter().map(|&n| Allpass::new(scale(n, spread))).collect::<Vec<_>>(),
            )
        };
        let (cl, al) = side(0);
        let (cr, ar) = side(23);
        Self { combs: [cl, cr], allpasses: [al, ar], feedback: 0.84, damp: 0.2, mix: 0.2 }
    }
}

impl Fx for Reverb {
    fn set_param(&mut self, idx: usize, v: f32) {
        match idx {
            0 => self.feedback = 0.7 + v * 0.28,
            1 => self.damp = v * 0.4,
            _ => self.mix = v,
        }
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for i in 0..l.len() {
            let input = (l[i] + r[i]) * 0.015;
            for (c, s) in [&mut l[i], &mut r[i]].into_iter().enumerate() {
                let mut wet = 0.0;
                for comb in &mut self.combs[c] {
                    wet += comb.tick(input, self.feedback, self.damp);
                }
                for ap in &mut self.allpasses[c] {
                    wet = ap.tick(wet);
                }
                *s = *s * (1.0 - self.mix * 0.5) + wet * 3.0 * self.mix;
            }
        }
    }
}
