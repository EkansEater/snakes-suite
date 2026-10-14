#!/bin/sh
# Adds Snake's Code to your desktop application menu (~/.local/share/applications).
APP_DIR="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
DEST="${XDG_DATA_HOME:-$HOME/.local/share}/applications/snakes-code.desktop"
mkdir -p "$(dirname "$DEST")"
cat > "$DEST" <<DESKTOP
[Desktop Entry]
Name=Snake's Code
Comment=Code editor
Exec="$APP_DIR/bin/snakes-code" %F
Icon=$APP_DIR/assets/icon.png
Type=Application
Categories=Development;TextEditor;IDE;
MimeType=text/plain;inode/directory;
StartupWMClass=snakes-code
Terminal=false
DESKTOP
echo "Installed $DEST"
