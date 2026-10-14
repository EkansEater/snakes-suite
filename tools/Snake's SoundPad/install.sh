#!/bin/sh
# Puts `snakepad` on your PATH and adds a menu entry. Re-run after moving the folder.
set -e
DIR="$(dirname "$(readlink -f "$0")")"
mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications"
ln -sf "$DIR/snakepad.sh" "$HOME/.local/bin/snakepad"
sed "s|@EXEC@|$HOME/.local/bin/snakepad|" "$DIR/snakepad.desktop.in" > "$HOME/.local/share/applications/snakepad.desktop"
echo "Installed. Run 'snakepad' or find \"Snake's SoundPad\" in your app menu."
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "Note: add ~/.local/bin to your PATH.";; esac
