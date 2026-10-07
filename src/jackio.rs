//! Linux backend: a direct connection to the audio server (JACK API, provided by PipeWire or JACK).
//! Lowest latency, per-port routing, and it is what makes desktop audio capture possible.

use crate::desktop::SINK_LABEL;
use crate::engine::{Mixer, Transport, NUM_INPUTS};
use crate::project::Config;
use anyhow::{Context, Result};
use jack::{AudioIn, AudioOut, Client, ClientOptions, Control, LatencyType, Port, PortFlags, ProcessScope};
use std::sync::atomic::Ordering::Relaxed;
use std::sync::Arc;

const AUDIO_TYPE: &str = "32 bit float mono audio";

struct Proc {
    mixer: Mixer,
    ins: [Port<AudioIn>; NUM_INPUTS],
    desk: [Port<AudioIn>; 2],
    out_l: Port<AudioOut>,
    out_r: Port<AudioOut>,
}

impl jack::ProcessHandler for Proc {
    fn process(&mut self, _: &Client, ps: &ProcessScope) -> Control {
        crate::engine::no_denormals();
        let ins: [&[f32]; NUM_INPUTS] = std::array::from_fn(|i| self.ins[i].as_slice(ps));
        let desk = [self.desk[0].as_slice(ps), self.desk[1].as_slice(ps)];
        self.mixer.process(ins, desk, self.out_l.as_mut_slice(ps), self.out_r.as_mut_slice(ps));
        Control::Continue
    }
}

struct Notif(Arc<Transport>);

impl jack::NotificationHandler for Notif {
    fn xrun(&mut self, _: &Client) -> Control {
        self.0.xruns.fetch_add(1, Relaxed);
        Control::Continue
    }
}

pub struct JackIo {
    active: jack::AsyncClient<Notif, Proc>,
    pub sample_rate: u32,
    name: String,
}

impl JackIo {
    pub fn start(transport: Arc<Transport>, build: impl FnOnce(u32) -> Mixer) -> Result<Self> {
        let (client, _) = Client::new("SnakeDAW", ClientOptions::NO_START_SERVER)
            .context("could not connect to the audio server (is PipeWire with pipewire-jack running?)")?;
        let sample_rate = client.sample_rate() as u32;
        let name = client.name().to_string();
        let ins: Vec<Port<AudioIn>> =
            (1..=NUM_INPUTS).map(|i| client.register_port(&format!("in_{i}"), AudioIn::default())).collect::<Result<_, _>>()?;
        let Ok(ins) = <[Port<AudioIn>; NUM_INPUTS]>::try_from(ins) else { anyhow::bail!("could not create the input ports") };
        let desk = [
            client.register_port("desktop_L", AudioIn::default())?,
            client.register_port("desktop_R", AudioIn::default())?,
        ];
        let out_l = client.register_port("out_L", AudioOut::default())?;
        let out_r = client.register_port("out_R", AudioOut::default())?;
        let proc = Proc { mixer: build(sample_rate), ins, desk, out_l, out_r };
        let active = client.activate_async(Notif(transport), proc)?;
        Ok(Self { active, sample_rate, name })
    }

    /// True if an audio server that speaks JACK is running.
    pub fn available() -> bool {
        // The JACK library is loaded on demand; treat a missing library like a missing server.
        std::panic::catch_unwind(|| Client::new("SnakeDAW-probe", ClientOptions::NO_START_SERVER).is_ok()).unwrap_or(false)
    }

    fn client(&self) -> &Client {
        self.active.as_client()
    }

    fn own(&self, port: &str) -> String {
        format!("{}:{}", self.name, port)
    }

    /// Ports we can record from (other programs' outputs and hardware inputs).
    pub fn capture_ports(&self) -> Vec<String> {
        let own = format!("{}:", self.name);
        let mut v = self.client().ports(None, Some(AUDIO_TYPE), PortFlags::IS_OUTPUT);
        v.retain(|p| !p.starts_with(&own));
        v
    }

