"""Locating and running the external programs the converters rely on."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from functools import lru_cache
from pathlib import Path


def popen_kwargs() -> dict:
    """Keep console windows from flashing up on Windows."""
    if sys.platform == "win32":
        return {"creationflags": subprocess.CREATE_NO_WINDOW}
    return {}


@lru_cache(maxsize=None)
def find_ffmpeg() -> str | None:
    """System ffmpeg if installed, otherwise the copy bundled with imageio-ffmpeg."""
    found = shutil.which("ffmpeg")
    if found:
        return found
    try:
        import imageio_ffmpeg

        return imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        return None


@lru_cache(maxsize=None)
def find_libreoffice() -> str | None:
    for name in ("soffice", "libreoffice"):
        found = shutil.which(name)
        if found:
            return found
    candidates = []
    if sys.platform == "win32":
        for var in ("PROGRAMFILES", "PROGRAMFILES(X86)"):
            base = os.environ.get(var)
            if base:
                candidates.append(Path(base) / "LibreOffice" / "program" / "soffice.exe")
    elif sys.platform == "darwin":
        candidates.append(Path("/Applications/LibreOffice.app/Contents/MacOS/soffice"))
    else:
        candidates += [
            Path("/usr/lib/libreoffice/program/soffice"),
            Path("/opt/libreoffice/program/soffice"),
            Path("/var/lib/flatpak/exports/bin/org.libreoffice.LibreOffice"),
        ]
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)
    return None
