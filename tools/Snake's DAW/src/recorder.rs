//! Disk writer for a recording track. Runs on its own thread so the audio thread never touches files.

use crate::audio::{wav_spec, AudioData, PEAK_CHUNK};
use anyhow::Result;
use rtrb::Consumer;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;

pub type LivePeaks = Arc<Mutex<Vec<(f32, f32)>>>;

/// Drain `rx` into a WAV file until the audio thread lets go of its end, then return the audio.
pub fn spawn_writer(path: PathBuf, sample_rate: u32, stereo: bool, mut rx: Consumer<f32>, peaks: LivePeaks) -> JoinHandle<Result<AudioData>> {
    std::thread::spawn(move || {
        let channels = if stereo { 2 } else { 1 };
        let mut wav = hound::WavWriter::create(&path, wav_spec(channels as u16, sample_rate))?;
        let mut ch = vec![Vec::new(); channels];
        let mut frame = Vec::with_capacity(channels);
        let (mut lo, mut hi, mut in_chunk) = (0.0f32, 0.0f32, 0);
        loop {
            let finished = rx.is_abandoned();
            let mut got_any = false;
            while let Ok(s) = rx.pop() {
                got_any = true;
                wav.write_sample(s)?;
                frame.push(s);
                if frame.len() < channels {
                    continue;
                }
                for (c, v) in frame.drain(..).enumerate() {
                    ch[c].push(v);
                    lo = lo.min(v);
                    hi = hi.max(v);
                }
                in_chunk += 1;
                if in_chunk == PEAK_CHUNK {
                    peaks.lock().unwrap().push((lo, hi));
                    (lo, hi, in_chunk) = (0.0, 0.0, 0);
                }
            }
            if finished && !got_any {
                break;
            }
            std::thread::sleep(Duration::from_millis(15));
        }
        wav.finalize()?;
        Ok(AudioData::new(ch))
    })
}
