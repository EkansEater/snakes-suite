//! Effects: a small built-in set plus hosted LV2 plugins.

pub mod builtin;
#[cfg(feature = "lv2")]
pub mod lv2;
#[cfg(not(feature = "lv2"))]
#[path = "lv2_stub.rs"]
pub mod lv2;

use crate::util::AtomicF32;
use std::sync::atomic::{AtomicBool, Ordering::Relaxed};
use std::sync::Arc;

#[derive(Clone, Debug)]
pub struct ParamInfo {
    pub name: String,
    pub min: f32,
    pub max: f32,
    pub default: f32,
    pub unit: &'static str,
    pub log: bool,
    /// Slider increment; 0 means continuous.
    pub step: f32,
}

/// A stereo, in-place effect that runs on the audio thread.
pub trait Fx: Send {
    fn set_param(&mut self, idx: usize, value: f32);
    fn process(&mut self, l: &mut [f32], r: &mut [f32]);
}

/// Values the UI writes and the audio thread reads.
pub struct FxShared {
    pub bypass: AtomicBool,
    pub params: Vec<AtomicF32>,
}

/// One effect in a track's chain, owned by the audio thread.
pub struct FxSlot {
    pub id: u64,
    shared: Arc<FxShared>,
    last: Vec<f32>,
    fx: Box<dyn Fx>,
}

impl FxSlot {
    pub fn new(id: u64, fx: Box<dyn Fx>, values: &[f32], bypass: bool) -> (Self, Arc<FxShared>) {
        let shared = Arc::new(FxShared {
            bypass: AtomicBool::new(bypass),
            params: values.iter().map(|v| AtomicF32::new(*v)).collect(),
        });
        // NaN never compares equal, so the first block pushes every parameter into the effect.
        let slot = Self { id, shared: shared.clone(), last: vec![f32::NAN; values.len()], fx };
        (slot, shared)
    }

    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        for (i, p) in self.shared.params.iter().enumerate() {
            let v = p.get();
            if v != self.last[i] {
                self.last[i] = v;
                self.fx.set_param(i, v);
            }
        }
        if !self.shared.bypass.load(Relaxed) {
            self.fx.process(l, r);
        }
    }
}

/// Stands in for an effect that could not be created (e.g. an uninstalled LV2 plugin).
pub struct Passthrough;

impl Fx for Passthrough {
    fn set_param(&mut self, _: usize, _: f32) {}
    fn process(&mut self, _: &mut [f32], _: &mut [f32]) {}
}

pub struct Created {
    pub fx: Box<dyn Fx>,
    pub name: String,
    pub infos: Vec<ParamInfo>,
}

/// Create an effect from its saved `kind`: a built-in key, or `lv2:<plugin uri>`.
pub fn create(kind: &str, sr: f32, host: &lv2::Lv2Host) -> Created {
    if let Some(uri) = kind.strip_prefix("lv2:") {
        match host.create(uri, sr) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("LV2 {uri}: {e:#}");
                Created { fx: Box::new(Passthrough), name: format!("Missing plugin: {uri}"), infos: vec![] }
            }
        }
    } else {
        builtin::create(kind, sr).unwrap_or(Created {
            fx: Box::new(Passthrough),
            name: format!("Unknown effect: {kind}"),
            infos: vec![],
        })
    }
}
