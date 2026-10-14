"""Build a standalone Snake's Converter for the operating system this runs on.

    pip install ".[build]"
    python scripts/build.py

The result lands in dist/. PyInstaller cannot cross-compile, so run this once
on each of Windows, macOS and Linux (the GitHub workflow does exactly that).
"""

import os
import sys
from pathlib import Path

import PyInstaller.__main__

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "snakes_converter" / "assets"

args = [
    str(ROOT / "scripts" / "launcher.py"),
    "--name", "Snake's Converter",
    "--paths", str(ROOT),
    "--windowed",
    "--noconfirm",
    "--clean",
    "--icon", str(ASSETS / "icon.png"),
    "--add-data", f"{ASSETS}{os.pathsep}snakes_converter/assets",
    "--collect-all", "imageio_ffmpeg",  # ships ffmpeg inside the app
    "--collect-all", "pypdfium2_raw",
    "--collect-data", "pypdfium2",
    "--collect-data", "docx",
    "--distpath", str(ROOT / "dist"),
    "--workpath", str(ROOT / "build"),
    "--specpath", str(ROOT / "build"),
]
if sys.platform != "darwin":  # macOS gets a .app bundle instead of a single file
    args.append("--onefile")

PyInstaller.__main__.run(args)
