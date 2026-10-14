//! Headless checks of the audio code (no sound card needed).

use crate::audio::AudioData;
use crate::engine::*;
use crate::fx::{builtin, FxSlot};
use crate::looper::{self, LoopAction, Looper, LooperShared};
use rtrb::RingBuffer;
use std::sync::atomic::Ordering::Relaxed;
use std::sync::Arc;

const SR: u32 = 48000;

fn sine(freq: f32, frames: usize) -> Vec<f32> {
    (0..frames).map(|i| (i as f32 * freq * std::f32::consts::TAU / SR as f32).sin() * 0.5).collect()
}

/// Frequency estimate from upward zero crossings.
fn zero_cross_freq(x: &[f32]) -> f32 {
    let n = x.windows(2).filter(|w| w[0] <= 0.0 && w[1] > 0.0).count();
    n as f32 * SR as f32 / x.len() as f32
}

struct Rig {
    mixer: Mixer,
    tr: Arc<Transport>,
    cmd: rtrb::Producer<Cmd>,
    looper: Arc<LooperShared>,
    _garbage: rtrb::Consumer<Garbage>,
}

fn rig() -> Rig {
    let tr = Arc::new(Transport::new());
    let (cmd, cmd_rx) = RingBuffer::new(64);
    let (garbage_tx, _garbage) = RingBuffer::new(64);
    let (tuner_tx, _) = RingBuffer::new(8);
    let looper = Arc::new(LooperShared::new());
    let mixer = Mixer::new(SR, tr.clone(), cmd_rx, garbage_tx, tuner_tx, Looper::new(SR, looper.clone()));
    Rig { mixer, tr, cmd, looper, _garbage }
}

fn run(rig: &mut Rig, input: &[f32]) -> Vec<f32> {
    let mut out = Vec::new();
    let silence = vec![0.0; 256];
    for block in input.chunks(256) {
        let (mut l, mut r) = (vec![0.0; block.len()], vec![0.0; block.len()]);
        let z = &silence[..block.len()];
        let mut ins = [z; NUM_INPUTS];
        ins[0] = block;
        rig.mixer.process(ins, [z, z], &mut l, &mut r);
        out.extend(l);
    }
    out
}

fn track(id: u64, clips: Vec<ClipRt>) -> (Box<TrackRt>, Arc<TrackShared>) {
    let shared = Arc::new(TrackShared::new());
    (Box::new(TrackRt::new(id, shared.clone(), clips, vec![])), shared)
}

#[test]
fn every_effect_stays_finite() {
    for (kind, _) in builtin::LIST {
        let c = builtin::create(kind, SR as f32).unwrap();
        let values: Vec<f32> = c.infos.iter().map(|i| i.default).collect();
        let (mut slot, _) = FxSlot::new(1, c.fx, &values, false);
        let mut l = sine(196.0, SR as usize);
        let mut r = l.clone();
        for (a, b) in l.chunks_mut(128).zip(r.chunks_mut(128)) {
            slot.process(a, b);
        }
        assert!(l.iter().chain(&r).all(|s| s.is_finite() && s.abs() < 8.0), "{kind} misbehaved");
        assert!(l[SR as usize / 2..].iter().any(|s| s.abs() > 1e-4), "{kind} is silent");
    }
}

#[test]
fn pitch_shifter_drops_an_octave() {
    let c = builtin::create("pitch", SR as f32).unwrap();
    let (mut slot, _) = FxSlot::new(1, c.fx, &[-12.0, 0.0, 1.0], false);
    let mut l = sine(440.0, SR as usize);
    let mut r = l.clone();
    slot.process(&mut l, &mut r);
    let f = zero_cross_freq(&l[SR as usize / 4..]);
    assert!((f - 220.0).abs() < 12.0, "expected about 220 Hz, got {f}");
}

