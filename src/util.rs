use std::sync::atomic::{AtomicU32, Ordering::Relaxed};

/// An f32 that the UI thread and the audio thread can share without locking.
pub struct AtomicF32(AtomicU32);

impl AtomicF32 {
    pub fn new(v: f32) -> Self {
        Self(AtomicU32::new(v.to_bits()))
    }
    pub fn get(&self) -> f32 {
        f32::from_bits(self.0.load(Relaxed))
    }
    pub fn set(&self, v: f32) {
        self.0.store(v.to_bits(), Relaxed)
    }
    /// Raise the stored value to `v` if `v` is larger (used for peak meters).
    pub fn raise(&self, v: f32) {
        if v > self.get() {
            self.set(v)
        }
    }
    /// Read the value and reset it to zero.
    pub fn take(&self) -> f32 {
        f32::from_bits(self.0.swap(0f32.to_bits(), Relaxed))
    }
}

pub fn db_to_gain(db: f32) -> f32 {
    if db <= -60.0 {
        0.0
    } else {
        10f32.powf(db / 20.0)
    }
}

pub fn gain_to_db(g: f32) -> f32 {
    if g <= 1e-6 {
        -120.0
    } else {
        20.0 * g.log10()
    }
}

pub fn peak(buf: &[f32]) -> f32 {
    buf.iter().fold(0.0f32, |m, s| m.max(s.abs()))
}

/// Make a string safe to use as a file or directory name.
pub fn sanitize(name: &str) -> String {
    let s: String = name
        .trim()
        .chars()
        .map(|c| if c.is_alphanumeric() || " -_.".contains(c) { c } else { '_' })
        .collect();
    if s.is_empty() {
        "untitled".into()
    } else {
        s
    }
}
