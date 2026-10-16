//! The JNI facade the Compose UI talks to (com.snake.suite.daw.NativeDaw).
//!
//! The desktop App (app.rs) owns cpal streams, which must stay on the thread that
//! made them, so it lives on one control thread. Every call from Kotlin becomes a
//! job on that thread:
//!
//!   start(context, home, config) -> error or null   creates the App (opens audio)
//!   stop()                                           saves and closes audio
//!   state() -> JSON                                  tick() + a snapshot for the UI
//!   call(op, json) -> JSON                           one change (see `op`)
//!   peaks(file, buckets) -> JSON                     waveform of one audio file

use crate::app::{App, Preset};
use crate::fx;
use crate::looper::{self, LoopAction};
use crate::project::{Config, InputSel};
use crate::util::gain_to_db;
use anyhow::{anyhow, Result};
use crossbeam_channel::{bounded, unbounded, Sender};
use jni::objects::{GlobalRef, JClass, JObject, JString};
use jni::sys::{jint, jstring};
use jni::JNIEnv;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::atomic::Ordering::Relaxed;
use std::sync::{Mutex, OnceLock};

type Job = Box<dyn FnOnce(&mut Option<App>) + Send>;

static CONTROL: OnceLock<Sender<Job>> = OnceLock::new();
static CONTEXT: Mutex<Option<GlobalRef>> = Mutex::new(None);

/// Run `f` on the control thread and wait for its answer.
fn run<T: Send + 'static>(f: impl FnOnce(&mut Option<App>) -> T + Send + 'static) -> T {
    let tx = CONTROL.get_or_init(|| {
        let (tx, rx) = unbounded::<Job>();
        std::thread::Builder::new()
            .name("daw-control".into())
            .spawn(move || {
                let mut app: Option<App> = None;
                for job in rx {
                    job(&mut app);
                }
            })
            .expect("control thread");
        tx
    });
    let (reply_tx, reply_rx) = bounded(1);
    let _ = tx.send(Box::new(move |app| {
        let _ = reply_tx.send(f(app));
    }));
    reply_rx.recv().expect("control thread stopped")
}

fn jstr(env: &mut JNIEnv, s: &JString) -> String {
    env.get_string(s).map(|s| s.into()).unwrap_or_default()
}

fn out(env: &mut JNIEnv, s: String) -> jstring {
    env.new_string(s).map(|s| s.into_raw()).unwrap_or(std::ptr::null_mut())
}

// ---------------------------------------------------------------- lifecycle

#[no_mangle]
pub extern "system" fn Java_com_snake_suite_daw_NativeDaw_start(
    mut env: JNIEnv, _: JClass, context: JObject, home: JString, config: JString,
) -> jstring {
    // cpal finds Android's audio devices through the app's Context.
    {
        let mut ctx = CONTEXT.lock().unwrap();
        if ctx.is_none() {
            if let (Ok(vm), Ok(global)) = (env.get_java_vm(), env.new_global_ref(&context)) {
                unsafe { ndk_context::initialize_android_context(vm.get_java_vm_pointer().cast(), global.as_obj().as_raw().cast()) };
                *ctx = Some(global);
            }
        }
    }
    // dirs:: reads these: projects go to $HOME/SnakeDAW, settings to $XDG_CONFIG_HOME/snakedaw.
    std::env::set_var("HOME", jstr(&mut env, &home));
    std::env::set_var("XDG_CONFIG_HOME", jstr(&mut env, &config));
    let err = run(|app| {
        if app.is_some() {
            return None;
        }
        match App::new(Config::load()) {
            Ok(a) => {
                *app = Some(a);
                None
            }
            Err(e) => Some(format!("{e:#}")),
        }
    });
    match err {
        Some(e) => out(&mut env, e),
        None => std::ptr::null_mut(),
    }
}

/// Save and close the sound card (when the app leaves the screen with nothing running).
#[no_mangle]
pub extern "system" fn Java_com_snake_suite_daw_NativeDaw_stop(_: JNIEnv, _: JClass) {
    run(|app| {
        // Dropping the App saves the project and settings (app.rs `impl Drop`).
        *app = None;
    });
}

#[no_mangle]
pub extern "system" fn Java_com_snake_suite_daw_NativeDaw_state(mut env: JNIEnv, _: JClass) -> jstring {
    let s = run(|app| match app {
        Some(a) => {
            a.tick();
            snapshot(a).to_string()
        }
        None => "null".into(),
    });
    out(&mut env, s)
}

