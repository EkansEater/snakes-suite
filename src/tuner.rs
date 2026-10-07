//! Chromatic tuner: pitch detection (YIN) on the live input.

use rtrb::Consumer;

const WINDOW: usize = 2048;
const NOTES: [&str; 12] = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

pub struct Reading {
    pub note: String,
    pub freq: f32,
    /// Offset from the nearest note, -50..50 cents.
    pub cents: f32,
}

pub struct Tuner {
    rx: Consumer<f32>,
    buf: Vec<f32>,
    fresh: usize,
    pub reading: Option<Reading>,
}

impl Tuner {
    pub fn new(rx: Consumer<f32>) -> Self {
        Self { rx, buf: Vec::new(), fresh: 0, reading: None }
    }

    /// Discard queued input (used while the tuner is closed).
    pub fn drain(&mut self) {
        while self.rx.pop().is_ok() {}
        self.buf.clear();
        self.reading = None;
    }

    pub fn update(&mut self, sr: f32) {
        // Work at half the sample rate: plenty for pitch, and it makes room for a long window
        // so notes down to about 28 Hz (below a 5-string bass) can be measured.
        let sr = sr / 2.0;
        let max_tau = (sr / 28.0) as usize;
        let need = WINDOW + max_tau;
        while self.rx.slots() >= 2 {
            let (Ok(a), Ok(b)) = (self.rx.pop(), self.rx.pop()) else { break };
            self.buf.push((a + b) * 0.5);
            self.fresh += 1;
        }
        if self.buf.len() > need {
            self.buf.drain(..self.buf.len() - need);
        }
        if self.buf.len() < need || self.fresh < 1024 {
            return;
        }
        self.fresh = 0;
        self.reading = detect(&self.buf, sr, max_tau).map(|freq| {
            let midi = 69.0 + 12.0 * (freq / 440.0).log2();
            let nearest = midi.round();
            let n = nearest as i32;
            Reading { note: format!("{}{}", NOTES[n.rem_euclid(12) as usize], n / 12 - 1), freq, cents: (midi - nearest) * 100.0 }
        });
    }
}

fn detect(x: &[f32], sr: f32, max_tau: usize) -> Option<f32> {
    let level = x[..WINDOW].iter().fold(0.0f32, |m, s| m.max(s.abs()));
    if level < 0.003 {
        return None;
    }
    let min_tau = ((sr / 2000.0) as usize).max(2);
    // Cumulative-mean-normalised difference function.
    let mut d = vec![1.0f32; max_tau + 1];
    let mut running = 0.0;
    for tau in 1..=max_tau {
        let diff: f32 = (0..WINDOW).map(|j| (x[j] - x[j + tau]).powi(2)).sum();
        running += diff;
        d[tau] = if running > 0.0 { diff * tau as f32 / running } else { 1.0 };
    }
    let mut tau = (min_tau..max_tau).find(|&t| d[t] < 0.12)?;
    while tau + 1 < max_tau && d[tau + 1] < d[tau] {
        tau += 1;
    }
    // Parabolic interpolation between neighbouring lags for sub-sample accuracy.
    let (a, b, c) = (d[tau - 1], d[tau], d[tau + 1]);
    let denom = a - 2.0 * b + c;
    let shift = if denom.abs() > 1e-9 { 0.5 * (a - c) / denom } else { 0.0 };
    Some(sr / (tau as f32 + shift))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_guitar_and_bass_notes() {
        let sr = 24000.0;
        let max_tau = (sr / 28.0) as usize;
        // Low E on guitar, low B on a 5-string bass, and a high note.
        for freq in [82.41f32, 30.87, 659.25] {
            let x: Vec<f32> = (0..WINDOW + max_tau)
                .map(|i| {
                    let t = i as f32 * freq * std::f32::consts::TAU / sr;
                    0.4 * t.sin() + 0.2 * (2.0 * t).sin() + 0.1 * (3.0 * t).sin()
                })
                .collect();
            let found = detect(&x, sr, max_tau).expect("a pitch");
            assert!((found / freq - 1.0).abs() < 0.004, "expected {freq} Hz, got {found}");
        }
    }
}