#[test]
fn clip_plays_at_its_position_and_loops() {
    let mut rig = rig();
    let data = Arc::new(AudioData::new(vec![vec![0.25; 1000]]));
    let (t, _) = track(1, vec![ClipRt { start: 500, offset: 0, len: 1000, data }]);
    rig.cmd.push(Cmd::AddTrack(t)).ok();
    rig.cmd.push(Cmd::Play).ok();
    let out = run(&mut rig, &vec![0.0; 2000]);
    assert_eq!(out[499], 0.0);
    assert_eq!(out[500], 0.25);
    assert_eq!(out[1499], 0.25);
    assert_eq!(out[1500], 0.0);

    // Loop 400..600: the clip start at 500 should come round again every 200 frames.
    rig.tr.loop_on.store(true, Relaxed);
    rig.tr.loop_start.store(400, Relaxed);
    rig.tr.loop_end.store(600, Relaxed);
    rig.cmd.push(Cmd::Seek(400)).ok();
    let out = run(&mut rig, &vec![0.0; 600]);
    assert_eq!((out[99], out[100], out[199], out[200], out[299], out[300]), (0.0, 0.25, 0.25, 0.0, 0.0, 0.25));
}

#[test]
fn monitoring_and_recording_with_count_in() {
    let mut rig = rig();
    let (t, shared) = track(7, vec![]);
    shared.input.store(0, Relaxed);
    shared.monitor.store(true, Relaxed);
    rig.cmd.push(Cmd::AddTrack(t)).ok();
    let input = vec![0.5; 1024];
    assert_eq!(run(&mut rig, &input)[10], 0.5, "monitored input should be audible while stopped");

    let (tx, mut rx) = RingBuffer::new(8192);
    rig.cmd.push(Cmd::Record { from: -256, at: 0, sinks: vec![RecSink { track: 7, tx, stereo: false }] }).ok();
    run(&mut rig, &input);
    assert_eq!(rx.slots(), 1024 - 256, "the count-in must not be recorded");
    assert_eq!(rx.pop().unwrap(), 0.5);
    rig.cmd.push(Cmd::Stop).ok();
    run(&mut rig, &input);
    assert!(!rig.tr.recording.load(Relaxed));
}

#[test]
fn loop_station_layers_in_sync() {
    let mut rig = rig();
    let (t, shared) = track(3, vec![]);
    shared.input.store(0, Relaxed);
    shared.monitor.store(true, Relaxed);
    rig.cmd.push(Cmd::AddTrack(t)).ok();
    shared.loop_mask.store(0b1111, Relaxed);
    rig.looper.count_in.store(false, Relaxed);

    rig.cmd.push(Cmd::Loop(0, LoopAction::Press)).ok();
    run(&mut rig, &vec![0.25; 4096]);
    rig.cmd.push(Cmd::Loop(0, LoopAction::Press)).ok();
    let out = run(&mut rig, &vec![0.0; 4096]);
    assert_eq!(rig.looper.len.load(Relaxed), 4096);
    assert_eq!(rig.looper.state[0].load(Relaxed), looper::PLAYING);
    assert_eq!(out[2000], 0.25, "the loop should play back what was recorded");

    // A second loop records for exactly one cycle, then both play together.
    rig.cmd.push(Cmd::Loop(1, LoopAction::Press)).ok();
    run(&mut rig, &vec![0.5; 4096]);
    let out = run(&mut rig, &vec![0.0; 4096]);
    assert_eq!(rig.looper.state[1].load(Relaxed), looper::PLAYING);
    assert_eq!(out[2000], 0.75);

    rig.cmd.push(Cmd::Loop(0, LoopAction::ToggleStop)).ok();
    assert_eq!(run(&mut rig, &vec![0.0; 4096])[2000], 0.5);
    for s in 0..looper::SLOTS {
        rig.cmd.push(Cmd::Loop(s, LoopAction::Clear)).ok();
    }
    assert_eq!(run(&mut rig, &vec![0.0; 4096])[2000], 0.0);
    assert_eq!(rig.looper.len.load(Relaxed), 0);
}

