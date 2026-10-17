//! Snake's DAW in the browser.
//!
//! The mixer, effects, loop station and tuner are the desktop app's own source files,
//! compiled in by path, so the browser sounds and behaves like the desktop. Only the
//! controller differs: the page keeps the project (the same project.json as the desktop)
//! and drives this module from its audio worklet with JSON messages (`daw_op`).
#![allow(dead_code, unexpected_cfgs)]

#[path = "../../src/audio.rs"]
mod audio;
#[path = "../../src/engine.rs"]
mod engine;
#[path = "../../src/fx/mod.rs"]
mod fx;
#[path = "../../src/looper.rs"]
mod looper;
#[path = "../../src/tuner.rs"]
mod tuner;
#[path = "../../src/util.rs"]
mod util;

use std::collections::HashMap;
use std::slice;
use std::sync::atomic::Ordering::Relaxed;
use std::sync::Arc;

use rtrb::{Consumer, Producer, RingBuffer};
use serde_json::{json, Value};

use audio::AudioData;
use engine::{ClipRt, Cmd, Garbage, Mixer, RecSink, TrackRt, TrackShared, Transport, MAX_BLOCK, NUM_INPUTS, SRC_NONE};
use fx::{FxShared, FxSlot};
use looper::{LoopAction, LoopBuf, Looper, LooperShared, SLOTS};
use tuner::Tuner;
use util::db_to_gain;

/// One recording track's tap: the mixer pushes samples, the page takes them.
struct Rec {
    rx: Consumer<f32>,
    stereo: bool,
    got: Vec<f32>,
}

pub struct Daw {
    sr: u32,
    mixer: Mixer,
    cmd: Producer<Cmd>,
    garbage: Consumer<Garbage>,
    tuner: Tuner,
    transport: Arc<Transport>,
    looper: Arc<LooperShared>,
    tracks: HashMap<u64, Arc<TrackShared>>,
    fx: HashMap<u64, Arc<FxShared>>,
    audio: HashMap<u64, Arc<AudioData>>,
    /// Audio being uploaded: id -> planar channels.
    uploads: HashMap<u64, Vec<Vec<f32>>>,
    recs: HashMap<u64, Rec>,
    lv2: fx::lv2::Lv2Host,
    ins: [Vec<f32>; 2],
    outs: [Vec<f32>; 2],
    silence: Vec<f32>,
    reply: Vec<u8>,
}

fn f(v: &Value, k: &str) -> f64 {
    v.get(k).and_then(Value::as_f64).unwrap_or(0.0)
}
fn u(v: &Value, k: &str) -> u64 {
    v.get(k).and_then(Value::as_u64).unwrap_or(0)
}
fn b(v: &Value, k: &str) -> bool {
    v.get(k).and_then(Value::as_bool).unwrap_or(false)
}

impl Daw {
    fn new(sr: u32) -> Self {
        let transport = Arc::new(Transport::new());
        let looper = Arc::new(LooperShared::new());
        let (cmd, cmd_rx) = RingBuffer::new(256);
        let (garbage_tx, garbage) = RingBuffer::new(256);
        let (tuner_tx, tuner_rx) = RingBuffer::new(sr as usize);
        let mixer = Mixer::new(sr, transport.clone(), cmd_rx, garbage_tx, tuner_tx, Looper::new(sr, looper.clone()));
        Self {
            sr,
            mixer,
            cmd,
            garbage,
            tuner: Tuner::new(tuner_rx),
            transport,
            looper,
            tracks: HashMap::new(),
            fx: HashMap::new(),
            audio: HashMap::new(),
            uploads: HashMap::new(),
            recs: HashMap::new(),
            lv2: fx::lv2::Lv2Host::new(),
            ins: [vec![0.0; MAX_BLOCK], vec![0.0; MAX_BLOCK]],
            outs: [vec![0.0; MAX_BLOCK], vec![0.0; MAX_BLOCK]],
            silence: vec![0.0; MAX_BLOCK],
            reply: Vec::new(),
        }
    }

