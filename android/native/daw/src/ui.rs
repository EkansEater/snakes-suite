//! What the controller (app.rs) keeps of the interface's state. On the desktop this is
//! egui's UiState; on Android the Compose UI owns everything else.

#[derive(Default)]
pub struct UiState {
    pub sel_track: Option<u64>,
    pub sel_clip: Option<(u64, u64)>,
    pub show_tuner: bool,
}
