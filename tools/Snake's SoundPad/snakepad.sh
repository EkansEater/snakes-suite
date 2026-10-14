#!/bin/sh
# Launcher: works from anywhere, including symlinked into ~/.local/bin/snakepad
DIR="$(dirname "$(readlink -f "$0")")"
cd "$DIR" && exec python3 -m snakepad "$@"
