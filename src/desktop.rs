//! Desktop audio capture: a virtual output device ("Snake's DAW Play-Along") that browsers and
//! players can send sound to. The DAW listens to it and mixes it into the headphones.

use std::process::Command;

pub const SINK_NAME: &str = "snakedaw_playalong";
/// Human-readable device name; this is also how the device appears among the audio ports.
pub const SINK_LABEL: &str = "SnakeDAW-PlayAlong";

fn pactl(args: &[&str]) -> Option<String> {
    let out = Command::new("pactl").args(args).output().ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_string())
}

fn sink_exists() -> bool {
    pactl(&["list", "short", "sinks"]).is_some_and(|s| s.lines().any(|l| l.split('\t').nth(1) == Some(SINK_NAME)))
}

fn default_sink() -> Option<String> {
    pactl(&["get-default-sink"]).filter(|s| !s.is_empty())
}

/// Move every stream that is currently playing to `sink`.
fn move_streams(sink: &str) {
    if let Some(list) = pactl(&["list", "short", "sink-inputs"]) {
        for id in list.lines().filter_map(|l| l.split('\t').next()) {
            pactl(&["move-sink-input", id, sink]);
        }
    }
}

/// Send all desktop audio into the DAW. Returns the previous default output so it can be restored.
pub fn enable() -> Result<Option<String>, String> {
    if !sink_exists() {
        let args = format!("sink_name={SINK_NAME}");
        pactl(&["load-module", "module-null-sink", &args, &format!("sink_properties=device.description={SINK_LABEL}")])
            .ok_or("could not create the play-along device (is pactl installed?)")?;
    }
    let previous = default_sink().filter(|s| s != SINK_NAME);
    pactl(&["set-default-sink", SINK_NAME]).ok_or("could not redirect desktop audio")?;
    move_streams(SINK_NAME);
    Ok(previous)
}

/// Undo `enable`: give desktop audio back to `previous` and remove the virtual device.
pub fn disable(previous: Option<&str>) {
    if let Some(prev) = previous {
        pactl(&["set-default-sink", prev]);
        move_streams(prev);
    }
    if let Some(modules) = pactl(&["list", "short", "modules"]) {
        for line in modules.lines().filter(|l| l.contains(&format!("sink_name={SINK_NAME}"))) {
            if let Some(id) = line.split('\t').next() {
                pactl(&["unload-module", id]);
            }
        }
    }
}

/// True if a previous session ended without restoring the system output.
pub fn left_enabled() -> bool {
    sink_exists()
}
