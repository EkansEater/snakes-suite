//! Portable backend: the operating system's own audio (WASAPI on Windows, CoreAudio on macOS,
//! ALSA on Linux). The input and output devices run as two separate streams joined by a small
//! queue, so any pair of devices works, at the cost of a little more latency than JACK.

use crate::engine::{no_denormals, Mixer, Transport, MAX_BLOCK, NUM_INPUTS};
use crate::project::Config;
use crate::util::AtomicF32;
use anyhow::{anyhow, bail, Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{BufferSize, Device, FromSample, Sample, SampleFormat, SizedSample, StreamConfig, SupportedBufferSize};
use std::sync::atomic::{AtomicU32, Ordering::Relaxed};
use std::sync::Arc;
use std::time::Instant;

/// A device the user can pick: its stable id and its display name.
pub type DeviceEntry = (String, String);

pub struct CpalIo {
    _output: cpal::Stream,
    _input: Option<cpal::Stream>,
    pub sample_rate: u32,
    pub inputs: usize,
    pub input_devices: Vec<DeviceEntry>,
    pub output_devices: Vec<DeviceEntry>,
    pub input_name: String,
    pub output_name: String,
    /// Why there is no input, if the chosen input device could not be used.
    pub input_problem: Option<String>,
    load: Arc<AtomicF32>,
    block: Arc<AtomicU32>,
}

fn name_of(device: &Device) -> String {
    device.description().map(|d| d.name().to_string()).unwrap_or_else(|_| "Unknown device".into())
}

fn entries(devices: impl Iterator<Item = Device>) -> Vec<DeviceEntry> {
    devices.filter_map(|d| Some((d.id().ok()?.to_string(), name_of(&d)))).collect()
}

/// The device saved in the settings, or the system default if none is saved or it has gone.
fn pick(host: &cpal::Host, saved: &str, default: Option<Device>) -> Option<Device> {
    saved.parse().ok().and_then(|id| host.device_by_id(&id)).or(default)
}

fn buffer_for(wanted: u32, supported: &SupportedBufferSize) -> BufferSize {
    match supported {
        SupportedBufferSize::Range { min, max } if (*min..=*max).contains(&wanted) => BufferSize::Fixed(wanted),
        _ => BufferSize::Default,
    }
}

/// Build an output stream whose callback works on interleaved f32, whatever the device's format.
fn output_stream<T>(device: &Device, config: StreamConfig, tr: Arc<Transport>, mut render: impl FnMut(&mut [f32]) + Send + 'static) -> Result<cpal::Stream>
where
    T: SizedSample + FromSample<f32>,
{
    let mut scratch = vec![0.0f32; MAX_BLOCK * config.channels as usize];
    let stream = device.build_output_stream(
        config,
        move |data: &mut [T], _: &cpal::OutputCallbackInfo| {
            for chunk in data.chunks_mut(scratch.len()) {
                let buf = &mut scratch[..chunk.len()];
                render(buf);
                for (out, s) in chunk.iter_mut().zip(buf.iter()) {
                    *out = T::from_sample(*s);
                }
            }
        },
        move |_| {
            tr.xruns.fetch_add(1, Relaxed);
        },
        None,
    )?;
    Ok(stream)
}

fn input_stream<T>(device: &Device, config: StreamConfig, mut tx: rtrb::Producer<f32>) -> Result<cpal::Stream>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let stream = device.build_input_stream(
        config,
        move |data: &[T], _: &cpal::InputCallbackInfo| {
            for s in data {
                // If the output side has stalled the queue fills up and the excess is dropped.
                let _ = tx.push(f32::from_sample(*s));
            }
        },
        |_| {},
        None,
    )?;
    Ok(stream)
}

/// Run `$build::<T>(...)` with T chosen from the device's sample format.
macro_rules! for_format {
    ($format:expr, $build:ident, $($arg:expr),*) => {
        match $format {
            SampleFormat::F32 => $build::<f32>($($arg),*),
            SampleFormat::I16 => $build::<i16>($($arg),*),
            SampleFormat::I32 => $build::<i32>($($arg),*),
            SampleFormat::U16 => $build::<u16>($($arg),*),
            SampleFormat::I8 => $build::<i8>($($arg),*),
            SampleFormat::U8 => $build::<u8>($($arg),*),
            other => Err(anyhow!("the device uses a sample format this program cannot handle ({other})")),
        }
    };
}

impl CpalIo {
    pub fn start(transport: Arc<Transport>, cfg: &Config, build: impl FnOnce(u32) -> Mixer) -> Result<Self> {
        let host = cpal::default_host();
        let output_devices = entries(host.output_devices().context("listing output devices")?);
        let input_devices = host.input_devices().map(entries).unwrap_or_default();

        let out_dev = pick(&host, &cfg.device_out, host.default_output_device()).ok_or_else(|| anyhow!("no audio output device was found"))?;
        let out_default = out_dev.default_output_config().context("reading the output device's format")?;
        let sample_rate = out_default.sample_rate();
        let out_channels = out_default.channels() as usize;
        if out_channels == 0 {
            bail!("the output device has no channels");
        }
        let buffer = buffer_for(cfg.buffer_size, out_default.buffer_size());

        // The input has to run at the output's sample rate; take the layout with the most channels.
        let mut input_problem = None;
        let in_dev = pick(&host, &cfg.device_in, host.default_input_device());
        let in_choice = in_dev.as_ref().and_then(|dev| {
            let mut best = None;
            for range in dev.supported_input_configs().ok()? {
                if let Some(c) = range.try_with_sample_rate(sample_rate) {
                    let score = (c.channels().min(NUM_INPUTS as u16), c.sample_format() == SampleFormat::F32);
                    if best.as_ref().is_none_or(|(s, _)| score > *s) {
                        best = Some((score, c));
                    }
                }
            }
            if best.is_none() {
                input_problem = Some(format!("“{}” cannot record at {sample_rate} Hz, the output's sample rate", name_of(dev)));
            }
            best.map(|(_, c)| c)
        });
        if in_dev.is_none() {
            input_problem = Some("no audio input device was found".into());
        }

        let in_channels = in_choice.as_ref().map_or(0, |c| c.channels() as usize);
        let (tx, mut rx) = rtrb::RingBuffer::<f32>::new((sample_rate as usize * in_channels).max(1));
        let input = match (&in_dev, &in_choice) {
            (Some(dev), Some(choice)) => {
                let config = StreamConfig { channels: choice.channels(), sample_rate, buffer_size: buffer_for(cfg.buffer_size, choice.buffer_size()) };
                let built = for_format!(choice.sample_format(), input_stream, dev, config, tx).or_else(|_| {
                    // Some drivers refuse a fixed buffer size: let them choose.
                    let (tx, new_rx) = rtrb::RingBuffer::<f32>::new(sample_rate as usize * in_channels);
                    rx = new_rx;
                    let config = StreamConfig { buffer_size: BufferSize::Default, ..config };
                    for_format!(choice.sample_format(), input_stream, dev, config, tx)
                });
                match built {
                    Ok(stream) => Some(stream),
                    Err(e) => {
                        input_problem = Some(format!("could not open “{}”: {e:#}", name_of(dev)));
                        None
                    }
                }
            }
            _ => None,
        };
        let inputs = if input.is_some() { in_channels.min(NUM_INPUTS) } else { 0 };

        let load = Arc::new(AtomicF32::new(0.0));
        let block = Arc::new(AtomicU32::new(cfg.buffer_size));
        let mut mixer = build(sample_rate);
        let mut ins = vec![vec![0.0f32; MAX_BLOCK]; NUM_INPUTS];
        let (mut left, mut right) = (vec![0.0f32; MAX_BLOCK], vec![0.0f32; MAX_BLOCK]);
        let silence = vec![0.0f32; MAX_BLOCK];
        let (load_w, block_w) = (load.clone(), block.clone());
        let render = move |data: &mut [f32]| {
            let started = Instant::now();
            no_denormals();
            let frames = data.len() / out_channels;
            block_w.store(frames as u32, Relaxed);

            if in_channels > 0 {
                // The two devices run on separate clocks. If input piles up, skip the oldest
                // audio so the monitoring delay cannot grow without bound.
                let queued = rx.slots() / in_channels;
                let limit = frames * 4 + 1024;
                if queued > limit {
                    for _ in 0..(queued - frames * 2) * in_channels {
                        let _ = rx.pop();
                    }
                }
            }
            let available = if in_channels > 0 { (rx.slots() / in_channels).min(frames) } else { 0 };
            for i in 0..frames {
                for c in 0..in_channels.max(NUM_INPUTS) {
                    let s = if i < available && c < in_channels { rx.pop().unwrap_or(0.0) } else { 0.0 };
                    if c < NUM_INPUTS {
                        ins[c][i] = s;
                    }
                }
            }

            let inputs: [&[f32]; NUM_INPUTS] = std::array::from_fn(|c| &ins[c][..frames]);
            let quiet = &silence[..frames];
            mixer.process(inputs, [quiet, quiet], &mut left[..frames], &mut right[..frames]);
            for (i, frame) in data.chunks_exact_mut(out_channels).enumerate() {
                frame.fill(0.0);
                if out_channels == 1 {
                    frame[0] = (left[i] + right[i]) * 0.5;
                } else {
                    frame[0] = left[i];
                    frame[1] = right[i];
                }
            }

            let budget = frames as f32 / sample_rate as f32;
            let used = started.elapsed().as_secs_f32() / budget * 100.0;
            load_w.set(used.max(load_w.get() * 0.98));
        };

        // The mixer lives inside the output callback, so a failed attempt cannot be retried with
        // other settings: ask for a fixed buffer only when the device says it supports it.
        let config = StreamConfig { channels: out_default.channels(), sample_rate, buffer_size: buffer };
        let output = for_format!(out_default.sample_format(), output_stream, &out_dev, config, transport, render)
            .with_context(|| format!("could not open the output device “{}”", name_of(&out_dev)))?;

        if let Some(stream) = &input {
            stream.play().context("starting the input device")?;
        }
        output.play().context("starting the output device")?;

        Ok(Self {
            _output: output,
            _input: input,
            sample_rate,
            inputs,
            input_devices,
            output_devices,
            input_name: in_dev.as_ref().map(name_of).unwrap_or_else(|| "none".into()),
            output_name: name_of(&out_dev),
            input_problem,
            load,
            block,
        })
    }

    pub fn buffer_size(&self) -> u32 {
        self.block.load(Relaxed)
    }

    pub fn cpu_load(&self) -> f32 {
        self.load.get()
    }

    /// Rough estimate: an input block, an output block and the queue between the two streams.
    pub fn roundtrip_latency(&self) -> i64 {
        3 * self.buffer_size() as i64
    }
}