/// Needs the Guitarix LV2 plugins installed, so it only runs on request (`cargo test -- --ignored`).
#[cfg(feature = "lv2")]
#[test]
#[ignore]
fn hosts_guitarix_lv2_plugins() {
    let host = crate::fx::lv2::Lv2Host::new();
    println!("{} usable LV2 effect plugins", host.plugins.len());
    let mut ok = 0;
    let gx: Vec<_> = host.plugins.iter().filter(|p| p.uri.contains("guitarix")).collect();
    assert!(!gx.is_empty(), "no Guitarix plugins found");
    for info in &gx {
        let Ok(c) = host.create(&info.uri, SR as f32) else {
            println!("could not start {}", info.name);
            continue;
        };
        let values: Vec<f32> = c.infos.iter().map(|i| i.default).collect();
        let (mut slot, _) = FxSlot::new(1, c.fx, &values, false);
        let mut l = sine(196.0, 4800);
        let mut r = l.clone();
        for (a, b) in l.chunks_mut(128).zip(r.chunks_mut(128)) {
            slot.process(a, b);
        }
        assert!(l.iter().all(|s| s.is_finite()), "{} produced garbage", info.name);
        ok += 1;
    }
    println!("{ok} of {} Guitarix plugins ran", gx.len());
    assert!(ok * 10 >= gx.len() * 9);
}

#[test]
fn recorder_writes_a_readable_wav() {
    let path = std::env::temp_dir().join(format!("snakedaw-test-{}.wav", std::process::id()));
    let (mut tx, rx) = RingBuffer::new(4096);
    let peaks = crate::recorder::LivePeaks::default();
    let writer = crate::recorder::spawn_writer(path.clone(), SR, true, rx, peaks.clone());
    for i in 0..1000 {
        tx.push(i as f32 / 1000.0).unwrap();
        tx.push(-0.5).unwrap();
    }
    drop(tx);
    let data = writer.join().unwrap().unwrap();
    assert_eq!((data.ch.len(), data.frames()), (2, 1000));
    assert_eq!(peaks.lock().unwrap().len(), 3);
    let loaded = AudioData::load_wav(&path).unwrap();
    assert_eq!(loaded.ch[0][500], 0.5);
    assert_eq!(loaded.ch[1][999], -0.5);
    let _ = std::fs::remove_file(path);
}

#[test]
fn loop_station_counts_in_and_closes_on_a_bar() {
    let mut rig = rig();
    let (t, shared) = track(3, vec![]);
    shared.input.store(0, Relaxed);
    rig.cmd.push(Cmd::AddTrack(t)).ok();
    shared.loop_mask.store(0b1111, Relaxed);
    // 120 BPM in 4/4: a beat is 24000 frames, a bar 96000.
    let bar = 96000;
    assert!(rig.looper.count_in.load(Relaxed), "count-in should be on by default");

    rig.cmd.push(Cmd::Loop(0, LoopAction::Press)).ok();
    let out = run(&mut rig, &vec![0.0; bar]);
    assert_eq!(rig.looper.state[0].load(Relaxed), looper::RECORDING, "recording starts after one bar");
    for beat in 0..4 {
        let at = beat * 24000;
        assert!(out[at + 1..at + 400].iter().any(|s| s.abs() > 0.1), "no click on count-in beat {}", beat + 1);
        assert!(out[at + 12000..at + 12400].iter().all(|s| s.abs() < 0.01), "click between beats");
    }

    // Stop a little late (2.1 bars): the loop is trimmed back to exactly two bars.
    run(&mut rig, &vec![0.0; bar * 2 + 9600]);
    rig.cmd.push(Cmd::Loop(0, LoopAction::Press)).ok();
    run(&mut rig, &vec![0.0; 256]);
    assert_eq!(rig.looper.len.load(Relaxed) as usize, bar * 2);
    assert_eq!(rig.looper.state[0].load(Relaxed), looper::PLAYING);

    // Stop early (0.9 bars): recording carries on until the bar is complete.
    rig.cmd.push(Cmd::Loop(0, LoopAction::Clear)).ok();
    rig.looper.count_in.store(false, Relaxed);
    rig.looper.click.store(true, Relaxed);
    rig.cmd.push(Cmd::Loop(1, LoopAction::Press)).ok();
    run(&mut rig, &vec![0.0; bar * 9 / 10]);
    rig.cmd.push(Cmd::Loop(1, LoopAction::Press)).ok();
    run(&mut rig, &vec![0.0; 256]);
    assert_eq!(rig.looper.state[1].load(Relaxed), looper::RECORDING);
    run(&mut rig, &vec![0.0; bar / 10]);
    assert_eq!(rig.looper.state[1].load(Relaxed), looper::PLAYING);
    assert_eq!(rig.looper.len.load(Relaxed) as usize, bar);
}

