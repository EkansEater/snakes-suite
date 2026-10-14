#!/bin/sh
# Build Snake's DAW in release mode and add it to the application menu.
set -e
cd "$(dirname "$0")"
cargo build --release
mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications"
install -m755 target/release/snakedaw "$HOME/.local/bin/snakedaw"
cat > "$HOME/.local/share/applications/snakedaw.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Snake's DAW
Comment=Practice and recording
Exec=$HOME/.local/bin/snakedaw
Icon=audio-x-generic
Categories=AudioVideo;Audio;
StartupWMClass=snakedaw
DESKTOP
echo "Installed. Start it from the application menu or run: snakedaw"
