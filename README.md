# SnakeDAW

A small, free DAW for practising and recording: plug in, hear yourself through an amp and effects,
play along, loop, and record. It runs on Linux, Windows and macOS with any audio interface.

## Install

Downloads for each system are attached to the project's releases.

- **Linux** – unpack the `.tar.gz` and run `./install.sh` (installs for your user only), or just run
  `./snakedaw`. It needs the `lilv` library for LV2 plugins (`sudo pacman -S lilv`,
  `sudo apt install liblilv-0-0`, `sudo dnf install lilv`).
- **Windows** – unpack the `.zip` and start `SnakeDAW.exe`. Windows may warn about an unknown
  publisher the first time: choose *More info → Run anyway*.
- **macOS** – unpack the `.zip`, move `SnakeDAW.app` to Applications, then right-click it and choose
  *Open* the first time (the app is not notarised by Apple). Allow microphone access when asked,
  otherwise your inputs stay silent.

## Your audio interface

SnakeDAW picks an interface by itself and shows what it chose under **⚙ Audio**, where you can
change it. Up to eight inputs are used.

- **Linux with PipeWire or JACK** – it connects straight to the audio server. This gives the
  shortest delay and lets you route every input and output individually.
- **Windows, macOS, or Linux without JACK** – it uses the system's own audio. Choose the input and
  output device under **⚙ Audio**; device changes apply the next time you start the program.

If your interface has a direct-monitor or MIX knob, turn it fully towards playback (PB / DAW),
otherwise you hear the dry signal on top of the processed one.

If you hear crackles, raise the buffer size under **⚙ Audio**. If playing feels delayed, lower it.

## What it does

- **Tracks** – each track listens to one input. ⏺ arms it for recording, 🎧 lets you hear it live,
  **FX** switches its effects on/off.
- **Effects** – noise gate, compressor, overdrive, distortion, amp, cabinet, EQ, pitch shifter /
  drop tune, tremolo, delay, reverb. Recordings are stored clean, so the tone can still be changed
  afterwards. With pedals in front of the interface, switch **FX** off or keep only amp and cabinet.
- **Loop station** – four loops recorded, overdubbed and muted on the fly (keys 1-4). The first loop
  sets the length. Each loop has its own list of tracks it records (the ⏺ menu under it). It has its
  own count-in and click; with either on, the first loop closes on a whole bar. To reuse something
  already recorded, draw a loop region and drag the track's "drag to loop" tab onto a loop.
- **Tuner** – chromatic, from about 28 Hz up, for guitar, bass or anything else.
- **Recording and editing** – record several armed tracks at once, move / trim / split / duplicate
  clips, undo, metronome with count-in, loop region, WAV mixdown export.

### Getting around the timeline

- Scroll wheel over the timeline zooms at the pointer; Shift+scroll, dragging empty space, the middle
  mouse button or the scrollbar slides it sideways. Scroll over the track names to move through tracks.
- Drag a track's bottom edge to change its height (double-click to reset).
- The top strip of the ruler is the loop region: drag to draw one, drag its middle to move it, its
  ends to resize it, click it to switch looping on or off. Click below the strip to move the playhead.

Shortcuts are listed under **Help**.

### Only on Linux (with PipeWire or JACK)

- **LV2 plugins** – any installed LV2 effect (Guitarix and others) under *+ Add effect*.
- **Desktop audio** – routes browser and player sound through the DAW into your headphones, onto a
  track you can also record. It is switched back when you turn it off or quit.

## Files

Projects are folders containing `project.json`, `audio/` and `exports/`, kept in a `SnakeDAW` folder
inside your Music folder. Settings live in your system's usual configuration folder
(`~/.config/snakedaw` on Linux).

## Building from source

You need [Rust](https://rustup.rs).

```bash
cargo run --release                          # Linux, with JACK/PipeWire and LV2 support
cargo run --release --no-default-features    # Windows, macOS, or Linux without those libraries
```

On Linux the build needs the development packages for ALSA, and for the default build also lilv
(Debian/Ubuntu: `libasound2-dev liblilv-dev`; Arch: `alsa-lib lilv`).

```bash
cargo test                 # audio engine checks, no sound card needed
cargo test -- --ignored    # also load every installed Guitarix LV2 plugin
cargo run -- --ports       # Linux: list the audio ports the DAW can see
SNAKEDAW_BACKEND=system cargo run   # Linux: try the system-audio backend for one run
```

Pushing a tag such as `v0.2.0` to GitHub builds the downloads for all three systems
(`.github/workflows/release.yml`).

| File | Role |
| --- | --- |
| `src/engine.rs` | realtime mixer: tracks, clips, monitoring, recording taps, metronome |
| `src/looper.rs` | loop station |
| `src/fx/` | built-in effects and the LV2 host |
| `src/audioio.rs` | chooses between the two audio backends |
| `src/jackio.rs` | Linux backend: JACK / PipeWire connection and port wiring |
| `src/cpalio.rs` | portable backend: system audio on Windows, macOS and Linux |
| `src/app.rs` | projects, tracks, transport, editing, export |
| `src/ui.rs` | the interface |