#[no_mangle]
pub extern "system" fn Java_com_snake_suite_daw_NativeDaw_call(mut env: JNIEnv, _: JClass, op: JString, args: JString) -> jstring {
    let op = jstr(&mut env, &op);
    let args: Value = serde_json::from_str(&jstr(&mut env, &args)).unwrap_or(Value::Null);
    let s = run(move |app| {
        let result = match app {
            Some(a) => call(a, &op, &args),
            None => Err(anyhow!("audio is not running")),
        };
        match result {
            Ok(v) => json!({ "ok": v }),
            Err(e) => json!({ "error": format!("{e:#}") }),
        }
        .to_string()
    });
    out(&mut env, s)
}

/// `{"frames": n, "peaks": [min, max, ...]}`: an audio file in `buckets` columns, for drawing its waveform.
#[no_mangle]
pub extern "system" fn Java_com_snake_suite_daw_NativeDaw_peaks(mut env: JNIEnv, _: JClass, file: JString, buckets: jint) -> jstring {
    let file = jstr(&mut env, &file);
    let s = run(move |app| {
        let empty = r#"{"frames":0,"peaks":[]}"#.to_string();
        let Some(a) = app else { return empty };
        let Some(data) = a.cache.get(&file) else { return empty };
        let peaks = &data.peaks;
        let n = (buckets.max(1) as usize).min(peaks.len().max(1));
        let per = peaks.len() as f64 / n as f64;
        let mut v = Vec::with_capacity(n * 2);
        for i in 0..n {
            let (s, e) = ((i as f64 * per) as usize, (((i + 1) as f64 * per) as usize).max((i as f64 * per) as usize + 1));
            let (mut lo, mut hi) = (0f32, 0f32);
            for p in &peaks[s.min(peaks.len())..e.min(peaks.len())] {
                lo = lo.min(p.0);
                hi = hi.max(p.1);
            }
            v.push((lo * 1000.0).round() / 1000.0);
            v.push((hi * 1000.0).round() / 1000.0);
        }
        json!({ "frames": data.frames(), "peaks": v }).to_string()
    });
    out(&mut env, s)
}

// ---------------------------------------------------------------- snapshot

fn snapshot(a: &mut App) -> Value {
    let tr = &a.tr;
    let meters: serde_json::Map<String, Value> = a
        .shared
        .iter()
        .map(|(id, s)| (id.to_string(), json!([s.peak_l.take(), s.peak_r.take()])))
        .collect();
    let fx_info: serde_json::Map<String, Value> = a
        .fx
        .iter()
        .map(|(id, h)| {
            let params: Vec<Value> = h
                .infos
                .iter()
                .map(|p| json!({ "name": p.name, "min": p.min, "max": p.max, "default": p.default, "unit": p.unit, "log": p.log, "step": p.step }))
                .collect();
            (id.to_string(), json!({ "name": h.name, "params": params }))
        })
        .collect();
    let lp = &a.looper;
    let sys = a.io.system();
    let recs: Vec<Value> = a.recs.iter().map(|r| json!({ "track": r.track, "frames": r.peaks.lock().map(|p| p.len() * crate::audio::PEAK_CHUNK).unwrap_or(0) })).collect();
    json!({
        "project": a.project,
        "dir": a.dir,
        "projectsDir": a.cfg.projects_dir,
        "sr": a.io.sample_rate,
        "pos": a.pos(),
        "playing": tr.playing.load(Relaxed),
        "recording": a.is_recording() || tr.recording.load(Relaxed),
        "recAt": a.rec_at,
        "recs": recs,
        "status": a.status,
        "export": a.export.as_ref().map(|e| e.progress.get()),
        "meters": meters,
        "master": [tr.master_peak_l.take(), tr.master_peak_r.take()],
        "inputPeaks": tr.input_peaks.iter().map(|p| p.take()).collect::<Vec<_>>(),
        "xruns": tr.xruns.load(Relaxed),
        "cpu": a.io.cpu_load(),
        "buffer": a.io.buffer_size(),
        "latency": a.io.roundtrip_latency(),
        "inputsAvailable": a.inputs_available,
        "fxInfo": fx_info,
        "selTrack": a.ui.sel_track,
        "selClip": a.ui.sel_clip,
        "tunerOn": a.ui.show_tuner,
        "tuner": a.tuner.reading.as_ref().map(|r| json!({ "note": r.note, "freq": r.freq, "cents": r.cents })),
        "looper": {
            "state": lp.state.iter().map(|s| s.load(Relaxed)).collect::<Vec<_>>(),
            "gain": lp.gain.iter().map(|g| g.get()).collect::<Vec<_>>(),
            "len": lp.len.load(Relaxed),
            "pos": lp.pos.load(Relaxed),
            "countIn": lp.count_in.load(Relaxed),
            "click": lp.click.load(Relaxed),
        },
        "audio": {
            "input": sys.map(|s| s.input_name.clone()),
            "output": sys.map(|s| s.output_name.clone()),
            "inputProblem": sys.and_then(|s| s.input_problem.clone()),
            "inputDevices": sys.map(|s| s.input_devices.clone()).unwrap_or_default(),
            "outputDevices": sys.map(|s| s.output_devices.clone()).unwrap_or_default(),
            "bufferSize": a.cfg.buffer_size,
            "recOffsetMs": a.cfg.rec_offset_ms,
            "deviceIn": a.cfg.device_in,
            "deviceOut": a.cfg.device_out,
        },
    })
}

