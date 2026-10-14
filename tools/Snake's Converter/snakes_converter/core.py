"""Shared types and helpers used by every converter."""

from __future__ import annotations

import os
import sys
import threading
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

Progress = Callable[[float], None]  # called with a fraction between 0 and 1


class ConversionError(Exception):
    """A conversion failed for a reason worth showing to the user."""


class Cancelled(Exception):
    """The user cancelled the conversion."""


@dataclass
class Options:
    audio_bitrate: str = "192k"
    video_quality: str = "balanced"  # high | balanced | small
    image_quality: int = 90  # JPEG / WebP quality
    pdf_dpi: int = 150  # resolution used when rendering PDF pages to images
    overwrite: bool = False


def check_cancel(cancel: threading.Event | None) -> None:
    if cancel is not None and cancel.is_set():
        raise Cancelled()


def unique_path(path: Path) -> Path:
    """Return `path`, or `name (1).ext`, `name (2).ext`... if it already exists."""
    if not path.exists():
        return path
    n = 1
    while True:
        candidate = path.with_name(f"{path.stem} ({n}){path.suffix}")
        if not candidate.exists():
            return candidate
        n += 1


def read_text(path: Path) -> str:
    """Read a text file without assuming it is UTF-8."""
    data = path.read_bytes()
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return data.decode("utf-16")
    for encoding in ("utf-8-sig", "cp1252"):
        try:
            return data.decode(encoding)
        except UnicodeDecodeError:
            continue
    return data.decode("latin-1")


_qt_app = None


def ensure_qt():
    """Make sure a Qt application object exists (needed for fonts, PDF and SVG)."""
    global _qt_app
    from PySide6.QtGui import QGuiApplication

    app = QGuiApplication.instance()
    if app is None:
        headless = sys.platform.startswith("linux") and not (
            os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY")
        )
        if headless:
            os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
        app = _qt_app = QGuiApplication(sys.argv[:1])
    return app
