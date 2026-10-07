use anyhow::{bail, Context, Result};
use std::path::Path;

/// Number of frames summarised by one waveform peak.
pub const PEAK_CHUNK: usize = 256;

/// Audio held fully in memory: one Vec per channel (1 or 2 channels).
pub struct AudioData {
    pub ch: Vec<Vec<f32>>,
    pub peaks: Vec<(f32, f32)>,
}

impl AudioData {
    pub fn new(ch: Vec<Vec<f32>>) -> Self {
        let peaks = compute_peaks(&ch);
        Self { ch, peaks }
    }

    pub fn frames(&self) -> usize {
        self.ch.first().map_or(0, |c| c.len())
    }

    pub fn load_wav(path: &Path) -> Result<Self> {
        let mut r = hound::WavReader::open(path).with_context(|| format!("opening {}", path.display()))?;
        let spec = r.spec();
        let n = spec.channels as usize;
        if n == 0 {
            bail!("{} has no channels", path.display());
        }
        let samples: Vec<f32> = match spec.sample_format {
            hound::SampleFormat::Float => r.samples::<f32>().collect::<Result<_, _>>()?,
            hound::SampleFormat::Int => {
                let scale = 1.0 / (1i64 << (spec.bits_per_sample - 1)) as f32;
                r.samples::<i32>().map(|s| s.map(|v| v as f32 * scale)).collect::<Result<_, _>>()?
            }
        };
        let keep = n.min(2);
        let mut ch = vec![Vec::with_capacity(samples.len() / n); keep];
        for frame in samples.chunks_exact(n) {
            for c in 0..keep {
                ch[c].push(frame[c]);
            }
        }
        Ok(Self::new(ch))
    }
}

pub fn compute_peaks(ch: &[Vec<f32>]) -> Vec<(f32, f32)> {
    let frames = ch.first().map_or(0, |c| c.len());
    let mut peaks = Vec::with_capacity(frames / PEAK_CHUNK + 1);
    let mut i = 0;
    while i < frames {
        let end = (i + PEAK_CHUNK).min(frames);
        let (mut lo, mut hi) = (0.0f32, 0.0f32);
        for c in ch {
            for &s in &c[i..end] {
                lo = lo.min(s);
                hi = hi.max(s);
            }
        }
        peaks.push((lo, hi));
        i = end;
    }
    peaks
}

pub fn wav_spec(channels: u16, sample_rate: u32) -> hound::WavSpec {
    hound::WavSpec { channels, sample_rate, bits_per_sample: 32, sample_format: hound::SampleFormat::Float }
}
