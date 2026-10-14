#!/bin/sh
# Adds Snake's Screen Recorder to the application menu and puts a `snakescreen` command in
# ~/.local/bin, running straight from this folder. Run again after moving it.
set -e
here="$(cd "$(dirname "$0")" && pwd)"
bin="$HOME/.local/bin"
apps="$HOME/.local/share/applications"
icons="$HOME/.local/share/icons/hicolor/scalable/apps"
mkdir -p "$bin" "$apps" "$icons"

cat > "$bin/snakescreen" <<LAUNCHER
#!/bin/sh
PYTHONPATH="$here\${PYTHONPATH:+:\$PYTHONPATH}" exec python3 -m snakescreen "\$@"
LAUNCHER
chmod +x "$bin/snakescreen"

cp "$here/snakescreen/assets/icon.svg" "$icons/snakescreen.svg"

cat > "$apps/snakescreen.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=Snake's Screen Recorder
Comment=Record your screen to MP4 or GIF, or audio to MP3
Exec=$bin/snakescreen
Icon=snakescreen
Categories=AudioVideo;Recorder;
Keywords=screen;record;capture;gif;
StartupWMClass=snakescreen
Actions=toggle;

[Desktop Action toggle]
Name=Start / stop recording
Exec=$bin/snakescreen --toggle
DESKTOP

echo "Installed. Launch Snake's Screen Recorder from your app menu, or run: $bin/snakescreen"
