#!/bin/sh
# Installs the downloaded SnakeDAW for the current user (no root needed).
set -e
cd "$(dirname "$0")"
mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications"
install -m755 snakedaw "$HOME/.local/bin/snakedaw"
sed "s|^Exec=.*|Exec=$HOME/.local/bin/snakedaw|" snakedaw.desktop > "$HOME/.local/share/applications/snakedaw.desktop"
echo "Installed. Start SnakeDAW from the application menu, or run: $HOME/.local/bin/snakedaw"