#[test]
fn loop_station_accepts_imported_audio() {
    let mut rig = rig();
    let cap = SR as usize * looper::MAX_SECONDS;
    let mut bufs: looper::LoopBuf = Box::new([vec![0.0; cap], vec![0.0; cap]]);
    bufs[0][..8192].fill(0.3);
    bufs[1][..8192].fill(0.3);
    rig.cmd.push(Cmd::LoopLoad { slot: 2, bufs, len: 8192 }).ok();
    let out = run(&mut rig, &vec![0.0; 8192 * 2]);
    assert_eq!(rig.looper.len.load(Relaxed), 8192);
    assert_eq!(rig.looper.state[2].load(Relaxed), looper::PLAYING);
    assert_eq!((out[100], out[8192 + 100]), (0.3, 0.3), "the imported loop should repeat");
}

#[test]
fn each_loop_records_only_its_own_tracks() {
    let mut rig = rig();
    // Track 1 listens to input 1 and feeds loop 1; track 2 listens to input 2 and feeds loop 2.
    for (id, input, mask) in [(1, 0, 0b01), (2, 1, 0b10)] {
        let (t, shared) = track(id, vec![]);
        shared.input.store(input, Relaxed);
        shared.monitor.store(true, Relaxed);
        shared.loop_mask.store(mask, Relaxed);
        rig.cmd.push(Cmd::AddTrack(t)).ok();
    }
    rig.looper.count_in.store(false, Relaxed);
    let (a, b, silence) = (vec![0.25; 256], vec![0.5; 256], vec![0.0; 256]);
    // Run 16 blocks and report a sample from the middle, away from the fades at the loop point.
    let play = |rig: &mut Rig, in1: &[f32], in2: &[f32]| {
        let (mut l, mut r) = (vec![0.0; 256], vec![0.0; 256]);
        let mut middle = 0.0;
        for block in 0..16 {
            let mut ins: [&[f32]; NUM_INPUTS] = [&silence; NUM_INPUTS];
            (ins[0], ins[1]) = (in1, in2);
            rig.mixer.process(ins, [&silence, &silence], &mut l, &mut r);
            if block == 8 {
                middle = l[100];
            }
        }
        middle
    };

    rig.cmd.push(Cmd::Loop(0, LoopAction::Press)).ok();
    play(&mut rig, &a, &b);
    rig.cmd.push(Cmd::Loop(0, LoopAction::Press)).ok();
    assert_eq!(play(&mut rig, &silence, &silence), 0.25, "loop 1 should hold track 1 only");

    rig.cmd.push(Cmd::Loop(1, LoopAction::Press)).ok();
    play(&mut rig, &a, &b);
    rig.cmd.push(Cmd::Loop(0, LoopAction::ToggleStop)).ok();
    assert_eq!(play(&mut rig, &silence, &silence), 0.5, "loop 2 should hold track 2 only");
}
