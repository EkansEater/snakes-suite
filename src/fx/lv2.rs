//! Hosting of LV2 effect plugins (e.g. the Guitarix gx_* set).

use super::{Created, Fx, ParamInfo};
use crate::engine::MAX_BLOCK;
use anyhow::{anyhow, Result};
use livi::{PortIndex, PortType};
use std::sync::Arc;

pub struct Lv2Info {
    pub uri: String,
    pub name: String,
}

pub struct Lv2Host {
    world: livi::World,
    features: Arc<livi::Features>,
    /// Plugins usable as a track effect: 1-2 audio ins and outs, no MIDI/CV ports.
    pub plugins: Vec<Lv2Info>,
}

impl Lv2Host {
    pub fn new() -> Self {
        let world = livi::World::new();
        let features = world.build_features(livi::FeaturesBuilder { min_block_length: 1, max_block_length: MAX_BLOCK });
        let mut plugins: Vec<Lv2Info> = world
            .iter_plugins()
            .filter(|p| {
                let c = p.port_counts();
                (1..=2).contains(&c.audio_inputs)
                    && (1..=2).contains(&c.audio_outputs)
                    && c.atom_sequence_inputs + c.atom_sequence_outputs + c.cv_inputs + c.cv_outputs == 0
            })
            .map(|p| Lv2Info { uri: p.uri(), name: p.name() })
            .collect();
        plugins.sort_by_key(|p| p.name.to_lowercase());

        // Some plugins hand slow work (loading files etc.) to a non-realtime worker.
        let workers = features.clone();
        std::thread::Builder::new()
            .name("lv2-worker".into())
            .spawn(move || loop {
                workers.worker_manager().run_workers();
                std::thread::sleep(std::time::Duration::from_millis(50));
            })
            .ok();

        Self { world, features, plugins }
    }

    pub fn create(&self, uri: &str, sr: f32) -> Result<Created> {
        let plugin = self.world.plugin_by_uri(uri).ok_or_else(|| anyhow!("plugin is not installed"))?;
        let inst = unsafe { plugin.instantiate(self.features.clone(), sr as f64) }
            .map_err(|e| anyhow!("could not start plugin: {e:?}"))?;
        let mut infos = Vec::new();
        let mut controls = Vec::new();
        for port in plugin.ports_with_type(PortType::ControlInput) {
            let min = port.min_value.filter(|v| v.is_finite()).unwrap_or(0.0);
            let max = port.max_value.filter(|v| v.is_finite()).unwrap_or(1.0).max(min);
            let default = if port.default_value.is_finite() { port.default_value.clamp(min, max) } else { min };
            infos.push(ParamInfo { name: port.name.clone(), min, max, default, unit: "", log: false, step: 0.0 });
            controls.push(port.index);
        }
        let counts = *plugin.port_counts();
        let fx = Lv2Fx {
            inst,
            controls,
            inb: vec![vec![0.0; MAX_BLOCK]; counts.audio_inputs],
            outb: vec![vec![0.0; MAX_BLOCK]; counts.audio_outputs],
        };
        Ok(Created { fx: Box::new(fx), name: plugin.name(), infos })
    }
}

struct Lv2Fx {
    inst: livi::Instance,
    controls: Vec<PortIndex>,
    inb: Vec<Vec<f32>>,
    outb: Vec<Vec<f32>>,
}

impl Fx for Lv2Fx {
    fn set_param(&mut self, idx: usize, value: f32) {
        if let Some(port) = self.controls.get(idx) {
            self.inst.set_control_input(*port, value);
        }
    }

    fn process(&mut self, l: &mut [f32], r: &mut [f32]) {
        let n = l.len().min(MAX_BLOCK);
        if self.inb.len() == 1 {
            // Mono plugin: feed it the sum of both channels.
            for i in 0..n {
                self.inb[0][i] = (l[i] + r[i]) * 0.5;
            }
        } else {
            self.inb[0][..n].copy_from_slice(&l[..n]);
            self.inb[1][..n].copy_from_slice(&r[..n]);
        }
        let ports = livi::EmptyPortConnections::new()
            .with_audio_inputs(self.inb.iter().map(|b| &b[..n]))
            .with_audio_outputs(self.outb.iter_mut().map(|b| &mut b[..n]));
        if unsafe { self.inst.run(n, ports) }.is_err() {
            return;
        }
        l[..n].copy_from_slice(&self.outb[0][..n]);
        r[..n].copy_from_slice(&self.outb.last().unwrap()[..n]);
    }
}