    fn send(&mut self, c: Cmd) {
        // The queue is drained every block; it only fills if the audio has stopped.
        let _ = self.cmd.push(c);
    }

    fn clips(&self, list: &Value) -> Vec<ClipRt> {
        list.as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|c| {
                        let data = self.audio.get(&u(c, "audio"))?.clone();
                        Some(ClipRt { start: f(c, "start") as i64, offset: u(c, "offset") as usize, len: u(c, "len") as usize, data })
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn make_fx(&mut self, d: &Value) -> Box<FxSlot> {
        let created = fx::create(d.get("kind").and_then(Value::as_str).unwrap_or(""), self.sr as f32, &self.lv2);
        let given: Vec<f32> = d.get("params").and_then(Value::as_array).map(|a| a.iter().map(|x| x.as_f64().unwrap_or(0.0) as f32).collect()).unwrap_or_default();
        let values: Vec<f32> = if given.len() == created.infos.len() { given } else { created.infos.iter().map(|i| i.default).collect() };
        let (slot, shared) = FxSlot::new(u(d, "id"), created.fx, &values, b(d, "bypass"));
        self.fx.insert(u(d, "id"), shared);
        Box::new(slot)
    }

    fn sync_track(s: &TrackShared, t: &Value) {
        if let Some(v) = t.get("volume_db").and_then(Value::as_f64) {
            s.gain.set(db_to_gain(v as f32));
        }
        if let Some(v) = t.get("pan").and_then(Value::as_f64) {
            s.pan.set(v as f32);
        }
        for (k, a) in [("mute", &s.mute), ("solo", &s.solo), ("arm", &s.arm), ("monitor", &s.monitor), ("fx_on", &s.fx_on)] {
            if let Some(v) = t.get(k).and_then(Value::as_bool) {
                a.store(v, Relaxed);
            }
        }
        if let Some(v) = t.get("input") {
            // The page gives a hardware input number, or null for none.
            s.input.store(v.as_u64().map_or(SRC_NONE, |i| (i as u32).min(NUM_INPUTS as u32 - 1)), Relaxed);
        }
        if let Some(v) = t.get("loop_mask").and_then(Value::as_u64) {
            s.loop_mask.store(v as u32, Relaxed);
        }
    }

    fn op(&mut self, v: &Value) -> Value {
        let op = v.get("op").and_then(Value::as_str).unwrap_or("");
        match op {
            "track_add" => {
                let id = u(v, "id");
                let shared = Arc::new(TrackShared::new());
                Self::sync_track(&shared, v);
                let fx: Vec<Box<FxSlot>> = v.get("fx").and_then(Value::as_array).cloned().unwrap_or_default().iter().map(|d| self.make_fx(d)).collect();
                let clips = self.clips(v.get("clips").unwrap_or(&Value::Null));
                self.tracks.insert(id, shared.clone());
                self.send(Cmd::AddTrack(Box::new(TrackRt::new(id, shared, clips, fx))));
            }
            "track_remove" => {
                self.tracks.remove(&u(v, "id"));
                self.send(Cmd::RemoveTrack(u(v, "id")));
            }
            "track" => {
                if let Some(s) = self.tracks.get(&u(v, "id")) {
                    Self::sync_track(s, v);
                }
            }
            "clips" => {
                let clips = self.clips(v.get("clips").unwrap_or(&Value::Null));
                self.send(Cmd::SetClips(u(v, "track"), clips));
            }
            "fx_add" => {
                let slot = self.make_fx(v);
                self.send(Cmd::AddFx { track: u(v, "track"), index: u(v, "index") as usize, slot });
            }
            "fx_remove" => {
                self.fx.remove(&u(v, "id"));
                self.send(Cmd::RemoveFx { track: u(v, "track"), fx: u(v, "id") });
            }
            "fx_move" => self.send(Cmd::MoveFx { track: u(v, "track"), fx: u(v, "id"), index: u(v, "index") as usize }),
            "fx_param" => {
                if let Some(s) = self.fx.get(&u(v, "id")) {
                    if let Some(p) = s.params.get(u(v, "index") as usize) {
                        p.set(f(v, "value") as f32);
                    }
                }
            }
            "fx_bypass" => {
                if let Some(s) = self.fx.get(&u(v, "id")) {
                    s.bypass.store(b(v, "on"), Relaxed);
                }
            }
            "audio_drop" => {
                self.audio.remove(&u(v, "id"));
            }
            "play" => self.send(Cmd::Play),
            "stop" => self.send(Cmd::Stop),
            "seek" => self.send(Cmd::Seek(f(v, "pos") as i64)),
            "transport" => {
                let t = &self.transport;
                if let Some(x) = v.get("loop_on").and_then(Value::as_bool) { t.loop_on.store(x, Relaxed) }
                if let Some(x) = v.get("loop_start").and_then(Value::as_f64) { t.loop_start.store(x as i64, Relaxed) }
                if let Some(x) = v.get("loop_end").and_then(Value::as_f64) { t.loop_end.store(x as i64, Relaxed) }
                if let Some(x) = v.get("metronome").and_then(Value::as_bool) { t.metro_on.store(x, Relaxed) }
                if let Some(x) = v.get("bpm").and_then(Value::as_f64) {
                    t.bpm.set(x as f32);
                    self.looper.bpm.set(x as f32);
                }
                if let Some(x) = v.get("beats_per_bar").and_then(Value::as_u64) {
                    t.beats_per_bar.store(x as u32, Relaxed);
                    self.looper.beats_per_bar.store(x as u32, Relaxed);
                }
                if let Some(x) = v.get("master_db").and_then(Value::as_f64) { t.master_gain.set(db_to_gain(x as f32)) }
                if let Some(x) = v.get("tuner").and_then(Value::as_bool) {
                    t.tuner_on.store(x, Relaxed);
                    if !x { self.tuner.drain() }
                }
                if let Some(x) = v.get("tuner_input").and_then(Value::as_u64) { t.tuner_input.store(x as u32, Relaxed) }
                if let Some(x) = v.get("loop_click").and_then(Value::as_bool) { self.looper.click.store(x, Relaxed) }
                if let Some(x) = v.get("loop_count_in").and_then(Value::as_bool) { self.looper.count_in.store(x, Relaxed) }
            }
            "record" => {
                // Taps for the armed tracks; the page collects what they hear (rec_take).
                let mut sinks = Vec::new();
                self.recs.clear();
                for t in v.get("tracks").and_then(Value::as_array).cloned().unwrap_or_default() {
                    let stereo = b(&t, "stereo");
                    let (tx, rx) = RingBuffer::new(self.sr as usize * 8);
                    sinks.push(RecSink { track: u(&t, "id"), tx, stereo });
                    self.recs.insert(u(&t, "id"), Rec { rx, stereo, got: Vec::new() });
                }
                self.send(Cmd::Record { from: f(v, "from") as i64, at: f(v, "at") as i64, sinks });
            }
            "loop" => {
                let slot = (u(v, "slot") as usize).min(SLOTS - 1);
                let action = match v.get("action").and_then(Value::as_str).unwrap_or("") {
                    "stop" => LoopAction::ToggleStop,
                    "clear" => LoopAction::Clear,
                    _ => LoopAction::Press,
                };
                self.send(Cmd::Loop(slot, action));
            }
            "loop_gain" => {
                if let Some(g) = self.looper.gain.get((u(v, "slot") as usize).min(SLOTS - 1)) {
                    g.set(f(v, "gain") as f32);
                }
            }
            "loop_load" => {
                // A rendered region from an upload: [left, right] of `len` frames.
                let id = u(v, "audio");
                if let Some(data) = self.audio.get(&id).cloned() {
                    let cap = self.sr as usize * looper::MAX_SECONDS;
                    let len = data.frames().min(cap);
                    let mut bufs: LoopBuf = Box::new([vec![0.0; cap], vec![0.0; cap]]);
                    for c in 0..2 {
                        let src = &data.ch[c.min(data.ch.len() - 1)];
                        bufs[c][..len].copy_from_slice(&src[..len]);
                    }
                    let slot = (u(v, "slot") as usize).min(SLOTS - 1);
                    self.send(Cmd::LoopLoad { slot, bufs, len: u(v, "len").max(1).min(cap as u64) as usize });
                }
            }
            "fx_kinds" => {
                return json!(fx::builtin::LIST
                    .iter()
                    .map(|(k, n)| {
                        let c = fx::builtin::create(k, self.sr as f32);
                        let infos: Vec<Value> = c.map(|c| c.infos.iter().map(|i| json!({ "name": i.name, "min": i.min, "max": i.max, "default": i.default, "unit": i.unit, "log": i.log, "step": i.step })).collect()).unwrap_or_default();
                        json!({ "kind": k, "name": n, "params": infos })
                    })
                    .collect::<Vec<_>>());
            }
            _ => return json!({ "error": format!("unknown op {op}") }),
        }
        json!({ "ok": true })
    }

    fn process(&mut self, n: usize) {
        let n = n.min(MAX_BLOCK);
        let (in_l, in_r) = (&self.ins[0][..n], &self.ins[1][..n]);
        let quiet = &self.silence[..n];
        let mut ins: [&[f32]; NUM_INPUTS] = [quiet; NUM_INPUTS];
        ins[0] = in_l;
        ins[1] = in_r;
        let [out_l, out_r] = &mut self.outs;
        self.mixer.process(ins, [quiet, quiet], &mut out_l[..n], &mut out_r[..n]);
        while self.garbage.pop().is_ok() {}
        for r in self.recs.values_mut() {
            while let Ok(s) = r.rx.pop() {
                r.got.push(s);
            }
        }
        if self.transport.tuner_on.load(Relaxed) {
            self.tuner.update(self.sr as f32);
        }
    }

    fn status(&self) -> Value {
        let t = &self.transport;
        let tracks: serde_json::Map<String, Value> = self.tracks.iter().map(|(id, s)| (id.to_string(), json!([s.peak_l.take(), s.peak_r.take()]))).collect();
        let lp = &self.looper;
        json!({
            "pos": t.pos.load(Relaxed),
            "playing": t.playing.load(Relaxed),
            "recording": t.recording.load(Relaxed),
            "master": [t.master_peak_l.take(), t.master_peak_r.take()],
            "inputs": [t.input_peaks[0].take(), t.input_peaks[1].take()],
            "tracks": tracks,
            "loops": (0..SLOTS).map(|i| lp.state[i].load(Relaxed)).collect::<Vec<_>>(),
            "loop_len": lp.len.load(Relaxed),
            "loop_pos": lp.pos.load(Relaxed),
            "tuner": self.tuner.reading.as_ref().map(|r| json!({ "note": r.note, "freq": r.freq, "cents": r.cents })),
            "recorded": self.recs.iter().map(|(id, r)| (id.to_string(), json!(r.got.len() / if r.stereo { 2 } else { 1 }))).collect::<serde_json::Map<_, _>>(),
        })
    }
}

// ---------------------------------------------------------------------------
// The C-style interface
// ---------------------------------------------------------------------------

#[no_mangle]
pub extern "C" fn buf_alloc(len: usize) -> *mut u8 {
    let mut v = Vec::<u8>::with_capacity(len);
    let p = v.as_mut_ptr();
    std::mem::forget(v);
    p
}

/// # Safety
/// From `buf_alloc` with the same `len`.
#[no_mangle]
pub unsafe extern "C" fn buf_free(p: *mut u8, len: usize) {
    drop(Vec::from_raw_parts(p, 0, len));
}

#[no_mangle]
pub extern "C" fn daw_new(sr: u32) -> *mut Daw {
    Box::into_raw(Box::new(Daw::new(sr)))
}

/// # Safety
/// `d` from `daw_new`.
#[no_mangle]
pub unsafe extern "C" fn daw_free(d: *mut Daw) {
    drop(Box::from_raw(d));
}

/// Where the page writes the input (0: left, 1: right) and reads the output (2, 3) of a block.
///
/// # Safety
/// `d` from `daw_new`.
#[no_mangle]
pub unsafe extern "C" fn daw_buf(d: *mut Daw, which: u32) -> *mut f32 {
    let d = &mut *d;
    match which {
        0 => d.ins[0].as_mut_ptr(),
        1 => d.ins[1].as_mut_ptr(),
        2 => d.outs[0].as_mut_ptr(),
        _ => d.outs[1].as_mut_ptr(),
    }
}

/// Render `n` frames (at most 8192).
///
/// # Safety
/// `d` from `daw_new`.
#[no_mangle]
pub unsafe extern "C" fn daw_process(d: *mut Daw, n: usize) {
    (*d).process(n);
}

/// Run a JSON message (`len` bytes at `p`); the answer is in `daw_reply`.
///
/// # Safety
/// `d` from `daw_new`; `p` points to `len` bytes.
#[no_mangle]
pub unsafe extern "C" fn daw_op(d: *mut Daw, p: *const u8, len: usize) -> usize {
    let d = &mut *d;
    let answer = match serde_json::from_slice::<Value>(slice::from_raw_parts(p, len)) {
        Ok(v) => d.op(&v),
        Err(e) => json!({ "error": e.to_string() }),
    };
    d.reply = answer.to_string().into_bytes();
    d.reply.len()
}

/// The meters, transport, loops and tuner, as JSON in `daw_reply`.
///
/// # Safety
/// `d` from `daw_new`.
#[no_mangle]
pub unsafe extern "C" fn daw_status(d: *mut Daw) -> usize {
    let d = &mut *d;
    d.reply = d.status().to_string().into_bytes();
    d.reply.len()
}

/// # Safety
/// `d` from `daw_new`.
#[no_mangle]
pub unsafe extern "C" fn daw_reply(d: *mut Daw) -> *const u8 {
    (*d).reply.as_ptr()
}

/// Room for `frames` frames of `channels` (1 or 2) planar channels of audio `id`, to fill.
///
/// # Safety
/// `d` from `daw_new`.
#[no_mangle]
pub unsafe extern "C" fn daw_audio_buf(d: *mut Daw, id: u64, channel: u32, frames: usize) -> *mut f32 {
    let d = &mut *d;
    let chans = d.uploads.entry(id).or_default();
    while chans.len() <= channel as usize {
        chans.push(Vec::new());
    }
    let c = &mut chans[channel as usize];
    c.resize(frames, 0.0);
    c.as_mut_ptr()
}

/// The upload is complete: clips can use audio `id`.
///
/// # Safety
/// `d` from `daw_new`.
#[no_mangle]
pub unsafe extern "C" fn daw_audio_done(d: *mut Daw, id: u64) {
    let d = &mut *d;
    if let Some(ch) = d.uploads.remove(&id) {
        d.audio.insert(id, Arc::new(AudioData::new(ch)));
    }
}

/// How many samples a recording track collected (interleaved when stereo); `daw_rec_ptr` has them.
///
/// # Safety
/// `d` from `daw_new`.
#[no_mangle]
pub unsafe extern "C" fn daw_rec_len(d: *mut Daw, track: u64) -> usize {
    (*d).recs.get(&track).map_or(0, |r| r.got.len())
}

/// # Safety
/// `d` from `daw_new`.
#[no_mangle]
pub unsafe extern "C" fn daw_rec_ptr(d: *mut Daw, track: u64) -> *const f32 {
    (*d).recs.get(&track).map_or(std::ptr::null(), |r| r.got.as_ptr())
}

/// The page took a track's recording.
///
/// # Safety
/// `d` from `daw_new`.
#[no_mangle]
pub unsafe extern "C" fn daw_rec_clear(d: *mut Daw, track: u64) {
    (*d).recs.remove(&track);
}