    /// Ports we can play into (hardware outputs).
    pub fn playback_ports(&self) -> Vec<String> {
        let own = format!("{}:", self.name);
        let mut v = self.client().ports(None, Some(AUDIO_TYPE), PortFlags::IS_INPUT);
        v.retain(|p| !p.starts_with(&own));
        v
    }

    /// The inputs of the most likely recording interface, in order.
    ///
    /// Multi-channel interfaces show up either as one mono port per input or as numbered
    /// "AUX" channels; ordinary sound cards as a left/right pair. Interfaces win over sound cards.
    pub fn auto_inputs(&self) -> Vec<String> {
        let ports: Vec<String> = self.capture_ports().into_iter().filter(|p| p.contains(":capture_")).collect();
        let first_device = |mut v: Vec<String>| {
            natural_sort(&mut v);
            let device = v.first().map(|p| device_of(p).to_string());
            v.retain(|p| Some(device_of(p)) == device.as_deref());
            v
        };
        let mut mono: Vec<String> = ports.iter().filter(|p| p.ends_with(":capture_MONO")).cloned().collect();
        if !mono.is_empty() {
            natural_sort(&mut mono);
            return mono;
        }
        let aux: Vec<String> = ports.iter().filter(|p| p.contains(":capture_AUX")).cloned().collect();
        if !aux.is_empty() {
            return first_device(aux);
        }
        if !ports.is_empty() {
            return first_device(ports);
        }
        // A plain JACK server: its hardware inputs in the order it lists them.
        let own = format!("{}:", self.name);
        let mut physical = self.client().ports(None, Some(AUDIO_TYPE), PortFlags::IS_OUTPUT | PortFlags::IS_PHYSICAL);
        physical.retain(|p| !p.starts_with(&own));
        physical
    }

    /// The stereo output to play through: the one belonging to the recording interface if there
    /// is one, otherwise the first ordinary sound card (monitors/HDMI last).
    pub fn auto_outputs(&self) -> Option<(String, String)> {
        let ports = self.playback_ports();
        let input_device = self.auto_inputs().first().map(|p| device_of(p).to_string()).unwrap_or_default();
        let mut lefts: Vec<&String> =
            ports.iter().filter(|p| p.ends_with(":playback_FL") && !p.contains(SINK_LABEL)).collect();
        lefts.sort_by_key(|p| {
            let shared = common_prefix(device_of(p), &input_device);
            let screen = p.contains("HDMI") || p.contains("DisplayPort");
            (std::cmp::Reverse(if shared >= 5 { shared } else { 0 }), screen, p.len(), p.to_string())
        });
        if let Some(left) = lefts.first() {
            let right = format!("{}:playback_FR", device_of(left));
            if ports.contains(&right) {
                return Some((left.to_string(), right));
            }
        }
        // No left/right pair: use the first two channels of whatever hardware output exists.
        let own = format!("{}:", self.name);
        let mut physical = self.client().ports(None, Some(AUDIO_TYPE), PortFlags::IS_INPUT | PortFlags::IS_PHYSICAL);
        physical.retain(|p| !p.starts_with(&own));
        let mut aux: Vec<String> = ports.iter().filter(|p| p.contains(":playback_AUX")).cloned().collect();
        natural_sort(&mut aux);
        let pair = if aux.len() >= 2 { aux } else { physical };
        Some((pair.first()?.clone(), pair.get(1)?.clone()))
    }

    /// Pick the port for a config entry: "" = detect automatically, "none" = leave unconnected.
    fn resolve(setting: &str, ports: &[String], auto: Option<String>) -> Option<String> {
        match setting {
            "none" => None,
            "" => auto,
            name => ports.iter().find(|p| p.as_str() == name).cloned(),
        }
    }

    pub fn resolve_input(&self, cfg: &Config, i: usize) -> Option<String> {
        let setting = cfg.inputs.get(i).map_or("", |s| s.as_str());
        let auto = if setting.is_empty() { self.auto_inputs().get(i).cloned() } else { None };
        Self::resolve(setting, &self.capture_ports(), auto)
    }

