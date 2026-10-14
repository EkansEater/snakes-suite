#!/bin/sh
# Adds Snake's MP3 Converter to your application menu, running from this folder (Linux).
# For a full install on any system use the Snake's Suite installer: python install.py mp3
set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
APPS="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
mkdir -p "$APPS"
rm -f "$APPS/snakes-sounds.desktop"  # the entry from before the rename
cat > "$APPS/snakes-mp3.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Snake's MP3 Converter
GenericName=Video to MP3 Converter
Comment=Drag a video link in, get an MP3 out
Exec="$DIR/snakes-mp3" %U
Icon=$DIR/snakes_mp3/assets/icon.svg
Terminal=false
Categories=AudioVideo;Audio;
Keywords=mp3;youtube;audio;convert;download;
StartupWMClass=snakes-mp3
DESKTOP
update-desktop-database "$APPS" 2>/dev/null || true
echo "Installed: Snake's MP3 Converter is now in your application menu."
