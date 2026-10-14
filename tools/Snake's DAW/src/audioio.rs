//! The sound card connection. Two backends sit behind one interface:
//! JACK/PipeWire on Linux (preferred there) and the operating system's own audio everywhere.

use crate::cpalio::CpalIo;
use crate::engine::{Mixer, Transport, NUM_INPUTS};
#[cfg(feature = "jack-backend")]
use crate::jackio::JackIo;
use crate::project::Config;
use anyhow::Result;
use std::sync::Arc;

pub enum Backend {
    #[cfg(feature = "jack-backend")]
    Jack(JackIo),
    System(CpalIo),
}

pub struct AudioIo {
    pub sample_rate: u32,
    pub backend: Backend,
}

impl AudioIo {
    /// Start audio. `cfg.backend` chooses: "jack", "system", or "" for the best one available.
    pub fn start(transport: Arc<Transport>, cfg: &Config, build: impl FnOnce(u32) -> Mixer) -> Result<Self> {
        // SNAKEDAW_BACKEND tries a backend for one run without changing the saved settings.
        let choice = std::env::var("SNAKEDAW_BACKEND").unwrap_or_else(|_| cfg.backend.clone());
        #[cfg(feature = "jack-backend")]
        let build = {
            if choice != "system" {
                // The mixer can only be built once, so check that a server is there before committing.
                if JackIo::available() || choice == "jack" {
                    let io = JackIo::start(transport, build)?;
                    return Ok(Self { sample_rate: io.sample_rate, backend: Backend::Jack(io) });
                }
            }
            build
        };
        let _ = &choice;
        let io = CpalIo::start(transport, cfg, build)?;
        Ok(Self { sample_rate: io.sample_rate, backend: Backend::System(io) })
    }

    #[cfg(feature = "jack-backend")]
    pub fn jack(&self) -> Option<&JackIo> {
        match &self.backend {
            Backend::Jack(io) => Some(io),
            _ => None,
        }
    }

    pub fn system(&self) -> Option<&CpalIo> {
        match &self.backend {
            Backend::System(io) => Some(io),
            #[cfg(feature = "jack-backend")]
            _ => None,
        }
    }

    /// Desktop audio capture needs the audio server's port routing.
    pub fn supports_desktop(&self) -> bool {
        self.system().is_none() && cfg!(target_os = "linux")
    }

    /// How many hardware inputs are usable right now.
    pub fn input_count(&self, cfg: &Config) -> usize {
        let _ = cfg;
        let n = match &self.backend {
            #[cfg(feature = "jack-backend")]
            Backend::Jack(io) => io.input_count(cfg),
            Backend::System(io) => io.inputs,
        };
        n.min(NUM_INPUTS)
    }

    /// Keep our ports wired to the chosen hardware (only JACK has ports to wire).
    pub fn apply_connections(&self, cfg: &Config) {
        let _ = cfg;
        #[cfg(feature = "jack-backend")]
        if let Backend::Jack(io) = &self.backend {
            io.apply_connections(cfg);
        }
    }

    pub fn output_connected(&self) -> bool {
        match &self.backend {
            #[cfg(feature = "jack-backend")]
            Backend::Jack(io) => io.output_connected(),
            Backend::System(_) => true,
        }
    }

    /// Frames between a sound entering the interface and the played-back audio it was performed to.
    pub fn roundtrip_latency(&self) -> i64 {
        match &self.backend {
            #[cfg(feature = "jack-backend")]
            Backend::Jack(io) => io.roundtrip_latency(),
            Backend::System(io) => io.roundtrip_latency(),
        }
    }

    pub fn buffer_size(&self) -> u32 {
        match &self.backend {
            #[cfg(feature = "jack-backend")]
            Backend::Jack(io) => io.buffer_size(),
            Backend::System(io) => io.buffer_size(),
        }
    }

    /// Change the buffer size now if the backend can; otherwise it applies on the next start.
    pub fn set_buffer_size(&self, frames: u32) {
        let _ = frames;
        #[cfg(feature = "jack-backend")]
        if let Backend::Jack(io) = &self.backend {
            io.set_buffer_size(frames);
        }
    }

    pub fn cpu_load(&self) -> f32 {
        match &self.backend {
            #[cfg(feature = "jack-backend")]
            Backend::Jack(io) => io.cpu_load(),
            Backend::System(io) => io.cpu_load(),
        }
    }
}