    pub fn resolve_output(&self, cfg: &Config, right: bool) -> Option<String> {
        let setting = if right { &cfg.out_r } else { &cfg.out_l };
        let auto = if setting.is_empty() { self.auto_outputs().map(|(l, r)| if right { r } else { l }) } else { None };
        Self::resolve(setting, &self.playback_ports(), auto)
    }

    /// How many of our inputs have something to listen to.
    pub fn input_count(&self, cfg: &Config) -> usize {
        (0..NUM_INPUTS).rev().find(|i| self.resolve_input(cfg, *i).is_some()).map_or(0, |i| i + 1)
    }

    fn connect_only(&self, own_port: &str, other: Option<String>, own_is_input: bool) {
        let own = self.own(own_port);
        let Some(port) = self.client().port_by_name(&own) else { return };
        for existing in port.get_connections() {
            if Some(&existing) == other.as_ref() {
                continue;
            }
            let _ = if own_is_input {
                self.client().disconnect_ports_by_name(&existing, &own)
            } else {
                self.client().disconnect_ports_by_name(&own, &existing)
            };
        }
        if let Some(other) = other {
            if !port.is_connected_to(&other).unwrap_or(false) {
                let _ = if own_is_input {
                    self.client().connect_ports_by_name(&other, &own)
                } else {
                    self.client().connect_ports_by_name(&own, &other)
                };
            }
        }
    }

    /// (Re)connect our ports to the hardware chosen in the settings.
    pub fn apply_connections(&self, cfg: &Config) {
        for i in 0..NUM_INPUTS {
            self.connect_only(&format!("in_{}", i + 1), self.resolve_input(cfg, i), true);
        }
        self.connect_only("out_L", self.resolve_output(cfg, false), false);
        self.connect_only("out_R", self.resolve_output(cfg, true), false);
        let ports = self.capture_ports();
        for (own, ch) in [("desktop_L", "FL"), ("desktop_R", "FR")] {
            let suffix = format!(":monitor_{ch}");
            let monitor = ports.iter().find(|p| p.contains(SINK_LABEL) && p.ends_with(&suffix)).cloned();
            self.connect_only(own, monitor, true);
        }
    }

    pub fn output_connected(&self) -> bool {
        self.client().port_by_name(&self.own("out_L")).is_some_and(|p| p.connected_count().unwrap_or(0) > 0)
    }

    /// Frames between a sound entering the interface and the played-back audio it was performed to.
    pub fn roundtrip_latency(&self) -> i64 {
        let lat = |port: &str, kind| {
            self.client().port_by_name(&self.own(port)).map_or(0, |p| p.get_latency_range(kind).1 as i64)
        };
        let total = lat("in_1", LatencyType::Capture) + lat("out_L", LatencyType::Playback);
        if (0..self.sample_rate as i64).contains(&total) {
            total
        } else {
            2 * self.buffer_size() as i64
        }
    }

    pub fn buffer_size(&self) -> u32 {
        self.client().buffer_size()
    }

    pub fn set_buffer_size(&self, frames: u32) {
        let _ = self.client().set_buffer_size(frames);
    }

    pub fn cpu_load(&self) -> f32 {
        self.client().cpu_load()
    }
}

/// The device part of a port name ("Device name:port").
fn device_of(port: &str) -> &str {
    port.rsplit_once(':').map_or(port, |(device, _)| device)
}

fn common_prefix(a: &str, b: &str) -> usize {
    a.chars().zip(b.chars()).take_while(|(x, y)| x == y).count()
}

/// Sort so that "Input 2" comes before "Input 10".
fn natural_sort(names: &mut [String]) {
    names.sort_by(|a, b| (a.len(), a).cmp(&(b.len(), b)));
}

pub fn print_ports() {
    match Client::new("SnakeDAW-ports", ClientOptions::NO_START_SERVER) {
        Ok((client, _)) => {
            for (title, flags) in [("Inputs you can record from", PortFlags::IS_OUTPUT), ("Outputs you can play to", PortFlags::IS_INPUT)] {
                println!("{title}:");
                for port in client.ports(None, Some(AUDIO_TYPE), flags) {
                    println!("  {port}");
                }
            }
        }
        Err(e) => eprintln!("could not connect to the audio server: {e}"),
    }
}
