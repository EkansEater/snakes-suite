//! Desktop audio routing is a PipeWire feature of the Linux build; a phone has none.

pub fn enable() -> Result<Option<String>, String> {
    Err("Desktop audio is only available on Linux with PipeWire.".into())
}

pub fn disable(_previous: Option<&str>) {}

pub fn left_enabled() -> bool {
    false
}