// ---------------------------------------------------------------- operations

fn id(v: &Value, key: &str) -> Result<u64> {
    v.get(key).and_then(Value::as_u64).ok_or_else(|| anyhow!("missing {key}"))
}

fn f(v: &Value, key: &str) -> Result<f64> {
    v.get(key).and_then(Value::as_f64).ok_or_else(|| anyhow!("missing {key}"))
}

fn b(v: &Value, key: &str) -> Result<bool> {
    v.get(key).and_then(Value::as_bool).ok_or_else(|| anyhow!("missing {key}"))
}

fn s<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v.get(key).and_then(Value::as_str).ok_or_else(|| anyhow!("missing {key}"))
}

fn call(a: &mut App, op: &str, v: &Value) -> Result<Value> {
    match op {
        // transport
        "play" => a.toggle_play(),
        "stop" => a.stop(),
        "record" => a.toggle_record(),
        "seek" => a.seek(f(v, "pos")? as i64),

        // editing
        "undo" => a.undo(),
        "redo" => a.redo(),
        "split" => a.split(),
        "delete" => a.delete_selected(),
        "duplicate" => a.duplicate_selected(),
        "select" => {
            a.ui.sel_track = v.get("track").and_then(Value::as_u64).or(a.ui.sel_track);
            a.ui.sel_clip = match (v.get("track").and_then(Value::as_u64), v.get("clip").and_then(Value::as_u64)) {
                (Some(t), Some(c)) => Some((t, c)),
                _ => None,
            };
        }
        // A drag starts with begin_edit (one undo step), then moves and trims as it goes.
        "begin_edit" => a.push_undo(),
        "clip" => {
            let (track, clip) = (id(v, "track")?, id(v, "clip")?);
            let t = a.project.tracks.iter_mut().find(|t| t.id == track).ok_or_else(|| anyhow!("no such track"))?;
            let c = t.clips.iter_mut().find(|c| c.id == clip).ok_or_else(|| anyhow!("no such clip"))?;
            if let Some(start) = v.get("start").and_then(Value::as_i64) {
                c.start = start.max(0);
            }
            if let Some(offset) = v.get("offset").and_then(Value::as_u64) {
                c.offset = offset;
            }
            if let Some(len) = v.get("len").and_then(Value::as_u64) {
                c.len = len.max(1);
            }
            a.sync_clips(track);
        }
        "save" => a.save(),

        // tracks
        "add_track" => a.add_track(match s(v, "preset")? {
            "guitar" => Preset::Guitar,
            "mic" => Preset::Mic,
            _ => Preset::Empty,
        }),
        "remove_track" => a.remove_track(id(v, "id")?),
        "track" => {
            let tid = id(v, "id")?;
            let t = a.project.tracks.iter_mut().find(|t| t.id == tid).ok_or_else(|| anyhow!("no such track"))?;
            let val = v.get("value").cloned().unwrap_or(Value::Null);
            match s(v, "field")? {
                "name" => t.name = val.as_str().unwrap_or(&t.name).to_string(),
                "volume_db" => t.volume_db = val.as_f64().unwrap_or(0.0) as f32,
                "pan" => t.pan = val.as_f64().unwrap_or(0.0).clamp(-1.0, 1.0) as f32,
                "mute" => t.mute = val.as_bool().unwrap_or(false),
                "solo" => t.solo = val.as_bool().unwrap_or(false),
                "arm" => t.arm = val.as_bool().unwrap_or(false),
                "monitor" => t.monitor = val.as_bool().unwrap_or(false),
                "fx_on" => t.fx_on = val.as_bool().unwrap_or(true),
                "input" => {
                    t.input = match val.as_i64() {
                        Some(n) if n >= 0 => InputSel::Hw(n as u8),
                        _ => InputSel::None,
                    }
                }
                other => return Err(anyhow!("unknown track field {other}")),
            }
            a.save();
        }

        // effects
        "fx_kinds" => return Ok(json!(fx::builtin::LIST.iter().map(|(k, n)| json!({ "kind": k, "name": n })).collect::<Vec<_>>())),
        "add_fx" => a.add_fx(id(v, "track")?, s(v, "kind")?),
        "remove_fx" => a.remove_fx(id(v, "track")?, id(v, "fx")?),
        "move_fx" => a.move_fx(id(v, "track")?, id(v, "fx")?, f(v, "by")? as i32),
        "fx" => {
            let fid = id(v, "fx")?;
            let def = a.project.tracks.iter_mut().flat_map(|t| t.fx.iter_mut()).find(|x| x.id == fid).ok_or_else(|| anyhow!("no such effect"))?;
            if let Some(bypass) = v.get("bypass").and_then(Value::as_bool) {
                def.bypass = bypass;
            }
            if let (Some(i), Some(val)) = (v.get("index").and_then(Value::as_u64), v.get("value").and_then(Value::as_f64)) {
                if let Some(p) = def.params.get_mut(i as usize) {
                    *p = val as f32;
                }
            }
        }

        // project settings
        "project" => {
            let p = &mut a.project;
            let val = v.get("value").cloned().unwrap_or(Value::Null);
            match s(v, "field")? {
                "name" => p.name = val.as_str().unwrap_or(&p.name).trim().to_string(),
                "bpm" => p.bpm = (val.as_f64().unwrap_or(120.0) as f32).clamp(20.0, 300.0),
                "beats_per_bar" => p.beats_per_bar = val.as_u64().unwrap_or(4).clamp(1, 16) as u32,
                "master_db" => p.master_db = val.as_f64().unwrap_or(0.0) as f32,
                "metronome" => p.metronome = val.as_bool().unwrap_or(false),
                "count_in" => p.count_in = val.as_bool().unwrap_or(false),
                "loop_on" => p.loop_on = val.as_bool().unwrap_or(false),
                "loop_start" => p.loop_start = val.as_i64().unwrap_or(0).max(0),
                "loop_end" => p.loop_end = val.as_i64().unwrap_or(0).max(0),
                other => return Err(anyhow!("unknown project field {other}")),
            }
            a.save();
        }
        "new_project" => a.new_project(s(v, "name")?),
        "open_project" => a.open_project(&PathBuf::from(s(v, "path")?))?,
        "projects" => {
            return Ok(json!(a
                .list_projects()
                .iter()
                .map(|p| json!({ "path": p, "name": p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default() }))
                .collect::<Vec<_>>()))
        }
        "export" => a.start_export(),

        // loop station
        "loop" => {
            let slot = (f(v, "slot")? as usize).min(looper::SLOTS - 1);
            let action = match s(v, "action")? {
                "press" => LoopAction::Press,
                "stop" => LoopAction::ToggleStop,
                _ => LoopAction::Clear,
            };
            a.loop_action(slot, action);
        }
        "loop_source" => {
            let slot = (f(v, "slot")? as usize).min(looper::SLOTS - 1);
            let track = id(v, "track")?;
            let list = &mut a.project.loop_sources[slot];
            list.retain(|t| *t != track);
            if b(v, "on")? {
                list.push(track);
            }
        }
        "loop_import" => a.import_loop_region((f(v, "slot")? as usize).min(looper::SLOTS - 1), id(v, "track")?),
        "looper" => {
            if let Some(x) = v.get("countIn").and_then(Value::as_bool) {
                a.looper.count_in.store(x, Relaxed);
            }
            if let Some(x) = v.get("click").and_then(Value::as_bool) {
                a.looper.click.store(x, Relaxed);
            }
            if let (Some(slot), Some(g)) = (v.get("slot").and_then(Value::as_u64), v.get("gain").and_then(Value::as_f64)) {
                if let Some(x) = a.looper.gain.get(slot as usize) {
                    x.set(g as f32);
                }
            }
        }

        // tools and settings
        "tuner" => a.ui.show_tuner = b(v, "on")?,
        "status" => a.status.clear(),
        "settings" => {
            if let Some(x) = v.get("bufferSize").and_then(Value::as_u64) {
                a.cfg.buffer_size = x as u32;
            }
            if let Some(x) = v.get("recOffsetMs").and_then(Value::as_f64) {
                a.cfg.rec_offset_ms = x as f32;
            }
            if let Some(x) = v.get("deviceIn").and_then(Value::as_str) {
                a.cfg.device_in = x.into();
            }
            if let Some(x) = v.get("deviceOut").and_then(Value::as_str) {
                a.cfg.device_out = x.into();
            }
            a.cfg.save();
        }
        "db" => return Ok(json!(gain_to_db(f(v, "gain")? as f32))),
        other => return Err(anyhow!("unknown operation {other}")),
    }
    Ok(Value::Null)
}
