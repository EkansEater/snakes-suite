//! Stand-in used when the program is built without LV2 support (Windows, macOS, or Linux
//! without the lilv library): there are simply no plugins to offer.

use super::Created;
use anyhow::{bail, Result};

pub struct Lv2Info {
    pub uri: String,
    pub name: String,
}

pub struct Lv2Host {
    pub plugins: Vec<Lv2Info>,
}

impl Lv2Host {
    pub fn new() -> Self {
        Self { plugins: Vec::new() }
    }

    pub fn create(&self, _uri: &str, _sr: f32) -> Result<Created> {
        bail!("this build has no LV2 plugin support")
    }
}
